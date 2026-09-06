import { NextResponse } from "next/server";
import {
  chartUrl,
  holdersUrl,
  isJsonType,
  MAX_VENUE_BYTES,
  quoteUrl,
  VENUE_HOSTS,
  VENUE_TIMEOUT_MS,
  venueHeaders,
  type QuoteDoc,
} from "@/lib/venue";

/**
 * THE ONE DOOR TO A THIRD-PARTY FEED.
 *
 * Replaces three wildcard `rewrites()` the redesign added to next.config.mjs,
 * which proxied `/robinhood/:path*`, `/yahoo/:path*` and `/blockscout/:path*`
 * to their upstreams. Those rewrites were same-origin, so the browser attached
 * the reader's `httpOnly; path:"/"` session cookie to every chart request and
 * Next forwarded it upstream — a live merrymen session posted to Yahoo on every
 * page view. They were also unauthenticated open proxies at an attacker-chosen
 * path, outside the middleware guards, which only cover `/api/`.
 *
 * Being under `/api/` is half the fix on its own: middleware.ts applies the
 * host allow-list and the cross-site block here, and the site gate covers it
 * when one is set. The other half is `lib/venue.ts`, which decides what may be
 * asked; this file only does the asking, and it builds every upstream request
 * from scratch rather than forwarding the reader's.
 *
 * CACHED AT THE EDGE, deliberately. A quote is the same for every viewer, so
 * one upstream fetch should serve all of them — the rewrites re-fetched ten
 * documents per visitor per navigation, which is both rude to the venue and
 * the reason the first paint was slow.
 */

/** Quotes move; bars and holder lists move slowly. Seconds, per document. */
const TTL: Record<string, number> = { quotes: 30, chart: 300, holders: 300 };

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const desk = params.get("desk") ?? "";

  const upstream =
    desk === "quotes"
      ? quoteUrl((params.get("doc") ?? "") as QuoteDoc)
      : desk === "chart"
        ? chartUrl(params.get("symbol") ?? "", params.get("window") ?? "")
        : desk === "holders"
          ? holdersUrl(params.get("token") ?? "")
          : null;

  // A REFUSAL NAMES THE DESK, NOT THE INPUT. Echoing the caller's string back
  // into a response body is how a proxy becomes a reflection gadget.
  if (!upstream) {
    return NextResponse.json({ error: "unknown or unsupported venue request" }, { status: 400 });
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), VENUE_TIMEOUT_MS);
  try {
    const res = await fetch(upstream, {
      // BUILT, NOT FORWARDED. `req.headers` never reaches this call, which is
      // the whole point — see venueHeaders().
      headers: venueHeaders(),
      signal: ctl.signal,
      redirect: "follow",
      cache: "no-store",
    });

    // A redirect that left the host we allow-listed is not an answer from the
    // venue we chose. `redirect: "follow"` is needed because these APIs do
    // redirect internally; this is the check that makes following it safe.
    const landed = new URL(res.url);
    if (!Object.values(VENUE_HOSTS).includes(landed.host as (typeof VENUE_HOSTS)[keyof typeof VENUE_HOSTS])) {
      return NextResponse.json({ error: "the venue redirected off its own host" }, { status: 502 });
    }

    if (!res.ok) {
      // The STATUS travels and the body does not. "Unavailable" is the honest
      // thing to tell the browser, and a venue's error page is not data.
      return NextResponse.json(
        { error: "venue unavailable", status: res.status },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!isJsonType(res.headers.get("content-type"))) {
      return NextResponse.json({ error: "venue answered with something that is not JSON" }, { status: 502 });
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_VENUE_BYTES) {
      return NextResponse.json({ error: "venue answer too large" }, { status: 502 });
    }

    const ttl = TTL[desk] ?? 60;
    return new NextResponse(buf, {
      headers: {
        "Content-Type": "application/json",
        // One upstream fetch serves every viewer for the window. `s-maxage`
        // is what the shared cache honours; `stale-while-revalidate` keeps a
        // venue outage from becoming a blank chart for the next reader.
        "Cache-Control": `public, max-age=${Math.min(ttl, 30)}, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}`,
      },
    });
  } catch {
    // Never the reason a page dies. The terminal reads this the same way it
    // reads any refused venue: no data, said plainly.
    return NextResponse.json(
      { error: "the venue did not answer" },
      { status: 504, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    clearTimeout(timer);
  }
}
