/**
 * THE PERP LANE — where a perp intent meets the ledger, the policy and an
 * executor, and where the protective loop and the perps route are driven from
 * (docs/perps.md rules 1, 6, 8, 8a, 9, 11, 12, 14 and "The perps route").
 *
 * index.ts is a 14,000-line main() with no seams; everything here is the perp
 * half of it, built from injected edges so a test can drive the REAL lane —
 * the real store, the real feed file reader, the real checkPolicy — and
 * index.ts keeps only thin, commented call sites.
 *
 * WHAT IS WIRED IN THIS STAGE: PAPER PERPS, END TO END. A live account with
 * perps on resolves to refuse(`perp-live-not-yet`) (perpsRailOf), announced
 * once per arm, and no path below can reach a live executor: there is none to
 * reach. The live account's perp term stays the known zero (no live perp row
 * can exist — nothing in this build writes one), so Lighter is never read.
 *
 * THE PAPER BOOK RIDES THE ACCOUNT'S RAIL, like the spot paper book: it is
 * the book only while execMode says paper. On a live account (or one the rail
 * refuses outright — not armed, a dead policy) it is left exactly as it was:
 * never traded, never protected, never counted in that account's equity
 * (rule 14: never a practice book beside the real one).
 *
 * ONE READ, EVERY CONSUMER. `refresh` reads the ledger, the paper book's
 * cash and the fleet feed once and derives, from that one moment, the
 * PerpsView (Snapshot.perps), the policy state (AgentState.perp), the equity
 * term (index.ts `perpBook`) and the report (`agents.perps`) — view.ts's four
 * builders, never a second composition (view.ts header).
 *
 * THE LANE LOCK (protect.ts createPerpLaneLock) IS THE PAPER BOOK'S LOCK TOO.
 * The paper engine books a perp action as a DELTA on paper_book cash, while
 * index.ts's spot paper fill and paper-peak writes are read-modify-writes of
 * the whole row. The protective loop books on its own clock, outside the
 * intent chain (rule 8a: it never waits behind it) — so every paper_book
 * read-modify-write in index.ts runs through `serial` (this lock), and the
 * tick reads paper cash and builds the perp term in ONE hold (`readWithBook`):
 * a stop filling between the two reads would otherwise count its margin once
 * in cash and once in ΣM, and a peak would ratchet on money that never
 * existed. Held only across ledger reads and paper bookings — never across a
 * network call — so a protective pass waits at most one booking. LIVE PERPS
 * WILL SEND UNDER THE SAME LOCK (sign → persist → send, protect.ts), which is
 * why there is one lock and not a paper one beside it.
 *
 * NEVER REACHED FROM THE EVM INTENT CHAIN'S INSIDE-OUT. processIntentLocked
 * (under intentChain) takes this lock; nothing holding this lock ever waits on
 * intentChain — the protective loop's closes run `executeLocked` directly —
 * so the two can never wait on each other.
 */

import { isHostedMode } from "../../../packages/core/src/hosted";
import {
  leverageFromImfBp,
  notionalMicro,
  perpMarketById,
  perpMarketByKey,
  type PerpKey,
  type PerpsReport,
} from "../../../packages/core/src/perps";
import { perpsModeOf, type ExecMode, type PerpsMode } from "../exec-mode";
import { perpAccountUsdg, type PerpBookPart, type PerpBookTerm } from "../equity";
import { countsAsEntry } from "../energy";
import { tradeConsumesSnapshot } from "../brain-live";
import type { LedgerFacts } from "../order-receipt";
import {
  checkPolicy as realCheckPolicy,
  isExitIntent,
  type AgentLimits,
  type AgentState,
  type PerpMarginIntent,
  type PerpOrderIntent,
  type PerpPolicyState,
  type TradeIntent,
  type Verdict,
} from "../policy";
import { perpsCeilingFor, type ResolvedConfig } from "../settings";
import type { PerpAccountRow, PerpOrderRow } from "../store";
import { renderWhy, type Why } from "../strategies/reasons";
import { ownerRejectRuleLabel } from "../thesis-policy";
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
import type { LighterFeedRead } from "./feed-reader";
import {
  PROTECT_THRESHOLDS,
  createPerpLaneLock,
  emptyProtectMemory,
  evaluateProtection,
  protectCadenceMs,
  protectCloseSlipBps,
  startProtectLoop,
  type PerpLaneLock,
  type ProtectLoop,
  type ProtectMemory,
  type ProtectPassContext,
} from "./protect";
import { runPerpRoute, type PerpRouteIntent } from "./route";
import {
  buildPerpBookTerm,
  buildPerpPolicyState,
  buildPerpsReport,
  buildPerpsViewStrict,
  renderScaled,
  type PerpsViewBuilt,
  type PerpsViewInput,
  type PerpsViewLedger,
} from "./view";

// ── the stage's rail ────────────────────────────────────────────────────────

/** The refusal a live account with perps on gets in this build (policy.ts, thesis-policy.ts carry its words). */
export const PERP_LIVE_NOT_YET = "perp-live-not-yet";

/**
 * perpsModeOf, as far as THIS BUILD can honour it. A paper account rides
 * paper perps exactly as perpsModeOf says. A LIVE account with perps on gets
 * refuse(`perp-live-not-yet`) whatever else is true: real-money perps are not
 * wired yet, and rule 14 forbids the fallback that would look helpful — a
 * practice perps book beside a real one. `off` stays off (a choice, not a
 * refusal).
 */
export function perpsRailOf(verdict: ExecMode, p: Parameters<typeof perpsModeOf>[1]): PerpsMode {
  const base = perpsModeOf(verdict, p);
  if (verdict.mode === "live" && base.mode !== "off") return { mode: "refuse", rule: PERP_LIVE_NOT_YET };
  return base;
}

/** The candle the entry was taken on: the 4 h bar that closed before `atSec` (perp-trend's `lastT`). */
const H4_MS = 14_400_000;
export function entryCandleOf(atSec: number): number {
  return Math.floor((atSec * 1000) / H4_MS) * H4_MS - H4_MS;
}

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
  /** The owner's Close all halts entries through this (`flatten`); nothing else in the lane writes the account row's flags. */
  patchPerpAccount(agentId: string, mode: "paper", patch: { entriesHalted: boolean }): Promise<void>;
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
   * Book one op and `spendMicro` straight into the settled halves, for an
   * order that may have been booked when the re-read above could not answer
   * (index.ts heldReservation's branch): released uncounted, the op is in
   * neither half and the cap is looser until the next refresh. That refresh
   * rebuilds the settled halves from the ledger, so nothing stays counted twice.
   */
  keep(spendMicro: bigint): void;
  /**
   * The day's spend and ops as they stand now, settled and in flight
   * (index.ts spentToday / opsTodayCount). Read under the lane's lock, so an
   * order judged there meets every op booked while it waited for the lock.
   */
  counters(): Promise<Pick<AgentState, "spentTodayUsdg" | "opsToday">>;
}

export type DecideFn = (
  intent: TradeIntent,
  source: string,
  reason?: string,
  known?: { whyCode?: string },
) => Promise<{ ok: true } | { ok: false; why: string }>;

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
  budget: PerpLaneBudget;
  /** index.ts addEvent, bound to the armed agent. Owner-facing; never a post. */
  events: (level: "ok" | "warn" | "err", message: string) => Promise<unknown>;
  /** index.ts ensureDecision — for the protective loop's closes (the route passes its own). */
  decide: DecideFn;
  /** Called whenever a refresh finds the lane ON — index.ts starts the in-process feed from it. */
  onActive?: () => void;
  checkPolicy?: typeof realCheckPolicy;
  /** Paper executor factory; tests may wrap it to watch it. */
  paperExecutor?: typeof createPaperPerpExecutor;
  lock?: PerpLaneLock;
  log?: (line: string) => void;
}

// ── what one read produces ──────────────────────────────────────────────────

export interface PerpLaneRead {
  /**
   * The lane is ON for this agent right now: a paper account whose perps are
   * on (rail paper) or whose paper book holds anything (rule 8a: exits,
   * stops and the equity term follow what is HELD, not the switch).
   */
  active: boolean;
  bookMode: "paper" | "live";
  rail: PerpsMode;
  /** Snapshot.perps: undefined when the lane is off, null when unread, else the view. */
  view: PerpsViewBuilt | null | undefined;
  /**
   * WHY `view` IS NULL on the practice book, when it is — two different gaps:
   *   - "ledger": the paper ledger itself could not be read (readLocked's
   *     catch), or a row it holds is one no view can be built from (an
   *     unlisted market, no entry price, no margin fraction: view.ts
   *     buildPerpsViewStrict throws), so what is held is NOT known;
   *   - "prices": the ledger read, but no view could be built from Lighter's
   *     prices (no feed file, a stale one, or none for a held market:
   *     view.ts buildPerpsViewStrict's null), so what is held IS known and
   *     only cannot be priced.
   * An owner's exit says which (close, flatten). Undefined whenever `view` is
   * not null.
   */
  viewUnread?: "ledger" | "prices";
  /** index.ts `perpBook`: undefined = known zero (no perps), "unread", or C + ΣM + ΣU + T. */
  book: PerpBookTerm;
  /** C + ΣM + ΣU + T at the last read that succeeded; null before any. */
  lastKnownMicro: bigint | null;
  /** AgentState.perp; undefined when the lane has nothing to judge (policy then refuses opens perp-not-enabled). */
  policy: PerpPolicyState | undefined;
  feedFresh: boolean;
  /** The paper ledger holds a position, an unresolved order or collateral. */
  held: boolean;
  report: PerpsReport;
  /** ms */
  readAtMs: number;
}

/** A perp intent's outcome as the caller's ledger facts read it (order-receipt.ts): paper, rejected or dropped — never landed. */
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
  processIntentReporting: (intent: TradeIntent) => Promise<{ status?: string } | null>;
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

/** A report that says, truthfully, that nothing is held — perps off, or a live account this build cannot trade perps on. */
function flatReport(rail: PerpsMode, protectAtMs: number | null): PerpsReport {
  return {
    v: 1,
    mode: rail.mode,
    blocker: rail.mode === "off" ? "perps-off" : null,
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

// ── the lane ────────────────────────────────────────────────────────────────

export interface PerpLane {
  readonly lock: PerpLaneLock;
  /** A fresh read, under the lane lock. */
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
   * processIntentLocked's perp branch: judge, review, judge again, reserve,
   * place, count, release. `base` is the caller's own AgentState (index.ts
   * passes processIntentLocked's `state`, so a perp open meets the very peak
   * figures a spot buy would); absent, deps.agentState composes one. Either
   * way `perp` and the venue flags are this call's FRESH read, and the day's
   * spend and ops are read under the lock (budget.counters), never `base`'s.
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
  /**
   * A paper reset: `reset` runs under the lock, then every in-memory perp fact
   * is forgotten. `askedAt` is when the owner asked for it (the command's
   * `at`); with it, the reset also lifts the owner's Close-all halt when it
   * was asked for after that halt: a halt this process set is compared with
   * when it was asked, and one an earlier process stored with when this lane
   * began, so a reset asked for before a restart lifts nothing. `reset` is
   * told which, and clears the ledger's halt in its own transaction (store.ts
   * resetPaperLedger). Without `askedAt`, no halt is lifted.
   *
   * `haltKept` says whether a Close-all halt still stands after it: the
   * ledger's, or one only this process holds because its write failed (a
   * re-read of the ledger alone missed that one, and the owner read a fresh
   * book with nothing to say why no position ever opened). "unread" when the
   * reset lifted nothing and the ledger could not say whether it holds one,
   * which says nothing of whether any Close all was ever pressed. An unarmed
   * lane, which a Spot worker's always is, keeps none.
   */
  resetPaper<T>(
    reset: (o: { clearEntriesHalt: boolean }) => Promise<T>,
    opts?: { askedAt?: number },
  ): Promise<{ out: T; haltKept: boolean | "unread" }>;
  /** Write `agents.perps` from the last read. */
  report(): Promise<void>;
  /** Venue market ids the feed should carry: the allowed markets plus anything held. */
  feedMarketIds(): number[];
  /** Venue market ids the book HOLDS: the feed's funding history covers each (feed.ts heldMarketIds). */
  heldMarketIds(): number[];
  /**
   * THE OWNER'S CLOSE OF ONE PRACTICE POSITION (owner-order.ts close-perp),
   * from the app's command drain. Reduce-only and the full size held, built
   * from this call's own read under the lock and filed under the owner's
   * decision (source `chat`, provenance owner-command), then the same lane
   * every perp intent takes. Paper only: there is no real-money book in this
   * build. The sentence is the owner's; `ok` only when the position is gone.
   */
  close(market: PerpKey, opts: { book: "paper"; notAfterMs?: number }): Promise<OwnerExitResult>;
  /**
   * THE OWNER'S CLOSE ALL (owner-order.ts flatten-perps): new entries halted
   * FIRST (perp_accounts.entries_halted, and this process's own memory of it
   * if that write fails), then every practice position closed as `close`
   * closes one. An absent `book` is every book (D11), which in this build is
   * the practice book. The halt lasts until the owner resets the practice
   * book (resetPaper, for a reset asked for after this Close all: `askedAt`
   * is when the owner asked for it); Resume needs the owner-controls history
   * (docs/perps.md), which has not landed.
   */
  flatten(opts: { book?: "paper"; notAfterMs?: number; askedAt?: number }): Promise<OwnerExitResult>;
}

/** What an owner's exit came to, in the owner's words. */
export interface OwnerExitResult {
  ok: boolean;
  sentence: string;
}

/**
 * WHERE AN OWNER'S PRACTICE BOOK IS NOT THE ACCOUNT'S BOOK, nothing of it is
 * touched — not even to close it. Rule 14: a practice book is never run beside
 * a real one, and the lane neither trades nor protects it until the account is
 * back on paper (readLocked). An owner's exit is a trade like any other.
 */
const PRACTICE_BOOK_FROZEN =
  "This account is not on paper right now, so its practice perpetual positions stay exactly as they are until it is. Nothing was sent.";

/**
 * What a practice reset's answer adds about the owner's Close-all pause, from
 * resetPaper's `haltKept`. A pause the reset did not lift is said, or the
 * owner reads a fresh book and waits for a strategy that never opens; one the
 * ledger could not answer for is said as that, never as none, and in words
 * that do not say a Close all was pressed: "unread" comes as readily to an
 * owner who never pressed one.
 */
export function resetHaltSentence(haltKept: boolean | "unread"): string {
  if (haltKept === "unread") {
    return " Whether new practice positions are paused by a Close all could not be read just now; if they show as paused, reset again to lift it.";
  }
  return haltKept ? " New practice positions stay paused by your earlier Close all; reset again to lift that." : "";
}

export function createPerpLane(deps: PerpLaneDeps): PerpLane {
  const lock = deps.lock ?? createPerpLaneLock({ onOverrun: (i) => log(`lane lock held past ${i.holdMs} ms by ${i.label ?? "?"}`) });
  const check = deps.checkPolicy ?? realCheckPolicy;
  const makePaper = deps.paperExecutor ?? createPaperPerpExecutor;
  const log = (line: string) => (deps.log ?? ((l: string) => console.log(l)))(`[perps] ${line}`);

  // ── per-agent memory (forgotten on a new agent, an arm, a paper reset) ──
  let agentKey: string | null = null;
  let lastRead: PerpLaneRead | null = null;
  /** The view the TICK read (Snapshot.perps) — what the route decides on. */
  let tickRead: PerpLaneRead | null = null;
  let lastKnownMicro: bigint | null = null;
  let protectMemory: ProtectMemory = emptyProtectMemory();
  let protectAtMs: number | null = null;
  /** Entries the route produced, refused or not (perp-trend: one entry per signal bar). */
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
  /**
   * The ledger's own Close-all halt as the last paper read found it, for the
   * account it read (`key` is haltKey's), or null when no read since the last
   * forget() reached the account row. Only the ledger's: the halt only this
   * process holds is ownerEntryHalts. A practice reset answers from it
   * (resetPaper), so a read that already said asks the ledger nothing more.
   */
  let ledgerHaltRead: { key: string; halted: boolean } | null = null;
  /**
   * THE OWNER'S HALT AS THIS PROCESS HOLDS IT, by account and book, with when
   * the newest Close all behind it was asked for. A Close all writes
   * perp_accounts.entries_halted before it closes anything; this is for the
   * write that failed, so the halt the owner was told about still holds here.
   * NOT per-agent memory: forget() — an arm, another account — never clears
   * it. Only the owner's practice reset does (resetPaper), and only a reset
   * asked for after that Close all: hosted, an exit rides the ferry's short
   * loop and a reset its reconcile pass, so a reset asked for first can reach
   * the worker second, and must not lift the halt the later Close all set.
   * This memory does not survive a restart; a halt it holds no time for is
   * ordered by when this lane began (laneStartedAt, resetPaper).
   */
  const ownerEntryHalts = new Map<string, number>();
  const haltKey = (agentId: string, book: "paper") => `${agentId.toLowerCase()}:${book}`;
  /**
   * WHEN THIS LANE — THIS WORKER PROCESS — BEGAN. Every halt this process sets
   * is in ownerEntryHalts with its time, so a halt in the ledger it holds no
   * time for was stored by an earlier process, and its Close all was asked for
   * before this one began (resetPaper).
   */
  const laneStartedAt = deps.now();

  function forget(): void {
    lastRead = null;
    tickRead = null;
    lastKnownMicro = null;
    protectMemory = emptyProtectMemory();
    entryCandles = new Map();
    strategistIntents = [];
    lastRefusalKey = null;
    lastIdleKey = null;
    railKey = null;
    tickFailureKey = null;
    lastActive = false;
    tickUnreadKeys = new Set();
    fundingGaps = new Map();
    ledgerHaltRead = null;
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
      // was never about.
      agentKey = key;
      forget();
      reportJson = null;
    }
    return a;
  }

  function railFor(a: PerpLaneAgent, cfg: PerpLaneConfig): PerpsMode {
    return perpsRailOf(deps.execMode(), {
      perpsEnabled: cfg.perpsEnabled,
      // RAW, never the rail's consented(): the migration stand-down that keeps
      // an unconsented account's spot trading live is not consent to leverage
      // (exec-mode.ts perpsModeOf, amendment 8a(g)).
      liveTradingEnabled: cfg.liveTradingEnabled,
      perpsLiveEnabled: cfg.perpsLiveEnabled,
      ceiling: perpsCeilingFor(cfg, a.smartAccount),
      granted: a.limits.perp !== undefined,
      // Stage: the live venue (deposit, key, account index) is not wired, so
      // it is never ready — perpsRailOf refuses a live account before this
      // matters, and it is false rather than a guess if it ever does.
      venueReady: false,
      entriesHalted: cfg.perpsEntriesHalted,
    });
  }

  /**
   * The policy state of a lane that holds nothing and reads nothing — a live
   * account in this build, or a paper one whose perps are refused (operator
   * off…). Built only so policy answers with the RAIL's own words: `off` has
   * none (absent → perp-not-enabled), a refusal names itself. No market is
   * read (every open refused behind the rail anyway), and the committed-money
   * totals saturate at their caps (view.ts buildPerpPolicyState, unread).
   */
  function railOnlyPolicy(a: PerpLaneAgent, cfg: PerpLaneConfig, rail: PerpsMode, nowSec: number): PerpPolicyState | undefined {
    if (rail.mode === "off") return undefined;
    const input: PerpsViewInput = {
      mode: "paper",
      nowSec,
      feed: null,
      settings: cfg,
      grant: { perTradeSealedMicro: a.limits.perTradeUsdg, expiresAtSec: a.limits.expiresAt },
      ledger: {
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
        entriesHalted: cfg.perpsEntriesHalted,
      },
    };
    try {
      return buildPerpPolicyState(input, null, rail);
    } catch {
      return undefined;
    }
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

  async function readLocked(): Promise<PerpLaneRead> {
    const nowMs = deps.now();
    const nowSec = Math.floor(nowMs / 1000);
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
    const rail = railFor(a, cfg);
    const bookMode: "paper" | "live" = verdict.mode === "paper" ? "paper" : "live";

    if (bookMode === "live") {
      // NO LIVE PERPS IN THIS BUILD: nothing writes a live perp row, so the
      // live term is the known zero of an agent with no perps (rule 11) and
      // Lighter is never read. The rail still says why nothing opens.
      //
      // A PRACTICE BOOK LEFT FROM PAPER stays exactly as it was — never run
      // beside the real book (rule 14), never counted in live equity — and
      // the owner is told so rather than finding it gone.
      // Only the owner's sentence depends on it, so a read that fails says
      // nothing rather than failing the live tick it rides on.
      let paperHeld = false;
      try {
        paperHeld = (await deps.store.getPerpPositions(a.agentId, "paper")).some((p) => p.base > 0n);
      } catch {
        paperHeld = false;
      }
      const r: PerpLaneRead = {
        active: false,
        bookMode,
        rail,
        view: undefined,
        book: undefined,
        lastKnownMicro: 0n,
        policy: railOnlyPolicy(a, cfg, rail, nowSec),
        feedFresh: false,
        held: paperHeld,
        report: flatReport(rail, protectAtMs),
        readAtMs: nowMs,
      };
      lastRead = r;
      noteActive(false);
      await announceRail(r, a);
      return r;
    }

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
      const r: PerpLaneRead = {
        active: true,
        bookMode,
        rail,
        view: null,
        viewUnread: "ledger",
        book: "unread",
        lastKnownMicro,
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
    const positions = await store.getPerpPositions(a.agentId, "paper", { includeFlat: true });
    const unresolved = await store.listSubmittedPerpOrders(a.agentId, "paper");
    const account = await store.getPerpAccount(a.agentId, "paper");
    // No row is no halt: an account that never traded was never paused.
    ledgerHaltRead = { key: haltKey(a.agentId, "paper"), halted: account?.entriesHalted === true };
    const collateral = account?.paperCollateralMicro ?? 0n;
    const heldRows = positions.filter((p) => p.base > 0n && p.side !== null);
    const held = heldRows.length > 0 || unresolved.length > 0 || collateral !== 0n;
    lastHeldMarkets = heldRows.map((p) => p.marketId);
    const active = rail.mode === "paper" || held;
    if (!active) {
      // Nothing held and perps not on: the known zero of an agent with no
      // perps (rule 11) — Lighter's prices are not even read.
      lastKnownMicro = 0n;
      const r: PerpLaneRead = {
        active: false,
        bookMode,
        rail,
        view: undefined,
        book: undefined,
        lastKnownMicro,
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

    const keyOf = (id: number): PerpKey | null => perpMarketById(id)?.key ?? null;
    const unresolvedMarkets = new Set<number>();
    const unresolvedOpenMarkets = new Set<number>();
    const closeInFlightMarkets = new Set<number>();
    let pendingOpen = 0n;
    for (const o of unresolved) {
      if (o.marketId === null) continue;
      unresolvedMarkets.add(o.marketId);
      if (o.effect === "open") {
        unresolvedOpenMarkets.add(o.marketId);
        pendingOpen += o.worstNotionalMicro;
      } else if (o.effect === "reduce" || o.effect === "close") {
        closeInFlightMarkets.add(o.marketId);
      }
    }
    const lastExit = new Map<PerpKey, { atSec: number; cause: "strategy" | "stop" | "take" | "risk" | "forced" | "unknown" }>();
    for (const [id, e] of facts.lastExits) {
      const k = keyOf(id);
      if (k !== null) lastExit.set(k, e);
    }
    // THE CANDLE OF THE LAST ENTRY: the ledger's opens (so a restart forgets
    // nothing that was sent) merged with this process's own record of every
    // entry the route produced, refused or not (so a refused entry is not
    // re-proposed on every tick of the same bar).
    const lastEntryCandleT = new Map<PerpKey, number>(entryCandles);
    for (const [id, at] of facts.lastOpenAt) {
      const k = keyOf(id);
      if (k === null) continue;
      const t = entryCandleOf(at);
      if ((lastEntryCandleT.get(k) ?? -Infinity) < t) lastEntryCandleT.set(k, t);
    }
    const cash = bookRow.cashUsdg;
    const ledger: PerpsViewLedger = {
      positions,
      unresolvedMarkets,
      unresolvedOpenMarkets,
      closeInFlightMarkets,
      pendingOpenNotionalMicro: pendingOpen,
      opensToday: facts.opensToday,
      lastExit,
      lastEntryCandleT,
      // Paper has no transfers: margin moves with each fill (rule 14).
      depositsInTransitMicro: 0n,
      withdrawalsInTransitMicro: 0n,
      paperCollateralMicro: account?.paperCollateralMicro ?? null,
      // An unreadable cash figure is not zero: the view then states no free collateral.
      paperCashMicro: Number.isFinite(cash) ? BigInt(Math.round(cash * 1e6)) : null,
      incident: account?.incident !== null && account?.incident !== undefined,
      // The ledger's halt, or the one this process holds because writing it failed.
      entriesHalted: (account?.entriesHalted ?? false) || ownerEntryHalts.has(haltKey(a.agentId, "paper")),
    };
    const input: PerpsViewInput = {
      mode: "paper",
      nowSec,
      feed,
      settings: cfg,
      grant: { perTradeSealedMicro: a.limits.perTradeUsdg, expiresAtSec: a.limits.expiresAt },
      ledger,
    };
    // A ROW NO VIEW CAN BE BUILT FROM IS THE LEDGER'S GAP, NOT THE PRICES'.
    // buildPerpsView answers null for both; an owner told Lighter's prices
    // could not be read, and to ask again in a minute, would ask for ever
    // about a row no price read mends.
    let view: PerpsViewBuilt | null;
    let viewUnread: "ledger" | "prices" | undefined;
    try {
      view = buildPerpsViewStrict(input);
      if (view === null) viewUnread = "prices";
    } catch (e) {
      log(`paper book unreadable: ${errText(e)}`);
      view = null;
      viewUnread = "ledger";
    }
    let book: PerpBookTerm = buildPerpBookTerm(view);
    // A FLAT PAPER BOOK IS A KNOWN ZERO, whatever the feed says. The paper
    // ledger is the whole book (rule 14): with no position, no order in
    // flight and no collateral there is nothing to value, and calling that
    // "unread" would pause equity and refuse every spot buy (rule 11) over a
    // price file for markets nothing is held in.
    if (book === "unread" && !held) book = ZERO_BOOK;
    if (book !== "unread" && book !== undefined) lastKnownMicro = perpAccountUsdg(book);
    const policy = buildPerpPolicyState(input, view, rail);
    const report = buildPerpsReport(input, view, { rail, protectAtMs, fundingUnreadMarkets: new Set(fundingGaps.keys()) });
    const r: PerpLaneRead = {
      active: true,
      bookMode,
      rail,
      view,
      ...(viewUnread !== undefined ? { viewUnread } : {}),
      book,
      lastKnownMicro,
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
   * THE RAIL, SAID ONCE PER CHANGE (and again after every arm). The owner is
   * told what perps are doing in their own words: practice, or why not —
   * never a slug. "Off" is said only when it is a change: an agent that never
   * turned perps on hears nothing.
   */
  async function announceRail(r: PerpLaneRead, a: PerpLaneAgent): Promise<void> {
    // Holding matters to the sentence only while perps are OFF (then what is
    // held still closes on its rules); with them on, a position opening or
    // closing is not a change of rail and says nothing here.
    const key = `${r.bookMode}|${r.rail.mode}|${r.rail.mode === "refuse" ? r.rail.rule : ""}|${(r.rail.mode === "off" || r.bookMode === "live") && r.held ? "held" : ""}`;
    if (key === railKey) return;
    const first = railKey === null;
    railKey = key;
    let line: string | null;
    const frozen =
      r.bookMode === "live" && r.held
        ? " The practice positions opened while the account was on paper stay exactly as they were — not traded, not " +
          "counted in the real book — until it is back on paper."
        : "";
    if (r.bookMode === "live" && r.held && r.rail.mode === "off") {
      line = `perpetuals are off.${frozen}`;
    } else if (r.rail.mode === "paper") {
      line =
        "perpetuals are on, in practice: Lighter's live prices and order book with the venue's own rules, margin drawn " +
        "from the paper book's cash — nothing is signed and no money moves. Every position opens with its stop.";
    } else if (r.rail.mode === "refuse" && r.rail.rule === PERP_LIVE_NOT_YET) {
      line =
        "perpetuals are switched on, but this account trades for real and real-money perpetuals are not available in " +
        "this version yet — nothing is opened on Lighter, and no practice perps run beside the real book." +
        frozen;
    } else if (r.rail.mode === "refuse") {
      // A perps slug has the owner's words (thesis-policy.ts); the account's
      // own refusal (not armed, a dead policy…) is already said by the
      // account's status, so it is named as that, never as a raw slug.
      const words = r.rail.rule.startsWith("perp-") ? ownerRejectRuleLabel(r.rail.rule) : null;
      line = `perpetuals are switched on, but nothing new is opened: ${words ?? "the account itself is not trading right now — its status says why"}.${frozen}`;
    } else if (r.held) {
      line = "perpetuals are off: nothing new is opened. The practice positions still held keep their stops and close on their own rules.";
    } else {
      line = first ? null : "perpetuals are off — nothing is opened on Lighter.";
    }
    if (line === null) return;
    log(`${a.agentId.slice(0, 10)} rail: ${key}`);
    try {
      await deps.events(r.rail.mode === "refuse" ? "warn" : "ok", line);
    } catch {
      // a notice that fails to write must never fail the read that raised it
    }
  }

  async function refreshLocked(): Promise<PerpLaneRead> {
    return readLocked();
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
    return refreshLocked();
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
      try {
        await deps.events("warn", `perps: ${labelOf(intent)} refused — ${v.rule}: ${v.detail}`);
      } catch {
        // never fails the refusal it describes
      }
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

  async function announcePlaced(intent: PerpOrderIntent, review: PerpReview, placed: PerpPlaceResult, r: PerpLaneRead): Promise<void> {
    const spec = r.policy?.markets.get(intent.marketId)?.spec ?? r.view?.facts.positions.get(intent.market)?.decimals ?? null;
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
    try {
      await deps.events(placed.filledBase === 0n ? "warn" : "ok", line);
    } catch {
      // the booking stands whether or not the line lands
    }
  }

  async function executeLocked(
    intent: PerpOrderIntent | PerpMarginIntent,
    equity: { equityUsdg: bigint; equityKnown: boolean },
    base?: Omit<AgentState, "perp">,
  ): Promise<PerpOutcome> {
    const a = agentNow();
    if (a === null) return { status: "rejected", rejectRule: "perp-not-enabled" };
    let r = await refreshLocked();
    const stateFor = async (read: PerpLaneRead): Promise<AgentState> => ({
      ...(base ?? (await deps.agentState(equity))),
      // THE DAY'S COUNTERS AS THEY STAND UNDER THE LOCK, never `base`'s: the
      // caller read those before it queued for this lock, and an owner's
      // Close or a protective close may have booked an op while it waited.
      // An open judged on the older count went one over the grant's ops cap.
      // This intent's own reservation is taken below, after the judging.
      ...(await deps.budget.counters()),
      // The venue's state is the account's, from THIS read: an open judged
      // against an older "unread" (or an older "read") is judged against a
      // book nobody is looking at any more.
      perpVenueUnread: read.book === "unread",
      perpLastKnownMicro: read.lastKnownMicro,
      perp: read.policy,
    });

    // ── MARGIN: not a paper thing, and not a live thing yet ──────────────
    if (intent.kind === "perp-margin") {
      const v = check(intent, a.limits, await stateFor(r));
      if (!v.ok) return refuse(intent, v, "policy");
      return refuse(
        intent,
        r.bookMode === "live"
          ? { rule: PERP_LIVE_NOT_YET, detail: "real-money perpetuals are not available in this version yet, so no margin moves to Lighter." }
          : {
              rule: "perp-order-malformed",
              detail: "paper perps keep no collateral at a venue — margin moves with each fill — so there is nothing to deposit, withdraw or claim.",
            },
        "lane",
      );
    }

    // ── LIVE: NOT BUILT. No executor exists to reach. ─────────────────────
    if (r.bookMode !== "paper") {
      const v = check(intent, a.limits, await stateFor(r));
      return refuse(
        intent,
        v.ok ? { rule: PERP_LIVE_NOT_YET, detail: "real-money perpetuals are not available in this version yet." } : v,
        "rail",
      );
    }

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
    const v2 = check(reviewed, a.limits, state);
    if (!v2.ok) return refuse(intent, v2, "reviewed");

    // ── reserve → place → count → release (recordTrade's order) ───────────
    // The reservation covers the moment between the booking and the settled
    // counters seeing it; `finally` releases it on EVERY exit, a throw and a
    // refusal included — a reservation left behind is permanent for the arm
    // (budget-reservation.invariant.test.ts; lane.test.ts pins this one).
    //
    // COUNTED, OR KEPT COUNTED. The count re-reads the settled halves, which
    // then hold the booked order. A store too busy to answer gets the
    // reservation's own figures booked into them instead (keep, as Spot's
    // heldReservation branch does): released uncounted, the op was in neither
    // half, and the next open of the same tick went one over the ops cap.
    //
    // A BOOKING IS NOT UNDONE BY A COUNT THAT FAILED AFTER IT. place()
    // returned, so the paper engine committed the fill, and it is announced
    // and answered as one. (The count used to share place()'s try, and a busy
    // store made a booked close "refused" and refunded a placed open's energy.)
    // A throw from place() that is not the executor's own refusal (PerpRefused,
    // always before anything is booked) may have come after its commit, so it
    // is counted the same way before its refusal is answered.
    const spend = intent.effect === "open" ? reviewed.notionalUsdg : 0n;
    const count = async (): Promise<void> => {
      try {
        await deps.budget.refresh();
      } catch (e) {
        deps.budget.keep(spend);
        log(`day's counters not re-read after ${labelOf(intent)}; its op stays counted: ${errText(e)}`);
      }
    };
    deps.budget.reserve(spend);
    let placed: PerpPlaceResult;
    try {
      try {
        placed = await ex.place(intent, review, { decisionId: intent.decisionId ?? null, agentId: a.agentId });
      } catch (e) {
        if (!(e instanceof PerpRefused)) await count();
        return refuse(intent, refusalOf(e), "place");
      }
      await count();
    } finally {
      deps.budget.release(spend);
    }
    lastRefusalKey = null;
    await announcePlaced(intent, review, placed, r);
    // Re-read after a booking so the next reader (the report, a pass) sees it.
    await refreshLocked();
    if (placed.filledBase === 0n) return { status: "dropped" };
    return { status: "paper", amountUsdg: Number(placed.filledQuoteMicro) / 1e6, basisSource: "paper" };
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
        line = `perps (paper): the ${key} take-profit filled — realized ${usdgText(ev.realizedMicro, true)} USDG.`;
        break;
      case "liq":
        level = "err";
        line =
          `perps (paper): ${key} was ${ev.outcome === "taken-over" ? "taken over by the venue" : "liquidated"} — realized ` +
          `${usdgText(ev.realizedMicro, true)} USDG, ${usdgText(ev.feeMicro)} USDG to the liquidation fee.`;
        break;
    }
    if (line === null) return;
    try {
      await deps.events(level, line);
    } catch {
      // the booking stands
    }
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
      try {
        await deps.events("warn", line);
      } catch {
        // said again next episode
      }
    }
    tickUnreadKeys = seen;
    fundingGaps = gaps;
  }

  async function protectLocked(signal: AbortSignal): Promise<void> {
    const a = agentNow();
    if (a === null) return;
    let r = await refreshLocked();
    const cfg = deps.config();
    if (!r.active || r.bookMode !== "paper") {
      protectAtMs = deps.now();
      return;
    }
    const epoch = await deps.store.getAgentEpoch(a.agentId);
    const ex = executorFor(a, epoch);

    // ── THE PAPER VENUE'S OWN CLOCK: funding, resting stops and takes, liquidation ──
    const nowMs = deps.now();
    const t = await ex.tick?.(nowMs);
    if (t) {
      for (const ev of t.events) if (ev.booked === "booked") await announceTick(ev);
      const failKey = t.failed ? `${t.failed.marketId}|${t.failed.kind}|${t.failed.error}` : null;
      if (failKey !== null && failKey !== tickFailureKey) {
        try {
          await deps.events(
            "err",
            `perps (paper): the venue's clock could not book ${t.failed?.kind} on ${perpMarketById(t.failed?.marketId ?? -1)?.key ?? "a market"} — ` +
              `${t.failed?.error}. Nothing moved; it is tried again on the next pass.`,
          );
        } catch {
          // said next time
        }
      }
      tickFailureKey = failKey;
      const gapsBefore = [...fundingGaps].join();
      await noteTickUnread(t.unread);
      // Re-read after a booking — or when the funding that reads unread
      // changed, so the report says it from this pass on.
      if (t.events.some((e) => e.booked === "booked") || [...fundingGaps].join() !== gapsBefore) r = await refreshLocked();
    }

    // ── THE BACKSTOP ─────────────────────────────────────────────────────
    const nowSec = Math.floor(deps.now() / 1000);
    const out = evaluateProtection({ view: r.view ?? null, nowSec, settings: cfg, prior: protectMemory, feedFresh: r.feedFresh });
    protectMemory = out.memory;
    for (const act of out.actions) {
      if (signal.aborted) break;
      if (act.kind === "alert") {
        try {
          await deps.events("warn", `perps: ${act.text}`);
        } catch {
          // an alert that fails is sent again next episode
        }
        continue;
      }
      if (act.kind === "replace-stop") {
        try {
          await ex.setStop?.(act.marketId, { trigger: act.trigger, price: act.price });
          const d = r.view?.facts.positions.get(act.market)?.decimals;
          const px = (v: bigint) => (d ? renderScaled(v, d.priceDecimals) : v.toString());
          await deps.events("ok", `perps (paper): a stop was put back under the ${act.market} ${act.side} at ${px(act.trigger)} (fills no worse than ${px(act.price)}).`);
        } catch (e) {
          log(`${act.market} stop not re-placed: ${errText(e)}`);
        }
        continue;
      }
      // A CLOSE: a decision row (hard-risk-exit by its Why), then the same
      // lane every perp intent takes — policy, review, policy, reserve, place.
      const intent: PerpOrderIntent = { ...act.intent };
      const stamped = await deps.decide(intent, "perp-route", renderWhy(act.why, "public"), { whyCode: act.why.code });
      if (!stamped.ok) {
        log(`${act.market} protective close not stamped: ${stamped.why}`);
        continue;
      }
      await executeLocked(intent, { equityUsdg: 0n, equityKnown: false });
    }
    protectAtMs = deps.now();
    // The report and the next reader see the book as this pass left it.
    await refreshLocked();
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
    // THE BAR IS SPENT whether or not the entry is placed: a refused entry
    // re-proposed on every tick of the same bar is a refusal a tick.
    if (out.entry !== null && out.entryCandleT !== null) entryCandles.set(out.entry.market, out.entryCandleT);
    const source = out.source ?? "perp-route";
    const all: { intent: PerpRouteIntent; why: Why | null }[] = [
      ...out.exits.map((intent, i) => ({ intent, why: out.why[i] ?? null })),
      ...(out.entry !== null ? [{ intent: out.entry, why: out.why[out.exits.length] ?? null }] : []),
    ];
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
        const facts = await hooks.processIntentReporting(intent);
        if (!tradeConsumesSnapshot(facts?.status)) await hooks.refundEntry(claim);
      } else {
        await hooks.processIntent(intent);
      }
    }
    // WHY NO ENTRY, once per change and to the owner only — every perp idle
    // code is withheld from publication (reasons.ts publishesIdle).
    const idle = out.idle;
    const idleKey = idle === null ? null : JSON.stringify(idle, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    if (idleKey !== lastIdleKey) {
      lastIdleKey = idleKey;
      if (idle !== null && idle.code !== "perp-no-signal") {
        try {
          await deps.events("ok", `perps: no new position — ${renderWhy(idle, "owner")}`);
        } catch {
          // said next change
        }
      }
    }
  }

  // ── the owner's exits ───────────────────────────────────────────────────

  /** Past the request's own deadline? At the deadline itself it still runs — command-files.ts isExpired's edge. */
  function lateFor(notAfterMs: number | undefined): boolean {
    return typeof notAfterMs === "number" && Number.isFinite(notAfterMs) && deps.now() > notAfterMs;
  }

  /**
   * ONE PRACTICE POSITION CLOSED FOR ITS OWNER, under the lock, on `r` — a read
   * this same hold took.
   *
   * BUILT FROM WHAT IS HELD, NEVER FROM WHAT WAS ASKED. The order carries a
   * market and nothing else (owner-order.ts): the side is the position's, the
   * size is all of it, and the worst price is the protective close's
   * (protect.ts protectCloseSlipBps: twice the owner's slippage, inside the
   * venue's band). So it can only ever reduce.
   *
   * IT IS NOT SAFE TO RUN TWICE. Built from what is held when it runs, a
   * request run a second time closes whatever is held in that market at that
   * moment: nothing, if nothing was opened since, but a position the strategy
   * opened since, if one was — a close the owner never asked for (lane.test.ts
   * pins both). The drain's claim is the only thing that keeps an exit to one
   * run (command-files.ts: the claim is the unlink; hosted, the ferry claims
   * the row before it writes the file), so nothing here may be leaned on as a
   * second line.
   *
   * FILED AS THE OWNER'S. The decision row is written under source `chat`
   * before anything is placed, so its provenance is owner-command and the fill
   * joins it (the protective close's shape, under the route's source). A close
   * whose decision cannot be written is not sent: a fill nobody can attribute
   * would read as the strategy's exit in every book that reads provenance, and
   * on paper waiting costs the owner nothing but a retry. Then the same lane
   * every perp intent takes — policy, review, policy, place — and the paper
   * engine books it into perp_fills, perp_positions and paper cash exactly as
   * it books the lane's own exits.
   */
  async function ownerCloseLocked(
    r: PerpLaneRead,
    market: PerpKey,
    reason: string,
  ): Promise<{ kind: "none" } | { kind: "unpriced" } | { kind: "unstamped"; why: string } | { kind: "sent"; out: PerpOutcome }> {
    const pos = r.view?.positions.get(market);
    if (pos === undefined) return { kind: "none" };
    const m = r.view?.markets.get(market);
    const draft =
      m === undefined ? null : buildExitDraft({ market: m, position: pos, effect: "close", maxSlippageBps: protectCloseSlipBps(deps.config().perpsMaxSlippageBps) });
    if (draft === null) return { kind: "unpriced" };
    const intent: PerpOrderIntent = { ...draft };
    const stamped = await deps.decide(intent, "chat", reason);
    if (!stamped.ok) return { kind: "unstamped", why: stamped.why };
    return { kind: "sent", out: await executeLocked(intent, { equityUsdg: 0n, equityKnown: false }) };
  }

  /**
   * `agents.perps` as the owner's exit left the book, so the desk that asked
   * shows it now rather than at the next pass. Outside the lock, as a pass
   * writes it; a report that fails to write never changes what the owner is
   * told happened — the next pass writes it again.
   */
  async function reportAfterOwnerExit(): Promise<void> {
    try {
      await writeReport(lastRead);
    } catch (e) {
      log(`report after an owner exit not written: ${errText(e)}`);
    }
  }

  /** How many practice positions are still held, from the ledger after the closes — never from an order's result. */
  async function practiceLeft(a: PerpLaneAgent): Promise<number | "unread"> {
    try {
      const held = await deps.store.getPerpPositions(a.agentId, "paper");
      return held.filter((p) => p.base > 0n).length;
    } catch {
      return "unread";
    }
  }

  /** How much of one market's practice position is still held, from the ledger after the close — never from the order's result. */
  async function practiceBaseLeft(a: PerpLaneAgent, marketId: number): Promise<bigint | "unread"> {
    try {
      const held = await deps.store.getPerpPositions(a.agentId, "paper");
      return held.filter((p) => p.marketId === marketId && p.base > 0n).reduce((sum, p) => sum + p.base, 0n);
    } catch {
      return "unread";
    }
  }

  // ── the report ──────────────────────────────────────────────────────────

  async function writeReport(r: PerpLaneRead | null): Promise<void> {
    const a = deps.armed();
    if (a === null || r === null) return;
    const json = JSON.stringify(r.report);
    if (json === reportJson) return;
    await deps.store.setAgentPerps(a.agentId, json);
    reportJson = json;
  }

  const lane: PerpLane = {
    lock,
    // The TICK's read (a live account's, which reads nothing in this build):
    // it becomes the view the route decides on, like readWithBook's.
    refresh: () =>
      lock.run(
        async () => {
          const r = await refreshLocked();
          tickRead = r;
          return r;
        },
        { label: "refresh" },
      ),
    async readWithBook<T>(read: () => Promise<T>) {
      return lock.run(
        async () => {
          const value = await read();
          const r = await refreshLocked();
          tickRead = r;
          return { value, read: r };
        },
        { label: "tick read" },
      );
    },
    serial: (fn, label) => lock.run(fn, { label: label ?? "paper book" }),
    last: () => lastRead,
    snapshotView: () => tickRead?.view,
    policyState: () => lastRead?.policy,
    execute: (intent, equity, base) => lock.run(() => executeLocked(intent, equity, base), { label: `execute ${labelOf(intent)}` }),
    runRoute,
    deliverStrategist(intents) {
      strategistIntents = [...intents];
    },
    async protectPass(ctx) {
      if (deps.armed() === null) return;
      await ctx.lock.run(() => protectLocked(ctx.signal), { signal: ctx.signal, label: "protect" });
      await writeReport(lastRead);
    },
    startProtect() {
      if (loop !== null) return;
      loop = startProtectLoop({
        // 15 s while anything is held or unread (protect.ts), 60 s with the
        // lane off — the pass is then a ledger read that finds nothing (never
        // a Lighter read: an inactive lane reads no feed), and runs so that
        // the moment the lane turns on is noticed within a minute.
        intervalMs: () => (lastRead?.active ? protectCadenceMs(lastRead.view ?? null) : PROTECT_THRESHOLDS.idleIntervalMs),
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
      // Not the tick's read: the route decides only on what a tick read.
      const r = await lock.run(refreshLocked, { label: "arm" });
      await writeReport(r);
    },
    async configChanged() {
      lastRefusalKey = null;
      lastIdleKey = null;
      lane.startProtect();
      const r = await lock.run(refreshLocked, { label: "settings" });
      await writeReport(r);
    },
    async resetPaper<T>(reset: (o: { clearEntriesHalt: boolean }) => Promise<T>, opts: { askedAt?: number } = {}) {
      return lock.run(
        async () => {
          // A RESET STARTS THE PRACTICE BOOK OVER, ITS CLOSE-ALL HALT WITH IT:
          // every practice position is closed into the old epoch, so the halt
          // has nothing left to protect, and without this nothing in this
          // build ever lifted it — one Close all ended practice entries on
          // that account for good (re-creating the wallet is the same index-1
          // account). Not a halt asked for after this reset was, and not for a
          // reset that cannot say when it was asked.
          //
          // A HALT THIS PROCESS HOLDS NO TIME FOR was stored by an earlier
          // worker process (ownerEntryHalts holds every halt this one set), so
          // its Close all was asked for before this lane began: a reset asked
          // for after that is after it, and lifts it. A reset asked for BEFORE
          // this lane began cannot be ordered against it — hosted, a reset
          // asked for first rides the reconcile pass and can reach a restarted
          // worker second, after the Close all ran in the process before — so
          // it lifts nothing, and the owner resets again. It used to lift it:
          // the restart had erased the only record that the reset came first,
          // and an older command undid the owner's newer Close all. The two
          // times are different clocks (the command's `at` is the web's, or
          // the queue row's; this is the worker's), and the restart between
          // the halt and this lane is far wider than they ever disagree by.
          const a = agentNow();
          const key = a === null ? null : haltKey(a.agentId, "paper");
          const haltAskedAt = key === null ? undefined : ownerEntryHalts.get(key);
          const askedAt = opts.askedAt;
          const clearEntriesHalt =
            key !== null &&
            typeof askedAt === "number" &&
            Number.isFinite(askedAt) &&
            (haltAskedAt !== undefined ? haltAskedAt <= askedAt : laneStartedAt <= askedAt);
          const out = await reset({ clearEntriesHalt });
          if (clearEntriesHalt && key !== null) ownerEntryHalts.delete(key);
          // The book those memories were about is gone: a breach clock, a
          // cooldown or an entry candle carried across would act on nothing.
          const keepRail = railKey;
          forget();
          railKey = keepRail;
          await refreshLocked();
          // WHAT STANDS NOW, once the reset and the forgetting are done, so no
          // read here can stop either. A lifted halt left neither copy: the
          // reset's own transaction cleared the ledger's. The halt this process
          // holds needs no read. Otherwise only the ledger knows: the read just
          // made says, when it reached the account row (ledgerHaltRead, which
          // forget() cleared, so it is this read's); only when it did not is
          // the ledger asked again. A second read that failed after the first
          // had answered once made an owner who never pressed Close all read
          // about one. A ledger that cannot answer at all is "unread", never
          // "none": a halt an earlier worker stored, unlifted, still refuses
          // every practice entry.
          const seen = ledgerHaltRead;
          const haltKept: boolean | "unread" =
            a === null || key === null || clearEntriesHalt
              ? false
              : ownerEntryHalts.has(key) ||
                (seen !== null && seen.key === key
                  ? seen.halted
                  : await deps.store.getPerpAccount(a.agentId, "paper").then(
                      (acct) => acct?.entriesHalted === true,
                      () => "unread" as const,
                    ));
          return { out, haltKept };
        },
        { label: "paper reset" },
      );
    },
    report: () => writeReport(lastRead),
    feedMarketIds() {
      const cfg = deps.config();
      // What is HELD is always carried (its stop and its liquidation are
      // watched whatever the switch says); the allowed markets only while
      // perps are on — the owner's switch AND the operator's ceiling, which
      // takes opens away and so needs no market a book does not hold.
      const ids = new Set<number>(lastHeldMarkets);
      if (cfg.perpsEnabled && cfg.perpsOperatorCeiling !== "off") {
        for (const k of cfg.perpsMarkets) {
          const id = perpMarketByKey(k)?.marketId;
          if (id !== undefined) ids.add(id);
        }
      }
      return [...ids].sort((x, y) => x - y);
    },
    heldMarketIds() {
      return [...new Set(lastHeldMarkets)].sort((x, y) => x - y);
    },
    async close(market, opts) {
      // A shape check passed upstream (owner-order.ts); a market this build does not trade is refused here, by name.
      if (perpMarketByKey(market) === null) return { ok: false, sentence: `${market} is not a perpetual market this version trades. Nothing was sent.` };
      const out = await lock.run(
        async (): Promise<OwnerExitResult> => {
          // Judged once the lock is ours: a protective pass ahead of it may have held it for a while.
          if (lateFor(opts.notAfterMs)) return { ok: false, sentence: `${market}: this close request expired before it could run. Nothing was sent.` };
          const a = agentNow();
          if (a === null) return { ok: false, sentence: "Nothing is armed, so no practice position could be closed. Nothing was sent." };
          const r = await refreshLocked();
          if (r.bookMode !== "paper") return { ok: false, sentence: PRACTICE_BOOK_FROZEN };
          if (r.view === null) {
            // WHICH OF TWO GAPS, told apart (r.viewUnread). A ledger that could
            // not be read leaves what is held unknown. Prices that could not be
            // read — the feed file missing or no longer refreshed, the far
            // likelier of the two — leave the ledger read and the position
            // known: it is still open, and nothing could price its close. Both
            // used to be "the practice book could not be read", which an owner
            // took for a lost practice record rather than a minute's wait.
            // Either way nothing is sent: no close is built on stale prices,
            // and with none fresh no paper stop can trigger either (protect.ts
            // never closes on an unread view), so the stop is not called a
            // protection it cannot be just now.
            const held = r.viewUnread === "prices" ? await practiceBaseLeft(a, perpMarketByKey(market)!.marketId) : "unread";
            if (held === 0n) return { ok: false, sentence: `${market}: there is no practice position to close. Nothing was sent.` };
            if (held !== "unread") {
              return {
                ok: false,
                sentence:
                  `${market}: Lighter's prices could not be read just now, so nothing was sent. The practice position is still open, ` +
                  "and its stop can only trigger once prices read again. Ask again in a minute.",
              };
            }
            return { ok: false, sentence: `${market}: the practice book could not be read, so nothing was sent. Its stop stays in place.` };
          }
          // What was held when the close was built (paper: the ledger row's own base), to tell a part-close from none.
          const heldBefore = r.view?.positions.get(market)?.baseAmount;
          const done = await ownerCloseLocked(r, market, `the owner asked to close ${market} reduce-only`);
          if (done.kind === "none") return { ok: false, sentence: `${market}: there is no practice position to close. Nothing was sent.` };
          if (done.kind === "unpriced") {
            return { ok: false, sentence: `${market}: the exit price could not be read, so nothing was sent. Its stop stays in place.` };
          }
          if (done.kind === "unstamped") {
            log(`${market} owner close not stamped: ${done.why}`);
            return { ok: false, sentence: `${market}: the close could not be recorded, so nothing was sent. Its stop stays in place; ask again.` };
          }
          if (done.out.status === "dropped") {
            return { ok: false, sentence: `${market}: the practice close did not fill — nothing on the book inside its worst price — so the position and its stop stay as they were.` };
          }
          // WHAT BECAME OF THE POSITION IS READ BACK FROM THE LEDGER, for a
          // refusal as for a fill — never taken from the order's result.
          //   - An IOC can fill part of a close.
          //   - A REFUSAL CAN COME AFTER THE BOOKING. The paper engine books
          //     the close in one transaction inside place(), and anything that
          //     throws after that commit and before place() returns comes back
          //     a refusal (perp-unpriced) for a position that is gone; the
          //     owner was told it and its stop "stay as they were", and their
          //     next Close found nothing to close. (A count of the day's ops
          //     that fails after a booking is no longer one: executeLocked
          //     answers that as the fill it was.)
          // Only "dropped" is taken as said: place() returned with nothing
          // filled, so nothing was booked.
          const left = await practiceBaseLeft(a, perpMarketByKey(market)!.marketId);
          if (done.out.status !== "paper") {
            const rule = done.out.rejectRule;
            log(`${market} owner close came back ${rule ?? "refused"}; the ledger holds ${left === "unread" ? "an unread amount" : left.toString()} of ${heldBefore?.toString() ?? "?"}`);
            const booked = left === 0n || (left !== "unread" && heldBefore !== undefined && left < heldBefore);
            // A refusal skips executeLocked's re-read after a booking, and
            // whether one was booked is not always known (a ledger that could
            // not be read just now): read again, as Close all does, so the
            // report written below shows what the ledger holds, or that it
            // could not be read, and never the read from before the close.
            try {
              await refreshLocked();
            } catch (e) {
              log(`re-read after an owner close not taken: ${errText(e)}`);
            }
            if (left === 0n) return { ok: true, sentence: `${market}: the practice position was closed.` };
            if (booked) {
              return { ok: false, sentence: `${market}: the practice close filled only part of the position; the rest remains open with its stop.` };
            }
            // The practice book has no venue behind it: perp-unpriced's owner
            // words ("Lighter could not be read, and money was at the venue")
            // describe a live account, and here mean the paper engine could
            // not price or book the close.
            const words = rule === "perp-unpriced" ? "the practice engine could not price or book it" : rule ? (ownerRejectRuleLabel(rule) ?? rule) : null;
            if (left === "unread") {
              return { ok: false, sentence: `${market}: the practice close was refused${words ? ` (${words})` : ""}, and what remains could not be read; check the position before asking again.` };
            }
            return { ok: false, sentence: `${market}: the practice close was refused${words ? ` (${words})` : ""}, so the position and its stop stay as they were.` };
          }
          if (left === "unread") return { ok: false, sentence: `${market}: a practice close was booked, but what remains could not be read; part of the position may still be open.` };
          if (left > 0n) return { ok: false, sentence: `${market}: the practice close filled only part of the position; the rest remains open with its stop.` };
          return { ok: true, sentence: `${market}: the practice position was closed.` };
        },
        { label: `owner close ${market}` },
      );
      await reportAfterOwnerExit();
      return out;
    },
    async flatten(opts) {
      const out = await lock.run(
        async (): Promise<OwnerExitResult> => {
          if (lateFor(opts.notAfterMs)) return { ok: false, sentence: "This Close all request expired before it could run. Nothing was sent and nothing was paused." };
          const a = agentNow();
          if (a === null) return { ok: false, sentence: "Nothing is armed, so no practice position could be closed. Nothing was sent and nothing was paused." };
          // THE HALT FIRST: whatever the closes below find, no entry follows
          // them. Held in this process before the write, so a write that fails
          // still stops entries here — and the owner is told it did not save.
          // Remembered with when it was asked for (the newest Close all wins),
          // so a reset asked for before it never lifts it (resetPaper).
          const key = haltKey(a.agentId, "paper");
          const askedAt = typeof opts.askedAt === "number" && Number.isFinite(opts.askedAt) ? opts.askedAt : Date.now();
          ownerEntryHalts.set(key, Math.max(ownerEntryHalts.get(key) ?? Number.NEGATIVE_INFINITY, askedAt));
          let haltSaved = false;
          try {
            await deps.store.patchPerpAccount(a.agentId, "paper", { entriesHalted: true });
            haltSaved = true;
          } catch (e) {
            log(`practice entries halt not stored: ${errText(e)}`);
          }
          const paused = haltSaved
            ? "New practice positions are paused until you reset the practice book."
            : "New practice positions are paused in this worker, but the pause could not be saved — turn perps off in Settings before it restarts.";
          const r = await refreshLocked();
          if (r.bookMode !== "paper") return { ok: false, sentence: `${PRACTICE_BOOK_FROZEN} ${paused}` };
          if (r.view === null) {
            // Which gap, as for Close (above). With only the prices unread the
            // ledger read, so the owner is told how many positions are still
            // open — not "they may still be open" — and to ask again; only a
            // ledger that could not be read leaves that unknown. The halt above
            // stands either way (D11).
            const left = r.viewUnread === "prices" ? await practiceLeft(a) : "unread";
            if (left === 0) return { ok: haltSaved, sentence: `There were no practice perpetual positions open. ${paused}` };
            if (left !== "unread") {
              return {
                ok: false,
                sentence:
                  `Lighter's prices could not be read just now, so no practice position was closed: ${left} remain${left === 1 ? "s" : ""} open, ` +
                  `with ${left === 1 ? "its stop" : "their stops"}, which can only trigger once prices read again. Ask again in a minute. ${paused}`,
              };
            }
            return { ok: false, sentence: `The practice book could not be read, so no position was closed; they may still be open. ${paused}` };
          }
          // Every market held at this read, each closed on the same read (one
          // market's close never moves another's position), and each refusal
          // left to the count below rather than ending the rest.
          const held = [...(r.view?.positions.keys() ?? [])];
          let refusedAny = false;
          for (const market of held) {
            const done = await ownerCloseLocked(r, market, "the owner's Close all: close every practice position");
            if (done.kind === "unstamped") log(`${market} owner close not stamped: ${done.why}`);
            if (done.kind === "sent" && done.out.status !== "paper" && done.out.status !== "dropped") refusedAny = true;
          }
          const left = await practiceLeft(a);
          // A refusal skips executeLocked's re-read, and one can come after the
          // engine booked the close (as for Close, above): read now, so the
          // report written below shows what the ledger holds and not the
          // positions this Close all just closed.
          if (refusedAny) {
            try {
              await refreshLocked();
            } catch (e) {
              log(`re-read after the owner's Close all not taken: ${errText(e)}`);
            }
          }
          if (left === "unread") return { ok: false, sentence: `The remaining practice perpetual positions could not be read; some may still be open. ${paused}` };
          if (left > 0) {
            return {
              ok: false,
              sentence: `${left} practice position${left === 1 ? "" : "s"} remain${left === 1 ? "s" : ""} open after the close attempts, with ${left === 1 ? "its stop" : "their stops"}. ${paused}`,
            };
          }
          const closed = held.length === 0 ? "There were no practice perpetual positions open." : "Every practice perpetual position was closed.";
          return { ok: haltSaved, sentence: `${closed} ${paused}` };
        },
        { label: "owner close all" },
      );
      await reportAfterOwnerExit();
      return out;
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
