"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import type { MarketData } from "@/lib/market";
import { compactUsd, count, subCentUsd, usdFixed } from "@/lib/format";
import { MovingFigure } from "@/terminal/ui";

/**
 * THE TAPE ALONG THE BOTTOM.
 *
 * A trading surface says what the market is doing whether or not you asked, and
 * it says it on every screen. Without this the product reads as a blog about
 * agents; with it, it reads as somewhere trading happens — which is the honest
 * framing, because it is.
 *
 * No marquee — it SCROLLS if it overflows, because a moving strip of prices is
 * unreadable and this one is meant to be read. A price that changes flips in
 * place (MovingFigure), which says it moved without making it move past you.
 *
 * TWO FEEDERS, ONE STRIP. `TickerStrip` draws whatever rows it is handed. The
 * terminal hands it the market it already reads every thirty seconds (see
 * terminal/ticker.ts), so its tape costs no request of its own; `Ticker` below
 * is the old self-fetching tape for the AppShell, which nothing mounts today.
 */

const money = (n: number | null): string => {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return usdFixed(n, 0);
  if (n >= 1) return usdFixed(n, 2);
  return subCentUsd(n);
};

/**
 * WAS A HAND-ROLLED SCALE, and it is the exact case the seam exists for.
 * "$1.2B" read on the long scale — Spanish, Italian, Dutch, European
 * Portuguese — is 10^12, a thousandfold overstatement with nothing on screen
 * to notice; and no k/M/B table can express Chinese, Japanese or Korean, which
 * regroup at 10^8.
 */
const compact = compactUsd;

export interface TickerItem {
  key: string;
  href: string;
  symbol: string;
  priceUsd: number | null;
  volume24hUsd: number | null;
  /** Only ever true when the chain said so. */
  halted: boolean;
  /** Only ever true when the price's own clock is over an hour old. */
  stale: boolean;
}

export function TickerStrip({
  items,
  wall = null,
  className,
  children,
}: {
  items: readonly TickerItem[];
  wall?: { turned: number; through: number } | null;
  className?: string;
  /** Controls that belong on the tape — the terminal's sound toggle. */
  children?: ReactNode;
}) {
  if (!items.length && !wall) return null;
  return (
    <aside className={className ? `mm-ticker ${className}` : "mm-ticker"} aria-label="Market">
      <div className="mm-ticker-scroll">
        {/* THE FLEET'S OWN NUMBER FIRST. Every other tape on the internet opens
            with BTC; this product's headline fact is the boundary, so it opens
            with how many intents the wall turned back today. */}
        {wall && (
          <Link href="/" className="mm-tick fleet">
            <span className="k">wall</span>
            <b className="mono warn">{count(wall.turned)}</b>
            <span className="mono dim">turned</span>
            <b className="mono up">{count(wall.through)}</b>
            <span className="mono dim">through</span>
          </Link>
        )}

        {items.map((t) => (
          // PREFETCH IS BACK ON, and the reason it was off has gone.
          //
          // It was disabled because fourteen of these sit in the viewport on
          // every page and /t/[token] is force-dynamic, so the default would
          // have warmed fourteen full server renders. That is only true
          // without a loading boundary: with one, the router prefetches the
          // route up to its loading.tsx and no further — a static skeleton,
          // not a ledger read. So the click is instant and costs nothing.
          <Link key={t.key} href={t.href} className="mm-tick">
            <span className="k">{t.symbol}</span>
            <b className="mono">
              <MovingFigure value={t.priceUsd} text={money(t.priceUsd)} />
            </b>
            {t.volume24hUsd !== null && <span className="mono dim">{compact(t.volume24hUsd)}</span>}
            {/* A stale feed is said, not hidden. A price nobody has updated in
                an hour is not a current price, and a tape that implies it is
                is worse than one that admits it. */}
            {t.halted ? (
              <span className="mono halted">halted</span>
            ) : t.stale ? (
              <span className="mono stale" title="This feed has not updated in over an hour">
                stale
              </span>
            ) : null}
          </Link>
        ))}
      </div>
      {children}
    </aside>
  );
}

/** The market read as tape rows — for the self-fetching tape below. */
export function marketItems(market: MarketData | null, nowSec: number): TickerItem[] {
  return (market?.tokens ?? [])
    .filter((t) => t.priceUsd !== null)
    .slice(0, 14)
    .map((t) => ({
      key: t.address,
      href: `/t/${t.address}`,
      symbol: t.symbol,
      priceUsd: t.priceUsd,
      volume24hUsd: t.volume24hUsd,
      halted: t.paused === true,
      stale: t.priceUpdatedAt !== null && nowSec - t.priceUpdatedAt > 3600,
    }));
}

/**
 * The self-fetching tape: one fetch of /api/market, which is already cached
 * for thirty seconds and already read by /tokens, so a visitor moving between
 * pages pays nothing extra.
 */
export function Ticker() {
  const [market, setMarket] = useState<MarketData | null>(null);
  const [wall, setWall] = useState<{ turned: number; through: number } | null>(null);

  useEffect(() => {
    let alive = true;
    let first = true;
    const load = async () => {
      // Gate the poll, never the first load: a tab opened in the background
      // would otherwise show an empty strip for ever.
      if (!first && document.visibilityState !== "visible") return;
      first = false;
      try {
        const [m, w] = await Promise.all([
          fetch("/api/market").then((r) => r.json()),
          fetch("/api/wall-tape").then((r) => r.json()).catch(() => null),
        ]);
        if (!alive) return;
        setMarket(m);
        if (w?.counts) setWall({ turned: w.counts.turned, through: w.counts.through });
      } catch {
        /* keep the last good strip rather than blanking it */
      }
    };
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return <TickerStrip items={marketItems(market, Date.now() / 1000)} wall={wall} />;
}
