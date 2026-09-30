/**
 * LANDING ON "RE-SIGN THIS KEY" FROM A LINK.
 *
 * Every re-sign button points at `/grant#resign`: the dashboard's banner
 * (App.tsx `resignHref`), the agent screen, and the Telegram "Sign now" button
 * the worker sends when an update or an expiry needs a new signature. The
 * browser's own jump to `#resign` happens once, as the page first paints — and
 * the section is not there yet. It renders only after the grant has loaded
 * (from this browser or from `/api/grants`), so the jump found nothing and the
 * owner landed at the top of a long page, on "fund your account", with the one
 * control they were sent for somewhere below.
 *
 * So the page makes the jump itself, ONCE, the first time the section exists.
 * Once, because a later re-render (a balance refresh, a caps edit) must never
 * yank an owner who has scrolled away back up to it.
 */

export const RESIGN_ANCHOR = "resign";

/** Fired by a completed sign-in, so a screen that loaded signed-out can load again. */
export const SIGNED_IN_EVENT = "merrymen:signed-in";

/** Should the page scroll to the re-sign section now? */
export function shouldJumpToResign(hash: string, alreadyJumped: boolean, sectionPresent: boolean): boolean {
  return !alreadyJumped && sectionPresent && hash.replace(/^#/, "") === RESIGN_ANCHOR;
}

/** sessionStorage key holding when the grant page last reloaded for a sign-in. */
export const SIGNED_IN_RELOAD_KEY = "merrymen.grant.signinReloadAt";
/** At most one such reload in this window. */
export const SIGNED_IN_RELOAD_GAP_MS = 60_000;

/**
 * Should the grant page reload after a sign-in?
 *
 * Only when it has no agent to show — a page already showing one has nothing
 * to gain — and never twice in a minute. That second rule is the loop guard:
 * Privy finishes a sign-in by itself on mount when its own login survives but
 * our session cookie did not, which is exactly what a browser that drops the
 * cookie produces. Reload → no cookie → automatic sign-in → reload, for ever.
 * `lastAt` is null when storage is unreadable; then the answer is no, since a
 * guard that cannot remember cannot stop a loop.
 */
export function shouldReloadAfterSignIn(hasGrant: boolean, lastAt: number | null, now: number): boolean {
  if (hasGrant || lastAt === null) return false;
  return now - lastAt >= SIGNED_IN_RELOAD_GAP_MS;
}

/** Tell any listening screen that the owner just signed in. Browser-only; a no-op elsewhere. */
export function announceSignedIn(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SIGNED_IN_EVENT));
}
