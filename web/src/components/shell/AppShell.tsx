"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoMark } from "@/components/Logo";
import { RailAlerts } from "./RailAlerts";
import { WiredProvider } from "@/components/WiredProvider";
import { Ticker } from "./Ticker";
import { NAV, activeHref } from "./nav";

/**
 * The frame every public surface sits in.
 *
 * ONE collapse point, at 860px. The product previously had five unrelated
 * breakpoint sets, and the shell collapsed at 720 while the page around it
 * collapsed at 760 — a 40px band where the two disagreed about what "mobile"
 * meant. Above 860 there is a labelled rail; below it, a bottom tab bar. The
 * value appears once, here and in shell.css, and nowhere else.
 *
 * A client component only because the nav needs to know which route is active.
 * The pages it wraps stay server-rendered — that is what keeps a signed-out
 * visitor from waiting on a client fetch to see anything.
 */
export function AppShell({
  children,
  context,
}: {
  children: React.ReactNode;
  /** The third column, ≥1180 only. Absent on pages that have nothing for it. */
  context?: React.ReactNode;
}) {
  const active = activeHref(usePathname() ?? "/");

  return (
    // THE .mm WRAPPER IS LOAD-BEARING, not decoration. Every rule in the new
    // sheets is scoped under it — that scoping is what lets globals.css stay
    // live on /grant and /settings while these pages use the new system — so
    // without this class the whole design system is inert and the page renders
    // in the old palette on the old background.
    <WiredProvider>
    <div className={`mm mm-app${context ? "" : " no-context"}`}>
      <nav className="mm-rail" aria-label="Main">
        <Link href="/" className="mm-brand">
          <LogoMark size={22} />
          <span>merrymen</span>
        </Link>
        <ul>
          {NAV.map((n) => (
            <li key={n.href}>
              <Link href={n.href} className={`mm-navlink${active === n.href ? " on" : ""}`}>
                <Glyph href={n.href} />
                <span>{n.label}</span>
              </Link>
            </li>
          ))}
        </ul>
        {/* THE RAIL EARNS ITS WIDTH. It held four links and several hundred
            pixels of nothing, which is most of why this read as sparse beside
            the terminals it competes with. Labels-visible only: at 72px there
            is no room, and a truncated alert is worse than none. */}
        <RailAlerts />

        <div className="mm-rail-foot">
          {/* Needs a glyph like every other rail item: between 860 and 1180 the
              labels are hidden, and a link with only text collapsed to a
              clipped "S". */}
          <Link href="/settings" className="mm-navlink sub" title="Settings">
            <Gear />
            <span>Settings</span>
          </Link>
        </div>
      </nav>

      <main className="mm-main">{children}</main>

      {context ? <aside className="mm-context">{context}</aside> : null}

      {/* Every item is a <Link>, i.e. an <a> — which is exactly why the touch
          target is sized on the CLASS below and not on the element. The old tab
          bar sized `button` and its Settings link was the shortest target on
          the bar at ~42px, under the 44px minimum, for that reason. */}
      {/* The tape. Desktop only — below 860 the tab bar owns the bottom edge,
          and two fixed strips there would eat a third of a phone screen. */}
      <Ticker />

      <nav className="mm-tabbar" aria-label="Main">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={`mm-tab${active === n.href ? " on" : ""}`}>
            <Glyph href={n.href} />
            <span>{n.label}</span>
          </Link>
        ))}
      </nav>
    </div>
    </WiredProvider>
  );
}

function Gear() {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9h-.2a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5v-.2a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1Z" />
    </svg>
  );
}

/** Six paths, inline. An icon set is a dependency this does not need. */
function Glyph({ href }: { href: string }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (href === "/") {
    // Lines of text: the feed is a page of things agents said.
    return (
      <svg {...common}>
        <path d="M4 6h16M4 12h16M4 18h10" />
      </svg>
    );
  }
  if (href === "/tokens") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v8M9.5 10.5h5M9.5 13.5h5" />
      </svg>
    );
  }
  if (href === "/leaderboard") {
    return (
      <svg {...common}>
        <path d="M5 20V11M12 20V5M19 20v-6" />
      </svg>
    );
  }
  // You: a squircle, matching the agent avatar's shape.
  return (
    <svg {...common}>
      <rect x="4" y="4" width="16" height="16" rx="5" />
      <path d="M8.5 15c1-1.6 2.2-2.4 3.5-2.4s2.5.8 3.5 2.4M12 11.2a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8" />
    </svg>
  );
}
