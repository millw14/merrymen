import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { it } from "node:test";
import { wrapSqlite } from "../../../worker/src/db";
import { LocalOwnerSponsorshipStore, SqlOwnerSponsorshipStore, ownerQuoteDigest, OWNER_SPONSOR_DAILY_QUOTES } from "./owner-sponsorship-store";

const OWNER = `0x${"17".repeat(20)}`;
const OTHER = `0x${"18".repeat(20)}`;
const NOW = Date.parse("2026-10-02T12:00:00Z");
const digest = (i: number) => createHash("sha256").update(String(i)).digest("hex");

it("serializes SQL reservations, deduplicates exact retries and rolls back incomplete accounting", async () => {
  const raw = new DatabaseSync(":memory:");
  try {
    const db = wrapSqlite(raw);
    const a = new SqlOwnerSponsorshipStore(async () => db, "sqlite");
    const b = new SqlOwnerSponsorshipStore(async () => db, "sqlite");
    assert.equal(await a.reserve(OWNER, digest(0), NOW), true);
    raw.exec("CREATE TRIGGER fail_quote BEFORE INSERT ON owner_gas_quotes BEGIN SELECT RAISE(ABORT, 'write failed'); END");
    await assert.rejects(a.reserve(OWNER, digest(1), NOW), /write failed/);
    raw.exec("DROP TRIGGER fail_quote");
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).reserve(OWNER, digest(i + 1), NOW)));
    assert.equal(results.filter(Boolean).length, OWNER_SPONSOR_DAILY_QUOTES - 1);
    assert.equal(await b.reserve(OWNER, digest(0), NOW), true, "an exact retry does not consume another slot");
    assert.equal(await b.reserve(OWNER, digest(99), NOW), false);
    assert.equal(await b.reserve(OTHER, digest(99), NOW), true);
    assert.equal(await b.reserve(OWNER, digest(99), NOW + 86400000), true);
  } finally { raw.close(); }
});

it("shares the last owner slot across separate processes and preserves it after restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "merrymen-owner-budget-"));
  const run = promisify(execFile);
  try {
    const store = new LocalOwnerSponsorshipStore(home);
    for (let i = 0; i < OWNER_SPONSOR_DAILY_QUOTES - 1; i++) assert.equal(await store.reserve(OWNER, digest(i), NOW), true);
    const child = (i: number) => run(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "-e",
      `import { LocalOwnerSponsorshipStore } from './web/src/lib/owner-sponsorship-store';
       new LocalOwnerSponsorshipStore(${JSON.stringify(home)}).reserve(${JSON.stringify(OWNER)}, ${JSON.stringify(digest(i))}, ${NOW}).then(v => console.log(v));`,
    ], { cwd: process.cwd(), env: { ...process.env, MERRYMEN_HOME: home, DATABASE_URL: "", MERRYMEN_HOSTED: "" } });
    const results = await Promise.all([child(100), child(101), child(102), child(103)]);
    assert.equal(results.filter((r) => r.stdout.trim() === "true").length, 1);
    assert.equal((await child(200)).stdout.trim(), "false");
    assert.equal(await new LocalOwnerSponsorshipStore(home).reserve(OWNER, digest(0), NOW), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("binds cross-chain operations and changed gas while ignoring renewed sponsor data/signatures", () => {
  const op = { sender: OWNER, nonce: "0x0", callData: "0x1234", callGasLimit: "0x100", maxFeePerGas: "0x100" };
  const base = ownerQuoteDigest(op, 4663);
  assert.equal(ownerQuoteDigest({ ...op, signature: "0x1234", paymasterData: "0xabcd" }, 4663), base);
  assert.equal(ownerQuoteDigest({ ...op, nonce: "0x00" }, 4663), base);
  assert.notEqual(ownerQuoteDigest(op, 46630), base);
  for (const patch of [{ nonce: "0x1" }, { maxFeePerGas: "0x101" }, { callGasLimit: "0x101" }, { callData: "0x1235" }, { factoryData: "0x1234" }]) {
    assert.notEqual(ownerQuoteDigest({ ...op, ...patch }, 4663), base);
  }
});

it("does not authorize quotes when durable storage is unavailable", async () => {
  let attempts = 0;
  const store = new SqlOwnerSponsorshipStore(async () => { attempts++; throw new Error("offline"); });
  await assert.rejects(store.reserve(OWNER, digest(0), NOW), /offline/);
  await assert.rejects(store.reserve(OWNER, digest(0), NOW), /offline/);
  assert.equal(attempts, 2, "a failed initialization can retry without pretending the budget was reserved");
});
