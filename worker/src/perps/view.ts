/**
 * THE PERPS VIEW — ONE READ OF LIGHTER, AND EVERY NUMBER ANYONE ACTS ON.
 *
 * Five readers need to know what the agent holds at Lighter and what it may
 * still do there: a producer (Snapshot.perps), the policy branch
 * (AgentState.perp), the equity seam (index.ts `perpBook`), the status report
 * (`agents.perps`) and the protective loop (protect.ts). If each composed the
 * venue for itself, the cap a producer sized to, the cap policy judged and the
 * headroom the dashboard showed would be three numbers from three reads — and
 * the owner would watch an open the report said fitted be refused. So the view
 * is built ONCE, from one feed read, one ledger read and (live) one venue
 * account read, and every other shape here is DERIVED from it:
 *
 *   buildPerpsView        → PerpsView (+ `facts`, what only the lane needs)
 *   buildPerpPolicyState  → policy.ts PerpPolicyState — the same figures
 *   buildPerpBookTerm     → equity.ts PerpBookTerm — rule 12's C + ΣM + ΣU + T
 *   buildPerpsReport      → core PerpsReport — `agents.perps`
 *
 * WHICH SOURCE IS AUTHORITATIVE, per rail (rule 14: never both at once):
 *
 *   paper  The LEDGER is the book: perp_positions rows (mode 'paper') ARE the
 *          positions, marked here at the fleet feed's mark with core's integer
 *          math. The paper engine draws margin straight from paper cash, so
 *          the book's cross collateral C is whatever perp_accounts carries for
 *          paper (0 unless the engine keeps a figure there) — the margin itself
 *          is ΣM on the rows, and equity counts it here because it has left
 *          paper cash.
 *   live   The VENUE is the book: positions, margin, unrealized P&L and the
 *          liquidation price come from ONE /api/v1/account response (rule 12:
 *          C, M and U taken from two responses can count a margin twice or not
 *          at all). The ledger contributes only what the venue does not say —
 *          the stop and take we RECORDED, when the position was opened, and
 *          money in transit.
 *
 * UNKNOWN IS NEVER ZERO (rule 11). `buildPerpsView` returns null — "perps are
 * on and Lighter could not be read" — when the feed is unread, when (with
 * markets allowed) every allowed market is missing or stale in it, when a
 * live venue account was not read, or when a held paper position's market is
 * not in the feed at all (a book that cannot be valued is not a book). A
 * stale mark on an otherwise read view is carried with `markFresh: false`:
 * the book term is then "unread" on paper, and protect.ts never closes on it.
 *
 * THE MODEL NEVER SEES LEVERAGE AS A CHOICE: `leverage`/`imfBp` per market are
 * core's leverageTarget of the owner's setting and the market's own minimum,
 * the very figure policy re-derives and refuses a mismatch against (rule 6).
 */

import {
  effectiveMinNotionalMicro,
  isolatedLiqPrice,
  leverageFromImfBp,
  leverageTarget,
  liqDistanceBps,
  notionalMicro,
  perpMarketById,
  perpMarketByKey,
  unrealizedPnlMicro,
  type PerpBlocker,
  type PerpKey,
  type PerpMarketSpec,
  type PerpSide,
  type PerpsReport,
  type PerpsReportPosition,
} from "../../../packages/core/src/index";
import type { PerpBookPart, PerpBookTerm } from "../equity";
import type { PerpsMode } from "../exec-mode";
import type { PerpPolicyState } from "../policy";
import type { ResolvedConfig } from "../settings";
import type { PerpPositionRow } from "../store";
import type { PerpMarketView, PerpPositionView, PerpsView } from "../strategies/types";
import type { LighterFeedRead, PerpFeedMarket } from "./feed-reader";
import { totalAssetValueConsistent, type PerpAccountPosition, type PerpAccountRead, type PerpDecimals, type VenueOrder } from "./markets";

// ── inputs ──────────────────────────────────────────────────────────────────

/** The resolved perps settings the view reads — worker/src/settings.ts ResolvedConfig, owner fields plus the operator halt. */
export type PerpsViewSettings = Pick<
  ResolvedConfig,
  | "perpsMarkets"
  | "perpsMaxLeverage"
  | "perpsPerTradeUsdg"
  | "perpsMaxOpenNotionalUsdg"
  | "perpsMaxCollateralUsdg"
  | "perpsMaxOpensPerDay"
  | "perpsStopLossPct"
  | "perpsStopSlipBps"
  | "perpsLiqBufferPct"
  | "perpsMaxSlippageBps"
  | "perpsEntriesHalted"
>;

/** The perp_positions columns the view reads (store.ts PerpPositionRow). */
export type PerpsViewLedgerRow = Pick<
  PerpPositionRow,
  | "marketId"
  | "side"
  | "base"
  | "entryPrice"
  | "allocatedMarginMicro"
  | "imfBp"
  | "marginMode"
  | "fundingMicro"
  | "stopTrigger"
  | "stopPrice"
  | "takeTrigger"
  | "takePrice"
  | "openedAt"
>;

/** What the ledger says, read once for this build. Every set and map is keyed as the ledger keys it. */
export interface PerpsViewLedger {
  /**
   * perp_positions for THIS rail, flat rows included (getPerpPositions(agent,
   * mode, { includeFlat: true })). On paper these are the book; on live they
   * are the cache, read only for the recorded stop/take and the open time.
   */
  positions: readonly PerpsViewLedgerRow[];
  /** market_ids with a perp_orders row not yet final (submitted | executed), any effect. */
  unresolvedMarkets: ReadonlySet<number>;
  /** Of those, the markets whose unresolved row is an OPEN — protect.ts leaves them to the open's own stop. */
  unresolvedOpenMarkets: ReadonlySet<number>;
  /** market_ids with a reduce or close not yet final — no open until it is (rule 9). */
  closeInFlightMarkets: ReadonlySet<number>;
  /** Σ worst notional of unresolved OPENS: exposure that may already be a position the read has not shown. */
  pendingOpenNotionalMicro: bigint;
  /** Opens sent in the trailing 24 h on this rail (perp_orders). */
  opensToday: number;
  lastExit: PerpsView["lastExit"];
  lastEntryCandleT: PerpsView["lastEntryCandleT"];
  /** T_in: our deposits landed on chain and not yet credited at the venue. */
  depositsInTransitMicro: bigint;
  /** T_out: our withdrawals executed at the venue and not yet paid home. */
  withdrawalsInTransitMicro: bigint;
  /** Paper: perp_accounts.paper_collateral_micro (null/absent = none kept). Ignored on live. */
  paperCollateralMicro?: bigint | null;
  /** Paper: the paper book's USDG cash — what paper margin is drawn from. Ignored on live. */
  paperCashMicro?: bigint | null;
  /** The recorded stop's expiry per market_id, unix seconds (the SL leg's signing time + its OrderExpiry). */
  stopExpiresAtSec?: ReadonlyMap<number, number>;
  /** perp_accounts incident flag (rule 16). */
  incident: boolean;
  /** perp_accounts.entries_halted — the owner's /flatten halt. */
  entriesHalted: boolean;
}

/** The live venue read: one /api/v1/account, the account's active orders, and the decimals both were parsed with. */
export interface PerpsViewVenue {
  account: PerpAccountRead;
  /** accountActiveOrders; null = not read, which leaves every stop's state UNREAD (never "missing"). */
  orders: readonly VenueOrder[] | null;
  /** The orderBookDetails decimals parseAccount used — every perp row's, listed or not. */
  decimals: ReadonlyMap<number, PerpDecimals>;
}

export interface PerpsViewInput {
  /** Which book to read. perpsModeOf decides opens; exits follow venue exposure (rule 8a) — see buildPerpPolicyState. */
  mode: "paper" | "live";
  nowSec: number;
  /** The fleet feed as feed-reader judged it; null = unread. */
  feed: LighterFeedRead | null;
  settings: PerpsViewSettings;
  /** From the grant: the sealed per-trade cap (AgentLimits.perTradeUsdg, micro) and its expiry. */
  grant: { perTradeSealedMicro: bigint; expiresAtSec: number | null };
  ledger: PerpsViewLedger;
  /** Live only. Absent or null on live is an unread venue — the view is null. */
  venue?: PerpsViewVenue | null;
  /** Closed 4 h mark candles per market_id, oldest first; absent = the feed's own `closed4h` (null when it has none). */
  candles4h?: ReadonlyMap<number, PerpMarketView["closed4h"]>;
  /** The account's drawdown breaker is tripped (opens stop; exits never do). */
  breakerTripped?: boolean;
  /** A blocker only the arm path knows: awaiting-deposit, key-pending, key-mismatch… */
  railBlocker?: PerpBlocker | null;
  /** Live: USDG in the smart account a deposit could draw on; null/absent = not known. */
  accountCashMicro?: bigint | null;
  /**
   * Build for the EXITS-ONLY lane (protect.ts, stand-down, owner closes), live
   * only: when the fleet feed is missing or every allowed market is stale, the
   * view is still built from the venue account alone — marks from its own
   * `position_value`, liquidation from the venue — with no market open for
   * opens (`perps-venue-unreachable`). A fresh account read is not unread
   * state, and a feed outage must not blind the loop that watches liquidation.
   * Paper has no account to fall back on and stays null.
   */
  exitsOnly?: boolean;
}

// ── outputs ─────────────────────────────────────────────────────────────────

/** A market the book HOLDS, as far as the feed says — for protect.ts, whether or not the owner still allows it. */
export interface PerpHeldMarket {
  /** null when the feed does not carry the market at all. */
  spec: PerpMarketSpec | null;
  /** null = unread. */
  status: "active" | "reduce-only" | "inactive" | null;
  /** Signed ppm of notional per hour, positive = longs pay; null = unread. */
  fundingPpmPerHour: number | null;
  /** The feed's prices and spec for it are fresh enough to act on. */
  fresh: boolean;
}

/**
 * What protect.ts and the report need about a position that PerpPositionView
 * does not carry. The stop is the heart of it: rule 7 says an open is not
 * "protected" until its stop is SEEN resting, so the state is four-valued and
 * only "resting" is protection.
 */
export interface PerpPositionFacts {
  key: PerpKey;
  marketId: number;
  decimals: PerpDecimals;
  /**
   * Where the mark came from. `feed` is the fleet feed; `account` is derived
   * from this read's own `position_value` (live, when the feed is stale or
   * missing the market) — the venue's mark at the snapshot, rounded toward
   * liquidation so a proximity is never understated.
   */
  markSource: "feed" | "account";
  /** The mark is current: a fresh feed entry, or this venue read's own. */
  markFresh: boolean;
  /**
   * The stop this position is MEANT to have: the ledger's recorded stop, else
   * (live) the tightest reduce-only stop the venue shows resting. null = none
   * known — protect.ts then derives one from the entry and the owner's setting.
   */
  recordedStop: { trigger: bigint; price: bigint } | null;
  /**
   *   resting — seen resting at exactly the recorded trigger
   *   other   — reduce-only stops rest, none at the recorded trigger
   *   missing — seen: nothing rests
   *   unread  — the orders were not read; NOT missing, and NOT protected
   */
  stopState: "resting" | "other" | "missing" | "unread";
  /** Unix seconds; null = not known (a live stop with no expiry read is treated as due by protect.ts). */
  stopExpiresAtSec: number | null;
  /** Venue order index of the stop seen resting at the recorded trigger (live); null on paper or when none rests. */
  restingStopOrder: string | null;
  /** Venue order indexes of reduce-only stops resting on this market that are not the recorded one. */
  otherStopOrders: readonly string[];
  /** An OPEN on this market has no final outcome yet. */
  openingUnresolved: boolean;
  /** false when the ledger could not date the open — openedAtSec then reads 0 (old), so protection is never deferred. */
  openedAtKnown: boolean;
  held: PerpHeldMarket;
}

export interface PerpsViewFacts {
  mode: "paper" | "live";
  /** Live: the venue account index; paper: null. */
  accountIndex: number | null;
  positions: ReadonlyMap<PerpKey, PerpPositionFacts>;
  /**
   * Live positions in markets outside LIGHTER_MARKETS_V1. Never ours (we trade
   * only the frozen table), so each is unknown activity (rule 16): counted in
   * equity and exposure, kept out of `positions` (no key, no intent can exit
   * it — the stand-down covers every market), and it blocks opens.
   */
  foreign: readonly PerpAccountPosition[];
  /** Live: the decimals the account was parsed with (for rendering foreign rows). */
  venueDecimals: ReadonlyMap<number, PerpDecimals> | null;
  /** Rule 12's venue term from this one read; "unread" when it cannot be vouched for. */
  book: PerpBookPart | "unread";
  /** Σ notional at mark (every position, foreign included) + unresolved opens — what the open-notional cap judges. */
  openNotionalMicro: bigint;
  /** C + ΣM + T_in — what the collateral cap judges. */
  committedCollateralMicro: bigint;
  depositsInTransitMicro: bigint;
  withdrawalsInTransitMicro: bigint;
  /** Rule 16 evidence: the durable flag, or activity this read shows that we never do. */
  incident: boolean;
  /** The operator's MERRYMEN_HALT_PERP_ENTRIES or the owner's /flatten. */
  entriesHalted: boolean;
  closeInFlight: ReadonlySet<PerpKey>;
  /** When what the view says was true, ms: the account snapshot's transaction_time (live) or the feed file's time (paper). */
  readAtMs: number;
}

/**
 * A PerpsView with the lane's own facts beside it. Assignable to PerpsView, so
 * the same object goes into Snapshot.perps; producers read the PerpsView half,
 * and `facts` holds nothing a producer could use to choose leverage or a key.
 */
export type PerpsViewBuilt = PerpsView & { readonly facts: PerpsViewFacts };

// ── units and constants ─────────────────────────────────────────────────────

/** Opens stop this long before the grant expires (rule 6/13; policy.ts perp-grant-expiring). */
export const PERP_GRANT_EXPIRING_SEC = 86_400;
/** Lighter's minimum deposit — below it a live account has no collateral it could post. */
const MIN_DEPOSIT_MICRO = 1_000_000n;

/**
 * Settings USDG → micro-USDG. Settings store USDG on a 0.01 grid (core
 * PERPS_NUM_BOUNDS), so this is exact and no cap has to pick a rounding.
 * Throws on a value no clamp could have produced: a cap read as 0 or NaN is a
 * cap nobody set.
 */
export function perpsUsdgToMicro(usdg: number): bigint {
  if (!Number.isFinite(usdg) || usdg < 0) throw new RangeError(`perps: ${usdg} is not a USDG amount`);
  return BigInt(Math.round(usdg * 100)) * 10_000n;
}

/** Settings percent (0.01 grid) → basis points, exactly. */
export function perpsPctToBps(pct: number): number {
  if (!Number.isFinite(pct) || pct < 0) throw new RangeError(`perps: ${pct} is not a percentage`);
  return Math.round(pct * 100);
}

/** The settings as policy.ts judges them — the one conversion every consumer shares. */
export function perpPolicySettings(s: PerpsViewSettings, perTradeSealedMicro: bigint): PerpPolicyState["settings"] {
  const own = perpsUsdgToMicro(s.perpsPerTradeUsdg);
  return {
    markets: [...s.perpsMarkets],
    maxLeverage: s.perpsMaxLeverage,
    // Effective per-trade = min(sealed, owner's perp cap) — rule 6. Policy
    // takes the min again from the limits, so a lane that forgot it here
    // cannot widen anything; this keeps producers from sizing past it.
    perTradeMicro: own < perTradeSealedMicro ? own : perTradeSealedMicro,
    maxOpenNotionalMicro: perpsUsdgToMicro(s.perpsMaxOpenNotionalUsdg),
    maxCollateralMicro: perpsUsdgToMicro(s.perpsMaxCollateralUsdg),
    maxOpensPerDay: s.perpsMaxOpensPerDay,
    stopLossBps: perpsPctToBps(s.perpsStopLossPct),
    stopSlipBps: s.perpsStopSlipBps,
    liqBufferBps: perpsPctToBps(s.perpsLiqBufferPct),
    maxSlippageBps: s.perpsMaxSlippageBps,
  };
}

/**
 * Why opens cannot happen, most fundamental first. The FIRST present blocker
 * is the one shown: an owner told "no collateral" while the key is
 * compromised would fix the wrong thing. Every PerpBlocker appears, so a rail
 * blocker handed in by the arm path lands in its proper place.
 */
export const PERP_BLOCKER_PRIORITY: readonly PerpBlocker[] = Object.freeze([
  "perps-unknown-activity",
  "perps-key-mismatch",
  "perps-off",
  "perps-live-off",
  "account-not-live",
  "perps-not-granted",
  "perps-entries-halted",
  "breaker-tripped",
  "perps-grant-expiring",
  "perps-venue-unreachable",
  "perps-key-pending",
  "perps-awaiting-deposit",
  "perps-cap-below-min",
  "perps-no-collateral",
]);

// ── small helpers ───────────────────────────────────────────────────────────

const MICRO = 1_000_000n;

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

function pickBlocker(present: ReadonlySet<PerpBlocker>): PerpBlocker | null {
  for (const b of PERP_BLOCKER_PRIORITY) if (present.has(b)) return b;
  return null;
}

/** A venue integer rendered at its precision: 20n at 5 → "0.00020" (the report's decimal strings). */
export function renderScaled(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  if (decimals <= 0) return `${neg ? "-" : ""}${a}`;
  const s = a.toString().padStart(decimals + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

/**
 * The venue's mark at the account snapshot, from a position's exact
 * `position_value` (|s| × mark, 6 dp): value × 10^(sd+pd) / (|s| × 10^6),
 * rounded TOWARD LIQUIDATION — down for a long, up for a short — so a distance
 * to liquidation or a stop computed from it is never overstated. null when it
 * cannot be derived.
 */
function markFromValue(valueMicro: bigint, base: bigint, d: PerpDecimals, side: PerpSide): bigint | null {
  const v = abs(valueMicro);
  if (base <= 0n || v <= 0n) return null;
  const num = v * 10n ** BigInt(d.sizeDecimals + d.priceDecimals);
  const den = base * MICRO;
  const q = num / den;
  const m = side === "short" && num % den !== 0n ? q + 1n : q;
  return m > 0n ? m : null;
}

/** Fresh enough to act on: the entry's own stamp and the read's stale set agree. (Not a type guard — its false branch must not narrow a stale entry away.) */
function feedFresh(feed: LighterFeedRead, m: PerpFeedMarket | undefined): boolean {
  return m !== undefined && m.fresh && !feed.stale.has(m.marketId);
}

function heldOf(feed: LighterFeedRead, m: PerpFeedMarket | undefined): PerpHeldMarket {
  if (m === undefined) return { spec: null, status: null, fundingPpmPerHour: null, fresh: false };
  const fresh = feedFresh(feed, m);
  return { spec: m.spec, status: fresh ? m.status : null, fundingPpmPerHour: fresh ? m.fundingRatePpm : null, fresh };
}

const ACTIVE_ORDER: ReadonlySet<string> = new Set(["open", "pending", "in-progress"]);

/**
 * The reduce-only protective orders of one kind resting on a market, on the
 * side that CLOSES the held position (a long's stop sells). Not reduce-only is
 * not ours and not protection: a stop that can flip the position is an order
 * the worker never places.
 */
function restingOf(orders: readonly VenueOrder[], marketId: number, side: PerpSide, kind: "stop" | "take"): VenueOrder[] {
  const types = kind === "stop" ? ["stop-loss", "stop-loss-limit"] : ["take-profit", "take-profit-limit"];
  return orders.filter(
    (o) => o.marketId === marketId && o.reduceOnly && types.includes(o.type) && o.isAsk === (side === "long") && ACTIVE_ORDER.has(o.status),
  );
}

/** The tightest of several resting stops: the one that fires first (a long's highest trigger, a short's lowest). */
function tightest(stops: readonly VenueOrder[], side: PerpSide): VenueOrder | null {
  let best: VenueOrder | null = null;
  for (const o of stops) {
    if (best === null || (side === "long" ? o.triggerPrice > best.triggerPrice : o.triggerPrice < best.triggerPrice)) best = o;
  }
  return best;
}

function expirySec(o: VenueOrder): number | null {
  return o.orderExpiryMs > 0 ? Math.floor(o.orderExpiryMs / 1000) : null;
}

// ── the view ────────────────────────────────────────────────────────────────

/**
 * Build the view, or null when Lighter is unread (see the header). NEVER
 * THROWS: a view this code cannot vouch for is an unread one, which refuses
 * opens and leaves exits to the venue's resting stops and the reconcile —
 * the fail-closed direction. Tests call buildPerpsViewStrict to see the throw.
 */
export function buildPerpsView(input: PerpsViewInput): PerpsViewBuilt | null {
  try {
    return buildPerpsViewStrict(input);
  } catch {
    return null;
  }
}

/** buildPerpsView without the catch — a malformed input throws. */
export function buildPerpsViewStrict(input: PerpsViewInput): PerpsViewBuilt | null {
  const { settings, ledger, nowSec, mode } = input;
  const exitsOnly = input.exitsOnly === true && mode === "live";
  if (input.feed === null && !exitsOnly) return null;
  const feed: LighterFeedRead = input.feed ?? { observedAt: 0, markets: new Map(), stale: new Set(), staleBooks: new Set() };
  const venue = mode === "live" ? input.venue ?? null : null;
  if (mode === "live" && venue === null) return null;
  const pol = perpPolicySettings(settings, input.grant.perTradeSealedMicro);

  // THE LEVERAGE STATE the account holds per market, flat rows included —
  // where it lives while flat (rule 6: an open is refused unless the venue
  // reads the market isolated at exactly IMF_m). Paper keeps it on its own rows.
  const venueLev = new Map<number, { imfBp: number | null; marginMode: "isolated" | "cross" | null }>();
  if (venue !== null) {
    for (const p of venue.account.positions) venueLev.set(p.marketId, { imfBp: p.imfBp, marginMode: p.marginMode });
  } else {
    for (const r of ledger.positions) venueLev.set(r.marketId, { imfBp: r.imfBp, marginMode: r.marginMode });
  }

  // ── markets: the owner's allowed set ∩ what the feed reads fresh ──────────
  const markets = new Map<PerpKey, PerpMarketView>();
  for (const key of settings.perpsMarkets) {
    const listed = perpMarketByKey(key);
    if (listed === null) continue;
    const fm = feed.markets.get(listed.marketId);
    if (fm === undefined || !feedFresh(feed, fm)) continue; // stale is unread for opens — absent, never "probably fine"
    let lev: { leverage: number; imfBp: number };
    let effMin: bigint;
    try {
      lev = leverageTarget(settings.perpsMaxLeverage, fm.spec);
      effMin = effectiveMinNotionalMicro(fm.spec, fm.mark);
    } catch {
      continue;
    }
    const vl = venueLev.get(listed.marketId);
    markets.set(listed.key, {
      key: listed.key,
      marketId: listed.marketId,
      cls: listed.cls,
      status: fm.status,
      spec: fm.spec,
      markPrice: fm.mark,
      indexPrice: fm.index,
      fundingPpmPerHour: fm.fundingRatePpm,
      lastFunding: fm.lastFunding === null ? null : { ppmPerHour: fm.lastFunding.ratePpm, atSec: Math.floor(fm.lastFunding.atMs / 1000) },
      effMinNotionalMicro: effMin,
      leverage: lev.leverage,
      imfBp: lev.imfBp,
      venueImfBp: vl?.imfBp ?? null,
      venueMarginMode: vl?.marginMode ?? null,
      bestBid: fm.bids[0]?.price ?? null,
      bestAsk: fm.asks[0]?.price ?? null,
      observedAtSec: Math.floor(fm.observedAt / 1000),
      // THE FEED'S OWN HISTORY when the caller hands none (feed-reader.ts:
      // closed4h and funding8h are already cut to what is current and
      // contiguous at the reader's clock, null otherwise). An explicit
      // `candles4h` still wins, so a test or a replay can pin its own.
      closed4h: input.candles4h?.get(listed.marketId) ?? fm.closed4h ?? null,
      funding8h: fm.funding8h,
    });
  }
  const noMarketRead = settings.perpsMarkets.length > 0 && markets.size === 0;
  if (noMarketRead && !exitsOnly) return null;

  // ── positions ─────────────────────────────────────────────────────────────
  const positions = new Map<PerpKey, PerpPositionView>();
  const facts = new Map<PerpKey, PerpPositionFacts>();
  const foreign: PerpAccountPosition[] = [];
  const ledgerRow = new Map<number, PerpsViewLedgerRow>();
  for (const r of ledger.positions) ledgerRow.set(r.marketId, r);
  let marksAllFresh = true;
  let openNotional = 0n;

  if (venue === null) {
    // PAPER: the ledger rows are the book, marked at the feed.
    for (const r of ledger.positions) {
      if (r.base === 0n || r.side === null) continue;
      const listed = perpMarketById(r.marketId);
      // The paper engine trades only the frozen table; a row outside it is a
      // book this build did not write.
      if (listed === null) throw new RangeError(`perps view: paper position on unlisted market ${r.marketId}`);
      const fm = feed.markets.get(r.marketId);
      if (fm === undefined) return null; // cannot be valued at all: the book is unread
      if (r.entryPrice === null || r.entryPrice <= 0n) throw new RangeError(`perps view: paper ${listed.key} has no entry price`);
      if (r.imfBp === null) throw new RangeError(`perps view: paper ${listed.key} has no margin fraction`);
      const fresh = feedFresh(feed, fm);
      if (!fresh) marksAllFresh = false;
      const spec = fm.spec;
      const mark = fm.mark;
      const unrealized = unrealizedPnlMicro({ side: r.side, baseAmount: r.base, entryPrice: r.entryPrice, markPrice: mark, spec });
      const notional = notionalMicro(r.base, mark, spec, "ceil");
      openNotional += notional;
      // The paper venue's own formula (paper.ts paperLiqPrice). null here is
      // "no positive liquidation price" (a 1x long); a row it cannot judge
      // throws — an unknown liquidation is never reported as none.
      const liq = isolatedLiqPrice({ side: r.side, entryPrice: r.entryPrice, baseAmount: r.base, allocatedMarginMicro: r.allocatedMarginMicro, mmfBp: spec.mmfBp, spec });
      const recorded = r.stopTrigger !== null && r.stopPrice !== null ? { trigger: r.stopTrigger, price: r.stopPrice } : null;
      const expires = ledger.stopExpiresAtSec?.get(r.marketId) ?? null;
      positions.set(listed.key, {
        key: listed.key,
        marketId: r.marketId,
        side: r.side,
        baseAmount: r.base,
        entryPrice: r.entryPrice,
        markPrice: mark,
        notionalMicro: notional,
        unrealizedMicro: unrealized,
        allocatedMarginMicro: r.allocatedMarginMicro,
        imfBp: r.imfBp,
        liqPrice: liq,
        // On paper the book's own stop IS the resting stop: the paper engine
        // fires it on the feed's mark, so recorded and resting are one row.
        stop: recorded === null ? null : { ...recorded, expiresAtSec: expires, resting: true },
        take:
          r.takeTrigger !== null && r.takePrice !== null
            ? { trigger: r.takeTrigger, price: r.takePrice, expiresAtSec: null, resting: true }
            : null,
        openedAtSec: r.openedAt ?? 0,
        // The paper engine books funding onto the row; none booked is a known 0 on a book this process writes.
        fundingMicro: r.fundingMicro ?? 0n,
      });
      facts.set(listed.key, {
        key: listed.key,
        marketId: r.marketId,
        decimals: { sizeDecimals: spec.sizeDecimals, priceDecimals: spec.priceDecimals },
        markSource: "feed",
        markFresh: fresh,
        recordedStop: recorded,
        stopState: recorded === null ? "missing" : "resting",
        stopExpiresAtSec: expires,
        restingStopOrder: null,
        otherStopOrders: [],
        openingUnresolved: ledger.unresolvedOpenMarkets.has(r.marketId),
        openedAtKnown: r.openedAt !== null,
        held: heldOf(feed, fm),
      });
    }
  } else {
    // LIVE: the venue account is the book; the ledger adds what it recorded.
    const acct = venue.account;
    for (const p of acct.positions) {
      if (p.baseAmount === 0n || p.side === null) continue;
      const listed = perpMarketById(p.marketId);
      if (listed === null || p.key === null || p.key !== listed.key) {
        foreign.push(p);
        openNotional += abs(p.positionValueMicro);
        continue;
      }
      const side = p.side;
      const fm = feed.markets.get(p.marketId);
      const d: PerpDecimals | undefined = fm !== undefined ? { sizeDecimals: fm.spec.sizeDecimals, priceDecimals: fm.spec.priceDecimals } : venue.decimals.get(p.marketId);
      // parseAccount refuses a non-flat row it has no decimals for, so this
      // is an input built wrong — not a position we can state.
      if (d === undefined) throw new RangeError(`perps view: no decimals for held ${listed.key}`);
      let mark: bigint;
      let markSource: "feed" | "account";
      let markFresh: boolean;
      if (fm !== undefined && feedFresh(feed, fm)) {
        mark = fm.mark;
        markSource = "feed";
        markFresh = true;
      } else {
        const derived = markFromValue(p.positionValueMicro, p.baseAmount, d, side);
        if (derived !== null) {
          mark = derived;
          markSource = "account";
          markFresh = true;
        } else if (fm !== undefined) {
          mark = fm.mark;
          markSource = "feed";
          markFresh = false;
        } else {
          throw new RangeError(`perps view: ${listed.key} cannot be marked`);
        }
      }
      if (!markFresh) marksAllFresh = false;
      const notional = notionalMicro(p.baseAmount, mark, d, "ceil");
      const venueValue = abs(p.positionValueMicro);
      // The cap judges the LARGER of our mark and the venue's value: exposure
      // is never under-counted by whichever read is a tick behind.
      openNotional += notional > venueValue ? notional : venueValue;

      const row = ledgerRow.get(p.marketId);
      let recorded = row !== undefined && row.stopTrigger !== null && row.stopPrice !== null ? { trigger: row.stopTrigger, price: row.stopPrice } : null;
      let stopState: PerpPositionFacts["stopState"];
      let stopExpires: number | null = ledger.stopExpiresAtSec?.get(p.marketId) ?? null;
      let otherStops: string[] = [];
      let restingStopPrice: bigint | null = null;
      let restingStopOrder: string | null = null;
      if (venue.orders === null) {
        stopState = "unread";
      } else {
        const stops = restingOf(venue.orders, p.marketId, side, "stop");
        if (recorded !== null) {
          const rec = recorded;
          const match = stops.find((o) => o.triggerPrice === rec.trigger) ?? null;
          stopState = match !== null ? "resting" : stops.length > 0 ? "other" : "missing";
          if (match !== null) {
            stopExpires = expirySec(match);
            restingStopPrice = match.price;
            restingStopOrder = match.orderIndex;
          }
          otherStops = stops.filter((o) => o !== match).map((o) => o.orderIndex);
        } else {
          // NO RECORD (an adopted position, a wiped cache): the stop the venue
          // shows resting is the stop — the tightest one, which fires first.
          const t = tightest(stops, side);
          if (t !== null) {
            recorded = { trigger: t.triggerPrice, price: t.price };
            stopState = "resting";
            stopExpires = expirySec(t);
            restingStopPrice = t.price;
            restingStopOrder = t.orderIndex;
            otherStops = stops.filter((o) => o !== t).map((o) => o.orderIndex);
          } else {
            stopState = "missing";
          }
        }
      }
      const takeRec = row !== undefined && row.takeTrigger !== null && row.takePrice !== null ? { trigger: row.takeTrigger, price: row.takePrice } : null;
      let take: PerpPositionView["take"] = null;
      if (venue.orders !== null) {
        const takes = restingOf(venue.orders, p.marketId, side, "take");
        const tk = takeRec !== null ? takes.find((o) => o.triggerPrice === takeRec.trigger) ?? null : tightest(takes, side === "long" ? "short" : "long");
        if (tk !== null) take = { trigger: tk.triggerPrice, price: tk.price, expiresAtSec: expirySec(tk), resting: true };
        else if (takeRec !== null) take = { ...takeRec, expiresAtSec: null, resting: false };
      } else if (takeRec !== null) {
        take = { ...takeRec, expiresAtSec: null, resting: false };
      }
      positions.set(listed.key, {
        key: listed.key,
        marketId: p.marketId,
        side,
        baseAmount: p.baseAmount,
        entryPrice: p.avgEntryPrice,
        markPrice: mark,
        notionalMicro: notional,
        unrealizedMicro: p.unrealizedMicro,
        allocatedMarginMicro: p.allocatedMarginMicro,
        imfBp: p.imfBp,
        liqPrice: p.liqPrice,
        stop:
          recorded === null
            ? null
            : { trigger: recorded.trigger, price: restingStopPrice ?? recorded.price, expiresAtSec: stopExpires, resting: stopState === "resting" },
        take,
        openedAtSec: row?.openedAt ?? 0,
        // HOLDER-SIGNED, as the venue renders it: negative = paid. Evidence —
        // account 18958's two longs read -0.011731 and -0.003279 in hours
        // whose /fundings direction was "long" (longs pay). The mainnet
        // checklist confirms it against our own positionFunding rows.
        fundingMicro: p.totalFundingPaidOutMicro,
      });
      facts.set(listed.key, {
        key: listed.key,
        marketId: p.marketId,
        decimals: d,
        markSource,
        markFresh,
        recordedStop: recorded,
        stopState,
        stopExpiresAtSec: stopExpires,
        restingStopOrder,
        otherStopOrders: otherStops,
        openingUnresolved: ledger.unresolvedOpenMarkets.has(p.marketId),
        openedAtKnown: row?.openedAt !== null && row?.openedAt !== undefined,
        held: heldOf(feed, fm),
      });
    }
  }
  openNotional += ledger.pendingOpenNotionalMicro;

  // ── the account and rule 12's term ────────────────────────────────────────
  const tIn = ledger.depositsInTransitMicro;
  const tOut = ledger.withdrawalsInTransitMicro;
  if (tIn < 0n || tOut < 0n || ledger.pendingOpenNotionalMicro < 0n) throw new RangeError("perps view: a ledger total is negative");
  let c: bigint;
  let m: bigint;
  let u: bigint;
  let gain: bigint;
  let book: PerpBookPart | "unread";
  let free: bigint;
  let incident = ledger.incident || foreign.length > 0;
  if (venue !== null) {
    const acct = venue.account;
    c = acct.collateralMicro;
    m = acct.isolatedMarginMicro;
    u = acct.unrealizedMicro;
    gain = acct.unrealizedGainMicro;
    free = c;
    // total_asset_value is the rule-12 cross-check; failing it is a book gap.
    book = totalAssetValueConsistent(acct)
      ? { collateralMicro: c, isolatedMarginMicro: m, unrealizedMicro: u, unrealizedGainMicro: gain, inTransitMicro: tIn + tOut, snapshotTime: acct.transactionTimeUs }
      : "unread";
    // Money in places the worker never puts it (rule 16): spot balances,
    // unlocks, pool shares. Evidence enough to stop opening.
    if (acct.spotHoldings.length > 0 || acct.pendingUnlockCount > 0 || acct.poolShareCount > 0) incident = true;
  } else {
    c = ledger.paperCollateralMicro ?? 0n;
    m = 0n;
    u = 0n;
    gain = 0n;
    for (const pos of positions.values()) {
      m += pos.allocatedMarginMicro;
      u += pos.unrealizedMicro;
      if (pos.unrealizedMicro > 0n) gain += pos.unrealizedMicro;
    }
    free = c + (ledger.paperCashMicro ?? 0n);
    // A paper position valued at a stale mark is a value nobody can stand
    // behind: rule 11 makes it a gap, not a total.
    book = marksAllFresh
      ? { collateralMicro: c, isolatedMarginMicro: m, unrealizedMicro: u, unrealizedGainMicro: gain, inTransitMicro: tIn + tOut, snapshotTime: null }
      : "unread";
  }
  const committed = c + m + tIn;
  const accountValue = c + m + u + tIn + tOut;

  // ── headroom and blockers — the numbers policy judges, as hints ───────────
  const sub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);
  const headroom = {
    perTradeNotionalMicro: pol.perTradeMicro,
    openNotionalLeftMicro: sub(pol.maxOpenNotionalMicro, openNotional),
    collateralLeftMicro: sub(pol.maxCollateralMicro, committed),
    opensLeftToday: Math.max(0, pol.maxOpensPerDay - ledger.opensToday),
  };
  const entriesHalted = settings.perpsEntriesHalted || ledger.entriesHalted;
  const present = new Set<PerpBlocker>();
  if (incident) present.add("perps-unknown-activity");
  if (input.railBlocker) present.add(input.railBlocker);
  if (exitsOnly && (input.feed === null || noMarketRead)) present.add("perps-venue-unreachable");
  if (entriesHalted) present.add("perps-entries-halted");
  if (input.breakerTripped === true) present.add("breaker-tripped");
  const exp = input.grant.expiresAtSec;
  if (exp !== null && (!Number.isFinite(exp) || exp - nowSec < PERP_GRANT_EXPIRING_SEC)) present.add("perps-grant-expiring");
  if (markets.size > 0 && [...markets.values()].every((mk) => mk.effMinNotionalMicro > pol.perTradeMicro)) present.add("perps-cap-below-min");
  if (venue === null) {
    if (ledger.paperCashMicro !== undefined && ledger.paperCashMicro !== null && free <= 0n) present.add("perps-no-collateral");
  } else if (c === 0n && input.accountCashMicro !== undefined && input.accountCashMicro !== null && input.accountCashMicro < MIN_DEPOSIT_MICRO) {
    present.add("perps-no-collateral");
  }

  const keysOf = (ids: ReadonlySet<number>) => {
    const out = new Set<PerpKey>();
    for (const id of ids) {
      const k = perpMarketById(id)?.key;
      if (k !== undefined) out.add(k);
    }
    return out;
  };

  const view: PerpsViewBuilt = {
    mode,
    readAtSec: venue !== null ? Math.floor(venue.account.transactionTimeUs / 1_000_000) : Math.floor(feed.observedAt / 1000),
    account: { collateralMicro: c, freeCollateralMicro: free, accountValueMicro: accountValue, inTransitMicro: tIn + tOut },
    positions,
    markets,
    unresolved: keysOf(ledger.unresolvedMarkets),
    headroom,
    opensBlocked: pickBlocker(present),
    lastExit: ledger.lastExit,
    lastEntryCandleT: ledger.lastEntryCandleT,
    grantExpiresAtSec: exp,
    facts: {
      mode,
      accountIndex: venue?.account.accountIndex ?? null,
      positions: facts,
      foreign,
      venueDecimals: venue?.decimals ?? null,
      book,
      openNotionalMicro: openNotional,
      committedCollateralMicro: committed,
      depositsInTransitMicro: tIn,
      withdrawalsInTransitMicro: tOut,
      incident,
      entriesHalted,
      closeInFlight: keysOf(ledger.closeInFlightMarkets),
      readAtMs: venue !== null ? Math.floor(venue.account.transactionTimeUs / 1000) : feed.observedAt,
    },
  };
  return view;
}

// ── derived shapes ──────────────────────────────────────────────────────────

type PolicyMarket = PerpPolicyState["markets"] extends ReadonlyMap<number, infer V> ? V : never;

/**
 * policy.ts's PerpPolicyState from the SAME figures the view shows.
 *
 * `rail` is perpsModeOf's answer and decides opens and deposits only; exits
 * follow venue exposure (rule 8a), so a refuse or off rail still gets the
 * positions it needs to judge a close. When the view is null (unread), the
 * positions are the LEDGER's — policy.ts says so — no market is read (every
 * open refused as inactive, and perp-unpriced behind it), and the two
 * committed-money totals SATURATE at their caps: unknown is never zero, and a
 * total that cannot be read must refuse the next deposit rather than admit it.
 */
export function buildPerpPolicyState(input: PerpsViewInput, view: PerpsViewBuilt | null, rail: PerpsMode): PerpPolicyState {
  const settings = perpPolicySettings(input.settings, input.grant.perTradeSealedMicro);
  const positions = new Map<number, { side: "long" | "short"; baseAmount: bigint }>();
  const markets = new Map<number, PolicyMarket>();
  let openNotional: bigint;
  let committed: bigint;
  let incident = input.ledger.incident;
  if (view !== null) {
    for (const p of view.positions.values()) positions.set(p.marketId, { side: p.side, baseAmount: p.baseAmount });
    for (const f of view.facts.foreign) {
      if (f.side !== null) positions.set(f.marketId, { side: f.side, baseAmount: f.baseAmount });
    }
    for (const mk of view.markets.values()) {
      markets.set(mk.marketId, {
        status: mk.status,
        effMinNotionalMicro: mk.effMinNotionalMicro,
        imfBpTarget: mk.imfBp,
        venueImfBp: mk.venueImfBp,
        venueMarginMode: mk.venueMarginMode,
        mmfBp: mk.spec.mmfBp,
        spec: mk.spec,
      });
    }
    openNotional = view.facts.openNotionalMicro;
    committed = view.facts.committedCollateralMicro;
    incident = view.facts.incident;
  } else {
    for (const r of input.ledger.positions) {
      if (r.base !== 0n && r.side !== null) positions.set(r.marketId, { side: r.side, baseAmount: r.base });
    }
    openNotional = settings.maxOpenNotionalMicro;
    committed = settings.maxCollateralMicro;
  }
  return {
    mode: rail.mode,
    refuseRule: rail.mode === "refuse" ? rail.rule : null,
    settings,
    openNotionalMicro: openNotional,
    committedCollateralMicro: committed,
    opensToday: input.ledger.opensToday,
    positions,
    markets,
    unresolvedMarkets: input.ledger.unresolvedMarkets,
    closeInFlightMarkets: input.ledger.closeInFlightMarkets,
    incident,
    entriesHalted: input.settings.perpsEntriesHalted || input.ledger.entriesHalted,
    grantExpiresAtSec: input.grant.expiresAtSec,
    nowSec: input.nowSec,
  };
}

/**
 * equity.ts's venue term from the view: C + ΣM + ΣU + T with Σ max(0, Uᵢ) per
 * position (rule 12). Live, every term is the one account response's own sums
 * — foreign positions included, because their money is the account's too.
 * Paper, C is the paper collateral figure (0 unless the engine keeps one; the
 * margin itself left paper cash and is ΣM here), and a stale mark is "unread".
 * A null view is "unread". (`undefined` — the known zero of an agent without
 * perps — is the caller's to pass, never this function's.)
 */
export function buildPerpBookTerm(view: PerpsViewBuilt | null): Exclude<PerpBookTerm, undefined> {
  return view === null ? "unread" : view.facts.book;
}

/** How a rail refusal reads as a PerpBlocker. operator-off has no owner remedy and no blocker (null). */
function railRefusalBlocker(rule: string, railBlocker: PerpBlocker | null | undefined): PerpBlocker | null {
  switch (rule) {
    case "perp-live-not-enabled":
      return "perps-live-off";
    case "perp-not-granted":
      return "perps-not-granted";
    case "perp-venue-unready":
      return railBlocker ?? "perps-venue-unreachable";
    case "perp-operator-off":
      return null;
    // The build, not the owner (lane.ts perpsRailOf): no owner remedy exists
    // until live perps ship, so no blocker is shown — the rail says refuse.
    case "perp-live-not-yet":
      return null;
    default:
      // The account's own RefuseRule: the account is not trading for real.
      return "account-not-live";
  }
}

function reportPosition(
  pos: PerpPositionView,
  f: PerpPositionFacts,
  mode: "paper" | "live",
): PerpsReportPosition {
  const d = f.decimals;
  let leverage: number | null;
  try {
    leverage = leverageFromImfBp(pos.imfBp);
  } catch {
    leverage = null;
  }
  return {
    market: pos.key,
    side: pos.side,
    baseAmount: renderScaled(pos.baseAmount, d.sizeDecimals),
    entryPrice: renderScaled(pos.entryPrice, d.priceDecimals),
    markPrice: f.markFresh ? renderScaled(pos.markPrice, d.priceDecimals) : null,
    leverage,
    marginMicro: pos.allocatedMarginMicro.toString(),
    liqPrice: pos.liqPrice !== null && pos.liqPrice > 0n ? renderScaled(pos.liqPrice, d.priceDecimals) : null,
    // Live U is the venue's own, from this read; paper U at a stale mark is not said.
    unrealizedMicro: mode === "live" || f.markFresh ? pos.unrealizedMicro.toString() : null,
    // Only a stop SEEN resting is shown as one (rule 7).
    stopTrigger: f.stopState === "resting" && f.recordedStop !== null ? renderScaled(f.recordedStop.trigger, d.priceDecimals) : null,
    fundingMicro: pos.fundingMicro.toString(),
  };
}

const REPORT_SYMBOL_RE = /^[A-Z0-9]{1,24}$/;

/**
 * `agents.perps` from the view (core PerpsReport). JSON-safe by construction.
 *
 * A null view reports what the LEDGER holds with every venue figure null — a
 * reader keys "Lighter could not be read" on `collateralMicro === null` — so it
 * never renders "No positions" over leverage it could not see. Only a stop
 * seen resting is shown or left out of `stopsMissing`: a stop whose state was
 * not read counts as missing, because the report must never claim protection
 * nobody saw.
 */
export function buildPerpsReport(
  input: PerpsViewInput,
  view: PerpsViewBuilt | null,
  ctx: { rail: PerpsMode; protectAtMs: number | null; accountIndex?: number | null; lastVenueReadAtMs?: number | null },
): PerpsReport {
  const rail = ctx.rail;
  let blocker: PerpBlocker | null;
  if (rail.mode === "off") blocker = "perps-off";
  else if (rail.mode === "refuse") blocker = railRefusalBlocker(rail.rule, input.railBlocker);
  else if (view === null) blocker = "perps-venue-unreachable";
  else blocker = view.opensBlocked;

  if (view === null) {
    const positions: PerpsReportPosition[] = [];
    for (const r of [...input.ledger.positions].sort((a, b) => a.marketId - b.marketId)) {
      if (r.base === 0n || r.side === null) continue;
      const listed = perpMarketById(r.marketId);
      const spec = input.feed?.markets.get(r.marketId)?.spec;
      if (listed === null || spec === undefined || r.entryPrice === null || r.entryPrice <= 0n) continue;
      let leverage: number | null = null;
      try {
        leverage = r.imfBp === null ? null : leverageFromImfBp(r.imfBp);
      } catch {
        leverage = null;
      }
      positions.push({
        market: listed.key,
        side: r.side,
        baseAmount: renderScaled(r.base, spec.sizeDecimals),
        entryPrice: renderScaled(r.entryPrice, spec.priceDecimals),
        markPrice: null,
        leverage,
        marginMicro: r.allocatedMarginMicro.toString(),
        liqPrice: null,
        unrealizedMicro: null,
        stopTrigger: null,
        fundingMicro: r.fundingMicro === null ? null : r.fundingMicro.toString(),
      });
    }
    const held = input.ledger.positions.filter((r) => r.base !== 0n && r.side !== null).length;
    return {
      v: 1,
      mode: rail.mode,
      blocker,
      venueReadAt: ctx.lastVenueReadAtMs ?? null,
      protectAt: ctx.protectAtMs,
      accountIndex: ctx.accountIndex ?? null,
      positions,
      openNotionalMicro: null,
      collateralMicro: null,
      inTransitMicro: null,
      minLiqDistanceBps: null,
      stopsMissing: held,
      incident: input.ledger.incident,
    };
  }

  const positions: PerpsReportPosition[] = [];
  let minLiq: number | null = null;
  let stopsMissing = 0;
  for (const pos of [...view.positions.values()].sort((a, b) => a.marketId - b.marketId)) {
    const f = view.facts.positions.get(pos.key);
    if (f === undefined) continue;
    positions.push(reportPosition(pos, f, view.mode));
    if (f.stopState !== "resting") stopsMissing += 1;
    if (f.markFresh && pos.liqPrice !== null && pos.markPrice > 0n) {
      const dist = liqDistanceBps({ side: pos.side, markPrice: pos.markPrice, liqPrice: pos.liqPrice });
      if (dist !== null && (minLiq === null || dist < minLiq)) minLiq = dist;
    }
  }
  // Foreign positions are exposure too: shown when they can be rendered, and
  // always counted as unprotected. `incident` is set whenever one exists.
  for (const p of view.facts.foreign) {
    stopsMissing += 1;
    const d = view.facts.venueDecimals?.get(p.marketId);
    if (d === undefined || p.side === null || !REPORT_SYMBOL_RE.test(p.symbol) || p.avgEntryPrice <= 0n) continue;
    let leverage: number | null = null;
    try {
      leverage = leverageFromImfBp(p.imfBp);
    } catch {
      leverage = null;
    }
    positions.push({
      market: `${p.symbol}-PERP` as PerpKey,
      side: p.side,
      baseAmount: renderScaled(p.baseAmount, d.sizeDecimals),
      entryPrice: renderScaled(p.avgEntryPrice, d.priceDecimals),
      markPrice: null,
      leverage,
      marginMicro: p.allocatedMarginMicro.toString(),
      liqPrice: p.liqPrice !== null && p.liqPrice > 0n ? renderScaled(p.liqPrice, d.priceDecimals) : null,
      unrealizedMicro: p.unrealizedMicro.toString(),
      stopTrigger: null,
      fundingMicro: p.totalFundingPaidOutMicro.toString(),
    });
  }
  const f = view.facts;
  return {
    v: 1,
    mode: rail.mode,
    blocker,
    venueReadAt: f.readAtMs,
    protectAt: ctx.protectAtMs,
    accountIndex: f.accountIndex,
    positions,
    openNotionalMicro: f.openNotionalMicro.toString(),
    // What was POSTED at the venue — C + ΣM (committed less money still in
    // transit to it), before unrealized P&L.
    collateralMicro: (f.committedCollateralMicro - f.depositsInTransitMicro).toString(),
    inTransitMicro: view.account.inTransitMicro.toString(),
    minLiqDistanceBps: minLiq,
    stopsMissing,
    incident: f.incident,
  };
}
