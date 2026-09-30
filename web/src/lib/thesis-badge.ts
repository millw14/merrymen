/**
 * What kind of post this is, in the agent's voice.
 *
 * PAST TENSE THROUGHOUT, and this is not a style preference. The reader is not
 * the one trading — the entire product is that something else does it — so a
 * present-tense "Buy" would read as an offer the page cannot honour. The
 * reference this design borrows from can say "Buy" because you can buy. Here
 * you cannot; your agent can.
 *
 * Every word below was argued for once already. Do not change one of them
 * without a reason better than "shorter".
 */
import { IN_FLIGHT_TEXT } from "@merrymen/thesis";
import type { PublicThesis } from "@/lib/thesis";

export type BadgeKind = "bought" | "sold" | "thesis" | "turned" | "quiet";

export interface Badge {
  label: string;
  kind: BadgeKind;
}

/**
 * THE THREE FIELDS THE BADGE IS COMPUTED FROM, named so a second surface can
 * reuse the rule instead of re-deriving it.
 *
 * The agent desk had its own copy — `latest.action === "buy" ? "Bought" : "Sold"`
 * — which consulted no outcome at all, so a refused buy read "Bought · 2h ago"
 * on the one screen its owner looks at most. That is the tester's original
 * complaint ("in the feed it says I've bought things but nothing shows in my
 * portfolio") surviving one screen over from where it was fixed, because the
 * fix lived in a function the desk could not call: it took a full
 * `PublicThesis`, and the desk holds the terminal's leaner `Thesis`.
 *
 * Widening the input is what makes the rule shared rather than copied. Every
 * existing caller still satisfies it — this only stops the type from being the
 * reason somebody writes the fourth version of this conditional.
 */
export interface BadgeInput {
  action: PublicThesis["action"];
  outcome?: PublicThesis["outcome"] | null;
  shadow?: boolean | null;
  /**
   * The publisher's sentence for the outcome — which is how a "pending" order in
   * flight is told from a "pending" decision nothing was ever sent for. See
   * `inFlightOf`.
   */
  outcomeText?: string | null;
}

/**
 * AN ORDER ON ITS WAY, as opposed to a decision that came to nothing.
 *
 * The publisher files two facts under "pending" (thesis-policy.ts
 * `outcomeOf`): a submitted trade, whose sentence is IN_FLIGHT_TEXT, and a buy
 * or sell decision with no trade at all — "no trade came of it", usually for
 * good. Read as one, the second said "buying" on the card and the rail, in
 * the money colour with the unsettled edge, about an order that was never
 * sent. The feed rows already tell them apart this way (beat.ts `inFlight`).
 *
 * NO SENTENCE AT ALL is taken at its word, which is the owner's own desk tape:
 * every row there is a trade, and a pending one was sent. A public post always
 * carries its sentence.
 */
export function inFlightOf(t: Pick<BadgeInput, "outcome" | "outcomeText">): boolean {
  return t.outcome === "pending" && (t.outcomeText == null || t.outcomeText === IN_FLIGHT_TEXT);
}

export function badgeOf(t: BadgeInput): Badge {
  // SHADOW IS CHECKED FIRST, and the ordering is the whole safety property.
  //
  // A shadow decision arrives as a buy with a size and no status, which every
  // test below reads as "a buy that has not landed yet" — and the buy arm turns
  // that into the word "BUYING". Brain has no path to the executor at all, so
  // that badge would be an agent announcing a trade it cannot make, in its own
  // voice, on a page anybody can read.
  //
  // The conditional is already in `t.head` ("would buy TSLA 5.00 USDG"), which
  // is what the non-React surfaces render. This is the same claim, in the one
  // place a reader looks first.
  if (t.shadow) {
    if (t.action === "buy") return { label: "would buy", kind: "thesis" };
    if (t.action === "sell") return { label: "would sell", kind: "thesis" };
    return { label: "thesis", kind: "thesis" };
  }
  if (t.outcome === "refused" || t.outcome === "reverted") {
    return { label: "turned back", kind: "turned" };
  }
  if (t.outcome === "dropped") return { label: "thought better of it", kind: "quiet" };
  // No name attached, or an explicit hold: it is talking about the book, not
  // about one position. "view" is the outcome a researched hold produces.
  if (!t.action || t.action === "hold" || t.outcome === "view") {
    return { label: "thesis", kind: "thesis" };
  }
  // A decision nothing was sent for is not "buying": it tried, and it is over.
  if (t.outcome === "pending" && !inFlightOf(t)) {
    return { label: t.action === "sell" ? "tried to sell" : "tried to buy", kind: "quiet" };
  }
  if (t.action === "buy") {
    return { label: t.outcome === "landed" ? "bought" : "buying", kind: "bought" };
  }
  return { label: t.outcome === "landed" ? "sold" : "selling", kind: "sold" };
}

/**
 * Does this post carry a trade at all?
 *
 * A thesis has no trade strip — its words ARE the post — and that is the single
 * biggest visual difference between the two kinds of card.
 */
export function hasTrade(t: PublicThesis): boolean {
  // A SHADOW POST KEEPS ITS STRIP, even though its badge is a thesis badge.
  //
  // The first cut hid it, on the reasoning that a thesis's words are the post.
  // That is backwards here: the strip is where `outcomeText` renders, and for a
  // shadow post that text is the disclaimer — "a stated intention — not
  // traded". Hiding the strip left a card reading "would buy" with no name, no
  // size, and nothing at all saying the trade did not happen. The qualifier
  // belongs beside the number it qualifies, not in a caption somewhere else.
  if (t.shadow) return t.symbol !== null || t.sizeUsdg !== null;
  return badgeOf(t).kind !== "thesis" && (t.symbol !== null || t.sizeUsdg !== null);
}
