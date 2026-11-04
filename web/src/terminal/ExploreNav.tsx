"use client";
/**
 * EXPLORE'S FOUR VIEWS, ONE ROW OF PILLS.
 *
 * Feed, Leaders, Markets and Research used to be two tabs, a section of Home
 * and a desktop-only sidebar, and Research had no desktop entry at all. Now
 * they are one place with one switcher, and each view is its own URL, so Back
 * works and a link opens the view it names.
 */
import { BarChart3, FlaskConical, Newspaper, Trophy } from "lucide-react";
import Link from "./Link";
import { EXPLORE } from "./nav";

const ICONS = { feed: Newspaper, leaders: Trophy, markets: BarChart3, alpha: FlaskConical } as const;

export function ExploreNav({ active }: { active: (typeof EXPLORE)[number]["id"] }) {
  return (
    <nav className="explore-nav" aria-label="Explore">
      <h1 className="top-title explore-title">Explore</h1>
      <div className="explore-pills">
        {EXPLORE.map((v) => {
          const Icon = ICONS[v.id];
          return (
            <Link key={v.id} href={v.path} className={v.id === active ? "on" : undefined} aria-current={v.id === active ? "page" : undefined}>
              <Icon size={16} aria-hidden="true" />
              <span>{v.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
