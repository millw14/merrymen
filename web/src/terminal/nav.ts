/**
 * THE URL AND THE SCREEN, AS PURE FUNCTIONS.
 *
 * Lifted out of App.tsx so routing can be tested without mounting the terminal:
 * importing App drags in every screen, the Privy provider and a path alias
 * chain that only resolves inside Next, so the one part of navigation that is
 * plain data was the one part nothing could exercise.
 *
 * Both directions live here together on purpose — they are two halves of one
 * bijection, and a tab added to one and forgotten in the other produces a URL
 * that renders the wrong screen with nothing failing.
 */
import type { Screen, Tab } from "./live";

/**
 * THE BAR, IN ORDER, AND EVERY BUTTON HAS TO EARN ITS PLACE.
 *
 * The owner's brief was "make all buttons have a value not just another tab".
 * Board left because it answers the same question Home does and Home now
 * carries it; Alpha took the freed slot.
 *
 * FEED IS THE CENTRE, under the logo — which is where the logo already was.
 * `TabIcon` has rendered `<LogoMark/>` for the middle slot all along; it just
 * opened the agent chat. Putting the feed under the mark that is already there
 * is what "the LOGO tab is the main tab" means.
 *
 * The ids are NOT the labels. They are wired into TabIcon's exhaustive switch,
 * the record below, the `data-screen` attribute CSS selects on, and FirstVisit
 * — so `agent` stays `agent` while it reads "Chat".
 */
export const TABS: { id: Tab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "agent", label: "Chat" },
  { id: "feed", label: "Feed" },
  { id: "alpha", label: "Alpha" },
  { id: "you", label: "Profile" },
];

export function screenForPath(path: string): Screen {
  if (path.startsWith("/t/")) return { kind: "token", id: decodeURIComponent(path.slice(3)) };
  if (path.startsWith("/a/")) return { kind: "profile", slug: decodeURIComponent(path.slice(3)) };
  if (path === "/search") return { kind: "search" };
  if (path === "/create") return { kind: "create" };
  if (path === "/settings") return { kind: "settings" };
  if (path === "/grant") return { kind: "grant" };
  if (path === "/limits") return { kind: "limits" };
  // MONEY IS A PLACE, NOT A MODE. These were component state, so Back could not
  // dismiss the panel and the tab bar vanished while it was open — on the two
  // screens where a person is most likely to want out. Adding them here is what
  // makes the browser's own back button work.
  if (path === "/deposit") return { kind: "deposit" };
  if (path === "/withdraw") return { kind: "withdraw" };
  // /leaderboard still resolves — it is a URL people have open and have shared.
  // The board moved onto Home rather than disappearing, so that is where it
  // goes. next.config.mjs also normalises the address bar with a redirect; this
  // is the half that works whether or not the redirect is configured.
  return {
    kind: "tab",
    tab:
      path === "/agent"
        ? "agent"
        : path === "/you"
          ? "you"
          : path === "/feed"
            ? "feed"
            : path === "/alpha"
              ? "alpha"
              : "home",
  };
}

export function pathForScreen(screen: Screen): string {
  if (screen.kind === "token") return `/t/${encodeURIComponent(screen.id)}`;
  if (screen.kind === "profile") return `/a/${encodeURIComponent(screen.slug)}`;
  if (screen.kind === "tab")
    return ({ home: "/", agent: "/agent", you: "/you", feed: "/feed", alpha: "/alpha" })[screen.tab];
  return `/${screen.kind}`;
}
