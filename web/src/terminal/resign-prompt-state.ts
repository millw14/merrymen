/**
 * WHAT THE OUT-OF-DATE-PERMISSION PROMPT SHOWS, AS A FUNCTION.
 *
 * Extracted from the component rather than left inside it, for the reason this
 * repo has already paid for once: the test runner globs `*.test.ts`, nothing
 * inside a `.tsx` is reachable from it, and a rule nobody can execute is a rule
 * that gets quietly broken. The conditions below decide whether a real owner is
 * interrupted about their money, so they are the part that must be executable.
 *
 * Four inputs, and each one has a third state that is not a `false`:
 *
 *   - `exists` is the SERVER's answer about whether there is an agent at all.
 *     `null` is "we have not asked yet" — distinct from "there is no agent",
 *     and collapsing the two is what makes a prompt flash on for an existing
 *     owner halfway through their first paint.
 *   - `grantedAt` is `null` when unread, never 0. A grant whose timestamp did
 *     not arrive is not a grant signed in 1970.
 *   - `canSign` says whether THIS browser holds a key that could act on the
 *     advice. Offering a signature to a browser that cannot make one sends the
 *     owner to a form asking for a secret they have never had.
 *   - `acknowledged` is `null` until the dismissal record has been read, so the
 *     dialog cannot flash open and immediately closed on a returning visitor.
 */

import { wallAgeOfGrant } from "@merrymen/core";

export type ResignPromptState =
  /** Say nothing. Either there is nothing to say, or we do not know yet. */
  | "hidden"
  /** First time this owner has met this wall release: interrupt, once. */
  | "dialog"
  /** They have seen it. A quiet line that stays while the permission is old. */
  | "strip";

export interface ResignPromptInput {
  /** The server's answer. `null` = unread. */
  exists: boolean | null;
  /** From the public grant, in seconds. `null` = unread. */
  grantedAt: number | null;
  /** Does this browser hold an owner key, or a usable Privy owner? */
  canSign: boolean;
  /** Has this owner already dismissed THIS wall release? `null` = unread. */
  acknowledged: boolean | null;
}

/**
 * Is the permission old enough to be worth an owner's attention?
 *
 * Separate from the render decision because two different surfaces need it:
 * whether to show anything at all, and whether the dismissal record is even
 * worth reading. It is also the half that is pure policy rather than UI.
 */
export function resignPromptApplies(input: Omit<ResignPromptInput, "acknowledged">): boolean {
  // THE SERVER'S YES, NOT THE ABSENCE OF A NO. `exists === true` is the only
  // arm that proceeds; `false` (no agent) and `null` (unread) both stop here.
  // An owner who has not created an agent has nothing to re-sign, and /grant
  // would meet them with a form asking for a key that does not exist for them.
  if (input.exists !== true) return false;
  // A browser that cannot sign cannot follow the advice.
  if (!input.canSign) return false;
  // "unknown" is not "stale". Only a grant we have actually read, and read as
  // older than the current wall, is one we may interrupt somebody about.
  return wallAgeOfGrant(input.grantedAt === null ? null : { grantedAt: input.grantedAt }) === "predates-change";
}

/**
 * The whole render decision.
 *
 * THE DIALOG IS ONCE; THE STRIP DOES NOT LEAVE. Proposals.tsx refuses a dismiss
 * button outright — "a banner somebody closed is a fact nobody ever acts on" —
 * and it is right about a condition the owner must act on before the agent
 * works. But a modal that returns every visit is one people learn to click
 * through, and a prompt nobody reads is the same silence in a louder costume.
 * So the interruption happens once per release and what remains is a quiet
 * line that stays as long as the permission is genuinely old.
 */
export function resignPromptState(input: ResignPromptInput): ResignPromptState {
  if (!resignPromptApplies(input)) return "hidden";
  // Not yet read. Showing the strip here would flash it and then replace it
  // with the dialog; showing the dialog would do the reverse for a returning
  // owner. Neither is worth guessing for the one frame it takes to read.
  if (input.acknowledged === null) return "hidden";
  return input.acknowledged ? "strip" : "dialog";
}
