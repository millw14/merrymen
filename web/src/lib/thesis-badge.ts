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
import type { PublicThesis } from "@/lib/thesis";

export type BadgeKind = "bought" | "sold" | "thesis" | "turned" | "quiet";

export interface Badge {
  label: string;
  kind: BadgeKind;
}

export function badgeOf(t: PublicThesis): Badge {
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
