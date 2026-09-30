/** Bounded authenticated pages for full financial histories and shutdown journals. */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db } from "../db";

export const CHECKPOINT_PAGE_BYTES = 512 * 1024;
export const PAGED_CHECKPOINT_SCHEMA = `CREATE TABLE IF NOT EXISTS perp_checkpoint_manifests (
 snapshot_id TEXT PRIMARY KEY, manifest TEXT NOT NULL, ownership_tag TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS perp_checkpoint_pages (
 snapshot_id TEXT NOT NULL, page_index BIGINT NOT NULL, payload TEXT NOT NULL,
 PRIMARY KEY (snapshot_id, page_index)
);`;

export interface PagedCheckpointBinding {
 id: string; tenant: string; smartAccount: string; generation: number;
}
interface Manifest { v: 1; pages: number; bytes: number; sha256: string }
const POINTER = /^pp1\.([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export function isPagedCheckpoint(pointer: string): boolean { return POINTER.test(pointer); }
function checkBinding(b: PagedCheckpointBinding): void {
 if (typeof b.id !== "string" || !b.id || b.id.length > 256 || !/^0x[0-9a-f]{40}$/i.test(b.tenant) || !/^0x[0-9a-f]{40}$/i.test(b.smartAccount) || !Number.isSafeInteger(b.generation) || b.generation < 1) throw new Error("paged checkpoint binding refused");
}
function pointerOf(b: PagedCheckpointBinding, pointer: string): { generation: number; snapshot: string } {
 checkBinding(b);
 const parts = POINTER.exec(pointer), generation = Number(parts?.[1]);
 if (!parts || !Number.isSafeInteger(generation) || generation > b.generation) throw new Error("paged checkpoint generation refused");
 return { generation, snapshot: parts[2]! };
}
function aad(b: PagedCheckpointBinding, generation: number, snapshot: string, part: string): Buffer {
 return Buffer.from(JSON.stringify(["merrymen-financial-pages-v1", b.id, b.tenant.toLowerCase(), b.smartAccount.toLowerCase(), generation, snapshot, part]));
}
/** Independent from manifest ciphertext so damaged payloads can still be retired safely. */
function ownershipTag(b: PagedCheckpointBinding, generation: number, snapshot: string, dek: Buffer): Buffer {
 const key = createHmac("sha256", dek).update("merrymen-checkpoint-retirement-key-v1").digest();
 return createHmac("sha256", key).update(aad(b, generation, snapshot, "ownership")).digest();
}
function seal(bytes: Buffer, dek: Buffer, bound: Buffer): string {
 const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", dek, iv); c.setAAD(bound);
 const encrypted = Buffer.concat([c.update(bytes), c.final()]);
 return [iv.toString("base64url"), c.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
function open(text: string, dek: Buffer, bound: Buffer, maxBytes: number): Buffer {
 try {
  if (typeof text !== "string" || text.length > Math.ceil(maxBytes * 4 / 3) + 64) throw new Error();
  const [iv, tag, payload, extra] = text.split(".");
  if (extra !== undefined || !iv || !tag || payload === undefined || !/^[A-Za-z0-9_-]+$/.test(iv) || !/^[A-Za-z0-9_-]+$/.test(tag) || !/^[A-Za-z0-9_-]*$/.test(payload)) throw new Error();
  const ivBytes = Buffer.from(iv, "base64url"), tagBytes = Buffer.from(tag, "base64url");
  if (ivBytes.length !== 12 || tagBytes.length !== 16) throw new Error();
  const d = createDecipheriv("aes-256-gcm", dek, ivBytes); d.setAAD(bound); d.setAuthTag(tagBytes);
  const bytes = Buffer.concat([d.update(Buffer.from(payload, "base64url")), d.final()]);
  if (bytes.length > maxBytes) throw new Error();
  return bytes;
 } catch { throw new Error("paged checkpoint authentication failed"); }
}
async function readOwnedManifest(db: Db, b: PagedCheckpointBinding, pointer: string, dek: Buffer) {
 const ref = pointerOf(b, pointer);
 const row = await db.prepare("SELECT manifest, ownership_tag FROM perp_checkpoint_manifests WHERE snapshot_id = ?").get(ref.snapshot) as { manifest: string; ownership_tag: string } | undefined;
 if (!row) throw new Error("paged checkpoint manifest is missing");
 if (typeof row.ownership_tag !== "string" || !/^[0-9a-f]{64}$/.test(row.ownership_tag) ||
   !timingSafeEqual(Buffer.from(row.ownership_tag, "hex"), ownershipTag(b, ref.generation, ref.snapshot, dek))) throw new Error("paged checkpoint ownership authentication failed");
 return { ...ref, row };
}
async function readManifest(db: Db, b: PagedCheckpointBinding, pointer: string, dek: Buffer) {
 const { row, ...ref } = await readOwnedManifest(db, b, pointer, dek);
 const manifest = JSON.parse(open(row.manifest, dek, aad(b, ref.generation, ref.snapshot, "manifest"), 4096).toString("utf8")) as Manifest;
 if (manifest.v !== 1 || !Number.isSafeInteger(manifest.pages) || manifest.pages < 0 || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 || manifest.pages !== Math.ceil(manifest.bytes / CHECKPOINT_PAGE_BYTES) || !/^[0-9a-f]{64}$/.test(manifest.sha256) || Object.keys(manifest).some(k => !["v", "pages", "bytes", "sha256"].includes(k))) throw new Error("paged checkpoint manifest is invalid");
 return { ...ref, manifest };
}

/**
 * The caller supplies its authority-fenced transaction and publishes the returned
 * pointer in that SAME transaction. A failed page or pointer write rolls back the
 * whole snapshot. No nested transaction and no arbitrary total-history limit.
 */
export async function savePagedCheckpoint(db: Db, b: PagedCheckpointBinding, bytes: Buffer, dek: Buffer): Promise<string> {
 return savePagedCheckpointStream(db, b, [bytes], dek);
}

/** Streaming capture adapter. It retains at most one plaintext page at a time. */
export async function savePagedCheckpointStream(db: Db, b: PagedCheckpointBinding, chunks: Iterable<Buffer> | AsyncIterable<Buffer>, dek: Buffer): Promise<string> {
 checkBinding(b);
 const snapshot = randomUUID(), hash = createHash("sha256");
 let index = 0, total = 0, pending = Buffer.allocUnsafe(CHECKPOINT_PAGE_BYTES), used = 0;
 const write = async (page: Buffer) => {
  hash.update(page); total += page.length;
  if (!Number.isSafeInteger(total)) throw new Error("paged checkpoint byte count exceeds the exact integer range");
  await db.prepare("INSERT INTO perp_checkpoint_pages (snapshot_id, page_index, payload) VALUES (?, ?, ?)")
   .run(snapshot, index, seal(page, dek, aad(b, b.generation, snapshot, `page:${index}`)));
  index++;
 };
 for await (const chunk of chunks) {
  if (!Buffer.isBuffer(chunk)) throw new Error("paged checkpoint source must yield bytes");
  for (let offset = 0; offset < chunk.length;) {
   const take = Math.min(chunk.length - offset, CHECKPOINT_PAGE_BYTES - used);
   chunk.copy(pending, used, offset, offset + take); used += take; offset += take;
   if (used === CHECKPOINT_PAGE_BYTES) { await write(pending); used = 0; }
  }
 }
 if (used) await write(pending.subarray(0, used));
 pending = Buffer.alloc(0);
 const manifest: Manifest = { v: 1, pages: index, bytes: total, sha256: hash.digest("hex") };
 // Only complete page sets acquire a manifest. The manifest authenticates the
 // exact byte count, order and content; page AAD prevents swaps and splicing.
 await db.prepare("INSERT INTO perp_checkpoint_manifests (snapshot_id, manifest, ownership_tag) VALUES (?, ?, ?)")
  .run(snapshot, seal(Buffer.from(JSON.stringify(manifest)), dek, aad(b, b.generation, snapshot, "manifest")), ownershipTag(b, b.generation, snapshot, dek).toString("hex"));
 return `pp1.${b.generation}.${snapshot}`;
}

/**
 * Streaming reader: each yielded page is authenticated. Callers restoring rows
 * must hold a transaction and commit only after the iterator has been exhausted,
 * when the complete byte count and digest have also been verified.
 */
export async function* readPagedCheckpoint(db: Db, b: PagedCheckpointBinding, pointer: string, dek: Buffer): AsyncGenerator<Buffer> {
 const { snapshot, generation, manifest } = await readManifest(db, b, pointer, dek);
 const count = await db.prepare("SELECT COUNT(*) AS n FROM perp_checkpoint_pages WHERE snapshot_id = ?").get(snapshot) as { n: number };
 if (Number(count.n) !== manifest.pages) throw new Error("paged checkpoint page set is incomplete");
 const hash = createHash("sha256"); let total = 0;
 for (let index = 0; index < manifest.pages; index++) {
  const row = await db.prepare("SELECT payload FROM perp_checkpoint_pages WHERE snapshot_id = ? AND page_index = ?").get(snapshot, index) as { payload: string } | undefined;
  if (!row) throw new Error("paged checkpoint page is missing");
  const bytes = open(row.payload, dek, aad(b, generation, snapshot, `page:${index}`), CHECKPOINT_PAGE_BYTES);
  const expected = Math.min(CHECKPOINT_PAGE_BYTES, manifest.bytes - total);
  if (bytes.length !== expected) throw new Error("paged checkpoint page length is invalid");
  hash.update(bytes); total += bytes.length;
  yield bytes;
 }
 if (total !== manifest.bytes || hash.digest("hex") !== manifest.sha256) throw new Error("paged checkpoint complete digest is invalid");
}

/** Compatibility adapter; streaming callers should consume readPagedCheckpoint. */
export async function loadPagedCheckpoint(db: Db, b: PagedCheckpointBinding, pointer: string, dek: Buffer): Promise<Buffer> {
 const pages: Buffer[] = [];
 for await (const page of readPagedCheckpoint(db, b, pointer, dek)) pages.push(page);
 return Buffer.concat(pages);
}

/** Delete the previous snapshot in the same transaction that publishes its replacement. */
export async function deletePagedCheckpoint(db: Db, b: PagedCheckpointBinding, pointer: string, dek: Buffer): Promise<void> {
 const { snapshot } = await readOwnedManifest(db, b, pointer, dek);
 await db.prepare("DELETE FROM perp_checkpoint_pages WHERE snapshot_id = ?").run(snapshot);
 await db.prepare("DELETE FROM perp_checkpoint_manifests WHERE snapshot_id = ?").run(snapshot);
}
