import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readdirSync, renameSync, rmSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { it } from "node:test";
import { CheckpointFrameReceiver, sendCheckpointFrames, sendCheckpointStream } from "./hosted-checkpoint-ipc";

it("a cancelled in-flight commit cannot reuse its descriptor to read another file", async () => {
 const home = mkdtempSync(path.join(os.tmpdir(), "mm-ipc-fd-")), r = new CheckpointFrameReceiver(home);
 const other = path.join(home, "other"); writeFileSync(other, "EVIL"); let fd: number | undefined, committed = false;
 try {
  const bytes = Buffer.from("GOOD"), payload = JSON.stringify({ bytes: 4, sha256: createHash("sha256").update(bytes).digest("hex") });
  await r.acceptStream("begin", payload, async () => {});
  await r.acceptStream("page", JSON.stringify({ index: 0, data: bytes.toString("base64") }), async () => {});
  await assert.rejects(r.acceptStream("commit", "{}", async chunks => {
   r.close(); fd = openSync(other, "r");
   const seen: Buffer[] = []; for await (const chunk of chunks) seen.push(chunk);
   committed = true; assert.equal(Buffer.concat(seen).toString(), "GOOD");
  }), /cancelled/);
  assert.equal(committed, false); assert.equal(readdirSync(home).filter(n => n.startsWith(".perp-checkpoint-")).length, 0);
 } finally { if (fd !== undefined) closeSync(fd); r.close(); rmSync(home, { recursive: true, force: true }); }
});

it("path replacement with a foreign symlink cannot redirect append or commit reads", async () => {
 const home = mkdtempSync(path.join(os.tmpdir(), "mm-ipc-link-")), r = new CheckpointFrameReceiver(home);
 const target = path.join(home, "foreign"); writeFileSync(target, "KEEP"); const bytes = Buffer.from("GOOD");
 try {
  await r.acceptStream("begin", JSON.stringify({ bytes: 4, sha256: createHash("sha256").update(bytes).digest("hex"), path: target }), async () => {});
  const file = path.join(home, readdirSync(home).find(n => n.startsWith(".perp-checkpoint-"))!);
  renameSync(file, `${file}.held`); symlinkSync(target, file);
  await r.acceptStream("page", JSON.stringify({ index: 0, data: bytes.toString("base64") }), async () => {});
  await r.acceptStream("commit", "{}", async chunks => { const held: Buffer[] = []; for await (const c of chunks) held.push(c); assert.equal(Buffer.concat(held).toString(), "GOOD"); });
  assert.equal(readFileSync(target, "utf8"), "KEEP");
 } finally { r.close(); rmSync(home, { recursive: true, force: true }); }
});

it("bounded streaming frames deliver all bytes and remove both spools on failure or success", async () => {
 const home = mkdtempSync(path.join(os.tmpdir(), "mm-ipc-stream-"));
 const parent = path.join(home, "parent"), child = path.join(home, "child"), r = new CheckpointFrameReceiver(parent);
 try {
  const total = 3 * 1024 * 1024 + 17, expected = createHash("sha256");
  async function* source() { for (let left = total; left > 0;) { const c = Buffer.alloc(Math.min(left, 33333), 7); expected.update(c); left -= c.length; yield c; } }
  let read = 0, digest = "";
  await sendCheckpointStream(source(), (kind, payload) => {
   assert.ok(payload.length < 750_000);
   return r.acceptStream(kind, payload, async chunks => { const hash = createHash("sha256"); for await (const c of chunks) { read += c.length; hash.update(c); } digest = hash.digest("hex"); });
  }, child);
  assert.equal(read, total); assert.equal(digest, expected.digest("hex"));
  assert.deepEqual(readdirSync(parent), []); assert.deepEqual(readdirSync(child), []);
  await assert.rejects(sendCheckpointFrames(Buffer.from("not committed"), (kind, payload) => r.acceptStream(kind, payload, async () => { throw new Error("storage down"); })), /storage down/);
  assert.deepEqual(readdirSync(parent), []);
 } finally { r.close(); rmSync(home, { recursive: true, force: true }); }
});
