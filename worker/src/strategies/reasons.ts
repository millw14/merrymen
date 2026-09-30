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
  /**
   * `marketShut` decides which of two true sentences this becomes.
   *
   * The rendering used to end "This is a fact about the feeds, not about the
   * market" unconditionally. It was written for the case where our own reads
   * failed, and then became the only sentence for both — so on a weekend, or
   * any weekday after 20:00 UTC, the agent told its owner the exact opposite of
   * what was happening. Optional, and absent renders the old wording: a fixture
   * that never established it should not have a claim invented for it.
   */
  | { code: "all-legs-stale"; legs: number; paused: number; marketShut?: boolean }
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
   * TODAY'S TRADE COUNT IS GONE — `budget-spent`'s sibling, for the count
   * rather than the money.
   *
   * Before the snapshot carried the count, this was the loudest way for an
   * agent to do nothing: the strategy proposed the same legs every tick and the
   * wall refused each one with `ops-cap`, which reached the public feed as
   * "tried to buy TSLA · past today's number of trades" once a tick until the
   * window rolled. Now the strategy stops proposing and says this once.
   *
   * NO FIGURE, deliberately. The snapshot carries the headroom, which is zero
   * whenever this fires, and not the ceiling; a sentence that printed "0" would
   * be a number that says nothing, and inventing the ceiling here would be a
   * figure nobody read on this tick.
   */
  | { code: "ops-spent" }
  /**
   * THE DRAWDOWN BREAKER IS TRIPPED — the book sits at or past the loss limit
   * sealed into the key, so the wall refuses every buy until it recovers.
   *
   * Before the snapshot carried the drawdown, this was a refusal a tick: the
   * strategy proposed, the wall said `drawdown-breaker`, and a Trencher paid a
   * Brain review for every entry it would never be allowed to make. Now the
   * strategy stops proposing buys and says this once.
   *
   * THE OWNER'S SENTENCE ONLY. The refusal it replaces is account state and
   * leaves the public feed; the same fact must not walk back in as a view —
   * see `publishesIdle`.
   *
   * ONE FIGURE, AND IT DOES NOT MOVE: the limit sealed into the key. The
   * drawdown itself changes every tick the book does, and a sentence that
   * carried it would be news to the once-per-change idle channel every tick.
   */
  | { code: "breaker-tripped"; limitBps: number }
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
    }
  /**
   * TAKING A LAUNCH ON THE CLASS ROUTE.
   *
   * Every field here was measured in the same pass that chose this curve, and
   * each is carried rather than re-read: a sentence that re-derives its own
   * evidence a second later is a sentence about a different market.
   *
   * THE NULLS ARE THE POINT. `trades` and `traders` come from a ~15-minute
   * window of curve events, and index.ts closes the empty-vs-unavailable gap
   * there explicitly — `classActivity === null ? null : (a ? a.buys + a.sells : 0)`.
   * A tape we could not read is NOT a quiet tape, and the difference decides
   * whether "buyers are sticking around" may be said at all.
   */
  | {
      code: "class-enter";
      symbol: string;
      usdgRaw: bigint;
      /** Trades on this curve in the activity window. null = tape unreadable. */
      trades: number | null;
      /** Distinct trading addresses in the same window. null = tape unreadable. */
      traders: number | null;
      /** Real quote depth with the virtual seed removed, raw USDG 6dp. */
      depthRaw: bigint;
      /** One-way price impact of THIS buy, bps. */
      impactBps: number;
      /** Round-trip cost at scoring size, bps. null when it could not be priced. */
      costBps: number | null;
      /** Progress toward graduation, bps of the threshold. */
      graduationBps: number;
      /** How many priced rivals this curve was chosen over. */
      field: number;
    }
  /**
   * LEAVING ONE.
   *
   * `cause` is a CODE and the set is CLOSED AT TWO, because two is how many
   * reasons the class exit actually has. It is deliberately price-free
   * (index.ts states it, class-exit.test.ts pins it), so there is no
   * thesis-invalidated exit; stop-floors and take-profits read the smart
   * account's balances and the class book is custodied by the vault, so no hard
   * risk exit can see it; and Brain's orders route to the adapter, never the
   * vault, so it cannot sell one either.
   *
   * Naming a third cause here would be naming an exit that did not happen.
   *
   *   clock — held longer than classMaxHoldSec
   *   cliff — close enough to graduation that the vault would soon be unable to
   *           sell at all, since PonsClassVault.sell reverts CurveGraduated
   *
   * `graduationBps` is NULLABLE and must stay so. The gate coalesces an
   * unreadable depth fraction to zero, which is the safe direction for deciding
   * (an unreadable curve never trips the cliff) and a lie for reporting. On a
   * `cliff` exit it is never null by construction — the cliff is how it fired.
   */
  | {
      code: "class-exit";
      symbol: string;
      cause: "clock" | "cliff";
      heldSec: number;
      graduationBps: number | null;
      /** USDG the sell is quoted to return, raw 6dp. */
      proceedsRaw: bigint;
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
/**
 * WHO IS READING.
 *
 * The same `Why` goes to two places with two readers. The owner's event log and
 * Telegram get the OWNER register, which may end in a remedy — "re-sign to raise
 * it", "add funds or lower the size per trade" — because the owner is the one
 * person who can act on it. The decision row becomes a PUBLIC post, and the
 * same sentence there is an instruction addressed to a stranger about somebody
 * else's account: the live feed carried "Add funds or lower the size per trade"
 * and "Change the mode in Settings" for weeks, which is the exact texture of a
 * worker log leaking onto a trading desk.
 *
 * `"owner"` is the default so every existing call site is byte-identical. The
 * public register is opt-in at the two places a sentence becomes a post.
 *
 * AND THE PUBLIC REGISTER CARRIES NO FIGURE OF THE BOOK — no size, no cost, no
 * cash, no floor. A private book publishes no size (thesis-policy.ts
 * `sizeUsdg`: a size is dollars), and this sentence is written into the row
 * BEFORE anybody knows whose book will read it back, so it has to be safe for
 * the book that shows least. It was not: "selling all 4.40 USDG of it against
 * the 5.00 paid" is the realized P&L outright, "out of X with 6.00 USDG" beside
 * a published return is the same P&L one division away, "5.00 USDG into TSLA"
 * beside a published entry price is the holding, and "5.00 USDG idle above the
 * 50.00 floor" is the cash balance — on steady-basket, the default, so on most
 * of the feed. Percentages, counts, the coin, and the market's own figures (a
 * pool's depth and FDV) stay: they are what the public default already shows.
 * A public book loses nothing it needs, because its head and `sizeUsdg` still
 * carry the size. The owner's copy keeps every figure.
 */
export type WhyAudience = "owner" | "public";

const capClause = (capped: boolean | undefined, audience: WhyAudience) =>
  !capped ? "" : audience === "owner" ? " — cut to what your signed key allows; re-sign to raise it" : " — cut to what the signed key allows";
export function renderWhy(w: Why, audience: WhyAudience = "owner"): string {
  // The owner's sentence names the book's figures; the public one never does.
  const own = audience === "owner";
  switch (w.code) {
    case "dca-leg":
      return own
        ? `the schedule says buy — ${usdg(w.usdgRaw)} USDG into ${w.symbol}, ` +
            `its ${pctWhole(w.weightBps)}% of a ${w.legs}-leg basket`
        : `the schedule says buy — cash into ${w.symbol}, its ${pctWhole(w.weightBps)}% of a ${w.legs}-leg basket`;
    case "park":
      // The figure is the amount being parked. In the clamped case that is
      // LESS than what is idle above the floor, so the old sentence — "X idle
      // above the floor, parking what the budget allows" — stated the parked
      // amount as if it were the idle amount. Said the right way round.
      if (!own) {
        return w.clamped
          ? `parking some of the cash idle above the floor — what today's budget still allows`
          : `cash idle above the floor — parking it in the vault until the next buy`;
      }
      return w.clamped
        ? `parking ${usdg(w.usdgRaw)} USDG of the cash idle above the ${usdg(w.floorRaw)} floor — ` +
            `what today's budget still allows`
        : `${usdg(w.usdgRaw)} USDG idle above the ${usdg(w.floorRaw)} floor — ` +
            `parking it in the vault until the next buy`;
    case "all-legs-stale":
      return (
        `nothing bought — ${w.legs === 1 ? "the price feed for the only leg is" : `all ${w.legs} legs' price feeds are`} ` +
        `stale, so there is no reference price to buy against` +
        (w.paused > 0 ? `, and ${w.paused} of them ${w.paused === 1 ? "is" : "are"} paused` : "") +
        // The whole point of the flag. Stale-because-shut and stale-because-broken
        // are the same observation with opposite meanings and opposite remedies.
        (w.marketShut === true
          ? `. The US market is closed right now, which is why — stock feeds run 24/5, and this ` +
            `clears itself when it reopens. Memecoins trade around the clock and are unaffected`
          : w.marketShut === false
            ? `. The market is OPEN, so this is our own read path rather than the feeds' schedule — ` +
              `worth looking at if it lasts`
            : `. This is a fact about the feeds, not about the market`)
      );
    case "budget-spent":
      return (
        `nothing bought — today's buying budget is spent. That is the daily cap in your ` +
        `signature doing its job, not a fault` +
        (own ? `: I buy ${usdg(w.capRaw)} USDG a tick, so a small cap is gone quickly. ` : `. `) +
        (audience === "owner"
          ? `Lower the size per tick in settings to spread it across the day, ` +
            `or raise the cap at /grant — that one needs a re-sign. `
          : ``) +
        `Selling is never blocked by this`
      );
    case "ops-spent":
      // "The last 24 hours", not "today": the count is a trailing window, so it
      // frees up as the oldest trades age out rather than at midnight, and an
      // owner told "today" would wait for a rollover that is not coming.
      return (
        `nothing bought — the number of trades the signed key allows in ` +
        `24 hours is used up, and it frees up as the oldest ones age out. ` +
        (audience === "owner" ? `Raise it at /grant — that one needs a re-sign. ` : ``) +
        `Selling is never blocked by this`
      );
    case "breaker-tripped":
      return (
        `nothing bought — the book is at least ${pct(w.limitBps)}% below its peak, the drawdown limit ` +
        `in the signed key, so the breaker refuses buys until it recovers. ` +
        (audience === "owner" ? `A wider limit needs a re-sign at /grant. ` : ``) +
        `Selling is never blocked by this`
      );
    case "under-one-buy":
      return (
        (own
          ? `nothing bought — ${usdg(w.cashRaw)} USDG on hand and one buy costs ${usdg(w.needRaw)}`
          : `nothing bought — the cash on hand is short of one buy`) +
        (w.vaultRaw > 0n
          ? own
            ? `. There is ${usdg(w.vaultRaw)} USDG in the vault I can pull back, so this should clear itself`
            : `. There is cash in the vault I can pull back, so this should clear itself`
          : `, and the vault is empty` + (audience === "owner" ? `. Add funds or lower the size per trade` : ``))
      );
    case "stop-floor":
      return (
        `${w.symbol} is ${pct(w.lossBps)}% below what it cost — ` +
        (own ? `selling all ${usdg(w.usdgRaw)} USDG of it against the ${usdg(w.costRaw)} paid` : `selling all of it`) +
        `. A floor, not a view: the rule fired, I did not change my mind` +
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
        `${w.symbol} is up ${pct(w.gainBps)}% on what it cost — ` +
        (own ? `selling all ${usdg(w.usdgRaw)} USDG of it against the ${usdg(w.costRaw)} paid` : `selling all of it`) +
        `, and taking the profit rather than watching it`
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
        `all ${w.legs} equity feeds are shut, so ` +
        (own ? `putting ${usdg(w.usdgRaw)} USDG into ${w.symbol}` : `buying ${w.symbol}`) +
        ` — a coin I hold a signed permission for, on a market that does not close`
      );
    case "unpark":
      return (
        `cash is under one tick's buy — pulling ${own ? `${usdg(w.usdgRaw)} USDG` : `some`} back from the vault ` +
        `so the next tick can trade`
      );
    case "gap-enter":
      return (
        `${w.symbol}'s feed has gone stale — its market is shut and the token keeps trading, ` +
        `so ${own ? `${usdg(w.usdgRaw)} USDG` : `buying`} in at the close print`
      );
    case "gap-exit":
      // No P&L claim: the strategy proposes, and never learns what it filled at.
      return `${w.symbol}'s feed is live again — the market reopened, so the whole position goes back to cash`;
    case "keel-seed":
      return `nothing invested yet — laying down an equal-weight entry${own ? `, ${usdg(w.usdgRaw)} USDG` : ``} into each of ${w.legs}${capClause(w.capped, audience)}`;
    case "keel-trim":
      return `${w.symbol} is ${own ? `${usdg(w.overRaw)} USDG ` : ``}over its equal weight — trimming it back toward the line`;
    case "keel-top":
      return `${w.symbol} is ${own ? `${usdg(w.underRaw)} USDG ` : ``}under its equal weight — topping it up from cash${capClause(w.capped, audience)}`;
    case "dip":
      return (
        `${w.symbol} is ${pct(w.dipBps)}% off its rolling high, the deepest of the ${w.priced} I priced — ` +
        `${own ? `${usdg(w.usdgRaw)} USDG` : `buying`} in${capClause(w.capped, audience)}`
      );
    case "trench-enter":
      // The depth and the FDV are the POOL's, read off a public tape, and stay;
      // only the size of this buy is the book's.
      return (
        `${w.symbol}: ${Math.round(w.liqUsd).toLocaleString("en-US")} deep, ` +
        `FDV ${Math.round(w.fdvUsd).toLocaleString("en-US")}, ${Math.round(w.ageSec / 60)}m old — ` +
        `inside every entry bound, ${own ? `${usdg(w.usdgRaw)} USDG` : `buying`} in`
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
    /**
     * THE CLASS ROUTE'S TWO SENTENCES, AND WHY THEY CARRY SO FEW FIGURES.
     *
     * Every other arm in this file prints its numbers, because every other arm
     * is the whole of what gets published. These two are not: the class route
     * has a FACT LAYER underneath (`decisions.evidence_json`), which keeps all
     * of it — depth, impact, cost, the field it beat — for the drill-down and
     * for the social writer.
     *
     * So the job here changes. This sentence is what a reader sees when there
     * is no post in the agent's own voice, and a feed of
     * "15m activity 32, depth 410.22 USDG, graduation 41.3%" is an observability
     * dashboard wearing a feed's clothes. It names the one fact that decided
     * the trade and stops. The rest is a click away and has not been lost.
     */
    case "class-enter": {
      // AN UNREADABLE TAPE SAYS NOTHING ABOUT BUYERS. `trades === null` is not
      // a quiet curve; it is a curve we could not hear. The clause is dropped
      // rather than softened, because "few buyers" would be a claim we cannot
      // make and "some buyers" would be one we invented.
      const busy =
        w.trades === null
          ? null
          : w.traders !== null && w.traders > 1
            ? `${w.traders} different buyers have been through it`
            : `${w.trades} trades have gone through it`;
      const beat = w.field > 1 ? `, and it was the best of ${w.field} I priced` : "";
      const taking = own ? `taking ${usdg(w.usdgRaw)} USDG of ${w.symbol}` : `buying into ${w.symbol}`;
      return busy === null ? `${taking} — early on the curve${beat}` : `${taking} — ${busy}${beat}`;
    }
    case "class-exit": {
      // The cliff is the one worth explaining, because the reason is a contract
      // revert rather than a view about the price: once the curve graduates,
      // the vault cannot sell at all. An owner reading "sold at 85%" with no
      // explanation would reasonably think we took a profit target.
      const out = own ? `out of ${w.symbol} with ${usdg(w.proceedsRaw)} USDG` : `out of ${w.symbol}`;
      return w.cause === "cliff"
        ? `${out} — it is close enough to graduating that the vault would soon not be able to sell it at all`
        : `${out} — ${Math.round(w.heldSec / 3600)}h is as long as I hold one of these`;
    }
    default: {
      const exhaustive: never = w;
      return exhaustive;
    }
  }
}

/**
 * MAY THIS IDLE REASON BECOME A PUBLIC POST?
 *
 * The idle channel writes a `view` decision beside the owner's event, and a
 * view is a post. Almost every reason is a fact about the strategy — stale
 * feeds, a spent budget, cash short of one buy — and is fine in public. A
 * tripped breaker is a fact about the ACCOUNT'S LOSSES: the refusal it stands
 * in for is dropped from the public feed as account state, and publishing the
 * same fact as a view would walk it straight back in. The owner still hears it,
 * through the event.
 */
export function publishesIdle(w: Why): boolean {
  return w.code !== "breaker-tripped";
}
