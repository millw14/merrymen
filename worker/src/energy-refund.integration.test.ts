/**
 * A REFUND SURVIVES THE ROUND TRIP THAT USED TO UNDO IT.
 *
 * The review finding: the orchestrator mirrors a claim while an autonomous
 * trade is awaiting execution; the trade is then refused and the child hands
 * the claim back. The refund DECREMENTED the child's row, and every copy merges
 * by taking the larger value — so shared kept the higher count for good, and
 * the next rebuild seeded it back: a trade the agent never made, spent against
 * a low-energy day.
 *
 * Driven here end to end over real sqlite with the real statements: the
 * child's REAL store (claimEnergy / refundEnergy / getEnergyDay, the way the
 * tick calls them) in its own home, the real mirror (mirrorTenant) up to a
 * shared ledger migrated by the real schema, and the real seed
 * (seedEnergyDays, what seedEnergyForChild runs) into a rebuilt child.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { wrapSqlite } from "./db";
import { claimEnergyDay, readEnergyDay, readEnergyDaysSince } from "./energy-days";
import { energyPlan, utcDay } from "./energy";
import { seedEnergyDays } from "./energy-seed";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-energy-refund-"));
const HOME = path.join(scratch, "child");
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = HOME;
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("./store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
// The orchestrator's read-side handle on the child's ledger, as the mirror opens it.
const childRaw = new DatabaseSync(path.join(HOME, "merrymen.db"), { readOnly: true });
const child = wrapSqlite(childRaw);
// Shared, migrated by the same schema and ALTERs the mirror applies to Postgres every pass.
const sharedRaw = new DatabaseSync(":memory:");
const shared = wrapSqlite(sharedRaw);
await store.applyLedgerSchema(shared);
sharedRaw.exec(MIRROR_STATE_DDL);

after(() => {
  childRaw.close();
  sharedRaw.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const AGENT = "0xa96bf429888e1aab4255762d17d29c53f6a0370d";
/** The agents row the mirror's snapshot pass needs before it copies anything (it is armed). */
const armed = (raw: DatabaseSync, account: string) =>
  raw
    .prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, '0xo', '0xs', 4663, '{}', 1, 2)")
    .run(account);
{
  const w = new DatabaseSync(path.join(HOME, "merrymen.db"));
  armed(w, AGENT);
  w.close();
}
const NOW = Math.floor(Date.now() / 1000);
const TODAY = utcDay(NOW);
const mirror = async () => {
  const r = await mirrorTenant({ tenant: "0xten", child, shared, nowSec: NOW });
  assert.equal(r.failed?.energy_days, undefined, JSON.stringify(r.failed));
  assert.ok(r.copied.energy_days, "the energy block ran");
};

describe("claim → mirror → refund → mirror → rebuild", () => {
  it("THE REBUILT CHILD'S DAY IS THE NET — one used, not the two the first mirror saw", async () => {
    // Two new trades claimed; both ops await execution when the mirror runs.
    assert.equal(await store.claimEnergy(AGENT, TODAY, "entries", 2), true);
    assert.equal(await store.claimEnergy(AGENT, TODAY, "entries", 2), true);
    await mirror();
    // The second is refused at execution and its claim handed back.
    await store.refundEnergy(AGENT, TODAY, "entries");
    assert.equal((await store.getEnergyDay(AGENT, TODAY))!.entries, 1);
    await mirror();
    assert.deepEqual(
      { ...(sharedRaw.prepare("SELECT entries, entries_refunded FROM energy_days WHERE agent_id = ? AND day = ?").get(AGENT, TODAY) as object) },
      { entries: 2, entries_refunded: 1 },
      "shared carries the claim AND the refund — both only ever rose",
    );
    assert.equal((await readEnergyDay(shared, AGENT, TODAY)).entries, 1);

    // ── a redeploy: the child is rebuilt empty and seeded ──
    const rebuiltRaw = new DatabaseSync(":memory:");
    const rebuilt = wrapSqlite(rebuiltRaw);
    const r = await seedEnergyDays({ home: path.join(scratch, "rebuilt"), agent: AGENT, nowSec: NOW, when: "spawn", local: () => rebuilt, shared: async () => shared });
    assert.equal(r.ok, true, r.ok ? "" : r.why);
    const counters = await readEnergyDay(rebuilt, AGENT, TODAY);
    assert.equal(counters.entries, 1, "the refund came back down with the claim");
    const plan = energyPlan({ mode: "enforce", level: "low", counters, reviewsAllowed: 29, entriesAllowed: 2, nowSec: NOW });
    assert.equal(plan.entries.open, true);
    assert.equal(plan.entries.left, 1, "the handed-back claim is still today's to use");
    assert.equal(await claimEnergyDay(rebuilt, AGENT, TODAY, "entries", 2), true);
    assert.equal(await claimEnergyDay(rebuilt, AGENT, TODAY, "entries", 2), false, "and then the day is spent");

    // The copies keep converging: the rebuilt child's later claim goes up,
    // and neither side can lower the other.
    const rows = await readEnergyDaysSince(rebuilt, AGENT, TODAY);
    assert.deepEqual(rows.map((x) => [x.entries, x.entriesRefunded]), [[3, 1]]);
    rebuiltRaw.close();
  });
});

describe("the claim counts the day's USE", () => {
  it("AFTER A REFUND, TEN RACERS AGAINST THE CAP: EXACTLY ONE WINS", async () => {
    const a = "0x00000000000000000000000000000000000000a2";
    assert.equal(await store.claimEnergy(a, TODAY, "entries", 2), true);
    assert.equal(await store.claimEnergy(a, TODAY, "entries", 2), true);
    await store.refundEnergy(a, TODAY, "entries");
    const wins = await Promise.all(Array.from({ length: 10 }, () => store.claimEnergy(a, TODAY, "entries", 2)));
    assert.equal(wins.filter(Boolean).length, 1);
    assert.equal((await store.getEnergyDay(a, TODAY))!.entries, 2);
  });

  it("REFUNDS NEVER TAKE IT BELOW ZERO, however many race", async () => {
    const a = "0x00000000000000000000000000000000000000a3";
    assert.equal(await store.claimEnergy(a, TODAY, "entries", 2), true);
    await Promise.all(Array.from({ length: 5 }, () => store.refundEnergy(a, TODAY, "entries")));
    assert.equal((await store.getEnergyDay(a, TODAY))!.entries, 0);
    const raw = new DatabaseSync(path.join(HOME, "merrymen.db"), { readOnly: true });
    try {
      assert.deepEqual({ ...(raw.prepare("SELECT entries, entries_refunded FROM energy_days WHERE agent_id = ?").get(a) as object) }, { entries: 1, entries_refunded: 1 });
    } finally {
      raw.close();
    }
    assert.equal(await store.claimEnergy(a, TODAY, "entries", 1), true, "the refunded claim can be used again");
    assert.equal(await store.claimEnergy(a, TODAY, "entries", 1), false);
  });

  it("reviews are never refunded, and a refund touches only entries", async () => {
    const a = "0x00000000000000000000000000000000000000a4";
    assert.equal(await store.claimEnergy(a, TODAY, "reviews", 3), true);
    assert.equal(await store.claimEnergy(a, TODAY, "entries", 3), true);
    await store.refundEnergy(a, TODAY, "entries");
    assert.deepEqual(await store.getEnergyDay(a, TODAY), { reviews: 1, entries: 0, toldAt: null });
  });
});

describe("a child ledger from before the refund counter", () => {
  it("GAINS THE COLUMN, ITS ROWS READ AS THEY DID, AND IT MIRRORS", async () => {
    // A ledger the previous release built: every table, energy_days in its old shape.
    const oldRaw = new DatabaseSync(":memory:");
    const old = wrapSqlite(oldRaw);
    await store.applyLedgerSchema(old);
    oldRaw.exec("DROP TABLE energy_days");
    oldRaw.exec(
      "CREATE TABLE energy_days (agent_id TEXT NOT NULL, day TEXT NOT NULL, reviews INTEGER NOT NULL DEFAULT 0, entries INTEGER NOT NULL DEFAULT 0," +
        " told_at INTEGER, read_at INTEGER, read_full INTEGER, PRIMARY KEY (agent_id, day))",
    );
    armed(oldRaw, "0xold");
    // Written by the old code: two claimed, one refunded by decrement.
    oldRaw.prepare("INSERT INTO energy_days (agent_id, day, reviews, entries) VALUES (?, ?, 2, 1)").run("0xold", TODAY);
    // The mirror copies it as it stands, before any ALTER.
    const r = await mirrorTenant({ tenant: "0xold-ten", child: old, shared, nowSec: NOW });
    assert.equal(r.failed?.energy_days, undefined, JSON.stringify(r.failed));
    assert.equal(r.copied.energy_days, 1);
    assert.equal((await readEnergyDay(shared, "0xold", TODAY)).entries, 1);
    // The store migrates it as it boots (SQLITE_ALTERS), and the seed does too.
    await store.applyLedgerSchema(old);
    assert.deepEqual(await readEnergyDay(old, "0xold", TODAY), { reviews: 2, entries: 1, toldAt: null });
    oldRaw.close();
  });
});
