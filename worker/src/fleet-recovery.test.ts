import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import { FLEET_RECOVERY_SCHEMA, readFleetCommandRefusal, readFleetRecoveryView, recordFleetRecoveryHold,
  recordFleetSourceVerified } from "./fleet-recovery";

const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw);
const tenant = `0x${"a".repeat(40)}`, account = `0x${"b".repeat(40)}`, other = `0x${"c".repeat(40)}`;
const scope = { tenant, smartAccount: account, chainId: 4663 }, now = 1_800_000_000;
after(() => raw.close());

it("old installs have no invented recovery state and readers create no schema", async () => {
  assert.equal(await readFleetRecoveryView(db, scope, now - 5), null);
  assert.equal(await readFleetCommandRefusal(db, account, now * 1000), false);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='fleet_recovery_health'").get()!.n, 0);
});

it("publishes a scoped source hold while preserving all financial and original-source records", async () => {
  await db.exec(`CREATE TABLE trades(agent_id TEXT,id INTEGER); CREATE TABLE posts(agent_id TEXT);
    CREATE TABLE flows(agent_id TEXT); CREATE TABLE mirror_state(tenant TEXT,last_id INTEGER);
    INSERT INTO mirror_state VALUES('${tenant}',100); INSERT INTO trades VALUES('${account}',99);`);
  await recordFleetRecoveryHold(db, scope, "source-continuity", now, () => true);
  assert.deepEqual(await readFleetRecoveryView(db, scope, now - 5), {
    state: "history-only", tradingPaused: true, history: "available", memory: "unknown",
    checkedAt: now, lastVerifiedHeartbeatAt: now - 5,
  });
  assert.equal(raw.prepare("SELECT last_id FROM mirror_state").get()!.last_id, 100);
  assert.equal(raw.prepare("SELECT id FROM trades").get()!.id, 99);
  assert.equal(await readFleetRecoveryView(db, { ...scope, tenant: other }, now), null);
  assert.equal(await readFleetRecoveryView(db, { ...scope, smartAccount: other }, now), null);
  assert.equal(await readFleetRecoveryView(db, { ...scope, chainId: 1 }, now), null);
});

it("no observed shared row is unknown history, not an empty original book or restored memory", async () => {
  const empty = { ...scope, smartAccount: other };
  await recordFleetRecoveryHold(db, empty, "persistent-source", now, () => true);
  const view = await readFleetRecoveryView(db, empty, now + 10);
  assert.equal(view?.state, "checking"); assert.equal(view?.history, "unknown");
  assert.equal(view?.memory, "unknown"); assert.equal(view?.lastVerifiedHeartbeatAt, null);
});

it("a lost writer rolls back the report; a stale check cannot overwrite a newer hold", async () => {
  let checks = 0;
  await assert.rejects(recordFleetRecoveryHold(db, scope, "source-barrier", now + 5, () => ++checks < 3), /lost its writer/);
  assert.equal((await readFleetRecoveryView(db, scope, null))?.checkedAt, now);
  await recordFleetRecoveryHold(db, scope, "source-barrier", now + 20, () => true);
  await recordFleetRecoveryHold(db, scope, "source-continuity", now + 10, () => true);
  assert.equal((await readFleetRecoveryView(db, scope, null))?.checkedAt, now + 20);
  await recordFleetSourceVerified(db, scope, now + 10, () => true);
  assert.equal((await readFleetRecoveryView(db, scope, null))?.tradingPaused, true);
});

it("healthy original-source verification clears only its report and never permits pre-recovery commands", async () => {
  assert.equal(await readFleetCommandRefusal(db, account, (now + 30) * 1000), true);
  await assert.rejects(recordFleetSourceVerified(db, scope, now + 30, () => false), /lost its writer/);
  await recordFleetSourceVerified(db, scope, now + 30, () => true);
  assert.equal(await readFleetRecoveryView(db, scope, null), null);
  assert.equal(await readFleetCommandRefusal(db, account, (now - 100) * 1000), true);
  assert.equal(await readFleetCommandRefusal(db, account, (now + 30) * 1000 + 999), true);
  assert.equal(await readFleetCommandRefusal(db, account, (now + 31) * 1000), true);
  assert.equal(await readFleetCommandRefusal(db, account, (now + 31) * 1000 + 1), false);
  assert.equal(raw.prepare("SELECT last_id FROM mirror_state").get()!.last_id, 100);
});

it("a database outage or malformed report fails closed rather than appearing recovered", async () => {
  const broken = { prepare() { throw new Error("connection unavailable"); } } as Pick<Db, "prepare">;
  await assert.rejects(readFleetRecoveryView(broken, scope, null), /unavailable/);
  await assert.rejects(readFleetCommandRefusal(broken, account, now * 1000), /unavailable/);
  raw.prepare("UPDATE fleet_recovery_health SET held=7 WHERE smart_account=?").run(other);
  await assert.rejects(readFleetRecoveryView(db, { ...scope, smartAccount: other }, null), /unreadable/);
});

it("the report accepts only exact wallet and chain scopes", async () => {
  await assert.rejects(recordFleetRecoveryHold(db, { ...scope, tenant: "any" }, "source-barrier", now, () => true), /Invalid/);
  await assert.rejects(recordFleetRecoveryHold(db, { ...scope, chainId: 0 }, "source-barrier", now, () => true), /Invalid/);
  assert.match(FLEET_RECOVERY_SCHEMA, /PRIMARY KEY\(tenant, smart_account, chain_id\)/);
});
