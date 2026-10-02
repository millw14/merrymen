/**
 * WHAT AN AGENT MAY SAY IN PUBLIC.
 *
 * WHY THIS LIVES UNDER worker/ AND NOT web/lib. It was in web/src/lib, which
 * was right while a browser was the only reader. The move anticipates a second:
 * the orchestrator is to materialise each child's followed theses into a file
 * the agent's desk reads, and what it writes must be EXACTLY what the public
 * feed publishes — same allowlist, same address backstop, same fail-closed
 * default.
 *
 * THAT SECOND READER NOW EXISTS: peer-theses.ts queries followed agents on the
 * orchestrator's side and every row leaves through the gate below, which is what
 * makes "a peer file can only contain what the public feed publishes" a property
 * rather than a promise. It did not exist for the three weeks this paragraph
 * described it in the present tense — the failure mode the rest of this module
 * exists to prevent, committed in a comment about it.
 * The worker cannot import from web/src (imports.test.ts forbids @merrymen/*
 * under worker/src, and web/src is not aliased inward at all), so the choice
 * was to move the module or keep a second copy. A second copy of a PUBLICATION
 * POLICY is the worst option available: the two readers drift into different
 * ideas of what may be published, and the drift stays invisible until
 * something private appears on a page. So it moved, and web/src/lib/thesis.ts
 * is a re-export. The module has no imports at all, which is what made that
 * mechanical — it is pure, DB-free, fetch-free and env-free, as below.
 *
 * This is the only gate between the decisions table and a page anybody can
 * read, and the decisions table was never built to be published. Three things
 * in it are actively unsafe, and none of them look it:
 *
 *   1. A `chat`-sourced reason embeds a RAW COUNTERPARTY ADDRESS by template —
 *      `owner asked to transfer 25 USDG to 0x… in chat` — unconditionally, on
 *      every chat transfer. Publishing one doxxes a third party and the amount.
 *
 *   2. The strategist is handed the whole signals snapshot — cash, vault,
 *      equity, every holding's dollar value — and its schema invites it to cite
 *      figures. A reason quoting the owner's balance sheet is within the design.
 *
 *   3. `dropped_rule` is a template with a MODEL-SUPPLIED HOLE in it:
 *      `#0 <symbol>: nothing held to sell`, where `<symbol>` is validated only
 *      as `typeof === "string"` — no length cap, no charset. It can never be
 *      published verbatim, at any length, however harmless it looks.
 *
 * SO THIS IS A WHITELIST, and it fails closed. A source nobody has classified
 * publishes nothing — not a redacted version, nothing. `SOURCE_POLICY` has no
 * fallthrough case by construction: an unknown key is `undefined`, and
 * `undefined` drops the row.
 *
 * WHY DROPPING RATHER THAN REDACTING. The address backstop below discards the
 * whole thesis rather than masking the match. Redaction implies we understood
 * the string well enough to know what was left; we don't, and a redactor that
 * is wrong once publishes the thing it was written to catch. Dropping is what
 * fail-closed actually means.
 *
 * WHAT IS NEVER HERE AT ALL. `signals_json` is not a field on the input type,
 * because the route does not select it. Not filtered — absent. That is a
 * stronger guarantee than any check in this file, and it is deliberate.
 *
 * PURE. No database, no fetch, no environment. It takes a row and returns a
 * post or null, so the whole policy is testable as a table.
 */

/** A joined decision + its outcome, exactly as the route selects it. */
export interface ThesisRow {
  agent_id?: string | null;
  name?: string | null;
  x_handle?: string | null;
  source?: string | null;
  action?: string | null;
  symbol?: string | null;
  /** The coin's own name, when the tape gave one. Display only; see store.ts. */
  display_name?: string | null;
  size_usdg?: number | null;
  reason?: string | null;
  dropped_rule?: string | null;
  /** A risk gate changing an action to hold is not the agent's market view. */
  hold_kind?: string | null;
  /** From the trade this decision caused, when there was one. */
  status?: string | null;
  reject_rule?: string | null;
  said?: number | null;
  last_at?: number | null;
  first_at?: number | null;
  /** The agent's mode at last heartbeat: "live" | "paper" | "idle" | null. */
  mode?: string | null;
  /**
   * The agent's public id, decorated onto the row by the caller.
   *
   * NOT selected from the ledger — the identity store is not the ledger, and
   * there is no cross-database join to make. The route reads the store once and
   * maps account -> slug over the rows it already has.
   */
  slug?: string | null;
  /**
   * THE AGENT'S OWN POST about this decision, joined from the posts table.
   *
   * Optional because most decisions have none and never will: it is written
   * only for a class trade that actually FILLED, and only when the writer had
   * something to say and cleared its gate. Absent is the common case and is not
   * a fault.
   */
  post?: string | null;
  // ── WHAT THE CALL WAS WORTH, folded per group by the reader's SQL ─────────
  //
  // A row here is a GROUP of identical copies, so each figure below arrives
  // already folded, and already NULL unless every copy in the group was read:
  // one unevidenced copy makes the whole group's figure unread, because an
  // average over the copies somebody happened to read is a guess. That rule
  // lives in the SQL beside the fold (read-theses.ts); this module only ever
  // sees the result and never turns an absent input into a zero.
  //
  // All optional: a reader that does not select them — the peer files — gets a
  // post with no figures, which claims nothing.
  /**
   * What the group's fills paid per unit, averaged by cash (Σ cash / Σ units),
   * from EVIDENCED fills only — a receipt or a paper book, never a quote,
   * because a quoted fill is an estimate and an estimated entry price is a
   * figure nobody read.
   */
  entry_price_usd?: number | null;
  /** Σ realized P&L the group's fills booked, USDG, when every copy booked one. */
  realized_pnl_usdg?: number | null;
  /** Σ USDG those same fills received — the proceeds the P&L was booked against. */
  closed_cash_usdg?: number | null;
  /** The price the author saw when it decided, when every copy saw the same one. */
  mark_usd?: number | null;
  /** The coin's market cap at decision time, the same way. Memecoins only. */
  mcap_usd?: number | null;
  /**
   * The author's owner opted into a public book — decorated by the caller from
   * settings, like `slug`. Only an explicit `true` publishes a dollar figure,
   * and a size is a dollar figure; anything else, including absence, keeps the
   * percentages-only default. See `sizeUsdg` on PublicThesis for why the size
   * went with the P&L.
   */
  public_book?: boolean | null;
}

export interface PublicThesis {
  name: string;
  /**
   * What a link points at, and what a follow targets. Null when this agent has
   * no identity yet — a grant minted before the store existed, or one whose
   * best-effort mint failed — in which case the post renders with no link
   * rather than not rendering at all. A missing link is a smaller loss than a
   * missing thesis.
   */
  slug: string | null;
  /** null when unset. Never "" and never "@unknown" — absent renders as nothing. */
  handle: string | null;
  /** "buy AAPL 16.66 USDG", or "" when the decision names nothing. */
  head: string;
  /**
   * The same facts, apart, so a feed can lay them out rather than print a
   * sentence. All three are null on a pure view — a post about the book rather
   * than about one name — and that absence is what makes it a THESIS post.
   *
   * They pass the same address backstop as everything else below.
   */
  action: "buy" | "sell" | "hold" | null;
  symbol: string | null;
  /**
   * THE COIN'S OWN NAME, when the tape gave one that is not the id itself.
   *
   * `symbol` for an autonomous Trencher coin is address-derived — `T` plus
   * eleven hex — and every surface that lays the facts out itself had only
   * that to print, so it printed "T3139F043B88" at a reader. This is the name
   * on its own; `symbol` stays the id everything prices and settles against.
   * Null, never a placeholder, when there is none. Optional only so older
   * constructions of this shape still type; the publisher always sets it.
   * Deployer-chosen text, so it passes the same address backstop as the rest.
   */
  displayName?: string | null;
  /**
   * THE TRADE'S SIZE — published only for a PUBLIC book, and null otherwise.
   *
   * It was published for every book, and on its own it looked harmless. Beside
   * `realizedPct` it is not: a sell's size is about its proceeds, so the P&L
   * the dollar gate withholds is `size × pct / (100 + pct)` — measured on the
   * ledger, "sell AAPL 4.00 USDG" at −20% is exactly the −1.00 that
   * `realizedUsd: null` was hiding. And a buy's size over `entryPriceUsd` is
   * the quantity it now holds. So the one opt-in that keeps a book private had
   * to cover the size too, or it covered nothing.
   *
   * The owner's rule is that percentages are the public default and `publicBook`
   * is opt-in; the profile already hides sizes for a private book, and this is
   * the feed agreeing with it. The HEAD drops the size with it (`headOf`), since
   * "sell AAPL 4.00 USDG" is the same figure in a sentence.
   */
  sizeUsdg: number | null;
  /**
   * Was this a pretend book?
   *
   * Paper agents DO appear here, which is a different answer from the one the
   * leaderboard gives. A leaderboard ranks P&L, and mixing fake capital into a
   * ranking of real returns is misleading. A thesis is not a return — an agent
   * reasoning about a token's depth is saying something true whether or not the
   * money behind it is. So it is shown, and it is labelled, and no figure from
   * it is ever ranked against a funded one.
   */
  paper: boolean;
  /**
   * "view" is a DECISION THE AGENT MADE, not a trade that failed to happen.
   *
   * Added because the desk's best feature rendered as its worst: a window where
   * the agent researched and concluded "stay flat, here is why" writes a
   * decision with a reason and no action, and every one of them read "no trade
   * came of it" — a failure sentence for the one case that is not a failure.
   * The same was true of an explicit hold. A hold is an answer.
   */
  outcome: "landed" | "reverted" | "refused" | "dropped" | "pending" | "view" | "shadow";
  outcomeText: string;
  /**
   * The agent said this; nothing could have come of it.
   *
   * A separate boolean rather than `outcome === "shadow"` alone, because a
   * renderer that forgets the new outcome arm still has to answer this
   * question, and because the two facts are genuinely different: `outcome` is
   * what happened to the decision, `shadow` is whether the machinery that would
   * have made something happen was connected at all.
   */
  shadow: boolean;
  reason: string | null;
  /**
   * What the agent said in its own voice, or null.
   *
   * SEPARATE FROM "reason", not a replacement for it. "reason" is our sentence
   * and is always safe; this is the model's, and carries model trust. A surface
   * shows this one when it is there and falls back to , so an agent
   * with nothing to say is never silent about a trade it made.
   */
  post: string | null;
  /** How many times this exact thesis was said in the window. */
  said: number;
  /** Epoch seconds. Formatted by the page, so this module stays pure. */
  at: number;
  firstAt: number;
  // ── THE CALL'S OWN FIGURES ───────────────────────────────────────────────
  //
  // A trade used to render beside the TOKEN's 24h change, and a reader took the
  // token's day for the agent's result. These are the call's: what a buy paid,
  // what a sell booked, the price a view was posted at. Each is null unless
  // every input to it was read — a surface renders NOTHING for null, never 0%.
  //
  // Optional because an older server sends none of them; a consumer treats
  // `undefined` exactly as null. The publisher always sets all five.
  /** A landed (or paper) BUY's fill price, USD per unit. "Since entry" = live / this − 1. */
  entryPriceUsd?: number | null;
  /** A landed (or paper) SELL's realized return, percent of the cost it closed. */
  realizedPct?: number | null;
  /**
   * The same sell's realized dollars — non-null ONLY when the author's owner
   * made the book public. Percentages are the public default; sizes are opt-in.
   */
  realizedUsd?: number | null;
  /** The price the author saw when it posted. "Since posted" = live / this − 1. */
  markUsd?: number | null;
  /** A memecoin's market cap at decision time, from the tape the agent read. */
  mcapUsd?: number | null;
}

/**
 * The strategies whose reasons may be published.
 *
 * Every one of these emits a typed `Why` that `renderWhy` turns into a sentence,
 * so the words came from us. A tenant's own strategy file is deliberately absent
 * and can never be added by accident: it returns a bare intent array and has no
 * way to produce a reason at all.
 */
export const PUBLISHABLE_STRATEGIES = [
  "steady-basket",
  "weekend-gap",
  "even-keel",
  "dip-hunter",
  "trencher",
  // `llm-strategist` IS DELIBERATELY ABSENT — see thesis.test.ts, which pins
  // that absence: its decisions publish as `strategist`, which is MODEL trust
  // (capped, address-checked) rather than the uncapped trust this list grants.
  //
  // KNOWN GAP, recorded rather than silently closed. Two sites in index.ts —
  // the idle post and the ensureDecision fallback — file renderWhy output (OUR
  // words: `model-held`, stop-floor, take-profit) under this strategy's name,
  // so for a strategist tenant those sentences reach no key at all and publish
  // nothing. Closing it by adding the name here would widen a trust boundary
  // that was drawn on purpose, so it is the owner's call, not a tidy-up.
] as const;

/**
 * The source a decision row is filed under, from the strategy's own name.
 *
 * A strategy may carry a parenthetical suffix that identifies its ENGINE rather
 * than its identity — `llm-strategist(anthropic:claude-opus-4)`. That belongs in
 * the operator log, where it tells you which driver answered, and it must not
 * reach the publication key: the policy is keyed by strategy, and a source that
 * silently changes when someone swaps the model is a source that matches
 * nothing. Stripping it here keeps one name in the ledger no matter who the
 * driver is.
 */
export function publicationSourceFor(strategyName: string): string {
  return `strategy:${strategyName.replace(/\([^)]*\)\s*$/, "")}`;
}

/** How much of a row each source is trusted for. Absent key ⇒ publish nothing. */
const SOURCE_POLICY: Readonly<Record<string, "strategy" | "model">> = Object.freeze({
  // The model's own words. Capped and address-checked before they are shown.
  strategist: "model",
  // Brain, running in shadow. Its words are a model's words and are treated as
  // such; what makes it different is not the trust level but the TENSE — see
  // SHADOW_SOURCES.
  "brain-shadow": "model",
  // The same reasoner, on an agent whose owner has enrolled it in
  // MERRYMEN_BRAIN_LIVE — so its decisions CAN reach a trade and must not be
  // filed under a source SHADOW_SOURCES lists as unable to. Publishable for
  // exactly the reason `brain-shadow` is: the words are the model's own,
  // address-scanned at two layers, and an owner watching a feed is owed the
  // thinking behind a trade that spent their money more than one that did not.
  brain: "model",
  // Deterministic review of observed public quotes, without execution authority.
  // Filed under this key only when the review CHANGED — a flipped bias or a
  // confirmed breakout. An unchanged one is `market-review-private`, below.
  "market-review": "strategy",
  ...Object.fromEntries(PUBLISHABLE_STRATEGIES.map((s) => [`strategy:${s}`, "strategy" as const])),
  /**
   * THE CLASS ROUTE — the one rail that traded and said nothing.
   *
   * Every class-vault entry and exit files under this source, and it was absent
   * from this map, so `publishableThesis` dropped all of it: two agents
   * completed full autonomous buy-and-sell round trips of a launch and neither
   * feed, nor any peer file, nor `read_peers` ever mentioned it. The most
   * interesting thing this product does was the one thing it never talked about.
   *
   * "strategy" TRUST, and that is a claim about authorship, not about
   * confidence. A class decision's `reason` is `renderWhy` output — our words,
   * written in advance, from a typed `Why` a deterministic producer emitted. It
   * is the same trust `strategy:even-keel` has and for exactly the same reason;
   * `reasons.ts` makes publishability a property of the type system rather than
   * something a reviewer has to remember.
   *
   * SO NOTHING MODEL-WRITTEN MAY EVER BE PUT IN THAT SLOT. `publishableThesis`
   * truncates to REASON_MAX only when the policy is "model", so prose smuggled
   * into a "strategy" row publishes UNCAPPED and unscanned. A post written in an
   * agent's own voice is model output and belongs in its own field with its own
   * gate — never in `reason`.
   */
  "class-route": "strategy",
  // NOT here, and each for its own reason:
  //   chat     — carries a counterparty address by template
  //   selftest — a dust probe, not a market view; it says so itself
  //   strategy:<a tenant's own file> — a string we did not write
  //   market-review-private — an unchanged review of one shared oracle series.
  //              Every quiet agent writes it every five minutes, and when one
  //              feed was fresh they all wrote the SAME line; published, it was
  //              one paragraph under five names. The owner's record keeps it.
});

/**
 * HOLDS THAT ARE NOT A MARKET VIEW.
 *
 * GATE_FORCED_HOLD: a risk gate turned the action into a hold — the agent was
 * not allowed to decide. STALE_MARK_HOLD: the Brain held on a price the tick
 * already knew was stale, so what it "saw" was the absence of a market ("price
 * feed stale, no volume…"), and published that read as a view about the coin.
 * Both stay in the owner's record, where they explain the silence; neither is
 * something to say in public.
 */
const PRIVATE_HOLD_KINDS: ReadonlySet<string> = new Set(["GATE_FORCED_HOLD", "STALE_MARK_HOLD"]);

/**
 * SOURCES WHOSE DECISIONS CANNOT REACH A TRADE.
 *
 * Brain is wired to think and to nothing else: there is no path from a
 * `BrainDecision` into `proposalsToIntents` or the executor, and a test proves
 * the absence by reading the imports rather than by trusting this comment.
 *
 * That absence has to survive the trip to a public page, and it very nearly did
 * not. A shadow row arrives with `action: "buy"`, a symbol, a size and a NULL
 * status — which is indistinguishable, to every gate below, from a real buy
 * whose trade has not landed yet. It would have been published as
 * `outcome: "pending"`, and the feed's badge function turns a pending buy into
 * the word "BUYING". An agent that cannot trade would have announced that it
 * was trading, in its own voice, on a page anybody can read.
 *
 * So a shadow source gets its own outcome arm and its own head, and both say
 * the conditional out loud: "would buy TSLA 5.00 USDG · a stated intention".
 * The reader is never left to infer from a missing status that nothing happened
 * — the post says so.
 *
 * WHEN EXECUTION IS CONNECTED, a source moves OUT of this set rather than the
 * set being deleted. The three states the feed then has to distinguish —
 * THESIS, INTENT, EXECUTED — are exactly the distinction this set draws, and
 * they do not collapse into one just because one agent graduated.
 */
export const SHADOW_SOURCES = ["brain-shadow"] as const;
const IS_SHADOW: ReadonlySet<string> = new Set<string>(SHADOW_SOURCES);

/**
 * SOURCES WHOSE POSTS ARE ABOUT TRADES THAT HAPPENED.
 *
 * A source in this set publishes only when its decision LANDED. Refused,
 * dropped, reverted and pending rows stay in the ledger and out of the feed.
 * The argument is at the gate below; the set is here beside SHADOW_SOURCES
 * because the two are the same kind of thing — a per-source rule about which
 * outcomes may be spoken about — and a reader should find them together.
 */
export const TRADED_ONLY_SOURCES = ["class-route"] as const;
const TRADED_ONLY: ReadonlySet<string> = new Set<string>(TRADED_ONLY_SOURCES);

/**
 * The trade statuses `outcomeOf` calls "landed" — a fill on chain, or on the
 * paper book. Exported for the SQL half of the gate below; outcomeOf keeps its
 * own two arms because the two say different sentences, and thesis-policy.test
 * holds the two in step.
 */
export const LANDED_STATUSES = ["landed", "paper"] as const;

/** Actions that move cash between the account and its vault — plumbing, not a thesis. */
export const CASH_ACTIONS = ["vault-deposit", "vault-withdraw"] as const;
const IS_CASH: ReadonlySet<string> = new Set<string>(CASH_ACTIONS);

/**
 * Wall rules that are about the ACCOUNT rather than the trade — the day's
 * allowance, and whether the key can act at all. A strategy's refusal on one of
 * these is the owner's fact and not a post; see the rule in publishableThesis.
 *
 * The arming half is every RefuseRule the execution fork writes into
 * `reject_rule` (core's autonomy.ts). account-refusals.test.ts holds a typed
 * record of that union, so a new rule there fails a test until it is placed.
 */
export const ACCOUNT_STATE_RULES = [
  "ops-cap",
  "daily-cap",
  "deposit-cap",
  "not-armed",
  "dead-policy",
  "grant-too-wide",
  "no-executor",
  "live-not-enabled",
  "wrong-chain",
  "no-gas",
  "no-cash",
  // The account's own drawdown against its high-water mark. See the halt rule
  // below, which is why this one also leaves for a MODEL's refusal.
  "drawdown-breaker",
] as const;
const IS_ACCOUNT_STATE: ReadonlySet<string> = new Set<string>(ACCOUNT_STATE_RULES);

/**
 * THE ACCOUNT RULES THAT HALT EVERY BUY, FROM EVERY PRODUCER — dropped from the
 * public feed whoever proposed the trade.
 *
 * The account-state rule above is for strategy sources only, and on purpose: a
 * model refused on the day's count still stated a view about the coin, and the
 * wall's answer is an honest ending to it. The breaker is different in kind.
 * While it is tripped the wall refuses every non-exit intent for the same
 * reason (policy.ts), so a refusal on it says nothing about the coin at all —
 * and a Trencher, whose buys ride the Brain's own decision row, re-reviews every
 * thirty seconds and writes that one fact in fresh model words each time.
 * Measured on the live feed 2026-09-23: thirty refused buys in fifteen minutes,
 * none of them collapsing, filling thirty of forty trade slots.
 *
 * THE OWNER STILL HEARS IT: `drawdown-breaker` is in owner-refusal.ts's
 * account-wide set, so the event line fires once per change, and the trade row
 * keeps its rule for the owner's desk. Only the public post goes.
 */
export const ACCOUNT_HALT_RULES = ["drawdown-breaker"] as const;
const IS_ACCOUNT_HALT: ReadonlySet<string> = new Set<string>(ACCOUNT_HALT_RULES);

/**
 * Every source a reader may put in a `WHERE source IN (…)`.
 *
 * Exported so the two SQL callers derive their list from the policy instead of
 * keeping their own copy of it. The SQL narrowing is an OPTIMISATION and this
 * module is the rule — but a hand-maintained second list is how the optimisation
 * silently becomes the rule for anything the policy later admits.
 */
export const PUBLISHABLE_SOURCES: readonly string[] = Object.freeze(Object.keys(SOURCE_POLICY));

/**
 * THE SQL HALF OF FOUR RULES BELOW, for a reader whose scan is bounded.
 *
 * A reader takes the newest N groups and only then asks `publishableThesis`
 * about each. The class route re-proposes a refused entry every tick with
 * drifting evidence, and a basket blocked on its own account refuses every leg
 * every tick, so the newest ninety groups could all be posts the gate was
 * always going to drop — and a buy that landed three hours earlier never
 * reached the gate at all. The feed had nothing to show, and the alerts rail
 * said there had been no trades.
 *
 * So the four rules that drop a row for its SOURCE, ACTION or RULE rather than
 * for its words are said in SQL too, built from the same constants, and the
 * scan spends its budget on rows that can publish. The gate still decides: this
 * may only ever be WIDER than publishableThesis, never narrower, and every row
 * it lets through is asked again there.
 *
 * EVERY NULLABLE COLUMN IS COALESCED, and that is what keeps it wider. A pure
 * view has no action and a refusal may carry no rule; `NULL IN (…)` is NULL,
 * `NOT NULL` is NULL, and WHERE drops a NULL — so without them this would
 * quietly unpublish every thesis that names nothing.
 *
 * `d` is the decisions alias and `t` the joined trade's. Every value travels as
 * a placeholder, in the order it appears, so the Postgres translator that
 * renumbers `?` has nothing of ours to misread.
 */
export function publicationNarrowing(d: string, t: string): { sql: string; args: string[] } {
  const holes = (n: number) => Array.from({ length: n }, () => "?").join(", ");
  const unlanded = `COALESCE(${t}.status, '') NOT IN (${holes(LANDED_STATUSES.length)})`;
  // The account rule is for STRATEGY sources only, and these are exactly the
  // ones the policy classifies — not a LIKE, which SQLite matches without case.
  const strategies = PUBLISHABLE_SOURCES.filter((s) => s.startsWith("strategy:"));
  return {
    sql: [
      `NOT (COALESCE(${d}.source, '') IN (${holes(TRADED_ONLY_SOURCES.length)}) AND ${unlanded})`,
      `NOT (COALESCE(${d}.action, '') IN (${holes(CASH_ACTIONS.length)}) AND ${unlanded})`,
      `NOT (COALESCE(${d}.source, '') IN (${holes(strategies.length)}) AND COALESCE(${t}.status, '') = ? AND COALESCE(${t}.reject_rule, '') IN (${holes(ACCOUNT_STATE_RULES.length)}))`,
      // Every source: a rejected trade is always a refused post (or, for a
      // shadow source, no post at all), and the gate drops a refusal on a halt
      // rule whoever wrote it — so this drops nothing the gate would publish.
      `NOT (COALESCE(${t}.status, '') = ? AND COALESCE(${t}.reject_rule, '') IN (${holes(ACCOUNT_HALT_RULES.length)}))`,
    ].join(" AND "),
    args: [
      ...TRADED_ONLY_SOURCES,
      ...LANDED_STATUSES,
      ...CASH_ACTIONS,
      ...LANDED_STATUSES,
      ...strategies,
      "rejected",
      ...ACCOUNT_STATE_RULES,
      "rejected",
      ...ACCOUNT_HALT_RULES,
    ],
  };
}

/**
 * THE SQL HALF OF A CALL'S FIGURES — the fold a reader of GROUPED copies runs
 * before handing a group to `publishableThesis` (see the figure fields on
 * ThesisRow). Shared by the feed and the peer files for the reason
 * `publicationNarrowing` is: two readers with their own copy of "when is a
 * figure read" would publish two answers to it.
 *
 * A group is many identical copies, so each figure is one number for all of
 * them, and it exists only when EVERY copy was read: one unevidenced fill in a
 * ×3 buy makes the entry unread rather than an average of the two somebody
 * happened to read. EVIDENCED is a fill off the settled receipt or the paper
 * book — never the pre-trade quote, which `basis_source` calls an estimate,
 * and an estimated entry price is a figure nobody read.
 *
 * The entry is averaged by what was PAID (Σ cash / Σ units), which is what a
 * position of those fills cost per unit; a plain mean of prices is not. Each
 * division is guarded per row, because Postgres raises on a zero divisor.
 * Each column ends in a comma, for splicing into a SELECT list.
 *
 * A SELL'S RESULT IS ONLY AS READ AS THE BASIS IT CLOSED. Its P&L is its
 * proceeds minus the average cost of what it sold, and that cost was booked by
 * the BUYS — any one of which may have been booked from the quote because its
 * receipt could not be parsed (index.ts says so in the log: "cost basis booked
 * from the quote (an estimate)"). A receipt-read sell over that basis is an
 * estimated return, and checking the sell's own row alone published it as a
 * read one. So a live fill counts as booked only when no quote-sourced trade
 * by the same account BOUGHT the coin it sold, before it. (For a buy the "coin
 * it sold" is the cash, which no figure here reads: only a sell's P&L is
 * published.) See `estimatedBasis`.
 *
 * SO A READER THAT SELECTS THESE puts `basisScope` in front of its statement
 * and `basisJoin(t)` among its joins. One that forgets gets a missing-column
 * error, which every reader here already answers by retrying without figures
 * — a post loses its figures, never the feed its posts, and no guess is shown.
 */
export function fillFigures(t: string): string {
  const evidenced = `(${t}.basis_source IN ('receipt', 'paper') AND ${t}.fill_price_usd > 0 AND ${t}.fill_cash_usdg > 0)`;
  const booked = `${evidenced} AND ${t}.realized_pnl_usdg IS NOT NULL AND NOT ${estimatedBasis(t)}`;
  const every = (cond: string) => `SUM(CASE WHEN ${cond} THEN 1 ELSE 0 END) = COUNT(*)`;
  return `
    CASE WHEN ${every(evidenced)} AND MIN(${t}.fill_price_usd) = MAX(${t}.fill_price_usd) THEN MIN(${t}.fill_price_usd)
         WHEN ${every(evidenced)}
         THEN SUM(${t}.fill_cash_usdg) / SUM(CASE WHEN ${evidenced} THEN ${t}.fill_cash_usdg / ${t}.fill_price_usd END) END AS entry_price_usd,
    CASE WHEN ${every(booked)} THEN SUM(${t}.realized_pnl_usdg) END AS realized_pnl_usdg,
    CASE WHEN ${every(booked)} THEN SUM(${t}.fill_cash_usdg) END AS closed_cash_usdg,`;
}

/**
 * WHETHER THE COST A LIVE FILL CLOSED WAS AN ESTIMATE — a SQL predicate over the
 * trades alias `t`, true when a quote-sourced trade by the same account bought
 * the coin `t` sold, at or before it. Exported for any reader of a realized
 * P&L, because "when is a realized figure read" must have one answer.
 *
 * "Before it", not "since the position was last flat", on purpose: an average
 * cost carries every buy since the last time the book was empty, and the
 * ledger has no column a reader can trust to say when that was (the quantities
 * are 18-decimal strings no SQLite REAL sums exactly). Erring early costs a
 * later round trip its figure — nothing is shown — and never shows a guess.
 * A paper fill closes the paper book, which no quote ever priced, so it is
 * never estimated here. Every column is one the base schema or the fill
 * migration created, on both engines.
 *
 * READ ONCE PER STATEMENT, NOT ONCE PER ROW. This was a correlated EXISTS, and
 * with no quote buy to find — the common case — it walked the account's whole
 * earlier history for every receipt copy in the read: refusals are trade rows,
 * a basket writes hundreds a day, and 40 sells over 200k rows took five
 * seconds a read on the feed, the profile and every tenant's peer file. It now
 * reads the joins `basisJoin` adds, over the set `basisScope` builds once, in
 * front of the statement. A row whose account is not in that set is counted an
 * ESTIMATE: the scope is a bound on the work, and a bound that could publish a
 * guess would be the wrong way round.
 */
export function estimatedBasis(t: string): string {
  return `(COALESCE(${t}.basis_source, '') = 'receipt' AND (basis_r.agent_id IS NULL OR (
      basis_q.first_at IS NOT NULL AND basis_q.first_at <= ${t}.created_at)))`;
}

/**
 * THE QUOTE-BOOKED BUYS A READ'S SELLS COULD HAVE CLOSED, as a WITH clause the
 * reader puts in front of its statement, with its arguments first.
 *
 * `basis_read` is every account with a receipt-read sell in the read's window —
 * the only accounts whose figures `estimatedBasis` is asked about. `basis_quote`
 * is, for each of those accounts and each coin, its FIRST quote-booked buy: a
 * sell is estimated exactly when that first one is at or before it, which is
 * the EXISTS this replaced. One pass over those accounts' histories, through
 * `trades_agent_time`, per statement — no index is added (the rule on
 * `trades`), and none is needed.
 *
 * `since` is the read's own window, widened by a day so a trade written a
 * moment before its decision's clock is still in scope (and one that is not
 * reads as an estimate, never as a figure). `accounts`, when the read is for
 * known agents, narrows it through `agents` — the ledger may spell an account
 * in either case, and the index needs the spelling it holds.
 */
const BASIS_MARGIN_SEC = 24 * 3600;
export function basisScope(opts: { since: number; accounts?: readonly string[] | null }): { sql: string; args: unknown[] } {
  const since = Math.floor(Number(opts.since)) - BASIS_MARGIN_SEC;
  const accounts = (opts.accounts ?? []).map((a) => a.toLowerCase());
  const only = accounts.length
    ? `AND br.agent_id IN (SELECT ba.smart_account FROM agents ba WHERE LOWER(ba.smart_account) IN (${accounts.map(() => "?").join(", ")}))`
    : "";
  return {
    sql: `WITH basis_read AS (
        SELECT DISTINCT br.agent_id AS agent_id FROM trades br
         WHERE br.basis_source = 'receipt' AND COALESCE(br.fill_side, 'sell') <> 'buy' AND br.created_at > ?
           ${only}
      ), basis_quote AS (
        SELECT bq.agent_id AS agent_id, LOWER(bq.buy_token) AS tok, MIN(bq.created_at) AS first_at
          FROM trades bq
         WHERE bq.basis_source = 'quote' AND bq.agent_id IN (SELECT agent_id FROM basis_read)
         GROUP BY bq.agent_id, LOWER(bq.buy_token)
      ) `,
    args: [Number.isFinite(since) ? since : 0, ...accounts],
  };
}

/** The two joins `estimatedBasis` reads, for the trades alias `t`. At most one row each. */
export function basisJoin(t: string): string {
  return `LEFT JOIN basis_read basis_r ON basis_r.agent_id = ${t}.agent_id
         LEFT JOIN basis_quote basis_q ON basis_q.agent_id = ${t}.agent_id AND basis_q.tok = LOWER(${t}.sell_token)`;
}

/**
 * The decision's own mark and market cap, folded the same way: two copies of a
 * view seen at different prices have no one "when posted", so no mark.
 */
export function markFigures(d: string): string {
  const one = (col: string) =>
    `CASE WHEN COUNT(${d}.${col}) = COUNT(*) AND MIN(${d}.${col}) = MAX(${d}.${col}) THEN MIN(${d}.${col}) END AS ${col},`;
  return `
    ${one("mark_usd")}
    ${one("mcap_usd")}`;
}

/**
 * Anything that looks like an on-chain identifier.
 *
 * `rh:` is included because the brokerage rail's agent id embeds an account
 * number, and a reason that quoted one would publish it.
 */
const ADDRESSY = /\b(?:0x[0-9a-fA-F]{6,}|rh:[A-Za-z0-9-]{1,64})\b/;

/** Matches the `/why` truncation point, so no surface cuts one mid-word. */
/**
 * The published length of a model's reason.
 *
 * EXPORTED because the web rail used to keep its own, shorter number — 90 — and
 * so clipped sentences the card beside it rendered in full. A cap is a product
 * decision about how much of an agent's view a reader gets; two of them means
 * the tighter one silently wins and nobody knows which.
 */
export const REASON_MAX = 220;

/**
 * CUT AT A BOUNDARY, AND SAY THAT YOU CUT.
 *
 * This was `slice(0, REASON_MAX)`. Measured on the live feed: 28 of 40 rows
 * were EXACTLY 220 characters, ending "...230.01 res" and "...GOOGL 342.79/35"
 * — every model-written view that ran long, cut mid-word, no ellipsis, on a
 * page whose whole point is that the agent sounds like somebody. The web had a
 * boundary-aware cutter (terminal/why.ts shortWhy) and it was dead for these
 * rows, because it only ever saw the string after this slice had already
 * happened.
 *
 * This is the one gate every reader shares — the feed and the peer files both
 * come through here — so it is the layer that has to be right; the prompts now
 * state a budget as well, so the model rarely reaches it. Prefer the last
 * sentence end if one falls in the back part of the budget, else the last
 * space, then an ellipsis; the result is always <= REASON_MAX.
 */
export function clip(text: string, max: number = REASON_MAX): string {
  const s = text.trim();
  if (s.length <= max) return s;
  const room = s.slice(0, max - 1);
  const lastStop = Math.max(room.lastIndexOf(". "), room.lastIndexOf("! "), room.lastIndexOf("? "));
  const cutAt = lastStop >= Math.floor(max * 0.6) ? lastStop + 1 : room.lastIndexOf(" ");
  const kept = (cutAt > 0 ? room.slice(0, cutAt) : room).trimEnd().replace(/[,;:—–-]+$/, "");
  return `${kept}…`;
}

/**
 * Why a proposal never reached the wall, said in our words.
 *
 * The clause after the first ": " in `dropped_rule` is author-written; the part
 * before it is not. So this matches the tail against a fixed list and returns a
 * sentence of our own — it never quotes, and it never echoes the figure in
 * "buy 50 USDG exceeds available cash", which would publish a bound on the
 * agent's cash.
 */
/**
 * The public id's shape, duplicated from identity-store's SLUG_RE on purpose.
 *
 * This module has NO IMPORTS — that is what let it move out of web/src/lib and
 * be read by the orchestrator as well as the browser — and importing a store
 * that reaches for node:fs and pg would end that immediately. A 16-character
 * base32 alphabet is not going to drift, and identity-store's own tests pin the
 * generator against exactly this shape.
 */
const SLUG_SHAPE = /^[0-9a-hjkmnp-tv-z]{16}$/;

export function classifyDrop(dropped: string): string {
  const tail = dropped.includes(": ") ? dropped.slice(dropped.indexOf(": ") + 2) : dropped;
  if (/not in the tradable universe/i.test(tail)) return "it named something outside what it may trade";
  if (/exceeds available cash/i.test(tail)) return "it asked for more cash than it had";
  if (/token is paused/i.test(tail)) return "that token is paused";
  if (/nothing held to sell/i.test(tail)) return "there was nothing held to sell";
  if (/curve has graduated/i.test(tail)) return "that launch has graduated to a pool";
  if (/no slippage floor/i.test(tail)) return "no price floor could be derived, so it refused to size it blind";
  return "it talked itself out of it";
}

/**
 * WHAT THE WALL SAID, in words a stranger can read.
 *
 * Module scope rather than a local, so the ONE list of rules this product
 * recognises has one home. `reject_rule` is NOT a closed vocabulary — some
 * paths write free-form text into it — which is exactly why anything absent
 * here gets the generic sentence rather than being echoed onto a public page.
 */
const R: Readonly<Record<string, string>> = Object.freeze({
  "per-trade-cap": "past the per-trade cap",
  // The same ceiling, met by a DEPOSIT into the vault rather than by a trade —
  // `policy.ts` picks between the two names on one line. It was missing here,
  // found by the drift test written for `no-exit`, which is the point of having
  // one: the same omission had already happened twice before anybody looked.
  "deposit-cap": "past the per-trade cap, which a vault deposit is measured against too",
  "daily-cap": "past today's spending cap",
  "ops-cap": "past today's number of trades",
  "drawdown-breaker": "the drawdown breaker was tripped",
  "asset-allowlist": "that asset is not in its signed permissions",
  "target-allowlist": "that venue is not in its signed permissions",
  "transfer-recipient-allowlist": "that recipient is not in its signed permissions",
  "no-gas": "the account had no gas",
  "no-route": "no route to trade it",
  "no-quote": "no price could be quoted",
  "no-liquidity": "not enough liquidity to fill",
  slippage: "the price moved too far between quote and fill",
  "insufficient-balance": "it did not hold what it tried to spend",
  "curve-graduated": "that launch had already graduated",
  // The worker writes this whenever a curve trade is proposed against a grant
  // carrying no Pons adapter. It was missing from this map, so a real and
  // common refusal fell to the catch-all and rendered as nothing at all —
  // invisible in the lane breakdown and unnamed in the feed.
  "no-curve-adapter": "this grant carries no adapter for that launchpad",
  "curve-provenance": "the launch could not be verified",
  // MISSED IN THE SAME SWEEP AS THE FIVE BELOW, and it reached an owner as the
  // bare word: "🧱 refused: no-exit. Nothing was sent and nothing was spent.
  // What does this mean if my agent tries to buy some custom token i added?"
  //
  // It means exactly one thing, and it is a fact about the SIGNATURE, never
  // about liquidity or routing: the buy token is not in the grant's sellable
  // set, so the position could be opened and never closed. policy.ts refuses it
  // before any quote is fetched, which is why it says nothing at all about
  // whether the token is tradable.
  //
  // Third person and no URL, like every other entry here — a stranger reading
  // the public tape cannot act on it. The owner's half, which names /grant,
  // lives in `rejectRuleRemedy` below.
  "no-exit": "its signed permission cannot sell that token, so the buy was refused before anything was sent",
  // ── THE FIVE THAT SAY AN AGENT IS NOT TRADING AT ALL ────────────────────
  //
  // `no-gas` above is one of six RefuseRules that execModeOf can produce, and
  // it was the only one here. The other five are written into `reject_rule`
  // every tick a blocked agent proposes anything, so the sentences that explain
  // an agent doing NOTHING — the single most common thing an owner asks about —
  // were the ones falling to the catch-all and rendering as unnamed amber.
  //
  // Wording follows exec-mode.ts's own `liveBlockerText`, which is where an
  // owner meets these in the feed; a public page and a private feed disagreeing
  // about the same fact is its own bug. live-blocker.test.ts already forces the
  // funding screen to cover every RefuseRule — nothing forced this map, which
  // is why it drifted.
  "not-armed": "it has no signed trading key yet",
  "dead-policy": "its signature seals a policy contract that is not on this chain",
  // Said as a SIZE, not a fault. The owner did nothing wrong — the product let
  // them sign a permission set it could never install, and the remedy is a
  // narrower one rather than anything they need to undo.
  "grant-too-wide": "its permission set is too wide to install on-chain",
  "no-executor": "no bundler is configured to submit anything",
  // The only entry here that is a CHOICE rather than a condition, so it is
  // phrased as one. This sentence is embedded mid-line after "it is not trading
  // for real because…", and it has to finish that sentence without implying
  // anybody made a mistake.
  // Neutral about simulation for the same reason as core's `liveBlockerText`:
  // this rule covers an agent that simulates AND one that does nothing, and a
  // public tape cannot tell a reader which from the rule alone.
  "live-not-enabled": "its owner has not turned on live trading, so it places no real orders",
  "wrong-chain": "its key was signed for a different network",
  "no-cash": "the account held no USDG to trade with",
  // ── THE ENERGY BUY ──────────────────────────────────────────────────────
  //
  // Every rule the owner's energy buy can write into `reject_rule`, so none of
  // them reaches a surface as a bare slug. Utility words only: energy is how
  // much the agent may do on its own, and nothing here says anything about the
  // token's price or what it might be worth. No tax or fee percentages either —
  // the figure is the token owner's to change, and a number printed here would
  // go stale without a line of this file changing.
  "energy-not-granted": "its signed key has no route to buy its own energy",
  "energy-needs-live": "it buys its own energy only while trading live",
  "energy-tax": "the token's own buy tax was above what the energy buy accepts",
  "energy-tax-unreadable": "the token's buy tax could not be read, so no safe floor could be set",
  "energy-no-quote": "the energy route could not be quoted",
  // The planner's own refusals (energy-buy.ts). Today they are said to the
  // owner before any intent exists and write no row; they are named here so
  // that the day one does, it reaches no surface as a bare slug.
  "energy-unreadable": "its balances could not be read, so it bought no energy",
  "energy-in-flight": "an earlier energy buy was still settling",
  "energy-too-small": "the most it could spend was below the smallest energy buy",
  // The accounting gate's own refusal (energy-accounting.ts): the purchase is
  // capital leaving the book, and this one would have left nothing, or too
  // little, contributed. Said as capital, never as performance.
  "would-exhaust-contributions": "spending that much on energy would have used up all, or nearly all, the capital put into it",
  // ── OUR OWN CHECKS BEFORE SIGNING, NOT THE WALL ─────────────────────────
  //
  // gas-limits.ts `boundGas` and executor.ts's `GasRefused`. None of these is
  // the owner's sealed policy: they are the product declining to sign an
  // operation whose gas it cannot justify, before anything is sent. They were
  // absent here, so an owner was handed "🛡 the wall turned back a buy of
  // ORBIO (gas-absurd)" — the bare slug, blamed on their own signature.
  // `isGasRefusal` below is what keeps the Telegram line from saying "wall".
  "gas-absurd": "its network fee estimate was far above what this trade should cost",
  "gas-unstable": "two network fee estimates for the same trade disagreed too far to trust either",
  "gas-unreadable": "its network fee could not be estimated",
  "gas-paymaster-unexpected": "its fee estimate did not match how the trade is paid for",
  "enable-too-wide": "its permission set is too wide to install together with this trade",
  "enable-replayed": "it tried to install permissions that had already been installed",
  "enable-redundant": "its permissions were already installed, so the install was not repeated",
  "enable-unverified": "the chain could not confirm whether its permissions needed installing",
  // gas-limits.ts `checkPrefund`: the fee the network holds up front.
  "prefund-short": "the account did not hold enough to cover the network fee up front",
  "prefund-unverified": "the up-front network fee could not be checked against the account's balance",
});

/**
 * Refusals that are the product's own gas checks before signing — never the
 * owner's wall. A surface that would say "the wall turned it back" says "it
 * wasn't sent" for these instead, as it already does for the gas sponsor.
 */
const GAS_REFUSALS: ReadonlySet<string> = new Set([
  "gas-absurd",
  "gas-unstable",
  "gas-unreadable",
  "gas-paymaster-unexpected",
  "enable-too-wide",
  "enable-replayed",
  "enable-redundant",
  "enable-unverified",
  "prefund-short",
  "prefund-unverified",
]);

export function isGasRefusal(rule: string | null | undefined): boolean {
  return !!rule && GAS_REFUSALS.has(rule);
}

/**
 * Refusals that are the MARKET, not the wall: nowhere to trade it, no price,
 * not enough depth, a price that moved, a launch that already graduated, or a
 * balance that was not there. "🛡 the wall turned back a buy of UBIK — no
 * route to trade it" reached an owner who then went looking through the
 * permissions they signed for a refusal their wall never made.
 */
const MARKET_REFUSALS: ReadonlySet<string> = new Set([
  "no-route",
  "no-quote",
  "no-liquidity",
  "slippage",
  "curve-graduated",
  "insufficient-balance",
]);

export function isMarketRefusal(rule: string | null | undefined): boolean {
  return !!rule && MARKET_REFUSALS.has(rule);
}

/**
 * The rule slugs this product recognises, for a reader that needs to GROUP by
 * them rather than render them.
 *
 * Exported so the wall band's lanes are not a second hand-rolled copy of a
 * publication policy. A rule outside this set is not a new lane, it is the
 * catch-all — the same refusal `outcomeOf` makes one line below.
 */
export const REJECT_RULES: readonly string[] = Object.freeze(Object.keys(R));

/**
 * The same sentence `outcomeOf` would use, for a reader GROUPING by rule.
 *
 * The wall band already knows which rule stopped each intent and renders it as
 * unlabelled amber. A page that wants to say "past the per-trade cap · 31" must
 * get the wording from here rather than title-casing the slug, for the reason
 * this whole map exists: the slug is an internal name and some of them read as
 * accusations ("insufficient-balance") that the sentence does not.
 *
 * Returns null for anything outside the set — including the band's catch-all —
 * so an unrecognised rule is rendered as nothing rather than echoed raw. The
 * detail after the slug is author-written and is never selected.
 */
export function rejectRuleLabel(rule: string | null | undefined): string | null {
  if (!rule) return null;
  return Object.prototype.hasOwnProperty.call(R, rule) ? R[rule]! : null;
}

/**
 * WHAT THE OWNER CAN DO ABOUT IT — a second register, deliberately separate.
 *
 * `R` above is the PUBLIC sentence: third person, no URLs, because a stranger
 * reading another agent's tape cannot act on it and should not be told to. This
 * is the sentence for the person who can, and it is the half that was missing
 * when an owner asked what `no-exit` meant and the product answered with the
 * slug.
 *
 * ONLY RULES WITH A REAL OWNER ACTION GET AN ENTRY. Everything else returns
 * null, which is what `autonomy.ts`'s `ownerRemedy` already establishes: "the
 * owner can fix it" and "the owner fixes it the same way" are different claims,
 * and a remedy invented for a rule that has none is worse than silence.
 *
 * NOT BUILT FROM `verdict.detail`, which is where these sentences already exist
 * in prose. Four reasons: the detail is not on the trade row (`store.ts` has a
 * `reject_rule` column and no detail column), it is unbounded free text this
 * file already fights to keep off a public page, several details embed a raw
 * address — one of them a third party's recipient — and the remedy is a
 * property of the RULE rather than of one refusal's wording, so every surface
 * needs it and not just the chat.
 */
export function rejectRuleRemedy(rule: string | null | undefined): string | null {
  if (!rule) return null;
  switch (rule) {
    case "no-exit":
      return "Re-sign your trading permission at /grant so it covers that token — renewal revokes old permissions on-chain and requires network fees.";
    case "asset-allowlist":
      return "Add the token at /settings, then re-sign your trading permission at /grant to cover it.";
    case "dead-policy":
    case "not-armed":
      return "Re-sign your trading permission at /grant — renewal revokes old permissions on-chain and requires network fees.";
    case "grant-too-wide":
      return "Re-sign at /grant on the web — a new signature there seals a narrower permission set that usually fits; if it is still too large, drop a custom token or a venue.";
    // The first operation of a key carries its whole wall plus a trade; this
    // one's wall leaves no room for the trade under what we will sign.
    case "enable-too-wide":
      return "Re-sign at /grant on the web — a new signature there seals a narrower permission set that leaves room for the trade that installs it; if it is still refused, drop a custom token or capability. Renewal revokes old permissions on-chain and requires network fees.";
    case "no-cash":
      return "Send USDG to the agent's account.";
    // Most often a coin whose only market is a Uniswap v4 pool, on a key that
    // does not carry the v4 adapter. Conditional, because a coin with no pool
    // anywhere gets the same slug and no setting fixes that.
    case "no-route":
      return "If it trades only on Uniswap v4 and your key doesn't carry the v4 adapter yet, save the V4SelfSwap adapter in /settings and re-sign at /grant so your agent can reach it.";
    case "no-gas":
      return "Send a little ETH to the agent's account — every operation pays a fee before it reaches the chain.";
    // The network holds the whole fee limit up front and returns what is not
    // used, so the account needs more on hand than one trade ends up costing.
    case "prefund-short":
      return "Send a little ETH to the agent's account — the network holds the fee up front and returns the unused part.";
    case "wrong-chain":
      return "Re-sign at /grant on Robinhood Chain; the current key is for a different network.";
    case "live-not-enabled":
      return "Turn on Live trading in Settings when you want it to trade real funds.";
    // THE ENERGY BUY'S TWO OWNER ACTIONS, and both of them name the way round
    // it: $MERRYMEN sent straight to the account counts the moment it lands,
    // whatever the key or the mode. The transient three (tax unreadable, no
    // quote, a tax above the ceiling) are the chain's to change, not the
    // owner's — except that sending the tokens directly is always open, which
    // is why `energy-tax` still says so.
    case "energy-not-granted":
      return "Re-sign your trading permission at /grant — revocation requires network fees — or send $MERRYMEN to the agent's account on Robinhood Chain directly.";
    case "energy-needs-live":
      return "Turn on Live trading in Settings, or send $MERRYMEN to the agent's account on Robinhood Chain directly.";
    case "energy-tax":
    case "energy-too-small":
      return "Send $MERRYMEN to the agent's account on Robinhood Chain directly — it counts the moment it lands.";
    case "would-exhaust-contributions":
      return "Send USDG to the agent's account first, then ask for energy again — or send $MERRYMEN to the agent's account on Robinhood Chain directly.";
    default:
      return null;
  }
}

/**
 * THE ONE "PENDING" THAT IS AN ORDER ON ITS WAY — a submitted trade.
 *
 * `outcomeOf` files two different facts under "pending": this one, and every
 * buy or sell decision that has no trade row at all ("no trade came of it"),
 * which is usually a permanent non-event. Exported so a renderer that colours
 * an order in flight tells the two apart by the publisher's own sentence
 * rather than by a copy of it (beat.ts `inFlight`).
 */
export const IN_FLIGHT_TEXT = "sent, waiting on the chain";

/** What the wall said, from the slug alone — the detail is never selected. */
export function outcomeOf(
  status: string | null | undefined,
  rejectRule: string | null | undefined,
): { outcome: PublicThesis["outcome"]; text: string } {
  if (status === "landed") return { outcome: "landed", text: "landed" };
  if (status === "paper") return { outcome: "landed", text: "filled on paper" };
  if (status === "reverted") return { outcome: "reverted", text: "reverted on-chain" };
  if (status === "submitted") return { outcome: "pending", text: IN_FLIGHT_TEXT };
  if (status !== "rejected") return { outcome: "pending", text: "no trade came of it" };

  // `reject_rule` is NOT a closed vocabulary — some paths write free-form text
  // into it — so anything unrecognised gets the generic sentence rather than
  // being echoed onto a public page.
  const known = rejectRule ? R[rejectRule] : undefined;
  return { outcome: "refused", text: known ?? "the wall turned it back" };
}

/**
 * "buy AAPL 16.66 USDG" — built structurally, never from prose.
 *
 * A shadow decision reads "would buy AAPL 16.66 USDG". The conditional is put
 * in the HEAD rather than left to a badge because the head is the one string
 * every surface renders: a share card, a feed row, a peer file the desk reads
 * back to another agent. Only one of those three is a React component, so a
 * claim that is only made conditional by CSS is not made conditional.
 */
function headOf(row: ThesisRow, shadow: boolean, sized: boolean): string {
  // A HOLD HAS NO SIZE. Brain forces delta to 0 on a hold, which arrived here
  // as size_usdg 0 and rendered "hold NVDA 0.00 USDG" — a figure that means
  // nothing and reads as a bug. A hold is an answer, not a quantity.
  //
  // AND A PRIVATE BOOK'S TRADE HAS NO SIZE IN PUBLIC, whatever it traded: the
  // head is the one string every surface prints, so a size withheld from
  // `sizeUsdg` and left here would be withheld from nothing. See `sizeUsdg`.
  const size =
    sized && row.action !== "hold" && typeof row.size_usdg === "number" && Number.isFinite(row.size_usdg)
      ? `${row.size_usdg.toFixed(2)} USDG`
      : null;
  // A hold is already the conditional's answer — "would hold" is not English an
  // agent would speak, and there is nothing to disclaim.
  const verb =
    shadow && (row.action === "buy" || row.action === "sell") ? `would ${row.action}` : row.action;
  // THE NAME FIRST, THE ID BESIDE IT. An autonomous Trencher symbol is
  // address-derived, `T` plus eleven hex of the contract, so a head built
  // from it alone reads "hold T7631DACC21B" and tells a reader nothing
  // about what was traded. The id stays because it is what everything
  // prices, routes and settles against, and because two coins may call
  // themselves the same thing on the same day.
  //
  // Absent name, absent parenthesis: never a placeholder. And never the
  // name alone, because dropping the id would make the feed the one
  // surface that cannot be reconciled against the ledger.
  const shown = nameOf(row);
  const named = shown ? `${shown} (${row.symbol})` : row.symbol;
  return [verb, named, size].filter(Boolean).join(" ");
}

/** The coin's name, or null when there is none worth printing beside the id. */
function nameOf(row: ThesisRow): string | null {
  const name = (row.display_name ?? "").trim();
  return name && name !== row.symbol ? name : null;
}

/**
 * THE SHAPE OF AN ID THAT NEEDS A NAME BESIDE IT: `T` plus the last eleven hex
 * of the contract, exactly as trencher-discovery.ts mints it.
 *
 * Only these are ever looked up for a name another row carried. A stock's name
 * IS its ticker (coin-name.ts never names one), so looking one up would cost a
 * scan to find nothing — or, worse, find a stray and rename TSLA.
 */
export const DERIVED_ID = /^T[0-9A-F]{11}$/;

/**
 * THE HEAD A READER SEES: the name, with the id left to a tooltip.
 *
 * `head` keeps "JUGGERNAUT (T3139F043B88)" because /why and the peer files are
 * where the post is reconciled against the ledger, and the id is the only key
 * that survives two coins calling themselves the same thing. A feed row is not
 * that place. Built here, beside `headOf`, because it undoes exactly the one
 * thing `headOf` adds and must not drift from it.
 */
export function readerHead(t: Pick<PublicThesis, "head" | "symbol" | "displayName">): string {
  if (!t.displayName || !t.symbol) return t.head;
  const name = t.displayName;
  // A FUNCTION, NEVER THE NAME AS THE REPLACEMENT STRING. `replace` expands
  // `$$`, `$&`, `` $` `` and `$'` in a string replacement, and the name is
  // whatever a deployer typed: "$$CASH" printed "$CASH", and "A$`B" spliced
  // the head into itself. A function's return value is inserted as it is.
  return t.head.replace(`${name} (${t.symbol})`, () => name);
}

/**
 * A FIGURE OF THE BOOK IN OUR OWN SENTENCE — the backstop for rows already
 * written.
 *
 * `renderWhy`'s public register now carries no size, cost, proceeds, cash or
 * floor (reasons.ts), because the sentence is written before anybody knows
 * whose book will read it back. The rows written before that change still say
 * "selling all 4.40 USDG of it against the 5.00 paid" — the realized P&L a
 * private book withholds — and they stay readable for a day on the feed and a
 * month on a profile. So a PRIVATE book's STRATEGY reason loses its figures
 * here.
 *
 * THIS IS THE ONE PLACE THIS MODULE REWRITES RATHER THAN DROPS, and the reason
 * is the one the address backstop gives for dropping: redaction is safe only
 * when the string is understood. A strategy reason is not prose — it is one of
 * a closed set of templates we wrote, and each rule below turns one old
 * public sentence into exactly the sentence `renderWhy(w, "public")` now
 * writes for the same `Why` (private-book.test.ts replays the old register
 * through it). Anything with a figure left afterwards — an older wording, or
 * a template nobody listed — loses the reason, not the figure: that is a
 * sentence we did NOT understand, and it fails closed. A model's reason is
 * never touched here: it is prose, and none of these rules could claim to
 * understand it.
 *
 * `AMT` is exactly what reasons.ts `usdg()` prints.
 */
const AMT = String.raw`-?\d[\d,]*\.\d{2}`;
const BOOK_FIGURE = /\d\s*USDG\b/;
const ANY_FIGURE = /\d\s*USDG\b|\d[\d,]*\.\d{2}\b/;
const LEGACY_FIGURES: readonly (readonly [RegExp, string])[] = [
  [new RegExp(`^the schedule says buy — ${AMT} USDG into `), "the schedule says buy — cash into "],
  [new RegExp(`^parking ${AMT} USDG of the cash idle above the ${AMT} floor — `), "parking some of the cash idle above the floor — "],
  [new RegExp(`^${AMT} USDG idle above the ${AMT} floor — `), "cash idle above the floor — "],
  [new RegExp(`, not a fault: I buy ${AMT} USDG a tick, so a small cap is gone quickly\\. `), ", not a fault. "],
  [new RegExp(`^nothing bought — ${AMT} USDG on hand and one buy costs ${AMT}`), "nothing bought — the cash on hand is short of one buy"],
  [new RegExp(`\\. There is ${AMT} USDG in the vault I can pull back`), ". There is cash in the vault I can pull back"],
  [new RegExp(` — selling all ${AMT} USDG of it against the ${AMT} paid`), " — selling all of it"],
  [new RegExp(`, so putting ${AMT} USDG into (\\S+) — `), ", so buying $1 — "],
  [new RegExp(` — pulling ${AMT} USDG back from the vault `), " — pulling some back from the vault "],
  [new RegExp(`laying down an equal-weight entry, ${AMT} USDG into each of `), "laying down an equal-weight entry into each of "],
  [new RegExp(`^(\\S+) is ${AMT} USDG (over|under) its equal weight — `), "$1 is $2 its equal weight — "],
  [new RegExp(`^taking ${AMT} USDG of (\\S+) — `), "buying into $1 — "],
  [new RegExp(`^out of (\\S+) with ${AMT} USDG — `), "out of $1 — "],
  // dip, trench-enter and gap-enter, after the vault sentence above has
  // taken the one "N USDG in the vault" that is not a buy.
  [new RegExp(`${AMT} USDG in(?= at the close print$| — |$)`), "buying in"],
];

/** The reason as a private book may publish it, or null when a figure could not be taken out. */
export function withoutBookFigures(reason: string): string | null {
  if (!BOOK_FIGURE.test(reason)) return reason;
  let s = reason;
  for (const [was, now] of LEGACY_FIGURES) s = s.replace(was, now);
  return ANY_FIGURE.test(s) ? null : s;
}

/** Known operational templates, not a classifier of market sentiment. */
function operationalNotice(text: string): boolean {
  return /^(?:no decision\s*\(|(?:error|failed|refused|unavailable)\s*:|(?:strategist|brain|model|provider|driver|rpc) (?:call )?(?:failed|error|unavailable)\b|nothing bought\s*[—–-]|nothing in your basket\b|(?:there (?:was|is) )?nothing held to sell\b|(?:i |we )?(?:cannot|can't|unable to) (?:sell|trade|submit)\b|couldn't submit\b)/i.test(text.trim());
}

/**
 * A row, turned into a post — or null, meaning it may not be published.
 *
 * Order matters: identity first, then source, then content. Each gate is
 * independent, so loosening the SQL later cannot loosen this.
 */
export function publishableThesis(row: ThesisRow): PublicThesis | null {
  // ── identity ──────────────────────────────────────────────────────────────
  // The brokerage rail's agent id embeds a real account number. It is excluded
  // here as well as in the SQL, because one of the two will be edited someday.
  if (row.agent_id && row.agent_id.toLowerCase().startsWith("rh:")) return null;
  const name = (row.name ?? "").trim();
  if (!name) return null;

  // ── source ────────────────────────────────────────────────────────────────
  const policy = row.source ? SOURCE_POLICY[row.source] : undefined;
  if (!policy) return null;
  if (row.hold_kind && PRIVATE_HOLD_KINDS.has(row.hold_kind)) return null;

  // Strictly `=== true`, the same test the dollars take below: a settings blob
  // is JSON, and a stray "true" string or a 1 is not the owner deciding to
  // publish their book.
  const bookPublic = row.public_book === true;

  // ── content ───────────────────────────────────────────────────────────────
  let reason: string | null = null;
  if (row.reason && row.reason.trim()) {
    reason = policy === "model" ? clip(row.reason) : row.reason.trim();
  }
  // OUR SENTENCE, WITHOUT THE BOOK'S FIGURES, for a book that keeps them —
  // see `withoutBookFigures`. A public book's sentence is its owner's choice.
  if (reason && policy === "strategy" && !bookPublic) reason = withoutBookFigures(reason);

  /**
   * THE AGENT'S OWN WORDS, IN THEIR OWN FIELD — and never in `reason`.
   *
   * A social post is MODEL PROSE and has to be treated as such: capped, address
   * scanned, dropped rather than trimmed. `reason` cannot hold it, because the
   * cap above is applied only when `policy === "model"` and a class post rides a
   * `strategy` source — so putting it there would publish model output UNCAPPED
   * and unscanned, and would destroy the thing `reasons.ts` built, which is that
   * for a strategy source every published word was written by us in advance.
   *
   * Two fields, two trust levels, one row. The deterministic sentence stays
   * exactly what it was; the post is additional and separately refusable, so a
   * post that fails this gate costs the agent its voice on that trade and
   * nothing else — the trade is still published, with our words.
   *
   * CAPPED AT REASON_MAX, the same ceiling, because both land on the same
   * surfaces and a post cut mid-word reads as a broken product wherever it
   * appears.
   */
  let post: string | null = null;
  if (row.post && row.post.trim()) {
    const body = clip(row.post);
    // The address backstop applies to it independently. It is the same rule as
    // below and it is repeated here rather than deferred, because a post that
    // names an address must cost the POST and not the whole thesis: the trade
    // and our own sentence about it are still safe to publish.
    post = ADDRESSY.test(body) || operationalNotice(body) ? null : body;
  }
  // A dropped order's classified error is useful in the owner's ledger, but
  // cannot stand in for an investment view. Keep substantive reasoning even
  // when execution failed; its honest outcome is attached below.
  if (reason && operationalNotice(reason)) reason = null;
  if (!reason && !post) return null;

  // ── shadow ────────────────────────────────────────────────────────────────
  // Resolved before the outcome chain, because every arm of that chain assumes
  // the decision was at least ALLOWED to become a trade, and this one was not.
  const shadow = IS_SHADOW.has(row.source!);

  // A shadow decision that carries a wall verdict or a trade status is a
  // CONTRADICTION, not a post: either the disconnection failed, or a source was
  // added to SHADOW_SOURCES that does reach the executor. Both are bugs, and
  // neither is disclosed on a public feed — the row is dropped and the
  // disconnection test is the thing that should have caught it.
  if (shadow && (row.status || row.dropped_rule || row.reject_rule)) return null;

  /**
   * A BRAIN REFUSAL IS THE OWNER'S FACT, NOT A POST.
   *
   * "no decision (refused): portfolio-quality-insufficient: core reports
   * performance unmeasurable: contributions unknown" was live on the public
   * feed. brain-shadow.ts writes that row with dropped_rule `brain-<kind>`
   * when the Brain's gate refuses to size a book whose accounting is not
   * evidenced — and it ALREADY writes the same fact to the owner's event log,
   * which is where a sentence about their deposits belongs. The post was the
   * excess: a stranger reads it as the agent being broken, and the owner reads
   * it twice. A brain-shadow copy is already dropped by the contradiction rule
   * above; this closes the same door for the live-enrolled source.
   */
  if ((row.dropped_rule ?? "").startsWith("brain-")) return null;

  const head = headOf(row, shadow, bookPublic);

  // DECIDED, versus FAILED TO HAPPEN.
  //
  // Resolved here rather than inside outcomeOf, which sees only the status pair
  // and therefore cannot tell a view from a buy whose trade has not landed yet
  // — both arrive as status null. The distinguishing facts are action and
  // symbol, and only this function has them.
  //
  // Both guards require a null status. A hold that somehow joined a trade row
  // is a contradiction worth surfacing rather than hiding, so it falls through
  // and reports what actually happened.
  const isView = !row.action && !row.symbol && !row.dropped_rule && !row.status;
  const isHold = row.action === "hold" && !row.status;
  const { outcome, text } = shadow
    ? row.action === "hold" || !row.action
      ? // A shadow hold and a live hold are the same event — nothing happened,
        // on purpose — so it keeps the sentence a reader already understands.
        ({ outcome: "shadow", text: "held — no trade, by choice" } as const)
      : ({ outcome: "shadow", text: "a stated intention — not traded" } as const)
    : isView
      ? ({ outcome: "view", text: "a view, no trade" } as const)
      : isHold
        ? ({ outcome: "view", text: "held — no trade, by choice" } as const)
        : row.dropped_rule && !row.status
          ? ({ outcome: "dropped", text: "dropped before it reached the wall" } as const)
          : outcomeOf(row.status, row.reject_rule);

  /**
   * A CLASS POST IS ABOUT A TRADE THAT HAPPENED, or it is not a post.
   *
   * Every other source publishes its refusals, and for the strategist that is
   * right: "I wanted to buy X because Y, and the wall said no" is the model's
   * actual thesis with an honest outcome on it. The class route is different in
   * a way that matters for a feed. Its reason is OUR deterministic sentence, its
   * entries are re-proposed with a fresh decision row every tick for as long as
   * the candidate qualifies, and the evidence in that sentence moves a little
   * each tick — so a persistently refused entry does not collapse under the
   * feed's GROUP BY into one row with a count. It becomes twenty-seven nearly
   * identical posts saying "taking 5.00 USDG of X" beside a badge saying it did
   * not. That is refusal spam in the agent's own voice, and a trading desk does
   * not post every order the risk desk bounced.
   *
   * The decision row is untouched — it is still in the ledger, still auditable,
   * still what /why reads. It just is not social content. `postableStatus` in
   * social-post.ts draws the same line for the writer, one layer earlier.
   */
  if (TRADED_ONLY.has(row.source ?? "") && outcome !== "landed") return null;

  /**
   * CASH MANAGEMENT THAT DID NOT HAPPEN IS NOT A POST EITHER.
   *
   * "vault-deposit 0.00 USDG — 0.00 USDG idle above the 50.00 floor" was live:
   * a sub-cent park the wall refused, published with the refusal badge. A vault
   * move is plumbing, not a view; when it lands the owner may reasonably see it,
   * and when it does not there is nothing to say. Same shape as the class-route
   * rule above, keyed on the action because these rows ride strategy sources.
   */
  if (IS_CASH.has(row.action ?? "") && outcome !== "landed") return null;

  /**
   * A LIMIT ON THE ACCOUNT IS NOT A VIEW ABOUT THE MARKET.
   *
   * "Robin tried to buy TSLA · past today's number of trades" was on the feed
   * once a tick, all day. A deterministic strategy re-proposes its legs on a
   * schedule, so once the account's own trade count, money or arming stops it,
   * every tick writes a fresh decision the wall refuses for the same reason —
   * true each time, and about nothing a stranger can read as a thesis. It says
   * the agent is stuck, in public, in the agent's name.
   *
   * THE OWNER'S FACT, and they still get it: the event log is told once per
   * change (owner-refusal.ts, and the live-blocker line for the arming rules),
   * the trade row keeps its `reject_rule` for their desk and the wall tape, and
   * the decision stays in the ledger. Only the post goes.
   *
   * STRATEGY SOURCES ONLY. A model's refused thesis is still its view — "I
   * wanted X because Y, and the wall said no" — and the TRADED_ONLY rule above
   * says so. And only these rules: a refusal about the TRADE (an asset the key
   * does not cover, a price that moved, a curve that graduated) says something
   * true about the market and keeps publishing.
   */
  if (
    outcome === "refused" &&
    (row.source ?? "").startsWith("strategy:") &&
    IS_ACCOUNT_STATE.has(row.reject_rule ?? "")
  ) {
    return null;
  }
  // And a HALT rule from any source, the model's included: see
  // ACCOUNT_HALT_RULES for why the breaker is not a view about the coin.
  if (outcome === "refused" && IS_ACCOUNT_HALT.has(row.reject_rule ?? "")) return null;

  const handle = (row.x_handle ?? "").trim() || null;

  // ── the backstop ──────────────────────────────────────────────────────────
  // Last, and over everything that will be rendered — including the name and
  // the handle, which are user-typed. A strategy reason cannot contain an
  // address by construction; this exists so the guarantee does not depend on
  // that staying true.
  const displayName = nameOf(row);
  for (const s of [name, handle, head, reason, text, row.symbol ?? null, row.slug ?? null, displayName]) {
    if (s && ADDRESSY.test(s)) return null;
  }

  const action =
    row.action === "buy" || row.action === "sell" || row.action === "hold" ? row.action : null;
  const symbol = (row.symbol ?? "").trim() || null;

  // Shape-checked rather than trusted. A malformed slug renders as null — the
  // post loses its link and keeps its words — because a slug is not a
  // disclosure risk the way a reason is, so dropping the whole post over one
  // would trade a real loss for an imaginary one.
  const slug = typeof row.slug === "string" && SLUG_SHAPE.test(row.slug) ? row.slug : null;

  // ── the call's own figures ────────────────────────────────────────────────
  // Only a trade that FILLED paid or booked anything: a refusal, a revert or a
  // pending buy has no entry and no result, whatever columns rode along.
  const filled = outcome === "landed";
  const entryPriceUsd = filled && action === "buy" ? positive(row.entry_price_usd) : null;
  // A sell's return is its booked P&L over the cost it closed, and the cost is
  // what it received minus what it booked. A cost of zero or less is not a
  // cost, so it measures nothing. Percent first and divided last, so +1.5 on 5
  // is exactly 30 rather than 30.000000000000004.
  const pnl = filled && action === "sell" ? figure(row.realized_pnl_usdg) : null;
  const proceeds = positive(row.closed_cash_usdg);
  const cost = pnl !== null && proceeds !== null ? proceeds - pnl : null;
  const realizedPct = pnl !== null && cost !== null && cost > 0 ? (pnl * 100) / cost : null;
  // DOLLARS ARE OPT-IN — the P&L and, for the reason on `sizeUsdg`, the size.
  const realizedUsd = realizedPct !== null && bookPublic ? pnl : null;

  return {
    name,
    slug,
    handle,
    head,
    action,
    symbol,
    displayName,
    paper: row.mode === "paper",
    sizeUsdg:
      bookPublic && typeof row.size_usdg === "number" && Number.isFinite(row.size_usdg) ? row.size_usdg : null,
    outcome,
    outcomeText: text,
    shadow,
    reason,
    post,
    said: Math.max(1, Number(row.said ?? 1)),
    at: Number(row.last_at ?? 0),
    firstAt: Number(row.first_at ?? row.last_at ?? 0),
    entryPriceUsd,
    realizedPct,
    realizedUsd,
    markUsd: positive(row.mark_usd),
    mcapUsd: positive(row.mcap_usd),
  };
}

/**
 * A figure as a reader handed it, or null for anything that is not one.
 *
 * node-postgres returns some aggregates as strings, and "3.1" is a read, not an
 * absence. Everything else that is not a finite number — null, undefined, "",
 * NaN, Infinity — is UNREAD and stays null, never 0.
 */
function figure(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** A price or a size: a figure, and above zero, or nothing. */
function positive(v: unknown): number | null {
  const n = figure(v);
  return n !== null && n > 0 ? n : null;
}
