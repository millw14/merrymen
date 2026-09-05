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
  size_usdg?: number | null;
  reason?: string | null;
  dropped_rule?: string | null;
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
  /** How many times this exact thesis was said in the window. */
  said: number;
  /** Epoch seconds. Formatted by the page, so this module stays pure. */
  at: number;
  firstAt: number;
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
] as const;

/** How much of a row each source is trusted for. Absent key ⇒ publish nothing. */
const SOURCE_POLICY: Readonly<Record<string, "strategy" | "model">> = Object.freeze({
  // The model's own words. Capped and address-checked before they are shown.
  strategist: "model",
  // Brain, running in shadow. Its words are a model's words and are treated as
  // such; what makes it different is not the trust level but the TENSE — see
  // SHADOW_SOURCES.
  "brain-shadow": "model",
  ...Object.fromEntries(PUBLISHABLE_STRATEGIES.map((s) => [`strategy:${s}`, "strategy" as const])),
  // NOT here, and each for its own reason:
  //   chat     — carries a counterparty address by template
  //   selftest — a dust probe, not a market view; it says so itself
  //   strategy:<a tenant's own file> — a string we did not write
});

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
 * Every source a reader may put in a `WHERE source IN (…)`.
 *
 * Exported so the two SQL callers derive their list from the policy instead of
 * keeping their own copy of it. The SQL narrowing is an OPTIMISATION and this
 * module is the rule — but a hand-maintained second list is how the optimisation
 * silently becomes the rule for anything the policy later admits.
 */
export const PUBLISHABLE_SOURCES: readonly string[] = Object.freeze(Object.keys(SOURCE_POLICY));

/**
 * Anything that looks like an on-chain identifier.
 *
 * `rh:` is included because the brokerage rail's agent id embeds an account
 * number, and a reason that quoted one would publish it.
 */
const ADDRESSY = /\b(?:0x[0-9a-fA-F]{6,}|rh:[A-Za-z0-9-]{1,64})\b/;

/** Matches the `/why` truncation point, so no surface cuts one mid-word. */
const REASON_MAX = 220;

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
});

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

/** What the wall said, from the slug alone — the detail is never selected. */
export function outcomeOf(
  status: string | null | undefined,
  rejectRule: string | null | undefined,
): { outcome: PublicThesis["outcome"]; text: string } {
  if (status === "landed") return { outcome: "landed", text: "landed" };
  if (status === "paper") return { outcome: "landed", text: "filled on paper" };
  if (status === "reverted") return { outcome: "reverted", text: "reverted on-chain" };
  if (status === "submitted") return { outcome: "pending", text: "sent, waiting on the chain" };
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
function headOf(row: ThesisRow, shadow: boolean): string {
  const size =
    typeof row.size_usdg === "number" && Number.isFinite(row.size_usdg)
      ? `${row.size_usdg.toFixed(2)} USDG`
      : null;
  // A hold is already the conditional's answer — "would hold" is not English an
  // agent would speak, and there is nothing to disclaim.
  const verb =
    shadow && (row.action === "buy" || row.action === "sell") ? `would ${row.action}` : row.action;
  return [verb, row.symbol, size].filter(Boolean).join(" ");
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

  // ── content ───────────────────────────────────────────────────────────────
  let reason: string | null = null;
  if (row.reason && row.reason.trim()) {
    // The model may omit the field, which arrives as "" rather than null. That
    // is expected, not exceptional: the post renders with its head and no
    // reasoning line, exactly as /why degrades.
    reason = policy === "model" ? row.reason.trim().slice(0, REASON_MAX) : row.reason.trim();
  } else if (row.dropped_rule) {
    reason = classifyDrop(row.dropped_rule);
  }

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

  const head = headOf(row, shadow);

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

  // A post with neither a head nor a reason says nothing at all.
  if (!head && !reason) return null;

  const handle = (row.x_handle ?? "").trim() || null;

  // ── the backstop ──────────────────────────────────────────────────────────
  // Last, and over everything that will be rendered — including the name and
  // the handle, which are user-typed. A strategy reason cannot contain an
  // address by construction; this exists so the guarantee does not depend on
  // that staying true.
  for (const s of [name, handle, head, reason, text, row.symbol ?? null, row.slug ?? null]) {
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

  return {
    name,
    slug,
    handle,
    head,
    action,
    symbol,
    paper: row.mode === "paper",
    sizeUsdg:
      typeof row.size_usdg === "number" && Number.isFinite(row.size_usdg) ? row.size_usdg : null,
    outcome,
    outcomeText: text,
    shadow,
    reason,
    said: Math.max(1, Number(row.said ?? 1)),
    at: Number(row.last_at ?? 0),
    firstAt: Number(row.first_at ?? row.last_at ?? 0),
  };
}
