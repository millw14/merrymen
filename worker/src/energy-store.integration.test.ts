/**
 * THE ENERGY COUNTERS, ON THE REAL LEDGER.
 *
 * A claim is one upsert, so a cap cannot be overrun by two claims arriving
 * together; a refund never takes a day below zero; the owner's notice is
 * claimed exactly once; the last good balance reading comes back newest-first.
 * Run against the child's own sqlite through the store, the way the tick
 * calls it.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-energy-store-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("./store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME, "merrymen.db"));

after(() => {
  raw.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const AGENT = "0x9999999999999999999999999999999999999999";
let n = 0;
const agent = () => `${AGENT.slice(0, -4)}${String(++n).padStart(4, "0")}`;
const DAY = "2026-09-27";

describe("a claim respects its cap", () => {
  it("three under a cap of three, then refused", async () => {
    const a = agent();
    assert.equal(await store.claimEnergy(a, DAY, "entries", 3), true);
    assert.equal(await store.claimEnergy(a, DAY, "entries", 3), true);
    assert.equal(await store.claimEnergy(a, DAY, "entries", 3), true);
    assert.equal(await store.claimEnergy(a, DAY, "entries", 3), false);
    assert.deepEqual(await store.getEnergyDay(a, DAY), { reviews: 0, entries: 3, toldAt: null });
  });

  it("TEN CONCURRENT CLAIMS AGAINST A CAP OF THREE: EXACTLY THREE WIN", async () => {
    const a = agent();
    const wins = await Promise.all(Array.from({ length: 10 }, () => store.claimEnergy(a, DAY, "reviews", 3)));
    assert.equal(wins.filter(Boolean).length, 3);
    assert.equal((await store.getEnergyDay(a, DAY))!.reviews, 3);
  });

  it("the two counters and two days are separate", async () => {
    const a = agent();
    assert.equal(await store.claimEnergy(a, DAY, "reviews", 1), true);
    assert.equal(await store.claimEnergy(a, DAY, "entries", 1), true);
    assert.equal(await store.claimEnergy(a, DAY, "reviews", 1), false);
    assert.equal(await store.claimEnergy(a, "2026-09-28", "reviews", 1), true, "a new UTC day is a new allowance");
  });

  it("a cap below one never writes a row", async () => {
    const a = agent();
    assert.equal(await store.claimEnergy(a, DAY, "entries", 0), false);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM energy_days WHERE agent_id = ?").get(a)!.n, 0);
  });
});

describe("a refund", () => {
  it("gives one back, and never goes below zero", async () => {
    const a = agent();
    await store.claimEnergy(a, DAY, "entries", 2);
    await store.refundEnergy(a, DAY, "entries");
    await store.refundEnergy(a, DAY, "entries");
    await store.refundEnergy(a, DAY, "entries");
    assert.equal((await store.getEnergyDay(a, DAY))!.entries, 0);
    assert.equal(await store.claimEnergy(a, DAY, "entries", 2), true, "the refunded claim can be used again");
  });
});

describe("the owner's notice", () => {
  it("is claimed exactly once per day", async () => {
    const a = agent();
    assert.equal(await store.claimEnergyNotice(a, DAY, 1_000), true);
    assert.equal(await store.claimEnergyNotice(a, DAY, 2_000), false);
    assert.equal((await store.getEnergyDay(a, DAY))!.toldAt, 1_000, "the first stamp stands");
    assert.equal(await store.claimEnergyNotice(a, "2026-09-28", 3_000), true);
  });

  it("and claims made before it do not disturb it, nor it them", async () => {
    const a = agent();
    await store.claimEnergy(a, DAY, "entries", 5);
    assert.equal(await store.claimEnergyNotice(a, DAY, 10), true);
    assert.deepEqual(await store.getEnergyDay(a, DAY), { reviews: 0, entries: 1, toldAt: 10 });
  });
});

describe("the last good reading", () => {
  it("comes back newest first, within the window", async () => {
    const a = agent();
    await store.noteEnergyRead(a, "2026-09-26", true, 100);
    await store.noteEnergyRead(a, DAY, false, 200);
    assert.deepEqual(await store.lastEnergyRead(a, 0), { full: false, at: 200 });
    assert.deepEqual(await store.lastEnergyRead(a, 201), null, "nothing inside the window");
  });

  it("an older reading never replaces a newer one on the same day", async () => {
    const a = agent();
    await store.noteEnergyRead(a, DAY, true, 500);
    await store.noteEnergyRead(a, DAY, false, 400);
    assert.deepEqual(await store.lastEnergyRead(a, 0), { full: true, at: 500 });
  });

  it("no reading at all is null, not 'not full'", async () => {
    assert.equal(await store.lastEnergyRead(agent(), 0), null);
  });
});

describe("a day with no row", () => {
  it("reads as zeros", async () => {
    assert.deepEqual(await store.getEnergyDay(agent(), DAY), { reviews: 0, entries: 0, toldAt: null });
  });
});

describe("the agents row carries the report", () => {
  it("setAgentEnergy writes the column; null clears it", async () => {
    const a = agent();
    raw.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, '0xo', '0xs', 4663, '{}', 1, 2)").run(a);
    await store.setAgentEnergy(a, JSON.stringify({ v: 1 }));
    assert.equal(raw.prepare("SELECT energy FROM agents WHERE smart_account = ?").get(a)!.energy, '{"v":1}');
    await store.setAgentEnergy(a, null);
    assert.equal(raw.prepare("SELECT energy FROM agents WHERE smart_account = ?").get(a)!.energy, null);
  });
});
