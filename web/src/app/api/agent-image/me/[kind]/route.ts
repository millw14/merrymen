/**
 * THE OWNER'S OWN PICTURE — upload and remove.
 *
 * ── WHY THIS LIVES UNDER /me/ ────────────────────────────────────────────
 *
 * The public read route is /api/agent-image/<slug>/<kind>. A write route at
 * /api/agent-image/<kind> would put a second DYNAMIC name at the same path
 * position, and Next refuses that outright — "You cannot use different slug
 * names for the same dynamic path" — which does not fail the route, it fails
 * the whole dev server and the build. A STATIC segment at that position is
 * unambiguous (static wins over dynamic) and it reads as what it is: my image.
 *
 * ── NO SLUG IN THE PATH, AND THAT IS THE AUTHORISATION ───────────────────
 *
 * The write routes take only a KIND. Whose image it is comes from the session
 * cookie, never from the URL — so there is no path an attacker can construct
 * that names somebody else's agent, because the field that would carry it does
 * not exist. The public READ route is the one that takes a slug, and it only
 * reads.
 *
 * ── WHY THE BODY IS RAW BYTES, NOT MULTIPART ─────────────────────────────
 *
 * A multipart parse is a parser we would be adding to an authenticated route
 * for one field. `fetch(url, { method: "PUT", headers: { "content-type":
 * file.type }, body: file })` sends the file as the body, and `arrayBuffer()`
 * reads it. No parser, no boundary handling, no filename to sanitise — there
 * is no filename at all, which is one fewer piece of attacker-chosen text in
 * the system.
 *
 * ── THE SIZE CHECK HAPPENS TWICE, ON PURPOSE ─────────────────────────────
 *
 * `content-length` first, so an oversized upload is refused BEFORE the body is
 * read into memory; then the real byte length after, because a header is a
 * claim. The bundler proxy makes the same two-step argument about its 32KB cap.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { getImageStore, isImageKind, sha256Of } from "@merrymen/image-store";
import { IMAGE_LIMITS, normaliseImage, refusalResponse } from "@/lib/agent-image";
import { tenantOf } from "@/lib/auth";

export const runtime = "nodejs";
/** Per-caller and mutating: never cached, never shared. */
export const dynamic = "force-dynamic";

async function owner(req: Request): Promise<`0x${string}` | null> {
  if (!isHostedMode()) return null;
  return tenantOf(req);
}

export async function PUT(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  // HOSTED ONLY, like every other owner-write surface. A self-hosted install
  // runs one operator against one settings file and has no session to attribute
  // an upload to — the same 404 the rest of the hosted-only surface gives.
  if (!isHostedMode()) return NextResponse.json({ error: "not found" }, { status: 404 });
  const tenant = await owner(req);
  if (!tenant) return NextResponse.json({ error: "sign in" }, { status: 401 });

  const { kind } = await params;
  if (!isImageKind(kind)) return NextResponse.json({ error: "unknown image" }, { status: 404 });

  // THE HEADER'S CLAIM, CHECKED BEFORE THE BODY IS READ. An absent
  // content-length is not treated as zero — it is an unknown, and an unknown
  // length on a capped upload is refused rather than read to find out.
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (!Number.isFinite(declared) || declared <= 0) {
    return NextResponse.json({ error: "send the image as the request body" }, { status: 411 });
  }
  if (declared > IMAGE_LIMITS[kind].maxBytes) {
    return NextResponse.json({ error: "that image is too large" }, { status: 413 });
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await req.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "that upload could not be read" }, { status: 400 });
  }

  // DECODED AND RE-ENCODED, never passed through. See lib/agent-image.ts for
  // why that is the image form of "refuse, never sanitise".
  const out = await normaliseImage(bytes, kind);
  if (!out.ok) {
    const { status, error } = refusalResponse(out.refusal);
    return NextResponse.json({ error }, { status });
  }

  await getImageStore().put(tenant, kind, {
    bytes: out.bytes,
    contentType: out.contentType,
    sha256: sha256Of(out.bytes),
  });
  // The version is the caller's cache-buster: the client appends it to the
  // image URL so a just-uploaded picture appears immediately rather than after
  // the read route's max-age expires.
  return NextResponse.json({ ok: true, version: sha256Of(out.bytes).slice(0, 12) });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  if (!isHostedMode()) return NextResponse.json({ error: "not found" }, { status: 404 });
  const tenant = await owner(req);
  if (!tenant) return NextResponse.json({ error: "sign in" }, { status: 401 });

  const { kind } = await params;
  if (!isImageKind(kind)) return NextResponse.json({ error: "unknown image" }, { status: 404 });

  // Removing one that is not there is not an error — the caller's intent
  // ("I want no picture here") is satisfied either way.
  await getImageStore().remove(tenant, kind);
  return NextResponse.json({ ok: true });
}
