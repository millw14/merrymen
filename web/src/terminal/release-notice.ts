/**
 * WHO A RELEASE NOTICE IS FOR, AND WHOSE ONE-SHOT IT MAY SPEND.
 *
 * ── THE SHOWING HALF ─────────────────────────────────────────────────────
 *
 * A notice about a trading mode is addressed to somebody who has an agent to
 * put into that mode. Shown to a visitor who has not made one, it is an
 * announcement about a feature of a thing they do not own, sitting directly
 * above the empty state whose whole job is to get them to make one. The desk
 * mounted it in exactly that branch.
 *
 * ── AND THE HALF THAT IS NOT MERELY NOISE ────────────────────────────────
 *
 * The notice also fires a DESKTOP NOTIFICATION, once ever, and records that it
 * has by writing a `:notified` flag. That write is the part worth being careful
 * about: a one-shot spent on somebody with no agent is not just a wasted
 * notification, it is the notification the real owner never gets. They create
 * an agent the next day, the flag already says "notified", and the release
 * they were meant to hear about passes in silence.
 *
 * So the gate has to sit in front of BOTH, and the notify arm cannot be
 * derived from the show arm — a dismissed notice must still not re-notify, and
 * a notice hidden for want of an agent must not notify either. They share one
 * precondition and are otherwise independent.
 *
 * Extracted from the component because the test runner globs `*.test.ts` and
 * nothing inside a `.tsx` is reachable from it. A rule about who gets
 * interrupted is not one to leave unexecutable.
 */

export interface ReleaseNoticeInput {
  /**
   * Does this reader have an agent?
   *
   * The caller decides what counts. The desk's `mine` is the fact the
   * surrounding branch is already predicated on; a shell-level caller should
   * prefer the server's `exists`, which does not go false while loading.
   */
  hasAgent: boolean;
  /** Has this reader already dismissed this release? */
  dismissed: boolean;
  /** Has the one-shot desktop notification for this release already been spent? */
  alreadyNotified: boolean;
  /** Is a desktop notification possible at all — API present and permission granted? */
  canNotify: boolean;
}

export interface ReleaseNoticeAction {
  /** Render the in-app notice. */
  show: boolean;
  /** Fire the desktop notification AND spend the one-shot. */
  notify: boolean;
}

export function releaseNotice(input: ReleaseNoticeInput): ReleaseNoticeAction {
  // ONE PRECONDITION IN FRONT OF BOTH. Not two independent checks, because the
  // expensive half to get wrong is the one that writes a flag.
  if (!input.hasAgent) return { show: false, notify: false };
  return {
    show: !input.dismissed,
    // INDEPENDENT OF `show`, deliberately. Dismissing the notice must not
    // re-arm the notification, and a reader who has already been notified must
    // still see the notice until they dismiss it.
    notify: input.canNotify && !input.alreadyNotified,
  };
}
