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
  /**
   * NOTHING BOUGHT, AND IT IS THE BALANCE — a different silence with a
   * different remedy.
   *
   * `all-legs-stale` fires only when the buy loop RAN and skipped every leg.
   * When cash is below one tick's buy the loop never runs at all, so nothing is
   * skipped, so `shut` is false, so that reason never fires — and the agent is
   * not `no-cash` either, because only an exact zero blocks the live rail. The
   * result is "trading for real — every leg available" printed beside a tape
   * with no rows in it, indefinitely, on a stock agent with the default
   * settings. It is the "nothing happens" complaint, and it had no sentence
   * anywhere.
   *
   * Counts only, so it publishes by the same rule as everything else here.
   */
  | { code: "under-one-buy"; cashRaw: bigint; needRaw: bigint; vaultRaw: bigint }
  /**
   * TODAY'S BUYING BUDGET IS GONE, which is not the same as being out of money.
   *
   * The sibling of `under-one-buy`, and the one that fires far more often. The
   * daily cap is sealed into the signature; `buyPerTickUsdg` is a setting. Ship
   * 25 per tick at 60s against a 50 cap and the day's allowance is spent in two
   * minutes, after which the strategy proposed the same legs every tick and the
   * wall refused every one — ~4,300 refusals a day, none of them news.
   *
   * It had no sentence because it could not have one: `bought` went true the
   * moment the loop pushed anything, and `bought` true means `idle` is never
   * set. The mechanism built to say why nothing happened was structurally
   * unable to fire in the commonest way for nothing to happen. Clamping the
   * loop is what lets this speak.
   *
   * Carries the per-tick figure rather than the cap: the cap needs a re-sign to
   * change and the tick size does not, so the number here is the one the owner
   * can actually act on.
   */
  | { code: "budget-spent"; capRaw: bigint }
  /**
   * A LEG THAT RAN FAR ENOUGH AHEAD OF WHAT IT COST TO BE WORTH REALISING.
   *
   * The default strategy could only ever buy — every intent it emitted had cash
   * on the sell side — so an agent on it accumulated and never realised
   * anything. This is the other half, and it carries the two numbers that make
   * it checkable: what the position cost and what it is worth now.
   */
  | { code: "take-profit"; symbol: string; gainBps: number; usdgRaw: bigint; costRaw: bigint }
  /**
   * THE MACHINE CUT IT, not the model.
   *
   * A floor sell and a model sell are the same row in the tape, and an owner
   * needs to be able to tell them apart: one means a rule fired, the other
   * means a reasoner decided. Every figure here is COMPUTED — the loss, what it
   * cost, what it is worth — so the feed never carries a model's own account of
   * why it sold as though it were the mechanism's.
   */
  | {
      code: "stop-floor";
      symbol: string;
      lossBps: number;
      usdgRaw: bigint;
      costRaw: bigint;
      /**
       * The level THIS position was graded to, when it was not the owner's own
       * number. Absent for an ungraded position, so the sentence an owner has
       * read for months is unchanged unless there is genuinely more to say.
       */
      floorBps?: number;
      /** Why the grade landed there — written at entry, quoted at the exit. */
      floorWhy?: string | null;
    }
  /**
   * THE MODEL LOOKED AND CHOSE TO HOLD.
   *
   * The LLM strategist returns a bare intent list, so a window where it decided
   * to do nothing wrote zero decision rows, zero events and zero log lines —
   * byte-for-byte identical to a window that never opened, to a model call that
   * failed and was retried, and to a healthy agent between decision intervals.
   * `all-legs-stale` was written to close exactly this hole and closed it only
   * for the basket, leaving it open on the rail that is supposed to be the
   * autonomous trading path.
   */
  | { code: "model-held"; held: number; considered: number; dropped: number }
  /**
   * THE ALWAYS-ON SIDE OF THE CHAIN, when the always-off side is shut.
   *
   * Every equity feed goes stale at a weekend, so a stock basket does nothing
   * for two days in three — which is most of what "no trading is being done"
   * meant. This is the fallback the owner asked for: stocks stay the default,
   * and when EVERY leg is stale the agent works a coin it has both put in its
   * basket and signed for. Never a substitute for a leg that could have
   * traded; it only fires when none of them could.
   */
  | { code: "stale-fallback"; symbol: string; usdgRaw: bigint; legs: number }
  /** The market is shut and the token keeps trading. */
  | { code: "gap-enter"; symbol: string; usdgRaw: bigint }
  /** The market reopened; the gap trade is over. */
  | { code: "gap-exit"; symbol: string }
  /** Laying down an equal-weight book for the first time. */
  /**
   * THE SIGNED KEY WOULD NOT ALLOW THE SIZE THIS STRATEGY WANTED.
   *
   * Set only where the buy was cut by `perTradeCapUsdg`/`spendHeadroomUsdg`,
   * never where cash or the owner's own per-tick bound was the binding
   * constraint — otherwise the sentence blames a signature that was not the
   * reason. The clamp itself is right and documented (even-keel.ts): it stops
   * the strategy proposing what the wall is certain to refuse. What was
   * missing is that nothing anywhere told the owner it was happening, so the
   * settings field kept reading 25 while the tape read 10 and no surface
   * joined them.
   *
   * ONLY ON THE BUY VARIANTS. `keel-trim` is the exit and must never carry
   * this, because the exit is never clamped: policy.ts exempts an unsized
   * exit from the per-trade cap, and a strategy that clamped its own exits
   * would be stricter than the wall — "structurally able to exit its losers
   * and unable to exit its winners". cap-aware.test.ts locks that.
   */
  | { code: "keel-seed"; usdgRaw: bigint; legs: number; capped?: boolean }
  /** A leg has drifted above its share. */
  | { code: "keel-trim"; symbol: string; overRaw: bigint }
  /** A leg has drifted below its share. */
  | { code: "keel-top"; symbol: string; underRaw: bigint; capped?: boolean }
  /** The deepest drawdown among the legs that could be priced. */
  | { code: "dip"; symbol: string; dipBps: number; priced: number; usdgRaw: bigint; capped?: boolean }
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
/**
 * The trailing clause naming the wall, when the wall is why the size shrank.
 * Deliberately short: reasons.test.ts caps a rendered sentence at 220 chars,
 * and the figure already appears earlier in every sentence that uses this.
 */
const capClause = (capped?: boolean) =>
  capped ? " — cut to what your signed key allows; re-sign to raise it" : "";
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
    case "budget-spent":
      return (
        `nothing bought — today's buying budget is spent. That is the daily cap in your ` +
        `signature doing its job, not a fault: I buy ${usdg(w.capRaw)} USDG a tick, so a small ` +
        `cap is gone quickly. Lower the size per tick in settings to spread it across the day, ` +
        `or raise the cap at /grant — that one needs a re-sign. Selling is never blocked by this`
      );
    case "under-one-buy":
      return (
        `nothing bought — ${usdg(w.cashRaw)} USDG on hand and one buy costs ${usdg(w.needRaw)}` +
        (w.vaultRaw > 0n
          ? `. There is ${usdg(w.vaultRaw)} USDG in the vault I can pull back, so this should clear itself`
          : `, and the vault is empty. Add funds or lower the size per trade`)
      );
    case "stop-floor":
      return (
        `${w.symbol} is ${pct(w.lossBps)}% below what it cost — selling all ${usdg(w.usdgRaw)} USDG of it ` +
        `against the ${usdg(w.costRaw)} paid. A floor, not a view: the rule fired, I did not change my mind` +
        // The graded clause, and ONLY when this position carried its own level.
        // An owner who never sees a grade should read exactly the sentence they
        // always read; one whose position was graded wider or tighter than
        // their setting is owed the reason it was, at the moment it costs them
        // money rather than in a settings screen they will not open.
        (w.floorBps
          ? w.floorWhy
            ? `. Its floor was graded when I bought it — ${w.floorWhy}`
            : `. Its floor was graded at ${pct(w.floorBps)}% when I bought it, not your usual level`
          : "")
      );
    case "take-profit":
      return (
        `${w.symbol} is up ${pct(w.gainBps)}% on what it cost — selling all ${usdg(w.usdgRaw)} USDG of it ` +
        `against the ${usdg(w.costRaw)} paid, and taking the profit rather than watching it`
      );
    case "model-held":
      // "MORE" WAS WRONG: `dropped` comes out of the same proposal list as
      // `considered`, so the refused ones were already inside the count and the
      // sentence asserted a larger universe than the model actually looked at.
      // And a refusal is not a hold — one is the model's decision, the other is
      // the wall's — so when nothing was held the sentence is about the wall.
      return w.held === 0
        ? `nothing bought — I put ${w.dropped} ${w.dropped === 1 ? "idea" : "ideas"} up and my key's limits refused ${w.dropped === 1 ? "it" : "them"}. ` +
            `That is the wall doing its job, not me sitting still`
        : `nothing bought — I looked at ${w.considered} ${w.considered === 1 ? "name" : "names"} and held ` +
            `${w.held === w.considered ? "all of them" : `${w.held} of them`}` +
            (w.dropped > 0 ? `; ${w.dropped} of those my key's limits refused` : "") +
            `. A decision, not a quiet tick`;
    case "stale-fallback":
      return (
        `all ${w.legs} equity feeds are shut, so putting ${usdg(w.usdgRaw)} USDG into ${w.symbol} — ` +
        `a coin I hold a signed permission for, on a market that does not close`
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
      return `nothing invested yet — laying down an equal-weight entry, ${usdg(w.usdgRaw)} USDG into each of ${w.legs}${capClause(w.capped)}`;
    case "keel-trim":
      return `${w.symbol} is ${usdg(w.overRaw)} USDG over its equal weight — trimming it back toward the line`;
    case "keel-top":
      return `${w.symbol} is ${usdg(w.underRaw)} USDG under its equal weight — topping it up from cash${capClause(w.capped)}`;
    case "dip":
      return (
        `${w.symbol} is ${pct(w.dipBps)}% off its rolling high, the deepest of the ${w.priced} I priced — ` +
        `${usdg(w.usdgRaw)} USDG in${capClause(w.capped)}`
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
