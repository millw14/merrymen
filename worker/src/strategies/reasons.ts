/**
 * WHY A STRATEGY DID SOMETHING, in words a stranger can read.
 *
 * THE HOLE THIS FILLS. `decisions.reason` has always existed and only the LLM
 * strategist ever wrote one — `index.ts` calls `ensureDecision(intent, source)`
 * with no third argument for every deterministic strategy, so `steady-basket`,
 * the DEFAULT, produced thousands of decision rows a day with `reason` NULL.
 * An agent that trades all day and can say nothing about it is not much of an
 * agent to watch, and the public feed would have been empty for almost everyone.
 *
 * WHY A TYPED UNION AND NOT A STRING. This is the load-bearing decision in the
 * file, and it is about what may be PUBLISHED rather than about types.
 *
 * A strategy emits a `Why` — numbers, and symbols drawn from its own configured
 * legs. It never emits prose. `renderWhy` is the only function in the codebase
 * that turns one into a sentence, so every word on the public page was written
 * here, by us, in advance. No model, no tenant's custom strategy file, and no
 * chat message can reach it. Compare `decisions.reason` from the strategist,
 * which is model prose and must be capped and address-scanned before it is shown
 * to anybody, and `dropped_rule`, which is a template with a MODEL-SUPPLIED
 * symbol in the middle of it and can never be published verbatim at all.
 *
 * So publishability stops being a thing somebody has to remember and becomes a
 * property of the type system: if it went through `renderWhy`, it is safe.
 *
 * A CONSEQUENCE WORTH STATING. A tenant's own strategy file (`custom.ts`)
 * returns a bare `TradeIntent[]` and therefore cannot produce a `Why` at all.
 * Its decisions carry no reason and it never appears in the feed with prose.
 * That is deliberate: a strategy we did not write is a string we did not write.
 *
 * VOICE. Lower case, one em-dash, a figure and then what it means. No
 * exclamation, no prediction, no claim about an outcome the strategy cannot see
 * — it proposes trades, it does not learn whether they filled. Matched to the
 * notes `trencher.ts` already emits.
 *
 * LENGTH. Every rendered string stays under 220 characters, which is where
 * Telegram's `/why` truncates (`telegram/reads.ts`), so no surface anywhere cuts
 * one of these mid-word.
 */

/** USDG is 6dp. Two decimals is what every other surface shows. */
function usdg(raw: bigint): string {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const whole = v / 1_000_000n;
  const cents = (v % 1_000_000n) / 10_000n;
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}.${cents.toString().padStart(2, "0")}`;
}

/**
 * Basis points as a percentage, one decimal where it earns its place: 240 → "2.4".
 * Used where the precision is the point, like how far off a high something is.
 */
function pct(bps: number): string {
  const n = bps / 100;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * A basket WEIGHT, to the nearest whole percent: 3333 → "33".
 *
 * Deliberately blunter than `pct`. An even three-leg basket is 3333 bps a leg,
 * and "33.3% of a 3-leg basket" spends a decimal saying what "a third" already
 * said — the sentence names the leg count, so the reader has the context. The
 * precision is real and it is also meaningless here.
 */
function pctWhole(bps: number): string {
  return String(Math.round(bps / 100));
}

/**
 * What a strategy observed, structurally.
 *
 * Every field is a number or a symbol from the strategy's own configuration.
 * Nothing here may carry free text, and nothing here may originate outside the
 * strategy that emits it.
 */
export type Why =
  /** A scheduled basket buy — one leg of the standing order. */
  | { code: "dca-leg"; symbol: string; usdgRaw: bigint; weightBps: number; legs: number }
  /** Idle cash above the floor going to the vault. `clamped` when the day's budget cut it. */
  | { code: "park"; usdgRaw: bigint; floorRaw: bigint; clamped: boolean }
  /** Pulling cash back because a buy could not be funded. */
  | { code: "unpark"; usdgRaw: bigint; needRaw: bigint }
  /**
   * NOTHING TO BUY, and it is the feeds, not the market.
   *
   * A basket tick that skips every leg returns an empty intent list,
   * which is indistinguishable from a healthy quiet tick — so 34 agents
   * spent a weekend doing nothing and saying nothing, and their owners
   * reported it as "no trading is being done". Carries counts only, so
   * it stays publishable by the same rule as every other reason here.
   */
  | { code: "all-legs-stale"; legs: number; paused: number }
  /** The market is shut and the token keeps trading. */
  | { code: "gap-enter"; symbol: string; usdgRaw: bigint }
  /** The market reopened; the gap trade is over. */
  | { code: "gap-exit"; symbol: string }
  /** Laying down an equal-weight book for the first time. */
  | { code: "keel-seed"; usdgRaw: bigint; legs: number }
  /** A leg has drifted above its share. */
  | { code: "keel-trim"; symbol: string; overRaw: bigint }
  /** A leg has drifted below its share. */
  | { code: "keel-top"; symbol: string; underRaw: bigint }
  /** The deepest drawdown among the legs that could be priced. */
  | { code: "dip"; symbol: string; dipBps: number; priced: number; usdgRaw: bigint }
  /** A launch that cleared every entry bound. */
  | { code: "trench-enter"; symbol: string; liqUsd: number; fdvUsd: number; ageSec: number; usdgRaw: bigint }
  /**
   * Leaving a launch. `cause` is a CODE, not the sentence the exit rule wrote —
   * the whole point of this module is that no string crosses the boundary.
   */
  | {
      code: "trench-exit";
      symbol: string;
      cause: "unpriceable" | "drain" | "stop" | "take" | "aged";
      pct?: number;
    };

/**
 * The ONLY producer of a published strategy reason.
 *
 * Exhaustive by construction: the `never` fallthrough makes adding a `Why`
 * without a sentence a compile error rather than a silently empty post.
 */
export function renderWhy(w: Why): string {
  switch (w.code) {
    case "dca-leg":
      return (
        `the schedule says buy — ${usdg(w.usdgRaw)} USDG into ${w.symbol}, ` +
        `its ${pctWhole(w.weightBps)}% of a ${w.legs}-leg basket`
      );
    case "park":
      return w.clamped
        ? `${usdg(w.usdgRaw)} USDG idle above the ${usdg(w.floorRaw)} floor — ` +
            `parking what today's budget still allows`
        : `${usdg(w.usdgRaw)} USDG idle above the ${usdg(w.floorRaw)} floor — ` +
            `parking it in the vault until the next buy`;
    case "all-legs-stale":
      return (
        `nothing bought — ${w.legs === 1 ? "the price feed for the only leg is" : `all ${w.legs} legs' price feeds are`} ` +
        `stale, so there is no reference price to buy against` +
        (w.paused > 0 ? `, and ${w.paused} of them ${w.paused === 1 ? "is" : "are"} paused` : "") +
        `. This is a fact about the feeds, not about the market`
      );
    case "unpark":
      return (
        `cash is under one tick's buy — pulling ${usdg(w.usdgRaw)} USDG back from the vault ` +
        `so the next tick can trade`
      );
    case "gap-enter":
      return (
        `${w.symbol}'s feed has gone stale — its market is shut and the token keeps trading, ` +
        `so ${usdg(w.usdgRaw)} USDG in at the close print`
      );
    case "gap-exit":
      // No P&L claim: the strategy proposes, and never learns what it filled at.
      return `${w.symbol}'s feed is live again — the market reopened, so the whole position goes back to cash`;
    case "keel-seed":
      return `nothing invested yet — laying down an equal-weight entry, ${usdg(w.usdgRaw)} USDG into each of ${w.legs}`;
    case "keel-trim":
      return `${w.symbol} is ${usdg(w.overRaw)} USDG over its equal weight — trimming it back toward the line`;
    case "keel-top":
      return `${w.symbol} is ${usdg(w.underRaw)} USDG under its equal weight — topping it up from cash`;
    case "dip":
      return (
        `${w.symbol} is ${pct(w.dipBps)}% off its rolling high, the deepest of the ${w.priced} I priced — ` +
        `${usdg(w.usdgRaw)} USDG in`
      );
    case "trench-enter":
      return (
        `${w.symbol}: ${Math.round(w.liqUsd).toLocaleString("en-US")} deep, ` +
        `FDV ${Math.round(w.fdvUsd).toLocaleString("en-US")}, ${Math.round(w.ageSec / 60)}m old — ` +
        `inside every entry bound, ${usdg(w.usdgRaw)} USDG in`
      );
    case "trench-exit": {
      const pct = w.pct === undefined ? null : Math.abs(Math.round(w.pct));
      if (w.cause === "drain")
        return `leaving ${w.symbol} — ${pct ?? "much"}% of the liquidity has left since entry`;
      if (w.cause === "stop") return `leaving ${w.symbol} — it is ${pct ?? "well"}% down from where I bought it`;
      if (w.cause === "take") return `leaving ${w.symbol} — it is ${pct ?? "well"}% up from where I bought it`;
      if (w.cause === "aged") return `leaving ${w.symbol} — held past the window I give a launch`;
      return `leaving ${w.symbol} — it cannot be priced any more, so I am going while there is still a route out`;
    }
    default: {
      const exhaustive: never = w;
      return exhaustive;
    }
  }
}
