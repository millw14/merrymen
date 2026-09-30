/**
 * THE ON-CHAIN PERP LEGS ON THE USEROP RAIL — the deposit, the key
 * registration and the claim, as index.ts processIntentLocked, the stranded
 * resolver and the orphan sweep meet them (docs/perps.md rules 3, 9 — "on-chain
 * legs ride the existing UserOp rail, which already works this way" — and 12;
 * the no-trades-rows-for-l2-perp-orders and margin-in-transit amendments).
 *
 * WHY THIS FILE, AND WHY SO LITTLE IN IT. Everything that makes an on-chain leg
 * crash-safe already exists in index.ts: the durable `submitted` trades row
 * written BEFORE broadcast (executor.ts onSubmitted), never re-sent; the
 * stranded resolver and its dropped-op write-off; the arm-time orphan sweep;
 * the budget reservation. A perp leg rides all of it as any other kind does.
 * What a perp leg adds is three questions that rail cannot answer for itself,
 * each pure here so a test can ask it without booting main():
 *
 *   perpLegCalls     — WHAT IS SIGNED. The calls from onboard.ts's builders —
 *                      proxy, token, asset, route and key from the frozen route
 *                      and the grant, the account index from the chain — and
 *                      then the matching final-fence lane, unconditionally. A
 *                      mismatch is a refusal before anything is signed.
 *   perpLegOfReceipt — WHAT LANDED. The proxy's own events in the op's own
 *                      logs: Deposit(to = self), the changePubKey priority
 *                      request (sender = self), WithdrawPending(owner = self).
 *                      One of them names the leg; none is "not a perp leg";
 *                      anything else — two legs, a proxy event about someone
 *                      else, a body that does not decode — is `ambiguous` and
 *                      is never guessed into a kind.
 *   perpLegTransfer  — WHAT THE MARGIN LEDGER RECORDS. A deposit is a
 *                      perp_transfers row `submitted` beside its pre-broadcast
 *                      trades row, and `landed` (identified by its Deposit log)
 *                      in the same db.tx as the trades row's settlement
 *                      (store.ts addTrade `with`). A claim writes NO transfer
 *                      here: its money is a WithdrawPending, and payouts.ts
 *                      recognises every one of those from the chain — mapping
 *                      it here as well would book one payout twice. A key
 *                      registration moves no money.
 *
 * THE TRADES ROWS these legs write are `perp-deposit`, `perp-key` and
 * `perp-claim` — never `transfer` (index.ts would book it as the owner taking
 * money home) and never `swap` — with `target` the proxy and every fill column
 * null (the no-trades-rows amendment). store.ts getSpentTodayUsdg counts a
 * deposit as spend and neither of the others; every one is an op.
 */

import { decodeEventLog, parseAbi, toEventSelector, type Hex } from "viem";
import {
  LIGHTER_READ_ABI,
  LIGHTER_ROUTE_V1,
  decodeLighterLog,
  lighterVenueProxies,
  validatePerpPubKey,
  type PerpGrant,
  type ReceiptLogLike,
} from "../../../packages/core/src/index";
import type { Call } from "../executor";
import { execModeOf, type ExecInputs, type ExecMode } from "../exec-mode";
import { checkPerpClaimCalls, checkPerpDepositCalls, checkPerpKeyCalls, type FenceVerdict } from "../final-fence";
import type { PerpKeyIntent, PerpMarginIntent, TradeIntent } from "../policy";
import type { PerpTransferInput } from "../store";
import { buildClaimCalls, buildDepositCalls, buildKeyCalls } from "./onboard";

// ── the kinds ───────────────────────────────────────────────────────────────

/** The trades kinds of the three on-chain legs — the only perp activity that is ever a `trades` row. */
export const PERP_LEG_KINDS = Object.freeze(["perp-deposit", "perp-key", "perp-claim"] as const);
export type PerpLegKind = (typeof PERP_LEG_KINDS)[number];

export function isPerpLegKind(kind: unknown): kind is PerpLegKind {
  return typeof kind === "string" && (PERP_LEG_KINDS as readonly string[]).includes(kind);
}

/** Return a pending payout to the same account even when new trading is off.
 * Policy still requires the unexpired sealed perp grant; every mechanical
 * execution gate and the final self-recipient fence remain in force.
 */
export function perpClaimExecMode(inputs: ExecInputs): ExecMode {
  return execModeOf({ ...inputs, liveTradingEnabled: true, cashUsdg: null });
}

/** The intents that are on-chain legs: a margin deposit, a claim, a key registration. */
export type PerpLegIntent = PerpKeyIntent | PerpMarginIntent;

/**
 * The trades kind an intent's row is written under, or null when the intent is
 * not an on-chain perp leg. A `perp-margin` WITHDRAW is an L2 request the perp
 * lane signs with the API key — never a UserOp, never a trades row — so it is
 * null here, and index.ts hands it to the lane.
 */
export function perpLegKind(intent: TradeIntent): PerpLegKind | null {
  if (intent.kind === "perp-key") return "perp-key";
  if (intent.kind !== "perp-margin") return null;
  if (intent.direction === "deposit") return "perp-deposit";
  if (intent.direction === "claim") return "perp-claim";
  return null;
}

/** The USDG a leg moves (micro): a deposit's out, a claim's home, a key registration's none. */
export function perpLegAmountMicro(intent: PerpLegIntent): bigint {
  return intent.kind === "perp-key" ? 0n : intent.amountUsdg;
}

// ── what is signed ──────────────────────────────────────────────────────────

export type PerpLegBuild =
  | { ok: true; kind: PerpLegKind; calls: Call[] }
  /**
   * Nothing is signed. `rule` is a final-fence refusal (`fence-<rule>`, the
   * energy fence's vocabulary), `perp-not-granted`, `perp-venue-unready` (the
   * chain's account index is unread, 0, or not the one the producer planned
   * on) or `perp-order-malformed` (a builder refused its own inputs).
   */
  | { ok: false; kind: PerpLegKind; rule: string; detail: string };

/**
 * THE CALLS FOR ONE LEG, AND THE FENCE OVER THEM — BEFORE ANYTHING IS SIGNED.
 *
 * No alternative builder, no skip, no condition: onboard.ts builds the calls
 * from the frozen route and the grant's sealed key, and the matching
 * final-fence lane checks them byte for byte against the terms this leg was
 * approved for. The fence is stricter than the wall on purpose (final-fence.ts):
 * a USDG approve naming the energy router passes the wall's ONE_OF and fails
 * here.
 *
 * THE ACCOUNT INDEX COMES FROM THE CHAIN. `chainAccountIndex` is
 * addressToAccountIndex(self) read by the caller just now; the intent's
 * `accountIndex` is only what its producer planned on. They must agree — a
 * disagreement means the producer read another moment of the chain (or another
 * account), and registering a key on a plan nobody can reproduce is refused.
 */
export function perpLegCalls(
  intent: PerpLegIntent,
  ctx: {
    /** grantPerp(active.grant) — the sealed route and key, or null. */
    perp: PerpGrant | null;
    /** The smart account: the deposit's `_to`, the claim's `_owner`. */
    account: `0x${string}`;
    /** addressToAccountIndex(self), read for this leg; null = unread. Only the key registration reads it. */
    chainAccountIndex?: bigint | null;
    /**
     * The builders — onboard.ts's, always, in production. A seam for one
     * test: a builder that drifted from the fence must be refused BY the
     * fence, and only a drifted builder can show that.
     */
    builders?: { deposit?: typeof buildDepositCalls; key?: typeof buildKeyCalls; claim?: typeof buildClaimCalls };
  },
): PerpLegBuild {
  const kind = perpLegKindOf(intent);
  if (kind === null) {
    return { ok: false, kind: "perp-deposit", rule: "perp-order-malformed", detail: "a Lighter withdrawal is an L2 request, never a UserOp" };
  }
  const perp = ctx.perp;
  if (perp === null) {
    return { ok: false, kind, rule: "perp-not-granted", detail: "the signed permission carries no Lighter route, so there is nothing to sign through" };
  }
  const account = ctx.account.toLowerCase() as `0x${string}`;
  const proxy = LIGHTER_ROUTE_V1.proxy;
  let calls: Call[];
  let fence: FenceVerdict;
  try {
    if (kind === "perp-deposit") {
      const deposit = intent as Extract<PerpMarginIntent, { direction: "deposit" }>;
      if (typeof deposit.target !== "string" || deposit.target.toLowerCase() !== proxy) {
        return { ok: false, kind, rule: "fence-recipient", detail: `the deposit names ${String(deposit.target)}, not the sealed Lighter proxy` };
      }
      calls = (ctx.builders?.deposit ?? buildDepositCalls)({ perp, account, amountMicro: deposit.amountUsdg });
      fence = checkPerpDepositCalls(calls, { account, usdg: LIGHTER_ROUTE_V1.usdg, proxy, amount: deposit.amountUsdg });
    } else if (kind === "perp-claim") {
      const claim = intent as PerpMarginIntent;
      calls = (ctx.builders?.claim ?? buildClaimCalls)({ perp, account, amountMicro: claim.amountUsdg });
      fence = checkPerpClaimCalls(calls, { proxy, account, amount: claim.amountUsdg });
    } else {
      const key = intent as PerpKeyIntent;
      const onChain = ctx.chainAccountIndex;
      if (onChain === null || onChain === undefined) {
        return { ok: false, kind, rule: "perp-venue-unready", detail: "the agent's Lighter account index could not be read on chain" };
      }
      if (onChain === 0n) {
        return { ok: false, kind, rule: "perp-venue-unready", detail: "the chain shows no Lighter account for the agent yet — its first deposit has not landed" };
      }
      if (!Number.isSafeInteger(key.accountIndex) || BigInt(key.accountIndex) !== onChain) {
        return {
          ok: false,
          kind,
          rule: "perp-venue-unready",
          detail: `the key registration was planned for Lighter account ${String(key.accountIndex)}, and the chain says the agent's is ${onChain}`,
        };
      }
      calls = (ctx.builders?.key ?? buildKeyCalls)({ perp, accountIndex: onChain });
      fence = checkPerpKeyCalls(calls, { proxy, accountIndex: onChain, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: perp.apiPublicKey });
    }
  } catch (e) {
    // A builder refusing its own inputs (an amount under Lighter's minimum, a
    // key the grant should never have carried) is an intent built wrong.
    return { ok: false, kind, rule: "perp-order-malformed", detail: e instanceof Error ? e.message : String(e) };
  }
  if (!fence.ok) return { ok: false, kind, rule: `fence-${fence.rule}`, detail: fence.detail };
  return { ok: true, kind, calls };
}

function perpLegKindOf(intent: PerpLegIntent): PerpLegKind | null {
  return perpLegKind(intent as TradeIntent);
}

// ── what landed ─────────────────────────────────────────────────────────────

/** NewPriorityRequest(address sender, uint64 serialId, uint8 pubdataType, bytes pubData, uint64 expirationTimestamp) — nothing indexed (lighter-contracts IEvents.sol). */
export const PRIORITY_ABI = parseAbi([
  "event NewPriorityRequest(address sender, uint64 serialId, uint8 pubdataType, bytes pubData, uint64 expirationTimestamp)",
]);
/** topic0 of NewPriorityRequest, derived from the signature rather than typed. */
export const LIGHTER_PRIORITY_REQUEST_TOPIC = toEventSelector(PRIORITY_ABI[0]).toLowerCase();
/** TxTypes.PriorityPubDataTypeL1ChangePubKey. */
const PUBDATA_CHANGE_PUBKEY = 62;
/** The packed changePubKey pubdata: type (1) ‖ accountIndex (6) ‖ masterAccountIndex (6) ‖ apiKeyIndex (1) ‖ pubKey (40). */
const CHANGE_PUBKEY_PUBDATA_BYTES = 54;

/** One leg, proven from the op's own logs. Amounts are micro-USDG (baseAmount × the route's tick). */
export type PerpLegEvidence =
  | { kind: "perp-deposit"; logIndex: number; accountIndex: bigint; amountMicro: bigint }
  | { kind: "perp-key"; logIndex: number; accountIndex: bigint; masterAccountIndex: bigint; apiKeyIndex: number; publicKey: `0x${string}` }
  | { kind: "perp-claim"; logIndex: number; amountMicro: bigint };

export type PerpLegReading =
  /** No proxy event about this account: not a perp leg (a swap, a transfer…). */
  | { kind: "none" }
  | { kind: "leg"; leg: PerpLegEvidence }
  /** The proxy said something about this op that is not exactly one of our three legs. Never guessed. */
  | { kind: "ambiguous"; why: string };

function positionOf(l: ReceiptLogLike): number | null {
  const v = l.logIndex;
  let n: number | null = null;
  if (typeof v === "number") n = v;
  else if (typeof v === "bigint") n = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
  else if (typeof v === "string" && /^(?:0x[0-9a-fA-F]+|\d+)$/.test(v)) n = Number(v);
  return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * WHICH LEG THESE LOGS PROVE — from ONE op's own logs (the bundler's
 * UserOperationReceipt.logs, or inflight-reconcile.ts opLogsOf over a
 * transaction receipt). Never a whole bundle's: another sender's deposit in
 * the same transaction must not become ours.
 *
 * ONLY THE PROXY SPEAKS. Logs from any other address — a contract copying the
 * proxy's event signatures included — are not evidence (core
 * lighterVenueProxies: 4663's proxy, nothing anywhere else).
 *
 *   Deposit(to = self, asset 3, route 0)          → perp-deposit
 *   NewPriorityRequest(sender = self, type 62)    → perp-key (its pubdata decoded)
 *   WithdrawPending(owner = self, asset 3)        → perp-claim
 *
 * A deposit's own NewPriorityRequest (type 61) is its plumbing, not a second
 * leg. Any other priority request from this account — a recover's withdraw,
 * cancel-all or order (types 65–68) — is the owner's, not one of these legs,
 * and is `ambiguous`; so is a proxy event naming ANOTHER account (the wall
 * pins every leg to self), two legs in one op, or a body that will not decode.
 * The caller leaves an ambiguous op exactly as it found it.
 */
export function perpLegOfReceipt(logs: readonly ReceiptLogLike[], account: string, chainId: number): PerpLegReading {
  const proxies = lighterVenueProxies(chainId);
  if (proxies.length === 0) return { kind: "none" };
  const self = account.toLowerCase();
  const found: PerpLegEvidence[] = [];
  for (const l of logs) {
    if (typeof l?.address !== "string" || !proxies.includes(l.address.toLowerCase())) continue;
    const t0 = String(l.topics?.[0] ?? "").toLowerCase();
    const at = positionOf(l);
    if (t0 === LIGHTER_ROUTE_V1.topics.deposit || t0 === LIGHTER_ROUTE_V1.topics.withdrawPending) {
      const e = decodeLighterLog(l);
      if (e === null) return { kind: "ambiguous", why: "a Lighter margin event in this op does not decode" };
      if (at === null) return { kind: "ambiguous", why: "a Lighter margin event in this op has no readable position" };
      const tick = BigInt(LIGHTER_ROUTE_V1.usdgTickSize);
      if (e.event === "Deposit") {
        if (e.toAddress !== self) return { kind: "ambiguous", why: `this op deposited to another Lighter account (${e.toAddress})` };
        if (e.assetIndex !== LIGHTER_ROUTE_V1.assetIndex || e.routeType !== LIGHTER_ROUTE_V1.routePerps) {
          return { kind: "ambiguous", why: `a deposit of asset ${e.assetIndex} route ${e.routeType}, not USDG to perps` };
        }
        found.push({ kind: "perp-deposit", logIndex: at, accountIndex: e.toAccountIndex, amountMicro: e.baseAmount * tick });
      } else {
        if (e.owner !== self) return { kind: "ambiguous", why: `this op claimed another owner's payout (${e.owner})` };
        if (e.assetIndex !== LIGHTER_ROUTE_V1.assetIndex) return { kind: "ambiguous", why: `a claim of asset ${e.assetIndex}, not USDG` };
        found.push({ kind: "perp-claim", logIndex: at, amountMicro: e.baseAmount * tick });
      }
      continue;
    }
    if (t0 === LIGHTER_PRIORITY_REQUEST_TOPIC) {
      let d: { sender: string; pubdataType: number; pubData: Hex };
      try {
        const r = decodeEventLog({ abi: PRIORITY_ABI, topics: l.topics as [Hex, ...Hex[]], data: l.data as Hex, strict: true });
        d = { sender: String(r.args.sender).toLowerCase(), pubdataType: Number(r.args.pubdataType), pubData: r.args.pubData };
      } catch {
        return { kind: "ambiguous", why: "a Lighter priority request in this op does not decode" };
      }
      if (d.sender !== self) return { kind: "ambiguous", why: `a Lighter priority request from another sender (${d.sender})` };
      // The deposit's own request: the Deposit event beside it is the evidence.
      if (d.pubdataType === 61) continue;
      if (d.pubdataType !== PUBDATA_CHANGE_PUBKEY) {
        return { kind: "ambiguous", why: `a Lighter priority request of type ${d.pubdataType} — not a deposit or a key registration` };
      }
      const key = changePubKeyOf(d.pubData);
      if (key === null || at === null) return { kind: "ambiguous", why: "a key registration whose request does not decode" };
      found.push({ kind: "perp-key", logIndex: at, ...key });
    }
  }
  if (found.length === 0) return { kind: "none" };
  if (found.length > 1) return { kind: "ambiguous", why: `this op carries ${found.length} Lighter legs (${found.map((f) => f.kind).join(", ")}) — ours carry one` };
  return { kind: "leg", leg: found[0]! };
}

/** The packed changePubKey pubdata (TxTypes.writeChangePubKeyPubDataForPriorityQueue), or null. */
export function changePubKeyOf(pubData: Hex): { accountIndex: bigint; masterAccountIndex: bigint; apiKeyIndex: number; publicKey: `0x${string}` } | null {
  if (typeof pubData !== "string" || !/^0x[0-9a-fA-F]*$/.test(pubData) || pubData.length !== 2 + CHANGE_PUBKEY_PUBDATA_BYTES * 2) return null;
  const hex = pubData.slice(2).toLowerCase();
  const byte = (i: number, n: number) => hex.slice(i * 2, (i + n) * 2);
  if (Number.parseInt(byte(0, 1), 16) !== PUBDATA_CHANGE_PUBKEY) return null;
  const publicKey = validatePerpPubKey(`0x${byte(14, 40)}`);
  if (publicKey === null) return null;
  return {
    accountIndex: BigInt(`0x${byte(1, 6)}`),
    masterAccountIndex: BigInt(`0x${byte(7, 6)}`),
    apiKeyIndex: Number.parseInt(byte(13, 1), 16),
    publicKey,
  };
}

/**
 * DOES WHAT LANDED MATCH WHAT WAS SIGNED? The in-process settlement's check,
 * against the leg's own terms — a deposit of exactly the amount to exactly the
 * index the chain now holds for us; a key registration of exactly the sealed
 * key at the route's index; a claim that paid this account something. A null
 * answer is a match; a string says what did not, and the caller leaves the
 * op `submitted` for the resolver rather than book a leg the receipt does not
 * show (rule 9: never guessed).
 */
export function perpLegMismatch(
  intent: PerpLegIntent,
  reading: PerpLegReading,
  sealedPubKey: string | null,
): string | null {
  const kind = perpLegKindOf(intent);
  if (reading.kind !== "leg") return reading.kind === "none" ? `the receipt carries no Lighter event for this ${kind}` : reading.why;
  const leg = reading.leg;
  if (leg.kind !== kind) return `the receipt shows a ${leg.kind}, not the ${kind} that was signed`;
  if (leg.kind === "perp-deposit") {
    const want = (intent as PerpMarginIntent).amountUsdg;
    if (leg.amountMicro !== want) return `the receipt deposited ${leg.amountMicro} micro-USDG, not the ${want} signed`;
    if (leg.accountIndex < 1n) return "the receipt's Deposit names no Lighter account";
  } else if (leg.kind === "perp-key") {
    if (leg.apiKeyIndex !== LIGHTER_ROUTE_V1.apiKeyIndex) return `the receipt registered key index ${leg.apiKeyIndex}, not ${LIGHTER_ROUTE_V1.apiKeyIndex}`;
    if (sealedPubKey === null || validatePerpPubKey(sealedPubKey) !== leg.publicKey) return "the receipt registered a key other than the one the grant sealed";
    if (BigInt((intent as PerpKeyIntent).accountIndex) !== leg.accountIndex) return `the receipt registered on account ${leg.accountIndex}, not ${(intent as PerpKeyIntent).accountIndex}`;
  } else if (leg.amountMicro <= 0n) {
    return "the receipt's claim paid nothing";
  }
  return null;
}

// ── what the margin ledger records ──────────────────────────────────────────

/** A perp_transfers write for one leg, on the live rail (store.ts upsertPerpTransfer's input, less agent and mode). */
export type PerpLegTransfer = Omit<PerpTransferInput, "agentId" | "mode">;

/**
 * The deposit's perp_transfers row when its UserOp is about to go out: the
 * rule-12a "row before it is sent", identified by OUR UserOp hash (the same
 * hash its pre-broadcast trades row carries). `submitted` moves no money, so
 * it journals nothing. Null for a claim (payouts.ts owns its money) and a key.
 */
export function perpLegSubmittedTransfer(intent: PerpLegIntent, userOpHash: string): PerpLegTransfer | null {
  if (perpLegKindOf(intent) !== "perp-deposit") return null;
  return { direction: "deposit", amountMicro: (intent as PerpMarginIntent).amountUsdg, initiator: "agent", state: "submitted", userOpHash };
}

/**
 * The deposit's row once its UserOp LANDED: `landed` — money in transit (T_in)
 * until the venue credits it — identified by the proxy's Deposit log (chain,
 * tx, log index) as well as our UserOp, so the same deposit learned from the
 * rail and later from the log is one row. It journals `margin` exactly once
 * (store.ts upsertPerpTransfer: a re-read that adds nothing writes nothing).
 * `initiator` is the agent's: the wall pins `_to` to this account, and only
 * this worker's session key signs through it.
 */
export function perpLegLandedTransfer(
  leg: PerpLegEvidence,
  at: { userOpHash: string; txHash: string; chainId: number },
): PerpLegTransfer | null {
  if (leg.kind !== "perp-deposit") return null;
  return {
    direction: "deposit",
    amountMicro: leg.amountMicro,
    initiator: "agent",
    state: "landed",
    userOpHash: at.userOpHash,
    chainId: at.chainId,
    txHash: at.txHash,
    logIndex: leg.logIndex,
  };
}

/**
 * The deposit's row when its UserOp REVERTED: `failed`. Nothing left the
 * account, so `submitted → failed` journals nothing and the row leaves the
 * open set (it would otherwise hold every ratchet — rule 12c — for ever).
 */
export function perpLegFailedTransfer(kind: PerpLegKind, amountMicro: bigint, userOpHash: string): PerpLegTransfer | null {
  if (kind !== "perp-deposit" || amountMicro <= 0n) return null;
  return { direction: "deposit", amountMicro, initiator: "agent", state: "failed", userOpHash };
}

/**
 * WHAT A SETTLED LEG EXPLAINS OF THE ACCOUNT'S CASH, for the stranded
 * resolver's settlement queue (flow-inference.ts rule 2: a settlement explains
 * only its own cash). A deposit's USDG left through its own receipt and
 * explains exactly that. A CLAIM's money is a WithdrawPending(self), which the
 * payout fold recognises from the chain between block-pinned reads (rule 12;
 * payouts.ts) — so the claim's settlement explains only what moved BESIDE that
 * payout (nothing, for our one-call claim), or one payout would be folded into
 * the baseline twice and the residual inferred as a withdrawal of it.
 */
export function perpLegCashExplained(receiptUsdgDelta6: bigint | null, reading: PerpLegReading): bigint | null {
  if (receiptUsdgDelta6 === null) return null;
  if (reading.kind === "leg" && reading.leg.kind === "perp-claim") return receiptUsdgDelta6 - reading.leg.amountMicro;
  return receiptUsdgDelta6;
}

// ── the two chain reads the legs and the payout step need ───────────────────

/** A viem-shaped client's one method these reads use. Structural, so a test hands a fake. */
export interface LighterViewClient {
  readContract(args: never): Promise<unknown>;
}

const UINT48_MAX = 2n ** 48n - 1n;
const UINT128_MAX = 2n ** 128n - 1n;

function asUint(v: unknown, max: bigint): bigint | null {
  if (typeof v === "bigint") return v >= 0n && v <= max ? v : null;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v) <= max ? BigInt(v) : null;
  return null;
}

/**
 * addressToAccountIndex(self) — 0n is the chain's own "no Lighter account"
 * (indexes start above 0), null is UNREAD. Off Lighter's chain there is no
 * venue at all, and the answer is a known 0n without a read: the proxy is
 * codeless there, and a call to it "succeeds" with nothing — never evidence.
 */
export async function readLighterAccountIndex(client: LighterViewClient, account: `0x${string}`, chainId: number): Promise<bigint | null> {
  if (chainId !== LIGHTER_ROUTE_V1.chainId) return 0n;
  try {
    const v = await client.readContract({
      address: LIGHTER_ROUTE_V1.proxy,
      abi: LIGHTER_READ_ABI,
      functionName: "addressToAccountIndex",
      args: [account],
    } as never);
    return asUint(v, UINT48_MAX);
  } catch {
    return null;
  }
}

/**
 * getPendingBalance(self, 3) AT BLOCK N — the block the cash was read at, so
 * the pending balance and the cash are one moment of the chain (rule 12b).
 * Micro-USDG (tick 1). Null is unread: a node that has not reached N, or one
 * that would not answer — never 0.
 */
export async function readLighterPendingAt(
  client: LighterViewClient,
  account: `0x${string}`,
  chainId: number,
  blockNumber: bigint,
): Promise<bigint | null> {
  if (chainId !== LIGHTER_ROUTE_V1.chainId) return 0n;
  try {
    const v = await client.readContract({
      address: LIGHTER_ROUTE_V1.proxy,
      abi: LIGHTER_READ_ABI,
      functionName: "getPendingBalance",
      args: [account, LIGHTER_ROUTE_V1.assetIndex],
      blockNumber,
    } as never);
    const base = asUint(v, UINT128_MAX);
    return base === null ? null : base * BigInt(LIGHTER_ROUTE_V1.usdgTickSize);
  } catch {
    return null;
  }
}

// ── the resolver's and the sweep's perp answers ─────────────────────────────

export type PerpLegResolution =
  /** Leave the row `submitted`: still counted, still holding inference, asked again next pass. */
  | { settle: false; why: string }
  /**
   * Settle it: `transfer` is the margin row to write in the same db.tx (a
   * deposit's `landed` or `failed`; null for a claim or a key), and
   * `cashExplained` what the settlement explains of the account's cash
   * (perpLegCashExplained; null = the receipt's movement was unreadable).
   */
  | { settle: true; transfer: PerpLegTransfer | null; cashExplained: bigint | null };

/**
 * THE STRANDED RESOLVER'S PERP BRANCH, pure: what to do with a `submitted`
 * perp-leg row the chain has now answered for (inflight-reconcile.ts
 * resolveSubmittedOps). The row already names its leg; the op's OWN logs must
 * prove it — the proxy's event for exactly that leg — or the row stays
 * `submitted` (rule 9: never guessed). A revert moved nothing: its deposit's
 * margin row goes `failed` (journaling nothing), found by our UserOp with the
 * amount it was written with.
 */
export function perpLegResolution(a: {
  kind: PerpLegKind;
  success: boolean;
  /** ResolvedOp.opLogs — this op's own logs, null when unreadable or not cut from the bundle. */
  opLogs: readonly ReceiptLogLike[] | null;
  receiptUsdgDelta6: bigint | null;
  account: string;
  chainId: number;
  userOpHash: string;
  txHash: string;
  /** A deposit's `submitted` margin row's amount (found by this UserOp), for a revert; null when there is none. */
  submittedTransferMicro: bigint | null;
}): PerpLegResolution {
  if (!a.success) {
    const failed = a.submittedTransferMicro === null ? null : perpLegFailedTransfer(a.kind, a.submittedTransferMicro, a.userOpHash);
    return { settle: true, transfer: failed, cashExplained: 0n };
  }
  if (a.opLogs === null) return { settle: false, why: "its own logs could not be read" };
  const reading = perpLegOfReceipt(a.opLogs, a.account, a.chainId);
  if (reading.kind !== "leg") return { settle: false, why: reading.kind === "none" ? "its receipt shows no Lighter event" : reading.why };
  if (reading.leg.kind !== a.kind) return { settle: false, why: `its receipt shows a ${reading.leg.kind}, not a ${a.kind}` };
  return {
    settle: true,
    transfer: perpLegLandedTransfer(reading.leg, { userOpHash: a.userOpHash, txHash: a.txHash, chainId: a.chainId }),
    cashExplained: perpLegCashExplained(a.receiptUsdgDelta6, reading),
  };
}

/**
 * THE ORPHAN SWEEP'S PERP ANSWER, pure: a landed op of ours the ledger has no
 * row for, whose own logs prove one of the three legs — its trades kind, the
 * USDG it moved (micro; 0 for a key) and, for a deposit, its `landed` margin
 * row. Null for anything the logs do not prove, which the sweep books under
 * its safe default instead.
 */
export function perpLegOrphan(
  o: { opLogs: readonly ReceiptLogLike[] | null; userOpHash: string; txHash: string },
  account: string,
  chainId: number,
): { kind: PerpLegKind; amountMicro: bigint; transfer: PerpLegTransfer | null } | null {
  if (o.opLogs === null) return null;
  const reading = perpLegOfReceipt(o.opLogs, account, chainId);
  if (reading.kind !== "leg") return null;
  const leg = reading.leg;
  return {
    kind: leg.kind,
    amountMicro: leg.kind === "perp-key" ? 0n : leg.amountMicro,
    transfer: perpLegLandedTransfer(leg, { userOpHash: o.userOpHash, txHash: o.txHash, chainId }),
  };
}
