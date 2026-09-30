/**
 * A DAY'S ENERGY SURVIVES THE REDEPLOY THAT DESTROYS THE CHILD.
 *
 * A hosted child's sqlite has no volume: every redeploy empties it. Kept only
 * there, a low-energy agent's used reviews and new trades would reset with each
 * deploy — a fresh allowance per deploy — the day's notice would go again, and
 * a holder whose balance read full would be throttled after a restart during
 * an RPC outage, because the last good reading was gone.
 *
 * This drives the REAL round trip over real sqlite with the real statements:
 * child A counts and reads → the mirror carries it up → child A is destroyed →
 * the seed (planEnergySeed + the shared merge, exactly what seedEnergyForChild
 * runs) writes it into an EMPTY child B → B's plan shows the same used counts,
 * the same notice stamp and the same last-good. And then the pins that keep
 * seedEnergyForChild where it must be: inside the lease, after the basis seed,
 * before the spawn.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { wrapSqlite } from "./db";
import { ENERGY_FULL_RAW } from "../../packages/core/src/index";
import {
  ENERGY_DAYS_SCHEMA,
  claimEnergyDay,
  claimEnergyNoticeDay,
  lastEnergyReadDay,
  mergeEnergyDayRow,
  noteEnergyReadDay,
  readEnergyDay,
  readEnergyDaysSince,
} from "./energy-days";
import { energyLevel, energyPlan, planEnergySeed, utcDay } from "./energy";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";

const AGENT = "0xa96bf429888e1aab4255762d17d29c53f6a0370d";
const NOW = Math.floor(Date.parse("2026-09-27T15:00:00Z") / 1000);
const TODAY = utcDay(NOW);

/** Enough of the ledger for the snapshot pass to reach its energy block. */
const SCHEMA = [
  "CREATE TABLE agents (smart_account TEXT PRIMARY KEY, name TEXT, owner_address TEXT, session_key_address TEXT," +
    " chain_id INTEGER, caps TEXT, granted_at INTEGER, expires_at INTEGER, status TEXT, created_at INTEGER, mode TEXT," +
    " beat_at INTEGER, sponsor_gas INTEGER, live_blocker TEXT, x_handle TEXT, x_verified INTEGER DEFAULT 0," +
    " epoch INTEGER DEFAULT 1, hwm_usdg REAL DEFAULT 0, hwm_withdrawn_usdg REAL NOT NULL DEFAULT 0," +
    " accrued_fee_usdg REAL DEFAULT 0, contributions_known INTEGER, contributions_why TEXT, gas_accounting TEXT," +
    " quality_at INTEGER, energy TEXT);",
  "CREATE TABLE positions (agent_id TEXT, symbol TEXT, token TEXT, raw_balance TEXT, ui_multiplier TEXT," +
    " price_usd REAL, price_stale INTEGER, price_source TEXT DEFAULT 'chainlink', value_usdg REAL," +
    " updated_at INTEGER, PRIMARY KEY (agent_id, symbol));",
  "CREATE TABLE cost_basis (agent_id TEXT, mode TEXT, symbol TEXT, qty_raw TEXT, cost_usdg TEXT," +
    " updated_at INTEGER, PRIMARY KEY (agent_id, mode, symbol));",
  "CREATE TABLE position_floors (agent_id TEXT, mode TEXT, symbol TEXT, stop_bps INTEGER, rung INTEGER," +
    " why TEXT, at INTEGER, PRIMARY KEY (agent_id, mode, symbol));",
  "CREATE TABLE class_positions (agent_id TEXT, token TEXT, symbol TEXT, decimals INTEGER DEFAULT 18," +
    " curve TEXT, quote_token TEXT, first_seen INTEGER, vault TEXT, entry_tx TEXT, exit_tx TEXT," +
    " cost_usdg TEXT, qty_raw TEXT, proceeds_usdg TEXT, opened_at_block TEXT, state TEXT DEFAULT 'open'," +
    " swept_raw TEXT, PRIMARY KEY (agent_id, token));",
  ENERGY_DAYS_SCHEMA + ";",
].join("\n");

const open = (ddl: string) => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(ddl);
  return { raw, db: wrapSqlite(raw) };
};

/** Exactly what seedEnergyForChild does, over sqlite standing in for shared Postgres. */
const seed = async (child: ReturnType<typeof open>["db"], shared: ReturnType<typeof open>["db"]) => {
  const sinceDay = utcDay(NOW - 86_400);
  const plan = planEnergySeed({
    shared: await readEnergyDaysSince(shared, AGENT, sinceDay),
    child: await readEnergyDaysSince(child, AGENT, sinceDay),
    sinceDay,
  });
  for (const row of plan) await mergeEnergyDayRow(child, AGENT, row);
  return plan.length;
};

describe("a redeploy does not hand out a fresh allowance", () => {
  it("COUNTERS, THE NOTICE AND THE LAST GOOD READING ALL COME BACK", async () => {
    // ── child A lives a low-energy afternoon ──
    const a = open(SCHEMA);
    a.raw.exec(`INSERT INTO agents (smart_account, name, epoch) VALUES ('${AGENT}','Robin',1)`);
    for (let i = 0; i < 4; i++) assert.equal(await claimEnergyDay(a.db, AGENT, TODAY, "reviews", 29), true);
    assert.equal(await claimEnergyDay(a.db, AGENT, TODAY, "entries", 2), true);
    assert.equal(await claimEnergyDay(a.db, AGENT, TODAY, "entries", 2), true);
    assert.equal(await claimEnergyNoticeDay(a.db, AGENT, TODAY, NOW - 600), true);
    await noteEnergyReadDay(a.db, AGENT, TODAY, true, NOW - 120);

    // ── the mirror carries it up ──
    const shared = open(SCHEMA + MIRROR_STATE_DDL);
    const r = await mirrorTenant({ tenant: "0xten", child: a.db, shared: shared.db, nowSec: NOW });
    // The append-only tables are not in this fixture and fail on their own
    // names; the snapshot pass, which carries energy, must not.
    assert.equal(r.failed?.snapshots, undefined);
    assert.equal(r.failed?.energy_days, undefined);
    assert.equal(r.copied.energy_days, 1);

    // ── child A is destroyed; child B starts empty ──
    a.raw.close();
    const b = open(SCHEMA);
    assert.deepEqual(await readEnergyDay(b.db, AGENT, TODAY), { reviews: 0, entries: 0, toldAt: null }, "a rebuilt child knows nothing");
    assert.equal(await seed(b.db, shared.db), 1);

    // ── B's plan is A's plan ──
    const counters = await readEnergyDay(b.db, AGENT, TODAY);
    assert.deepEqual(counters, { reviews: 4, entries: 2, toldAt: NOW - 600 });
    const lastGood = await lastEnergyReadDay(b.db, AGENT, NOW - 86_400);
    assert.deepEqual(lastGood, { full: true, at: NOW - 120 });
    // With the chain unreadable right after the restart, the holder is NOT
    // throttled: the carried reading stands.
    assert.equal(energyLevel({ holder: null, account: null }, lastGood, NOW).level, "full");
    // And a low agent's allowance is exactly as spent as it was.
    const plan = energyPlan({ mode: "enforce", level: "low", counters, reviewsAllowed: 29, entriesAllowed: 2, nowSec: NOW });
    assert.equal(plan.entries.open, false, "the day's two new trades are still used");
    assert.equal(plan.entries.used, 2);
    assert.equal(plan.reviews.used, 4);
    assert.equal(plan.told, true, "and the owner is not told a second time");
    b.raw.close();
    shared.raw.close();
  });

  it("A SEED NEVER LOWERS WHAT A RUNNING CHILD ALREADY COUNTED", async () => {
    const shared = open(SCHEMA + MIRROR_STATE_DDL);
    await mergeEnergyDayRow(shared.db, AGENT, { day: TODAY, reviews: 2, entries: 1, entriesRefunded: 0, toldAt: null, readAt: NOW - 500, readFull: true });
    const b = open(SCHEMA);
    for (let i = 0; i < 5; i++) await claimEnergyDay(b.db, AGENT, TODAY, "reviews", 29);
    await noteEnergyReadDay(b.db, AGENT, TODAY, false, NOW - 10);
    await seed(b.db, shared.db);
    assert.deepEqual(await readEnergyDay(b.db, AGENT, TODAY), { reviews: 5, entries: 1, toldAt: null });
    assert.deepEqual(await lastEnergyReadDay(b.db, AGENT, 0), { full: false, at: NOW - 10 }, "the newer reading, the child's own, stands");
    b.raw.close();
    shared.raw.close();
  });

  it("only today and yesterday travel back", async () => {
    const shared = open(SCHEMA + MIRROR_STATE_DDL);
    await mergeEnergyDayRow(shared.db, AGENT, { day: utcDay(NOW - 3 * 86_400), reviews: 9, entries: 9, entriesRefunded: 0, toldAt: null, readAt: null, readFull: null });
    await mergeEnergyDayRow(shared.db, AGENT, { day: utcDay(NOW - 86_400), reviews: 7, entries: 0, entriesRefunded: 0, toldAt: null, readAt: NOW - 80_000, readFull: false });
    const b = open(SCHEMA);
    assert.equal(await seed(b.db, shared.db), 1);
    assert.equal((await readEnergyDay(b.db, AGENT, utcDay(NOW - 86_400))).reviews, 7);
    assert.equal((await readEnergyDay(b.db, AGENT, utcDay(NOW - 3 * 86_400))).reviews, 0);
    b.raw.close();
    shared.raw.close();
  });

  it("the full threshold is the core contract's, not a literal", () => {
    assert.equal(ENERGY_FULL_RAW, 100_000n * 10n ** 18n);
  });
});

/**
 * WHERE THE SEED RUNS, pinned the way the basis seed's is (orchestrator.test.ts).
 */
describe("seedEnergyForChild's place in spawnChild", () => {
  const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
  const body = (name: string) => {
    const at = src.indexOf(`async function ${name}(`);
    return src.slice(at, src.indexOf("\n}\n", at));
  };

  it("INSIDE THE LEASE, AFTER THE BASIS SEED, BEFORE THE SPAWN", () => {
    const guard = src.indexOf("log(`${tenant}: no healthy lease — not spawning");
    const basis = src.indexOf("await seedBasisForChild(tenant, smartAccount);");
    const energy = src.indexOf("await seedEnergyForChild(tenant, smartAccount);");
    const spawned = src.indexOf("const proc = spawn(", energy);
    assert.ok(guard > 0 && basis > guard, "the basis seed still sits below the lease refusal");
    assert.ok(energy > basis, "the energy seed follows the basis seed");
    assert.ok(spawned > energy, "and both land before the child exists");
  });

  it("it runs the same plan and the same merge this file just drove", () => {
    const fn = body("seedEnergyForChild");
    assert.match(fn, /if \(!url\) return true;/, "self-hosted: the child's own ledger is never wiped");
    // The deciding half moved to energy-seed.ts, where energy-seed.test.ts
    // runs it — including the failure this used to only log.
    assert.match(fn, /seedEnergyDays\(\{\s*home,\s*agent: smartAccount,\s*nowSec: Math\.floor\(Date\.now\(\) \/ 1000\),/);
    assert.match(fn, /shared: \(\) => makePgDb\(url\),/);
    assert.match(fn, /FAILED/, "a failed seed is said out loud");
    const seedSrc = readFileSync(new URL("./energy-seed.ts", import.meta.url), "utf8");
    const at = seedSrc.indexOf("export async function seedEnergyDays(");
    const seed = seedSrc.slice(at, seedSrc.indexOf("\n}\n", at));
    assert.match(seed, /planEnergySeed\(/);
    assert.match(seed, /readEnergyDaysSince\(shared, i\.agent, sinceDay\)/);
    assert.match(seed, /mergeEnergyDayRow\(local, i\.agent, row\)/);
    assert.match(seed, /utcDay\(i\.nowSec - 86_400\)/, "today and yesterday");
    assert.ok(seed.indexOf("clearEnergyUnrestored(i.home);") > seed.indexOf("mergeEnergyDayRow(local, i.agent, row)"), "the marker goes only after every row is in");
  });
});

/**
 * A HOLDER WHO NEVER SAVED SETTINGS IS STILL A HOLDER.
 *
 * writeSettingsForChild returned before writing anything for a tenant with no
 * saved settings, so the child had no holder address, and circle.ts reads "no
 * address" as a knowable outsider — the Circle tier lost and, with energy, the
 * agent throttled for tokens its owner holds.
 */
describe("writeSettingsForChild always writes settings.json", () => {
  const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function writeSettingsForChild("), src.indexOf("\n}\n", src.indexOf("async function writeSettingsForChild(")));

  it("WITH NO SAVED SETTINGS: the holder address is written before the early return", () => {
    // B2 (sybil) changed WHICH address: effectiveHolder's, by the same claims
    // as the saved-settings path — the login wallet unless another account
    // claims it, and then no key at all (childSettingsFor).
    const holder = fn.indexOf("? (effectiveHolder(tenant, settings?.holderProof ?? null, (w) => claims.get(w))?.address ?? null)");
    const write = fn.indexOf("if (!settings) writeChildSettings(tenant, childSettingsFor(null, holder));");
    const early = fn.indexOf("if (!settings) return null;");
    assert.ok(holder > 0 && write > holder, "a settings-less tenant still gets a file, by the one holder rule");
    assert.ok(early > write, "written BEFORE the early return, or it is never written");
  });

  it("and the saved-settings path writes through the same helper, by the same holder rule", () => {
    assert.match(fn, /writeChildSettings\(tenant, forChild\);/);
    assert.match(fn, /const forChild: MerrymenSettings = childSettingsFor\(settings, holder\);/);
    const helper = src.slice(src.indexOf("function writeChildSettings("), src.indexOf("\n}\n", src.indexOf("function writeChildSettings(")));
    assert.match(helper, /const file = path\.join\(home, "settings\.json"\);/);
    assert.match(helper, /writeFileAtomicSync\(file, next, 0o600\);/, "owner-only, like the file it always was — and replaced whole (settings-atomic.test.ts)");
  });
});
