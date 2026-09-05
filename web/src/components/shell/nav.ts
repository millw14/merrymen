/**
 * FOUR PLACES. NOT SIX.
 *
 * At 375px four tabs are 93px each, which is comfortable. Five would be 75px,
 * and the old console's own comment records discovering that five tabs at that
 * width gave an unreadable label.
 *
 * The reference product's fifth pillar is Alerts — "real time notifications for
 * what the best are buying". The plan is for that to become the feed's Wired
 * filter, which would be the same information and need no push infrastructure.
 * NEITHER IS BUILT: there is no Wired filter and no follow graph, so this
 * paragraph currently justifies four tabs by pointing at a fifth thing that
 * does not exist. It is still four tabs for the width reason above, which is
 * the argument that actually holds.
 */
export interface NavItem {
  href: string;
  label: string;
  /** Matches this route and everything under it. */
  prefix?: string;
}

export const NAV: readonly NavItem[] = [
  { href: "/", label: "Feed" },
  { href: "/tokens", label: "Tokens", prefix: "/t" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/you", label: "You" },
] as const;

/** Which nav item owns this path. Exact for "/", prefix for the rest. */
export function activeHref(pathname: string): string {
  if (pathname === "/") return "/";
  for (const n of NAV) {
    if (n.href === "/") continue;
    if (pathname === n.href || pathname.startsWith(`${n.href}/`)) return n.href;
    if (n.prefix && pathname.startsWith(`${n.prefix}/`)) return n.href;
  }
  // An agent profile belongs to the feed: you got there from a post.
  if (pathname.startsWith("/a/")) return "/";
  return "/";
}
