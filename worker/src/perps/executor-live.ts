/**
 * THE LIVE LIGHTER EXECUTOR — the one place a signed venue transaction is
 * written down and sent (docs/perps.md rules 2, 6, 7, 8, 9; review amendments
 * replay-model-nonce-not-coi, signer-input-validation, venue-stop-semantics,
 * venue-stop-expiry-and-price-band, leverage-is-per-market-not-per-order).
 *
 * The same PerpExecutor as paper (executor.ts): review() is the dry run the
 * lane's second policy pass judges, place() the dispose half. What differs is
 * who fills — the venue, on its own clock — and so what place() can promise:
 * not a fill, but that the tx it sent is on record and can never be sent
 * twice under two nonces by accident.
 *
 * EVERY SEND IS FOUR STEPS, IN THIS ORDER, UNDER ONE LOCK (submit()):
 *
 *   1. RESERVE   nonce.ts commits max(now_ms, high-water + 1) before anything
 *                is signed, so no restart can reuse it.
 *   2. SIGN      the signer (signer.ts) owns every argument and re-checks what
 *                it returned. The nonce is its; so are the client order
 *                indexes (nonce × 8 + leg) the row will hold.
 *   3. PERSIST   the rule-9 `submitted` row — the exact tx_info, its hash,
 *                type, account, key, nonce, ExpiredAt and every client order
 *                index (the legs come from the SIGNED result, in the row's own
 *                transaction — insertPerpOrderSubmitted writes them, so no
 *                second write can fail between the row and its legs; and, for
 *                a withdrawal, its perp_transfers row, in that SAME
 *                transaction). A failed write throws PerpNotRecorded and
 *                NOTHING IS SENT: a tx with no row is one no reconcile could
 *                ever find, re-send or resolve.
 *   4. SEND      once. Never retried here (api.ts): a re-send is a decision
 *                about the row, made by reconcile.ts through resendPersisted()
 *                with the persisted bytes and nothing else.
 *
 * The lock keeps sends in nonce order. With SkipNonce a later nonce that
 * executes first kills every earlier pending tx on the key, so two of our own
 * sends overtaking each other would silently drop the first. It also covers
 * the checks against our own unresolved rows (an open or a leverage change on
 * a market whose last tx has no outcome, a second withdrawal): judged outside
 * it, two callers could both pass them before either row existed.
 *
 * WHAT AN ANSWER MEANS TO THE ROW (rule 9):
 *   accepted          poll /tx by hash for ~3 s (bounded, never more). Status
 *                     2..5 → `executed` (fills are reconcile's to ingest; the
 *                     taker's venue order index is recorded on its leg when
 *                     event_info names it); 0 → `rejected`; an application
 *                     error → `app-error`; pending or unread → `submitted`.
 *   refused-send      on this FIRST send the tx never entered the sequencer,
 *                     so the row is `rejected` — UNLESS the venue's code says
 *                     an execution may already exist (21104, 21728:
 *                     maybeExecuted), which leaves it `submitted`.
 *   not sent          our own budget or the fleet cooldown stopped it before
 *                     it left: `rejected`, with a reason that says so.
 *   anything else     timeout, 5xx, a garbled answer, the venue's limiter —
 *                     WE DO NOT KNOW. `submitted`, resolved by hash.
 *
 * WHAT IT NEVER SIGNS. CreateSubAccount, Transfer, UpdateAccountConfig,
 * UpdateAccountAssetConfig, ApproveIntegrator, ChangePubKey (rule 2): the
 * signer does not expose them, and nothing here reaches past its typed
 * wrappers. Every open is ONE grouped tx carrying its own stop (rule 7): the
 * signer has no bare-open door to call.
 *
 * THE VENUE ACCOUNT IS THE ONLY TRUTH ABOUT POSITIONS. Exits are clamped to
 * the latest venue read, never to the ledger; an open asserts from it that the
 * market is isolated at exactly the IMF policy judged (rule 6). account() is
 * the one authenticated read everything else (equity, the view, protect.ts)
 * takes positions from.
 */

import {
  LIGHTER_ROUTE_V1,
  effectiveMinNotionalMicro,
  isolatedLiqPrice,
  isolatedMarginMicro,
  notionalMicro,
  perpMarketById,
  perpMarketByKey,
  type PerpMarketSpec,
  type PerpSide,
} from "../../../packages/core/src/perps";
import type { PerpLegStatus, PerpOrderEffect, PerpTransferInitiator } from "../perp-ledger-rules";
import type { PerpOpenIntent, PerpOrderIntent } from "../policy";
import {
  PerpNotRecorded,
  type PerpOrderResolution,
  type PerpOrderRow,
  type PerpOrderSubmission,
  type PerpTransferInput,
  type PerpTransferOutcome,
} from "../store";
import type { LighterApi, LighterApiError, LighterResult, SendTxError, SendTxReceipt } from "./api";
import type { LighterAuth } from "./auth";
import { PerpRefused, type PerpExecutor, type PerpPlaceContext, type PerpPlaceResult, type PerpReview } from "./executor";
import { feedBookForPaperFill, feedMarketForOpen, type LighterFeedRead } from "./feed-reader";
import type { DepthLevel, PerpAccountPosition, PerpAccountRead, PerpDecimals, TxRead } from "./markets";
import type { NonceAllocator } from "./nonce";
import { simulateTakerFill } from "./paper";
import type { LighterSignerClient, SignContext, SignedLighterTx } from "./signer";

// ── constants ───────────────────────────────────────────────────────────────

/**
 * A venue stop's OrderExpiry, from now (rule 7). Inside the signer's own
 * window (15 min … 30 days − 1 h, judged when the tx executes), and three
 * weeks past protect.ts' 7-day renewal, so a stop is renewed long before it
 * can lapse.
 */
export const LIVE_STOP_EXPIRY_MS = 28 * 86_400_000;

/** An open's review must be this fresh when it is placed: rule 6's 30 s for prices an open may be judged at. */
export const LIVE_REVIEW_MAX_AGE_MS = 30_000;

/** Depth asked of the venue when the feed's book is stale (≤ 250; the feed carries 10 levels). */
export const LIVE_BOOK_READ_LIMIT = 50;

/**
 * The /tx poll after an accepted send: three reads over ~3 s. The venue's
 * standard-account taker latency is 300 ms and a tx is usually indexed within
 * a second; anything slower is reconcile's, which does not hold the lane's
 * lock or the exit budget while it waits.
 */
export const LIVE_TX_POLL_DELAYS_MS: readonly number[] = Object.freeze([400, 1_000, 1_600]);

const MICRO = 1_000_000n;
const BP = 10_000n;

// ── what the executor is given ──────────────────────────────────────────────

/** The slice of api.ts the executor calls — an address-keyed, authenticated client for the account's L1 address. */
export type LivePerpApi = Pick<LighterApi, "account" | "orderBookOrders" | "sendTx" | "tx">;

/** The ledger functions the live executor writes through — store.ts's own, injectable for a test. */
export interface LivePerpStore {
  insertPerpOrderSubmitted(s: PerpOrderSubmission): Promise<string>;
  resolvePerpOrder(r: PerpOrderResolution): Promise<boolean>;
  updatePerpLegStatus(u: {
    agentId: string;
    mode: "live";
    clientOrderIndex: number;
    status: PerpLegStatus;
    venueOrderIndex?: string | null;
    venueStatus?: string | null;
  }): Promise<boolean>;
  upsertPerpTransfer(t: PerpTransferInput): Promise<PerpTransferOutcome>;
  listSubmittedPerpOrders(agentId: string, mode: "live"): Promise<PerpOrderRow[]>;
}

export interface LivePerpExecutorOptions {
  agentId: string;
  /**
   * Accepted for parity with the paper executor and never used to book: the
   * store reads the epoch INSIDE each row's own transaction (perpBookingOf),
   * which is the one read that cannot race openNextEpoch.
   */
  epoch?: number | (() => number);
  accountIndex: number;
  /** The signer client for (account, route key); a getter picks up a rebuilt signer. */
  signerClient: LighterSignerClient | (() => LighterSignerClient);
  api: LivePerpApi;
  /** The fleet feed as this tick read it; null = unread. */
  feed: () => LighterFeedRead | null;
  store: LivePerpStore;
  nonces: NonceAllocator;
  auth: LighterAuth;
  /** ms — the clock the signer reads too. */
  now: () => number;
  /** The venue's clock minus ours (api.ts clockSkewMs), null when unmeasured. */
  clockSkewMs: () => number | null;
  /** A bounded stand-down's send cutoff, scoped to this asynchronous call. */
  sendNotAfterMs?: () => number | undefined;
  /**
   * Size and price decimals for EVERY perp market (orderBookDetails'
   * `decimals`), so a position in a market the feed does not carry is still
   * read exactly. Default: the markets the feed carries — a non-flat position
   * anywhere else then makes the account read unread, never smaller.
   */
  decimals?: () => ReadonlyMap<number, PerpDecimals> | null;
  /** Test seam: the wait between /tx polls. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: the /tx poll schedule (default LIVE_TX_POLL_DELAYS_MS). */
  txPollDelaysMs?: readonly number[];
}

// ── what it answers ─────────────────────────────────────────────────────────

/** The live dry run: PerpReview plus where its book came from and what the caps judge. */
export interface LivePerpReview extends PerpReview {
  /** The fleet feed's book (≤ 10 s), one authenticated venue read, or none (an exit is still reviewed without one). */
  bookSource: "feed" | "venue" | "unread";
  /** Open: base × max(worst, mark), rounded up — the exposure the caps judge. Exit: base × worst, or 0 when decimals are unread. */
  worstNotionalMicro: bigint;
  /** Exit: the venue-read position size it was clamped to. Open: null. */
  heldBase: bigint | null;
}

/** place()'s context on the live rail: the latest venue account read, when the caller has one. */
export interface LivePerpPlaceContext extends PerpPlaceContext {
  /** Absent or null: place() reads the account itself. */
  venue?: PerpAccountRead | null;
}

/** What happened to the one send. */
export type LiveSend =
  | { kind: "accepted"; tx: "executed" | "pending" | "rejected" | "app-error" | "unread" }
  | { kind: "refused"; code: number | null; maybeExecuted: boolean; detail: string }
  | { kind: "not-sent"; detail: string }
  | { kind: "unknown"; detail: string };

/** One signed venue tx, as recorded and sent. */
export interface LiveTxResult {
  orderRowId: string;
  txHash: string;
  txType: number;
  nonce: bigint;
  /**
   * What THIS call moved the rule-9 row to. `submitted` when it did not move
   * it: still waiting on the venue, or already moved by a reconcile that got
   * there first — the ledger, not this field, is the record.
   */
  rowStatus: "submitted" | "executed" | "rejected" | "app-error";
  send: LiveSend;
  /** The taker order's venue order index, when /tx showed it executed and named it. */
  venueOrderIndex: string | null;
  detail: string;
}

export interface LivePerpPlaceResult extends PerpPlaceResult {
  tx: LiveTxResult;
}

export type LiveAccountResult =
  | { ok: true; read: PerpAccountRead; serverDateMs: number | null }
  | { ok: false; detail: string; error: LighterApiError | null };

export type ResendResult = { sent: false; why: string } | { sent: true; result: LighterResult<SendTxReceipt, SendTxError> };

export interface LiveTxOptions {
  decisionId?: string | null;
  /** A fixed phrase for the row (never bytes). */
  reason?: string | null;
  /** Spend the exit end of the rate budget. Defaults per action. */
  exit?: boolean;
}

export interface LivePerpExecutor extends PerpExecutor {
  readonly mode: "live";
  review(intent: PerpOrderIntent): Promise<LivePerpReview>;
  place(intent: PerpOrderIntent, review: PerpReview, ctx: LivePerpPlaceContext): Promise<LivePerpPlaceResult>;
  /** ONE authenticated account read — the only source of live equity and positions. Unread is a value, never an empty account. */
  account(opts?: { exit?: boolean }): Promise<LiveAccountResult>;
  /**
   * Set a market isolated at `imfBp` (rule 6) — only while it is flat with no
   * open, pending or position-tied order at the venue and no unresolved row of
   * ours, else PerpRefused `perp-leverage-busy`. `already` when the venue
   * already reads exactly that. The caller confirms by re-reading the account.
   */
  ensureLeverage(marketId: number, imfBp: number, venue: PerpAccountRead, opts?: LiveTxOptions): Promise<LiveTxResult | { kind: "already"; detail: string }>;
  /** Cancel every order in ONE market (never account-wide: that would take other markets' stops). */
  cancelMarket(marketId: number, opts?: LiveTxOptions): Promise<LiveTxResult>;
  cancelOrder(marketId: number, orderIndex: bigint | number, opts?: LiveTxOptions): Promise<LiveTxResult>;
  /**
   * EVERY order on the account, every market, resting stops included — the
   * incident stand-down's (rule 16), for orders a compromised key left in
   * markets this worker never trades. Only once every market reads flat, or
   * after the owner accepted losing the stops (rule 13): hence the literal.
   */
  cancelAllAccountWide(opts: LiveTxOptions & { acknowledge: "removes-every-resting-stop" }): Promise<LiveTxResult>;
  /** A secure withdrawal (it can only pay the account's own L1 address) of at most the free cross collateral. */
  requestWithdraw(amountMicro: bigint, freeCollateralMicro: bigint, opts: LiveTxOptions & { initiator: PerpTransferInitiator }): Promise<LiveTxResult>;
  /**
   * A standalone position-tied STOP_LOSS (BaseAmount 0, reduce-only, 28-day
   * expiry) under the held `side`. The caller cancels the stop it supersedes
   * once this one is seen resting — never before (rule 13: no gap without one).
   */
  replaceStop(marketId: number, side: PerpSide, trigger: bigint, price: bigint, opts?: LiveTxOptions): Promise<LiveTxResult>;
  /** Re-send a submitted row's exact persisted bytes, before its ExpiredAt (see resendPersisted). */
  resendPersisted(row: PerpOrderRow): Promise<ResendResult>;
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** A promise-chain mutex (nonce.ts has its own): each call runs after the last one settled. */
function serialiser(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

function ceilDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && a > 0n ? q + 1n : q;
}

function unpriced(detail: string): PerpRefused {
  return new PerpRefused("perp-unpriced", detail);
}

function malformed(detail: string): PerpRefused {
  return new PerpRefused("perp-order-malformed", detail);
}

function errText(e: unknown): string {
  // Only messages we or api.ts wrote reach here (they carry no token or key);
  // anything else is named by its class.
  return e instanceof Error ? e.message.slice(0, 200) : "an unknown error";
}

/** Venue text bound for a row or a log line: short, and nothing key- or token-shaped (api.ts clip's rule). */
function venueText(s: string): string {
  return s
    .replace(/\d{9,11}:\d{1,16}:\d{1,3}:[0-9a-f]{160}/g, "[auth]")
    .replace(/(0x)?[0-9a-fA-F]{64,}/g, "[hex]")
    .slice(0, 80);
}

/**
 * The venue's depth lists one row per ORDER (parseDepth allows equal prices
 * from different orders); the taker walk wants one per PRICE, strictly
 * ordered. Summing equal neighbours is exactly what a taker sweeping them sees.
 */
function aggregated(levels: readonly DepthLevel[]): DepthLevel[] {
  const out: DepthLevel[] = [];
  for (const lv of levels) {
    const last = out[out.length - 1];
    if (last !== undefined && last.price === lv.price) out[out.length - 1] = { price: last.price, baseAmount: last.baseAmount + lv.baseAmount };
    else out.push({ price: lv.price, baseAmount: lv.baseAmount });
  }
  return out;
}

/** The position the venue holds in a market, or null when flat. */
function heldIn(acct: PerpAccountRead, marketId: number): (PerpAccountPosition & { side: PerpSide }) | null {
  const p = acct.positions.find((x) => x.marketId === marketId);
  return p !== undefined && p.baseAmount > 0n && p.side !== null ? (p as PerpAccountPosition & { side: PerpSide }) : null;
}

/** What an open asserts; place() refuses an open whose terms are not the ones reviewed. */
function openKey(o: PerpOpenIntent): string {
  return [o.marketId, "open", o.side, o.baseAmount, o.worstPrice, o.imfBp, o.stopTrigger, o.stopPrice, o.takeTrigger ?? "-", o.takePrice ?? "-"].join("|");
}

/**
 * The estimated isolated liquidation price of an open — policy.ts's own
 * arithmetic (rule 7): entry at the IOC's WORST price, margin at that entry
 * rounded DOWN, the market's maintenance constant. Both roundings put
 * liquidation nearer the entry, the direction that refuses sooner.
 */
function liqAtWorst(side: PerpSide, worst: bigint, base: bigint, imfBp: number, spec: PerpMarketSpec): bigint | null {
  const notionalAtWorst = notionalMicro(base, worst, spec, "floor");
  const am = (notionalAtWorst * BigInt(imfBp)) / BP;
  return isolatedLiqPrice({ side, entryPrice: worst, baseAmount: base, allocatedMarginMicro: am, mmfBp: spec.mmfBp, spec });
}

/** The exits-lane effects: a re-send of these may spend the exit reserve of the rate budget. */
function isExitRow(effect: PerpOrderEffect, reduceOnly: boolean): boolean {
  return reduceOnly || effect === "reduce" || effect === "close" || effect === "cancel" || effect === "withdraw" || effect === "standdown";
}

/**
 * Do the persisted bytes say what the row says? A row can come back from a
 * ledger another process wrote (a stand-down child, a restore); bytes that
 * name another account, key, nonce or expiry than their row are not bytes this
 * row may send. Null when they agree.
 */
function bytesDisagree(row: PerpOrderRow): string | null {
  let info: unknown;
  try {
    info = JSON.parse(row.txInfo as string);
  } catch {
    return "the persisted tx_info is not JSON";
  }
  if (typeof info !== "object" || info === null) return "the persisted tx_info is not an object";
  const i = info as Record<string, unknown>;
  const account = "AccountIndex" in i ? i.AccountIndex : i.FromAccountIndex;
  if (account !== row.accountIndex) return "the persisted bytes name another account";
  if (i.ApiKeyIndex !== row.apiKeyIndex) return "the persisted bytes name another key";
  if (i.Nonce !== row.nonce) return "the persisted bytes carry another nonce";
  if (i.ExpiredAt !== row.expiredAt) return "the persisted bytes carry another ExpiredAt";
  return null;
}

// ── re-sending persisted bytes (reconcile.ts) ───────────────────────────────

/**
 * RE-SEND A SUBMITTED ROW'S EXACT BYTES (rule 9: "Only persisted bytes are
 * re-sent, and never after ExpiredAt").
 *
 * Why the same bytes and never a re-signature: the Schnorr signature is
 * randomised, so a re-sign is a DIFFERENT tx with the same nonce — and if the
 * first one did execute, the pair is two claims on one nonce the ledger holds
 * only one row for. The persisted string is the only tx this row may ever be.
 *
 * Why the LATER of the two clocks: the sequencer judges ExpiredAt by its own.
 * With our clock behind it a send we think is in time can arrive expired —
 * harmless, the venue refuses it — but the write-off (ExpiredAt + 120 s with a
 * measured skew under 5 s) is only sound if nothing of ours can still execute
 * by then, so the send stops at whichever clock reaches ExpiredAt first.
 * Unmeasured skew leaves our clock alone to decide; rule 9 then never writes
 * the row off at all, so no send can race a write-off.
 *
 * RESOLVES NOTHING. A refusal of a re-send is not evidence the tx is dead —
 * the first send may have executed (21104, 21728), and even another code says
 * only that THIS attempt was refused. The row is resolved by hash alone.
 */
export async function resendPersisted(
  deps: {
    agentId: string;
    accountIndex: number;
    api: Pick<LighterApi, "sendTx">;
    now: () => number;
    clockSkewMs: () => number | null;
  },
  row: PerpOrderRow,
): Promise<ResendResult> {
  if (typeof row.agentId !== "string" || row.agentId.toLowerCase() !== deps.agentId.toLowerCase()) return { sent: false, why: "the row is another agent's" };
  if (row.mode !== "live") return { sent: false, why: "a paper row signed nothing" };
  if (row.status !== "submitted") return { sent: false, why: `the row is ${row.status}; only a submitted row is re-sent` };
  if (row.txInfo === null || row.txHash === null || row.txType === null || row.nonce === null || row.expiredAt === null || row.accountIndex === null || row.apiKeyIndex === null) {
    return { sent: false, why: "the row does not hold a complete signed tx" };
  }
  if (row.accountIndex !== deps.accountIndex || row.apiKeyIndex !== LIGHTER_ROUTE_V1.apiKeyIndex) {
    return { sent: false, why: `the row was signed for account ${row.accountIndex} key ${row.apiKeyIndex}, not this executor's` };
  }
  const disagree = bytesDisagree(row);
  if (disagree !== null) return { sent: false, why: disagree };
  const nowMs = deps.now();
  if (row.sendNotAfterMs != null && (!Number.isSafeInteger(row.sendNotAfterMs) || row.sendNotAfterMs <= 0 || nowMs >= row.sendNotAfterMs)) {
    return { sent: false, why: "the persisted send deadline expired or is unreadable; these bytes cannot be replayed" };
  }
  const skew = deps.clockSkewMs();
  const latest = skew !== null && Number.isFinite(skew) && skew > 0 ? nowMs + skew : nowMs;
  if (!Number.isFinite(latest) || latest >= row.expiredAt) {
    return { sent: false, why: `past ExpiredAt ${row.expiredAt} by the later of our clock and the venue's; the row waits for its write-off` };
  }
  try {
    const result = await deps.api.sendTx({ txType: row.txType, txInfo: row.txInfo, txHash: row.txHash }, {
      exit: isExitRow(row.effect, row.reduceOnly), notAfterMs: Math.min(row.expiredAt, row.sendNotAfterMs ?? Infinity),
    });
    return { sent: true, result };
  } catch (e) {
    // An argument guard in api.ts: thrown BEFORE sending, so nothing left.
    return { sent: false, why: `the transport refused the persisted bytes before sending: ${errText(e)}` };
  }
}

// ── the executor ────────────────────────────────────────────────────────────

interface Submission {
  effect: PerpOrderEffect;
  reduceOnly: boolean;
  marketId: number | null;
  worstNotionalMicro: bigint;
  decisionId: string | null;
  reason: string | null;
  withdraw: { amountMicro: bigint; initiator: PerpTransferInitiator } | null;
  exit: boolean;
  /** What is being signed, for the detail line. */
  what: string;
  notAfterMs?: number;
  /**
   * A refusal judged INSIDE the send lock, before a nonce is reserved — a
   * check against our own unresolved rows, which a concurrent send could
   * otherwise slip past between the check and the signature.
   */
  guard?: () => Promise<void>;
  /** Final lane veto immediately before transport after the durable row exists. */
  beforeSendGuard?: () => void | Promise<void>;
  sign: (client: LighterSignerClient, ctx: SignContext) => SignedLighterTx;
}

export function createLivePerpExecutor(opts: LivePerpExecutorOptions): LivePerpExecutor {
  const { agentId, accountIndex, api, store, nonces, auth } = opts;
  const apiKeyIndex = LIGHTER_ROUTE_V1.apiKeyIndex;
  if (typeof agentId !== "string" || agentId.trim() === "") throw new RangeError("live perp executor: an agent id is required");
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 1) throw new RangeError("live perp executor: accountIndex must be a positive integer");
  // One (agent, account, key) end to end: a nonce reserved for another
  // account, or a token minted for one, would sign or read the wrong book.
  if (nonces.agentId.toLowerCase() !== agentId.toLowerCase() || nonces.accountIndex !== accountIndex || nonces.apiKeyIndex !== apiKeyIndex) {
    throw new RangeError("live perp executor: the nonce allocator is for another agent, account or key");
  }
  if (auth.accountIndex !== accountIndex || auth.apiKeyIndex !== apiKeyIndex) throw new RangeError("live perp executor: the auth cache is for another account or key");
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollDelays = opts.txPollDelaysMs ?? LIVE_TX_POLL_DELAYS_MS;
  const serial = serialiser();

  function client(): LighterSignerClient {
    const c = typeof opts.signerClient === "function" ? opts.signerClient() : opts.signerClient;
    if (c.accountIndex !== accountIndex || c.apiKeyIndex !== apiKeyIndex) {
      throw new Error(`the signer client signs for account ${c.accountIndex} key ${c.apiKeyIndex}, not this executor's ${accountIndex}/${apiKeyIndex}`);
    }
    return c;
  }

  function decimalsNow(read: LighterFeedRead | null): ReadonlyMap<number, PerpDecimals> {
    const given = opts.decimals?.() ?? null;
    if (given !== null) return given;
    const m = new Map<number, PerpDecimals>();
    for (const [id, fm] of read?.markets ?? []) m.set(id, { sizeDecimals: fm.spec.sizeDecimals, priceDecimals: fm.spec.priceDecimals });
    return m;
  }

  async function readAccount(exit: boolean): Promise<LiveAccountResult> {
    const decimals = decimalsNow(opts.feed());
    let r: LighterResult<PerpAccountRead>;
    try {
      r = await auth.withAuth((a) => api.account({ by: "index", accountIndex }, decimals, { auth: a, exit }));
    } catch (e) {
      return { ok: false, detail: `the Lighter account could not be read: ${errText(e)}`, error: null };
    }
    if (!r.ok) return { ok: false, detail: r.error.detail, error: r.error };
    if (r.value.accountIndex !== accountIndex) return { ok: false, detail: `the venue answered for account ${r.value.accountIndex}, not ${accountIndex}`, error: null };
    return { ok: true, read: r.value, serverDateMs: r.serverDateMs };
  }

  /** The venue account place() judges against: the caller's latest read, or one taken now. */
  async function venueFor(ctx: LivePerpPlaceContext, exit: boolean, what: string): Promise<PerpAccountRead> {
    if (ctx.venue !== undefined && ctx.venue !== null) {
      if (ctx.venue.accountIndex !== accountIndex) throw malformed(`the venue read in the context is account ${ctx.venue.accountIndex}, not ${accountIndex}`);
      return ctx.venue;
    }
    const r = await readAccount(exit);
    // Rule 11: an unread account is not an empty one. An open is refused; an
    // exit cannot be sized — the lane tries again on the next read.
    if (!r.ok) throw unpriced(`the Lighter account is unread (${r.detail}), so ${what}`);
    return r.read;
  }

  /** The book an order is priced against: the feed's (≤ 10 s), else ONE authenticated read, else null. */
  async function bookFor(
    read: LighterFeedRead | null,
    marketId: number,
    spec: PerpMarketSpec,
    exit: boolean,
  ): Promise<{ bids: DepthLevel[]; asks: DepthLevel[]; observedAt: number; source: "feed" | "venue" } | null> {
    // feed-reader's "≤ 10 s" book accessor — named for the paper fill that
    // first needed it, and the same freshness rule for a live dry run.
    const f = feedBookForPaperFill(read, marketId);
    if (f !== null) return { bids: aggregated(f.bids), asks: aggregated(f.asks), observedAt: f.bookObservedAt, source: "feed" };
    const d: PerpDecimals = { sizeDecimals: spec.sizeDecimals, priceDecimals: spec.priceDecimals };
    try {
      const r = await auth.withAuth((a) => api.orderBookOrders(marketId, LIVE_BOOK_READ_LIMIT, d, { auth: a, exit }));
      if (!r.ok) return null;
      return { bids: aggregated(r.value.bids), asks: aggregated(r.value.asks), observedAt: opts.now(), source: "venue" };
    } catch {
      return null;
    }
  }

  /** The intent's own shape, checked where nothing downstream can re-check it (executor.ts's, for the live rail). */
  function shapeOf(intent: PerpOrderIntent): { exit: boolean } {
    const x = intent as PerpOrderIntent & Record<string, unknown>;
    if (x.kind !== "perp-order" || x.venue !== "lighter") throw malformed("not a Lighter perp order");
    const listed = perpMarketByKey(String(x.market));
    if (listed === null || listed.marketId !== x.marketId) throw malformed(`${String(x.market)} is not market ${String(x.marketId)} on Lighter`);
    if (x.side !== "long" && x.side !== "short") throw malformed("a perp order names the side long or short");
    if (typeof x.baseAmount !== "bigint" || x.baseAmount <= 0n || typeof x.worstPrice !== "bigint" || x.worstPrice <= 0n) {
      throw malformed("size and worst price must be positive venue integers");
    }
    if (x.effect === "open" && x.reduceOnly === false) return { exit: false };
    if ((x.effect === "reduce" || x.effect === "close") && x.reduceOnly === true) return { exit: true };
    throw malformed("an open is never reduce-only and an exit always is (rule 8)");
  }

  function walk(isAsk: boolean, base: bigint, worst: bigint, book: { bids: DepthLevel[]; asks: DepthLevel[] }, spec: PerpMarketSpec, feePpm: number) {
    try {
      return simulateTakerFill({ isAsk, baseAmount: base, worstPrice: worst, book, spec, takerFeePpm: feePpm });
    } catch (e) {
      throw malformed(`the order cannot be walked against the book: ${errText(e)}`);
    }
  }

  /**
   * Rule 8: clamped, never refused, for size. A close is the whole venue-read
   * position; a reduce is cut to it; a remainder under the market minimum
   * becomes a close (a stub the venue would not let us close on its own).
   * With the market's decimals unread, a reduce is kept as asked (clamped):
   * the minimum cannot be judged, and reduce-only means it cannot overshoot.
   */
  function clampExit(intent: PerpOrderIntent, held: PerpAccountPosition, read: LighterFeedRead | null): bigint {
    let base = intent.effect === "close" ? held.baseAmount : intent.baseAmount < held.baseAmount ? intent.baseAmount : held.baseAmount;
    const m = read?.markets.get(intent.marketId);
    if (base < held.baseAmount && m !== undefined) {
      const ref = m.mark > 0n ? m.mark : held.avgEntryPrice;
      if (ref > 0n && notionalMicro(held.baseAmount - base, ref, m.spec, "floor") < effectiveMinNotionalMicro(m.spec, ref)) base = held.baseAmount;
    }
    return base;
  }

  async function price(intent: PerpOrderIntent): Promise<LivePerpReview> {
    const { exit } = shapeOf(intent);
    const marketId = intent.marketId;
    const read = opts.feed();

    if (!exit) {
      const o = intent as PerpOpenIntent;
      const fresh = feedMarketForOpen(read, marketId);
      // Rule 11: an open is judged at prices ≤ 30 s old or not at all.
      if (fresh === null) throw unpriced(`${intent.market}'s prices are not in the Lighter feed or are older than 30 s`);
      if (fresh.status !== "active") throw new PerpRefused("perp-market-inactive", `${intent.market} is ${fresh.status} at the venue`);
      if (typeof o.stopTrigger !== "bigint" || typeof o.stopPrice !== "bigint" || o.stopTrigger <= 0n || o.stopPrice <= 0n) {
        throw new PerpRefused("perp-stop-required", "every open carries its own stop (rule 7)");
      }
      if ((o.takeTrigger === undefined) !== (o.takePrice === undefined)) throw malformed("a take-profit carries both its trigger and its bound, or neither");
      if (!Number.isSafeInteger(o.imfBp) || o.imfBp < 1 || o.imfBp > 10_000) throw malformed("the open's margin fraction is not 1..10000 bp");
      const spec = fresh.spec;
      const book = await bookFor(read, marketId, spec, false);
      if (book === null) throw unpriced(`${intent.market}'s order book is older than 10 s and a venue read of it failed`);
      const isAsk = o.side === "short";
      const fill = walk(isAsk, o.baseAmount, o.worstPrice, book, spec, fresh.takerFeePpm);
      // The caps judge the most the order can put on: its size at the worse
      // of its worst price and the mark (policy.ts's floor), and the margin
      // the venue will lock for it at the IMF this open asserts.
      const ref = o.worstPrice > fresh.mark ? o.worstPrice : fresh.mark;
      let worstNotional: bigint;
      let liq: bigint | null;
      try {
        worstNotional = notionalMicro(o.baseAmount, ref, spec, "ceil");
        liq = liqAtWorst(o.side, o.worstPrice, o.baseAmount, o.imfBp, spec);
      } catch (e) {
        throw unpriced(`${intent.market}'s terms cannot be priced: ${errText(e)}`);
      }
      const worstFee = ceilDiv(worstNotional * BigInt(fresh.takerFeePpm), MICRO);
      const expectedFill = fill.filledBase === 0n ? "none" : fill.filledBase === o.baseAmount ? "full" : "partial";
      return {
        intentKey: openKey(o),
        marketId,
        effect: "open",
        side: o.side,
        isAsk,
        baseAmount: o.baseAmount,
        worstPrice: o.worstPrice,
        mark: fresh.mark,
        expectedFill,
        filledBase: fill.filledBase,
        avgPrice: fill.avgPrice,
        notionalAtFillMicro: fill.filledQuoteMicro,
        feeMicro: fill.feeMicro,
        marginNeededMicro: isolatedMarginMicro(worstNotional, o.imfBp) + worstFee,
        liqPriceEstimate: liq,
        levels: fill.levels,
        bookObservedAt: book.observedAt,
        bookSource: book.source,
        worstNotionalMicro: worstNotional,
        heldBase: null,
        detail:
          `live open ${o.side} ${intent.market}: book (${book.source}) takes ${fill.filledBase}/${o.baseAmount} base` +
          (fill.avgPrice === null ? " — nothing inside the worst price" : ` @ ${fill.avgPrice}`),
      };
    }

    // AN EXIT: sized from the venue, priced if a book can be read, and never
    // refused for want of one — the venue fills a reduce-only IOC against the
    // book it sees, and rule 8 says an exit is always attemptable.
    const acct = await readAccount(true);
    if (!acct.ok) throw unpriced(`the Lighter account is unread (${acct.detail}), so the position to ${intent.effect} cannot be sized`);
    const held = heldIn(acct.read, marketId);
    if (held === null) throw new PerpRefused("perp-no-position", `Lighter shows no ${intent.market} position to ${intent.effect}`);
    if (held.side !== intent.side) throw new PerpRefused("perp-side-mismatch", `${intent.market} holds a ${held.side}, not the ${intent.side} this ${intent.effect} names`);
    const base = clampExit(intent, held, read);
    const effect = base === held.baseAmount ? "close" : "reduce";
    const isAsk = held.side === "long";
    const m = read?.markets.get(marketId);
    const spec = m?.spec ?? null;
    const book = spec === null ? null : await bookFor(read, marketId, spec, true);
    const fill =
      book !== null && spec !== null && m !== undefined
        ? walk(isAsk, base, intent.worstPrice, book, spec, m.takerFeePpm)
        : { filledBase: 0n, filledQuoteMicro: 0n, avgPrice: null, feeMicro: 0n, levels: [] as DepthLevel[] };
    let worstNotional = 0n;
    if (spec !== null) {
      try {
        worstNotional = notionalMicro(base, intent.worstPrice, spec, "ceil");
      } catch {
        worstNotional = 0n;
      }
    }
    return {
      intentKey: `${marketId}|${effect}|${held.side}|${base}|${intent.worstPrice}`,
      marketId,
      effect,
      side: held.side,
      isAsk,
      baseAmount: base,
      worstPrice: intent.worstPrice,
      mark: feedMarketForOpen(read, marketId)?.mark ?? null,
      expectedFill: book === null ? "none" : fill.filledBase === 0n ? "none" : fill.filledBase === base ? "full" : "partial",
      filledBase: fill.filledBase,
      avgPrice: fill.avgPrice,
      notionalAtFillMicro: fill.filledQuoteMicro,
      feeMicro: fill.feeMicro,
      marginNeededMicro: 0n,
      liqPriceEstimate: null,
      levels: fill.levels,
      bookObservedAt: book?.observedAt ?? 0,
      bookSource: book?.source ?? "unread",
      worstNotionalMicro: worstNotional,
      heldBase: held.baseAmount,
      detail:
        `live ${effect} ${held.side} ${intent.market}: ${base} of ${held.baseAmount} held` +
        (book === null ? " — the book is unread, sent unpriced (reduce-only)" : ` — book (${book.source}) takes ${fill.filledBase}`),
    };
  }

  /** Move a withdrawal's transfer row with its order row. Best effort: reconcile advances whatever this misses. */
  async function settleTransfer(s: Submission, txHash: string, state: "executed" | "failed"): Promise<string> {
    if (s.withdraw === null) return "";
    try {
      const out = await store.upsertPerpTransfer({
        agentId,
        mode: "live",
        direction: "withdraw",
        amountMicro: s.withdraw.amountMicro,
        initiator: s.withdraw.initiator,
        state,
        venueTxHash: txHash,
      });
      return out.outcome === "refused" ? `; its transfer row refused the move (${out.why})` : "";
    } catch (e) {
      return `; its transfer row could not be moved (${errText(e)}) — reconcile will`;
    }
  }

  /** Resolve the row this call sent. False (and a note) when the ledger did not move — reconcile resolves it by hash. */
  async function settle(id: string, status: "executed" | "rejected" | "app-error", reason: string | null): Promise<{ moved: boolean; note: string }> {
    try {
      const moved = await store.resolvePerpOrder({ agentId, mode: "live", id, status, reason });
      return { moved, note: moved ? "" : "; the row had already moved" };
    } catch (e) {
      return { moved: false, note: `; the row could not be resolved (${errText(e)}) — reconcile resolves it by hash` };
    }
  }

  /**
   * Poll /tx by OUR hash, bounded. A /tx answer that is not our tx (another
   * account, key, nonce or type at our hash) is no answer at all.
   */
  async function poll(signed: SignedLighterTx, exit: boolean): Promise<{ tx: "executed" | "pending" | "rejected" | "app-error" | "unread"; read: TxRead | null }> {
    let last: "pending" | "unread" = "unread";
    for (const d of pollDelays) {
      await sleep(d);
      let r: LighterResult<TxRead>;
      try {
        r = await auth.withAuth((a) => api.tx(signed.txHash, { auth: a, exit }));
      } catch {
        break;
      }
      if (!r.ok) {
        // Never spend the budget a close needs on a poll the reconciler will
        // repeat anyway. Anything else — not indexed yet (21500), a 5xx, a
        // garbled answer — is asked again, up to the bound.
        if (r.error.kind === "rate-limited") break;
        continue;
      }
      const t = r.value;
      if (t.accountIndex !== accountIndex || t.apiKeyIndex !== apiKeyIndex || t.nonce !== signed.nonce || t.type !== signed.txType) return { tx: "unread", read: null };
      if (t.outcome === "pending") {
        last = "pending";
        continue;
      }
      return { tx: t.outcome, read: t };
    }
    return { tx: last, read: null };
  }

  /** RESERVE → SIGN → PERSIST → SEND, under the send lock; then what the answer means to the row. */
  async function submit(s: Submission): Promise<LiveTxResult> {
    const sent = await serial(async () => {
      const deadlines = [s.notAfterMs, opts.sendNotAfterMs?.()].filter((x): x is number => x !== undefined);
      if (deadlines.some(x => !Number.isSafeInteger(x) || x <= 0)) throw malformed("the send deadline is invalid");
      const notAfterMs = deadlines.length ? Math.min(...deadlines) : undefined;
      const checkDeadline = () => {
        if (notAfterMs !== undefined && opts.now() >= notAfterMs) throw unpriced("the request expired before send");
      };
      checkDeadline();
      if (s.guard) await s.guard();
      const c = client();
      const reserved = await nonces.next();
      checkDeadline();
      const signed = s.sign(c, { accountIndex, nonce: reserved.nonce, nonceHighWater: reserved.previousHighWater });
      if (signed.accountIndex !== accountIndex || signed.apiKeyIndex !== apiKeyIndex || BigInt(signed.nonce) !== reserved.nonce) {
        throw new Error("the signer returned a tx for another account, key or nonce; nothing was persisted or sent");
      }
      let id: string;
      try {
        id = await store.insertPerpOrderSubmitted({
          agentId,
          mode: "live",
          effect: s.effect,
          reduceOnly: s.reduceOnly,
          marketId: s.marketId,
          worstNotionalMicro: s.worstNotionalMicro,
          decisionId: s.decisionId,
          reason: s.reason,
          signed,
          withdraw: s.withdraw,
          sendNotAfterMs: notAfterMs,
        });
      } catch (e) {
        // A failed write sends NOTHING (rule 9). Whatever the store threw, the
        // caller gets the one type that says so.
        if (e instanceof PerpNotRecorded) throw e;
        throw new PerpNotRecorded("the ledger refused the write", signed.txHash, { cause: e });
      }
      try {
        // The durable write may outlast the owner's request. Persist its
        // deadline too, so a crash or failed resolution cannot revive it.
        checkDeadline();
        await s.beforeSendGuard?.();
        checkDeadline();
        const result = await api.sendTx({ txType: signed.txType, txInfo: signed.txInfo, txHash: signed.txHash }, {
          exit: s.exit, notAfterMs: Math.min(signed.expiredAt, notAfterMs ?? Infinity),
        });
        return { id, signed, result, thrown: null };
      } catch (e) {
        // api.ts's argument guards throw BEFORE sending: nothing left.
        return { id, signed, result: null, thrown: e };
      }
    });

    const { id, signed } = sent;
    const head = { orderRowId: id, txHash: signed.txHash, txType: signed.txType, nonce: BigInt(signed.nonce), venueOrderIndex: null as string | null };
    const say = (x: string) => `${s.what} (tx ${signed.txHash.slice(0, 12)}…, nonce ${signed.nonce}): ${x}`;

    if (sent.result === null) {
      const r = await settle(id, "rejected", "not-sent: transport refused the arguments");
      const t = r.moved ? await settleTransfer(s, signed.txHash, "failed") : "";
      return {
        ...head,
        rowStatus: r.moved ? "rejected" : "submitted",
        send: { kind: "not-sent", detail: errText(sent.thrown) },
        detail: say(`not sent — ${errText(sent.thrown)}${r.note}${t}`),
      };
    }
    const res = sent.result;
    if (!res.ok) {
      const e = res.error;
      if (e.kind === "refused-send") {
        const send: LiveSend = { kind: "refused", code: e.code, maybeExecuted: e.maybeExecuted, detail: e.detail };
        // An execution may already exist behind these bytes: only the hash can say.
        if (e.maybeExecuted) return { ...head, rowStatus: "submitted", send, detail: say(`refused (${e.code}) in a way an executed tx also would be; the row stays submitted and is resolved by hash`) };
        // A FIRST send the venue refused never entered the sequencer: the
        // nonce was not consumed and these bytes are dead.
        const r = await settle(id, "rejected", `send refused: code ${e.code ?? "none"} (HTTP ${e.status})`);
        const t = r.moved ? await settleTransfer(s, signed.txHash, "failed") : "";
        return { ...head, rowStatus: r.moved ? "rejected" : "submitted", send, detail: say(`refused by the venue: ${e.detail}${r.note}${t}`) };
      }
      if (e.kind === "rate-limited" && e.source !== "venue") {
        // Our own brake stopped it before fetch: certainly not sent.
        const r = await settle(id, "rejected", `not-sent: ${e.source}`);
        const t = r.moved ? await settleTransfer(s, signed.txHash, "failed") : "";
        return { ...head, rowStatus: r.moved ? "rejected" : "submitted", send: { kind: "not-sent", detail: e.detail }, detail: say(`not sent — ${e.detail}${r.note}${t}`) };
      }
      // Timeout, 5xx, a garbled answer, the venue's own limiter: unknown.
      return { ...head, rowStatus: "submitted", send: { kind: "unknown", detail: e.detail }, detail: say(`outcome unknown (${e.kind}); the row stays submitted and is resolved by hash`) };
    }

    const p = await poll(signed, s.exit);
    const send: LiveSend = { kind: "accepted", tx: p.tx };
    if (p.tx === "executed") {
      const r = await settle(id, "executed", null);
      const t = r.moved ? await settleTransfer(s, signed.txHash, "executed") : "";
      let venueOrderIndex: string | null = null;
      const ev = p.read;
      // event_info names the taker order (`to`): record its venue index on
      // OUR leg with that client order index — never on a leg it is not.
      if (ev !== null && ev.orderIndex !== null && ev.clientOrderIndex !== null && signed.clientOrderIndexes.some((l) => l.clientOrderIndex === ev.clientOrderIndex)) {
        try {
          await store.updatePerpLegStatus({ agentId, mode: "live", clientOrderIndex: ev.clientOrderIndex, status: "submitted", venueOrderIndex: ev.orderIndex });
          venueOrderIndex = ev.orderIndex;
        } catch {
          // Reconcile learns it from the venue's orders; nothing depends on it now.
        }
      }
      return { ...head, venueOrderIndex, rowStatus: r.moved ? "executed" : "submitted", send, detail: say(`executed at the venue; fills are reconcile's to book${r.note}${t}`) };
    }
    if (p.tx === "rejected" || p.tx === "app-error") {
      const why = p.tx === "app-error" ? `app error: ${venueText(p.read?.appError ?? "")}` : "sequencer status 0";
      const r = await settle(id, p.tx, why);
      const t = r.moved ? await settleTransfer(s, signed.txHash, "failed") : "";
      return { ...head, rowStatus: r.moved ? p.tx : "submitted", send, detail: say(`${p.tx === "app-error" ? "refused by the venue's application" : "rejected by the sequencer"}${r.note}${t}`) };
    }
    return { ...head, rowStatus: "submitted", send, detail: say(`accepted; ${p.tx === "pending" ? "still pending" : "not yet readable"} after the poll — reconcile resolves it by hash`) };
  }

  function placed(tx: LiveTxResult, what: string): LivePerpPlaceResult {
    return {
      status: tx.send.kind === "not-sent" || tx.rowStatus === "rejected" || tx.rowStatus === "app-error" ? "rejected" : "submitted",
      orderRowId: tx.orderRowId,
      nonce: tx.nonce,
      // The venue fills, on its own clock: what filled is reconcile's to
      // ingest by venue identity (rule 10), never guessed from the review.
      filledBase: 0n,
      filledQuoteMicro: 0n,
      avgPrice: null,
      feeMicro: 0n,
      detail: `${what}; ${tx.detail}`,
      tx,
    };
  }

  /** Our own rows still waiting on the venue; unread is a refusal, never "none". */
  async function unresolvedRows(what: string): Promise<PerpOrderRow[]> {
    try {
      return await store.listSubmittedPerpOrders(agentId, "live");
    } catch (e) {
      throw unpriced(`the ledger's unresolved orders are unread (${errText(e)}), so ${what}`);
    }
  }

  function checkMarket(marketId: number): void {
    if (!Number.isSafeInteger(marketId) || perpMarketById(marketId) === null) throw malformed(`market ${String(marketId)} is not in LIGHTER_MARKETS_V1`);
  }

  return {
    mode: "live",

    async review(intent) {
      return price(intent);
    },

    async place(intent, review, ctx) {
      if (typeof ctx?.agentId !== "string" || ctx.agentId.toLowerCase() !== agentId.toLowerCase()) {
        throw malformed("this order was placed for another agent's venue account");
      }
      const { exit } = shapeOf(intent);
      const marketId = intent.marketId;
      if (review.marketId !== marketId) throw malformed("the order is not the one that was reviewed");

      if (!exit) {
        const o = intent as PerpOpenIntent;
        if (review.effect !== "open" || review.intentKey !== openKey(o)) throw malformed("the open is not the one that was reviewed");
        const nowMs = opts.now();
        if (!(nowMs - review.bookObservedAt <= LIVE_REVIEW_MAX_AGE_MS)) throw unpriced("the review is older than 30 s; an open is priced again before it is signed");
        const fresh = feedMarketForOpen(opts.feed(), marketId);
        if (fresh === null) throw unpriced(`${intent.market}'s prices went stale between review and place`);
        if (fresh.status !== "active") throw new PerpRefused("perp-market-inactive", `${intent.market} is ${fresh.status} at the venue`);
        // Rule 6, asserted again where it is signed: policy judged it on the
        // lane's read, and the venue is the only authority on leverage.
        const venue = await venueFor(ctx, false, "nothing is opened");
        const pos = venue.positions.find((p) => p.marketId === marketId) ?? null;
        if (pos !== null && pos.baseAmount > 0n) throw new PerpRefused("perp-add-to-position", `Lighter already holds a ${pos.side ?? "position"} in ${intent.market}; an open never adds to it`);
        if (pos === null || pos.marginMode !== "isolated") throw new PerpRefused("perp-leverage-unset", `Lighter does not read ${intent.market} as isolated margin for this account`);
        if (pos.imfBp !== o.imfBp) throw new PerpRefused("perp-leverage-mismatch", `Lighter reads ${intent.market} at ${pos.imfBp} bp, not the ${o.imfBp} this open asserts`);
        const hasTake = typeof o.takeTrigger === "bigint" && typeof o.takePrice === "bigint";
        if (!hasTake && (o.takeTrigger !== undefined || o.takePrice !== undefined)) throw malformed("a take-profit carries both its trigger and its bound, or neither");
        const expiry = Math.floor(nowMs) + LIVE_STOP_EXPIRY_MS;
        const ref = o.worstPrice > fresh.mark ? o.worstPrice : fresh.mark;
        let worst = notionalMicro(o.baseAmount, ref, fresh.spec, "ceil");
        if (o.notionalUsdg > worst) worst = o.notionalUsdg;
        const reviewed = (review as Partial<LivePerpReview>).worstNotionalMicro;
        if (typeof reviewed === "bigint" && reviewed > worst) worst = reviewed;
        const tx = await submit({
          effect: "open",
          reduceOnly: false,
          marketId,
          worstNotionalMicro: worst,
          decisionId: ctx.decisionId ?? null,
          reason: null,
          withdraw: null,
          exit: false,
          what: `open ${o.side} ${intent.market}`,
          notAfterMs: ctx.notAfterMs,
          // Rule 9: nothing new on a market whose last tx has no outcome yet.
          guard: async () => {
            const pending = (await unresolvedRows("nothing is opened")).filter((r) => r.marketId === marketId && r.status === "submitted");
            if (pending.length > 0) throw new PerpRefused("perp-close-in-flight", `a ${pending[0]?.effect ?? "tx"} on ${intent.market} has no outcome yet`);
            await ctx.beforeCommit?.();
          },
          beforeSendGuard: ctx.beforeCommit,
          // ONE grouped tx (rule 7): OTO [IOC entry, SL], or OTOCO with the
          // take. The children are BaseAmount 0 and reduce-only — the venue
          // sizes them to what the entry actually filled — and expire
          // together in 28 days.
          sign: (c, sctx) =>
            c.signCreateGroupedOrders(
              {
                marketId,
                side: o.side,
                baseAmount: o.baseAmount,
                worstPrice: o.worstPrice,
                stopLoss: { triggerPrice: o.stopTrigger, price: o.stopPrice, orderExpiry: expiry },
                ...(hasTake ? { takeProfit: { triggerPrice: o.takeTrigger as bigint, price: o.takePrice as bigint, orderExpiry: expiry } } : {}),
              },
              sctx,
            ),
        });
        return placed(tx, review.detail);
      }

      // AN EXIT: sized from the latest venue read, reduce-only, never refused
      // for size, and never checked against an earlier ambiguous close — a new
      // reduce-only close is always signable (rule 9's exception): it cannot
      // flip, and once it executes the earlier one is dead.
      if (review.side !== intent.side) throw malformed("the exit is not the one that was reviewed");
      const venue = await venueFor(ctx, true, "the position cannot be sized");
      const held = heldIn(venue, marketId);
      if (held === null) throw new PerpRefused("perp-no-position", `Lighter shows no ${intent.market} position to ${intent.effect}`);
      if (held.side !== intent.side) throw new PerpRefused("perp-side-mismatch", `${intent.market} holds a ${held.side}, not the ${intent.side} this ${intent.effect} names`);
      const read = opts.feed();
      const base = clampExit(intent, held, read);
      const effect = base === held.baseAmount ? "close" : "reduce";
      // A long is closed by selling, a short by buying — from the side HELD,
      // never from anything a producer said about direction.
      const isAsk = held.side === "long";
      const spec = read?.markets.get(marketId)?.spec ?? null;
      let worst = 0n;
      if (spec !== null) {
        try {
          worst = notionalMicro(base, intent.worstPrice, spec, "ceil");
        } catch {
          worst = 0n;
        }
      }
      const tx = await submit({
        effect,
        reduceOnly: true,
        marketId,
        worstNotionalMicro: worst,
        decisionId: ctx.decisionId ?? null,
        reason: null,
        withdraw: null,
        exit: true,
        what: `${effect} ${held.side} ${intent.market} (${base} of ${held.baseAmount})`,
        notAfterMs: ctx.notAfterMs,
        sign: (c, sctx) => c.signCreateOrder({ kind: "close", marketId, isAsk, baseAmount: base, worstPrice: intent.worstPrice }, sctx),
      });
      return placed(tx, review.detail);
    },

    account(o = {}) {
      return readAccount(o.exit === true);
    },

    async ensureLeverage(marketId, imfBp, venue, o = {}) {
      checkMarket(marketId);
      if (!Number.isSafeInteger(imfBp) || imfBp < 1 || imfBp > 10_000) throw malformed(`${String(imfBp)} bp is not a margin fraction`);
      if (venue?.accountIndex !== accountIndex) throw malformed("the venue read is not this account's");
      const key = perpMarketById(marketId)?.key ?? `market ${marketId}`;
      const pos = venue.positions.find((p) => p.marketId === marketId) ?? null;
      if (pos !== null && pos.marginMode === "isolated" && pos.imfBp === imfBp) return { kind: "already", detail: `${key} already reads isolated at ${imfBp} bp` };
      // Rule 6: leverage changes only while the market is flat and holds no
      // order — it would re-margin a live position, and the venue refuses a
      // margin-mode change with anything resting anyway.
      if (pos !== null && (pos.baseAmount > 0n || pos.openOrderCount > 0 || pos.pendingOrderCount > 0 || pos.positionTiedOrderCount > 0)) {
        throw new PerpRefused(
          "perp-leverage-busy",
          `${key} is not flat at the venue (${pos.baseAmount} base, ${pos.openOrderCount} open, ${pos.pendingOrderCount} pending, ${pos.positionTiedOrderCount} position-tied orders)`,
        );
      }
      const m = opts.feed()?.markets.get(marketId);
      if (m === undefined) throw unpriced(`${key}'s minimum margin fraction is unread, so no leverage is set`);
      const minImfBp = m.spec.minImfBp;
      return submit({
        effect: "leverage",
        reduceOnly: false,
        marketId,
        worstNotionalMicro: 0n,
        decisionId: o.decisionId ?? null,
        reason: o.reason ?? null,
        withdraw: null,
        exit: o.exit ?? false,
        what: `leverage ${key} isolated at ${imfBp} bp`,
        // …and a tx of ours the venue read may not show yet is not flat either.
        guard: async () => {
          const pending = (await unresolvedRows("leverage is not changed")).filter((r) => r.marketId === marketId && r.status === "submitted");
          if (pending.length > 0) throw new PerpRefused("perp-leverage-busy", `a ${pending[0]?.effect ?? "tx"} on ${key} has no outcome yet`);
        },
        sign: (c, sctx) => c.signUpdateLeverage({ marketId, imfBp, minImfBp }, sctx),
      });
    },

    async cancelMarket(marketId, o = {}) {
      checkMarket(marketId);
      const key = perpMarketById(marketId)?.key ?? `market ${marketId}`;
      return submit({
        effect: "cancel",
        reduceOnly: false,
        marketId,
        worstNotionalMicro: 0n,
        decisionId: o.decisionId ?? null,
        reason: o.reason ?? null,
        withdraw: null,
        // Cancels run in the exits lane (stand-down, cleanup once flat, a
        // superseded stop): they may use the reserved end of the budget.
        exit: o.exit ?? true,
        what: `cancel every order in ${key}`,
        sign: (c, sctx) => c.signCancelAllOrders({ marketId }, sctx),
      });
    },

    async cancelOrder(marketId, orderIndex, o = {}) {
      checkMarket(marketId);
      const key = perpMarketById(marketId)?.key ?? `market ${marketId}`;
      return submit({
        effect: "cancel",
        reduceOnly: false,
        marketId,
        worstNotionalMicro: 0n,
        decisionId: o.decisionId ?? null,
        reason: o.reason ?? null,
        withdraw: null,
        exit: o.exit ?? true,
        what: `cancel order ${String(orderIndex)} in ${key}`,
        sign: (c, sctx) => c.signCancelOrder({ marketId, orderIndex }, sctx),
      });
    },

    async cancelAllAccountWide(o) {
      if (o?.acknowledge !== "removes-every-resting-stop") throw malformed('an account-wide cancel is acknowledged with "removes-every-resting-stop"');
      return submit({
        effect: "cancel",
        reduceOnly: false,
        marketId: null,
        worstNotionalMicro: 0n,
        decisionId: o.decisionId ?? null,
        reason: o.reason ?? "account-wide-cancel",
        withdraw: null,
        exit: o.exit ?? true,
        what: "cancel every order on the account",
        sign: (c, sctx) => c.signCancelAllOrdersAccountWide({ acknowledge: "removes-every-resting-stop" }, sctx),
      });
    },

    async requestWithdraw(amountMicro, freeCollateralMicro, o) {
      if (typeof amountMicro !== "bigint" || amountMicro <= 0n) throw malformed("a withdrawal names a positive micro-USDG amount");
      // Never more than the FREE cross collateral of the last venue read:
      // isolated margin is a position's, and asking for it is a refusal at
      // best. The signer bounds it again from the same number.
      if (typeof freeCollateralMicro !== "bigint" || freeCollateralMicro <= 0n) {
        throw new PerpRefused("perp-withdraw-exceeds-free", "there is no free cross collateral at the venue to withdraw");
      }
      if (amountMicro > freeCollateralMicro) {
        throw new PerpRefused("perp-withdraw-exceeds-free", `${amountMicro} micro-USDG is more than the ${freeCollateralMicro} free at the venue`);
      }
      return submit({
        effect: "withdraw",
        reduceOnly: false,
        marketId: null,
        worstNotionalMicro: 0n,
        decisionId: o.decisionId ?? null,
        reason: o.reason ?? null,
        // The perp_transfers row rides in the order row's own transaction
        // (store.ts insertPerpOrderSubmitted): a request without its transfer
        // is money the in-transit sum would never see.
        withdraw: { amountMicro, initiator: o.initiator },
        exit: o.exit ?? true,
        what: `withdraw ${amountMicro} micro-USDG to the account's own L1 address`,
        // Rule 9 for withdrawals: never a second request while an earlier
        // one's outcome is unknown — `executed` is known (it ran; its payout is
        // the transfer row's to track), `submitted` is not.
        guard: async () => {
          const pending = (await unresolvedRows("no withdrawal is requested")).filter((r) => r.effect === "withdraw" && r.status === "submitted");
          if (pending.length > 0) throw new PerpRefused("perp-withdraw-in-flight", "an earlier withdrawal request has no outcome yet");
        },
        sign: (c, sctx) => c.signWithdraw({ amountMicro, freeCollateralMicro }, sctx),
      });
    },

    async replaceStop(marketId, side, trigger, price, o = {}) {
      checkMarket(marketId);
      if (side !== "long" && side !== "short") throw malformed("a stop names the side held, long or short");
      if (typeof trigger !== "bigint" || typeof price !== "bigint" || trigger <= 0n || price <= 0n) {
        throw new PerpRefused("perp-stop-required", "a stop names a positive trigger and bound");
      }
      const key = perpMarketById(marketId)?.key ?? `market ${marketId}`;
      // A stop the mark is already past fires the moment it rests: that is a
      // close by another name, protect.ts P2's to make. Judged only on a
      // CURRENT mark; with none, the stop is placed anyway — a stop under an
      // unprotected position is never worse than no stop.
      const fresh = feedMarketForOpen(opts.feed(), marketId);
      if (fresh !== null && !(side === "long" ? trigger < fresh.mark : trigger > fresh.mark)) {
        throw new PerpRefused("perp-stop-required", `a ${side} stop at ${trigger} is not on the losing side of the mark ${fresh.mark}`);
      }
      const expiry = Math.floor(opts.now()) + LIVE_STOP_EXPIRY_MS;
      return submit({
        // A position-tied stop closes the whole position when it fires: the
        // row is a reduce-only `close` with no notional (an exit is never
        // spend), and it holds opens on this market until it is final.
        effect: "close",
        reduceOnly: true,
        marketId,
        worstNotionalMicro: 0n,
        decisionId: o.decisionId ?? null,
        reason: o.reason ?? "protective-stop",
        withdraw: null,
        exit: o.exit ?? true,
        what: `stop under the ${side} ${key} at ${trigger} (no worse than ${price})`,
        sign: (c, sctx) => c.signCreateOrder({ kind: "stop-loss", marketId, isAsk: side === "long", triggerPrice: trigger, price, orderExpiry: expiry }, sctx),
      });
    },

    resendPersisted(row) {
      // Under the send lock, like every send: one tx of ours in flight at a
      // time, so a re-send never races a fresh signature to the sequencer.
      return serial(() => resendPersisted({ agentId, accountIndex, api, now: opts.now, clockSkewMs: opts.clockSkewMs }, row));
    },
  };
}
