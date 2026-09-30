"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

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
 * ring stays personal. A signed-out visitor makes no follow request and shows
 * no rings. Changing the cookie session resets and reloads this state.
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
  busy?: boolean;
  error?: string | null;
}

/**
 * EXPORTED so a test can render a consumer against a KNOWN answer.
 *
 * The provider's own state arrives from a `fetch` inside `useEffect`, which
 * does not run under `renderToStaticMarkup` — so a test driving the real
 * provider can only ever observe the empty set, i.e. exactly the half of the
 * property that holds when the feature is deleted. Seeding the context is what
 * makes "a wired slug draws a ring" falsifiable at all.
 *
 * Not a test-only hatch: this is the ordinary shape of a React context, and the
 * default below is still the thing every unwrapped consumer reads.
 */
export const WiredContext = createContext<Wired>({
  wired: [],
  max: 8,
  known: false,
  toggle: async () => {},
});
const Ctx = WiredContext;

export function useWired(): Wired {
  return useContext(Ctx);
}

/** The App passes the authenticated cookie session, including account changes. */
export function WiredProvider({ children, tenant = null }: { children: ReactNode; tenant?: string | null }) {
  const owner = tenant?.toLowerCase() ?? null;
  return <AccountWires key={owner ?? "anonymous"} tenant={owner}>{children}</AccountWires>;
}
function AccountWires({ children, tenant }: { children: ReactNode; tenant: string | null }) {
  const [wired, setWired] = useState<string[]>([]);
  const [max, setMax] = useState(8);
  const [known, setKnown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const writing = useRef(false);
  useEffect(() => {
    alive.current = true;
    let current = true;
    if (tenant) void fetch("/api/follow", { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!current || !Array.isArray(d?.wired)) return;
        setWired(d.wired);
        if (typeof d.max === "number") setMax(d.max);
        setKnown(true);
      }).catch(() => {});
    return () => { current = false; alive.current = false; };
  }, [tenant]);
  const toggle = async (slug: string, on: boolean) => {
    if (!tenant || !known || writing.current) return;
    const previous = wired;
    writing.current = true;
    setBusy(true);
    setError(null);
    setWired(on ? [...new Set([slug, ...previous])] : previous.filter(s => s !== slug));
    try {
      const r = await fetch("/api/follow", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: slug, on }),
      });
      const d = await r.json();
      if (!r.ok || !Array.isArray(d.wired)) throw new Error("Follow update failed");
      if (alive.current) setWired(d.wired);
    } catch {
      if (alive.current) {
        setWired(previous);
        setError("Could not update who your agent reads. Try again.");
      }
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return <Ctx.Provider value={{ wired, max, known, toggle, busy, error }}>{children}</Ctx.Provider>;
}
