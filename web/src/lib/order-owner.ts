/**
 * THE OWNER WHO CONFIRMED, HELD AGAINST THE SESSION THAT SENT THE REQUEST.
 *
 * A browser sends the session it holds when a request LEAVES, not the one it
 * held when the owner tapped. A chat card's order can leave well after the tap
 * — a snipe places its order only once its lookup answers — and another tab can
 * sign a different wallet in, changing this browser's cookie without the tab
 * that tapped ever knowing. So the card names the owner who tapped (`owner` in
 * the body, from chat-controller.ts ConfirmScope.owner), and a route that acts
 * for the chat refuses a session that is not that owner's, rather than act for
 * whoever happens to be signed in now.
 *
 * A body that names nobody is a card from before this, or a self-hosted one,
 * and is judged as it always was: by its session alone. Hosted only — a
 * self-hosted box has one operator and no sign-in to hold a claim against.
 */

/** What the route answers, and so what the owner who tapped reads in the chat. */
export const OWNER_CHANGED =
  "this browser is signed in with a different wallet now than the one that confirmed this, so nothing was placed. Sign back in with that wallet and ask again.";

/** The same refusal for a card that changes a setting (PUT /api/settings): nothing was written. */
export const OWNER_CHANGED_SETTING =
  "this browser is signed in with a different wallet now than the one that confirmed this, so nothing was changed. Sign back in with that wallet and ask again.";

/**
 * The same refusal for the lookup after a placement whose answer was lost
 * (GET /api/orders?owner=): what is open under another wallet's session is
 * that wallet's, and is not read for this one. Not "nothing was placed" — the
 * placement it follows may have landed before the other wallet signed in.
 */
export const OWNER_CHANGED_LOOKUP =
  "this browser is signed in with a different wallet now than the one that confirmed this, so its open order was not read.";

/**
 * Does the owner a request names differ from the session that sent it? A claim
 * that is not a string, or a claim with no session to hold it against, is a
 * difference: nothing is done on a claim that cannot be checked.
 */
export function ownerMismatch(claimed: unknown, tenant: string | null): boolean {
  if (claimed === undefined || claimed === null) return false;
  return typeof claimed !== "string" || tenant === null || claimed.trim().toLowerCase() !== tenant.toLowerCase();
}
