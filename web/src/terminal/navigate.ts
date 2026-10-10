/**
 * MOVING BETWEEN SCREENS IS A URL CHANGE AND NOTHING ELSE.
 *
 * Every route under app/(app) renders the one <App/> from its layout and a page
 * that returns null; the screen is read back off the pathname (nav.ts). So a
 * click used to do far more work than it needed: `router.push` asked the
 * server for the next route — nineteen routes all marked force-dynamic with no
 * loading boundary, so nothing was prefetched — and the screen could not
 * change until that render came back. Tens of seconds in dev, a round trip in
 * production, for a tree the browser already had.
 *
 * `window.history.pushState` is the App Router's own escape hatch for this:
 * Next patches it to update the router's URL and `usePathname` with the tree
 * it already holds, and Back and Forward restore that same tree. No request,
 * no render, no wait. The one thing it does not do is run a route's
 * generateMetadata, so the tab title stays as it was until a full load.
 *
 * Only paths that resolve to the terminal go this way. Anything else — the
 * connect pages, the lookup, an external link — is a real navigation and
 * stays one.
 */

/** The routes app/(app) owns: every one renders the terminal. */
const SCREEN_PATHS = new Set([
  "/", "/home", "/feed", "/chat", "/agent", "/alpha", "/you", "/profile",
  "/search", "/create", "/settings", "/grant", "/limits", "/groupchat",
  "/deposit", "/withdraw", "/leaderboard", "/tokens",
]);

/** True for a path the terminal renders itself, so it can be entered in place. */
export function isScreenPath(href: string): boolean {
  // A same-origin path only: a full URL, a hash or a query is someone else's.
  if (!href.startsWith("/") || href.startsWith("//")) return false;
  const path = href.split(/[?#]/, 1)[0]!;
  if (SCREEN_PATHS.has(path)) return true;
  return path.startsWith("/t/") || path.startsWith("/a/");
}

/** Enter a screen in place. A no-op when it is the screen already showing. */
export function goTo(path: string): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname === path) return;
  window.history.pushState(null, "", path);
}
