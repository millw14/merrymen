import { NextResponse } from "next/server";
import { resolveLogo, safeHost } from "@/lib/coin-image";
import { fetchPublicHttps } from "../../../../../packages/core/src/server/public-network";

/**
 * A launched token's logo, fetched server-side and streamed back.
 *
 * THIS PROXY IS NOT A CONVENIENCE. ipfs.io, dweb.link and nftstorage.link all
 * return HTTP 403 to a real browser User-Agent — 0 of 25 images loaded in two
 * independent runs — while returning 100% at 200–300ms to a server. A card
 * with `<img src="https://ipfs.io/ipfs/…">` is an empty square on every phone,
 * and it would have looked like a styling problem rather than a blocked
 * request.
 *
 * It also fixes three things a hotlink cannot:
 *   - the payload. p90 is 454KB and the largest sampled logo is 1.49MB, which
 *     is absurd for a 44px square on a phone;
 *   - the host list. Logos point at fifteen different domains, so hotlinking
 *     hands an attacker-chosen URL straight to the reader's browser;
 *   - caching. A logo never changes, so one fetch serves every viewer forever.
 *
 * WHAT IT WILL NOT FETCH lives in lib/coin-image.ts, where it can be tested:
 * nothing that is not https after resolution, and no private or loopback host,
 * so this cannot be turned into a probe of the deploy's own network. Here it
 * additionally caps the response size, caps the time, and returns only bodies
 * the origin itself labelled `image/*`.
 */

export const revalidate = 86_400;
export const runtime = "nodejs";

/** A logo is a square on a phone. Anything past this is somebody's mistake. */
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 6_000;

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("uri");
  if (!raw) return new NextResponse("missing uri", { status: 400 });

  for (const candidate of resolveLogo(raw).slice(0, 3)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || !safeHost(url)) continue;

    try {
      const res = await fetchPublicHttps(url, {
        maxBytes: MAX_BYTES,
        timeoutMs: TIMEOUT_MS,
        accept: (response) => (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300 &&
          /^image\//i.test(response.headers["content-type"] ?? ""),
      });
      return new NextResponse(new Uint8Array(res.body), {
        headers: {
          "Content-Type": res.headers["content-type"]!,
          "X-Content-Type-Options": "nosniff",
          // SVG logos remain images even when opened as a document on our
          // origin: no scripts, external loads or access to the app's origin.
          "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
          // A logo never changes, so this is cacheable for as long as anyone
          // will keep it. Immutable because the URI IS the identity.
          "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable",
        },
      });
    } catch {
      /* try the next gateway */
    }
  }
  // 404 rather than a placeholder image: the card can decide what an absent
  // logo looks like, and a served placeholder would cache as though it were one.
  return new NextResponse("no image", { status: 404 });
}
