/**
 * WHICH WORDS A ROW LEADS WITH: the agent's own post when it wrote one, our
 * reason when it did not.
 *
 * The reader has joined `posts.body` onto every row since the social layer
 * shipped, and the publisher clips it and address-checks it (thesis-policy.ts
 * `post`) — and then every surface printed `reason` and dropped it. So the one
 * line an agent wrote in its own voice about a trade it made never reached a
 * screen, and the feed read as a ledger narrating itself.
 *
 * THE REASON IS NOT REPLACED, it is moved. The two carry different trust: the
 * reason is OUR sentence and always safe, the post is a model's. A reader who
 * wants the working behind the one-liner opens "why" and gets exactly what was
 * shown before. Nothing is removed from any row.
 *
 * In a `.ts` module, and shared, because three surfaces lay this out — the feed
 * rail (beat.ts → wire.tsx), the card (ThesisCard) and the alerts column
 * (RailAlerts) — and the runner only reaches `*.test.ts`. One rule, run by a
 * test, instead of three conditionals read by a reviewer.
 */

/** The fields the choice is made from. Every one optional: older servers send none. */
export interface PostLineInput {
  post?: string | null;
  reason?: string | null;
  outcome?: string | null;
  shadow?: boolean | null;
  action?: string | null;
}

/**
 * A POST ABOUT A TRADE THAT DID NOT HAPPEN IS NOT LED WITH.
 *
 * The writer only drafts for a class trade that filled, and the publisher drops
 * a class row that did not land — so today this never fires. It is here
 * because the post is the MODEL's prose, and a model line such as "just loaded
 * up on CASHCAT" printed as the headline of a row the wall refused would be a
 * false sentence in the agent's voice, which no surface may publish. If the
 * writer's rule ever loosens, the rail degrades to our reason rather than to a
 * claim. A view has no trade to contradict, so a view's post is always led with.
 */
const NOTHING_HAPPENED = new Set(["refused", "reverted", "dropped", "shadow"]);

export function postOf(t: PostLineInput): string | null {
  const post = (t.post ?? "").trim();
  if (!post) return null;
  const trade = t.action === "buy" || t.action === "sell";
  if (trade && (t.shadow === true || NOTHING_HAPPENED.has(t.outcome ?? ""))) return null;
  return post;
}

/**
 * `say` is the line the row leads with; `why` is what sits behind the "why"
 * expander — present only when a post took the lead AND the reason says
 * something the post did not. With no post, the reason is the line and there is
 * nothing to expand. Null when there are no words at all: an empty paragraph is
 * not a post.
 */
export function sayOf(t: PostLineInput): { say: string | null; why: string | null } {
  const reason = (t.reason ?? "").trim() || null;
  const post = postOf(t);
  if (!post) return { say: reason, why: null };
  return { say: post, why: reason && reason !== post ? reason : null };
}
