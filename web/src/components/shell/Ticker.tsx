"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "@/terminal/Link";
import type { MarketData } from "@/lib/market";
import { compactUsd, count, subCentUsd, usdFixed } from "@/lib/format";
import { Coin, MovingFigure } from "@/terminal/ui";

/**
 * THE TAPE ALONG THE BOTTOM.
 *
 * A trading surface says what the market is doing whether or not you asked, and
 * it says it on every screen. Without this the product reads as a blog about
 * agents; with it, it reads as somewhere trading happens — which is the honest
 * framing, because it is.
 *
 * By default it SCROLLS if it overflows, because a moving strip of prices is
 * hard to read and this one is meant to be read. A price that changes flips in
 * place (MovingFigure), which says it moved without making it move past you.
 *
 * `loop` makes it run instead — the terminal's tape asked for it. The run is
 * built to cost nothing and to stay readable: the rows are drawn twice inside
 * one track that a CSS transform slides by exactly half its width, so the
 * compositor does the work and no JavaScript ticks; the track element never
 * changes identity across re-renders, so a price update does not restart it;
 * it pauses while the pointer or keyboard focus is on it; and under
 * `prefers-reduced-motion` the second copy is dropped and the strip goes back
 * to scrolling by hand (desktop.css).
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
  /** The token's logo, or "" to draw its initials instead (Coin). */
  logo?: string;
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
  loop = false,
  children,
}: {
  items: readonly TickerItem[];
  wall?: { turned: number; through: number } | null;
  className?: string;
  /** Run the rows along the strip in a loop instead of letting it scroll. */
  loop?: boolean;
  /** Controls that belong on the tape — the terminal's sound toggle. */
  children?: ReactNode;
}) {
  if (!items.length && !wall) return null;
  const rows = (copy: boolean) => (
    // The second copy exists for the loop's seam alone: it is the same links
    // again, so assistive tech is told to skip it and it cannot take focus.
    <div className="mm-ticker-run" aria-hidden={copy || undefined}>
      {items.map((t) => (
        <Link key={t.key} href={t.href} className="mm-tick" tabIndex={copy ? -1 : undefined}>
          {t.logo !== undefined && <Coin symbol={t.symbol} logo={t.logo} />}
          <span className="k">{t.symbol}</span>
          <b className="mono">
            <MovingFigure value={t.priceUsd} text={money(t.priceUsd)} />
          </b>
          {t.volume24hUsd !== null && <span className="mono dim">{compact(t.volume24hUsd)}</span>}
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
  );
  if (loop) {
    // Four seconds a row keeps the pace the same however many rows there are.
    const seconds = Math.max(20, items.length * 4);
    return (
      <aside className={className ? `mm-ticker mm-ticker-loop ${className}` : "mm-ticker mm-ticker-loop"} aria-label="Market">
        <div className="mm-ticker-scroll">
          <div className="mm-ticker-track" style={{ "--tape-seconds": `${seconds}s` } as React.CSSProperties}>
            {rows(false)}
            {rows(true)}
          </div>
        </div>
        {children}
      </aside>
    );
  }
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

        {/* PREFETCH IS ON for these links, and the reason it was off has
            gone: /t/[token] has a loading boundary, so the router prefetches
            the static skeleton and no further. A stale feed is said, not
            hidden: a price nobody has updated in an hour is not a current
            price, and a tape that implies it is is worse than one that admits
            it. */}
        {rows(false)}
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
