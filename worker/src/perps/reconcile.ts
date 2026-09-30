/**
 * THE LIVE RECONCILER — what happened at Lighter, booked once, and what the
 * venue shows that we did not do, noticed (docs/perps.md rules 9, 10, 11, 12,
 * 16 and the Ledger's "Hosted" bullet; key-amendments replay-model-nonce-not-
 * coi, redeploy-restart-lifecycle, unknown-activity-freeze; accounting
 * fill-and-funding-identity, venue-delta-identity-check, money-precision).
 *
 * THE VENUE IS AUTHORITATIVE FOR WHAT HAPPENED; THE LEDGER RECORDS IT ONCE.
 * Nothing here decides anything a model could want: it reads the venue, and
 * writes what the venue says through store.ts's idempotent writers, each fact
 * with its hash-chained journal entry in one transaction. A re-read books
 * nothing twice (insertPerpFill's `duplicate`), so every step may re-read an
 * overlapping window and every pass may be repeated after a crash.
 *
 * ONE PASS, IN ORDER (reconcileOnce — each tick, and at arm):
 *
 *   0 arm       the ledger is CONTINUOUS (its nonce high-water reaches the
 *               venue's last nonce for our key) or it is rebuilt from the venue
 *               first: a hosted redeploy wipes the child's sqlite, and the
 *               day's opens, the orders resting at the venue and the fills
 *               since are then only at Lighter (redeploy-restart-lifecycle).
 *               Until the rebuild completes, and for one signer ExpiredAt
 *               horizon after it, the pass reports a gap — opens wait.
 *   1 resolve   every `submitted` rule-9 row, by tx hash — never by anything
 *               weaker (see resolveSubmitted).
 *   2 fills     venue orders (legs learn their venue index and status; an
 *               order signed with our client-index scheme and no row is
 *               ADOPTED; anything else is unknown activity) and the account's
 *               trades since an overlapping cursor, each side of each trade
 *               booked with its provenance; then `executed` rows are finalized
 *               from the venue's final order record and the fills booked.
 *   3 funding   positionFunding, by the venue's funding id.
 *   4 transfers withdraw/history advances our withdrawal rows (never to
 *               `paid` — payouts.ts decides that from the chain).
 *   5 account   ONE /api/v1/account read: rule 12's C, ΣM and ΣU.
 *   6 sync      perp_positions (the venue cache) from that one read.
 *   7 delta     Δ(C + ΣM) must equal Σ(realized − fee + funding) + credited
 *               deposits − executed withdrawals between two reads.
 *   8 incidents rule 16's triggers over this pass's reads; a flag is written
 *               durably before this function returns (incident.ts).
 *
 * FAILURE IS A GAP, NEVER A THROW AND NEVER A ZERO (rule 11). Every external
 * read is bounded by api.ts (time, size, rate) and every failure here — a
 * read, a parse, a write — becomes a string in `gaps` and the step stops
 * short of anything it cannot stand behind: a cursor never moves past a fact
 * that was not booked, a row is never resolved on an answer that contradicts
 * it, and a fill whose provenance could not be established this pass is left
 * for the next one rather than guessed. The caller refuses every non-exit
 * intent while `gaps` is non-empty; exits are still attempted.
 *
 * WHAT THIS MODULE NEVER DOES: sign, send (except `resend`, the executor's
 * re-send of the EXACT persisted bytes before their ExpiredAt), decide
 * `paid`, or respond to an incident beyond persisting its flag.
 */

import { LIGHTER_ROUTE_V1, PERP_COI_MAX, notionalMicro } from "../../../packages/core/src/perps";
import type { PerpAttribution, PerpLegRole, PerpLegStatus } from "../perp-ledger-rules";
import type {
  PerpAccountPatch,
  PerpAccountRow,
  PerpFillInput,
  PerpFundingInput,
  PerpFundingOutcome,
  PerpInsertOutcome,
  PerpLegRow,
  PerpOrderResolution,
  PerpOrderRow,
  PerpPositionInput,
  PerpPositionRow,
  PerpTransferInput,
  PerpTransferOutcome,
  PerpTransferRow,
} from "../store";
import type { LighterApi, LighterResult, RequestFlags } from "./api";
import { detectIncidents, incidentReadGaps, persistIncident, type Incident, type IncidentInputs } from "./incident";
import type {
  ApiKeyRead,
  OurTradeSide,
  PerpAccountRead,
  PerpDecimals,
  PerpTrade,
  PositionFundingRow,
  TxRead,
  VenueOrder,
  WithdrawHistoryRow,
} from "./markets";
import { ADOPTED_REASON, type AdoptedPerpLeg, type AdoptedPerpOrderInput } from "./reconcile-ledger";

// ── constants, each a decision ──────────────────────────────────────────────

/** A pending tx's persisted bytes are re-sent at most this often (the venue may drop a queued tx; the bytes are the same tx). */
export const RESEND_AFTER_MS = 10_000;
/** Rule 9: `not-found` becomes `expired` only this long past ExpiredAt… */
export const EXPIRY_GRACE_MS = 120_000;
/** …and only with our clock measured within this of the venue's. */
export const MAX_SKEW_MS = 5_000;
/** The signer sets ExpiredAt = its clock + 599 s; a tx a lost ledger signed can execute this long after the loss. */
export const SIGNER_EXPIRY_HORIZON_MS = 600_000;
/** The fill cursor re-reads this much behind the newest trade booked: the venue's trade index can lag its execution. */
export const FILL_CURSOR_OVERLAP_MS = 5 * 60_000;
/** The funding cursor's overlap: funding lands on the hour and the venue's history can lag it. */
export const FUNDING_CURSOR_OVERLAP_SEC = 2 * 3_600;
/** What a rebuild re-reads: the venue keeps ~24 h of inactive orders; two hours more catch a boundary. */
export const REBUILD_WINDOW_MS = 26 * 3_600_000;
/** The venue-delta identity's tolerance, per record in the window (fee and realized rounding, money-precision). */
export const DELTA_TOLERANCE_PER_RECORD_MICRO = 2n;
/** Consecutive delta mismatches after which the venue's money is doubtful — rule 16(e) — rather than a race between reads. */
export const DELTA_DOUBTFUL_AFTER = 3;
/** A deposit landed on chain and still not seen credited after this is a gap (T_in would otherwise count it twice). */
export const DEPOSIT_CREDIT_GRACE_MS = 10 * 60_000;

const TRADE_PAGE = 100;
const MAX_TRADE_PAGES = 10;
const ORDER_PAGE = 100;
/** The venue keeps about 1K inactive orders; reaching this many pages is "maybe more", which is a gap. */
const MAX_INACTIVE_PAGES = 10;
const FUNDING_PAGE = 100;
const MAX_FUNDING_PAGES = 5;
const MAX_WITHDRAW_PAGES = 3;
/** /tx lookups per pass for rule-9 rows; the rest wait for the next pass (the address budget is 40/min for routine reads). */
const MAX_RESOLVE_LOOKUPS = 20;
/** /tx lookups per pass to learn who signed an unmatched trade. */
const MAX_ORPHAN_TX_LOOKUPS = 5;
const DECIMALS_TTL_MS = 30 * 60_000;
/** A stop child can rest 28 days before it trades; a client index whose nonce is further from its trade than this is not ours. */
const SCHEME_NONCE_SPAN_MS = 30 * 86_400_000;
const LEG_ROLE: Readonly<Record<number, PerpLegRole>> = Object.freeze({ 0: "entry", 1: "sl", 2: "tp", 3: "close" });
const ORDER_TX_TYPES: ReadonlySet<number> = new Set([14, 28]);
const WITHDRAW_TX_TYPE = 13;

// ── what the reconciler is given ────────────────────────────────────────────

/** The api.ts methods the reconciler reads through (an authenticated, address-keyed client). */
export type LiveReconcileApi = Pick<
  LighterApi,
  | "tx"
  | "trades"
  | "positionFunding"
  | "withdrawHistory"
  | "account"
  | "apikeys"
  | "accountsByL1Address"
  | "accountActiveOrders"
  | "accountInactiveOrders"
  | "orderBookDetails"
>;

/**
 * The ledger functions it books through — store.ts's own, except the last
 * two, which store.ts wires from reconcile-ledger.ts (see that file's header).
 */
export interface LiveReconcileStore {
  listSubmittedPerpOrders(agentId: string, mode: "live"): Promise<PerpOrderRow[]>;
  resolvePerpOrder(r: PerpOrderResolution): Promise<boolean>;
  updatePerpLegStatus(u: {
    agentId: string;
    mode: "live";
    clientOrderIndex: number;
    status: PerpLegStatus;
    venueOrderIndex?: string | null;
    venueStatus?: string | null;
  }): Promise<boolean>;
  perpOrderByCoi(agentId: string, mode: "live", clientOrderIndex: number | bigint): Promise<{ order: PerpOrderRow; leg: PerpLegRow } | null>;
  insertPerpFill(fill: PerpFillInput): Promise<PerpInsertOutcome>;
  insertPerpFunding(f: PerpFundingInput): Promise<PerpFundingOutcome>;
  upsertPerpTransfer(t: PerpTransferInput): Promise<PerpTransferOutcome>;
  listOpenPerpTransfers(agentId: string, mode: "live"): Promise<PerpTransferRow[]>;
  setPerpPositions(agentId: string, mode: "live", source: "venue", rows: readonly Omit<PerpPositionInput, "agentId" | "mode" | "source">[]): Promise<void>;
  getPerpPositions(agentId: string, mode: "live", opts?: { includeFlat?: boolean }): Promise<PerpPositionRow[]>;
  getPerpAccount(agentId: string, mode: "live"): Promise<PerpAccountRow | null>;
  patchPerpAccount(agentId: string, mode: "live", patch: PerpAccountPatch): Promise<void>;
  bumpNonceHighWater(agentId: string, mode: "live", floor: bigint | number): Promise<bigint>;
  getNonceHighWater(agentId: string, mode: "live"): Promise<bigint | null>;
  /** reconcile-ledger.ts insertAdoptedPerpOrderRow, on the store's connection. */
  insertAdoptedPerpOrder(a: AdoptedPerpOrderInput): Promise<{ id: string; outcome: "inserted" | "exists" }>;
  /** reconcile-ledger.ts perpNonceRecordedRow, on the store's connection. */
  perpNonceRecorded(agentId: string, accountIndex: number, apiKeyIndex: number, nonce: number | bigint): Promise<boolean>;
}

export interface LiveReconcilerDeps {
  agentId: string;
  /** The agents row's epoch, for adopted rows only (every other writer books into the agents row's epoch itself). */
  epoch: number | (() => number);
  /** Our venue account (the master under our L1 address). */
  accountIndex: number;
  /** Our key index (LIGHTER_ROUTE_V1.apiKeyIndex). */
  apiKeyIndex: number;
  /** The agent's smart account — the account's L1 address. */
  smartAccount: string;
  /** The public key sealed in the grant — rule 16(b)'s reference. */
  sealedPubKey: string;
  api: LiveReconcileApi;
  /** The signer's auth token (fresh per pass when a function); null = none, and every account read is a gap. */
  auth: string | (() => string | null);
  store: LiveReconcileStore;
  /** ms */
  now: () => number;
  /**
   * The clock skew against the venue, ms, as last measured (api.ts
   * `clockSkewMs()`: the venue's clock minus ours); null = not measured. Only
   * its magnitude is judged.
   */
  clockSkewMs: () => number | null;
  /**
   * executor-live's resendPersisted: sends the row's EXACT persisted tx_info
   * again, and itself refuses past ExpiredAt by the later clock. Its answer
   * resolves nothing — the row is resolved by hash alone — so it is only
   * logged.
   */
  resend: (row: PerpOrderRow) => Promise<unknown>;
  /** Mark reads as exit reads (api.ts `exit`): true while the lane runs exits-only or a stand-down. */
  exitReads?: boolean;
  log?: (line: string) => void;
}

// ── what a pass reports ─────────────────────────────────────────────────────

/** A liquidation, deleverage or settlement booked on our account this pass — the breaker's to see (rule 10). */
export interface ForcedFill {
  tradeId: string;
  sideRole: "ask" | "bid";
  marketId: number;
  tradeType: "liquidation" | "deleverage" | "market-settlement";
  base: bigint;
  price: bigint;
  realizedMicro: bigint;
  feeMicro: bigint;
  /** ms */
  atMs: number;
}

export interface StepReport {
  /** Book gaps (rule 11): while any stands, the caller refuses every non-exit intent. */
  gaps: string[];
  /** Owner- or operator-facing notices (forced fills, adoptions, unknown activity, an unmeasured clock). */
  alerts: string[];
}

export interface ReconcileResult extends StepReport {
  /** The ONE account read of this pass (rule 12), or null when it could not be read or was older than the last used. */
  accountRead: PerpAccountRead | null;
  /** This pass's accountActiveOrders, for the view (null = unread — every stop's state is then UNREAD, never missing). */
  orders: readonly VenueOrder[] | null;
  /** The decimals every read of this pass was parsed with. */
  decimals: ReadonlyMap<number, PerpDecimals> | null;
  incident: Incident | null;
  /** Venue orders adopted as `orphan-order` rows this pass. */
  adopted: number;
  forcedFills: ForcedFill[];
  /** The venue-delta identity has failed DELTA_DOUBTFUL_AFTER passes in a row. */
  deltaDoubtful: boolean;
  /** continuous: the ledger reached the venue at arm; rebuilt: it was rebuilt from the venue; pending: neither yet. */
  continuity: "continuous" | "rebuilt" | "pending";
}

// ── pure parts ──────────────────────────────────────────────────────────────

/**
 * IS THE LOCAL LEDGER CONTINUOUS WITH THE VENUE? Its perp_accounts row exists
 * and its nonce high-water reaches the venue's last-used nonce for our key
 * (`venueNextNonce − 1`: apikeys' `nonce` equals nextNonce). Every tx this
 * worker signs raises the high-water BEFORE signing (rule 9), so a continuous
 * ledger has seen every nonce the venue has. Anything else — no row (a wiped
 * hosted child), no high-water, a high-water behind the venue (a stale seed),
 * or an unread venue nonce — is NOT continuous, and the day is rebuilt from
 * the venue before any open. A rebuild of a ledger that was continuous after
 * all adopts nothing, so erring this way costs reads, never money.
 */
export function isContinuous(account: Pick<PerpAccountRow, "nonceHighWater"> | null, venueNextNonce: number | null): boolean {
  if (account === null || account.nonceHighWater === null) return false;
  if (venueNextNonce === null || !Number.isSafeInteger(venueNextNonce)) return false;
  return account.nonceHighWater >= BigInt(venueNextNonce) - 1n;
}

/** The part of one venue account read the delta identity compares: C + ΣM at one transaction_time. */
export interface VenueMoneySnapshot {
  collateralMicro: bigint;
  isolatedMarginMicro: bigint;
  /** µs */
  transactionTimeUs: number;
}

/** What the ledger booked between two snapshots. Every amount is signed from the account's view. */
export interface VenueDeltaRecords {
  /** Σ (realized − fee) over fills. */
  fillsMicro: bigint;
  /** Σ funding payments (+ received, − paid). */
  fundingMicro: bigint;
  /** Σ our deposits the venue credited. */
  depositsCreditedMicro: bigint;
  /** Σ our withdrawals the venue executed (money that left the venue). */
  withdrawalsExecutedMicro: bigint;
  /** How many records the sums hold — the tolerance scales with it. */
  records: number;
}

export interface VenueDeltaVerdict {
  ok: boolean;
  /** Δ(C + ΣM) */
  actualMicro: bigint;
  /** What the records explain. */
  explainedMicro: bigint;
  diffMicro: bigint;
  toleranceMicro: bigint;
  /** Set when the snapshots cannot be compared at all. */
  reason?: "stale-snapshot";
}

/**
 * THE VENUE-DELTA IDENTITY (rules 10 and 11; accounting venue-delta-identity-
 * check): between two reads of the account,
 *
 *   Δ(C + ΣM) == Σ(realized − fee) + Σ funding + credited deposits − executed withdrawals
 *
 * within ± 2 micro per record (a fee is usd × ppm rounded, realized is
 * re-derived — one rounding each). ΣU is left out on purpose: unrealized P&L
 * moves with the mark, not with money. Opening an isolated position moves
 * margin from C to M inside the sum, so it changes nothing. What breaks it is
 * money the ledger did not see: a missed fill, a liquidation's fee to the
 * insurance pool, a transfer to a sub-account the API key made — the
 * "profit" or "loss" that would otherwise land in equity unexplained. Pure.
 */
export function venueDeltaCheck(prev: VenueMoneySnapshot, curr: VenueMoneySnapshot, ingested: VenueDeltaRecords): VenueDeltaVerdict {
  const actual = curr.collateralMicro + curr.isolatedMarginMicro - (prev.collateralMicro + prev.isolatedMarginMicro);
  const explained = ingested.fillsMicro + ingested.fundingMicro + ingested.depositsCreditedMicro - ingested.withdrawalsExecutedMicro;
  const diff = actual - explained;
  const tol = DELTA_TOLERANCE_PER_RECORD_MICRO * BigInt(Math.max(0, ingested.records));
  if (curr.transactionTimeUs < prev.transactionTimeUs) {
    return { ok: false, actualMicro: actual, explainedMicro: explained, diffMicro: diff, toleranceMicro: tol, reason: "stale-snapshot" };
  }
  return { ok: (diff < 0n ? -diff : diff) <= tol, actualMicro: actual, explainedMicro: explained, diffMicro: diff, toleranceMicro: tol };
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) === (b < 0n)) ? q + 1n : q;
}

/**
 * A fill's fee, micro-USDG, from the venue's parts-per-million of notional:
 * ceil(usd × ppm / 10⁶) toward +∞, so a fee is never understated and a maker
 * rebate (negative ppm) never overstated. The venue does not publish its own
 * rounding; the delta identity allows one micro of it per record.
 */
export function perpFeeMicro(usdAmountMicro: bigint, feePpm: number): bigint {
  if (!Number.isSafeInteger(feePpm)) throw new RangeError("perpFeeMicro: fee ppm must be an integer");
  return ceilDiv(usdAmountMicro * BigInt(feePpm), 1_000_000n);
}

/**
 * WHAT ONE SIDE OF A TRADE DID TO OUR POSITION, from the venue's own
 * before-state (fill-and-funding-identity: realized is re-derivable from
 * position_before, entry_quote_before, size and price).
 *
 *   side      the POSITION side the fill trades (rule 15, never "sell"): a bid
 *             into a short and an ask out of a long are that short and long
 *             closing; otherwise it opens or adds to the side it buys or sells.
 *   realized  on the part that CLOSES — min(size, |position before|) — the
 *             exit quote less that part's share of the entry quote, rounded
 *             toward −∞ (a gain never overstated). An opening fill realizes a
 *             known 0. A fill that crosses zero (never ours: exits are
 *             reduce-only) realizes its closing part and is booked on the side
 *             it closed.
 *
 * `venuePnlMicro` (the authenticated *_account_pnl, when present) is used only
 * when the before-state is missing — the parser requires it, so in practice
 * never; it is kept so a venue that ever omits the before-state still books.
 */
export function perpFillEconomics(args: {
  sideRole: "ask" | "bid";
  size: bigint;
  usdAmountMicro: bigint;
  positionBefore: bigint | null;
  entryQuoteBeforeMicro: bigint | null;
  venuePnlMicro?: bigint | null;
}): { side: "long" | "short"; realizedMicro: bigint | null; closingBase: bigint } {
  const buy = args.sideRole === "bid";
  const s = args.positionBefore;
  if (s === null || args.entryQuoteBeforeMicro === null) {
    return { side: buy ? "long" : "short", realizedMicro: args.venuePnlMicro ?? null, closingBase: 0n };
  }
  const closesShort = buy && s < 0n;
  const closesLong = !buy && s > 0n;
  const side: "long" | "short" = closesShort ? "short" : closesLong ? "long" : buy ? "long" : "short";
  if (!closesShort && !closesLong) return { side, realizedMicro: 0n, closingBase: 0n };
  const abs = s < 0n ? -s : s;
  const closing = args.size < abs ? args.size : abs;
  // realized = sign × (usd × closing / size − entry × closing / |s|), as one
  // exact fraction over size × |s|, floored once.
  const sign = closesLong ? 1n : -1n;
  const num = sign * closing * (args.usdAmountMicro * abs - args.entryQuoteBeforeMicro * args.size);
  return { side, realizedMicro: floorDiv(num, args.size * abs), closingBase: closing };
}

/** A venue client order index, if it is one we could have signed: 1..2^48−1. */
function coiOf(s: string): bigint | null {
  if (!/^\d{1,20}$/.test(s)) return null;
  const v = BigInt(s);
  return v >= 1n && v <= PERP_COI_MAX ? v : null;
}

/**
 * Signed with OUR scheme (rule 9: client order index = nonce × 8 + leg, leg
 * 0..3) — how an order whose row a wipe lost is recognised as this agent's.
 * The venue order carries the tx nonce, so the check is exact, not a guess
 * about the digits.
 */
function oursByScheme(o: Pick<VenueOrder, "clientOrderIndex" | "nonce">): boolean {
  const coi = coiOf(o.clientOrderIndex);
  if (coi === null || !Number.isSafeInteger(o.nonce) || o.nonce < 1) return false;
  const leg = coi % 8n;
  return leg <= 3n && BigInt(o.nonce) * 8n + leg === coi;
}

const FINAL_VENUE_PREFIX = "canceled";
function venueFinal(status: VenueOrder["status"]): boolean {
  return status === "filled" || status.startsWith(FINAL_VENUE_PREFIX);
}

/** The venue's status word → our leg vocabulary (the venue's word rides beside it, verbatim). */
function legStatusOf(o: Pick<VenueOrder, "status" | "filledBaseAmount">): PerpLegStatus {
  switch (o.status) {
    case "in-progress":
    case "pending":
      return "pending";
    case "open":
      return "open";
    case "filled":
      return "filled";
    default:
      if (o.filledBaseAmount > 0n) return "partial";
      return o.status === "canceled-expired" ? "expired" : "cancelled";
  }
}

const LEG_FINAL: ReadonlySet<PerpLegStatus> = new Set(["filled", "partial", "cancelled", "expired", "rejected"]);

function msg(e: unknown): string {
  return clip(e instanceof Error ? e.message : String(e));
}

/** Venue text in a gap or alert: short, and nothing key- or token-shaped (api.ts clip). */
function clip(s: string): string {
  return s
    .replace(/\d{9,11}:\d{1,16}:\d{1,3}:[0-9a-f]{160}/g, "[auth]")
    .replace(/(0x)?[0-9a-fA-F]{64,}/g, "[hex]")
    .slice(0, 200);
}

function short(hash: string): string {
  return `${hash.slice(0, 10)}…`;
}

function canonKey(k: string): string {
  return k.trim().toLowerCase().replace(/^0x/, "");
}

// ── the reconciler ──────────────────────────────────────────────────────────

type Read<T> = { ok: true; value: T; serverDateMs: number | null } | { ok: false; kind: string; detail: string; serverDateMs: number | null };

interface DeltaRecord {
  /** µs, the venue's time for the record. */
  tsUs: number;
  fillsMicro: bigint;
  fundingMicro: bigint;
  depositMicro: bigint;
  withdrawMicro: bigint;
}

interface Pass extends StepReport {
  nowMs: number;
  auth: string | null;
  decimals: ReadonlyMap<number, PerpDecimals> | null;
  apikeys: ApiKeyRead[] | null;
  active: VenueOrder[] | null;
  /** All inactive orders the venue lists (read at most once per pass, only when needed); undefined = not read yet. */
  inactive?: VenueOrder[] | null;
  inactiveComplete: boolean;
  inactiveClassified: boolean;
  /** Set while the arm step is rebuilding a discontinuous ledger: the venue's next nonce for our key. */
  rebuilding: { venueNonce: number } | null;
  adoptedNonces: Map<number, string>;
  resolveLookups: number;
  orphanLookups: number;
  unknownFills: number;
  unknownOrders: number;
  adopted: number;
  forced: ForcedFill[];
  fillsComplete: boolean;
  fundingComplete: boolean;
  transfersComplete: boolean;
}

export interface LiveReconciler {
  /** Resolve every `submitted` rule-9 row by tx hash (rule 9). */
  resolveSubmitted(): Promise<StepReport>;
  /** Venue orders and the account's trades since the cursor, booked with provenance; `executed` rows finalized. */
  ingestFills(): Promise<StepReport & { adopted: number; unknownFills: number; unknownOrders: number; forcedFills: ForcedFill[] }>;
  /** positionFunding, by funding id. */
  ingestFunding(): Promise<StepReport>;
  /** withdraw/history → our withdrawal rows move forward (never to `paid`). */
  ingestTransfers(): Promise<StepReport>;
  /** perp_positions from ONE account read, recorded stops and takes kept. */
  syncPositions(accountRead: PerpAccountRead): Promise<StepReport>;
  /**
   * When the ledger is discontinuous, adopt the venue's orders and trades of
   * the last 26 h and raise the high-water to the venue's nonce — BEFORE any
   * open. A no-op (continuous) when the ledger already reaches the venue.
   */
  rebuildDayAfterWipe(): Promise<StepReport & { continuity: "continuous" | "rebuilt" | "pending"; adopted: number }>;
  /** isContinuous() against the current ledger and a fresh venue read; false when either is unread. */
  isContinuous(): Promise<boolean>;
  /** The pure identity, for callers that hold their own snapshots. */
  venueDeltaCheck: typeof venueDeltaCheck;
  /** The ordered pass (see the header). Never throws. */
  reconcileOnce(): Promise<ReconcileResult>;
  /** For tests and the status line: the cursors and counters this instance carries. */
  state(): { armed: boolean; continuity: "continuous" | "rebuilt" | "pending"; fillCursorMs: number | null; fundingCursorSec: number | null; mismatchStreak: number };
}

export function createLiveReconciler(deps: LiveReconcilerDeps): LiveReconciler {
  const { agentId, accountIndex, apiKeyIndex, store, api } = deps;
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 1) throw new RangeError("reconcile: accountIndex must be a venue account index");
  if (!Number.isSafeInteger(apiKeyIndex) || apiKeyIndex < 0 || apiKeyIndex > 254) throw new RangeError("reconcile: apiKeyIndex must be 0..254");
  const log = deps.log ?? (() => {});
  const startedAtMs = deps.now();

  // Instance state: what one worker process carries between passes. None of
  // it is a fact — each is re-derivable from the venue, and is at arm.
  let decimalsCache: { map: ReadonlyMap<number, PerpDecimals>; atMs: number } | null = null;
  const lastSendMs = new Map<string, number>();
  let fillCursorMs: number | null = null;
  let fundingCursorSec: number | null = null;
  /** Σ of the fills seen per venue order index — what `executed` rows are finalized against. Deduped by trade side. */
  const tallies = new Map<string, { base: bigint; quoteMicro: bigint }>();
  const tallied = new Set<string>();
  const deltaRecords = new Map<string, DeltaRecord>();
  let prevSnapshot: VenueMoneySnapshot | null = null;
  let mismatchStreak = 0;
  let armed = false;
  let continuity: "continuous" | "rebuilt" | "pending" = "pending";
  let baselineNonce: bigint | null = null;
  /** Notices already given, so a standing condition is said once per process, not every pass (its gap stands every pass). */
  const alerted = new Set<string>();

  const epochNow = () => (typeof deps.epoch === "function" ? deps.epoch() : deps.epoch);

  function newPass(): Pass {
    let auth: string | null = null;
    try {
      auth = typeof deps.auth === "function" ? deps.auth() : deps.auth;
    } catch {
      auth = null;
    }
    return {
      nowMs: deps.now(),
      auth,
      decimals: null,
      apikeys: null,
      active: null,
      inactiveComplete: false,
      inactiveClassified: false,
      rebuilding: null,
      adoptedNonces: new Map(),
      resolveLookups: 0,
      orphanLookups: 0,
      unknownFills: 0,
      unknownOrders: 0,
      adopted: 0,
      forced: [],
      fillsComplete: false,
      fundingComplete: false,
      transfersComplete: false,
      gaps: [],
      alerts: [],
    };
  }

  const gap = (p: Pass, s: string) => {
    p.gaps.push(s);
    log(`[perps reconcile] gap: ${s}`);
  };
  const alert = (p: Pass, s: string) => {
    p.alerts.push(s);
    log(`[perps reconcile] ${s}`);
  };

  function flags(p: Pass): RequestFlags & { auth: string } {
    return { auth: p.auth as string, exit: deps.exitReads === true };
  }

  /** Every venue call goes through here: a throw (a caller-side argument error) is a failed read like any other. */
  async function read<T>(f: () => Promise<LighterResult<T, { kind: string; detail: string }>>): Promise<Read<T>> {
    try {
      const r = await f();
      return r.ok ? r : { ok: false, kind: r.error.kind, detail: r.error.detail, serverDateMs: r.serverDateMs };
    } catch (e) {
      return { ok: false, kind: "threw", detail: msg(e), serverDateMs: null };
    }
  }

  async function decimalsFor(p: Pass): Promise<ReadonlyMap<number, PerpDecimals> | null> {
    if (decimalsCache !== null && p.nowMs - decimalsCache.atMs < DECIMALS_TTL_MS) return decimalsCache.map;
    if (p.auth !== null) {
      const r = await read(() => api.orderBookDetails(undefined, flags(p)));
      if (r.ok && r.value.decimals.size > 0) {
        decimalsCache = { map: r.value.decimals, atMs: p.nowMs };
        return decimalsCache.map;
      }
      // A stale map still parses: a market's decimals changing is a relisting,
      // and the parsers refuse a symbol that no longer matches its id.
      if (decimalsCache === null) gap(p, `markets: orderBookDetails unread (${r.ok ? "no decimals" : r.kind}); venue amounts cannot be parsed`);
    }
    return decimalsCache?.map ?? null;
  }

  // ── 0. arm: continuity, and the rebuild after a wipe ──────────────────────

  async function readApiKeys(p: Pass): Promise<void> {
    if (p.auth === null) return;
    const r = await read(() => api.apikeys(accountIndex, 255, flags(p)));
    if (r.ok) p.apikeys = r.value;
  }

  /** The venue's NEXT nonce for our key; 0 when our index holds no key (it has signed nothing); null when unread. */
  function ourVenueNonce(p: Pass): number | null {
    if (p.apikeys === null) return null;
    const k = p.apikeys.find((x) => x.accountIndex === accountIndex && x.apiKeyIndex === apiKeyIndex);
    return k === undefined ? 0 : k.nonce;
  }

  async function armStep(p: Pass, acctRow: PerpAccountRow | null | undefined): Promise<void> {
    if (armed) return;
    const venueNonce = ourVenueNonce(p);
    if (venueNonce === null || acctRow === undefined) {
      gap(p, "arm: the venue's nonce for our key or the ledger's account row was not read; opens wait for the continuity check");
      return;
    }
    if (isContinuous(acctRow, venueNonce)) {
      armed = true;
      continuity = "continuous";
      return;
    }
    // Discontinuous: the fills step adopts every order of ours the venue
    // lists and re-reads 26 h of trades; finishArm raises the high-water once
    // every read of it succeeded.
    p.rebuilding = { venueNonce };
    fillCursorMs = null;
    alert(p, "the perp ledger does not reach the venue (a wiped or stale ledger): rebuilding the last 26 h from Lighter before any open");
  }

  async function finishArm(p: Pass): Promise<void> {
    if (p.rebuilding === null) return;
    if (!p.fillsComplete || !p.inactiveComplete || p.active === null) {
      gap(p, "arm: the rebuild from the venue is incomplete; opens wait for the next pass");
      return;
    }
    const last = BigInt(p.rebuilding.venueNonce) - 1n;
    try {
      const hw = await store.getNonceHighWater(agentId, "live");
      // Raise, never lower, and only when behind: bump commits max(floor,
      // hw + 1), so a high-water already there is left alone.
      if (last >= 1n && (hw === null || hw < last)) await store.bumpNonceHighWater(agentId, "live", last);
    } catch (e) {
      gap(p, `arm: the nonce high-water could not be raised to the venue's (${msg(e)})`);
      return;
    }
    baselineNonce = last;
    armed = true;
    continuity = "rebuilt";
    alert(p, `the perp ledger was rebuilt from the venue (${p.adopted} order(s) adopted)`);
  }

  /** After a rebuild, a tx the LOST ledger signed may still execute until its ExpiredAt: opens wait one signer horizon past this process's start. */
  function horizonGap(p: Pass): void {
    if (continuity !== "rebuilt") return;
    const until = startedAtMs + SIGNER_EXPIRY_HORIZON_MS + MAX_SKEW_MS;
    if (p.nowMs < until) gap(p, `arm: a tx the lost ledger signed may execute until ${new Date(until).toISOString()}; opens wait`);
  }

  // ── 1. resolve submitted rows by hash ─────────────────────────────────────

  function skewState(p: Pass, serverDateMs: number | null): "ok" | "too-large" | "unknown" {
    // Two measurements, either sufficient: the caller's running measure and
    // this very answer's Date header (second precision). Unknown only when
    // neither exists; every known one must be under the bound.
    const known: number[] = [];
    let injected: number | null = null;
    try {
      injected = deps.clockSkewMs();
    } catch {
      injected = null;
    }
    if (injected !== null && Number.isFinite(injected)) known.push(Math.abs(injected));
    if (serverDateMs !== null && Number.isFinite(serverDateMs)) known.push(Math.abs(p.nowMs - serverDateMs));
    if (known.length === 0) return "unknown";
    return known.every((k) => k < MAX_SKEW_MS) ? "ok" : "too-large";
  }

  async function maybeResend(p: Pass, row: PerpOrderRow): Promise<void> {
    if (row.txInfo === null || row.expiredAt === null) return;
    const now = deps.now();
    // Never after ExpiredAt: the bytes are dead then, and a re-send would only
    // be a refusal — or, with a venue clock behind ours, a surprise.
    if (now >= row.expiredAt) return;
    const last = lastSendMs.get(row.id) ?? row.createdAt * 1000;
    if (now - last <= RESEND_AFTER_MS) return;
    lastSendMs.set(row.id, now);
    try {
      const r = (await deps.resend(row)) as { sent?: unknown; why?: unknown } | undefined;
      if (r !== undefined && r !== null && r.sent === false) log(`[perps reconcile] re-send of ${short(row.txHash ?? row.id)} not made: ${clip(String(r.why))}`);
    } catch (e) {
      gap(p, `resolve: re-sending ${short(row.txHash ?? row.id)} failed (${msg(e)}); it stays submitted`);
    }
  }

  async function withdrawTransferOf(row: PerpOrderRow): Promise<PerpTransferRow | null> {
    const open = await store.listOpenPerpTransfers(agentId, "live");
    return open.find((t) => t.direction === "withdraw" && ((row.txHash !== null && t.venueTxHash === row.txHash) || t.orderId === row.id)) ?? null;
  }

  /** rejected, app-error, expired: the tx never ran as asked. Its legs end, and a withdrawal it requested moved nothing. */
  async function finalNoExec(p: Pass, row: PerpOrderRow, status: "rejected" | "app-error" | "expired", reason: string): Promise<void> {
    await store.resolvePerpOrder({ agentId, mode: "live", id: row.id, status, filledBase: 0n, filledQuoteMicro: 0n, reason });
    for (const l of row.legs) {
      await store.updatePerpLegStatus({ agentId, mode: "live", clientOrderIndex: l.clientOrderIndex, status: status === "expired" ? "expired" : "rejected" });
    }
    if (row.effect === "withdraw" || row.txType === WITHDRAW_TX_TYPE) {
      const t = await withdrawTransferOf(row);
      if (t === null) return;
      if (t.state !== "submitted") {
        // The venue's history already said it executed; the tx now says it
        // did not. Two sources disagreeing about money is a gap, not a vote.
        gap(p, `transfers: withdrawal ${t.id} is ${t.state} but its tx ${short(row.txHash ?? "")} is ${status}`);
        return;
      }
      await store.upsertPerpTransfer({ agentId, mode: "live", id: t.id, direction: "withdraw", amountMicro: t.amountMicro, initiator: t.initiator, state: "failed" });
    }
  }

  async function onExecuted(p: Pass, row: PerpOrderRow, tx: TxRead): Promise<void> {
    // The taker order's venue index, onto the leg its client index names —
    // what trades are filtered by and what the venue lists the order under.
    if (tx.orderIndex !== null && tx.clientOrderIndex !== null) {
      const leg = row.legs.find((l) => l.clientOrderIndex === tx.clientOrderIndex);
      if (leg !== undefined && leg.venueOrderIndex === null && !LEG_FINAL.has(leg.status)) {
        await store.updatePerpLegStatus({ agentId, mode: "live", clientOrderIndex: leg.clientOrderIndex, status: leg.status, venueOrderIndex: tx.orderIndex });
      }
    }
    await store.resolvePerpOrder({ agentId, mode: "live", id: row.id, status: "executed" });
    if (row.effect === "withdraw" || row.txType === WITHDRAW_TX_TYPE) {
      const t = await withdrawTransferOf(row);
      if (t === null) return;
      const r = await store.upsertPerpTransfer({ agentId, mode: "live", id: t.id, direction: "withdraw", amountMicro: t.amountMicro, initiator: t.initiator, state: "executed" });
      if (r.outcome === "refused") gap(p, `transfers: withdrawal ${t.id} could not advance (${r.why})`);
      else if (r.outcome === "advanced" && r.journaled) {
        deltaRecords.set(`withdraw:${t.id}`, { tsUs: tx.executedAtMs * 1000, fillsMicro: 0n, fundingMicro: 0n, depositMicro: 0n, withdrawMicro: t.amountMicro });
      }
    }
  }

  async function resolveStep(p: Pass): Promise<void> {
    if (p.auth === null) return;
    let rows: PerpOrderRow[];
    try {
      rows = await store.listSubmittedPerpOrders(agentId, "live");
    } catch (e) {
      gap(p, `resolve: the ledger's submitted rows could not be read (${msg(e)})`);
      return;
    }
    for (const row of rows) {
      if (row.status !== "submitted") continue; // `executed` rows are the fill step's
      if (row.txHash === null) {
        gap(p, `resolve: live row ${row.id} has no tx hash; it cannot be resolved`);
        continue;
      }
      if (p.resolveLookups >= MAX_RESOLVE_LOOKUPS) {
        gap(p, "resolve: more submitted rows than one pass looks up; the rest wait");
        break;
      }
      p.resolveLookups++;
      const hash = row.txHash;
      const r = await read(() => api.tx(hash, flags(p)));
      try {
        if (r.ok) {
          const tx = r.value;
          // An answer about another account, key or nonce is not an answer
          // about this row — whatever the hash says.
          if (tx.accountIndex !== row.accountIndex || (row.apiKeyIndex !== null && tx.apiKeyIndex !== row.apiKeyIndex) || (row.nonce !== null && tx.nonce !== row.nonce)) {
            gap(p, `resolve: tx ${short(hash)} answers for another account, key or nonce; it stays submitted`);
            continue;
          }
          switch (tx.outcome) {
            case "pending":
              await maybeResend(p, row);
              break;
            case "rejected":
              await finalNoExec(p, row, "rejected", "the venue failed the tx (status 0); its nonce is spent");
              break;
            case "app-error":
              await finalNoExec(p, row, "app-error", `the venue refused it: ${clip(tx.appError ?? "")}`);
              break;
            case "executed":
              await onExecuted(p, row, tx);
              break;
          }
        } else if (r.kind === "not-found") {
          if (row.expiredAt === null) {
            gap(p, `resolve: tx ${short(hash)} is not found and its row has no ExpiredAt; it stays submitted`);
          } else if (p.nowMs <= row.expiredAt + EXPIRY_GRACE_MS) {
            // Not found yet: the send may never have arrived. The same bytes,
            // before ExpiredAt, are the same tx — at most one executes.
            await maybeResend(p, row);
          } else {
            const skew = skewState(p, r.serverDateMs);
            if (skew === "ok") {
              await finalNoExec(p, row, "expired", "not found 120 s past its ExpiredAt, with the clock within 5 s of the venue's");
            } else {
              const s = `resolve: tx ${short(hash)} is not found past its ExpiredAt but the clock skew is ${skew === "unknown" ? "unmeasured" : "5 s or more"}; it stays submitted`;
              gap(p, s);
              alert(p, s);
            }
          }
        } else {
          // Every other failure is `unknown` — never not-found (rule 9).
          gap(p, `resolve: tx ${short(hash)} unread (${r.kind}); it stays submitted`);
        }
      } catch (e) {
        gap(p, `resolve: row ${row.id} could not be written (${msg(e)})`);
      }
    }
  }

  // ── 2. orders, fills, and finalizing executed rows ────────────────────────

  async function readActive(p: Pass): Promise<void> {
    const d = p.decimals;
    if (d === null || p.auth === null) return;
    const r = await read(() => api.accountActiveOrders(accountIndex, d, flags(p)));
    if (!r.ok) {
      gap(p, `orders: active orders unread (${r.kind})`);
      return;
    }
    if (r.value.nextCursor !== null) gap(p, "orders: more active orders than one page; the rest are unread");
    p.active = r.value.orders;
  }

  /** Every inactive order the venue still lists (its ~24 h window), paged, at most once per pass. null = unread. */
  async function inactiveAll(p: Pass): Promise<VenueOrder[] | null> {
    if (p.inactive !== undefined) return p.inactive;
    const d = p.decimals;
    if (d === null || p.auth === null) {
      p.inactive = null;
      return null;
    }
    const out: VenueOrder[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_INACTIVE_PAGES; page++) {
      const c = cursor;
      const r = await read(() => api.accountInactiveOrders({ accountIndex, limit: ORDER_PAGE, ...(c === undefined ? {} : { cursor: c }) }, d, flags(p)));
      if (!r.ok) {
        gap(p, `orders: inactive orders unread (${r.kind})`);
        p.inactive = null;
        return null;
      }
      out.push(...r.value.orders);
      if (r.value.nextCursor === null || r.value.orders.length === 0) {
        p.inactiveComplete = true;
        p.inactive = out;
        return out;
      }
      cursor = r.value.nextCursor;
    }
    // The venue's own limit reached: there may be orders it no longer lists.
    gap(p, `orders: the venue listed ${MAX_INACTIVE_PAGES} pages of inactive orders; older ones are unread`);
    p.inactive = out;
    return out;
  }

  async function learnLeg(leg: PerpLegRow, o: VenueOrder): Promise<void> {
    if (LEG_FINAL.has(leg.status)) return;
    const status = legStatusOf(o);
    if (status === leg.status && leg.venueOrderIndex !== null && leg.venueStatus === o.status) return;
    await store.updatePerpLegStatus({ agentId, mode: "live", clientOrderIndex: leg.clientOrderIndex, status, venueOrderIndex: o.orderIndex, venueStatus: o.status });
  }

  /**
   * ADOPT THE TX AT `nonce` — every order of ours the reads show under it —
   * as one `adopted` row with its legs, written BEFORE any fill is booked
   * against it. The row carries the venue's own time, so an adopted open
   * counts against the 24 h it happened in (rule 6 survives a wipe).
   */
  async function adoptFromOrders(p: Pass, nonce: number): Promise<string | null> {
    const cached = p.adoptedNonces.get(nonce);
    if (cached !== undefined) return cached;
    const pool = [...(p.active ?? []), ...(p.inactive ?? [])];
    const byIndex = new Map<string, VenueOrder>();
    for (const o of pool) if (o.nonce === nonce && oursByScheme(o)) byIndex.set(o.orderIndex, o);
    const group = [...byIndex.values()];
    if (group.length === 0) return null;
    const roleOf = (o: VenueOrder) => LEG_ROLE[Number((coiOf(o.clientOrderIndex) ?? 0n) % 8n)] as PerpLegRole;
    const legs: AdoptedPerpLeg[] = [];
    const seenCoi = new Set<string>();
    for (const o of group) {
      if (seenCoi.has(o.clientOrderIndex)) continue;
      seenCoi.add(o.clientOrderIndex);
      legs.push({ role: roleOf(o), clientOrderIndex: Number(o.clientOrderIndex), venueOrderIndex: o.orderIndex, status: legStatusOf(o), venueStatus: o.status });
    }
    const main = group.find((o) => roleOf(o) === "entry") ?? group.find((o) => roleOf(o) === "close") ?? (group[0] as VenueOrder);
    const d = p.decimals?.get(main.marketId);
    if (d === undefined) {
      gap(p, `orders: an order of ours in market ${main.marketId} cannot be adopted without its decimals`);
      return null;
    }
    const reduceOnly = group.every((o) => o.reduceOnly);
    const final = venueFinal(main.status);
    const status: AdoptedPerpOrderInput["status"] = !final ? "executed" : main.status === "filled" ? "filled" : main.filledBaseAmount > 0n ? "partial" : "cancelled";
    // What the daily cap would have held at signing: base × worst price. A
    // market IOC's price IS its worst price; a trigger order's too.
    const worst = main.initialBaseAmount > 0n && main.price > 0n ? notionalMicro(main.initialBaseAmount, main.price, d, "ceil") : main.filledQuoteMicro;
    const createdAtMs = Math.min(...group.map((o) => o.timestampMs));
    try {
      const res = await store.insertAdoptedPerpOrder({
        agentId,
        epoch: epochNow(),
        accountIndex,
        apiKeyIndex,
        nonce,
        txHash: null,
        txType: group.length > 1 ? 28 : 14,
        status,
        effect: reduceOnly ? "close" : "open",
        reduceOnly,
        marketId: main.marketId,
        worstNotionalMicro: worst,
        filledBase: final ? main.filledBaseAmount : null,
        filledQuoteMicro: final ? main.filledQuoteMicro : null,
        createdAtSec: Math.max(1, Math.floor(createdAtMs / 1000)),
        legs,
      });
      p.adoptedNonces.set(nonce, res.id);
      if (res.outcome === "inserted") {
        p.adopted++;
        alert(p, `adopted order ${main.orderIndex} (market ${main.marketId}, nonce ${nonce}) as orphan-order: signed with our key, its ledger row was lost`);
      }
      return res.id;
    } catch (e) {
      gap(p, `orders: adopting nonce ${nonce} failed (${msg(e)})`);
      return null;
    }
  }

  /** Adopt from the tx itself — the creating tx of a trade we took, when no order read lists the order. */
  async function adoptFromTx(p: Pass, tx: TxRead, t: PerpTrade, coi: bigint): Promise<string | null> {
    const cached = p.adoptedNonces.get(tx.nonce);
    if (cached !== undefined) return cached;
    const leg = coi % 8n;
    if (leg > 3n || BigInt(tx.nonce) * 8n + leg !== coi) return null;
    let info: Record<string, unknown>;
    try {
      info = JSON.parse(tx.info) as Record<string, unknown>;
    } catch {
      return null;
    }
    const reduceOnly = info.ReduceOnly === 1;
    const d = p.decimals?.get(t.marketId);
    if (d === undefined) return null;
    const base = typeof info.BaseAmount === "number" && Number.isSafeInteger(info.BaseAmount) && info.BaseAmount > 0 ? BigInt(info.BaseAmount) : null;
    const price = typeof info.Price === "number" && Number.isSafeInteger(info.Price) && info.Price > 0 ? BigInt(info.Price) : null;
    const worst = base !== null && price !== null ? notionalMicro(base, price, d, "ceil") : t.usdAmountMicro;
    try {
      const res = await store.insertAdoptedPerpOrder({
        agentId,
        epoch: epochNow(),
        accountIndex,
        apiKeyIndex,
        nonce: tx.nonce,
        txHash: tx.hash,
        txType: tx.type,
        // A tx whose order no read lists any more is long finished, but its
        // other fills are not known here: `executed` keeps its worst notional
        // on the daily cap (erring toward under-spending), never a guess.
        status: "executed",
        effect: reduceOnly ? "close" : "open",
        reduceOnly,
        marketId: t.marketId,
        worstNotionalMicro: worst,
        filledBase: null,
        filledQuoteMicro: null,
        createdAtSec: Math.max(1, Math.floor((tx.queuedAtMs || t.timestampMs) / 1000)),
        legs: [{ role: LEG_ROLE[Number(leg)] as PerpLegRole, clientOrderIndex: Number(coi), venueOrderIndex: tx.orderIndex, status: "filled", venueStatus: null }],
      });
      p.adoptedNonces.set(tx.nonce, res.id);
      if (res.outcome === "inserted") {
        p.adopted++;
        alert(p, `adopted tx ${short(tx.hash)} (nonce ${tx.nonce}) as orphan-order: signed with our key, its ledger row was lost`);
      }
      return res.id;
    } catch (e) {
      gap(p, `fills: adopting tx ${short(tx.hash)} failed (${msg(e)})`);
      return null;
    }
  }

  /** Classify every order a read listed: our legs learn; our orphans are adopted; the rest is unknown activity (rule 16 d). */
  async function classifyOrders(p: Pass, orders: readonly VenueOrder[]): Promise<void> {
    for (const o of orders) {
      try {
        const coi = coiOf(o.clientOrderIndex);
        const hit = coi === null ? null : await store.perpOrderByCoi(agentId, "live", coi);
        if (hit !== null) {
          await learnLeg(hit.leg, o);
          continue;
        }
        if (o.type === "liquidation") continue; // the venue's own order, not a signature
        if (oursByScheme(o)) {
          await adoptFromOrders(p, o.nonce);
          continue;
        }
        p.unknownOrders++;
        if (!alerted.has(`o:${o.orderIndex}`)) {
          alerted.add(`o:${o.orderIndex}`);
          alert(p, `unknown activity: order ${o.orderIndex} (market ${o.marketId}, ${o.status}) matches no order of ours`);
        }
      } catch (e) {
        gap(p, `orders: order ${o.orderIndex} could not be classified (${msg(e)})`);
      }
    }
  }

  /**
   * WHOSE FILL IS THIS SIDE? null = not established this pass (a read failed),
   * and the side is left for the next pass — never guessed into `venue-unknown`.
   */
  async function attribute(
    p: Pass,
    t: PerpTrade,
    s: OurTradeSide,
    orderIndex: string,
    coi: bigint | null,
  ): Promise<{ attribution: PerpAttribution; orderId: string | null } | null> {
    if (coi !== null) {
      const hit = await store.perpOrderByCoi(agentId, "live", coi);
      if (hit !== null) {
        if (hit.leg.venueOrderIndex === null && !LEG_FINAL.has(hit.leg.status)) {
          await store.updatePerpLegStatus({ agentId, mode: "live", clientOrderIndex: hit.leg.clientOrderIndex, status: hit.leg.status, venueOrderIndex: orderIndex });
        }
        // A fill on a row already resolved as never executed: the venue's
        // index lagged past the expiry grace, or an application error still
        // traded. The fill is the venue's word and is booked; the row's final
        // answer is never rewritten (perp-ledger-rules.ts), so the day's cap
        // under-counts it — which must be said, not absorbed.
        if (hit.order.status === "rejected" || hit.order.status === "expired" || hit.order.status === "app-error") {
          const s = `fills: trade ${t.tradeId} filled order row ${hit.order.id}, which was resolved ${hit.order.status}; the day's cap under-counts it`;
          gap(p, s);
          if (!alerted.has(`f:${t.tradeId}:${s}`)) {
            alerted.add(`f:${t.tradeId}:${s}`);
            alert(p, s);
          }
        }
        // `venue-take` is spelled `venue-stop` with the fill carrying the tp
        // leg's client index: perp-ledger-rules.ts has one resting-order
        // provenance, and perpLaneLedgerFacts tells take from stop by leg role.
        const attribution: PerpAttribution =
          hit.order.reason === ADOPTED_REASON ? "orphan-order" : hit.leg.role === "sl" || hit.leg.role === "tp" ? "venue-stop" : "intent";
        return { attribution, orderId: hit.order.id };
      }
    }
    // A liquidation, deleverage or settlement: the venue's doing, not a signature.
    if (t.type !== "trade") return { attribution: "venue-forced", orderId: null };

    // Ours by the scheme, from what the venue lists under the order.
    const inList = (list: readonly VenueOrder[] | null | undefined) => list?.find((o) => o.orderIndex === orderIndex) ?? null;
    let o = inList(p.active);
    if (o === null) {
      const inactive = await inactiveAll(p);
      if (inactive === null) return null;
      o = inList(inactive);
    }
    if (o !== null && oursByScheme(o)) {
      const id = await adoptFromOrders(p, o.nonce);
      return id === null ? null : { attribution: "orphan-order", orderId: id };
    }

    // Who signed the tx this trade came from — when we were its taker, the
    // trade's tx is the creating one.
    if (s.role === "taker" && /^[0-9a-f]{80}$/.test(t.txHash) && coi !== null) {
      if (p.orphanLookups >= MAX_ORPHAN_TX_LOOKUPS) {
        gap(p, "fills: more unmatched trades than one pass looks up; the rest wait");
        return null;
      }
      p.orphanLookups++;
      const r = await read(() => api.tx(t.txHash, flags(p)));
      if (!r.ok && r.kind !== "not-found") {
        gap(p, `fills: the tx behind trade ${t.tradeId} is unread (${r.kind}); it waits`);
        return null;
      }
      if (r.ok && r.value.accountIndex === accountIndex) {
        if (r.value.apiKeyIndex !== apiKeyIndex) return { attribution: "owner-recover", orderId: null };
        const id = await adoptFromTx(p, r.value, t, coi);
        if (id !== null) return { attribution: "orphan-order", orderId: id };
      }
    }
    return { attribution: "venue-unknown", orderId: null };
  }

  /** Book one of OUR sides of one trade. False when it could not be booked this pass (the cursor must hold). */
  async function bookSide(p: Pass, t: PerpTrade, s: OurTradeSide): Promise<boolean> {
    const orderIndex = s.side === "ask" ? t.askOrderIndex : t.bidOrderIndex;
    const coi = coiOf(s.side === "ask" ? t.askClientOrderIndex : t.bidClientOrderIndex);
    const taker = s.role === "taker";
    const attr = await attribute(p, t, s, orderIndex, coi);
    if (attr === null) return false;
    const econ = perpFillEconomics({
      sideRole: s.side,
      size: t.size,
      usdAmountMicro: t.usdAmountMicro,
      positionBefore: taker ? t.takerPositionSizeBefore : t.makerPositionSizeBefore,
      entryQuoteBeforeMicro: taker ? t.takerEntryQuoteBeforeMicro : t.makerEntryQuoteBeforeMicro,
      venuePnlMicro: s.side === "ask" ? t.askAccountPnlMicro : t.bidAccountPnlMicro,
    });
    const fee = perpFeeMicro(t.usdAmountMicro, s.feePpm);
    const outcome = await store.insertPerpFill({
      agentId,
      mode: "live",
      venueTradeId: t.tradeId,
      sideRole: s.side,
      marketId: t.marketId,
      side: econ.side,
      role: s.role,
      base: t.size,
      price: t.price,
      quoteMicro: t.usdAmountMicro,
      feeMicro: fee,
      realizedMicro: econ.realizedMicro,
      positionBefore: taker ? t.takerPositionSizeBefore : t.makerPositionSizeBefore,
      entryQuoteBeforeMicro: taker ? t.takerEntryQuoteBeforeMicro : t.makerEntryQuoteBeforeMicro,
      tradeType: t.type,
      attribution: attr.attribution,
      orderId: attr.orderId,
      venueOrderIndex: orderIndex,
      clientOrderIndex: coi === null ? null : Number(coi),
      venueTxHash: /^[0-9a-f]+$/.test(t.txHash) ? t.txHash : null,
      venueTsMs: t.timestampMs,
    });
    const key = `${t.tradeId}:${s.side}`;
    if (outcome === "mismatch") {
      gap(p, `fills: trade ${t.tradeId} (${s.side}) was booked with different venue facts; the first booking stands`);
    }
    // What every later step reads from this side, counted once per identity.
    if (!tallied.has(key)) {
      tallied.add(key);
      const held = tallies.get(orderIndex) ?? { base: 0n, quoteMicro: 0n };
      tallies.set(orderIndex, { base: held.base + t.size, quoteMicro: held.quoteMicro + t.usdAmountMicro });
    }
    if (econ.realizedMicro !== null) {
      deltaRecords.set(`fill:${key}`, { tsUs: t.transactionTimeUs, fillsMicro: econ.realizedMicro - fee, fundingMicro: 0n, depositMicro: 0n, withdrawMicro: 0n });
    } else {
      gap(p, `fills: trade ${t.tradeId} (${s.side}) has no derivable realized P&L`);
    }
    if (outcome === "inserted") {
      if (attr.attribution === "venue-forced") {
        p.forced.push({
          tradeId: t.tradeId,
          sideRole: s.side,
          marketId: t.marketId,
          tradeType: t.type as ForcedFill["tradeType"],
          base: t.size,
          price: t.price,
          realizedMicro: econ.realizedMicro ?? 0n,
          feeMicro: fee,
          atMs: t.timestampMs,
        });
        alert(p, `forced fill: a ${t.type} trade ${t.tradeId} in market ${t.marketId} closed ${t.size} on our account`);
      }
      if (attr.attribution === "owner-recover") alert(p, `fill ${t.tradeId} in market ${t.marketId} was signed by another key on our account (the owner's recover)`);
    }
    // Rule 16 (d): a non-forced fill matching nothing of ours — counted on
    // every read (not only the first), so a flag that failed to persist is
    // raised again on the next pass.
    if (attr.attribution === "venue-unknown") {
      p.unknownFills++;
      if (outcome === "inserted") alert(p, `unknown activity: fill ${t.tradeId} in market ${t.marketId} matches no order of ours`);
    }
    return true;
  }

  async function readTradesSince(p: Pass, sinceMs: number): Promise<{ trades: PerpTrade[]; complete: boolean }> {
    const d = p.decimals;
    if (d === null || p.auth === null) return { trades: [], complete: false };
    const all = new Map<string, PerpTrade>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TRADE_PAGES; page++) {
      const c = cursor;
      const r = await read(() => api.trades({ accountIndex, limit: TRADE_PAGE, ...(c === undefined ? {} : { cursor: c }) }, d, flags(p)));
      if (!r.ok) {
        gap(p, `fills: trades unread (${r.kind})`);
        return { trades: [...all.values()], complete: false };
      }
      let oldest = Number.POSITIVE_INFINITY;
      for (const t of r.value.trades) {
        all.set(t.tradeId, t);
        if (t.timestampMs < oldest) oldest = t.timestampMs;
      }
      if (r.value.trades.length === 0 || r.value.nextCursor === null || oldest < sinceMs) return { trades: [...all.values()], complete: true };
      cursor = r.value.nextCursor;
    }
    gap(p, `fills: more than ${MAX_TRADE_PAGES * TRADE_PAGE} trades since the cursor; the rest wait`);
    return { trades: [...all.values()], complete: false };
  }

  /**
   * FINALIZE `executed` ORDER ROWS from the venue's final record of the main
   * leg (entry, else close) — once every fill that record counts is booked.
   * The venue record says the order is DONE and how much it filled; the fills
   * booked say the same or the row waits (a trade index lagging its
   * execution). A row whose order still rests (a standalone stop) stays
   * `executed`: that is what it is.
   */
  async function finalizeStep(p: Pass): Promise<void> {
    let rows: PerpOrderRow[];
    try {
      rows = (await store.listSubmittedPerpOrders(agentId, "live")).filter((r) => r.status === "executed");
    } catch (e) {
      gap(p, `fills: executed rows unread (${msg(e)})`);
      return;
    }
    for (const row of rows) {
      if (row.txType !== null && !ORDER_TX_TYPES.has(row.txType)) continue; // leverage, cancel, withdraw end at executed
      const main = row.legs.find((l) => l.role === "entry") ?? row.legs.find((l) => l.role === "close") ?? row.legs[0];
      if (main === undefined) continue;
      const match = (o: VenueOrder) => (main.venueOrderIndex !== null && o.orderIndex === main.venueOrderIndex) || o.clientOrderIndex === String(main.clientOrderIndex);
      let rec: VenueOrder | null = p.active?.find(match) ?? null;
      try {
        if (rec === null) {
          if (p.active === null) continue; // unread: the gap is already said
          const inactive = await inactiveAll(p);
          if (inactive === null) continue;
          rec = inactive.find(match) ?? null;
        }
        if (rec === null) {
          // Not listed yet (a lagging index) is normal for minutes. An hour on,
          // inside the venue's own window, it is a gap; past that window the
          // row can no longer count against any day, so it is said once and
          // left `executed` rather than refusing opens for good.
          const nowSec = Math.floor(p.nowMs / 1000);
          if (row.updatedAt < nowSec - 3_600) {
            const s = `fills: executed row ${row.id} names an order the venue no longer lists; its worst notional stays on the cap`;
            if (row.createdAt * 1000 > p.nowMs - REBUILD_WINDOW_MS) gap(p, s);
            else if (!alerted.has(`x:${row.id}`)) {
              alerted.add(`x:${row.id}`);
              alert(p, s);
            }
          }
          continue;
        }
        await learnLeg(main, rec);
        if (!venueFinal(rec.status)) continue;
        const t = tallies.get(rec.orderIndex) ?? { base: 0n, quoteMicro: 0n };
        if (t.base < rec.filledBaseAmount) continue; // its fills are not all in yet
        if (t.base > rec.filledBaseAmount) {
          gap(p, `fills: order ${rec.orderIndex} has more booked fills than the venue says it filled`);
          continue;
        }
        const status = rec.status === "filled" ? "filled" : rec.filledBaseAmount > 0n ? "partial" : "cancelled";
        await store.resolvePerpOrder({ agentId, mode: "live", id: row.id, status, filledBase: rec.filledBaseAmount, filledQuoteMicro: t.quoteMicro });
      } catch (e) {
        gap(p, `fills: executed row ${row.id} could not be finalized (${msg(e)})`);
      }
    }
  }

  async function fillsStep(p: Pass): Promise<void> {
    if (p.decimals === null || p.auth === null) {
      if (p.auth !== null) gap(p, "fills: no market decimals; trades and orders cannot be parsed");
      return;
    }
    await readActive(p);
    // A rebuild reads the venue's whole inactive list up front: every order
    // of ours is adopted BEFORE any trade is attributed, so no fill of a lost
    // order is booked as anything but ours.
    if (p.rebuilding !== null) await inactiveAll(p);
    if (p.active !== null) await classifyOrders(p, p.active);
    if (p.inactive) {
      await classifyOrders(p, p.inactive);
      p.inactiveClassified = true;
    }

    const since = fillCursorMs ?? p.nowMs - REBUILD_WINDOW_MS;
    const { trades, complete } = await readTradesSince(p, since);
    const ordered = trades
      .filter((t) => t.timestampMs >= since && t.ours.length > 0)
      .sort((a, b) => a.timestampMs - b.timestampMs || a.transactionTimeUs - b.transactionTimeUs || (BigInt(a.tradeId) < BigInt(b.tradeId) ? -1 : 1));
    let booked = true;
    let newest = since;
    for (const t of ordered) {
      for (const s of t.ours) {
        let ok = false;
        try {
          ok = await bookSide(p, t, s);
        } catch (e) {
          gap(p, `fills: trade ${t.tradeId} (${s.side}) could not be booked (${msg(e)})`);
        }
        if (!ok) booked = false;
      }
      // The cursor may only pass what was booked, all of it, in order.
      if (booked && t.timestampMs > newest) newest = t.timestampMs;
    }
    p.fillsComplete = complete && booked;
    if (p.fillsComplete) {
      const next = Math.max(since, (ordered.length > 0 ? newest : p.nowMs) - FILL_CURSOR_OVERLAP_MS);
      fillCursorMs = next;
    }
    await finalizeStep(p);
    // An inactive list read lazily (to attribute a trade or finalize a row)
    // is classified like any other read: rule 16 (d) covers every order the
    // venue shows, not only the ones a trade led us to.
    if (p.inactive && !p.inactiveClassified) {
      await classifyOrders(p, p.inactive);
      p.inactiveClassified = true;
    }
  }

  // ── 3. funding ────────────────────────────────────────────────────────────

  async function fundingStep(p: Pass): Promise<void> {
    const d = p.decimals;
    if (d === null || p.auth === null) return;
    const since = fundingCursorSec ?? Math.floor((p.nowMs - REBUILD_WINDOW_MS) / 1000);
    const rows = new Map<string, PositionFundingRow>();
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < MAX_FUNDING_PAGES; page++) {
      const c = cursor;
      const r = await read(() => api.positionFunding({ accountIndex, limit: FUNDING_PAGE, startSec: since, ...(c === undefined ? {} : { cursor: c }) }, d, flags(p)));
      if (!r.ok) {
        gap(p, `funding: positionFunding unread (${r.kind})`);
        break;
      }
      let oldest = Number.POSITIVE_INFINITY;
      for (const f of r.value.rows) {
        rows.set(`${f.marketId}:${f.fundingId}`, f);
        if (f.timestampSec < oldest) oldest = f.timestampSec;
      }
      if (r.value.rows.length === 0 || r.value.nextCursor === null || oldest < since) {
        complete = true;
        break;
      }
      cursor = r.value.nextCursor;
    }
    if (!complete && rows.size > 0) gap(p, "funding: more funding rows than one pass reads; the rest wait");
    const ordered = [...rows.values()].filter((f) => f.timestampSec >= since).sort((a, b) => a.timestampSec - b.timestampSec || a.marketId - b.marketId);
    let booked = true;
    let newest = since;
    for (const f of ordered) {
      try {
        // `change` is HOLDER-signed (negative = paid): the venue's own money
        // movement, booked as is. A payment whose sign contradicts the rate —
        // a long receiving while longs pay — is a convention the venue has not
        // shown us; it is booked (the venue moved that money) and said.
        if (f.ratePpm !== 0 && f.changeMicro !== 0n) {
          const longsPay = f.ratePpm > 0;
          const payer = (f.positionSide === "long") === longsPay;
          if (payer !== f.changeMicro < 0n) gap(p, `funding: payment ${f.fundingId} in market ${f.marketId} has a sign the rate does not explain`);
        }
        if (f.discountMicro !== 0n) gap(p, `funding: payment ${f.fundingId} carries a discount of ${f.discountMicro} micro whose meaning is unobserved`);
        const outcome = await store.insertPerpFunding({
          agentId,
          mode: "live",
          marketId: f.marketId,
          fundingId: f.fundingId,
          fundingHour: Math.floor(f.timestampSec / 3_600) * 3_600,
          paymentMicro: f.changeMicro,
          ratePpm: f.ratePpm,
          positionBase: f.positionSize,
          positionSide: f.positionSide,
        });
        if (outcome === "mismatch" || outcome === "hour-conflict") {
          gap(p, `funding: payment ${f.fundingId} in market ${f.marketId} disagrees with what is booked (${outcome})`);
        }
        deltaRecords.set(`funding:${f.marketId}:${f.fundingId}`, { tsUs: f.timestampSec * 1_000_000, fillsMicro: 0n, fundingMicro: f.changeMicro, depositMicro: 0n, withdrawMicro: 0n });
        if (f.timestampSec > newest) newest = f.timestampSec;
      } catch (e) {
        gap(p, `funding: payment ${f.fundingId} could not be booked (${msg(e)})`);
        booked = false;
        break;
      }
    }
    p.fundingComplete = complete && booked;
    if (p.fundingComplete) fundingCursorSec = Math.max(since, (ordered.length > 0 ? newest : Math.floor(p.nowMs / 1000)) - FUNDING_CURSOR_OVERLAP_SEC);
  }

  // ── 4. transfers ──────────────────────────────────────────────────────────

  async function transfersStep(p: Pass): Promise<void> {
    if (p.auth === null) return;
    let open: PerpTransferRow[];
    try {
      open = await store.listOpenPerpTransfers(agentId, "live");
    } catch (e) {
      gap(p, `transfers: open transfers unread (${msg(e)})`);
      return;
    }
    // Deposits landed and never seen credited (see deltaStep): T_in would
    // count them beside the collateral they may already be.
    for (const t of open) {
      if (t.direction === "deposit" && t.state === "landed" && p.nowMs - t.updatedAt * 1000 > DEPOSIT_CREDIT_GRACE_MS) {
        gap(p, `transfers: deposit ${t.id} landed on chain but the venue has not been seen to credit it`);
      }
    }
    const rows: WithdrawHistoryRow[] = [];
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < MAX_WITHDRAW_PAGES; page++) {
      const c = cursor;
      const r = await read(() => api.withdrawHistory({ accountIndex, ...(c === undefined ? {} : { cursor: c }) }, flags(p)));
      if (!r.ok) {
        gap(p, `transfers: withdraw history unread (${r.kind})`);
        return;
      }
      rows.push(...r.value.rows);
      if (r.value.cursor === null || r.value.rows.length === 0) {
        complete = true;
        break;
      }
      cursor = r.value.cursor;
    }
    const withdrawals = open.filter((t) => t.direction === "withdraw");
    const matched = new Set<string>();
    let ok = true;
    for (const h of rows) {
      try {
        if (h.assetId !== LIGHTER_ROUTE_V1.assetIndex) continue; // not USDG: not ours to book (rule 2); the account read says where it sits
        if (h.type === "fast") {
          // A fast withdrawal needs an L1 signature the worker cannot make.
          gap(p, `transfers: a fast withdrawal (${clip(h.id)}) appears on our account; this worker never requests one`);
          continue;
        }
        // By our L2 Withdraw's hash when the venue's id is that hash; else by
        // amount, among OUR open withdrawals requested around that time (a
        // history row older than our request, or one we requested after it,
        // is not that request), and only when exactly one fits.
        const byId = withdrawals.find((w) => w.venueTxHash !== null && w.venueTxHash === h.id.toLowerCase().replace(/^0x/, ""));
        const byAmount = withdrawals.filter(
          (w) => !matched.has(w.id) && w.amountMicro === h.amountMicro && w.createdAt <= h.timestampSec + 300 && h.timestampSec >= w.createdAt - 300,
        );
        const w = byId ?? (byAmount.length === 1 ? byAmount[0] : undefined);
        if (w === undefined && byAmount.length > 1) {
          gap(p, `transfers: withdrawal ${clip(h.id)} of ${h.amountMicro} micro matches ${byAmount.length} of ours`);
          continue;
        }
        if (w !== undefined) {
          matched.add(w.id);
          // The venue's history moves a row FORWARD only, and never to
          // `paid`: pending, claimable and completed all say the L2 withdraw
          // executed; the chain says when it was paid (payouts.ts).
          const state = h.status === "failed" ? "failed" : h.status === "refunded" ? "refunded" : "executed";
          const r = await store.upsertPerpTransfer({ agentId, mode: "live", id: w.id, direction: "withdraw", amountMicro: w.amountMicro, initiator: w.initiator, state });
          if (r.outcome === "refused") gap(p, `transfers: withdrawal ${w.id} could not advance (${r.why})`);
          else if (r.outcome === "advanced" && r.journaled) {
            const tsUs = h.timestampSec * 1_000_000;
            if (state === "executed") deltaRecords.set(`withdraw:${w.id}`, { tsUs, fillsMicro: 0n, fundingMicro: 0n, depositMicro: 0n, withdrawMicro: w.amountMicro });
            else if (r.from === "executed") deltaRecords.set(`withdraw-back:${w.id}`, { tsUs: p.nowMs * 1000, fillsMicro: 0n, fundingMicro: 0n, depositMicro: w.amountMicro, withdrawMicro: 0n });
          }
          continue;
        }
        // A withdrawal still in flight that no OPEN row of ours explains. It
        // is NOT adopted as in transit: the venue's history lags the payout
        // (margin-in-transit-double-count 3), so this is as likely our own
        // withdrawal already paid home as an unrequested one, and counting it
        // in T_out would put the same money in cash AND in transit — a phantom
        // gain the high-water mark and the fee would keep. Left out, the worst
        // case is the conservative one (equity under-counted until the payout
        // lands, which then reads as capital, never as profit). So: a gap
        // until the venue's history settles, and said. Completed, failed and
        // refunded rows move nothing this ledger still carries.
        if (h.status === "pending" || h.status === "claimable") {
          const s = `transfers: a ${h.status} withdrawal of ${h.amountMicro} micro-USDG (${clip(h.id)}) matches no open withdrawal of ours`;
          gap(p, s);
          if (!alerted.has(`w:${h.id}`)) {
            alerted.add(`w:${h.id}`);
            alert(p, s);
          }
        }
      } catch (e) {
        gap(p, `transfers: withdrawal ${clip(h.id)} could not be booked (${msg(e)})`);
        ok = false;
      }
    }
    p.transfersComplete = complete && ok;
  }

  // ── 5–6. the account read and the positions it carries ────────────────────

  async function accountStep(p: Pass, acctRow: PerpAccountRow | null | undefined): Promise<PerpAccountRead | null> {
    const d = p.decimals;
    if (d === null || p.auth === null) return null;
    const r = await read(() => api.account({ by: "index", accountIndex }, d, flags(p)));
    if (!r.ok) {
      gap(p, `account: the venue account is unread (${r.kind})`);
      return null;
    }
    // Rule 12: never a snapshot older than the last one used.
    if (acctRow?.lastSnapshotTime !== null && acctRow?.lastSnapshotTime !== undefined && r.value.transactionTimeUs < acctRow.lastSnapshotTime) {
      gap(p, "account: the venue answered with a snapshot older than the last one used");
      return null;
    }
    return r.value;
  }

  async function syncStep(p: Pass, acct: PerpAccountRead): Promise<void> {
    try {
      const held = await store.getPerpPositions(agentId, "live", { includeFlat: true });
      const byMarket = new Map(held.map((r) => [r.marketId, r]));
      const rows: Omit<PerpPositionInput, "agentId" | "mode" | "source">[] = acct.positions.map((v) => {
        const prior = byMarket.get(v.marketId);
        // The venue says size, side, margin and P&L; the LEDGER keeps what the
        // venue does not — the stop and take we recorded and when the position
        // was opened — for as long as it is the same position (same side).
        const keep = prior !== undefined && v.side !== null && prior.side === v.side ? prior : null;
        return {
          marketId: v.marketId,
          side: v.side,
          base: v.baseAmount,
          entryPrice: v.side === null ? null : v.avgEntryPrice,
          allocatedMarginMicro: v.allocatedMarginMicro,
          imfBp: v.imfBp,
          marginMode: v.marginMode,
          realizedMicro: v.realizedMicro,
          fundingMicro: v.totalFundingPaidOutMicro,
          stopTrigger: keep?.stopTrigger ?? null,
          stopPrice: keep?.stopPrice ?? null,
          takeTrigger: keep?.takeTrigger ?? null,
          takePrice: keep?.takePrice ?? null,
          fundingHourApplied: null,
          openedAt: keep?.openedAt ?? null,
        };
      });
      // Markets this read does not list go flat (setPerpPositions), keeping
      // their leverage state.
      await store.setPerpPositions(agentId, "live", "venue", rows);
      await store.patchPerpAccount(agentId, "live", {
        accountIndex,
        lastVenueReadAt: Math.floor(p.nowMs / 1000),
        lastSnapshotTime: acct.transactionTimeUs,
      });
    } catch (e) {
      gap(p, `positions: the venue cache could not be written (${msg(e)})`);
    }
  }

  // ── 7. the venue-delta identity ───────────────────────────────────────────

  function recordsBetween(fromUs: number, toUs: number): VenueDeltaRecords {
    const out: VenueDeltaRecords = { fillsMicro: 0n, fundingMicro: 0n, depositsCreditedMicro: 0n, withdrawalsExecutedMicro: 0n, records: 0 };
    for (const r of deltaRecords.values()) {
      if (r.tsUs <= fromUs || r.tsUs > toUs) continue;
      out.fillsMicro += r.fillsMicro;
      out.fundingMicro += r.fundingMicro;
      out.depositsCreditedMicro += r.depositMicro;
      out.withdrawalsExecutedMicro += r.withdrawMicro;
      out.records++;
    }
    return out;
  }

  /**
   * A mismatch that is exactly our landed deposits (all of them, or one) is
   * the venue CREDITING them — the "venue shows it" of the deposit machine
   * (perp-ledger-rules.ts). They move to `credited` (journaled `margin`), and
   * T_in stops counting money C now holds.
   */
  async function creditDeposits(p: Pass, diff: bigint, tol: bigint, curr: VenueMoneySnapshot): Promise<boolean> {
    let open: PerpTransferRow[];
    try {
      open = (await store.listOpenPerpTransfers(agentId, "live")).filter((t) => t.direction === "deposit" && t.state === "landed");
    } catch {
      return false;
    }
    if (open.length === 0) return false;
    const within = (x: bigint) => (x < 0n ? -x : x) <= tol + DELTA_TOLERANCE_PER_RECORD_MICRO * BigInt(open.length);
    const all = open.reduce((s, t) => s + t.amountMicro, 0n);
    const pick = within(diff - all) ? open : ((): PerpTransferRow[] => {
      const one = open.filter((t) => within(diff - t.amountMicro));
      return one.length === 1 ? one : [];
    })();
    if (pick.length === 0) return false;
    for (const t of pick) {
      const r = await store.upsertPerpTransfer({ agentId, mode: "live", id: t.id, direction: "deposit", amountMicro: t.amountMicro, initiator: t.initiator, state: "credited" });
      if (r.outcome === "advanced" && r.journaled) {
        deltaRecords.set(`deposit:${t.id}`, { tsUs: curr.transactionTimeUs, fillsMicro: 0n, fundingMicro: 0n, depositMicro: t.amountMicro, withdrawMicro: 0n });
      }
    }
    alert(p, `the venue credited ${pick.length} deposit(s)`);
    return true;
  }

  async function deltaStep(p: Pass, acct: PerpAccountRead): Promise<boolean> {
    const curr: VenueMoneySnapshot = { collateralMicro: acct.collateralMicro, isolatedMarginMicro: acct.isolatedMarginMicro, transactionTimeUs: acct.transactionTimeUs };
    if (!p.fillsComplete || !p.fundingComplete || !p.transfersComplete) {
      // The window is judged when its records are all in; the previous
      // snapshot stays, so the next complete pass judges the whole span.
      return false;
    }
    if (prevSnapshot === null) {
      prevSnapshot = curr;
      for (const [k, r] of deltaRecords) if (r.tsUs <= curr.transactionTimeUs) deltaRecords.delete(k);
      return false;
    }
    const prev = prevSnapshot;
    let verdict = venueDeltaCheck(prev, curr, recordsBetween(prev.transactionTimeUs, curr.transactionTimeUs));
    if (!verdict.ok && verdict.reason === undefined) {
      // A fill that landed between the trade read and the account read is the
      // common, harmless mismatch: read the trades once more and re-judge.
      await fillsRecheck(p);
      verdict = venueDeltaCheck(prev, curr, recordsBetween(prev.transactionTimeUs, curr.transactionTimeUs));
      if (!verdict.ok && (await creditDeposits(p, verdict.diffMicro, verdict.toleranceMicro, curr))) {
        verdict = venueDeltaCheck(prev, curr, recordsBetween(prev.transactionTimeUs, curr.transactionTimeUs));
      }
    }
    // Consumed: every record at or before this snapshot has had its window.
    for (const [k, r] of deltaRecords) if (r.tsUs <= curr.transactionTimeUs) deltaRecords.delete(k);
    if (verdict.reason === "stale-snapshot") {
      gap(p, "delta: the venue answered with an older snapshot than the last one judged");
      return false;
    }
    prevSnapshot = curr;
    if (verdict.ok) {
      mismatchStreak = 0;
      return false;
    }
    mismatchStreak++;
    const s = `delta: the venue's collateral moved ${verdict.actualMicro} micro, the ledger explains ${verdict.explainedMicro} (off by ${verdict.diffMicro}, tolerance ${verdict.toleranceMicro})`;
    gap(p, s);
    alert(p, s);
    return mismatchStreak >= DELTA_DOUBTFUL_AFTER;
  }

  async function fillsRecheck(p: Pass): Promise<void> {
    const since = fillCursorMs ?? p.nowMs - REBUILD_WINDOW_MS;
    const { trades } = await readTradesSince(p, since);
    for (const t of trades.filter((x) => x.timestampMs >= since && x.ours.length > 0).sort((a, b) => a.timestampMs - b.timestampMs)) {
      for (const s of t.ours) {
        try {
          await bookSide(p, t, s);
        } catch (e) {
          gap(p, `fills: trade ${t.tradeId} (${s.side}) could not be booked (${msg(e)})`);
        }
      }
    }
  }

  // ── 8. incidents ──────────────────────────────────────────────────────────

  async function incidentStep(p: Pass, acct: PerpAccountRead | null, acctRow: PerpAccountRow | null | undefined, doubtful: boolean): Promise<Incident | null> {
    if (p.auth === null) return null;
    const venueNonce = ourVenueNonce(p);
    let hw: bigint | null = null;
    let recorded: boolean | null = null;
    try {
      // AFTER the venue's nonce was read (armStep): any nonce the venue shows
      // was reserved before it was signed, so it is already under this.
      hw = await store.getNonceHighWater(agentId, "live");
      if (armed && venueNonce !== null && hw !== null) {
        const last = BigInt(venueNonce) - 1n;
        if (last >= 1n && last <= hw && (baselineNonce === null || last > baselineNonce)) {
          // Either reading of the venue's field — next or last — must name a
          // nonce some row of ours holds.
          recorded = (await store.perpNonceRecorded(agentId, accountIndex, apiKeyIndex, last)) || (await store.perpNonceRecorded(agentId, accountIndex, apiKeyIndex, venueNonce));
        }
      }
    } catch (e) {
      gap(p, `incident: the nonce high-water or order rows could not be read (${msg(e)})`);
    }
    const l1 = await read(() => api.accountsByL1Address(deps.smartAccount, flags(p)));
    const sealed = canonKey(deps.sealedPubKey);
    const inputs: IncidentInputs = {
      sealedPubKey: deps.sealedPubKey,
      apiKeyIndex,
      masterIndex: accountIndex,
      apikeysRead: p.apikeys,
      accountsByL1Read: l1.ok ? l1.value : null,
      highWater: hw,
      venueNonceForOurKey: venueNonce,
      nonceJudged: armed,
      nonceRecorded: recorded,
      sealedRetired: acctRow?.retiredPubkeys.some((k) => canonKey(k) === sealed) ?? false,
      unknownFills: p.unknownFills,
      unknownOrders: p.unknownOrders,
      deltaMismatch: doubtful,
      nowSec: Math.floor(p.nowMs / 1000),
    };
    for (const g of incidentReadGaps(inputs)) gap(p, g);
    let incident = detectIncidents(inputs);
    // Money where this worker never puts it — spot balances, pool shares,
    // pending unlocks — is venue money the ledger cannot explain (rule 16 e).
    if (acct !== null && (acct.spotHoldings.length > 0 || acct.poolShareCount > 0 || acct.pendingUnlockCount > 0)) {
      const trigger = {
        kind: "venue-money-unexplained" as const,
        evidence: `the account holds ${acct.spotHoldings.length} spot balance(s), ${acct.poolShareCount} pool share(s) and ${acct.pendingUnlockCount} pending unlock(s)`,
      };
      incident = incident === null ? { kind: trigger.kind, at: inputs.nowSec, detail: { triggers: [trigger] } } : { ...incident, detail: { triggers: [...incident.detail.triggers, trigger] } };
    }
    if (incident !== null) {
      try {
        const r = await persistIncident(store, { agentId, incident });
        if (r === "set") alert(p, `INCIDENT (${incident.kind}): the Lighter API key may be compromised — opens are refused; ${incident.detail.triggers.map((t) => t.evidence).join("; ")}`);
      } catch (e) {
        const s = `incident: the flag could not be stored (${msg(e)}); opens must be refused from memory`;
        gap(p, s);
        alert(p, s);
      }
    }
    return incident;
  }

  // ── the pass ──────────────────────────────────────────────────────────────

  async function prepare(p: Pass): Promise<PerpAccountRow | null | undefined> {
    if (p.auth === null) {
      gap(p, "auth: no Lighter auth token; the account cannot be read");
      return undefined;
    }
    p.decimals = await decimalsFor(p);
    try {
      return await store.getPerpAccount(agentId, "live");
    } catch (e) {
      gap(p, `ledger: the account row is unreadable (${msg(e)})`);
      return undefined;
    }
  }

  function report(p: Pass): StepReport {
    return { gaps: p.gaps, alerts: p.alerts };
  }

  async function reconcileOnce(): Promise<ReconcileResult> {
    const p = newPass();
    let acct: PerpAccountRead | null = null;
    let incident: Incident | null = null;
    let doubtful = false;
    try {
      const acctRow = await prepare(p);
      if (p.auth !== null) {
        await readApiKeys(p);
        await armStep(p, acctRow);
        await resolveStep(p);
        await fillsStep(p);
        await fundingStep(p);
        await transfersStep(p);
        acct = await accountStep(p, acctRow);
        if (acct !== null) await syncStep(p, acct);
        if (acct !== null) doubtful = await deltaStep(p, acct);
        await finishArm(p);
        horizonGap(p);
        incident = await incidentStep(p, acct, acctRow, doubtful);
      }
    } catch (e) {
      // Nothing above should throw; if something did, it is a gap, never a
      // crashed tick.
      gap(p, `reconcile: the pass stopped (${msg(e)})`);
    }
    if (!armed) gap(p, "arm: the ledger's continuity with the venue is not established; opens wait");
    return {
      gaps: p.gaps,
      alerts: p.alerts,
      accountRead: acct,
      orders: p.active,
      decimals: p.decimals,
      incident,
      adopted: p.adopted,
      forcedFills: p.forced,
      deltaDoubtful: doubtful,
      continuity,
    };
  }

  return {
    async resolveSubmitted() {
      const p = newPass();
      await prepare(p);
      await resolveStep(p);
      return report(p);
    },
    async ingestFills() {
      const p = newPass();
      await prepare(p);
      await fillsStep(p);
      return { ...report(p), adopted: p.adopted, unknownFills: p.unknownFills, unknownOrders: p.unknownOrders, forcedFills: p.forced };
    },
    async ingestFunding() {
      const p = newPass();
      await prepare(p);
      await fundingStep(p);
      return report(p);
    },
    async ingestTransfers() {
      const p = newPass();
      await prepare(p);
      await transfersStep(p);
      return report(p);
    },
    async syncPositions(accountRead: PerpAccountRead) {
      const p = newPass();
      await syncStep(p, accountRead);
      return report(p);
    },
    async rebuildDayAfterWipe() {
      const p = newPass();
      const acctRow = await prepare(p);
      if (p.auth !== null) {
        await readApiKeys(p);
        await armStep(p, acctRow);
        if (p.rebuilding !== null) {
          await fillsStep(p);
          await finishArm(p);
        }
      }
      horizonGap(p);
      return { ...report(p), continuity, adopted: p.adopted };
    },
    async isContinuous() {
      const p = newPass();
      const acctRow = await prepare(p);
      if (p.auth === null || acctRow === undefined) return false;
      await readApiKeys(p);
      return isContinuous(acctRow, ourVenueNonce(p));
    },
    venueDeltaCheck,
    reconcileOnce,
    state() {
      return { armed, continuity, fillCursorMs, fundingCursorSec, mismatchStreak };
    },
  };
}
