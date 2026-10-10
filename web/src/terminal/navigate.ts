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

/** Enter a screen in place, or reveal an anchor on the screen already showing. */
export function goTo(path: string): void {
  if (typeof window === "undefined") return;
  const previous = new URL(window.location.href);
  const next = new URL(path, previous);
  // Keep Next's patched history method: it carries the current router tree
  // into this entry so Back/Forward can restore the screen without a reload.
  if (next.href !== previous.href) window.history.pushState(null, "", path);
  if (next.pathname === previous.pathname && next.hash) {
    // pushState does not emit hashchange. Settings listens for it to open the
    // target's collapsed group and scroll into view; usePathname cannot notice
    // a same-screen anchor. Re-clicking an anchor reveals it again without
    // creating another history entry. New screens reveal after they mount.
    window.dispatchEvent(new window.HashChangeEvent("hashchange", { oldURL: previous.href, newURL: next.href }));
  }
}
