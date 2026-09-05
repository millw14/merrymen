/**
 * WHAT THE BROWSER IS ALLOWED TO ASK A THIRD PARTY, AND HOW IT ASKS.
 *
 * The redesign needed three outside feeds the app had never used — Robinhood's
 * issuer quotes, Yahoo's chart bars, Blockscout's holder list — and reached
 * them by adding wildcard `rewrites()` to next.config.mjs:
 *
 *     {source:"/robinhood/:path*", destination:"https://api.robinhood.com/rhj/:path*"}
 *     {source:"/yahoo/:path*",     destination:"https://query1.finance.yahoo.com/:path*"}
 *     {source:"/blockscout/:path*",destination:"https://robinhoodchain.blockscout.com/api/v2/:path*"}
 *
 * That is three problems in five lines, and the first is the serious one.
 *
 * 1. IT SENDS THE READER'S SESSION COOKIE TO THREE STRANGERS. The session is
 *    set `httpOnly, secure, sameSite:"strict", path:"/"` — `path:"/"` is what
 *    matters. `/yahoo/…` is same-origin, so the browser attaches the cookie,
 *    and a Next rewrite proxies the request upstream with its headers. Every
 *    chart view on a hosted deployment posted a live merrymen session to
 *    Yahoo. `sameSite:"strict"` does not help: this IS the site.
 *
 * 2. IT IS AN OPEN PROXY. `:path*` means anyone on the internet can drive our
 *    egress at those three hosts, through our IP and our reputation, at any
 *    path they choose, unauthenticated — the middleware's cross-site and host
 *    guards only cover `/api/`.
 *
 * 3. IT IS UNBOUNDED. No timeout, no size cap, no cache: every visitor's page
 *    load became ten upstream requests, re-fetched on every navigation.
 *
 * So the browser now asks OUR api, and this module is where the ask is bounded.
 * Requests upstream are BUILT, never forwarded: a fresh URL from validated
 * pieces, a fixed header set, no cookies, a timeout and a byte cap. The symbol
 * must be one this chain actually lists; the window must be one of five; the
 * address must be twenty bytes of hex. There is no arm that takes a caller's
 * string and puts it in a URL.
 *
 * `coin-image/route.ts` already argued all of this for logos, in 2026-08. This
 * is the same argument applied to data.
 *
 * PURE. No network here — the routes do the fetching, this decides what may be
 * fetched, so the decision can be tested without one.
 */

import { STOCK_TOKENS } from "@merrymen/core";

/** Hosts this app will talk to on a reader's behalf, and nothing else. */
export const VENUE_HOSTS = {
  robinhood: "api.robinhood.com",
  yahoo: "query1.finance.yahoo.com",
  blockscout: "robinhoodchain.blockscout.com",
} as const;

/** Bounds. A quote is kilobytes; a chart is tens of them. */
export const MAX_VENUE_BYTES = 2_000_000;
export const VENUE_TIMEOUT_MS = 10_000;

/**
 * The two Robinhood documents the terminal reads.
 *
 * Named individually rather than matched by pattern: an allow-list of two
 * strings cannot be talked into a third.
 */
export type QuoteDoc = "assets" | "prices";
export function quoteUrl(doc: QuoteDoc): string | null {
  if (doc !== "assets" && doc !== "prices") return null;
  return `https://${VENUE_HOSTS.robinhood}/rhj/${doc}`;
}

/**
 * Chart windows the terminal offers, and the upstream shape of each.
 *
 * THE LABELS ARE THE VENUE'S GRID, NOT OURS. Yahoo's `range` takes
 * `1d, 5d, 1mo, 3mo, 6mo, 1y, 2y, 5y, 10y, ytd, max` and nothing between them.
 * The button used to say "7D" and ask for `5d`, because 7d does not exist —
 * so the chart, the axis and the percentage under it were all five days of data
 * with a week's name on them. The button now says what it fetches.
 *
 * `cut` trims a longer response down to a shorter window, which is the honest
 * direction: a 1-hour view is the tail of a one-day fetch at minute
 * resolution. Nothing here ever pads a short series out to a longer name.
 */
export const CHART_WINDOWS = {
  "1H": { interval: "1m", range: "1d", cut: 3_600 },
  "4H": { interval: "5m", range: "1d", cut: 14_400 },
  "1D": { interval: "5m", range: "1d", cut: null },
  "5D": { interval: "15m", range: "5d", cut: null },
  "1M": { interval: "60m", range: "1mo", cut: null },
  ALL: { interval: "1d", range: "5y", cut: null },
} as const;
export type ChartWindow = keyof typeof CHART_WINDOWS;

export function isChartWindow(v: string): v is ChartWindow {
  return Object.prototype.hasOwnProperty.call(CHART_WINDOWS, v);
}

/**
 * The symbols this app will ask a chart venue about.
 *
 * DERIVED FROM THE CHAIN'S OWN REGISTRY, not from the caller. Yahoo will answer
 * for any ticker on earth, and a proxy that passes one through is a free
 * market-data relay wearing our domain. It is also the honesty boundary: a
 * chart we draw must be of an instrument this chain actually lists, or the page
 * is showing a price nobody here can trade.
 */
const LISTED = new Set(STOCK_TOKENS.map((t) => t.symbol.toUpperCase()));

export function chartUrl(symbol: string, window: string): string | null {
  const want = symbol.trim().toUpperCase();
  if (!/^[A-Z]{1,8}$/.test(want) || !LISTED.has(want)) return null;
  if (!isChartWindow(window)) return null;
  const { interval, range } = CHART_WINDOWS[window];
  return (
    `https://${VENUE_HOSTS.yahoo}/v8/finance/chart/${encodeURIComponent(want)}` +
    `?interval=${interval}&range=${range}`
  );
}

/**
 * The holder list for one token.
 *
 * Any well-formed address is allowed rather than only the listed ones, because
 * the market view legitimately covers launchpad coins the registry has never
 * heard of. The bound that matters here is the SHAPE — twenty bytes of hex
 * cannot carry a path traversal, a query string or another host.
 */
export function holdersUrl(address: string): string | null {
  const want = address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(want)) return null;
  return `https://${VENUE_HOSTS.blockscout}/api/v2/tokens/${want}/holders`;
}

/**
 * The headers a venue request carries. Built, not forwarded.
 *
 * THE POINT OF THIS FUNCTION IS WHAT IT DOES NOT RETURN. No cookie, no
 * authorization, no referer, no forwarded-for — nothing that identifies the
 * reader. A venue learns that merrymen asked about TSLA; it does not learn who
 * was looking, and it cannot be handed a session to replay.
 */
export function venueHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    // Yahoo's chart endpoint returns 401 to a bare client. A product name is
    // the honest thing to send and is also the thing a rate-limiter should see.
    "user-agent": "merrymen/1 (+https://merrymen.dev)",
  };
}

/**
 * A venue answer is never trusted to be the shape it claims.
 *
 * The routes hand the body straight back to the browser, so the only guarantee
 * offered is that it parsed as JSON and was under the cap. Every consumer in
 * `web/src/terminal` already treats these as unknown and reads defensively;
 * this exists so that a venue returning an HTML error page cannot arrive at a
 * caller expecting JSON with a 200 beside it.
 */
export function isJsonType(contentType: string | null): boolean {
  return (contentType ?? "").toLowerCase().includes("json");
}
