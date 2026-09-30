/**
 * THE PERP LANE — where a perp intent meets the ledger, the policy and an
 * executor, and where the protective loop, the perps route, the on-chain
 * onboarding legs and the stand-down are driven from (docs/perps.md rules 1,
 * 5, 6, 7, 8, 8a, 9, 10, 11, 12, 13, 14, 16 and "The perps route").
 *
 * index.ts is a 14,000-line main() with no seams; everything here is the perp
 * half of it, built from injected edges so a test can drive the REAL lane —
 * the real store, the real feed file reader, the real checkPolicy, the real
 * live executor and reconciler over a fake venue — and index.ts keeps only
 * thin, commented call sites.
 *
 * TWO BOOKS, ONE RAIL (rule 14). The book is the account's: paper while
 * execMode says paper, the live Lighter account while it says live
 * (perpsModeOf). A live account never runs a practice book beside its real
 * one — a paper book left from paper is frozen there, never traded, never
 * counted — and a paper account never trades the live venue.
 *
 * EXCEPT THE WAY OUT (rule 8a). Whenever the live venue shows exposure — or,
 * unread, the ledger does — the EXITS-ONLY LANE runs with the live key
 * whatever execMode, the switches, pause, the grant or its expiry say:
 * reconcile, protect.ts, owner closes, the stand-down, withdrawals and claims.
 * It never opens, deposits, raises leverage or adds margin. So the live key is
 * held HERE, in a handle keyed on (agent, venue account, sealed key), not in
 * index.ts's `active`: a kill, an expiry or a re-sign clears `active`, and the
 * handle outlives it (`retained`) until the venue reads flat.
 *
 * LIVE IS READY ONLY WHEN EVERY LINK IS PROVEN (rule 5, the onboarding plan):
 * a grant carrying the perp block; the private key loaded from the keystore;
 * the signer past its known-answer test; the key registered at index 16
 * equal to the sealed one AND a token our private key minted accepted
 * (verifyKeyUsable); the account index read on chain; the local ledger
 * continuous with the venue (reconcile.ts). Until then opens refuse
 * `perp-venue-unready` with the blocker that names the missing link, and the
 * onboarding plan (onboard.ts) drives the on-chain legs through index.ts's
 * UserOp rail: a deposit ONLY to fund an open the route proposed, the key
 * registration only as planOnboarding allows (a foreign key is an incident,
 * never registered over), a claim when one is due. Leverage is its own step,
 * while the market is flat, never in the tick of the open it serves.
 *
 * ONE READ, EVERY CONSUMER. A read derives, from one moment — the paper
 * ledger and the feed, or the live venue account the reconciler read and the
 * ledger beside it — the PerpsView (Snapshot.perps), the policy state
 * (AgentState.perp), the equity term (index.ts `perpBook`, through
 * noteLivePerpTerm on live) and the report (`agents.perps`): view.ts's four
 * builders, never a second composition (view.ts header).
 *
 * THE LANE LOCK (protect.ts createPerpLaneLock) IS THE PAPER BOOK'S LOCK AND
 * THE LIVE SEND LOCK. The paper engine books a perp action as a DELTA on
 * paper_book cash; every paper_book read-modify-write in index.ts runs
 * through `serial`, and the tick reads paper cash and the perp term in ONE
 * hold (`readWithBook`). Live sends (sign → persist → send, executor-live.ts)
 * run under it too, so the tick's lane and the protective loop never sign in
 * two orders. THE VENUE READS DO NOT: a reconcile pass is a dozen bounded
 * requests, and a protective close must never wait behind one — reads run
 * outside the lock (one at a time, their own mutex) and the lock is taken
 * only to build the read from what they returned.
 *
 * NEVER REACHED FROM THE EVM INTENT CHAIN'S INSIDE-OUT. processIntentLocked
 * (under intentChain) takes this lock; nothing holding this lock ever waits on
 * intentChain — the protective loop's closes run `executeLocked` directly,
 * and the on-chain legs the onboarding plan wants are produced by the ROUTE,
 * outside the lock, through the same hooks as any other intent.
 */

import { isHostedMode } from "../../../packages/core/src/hosted";
import { hostedPerpsLiveReady } from "./hosted-readiness";
import {
  GRANT_PERP_LIGHTER,
  LIGHTER_ROUTE_V1,
  PERP_LEG,
  custodySentence,
  isolatedMarginMicro,
  leverageFromImfBp,
  notionalMicro,
  perpCoi,
  perpMarketById,
  perpMarketByKey,
  perpsBlockerText,
  type PerpBlocker,
  type PerpExposure,
  type PerpGrant,
  type PerpKey,
  type PerpsReport,
} from "../../../packages/core/src/perps";
import { perpsModeOf, type ExecMode, type PerpsMode, type PerpsModeInputs } from "../exec-mode";
import { perpAccountUsdg, type PerpBookPart, type PerpBookTerm } from "../equity";
import { countsAsEntry } from "../energy";
import { tradeConsumesSnapshot } from "../brain-live";
import type { LedgerFacts } from "../order-receipt";
import {
  checkPolicy as realCheckPolicy,
  isExitIntent,
  type AgentLimits,
  type AgentState,
  type PerpExitIntent,
  type PerpKeyIntent,
  type PerpMarginIntent,
  type PerpOrderIntent,
  type PerpPolicyState,
  type TradeIntent,
  type Verdict,
} from "../policy";
import { perpsCeilingFor, type ResolvedConfig } from "../settings";
import type { PerpAccountRow, PerpOrderRow, PerpPositionInput, PerpPositionRow, PerpTransferRow } from "../store";
import { renderWhy, type Why } from "../strategies/reasons";
import { ownerRejectRuleLabel } from "../thesis-policy";
import type { LighterApi } from "./api";
import { buildExitDraft } from "./drafts";
import {
  createPaperPerpExecutor,
  PerpRefused,
  type PaperPerpStore,
  type PerpExecutor,
  type PerpPlaceResult,
  type PerpReview,
  type PerpTickEvent,
  type PerpTickUnread,
} from "./executor";
import type { LivePerpExecutor } from "./executor-live";
import type { LighterFeedRead } from "./feed-reader";
import { persistIncident, type Incident } from "./incident";
import { openLiveHandle, type LiveHandle, type LiveHandleStore, type LiveSignerLike } from "./live-handle";
import type { LivePerpTerm } from "./live-term";
import type { PerpAccountRead, PerpDecimals, VenueOrder } from "./markets";
import { apiKeySlotOf, onboardingBlocker, planOnboarding, type ApiKeySlot, type OnboardingStep } from "./onboard";
import type { InTransit } from "./payouts";
import { loadPerpPrivateKey, type PerpKeyPair } from "./keystore";
import {
  PROTECT_THRESHOLDS,
  createPerpLaneLock,
  emptyProtectMemory,
  evaluateProtection,
  protectCadenceMs,
  startProtectLoop,
  type PerpLaneLock,
  type ProtectAction,
  type ProtectLoop,
  type ProtectMemory,
  type ProtectPassContext,
} from "./protect";
import type { ReconcileResult } from "./reconcile";
import { runPerpRoute, type PerpRouteIntent } from "./route";
import { runStanddown, standdownExposure, standdownStepLine, type StanddownReason, type StanddownResult } from "./standdown";
import { readPendingStanddownRequests, writeStanddownProgress, writeStanddownResult } from "./standdown-files";
import {
  buildPerpBookTerm,
  buildPerpPolicyState,
  buildPerpsReport,
  buildPerpsView,
  perpsUsdgToMicro,
  railBlockerOf,
  renderScaled,
  type PerpsViewBuilt,
  type PerpsViewInput,
  type PerpsViewLedger,
} from "./view";

// ── small pure pieces ───────────────────────────────────────────────────────

/** The candle the entry was taken on: the 4 h bar that closed before `atSec` (perp-trend's `lastT`). */
const H4_MS = 14_400_000;
export function entryCandleOf(atSec: number): number {
  return Math.floor((atSec * 1000) / H4_MS) * H4_MS - H4_MS;
}

/**
 * The live cadences, each a decision:
 *   reconcileEveryMs   a protective pass runs a full reconcile when the last
 *                      one is older than this (the tick runs one every tick) —
 *                      so the exits-only lane on a paused, killed or expired
 *                      agent still books fills, funding and transfers.
 *   keyRecheckMs       the rule-5 self-check is repeated this often on a
 *                      verified key (a key rotated under us is caught by the
 *                      reconcile's incident check sooner).
 *   handleRetryMs      a handle that could not open is tried again after this.
 *   lightMaxAgeMs      an intent's read older than this is re-taken first.
 *   leverageWaitMs     a leverage change we sent is not sent again for this
 *                      long: the next account read shows it, or the executor's
 *                      own guard refuses while its row is unresolved.
 *   incidentRepeatMs   while the incident flag stands and anything is left at
 *                      the venue, the stand-down runs again this often
 *                      (rule 16: "withdrawals repeated as margin frees").
 *   flatWithdrawMs     free collateral goes home after this long flat on the
 *                      live rail ("The perps route").
 *   keyLandedWaitMs    a key registration that landed is awaited this long
 *                      before the venue is asked to show it again from scratch.
 */
export const LIVE_LANE_TIMING = Object.freeze({
  reconcileEveryMs: 60_000,
  keyRecheckMs: 10 * 60_000,
  handleRetryMs: 60_000,
  lightMaxAgeMs: 15_000,
  leverageWaitMs: 60_000,
  incidentRepeatMs: 10 * 60_000,
  flatWithdrawMs: 24 * 3_600_000,
  keyLandedWaitMs: 10 * 60_000,
  publicDecimalsMs: 30 * 60_000,
});

/** The rules an entry is refused under while the venue is being made ready — the route keeps its bar for them. */
const WAITING_RULES: ReadonlySet<string> = new Set(["perp-venue-unready", "perp-leverage-unset", "perp-leverage-busy"]);

// ── the edges ───────────────────────────────────────────────────────────────

/** The resolved settings the lane reads (worker/src/settings.ts ResolvedConfig). */
export type PerpLaneConfig = Pick<
  ResolvedConfig,
  | "perpsEnabled"
  | "liveTradingEnabled"
  | "perpsLiveEnabled"
  | "perpsDriver"
  | "perpsMarkets"
  | "perpsMaxLeverage"
  | "perpsPerTradeUsdg"
  | "perpsMaxOpenNotionalUsdg"
  | "perpsMaxCollateralUsdg"
  | "perpsMaxOpensPerDay"
  | "perpsStopLossPct"
  | "perpsStopSlipBps"
  | "perpsTakeProfitPct"
  | "perpsLiqBufferPct"
  | "perpsMaxSlippageBps"
  | "perpsOperatorCeiling"
  | "perpsLiveTenants"
  | "perpsEntriesHalted"
  | "paperStartUsdg"
>;

/** The store functions the lane reads and books through — store.ts's own; a test passes the module. */
export interface PerpLaneStore extends PaperPerpStore {
  listSubmittedPerpOrders(agentId: string, mode: "paper"): Promise<readonly Pick<PerpOrderRow, "marketId" | "effect" | "reduceOnly" | "worstNotionalMicro">[]>;
  getPerpAccount(agentId: string, mode: "paper"): Promise<Pick<PerpAccountRow, "paperCollateralMicro" | "incident" | "entriesHalted"> | null>;
  perpLaneLedgerFacts(
    agentId: string,
    mode: "paper",
    sinceSec: number,
  ): Promise<{
    opensToday: number;
    lastExits: Map<number, { atSec: number; cause: "strategy" | "stop" | "take" | "risk" | "forced" | "unknown" }>;
    lastOpenAt: Map<number, number>;
  }>;
  getAgentEpoch(agentId: string): Promise<number>;
  setAgentPerps(agentId: string, json: string | null): Promise<void>;
  /** store.ts returnFoldedPaperCollateral — a restore's folded paper collateral back to paper cash once flat. */
  returnFoldedPaperCollateral?(agentId: string): Promise<bigint>;
  /** store.ts patchPerpAccount — the paper book's /flatten halt. */
  patchPerpAccount?(agentId: string, mode: "paper", patch: { entriesHalted: boolean }): Promise<void>;
}

/** The armed agent as index.ts's `active` knows it. */
export interface PerpLaneAgent {
  agentId: string;
  smartAccount: string;
  limits: AgentLimits;
}

export interface PerpLaneBudget {
  /** One op and `spendMicro` of the day's spend, held in-flight until the booking is counted (index.ts inFlightOps). */
  reserve(spendMicro: bigint): void;
  /** Drop exactly that reservation. */
  release(spendMicro: bigint): void;
  /** Re-read the settled halves (index.ts refreshBudget) — the booked row is now counted there. */
  refresh(): Promise<void>;
  /**
   * recordTrade's FAIL-CLOSED conversion: the booking happened but the settled
   * halves could not be re-read, so book this reservation's op and spend
   * straight into them before it is released — the cap stays counted for the
   * rest of the arm rather than loosening. Absent: the reservation is held
   * (never released) instead, the same direction.
   */
  keep?(spendMicro: bigint): void;
}

export type DecideFn = (
  intent: TradeIntent,
  source: string,
  reason?: string,
  known?: { whyCode?: string },
) => Promise<{ ok: true } | { ok: false; why: string }>;

/** The ledger functions the live side reads and writes through — store.ts's own. */
export interface PerpLiveStore extends LiveHandleStore {
  getPerpPositions(agentId: string, mode: "live", opts?: { includeFlat?: boolean }): Promise<PerpPositionRow[]>;
  /** store.ts upsertPerpPosition — the stop an open of ours carried, recorded on the venue's position (recordOpenStops). */
  upsertPerpPosition(p: PerpPositionInput): Promise<void>;
  getPerpAccount(agentId: string, mode: "live"): Promise<PerpAccountRow | null>;
  listOpenPerpTransfers(agentId: string, mode: "live"): Promise<PerpTransferRow[]>;
  perpLaneLedgerFacts(
    agentId: string,
    mode: "live",
    sinceSec: number,
  ): Promise<{
    opensToday: number;
    lastExits: Map<number, { atSec: number; cause: "strategy" | "stop" | "take" | "risk" | "forced" | "unknown" }>;
    lastOpenAt: Map<number, number>;
  }>;
}

/**
 * THE LIVE VENUE'S EDGES — index.ts's own reads and clients. Absent, the lane
 * has no way to read or sign at Lighter: a live account's perps are then
 * refused `perp-venue-unready` and nothing live is ever reached.
 */
export interface PerpLiveDeps {
  /** MERRYMEN_HOME — the keystore and the stand-down request/result files. */
  home: () => string;
  /** The process's signer (signer.ts loadSigner). */
  loadSigner: () => Promise<LiveSignerLike>;
  /** The ADDRESS-KEYED client for this L1 address (api.ts budgetKey = the smart account). */
  api: (smartAccount: string) => LighterApi;
  /** The PUBLIC client — the reads that must work before our key is registered. */
  publicApi: () => Pick<LighterApi, "apikeys" | "account" | "orderBookDetails" | "withdrawalDelay" | "accountsByL1Address">;
  store: PerpLiveStore;
  /** addressToAccountIndex(self) as index.ts last read it on chain: 0n none, null unread. */
  accountIndex: () => bigint | null;
  /** USDG in the smart account (micro) at the tick's balance read; null unread. */
  cashMicro: () => bigint | null;
  /** This tick's payout step (index.ts perpTransit): T_in/T_out and the pending balance; null = not established. */
  transit: () => { transit: InTransit | null; pendingBalanceMicro: bigint | null } | null;
  /**
   * perps/live-term.ts livePerpTerm: the live equity term from ONE account
   * read and a transit — this tick's (index.ts perpTransit), less any landed
   * deposit this read found the venue had already credited (the transit was
   * computed before that was known).
   */
  term: (account: PerpAccountRead | null, transit: InTransit | null) => LivePerpTerm;
  /** A perp-key UserOp of ours is `submitted` (the trades ledger); null unread. */
  keyLegInFlight: () => Promise<boolean | null>;
  /** Hosted lease/session checkpoint fence at the final venue-send boundary. */
  beforeSend?: (agentId: string) => Promise<void>;
  /** Test seam: the keystore. */
  loadKey?: (args: { home: string; apiPublicKey: string }) => PerpKeyPair;
  /** Test seam: the executor's /tx poll. */
  executorTuning?: { sleep?: (ms: number) => Promise<void>; txPollDelaysMs?: readonly number[] };
  /** Test seam: the stand-down's waits (standdown.ts `sleep` / `limits` — tightening only). */
  standdownTuning?: { sleep?: (ms: number) => Promise<void>; limits?: { pollMs?: number; retryPauseMs?: number; readRetryMs?: number } };
}

export interface PerpLaneDeps {
  store: PerpLaneStore;
  /** index.ts `active`, or null when nothing is armed. */
  armed: () => PerpLaneAgent | null;
  config: () => PerpLaneConfig;
  /** index.ts execMode() — asked fresh at every decision, never cached across one. */
  execMode: () => ExecMode;
  /** The fleet feed as of `nowMs` — readLighterFeed(lighterFeedPath(home), nowMs); null = unread. Never the network. */
  readFeed: (nowMs: number) => LighterFeedRead | null;
  /** ms */
  now: () => number;
  /**
   * The account-wide half of AgentState — spend, ops, the peak, equity — as
   * index.ts's own processIntentLocked composes it. The lane adds `perp` and
   * the venue flags from its own fresh read.
   */
  agentState: (equity: { equityUsdg: bigint; equityKnown: boolean }) => Promise<Omit<AgentState, "perp">>;
  /**
   * The day's spend and ops AS THEY STAND NOW, read under the lane lock
   * (index.ts spentToday() / opsTodayCount()). A caller's `base` was composed
   * BEFORE the lock was taken; a protective close booked in between moved
   * both, and judging the next intent against the older figures is judging
   * it against a cap with that op missing (the review's R3-OPS-CAP-STALE-BASE).
   */
  counters?: () => { spentTodayUsdg: bigint; opsToday: number };
  budget: PerpLaneBudget;
  /** index.ts addEvent, bound to the armed agent. Owner-facing; never a post. */
  events: (level: "ok" | "warn" | "err", message: string) => Promise<unknown>;
  /** index.ts ensureDecision — for the protective loop's and the stand-down's closes (the route passes its own). */
  decide: DecideFn;
  /** Called whenever a read finds the lane ON — index.ts starts the in-process feed from it. */
  onActive?: () => void;
  /** The live venue's edges; absent = no live perps in this process. */
  live?: PerpLiveDeps;
  checkPolicy?: typeof realCheckPolicy;
  /** Paper executor factory; tests may wrap it to watch it. */
  paperExecutor?: typeof createPaperPerpExecutor;
  lock?: PerpLaneLock;
  log?: (line: string) => void;
}

// ── what one read produces ──────────────────────────────────────────────────

export interface PerpLaneRead {
  /**
   * The lane is ON for this agent right now: its perps rail is on (paper, or
   * live with everything but the venue's readiness in place), or its book
   * holds anything (rule 8a: exits, stops and the equity term follow what is
   * HELD, not the switch).
   */
  active: boolean;
  bookMode: "paper" | "live";
  rail: PerpsMode;
  /** Snapshot.perps: undefined when the lane is off, null when unread, else the view. */
  view: PerpsViewBuilt | null | undefined;
  /** index.ts `perpBook`: undefined = known zero (no perps), "unread", or C + ΣM + ΣU + T. */
  book: PerpBookTerm;
  /** C + ΣM + ΣU + T at the last read that succeeded; null before any. */
  lastKnownMicro: bigint | null;
  /** AgentState.perp; undefined when the lane has nothing to judge (policy then refuses opens perp-not-enabled). */
  policy: PerpPolicyState | undefined;
  /**
   * Live: the same state with the venue's own readiness ASSUMED — what an
   * on-chain onboarding leg (a deposit, a key registration) is judged
   * against, since those legs are how the venue becomes ready. Every other
   * brake (incident, halt, expiry, caps) is the same read's.
   */
  legPolicy?: PerpPolicyState;
  /** Live: the equity term from this read's one account read — index.ts applies it with noteLivePerpTerm. */
  liveTerm?: LivePerpTerm;
  /** Live: the venue (or, unread, the ledger) shows exposure — rule 8a's exits-only lane runs while it does. */
  exposure?: boolean;
  feedFresh: boolean;
  /** The book holds a position, an unresolved order or collateral. */
  held: boolean;
  report: PerpsReport;
  /** ms */
  readAtMs: number;
}

/** A perp intent's outcome as the caller's ledger facts read it (order-receipt.ts): paper, submitted, rejected or dropped — never landed. */
export type PerpOutcome = LedgerFacts;

/** What the tick measured, for the route (perp-trend's ctx). */
export interface PerpRouteTick {
  equityUsdg: bigint;
  equityKnown: boolean;
  /** The drawdown breaker is NOT tripped (breakerIdle(snap) === undefined). */
  breakerIdle: boolean;
  breakerLimitBps?: number | null;
  energyEntriesLeft: boolean;
  opsHeadroom: boolean;
  /** micro-USDG; null = not read. */
  spendHeadroomMicro: bigint | null;
  /** The owner's strategy — `strategist` resolves to `manual` unless it is llm-strategist with a real model. */
  strategistLive: boolean;
}

/** index.ts's own producer plumbing, in the class route's shape. */
export interface PerpRouteHooks<C extends { ok: boolean }> {
  claimEntry: () => Promise<C>;
  refundEntry: (claim: C | null) => Promise<void>;
  withholdEntry: () => Promise<void>;
  ensureDecision: DecideFn;
  /** processIntentReporting — the facts ITS OWN run produced. */
  processIntentReporting: (intent: TradeIntent) => Promise<{ status?: string; rejectRule?: string } | null>;
  processIntent: (intent: TradeIntent) => Promise<void>;
}

// ── small helpers ───────────────────────────────────────────────────────────

const ZERO_BOOK: PerpBookPart = Object.freeze({
  collateralMicro: 0n,
  isolatedMarginMicro: 0n,
  unrealizedMicro: 0n,
  unrealizedGainMicro: 0n,
  inTransitMicro: 0n,
  snapshotTime: null,
});

/** micro-USDG as the owner reads it: "+12.34" / "−0.50" (rounded toward zero, 2 dp). */
export function usdgText(micro: bigint, signed = false): string {
  const neg = micro < 0n;
  const a = neg ? -micro : micro;
  const cents = a / 10_000n;
  const s = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  return neg ? `−${s}` : signed ? `+${s}` : s;
}

function levText(imfBp: number): string {
  try {
    return `${leverageFromImfBp(imfBp)}x`;
  } catch {
    return "?x";
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A perp intent's effect and side, as a label: "open long BTC-PERP". */
function labelOf(intent: PerpOrderIntent | PerpMarginIntent): string {
  return intent.kind === "perp-order" ? `${intent.effect} ${intent.side} ${intent.market}` : `margin ${intent.direction}`;
}

/**
 * A report that says, truthfully, that nothing is held — perps off, or a live
 * account with no venue account — and names the rail's reason (view.ts
 * railBlockerOf: not granted, live perps off, the account not live…).
 */
function flatReport(rail: PerpsMode, protectAtMs: number | null, live?: { railBlocker?: PerpBlocker | null }): PerpsReport {
  return {
    v: 1,
    mode: rail.mode,
    // A PAPER book's refusal (operator off, the account's own state) has no
    // owner blocker here: "the account is not live" would be a live account's
    // sentence. A live one names its reason.
    blocker: live !== undefined ? railBlockerOf(rail, live.railBlocker) : rail.mode === "off" ? "perps-off" : null,
    venueReadAt: null,
    protectAt: protectAtMs,
    accountIndex: null,
    positions: [],
    openNotionalMicro: "0",
    collateralMicro: "0",
    inTransitMicro: "0",
    minLiqDistanceBps: null,
    stopsMissing: 0,
    incident: false,
  };
}

/** The grant's perp block as core's PerpGrant, from the limits the arm built (policy.ts AgentLimits.perp). */
function perpGrantOf(limits: AgentLimits): PerpGrant | null {
  const p = limits.perp;
  if (p === undefined || p.apiKeyIndex !== LIGHTER_ROUTE_V1.apiKeyIndex) return null;
  return { route: GRANT_PERP_LIGHTER, apiKeyIndex: p.apiKeyIndex, apiPublicKey: p.apiPublicKey };
}

/** An account the venue does not have yet (addressToAccountIndex 0): every figure a known zero. */
function noVenueAccount(l1: string, nowMs: number): PerpAccountRead {
  return {
    accountIndex: 0,
    l1Address: l1.toLowerCase() as `0x${string}`,
    collateralMicro: 0n,
    positions: [],
    isolatedMarginMicro: 0n,
    unrealizedMicro: 0n,
    unrealizedGainMicro: 0n,
    venueValueMicro: 0n,
    totalAssetValueMicro: 0n,
    transactionTimeUs: nowMs * 1000,
    accountType: 0,
    status: 1,
    totalOrderCount: 0,
    pendingOrderCount: 0,
    poolShareCount: 0,
    spotHoldings: [],
    spotUsdgMicro: 0n,
    pendingUnlockCount: 0,
  };
}

/** Does this venue read show anything at all — rule 8a's "positions, orders, collateral or withdrawals in transit"? */
function venueShowsExposure(acct: PerpAccountRead, transit: InTransit | null): boolean {
  if (acct.collateralMicro !== 0n || acct.isolatedMarginMicro !== 0n) return true;
  if (acct.totalOrderCount > 0 || acct.pendingOrderCount > 0 || acct.poolShareCount > 0 || acct.pendingUnlockCount > 0) return true;
  if (acct.spotHoldings.length > 0) return true;
  if (acct.positions.some((p) => p.baseAmount !== 0n || p.openOrderCount > 0 || p.pendingOrderCount > 0 || p.positionTiedOrderCount > 0)) return true;
  if (transit === null) return true; // unknown money in transit is not none
  return transit.tInMicro !== 0n || transit.tOutMicro !== 0n || transit.gap;
}

const ACTIVE_ORDER: ReadonlySet<string> = new Set(["open", "pending", "in-progress"]);

// ── the live side's memory ──────────────────────────────────────────────────

/** What one venue read (full: a reconcile pass; light: the account and its orders) returned. */
interface VenueSnap {
  depth: "full" | "light";
  atMs: number;
  account: PerpAccountRead | null;
  orders: readonly VenueOrder[] | null;
  decimals: ReadonlyMap<number, PerpDecimals> | null;
  /** The last full pass's result (kept across light reads: its gaps and continuity still stand). */
  rec: ReconcileResult | null;
}

interface LiveSide {
  /** agent|account|sealed key — a new key or account is a new side. */
  key: string;
  agent: PerpLaneAgent;
  accountIndex: number;
  sealed: `0x${string}`;
  handle: LiveHandle | null;
  failure: { blocker: PerpBlocker; why: string; retryable: boolean; atMs: number } | null;
  /** verifyKeyUsable passed for this handle, and when it was last checked. */
  keyOk: boolean;
  keyCheckedAtMs: number;
  /** The last key-slot read (PUBLIC client), full reads only. */
  slot: ApiKeySlot;
  snap: VenueSnap | null;
  /** The last full reconcile's continuity (reconcile.ts): opens wait while `pending`. */
  continuity: "continuous" | "rebuilt" | "pending";
  lastFullAtMs: number;
  /** Last read's exposure (rule 8a); true until a read says otherwise. */
  exposure: boolean;
  /** When this side last STARTED an incident stand-down (ms); 0 = never in this process (incidentDue). */
  incidentStanddownMs: number;
  /** Venue order indexes a replacement stop of ours supersedes, per market — cancelled only once the new one reads resting. */
  supersede: Map<number, { replacementClientOrderIndex: string; orders: Set<string> }>;
  /** Non-reduce-only orders cancelled by the exits-only lane, and when (one ask a minute). */
  cancelledAt: Map<string, number>;
  /** When the venue last read flat (no position, no order), for the 24 h withdrawal. */
  flatSinceMs: number | null;
  /** Leverage changes this side sent, per market (ms): not sent again inside leverageWaitMs. */
  leverageSentAt: Map<number, number>;
  /** Owner lines already said this process (reconcile alerts, forced fills, key states). */
  said: Set<string>;
  /** A key registration of ours that landed, awaited until the venue shows it. */
  keyLegLandedAtMs: number | null;
  /** GET /withdrawalDelay, read by a full venue read while something is pending on the contract; null unread. */
  withdrawalDelaySec: number | null;
  /** The stop (and take) each open of ours carried, until its position shows and they are recorded on it. */
  pendingStops: Map<number, { side: "long" | "short"; stopTrigger: bigint; stopPrice: bigint; takeTrigger: bigint | null; takePrice: bigint | null; atMs: number }>;
  /**
   * Landed deposits this side found ALREADY CREDITED (creditGenesisDeposits)
   * since the transit it was handed was computed — that transit still counts
   * them in T_in, and C now holds them.
   */
  creditedSince: { transit: object | null; micro: bigint };
}

// ── the lane ────────────────────────────────────────────────────────────────

export interface PerpLane {
  readonly lock: PerpLaneLock;
  /** A fresh read — the tick's (a full reconcile pass on a live book, outside the lock; the read under it). */
  refresh(): Promise<PerpLaneRead>;
  /**
   * The tick's paper cash read and the perp read in ONE hold of the lock —
   * so equity = cash + C + ΣM + ΣU is one moment of the paper book.
   */
  readWithBook<T>(read: () => Promise<T>): Promise<{ value: T; read: PerpLaneRead }>;
  /** Run `fn` under the lane lock — every paper_book read-modify-write goes through here. */
  serial<T>(fn: () => Promise<T>, label?: string): Promise<T>;
  /** The last read (the tick's, a pass's, an intent's), or null before any. */
  last(): PerpLaneRead | null;
  /**
   * Snapshot.perps for THIS tick — the view the tick read (readWithBook or
   * refresh): undefined when perps are off for this agent, null when Lighter
   * is unread, else the view. The route decides on this same view.
   */
  snapshotView(): PerpsViewBuilt | null | undefined;
  /** AgentState.perp from the last read. */
  policyState(): PerpPolicyState | undefined;
  /**
   * AgentState.perp for THIS intent: an on-chain onboarding leg (a margin
   * deposit, a key registration) is judged with the venue's readiness
   * assumed (`legPolicy`) — those legs are what make it ready — and every
   * other intent against the rail as it stands.
   */
  policyStateFor(intent: TradeIntent): PerpPolicyState | undefined;
  /**
   * processIntentLocked's perp branch: judge, review, judge again, reserve,
   * place, count, release. `base` is the caller's own AgentState (index.ts
   * passes processIntentLocked's `state`, so a perp open meets the very spend,
   * ops and peak figures a spot buy would; the day's counters are re-read
   * under the lock); absent, deps.agentState composes one. Either way `perp`
   * and the venue flags are this call's FRESH read.
   */
  execute(
    intent: PerpOrderIntent | PerpMarginIntent,
    equity: { equityUsdg: bigint; equityKnown: boolean },
    base?: Omit<AgentState, "perp">,
  ): Promise<PerpOutcome>;
  /** The perps route, after the strategy loop and the class route (docs/perps.md "The perps route"). */
  runRoute<C extends { ok: boolean }>(t: PerpRouteTick, hooks: PerpRouteHooks<C>): Promise<void>;
  /** The strategist's one-shot handoff (makeLlmStrategist `perps.deliver`). */
  deliverStrategist(intents: readonly PerpRouteIntent[]): void;
  /** One protective pass — the loop's `run`, and a test's. */
  protectPass(ctx: ProtectPassContext): Promise<void>;
  /** Start the protective loop (once per process; idempotent). */
  startProtect(): void;
  stopProtect(): Promise<void>;
  readonly protecting: boolean;
  /** A new arm: forget per-arm memory, announce the rail again, and make sure the protective loop runs. */
  armed(): Promise<void>;
  /** Settings changed (perpsKey moved): re-read, re-announce, and make sure the protective loop runs. */
  configChanged(): Promise<void>;
  /** A paper reset: `reset` runs under the lock, then every in-memory perp fact is forgotten. */
  resetPaper<T>(reset: () => Promise<T>): Promise<T>;
  /** Write `agents.perps` from the last read. */
  report(): Promise<void>;
  /** Owner chat must show retained real exposure even while practicing. */
  ownerReport(): Promise<PerpsReport | null>;
  /** Venue market ids the feed should carry: the allowed markets plus anything held. */
  feedMarketIds(): number[];
  /** Venue market ids a book HOLDS (paper and live) — the feed's funding history covers them all. */
  heldMarketIds(): number[];
  /**
   * RULE 13's STAND-DOWN with the key the lane holds: the lane and the
   * protective loop are latched off while it runs, the owner is told what is
   * left in custodySentence's words, and — with a request `nonce` — the
   * self-hosted result (and progress) file is written. One at a time: a
   * second call waits for the running one and shares its result.
   */
  standdown(reason: StanddownReason, opts?: { nonce?: string; notAfterMs?: number }): Promise<StanddownResult | null>;
  /**
   * THE OWNER'S /flatten (Stage 6 surfaces): every position closed reduce-only
   * — the live stand-down with reason `flatten`, or the paper book's own
   * closes — and new entries halted (perp_accounts.entries_halted) until the
   * owner clears it on the dashboard. The sentence is the owner's.
   */
  flatten(opts?: { notAfterMs?: number; book?: "paper" | "live" }): Promise<{ ok: boolean; sentence: string }>;
  /** Owner-requested reduce-only close; live holdings take precedence over practice holdings. */
  close(market: PerpKey, opts?: { notAfterMs?: number; book?: "paper" | "live" }): Promise<{ ok: boolean; sentence: string }>;
  /** Dashboard-only control, bound to the book the owner viewed. Never clears an incident. */
  resumeEntries(mode: "paper" | "live", opts?: { notAfterMs?: number }): Promise<{ ok: boolean; sentence: string }>;
  /** The self-hosted request files (standdown-files.ts), from index.ts's 2 s command-wake watcher. */
  pollStanddownRequests(): Promise<void>;
  /**
   * index.ts cleared `active` for good — a kill or the grant's expiry. The
   * live key stays held (exits-only) and the stand-down runs with it: for a
   * kill after the request file has had its chance to name it, for an expiry
   * at once.
   */
  grantEnded(reason: "kill" | "expiry"): Promise<void>;
  readonly standingDown: boolean;
}

export function createPerpLane(deps: PerpLaneDeps): PerpLane {
  const lock = deps.lock ?? createPerpLaneLock({ onOverrun: (i) => log(`lane lock held past ${i.holdMs} ms by ${i.label ?? "?"}`) });
  const check = deps.checkPolicy ?? realCheckPolicy;
  const makePaper = deps.paperExecutor ?? createPaperPerpExecutor;
  const log = (line: string) => (deps.log ?? ((l: string) => console.log(l)))(`[perps] ${line}`);

  // ── per-agent memory (forgotten on a new agent, an arm, a paper reset) ──
  let agentKey: string | null = null;
  // A failed halt write must still prevent entries in this process. Kept
  // across re-arms, scoped to the account/book, and cleared only by resume.
  const ownerEntryHalts = new Set<string>();
  let lastRead: PerpLaneRead | null = null;
  /** The view the TICK read (Snapshot.perps) — what the route decides on. */
  let tickRead: PerpLaneRead | null = null;
  // A practice zero never proves the real venue was empty. Each book keeps
  // its own last successful value through unread reads and rail changes.
  let lastKnownPaperMicro: bigint | null = null;
  let lastKnownLiveMicro: bigint | null = null;
  let protectMemory: ProtectMemory = emptyProtectMemory();
  let liveProtectMemory: ProtectMemory = emptyProtectMemory();
  let protectAtMs: number | null = null;
  /** Admitted, stamped entries the route attempted (perp-trend: one entry per signal bar). */
  let entryCandles = new Map<PerpKey, number>();
  let strategistIntents: PerpRouteIntent[] = [];
  let lastRefusalKey: string | null = null;
  let lastIdleKey: string | null = null;
  let railKey: string | null = null;
  let tickFailureKey: string | null = null;
  let reportJson: string | null = null;
  let loop: ProtectLoop | null = null;
  let lastHeldMarkets: number[] = [];
  /** Whether the last read found the lane on — so the moment it turns on is noticed (noteActive). */
  let lastActive = false;
  /** What the paper venue's clock could not run last pass, keyed per episode (noteTickUnread). */
  let tickUnreadKeys = new Set<string>();
  /** market_id → the first owed funding hour the feed does not carry: that position's funding is unread. */
  let fundingGaps = new Map<number, number>();

  // ── what outlives an arm ──
  /**
   * The last armed agent, kept when `active` is cleared (a kill, an expiry):
   * the protective loop keeps the paper venue's clock running over a
   * practice book it still holds (the review's S3-06), and the live exits
   * lane keeps the key until the venue reads flat (rule 8a).
   */
  let retained: PerpLaneAgent | null = null;
  /** Which book `retained` was on when last armed — a paper book is clocked after a kill only if it was the account's. */
  let retainedBook: "paper" | "live" = "paper";
  let live: LiveSide | null = null;
  /** The last live read (the exits-only lane's, on an account whose book is paper). */
  let liveRead: PerpLaneRead | null = null;
  /** The on-chain leg the onboarding plan wants next, for the route to send (one a tick). */
  let pendingLeg: { intent: PerpMarginIntent | PerpKeyIntent; why: string } | null = null;
  /** A stand-down the read found due (an incident), started once the lock is released. */
  let wantStanddown: StanddownReason | null = null;
  let standing: Promise<StanddownResult | null> | null = null;
  /** Latched while a stand-down runs: the lane refuses, the loop skips (the caller's latch, standdown.ts). */
  let latched = false;
  const handledNonces = new Set<string>();
  let polling = false;
  let venueReads: Promise<unknown> = Promise.resolve();
  let publicDecimals: { map: ReadonlyMap<number, PerpDecimals>; atMs: number } | null = null;
  /** The last stand-down this process ran, and when it ended — a kill's request file and the kill itself are one stand-down. */
  let lastStanddown: { reason: StanddownReason; atMs: number } | null = null;
  /** The retained (not armed) paper book still holds something: its clock keeps running. */
  let retainedPaperHeld = false;
  /** Whether the sealed key's private half loads from the keystore, per key, re-asked each minute. */
  const keyLoads = new Map<string, { ok: boolean; atMs: number }>();

  /**
   * CAN THIS MACHINE SIGN WITH THE SEALED KEY AT ALL? Asked of the keystore
   * (file present, 0600, paired with the sealed public key) BEFORE a single
   * micro-USDG is posted or a key registered for it: margin at a venue this
   * worker holds no key for is money nothing here can close a position with
   * or bring home (only the owner's recover could). Cached a minute; the
   * owner putting the file back (or re-signing) is picked up by the next ask.
   */
  function keyLoadable(sealed: `0x${string}`): boolean {
    const L = deps.live;
    if (L === undefined) return false;
    const nowMs = deps.now();
    const hit = keyLoads.get(sealed);
    if (hit !== undefined && nowMs - hit.atMs < LIVE_LANE_TIMING.handleRetryMs) return hit.ok;
    let ok: boolean;
    try {
      (L.loadKey ?? loadPerpPrivateKey)({ home: L.home(), apiPublicKey: sealed });
      ok = true;
    } catch {
      ok = false;
    }
    if (!ok && (hit === undefined || hit.ok)) {
      void say(
        "warn",
        "perps: the Lighter trading key your grant sealed is not on this machine (or is not readable), so nothing is posted to or " +
          "signed at Lighter — live perps stay off, and any position there keeps only the stop resting at the venue. Re-sign on the " +
          "dashboard with perpetuals included to make a new key.",
      );
    }
    keyLoads.set(sealed, { ok, atMs: nowMs });
    return ok;
  }

  function forget(): void {
    lastRead = null;
    tickRead = null;
    lastKnownPaperMicro = null;
    lastKnownLiveMicro = null;
    protectMemory = emptyProtectMemory();
    liveProtectMemory = emptyProtectMemory();
    entryCandles = new Map();
    strategistIntents = [];
    lastRefusalKey = null;
    lastIdleKey = null;
    railKey = null;
    tickFailureKey = null;
    lastActive = false;
    tickUnreadKeys = new Set();
    fundingGaps = new Map();
    pendingLeg = null;
    liveRead = null;
  }

  async function say(level: "ok" | "warn" | "err", line: string): Promise<void> {
    try {
      await deps.events(level, line);
    } catch {
      // a notice that fails to write never fails what raised it
    }
  }

  /**
   * THE LANE TURNING ON IS A REASON TO LOOK NOW. The loop idles at a pass a
   * minute while the lane is off; when a read (the tick's, an intent's) finds
   * it on — a practice book that has become the account's book again because
   * execMode moved live → paper, or perps switched on — the next pass is run
   * at once instead of up to a minute later, and the loop's cadence (15 s
   * while anything is held) follows from that pass's own read. It only moves
   * the loop's clock; the pass itself still runs under the lane lock, on the
   * loop's own timer, never inside the read that noticed.
   */
  function noteActive(active: boolean): void {
    if (active && !lastActive) loop?.kick();
    lastActive = active;
  }

  function agentNow(): PerpLaneAgent | null {
    const a = deps.armed();
    if (a === null) return null;
    const key = a.agentId.toLowerCase();
    if (agentKey !== key) {
      // Another account's memory is never this one's: a cooldown, a breach
      // clock or a strategist handoff carried across would act on a book it
      // was never about — and another account's key is never this one's.
      agentKey = key;
      forget();
      reportJson = null;
      if (live !== null && live.agent.agentId.toLowerCase() !== key) {
        log(`live handle for ${live.agent.agentId.slice(0, 10)} let go: another agent is armed`);
        live = null;
      }
    }
    retained = a;
    return a;
  }

  /** The armed agent, or the one retained past a kill or an expiry — for the protective loop, the stand-down and exits only. */
  function laneAgent(): PerpLaneAgent | null {
    return agentNow() ?? retained;
  }

  function modeInputs(a: PerpLaneAgent, cfg: PerpLaneConfig, venueReady: boolean): PerpsModeInputs {
    const ceiling = perpsCeilingFor(cfg, a.smartAccount);
    return {
      perpsEnabled: cfg.perpsEnabled,
      // RAW, never the rail's consented(): the migration stand-down that keeps
      // an unconsented account's spot trading live is not consent to leverage
      // (exec-mode.ts perpsModeOf, amendment 8a(g)).
      liveTradingEnabled: cfg.liveTradingEnabled,
      perpsLiveEnabled: cfg.perpsLiveEnabled,
      ceiling: ceiling === "live" && isHostedMode() && !hostedPerpsLiveReady() ? "paper" : ceiling,
      granted: perpGrantOf(a.limits) !== null,
      venueReady,
      entriesHalted: cfg.perpsEntriesHalted,
    };
  }

  /**
   * The policy state of a lane that holds nothing and reads nothing. Built
   * only so policy answers with the RAIL's own words: `off` has none (absent
   * → perp-not-enabled), a refusal names itself. No market is read (every
   * open refused behind the rail anyway), and the committed-money totals
   * saturate at their caps (view.ts buildPerpPolicyState, unread).
   */
  function railOnlyPolicy(a: PerpLaneAgent, cfg: PerpLaneConfig, rail: PerpsMode, nowSec: number, mode: "paper" | "live" = "paper"): PerpPolicyState | undefined {
    if (rail.mode === "off") return undefined;
    const input: PerpsViewInput = {
      mode,
      nowSec,
      feed: null,
      settings: cfg,
      grant: { perTradeSealedMicro: a.limits.perTradeUsdg, expiresAtSec: a.limits.expiresAt },
      ledger: emptyLedger(cfg.perpsEntriesHalted),
    };
    try {
      return buildPerpPolicyState(input, null, rail);
    } catch {
      return undefined;
    }
  }

  function emptyLedger(entriesHalted: boolean): PerpsViewLedger {
    return {
      positions: [],
      unresolvedMarkets: new Set(),
      unresolvedOpenMarkets: new Set(),
      closeInFlightMarkets: new Set(),
      pendingOpenNotionalMicro: 0n,
      opensToday: 0,
      lastExit: new Map(),
      lastEntryCandleT: new Map(),
      depositsInTransitMicro: 0n,
      withdrawalsInTransitMicro: 0n,
      incident: false,
      entriesHalted,
    };
  }

  function executorFor(a: PerpLaneAgent, epoch: number): PerpExecutor {
    const cfg = deps.config();
    return makePaper({
      agentId: a.agentId,
      epoch,
      feed: () => deps.readFeed(deps.now()),
      store: deps.store,
      now: deps.now,
      paperStartUsdg: cfg.paperStartUsdg,
    });
  }

  // ── the one read ────────────────────────────────────────────────────────

  function bookModeOf(verdict: ExecMode): "paper" | "live" {
    return verdict.mode === "paper" ? "paper" : "live";
  }

  /**
   * `exitsOnly` is the protective loop's read (view.ts): a live view is built
   * from the venue account alone when the fleet feed is out, because a feed
   * outage must not blind the loop that watches liquidation.
   */
  async function readLocked(opts: { exitsOnly?: boolean } = {}): Promise<PerpLaneRead> {
    const nowMs = deps.now();
    const a = agentNow();
    const off: PerpsMode = { mode: "off" };
    if (a === null) {
      const r: PerpLaneRead = {
        active: false,
        bookMode: "paper",
        rail: off,
        view: undefined,
        book: undefined,
        lastKnownMicro: null,
        policy: undefined,
        feedFresh: false,
        held: false,
        report: flatReport(off, protectAtMs),
        readAtMs: nowMs,
      };
      lastRead = r;
      return r;
    }
    const cfg = deps.config();
    const verdict = deps.execMode();
    const bookMode = bookModeOf(verdict);
    retainedBook = bookMode;
    if (bookMode === "live") {
      const r = await readLiveLocked(a, cfg, verdict, nowMs, opts.exitsOnly === true);
      lastRead = r;
      await announceRail(r, a);
      return r;
    }
    const rail = perpsModeOf(verdict, modeInputs(a, cfg, false));
    // ── PAPER: the ledger IS the book ────────────────────────────────────
    try {
      return await readPaperLocked(a, cfg, rail, nowMs);
    } catch (e) {
      // AN UNREADABLE PAPER LEDGER IS A GAP, NOT A CRASH (rule 11): the tick
      // must not die over it — spot exits still have to go out — and the
      // book must not be called flat either. So: unread. The equity row, the
      // peaks and every non-exit wait (policy perp-unpriced); a perp exit has
      // no position it can be sized against and waits too, with the resting
      // paper stops, until the ledger reads.
      log(`paper book unreadable: ${errText(e)}`);
      const nowSec = Math.floor(nowMs / 1000);
      const r: PerpLaneRead = {
        active: true,
        bookMode,
        rail,
        view: null,
        book: "unread",
        lastKnownMicro: lastKnownPaperMicro,
        policy: railOnlyPolicy(a, cfg, rail, nowSec),
        feedFresh: false,
        held: true,
        report: { ...flatReport(rail, protectAtMs), blocker: rail.mode === "paper" ? "perps-venue-unreachable" : null, openNotionalMicro: null, collateralMicro: null, inTransitMicro: null },
        readAtMs: nowMs,
      };
      lastRead = r;
      noteActive(true);
      return r;
    }
  }

  async function readPaperLocked(a: PerpLaneAgent, cfg: PerpLaneConfig, rail: PerpsMode, nowMs: number): Promise<PerpLaneRead> {
    const nowSec = Math.floor(nowMs / 1000);
    const bookMode = "paper" as const;
    const store = deps.store;
    let positions = await store.getPerpPositions(a.agentId, "paper", { includeFlat: true });
    const unresolved = await store.listSubmittedPerpOrders(a.agentId, "paper");
    let account = await store.getPerpAccount(a.agentId, "paper");
    // A RESTORE'S FOLDED COLLATERAL GOES BACK TO PAPER CASH once the paper
    // book is flat (store.ts returnFoldedPaperCollateral, the review's
    // R3-FOLDED-PAPER-COLLATERAL): the engine funds opens from cash and keeps
    // no collateral at a venue, so C here was money nothing could spend that
    // the cap still counted as committed. Equity does not move (C → cash).
    if ((account?.paperCollateralMicro ?? 0n) > 0n && unresolved.length === 0 && !positions.some((p) => p.base > 0n && p.side !== null) && store.returnFoldedPaperCollateral) {
      try {
        const moved = await store.returnFoldedPaperCollateral(a.agentId);
        if (moved > 0n) {
          log(`${a.agentId.slice(0, 10)} folded paper collateral ${usdgText(moved)} USDG returned to paper cash`);
          account = await store.getPerpAccount(a.agentId, "paper");
          positions = await store.getPerpPositions(a.agentId, "paper", { includeFlat: true });
        }
      } catch (e) {
        log(`folded paper collateral not returned: ${errText(e)}`);
      }
    }
    const collateral = account?.paperCollateralMicro ?? 0n;
    const heldRows = positions.filter((p) => p.base > 0n && p.side !== null);
    const held = heldRows.length > 0 || unresolved.length > 0 || collateral !== 0n;
    lastHeldMarkets = heldRows.map((p) => p.marketId);
    const active = rail.mode === "paper" || held;
    if (!active) {
      // Nothing held and perps not on: the known zero of an agent with no
      // perps (rule 11) — Lighter's prices are not even read.
      lastKnownPaperMicro = 0n;
      const r: PerpLaneRead = {
        active: false,
        bookMode,
        rail,
        view: undefined,
        book: undefined,
        lastKnownMicro: lastKnownPaperMicro,
        policy: railOnlyPolicy(a, cfg, rail, nowSec),
        feedFresh: false,
        held: false,
        report: flatReport(rail, protectAtMs),
        readAtMs: nowMs,
      };
      lastRead = r;
      noteActive(false);
      await announceRail(r, a);
      return r;
    }
    deps.onActive?.();
    noteActive(true);

    const facts = await store.perpLaneLedgerFacts(a.agentId, "paper", nowSec - 86_400);
    const bookRow = await store.getPaperBook(a.agentId, cfg.paperStartUsdg);
    const feed = deps.readFeed(nowMs);

    const orders = orderSets(unresolved);
    const cash = bookRow.cashUsdg;
    const ledger: PerpsViewLedger = {
      positions,
      unresolvedMarkets: orders.unresolvedMarkets,
      unresolvedOpenMarkets: orders.unresolvedOpenMarkets,
      closeInFlightMarkets: orders.closeInFlightMarkets,
      pendingOpenNotionalMicro: orders.pendingOpen,
      opensToday: facts.opensToday,
      lastExit: lastExitOf(facts.lastExits),
      lastEntryCandleT: lastEntryOf(facts.lastOpenAt),
      // Paper has no transfers: margin moves with each fill (rule 14).
      depositsInTransitMicro: 0n,
      withdrawalsInTransitMicro: 0n,
      paperCollateralMicro: account?.paperCollateralMicro ?? null,
      // An unreadable cash figure is not zero: the view then states no free collateral.
      paperCashMicro: Number.isFinite(cash) ? BigInt(Math.round(cash * 1e6)) : null,
      incident: account?.incident !== null && account?.incident !== undefined,
      entriesHalted: (account?.entriesHalted ?? false) || ownerEntryHalts.has(`${a.agentId}:paper`),
    };
    const input: PerpsViewInput = {
      mode: "paper",
      nowSec,
      feed,
      settings: cfg,
      grant: { perTradeSealedMicro: a.limits.perTradeUsdg, expiresAtSec: a.limits.expiresAt },
      ledger,
    };
    const view = buildPerpsView(input);
    let book: PerpBookTerm = buildPerpBookTerm(view);
    // A FLAT PAPER BOOK IS A KNOWN ZERO, whatever the feed says. The paper
    // ledger is the whole book (rule 14): with no position, no order in
    // flight and no collateral there is nothing to value, and calling that
    // "unread" would pause equity and refuse every spot buy (rule 11) over a
    // price file for markets nothing is held in.
    if (book === "unread" && !held) book = ZERO_BOOK;
    if (book !== "unread" && book !== undefined) lastKnownPaperMicro = perpAccountUsdg(book);
    const policy = buildPerpPolicyState(input, view, rail);
    const report = buildPerpsReport(input, view, { rail, protectAtMs, fundingUnreadMarkets: new Set(fundingGaps.keys()) });
    const r: PerpLaneRead = {
      active: true,
      bookMode,
      rail,
      view,
      book,
      lastKnownMicro: lastKnownPaperMicro,
      policy,
      feedFresh: feed !== null && nowMs - feed.observedAt <= 30_000,
      held,
      report,
      readAtMs: nowMs,
    };
    lastRead = r;
    await announceRail(r, a);
    return r;
  }

  /**
   * The ledger's unresolved orders as the view's sets (one derivation for
   * both books).
   *
   * `executed` IS FINAL FOR A TX THAT PLACES NO ORDER (reconcile.ts
   * finalizeStep: "leverage, cancel, withdraw end at executed"): the venue
   * ran it and there is nothing further to learn. Counted as unresolved, a
   * leverage change set while flat — the step before every first open —
   * held its market "unresolved" for good, and no open could ever follow it.
   * A `submitted` row of any kind, and an order row still `executed` (its
   * fills not all booked, or a stop still resting), stay unresolved.
   */
  function orderSets(unresolved: readonly Pick<PerpOrderRow, "marketId" | "effect" | "worstNotionalMicro">[]) {
    const unresolvedMarkets = new Set<number>();
    const unresolvedOpenMarkets = new Set<number>();
    const closeInFlightMarkets = new Set<number>();
    let pendingOpen = 0n;
    for (const o of unresolved) {
      if (o.marketId === null) continue;
      const status = (o as { status?: string }).status;
      if (status === "executed" && o.effect !== "open" && o.effect !== "reduce" && o.effect !== "close") continue;
      unresolvedMarkets.add(o.marketId);
      if (o.effect === "open") {
        unresolvedOpenMarkets.add(o.marketId);
        pendingOpen += o.worstNotionalMicro;
      } else if (o.effect === "reduce" || o.effect === "close") {
        closeInFlightMarkets.add(o.marketId);
      }
    }
    return { unresolvedMarkets, unresolvedOpenMarkets, closeInFlightMarkets, pendingOpen };
  }

  function lastExitOf(m: Map<number, { atSec: number; cause: "strategy" | "stop" | "take" | "risk" | "forced" | "unknown" }>) {
    const out = new Map<PerpKey, { atSec: number; cause: "strategy" | "stop" | "take" | "risk" | "forced" | "unknown" }>();
    for (const [id, e] of m) {
      const k = perpMarketById(id)?.key ?? null;
      if (k !== null) out.set(k, e);
    }
    return out;
  }

  /**
   * THE CANDLE OF THE LAST ENTRY: the ledger's opens (so a restart forgets
   * nothing that was sent) merged with this process's own record of every
   * entry execution attempted, refused or not (so a refused entry is not
   * re-proposed on every tick of the same bar).
   */
  function lastEntryOf(lastOpenAt: Map<number, number>) {
    const out = new Map<PerpKey, number>(entryCandles);
    for (const [id, at] of lastOpenAt) {
      const k = perpMarketById(id)?.key ?? null;
      if (k === null) continue;
      const t = entryCandleOf(at);
      if ((out.get(k) ?? -Infinity) < t) out.set(k, t);
    }
    return out;
  }

  // ── the live side ───────────────────────────────────────────────────────

  /**
   * The live side for (agent, account, sealed key) — opened, or re-tried, or
   * the one already held. Null when there is no venue account or no key to
   * hold one with. A side whose key or account changed is a NEW side: the old
   * key signs nothing for the new one.
   */
  async function ensureLiveSide(a: PerpLaneAgent, idx: number, sealed: `0x${string}` | null): Promise<LiveSide | null> {
    const L = deps.live;
    if (L === undefined) return null;
    const key = `${a.agentId.toLowerCase()}|${idx}|${sealed ?? "no-key"}`;
    if (live === null || live.key !== key) {
      if (live !== null) log(`live handle for account ${live.accountIndex} replaced (account or sealed key changed)`);
      live = {
        key,
        agent: a,
        accountIndex: idx,
        sealed: sealed ?? ("0x" + "0".repeat(80)) as `0x${string}`,
        handle: null,
        failure: null,
        keyOk: false,
        keyCheckedAtMs: 0,
        slot: "unread",
        snap: null,
        continuity: "pending",
        lastFullAtMs: 0,
        exposure: true,
        incidentStanddownMs: 0,
        supersede: new Map(),
        cancelledAt: new Map(),
        flatSinceMs: null,
        leverageSentAt: new Map(),
        said: new Set(),
        keyLegLandedAtMs: null,
        withdrawalDelaySec: null,
        pendingStops: new Map(),
        creditedSince: { transit: null, micro: 0n },
      };
    }
    const side = live;
    side.agent = a;
    if (side.handle !== null) return side;
    // NO SEALED KEY (a venue account under our address with no perp block on
    // the grant — re-signed without perps once flat, or money someone else
    // deposited): nothing can be signed, but the account is still READ,
    // publicly, so its money is counted and its exposure known (rule 11).
    if (sealed === null) return side;
    const nowMs = deps.now();
    if (side.failure !== null) {
      if (nowMs - side.failure.atMs < LIVE_LANE_TIMING.handleRetryMs) return side;
      // Owner repairs can make the exact sealed key usable without changing
      // the grant. The normal keystore checks still prove mode, contents and
      // public-key binding; an unrelated or still-broken file never retries.
      if (!side.failure.retryable && !(side.failure.blocker === "perps-key-pending" && keyLoadable(sealed))) return side;
    }
    let epoch = 1;
    try {
      epoch = await deps.store.getAgentEpoch(a.agentId);
    } catch {
      epoch = 1;
    }
    const opened = await openLiveHandle({
      agentId: a.agentId,
      smartAccount: a.smartAccount,
      accountIndex: idx,
      sealedPubKey: sealed,
      home: L.home(),
      api: L.api(a.smartAccount),
      publicApi: L.publicApi(),
      store: L.store,
      feed: () => deps.readFeed(deps.now()),
      now: deps.now,
      // The agents row's epoch, for adopted rows only (reconcile.ts): every
      // other writer reads it inside its own transaction.
      epoch: () => epoch,
      loadSigner: L.loadSigner,
      ...(L.beforeSend !== undefined ? { beforeSend: () => L.beforeSend!(a.agentId) } : {}),
      ...(L.loadKey !== undefined ? { loadKey: L.loadKey } : {}),
      ...(L.executorTuning !== undefined ? { executorTuning: L.executorTuning } : {}),
      log: (l) => log(l),
    });
    if (opened.ok) {
      side.handle = opened.handle;
      side.failure = null;
    } else {
      const first = side.failure === null || side.failure.why !== opened.why;
      side.failure = { blocker: opened.blocker, why: opened.why, retryable: opened.retryable, atMs: nowMs };
      if (first) {
        log(opened.why);
        await say(
          "warn",
          opened.blocker === "perps-key-pending"
            ? "perps: the Lighter trading key your grant sealed is not on this machine (or is not readable), so nothing can be " +
                "signed at Lighter — live perps stay off, and any position there keeps only the stop resting at the venue. " +
                "Re-sign on the dashboard with perpetuals included to make a new key."
            : "perps: the Lighter signer could not be loaded, so nothing can be signed at Lighter right now — it is tried again, " +
                "and any position there keeps the stop resting at the venue.",
        );
      }
    }
    return side;
  }

  /** The venue's decimals for a read by the PUBLIC client (orderBookDetails, cached): a key-less read of the account. */
  async function publicDecimalsNow(): Promise<ReadonlyMap<number, PerpDecimals> | null> {
    const L = deps.live;
    if (L === undefined) return null;
    const nowMs = deps.now();
    if (publicDecimals !== null && nowMs - publicDecimals.atMs < LIVE_LANE_TIMING.publicDecimalsMs) return publicDecimals.map;
    try {
      const r = await L.publicApi().orderBookDetails();
      if (r.ok && r.value.decimals.size > 0) publicDecimals = { map: r.value.decimals, atMs: nowMs };
    } catch {
      // a stale map still parses (reconcile.ts decimalsFor)
    }
    return publicDecimals?.map ?? null;
  }

  /**
   * ONE VENUE READ, OUTSIDE THE LOCK, ONE AT A TIME. `full` is a reconcile
   * pass (reconcile.ts: resolve, fills, funding, transfers, THE account read,
   * positions, the delta identity, incidents) plus the key slot and, when due,
   * the rule-5 self-check; `light` is the account and its orders only (the
   * protective loop's 15 s, an intent's). Its result is kept on the side for
   * the next read under the lock to build from. Never throws.
   */
  async function venueRead(a: PerpLaneAgent, depth: "full" | "light"): Promise<void> {
    const run = venueReads.then(() => venueReadNow(a, depth));
    venueReads = run.catch(() => {});
    await run.catch((e) => log(`venue read: ${errText(e)}`));
  }

  async function venueReadNow(a: PerpLaneAgent, depth: "full" | "light"): Promise<void> {
    const L = deps.live;
    if (L === undefined) return;
    const idxRaw = L.accountIndex();
    const grant = perpGrantOf(a.limits);
    const kept = live !== null && live.handle !== null ? live.sealed : null;
    const sealed = grant?.apiPublicKey ?? kept;
    if (idxRaw === null || idxRaw <= 0n) return;
    const idx = Number(idxRaw);
    const side = await ensureLiveSide(a, idx, sealed);
    if (side === null) return;
    const nowMs = deps.now();
    const h = side.handle;

    // The key slot (PUBLIC — it must read before our key is registered) and,
    // when due, the self-check. Full reads only: once a tick. The venue's
    // withdrawal delay too, while anything is pending on the contract: the
    // claim's timing reads it (onboard.ts claimDue), never a guess.
    if (depth === "full") {
      const pending = L.transit()?.pendingBalanceMicro ?? null;
      if (pending !== null && pending > 0n) {
        try {
          const r = await L.publicApi().withdrawalDelay();
          side.withdrawalDelaySec = r.ok ? r.value : side.withdrawalDelaySec;
        } catch {
          // kept as it was: a claim waits for a read
        }
      }
      side.slot = h !== null ? await h.keySlot() : await publicKeySlot(idx);
      await noteForeignKey(side, a);
      const due = !side.keyOk || nowMs - side.keyCheckedAtMs > LIVE_LANE_TIMING.keyRecheckMs;
      if (h !== null && due && typeof side.slot === "object") {
        const v = await h.verifyKey(side.slot);
        side.keyCheckedAtMs = nowMs;
        if (v.ok) {
          if (!side.keyOk) {
            log(`the Lighter key at account ${idx} index ${LIGHTER_ROUTE_V1.apiKeyIndex} is the sealed one and accepts our token`);
            await recordRegisteredKey(a, side.sealed);
          }
          side.keyOk = true;
        } else if (!v.unread) {
          // PROVEN: the venue holds another key, or refused a token our key
          // made. Never a pass; the incident path owns a foreign key.
          side.keyOk = false;
          if (!side.said.has(`key:${v.detail}`)) {
            side.said.add(`key:${v.detail}`);
            await say("err", `perps: ${v.detail}. Live perps stay off; anything at Lighter keeps the stops resting there.`);
          }
        }
      } else if (typeof side.slot !== "object" || side.slot.publicKey !== sealed) {
        // The sealed key is not (or no longer) at our index.
        if (side.slot !== "unread") side.keyOk = false;
      }
    }

    if (h !== null && side.keyOk) {
      let entriesMayReplay = false;
      try {
        const account = await L.store.getPerpAccount(a.agentId, "live");
        entriesMayReplay = account !== null && !account.entriesHalted && account.incident === null;
      } catch { /* unread authority never permits an entry replay */ }
      h.exitReads = latched || !isLiveRailOn(a) || !entriesMayReplay || ownerEntryHalts.has(`${a.agentId}:live`);
      if (depth === "full") {
        const rec = await h.reconciler.reconcileOnce();
        h.noteReconcile(rec);
        side.continuity = rec.continuity;
        side.lastFullAtMs = nowMs;
        side.snap = { depth, atMs: nowMs, account: rec.accountRead, orders: rec.orders, decimals: rec.decimals, rec };
        await noteReconcile(side, a, rec);
        if (rec.accountRead !== null) await creditGenesisDeposits(a, side, rec.accountRead);
        await recordOpenStops(a, side);
      } else {
        const acct = await h.executor.account({ exit: true });
        const orders = acct.ok ? await h.activeOrders() : null;
        side.snap = { depth, atMs: nowMs, account: acct.ok ? acct.read : null, orders, decimals: h.decimals(), rec: side.snap?.rec ?? null };
      }
      return;
    }
    // NO USABLE KEY: the account is still read — publicly (the venue
    // publishes it) — so its money is counted and its exposure known.
    const dec = await publicDecimalsNow();
    let acct: PerpAccountRead | null = null;
    if (dec !== null) {
      try {
        const r = await L.publicApi().account({ by: "index", accountIndex: idx }, dec);
        acct = r.ok ? r.value : null;
      } catch {
        acct = null;
      }
    }
    side.snap = { depth, atMs: nowMs, account: acct, orders: null, decimals: dec, rec: side.snap?.rec ?? null };
    if (acct !== null) await creditGenesisDeposits(a, side, acct);
  }

  /**
   * THE FIRST DEPOSITS' CREDIT (the venue's "shows it" for a brand-new
   * account). The reconciler marks a deposit credited from the venue-delta
   * identity — a mismatch between two of ITS reads that is exactly the
   * deposit — but the first deposit is what CREATES the venue account, and
   * the key that reads it authenticated is registered only after; by the
   * reconciler's first read the credit is already inside its baseline, and
   * the deposit would sit `landed` for good: counted in T_in beside the C
   * that holds it (a phantom gain the ratchets hold on), then a gap refusing
   * every open (reconcile.ts DEPOSIT_CREDIT_GRACE_MS).
   *
   * So a FRESH account is judged here, exactly: nothing ever signed on it
   * (our nonce high-water was never raised), no position, no order, every
   * open transfer a landed deposit of ours — and C + ΣM equal, to the micro,
   * to those deposits. Then they are what the venue holds, and they are
   * credited. Anything else (fills since, a payout, one deposit of two) is
   * left to the reconciler's identity; never guessed.
   */
  async function creditGenesisDeposits(a: PerpLaneAgent, side: LiveSide, acct: PerpAccountRead): Promise<void> {
    const L = deps.live;
    if (L === undefined) return;
    try {
      if ((await L.store.getNonceHighWater(a.agentId, "live")) !== null) return;
      if (acct.positions.some((p) => p.baseAmount !== 0n) || acct.totalOrderCount > 0 || acct.pendingOrderCount > 0) return;
      const open = await L.store.listOpenPerpTransfers(a.agentId, "live");
      if (open.length === 0 || !open.every((t) => t.direction === "deposit" && t.state === "landed")) return;
      const sum = open.reduce((x, t) => x + t.amountMicro, 0n);
      if (acct.collateralMicro + acct.isolatedMarginMicro !== sum) return;
      for (const t of open) {
        await L.store.upsertPerpTransfer({ agentId: a.agentId, mode: "live", id: t.id, direction: "deposit", amountMicro: t.amountMicro, initiator: t.initiator, state: "credited" });
      }
      const tr = L.transit();
      if (side.creditedSince.transit !== tr) side.creditedSince = { transit: tr, micro: 0n };
      side.creditedSince.micro += sum;
      log(`${a.agentId.slice(0, 10)}: Lighter credited the first deposit(s), ${usdgText(sum)} USDG`);
      await say("ok", `perps: Lighter credited ${usdgText(sum)} USDG of margin to the agent's new account.`);
    } catch (e) {
      log(`first deposits not credited: ${errText(e)}`);
    }
  }

  /** The transit this read may use: the tick's, less what was found credited since it was computed. */
  function transitNow(side: LiveSide | null): InTransit | null {
    const t = deps.live?.transit()?.transit ?? null;
    if (t === null || side === null || side.creditedSince.transit !== deps.live?.transit() || side.creditedSince.micro === 0n) return t;
    const tIn = t.tInMicro - side.creditedSince.micro;
    return { ...t, tInMicro: tIn > 0n ? tIn : 0n };
  }

  /**
   * THE STOP EACH OPEN CARRIED, ON ITS POSITION (view.ts: "the stop and take
   * we RECORDED, when the position was opened"). The reconciler's position
   * cache keeps a recorded stop for as long as it is the same position, but
   * it has no source for the first one: this is it. Written once the venue
   * shows the position on the open's side; an open that never became one is
   * forgotten after ten minutes. Process memory — after a restart the view
   * takes the stop the venue shows resting, which is what it would record.
   */
  async function recordOpenStops(a: PerpLaneAgent, side: LiveSide): Promise<void> {
    const L = deps.live;
    if (L === undefined || side.pendingStops.size === 0) return;
    let rows: PerpPositionRow[];
    try {
      rows = await L.store.getPerpPositions(a.agentId, "live", { includeFlat: true });
    } catch {
      return;
    }
    const nowMs = deps.now();
    for (const [marketId, st] of [...side.pendingStops]) {
      const row = rows.find((r) => r.marketId === marketId);
      if (row !== undefined && row.base > 0n && row.side === st.side) {
        try {
          await L.store.upsertPerpPosition({
            agentId: a.agentId,
            mode: "live",
            marketId,
            side: row.side,
            base: row.base,
            entryPrice: row.entryPrice,
            allocatedMarginMicro: row.allocatedMarginMicro,
            imfBp: row.imfBp,
            marginMode: row.marginMode,
            realizedMicro: row.realizedMicro,
            fundingMicro: row.fundingMicro,
            stopTrigger: st.stopTrigger,
            stopPrice: st.stopPrice,
            takeTrigger: st.takeTrigger,
            takePrice: st.takePrice,
            fundingHourApplied: null,
            openedAt: row.openedAt ?? Math.floor(st.atMs / 1000),
            source: "venue",
          });
          side.pendingStops.delete(marketId);
        } catch (e) {
          log(`the ${perpMarketById(marketId)?.key ?? marketId} stop was not recorded: ${errText(e)}`);
        }
      } else if (nowMs - st.atMs > 10 * 60_000) {
        side.pendingStops.delete(marketId);
      }
    }
  }

  async function publicKeySlot(idx: number): Promise<ApiKeySlot> {
    const L = deps.live;
    if (L === undefined) return "unread";
    try {
      return apiKeySlotOf(await L.publicApi().apikeys(idx, LIGHTER_ROUTE_V1.apiKeyIndex));
    } catch {
      return "unread";
    }
  }

  /** perp_accounts.registered_pubkey ← the sealed key, once the venue shows it and it passed the self-check (onboard.ts `ready`). */
  async function recordRegisteredKey(a: PerpLaneAgent, sealed: `0x${string}`): Promise<void> {
    const L = deps.live;
    if (L === undefined) return;
    try {
      const row = await L.store.getPerpAccount(a.agentId, "live");
      if (row?.registeredPubkey?.toLowerCase() === sealed.toLowerCase()) return;
      await L.store.patchPerpAccount(a.agentId, "live", { registeredPubkey: sealed, ...(live !== null ? { accountIndex: live.accountIndex } : {}) });
    } catch (e) {
      log(`registered key not recorded: ${errText(e)}`);
    }
  }

  /**
   * A KEY AT OUR INDEX WE DID NOT PUT THERE IS AN INCIDENT (rule 16), read
   * from the PUBLIC slot so it is seen even when our own token no longer
   * works (a replaced key makes every authenticated read fail — the
   * reconciler's own check could not run then). The onboarding plan decides
   * what "ours" is: the sealed key, one this worker registered and did not
   * retire, or an owner rotation `recover` recorded.
   */
  async function noteForeignKey(side: LiveSide, a: PerpLaneAgent): Promise<void> {
    const L = deps.live;
    if (L === undefined || typeof side.slot !== "object") return;
    const grant = perpGrantOf(a.limits);
    if (grant === null) return;
    let row: PerpAccountRow | null;
    try {
      row = await L.store.getPerpAccount(a.agentId, "live");
    } catch {
      return;
    }
    const step = planOnboarding({
      grantPerp: grant,
      chainState: { usdgBalanceMicro: null, accountIndex: side.accountIndex, pendingBalanceMicro: null },
      venue: { apikeysAtIndex: side.slot, crossCollateralMicro: null },
      ledger: { registeredPubKey: row?.registeredPubkey ?? null, retiredPubKeys: row?.retiredPubkeys ?? [], depositsInFlight: 0, keyRegistrationInFlight: false },
      needMarginMicro: null,
      caps: { perTradeMicro: 0n, maxCollateralMicro: 0n, committedMicro: 0n },
    });
    const foreign = step.kind === "key-foreign" || (step.kind === "key-retired" && step.inSlot);
    if (!foreign) return;
    side.keyOk = false;
    const nowSec = Math.floor(deps.now() / 1000);
    const incident: Incident = {
      kind: "pubkey-mismatch",
      at: nowSec,
      detail: {
        triggers: [
          {
            kind: "pubkey-mismatch",
            evidence:
              step.kind === "key-foreign"
                ? `the key at account ${side.accountIndex} index ${LIGHTER_ROUTE_V1.apiKeyIndex} is ${step.publicKey.slice(0, 10)}…, not the sealed ${side.sealed.slice(0, 10)}…`
                : `the retired sealed key is back at account ${side.accountIndex} index ${LIGHTER_ROUTE_V1.apiKeyIndex}`,
          },
        ],
      },
    };
    try {
      const r = await persistIncident(L.store, { agentId: a.agentId, incident });
      if (r === "set") {
        await say(
          "err",
          `perps INCIDENT: ${incident.detail.triggers[0]!.evidence} — the agent did not put it there, so the Lighter key may be ` +
            "compromised. Every open is refused and the positions are being stood down. Replace the key with your owner key " +
            "using `merrymen recover`, then clear the alert on the dashboard.",
        );
      }
    } catch (e) {
      log(`incident flag not stored (${errText(e)}); opens are refused from memory`);
    }
    if (incidentDue(side)) wantStanddown = "incident";
  }

  /**
   * IS AN INCIDENT STAND-DOWN DUE? The first time the flag is seen by this
   * process, and again every incidentRepeatMs while anything is still at the
   * venue (rule 16: "withdrawals repeated as margin frees") — never once a
   * tick, and never while one runs.
   */
  function incidentDue(side: LiveSide): boolean {
    if (standing !== null || side.handle === null) return false;
    if (side.incidentStanddownMs === 0) return true;
    return side.exposure && deps.now() - side.incidentStanddownMs > LIVE_LANE_TIMING.incidentRepeatMs;
  }

  /** A reconcile pass's owner-facing half: alerts and forced fills said once; an incident's stand-down scheduled. */
  async function noteReconcile(side: LiveSide, _a: PerpLaneAgent, rec: ReconcileResult): Promise<void> {
    for (const s of rec.alerts) {
      if (side.said.has(s)) continue;
      side.said.add(s);
      await say(/INCIDENT/.test(s) ? "err" : "warn", `perps: ${s}`);
    }
    for (const f of rec.forcedFills) {
      const k = `forced:${f.tradeId}:${f.sideRole}`;
      if (side.said.has(k)) continue;
      side.said.add(k);
      const mk = perpMarketById(f.marketId)?.key ?? `market ${f.marketId}`;
      await say("err", `perps: Lighter ${f.tradeType === "liquidation" ? "liquidated" : f.tradeType === "deleverage" ? "deleveraged" : "settled"} ${mk} — realized ${usdgText(f.realizedMicro, true)} USDG.`);
    }
    if (rec.incident !== null && incidentDue(side)) wantStanddown = "incident";
  }

  function isLiveRailOn(a: PerpLaneAgent): boolean {
    const cfg = deps.config();
    return perpsModeOf(deps.execMode(), modeInputs(a, cfg, true)).mode === "live";
  }

  /** The live ledger as the view reads it (perp_positions cache, unresolved rows, the account row, the day's facts); throws when unreadable. */
  async function liveLedger(a: PerpLaneAgent, nowSec: number) {
    const L = deps.live as PerpLiveDeps;
    const positions = await L.store.getPerpPositions(a.agentId, "live", { includeFlat: true });
    const unresolved = await L.store.listSubmittedPerpOrders(a.agentId, "live");
    const account = await L.store.getPerpAccount(a.agentId, "live");
    const transfers = await L.store.listOpenPerpTransfers(a.agentId, "live");
    const facts = await L.store.perpLaneLedgerFacts(a.agentId, "live", nowSec - 86_400);
    return { positions, unresolved, account, transfers, facts };
  }

  /**
   * THE LIVE READ (under the lock, from the venue read the side holds). See
   * the header for the order of what must be true before opens run; each
   * missing link is a PerpBlocker in the report and `perp-venue-unready` for
   * an open.
   */
  async function readLiveLocked(a: PerpLaneAgent, cfg: PerpLaneConfig, verdict: ExecMode, nowMs: number, exitsOnly = false): Promise<PerpLaneRead> {
    const nowSec = Math.floor(nowMs / 1000);
    const L = deps.live;
    const railPre = perpsModeOf(verdict, modeInputs(a, cfg, true));
    const grant = perpGrantOf(a.limits);

    // A practice book left from paper stays exactly as it was (rule 14) — the
    // owner is told so rather than finding it gone. Only the sentence
    // depends on it, so a read that fails says nothing.
    let paperHeld = false;
    try {
      paperHeld = (await deps.store.getPerpPositions(a.agentId, "paper")).some((p) => p.base > 0n);
    } catch {
      paperHeld = false;
    }
    const flat = (rail: PerpsMode, extra: Partial<PerpLaneRead> = {}): PerpLaneRead => {
      noteActive(false);
      lastKnownLiveMicro = 0n;
      return {
        active: false,
        bookMode: "live",
        rail,
        view: undefined,
        book: undefined,
        lastKnownMicro: 0n,
        policy: railOnlyPolicy(a, cfg, rail, nowSec, "live"),
        feedFresh: false,
        held: paperHeld,
        report: flatReport(rail, protectAtMs, {}),
        readAtMs: nowMs,
        ...extra,
      };
    };
    if (L === undefined) {
      // NO LIVE EDGES IN THIS PROCESS: nothing at Lighter can be read or
      // signed, so the venue is never ready and nothing live is reached.
      return flat(perpsModeOf(verdict, modeInputs(a, cfg, false)));
    }

    // ── the ledger ──
    let led: Awaited<ReturnType<typeof liveLedger>> | null;
    try {
      led = await liveLedger(a, nowSec);
    } catch (e) {
      log(`live perp ledger unreadable: ${errText(e)}`);
      led = null;
    }
    const ledgerExposure =
      led === null ||
      led.positions.some((p) => p.base > 0n && p.side !== null) ||
      led.unresolved.length > 0 ||
      led.transfers.length > 0;
    const idxRaw = L.accountIndex();
    const sealed = grant?.apiPublicKey ?? live?.sealed ?? null;

    // ── NO VENUE ACCOUNT (addressToAccountIndex 0): the known zero ──
    if (idxRaw === 0n && (led === null || (led.positions.every((p) => p.base === 0n) && led.unresolved.length === 0))) {
      if (railPre.mode !== "live") return flat(perpsModeOf(verdict, modeInputs(a, cfg, false)));
      // Real perps are on and everything but the venue is in place: the
      // route may propose an entry (and the deposit that funds it is what
      // creates the account), so the lane is ON with an empty venue view.
      return liveReadOf(a, cfg, verdict, nowMs, { led, account: noVenueAccount(a.smartAccount, nowMs), orders: [], decimals: null, idx: 0, knownZero: true, sealed, exitsOnly });
    }
    // ── THE INDEX UNREAD, with perps in play: unread, never zero (rule 11) ──
    if (idxRaw === null) {
      if (grant === null && !ledgerExposure && live === null) return flat(perpsModeOf(verdict, modeInputs(a, cfg, false)));
      return liveReadOf(a, cfg, verdict, nowMs, { led, account: null, orders: null, decimals: null, idx: null, knownZero: false, sealed, exitsOnly });
    }
    if (idxRaw === 0n) {
      // The chain says no account while the ledger holds an order or a
      // position: the two disagree, and unknown is never zero.
      return liveReadOf(a, cfg, verdict, nowMs, { led, account: null, orders: null, decimals: null, idx: 0, knownZero: false, sealed, exitsOnly });
    }
    const idx = Number(idxRaw);
    const snap = live !== null && live.accountIndex === idx ? live.snap : null;
    return liveReadOf(a, cfg, verdict, nowMs, {
      led,
      account: snap?.account ?? null,
      orders: snap?.orders ?? null,
      decimals: snap?.decimals ?? null,
      idx,
      knownZero: false,
      sealed,
      exitsOnly,
    });
  }

  /** The live read's one composition, from the venue read (or its absence) and the ledger. */
  async function liveReadOf(
    a: PerpLaneAgent,
    cfg: PerpLaneConfig,
    verdict: ExecMode,
    nowMs: number,
    v: {
      led: Awaited<ReturnType<typeof liveLedger>> | null;
      account: PerpAccountRead | null;
      orders: readonly VenueOrder[] | null;
      decimals: ReadonlyMap<number, PerpDecimals> | null;
      idx: number | null;
      /** The account does not exist: its term is the known zero, not a read. */
      knownZero: boolean;
      sealed: `0x${string}` | null;
      /** The protective loop's read: the view is built from the account alone when the feed is out. */
      exitsOnly?: boolean;
    },
  ): Promise<PerpLaneRead> {
    const L = deps.live as PerpLiveDeps;
    const nowSec = Math.floor(nowMs / 1000);
    const feed = deps.readFeed(nowMs);
    const railPre = perpsModeOf(verdict, modeInputs(a, cfg, true));
    const grant = perpGrantOf(a.limits);
    const side = live !== null && v.idx !== null && live.accountIndex === v.idx ? live : null;
    const transit = transitNow(side);
    const led = v.led;

    // ── the view ──
    const orders = orderSets(led?.unresolved ?? []);
    const ledger: PerpsViewLedger = {
      positions: led?.positions ?? [],
      unresolvedMarkets: orders.unresolvedMarkets,
      unresolvedOpenMarkets: orders.unresolvedOpenMarkets,
      closeInFlightMarkets: orders.closeInFlightMarkets,
      pendingOpenNotionalMicro: orders.pendingOpen,
      opensToday: led?.facts.opensToday ?? 0,
      lastExit: lastExitOf(led?.facts.lastExits ?? new Map()),
      lastEntryCandleT: lastEntryOf(led?.facts.lastOpenAt ?? new Map()),
      // T_in / T_out from the tick's payout step (payouts.ts inTransit); an
      // unknown transit is a book gap in the term below, and the committed
      // total saturates in the policy state (never counted as zero).
      depositsInTransitMicro: transit?.tInMicro ?? 0n,
      withdrawalsInTransitMicro: transit?.tOutMicro ?? 0n,
      stopExpiresAtSec: new Map(),
      incident: led?.account?.incident !== null && led?.account?.incident !== undefined,
      entriesHalted: (led?.account?.entriesHalted ?? false) || ownerEntryHalts.has(`${a.agentId}:live`),
    };
    const decimals = v.decimals ?? feedDecimals(feed);
    const input: PerpsViewInput = {
      mode: "live",
      nowSec,
      feed,
      settings: cfg,
      grant: { perTradeSealedMicro: a.limits.perTradeUsdg, expiresAtSec: a.limits.expiresAt },
      ledger,
      venue: v.account !== null ? { account: v.account, orders: v.orders, decimals } : null,
      accountCashMicro: L.cashMicro(),
      ...(v.exitsOnly === true ? { exitsOnly: true } : {}),
    };
    // ── THE RECONCILER'S GAPS ARE BOOK GAPS (reconcile.ts header: "the caller
    // refuses every non-exit intent while `gaps` is non-empty; exits are
    // still attempted"). A pass that could not read the fills, the funding,
    // the transfers, the incident reads or the account, or whose venue-delta
    // identity failed, leaves money it cannot explain: no equity row, no
    // ratchet, no fee, and every non-exit refused (policy perp-unpriced) —
    // rule 11. The ARM gaps (continuity, the signer horizon after a rebuild)
    // are about what may be SIGNED, not about money: they hold opens
    // (venueReady below) and leave the book as read. The protective loop's
    // read keeps its view either way — exits are still attempted.
    const rec = side?.snap?.rec ?? null;
    const recGaps = rec?.gaps ?? [];
    const moneyGaps = recGaps.filter((g) => !g.startsWith("arm:"));
    const view = (led === null || moneyGaps.length > 0) && v.exitsOnly !== true ? null : buildPerpsView(input);

    // ── the term (index.ts noteLivePerpTerm) ──
    let liveTerm: LivePerpTerm | undefined;
    let book: PerpBookTerm;
    if (v.knownZero && led !== null && led.transfers.length === 0) {
      book = undefined;
      lastKnownLiveMicro = 0n;
    } else {
      liveTerm = L.term(v.account, transit);
      if (led === null) {
        // The tick consumes liveTerm when present. Keep its money verdict
        // identical to book, including failures after a successful reconcile.
        liveTerm = { book: "unread", valueMicro: null, venueMoneyMicro: null, why: "the live perpetual ledger could not be read" };
      } else if (moneyGaps.length > 0) {
        liveTerm = { book: "unread", valueMicro: null, venueMoneyMicro: null, why: `the Lighter reconcile has a gap: ${moneyGaps[0]}` };
        if (!side?.said.has(`gap:${moneyGaps[0]}`)) {
          side?.said.add(`gap:${moneyGaps[0]}`);
          log(`book gap: ${moneyGaps.join("; ")}`);
        }
      }
      book = liveTerm.book;
      if (liveTerm.valueMicro !== null) lastKnownLiveMicro = liveTerm.valueMicro;
    }

    // ── readiness, link by link ──
    const keyReady = side !== null && side.handle !== null && side.keyOk;
    const incident = ledger.incident || (view?.facts.incident ?? false);
    const venueReady =
      grant !== null &&
      v.idx !== null &&
      v.idx > 0 &&
      keyReady &&
      v.account !== null &&
      side !== null &&
      side.continuity !== "pending" &&
      recGaps.length === 0 &&
      !incident;
    const rail = perpsModeOf(verdict, modeInputs(a, cfg, venueReady));
    const step = await onboardingStep(a, v, side, view, null);
    let railBlocker: PerpBlocker | null = null;
    if (rail.mode === "refuse" && rail.rule === "perp-venue-unready") {
      railBlocker =
        (grant !== null && !keyLoadable(grant.apiPublicKey) ? "perps-key-pending" : null) ??
        (step !== null ? onboardingBlocker(step) : null) ??
        side?.failure?.blocker ??
        (v.idx === 0 || v.account?.collateralMicro === 0n
          ? "perps-awaiting-deposit"
          : side !== null && side.handle !== null && !side.keyOk
            ? "perps-key-pending"
            : "perps-venue-unreachable");
    }
    const withBlocker: PerpsViewInput = { ...input, railBlocker };
    let policy: PerpPolicyState | undefined = led === null && v.exitsOnly !== true ? railOnlyPolicy(a, cfg, rail, nowSec, "live") : buildPerpPolicyState(withBlocker, view, rail);
    let legPolicy: PerpPolicyState | undefined = led === null ? undefined : assumeLeverage(buildPerpPolicyState(input, view, railPre));
    // Money in transit unknown: the committed total is unknown too, and an
    // unknown total must refuse the next deposit or open rather than admit it.
    if (transit === null || transit.gap) {
      if (policy !== undefined) policy = { ...policy, committedCollateralMicro: policy.settings.maxCollateralMicro };
      if (legPolicy !== undefined) legPolicy = { ...legPolicy, committedCollateralMicro: legPolicy.settings.maxCollateralMicro };
    }
    const report = buildPerpsReport(withBlocker, view, {
      rail,
      protectAtMs,
      accountIndex: v.idx !== null && v.idx > 0 ? v.idx : null,
      lastVenueReadAtMs: side?.snap?.account ? Math.floor(side.snap.account.transactionTimeUs / 1000) : null,
    });

    // THE DURABLE FLAG (rule 16), whatever raised it — this pass's detection,
    // an unknown fill two passes ago, a flag left by the last process: while
    // it stands and anything is at the venue, the stand-down is due.
    if (ledger.incident && side !== null && incidentDue(side)) wantStanddown = "incident";
    const venueExposure = v.account !== null ? venueShowsExposure(v.account, transit) : null;
    const ledgerHeld =
      led === null || led.positions.some((p) => p.base > 0n && p.side !== null) || led.unresolved.length > 0 || led.transfers.length > 0;
    const exposure = v.knownZero ? ledgerHeld && led !== null && (led.unresolved.length > 0 || led.transfers.length > 0) : (venueExposure ?? ledgerHeld);
    if (side !== null) {
      side.exposure = exposure;
      // Keep the idle withdrawal clock in the complete financial checkpoint:
      // a process restart must not postpone a return home for another day.
      // Only funded, fresh, known-flat accounts with no incoming deposit or unresolved open retain
      // it; a different venue account/epoch or malformed/future stamp starts
      // a new 24-hour interval, and any unread/non-flat observation clears it.
      const flatNow = v.account !== null && v.account.collateralMicro > 0n && led !== null &&
        !v.account.positions.some((p) => p.baseAmount !== 0n) && v.account.totalOrderCount === 0 && v.account.pendingOrderCount === 0 &&
        !led.unresolved.some(order => order.effect === "open") && !led.transfers.some(transfer => transfer.direction === "deposit");
      try {
        const epoch = await deps.store.getAgentEpoch(a.agentId);
        const saved = led?.account?.flatSince ?? null;
        const bound = saved !== null && saved.accountIndex === side.accountIndex && saved.epoch === epoch && saved.atMs > 0 && saved.atMs <= nowMs;
        const next = flatNow ? { atMs: bound ? saved.atMs : nowMs, epoch, accountIndex: side.accountIndex } : null;
        if (JSON.stringify(next) !== JSON.stringify(saved)) await L.store.patchPerpAccount(a.agentId, "live", { flatSince: next });
        side.flatSinceMs = next?.atMs ?? null;
      } catch {
        // Failure to durably record the observation never authorizes an early
        // withdrawal. Exits-only recovery still follows its separate rule.
        side.flatSinceMs = null;
      }
    }
    const active = railPre.mode === "live" || exposure;
    if (active) {
      deps.onActive?.();
      noteActive(true);
    } else {
      noteActive(false);
    }
    lastHeldMarkets = [...new Set([...(view?.positions.values() ?? [])].map((p) => p.marketId))];
    const r: PerpLaneRead = {
      active,
      bookMode: "live",
      rail,
      view: active ? view : undefined,
      book,
      lastKnownMicro: lastKnownLiveMicro,
      policy,
      ...(legPolicy !== undefined ? { legPolicy } : {}),
      ...(liveTerm !== undefined ? { liveTerm } : {}),
      exposure,
      feedFresh: feed !== null && nowMs - feed.observedAt <= 30_000,
      held: exposure,
      report,
      readAtMs: nowMs,
    };
    liveRead = r;
    return r;
  }

  /**
   * THE LEG STATE ASSUMES WHAT ONBOARDING WILL DO. Leverage can only be set
   * with the registered key (an L2 tx), the key only once margin is posted —
   * so judging the deposit's OPEN against "leverage unset" would refuse the
   * first deposit forever. A flat market with nothing unresolved is judged as
   * isolated at exactly its target IMF, which is what the lane sets it to
   * before the open goes (ensureLiveLeverage); a market with a position or an
   * order keeps the venue's own reading.
   */
  function assumeLeverage(p: PerpPolicyState): PerpPolicyState {
    const markets = new Map(p.markets);
    for (const [id, m] of p.markets) {
      if (p.positions.has(id) || p.unresolvedMarkets.has(id)) continue;
      markets.set(id, { ...m, venueImfBp: m.imfBpTarget, venueMarginMode: "isolated" });
    }
    return { ...p, markets };
  }

  function feedDecimals(feed: LighterFeedRead | null): ReadonlyMap<number, PerpDecimals> {
    const m = new Map<number, PerpDecimals>();
    for (const [id, fm] of feed?.markets ?? []) m.set(id, { sizeDecimals: fm.spec.sizeDecimals, priceDecimals: fm.spec.priceDecimals });
    return m;
  }

  /**
   * The onboarding plan (onboard.ts planOnboarding) for this read and, when
   * given, the margin of the open it would fund. Null when there is no grant
   * or no live edge. The deposit is sized so the deposit AND the open's
   * margin fit the collateral cap together — checkPerpOpen judges the margin
   * as new commitment on top of the landed deposit (route.ts depositToFund,
   * the review's S3-COLLATERAL-SIZING-MISMATCH) — so the cap handed to the
   * plan is already lowered by the margin.
   */
  async function onboardingStep(
    a: PerpLaneAgent,
    v: { led: Awaited<ReturnType<typeof liveLedger>> | null; account: PerpAccountRead | null; idx: number | null },
    side: LiveSide | null,
    view: PerpsViewBuilt | null,
    needMarginMicro: bigint | null,
  ): Promise<OnboardingStep | null> {
    const L = deps.live;
    const grant = perpGrantOf(a.limits);
    if (L === undefined || grant === null) return null;
    const cfg = deps.config();
    const t = L.transit();
    const nowSec = Math.floor(deps.now() / 1000);
    const led = v.led;
    const deposits = (led?.transfers ?? []).filter((x) => x.direction === "deposit" && (x.state === "submitted" || x.state === "landed"));
    const withdraws = (led?.transfers ?? []).filter((x) => x.direction === "withdraw");
    // An unread submitted-op ledger cannot authorize another key UserOp.
    const keyInFlight = (await L.keyLegInFlight().catch(() => null)) !== false || (side?.keyLegLandedAtMs !== null && side?.keyLegLandedAtMs !== undefined && deps.now() - side.keyLegLandedAtMs < LIVE_LANE_TIMING.keyLandedWaitMs);
    const committed = view?.facts.committedCollateralMicro ?? null;
    const cap = perpsUsdgToMicro(cfg.perpsMaxCollateralUsdg);
    const need = needMarginMicro !== null && needMarginMicro > 0n ? needMarginMicro : null;
    // Read outside the lock by the venue read when something is pending (its
    // own cadence); null — no claim — until it has been.
    const withdrawalDelaySec = side?.withdrawalDelaySec ?? null;
    const pending = t?.pendingBalanceMicro ?? null;
    return planOnboarding({
      grantPerp: grant,
      chainState: {
        usdgBalanceMicro: L.cashMicro(),
        accountIndex: v.idx,
        pendingBalanceMicro: pending,
        pendingSinceSec: withdraws.length > 0 ? Math.min(...withdraws.map((w) => w.createdAt)) : null,
      },
      venue: {
        apikeysAtIndex: side?.slot ?? "unread",
        crossCollateralMicro: v.account?.collateralMicro ?? null,
        withdrawalDelaySec,
      },
      ledger: {
        registeredPubKey: led?.account?.registeredPubkey ?? null,
        retiredPubKeys: led?.account?.retiredPubkeys ?? [],
        depositsInFlight: deposits.length,
        keyRegistrationInFlight: keyInFlight,
      },
      needMarginMicro: need,
      caps: {
        perTradeMicro: a.limits.perTradeUsdg,
        maxCollateralMicro: cap,
        // Unknown committed money is the whole cap: nothing is deposited on a guess.
        committedMicro: committed === null ? cap : committed + (need ?? 0n),
      },
      nowSec,
    });
  }

  /** The on-chain leg a step asks for, or null. Legs are the ROUTE's to send (outside the lock, through processIntentReporting). */
  function legOf(step: OnboardingStep | null): { intent: PerpMarginIntent | PerpKeyIntent; why: string } | null {
    if (step === null) return null;
    switch (step.kind) {
      case "deposit":
        return {
          intent: { kind: "perp-margin", direction: "deposit", target: LIGHTER_ROUTE_V1.proxy, amountUsdg: step.amountMicro } as PerpMarginIntent,
          why: `post ${usdgText(step.amountMicro)} USDG of margin at Lighter to fund the open the route proposed`,
        };
      case "register-key":
        return { intent: { kind: "perp-key", accountIndex: step.accountIndex } as PerpKeyIntent, why: "register the sealed trading key at the agent's Lighter account" };
      case "claim":
        return {
          intent: { kind: "perp-margin", direction: "claim", amountUsdg: step.amountMicro } as PerpMarginIntent,
          why: `claim ${usdgText(step.amountMicro)} USDG Lighter owes this account (its relayer has not)`,
        };
      default:
        return null;
    }
  }

  /** An onboarding step, in the owner's words, for the open it holds back. */
  function stepText(step: OnboardingStep | null): string {
    if (step === null) return "the agent's Lighter account is not ready yet";
    switch (step.kind) {
      case "deposit":
        return `the open waits for ${usdgText(step.amountMicro)} USDG of margin to be posted at Lighter first`;
      case "await-credit":
        return "the open waits for the margin already posted to be credited at Lighter";
      case "cannot-fund":
        return `the open cannot be funded: ${step.detail}`;
      case "register-key":
      case "await-key":
        return "the open waits for the agent's trading key to be registered at Lighter";
      case "key-foreign":
      case "key-retired":
        return perpsBlockerText("perps-key-mismatch").what;
      case "unread":
        return `the open waits: Lighter's ${step.what === "cash" ? "cash balance" : step.what} could not be read`;
      case "not-granted":
        return perpsBlockerText("perps-not-granted").what;
      case "claim":
        return "a payout Lighter owes the account is being claimed first";
      case "idle":
      case "ready":
        return "the agent's Lighter account is not ready yet";
    }
  }

  // ── the rail, said once per change ──────────────────────────────────────

  /**
   * THE RAIL, SAID ONCE PER CHANGE (and again after every arm). The owner is
   * told what perps are doing in their own words: practice, real, or why not
   * — never a slug. "Off" is said only when it is a change FROM on: an owner
   * who never turned perps on and holds nothing hears nothing, however often
   * the account's own rail moves between paper and live (the review's S3-05 —
   * the key used to carry the book, so a cash read of 0 flipping the account
   * to paper and back said "perpetuals are off" to owners who never had them).
   */
  async function announceRail(r: PerpLaneRead, a: PerpLaneAgent): Promise<void> {
    const quietOff = r.rail.mode === "off" && !r.held;
    const key = quietOff
      ? "off"
      : `${r.bookMode}|${r.rail.mode}|${r.rail.mode === "refuse" ? r.rail.rule : ""}|${(r.rail.mode === "off" || r.bookMode === "live") && r.held ? "held" : ""}`;
    if (key === railKey) return;
    const prev = railKey;
    railKey = key;
    let line: string | null;
    const frozen =
      r.bookMode === "live" && r.held && r.exposure !== true
        ? " The practice positions opened while the account was on paper stay exactly as they were — not traded, not " +
          "counted in the real book — until it is back on paper."
        : "";
    if (quietOff) {
      // Off after being on is news; off after off (or first) is not.
      line = prev === null || prev === "off" || prev.includes("|off|") ? null : "perpetuals are off — nothing new is opened on Lighter.";
    } else if (r.bookMode === "live" && r.held && r.rail.mode === "off") {
      line =
        r.exposure === true
          ? "perpetuals are off: nothing new is opened on Lighter. What is still there keeps its stops, is watched and closed on its " +
            "own rules, and free collateral comes home once it is flat."
          : `perpetuals are off.${frozen}`;
    } else if (r.rail.mode === "paper") {
      line =
        "perpetuals are on, in practice: Lighter's live prices and order book with the venue's own rules, margin drawn " +
        "from the paper book's cash — nothing is signed and no money moves. Every position opens with its stop.";
    } else if (r.rail.mode === "live") {
      line =
        "perpetuals are live on Lighter: real USDG, isolated margin at the leverage you set, and every position opens with its " +
        "stop resting at the venue. Closes and stops always run.";
    } else if (r.rail.mode === "refuse") {
      // A perps slug has the owner's words (thesis-policy.ts); the account's
      // own refusal (not armed, a dead policy…) is already said by the
      // account's status, so it is named as that, never as a raw slug.
      const words = r.rail.rule.startsWith("perp-") ? ownerRejectRuleLabel(r.rail.rule) : null;
      line = `perpetuals are switched on, but nothing new is opened: ${words ?? "the account itself is not trading right now — its status says why"}.${frozen}`;
    } else if (r.held) {
      line = "perpetuals are off: nothing new is opened. The practice positions still held keep their stops and close on their own rules.";
    } else {
      line = null;
    }
    if (line === null) return;
    log(`${a.agentId.slice(0, 10)} rail: ${key}`);
    await say(r.rail.mode === "refuse" ? "warn" : "ok", line);
  }

  // ── the paper leverage, set while flat ──────────────────────────────────

  /**
   * RULE 6's LAZY UpdateLeverage, on the paper venue: an open is refused unless
   * the market reads isolated at exactly IMF_m, and a market is set only while
   * it is flat. Set here only when the open ASSERTS the very IMF the owner's
   * setting implies (view.ts leverageTarget): a leverage anyone else chose is
   * never written, it is refused by policy as the mismatch it is.
   */
  async function ensurePaperLeverage(intent: PerpOrderIntent, r: PerpLaneRead, ex: PerpExecutor): Promise<PerpLaneRead> {
    if (intent.effect !== "open" || !r.view) return r;
    const m = r.view.markets.get(intent.market);
    if (m === undefined || m.marketId !== intent.marketId) return r;
    if (m.venueImfBp === m.imfBp && m.venueMarginMode === "isolated") return r;
    if (r.view.positions.has(intent.market) || r.view.unresolved.has(intent.market)) return r;
    if (intent.imfBp !== m.imfBp) return r;
    try {
      await ex.setLeverage?.(m.marketId, m.imfBp);
      log(`${intent.market} set isolated at ${levText(m.imfBp)} on the paper venue`);
    } catch (e) {
      // Policy says why the open cannot go (leverage-unset/-mismatch); this only notes it.
      log(`${intent.market} leverage not set: ${errText(e)}`);
      return r;
    }
    return readLocked();
  }

  // ── one intent ──────────────────────────────────────────────────────────

  async function refuse(intent: PerpOrderIntent | PerpMarginIntent, v: { rule: string; detail: string }, stage: string): Promise<PerpOutcome> {
    log(`REJECTED ${labelOf(intent)} (${stage}): ${v.rule} — ${v.detail}`);
    // THE OWNER LINE, ONCE PER CHANGE (owner-refusal.ts's shape): the same
    // refusal on every tick is one fact, and forty copies of it push the
    // one that matters out of view. Owner-facing only — perp refusals are
    // withheld from every public surface (rule 17), and there is no trades
    // row to carry them (the trades boundary).
    const key = `${v.rule}|${labelOf(intent)}`;
    if (key !== lastRefusalKey) {
      lastRefusalKey = key;
      await say("warn", `perps: ${labelOf(intent)} refused — ${v.rule}: ${v.detail}`);
    }
    return { status: "rejected", rejectRule: v.rule };
  }

  function refusalOf(e: unknown): { rule: string; detail: string } {
    if (e instanceof PerpRefused) return { rule: e.rule, detail: e.detail };
    // Anything else the executor could not price or book is an unknown, and
    // an unknown refuses (rule 11) — it never becomes "filled".
    return { rule: "perp-unpriced", detail: errText(e) };
  }

  /** The terms checkPolicy's second pass judges: the order at the review's fresh mark, never under what it can put on. */
  function reviewedOf(intent: PerpOrderIntent, review: PerpReview, r: PerpLaneRead): PerpOrderIntent {
    if (intent.effect !== "open") {
      // An exit clamped to the position is judged as the exit it became.
      return { ...intent, effect: review.effect === "reduce" ? "reduce" : "close", baseAmount: review.baseAmount };
    }
    const mark = review.mark ?? intent.markPrice;
    const ref = intent.worstPrice > mark ? intent.worstPrice : mark;
    const spec = r.policy?.markets.get(intent.marketId)?.spec;
    let floor = 0n;
    try {
      if (spec !== undefined) floor = notionalMicro(intent.baseAmount, ref, spec, "ceil");
    } catch {
      floor = 0n;
    }
    const atFill = review.notionalAtFillMicro + review.feeMicro;
    let n = intent.notionalUsdg;
    if (floor > n) n = floor;
    if (atFill > n) n = atFill;
    return { ...intent, markPrice: mark, notionalUsdg: n };
  }

  function specOf(intent: PerpOrderIntent, r: PerpLaneRead): PerpDecimals | null {
    return r.policy?.markets.get(intent.marketId)?.spec ?? r.view?.facts.positions.get(intent.market)?.decimals ?? null;
  }

  async function announcePlaced(intent: PerpOrderIntent, review: PerpReview, placed: PerpPlaceResult, r: PerpLaneRead): Promise<void> {
    const spec = specOf(intent, r);
    const px = (v: bigint | null) => (v === null ? "?" : spec ? renderScaled(v, spec.priceDecimals) : v.toString());
    const sz = (v: bigint) => (spec ? renderScaled(v, spec.sizeDecimals) : v.toString());
    let line: string;
    if (placed.filledBase === 0n) {
      line =
        `perps (paper): the ${intent.market} ${intent.effect} did not fill — nothing on the book inside its worst price ` +
        `${px(intent.worstPrice)}, so nothing moved.`;
    } else if (intent.effect === "open") {
      line =
        `📜 perps (paper): opened a ${levText(intent.imfBp)} ${intent.side} on ${intent.market} — ${sz(placed.filledBase)} at ` +
        `${px(placed.avgPrice)}, stop ${px(intent.stopTrigger)} (fills no worse than ${px(intent.stopPrice)})` +
        (placed.status === "partial" ? `, part-filled (${sz(placed.filledBase)} of ${sz(review.baseAmount)})` : "") +
        ` — nothing signed.`;
    } else {
      const verb = review.effect === "close" && placed.status === "filled" ? "closed" : "reduced";
      line =
        `📜 perps (paper): ${verb} the ${intent.side} on ${intent.market} — ${sz(placed.filledBase)} at ${px(placed.avgPrice)}, ` +
        `realized ${usdgText(placed.realizedMicro ?? 0n, true)} USDG — nothing signed.`;
    }
    await say(placed.filledBase === 0n ? "warn" : "ok", line);
  }

  /** A live send, said: what was signed and that Lighter's fills are booked as they are reported (never a fill guessed here). */
  async function announceLive(intent: PerpOrderIntent, review: PerpReview, placed: PerpPlaceResult & { tx?: { txHash: string } }, r: PerpLaneRead): Promise<void> {
    const spec = specOf(intent, r);
    const px = (v: bigint | null) => (v === null ? "?" : spec ? renderScaled(v, spec.priceDecimals) : v.toString());
    const sz = (v: bigint) => (spec ? renderScaled(v, spec.sizeDecimals) : v.toString());
    const tx = placed.tx?.txHash ? ` (tx ${placed.tx.txHash.slice(0, 12)}…)` : "";
    const line =
      intent.effect === "open"
        ? `perps: sent a ${levText(intent.imfBp)} ${intent.side} on ${intent.market} to Lighter — ${sz(review.baseAmount)} no worse than ` +
          `${px(intent.worstPrice)}, with its stop at ${px(intent.stopTrigger)} (fills no worse than ${px(intent.stopPrice)})${tx}. ` +
          `What fills is booked as Lighter reports it.`
        : `perps: sent a reduce-only ${review.effect} of the ${intent.side} on ${intent.market} to Lighter — ${sz(review.baseAmount)} no worse ` +
          `than ${px(intent.worstPrice)}${tx}. What fills is booked as Lighter reports it.`;
    await say("ok", line);
  }

  /**
   * RESERVE → PLACE → COUNT → RELEASE (recordTrade's order), for both books.
   *
   * The reservation covers the moment between the booking and the settled
   * counters seeing it; `finally` releases it on EVERY exit, a throw and a
   * refusal included — a reservation left behind is permanent for the arm
   * (budget-reservation.invariant.test.ts; lane.test.ts pins this one).
   *
   * ONCE place() HAS RETURNED, THE BOOKING IS FACT (the review's
   * S3-LANE-REFRESH-FAIL). A settled-counter re-read that throws after it is
   * NOT a refusal of the order — the position exists, or the signed tx is on
   * its way — so it is never reported as one, never refunds the energy
   * claim, and never drops the reservation unaccounted: recordTrade's
   * fail-closed conversion books the reservation into the settled halves
   * first (budget.keep), and the owner is told the counters need a re-read.
   */
  async function reservePlaceCount(
    intent: PerpOrderIntent,
    spend: bigint,
    place: () => Promise<PerpPlaceResult>,
  ): Promise<{ ok: true; placed: PerpPlaceResult } | { ok: false; out: PerpOutcome }> {
    deps.budget.reserve(spend);
    let placed: PerpPlaceResult;
    let held = false;
    try {
      placed = await place();
      held = await countOrKeep(spend);
    } catch (e) {
      // Hosted checkpoint publication can fail after the local submitted
      // row commits. Re-read it before releasing; an unread ledger keeps the
      // reservation conservatively even when the executor did not return.
      held = await countOrKeep(spend);
      return { ok: false, out: await refuse(intent, refusalOf(e), "place") };
    } finally {
      if (!held) deps.budget.release(spend);
    }
    return { ok: true, placed };
  }

  /** The settled halves re-read; on a throw, the reservation CONVERTED (true = hold it: no keep() to convert into). Never throws. */
  async function countOrKeep(spend: bigint): Promise<boolean> {
    try {
      await deps.budget.refresh();
      return false;
    } catch (e) {
      log(`the day's counters could not be re-read after a booking (${errText(e)}); its op and spend stay counted`);
      await say("err", "perps: a booking went through but the day's counters could not be re-read — its spend stays counted this session, and the ledger row is the record.");
      if (deps.budget.keep) {
        deps.budget.keep(spend);
        return false;
      }
      return true;
    }
  }

  async function executeLocked(
    intent: PerpOrderIntent | PerpMarginIntent,
    equity: { equityUsdg: bigint; equityKnown: boolean },
    base?: Omit<AgentState, "perp">,
    opts: { agent?: PerpLaneAgent; read?: PerpLaneRead; notAfterMs?: number } = {},
  ): Promise<PerpOutcome> {
    const a = opts.agent ?? agentNow();
    if (a === null) return { status: "rejected", rejectRule: "perp-not-enabled" };
    if (latched) {
      return refuse(intent, { rule: "perp-standing-down", detail: "the perps are being stood down right now, and nothing else is sent at Lighter until that ends." }, "lane");
    }
    let r = opts.read ?? (await readLocked());
    const stateFor = async (read: PerpLaneRead, legs = false): Promise<AgentState> => ({
      ...(base ?? (await deps.agentState(equity))),
      // THE DAY'S COUNTERS AS THEY STAND UNDER THE LOCK (deps.counters): a
      // protective close booked between `base` and now is counted.
      ...(deps.counters ? deps.counters() : {}),
      // The venue's state is the account's, from THIS read: an open judged
      // against an older "unread" (or an older "read") is judged against a
      // book nobody is looking at any more.
      perpVenueUnread: read.book === "unread",
      perpLastKnownMicro: read.lastKnownMicro,
      perp: legs ? (read.legPolicy ?? read.policy) : read.policy,
    });

    // ── MARGIN: a withdrawal (L2) is the live book's; the legs never reach here ──
    if (intent.kind === "perp-margin") {
      const v = check(intent, a.limits, await stateFor(r));
      if (!v.ok) return refuse(intent, v, "policy");
      if (intent.direction === "withdraw" && live?.handle && live.keyOk && (r.bookMode === "live" || live.exposure)) {
        return withdrawLive(intent, live);
      }
      return refuse(
        intent,
        r.bookMode === "live"
          ? intent.direction === "withdraw"
            ? { rule: "perp-venue-unready", detail: "the agent's Lighter key is not loaded or not verified, so no withdrawal can be signed." }
            : { rule: "perp-order-malformed", detail: "a deposit or a claim is an on-chain leg through the UserOp rail, never the lane's." }
          : {
              rule: "perp-order-malformed",
              detail: "paper perps keep no collateral at a venue — margin moves with each fill — so there is nothing to deposit, withdraw or claim.",
            },
        "lane",
      );
    }

    // ── WHICH BOOK: the account's — except an exit of what the LIVE venue
    // holds while the account is on paper (rule 8a: the exits-only lane). ──
    if (r.bookMode === "paper" && intent.effect !== "open" && live !== null && live.exposure) {
      const lr = liveRead;
      const liveHolds = lr?.view?.positions.get(intent.market) !== undefined;
      const paperHolds = r.view?.positions.get(intent.market) !== undefined;
      if (liveHolds && !paperHolds && lr !== null) return executeLive(a, intent, stateFor, lr, opts.notAfterMs);
    }
    if (r.bookMode === "live") return executeLive(a, intent, stateFor, r, opts.notAfterMs);

    const epoch = await deps.store.getAgentEpoch(a.agentId);
    const ex = executorFor(a, epoch);
    if (intent.effect === "open" && r.rail.mode === "paper") r = await ensurePaperLeverage(intent, r, ex);

    // ── the proposed terms ─────────────────────────────────────────────────
    const state = await stateFor(r);
    const v1: Verdict = check(intent, a.limits, state);
    if (!v1.ok) return refuse(intent, v1, "policy");

    // ── the dry run, priced against the book as it stands ─────────────────
    let review: PerpReview;
    try {
      review = await ex.review(intent);
    } catch (e) {
      return refuse(intent, refusalOf(e), "review");
    }

    // ── the reviewed terms: the SECOND pass, which is the one that counts ─
    const reviewed = reviewedOf(intent, review, r);
    const v2 = check(reviewed, a.limits, { ...state, ...(deps.counters ? deps.counters() : {}) });
    if (!v2.ok) return refuse(intent, v2, "reviewed");

    const spend = intent.effect === "open" ? reviewed.notionalUsdg : 0n;
    const done = await reservePlaceCount(intent, spend, () => ex.place(intent, review, { decisionId: intent.decisionId ?? null, agentId: a.agentId, notAfterMs: opts.notAfterMs }));
    if (!done.ok) return done.out;
    const placed = done.placed;
    lastRefusalKey = null;
    await announcePlaced(intent, review, placed, r);
    // Re-read after a booking so the next reader (the report, a pass) sees it.
    await readLocked();
    if (placed.filledBase === 0n) return { status: "dropped" };
    return { status: "paper", amountUsdg: Number(placed.filledQuoteMicro) / 1e6, basisSource: "paper" };
  }

  /**
   * A LIVE ORDER. The open is held back — never shrunk, never forced — until
   * the venue is ready for it: the onboarding plan with THIS open's margin
   * (the on-chain leg it wants is left for the route to send), then the
   * market's leverage as its own step. Then the same two policy passes, the
   * same reservation, one persisted-before-send venue tx (executor-live.ts),
   * and the outcome `submitted`: what filled is the reconciler's to book.
   */
  async function executeLive(
    a: PerpLaneAgent,
    intent: PerpOrderIntent,
    stateFor: (read: PerpLaneRead, legs?: boolean) => Promise<AgentState>,
    r: PerpLaneRead,
    notAfterMs?: number,
  ): Promise<PerpOutcome> {
    const side = live;
    const exit = intent.effect !== "open";

    if (!exit) {
      const railPre = r.legPolicy?.mode;
      const venueUnready = r.rail.mode === "refuse" && r.rail.rule === "perp-venue-unready";
      // ── THE OPEN FIRST, AS IF THE VENUE WERE READY ──
      // Nothing is deposited, registered or leveraged for an open policy
      // would refuse anyway (a cap, the market, its stop, the incident…):
      // the leg state assumes only what onboarding itself will do.
      if (venueUnready && railPre === "live") {
        const v0 = check(intent, a.limits, await stateFor(r, true));
        if (!v0.ok) return refuse(intent, v0, "policy");
      }
      // ── ONBOARDING, for this open — with or without a key registered yet:
      // the first deposit is what CREATES the venue account the key
      // registers on. But never for a key this machine cannot load. ──
      const sealedNow = perpGrantOf(a.limits)?.apiPublicKey ?? null;
      if (venueUnready && railPre === "live" && (sealedNow === null || !keyLoadable(sealedNow))) {
        return refuse(intent, { rule: "perp-venue-unready", detail: perpsBlockerText("perps-key-pending").what }, "onboarding");
      }
      if ((venueUnready && railPre === "live") || r.rail.mode === "live") {
        let need: bigint | null = null;
        try {
          need = isolatedMarginMicro(intent.notionalUsdg, intent.imfBp);
        } catch {
          need = null;
        }
        const idxRaw = deps.live?.accountIndex() ?? null;
        const idx = idxRaw === null ? null : Number(idxRaw);
        const account = idx === 0 ? noVenueAccount(a.smartAccount, deps.now()) : side !== null && side.accountIndex === idx ? (side.snap?.account ?? null) : null;
        const led = await liveLedger(a, Math.floor(deps.now() / 1000)).catch(() => null);
        const step = await onboardingStep(a, { led, account, idx }, side !== null && side.accountIndex === idx ? side : null, r.view ?? null, need);
        if (venueUnready || (step !== null && step.kind !== "ready")) {
          const leg = legOf(step);
          if (leg !== null) pendingLeg = leg;
          if (step !== null && step.kind === "cannot-fund") return refuse(intent, { rule: step.rule, detail: step.detail }, "onboarding");
          return refuse(intent, { rule: "perp-venue-unready", detail: stepText(step) }, "onboarding");
        }
      }
    }

    if (side === null || side.handle === null || !side.keyOk) {
      // The rail's own refusal first, when it has one: that is the owner's reason.
      if (!exit) {
        const v = check(intent, a.limits, await stateFor(r));
        if (!v.ok) return refuse(intent, v, "policy");
      }
      return refuse(
        intent,
        {
          rule: "perp-venue-unready",
          detail: exit
            ? "the agent's Lighter key is not loaded or not verified, so no close can be signed — the stop resting at the venue still protects the position."
            : `${stepText(null)} (${side?.failure?.why ?? "the trading key is not verified yet"}).`,
        },
        "lane",
      );
    }
    const ex: LivePerpExecutor = side.handle.executor;

    // ── LEVERAGE, its own step, while flat ──
    const state = await stateFor(r);
    if (!exit && r.rail.mode === "live") {
      // This signs an operation too. Judge the proposed open with only the
      // leverage setting it is about to establish assumed: expiry, caps,
      // entry halts and the breaker must all permit it before any signature.
      const readyState = { ...state, perp: state.perp === undefined ? undefined : assumeLeverage(state.perp) };
      const ready = check(intent, a.limits, readyState);
      if (!ready.ok) return refuse(intent, ready, "before-leverage");
      const held = await ensureLiveLeverage(intent, r, side);
      if (held !== null) return held;
    }

    // ── the proposed terms ─────────────────────────────────────────────────
    const v1 = check(intent, a.limits, state);
    if (!v1.ok) return refuse(intent, v1, "policy");

    // ── the dry run: the fleet feed's book (or one venue read), the venue-read position for an exit ──
    let review: PerpReview;
    try {
      review = await ex.review(intent);
    } catch (e) {
      return refuse(intent, refusalOf(e), "review");
    }
    const reviewed = reviewedOf(intent, review, r);
    const v2 = check(reviewed, a.limits, { ...state, ...(deps.counters ? deps.counters() : {}) });
    if (!v2.ok) return refuse(intent, v2, "reviewed");

    const spend = intent.effect === "open" ? reviewed.notionalUsdg : 0n;
    const fresh = side.snap !== null && deps.now() - side.snap.atMs <= LIVE_LANE_TIMING.lightMaxAgeMs ? side.snap.account : null;
    const done = await reservePlaceCount(intent, spend, () =>
      ex.place(intent, review, { decisionId: intent.decisionId ?? null, agentId: a.agentId, notAfterMs, ...(fresh !== null ? { venue: fresh } : {}) }),
    );
    if (!done.ok) return done.out;
    const placed = done.placed as PerpPlaceResult & { tx?: { txHash: string } };
    if (placed.status === "rejected") {
      // The row is final (the venue or our own brake refused the send); nothing
      // was opened or closed. The owner's words, once per change.
      return refuse(intent, { rule: "perp-venue-refused", detail: placed.detail }, "venue");
    }
    // THE STOP THIS OPEN CARRIES, recorded on its position once the venue
    // shows it (recordOpenStops): the view judges the resting stop against
    // it, and protect.ts puts THIS one back if it goes missing.
    if (intent.effect === "open") {
      side.pendingStops.set(intent.marketId, {
        side: intent.side,
        stopTrigger: intent.stopTrigger,
        stopPrice: intent.stopPrice,
        takeTrigger: intent.takeTrigger ?? null,
        takePrice: intent.takePrice ?? null,
        atMs: deps.now(),
      });
    }
    lastRefusalKey = null;
    await announceLive(intent, review, placed, r);
    return { status: "submitted" };
  }

  /**
   * RULE 6's UpdateLeverage ON THE LIVE VENUE: before the first open in a
   * market that does not read isolated at exactly IMF_m, set it — while the
   * market is flat, as ITS OWN STEP (never in the same tick as the open, which
   * waits: `perp-leverage-unset`), and confirmed only by the next account
   * read, never by our own send. Null when the market is already set (or
   * policy will refuse the open for a reason of its own).
   */
  async function ensureLiveLeverage(intent: PerpOrderIntent, r: PerpLaneRead, side: LiveSide): Promise<PerpOutcome | null> {
    const view = r.view;
    if (!view || intent.effect !== "open") return null;
    const m = view.markets.get(intent.market);
    if (m === undefined || m.marketId !== intent.marketId) return null;
    if (m.venueImfBp === m.imfBp && m.venueMarginMode === "isolated") return null;
    if (intent.imfBp !== m.imfBp) return null; // policy refuses the mismatch by name
    if (view.positions.has(intent.market) || view.unresolved.has(intent.market)) return null;
    const acct = side.snap?.account ?? null;
    const h = side.handle;
    if (acct === null || h === null) return null;
    const nowMs = deps.now();
    const sent = side.leverageSentAt.get(m.marketId);
    if (sent !== undefined && nowMs - sent < LIVE_LANE_TIMING.leverageWaitMs) {
      return refuse(intent, { rule: "perp-leverage-unset", detail: `${intent.market}'s leverage was sent to Lighter and is not read back yet; the open waits for it` }, "leverage");
    }
    // Leverage consumes one operation and no opening notional. Reserve it
    // until the ledger refresh sees the signed row, exactly as for an order,
    // so another intent in this tick sees the remaining allowance.
    deps.budget.reserve(0n);
    let held = false;
    try {
      const res = await h.executor.ensureLeverage(m.marketId, m.imfBp, acct, { reason: "before-first-open", decisionId: intent.decisionId ?? null });
      if ("kind" in res) return null;
      held = await countOrKeep(0n);
      if (res.rowStatus === "rejected" || res.rowStatus === "app-error") {
        return refuse(intent, { rule: "perp-venue-refused", detail: res.detail }, "leverage");
      }
      side.leverageSentAt.set(m.marketId, nowMs);
      log(`${intent.market} leverage sent: isolated at ${levText(m.imfBp)} — ${"detail" in res ? res.detail : ""}`);
    } catch (e) {
      held = await countOrKeep(0n);
      return refuse(intent, refusalOf(e), "leverage");
    } finally {
      if (!held) deps.budget.release(0n);
    }
    return refuse(
      intent,
      { rule: "perp-leverage-unset", detail: `${intent.market} was just set isolated at ${levText(m.imfBp)} at Lighter; the open waits for the account to read it` },
      "leverage",
    );
  }

  /** A secure withdrawal of free cross collateral (L2, the API key): it can only pay the account's own L1 address. */
  async function withdrawLive(intent: PerpMarginIntent, side: LiveSide): Promise<PerpOutcome> {
    const h = side.handle as LiveHandle;
    const free = side.snap?.account?.collateralMicro ?? null;
    if (free === null) return refuse(intent, { rule: "perp-unpriced", detail: "the Lighter account is unread, so the free collateral is unknown" }, "withdraw");
    const amount = intent.amountUsdg > free ? free : intent.amountUsdg;
    try {
      const tx = await h.executor.requestWithdraw(amount, free, { initiator: "agent", decisionId: intent.decisionId ?? null });
      if (tx.rowStatus === "rejected" || tx.rowStatus === "app-error") return refuse(intent, { rule: "perp-venue-refused", detail: tx.detail }, "withdraw");
      await say("ok", `perps: asked Lighter to send ${usdgText(amount)} USDG of free collateral home — it arrives after the venue's withdrawal delay and a claim.`);
      return { status: "submitted" };
    } catch (e) {
      return refuse(intent, refusalOf(e), "withdraw");
    }
  }

  // ── the protective pass ─────────────────────────────────────────────────

  async function announceTick(ev: PerpTickEvent): Promise<void> {
    const key = perpMarketById(ev.marketId)?.key ?? `market ${ev.marketId}`;
    let line: string | null = null;
    let level: "ok" | "warn" | "err" = "ok";
    switch (ev.kind) {
      case "funding":
        // Hourly, and summed in the daily report later: one line an hour
        // would bury everything else the owner needs to see.
        log(`${key} funding ${ev.outcome} ${usdgText(ev.paymentMicro, true)} USDG`);
        return;
      case "sl":
        if (ev.outcome === "gapped") {
          level = "warn";
          line =
            `perps (paper): the ${key} stop was gapped through — the price jumped past its bound, the position is still ` +
            `open, and the protective loop is watching it (it re-places a stop or closes it).`;
        } else {
          level = "warn";
          line = `perps (paper): the ${key} stop fired — ${ev.outcome === "reduced" ? "part of the position" : "the position"} closed, realized ${usdgText(ev.realizedMicro, true)} USDG.`;
        }
        break;
      case "tp":
        // THE TAKE-PROFIT'S TRUE OUTCOME (the review's R3-TP-GAPPED-SAYS-
        // FILLED): a take that fired and found nothing inside its bound
        // filled NOTHING — the position is still open and the take is spent —
        // and a part-fill closed only part. Saying "filled, realized +0.00"
        // for either told the owner a position was gone that was not.
        if (ev.outcome === "gapped") {
          level = "warn";
          line =
            `perps (paper): the ${key} take-profit fired but found nothing inside its bound — nothing filled, the position is ` +
            `still open with its stop, and the take-profit is used up.`;
        } else if (ev.outcome === "reduced") {
          line = `perps (paper): the ${key} take-profit part-filled — part of the position closed, realized ${usdgText(ev.realizedMicro, true)} USDG; the rest stays open with its stop.`;
        } else {
          line = `perps (paper): the ${key} take-profit filled — the position closed, realized ${usdgText(ev.realizedMicro, true)} USDG.`;
        }
        break;
      case "liq":
        level = "err";
        line =
          `perps (paper): ${key} was ${ev.outcome === "taken-over" ? "taken over by the venue" : "liquidated"} — realized ` +
          `${usdgText(ev.realizedMicro, true)} USDG, ${usdgText(ev.feeMicro)} USDG to the liquidation fee.`;
        break;
    }
    if (line === null) return;
    await say(level, line);
  }

  /**
   * WHAT THE PAPER VENUE'S CLOCK COULD NOT RUN, said — once per episode, not
   * once a pass. It used to be discarded, so an owed funding hour the feed did
   * not carry was invisible to the owner and the report alike (the review's
   * R3-PAPER-FUNDING-GAP). A funding gap is the owner's to know (the
   * practice book has stopped charging that position until the hour is in the
   * feed) and makes that position's funding unread in `agents.perps`; a
   * crossed stop waiting for a fresh book is the owner's to know too. A
   * market with no fresh mark or funding this pass is a price outage, which
   * P7 already alerts on at 2 and 10 minutes: logged, not announced.
   */
  async function noteTickUnread(unread: readonly PerpTickUnread[]): Promise<void> {
    const seen = new Set<string>();
    const gaps = new Map<number, number>();
    for (const u of unread) {
      const key = `${u.marketId}|${u.kind}|${u.sinceHour ?? ""}`;
      seen.add(key);
      if (u.kind === "funding-gap" && u.sinceHour !== undefined) gaps.set(u.marketId, u.sinceHour);
      if (tickUnreadKeys.has(key)) continue;
      const mk = perpMarketById(u.marketId)?.key ?? `market ${u.marketId}`;
      let line: string | null = null;
      if (u.kind === "funding-gap" && u.sinceHour !== undefined) {
        const at = new Date(u.sinceHour * 1000).toISOString().replace(/:00\.000Z$/, " UTC").replace("T", " ");
        line =
          `perps (paper): ${mk}'s funding from ${at} could not be charged — the Lighter feed does not carry that hour. ` +
          `Every hour before it was charged; nothing after it is until the feed carries it or the position closes, and ` +
          `its funding shows as unread meanwhile rather than as zero.`;
      } else if (u.kind === "book") {
        line = `perps (paper): on ${mk}, ${u.why} — it is filled against the first fresh book, and the protective loop is watching the position.`;
      }
      log(`${mk} venue clock: ${u.kind} — ${u.why}`);
      if (line === null) continue;
      await say("warn", line);
    }
    tickUnreadKeys = seen;
    fundingGaps = gaps;
  }

  /** One paper pass: the paper venue's clock, then the backstop. `a` may be a retained agent (the book keeps its clock after a kill). */
  async function paperProtectLocked(a: PerpLaneAgent, r0: PerpLaneRead, signal: AbortSignal): Promise<void> {
    let r = r0;
    const cfg = deps.config();
    const epoch = await deps.store.getAgentEpoch(a.agentId);
    const ex = executorFor(a, epoch);

    // ── THE PAPER VENUE'S OWN CLOCK: funding, resting stops and takes, liquidation ──
    const nowMs = deps.now();
    const t = await ex.tick?.(nowMs);
    const reread = async () => (deps.armed() !== null ? readLocked() : readRetainedPaper(a));
    if (t) {
      for (const ev of t.events) if (ev.booked === "booked") await announceTick(ev);
      const failKey = t.failed ? `${t.failed.marketId}|${t.failed.kind}|${t.failed.error}` : null;
      if (failKey !== null && failKey !== tickFailureKey) {
        await say(
          "err",
          `perps (paper): the venue's clock could not book ${t.failed?.kind} on ${perpMarketById(t.failed?.marketId ?? -1)?.key ?? "a market"} — ` +
            `${t.failed?.error}. Nothing moved; it is tried again on the next pass.`,
        );
      }
      tickFailureKey = failKey;
      const gapsBefore = [...fundingGaps].join();
      await noteTickUnread(t.unread);
      // Re-read after a booking — or when the funding that reads unread
      // changed, so the report says it from this pass on.
      if (t.events.some((e) => e.booked === "booked") || [...fundingGaps].join() !== gapsBefore) r = await reread();
    }

    // ── THE BACKSTOP ─────────────────────────────────────────────────────
    const nowSec = Math.floor(deps.now() / 1000);
    const out = evaluateProtection({ view: r.view ?? null, nowSec, settings: cfg, prior: protectMemory, feedFresh: r.feedFresh, book: "paper" });
    protectMemory = out.memory;
    for (const act of out.actions) {
      if (signal.aborted) break;
      if (act.kind === "alert") {
        await say("warn", `perps: ${act.text}`);
        continue;
      }
      if (act.kind === "replace-stop") {
        try {
          await ex.setStop?.(act.marketId, { trigger: act.trigger, price: act.price });
          const d = r.view?.facts.positions.get(act.market)?.decimals;
          const px = (v: bigint) => (d ? renderScaled(v, d.priceDecimals) : v.toString());
          await say("ok", `perps (paper): a stop was put back under the ${act.market} ${act.side} at ${px(act.trigger)} (fills no worse than ${px(act.price)}).`);
        } catch (e) {
          log(`${act.market} stop not re-placed: ${errText(e)}`);
        }
        continue;
      }
      await protectiveClose(a, act, r);
    }
    await reread();
  }

  /** A protective CLOSE: a decision row (hard-risk-exit by its Why), then the same lane every perp intent takes. */
  async function protectiveClose(a: PerpLaneAgent, act: Extract<ProtectAction, { kind: "close" }>, r: PerpLaneRead): Promise<void> {
    const intent: PerpOrderIntent = { ...act.intent };
    const stamped = await deps.decide(intent, "perp-route", renderWhy(act.why, "public"), { whyCode: act.why.code });
    if (!stamped.ok) log(`${act.market} protective close not stamped: ${stamped.why} — sent anyway (an exit is always attemptable)`);
    await executeLocked(intent, { equityUsdg: 0n, equityKnown: false }, undefined, { agent: a, read: r });
  }

  /** The retained agent's paper book (after a kill or an expiry): its practice positions keep the venue's clock. */
  async function readRetainedPaper(a: PerpLaneAgent): Promise<PerpLaneRead> {
    const cfg = deps.config();
    // Not armed: the rail is the account's refusal, so nothing opens; what is
    // held is still valued, clocked and exited on its rules.
    const rail: PerpsMode = { mode: "refuse", rule: "not-armed" };
    return readPaperLocked(a, cfg, rail, deps.now());
  }

  /**
   * ONE LIVE PASS — the exits-only lane's heart (rule 8a). On the read the
   * pass took (a light read, or a full reconcile when the last one is a
   * minute old): protect.ts's actions through the live executor; a stop that
   * a replacement of ours superseded cancelled only once the new one reads
   * resting; and, when the live rail is NOT on (perps or live switched off, a
   * kill, an expiry), the housekeeping of an exits-only account — resting
   * orders that could open cancelled, free collateral home once flat. A live
   * rail that is on sends idle collateral home after 24 h flat.
   */
  async function liveProtectLocked(a: PerpLaneAgent, r: PerpLaneRead, signal: AbortSignal): Promise<void> {
    const side = live;
    if (side === null || side.handle === null || !side.keyOk) return;
    const h = side.handle;
    const cfg = deps.config();
    const nowMs = deps.now();
    const nowSec = Math.floor(nowMs / 1000);
    const out = evaluateProtection({ view: r.view ?? null, nowSec, settings: cfg, prior: liveProtectMemory, feedFresh: r.feedFresh, book: "live" });
    liveProtectMemory = out.memory;
    for (const act of out.actions) {
      if (signal.aborted) break;
      if (act.kind === "alert") {
        await say("warn", `perps: ${act.text}`);
        continue;
      }
      if (act.kind === "replace-stop") {
        try {
          const tx = await h.executor.replaceStop(act.marketId, act.side, act.trigger, act.price, { reason: `protective-stop-${act.reason}` });
          if (act.supersedes.length > 0 && tx.rowStatus !== "rejected" && tx.rowStatus !== "app-error") {
            const s = side.supersede.get(act.marketId)?.orders ?? new Set<string>();
            for (const o of act.supersedes) s.add(o);
            side.supersede.set(act.marketId, { replacementClientOrderIndex: perpCoi(tx.nonce, PERP_LEG.sl).toString(), orders: s });
          }
          const d = r.view?.facts.positions.get(act.market)?.decimals;
          const px = (v: bigint) => (d ? renderScaled(v, d.priceDecimals) : v.toString());
          await say(
            tx.rowStatus === "rejected" || tx.rowStatus === "app-error" ? "err" : "ok",
            tx.rowStatus === "rejected" || tx.rowStatus === "app-error"
              ? `perps: a stop under the ${act.market} ${act.side} was refused by Lighter (${tx.detail}); the protective loop tries again.`
              : `perps: a stop was put back under the ${act.market} ${act.side} at Lighter at ${px(act.trigger)} (fills no worse than ${px(act.price)}).`,
          );
        } catch (e) {
          log(`${act.market} live stop not re-placed: ${errText(e)}`);
        }
        continue;
      }
      await protectiveClose(a, act, r);
    }

    // ── A SUPERSEDED STOP GOES ONLY ONCE ITS REPLACEMENT READS RESTING ──
    for (const [marketId, pending] of side.supersede) {
      if (signal.aborted) break;
      const key = perpMarketById(marketId)?.key;
      const f = key !== undefined ? r.view?.facts.positions.get(key) : undefined;
      if (f === undefined) {
        // Flat: the venue ends position-tied orders itself; nothing to keep.
        side.supersede.delete(marketId);
        continue;
      }
      if (f.stopState !== "resting") continue;
      // This pass's read may still show only the old stop, including after
      // an accepted send. Wait for the exact replacement we signed to be
      // the confirmed resting stop before retiring any of its predecessors.
      const replacement = side.snap?.orders?.find((o) => o.clientOrderIndex === pending.replacementClientOrderIndex);
      if (replacement === undefined || f.restingStopOrder !== replacement.orderIndex) continue;
      const orders = pending.orders;
      for (const o of [...orders]) {
        if (o === f.restingStopOrder || !f.otherStopOrders.includes(o)) {
          orders.delete(o);
          continue;
        }
        try {
          const tx = await h.executor.cancelOrder(marketId, BigInt(o), { reason: "superseded-stop" });
          if (tx.rowStatus !== "rejected" && tx.rowStatus !== "app-error") orders.delete(o);
        } catch (e) {
          log(`superseded stop ${o} not cancelled: ${errText(e)}`);
        }
      }
      if (orders.size === 0) side.supersede.delete(marketId);
    }

    const acct = side.snap?.account ?? null;
    if (acct === null || signal.aborted) return;
    const railOn = r.rail.mode === "live";
    // ── EXITS-ONLY: nothing resting that could open ──
    if (!railOn && side.snap?.orders) {
      for (const o of side.snap.orders) {
        if (o.reduceOnly || !ACTIVE_ORDER.has(o.status)) continue;
        const last = side.cancelledAt.get(o.orderIndex);
        if (last !== undefined && nowMs - last < 60_000) continue;
        side.cancelledAt.set(o.orderIndex, nowMs);
        try {
          await h.executor.cancelOrder(o.marketId, BigInt(o.orderIndex), { reason: "exits-only" });
          log(`exits-only: cancelled resting order ${o.orderIndex} on market ${o.marketId} (not reduce-only)`);
        } catch (e) {
          log(`exits-only cancel of ${o.orderIndex}: ${errText(e)}`);
        }
      }
    }
    // ── FREE COLLATERAL HOME once flat: at once when exits-only, after 24 h flat on a live rail ──
    // Funding/key/reconcile readiness can temporarily refuse an otherwise
    // enabled live rail. That wait is not an owner request to return its new
    // deposit. Keep cancellation above tied to full readiness; only collateral
    // timing uses the underlying consent, operator and permission eligibility.
    const idleReturn = railOn || (r.rail.mode === "refuse" && r.rail.rule === "perp-venue-unready" &&
      isLiveRailOn(a) && a.limits.expiresAt * 1000 > nowMs && !r.policy?.incident && !side.snap?.rec?.incident);
    const flat = !acct.positions.some((p) => p.baseAmount !== 0n) && acct.totalOrderCount === 0 && acct.pendingOrderCount === 0;
    const flatLongEnough = side.flatSinceMs !== null && nowMs - side.flatSinceMs >= LIVE_LANE_TIMING.flatWithdrawMs;
    if (flat && acct.collateralMicro > 0n && (!idleReturn || flatLongEnough)) {
      try {
        const tx = await h.executor.requestWithdraw(acct.collateralMicro, acct.collateralMicro, { initiator: "agent", reason: idleReturn ? "flat-24h" : "exits-only" });
        if (tx.rowStatus !== "rejected" && tx.rowStatus !== "app-error") {
          await say(
            "ok",
            `perps: ${idleReturn ? "the Lighter account has been flat for a day, so" : "nothing is open at Lighter any more, so"} its free ` +
              `collateral (${usdgText(acct.collateralMicro)} USDG) was asked home — it arrives after the venue's withdrawal delay and a claim.`,
          );
        }
      } catch (e) {
        // perp-withdraw-in-flight: an earlier one has no outcome yet — asked again next pass.
        if (!(e instanceof PerpRefused && e.rule === "perp-withdraw-in-flight")) log(`free collateral not asked home: ${errText(e)}`);
      }
    }
  }

  async function protectLocked(signal: AbortSignal): Promise<void> {
    const a = agentNow();
    if (a !== null) {
      const r = await readLocked({ exitsOnly: true });
      if (r.bookMode === "paper") {
        if (r.active) await paperProtectLocked(a, r, signal);
        // A live venue with exposure on a paper account: exits only (rule 8a).
        if (live !== null && live.exposure && !signal.aborted) {
          const lr = await readLiveLocked(a, deps.config(), deps.execMode(), deps.now(), true);
          await liveProtectLocked(a, lr, signal);
        }
      } else if (r.active) {
        await liveProtectLocked(a, r, signal);
      }
    } else if (retained !== null) {
      // NOT ARMED (a kill, an expiry): what was held keeps its protection.
      const kept = retained;
      retainedPaperHeld = false;
      if (retainedBook === "paper") {
        try {
          const pr = await readRetainedPaper(kept);
          retainedPaperHeld = pr.held;
          if (pr.held) await paperProtectLocked(kept, pr, signal);
        } catch (e) {
          // Unread is not empty: the book is kept, and asked about next pass.
          retainedPaperHeld = true;
          log(`retained paper book: ${errText(e)}`);
        }
      }
      if (live !== null && !signal.aborted) {
        const lr = await readLiveLocked(kept, deps.config(), deps.execMode(), deps.now(), true);
        lastRead = lr;
        if (lr.exposure === true) await liveProtectLocked(kept, lr, signal);
      }
    } else {
      return;
    }
    protectAtMs = deps.now();
    // The report and the next reader see the book as this pass left it.
    if (deps.armed() !== null) await readLocked();
  }

  /** Is the retained agent's book empty everywhere — so there is nothing left to protect, and the key can be let go? */
  function retainedIdle(): boolean {
    if (deps.armed() !== null) return false;
    const liveHeld = live !== null && live.exposure;
    return !liveHeld && !retainedPaperHeld;
  }

  // ── the route ───────────────────────────────────────────────────────────

  async function runRoute<C extends { ok: boolean }>(t: PerpRouteTick, hooks: PerpRouteHooks<C>): Promise<void> {
    const a = agentNow();
    // One-shot: a window's strategist intents are this tick's or nobody's.
    const handoff = strategistIntents;
    strategistIntents = [];
    if (a === null) return;
    // THE TICK'S OWN READ — the view Snapshot.perps carried, which the
    // strategist also saw — never a pass's newer one: the route decides on
    // what its producers were shown, and every intent is re-judged against a
    // fresh read when it is executed anyway.
    const r = tickRead;
    if (r === null || !r.active) return;
    const cfg = deps.config();
    // ONE WRITER PER BOOK: `strategist` without a real model behind it is
    // nobody, so it is manual — never a fall back to perp-trend.
    const driver = cfg.perpsDriver === "strategist" && !t.strategistLive ? "manual" : cfg.perpsDriver;
    const out = runPerpRoute({
      view: r.view,
      settings: cfg,
      driver,
      perpTrendCtx: {
        equityMicro: t.equityKnown ? t.equityUsdg : null,
        breakerIdle: t.breakerIdle,
        breakerLimitBps: t.breakerLimitBps ?? null,
        energyEntriesLeft: t.energyEntriesLeft,
        opsHeadroom: t.opsHeadroom,
        spendHeadroomMicro: t.spendHeadroomMicro,
        perTradeSealedMicro: a.limits.perTradeUsdg,
        nowSec: Math.floor(deps.now() / 1000),
      },
      strategistPerpIntents: handoff,
    });
    for (const d of out.dropped) log(`strategist ${labelOf(d.intent)} dropped: ${d.why}`);
    const source = out.source ?? "perp-route";
    const all: { intent: PerpRouteIntent; why: Why | null }[] = [
      ...out.exits.map((intent, i) => ({ intent, why: out.why[i] ?? null })),
      ...(out.entry !== null ? [{ intent: out.entry, why: out.why[out.exits.length] ?? null }] : []),
    ];
    pendingLeg = null;
    // EXITS FIRST, THEN THE ONE ENTRY — each the class route's shape.
    for (const { intent: draft, why } of all) {
      const intent = { ...draft } as TradeIntent;
      const entry = countsAsEntry(intent.kind, isExitIntent(intent, a.limits));
      const claim = entry ? await hooks.claimEntry() : null;
      if (claim !== null && !claim.ok) {
        await hooks.withholdEntry();
        continue;
      }
      const stamped = await hooks.ensureDecision(intent, source, why ? renderWhy(why, "public") : undefined, why ? { whyCode: why.code } : undefined);
      if (!stamped.ok) {
        await hooks.refundEntry(claim);
        continue;
      }
      if (entry) {
        // Admission and the decision must succeed before this signal is spent.
        // A temporary energy-claim race or failed journal stamp sent nothing;
        // the next tick must be able to reconsider it against fresh gates.
        // Once execution starts, retain the bar even for an unknown outcome;
        // only the explicit onboarding waits below release it for another try.
        if (out.entryCandleT !== null && draft.kind === "perp-order") entryCandles.set(draft.market, out.entryCandleT);
        const facts = await hooks.processIntentReporting(intent);
        if (!tradeConsumesSnapshot(facts?.status)) await hooks.refundEntry(claim);
        // AN ENTRY HELD BACK WHILE THE VENUE IS MADE READY KEEPS ITS BAR: the
        // deposit, key or leverage it waits on is this tick's leg, and the
        // same signal is proposed again next tick until it can go (or the
        // bar ends). Spending the bar here would make every first open fail.
        if (facts?.status === "rejected" && facts.rejectRule !== undefined && WAITING_RULES.has(facts.rejectRule) && draft.kind === "perp-order") {
          entryCandles.delete(draft.market);
        }
      } else {
        await hooks.processIntent(intent);
      }
    }
    // ── THE ONBOARDING LEG, at most one a tick (onboard.ts's order) ──
    await sendLeg(a, hooks);
    // WHY NO ENTRY, once per change and to the owner only — every perp idle
    // code is withheld from publication (reasons.ts publishesIdle).
    const idle = out.idle;
    const idleKey = idle === null ? null : JSON.stringify(idle, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    if (idleKey !== lastIdleKey) {
      lastIdleKey = idleKey;
      if (idle !== null && idle.code !== "perp-no-signal") await say("ok", `perps: no new position — ${renderWhy(idle, "owner")}`);
    }
  }

  /**
   * THE NEXT ON-CHAIN LEG — through index.ts's UserOp rail (processIntent-
   * Reporting: the policy, the fence, the durable row before broadcast, the
   * resolver), never the lock. The deposit or key an open just asked for
   * first; otherwise the steady plan's: a key registration the account can
   * take now (C > 0), or a claim that is due. A deposit is NEVER volunteered
   * here: it exists only to fund the open that asked.
   */
  async function sendLeg<C extends { ok: boolean }>(a: PerpLaneAgent, hooks: PerpRouteHooks<C>): Promise<void> {
    let leg = pendingLeg;
    pendingLeg = null;
    const idxRaw = deps.live?.accountIndex() ?? null;
    if (leg === null && deps.live !== undefined && idxRaw !== null && idxRaw > 0n) {
      let led: Awaited<ReturnType<typeof liveLedger>> | null = null;
      try {
        led = await liveLedger(a, Math.floor(deps.now() / 1000));
      } catch {
        led = null;
      }
      const side = live !== null && live.accountIndex === Number(idxRaw) ? live : null;
      const step = await onboardingStep(a, { led, account: side?.snap?.account ?? null, idx: Number(idxRaw) }, side, tickRead?.view ?? null, null);
      const steady = legOf(step);
      if (steady !== null) {
        if (steady.intent.kind === "perp-key") {
          // Only a key this worker can then USE (the handle opened: key file,
          // signer, client), and only on a rail that would trade with it.
          if (side?.handle !== null && side !== null && tickRead?.legPolicy?.mode === "live") leg = steady;
        } else if (steady.intent.kind === "perp-margin" && steady.intent.direction === "claim") {
          // A claim pays this account and no other; it waits on nothing.
          leg = steady;
        }
        // A deposit is never volunteered: it only funds the open that asked.
      }
    }
    if (leg === null) return;
    // A KEY IS REGISTERED ONLY FOR A HANDLE THAT OPENED — the key file loaded,
    // the signer passed its KAT, the client exists — so the key registered is
    // one this worker can then sign with; a deposit only for a key that loads.
    if (leg.intent.kind === "perp-key" && (live === null || live.handle === null)) return;
    if (leg.intent.kind === "perp-margin" && leg.intent.direction === "deposit") {
      const sealed = perpGrantOf(a.limits)?.apiPublicKey ?? null;
      if (sealed === null || !keyLoadable(sealed)) return;
    }
    const intent = { ...leg.intent } as TradeIntent;
    const stamped = await hooks.ensureDecision(intent, "perp-route", leg.why);
    if (!stamped.ok) {
      log(`onboarding leg not stamped: ${stamped.why}`);
      return;
    }
    const facts = await hooks.processIntentReporting(intent);
    log(`onboarding leg ${intent.kind === "perp-key" ? "perp-key" : `perp-${(intent as PerpMarginIntent).direction}`}: ${facts?.status ?? "no facts"}${facts?.rejectRule ? ` (${facts.rejectRule})` : ""}`);
    if (intent.kind === "perp-key" && facts?.status === "landed" && live !== null) live.keyLegLandedAtMs = deps.now();
  }

  // ── the stand-down ──────────────────────────────────────────────────────

  /**
   * THE STAND-DOWN, RUN (rule 13; standdown.ts). Latches the lane (every
   * intent refused `perp-standing-down`) and the protective loop off while it
   * runs — standdown.ts's caller's latch — after the lock's current holder
   * finishes; reads move to the exit budget. The owner's message is built from
   * the RESULT, through custodySentence, never a constant.
   */
  async function standdownNow(reason: StanddownReason, nonce: string | undefined, notAfterMs?: number): Promise<StanddownResult | null> {
    const L = deps.live;
    const side = live;
    const a = side?.agent ?? laneAgent();
    const nowMs = deps.now();
    const home = L?.home() ?? null;
    if (side === null || side.handle === null || a === null) {
      // NOTHING TO HOLD THE KEY WITH. With no venue account at all (the chain
      // says 0) that is the truth — nothing is on Lighter; otherwise what is
      // left is unknown, and the owner is sent to recover.
      const idx = L?.accountIndex() ?? null;
      const nothing = idx === 0n && side === null;
      const result: StanddownResult = nothing
        ? {
            reason,
            startedAt: nowMs,
            finishedAt: nowMs,
            deadlineMs: nowMs,
            outcome: "done",
            closed: [],
            residual: [],
            ordersLeft: 0,
            withdrawRequestedMicro: null,
            failedSteps: [],
            ingested: true,
            venue: { readAt: nowMs, final: true, collateralMicro: 0n, isolatedMarginMicro: 0n, poolShareCount: 0, spotBalanceCount: 0 },
          }
        : {
            reason,
            startedAt: nowMs,
            finishedAt: nowMs,
            deadlineMs: nowMs,
            outcome: "unreachable",
            closed: [],
            residual: [],
            ordersLeft: null,
            withdrawRequestedMicro: null,
            failedSteps: [side?.failure?.why ?? "the agent's Lighter key is not held by this worker, so nothing could be signed"],
            ingested: false,
            venue: null,
          };
      if (home !== null && nonce !== undefined) writeResultQuietly(home, nonce, result);
      const exposure: PerpExposure = nothing ? { kind: "none" } : { kind: "unread" };
      await say(nothing ? "ok" : "err", `perps stand-down (${reason}): ${custodySentence(exposure)}`);
      return result;
    }
    const h = side.handle;
    latched = true;
    h.exitReads = true;
    // Stamped at the START, so a trigger seen while it runs does not queue another.
    if (reason === "incident") side.incidentStanddownMs = deps.now();
    lastStanddown = { reason, atMs: deps.now() };
    try {
      // The holder of the lock (a send in flight) finishes first; the latch
      // keeps every later one out.
      await lock.run(async () => {}, { label: "stand-down latch" });
      const lines: string[] = [];
      await say("warn", `perps: standing the Lighter positions down (${reason}) — every position is closed reduce-only before any order is cancelled.`);
      const result = await runStanddown({
        reason,
        deadlineMs: Math.min(nowMs + 15 * 60_000, notAfterMs ?? Infinity),
        now: deps.now,
        executor: h.standdownExecutor(async (intent, why) => {
          const r = await deps.decide(intent as TradeIntent, reason === "flatten" ? "chat" : "perp-route", why);
          if (!r.ok) throw new Error(r.why);
        }),
        reconcile: h.standdownReconcile(),
        settings: { maxSlippageBps: deps.config().perpsMaxSlippageBps },
        feed: () => deps.readFeed(deps.now()),
        ...(L?.standdownTuning?.sleep !== undefined ? { sleep: L.standdownTuning.sleep } : {}),
        ...(L?.standdownTuning?.limits !== undefined ? { limits: L.standdownTuning.limits } : {}),
        onStep: (s) => {
          lines.push(standdownStepLine(s));
          if (home !== null && nonce !== undefined) {
            try {
              writeStanddownProgress(home, nonce, lines);
            } catch {
              // progress is advice to the CLI; the result is the record
            }
          }
        },
      });
      if (home !== null && nonce !== undefined) writeResultQuietly(home, nonce, result);
      if (reason === "incident") side.incidentStanddownMs = deps.now();
      lastStanddown = { reason, atMs: deps.now() };
      const exposure = standdownExposure(result, await standdownExtras(a, side));
      await say(result.outcome === "done" ? "ok" : "err", `perps stand-down (${reason}): ${custodySentence(exposure)}`);
      return result;
    } catch (e) {
      // runStanddown throws only on a caller's bad argument — still, the CLI
      // waiting on this request gets an answer, and it is the honest one:
      // what is left is unknown.
      const t = deps.now();
      const result: StanddownResult = {
        reason,
        startedAt: nowMs,
        finishedAt: t < nowMs ? nowMs : t,
        deadlineMs: nowMs,
        outcome: "unreachable",
        closed: [],
        residual: [],
        ordersLeft: null,
        withdrawRequestedMicro: null,
        failedSteps: [`the stand-down stopped: ${errText(e)}`],
        ingested: false,
        venue: null,
      };
      if (home !== null && nonce !== undefined) writeResultQuietly(home, nonce, result);
      await say("err", `perps stand-down (${reason}): ${custodySentence({ kind: "unread" })}`);
      return result;
    } finally {
      latched = false;
      h.exitReads = false;
      loop?.kick();
    }
  }

  function writeResultQuietly(home: string, nonce: string, result: StanddownResult): void {
    try {
      writeStanddownResult(home, nonce, result);
    } catch (e) {
      log(`stand-down result ${nonce} not written: ${errText(e)}`);
    }
  }

  /** What the stand-down cannot know, read now — never defaulted to zero (standdown.ts standdownExposure). */
  async function standdownExtras(a: PerpLaneAgent, side: LiveSide) {
    const L = deps.live as PerpLiveDeps;
    let pendingWithdrawalsMicro: bigint | null = 0n;
    let depositsInTransitMicro: bigint | null = 0n;
    try {
      for (const t of await L.store.listOpenPerpTransfers(a.agentId, "live")) {
        if (t.direction === "withdraw") pendingWithdrawalsMicro += t.amountMicro;
        else if (t.direction === "deposit" && t.state === "landed") depositsInTransitMicro += t.amountMicro;
      }
    } catch {
      // unreadable: the transit from the payout step is the other source
      const tr = L.transit()?.transit ?? null;
      pendingWithdrawalsMicro = tr !== null && !tr.gap ? tr.tOutMicro : null;
      depositsInTransitMicro = tr !== null && !tr.gap ? tr.tInMicro : null;
    }
    let otherAccounts: { count: number; valueMicro: bigint | null } | null = null;
    try {
      const r = await L.publicApi().accountsByL1Address(a.smartAccount);
      if (r.ok) {
        const others = r.value.accounts.filter((x) => x.accountIndex !== side.accountIndex);
        otherAccounts = { count: others.length, valueMicro: others.length === 0 ? 0n : null };
      }
    } catch {
      otherAccounts = null;
    }
    let withdrawalDelaySec: number | null = null;
    try {
      const r = await L.publicApi().withdrawalDelay();
      withdrawalDelaySec = r.ok ? r.value : null;
    } catch {
      withdrawalDelaySec = null;
    }
    return { pendingWithdrawalsMicro, depositsInTransitMicro, otherAccounts, withdrawalDelaySec };
  }

  function standdown(reason: StanddownReason, opts: { nonce?: string; notAfterMs?: number } = {}): Promise<StanddownResult | null> {
    const running = standing;
    if (running !== null) {
      // ONE AT A TIME: a second request shares the running one's result (and
      // gets its own result file under its own nonce).
      return running.then((res) => {
        const home = deps.live?.home() ?? null;
        if (res !== null && home !== null && opts.nonce !== undefined) writeResultQuietly(home, opts.nonce, res);
        return res;
      });
    }
    const run = standdownNow(reason, opts.nonce, opts.notAfterMs).finally(() => {
      standing = null;
    });
    standing = run;
    return run;
  }

  /** A stand-down the last read found due (an incident), started outside the lock. */
  function kickStanddown(): void {
    const r = wantStanddown;
    wantStanddown = null;
    if (r === null || standing !== null) return;
    void standdown(r).catch((e) => log(`stand-down (${r}): ${errText(e)}`));
  }

  // ── the report ──────────────────────────────────────────────────────────

  async function writeReport(r: PerpLaneRead | null): Promise<void> {
    const a = laneAgent();
    if (a === null || r === null) return;
    const json = JSON.stringify(r.report);
    if (json === reportJson) return;
    await deps.store.setAgentPerps(a.agentId, json);
    reportJson = json;
  }

  /** The venue read a live book's read is built from — taken outside the lock — when the account's book is live or the venue holds anything. */
  async function preRead(depth: "full" | "light"): Promise<void> {
    const a = laneAgent();
    // A running stand-down reconciles through the same reconciler itself: a
    // second pass beside it would interleave one instance's cursors.
    if (a === null || deps.live === undefined || latched) return;
    const armedNow = deps.armed() !== null;
    const liveBook = armedNow && bookModeOf(deps.execMode()) === "live";
    // A VENUE ACCOUNT THIS PROCESS HAS NOT LOOKED AT YET is read once whatever
    // the book: an account on paper now (a restart after the rail moved, the
    // last USDG posted as margin) may still hold live positions, and rule 8a
    // keeps their exits running — which needs them seen first. Read, its
    // exposure decides from then on.
    const idx = deps.live.accountIndex();
    const unseen = live === null && idx !== null && idx > 0n;
    if (!liveBook && !(live !== null && live.exposure) && !unseen) return;
    if (depth === "light" && live?.snap && deps.now() - live.snap.atMs <= LIVE_LANE_TIMING.lightMaxAgeMs) return;
    await venueRead(a, depth);
  }

  const lane: PerpLane = {
    lock,
    // The TICK's read: a live book reconciles first (outside the lock), then
    // reads under it; it becomes the view the route decides on, like
    // readWithBook's.
    async refresh() {
      await preRead("full");
      const r = await lock.run(
        async () => {
          const read = await readLocked();
          tickRead = read;
          return read;
        },
        { label: "refresh" },
      );
      kickStanddown();
      return r;
    },
    async readWithBook<T>(read: () => Promise<T>) {
      await preRead("full");
      const out = await lock.run(
        async () => {
          const value = await read();
          const r = await readLocked();
          tickRead = r;
          return { value, read: r };
        },
        { label: "tick read" },
      );
      kickStanddown();
      return out;
    },
    serial: (fn, label) => lock.run(fn, { label: label ?? "paper book" }),
    last: () => lastRead,
    snapshotView: () => tickRead?.view,
    policyState: () => lastRead?.policy,
    policyStateFor(intent) {
      const r = lastRead;
      const leg = (intent.kind === "perp-margin" && intent.direction === "deposit") || intent.kind === "perp-key";
      return leg ? (r?.legPolicy ?? r?.policy) : r?.policy;
    },
    async execute(intent, equity, base) {
      await preRead("light");
      const out = await lock.run(() => executeLocked(intent, equity, base), { label: `execute ${labelOf(intent)}` });
      kickStanddown();
      return out;
    },
    runRoute,
    deliverStrategist(intents) {
      strategistIntents = [...intents];
    },
    async protectPass(ctx) {
      if (laneAgent() === null) return;
      // LATCHED while a stand-down runs (its caller's latch): the stand-down
      // is the only thing sending at Lighter until it ends.
      if (latched) return;
      const stale = live === null || deps.now() - live.lastFullAtMs > LIVE_LANE_TIMING.reconcileEveryMs;
      await preRead(stale ? "full" : "light");
      await ctx.lock.run(() => protectLocked(ctx.signal), { signal: ctx.signal, label: "protect" });
      await writeReport(deps.armed() !== null ? lastRead : (liveRead ?? lastRead));
      kickStanddown();
      // THE GRANT RAN OUT WHILE ARMED OR RETAINED: expiry stands it down with
      // the key still held (rule 13), once.
      const a = laneAgent();
      if (a !== null && live !== null && live.exposure && live.handle !== null && Math.floor(deps.now() / 1000) >= a.limits.expiresAt && standing === null) {
        if (live.said.has("expiry-standdown") === false) {
          live.said.add("expiry-standdown");
          void standdown("expiry").catch((e) => log(`stand-down (expiry): ${errText(e)}`));
        }
      }
      if (retainedIdle() && retained !== null) {
        log(`${retained.agentId.slice(0, 10)}: nothing left to protect after the grant ended — the key is let go`);
        retained = null;
        live = null;
      }
    },
    startProtect() {
      if (loop !== null) return;
      loop = startProtectLoop({
        // 15 s while anything is held or unread (protect.ts), 60 s with the
        // lane off — the pass is then a ledger read that finds nothing (never
        // a Lighter read: an inactive lane reads no feed and no venue), and
        // runs so that the moment the lane turns on is noticed within a minute.
        intervalMs: () => {
          const r = liveRead !== null && live?.exposure ? liveRead : lastRead;
          return r?.active ? protectCadenceMs(r.view ?? null) : PROTECT_THRESHOLDS.idleIntervalMs;
        },
        run: (ctx) => lane.protectPass(ctx),
        lock,
        onError: (e) => log(`protect pass: ${errText(e)}`),
      });
    },
    async stopProtect() {
      const l = loop;
      loop = null;
      if (l !== null) await l.stop();
    },
    get protecting() {
      return loop !== null;
    },
    async armed() {
      forget();
      // A handle that could not open (a key file the owner has since put in
      // place) is tried again at every arm.
      if (live !== null && live.failure !== null) live.failure = null;
      // THE LOOP STARTS WITH THE FIRST ARM, WHATEVER THE LANE SAYS NOW, and
      // before anything here can throw. It used to start only when the lane
      // was active or perps on at that moment — but the lane can turn on
      // later with no arm and no settings change to notice it: execMode
      // flipping live → paper over a practice book still held (live and
      // paper trading switches are in neither re-arm key; a cash or gas read
      // of 0 moves the rail by itself). The paper venue's clock — its stops,
      // take-profits, liquidation and funding — runs only inside the pass, so
      // that book was valued and traded while nothing could fire its stop
      // (the review's S3-02). An idle pass is one ledger read a minute.
      lane.startProtect();
      // RECONCILE BEFORE ANY OPEN (reconcile.ts arm step): the live venue is
      // read and the ledger's continuity judged here, at the arm, outside the
      // lock. Not the tick's read: the route decides only on what a tick read.
      await preRead("full");
      const r = await lock.run(readLocked, { label: "arm" });
      await writeReport(r);
      kickStanddown();
    },
    async configChanged() {
      lastRefusalKey = null;
      lastIdleKey = null;
      lane.startProtect();
      const r = await lock.run(readLocked, { label: "settings" });
      await writeReport(r);
    },
    async resetPaper<T>(reset: () => Promise<T>) {
      return lock.run(
        async () => {
          const out = await reset();
          // The book those memories were about is gone: a breach clock, a
          // cooldown or an entry candle carried across would act on nothing.
          const keepRail = railKey;
          forget();
          railKey = keepRail;
          await readLocked();
          return out;
        },
        { label: "paper reset" },
      );
    },
    report: () => writeReport(lastRead),
    ownerReport: () => lock.run(async () => {
      const a = laneAgent();
      if (a !== null && deps.live !== undefined && live !== null && (live.exposure || live.snap?.account?.positions.some((p) => p.baseAmount !== 0n))) {
        const r = await readLiveLocked(a, deps.config(), deps.execMode(), deps.now(), true);
        return { ...r.report, mode: "live" };
      }
      return lastRead ? { ...lastRead.report, mode: lastRead.bookMode } : null;
    }, { label: "owner perpetual report" }),
    feedMarketIds() {
      const cfg = deps.config();
      // What is HELD is always carried (its stop and its liquidation are
      // watched whatever the switch says); the allowed markets only while
      // perps are on.
      const ids = new Set<number>(lane.heldMarketIds());
      if (cfg.perpsEnabled) {
        for (const k of cfg.perpsMarkets) {
          const id = perpMarketByKey(k)?.marketId;
          if (id !== undefined) ids.add(id);
        }
      }
      return [...ids].sort((x, y) => x - y);
    },
    heldMarketIds() {
      const ids = new Set<number>(lastHeldMarkets);
      for (const p of liveRead?.view?.positions.values() ?? []) ids.add(p.marketId);
      for (const p of live?.snap?.account?.positions ?? []) if (p.baseAmount !== 0n && perpMarketById(p.marketId) !== null) ids.add(p.marketId);
      return [...ids].sort((x, y) => x - y);
    },
    standdown,
    async close(market, opts = {}) {
      if (perpMarketByKey(market) === null) return { ok: false, sentence: "That perpetual market is not supported." };
      await preRead("light");
      return lock.run(async () => {
        if (opts.notAfterMs !== undefined && deps.now() >= opts.notAfterMs) return { ok: false, sentence: "This close request expired before it could run; no order was sent." };
        const a = laneAgent();
        if (a === null) return { ok: false, sentence: "There is no agent key available to close a perpetual position." };
        const cfg = deps.config();
        let r = await readLocked();
        if (opts.book === "paper" && r.bookMode !== "paper") r = await readRetainedPaper(a);
        if (deps.live !== undefined && live !== null) {
          const lr = await readLiveLocked(a, cfg, deps.execMode(), deps.now(), true);
          if (opts.book === undefined && lr.view?.positions.has(market)) {
            const paperRows = await deps.store.getPerpPositions(a.agentId, "paper");
            if (paperRows.some((p) => p.marketId === perpMarketByKey(market)!.marketId && p.base > 0n)) {
              return { ok: false, sentence: `${market} is held in both the real and practice books. Choose which book to close on the dashboard; no order was sent.` };
            }
          }
          if (opts.book === "live" || (opts.book === undefined && lr.view?.positions.has(market))) r = lr;
        }
        if (opts.book === "live" && r.bookMode !== "live") return { ok: false, sentence: "The real-money perpetual book could not be read; no order was sent." };
        const pos = r.view?.positions.get(market);
        const m = r.view?.markets.get(market);
        if (pos === undefined || m === undefined) return { ok: false, sentence: `${market}: no readable position is available to close; no order was sent.` };
        const draft = buildExitDraft({ market: m, position: pos, effect: "close", maxSlippageBps: Math.min(450, Math.max(cfg.perpsMaxSlippageBps, 150)) });
        if (draft === null) return { ok: false, sentence: `${market}: the exit price could not be read; its protection stays in place.` };
        const intent = { ...draft } as PerpOrderIntent;
        await deps.decide(intent, "chat", `the owner asked to close ${market} reduce-only`);
        const out = await executeLocked(intent, { equityUsdg: 0n, equityKnown: false }, undefined, { agent: a, read: r, notAfterMs: opts.notAfterMs });
        if (out.status === "paper") {
          try {
            const held = await deps.store.getPerpPositions(a.agentId, "paper");
            if (held.some((p) => p.marketId === m.marketId && p.base > 0n)) {
              return { ok: false, sentence: `${market}: the practice close filled partially; a position remains open.` };
            }
            return { ok: true, sentence: `${market}: the practice position was closed.` };
          } catch {
            return { ok: false, sentence: `${market}: a practice close was recorded, but the remaining position could not be read.` };
          }
        }
        const ok = out.status === "submitted" || out.status === "landed";
        return {
          ok,
          sentence: ok ? `${market}: a real-money reduce-only close was submitted; the venue fill still needs confirmation.`
              : `${market}: no close was confirmed${out.rejectRule ? ` (${out.rejectRule})` : ""}; its protection stays in place.`,
        };
      }, { label: `owner close ${market}` });
    },
    async resumeEntries(mode, opts = {}) {
      return lock.run(async () => {
        if (opts.notAfterMs !== undefined && deps.now() >= opts.notAfterMs) return { ok: false, sentence: "This resume request expired; entries remain paused." };
        const a = agentNow();
        if (a === null || (mode !== "paper" && mode !== "live")) return { ok: false, sentence: "An armed agent and a valid book are required to resume entries." };
        if (latched || standing !== null) return { ok: false, sentence: "Wait for the perpetual stand-down to finish before resuming entries." };
        const liveStore = deps.live?.store;
        if (mode === "live" ? liveStore === undefined : deps.store.getPerpAccount === undefined || deps.store.patchPerpAccount === undefined) return { ok: false, sentence: "The perpetual ledger is unavailable; entries remain paused." };
        const account = mode === "live" ? await liveStore!.getPerpAccount(a.agentId, "live") : await deps.store.getPerpAccount!(a.agentId, "paper");
        if (account?.incident != null) return { ok: false, sentence: "The perpetual key incident must be resolved before entries can resume." };
        if (opts.notAfterMs !== undefined && deps.now() >= opts.notAfterMs) return { ok: false, sentence: "This resume request expired; entries remain paused." };
        if (mode === "live") await liveStore!.patchPerpAccount(a.agentId, "live", { entriesHalted: false });
        else await deps.store.patchPerpAccount!(a.agentId, "paper", { entriesHalted: false });
        ownerEntryHalts.delete(`${a.agentId}:${mode}`);
        await readLocked();
        return { ok: true, sentence: `${mode === "paper" ? "Practice" : "Live"} perpetual entries are resumed, subject to your trading settings and limits.` };
      }, { label: "resume perpetual entries" });
    },
    async flatten(opts = {}) {
      if (opts.notAfterMs !== undefined && deps.now() >= opts.notAfterMs) return { ok: false, sentence: "This flatten request expired before it could run." };
      await preRead("light");
      const a = laneAgent();
      if (a === null) return { ok: false, sentence: "Nothing is armed, so there are no perpetual positions to close." };
      if (opts.book === undefined && live?.exposure) {
        const paperRows = await deps.store.getPerpPositions(a.agentId, "paper");
        if (paperRows.some((p) => p.base > 0n)) return { ok: false, sentence: "There are both real and practice perpetual holdings. Choose a book to flatten on the dashboard; no orders were sent." };
      }
      const bookLive = opts.book === "live" || (opts.book === undefined && (deps.armed() === null || bookModeOf(deps.execMode()) === "live" || (live !== null && live.exposure)));
      if (bookLive) {
        const L = deps.live;
        ownerEntryHalts.add(`${a.agentId}:live`);
        let haltSaved = false;
        // The halt first: whatever the stand-down finds, no entry follows it.
        try {
          await L?.store.patchPerpAccount(a.agentId, "live", { entriesHalted: true });
          haltSaved = L !== undefined;
        } catch (e) {
          log(`entries halt not stored: ${errText(e)}`);
        }
        const res = await standdown("flatten", { notAfterMs: opts.notAfterMs });
        const side = live;
        if (res === null) return { ok: false, sentence: "The Lighter positions could not be stood down." };
        const exposure = side !== null ? standdownExposure(res, await standdownExtras(a, side)) : ({ kind: "unread" } as PerpExposure);
        return {
          ok: res.outcome === "done" && haltSaved,
          sentence: `${haltSaved ? "New perpetual positions are paused until you resume them on the dashboard." : "New perpetual positions are paused in this worker, but the pause could not be saved; turn perps off in Settings before restarting."} ${custodySentence(exposure)}`,
        };
      }
      // THE PAPER BOOK: halted first, then each practice position closed through the lane.
      ownerEntryHalts.add(`${a.agentId}:paper`);
      let haltSaved = false;
      try {
        await deps.store.patchPerpAccount?.(a.agentId, "paper", { entriesHalted: true });
        haltSaved = deps.store.patchPerpAccount !== undefined;
      } catch (e) {
        log(`paper entries halt not stored: ${errText(e)}`);
      }
      const left = await lock.run(async () => {
        if (opts.notAfterMs !== undefined && deps.now() >= opts.notAfterMs) return null;
        const r = await readRetainedPaper(a);
        const cfg = deps.config();
        for (const pos of r.view?.positions.values() ?? []) {
          const m = r.view?.markets.get(pos.key);
          const draft = m === undefined ? null : buildExitDraft({ market: m, position: pos, effect: "close", maxSlippageBps: Math.max(cfg.perpsMaxSlippageBps, 150) });
          if (draft === null) {
            continue;
          }
          const intent = { ...draft } as PerpOrderIntent;
          await deps.decide(intent, "chat", "the owner's /flatten: close every practice position");
          await executeLocked(intent, { equityUsdg: 0n, equityKnown: false }, undefined, { agent: a, read: r, notAfterMs: opts.notAfterMs });
        }
        // An IOC can fill only part of a close. The committed positions, not
        // a successful order result, establish whether the book is flat.
        try { return (await deps.store.getPerpPositions(a.agentId, "paper")).filter((p) => p.base > 0n).length; }
        catch { return "unread" as const; }
      }, { label: "flatten" });
      if (left === null) return { ok: false, sentence: "This flatten request expired before execution; new entries remain paused." };
      if (left === "unread") return { ok: false, sentence: `The remaining practice perpetual positions could not be read; they may still be open. ${haltSaved ? "New entries are paused until you resume them on the dashboard." : "New entries are paused in this worker, but the pause could not be saved; turn perps off in Settings before restarting."}` };
      if (!haltSaved) return { ok: false, sentence: `${left === 0 ? "Every practice perpetual position was closed." : `${left} practice positions could not be closed.`} New entries are paused in this worker, but the pause could not be saved; turn perps off in Settings before restarting.` };
      return {
        ok: left === 0,
        sentence:
          left === 0
            ? "Every practice perpetual position was closed, and new ones are paused until you resume them on the dashboard."
            : `${left} practice position${left === 1 ? "" : "s"} remain${left === 1 ? "s" : ""} open after the close attempts; new entries are paused until you resume them on the dashboard.`,
      };
    },
    async pollStanddownRequests() {
      if (deps.live === undefined || polling) return;
      polling = true;
      try {
        const home = deps.live.home();
        const reqs = readPendingStanddownRequests(home, { onIgnored: (f, why) => log(`stand-down request ${f} ignored: ${why}`) });
        for (const req of reqs) {
          if (handledNonces.has(req.nonce)) continue;
          handledNonces.add(req.nonce);
          log(`stand-down request ${req.nonce} (${req.reason})`);
          await standdown(req.reason, { nonce: req.nonce });
        }
      } catch (e) {
        log(`stand-down requests: ${errText(e)}`);
      } finally {
        polling = false;
      }
    },
    async grantEnded(reason) {
      // The key stays held (`retained`, `live`) — the protective loop keeps
      // what is there protected, exits-only, until the venue reads flat.
      if (live === null && deps.live === undefined) return;
      if (reason === "expiry") {
        // Once per expiry (the protective loop may have started it already).
        if (live !== null && live.exposure && !live.said.has("expiry-standdown")) {
          live.said.add("expiry-standdown");
          await standdown("expiry");
        }
        return;
      }
      // A KILL: the self-hosted kill path leaves a request file first (the CLI
      // waits on ITS result) — give it its turn, then stand down if nothing
      // named one. Once per kill.
      await lane.pollStanddownRequests();
      const nowMs = deps.now();
      const recent = lastStanddown !== null && lastStanddown.reason === "kill" && nowMs - lastStanddown.atMs < 5 * 60_000;
      if (standing === null && live !== null && live.exposure && !recent) await standdown("kill");
    },
    get standingDown() {
      return latched || standing !== null;
    },
  };
  return lane;
}

// ── the in-process feed (self-hosted only) ──────────────────────────────────

export interface PerpFeedHost {
  /** Start the one in-process feed if this process should run it and does not yet. Never throws. */
  ensure(): void;
  stop(): void;
  readonly running: boolean;
}

/**
 * ONE FEED PER PROCESS, AND NONE IN A HOSTED CHILD (docs/perps.md, feed.ts).
 * Self-hosted, the worker runs the fleet feed in-process the first time perps
 * need it; a hosted child only READS `lighter-feed.json` from the fleet home
 * (the orchestrator's feed is its own stage) and never opens a socket of its
 * own — every child falling back to the venue at once is the per-IP stampede
 * the feed exists to prevent. A start that throws is said once and retried on
 * the next ensure(); the lane reads "unread" meanwhile, which refuses opens.
 */
export function createPerpFeedHost(o: {
  hostedChild: () => boolean;
  wanted: () => boolean;
  start: () => { stop(): void };
  log?: (line: string) => void;
}): PerpFeedHost {
  let handle: { stop(): void } | null = null;
  let lastError: string | null = null;
  return {
    ensure() {
      if (handle !== null) return;
      try {
        if (o.hostedChild() || !o.wanted()) return;
        handle = o.start();
        lastError = null;
        o.log?.("[perps] in-process Lighter feed started");
      } catch (e) {
        const msg = errText(e);
        if (msg !== lastError) o.log?.(`[perps] the Lighter feed could not start: ${msg}`);
        lastError = msg;
      }
    },
    stop() {
      const h = handle;
      handle = null;
      try {
        h?.stop();
      } catch {
        // stopping is best-effort
      }
    },
    get running() {
      return handle !== null;
    },
  };
}

/**
 * A hosted child reads the fleet's feed file and never runs one: hosted mode
 * (core isHostedMode — the rest of index.ts's test), or any process an
 * orchestrator gave a fleet home (the file lives there, and so does its writer).
 */
export function isHostedChildProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return isHostedMode() || (env.MERRYMEN_FLEET_HOME ?? "").trim().length > 0;
}

// Kept for readers of the lane's type surface: the exit intent the stand-down closes with.
export type { PerpExitIntent };
