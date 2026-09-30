"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SearchHit } from "@/app/api/search/route";
import { usd } from "@/lib/format";

/**
 * THE BAR ACROSS THE TOP: find something, and see where you stand.
 *
 * A trading surface is navigated by typing a symbol, and it tells you your own
 * position on every screen without being asked. The product had neither — just
 * a page title — which is a large part of why it read as a publication rather
 * than a place where trading happens.
 *
 * The search is real: it queries agents and tokens, the two things this product
 * has pages for. A search box that does not work is worse than no search box,
 * so this one is wired before it is styled.
 *
 * WHAT THE RIGHT-HAND SIDE SAYS DEPENDS ON WHAT IS TRUE. Signed in with an
 * agent, it is that agent's book. Signed in without one, it is the one thing
 * worth doing next. Signed out, it says nothing at all rather than showing a
 * zero that belongs to nobody — a balance is the one number that must never be
 * guessed.
 */

const money = (n: number) =>
  usd(n);

interface Mine {
  hasAgent: boolean;
  signedIn: boolean;
  cash: number;
  equity: number;
}

export function TopBar() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<Mine | null>(null);
  const box = useRef<HTMLDivElement | null>(null);

  // ── your own position ────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [g, s] = await Promise.all([
          fetch("/api/grants").then((r) => r.json()),
          fetch("/api/auth/session").then((r) => r.json()),
        ]);
        if (!alive) return;
        const cash = Number(g?.balances?.cashUsdg ?? 0);
        const vault = Number(g?.balances?.vaultUsdg ?? 0);
        setMine({
          hasAgent: g?.exists === true,
          signedIn: Boolean(s?.address) || g?.exists === true,
          cash,
          equity: cash + vault,
        });
      } catch {
        /* the bar simply says less */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ── search ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      return;
    }
    // Debounced, because this fires on a keystroke and the route is a real
    // query rather than a prefix tree.
    const id = setTimeout(() => {
      void fetch(`/api/search?q=${encodeURIComponent(term)}`)
        .then((r) => r.json())
        .then((d) => setHits(d.hits ?? []))
        .catch(() => setHits([]));
    }, 180);
    return () => clearTimeout(id);
  }, [q]);

  // Close on an outside click, and on Escape — a dropdown that traps the page
  // is the thing people hate most about search boxes.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
      // "/" focuses search from anywhere, unless the user is already typing.
      if (e.key === "/" && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        box.current?.querySelector("input")?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const go = (href: string) => {
    setOpen(false);
    setQ("");
    router.push(href);
  };

  return (
    <div className="mm-topbar">
      <div className="mm-search" ref={box}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="11" cy="11" r="7" />
          <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
        </svg>
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits[0]) go(hits[0].href);
          }}
          placeholder="Search agents or tokens…"
          aria-label="Search agents or tokens"
          spellCheck={false}
        />
        <kbd className="mono">/</kbd>

        {open && q.trim().length >= 2 && (
          <div className="mm-search-pop">
            {hits.length === 0 ? (
              <p className="none">Nothing matches that.</p>
            ) : (
              hits.map((h) => (
                <button key={h.href} type="button" onClick={() => go(h.href)}>
                  <span className={`kind ${h.kind}`}>{h.kind === "agent" ? "agent" : "token"}</span>
                  <span className="t">{h.title}</span>
                  {h.sub && <span className="s mono">{h.sub}</span>}
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="mm-mine">
        {mine?.hasAgent ? (
          <Link href="/you" className="mm-mine-book">
            <span>
              <b className="mono">{money(mine.cash)}</b>
              <i>cash</i>
            </span>
            <span>
              <b className="mono">{money(mine.equity)}</b>
              <i>on the book</i>
            </span>
          </Link>
        ) : mine ? (
          <Link href="/grant" className="mm-btn primary sm">
            Deploy an agent
          </Link>
        ) : null}
      </div>
    </div>
  );
}
