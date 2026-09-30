import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { wrapSqlite } from "../db";
import { CHECKPOINT_PAGE_BYTES, PAGED_CHECKPOINT_SCHEMA, savePagedCheckpoint, savePagedCheckpointStream, loadPagedCheckpoint, deletePagedCheckpoint, readPagedCheckpoint, type PagedCheckpointBinding } from "./hosted-financial-pages";

const DEK = Buffer.alloc(32, 31);
const binding: PagedCheckpointBinding = { id: "live:account", tenant: `0x${"11".repeat(20)}`, smartAccount: `0x${"22".repeat(20)}`, generation: 3 };
async function setup() {
 const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw); await db.exec(PAGED_CHECKPOINT_SCHEMA);
 await db.exec("CREATE TABLE published_checkpoint (id TEXT PRIMARY KEY, pointer TEXT NOT NULL)");
 return { raw, db };
}
describe("authenticated financial checkpoint pages", () => {
 it("preserves a history beyond 32MiB using bounded encrypted pages and a complete manifest", async () => {
  const { raw, db } = await setup(); try {
   const bytes = Buffer.alloc(33 * 1024 * 1024 + 19, 97); bytes.write("SIGNED_TEST_BYTES"); bytes.write("FINAL_JOURNAL_HASH", bytes.length - 18);
   const pointer = await db.tx(tx => savePagedCheckpoint(tx, binding, bytes, DEK));
   const rows = await db.prepare("SELECT payload FROM perp_checkpoint_pages ORDER BY page_index").all() as { payload: string }[];
   assert.ok(rows.length > 64);
   assert.ok(rows.every(row => row.payload.length < CHECKPOINT_PAGE_BYTES * 1.4 && !row.payload.includes("SIGNED_TEST_BYTES")));
   assert.deepEqual(await loadPagedCheckpoint(db, binding, pointer, DEK), bytes);
   let total = 0; for await (const page of readPagedCheckpoint(db, binding, pointer, DEK)) { assert.ok(page.length <= CHECKPOINT_PAGE_BYTES); total += page.length; }
   assert.equal(total, bytes.length);
  } finally { raw.close(); }
 });
 it("streams irregular capture chunks and restoration pages without assembling the history", async () => {
  const { raw, db } = await setup(); try {
   const expected = createHash("sha256"), actual = createHash("sha256"); let captured = 0;
   async function* source() {
    for (let i = 0; i < 1000; i++) {
     const bytes = Buffer.alloc(41_003 + i % 13, i % 251); captured += bytes.length; expected.update(bytes); yield bytes;
    }
   }
   const pointer = await db.tx(tx => savePagedCheckpointStream(tx, binding, source(), DEK));
   let restored = 0;
   for await (const bytes of readPagedCheckpoint(db, binding, pointer, DEK)) { restored += bytes.length; actual.update(bytes); }
   assert.ok(captured > 32 * 1024 * 1024); assert.equal(restored, captured); assert.equal(actual.digest("hex"), expected.digest("hex"));
  } finally { raw.close(); }
 });
 it("binding includes tenant, account, job, original generation, snapshot and page index", async () => {
  const { raw, db } = await setup(); try {
   const pointer = await db.tx(tx => savePagedCheckpoint(tx, binding, Buffer.alloc(CHECKPOINT_PAGE_BYTES + 20, 9), DEK));
   assert.equal((await loadPagedCheckpoint(db, { ...binding, generation: 4 }, pointer, DEK)).length, CHECKPOINT_PAGE_BYTES + 20);
   for (const b of [{ ...binding, tenant: `0x${"33".repeat(20)}` }, { ...binding, smartAccount: `0x${"33".repeat(20)}` }, { ...binding, id: "other" }, { ...binding, generation: 2 }]) {
    await assert.rejects(loadPagedCheckpoint(db, b, pointer, DEK));
    await assert.rejects(deletePagedCheckpoint(db, b, pointer, DEK));
   }
   await assert.rejects(loadPagedCheckpoint(db, binding, pointer.replace("pp1.3.", "pp1.2."), DEK));
   const row = await db.prepare("SELECT payload FROM perp_checkpoint_pages WHERE page_index = 0").get() as { payload: string };
   await db.prepare("UPDATE perp_checkpoint_pages SET payload = ? WHERE page_index = 1").run(row.payload);
   await assert.rejects(loadPagedCheckpoint(db, binding, pointer, DEK), /authentication/);
  } finally { raw.close(); }
 });
 it("missing, extra, corrupt and unpublished pages never produce a successful restore", async () => {
  const { raw, db } = await setup(); try {
   const pointer = await db.tx(tx => savePagedCheckpoint(tx, binding, Buffer.alloc(CHECKPOINT_PAGE_BYTES + 2, 5), DEK));
   await db.prepare("DELETE FROM perp_checkpoint_pages WHERE page_index = 1").run();
   await assert.rejects(loadPagedCheckpoint(db, binding, pointer, DEK), /incomplete/);
   const empty = await db.tx(tx => savePagedCheckpoint(tx, binding, Buffer.alloc(0), DEK));
   assert.equal((await loadPagedCheckpoint(db, binding, empty, DEK)).length, 0);
   const snapshot = empty.split(".")[2]!;
   await db.prepare("INSERT INTO perp_checkpoint_pages VALUES (?, 0, 'untrusted')").run(snapshot);
   await assert.rejects(loadPagedCheckpoint(db, binding, empty, DEK), /incomplete/);
   await assert.rejects(loadPagedCheckpoint(db, binding, "pp1.3.00000000-0000-4000-8000-000000000000", DEK), /missing/);
  } finally { raw.close(); }
 });
 it("page creation and pointer publication roll back atomically on lost authority", async () => {
  const { raw, db } = await setup(); try {
   await assert.rejects(db.tx(async tx => {
    const pointer = await savePagedCheckpoint(tx, binding, Buffer.from("new sensitive bytes"), DEK);
    await tx.prepare("INSERT INTO published_checkpoint VALUES ('owner', ?)").run(pointer);
    throw new Error("lease lost at publication");
   }), /lease lost/);
   for (const table of ["perp_checkpoint_pages", "perp_checkpoint_manifests", "published_checkpoint"]) {
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
   }
  } finally { raw.close(); }
 });
 it("terminal replacement removes prior encrypted replay pages and preserves the sanitized history", async () => {
  const { raw, db } = await setup(); try {
   const old = await db.tx(async tx => {
    const pointer = await savePagedCheckpoint(tx, binding, Buffer.from("old signed replay bytes"), DEK);
    await tx.prepare("INSERT INTO published_checkpoint VALUES ('owner', ?)").run(pointer); return pointer;
   });
   const next = await db.tx(async tx => {
    const pointer = await savePagedCheckpoint(tx, binding, Buffer.from("same exact journal; replay bytes erased"), DEK);
    await tx.prepare("UPDATE published_checkpoint SET pointer = ? WHERE id = 'owner'").run(pointer);
    await deletePagedCheckpoint(tx, binding, old, DEK); return pointer;
   });
   await assert.rejects(loadPagedCheckpoint(db, binding, old, DEK), /missing/);
   assert.equal((await loadPagedCheckpoint(db, binding, next, DEK)).toString(), "same exact journal; replay bytes erased");
   assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM perp_checkpoint_manifests").get() as { n: number }).n, 1);
  } finally { raw.close(); }
 });
 it("retirement authenticates ownership even when manifest ciphertext is corrupt", async () => {
  const { raw, db } = await setup(); try {
   const pointer = await db.tx(tx => savePagedCheckpoint(tx, binding, Buffer.from("signed bytes to expire"), DEK));
   await db.prepare("UPDATE perp_checkpoint_manifests SET manifest = 'corrupt'").run();
   await assert.rejects(loadPagedCheckpoint(db, binding, pointer, DEK), /authentication/);
   await assert.rejects(deletePagedCheckpoint(db, { ...binding, tenant: `0x${"44".repeat(20)}` }, pointer, DEK), /ownership/);
   await assert.rejects(deletePagedCheckpoint(db, binding, pointer, Buffer.alloc(32, 7)), /ownership/);
   assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM perp_checkpoint_pages").get() as { n: number }).n, 1);
   await db.tx(tx => deletePagedCheckpoint(tx, { ...binding, generation: 4 }, pointer, DEK));
   for (const table of ["perp_checkpoint_pages", "perp_checkpoint_manifests"]) assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
  } finally { raw.close(); }
 });
 it("a retirement tag cannot be spliced from another snapshot", async () => {
  const { raw, db } = await setup(); try {
   const a = await db.tx(tx => savePagedCheckpoint(tx, binding, Buffer.from("first"), DEK));
   const b = await db.tx(tx => savePagedCheckpoint(tx, binding, Buffer.from("second"), DEK));
   const tag = await db.prepare("SELECT ownership_tag FROM perp_checkpoint_manifests WHERE snapshot_id = ?").get(a.split(".")[2]) as { ownership_tag: string };
   await db.prepare("UPDATE perp_checkpoint_manifests SET ownership_tag = ? WHERE snapshot_id = ?").run(tag.ownership_tag, b.split(".")[2]);
   await assert.rejects(deletePagedCheckpoint(db, binding, b, DEK), /ownership/);
   await assert.rejects(loadPagedCheckpoint(db, binding, b, DEK), /ownership/);
   assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM perp_checkpoint_pages").get() as { n: number }).n, 2);
  } finally { raw.close(); }
 });
});
