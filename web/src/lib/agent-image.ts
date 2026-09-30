/**
 * TURNING AN UPLOAD INTO SOMETHING SAFE TO SERVE.
 *
 * ── THE RULE THIS FOLLOWS, WHICH IS THE REPO'S RULE FOR STRINGS ──────────
 *
 * Everywhere else, user-supplied input is validated at the door with a strict
 * shape and REFUSED rather than sanitised: an x handle is `/^[A-Za-z0-9_]{1,15}$/`
 * or it is not a handle; an address is 40 hex or it is not an address. The
 * image equivalent of "refuse, never sanitise" is DECODE AND RE-ENCODE. We do
 * not inspect an upload and pass the original bytes through if it looks fine —
 * we decode it to pixels and write our own file. Whatever was in the container
 * that we did not understand does not survive that, because nothing of the
 * original container does.
 *
 * That is what makes the list below an allowlist of what we can DECODE rather
 * than a blocklist of what is dangerous. A blocklist of image exploits is the
 * shape of problem that cannot be finished.
 *
 * ── WHAT IS REFUSED, AND WHY EACH ────────────────────────────────────────
 *
 *   SVG — is a document, not a picture. It can carry script and it can fetch.
 *   It is refused by the format allowlist rather than by a check, because
 *   sharp would happily rasterise it and then we would be deciding, per
 *   feature, whether the rasteriser is a sandbox. It is not our sandbox.
 *
 *   ANIMATION — metadata with multiple pages is refused before re-encoding.
 *   `animated: false` also prevents decoding every frame while inspecting it.
 *
 *   DECOMPRESSION BOMBS — `limitInputPixels` refuses a file whose HEADER
 *   claims more pixels than we will ever draw, before any of it is decoded.
 *   A 32,000 x 32,000 PNG is a few hundred kilobytes on the wire and 4GB in
 *   memory, so a byte cap alone does not catch it.
 *
 *   EXIF — `.rotate()` applies the orientation tag and then the re-encode
 *   drops every other tag with it, including GPS. An owner uploading a photo
 *   from a phone should not be publishing where they took it.
 *
 * ── AND WHAT IS DELIBERATELY NOT DECIDED HERE ────────────────────────────
 *
 * Nothing about WHO may upload. This function takes bytes and returns bytes or
 * a refusal; the session, the hosted check and the size cap live in the route,
 * because they are facts about a request and this is a fact about a file.
 */

/**
 * The formats we can decode, and therefore the only ones we accept.
 *
 * Read from sharp's own `metadata().format`, not from the request's
 * Content-Type — a header is what the client claims and these are what the
 * bytes actually are. A lying header is not a special case here; it simply
 * never gets consulted.
 */
const DECODABLE = new Set(["jpeg", "png", "webp"]);

/**
 * What a stored image is sized to.
 *
 * An avatar is drawn at 48px and under nearly everywhere and at 160px at its
 * largest, so 512 is already generous for a 2x display. A banner spans the
 * profile header. Both are re-encoded to webp, which is the one format every
 * browser this product supports can read and which is materially smaller than
 * png for photographs.
 */
export const IMAGE_LIMITS = {
  avatar: { side: 512, maxBytes: 5 * 1024 * 1024 },
  banner: { width: 1500, height: 500, maxBytes: 8 * 1024 * 1024 },
} as const;

/** The most pixels we will let a decoder allocate, before decoding. */
const MAX_INPUT_PIXELS = 30_000_000;

export type ImageRefusal =
  | "empty"
  | "too-large"
  | "unreadable"
  | "unsupported-format"
  | "too-many-pixels"
  | "processing-unavailable";

export type NormalisedImage =
  | { ok: true; bytes: Uint8Array; contentType: "image/webp" }
  | { ok: false; refusal: ImageRefusal };

/**
 * Decode an upload and re-encode it to a bounded webp, or refuse it.
 *
 * `sharp` is imported LAZILY, exactly as `worker/src/pnl-card.ts` does, and for
 * the same reason: it is a native module, and a host where it fails to load
 * must not take the surface down at import time. A load failure is its own
 * refusal — `processing-unavailable` — so the route can answer 503 rather than
 * a 400 that tells the owner their perfectly good picture was rejected.
 */
export async function normaliseImage(bytes: Uint8Array, kind: "avatar" | "banner"): Promise<NormalisedImage> {
  if (bytes.byteLength === 0) return { ok: false, refusal: "empty" };
  if (bytes.byteLength > IMAGE_LIMITS[kind].maxBytes) return { ok: false, refusal: "too-large" };

  let sharp: typeof import("sharp");
  try {
    sharp = (await import("sharp")).default as unknown as typeof import("sharp");
  } catch {
    return { ok: false, refusal: "processing-unavailable" };
  }

  try {
    const input = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, animated: false });
    const meta = await input.metadata();
    if (!meta.format || !DECODABLE.has(meta.format)) return { ok: false, refusal: "unsupported-format" };
    if ((meta.pages ?? 1) > 1) return { ok: false, refusal: "unsupported-format" };

    const resized =
      kind === "avatar"
        ? input.rotate().resize(IMAGE_LIMITS.avatar.side, IMAGE_LIMITS.avatar.side, { fit: "cover" })
        : input.rotate().resize(IMAGE_LIMITS.banner.width, IMAGE_LIMITS.banner.height, { fit: "cover" });

    const out = await resized.webp({ quality: 82 }).toBuffer();
    return { ok: true, bytes: new Uint8Array(out), contentType: "image/webp" };
  } catch (e) {
    // sharp throws on a pixel-limit breach with a message naming it; everything
    // else that throws here is a file we could not read. Both are refusals, and
    // telling them apart is worth one string test because the remedies differ:
    // one is "that image is enormous", the other is "that is not an image".
    const m = e instanceof Error ? e.message : String(e);
    if (/pixel|limitInputPixels/i.test(m)) return { ok: false, refusal: "too-many-pixels" };
    return { ok: false, refusal: "unreadable" };
  }
}

/** What to tell the owner, and with which status. Never the library's words. */
export function refusalResponse(refusal: ImageRefusal): { status: number; error: string } {
  switch (refusal) {
    case "empty":
      return { status: 400, error: "that upload was empty" };
    case "too-large":
      return { status: 413, error: "that image is too large" };
    case "too-many-pixels":
      return { status: 413, error: "that image has too many pixels to process" };
    case "unsupported-format":
      return { status: 415, error: "use a PNG, JPEG or WebP — SVGs and animations are not accepted" };
    case "unreadable":
      return { status: 400, error: "that file could not be read as an image" };
    case "processing-unavailable":
      // NOT A 4xx. The upload may be perfectly good; this deployment cannot
      // process it. Blaming the owner for our own missing native module is the
      // kind of wrong answer somebody spends an hour acting on.
      return { status: 503, error: "image processing is unavailable on this deployment" };
  }
}
