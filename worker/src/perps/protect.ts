/**
 * THE PROTECTIVE LOOP — what keeps a leveraged position from outliving its
 * protection when nobody is watching (docs/perps.md rules 7, 8, 8a, 11, 13;
 * review amendments protect-loop-own-clock, protective-loop-thresholds,
 * venue-stop-semantics, venue-stop-expiry-and-price-band).
 *
 * THE VENUE STOP IS THE PRIMARY PROTECTION; THIS IS THE BACKSTOP. A resting
 * Lighter stop is a bounded-price IOC that expires: a gap through its worst
 * price leaves the position open, and a stop that lapsed leaves none. This
 * module looks at every open position on its own clock and asks, in priority
 * order, whether the position must go now, or its stop be put back:
 *
 *   P1 liquidation proximity  |mark − liq| / mark ≤ buffer/2 → close;
 *                             ≤ buffer → alert once per episode. Also: the
 *                             recorded stop's worst price no longer beats the
 *                             venue's liquidation price at all (funding moved
 *                             it) → close (`liq-inside-stop`): that stop can
 *                             never fire first.
 *   P2 stop breached          mark ≥ 25 bps past the stop trigger on two reads
 *                             ≥ 15 s apart, position still open → close. With
 *                             NO stop seen resting the grace is 0 bps: the
 *                             25 bps exist to let the venue stop act first,
 *                             and there is none to wait for.
 *   P3 stop missing/wrong     missing, resting at another trigger, or expiring
 *                             within 7 days → re-place at the recorded stop
 *                             (or let P2 run if mark is already past it); two
 *                             placements that never showed up → close.
 *   P4 funding bleed          funding paid since open ≥ 50% of the initial
 *                             stop risk, or the current rate against the side
 *                             ≥ 0.05%/h → close.
 *   P5 market status          reduce-only → alert (policy already refuses
 *                             opens); inactive → one close per episode.
 *   P6 authority changes      the caller's (kill, expiry, switches) — rule 13.
 *   P7 venue unread           alerts at 2 and 10 minutes. NEVER A CLOSE FROM
 *                             UNREAD STATE: a close decided on a mark or a
 *                             position nobody read is a guess with leverage.
 *
 * AT MOST ONE CLOSE PER MARKET PER PASS — the first rule that fires wins — and
 * never within 30 s of the last one this loop sent for that market (rule 9
 * lets a reduce-only close be signed anew while an earlier one is ambiguous;
 * the spacing keeps that from spending the exit rate budget every pass). A
 * market whose OPEN is still unresolved, or under 60 s old, is left alone: its
 * stop child may simply not be visible yet.
 *
 * EVERY CLOSE IS A DRAFT, not a send: a reduce-only, full-size perp-order the
 * lane mints through ensureDecision with Why `perp-risk-exit{cause}` (so
 * provenance.ts reads it `hard-risk-exit`) and sends under rule 9. This module
 * never signs, never persists, never reads the network, and imports nothing
 * from the spot rail or the EVM intent chain: evaluateProtection is pure, and
 * startProtectLoop is only a clock.
 *
 * ITS OWN CLOCK (protect-loop-own-clock). startProtectLoop runs on a timer of
 * its own — 15 s while anything is held or resting, 60 s otherwise — never
 * from tick(), so pause, grant expiry, an unreadable Robinhood Chain, the
 * on-chain breaker or any tick early return cannot switch it off. Its sends
 * share one lock (createPerpLaneLock) with the lane's, held only across
 * sign → persist → send.
 */

import {
  liqDistanceBps,
  notionalMicro,
  stopPrices,
  worstPriceForTaker,
  type PerpKey,
  type PerpSide,
} from "../../../packages/core/src/index";
import type { PerpExitIntent } from "../policy";
import type { Why } from "../strategies/reasons";
import { perpsPctToBps, renderScaled, type PerpPositionFacts, type PerpsViewBuilt, type PerpsViewSettings } from "./view";

// ── thresholds ──────────────────────────────────────────────────────────────

/** Every number the loop acts on (protective-loop-thresholds), frozen so a test pins each one. */
export const PROTECT_THRESHOLDS = Object.freeze({
  /** Cadence while a position or resting order exists. */
  activeIntervalMs: 15_000,
  /** Cadence otherwise. */
  idleIntervalMs: 60_000,
  /** An open younger than this is left to its own stop child. */
  openGraceSec: 60,
  /** P2: how far past the trigger mark must be while a stop rests. */
  breachBps: 25,
  /** P2: the two reads must be at least this far apart. */
  breachConfirmSec: 15,
  /** P3: a stop expiring sooner than this is renewed (the contract's 7 days, not 48 h). */
  stopRenewSec: 7 * 86_400,
  /** P4: funding paid ≥ this share (bp) of the initial stop risk. */
  fundingPaidShareBps: 5_000,
  /** P4: a current rate against the side of at least this, ppm of notional per hour (0.05%/h). */
  fundingAgainstPpmPerHour: 500,
  /** No second close on a market this soon after the last one. */
  closeRetrySec: 30,
  /** No second stop placement this soon — the last one needs a read to show up. */
  replaceRetrySec: 60,
  /** Placements that never appeared before the position is closed instead (`stop-missing`). */
  replaceAttempts: 2,
  /** A protective close's slippage: 2 × perpsMaxSlippageBps, never under the stand-down's floor (rule 13)… */
  closeSlipFloorBps: 150,
  /** …and never past 4.5%, inside the venue's 5% price band. */
  closeSlipCapBps: 450,
  /** P7: the first unread alert, and the one that names `merrymen recover`. */
  unreadAlertSec: 120,
  unreadRecoverAlertSec: 600,
  /** A view older than this is unread, whatever it says. */
  viewMaxAgeSec: 60,
});

/** The perps settings the loop reads. */
export type ProtectSettings = Pick<PerpsViewSettings, "perpsStopLossPct" | "perpsStopSlipBps" | "perpsLiqBufferPct" | "perpsMaxSlippageBps">;

// ── actions and memory ──────────────────────────────────────────────────────

/** Every cause this loop closes for — each one a perp-risk-exit cause in strategies/reasons.ts. */
export type ProtectCause = "liq-proximity" | "liq-inside-stop" | "stop-breached" | "stop-missing" | "funding-bleed" | "market-status";
export type ProtectRule = "P1" | "P2" | "P3" | "P4" | "P5" | "P7";
export type ProtectAlertCode =
  | "perp-liq-proximity"
  | "perp-stop-missing"
  | "perp-stop-expiring"
  | "perp-stop-underivable"
  | "perp-close-unpriceable"
  | "perp-market-reduce-only"
  | "perp-market-inactive"
  | "perp-venue-unread"
  | "perp-venue-unread-recover";

export type PerpRiskExitWhy = Extract<Why, { code: "perp-risk-exit" }>;

export type ProtectAction =
  | {
      kind: "close";
      rule: ProtectRule;
      market: PerpKey;
      marketId: number;
      /** The side HELD. */
      side: PerpSide;
      cause: ProtectCause;
      /** Reduce-only, full view-read size, priced 2 × slippage (floored, capped) from the mark. */
      intent: PerpExitIntent;
      why: PerpRiskExitWhy;
    }
  | {
      kind: "replace-stop";
      rule: "P3";
      market: PerpKey;
      marketId: number;
      side: PerpSide;
      /** Position-tied, reduce-only STOP_LOSS at these venue integers; the executor sets a fresh 28-day expiry. */
      trigger: bigint;
      price: bigint;
      reason: "missing" | "other" | "expiring";
      /** Venue order indexes to cancel ONLY once the new stop is seen resting (never before: rule 13 never removes a stop first). */
      supersedes: readonly string[];
    }
  | { kind: "alert"; rule: ProtectRule; market: PerpKey | null; code: ProtectAlertCode; text: string };

/** One market's episode state. An episode ends when its condition clears or the position is gone. */
export interface ProtectMarketMemory {
  /** P2: when the current breach was first read (unix s); null = not breached. */
  firstBreachAt: number | null;
  /** P1: the proximity alert for this episode was sent. */
  liqAlerted: boolean;
  /** P3: the missing/expiring-stop alert for this episode was sent. */
  stopAlerted: boolean;
  /** P3: placements sent this episode, and when the last went. */
  replaceAttempts: number;
  lastReplaceAt: number | null;
  /** P5: the non-active status this episode is about, whether it was alerted and whether its one close went. */
  statusEpisode: "reduce-only" | "inactive" | null;
  statusCloseSent: boolean;
  /** The last close this loop drafted for the market (unix s). */
  lastCloseAt: number | null;
}

export interface ProtectMemory {
  markets: ReadonlyMap<PerpKey, ProtectMarketMemory>;
  /** P7: when the current unread spell began (unix s); null = reading. */
  unreadSince: number | null;
  unreadAlerted: boolean;
  unreadRecoverAlerted: boolean;
}

export function emptyProtectMemory(): ProtectMemory {
  return { markets: new Map(), unreadSince: null, unreadAlerted: false, unreadRecoverAlerted: false };
}

function freshMarketMemory(): ProtectMarketMemory {
  return {
    firstBreachAt: null,
    liqAlerted: false,
    stopAlerted: false,
    replaceAttempts: 0,
    lastReplaceAt: null,
    statusEpisode: null,
    statusCloseSent: false,
    lastCloseAt: null,
  };
}

// ── pure helpers ────────────────────────────────────────────────────────────

const BP = 10_000n;

/** Mark at or past the trigger, by at least `bps` of the trigger, in the direction that hurts `side`. */
function pastTrigger(side: PerpSide, mark: bigint, trigger: bigint, bps: number): boolean {
  const gap = side === "long" ? trigger - mark : mark - trigger;
  return gap >= 0n && gap * BP >= trigger * BigInt(bps);
}

/** The stop's worst price no longer beats liquidation at all: a long's at or below it, a short's at or above. */
function stopInsideLiq(side: PerpSide, stopPrice: bigint, liq: bigint): boolean {
  return side === "long" ? stopPrice <= liq : stopPrice >= liq;
}

/** The slippage a protective close accepts: 2 × the owner's, floored at the stand-down's and capped inside the venue band. */
export function protectCloseSlipBps(maxSlippageBps: number): number {
  const t = PROTECT_THRESHOLDS;
  const twice = Number.isSafeInteger(maxSlippageBps) && maxSlippageBps > 0 ? 2 * maxSlippageBps : t.closeSlipFloorBps;
  return Math.min(t.closeSlipCapBps, Math.max(t.closeSlipFloorBps, twice));
}

/**
 * The stop a position SHOULD have when none is recorded (an adopted position,
 * a wiped cache): the owner's setting applied to its entry, exactly as an open
 * builds one (rule 7). null when it cannot be built — the caller alerts.
 */
function derivedStop(side: PerpSide, entry: bigint, s: ProtectSettings): { trigger: bigint; price: bigint } | null {
  try {
    return stopPrices({ side, entryRefPrice: entry, stopLossBps: perpsPctToBps(s.perpsStopLossPct), stopSlipBps: s.perpsStopSlipBps });
  } catch {
    return null;
  }
}

/**
 * How fast the loop should run: 15 s whenever anything could need it — a
 * position, a foreign position, an unresolved order, or a view nobody could
 * read (unknown is never "nothing held") — else 60 s.
 */
export function protectCadenceMs(view: PerpsViewBuilt | null): number {
  if (view === null || view.positions.size > 0 || view.facts.foreign.length > 0 || view.unresolved.size > 0) {
    return PROTECT_THRESHOLDS.activeIntervalMs;
  }
  return PROTECT_THRESHOLDS.idleIntervalMs;
}

// ── the evaluation ──────────────────────────────────────────────────────────

export interface ProtectInput {
  /** This pass's view (buildPerpsView). null = the venue could not be read. */
  view: PerpsViewBuilt | null;
  nowSec: number;
  settings: ProtectSettings;
  prior: ProtectMemory;
  /**
   * The fleet feed read fresh this pass. When false, only marks the view took
   * from this pass's own venue account read (live) are acted on; a feed mark
   * is not.
   */
  feedFresh: boolean;
}

/**
 * One protective pass over the view: the actions to take, and the memory the
 * next pass needs. PURE — no clock, no I/O, no randomness; the same input is
 * the same answer, which is what lets every priority be tested alone.
 */
export function evaluateProtection(input: ProtectInput): { actions: ProtectAction[]; memory: ProtectMemory } {
  const { view, nowSec, settings, prior, feedFresh } = input;
  const t = PROTECT_THRESHOLDS;
  const actions: ProtectAction[] = [];
  const markets = new Map<PerpKey, ProtectMarketMemory>();

  const viewUnread = view === null || !Number.isFinite(view.readAtSec) || nowSec - view.readAtSec > t.viewMaxAgeSec;
  if (viewUnread) {
    // P7, AND NOTHING ELSE: no position, mark or stop state was read, so no
    // close and no placement is decided here. Episode memory carries over —
    // except a breach, which needs two CONSECUTIVE reads, not two reads with
    // an outage between them.
    for (const [k, m] of prior.markets) markets.set(k, { ...m, firstBreachAt: null });
    return { actions, memory: { markets, ...unreadAlerts(actions, prior, nowSec, "venue") } };
  }

  const liqBufferBps = perpsPctToBps(settings.perpsLiqBufferPct);
  let anyMarkFresh = false;
  const ordered = [...view.positions.values()].sort((a, b) => a.marketId - b.marketId);
  for (const pos of ordered) {
    const f = view.facts.positions.get(pos.key);
    if (f === undefined) continue;
    const m: ProtectMarketMemory = { ...(prior.markets.get(pos.key) ?? freshMarketMemory()) };
    markets.set(pos.key, m);
    const mf = f.markFresh && (f.markSource === "account" || feedFresh);
    if (mf) anyMarkFresh = true;

    // THE OPEN IS STILL LANDING: its stop child may not be visible yet, and a
    // "missing stop" here would place a second one beside it.
    // (An open "from the future" by more than the grace is a bad stamp, not a
    // young position — it must not defer protection forever.)
    const age = nowSec - pos.openedAtSec;
    if (f.openingUnresolved || (f.openedAtKnown && age < t.openGraceSec && age > -t.openGraceSec)) {
      m.firstBreachAt = null;
      continue;
    }
    if (!mf) m.firstBreachAt = null;

    const ref = f.recordedStop ?? derivedStop(pos.side, pos.entryPrice, settings);
    const d = f.decimals;
    const px = (v: bigint) => renderScaled(v, d.priceDecimals);
    let close: { rule: ProtectRule; cause: ProtectCause } | null = null;

    // ── P1 liquidation proximity ────────────────────────────────────────────
    if (mf && pos.liqPrice !== null) {
      const dist = liqDistanceBps({ side: pos.side, markPrice: pos.markPrice, liqPrice: pos.liqPrice });
      if (dist !== null && dist * 2 <= liqBufferBps) {
        close = { rule: "P1", cause: "liq-proximity" };
      } else if (f.recordedStop !== null && stopInsideLiq(pos.side, f.recordedStop.price, pos.liqPrice)) {
        // Judged only against a RECORDED stop: a derived one is our guess at
        // what the position should have had, not a stop that failed.
        close = { rule: "P1", cause: "liq-inside-stop" };
      } else if (dist !== null && dist <= liqBufferBps) {
        if (!m.liqAlerted) {
          m.liqAlerted = true;
          actions.push({
            kind: "alert",
            rule: "P1",
            market: pos.key,
            code: "perp-liq-proximity",
            text:
              `${pos.key} (${pos.side}) is within ${settings.perpsLiqBufferPct}% of its liquidation price: mark ${px(pos.markPrice)}, ` +
              `liquidation ${px(pos.liqPrice)}. It is closed if it gets within half that.`,
          });
        }
      } else {
        m.liqAlerted = false;
      }
    }

    // ── P2 stop breached ────────────────────────────────────────────────────
    if (close === null) {
      if (mf && ref !== null) {
        const noneResting = f.stopState === "missing" || f.stopState === "other";
        if (pastTrigger(pos.side, pos.markPrice, ref.trigger, noneResting ? 0 : t.breachBps)) {
          if (m.firstBreachAt === null) m.firstBreachAt = nowSec;
          else if (nowSec - m.firstBreachAt >= t.breachConfirmSec) close = { rule: "P2", cause: "stop-breached" };
        } else {
          m.firstBreachAt = null;
        }
      } else {
        m.firstBreachAt = null;
      }
    }

    // ── P3 stop missing, wrong or expiring ──────────────────────────────────
    // An UNREAD order state is neither: re-placing on it would stack stops
    // under a position whose real stop may be resting fine.
    if (close === null && f.stopState !== "unread") {
      const expiring =
        f.stopState === "resting" &&
        // A live stop whose expiry was not read cannot be shown to live; a
        // paper stop is the engine's own and has none.
        (f.stopExpiresAtSec === null ? view.facts.mode === "live" : f.stopExpiresAtSec - nowSec < t.stopRenewSec);
      const reason: "missing" | "other" | "expiring" | null =
        f.stopState === "missing" ? "missing" : f.stopState === "other" ? "other" : expiring ? "expiring" : null;
      if (reason === null) {
        m.stopAlerted = false;
        m.replaceAttempts = 0;
        m.lastReplaceAt = null;
      } else {
        const firstInEpisode = !m.stopAlerted;
        if (firstInEpisode) {
          m.stopAlerted = true;
          actions.push({
            kind: "alert",
            rule: "P3",
            market: pos.key,
            code: reason === "expiring" ? "perp-stop-expiring" : "perp-stop-missing",
            text:
              reason === "expiring"
                ? `${pos.key}'s stop at Lighter expires soon; a fresh one is being placed before it lapses.`
                : `${pos.key} (${pos.side}) has no stop resting at Lighter at its recorded level; a replacement is being placed.`,
          });
        }
        if (ref === null) {
          if (firstInEpisode) {
            actions.push({
              kind: "alert",
              rule: "P3",
              market: pos.key,
              code: "perp-stop-underivable",
              text: `${pos.key} has no recorded stop and one could not be built from its entry; it is watched for liquidation distance only.`,
            });
          }
        } else if (mf && pastTrigger(pos.side, pos.markPrice, ref.trigger, 0)) {
          // Mark is already past it: a stop placed now is a close by another
          // name. P2's two-read clock (started above) owns this.
        } else if (m.lastReplaceAt !== null && nowSec - m.lastReplaceAt < t.replaceRetrySec) {
          // The last placement has not had a read to show up in yet.
        } else if (reason !== "expiring" && m.replaceAttempts >= t.replaceAttempts) {
          // Placements that never appeared: no position stays open without a
          // stop (venue-stop-expiry-and-price-band). An EXPIRING stop still
          // rests, so it is retried, not closed on.
          if (mf) close = { rule: "P3", cause: "stop-missing" };
        } else {
          m.replaceAttempts += 1;
          m.lastReplaceAt = nowSec;
          const supersedes = [...f.otherStopOrders];
          if (reason === "expiring" && f.restingStopOrder !== null) supersedes.unshift(f.restingStopOrder);
          actions.push({
            kind: "replace-stop",
            rule: "P3",
            market: pos.key,
            marketId: pos.marketId,
            side: pos.side,
            trigger: ref.trigger,
            price: ref.price,
            reason,
            supersedes,
          });
        }
      }
    }

    // ── P4 funding bleed ────────────────────────────────────────────────────
    if (close === null && mf) {
      const paid = pos.fundingMicro < 0n ? -pos.fundingMicro : 0n;
      let risk = 0n;
      try {
        risk = (notionalMicro(pos.baseAmount, pos.entryPrice, d, "floor") * BigInt(perpsPctToBps(settings.perpsStopLossPct))) / BP;
      } catch {
        risk = 0n;
      }
      if (risk > 0n && paid * BP >= risk * BigInt(t.fundingPaidShareBps)) {
        close = { rule: "P4", cause: "funding-bleed" };
      } else if (f.held.fresh && f.held.fundingPpmPerHour !== null) {
        const r = f.held.fundingPpmPerHour; // positive = longs pay
        if (pos.side === "long" ? r >= t.fundingAgainstPpmPerHour : r <= -t.fundingAgainstPpmPerHour) {
          close = { rule: "P4", cause: "funding-bleed" };
        }
      }
    }

    // ── P5 market status ────────────────────────────────────────────────────
    if (f.held.fresh && f.held.status !== null) {
      const st = f.held.status;
      if (st === "active") {
        m.statusEpisode = null;
        m.statusCloseSent = false;
      } else {
        if (m.statusEpisode !== st) {
          m.statusEpisode = st;
          m.statusCloseSent = false;
          actions.push({
            kind: "alert",
            rule: "P5",
            market: pos.key,
            code: st === "inactive" ? "perp-market-inactive" : "perp-market-reduce-only",
            text:
              st === "inactive"
                ? `Lighter shows ${pos.key} as not trading; one close of the position is attempted. If Lighter refuses it, the position keeps its stop.`
                : `${pos.key} is reduce-only on Lighter: nothing new opens there, and the position keeps its stop.`,
          });
        }
        if (st === "inactive" && close === null && !m.statusCloseSent && mf) {
          close = { rule: "P5", cause: "market-status" };
        }
      }
    }

    // ── the one close ───────────────────────────────────────────────────────
    if (close === null) continue;
    if (m.lastCloseAt !== null && nowSec - m.lastCloseAt < t.closeRetrySec) continue;
    let worst: bigint;
    try {
      worst = worstPriceForTaker({ isAsk: pos.side === "long", mark: pos.markPrice, maxSlippageBps: protectCloseSlipBps(settings.perpsMaxSlippageBps) });
    } catch {
      actions.push({
        kind: "alert",
        rule: close.rule,
        market: pos.key,
        code: "perp-close-unpriceable",
        text: `${pos.key} needs closing (${close.cause}) but no order price could be built from its mark; its venue stop still rests.`,
      });
      continue;
    }
    const intent: PerpExitIntent = {
      kind: "perp-order",
      venue: "lighter",
      market: pos.key,
      marketId: pos.marketId,
      effect: "close",
      side: pos.side,
      reduceOnly: true,
      baseAmount: pos.baseAmount,
      worstPrice: worst,
      markPrice: pos.markPrice,
      // Informational on an exit (nothing caps one); at the mark, as drafts.ts's buildExitDraft states it.
      notionalUsdg: notionalMicro(pos.baseAmount, pos.markPrice, d, "ceil"),
    };
    m.lastCloseAt = nowSec;
    if (close.rule === "P5") m.statusCloseSent = true;
    actions.push({
      kind: "close",
      rule: close.rule,
      market: pos.key,
      marketId: pos.marketId,
      side: pos.side,
      cause: close.cause,
      intent,
      why: { code: "perp-risk-exit", market: pos.key, side: pos.side, cause: close.cause },
    });
  }

  // P7 FOR PRICES: positions held and not one fresh mark among them is as
  // unread as the account itself, as far as acting goes.
  const pricesUnread = ordered.length > 0 && !anyMarkFresh;
  if (pricesUnread) return { actions, memory: { markets, ...unreadAlerts(actions, prior, nowSec, "prices") } };
  return { actions, memory: { markets, unreadSince: null, unreadAlerted: false, unreadRecoverAlerted: false } };
}

/** P7's two alerts, once each per unread spell. */
function unreadAlerts(
  actions: ProtectAction[],
  prior: ProtectMemory,
  nowSec: number,
  what: "venue" | "prices",
): Pick<ProtectMemory, "unreadSince" | "unreadAlerted" | "unreadRecoverAlerted"> {
  const t = PROTECT_THRESHOLDS;
  const since = prior.unreadSince ?? nowSec;
  let alerted = prior.unreadAlerted;
  let recover = prior.unreadRecoverAlerted;
  const cannot = what === "venue" ? "Lighter positions cannot be read" : "Lighter's prices cannot be read";
  if (!alerted && nowSec - since >= t.unreadAlertSec) {
    alerted = true;
    actions.push({ kind: "alert", rule: "P7", market: null, code: "perp-venue-unread", text: `${cannot}; resting venue stops still protect them.` });
  }
  if (!recover && nowSec - since >= t.unreadRecoverAlertSec) {
    recover = true;
    actions.push({
      kind: "alert",
      rule: "P7",
      market: null,
      code: "perp-venue-unread-recover",
      text:
        `${cannot} for 10 minutes. Resting venue stops still protect open positions, but nothing else can act on them ` +
        "until it reads. To see and unwind them with your owner key, run `merrymen recover`.",
    });
  }
  return { unreadSince: since, unreadAlerted: alerted, unreadRecoverAlerted: recover };
}

// ── the lane lock ───────────────────────────────────────────────────────────

/**
 * ONE LOCK FOR EVERY LIGHTER SEND — the tick's perp lane and this loop.
 *
 * Held ONLY across sign → persist → send (protect-loop-own-clock): never
 * across a poll, a receipt wait or an on-chain leg, so a protective close
 * waits at most one send behind the lane, never behind the lane's whole tick.
 * Nonces do not depend on it — the high-water is committed before signing
 * (rule 9) — the lock keeps the two writers' sends in one order.
 *
 * BOUNDED: a holder that outlives `holdMs` (api.ts's own timeouts make that a
 * bug, not a slow venue) loses the lock, and the next waiter proceeds; the
 * overrunning send still completes or fails on its own, and its persisted row
 * is the reconcile's. A waiter whose `signal` aborts leaves the queue without
 * running — which is how an abandoned protective pass is kept from sending.
 */
export interface PerpLaneLock {
  run<T>(fn: () => Promise<T>, opts?: { signal?: AbortSignal; label?: string }): Promise<T>;
  /** Someone holds it right now. */
  readonly busy: boolean;
  /** How many are queued behind the holder. */
  readonly waiting: number;
}

export const PERP_LANE_LOCK_HOLD_MS = 20_000;

export function createPerpLaneLock(
  opts: { holdMs?: number; onOverrun?: (info: { label: string | null; holdMs: number }) => void } = {},
): PerpLaneLock {
  const holdMs = typeof opts.holdMs === "number" && Number.isFinite(opts.holdMs) && opts.holdMs > 0 ? opts.holdMs : PERP_LANE_LOCK_HOLD_MS;
  let tail: Promise<void> = Promise.resolve();
  let holder: object | null = null;
  let waiting = 0;

  const aborted = (signal: AbortSignal | undefined) =>
    signal?.reason instanceof Error ? signal.reason : new Error("perp lane lock: the waiter was aborted");

  function waitTurn(prev: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
    if (signal === undefined) return prev;
    if (signal.aborted) return Promise.reject(aborted(signal));
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(aborted(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      prev.then(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    });
  }

  return {
    get busy() {
      return holder !== null;
    },
    get waiting() {
      return waiting;
    },
    run<T>(fn: () => Promise<T>, o: { signal?: AbortSignal; label?: string } = {}): Promise<T> {
      const prev = tail;
      let release!: () => void;
      const mine = new Promise<void>((r) => {
        release = r;
      });
      // The chain never rejects: each link resolves when its holder frees it.
      tail = prev.then(() => mine);
      const me = {};
      let freed = false;
      const free = () => {
        if (freed) return;
        freed = true;
        if (holder === me) holder = null;
        release();
      };
      waiting += 1;
      return (async () => {
        try {
          await waitTurn(prev, o.signal);
        } catch (e) {
          waiting -= 1;
          free();
          throw e;
        }
        waiting -= 1;
        if (o.signal?.aborted) {
          free();
          throw aborted(o.signal);
        }
        holder = me;
        const timer = setTimeout(() => {
          try {
            opts.onOverrun?.({ label: o.label ?? null, holdMs });
          } catch {
            // a reporter that throws must not keep the lock held
          }
          free();
        }, holdMs);
        timer.unref?.();
        try {
          return await fn();
        } finally {
          clearTimeout(timer);
          free();
        }
      })();
    },
  };
}

// ── the loop ────────────────────────────────────────────────────────────────

export interface ProtectPassContext {
  /** The shared lane lock — every send of the pass goes through lock.run(…, { signal }). */
  lock: PerpLaneLock;
  /** Aborted when the pass is abandoned or the loop stops: pass it to lock.run so an abandoned pass cannot send. */
  signal: AbortSignal;
  /** 1-based pass number. */
  pass: number;
}

export interface ProtectLoop {
  /** No further passes; aborts the current one's signal and resolves once it settles (or is abandoned). */
  stop(): Promise<void>;
  /** Run a pass now (after the current one, if one is running). */
  kick(): void;
  readonly passes: number;
  readonly running: boolean;
}

/**
 * The protective loop's clock. Its own timer (unref'd — it never holds the
 * process open), started by the arm/boot path and never by tick().
 *
 *   NEVER OVERLAPS ITSELF  The next pass is scheduled only after the current
 *                          one settles. A pass that outlives `abandonAfterMs`
 *                          is ABANDONED — its signal aborts, so its next
 *                          lock.run refuses to start — and the loop moves on:
 *                          one hung read must not end protection.
 *   NEVER THROWS OUT       A throwing pass, a throwing `intervalMs` and a
 *                          throwing reporter are all absorbed; the loop runs on.
 *   CADENCE                intervalMs() is asked after every pass (15 s with
 *                          anything held, 60 s otherwise — protectCadenceMs),
 *                          clamped to [minIntervalMs, 60 s]; a non-number is
 *                          the fast cadence, never a stall.
 */
export function startProtectLoop(opts: {
  intervalMs: () => number;
  run: (ctx: ProtectPassContext) => Promise<void>;
  lock: PerpLaneLock;
  onError?: (err: unknown) => void;
  /** Floor on the interval; default 1 s (tests lower it). */
  minIntervalMs?: number;
  /** A pass older than this is abandoned; default 120 s. */
  abandonAfterMs?: number;
}): ProtectLoop {
  const minMs = typeof opts.minIntervalMs === "number" && opts.minIntervalMs >= 0 ? opts.minIntervalMs : 1_000;
  const maxMs = PROTECT_THRESHOLDS.idleIntervalMs;
  const abandonMs = typeof opts.abandonAfterMs === "number" && opts.abandonAfterMs > 0 ? opts.abandonAfterMs : 120_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let kicked = false;
  let passes = 0;
  let current: { ac: AbortController; settled: Promise<void> } | null = null;

  const report = (e: unknown) => {
    try {
      opts.onError?.(e);
    } catch {
      // the loop outlives its reporter
    }
  };
  const nextDelay = (): number => {
    let ms: number;
    try {
      ms = opts.intervalMs();
    } catch (e) {
      report(e);
      ms = PROTECT_THRESHOLDS.activeIntervalMs;
    }
    if (typeof ms !== "number" || !Number.isFinite(ms)) ms = PROTECT_THRESHOLDS.activeIntervalMs;
    return Math.min(maxMs, Math.max(minMs, ms));
  };
  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void pass(), ms);
    timer.unref?.();
  };

  async function pass(): Promise<void> {
    timer = null;
    if (stopped || running) return;
    running = true;
    passes += 1;
    const n = passes;
    const ac = new AbortController();
    let abandonTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const work = (async () => {
        await opts.run({ lock: opts.lock, signal: ac.signal, pass: n });
      })().catch(report);
      const abandoned = new Promise<void>((resolve) => {
        abandonTimer = setTimeout(() => {
          ac.abort(new Error(`protect pass ${n} abandoned after ${abandonMs} ms`));
          report(new Error(`protect pass ${n} overran ${abandonMs} ms and was abandoned`));
          resolve();
        }, abandonMs);
        abandonTimer.unref?.();
      });
      const settled = Promise.race([work, abandoned]);
      current = { ac, settled };
      await settled;
    } catch (e) {
      report(e);
    } finally {
      if (abandonTimer !== null) clearTimeout(abandonTimer);
      running = false;
      current = null;
    }
    if (stopped) return;
    if (kicked) {
      kicked = false;
      schedule(0);
    } else {
      schedule(nextDelay());
    }
  }

  schedule(0);
  return {
    async stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      const c = current;
      if (c !== null) {
        c.ac.abort(new Error("protect loop stopped"));
        await c.settled;
      }
    },
    kick() {
      if (stopped) return;
      if (running) {
        kicked = true;
        return;
      }
      schedule(0);
    },
    get passes() {
      return passes;
    },
    get running() {
      return running;
    },
  };
}
