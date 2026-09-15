/**
 * WHETHER AN AGENT CAN ACT ON ITS OWN, AND — WHEN IT CANNOT — WHY, IN ONE PLACE.
 *
 * A tester opened the app, read "$1,000", waited a day, and reported the bot was
 * broken. The account held 0.000000 USDG. Every line the worker wrote was
 * correct and internally consistent: with no real cash `canTradeForReal` is
 * false, the agent drops to paper, and the paper book's starting balance is what
 * the account line then reports. Nothing lied. The screen simply rendered
 * practice money in the same shape as deposited money, and the reader supplied
 * the only interpretation available to them.
 *
 * That is the failure this module exists to make impossible. It is the same rule
 * the rest of this codebase already keeps about zero — `$0.00` is a measurement
 * and `—` is a missing one, and they must never render alike. Simulated money is
 * the third case: a number that is real arithmetic about an unreal book.
 *
 * WHY IT LIVES IN CORE. `liveBlocker` decides which leg of the live rail failed
 * and it lives in the worker, because it reads the worker's inputs. The NAMES of
 * those legs and the words an owner reads for them are not worker facts — the
 * dashboard, the chat and the feed all render them, and a second copy in the web
 * tier is exactly the drift that lets one surface say "add funds" while another
 * says "re-sign". The worker re-exports these, so there is still one home.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: decide anything. `autonomyOf` is a pure
 * restatement of facts the worker already established. It cannot make an agent
 * live, and a bug here can only mislabel — never unblock.
 */

/**
 * The leg of the live rail that failed.
 *
 * Ordered by what the remedy COSTS, not by how likely it is: a dead policy is
 * fixable only by re-signing — not by funding, not by a bundler key, not by
 * switching chain — so it outranks all three. Naming a cheaper remedy first
 * sends an owner to buy USDG for an account that could never have spent it.
 */
export type RefuseRule =
  | "not-armed"
  | "dead-policy"
  | "grant-too-wide"
  | "no-executor"
  /**
   * THE ONE THAT IS NOT A FAULT. The owner has not asked for real execution,
   * so nothing is broken and there is nothing to repair — the agent is doing
   * exactly what it was told. It sits in this union because every surface
   * already knows how to carry a rule, and inventing a parallel channel for it
   * would guarantee some surface forgot to read one of the two.
   *
   * It is deliberately ABSENT from `OWNER_ACTION` below. That set drives the
   * red BLOCKED pill and the re-sign banner, and a practising owner is neither
   * blocked nor in need of a signature.
   */
  | "live-not-enabled"
  | "wrong-chain"
  | "no-gas"
  | "no-cash";

/**
 * The same leg, in words an owner can act on.
 *
 * Sentence-shaped and lowercase because both existing callers embed it mid-line
 * ("NOT trading for real yet: …"). The short label and the button live below.
 */
export function liveBlockerText(rule: RefuseRule): string {
  switch (rule) {
    case "not-armed":
      return "your trading key is not active yet — the agent has no permission to trade with";
    case "dead-policy":
      return "this trading key was signed before a fix and cannot reach the chain; re-signing it is free and instant";
    case "grant-too-wide":
      return (
        "this key's permission set is too wide to install on-chain — its first operation would cost more " +
        "gas than we will sign for, so it can never reach the chain. Re-signing with fewer tokens or " +
        "fewer venues fixes it, and costs nothing"
      );
    case "no-executor":
      return "no bundler is configured, so nothing can be submitted to the chain";
    case "live-not-enabled":
      // Present tense, no remedy, no urgency. This is a description of a
      // working agent doing what it was asked, and the one sentence here that
      // must never read like a problem.
      //
      // AND IT MUST NOT CLAIM SIMULATION, because this rule reaches TWO
      // different states. With `paperTradingEnabled` on it is a paper verdict
      // and the agent simulates; with it off, `execModeOf` returns `refuse` and
      // the agent does nothing at all. The first draft said "it is practising
      // with simulated money" for both, which put this sentence next to
      // `simulated: false` and "Available cash" in the idle arm below — one
      // object asserting both halves of a contradiction.
      //
      // So this says only what is true either way. Whether anything is being
      // simulated is carried by `mode`, which every caller already has.
      return "live trading is off, so no real orders are placed — turn it on in Settings when you want it to trade for real";
    case "wrong-chain":
      return "this key is for a different network than the one trading happens on";
    case "no-gas":
      return "the account holds no ETH, and every operation has to pay a fee before it reaches the chain";
    case "no-cash":
      return "the account holds no USDG to trade with";
  }
}

/**
 * What this agent's money and activity actually are, as a single word.
 *
 *   live     real funds on chain, and nothing is stopping execution
 *   paper    simulated funds only — the numbers are arithmetic about a book
 *            that does not exist on any chain
 *   blocked  the owner has to do something, and until they do it cannot trade
 *   idle     nothing is wrong and nothing is happening: no capital to deploy
 *
 * `blocked` OUTRANKS `paper` on purpose. Both render as "not trading for real",
 * but only one of them has an action attached, and burying a re-sign behind the
 * word "paper" is how nine owners sat in practice mode without being told that a
 * free signature would end it.
 */
export type AutonomyState = "live" | "paper" | "blocked" | "idle" | "checking";

/** Blockers only the OWNER can clear. Everything else is ours to fix. */
const OWNER_ACTION: ReadonlySet<RefuseRule> = new Set<RefuseRule>([
  "dead-policy",
  "grant-too-wide",
  "wrong-chain",
  "not-armed",
]);

/**
 * The headline and the button, PER RULE — because "the owner can fix it" and
 * "the owner fixes it the same way" are different claims, and only the first is
 * true of this set.
 *
 * Three distinct remedies hide in four rules:
 *   dead-policy / not-armed  a fresh signature of the same shape — a renewal
 *   wrong-chain              a signature on a DIFFERENT NETWORK; renewing on
 *                            the current one is a guaranteed no-op, and the
 *                            grant screen syncs its selector to the key being
 *                            replaced, so the owner repeats it forever
 *   grant-too-wide           a SMALLER wall; same network, same freshness, and
 *                            still a no-op unless something is removed
 */
function ownerRemedy(rule: RefuseRule | "expired"): {
  headline: string;
  action: { label: string; kind: "renew-grant" | "add-funds"; chain?: number };
} {
  switch (rule) {
    case "wrong-chain":
      return {
        headline: "Your Merryman's permission is for a different network.",
        // Names the network, because the fix is to CHANGE one and the screen
        // opens on the one being replaced.
        //
        // AND NOW CARRIES IT. Naming the network in the label was only half a
        // remedy: the button said "Re-sign on Robinhood Chain" and opened a
        // screen whose selector syncs to the grant being replaced — so the
        // prominent control there read "re-sign this key (free)" and minted
        // another testnet grant. The owner re-signed, the banner came back, and
        // he reported the product as broken. `chain` is the intent travelling
        // with the button so the destination can honour what the label promised.
        action: { label: "Re-sign on Robinhood Chain", kind: "renew-grant", chain: 4663 },
      };
    case "grant-too-wide":
      return {
        headline: "Your Merryman's permission covers too much to be installed.",
        action: { label: "Sign a smaller permission", kind: "renew-grant" },
      };
    case "expired":
      return {
        headline: "Your Merryman's trading permission has expired.",
        action: { label: "Renew permission", kind: "renew-grant" },
      };
    default:
      return {
        headline: "Your Merryman needs a free permission renewal to trade autonomously.",
        action: { label: "Renew permission", kind: "renew-grant" },
      };
  }
}

export interface AutonomyInput {
  /** What the worker published: paper | live | idle. Null when never heard from. */
  mode: "paper" | "live" | "idle" | null;
  /** The worker's own verdict on which leg failed. Null when nothing is blocking. */
  liveBlocker: RefuseRule | string | null;
  /** Has the session key's validity window passed? Not a RefuseRule — see below. */
  expired?: boolean;
  /**
   * REAL, ON-CHAIN USDG. Not the book's cash, which in paper mode is the
   * simulated balance and is precisely what must not be mistaken for this.
   * Null means unreadable, which is not zero and must not render as zero.
   */
  realCashUsd?: number | null;
  /**
   * WAS THIS VERDICT REACHED ABOUT A KEY THAT NO LONGER EXISTS?
   *
   * True when the owner signed a new grant more recently than the worker last
   * spoke — i.e. `grant.grantedAt > workerAliveAt`. Both facts already travel on
   * `AgentStatus`, from the grant store the POST wrote synchronously and from
   * the mirrored `agents` row, so this asks nothing new of any service.
   *
   * WHY IT HAS TO EXIST. A corrected grant takes four hops to reach this
   * screen — the orchestrator's 15s ferry, the child's 240s tick, the 15s
   * mirror, the browser's 60s poll — about five and a half minutes at worst.
   * For all of it the page kept asserting the OLD blocker, so an owner who had
   * just done exactly what they were told watched the same banner tell them to
   * do it again. One of them re-signed repeatedly and reported the product as
   * broken; he was right to.
   *
   * THIS DOES NOT MAKE IT FASTER. It stops the screen claiming to know
   * something it cannot know yet, which is the only honest move available — the
   * remedy is a latency nobody can shorten from here.
   *
   * DELIBERATELY NOT A SUPPRESSION. It never says the agent is fine; it says we
   * have not heard since the signature. The instant the worker beats, whatever
   * it reports is shown in full — including "still wrong-chain", if the owner
   * re-signed onto the sandbox again.
   */
  blockerPredatesGrant?: boolean;
}

export interface Autonomy {
  state: AutonomyState;
  /** Short, for a chip. Uppercase because it is a status, not a sentence. */
  label: string;
  /** The one thing stopping autonomous trading, in the owner's words. Null when nothing is. */
  reason: string | null;
  /** The machine-readable rule behind `reason`, for styling and analytics. */
  rule: RefuseRule | "expired" | null;
  /** True when the owner — and only the owner — can clear this. */
  needsOwnerAction: boolean;
  /**
   * The headline sentence for the blocked banner.
   *
   * HERE RATHER THAN IN THE SURFACE, because the surface printed ONE sentence —
   * "Your Merryman needs a free permission renewal to trade autonomously" — for
   * every rule in OWNER_ACTION, and it is false for two of them.
   *
   * A tester hit exactly that: his key was signed for another network, the
   * banner told him to renew, renewing on the same network changed nothing, and
   * the banner came back. He reported it as "I'm resigning but this banner keeps
   * appearing", which is the shape of a remedy that cannot work being offered as
   * the only one. `grant-too-wide` has the same defect, and exec-mode.ts says so
   * in its own words: "re-signing the same wall changes nothing, so the owner
   * has to sign a smaller one".
   *
   * A remedy that cannot fix the named cause is worse than no remedy: it costs
   * the owner a signature, teaches them the product is broken, and hides the
   * real fix.
   */
  headline: string | null;
  /** The button to render, when there is one worth rendering. */
  /**
   * `start-live` is the odd one out, deliberately: the other two REPAIR
   * something, this one CHANGES A DECISION. It has to exist for "the owner
   * explicitly turned real trading on" to be a thing an owner can actually do —
   * without an affordance, consent would be required and ungrantable.
   */
  action: { label: string; kind: "renew-grant" | "add-funds" | "start-live"; chain?: number } | null;
  /**
   * Is the money on this screen simulated?
   *
   * The single most important field here. Every surface that prints a balance
   * must consult it, and must change the LABEL rather than adding a footnote —
   * a caption below a large number is not read by someone who has already
   * decided what the number means.
   */
  simulated: boolean;
  /** What to call the balance. "Available cash" is a promise; keep it for real money. */
  moneyLabel: string;
}

/**
 * EXPIRY IS NOT A RefuseRule, and that is not an oversight.
 *
 * `liveBlocker` is only consulted once `canTradeForReal` has answered false, and
 * an expired agent never gets that far — it is retired before the rail is
 * assessed, so it has no blocker to name. Rendering it as `not-armed` would be
 * true and useless: the remedy is identical to dead-policy's (re-sign) and the
 * cause is not. So it is carried alongside and named in its own words.
 */
export function autonomyOf(input: AutonomyInput): Autonomy {
  const rule = normaliseRule(input.liveBlocker);

  if (input.expired === true) {
    const remedy = ownerRemedy("expired");
    return {
      state: "blocked",
      label: "BLOCKED",
      reason: "this trading permission has expired, so the agent can no longer act for you",
      rule: "expired",
      needsOwnerAction: true,
      headline: remedy.headline,
      action: remedy.action,
      simulated: input.mode === "paper",
      moneyLabel: input.mode === "paper" ? SIMULATED_LABEL : REAL_LABEL,
    };
  }

  /**
   * A VERDICT ABOUT A KEY THE OWNER HAS ALREADY REPLACED IS NOT NEWS.
   *
   * Placed ahead of the OWNER_ACTION arm because that arm is the one that
   * renders the red pill and asks for a signature — and asking for the
   * signature they just gave is precisely the loop being closed here.
   *
   * Only the owner-clearable rules are gated. `no-cash` and `no-gas` are not
   * about the key at all, so a fresh signature says nothing about them and they
   * carry on reporting normally.
   */
  if (input.blockerPredatesGrant === true && rule && OWNER_ACTION.has(rule)) {
    return {
      state: "checking",
      label: "CHECKING",
      reason:
        "we have not heard from your agent since you re-signed — this usually takes a few minutes, " +
        "and what it reports next will be about the new key",
      rule,
      // NOT an owner action: they have already taken it. Offering the button
      // again is how the same signature gets made three times.
      needsOwnerAction: false,
      headline: null,
      action: null,
      // Unchanged from every other arm: what the money IS does not depend on
      // how fresh our news about it is.
      simulated: input.mode === "paper",
      moneyLabel: input.mode === "paper" ? SIMULATED_LABEL : REAL_LABEL,
    };
  }

  if (rule && OWNER_ACTION.has(rule)) {
    const remedy = ownerRemedy(rule);
    return {
      state: "blocked",
      label: "BLOCKED",
      reason: liveBlockerText(rule),
      rule,
      needsOwnerAction: true,
      headline: remedy.headline,
      action: remedy.action,
      // A blocked agent is usually ALSO on paper, and its balance is still
      // simulated. Both facts are true and the owner needs both.
      simulated: input.mode === "paper",
      moneyLabel: input.mode === "paper" ? SIMULATED_LABEL : REAL_LABEL,
    };
  }

  if (input.mode === "paper") {
    // NO REAL MONEY AND NO OWNER ACTION: the honest reading is "you have not
    // funded this yet", and the remedy is money, not a signature.
    const unfunded = input.realCashUsd === 0;
    /**
     * PRACTISING ON PURPOSE IS NOT A FUNDING PROBLEM, and offering "Add funds"
     * here was how the confusion started: a deliberately-practising owner was
     * shown a money button, so money is what he assumed was missing. It is not,
     * and after this change money cannot promote him anyway.
     *
     * The honest control for someone already doing what they chose is the one
     * that changes the choice.
     */
    const byChoice = rule === "live-not-enabled";
    return {
      state: "paper",
      label: "PAPER",
      reason: rule ? liveBlockerText(rule) : null,
      rule,
      needsOwnerAction: false,
      headline: null,
      action: byChoice
        ? { label: "Start live trading", kind: "start-live" }
        : unfunded
          ? { label: "Add funds", kind: "add-funds" }
          : null,
      simulated: true,
      moneyLabel: SIMULATED_LABEL,
    };
  }

  if (input.mode === "live") {
    return {
      state: "live",
      label: "LIVE",
      reason: null,
      rule: null,
      needsOwnerAction: false,
      headline: null,
      action: null,
      simulated: false,
      moneyLabel: REAL_LABEL,
    };
  }

  // `idle` and null share an arm because they mean the same thing to a reader:
  // nothing is wrong and nothing is happening. They differ only in whether we
  // have heard from the worker, which is our problem and not the owner's.
  return {
    state: "idle",
    label: "IDLE",
    reason: rule ? liveBlockerText(rule) : null,
    rule,
    needsOwnerAction: false,
    headline: null,
    action: input.realCashUsd === 0 ? { label: "Add funds", kind: "add-funds" } : null,
    simulated: false,
    moneyLabel: REAL_LABEL,
  };
}

/** The two money labels, named once so no surface can invent a third. */
export const REAL_LABEL = "Available cash";
/**
 * "PAPER", NOT "PRACTICE", and the word matters more than it looks.
 *
 * The product used "practice" for two unrelated things: simulated trading on any
 * chain, and the testnet itself — the wallet screen literally offered "Move this
 * key to practice (testnet 46630)". An owner who wanted the first could pick the
 * second and end up with a grant that can never trade, which is exactly what
 * happened. Three words now mean three things and nothing else: TESTNET is the
 * 46630 network, PAPER is simulated trading, LIVE is real money.
 */
export const SIMULATED_LABEL = "Paper balance (not real money)";

/**
 * The blocker as it arrives from the API: a TEXT column, so it can hold anything.
 *
 * An unrecognised value is dropped to null rather than passed through, because
 * every consumer of `rule` switches on it and a stray string would fall out of
 * the switch as `undefined` — rendering an agent as un-blocked precisely when
 * the worker was trying to say something new.
 */
function normaliseRule(v: RefuseRule | string | null | undefined): RefuseRule | null {
  switch (v) {
    case "not-armed":
    case "dead-policy":
    case "grant-too-wide":
    case "no-executor":
    // MUST BE LISTED, and the failure if it is not is the quiet kind: this
    // function drops anything it does not recognise to null, and a null rule
    // renders as an agent with nothing to say about itself. The one state whose
    // whole purpose is to explain that practising is deliberate would arrive as
    // no explanation at all.
    case "live-not-enabled":
    case "wrong-chain":
    case "no-gas":
    case "no-cash":
      return v;
    default:
      return null;
  }
}
