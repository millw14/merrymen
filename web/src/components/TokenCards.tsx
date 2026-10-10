"use client";

import { useState } from "react";
import Link from "@/terminal/Link";
import { compactUsd } from "@/lib/format";
import type { DiscoveryRow, FreshRow, Payload } from "@/lib/read-discoveries";

/**
 * The token cards, lifted out of the console.
 *
 * EVERY HONESTY PROPERTY HERE WAS ARGUED FOR ONCE AND IS PINNED BY
 * api/discoveries/honesty.test.ts. They look like small wording choices and
 * each of them is a claim the page would otherwise be making falsely. Read the
 * comments before changing a line.
 */

const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

export function shortAge(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86_400)}d`;
}

// Moved to lib/format so the token page's SERVER-rendered stat strip can use
// it without pulling this client module into its bundle. Re-exported because
// the name is used across the coins view.
export { compactUsd };

/**
 * WHICH READS FAILED, said once per page rather than once per card.
 *
 * The three on-chain reads fail as a WAVE — the RPC turns down the burst, not
 * one coin — so a per-card "unknown" thirty times over would read as thirty
 * broken coins instead of one degraded read.
 */
export function chainGap(d: Payload): string {
  const c = d.chain;
  if (!c) return ""; // a payload from before this field existed
  const missing = [
    !c.facts && "tickers",
    !c.meta && "logos and links",
    !c.clock && "ages",
  ].filter(Boolean) as string[];
  if (!missing.length) return "";
  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return `The chain turned down this read, so ${list} are missing below. The trade counts are real. It retries on its own.`;
}

/**
 * A coin's picture.
 *
 * Two things are load-bearing. It goes through /api/coin-image, because every
 * IPFS gateway returns 403 to a browser User-Agent and a direct src is an empty
 * square on every device. And it falls back to the first letters of the ticker
 * rather than a broken-image glyph, because roughly 1 in 250 launches publishes
 * no logo at all and a card with a shattered icon reads as a broken page.
 */
function CoinArt({ logo, symbol }: { logo: string; symbol: string }) {
  const [failed, setFailed] = useState(false);
  const initials =
    (symbol || "?")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 2)
      .toUpperCase() || "?";
  if (!logo || failed) return <span className="mm-art fallback">{initials}</span>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- next/image would
    // need every launcher-chosen host in next.config; the proxy is the allowlist.
    <img
      className="mm-art"
      src={`/api/coin-image?uri=${encodeURIComponent(logo)}`}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * CAN AN AGENT ACTUALLY BUY THIS COIN.
 *
 * There are TWO different noes here and they used to render as one. A coin
 * missing from a grant says "not added", and the fix is real: add it, re-sign,
 * done. A coin still on its bonding curve has NO POOL, and merrymen trades one
 * venue. Showing "not added" on a curve coin promised a fix that does not work
 * — the owner adds the token, pays for a re-sign, and still cannot touch it.
 * That is the exact shape of failure this codebase keeps refusing: a screen
 * that looks like it is telling you what to do while being wrong about what
 * would happen. So the curve case is checked FIRST.
 */
function Reach({ onCurve }: { onCurve: boolean }) {
  if (onCurve) {
    return (
      <span
        className="mm-badge out"
        title="This coin still trades on its launch curve, so there is no pool to trade against. Adding it to a grant will not help until it graduates."
      >
        no pool yet
      </span>
    );
  }
  return (
    <span className="mm-badge in" title="This coin trades in a pool an agent can route through.">
      tradeable
    </span>
  );
}

/** Just launched: age, curve progress, who is trading it, what it claims to be. */
export function FreshCard({ f }: { f: FreshRow }) {
  const pct = f.progressBps === null ? null : f.progressBps / 100;
  return (
    <article className="mm-card">
      <header>
        <CoinArt logo={f.logo} symbol={f.symbol} />
        <div className="idc">
          <div className="tick">
            {/* The ADDRESS when the ticker could not be read, never "unnamed" —
                that is a statement about the coin, and the coin has a name we
                simply failed to fetch. The address is true and still useful. */}
            <b>{f.symbol || short(f.token)}</b>
            {f.name && f.name !== f.symbol && <span className="nm">{f.name}</span>}
          </div>
          <div className="meta mono">
            <span>{shortAge(f.ageSec)} old</span>
            {/* Distinct ADDRESSES first: 291 trades from 25 addresses is a
                different thing from 223 from 176, and only one looks like people. */}
            <span>{f.traders} traders</span>
            <span>{f.trades} trades</span>
          </div>
        </div>
        <Reach onCurve={(f.progressBps ?? 0) < 10_000} />
      </header>

      {pct !== null && (
        <div className="mm-grad">
          <div className="gbar">
            <i style={{ width: `${Math.min(100, Math.max(1.5, pct))}%` }} />
          </div>
          <span className="glab mono">{pct < 0.05 ? "<0.1" : pct.toFixed(1)}% to graduation</span>
        </div>
      )}

      {/* Three states, not two. "Published nothing about itself" is a CLAIM,
          and it may only be made when the metadata read actually succeeded —
          `bare` is false when it did not, so an unread coin says nothing at all
          rather than being accused of silence. */}
      {f.description ? (
        <p className="say">{f.description}</p>
      ) : f.bare ? (
        <p className="say none">Published nothing about itself.</p>
      ) : null}

      <footer>
        {f.twitter && (
          <a className="soc" href={f.twitter} target="_blank" rel="noreferrer noopener nofollow">
            X
          </a>
        )}
        {f.telegram && (
          <a className="soc" href={f.telegram} target="_blank" rel="noreferrer noopener nofollow">
            Telegram
          </a>
        )}
        {f.website && (
          <a className="soc" href={f.website} target="_blank" rel="noreferrer noopener nofollow">
            Site
          </a>
        )}
        {f.bare && <span className="soc mute">no socials</span>}
        {/* Prefetches only as far as the route's loading boundary. */}
        <Link className="soc go" href={`/t/${f.token}`}>
          who&rsquo;s in it →
        </Link>
      </footer>
    </article>
  );
}

/** Trading now: the index's numbers, with the curve caveat kept visible. */
export function MarketCard({ r }: { r: DiscoveryRow }) {
  const up = (r.change24hPct ?? 0) >= 0;
  return (
    <article className="mm-card">
      <header>
        <CoinArt logo="" symbol={r.name.split(/[\s/]/)[0] ?? ""} />
        <div className="idc">
          <div className="tick">
            <b>{r.name}</b>
            {r.graduated && <span className="mm-chip up">graduated</span>}
            {r.onCurve && <span className="mm-chip quiet">on its curve</span>}
          </div>
          <div className="meta mono">
            <span>{r.ageDays === null ? "—" : shortAge(Math.round(r.ageDays * 86_400))} old</span>
            <span>{r.buyers24h === null ? "—" : `${r.buyers24h} buyers`}</span>
            <span>{compactUsd(r.volume24hUsd)} vol</span>
          </div>
        </div>
        <span className={`chg mono ${up ? "up" : "down"}`}>
          {r.change24hPct === null ? "—" : `${up ? "+" : ""}${r.change24hPct.toFixed(1)}%`}
        </span>
      </header>

      <div className="mm-figs mono">
        <span>
          <i>Price</i>
          {r.priceUsd === null
            ? "—"
            : `$${r.priceUsd < 0.01 ? r.priceUsd.toPrecision(2) : r.priceUsd.toFixed(4)}`}
        </span>
        <span>
          {/* FDV, and it says FDV. The index substitutes fully-diluted value
              for market cap whenever it lacks a circulating supply, and calling
              that "market cap" systematically makes a token look bigger and
              safer than it is. */}
          <i>FDV</i>
          {compactUsd(r.fdvUsd)}
        </span>
        <span>
          <i>Depth</i>
          {/* A coin still on its bonding curve reports a reserve that is mostly
              the VIRTUAL SEED — about $4,100 it does not hold — so it is never
              shown here as though it were money you could sell into. */}
          {r.onCurve ? "pre-graduation" : compactUsd(r.reserveUsd)}
        </span>
      </div>

      {/* THE AGENT'S OWN LINE, on the coin it is about. Conviction is an
          ORDERING — "look here first" — never a size and never a permission, so
          it renders as marks rather than a score out of five that would read
          like a rating. A coin with no verdict was passed over or never judged;
          saying nothing is the honest rendering of that. */}
      {r.verdict && (
        <div className="mm-verdict">
          <span className="pips" aria-label={`conviction ${r.verdict.conviction} of 5`}>
            {"▮".repeat(Math.max(1, Math.min(5, r.verdict.conviction)))}
          </span>
          <span className="vsay">{r.verdict.reason}</span>
        </div>
      )}

      <footer>
        <span className="soc mute">{r.venue}</span>
        <Reach onCurve={r.onCurve} />
        <Link className="soc go" href={`/t/${r.token}`}>
          who&rsquo;s in it →
        </Link>
      </footer>
    </article>
  );
}
