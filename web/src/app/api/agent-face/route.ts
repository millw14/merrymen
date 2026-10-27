import { NextResponse } from "next/server";
import { walletNotSupported } from "@/lib/route-guard";

/**
 * AN AGENT'S FACE, generated from its public id.
 *
 * Robots, from robohash.org, seeded on the agent's SLUG. Sakura already uses
 * this service for the same job, so it is a choice the codebase has made once
 * before rather than a new dependency to argue about.
 *
 * WHY THE SLUG AND NOT THE NAME. The name is owner-typed and editable, so a
 * rename would change an agent's face — and a feed where faces move is a feed
 * nobody learns to read. The slug is minted once and never changes, which is
 * the whole reason it exists.
 *
 * WHY A PROXY RATHER THAN A HOTLINK, for the same three reasons coin-image
 * gives:
 *   - a public feed hotlinking a third party sends every reader's IP to it,
 *     forty times per page;
 *   - the response is capped in bytes and in time here, and only a body the
 *     origin itself labelled `image/*` is passed on;
 *   - a face never changes, so one fetch serves every viewer for a year.
 *
 * AND IT MUST NEVER BE A BROKEN IMAGE. The seed is validated to the slug's own
 * shape before anything is fetched, and a failure returns 502 so the component
 * falls back to the gradient it has always drawn. An agent with no face is a
 * worse outcome than an agent with a plain one.
 */

export const revalidate = 31_536_000;

const SEED_RE = /^[0-9a-hjkmnp-tv-z]{16}$/;
const MAX_BYTES = 400_000;
const TIMEOUT_MS = 5_000;

export async function GET(req: Request) {
  const walletRefused = walletNotSupported(req);
  if (walletRefused) return walletRefused;
  const seed = new URL(req.url).searchParams.get("seed") ?? "";
  // Shape-checked BEFORE any outbound request, so this cannot be turned into a
  // way to make our server fetch an arbitrary robohash path.
  if (!SEED_RE.test(seed)) return new NextResponse("bad seed", { status: 400 });

  // set1 is the robot set. These are agents; they are robots.
  // bgset is omitted deliberately — robohash returns transparent without it,
  // and the product's ground is pure black.
  const url = `https://robohash.org/${seed}.png?set=set1&size=160x160`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    // `no-store` bypasses the framework's own data cache, which is for JSON and
    // has no business holding image bodies — this route does its own caching
    // with the header below, and the URL is the identity so it never changes.
    const r = await fetch(url, { signal: ac.signal, redirect: "follow", cache: "no-store" });
    if (!r.ok) {
      console.error(`[agent-face] upstream ${r.status} for ${seed}`);
      return new NextResponse("upstream refused", { status: 502 });
    }
    const type = r.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) {
      console.error(`[agent-face] not an image (${type || "no type"}) for ${seed}`);
      return new NextResponse("not an image", { status: 502 });
    }
    // A Uint8Array, not the raw ArrayBuffer: the response constructor rejects
    // the latter, and being caught below it read as "the origin is down" when
    // the origin had answered perfectly.
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) {
      console.error(`[agent-face] ${buf.byteLength} bytes for ${seed}`);
      return new NextResponse("too large", { status: 502 });
    }
    return new NextResponse(buf, {
      headers: {
        "Content-Type": type,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (e) {
    // Named, not swallowed. A silent 502 here is indistinguishable from the
    // service being down, and it was not.
    console.error(`[agent-face] ${seed}: ${e instanceof Error ? e.message : String(e)}`);
    return new NextResponse("unreachable", { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
