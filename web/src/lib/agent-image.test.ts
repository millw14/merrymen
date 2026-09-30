/**
 * WHAT MAY BECOME AN AGENT'S PICTURE.
 *
 * Fixtures are generated with sharp rather than committed as binaries, so the
 * suite carries no opaque blobs and a reader can see exactly what each case is.
 *
 * The load-bearing assertion is not "an SVG is refused" — it is that the OUTPUT
 * is always a webp we encoded ourselves at a bounded size with no metadata. A
 * decode-and-re-encode is the image form of this repo's rule for strings
 * (refuse, never sanitise), and its guarantee is about what comes out, not
 * about what we managed to detect going in.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sharp from "sharp";
import { IMAGE_LIMITS, normaliseImage, refusalResponse } from "./agent-image";

const solid = (w: number, h: number, fmt: "png" | "jpeg" | "webp") => {
  const img = sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 40, b: 90 } } });
  return (fmt === "png" ? img.png() : fmt === "jpeg" ? img.jpeg() : img.webp()).toBuffer();
};

describe("an accepted image is re-encoded, not passed through", () => {
  for (const fmt of ["png", "jpeg", "webp"] as const) {
    it(`accepts ${fmt} and returns webp`, async () => {
      const r = await normaliseImage(new Uint8Array(await solid(64, 64, fmt)), "avatar");
      assert.ok(r.ok, `${fmt} must be accepted`);
      assert.equal(r.contentType, "image/webp");
      const m = await sharp(Buffer.from(r.bytes)).metadata();
      assert.equal(m.format, "webp", "the stored bytes must be our own encoding");
    });
  }

  it("sizes an avatar to a square and a banner to the header's shape", async () => {
    const a = await normaliseImage(new Uint8Array(await solid(900, 300, "png")), "avatar");
    assert.ok(a.ok);
    const am = await sharp(Buffer.from(a.bytes)).metadata();
    assert.equal(am.width, IMAGE_LIMITS.avatar.side);
    assert.equal(am.height, IMAGE_LIMITS.avatar.side);

    const b = await normaliseImage(new Uint8Array(await solid(300, 900, "png")), "banner");
    assert.ok(b.ok);
    const bm = await sharp(Buffer.from(b.bytes)).metadata();
    assert.equal(bm.width, IMAGE_LIMITS.banner.width);
    assert.equal(bm.height, IMAGE_LIMITS.banner.height);
  });

  it("carries no metadata out of the upload", async () => {
    // THE PRIVACY CASE. A phone photo carries GPS in EXIF, and an owner setting
    // a profile picture is not publishing where they took it. The re-encode
    // drops every tag; `.rotate()` applies the orientation first so the picture
    // is not left sideways by the loss.
    const withExif = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .withExif({ IFD0: { Copyright: "somebody", Software: "a phone" } })
      .jpeg()
      .toBuffer();
    assert.ok((await sharp(withExif).metadata()).exif, "fixture must actually carry EXIF");
    const r = await normaliseImage(new Uint8Array(withExif), "avatar");
    assert.ok(r.ok);
    assert.equal((await sharp(Buffer.from(r.bytes)).metadata()).exif, undefined, "EXIF must not survive");
  });
});

describe("what is refused, and with which answer", () => {
  it("refuses an animated WebP instead of silently keeping its first frame", async () => {
    const bytes = await sharp(Buffer.from([255, 0, 0, 0, 255, 0]), {
      raw: { width: 1, height: 2, channels: 3, pageHeight: 1 },
    }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    assert.equal((await sharp(bytes).metadata()).pages, 2);
    assert.deepEqual(await normaliseImage(bytes, "avatar"), { ok: false, refusal: "unsupported-format" });
  });
  it("refuses an SVG — it is a document, not a picture", async () => {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>`,
    );
    const r = await normaliseImage(new Uint8Array(svg), "avatar");
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.refusal, "unsupported-format");
    assert.equal(refusalResponse("unsupported-format").status, 415);
  });

  it("refuses bytes that are not an image", async () => {
    const r = await normaliseImage(new Uint8Array([1, 2, 3, 4]), "avatar");
    assert.equal(r.ok === false && r.refusal, "unreadable");
  });

  it("refuses an empty body", async () => {
    const r = await normaliseImage(new Uint8Array(0), "avatar");
    assert.equal(r.ok === false && r.refusal, "empty");
  });

  it("refuses anything over the per-kind byte cap before decoding", async () => {
    const big = new Uint8Array(IMAGE_LIMITS.avatar.maxBytes + 1);
    const r = await normaliseImage(big, "avatar");
    assert.equal(r.ok === false && r.refusal, "too-large");
    assert.equal(refusalResponse("too-large").status, 413);
  });

  it("is NOT fooled by a lying content type — the bytes decide", async () => {
    // Nothing in normaliseImage consults a header; this asserts the property by
    // showing an SVG is refused no matter what a caller would have claimed.
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>`);
    assert.equal((await normaliseImage(new Uint8Array(svg), "banner")).ok, false);
  });

  it("blames the deployment, not the owner, when the encoder is missing", () => {
    // A 4xx here would tell somebody their perfectly good picture was rejected
    // and send them looking for a problem in the file.
    assert.equal(refusalResponse("processing-unavailable").status, 503);
  });

  it("gives every refusal an owner-facing sentence with no library words", () => {
    for (const r of ["empty", "too-large", "unreadable", "unsupported-format", "too-many-pixels", "processing-unavailable"] as const) {
      const { status, error } = refusalResponse(r);
      assert.ok(status >= 400 && status < 600, r);
      assert.ok(error.length > 8 && !/sharp|libvips|Error:/i.test(error), `"${error}" must not leak the library`);
    }
  });
});
