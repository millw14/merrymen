"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * WHO THE VIEWER READS — a client fact, deliberately.
 *
 * The ring on an avatar means "your agent reads this desk", so it is per-viewer,
 * and the feed is `revalidate = 30` and server-rendered. `read-theses.ts` records
 * why that matters: the response is byte-identical for every visitor BY
 * CONSTRUCTION, and the moment a session read appears in that path the caching
 * becomes a leak.
 *
 * So the ring is applied AFTER paint, from the browser, against a route that is
 * already `force-dynamic` and already per-caller. The page stays cacheable, the
 * ring stays personal, and a signed-out visitor fetches once, gets a 401 and
 * shows no rings — which is correct, because they have no agent to wire with.
 *
 * ONE FETCH FOR THE WHOLE PAGE. Mounted in the app shell, so the feed, the
 * leaderboard, a token page and an agent profile all share a single answer
 * rather than each asking.
 */

interface Wired {
  /** Slugs the viewer's agent reads. Empty until the first answer lands. */
  wired: string[];
  /** The cap, so a control can render a budget rather than a bare count. */
  max: number;
  /** False until the first answer lands — "not yet known" is not "none". */
  known: boolean;
  /** Optimistically flip one slug and persist it. No-op when signed out. */
  toggle(slug: string, on: boolean): Promise<void>;
}

const Ctx = createContext<Wired>({ wired: [], max: 8, known: false, toggle: async () => {} });

export function useWired(): Wired {
  return useContext(Ctx);
}

export function WiredProvider({ children }: { children: ReactNode }) {
  const [wired, setWired] = useState<string[]>([]);
  const [max, setMax] = useState(8);
  const [known, setKnown] = useState(false);

  useEffect(() => {
    let alive = true;
    void fetch("/api/follow")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { wired?: string[]; max?: number } | null) => {
        if (!alive || !d) return;
        setWired(d.wired ?? []);
        if (typeof d.max === "number") setMax(d.max);
        setKnown(true);
      })
      // A signed-out viewer, a self-hosted install (404) and an unreachable
      // route all land here. `known` stays false, so nothing claims the viewer
      // follows nobody — it claims not to know, which is the truth.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const toggle = async (slug: string, on: boolean) => {
    // OPTIMISTIC, then reconciled with what the server actually stored. The
    // server is the authority on the cap, so a refused write snaps back rather
    // than leaving a ring the agent will not honour.
    setWired((prev) => (on ? [...new Set([slug, ...prev])] : prev.filter((s) => s !== slug)));
    try {
      const r = await fetch("/api/follow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: slug, on }),
      });
      const d = (await r.json()) as { wired?: string[] };
      if (Array.isArray(d.wired)) setWired(d.wired);
    } catch {
      // Leave the optimistic state: a failed write with a reverted ring reads as
      // the click not registering, and the next load corrects it either way.
    }
  };

  return <Ctx.Provider value={{ wired, max, known, toggle }}>{children}</Ctx.Provider>;
}
