/**
 * THE PERPS ROUTE — which one producer may open or strategically close perps
 * this tick, and in what order (docs/perps.md, "The perps route").
 *
 * PERPS ARE A ROUTE BESIDE THE OWNER'S SPOT STRATEGY, NOT A STRATEGY. The
 * owner's `strategy` keeps running exactly as it did; `perpsDriver` picks the
 * ONE autonomous producer for the perp book:
 *
 *   perp-trend  the deterministic producer (perp-trend.ts). Its decisions file
 *               under `perp-route`.
 *   strategist  the LLM strategist's `perpActions`, already validated by
 *               `proposalsToPerpIntents` and journaled by the strategist under
 *               `perp:strategist` (their decisionIds ride on the intents and
 *               ensureDecision reuses them).
 *   manual      nobody: owner orders and protect.ts only.
 *
 * ONE WRITER PER BOOK. Two producers on one book is how a trend exit closes
 * the position a model just opened, or a model adds to one the trend holds.
 * So each driver reads ONLY its own producer's output — perp-trend never runs
 * under `strategist`, and strategist intents handed in under `perp-trend` are
 * ignored, whatever else is true. A driver this build does not know produces
 * nothing (fail closed; it never falls back to perp-trend).
 *
 * THE ORDER, EVERY TICK, after the strategy loop and the class route: exits
 * first, then at most ONE entry. The lane takes each through countsAsEntry →
 * energy claim → ensureDecision(intent, source, …) → processIntentReporting
 * → refund when nothing was placed, the class-route shape.
 *
 * WHAT THIS DOES NOT CONTAIN. protect.ts — stops, liquidation distance, funding
 * bleed, market status — is not the route and does not depend on the driver;
 * it runs on its own clock, before pause and the drawdown return. Pause stops
 * this route (entries AND strategic exits); it never stops protect.ts.
 *
 * UNREAD IS NOTHING. A null view (Lighter not read this tick) originates no
 * entry and no exit either: a strategic exit sized off a position nobody read
 * is a guess, and the backstops that act in the dark read the venue
 * themselves.
 *
 * PURE. The lane supplies the view, the settings and the brakes it measured.
 */

import { perpsStyleForDriver } from "../../../packages/core/src/perps-styles";
import {
  PERP_MIN_DEPOSIT_MICRO,
  isolatedMarginMicro,
  leverageFromImfBp,
  perpDepositForMarginMicro,
  perpMarginFitsCap,
  type PerpKey,
} from "../../../packages/core/src/perps";
import type { PerpsDriver } from "../../../packages/core/src/settings";
import type { Why } from "../strategies/reasons";
import type { PerpsView } from "../strategies/types";
import type { ResolvedConfig } from "../settings";
import type { PerpIntentDraft } from "./drafts";
import { perpTrendTick, type PerpTrendCtx, type PerpTrendSettings } from "./perp-trend";

/** A route intent: a draft, possibly carrying the strategist's decisionId. Assignable to TradeIntent. */
export type PerpRouteIntent = PerpIntentDraft & { decisionId?: string };

export type PerpRouteSettings = PerpTrendSettings & Pick<ResolvedConfig, "perpsEnabled">;

export interface PerpRouteInput {
  /** Snapshot.perps: absent = perps off, null = Lighter unread, else the view. */
  view: PerpsView | null | undefined;
  settings: PerpRouteSettings;
  /** settings.perpsDriver as resolved for THIS tick (the lane turns a strategist driver with no real model into "manual"). */
  driver: PerpsDriver;
  perpTrendCtx: PerpTrendCtx;
  /**
   * The strategist's survivors this tick, with decisionIds stamped — a
   * one-shot handoff the lane clears after this call, so a window's intents
   * are never re-sent on the ticks between windows. Read only under
   * `strategist`.
   */
  strategistPerpIntents?: readonly PerpRouteIntent[];
  /** Brain may only veto the current deterministic candidate; the lane validates its bound review. */
  brainApproved?: boolean;
}

export interface PerpRouteResult {
  exits: PerpRouteIntent[];
  entry: PerpRouteIntent | null;
  /** why[i] explains exits[i]; why[exits.length] explains the entry when there is one. Null = the decision row says it. */
  why: (Why | null)[];
  /** Why no entry, when there is none and something can be said. */
  idle: Why | null;
  /** The decision source for everything above; null when nothing was produced. */
  source: "perp-route" | "perp:strategist" | null;
  /** perp-trend's entry candle `t` (ms), for the ledger's lastEntryCandleT; null otherwise. */
  entryCandleT: number | null;
  /** Strategist intents the current view no longer supports, and why — for the owner's log. */
  dropped: { intent: PerpRouteIntent; why: string }[];
}

const nothing = (idle: Why | null = null): PerpRouteResult => ({
  exits: [],
  entry: null,
  why: [],
  idle,
  source: null,
  entryCandleT: null,
  dropped: [],
});

/** An open's stop distance from its entry reference, in percent (2 dp, rounded toward the entry) — for the owner's sentence. */
function stopPctOf(o: Extract<PerpRouteIntent, { effect: "open" }>): number {
  const ref = o.worstPrice;
  const gap = ref > o.stopTrigger ? ref - o.stopTrigger : o.stopTrigger - ref;
  if (ref <= 0n) return 0;
  return Number((gap * 10_000n) / ref) / 100;
}

/**
 * Run the route for one tick. Exits first, then at most one entry, from the
 * one producer `driver` names.
 */
export function runPerpRoute(input: PerpRouteInput): PerpRouteResult {
  const { view, settings: s, driver, perpTrendCtx: ctx } = input;
  if (driver === "manual") return nothing();
  if (driver !== "perp-trend" && driver !== "brain" && driver !== "strategist") return nothing();
  if (!view) return nothing((driver === "perp-trend" || driver === "brain") && s.perpsEnabled ? { code: "perp-signal-unread", market: null } : null);

  if (driver === "perp-trend" || driver === "brain") {
    const r = perpTrendTick(view, s, ctx);
    // Perps switched off in Settings stops OPENS only (rule 5, 8a): the
    // strategy still closes what it holds on its own rules.
    const entry = s.perpsEnabled && perpsStyleForDriver(s.perpsStyle, driver) && (driver !== "brain" || input.brainApproved === true) ? r.entry : null;
    const why: (Why | null)[] = r.why.slice(0, r.exits.length);
    if (entry !== null) why.push(r.why[r.exits.length] ?? null);
    const produced = r.exits.length > 0 || entry !== null;
    return {
      exits: r.exits,
      entry,
      why,
      idle: entry === null && s.perpsEnabled ? r.idle : null,
      source: produced ? "perp-route" : null,
      entryCandleT: entry !== null ? r.entryCandleT : null,
      dropped: [],
    };
  }

  // ── strategist ─────────────────────────────────────────────────────────
  //
  // The intents were validated against this tick's view when the strategist
  // built them; they are re-held here to the one thing that can have changed
  // in between (the ledger this tick) and to the route's own rules: an exit
  // must still name a held position on its held side, one exit per market;
  // the entry must still be allowed at all, and only the first survives.
  const out: PerpRouteResult = nothing();
  const exited = new Set<PerpKey>();
  const opens: Extract<PerpRouteIntent, { effect: "open" }>[] = [];
  for (const i of input.strategistPerpIntents ?? []) {
    if (i.kind !== "perp-order" || i.venue !== "lighter") {
      out.dropped.push({ intent: i, why: "not a Lighter perp order" });
      continue;
    }
    if (i.effect === "open") {
      opens.push(i);
      continue;
    }
    const held = view.positions.get(i.market);
    if (held === undefined || held.baseAmount <= 0n) {
      out.dropped.push({ intent: i, why: `nothing is held on ${i.market} any more` });
      continue;
    }
    if (held.side !== i.side) {
      out.dropped.push({ intent: i, why: `the ${i.market} position is ${held.side}, not ${i.side}` });
      continue;
    }
    if (exited.has(i.market)) {
      out.dropped.push({ intent: i, why: `${i.market} already has an exit this tick` });
      continue;
    }
    exited.add(i.market);
    out.exits.push(i);
    out.why.push(null);
  }

  const gate = ((): string | null => {
    if (!s.perpsEnabled) return "perpetuals are off in Settings";
    if (view.opensBlocked !== null) return `opens are blocked (${view.opensBlocked})`;
    if (!ctx.breakerIdle) return "the drawdown breaker is tripped";
    if (!ctx.energyEntriesLeft) return "today's energy for new positions is used up";
    if (!ctx.opsHeadroom) return "today's operation count is used up";
    if (!(view.headroom.opensLeftToday > 0)) return "no perp opens are left today";
    return null;
  })();
  for (const o of opens) {
    if (out.entry !== null) {
      out.dropped.push({ intent: o, why: "one new position per tick" });
      continue;
    }
    if (gate !== null) {
      out.dropped.push({ intent: o, why: gate });
      continue;
    }
    const m = view.markets.get(o.market);
    if (m === undefined || m.status !== "active") {
      out.dropped.push({ intent: o, why: `${o.market} is not open for trading this tick` });
      continue;
    }
    if (view.positions.has(o.market) || view.unresolved.has(o.market) || exited.has(o.market)) {
      out.dropped.push({ intent: o, why: `${o.market} already holds a position or an unresolved order` });
      continue;
    }
    let leverage: number;
    try {
      leverage = leverageFromImfBp(o.imfBp);
    } catch {
      out.dropped.push({ intent: o, why: "its margin fraction is not a fraction" });
      continue;
    }
    out.entry = o;
    out.why.push({ code: "perp-open", market: o.market, side: o.side, leverage, stopPct: stopPctOf(o) });
  }
  out.source = out.exits.length > 0 || out.entry !== null ? "perp:strategist" : null;
  return out;
}

/**
 * THE MARGIN DEPOSIT THAT FUNDS A PENDING OPEN, or why there is none.
 *
 * Deposits exist ONLY to fund an entry the route is about to send (docs/perps.md
 * "The perps route": margin + 10%, within caps) — never to rescue a loser,
 * which is what a deposit into a position under water would be. So this is
 * asked with the entry in hand:
 *
 *   need    = isolated margin of the open's notional at its IMF, + 10%,
 *             less the free collateral already at the venue (rounded UP)
 *   refused when it exceeds any bound: the room left under
 *             perpsMaxCollateralUsdg FOR THE DEPOSIT AND THE OPEN TOGETHER,
 *             the sealed per-trade cap (the wall pins the deposit's amount to
 *             it), or the day's spend headroom (a deposit is spend, rule 6) —
 *             the open then waits, it is never shrunk here (sizing is the
 *             producer's, core perpOpenMarginBudgetMicro)
 *   raised  to Lighter's 1 USDG minimum deposit when smaller, if that fits
 *
 * WHY TOGETHER. A landed deposit is committed (C), and checkPerpOpen judges
 * the open's margin as new commitment on top of it: committed + deposit +
 * margin ≤ cap. A deposit checked against the room alone would pass, land,
 * and then be the very thing that refuses the open it was posted to fund —
 * and every retry after it would find enough free collateral, post nothing,
 * and be refused again, stranding the USDG at the venue (the review's
 * S3-COLLATERAL-SIZING-MISMATCH). So nothing is deposited for an open the
 * cap will not then admit.
 *
 * `{ amountMicro: 0n }` means the collateral already there covers it.
 */
export function depositToFund(
  entry: Pick<Extract<PerpRouteIntent, { effect: "open" }>, "notionalUsdg" | "imfBp">,
  view: Pick<PerpsView, "account" | "headroom">,
  caps: { perTradeSealedMicro: bigint; spendHeadroomMicro: bigint | null; minDepositMicro?: bigint },
): { ok: true; amountMicro: bigint } | { ok: false; why: string } {
  let margin: bigint;
  try {
    margin = isolatedMarginMicro(entry.notionalUsdg, entry.imfBp);
  } catch {
    return { ok: false, why: "the open's margin fraction is not a fraction" };
  }
  const amount = perpDepositForMarginMicro(margin, view.account.freeCollateralMicro, caps.minDepositMicro ?? PERP_MIN_DEPOSIT_MICRO);
  // The room is cap − committed (view.ts headroom), so committed + deposit +
  // margin ≤ cap is deposit + margin ≤ room — checkPerpOpen's own test
  // (core perpMarginFitsCap) with the deposit already landed.
  if (!perpMarginFitsCap(amount, margin, view.headroom.collateralLeftMicro)) {
    return { ok: false, why: "the deposit and the open's margin together would pass the most you allowed at Lighter" };
  }
  if (amount === 0n) return { ok: true, amountMicro: 0n };
  if (amount > caps.perTradeSealedMicro) return { ok: false, why: "it is over the signed per-trade cap" };
  if (caps.spendHeadroomMicro !== null && amount > caps.spendHeadroomMicro) return { ok: false, why: "it is over what is left of today's spending" };
  return { ok: true, amountMicro: amount };
}
