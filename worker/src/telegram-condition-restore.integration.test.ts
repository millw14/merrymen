import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const fleet = mkdtempSync(path.join(os.tmpdir(), "merrymen-condition-restore-"));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
delete process.env.DATABASE_URL;
after(() => rmSync(fleet, { recursive: true, force: true }));

const { childHome, publishChildTelegramForTest, restoredTelegramFile, writeTelegramForChild } = await import("./orchestrator");
const { wrapSqlite } = await import("./db");
const { ensureTelegramSchema, TELEGRAM_STATE_DDL, publishTenantTelegram, publishTelegramRuntime, readTenantTelegram,
  publishTenantConditionAlerts, readTenantConditionAlerts, livenessFor } = await import("./telegram-store");

const tenant = `0x${"a".repeat(40)}` as const;
const otherTenant = `0x${"b".repeat(40)}` as const;
const owner = 123456;
const stamp = Math.floor(Date.now() / 1000) - 100;
const alert = { "drawdown-halted:500": stamp };
const state = { linkCode: "K7M2QX", ownerId: owner, linkedAt: stamp - 100, firedAlerts: alert };
const live = livenessFor({ botId: null, poll: null }, null, "trading");
const raw = new DatabaseSync(":memory:");
const db = wrapSqlite(raw);
after(() => raw.close());

test("real child publish → lost home → restore retains cooldown without restoring command authority", async () => {
  await ensureTelegramSchema(db);
  const home = childHome(tenant);
  const file = path.join(home, "telegram.json");
  mkdirSync(home, { recursive: true });
  writeFileSync(file, JSON.stringify({ ...state, offset: 987, linkedChats: [], botToken: "not-for-the-mirror",
    firedAlerts: { ...alert, token: stamp, "no-gas": "not-a-time" } }));
  await publishChildTelegramForTest(tenant, db, "trading");
  assert.deepEqual(await readTenantConditionAlerts(db, tenant, owner), alert);
  assert.deepEqual(await readTenantConditionAlerts(db, otherTenant, owner), {});
  assert.deepEqual(await readTenantTelegram(db, tenant), { linkCode: state.linkCode, ownerId: owner, linkedAt: state.linkedAt },
    "ordinary readers never receive cooldown metadata");
  const envelope = raw.prepare("SELECT condition_alerts FROM tenant_telegram WHERE tenant = ?").get(tenant) as { condition_alerts: string };
  assert.deepEqual(JSON.parse(envelope.condition_alerts), { ownerId: owner, firedAlerts: alert });
  rmSync(file);
  await writeTelegramForChild(tenant, db);
  const restored = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(restored, state);
  assert.ok(!("offset" in restored) && !("linkedChats" in restored) && !("botToken" in restored));
  assert.ok(stamp + 6 * 3600 > Math.floor(Date.now() / 1000), "original six-hour expiry survives, not a refreshed timestamp");
});

test("owner changes and fallback owners cannot inherit a different recipient's cooldown", async () => {
  await publishTenantTelegram(db, tenant, { ...state, ownerId: owner + 1 });
  assert.deepEqual(await readTenantConditionAlerts(db, tenant, owner + 1), {});
  assert.deepEqual(restoredTelegramFile({ ...state }, owner + 1), {
    linkCode: state.linkCode, ownerId: owner + 1, linkedAt: state.linkedAt,
  });
  assert.deepEqual(restoredTelegramFile({ ...state, ownerId: null }, owner), {
    linkCode: state.linkCode, ownerId: owner, linkedAt: state.linkedAt,
  });
  assert.equal(await publishTelegramRuntime(db, tenant, { ...state, ownerId: owner + 1, firedAlerts: {} }, live), null);
  assert.deepEqual(await readTenantConditionAlerts(db, tenant, owner + 1), {});
});

test("legacy schema still publishes and restores its link when cooldown migration is unavailable", async () => {
  const legacyRaw = new DatabaseSync(":memory:");
  const legacy = wrapSqlite(legacyRaw);
  try {
    await legacy.exec(TELEGRAM_STATE_DDL);
    assert.ok(await publishTelegramRuntime(legacy, tenant, state, live) instanceof Error);
    assert.deepEqual(await readTenantTelegram(legacy, tenant), { linkCode: state.linkCode, ownerId: owner, linkedAt: state.linkedAt });
    assert.deepEqual(await readTenantConditionAlerts(legacy, tenant, owner), {});
    await ensureTelegramSchema(legacy);
    assert.equal(await publishTelegramRuntime(legacy, tenant, state, live), null);
    assert.deepEqual(await readTenantConditionAlerts(legacy, tenant, owner), alert);
  } finally { legacyRaw.close(); }
});

test("a stale recipient publish and a failed optional write cannot assign the old owner's cooldown to the new one", async () => {
  await publishTelegramRuntime(db, otherTenant, state, live);
  await publishTenantTelegram(db, otherTenant, { ...state, ownerId: owner + 2 });
  await publishTenantConditionAlerts(db, otherTenant, state);
  assert.deepEqual(await readTenantConditionAlerts(db, otherTenant, owner + 2), {});
  raw.exec("CREATE TRIGGER reject_cooldown BEFORE UPDATE OF condition_alerts ON tenant_telegram BEGIN SELECT RAISE(ABORT, 'optional cooldown unavailable'); END");
  try {
    const failed = await publishTelegramRuntime(db, otherTenant, { ...state, ownerId: owner + 3 }, live);
    assert.match(failed?.message ?? "", /optional cooldown unavailable/);
    assert.equal((await readTenantTelegram(db, otherTenant))?.ownerId, owner + 3);
    assert.deepEqual(await readTenantConditionAlerts(db, otherTenant, owner + 3), {});
  } finally { raw.exec("DROP TRIGGER reject_cooldown"); }
});
