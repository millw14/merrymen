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
 * FOUR, because a newcomer asks four questions: how is my merryman doing
 * (Home), can I talk to him (Chat), what is everybody else doing (Explore),
 * and where are my account and settings (Me). The bar used to be five — Feed
 * and Alpha each had a slot, and Alpha was a lock screen for most people and
 * unreachable on desktop. Both now live under Explore, beside the leaderboard
 * and the market list that Home used to stack under the balance.
 *
 * THE LOGO IS EXPLORE'S ICON. `TabIcon` renders `<LogoMark/>` for `feed`, and
 * Explore opens on the feed, so the mark still leads to the room.
 *
 * The ids are NOT the labels. They are wired into TabIcon's exhaustive switch,
 * the record below, the `data-screen` attribute CSS selects on, and FirstVisit
 * — so `agent` stays `agent` while it reads "Chat", `feed` reads "Explore" and
 * `you` reads "Me". `alpha` is still a tab id (its screen and URL are
 * unchanged); it is simply reached through Explore rather than the bar.
 */
export const TABS: { id: Tab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "agent", label: "Chat" },
  { id: "feed", label: "Explore" },
  { id: "you", label: "Me" },
];

/** The views inside Explore, in order. Each is its own URL so Back works. */
export const EXPLORE: { id: "feed" | "leaders" | "markets" | "alpha"; label: string; path: string }[] = [
  { id: "feed", label: "Feed", path: "/feed" },
  { id: "leaders", label: "Leaders", path: "/leaders" },
  { id: "markets", label: "Markets", path: "/markets" },
  { id: "alpha", label: "Research", path: "/alpha" },
];

/** Which Explore view a screen is, or null when it is not part of Explore. */
export function exploreViewOf(screen: Screen): (typeof EXPLORE)[number]["id"] | null {
  if (screen.kind === "leaders" || screen.kind === "markets") return screen.kind;
  if (screen.kind === "tab" && (screen.tab === "feed" || screen.tab === "alpha")) return screen.tab;
  return null;
}

/**
 * `solana` is whether this deployment offers Solana (solanaEnabled, handed down
 * from the server). Without it /solana is an unknown path and opens Home, so a
 * Back into an old /solana entry cannot mount the screen.
 */
export function screenForPath(path: string, solana = false, perps = false): Screen {
  if (path.startsWith("/t/")) return { kind: "token", id: decodeURIComponent(path.slice(3)) };
  if (path.startsWith("/a/")) return { kind: "profile", slug: decodeURIComponent(path.slice(3)) };
  if (path === "/search") return { kind: "search" };
  if (path === "/create") return { kind: "create" };
  if (path === "/settings") return { kind: "settings" };
  if (path === "/grant") return { kind: "grant" };
  if (path === "/perps" && perps) return { kind: "perps" };
  if (path === "/solana" && solana) return { kind: "solana" };
  if (path === "/limits") return { kind: "limits" };
  // The room every agent is in. A screen, NOT a sixth tab: `/chat` is the
  // owner talking to their own agent, and the bar is exactly five wide.
  if (path === "/groupchat") return { kind: "groupchat" };
  // Where an owner dresses their merryman. A screen, like the room above.
  if (path === "/wardrobe") return { kind: "wardrobe" };
  // Explore's own views. The leaderboard has a place again, under Explore,
  // and the old addresses for both open the view they always named.
  if (path === "/leaders" || path === "/leaderboard") return { kind: "leaders" };
  if (path === "/markets" || path === "/tokens") return { kind: "markets" };
  // MONEY IS A PLACE, NOT A MODE. These were component state, so Back could not
  // dismiss the panel and the tab bar vanished while it was open — on the two
  // screens where a person is most likely to want out. Adding them here is what
  // makes the browser's own back button work.
  if (path === "/deposit") return { kind: "deposit" };
  if (path === "/withdraw") return { kind: "withdraw" };
  //
  // "/" IS HOME. The front door is the merryman, on every device: the phone
  // used to open on the feed and the desktop on whichever token chart was
  // listed first, so nobody landed in the same place twice.
  return {
    kind: "tab",
    tab:
      path === "/agent" || path === "/chat"
        ? "agent"
        : path === "/you" || path === "/profile"
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
    return ({ home: "/home", agent: "/chat", you: "/profile", feed: "/feed", alpha: "/alpha" })[screen.tab];
  return `/${screen.kind}`;
}
