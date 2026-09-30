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
import {
  createPaperPerpExecutor,
  PerpRefused,
  type PaperPerpStore,
  type PerpExecutor,
  type PerpPlaceResult,
  type PerpReview,
  type PerpTickEvent,
} from "./executor";
import type { LighterFeedRead } from "./feed-reader";
import {
  PROTECT_THRESHOLDS,
  createPerpLaneLock,
  emptyProtectMemory,
  evaluateProtection,
  protectCadenceMs,
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
  buildPerpsView,
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
   * passes processIntentLocked's `state`, so a perp open meets the very spend,
   * ops and peak figures a spot buy would); absent, deps.agentState composes
   * one. Either way `perp` and the venue flags are this call's FRESH read.
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
  /** Start the protective loop if the lane is (or may become) on; idempotent. */
  startProtect(): void;
  stopProtect(): Promise<void>;
  readonly protecting: boolean;
  /** A new arm: forget per-arm memory, announce the rail again, start protection when due. */
  armed(): Promise<void>;
  /** Settings changed (perpsKey moved): re-read, re-announce, start protection when due. */
  configChanged(): Promise<void>;
  /** A paper reset: `reset` runs under the lock, then every in-memory perp fact is forgotten. */
  resetPaper<T>(reset: () => Promise<T>): Promise<T>;
  /** Write `agents.perps` from the last read. */
  report(): Promise<void>;
  /** Venue market ids the feed should carry: the allowed markets plus anything held. */
  feedMarketIds(): number[];
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
        book: "unread",
        lastKnownMicro,
        policy: railOnlyPolicy(a, cfg, rail, nowSec),
        feedFresh: false,
        held: true,
        report: { ...flatReport(rail, protectAtMs), blocker: rail.mode === "paper" ? "perps-venue-unreachable" : null, openNotionalMicro: null, collateralMicro: null, inTransitMicro: null },
        readAtMs: nowMs,
      };
      lastRead = r;
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
      await announceRail(r, a);
      return r;
    }
    deps.onActive?.();

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
      entriesHalted: account?.entriesHalted ?? false,
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
    if (book !== "unread" && book !== undefined) lastKnownMicro = perpAccountUsdg(book);
    const policy = buildPerpPolicyState(input, view, rail);
    const report = buildPerpsReport(input, view, { rail, protectAtMs });
    const r: PerpLaneRead = {
      active: true,
      bookMode,
      rail,
      view,
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
    const spend = intent.effect === "open" ? reviewed.notionalUsdg : 0n;
    deps.budget.reserve(spend);
    let placed: PerpPlaceResult;
    try {
      placed = await ex.place(intent, review, { decisionId: intent.decisionId ?? null, agentId: a.agentId });
      await deps.budget.refresh();
    } catch (e) {
      return refuse(intent, refusalOf(e), "place");
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
      if (t.events.some((e) => e.booked === "booked")) r = await refreshLocked();
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
        // lane off — the pass is then a ledger read that finds nothing, and
        // runs only to notice the moment something is held again.
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
      // Not the tick's read: the route decides only on what a tick read.
      const r = await lock.run(refreshLocked, { label: "arm" });
      if (r.active || deps.config().perpsEnabled) lane.startProtect();
      await writeReport(r);
    },
    async configChanged() {
      lastRefusalKey = null;
      lastIdleKey = null;
      const r = await lock.run(refreshLocked, { label: "settings" });
      if (r.active || deps.config().perpsEnabled) lane.startProtect();
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
          await refreshLocked();
          return out;
        },
        { label: "paper reset" },
      );
    },
    report: () => writeReport(lastRead),
    feedMarketIds() {
      const cfg = deps.config();
      // What is HELD is always carried (its stop and its liquidation are
      // watched whatever the switch says); the allowed markets only while
      // perps are on.
      const ids = new Set<number>(lastHeldMarkets);
      if (cfg.perpsEnabled) {
        for (const k of cfg.perpsMarkets) {
          const id = perpMarketByKey(k)?.marketId;
          if (id !== undefined) ids.add(id);
        }
      }
      return [...ids].sort((x, y) => x - y);
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
