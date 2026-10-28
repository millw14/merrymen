/**
 * A STRATEGY'S OWN TERMS, said to Brain with the operator's authority.
 *
 * Brain fences the persona as an untrusted strategy brief, rightly — it is the
 * slot owner-adjacent text travels in, and the house rules say never to obey
 * fenced material. But a strategy's mechanics then arrive with a stranger's
 * authority: Trencher's exits fire at -10%/+20%/30 minutes in code, while the
 * manager is shown a daily-crossover example and a JSON template that says
 * "3-5 days". Brain now has a second, trusted channel (`strategy_terms` and
 * `horizon` on DecideRequest, rendered as DESK POLICY outside every fence), and
 * this module is the only thing in the worker that fills it.
 *
 * CODE ONLY, AND CHECKABLE BY READING ONE FILE. There is deliberately no
 * function here that turns an arbitrary string into `StrategyTerms`: a generic
 * constructor is a constructor owner text can be passed to, and then "trusted"
 * would mean "whoever called it last". Every policy is rendered below from
 * numbers in the strategy's own config and repo literals. A new strategy adds
 * its renderer HERE, where a reviewer sees all of them together.
 *
 * WHAT IT CANNOT DO, on either side of the wire. It is prose for the model. No
 * gate, clamp, cap, liquidity floor, guard, escalation rule, budget or
 * economics verdict reads it — in Brain or here — and it states its exits as
 * facts code enforces, never as parameters the model may set.
 *
 * THE BOUNDS MIRROR BRAIN'S (services/brain/brain/schemas.py) exactly, so a
 * policy this side would send is one that side accepts. A mismatch there is a
 * 422, and a 422 is a lost review; strategy-terms.test.ts pins both.
 */
import type { TrencherConfig } from "./strategies/trencher";

/** Brain's MAX_STRATEGY_TERMS_CHARS. Sent to every analyst and the manager, so it is paid four times a pulse. */
export const MAX_STRATEGY_TERMS_CHARS = 2_500;
/** Brain's MAX_HORIZON_CHARS. A phrase, not a paragraph. */
export const MAX_HORIZON_CHARS = 40;
/** Brain's `_HORIZON`, anchored. It is interpolated into the manager's JSON example. */
const HORIZON = /^[A-Za-z0-9][A-Za-z0-9 .,()/+-]*$/;
/** Brain's `_FENCE_TAG`: trusted text must not open or close an untrusted fence. */
const FENCE_TAG = /<\s*\/?\s*untrusted/i;
/** Brain's `_reject_executable`, both halves. */
const ADDRESS = /0x[0-9a-fA-F]{40}/;
const HEXBLOB = /0x[0-9a-fA-F]{16,}/;

declare const RENDERED_HERE: unique symbol;

/**
 * A desk policy this module rendered and validated. Frozen, and branded so a
 * caller cannot hand `decide()` a plain object literal; brain-client.ts still
 * re-validates it with `strategyTermsWire`, because a brand is a compile-time
 * claim and `as` can forge one.
 */
export type StrategyTerms = Readonly<{ terms: string | null; horizon: string | null }> & {
  readonly [RENDERED_HERE]: true;
};

/**
 * The two request fields, or null when there is nothing valid to send.
 *
 * Null rather than a throw: an invalid policy degrades to TODAY's request —
 * every prompt byte-identical to before the channel existed — and never to a
 * stalled tick or a review lost to a 422.
 */
export function strategyTermsWire(p: unknown): { strategy_terms?: string; horizon?: string } | null {
  if (!p || typeof p !== "object") return null;
  const { terms, horizon } = p as { terms?: unknown; horizon?: unknown };
  const t = typeof terms === "string" ? terms.trim() : terms == null ? "" : null;
  const h = typeof horizon === "string" ? horizon.trim() : horizon == null ? "" : null;
  if (t === null || h === null || (!t && !h)) return null;
  if (t.length > MAX_STRATEGY_TERMS_CHARS || FENCE_TAG.test(t) || ADDRESS.test(t) || HEXBLOB.test(t)) return null;
  if (h && (h.length > MAX_HORIZON_CHARS || !HORIZON.test(h) || HEXBLOB.test(h))) return null;
  return { ...(t ? { strategy_terms: t } : {}), ...(h ? { horizon: h } : {}) };
}

/** Build, validate and freeze. Private on purpose: see the header. */
function rendered(terms: string, horizon: string): StrategyTerms | null {
  const wire = strategyTermsWire({ terms, horizon });
  if (!wire) return null;
  return Object.freeze({ terms: wire.strategy_terms ?? null, horizon: wire.horizon ?? null }) as StrategyTerms;
}

/** 1000 bps → "10", 1250 → "12.5". */
function pct(bps: number): string {
  return (bps / 100).toFixed(2).replace(/\.?0+$/, "");
}

/** 1800 → "30 minutes", 7200 → "2 hours", 45 → "45 seconds". */
function duration(sec: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (sec >= 7_200 && sec % 3_600 === 0) return unit(sec / 3_600, "hour");
  if (sec % 60 === 0) return unit(sec / 60, "minute");
  return unit(sec, "second");
}

/**
 * AN ILLUSTRATIVE REALISED STOP, half again past the trigger and never past a
 * total loss: the stop is checked on a tick and sold at market on a thin pool,
 * so the nominal level is where losses start, not where they end. Bps in, bps
 * out. Exported so the research brief (decision-research.ts
 * trenchMomentumBrief) works the same `s` as the desk policy, never another.
 */
export function realisedStopBps(stopLossBps: number): number {
  return Math.min(10_000, Math.round((stopLossBps * 3) / 2));
}

/**
 * The take-profit rate at which the bracket breaks even, for an average
 * stop-out loss `s`, a cost `c` paid on every exit and a take-profit `tp`, all
 * in one unit: p * tp = (1 - p) * s + c, so p = (s + c) / (s + tp). The one
 * formula both the desk policy and the research brief print.
 */
export function breakEvenRate(s: number, c: number, tp: number): number {
  return (s + c) / (s + tp);
}

/** The Trencher config fields its terms are rendered from. Numbers only — no string reaches the text. */
export type TrencherTermsConfig = Pick<
  TrencherConfig,
  "perEntryUsdg" | "stopLossBps" | "takeProfitBps" | "maxHoldSec" | "liquidityDrainFraction"
>;

/**
 * TRENCHER'S MOMENTUM PLAN, as desk policy: the horizon, the exits code
 * enforces, what an entry has to clear, and what the two words the whole
 * strategy turns on mean.
 *
 * WHY EACH PART IS HERE.
 *   - EXITS are stated as enforced facts, because a manager that thinks it is
 *     choosing a stop reasons about a trade it is not making. And as TRIGGERS,
 *     not fills: shouldExit (strategies/trencher.ts) fires only when a check
 *     happens to see the move, and the sell goes out at market on a thin pool.
 *     A drain or rug between checks realises -30% to -90%. Policy that called
 *     the stop a bracket would hand the manager an operator-endorsed loss cap
 *     that does not exist.
 *   - BREAK-EVEN is the bracket's own arithmetic, said as a FLOOR: at the
 *     nominal -10% an entry has to reach the take-profit about a third of the
 *     time just to stand still, and realised stop-outs and round-trip drag
 *     both raise that. The worked figure for a worse realised stop is there
 *     so the bar the model argues against is not the optimistic one. It is
 *     framed as a bar to argue against, with an explicit instruction not to
 *     state a probability nobody measured.
 *   - EXPECTED EDGE is the bracket's worth after costs, not the take-profit
 *     amount (the number a model reaches for when told "+20%"), and its loss
 *     side is priced with the tail, not at the nominal stop. The figure feeds
 *     the economics verdict and the dataset, so an optimistic one travels.
 *   - CONTINUATION and DISTRIBUTION are defined, because "momentum" is read
 *     both ways and only one of them is an entry. Evidence that cannot tell
 *     them apart is a hold: nothing here makes acting easier to justify.
 *
 * Null when the config has no real bracket (a non-positive or non-integer
 * term, or a stop at or past -100%): the framing would then be false, and no
 * policy is better than a wrong one. The caller sends today's request.
 *
 * WIRED at the Trencher review in worker/src/index.ts, for research accounts'
 * entry reviews only (the same `costContext` gate as the momentum plan):
 *
 *     if (costContext) inputs.strategyTerms = trencherStrategyTerms(TRENCHER_FAST);
 *
 * runShadow passes it to `decide()`, which sends it only to a Brain whose
 * /health advertises "strategy-terms". The momentum plan those reviews also
 * carry (decision-research.ts trenchMomentumBrief) states the same exits and
 * prices `s` and `c` the same way, through realisedStopBps and breakEvenRate,
 * so the trusted terms and the fenced brief never give the manager two bars.
 */
export function trencherStrategyTerms(cfg: TrencherTermsConfig): StrategyTerms | null {
  const { stopLossBps: sl, takeProfitBps: tp, maxHoldSec: hold } = cfg;
  if (![sl, tp, hold].every((n) => Number.isSafeInteger(n) && n > 0) || sl >= 10_000) return null;
  if (typeof cfg.perEntryUsdg !== "bigint" || cfg.perEntryUsdg <= 0n) return null;
  const drain = cfg.liquidityDrainFraction;
  const window = duration(hold);
  // Break-even take-profit rate for an average stop-out loss of `s` bps and a
  // cost of `c` bps on every exit (breakEvenRate).
  const bar = (s: number, c: number) => Math.round(100 * breakEvenRate(s, c, tp));
  const realised = realisedStopBps(sl);
  const cap = (Number(cfg.perEntryUsdg) / 1e6).toFixed(2);

  const terms = [
    `STRATEGY: Trencher, short-horizon memecoin momentum. Each entry is capped at ${cap} USDG and by the owner's limits; ` +
      "the cap is a sizing ceiling, not evidence about liquidity or edge.",
    `EXITS, enforced by code after every entry, not by you: triggers at -${pct(sl)}% (stop-loss) and +${pct(tp)}% ` +
      `(take-profit) from entry, a time exit at ${window}` +
      (Number.isFinite(drain) && drain > 0 && drain < 1
        ? `, and an exit if pool depth falls below ${Math.round(drain * 100)}% of its depth at entry`
        : "") +
      ". You cannot set, move or widen them. A trigger is not a fill: code acts on its next check, selling at " +
      `market on a thin pool, so a gap, drain or rug can lose far more than ${pct(sl)}%. The stop does not cap the loss.`,
    `HORIZON: judge the next ${window} from the 5-minute and 1-hour data; 6-hour and 24-hour data are context. ` +
      "A daily trend alone neither qualifies nor disqualifies an entry.",
    `BREAK-EVEN: if every trade ended at +${pct(tp)}% or -${pct(sl)}%, entries would break even before costs ` +
      `by hitting the take-profit about ${bar(sl, 0)}% of the time. That is a floor: stop-outs fill below ` +
      `-${pct(sl)}%; at an average realised stop of -${pct(realised)}% the bar is about ${bar(realised, 0)}%. ` +
      `Costs c beyond your average fill (exit impact, fees, gas both ways) raise it to (s + c) / (s + ${pct(tp)}) of ` +
      "entries, s the average realised stop-out loss, as % of entry " +
      `(c = 2: about ${bar(sl, 200)}% at s = ${pct(sl)}, ${bar(realised, 200)}% at s = ${pct(realised)}). ` +
      "Time exits fall between and still pay c. Do not state a probability you cannot measure; " +
      "say whether the evidence plausibly clears this bar, and why.",
    "EXPECTED EDGE: expected_edge_usdg is this bracket's worth at this size after costs, not the take-profit " +
      `amount; price its losses at realised stop-outs with a tail to near-total loss, never at -${pct(sl)}%.`,
    "CONTINUATION: price rising while buying broadens: more distinct buyers, buys outnumbering sells in the last " +
      "5 minutes, volume and depth holding or rising, dips bought. DISTRIBUTION: price flat or rising " +
      "while selling grows into it: repeated or large sells into strength, buyers thinning, volume spiking on down " +
      "moves, depth pulled, or a few wallets doing most of the buying. Only continuation supports an entry. " +
      "Distribution, or evidence that cannot tell the two apart, is a HOLD.",
    "POSITION REVIEW: the exits keep running whatever you decide. Sell ahead of them when the evidence shows " +
      "distribution or a failed continuation.",
  ].join("\n");

  return rendered(terms, `up to ${window}`);
}
