/** Bounded IPC frames; large histories never become one oversized process message. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, createReadStream, mkdirSync, openSync, readSync, readdirSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { CHECKPOINT_PAGE_BYTES } from "./hosted-financial-pages";

export async function sendCheckpointFrames(bytes: Buffer, send: (kind: "begin" | "page" | "commit", payload: string) => Promise<void>): Promise<void> {
 await send("begin", JSON.stringify({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }));
 for (let at = 0, index = 0; at < bytes.length; at += CHECKPOINT_PAGE_BYTES, index++) {
  await send("page", JSON.stringify({ index, data: bytes.subarray(at, at + CHECKPOINT_PAGE_BYTES).toString("base64") }));
 }
 await send("commit", "{}");
}

/** Capture once to a private spool, then transmit fixed-size pages without a full-history Buffer. */
export async function sendCheckpointStream(chunks: Iterable<Buffer> | AsyncIterable<Buffer>, send: (kind: "begin" | "page" | "commit", payload: string) => Promise<void>, home: string): Promise<void> {
 mkdirSync(home, { recursive: true, mode: 0o700 });
 const file = path.join(home, `.perp-checkpoint-${randomUUID()}`), hash = createHash("sha256"); let bytes = 0;
 const fd = openSync(file, "wx+", 0o600);
 try {
  for await (const chunk of chunks) { writeSync(fd, chunk); hash.update(chunk); bytes += chunk.length; }
  await send("begin", JSON.stringify({ bytes, sha256: hash.digest("hex") }));
  let index = 0;
  for await (const chunk of createReadStream(file, { fd, autoClose: false, start: 0, highWaterMark: CHECKPOINT_PAGE_BYTES })) {
   await send("page", JSON.stringify({ index: index++, data: (chunk as Buffer).toString("base64") }));
  }
  await send("commit", "{}");
 } finally { closeSync(fd); rmSync(file, { force: true }); }
}

/** One active upload per leased child; every incomplete file is removed on exit. */
export class CheckpointFrameReceiver {
 private active: { file: string; fd: number; bytes: number; hash: string; received: number; pages: number; digest: ReturnType<typeof createHash>; committing: boolean; cancelled: boolean } | null = null;
 constructor(private home: string) { clearCheckpointUploads(home); }
 close(): void {
  const a = this.active; if (!a) return;
  a.cancelled = true;
  // An in-flight reader retains sole FD ownership until its commit settles.
  // Closing here could let the OS reuse that number for another tenant's file.
  if (!a.committing) closeSync(a.fd);
  rmSync(a.file, { force: true }); this.active = null;
 }
 async accept(kind: string, payload: unknown, commit: (bytes: Buffer) => Promise<void>): Promise<void> {
  return this.acceptStream(kind, payload, async chunks => { const bytes: Buffer[] = []; for await (const chunk of chunks) bytes.push(chunk); await commit(Buffer.concat(bytes)); });
 }
 async acceptStream(kind: string, payload: unknown, commit: (chunks: AsyncIterable<Buffer>) => Promise<void>): Promise<void> {
  if (typeof payload !== "string" || payload.length > CHECKPOINT_PAGE_BYTES * 1.4 + 256) throw new Error("checkpoint frame exceeds its bound");
  try {
   if (kind === "begin") {
    const m = JSON.parse(payload) as { bytes?: unknown; sha256?: unknown };
    if (!Number.isSafeInteger(m.bytes) || Number(m.bytes) < 1 || typeof m.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(m.sha256)) throw new Error("checkpoint manifest refused");
    this.close(); mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const file = path.join(this.home, `.perp-checkpoint-${randomUUID()}`);
    const fd = openSync(file, "wx+", 0o600);
    this.active = { file, fd, bytes: Number(m.bytes), hash: m.sha256, received: 0, pages: 0, digest: createHash("sha256"), committing: false, cancelled: false }; return;
   }
   const a = this.active; if (!a) throw new Error("checkpoint upload has no manifest");
   if (kind === "page") {
    const m = JSON.parse(payload) as { index?: unknown; data?: unknown };
    if (m.index !== a.pages || typeof m.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(m.data)) throw new Error("checkpoint page order refused");
    const bytes = Buffer.from(m.data, "base64");
    if (bytes.length !== Math.min(CHECKPOINT_PAGE_BYTES, a.bytes - a.received) || bytes.length < 1) throw new Error("checkpoint page length refused");
    writeSync(a.fd, bytes); a.digest.update(bytes); a.received += bytes.length; a.pages++; return;
   }
   if (kind !== "commit" || a.received !== a.bytes || a.digest.digest("hex") !== a.hash) throw new Error("checkpoint upload incomplete");
   a.committing = true;
   // Synchronous bounded reads have no queued fs operation that could outlive
   // this descriptor's ownership. Cancellation is checked across every yield.
   let consumed = false;
   const read = async function* () {
    const digest = createHash("sha256");
    for (let position = 0; position < a.bytes;) {
     if (a.cancelled) throw new Error("checkpoint upload cancelled");
     const chunk = Buffer.allocUnsafe(Math.min(CHECKPOINT_PAGE_BYTES, a.bytes - position));
     const n = readSync(a.fd, chunk, 0, chunk.length, position);
     if (!n) throw new Error("checkpoint file was truncated");
     const bytes = chunk.subarray(0, n); digest.update(bytes); position += n; yield bytes;
    }
    if (a.cancelled) throw new Error("checkpoint upload cancelled");
    if (digest.digest("hex") !== a.hash) throw new Error("checkpoint file content changed");
    consumed = true;
   };
   try { await commit(read()); if (a.cancelled || !consumed) throw new Error("checkpoint upload cancelled or not consumed"); }
   finally { closeSync(a.fd); rmSync(a.file, { force: true }); if (this.active === a) this.active = null; }
  } catch (error) { this.close(); throw error; }
 }
}

export function clearCheckpointUploads(home: string): void {
 let files: string[]; try { files = readdirSync(home); } catch { return; }
 for (const file of files) if (/^\.perp-checkpoint-[a-f0-9-]{36}$/.test(file)) rmSync(path.join(home, file), { force: true });
}
