/**
 * AN AGENT'S PICTURE, FOR ANYBODY.
 *
 * ── 404 IS A FEATURE HERE ────────────────────────────────────────────────
 *
 * When an agent has uploaded nothing, this answers 404 and the `<img>`'s
 * `onError` falls through to the seeded gradient the components already draw.
 * That is deliberate and it is the same choice `api/coin-image` makes: never
 * serve a placeholder, because a placeholder is cacheable and a cached
 * placeholder is indistinguishable from a real picture that happens to look
 * blank. An absent image must stay absent.
 *
 * ── AND WHY THIS ROUTE EXISTS FOR AGENTS WITH NO UPLOAD AT ALL ───────────
 *
 * The terminal's `Face` used to build `https://robohash.org/<slug>.png` and
 * hotlink it — on a public feed, which sends every reader's IP to a third party
 * for every avatar on the page. `api/agent-face` was written as the proxy for
 * exactly that and only the unmounted `AgentAvatar` ever used it. Pointing every
 * face at THIS route closes the hotlink: an uploaded image is served from here,
 * and everything else falls to the gradient, which needs no network at all.
 *
 * ── SHAPE BEFORE STORE ───────────────────────────────────────────────────
 *
 * The slug is checked against the identity store's own regex before any query,
 * exactly as `bySlug` and `api/agent-face` do. An unknown or malformed id never
 * reaches the database.
 */
import { NextResponse } from "next/server";
import { getIdentityStore, SLUG_RE } from "@merrymen/identity-store";
import { getImageStore, isImageKind } from "@merrymen/image-store";

export const runtime = "nodejs";

/**
 * SHORT, WITH AN ETAG — not immutable.
 *
 * The URL does not contain the content hash (the components build it from the
 * slug alone, which is what keeps them simple), so `immutable` would pin a
 * replaced avatar in every cache until it expired. A minute of freshness plus
 * an ETag gives a cheap 304 on the common path and a new picture that actually
 * appears. The upload route hands back a version string for callers that want
 * the change to show instantly.
 */
const CACHE = "public, max-age=60, stale-while-revalidate=300";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string; kind: string }> }) {
  const { slug, kind } = await params;
  if (!SLUG_RE.test(slug)) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!isImageKind(kind)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const identity = await getIdentityStore().bySlug(slug).catch(() => null);
  if (!identity) return NextResponse.json({ error: "not found" }, { status: 404 });

  const image = await getImageStore().get(identity.tenant, kind).catch(() => null);
  if (!image) return NextResponse.json({ error: "not found" }, { status: 404 });

  const etag = `"${image.sha256}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag, "Cache-Control": CACHE } });
  }

  return new NextResponse(new Uint8Array(image.bytes) as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": image.contentType,
      "Cache-Control": CACHE,
      ETag: etag,
      // The bytes were produced by our own encoder, so the type is ours to
      // assert — but a browser that sniffs is a browser that can be persuaded,
      // and this costs nothing.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
