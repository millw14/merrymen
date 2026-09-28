/**
 * A SEED THAT FAILS DOES NOT HAND OUT A FRESH DAY.
 *
 * The review finding: in hosted enforce mode a transient shared-ledger or
 * schema failure while a child was rebuilt was logged, and the child started
 * with an EMPTY energy_days — so a low-energy agent got the day's reviews and
 * new trades again, once per redeploy that met the outage.
 *
 * Driven here with the real seed (seedEnergyDays, exactly what the
 * orchestrator's seedEnergyForChild runs), the child's REAL store over its own
 * sqlite in its own home (getEnergyDay and claimEnergy, the way the tick calls
 * them), sqlite standing in for shared Postgres, and the real plan:
 *
 *   a failed seed → today and yesterday read as unreadable → an enforcing,
 *   low-energy agent claims nothing new; full energy, observe and every exit
 *   are untouched → a later seed merges the durable history in, keeps what
 *   the child counted meanwhile, and only then clears the marker.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { wrapSqlite, type Db } from "./db";
import { ENERGY_DAYS_SCHEMA, mergeEnergyDayRow } from "./energy-days";
import { claimCap, countsAsEntry, energyPlan, utcDay } from "./energy";
import {
  ENERGY_UNRESTORED_FILE,
  clearEnergyUnrestored,
  energyDayUnrestored,
  energyUnrestoredPending,
  markEnergyUnrestored,
  seedEnergyDays,
} from "./energy-seed";

// The child's home, as childEnv sets MERRYMEN_HOME for it. No DATABASE_URL:
// a child never holds one; its store is its own sqlite.
const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-energy-seed-"));
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
// The orchestrator's own handle on the child's ledger, opened the way
// seedEnergyForChild opens it.
const localRaw = new DatabaseSync(path.join(HOME, "merrymen.db"));
localRaw.exec("PRAGMA busy_timeout = 250");
const local = wrapSqlite(localRaw);

after(() => {
  localRaw.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const AGENT = "0x9999999999999999999999999999999999990001";
const NOW = Math.floor(Date.parse("2026-09-28T15:00:00Z") / 1000);
const TODAY = utcDay(NOW);
const YESTERDAY = utcDay(NOW - 86_400);
const TOMORROW = utcDay(NOW + 86_400);

/** Shared Postgres, as the mirror left it before the redeploy: the day's two new trades used, three reviews, the notice sent. */
const sharedRaw = new DatabaseSync(":memory:");
sharedRaw.exec(ENERGY_DAYS_SCHEMA);
const shared = wrapSqlite(sharedRaw);
await mergeEnergyDayRow(shared, AGENT, { day: TODAY, reviews: 3, entries: 2, entriesRefunded: 0, toldAt: NOW - 3_600, readAt: NOW - 600, readFull: false });

const outage = () => Promise.reject(new Error("Connection terminated unexpectedly"));
const seed = (when: "spawn" | "retry", sharedDb: () => Promise<Db>, nowSec = NOW, localDb: () => Db = () => local) =>
  seedEnergyDays({ home: HOME, agent: AGENT, nowSec, when, local: localDb, shared: sharedDb });

/** Today's plan for a low-energy agent, from the store exactly as refreshEnergy reads it. */
const planFor = async (mode: "enforce" | "observe", level: "low" | "full" = "low") =>
  energyPlan({ mode, level, counters: await store.getEnergyDay(AGENT, TODAY), reviewsAllowed: 29, entriesAllowed: 2, nowSec: NOW });

describe("a seed that fails leaves the child armed — with today unreadable, not empty", () => {
  it("THE SPAWN'S FAILED SEED MARKS TODAY AND YESTERDAY, and the store reads them as unreadable", async () => {
    const r = await seed("spawn", outage);
    assert.equal(r.ok, false);
    assert.deepEqual(!r.ok && r.marked, [YESTERDAY, TODAY]);
    assert.equal(energyUnrestoredPending(HOME), true);
    assert.equal(await store.getEnergyDay(AGENT, TODAY), null, "not zeros: nobody knows what today used");
    assert.equal(await store.getEnergyDay(AGENT, YESTERDAY), null);
    assert.deepEqual(await store.getEnergyDay(AGENT, utcDay(NOW - 3 * 86_400)), { reviews: 0, entries: 0, toldAt: null }, "a day the seed never carries is not marked");
  });

  it("ENFORCE, LOW: no fresh allowance — reviews and new trades closed, and a claim writes nothing", async () => {
    const plan = await planFor("enforce");
    assert.equal(plan.enforce, true);
    assert.equal(plan.entries.open, false);
    assert.equal(plan.reviews.open, false);
    assert.equal(plan.entries.left, 0);
    // The strategy loop's hard filter claims without asking the plan first.
    const cap = claimCap(plan, "entries", NOW);
    assert.equal(cap, 0);
    assert.equal(await store.claimEnergy(AGENT, TODAY, "entries", cap!), false);
    assert.equal(await store.claimEnergy(AGENT, TODAY, "reviews", claimCap(plan, "reviews", NOW)!), false);
    assert.equal(localRaw.prepare("SELECT COUNT(*) AS n FROM energy_days WHERE agent_id = ?").get(AGENT)!.n, 0, "nothing counted against an empty row");
  });

  it("EXITS NEVER ASK: a sale, a withdrawal and the idle-cash sweep are not entries", () => {
    assert.equal(countsAsEntry("swap", true), false, "an exit, by the breaker's own test");
    assert.equal(countsAsEntry("vault-withdraw", true), false);
    assert.equal(countsAsEntry("vault-deposit", false), false);
  });

  it("FULL ENERGY, OBSERVE AND OFF ARE UNTOUCHED", async () => {
    const full = await planFor("enforce", "full");
    assert.equal(full.entries.open, true);
    assert.equal(full.reviews.open, true);
    assert.equal(claimCap(full, "entries", NOW), null, "a full agent claims nothing and needs no count");
    const obs = await planFor("observe");
    assert.equal(obs.entries.open, true);
    assert.equal(obs.reviews.open, true);
    // Observe counts and never refuses — here, one new trade while unrestored.
    assert.equal(await store.claimEnergy(AGENT, TODAY, "entries", claimCap(obs, "entries", NOW)!), true);
    const off = energyPlan({ mode: "off", level: "low", counters: null, reviewsAllowed: 0, entriesAllowed: 0, nowSec: NOW });
    assert.equal(off.entries.open, true);
    assert.equal(claimCap(off, "entries", NOW), null);
  });

  it("A RETRY THAT FAILS AGAIN leaves the marker exactly as it was — a later day is the child's own", async () => {
    const r = await seed("retry", outage, NOW + 86_400);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.marked, null);
    assert.equal(energyDayUnrestored(HOME, TODAY), true);
    assert.equal(energyDayUnrestored(HOME, TOMORROW), false, "tomorrow began on this child; its count is complete");
  });

  it("A MERGE THAT FAILS PART-WAY DOES NOT CLEAR THE MARKER", async () => {
    const brokenLocal: Db = {
      exec: (sql) => local.exec(sql),
      tx: (fn) => local.tx(fn),
      prepare: (sql) => {
        if (/^\s*INSERT INTO energy_days/.test(sql)) throw new Error("database is locked");
        return local.prepare(sql);
      },
    };
    const r = await seed("retry", async () => shared, NOW, () => brokenLocal);
    assert.equal(r.ok, false);
    assert.equal(energyUnrestoredPending(HOME), true);
    assert.equal(await store.getEnergyDay(AGENT, TODAY), null);
  });

  it("A LATER SEED PUTS THE HISTORY BACK, KEEPS WHAT THE CHILD COUNTED MEANWHILE, AND ONLY THEN CLEARS THE MARKER", async () => {
    // The observe claim above is on the child's row: entries 1 locally, 2 in shared.
    for (let i = 0; i < 5; i++) await store.claimEnergy(AGENT, TODAY, "reviews", Number.MAX_SAFE_INTEGER);
    const r = await seed("retry", async () => shared);
    assert.deepEqual(r, { ok: true, restored: 1 });
    assert.equal(energyUnrestoredPending(HOME), false);
    assert.deepEqual(await store.getEnergyDay(AGENT, TODAY), { reviews: 5, entries: 2, toldAt: NOW - 3_600 }, "the larger of each count, and the first notice stamp");
    // The durable history is back: the day's two new trades are spent again.
    const plan = await planFor("enforce");
    assert.equal(plan.entries.used, 2);
    assert.equal(plan.entries.open, false);
    assert.equal(plan.told, true, "and the owner is not told a second time");
    assert.equal(await store.claimEnergy(AGENT, TODAY, "entries", claimCap(plan, "entries", NOW)!), false);
  });

  it("a seed with nothing to restore still clears a marker", async () => {
    markEnergyUnrestored(HOME, [TODAY], NOW);
    const empty = new DatabaseSync(":memory:");
    const r = await seed("spawn", async () => wrapSqlite(empty), NOW + 5 * 86_400);
    assert.equal(r.ok, true);
    assert.equal(energyUnrestoredPending(HOME), false);
    empty.close();
  });
});

describe("the marker", () => {
  it("A CRASH-RESTART'S SECOND FAILURE KEEPS THE DAYS THE FIRST ONE MARKED", async () => {
    markEnergyUnrestored(HOME, ["2026-09-20", "2026-09-21"], NOW);
    const r = await seed("spawn", outage);
    assert.deepEqual(!r.ok && r.marked, ["2026-09-20", "2026-09-21", YESTERDAY, TODAY]);
    clearEnergyUnrestored(HOME);
  });

  it("ONE NOBODY CAN PARSE COVERS EVERY DAY; NONE COVERS NONE", () => {
    writeFileSync(path.join(HOME, ENERGY_UNRESTORED_FILE), "{ not json");
    assert.equal(energyDayUnrestored(HOME, TODAY), true);
    assert.equal(energyDayUnrestored(HOME, "2031-01-01"), true);
    writeFileSync(path.join(HOME, ENERGY_UNRESTORED_FILE), JSON.stringify({ v: 1, days: ["not-a-day"] }));
    assert.equal(energyDayUnrestored(HOME, TODAY), true);
    clearEnergyUnrestored(HOME);
    assert.equal(energyDayUnrestored(HOME, TODAY), false);
    assert.equal(energyUnrestoredPending(HOME), false);
    clearEnergyUnrestored(HOME); // clearing nothing is not an error
  });

  it("is written owner-only and whole", () => {
    markEnergyUnrestored(HOME, [TODAY], NOW);
    const text = readFileSync(path.join(HOME, ENERGY_UNRESTORED_FILE), "utf8");
    assert.deepEqual(JSON.parse(text), { v: 1, days: [TODAY], at: NOW });
    if (process.platform !== "win32") assert.equal(statSync(path.join(HOME, ENERGY_UNRESTORED_FILE)).mode & 0o777, 0o600);
    clearEnergyUnrestored(HOME);
  });
});

/**
 * WHERE THE ORCHESTRATOR RUNS IT: before every spawn (the pins in
 * energy-durability.test.ts), and again on every reconcile pass for a running
 * child whose marker stands.
 */
describe("the orchestrator retries a running child's seed", () => {
  const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
  const body = (name: string) => {
    const at = src.indexOf(`async function ${name}(`);
    return src.slice(at, src.indexOf("\n}\n", at));
  };

  it("EVERY RECONCILE PASS, FOR EVERY RUNNING CHILD", () => {
    const rec = body("reconcile");
    const loop = rec.slice(rec.indexOf("for (const tenant of children.keys()) {"));
    assert.match(loop.slice(0, loop.indexOf("\n  }\n")), /await retryEnergySeed\(tenant as `0x\$\{string\}`\);/);
  });

  it("only while the marker stands, as a retry, for the running child's own account", () => {
    const fn = body("retryEnergySeed");
    assert.match(fn, /!energyUnrestoredPending\(childHome\(tenant\)\)/);
    assert.match(fn, /await seedEnergyForChild\(tenant, child\.smartAccount, "retry"\);/);
  });

  it("the seed passes `when` through, and the child's ledger is opened inside the attempt", () => {
    const fn = body("seedEnergyForChild");
    assert.match(fn, /seedEnergyDays\(\{[\s\S]*when,[\s\S]*local: \(\) => \{/);
    assert.match(fn, /PRAGMA busy_timeout = 250/, "a retry beside a running child waits briefly for its lock, never long");
  });
});
