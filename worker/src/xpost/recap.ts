/**
 * ONE POST FOR A BURST OF TRADES (the owner's ask, 2026-10-14: "post one recap
 * for a burst, like 'closed 6 trades this morning'").
 *
 * Alan made twenty trades in four hours on 2026-10-13 and four were posted:
 * the night held the plan, the two-hour freshness dropped the oldest, and
 * the seventy-five-minute gap queued the rest until they went stale. The
 * planner now leaves a trade it cannot post soon for a recap (planner.ts
 * planRecap), and this file says it.
 *
 * CODE'S WORDS AND CODE'S FIGURES, NO MODEL. A recap is a count of its own
 * receipt-backed trades: the words only say it is one ("an update on the
 * trading desk, the full rundown follows"), naming no coin, no result, no
 * size and no time of day,
 * and the figures line after the gate says the rest (xpost/figures.ts
 * "recap:" and "traded"). Nothing for a model to embellish, and nothing a
 * model outage can silence: a recap goes out whenever the gate admits one of
 * the lines, which xpost/recap.test.ts pins live and paper.
 *
 * Pure: no I/O, no model, no clock.
 */
import { latinLines } from "./casual";
import { cleanTicker, renderFiguresLine, TRADED_MAX, type FiguresSection, type FiguresSpec } from "./figures";
import { recapCoverOf, sellKey, type PlanCall, type PlanIntent, type PlanSell } from "./planner";

/** Short conversational leads and independent tails. Selection walks every cell;
 * the real repeat and opener gates, not a template's index, decide what is fresh. */
export const RECAP_SLOTS: readonly [readonly string[], readonly string[], readonly string[]] = [
  ["ok, quick trade catchup", "rounding up the latest activity", "here comes the desk rundown", "flipping through the running tally",
    "a plain update from the logbook", "the recap has entered chat", "keeping tabs on the paperwork", "putting the ledger into words",
    "pulling together the recorded bits", "back with the accounting notes", "time for the condensed version", "bookmarking the current chapter",
    "opening the summary drawer", "collecting the details in public", "letting the record speak", "bringing the scattered notes together",
    "zooming out to the overview", "turning the page to the totals", "leaving a checkpoint for the timeline", "making room for the breakdown",
    "gathering the latest notes on activity", "unpacking the trading notebook", "filing the catchup without ceremony", "stopping by with the scorecard"],
  ["the numbers can do the talking", "no dramatic soundtrack required", "less narration, more actual detail", "a bit of reading for the curious",
    "nothing dressed up for the occasion", "keeping the commentary pretty short", "the unglamorous part gets a mention", "a tidy place for the loose ends",
    "no plot twist added for effect", "the arithmetic gets the microphone", "leaving the adjectives at the door", "straight from what was recorded",
    "the boring details deserve daylight", "without the motivational speech", "putting the spectacle on mute", "no essay needed alongside",
    "the evidence keeps its own voice", "without inventing a grand narrative", "the useful stuff fits underneath", "no confetti in the footnotes",
    "skipping the theatrical introduction", "just the facts in readable form", "without turning bookkeeping into folklore", "a compact read for passing visitors"],
  [],
];

/** Every lead/tail pair, deterministically shuffled, with an explicit paper disclosure. */
export function recapLines(seed: string, o: { paper?: boolean } = {}): string[] {
  // A third equal slot lets latinLines enumerate every lead/tail pair exactly once.
  const slots = [RECAP_SLOTS[0], RECAP_SLOTS[1], RECAP_SLOTS[0].map(() => "")] as const;
  return latinLines(slots, seed, (a, b) => `${a}. ${b}${o.paper === true ? ", on paper" : ""}.`);
}

/** A trade's ticker as the figures line may show it: its symbol, else its name, when either is one. */
function tickerOf(c: Pick<PlanCall, "symbol" | "name">): string | null {
  return cleanTicker(c.symbol) ?? cleanTicker(c.name);
}

/** A recap's counts, as the figures line's recap section: buys, sales, and their measured outcomes. */
function recapSection(buys: number, sells: number, results: readonly PlanSell[]): Extract<FiguresSection, { kind: "recap" }> {
  const measured = results.filter((s) => s.outcome === "profit" || s.outcome === "loss");
  const gains = measured.filter((s) => s.outcome === "profit" && typeof s.gainPct === "number" && Number.isFinite(s.gainPct)).map((s) => s.gainPct as number);
  return { kind: "recap", buys, sells,
    ...(measured.length ? { wins: measured.filter((s) => s.outcome === "profit").length, losses: measured.filter((s) => s.outcome === "loss").length } : {}),
    ...(gains.length ? { bestPct: Math.max(...gains) } : {}) };
}

/**
 * A RECAP'S FIGURES: how many buys and sales; of the sales whose outcome a
 * receipt measured, how many closed in profit and at a loss, and the best
 * measured gain among the profits; and the coins, newest first. Every number
 * is a count of its own trades or a gain the sale's receipts measured.
 */
export function recapFigures(r: Pick<Extract<PlanIntent, { kind: "recap" }>, "buys" | "sells" | "results">): FiguresSpec {
  const coins = [...(r.buys ?? []), ...(r.sells ?? [])].sort((a, b) => b.atSec - a.atSec).map(tickerOf).filter((t): t is string => t !== null);
  return [recapSection((r.buys ?? []).length, (r.sells ?? []).length, Array.isArray(r.results) ? r.results : []),
    { kind: "traded", symbols: [...new Set(coins)].slice(0, TRADED_MAX) }];
}

/**
 * DOES A RECAP STILL SAY WHAT ITS RECEIPTS SAY, AT SEND TIME? (review of the
 * recap branch, 2026-10-14: a sale post's evidence is replayed before it
 * goes out, and a recap's was not.) Its covered keys (its row's `coin`) are
 * read again: every sale it counted must still be one of the receipt-backed
 * sales (`sales`, read fresh), and the counts, outcomes and best gain those
 * give now must be the ones on the post, whole or with the best gain the
 * line may have dropped to fit. Any doubt: false, and the recap is withheld.
 */
export function recapStillHolds(post: { tenant: string; body: string; coin: string | null }, sales: readonly PlanSell[]): boolean {
  const keys = recapCoverOf(post.coin);
  if (!keys.length || typeof post.body !== "string") return false;
  const buys = keys.filter((k) => k.startsWith("buy:")).length;
  const sellKeys = new Set(keys.filter((k) => k.startsWith("sell:")));
  const matched = sales.filter((s) => sellKeys.has(sellKey(post.tenant, s.operationKey)));
  if (matched.length !== sellKeys.size) return false;
  const full = recapSection(buys, matched.length, matched);
  const variants = [full, { ...full, bestPct: null }].map((s) => renderFiguresLine([s])).filter((l): l is string => l !== null).map((l) => l.slice(0, -1));
  return variants.some((v) => post.body.includes(` ${v};`) || post.body.endsWith(` ${v}.`));
}
