/**
 * THE IMAGE STORE — round trip, isolation, and the incomplete-record rule.
 *
 * Exercised on the file backend, which is the one a test can run; the Pg
 * backend shares the interface and its DDL is asserted by shape elsewhere. The
 * property worth the most here is the one the sidecar exists for: a record
 * whose type is missing reads as ABSENT rather than as a guess.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FileImageStore, IMAGE_KINDS, isImageKind, resetImageStoreForTest, sha256Of } from "./image-store";

const A = "0x00000000000000000000000000000000000000aa" as const;
const B = "0x00000000000000000000000000000000000000bb" as const;
const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i % 251));

let home: string;
let prev: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "mm-image-"));
  prev = process.env.MERRYMEN_HOME;
  process.env.MERRYMEN_HOME = home;
  resetImageStoreForTest();
});
afterEach(async () => {
  if (prev === undefined) delete process.env.MERRYMEN_HOME;
  else process.env.MERRYMEN_HOME = prev;
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the image store", () => {
  it("round-trips bytes, type and hash", async () => {
    const s = new FileImageStore();
    const b = bytes(64);
    await s.put(A, "avatar", { bytes: b, contentType: "image/webp", sha256: sha256Of(b) });
    const got = await s.get(A, "avatar");
    assert.ok(got);
    assert.deepEqual(Array.from(got.bytes), Array.from(b));
    assert.equal(got.contentType, "image/webp");
    assert.equal(got.sha256, sha256Of(b));
    assert.ok(got.updatedAt > 0, "a stored image knows when it was stored");
  });

  it("keeps the two kinds and the two tenants apart", async () => {
    const s = new FileImageStore();
    await s.put(A, "avatar", { bytes: bytes(8), contentType: "image/webp", sha256: "a" });
    await s.put(A, "banner", { bytes: bytes(16), contentType: "image/webp", sha256: "b" });
    await s.put(B, "avatar", { bytes: bytes(32), contentType: "image/webp", sha256: "c" });
    assert.equal((await s.get(A, "avatar"))!.bytes.byteLength, 8);
    assert.equal((await s.get(A, "banner"))!.bytes.byteLength, 16);
    assert.equal((await s.get(B, "avatar"))!.bytes.byteLength, 32);
    assert.equal(await s.get(B, "banner"), null);
  });

  it("replaces rather than accumulating", async () => {
    const s = new FileImageStore();
    await s.put(A, "avatar", { bytes: bytes(8), contentType: "image/webp", sha256: "first" });
    await s.put(A, "avatar", { bytes: bytes(99), contentType: "image/webp", sha256: "second" });
    const got = await s.get(A, "avatar");
    assert.equal(got!.bytes.byteLength, 99);
    assert.equal(got!.sha256, "second");
  });

  it("reads an absent image as absent, not as an error", async () => {
    assert.equal(await new FileImageStore().get(A, "avatar"), null);
  });

  /**
   * THE REASON THE TYPE LIVES IN A SIDECAR.
   *
   * Bytes with no sidecar is the state a crash between the two writes leaves
   * behind. It must read as "no image" — the safe direction, because the
   * fallback gradient is always correct — rather than as an image we serve with
   * a guessed content type.
   */
  it("treats bytes with no type as no image", async () => {
    const s = new FileImageStore();
    await s.put(A, "avatar", { bytes: bytes(8), contentType: "image/webp", sha256: "x" });
    const files = await readdir(path.join(home, "agent-image"));
    const sidecar = files.find((f) => f.endsWith(".json"))!;
    await rm(path.join(home, "agent-image", sidecar));
    assert.equal(await s.get(A, "avatar"), null, "an incomplete record is absent");
  });

  it("treats a malformed sidecar as no image", async () => {
    const s = new FileImageStore();
    await s.put(A, "avatar", { bytes: bytes(8), contentType: "image/webp", sha256: "x" });
    const dir = path.join(home, "agent-image");
    const sidecar = (await readdir(dir)).find((f) => f.endsWith(".json"))!;
    await writeFile(path.join(dir, sidecar), "{not json", "utf8");
    assert.equal(await s.get(A, "avatar"), null);
  });

  it("removes one kind without touching the other", async () => {
    const s = new FileImageStore();
    await s.put(A, "avatar", { bytes: bytes(8), contentType: "image/webp", sha256: "a" });
    await s.put(A, "banner", { bytes: bytes(8), contentType: "image/webp", sha256: "b" });
    await s.remove(A, "avatar");
    assert.equal(await s.get(A, "avatar"), null);
    assert.ok(await s.get(A, "banner"));
  });

  it("removing what is not there is not an error", async () => {
    await new FileImageStore().remove(A, "banner");
  });

  it("forgets both on kill, and only for that tenant", async () => {
    const s = new FileImageStore();
    for (const k of IMAGE_KINDS) await s.put(A, k, { bytes: bytes(8), contentType: "image/webp", sha256: k });
    await s.put(B, "avatar", { bytes: bytes(8), contentType: "image/webp", sha256: "b" });
    await s.removeTenant(A);
    for (const k of IMAGE_KINDS) assert.equal(await s.get(A, k), null);
    assert.ok(await s.get(B, "avatar"), "another tenant's picture is not ours to delete");
  });
});

describe("the kind is a closed set", () => {
  it("admits exactly avatar and banner", () => {
    assert.deepEqual([...IMAGE_KINDS], ["avatar", "banner"]);
    assert.equal(isImageKind("avatar"), true);
    assert.equal(isImageKind("banner"), true);
  });

  it("refuses anything else, including path-shaped input", () => {
    // It is a path segment on a public route and half a primary key. An open
    // set here is a directory traversal and an unbounded row count at once.
    for (const bad of ["", "AVATAR", "../grant", "avatar/../../etc", "profile", null, undefined, 1, {}]) {
      assert.equal(isImageKind(bad), false, JSON.stringify(bad));
    }
  });
});
