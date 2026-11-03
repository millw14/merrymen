/** The real parent bridge: leased homes, file requests and an actual shared SQL queue. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, test } from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite } from "./db";
import { applyLedgerSchema } from "./store";
import { botIdOf, tokenTagOf } from "./telegram/state";
import { PERPS_BOT_OUTBOX, readPerpsBotAuthority, readPerpsBotSnapshot, writePerpsBotRequest, type PerpsBotRequest } from "./perps/telegram-bridge";
const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "perps-parent-bridge-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
process.env.MERRYMEN_PERPS = "paper";
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 63).toString("base64");
for (const k of ["DATABASE_URL", "MERRYMEN_ACCOUNTING_HOLD_TENANTS", "MERRYMEN_FLEET_ROLLOUT", "MERRYMEN_ROLLOUT_NEW_TENANTS", "MERRYMEN_PERSISTENT_HOME_REQUIRED", "MERRYMEN_FLEET_RECOVERY_REPORT_ONLY"]) delete process.env[k];
for (const k of Object.keys(process.env)) if (k.startsWith("RAILWAY_")) delete process.env[k];
const orch = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore } = await import("./settings-store");
const { acquireTenantLease } = await import("./tenant-lease");
const perps = getGrantStore("perps"), spot = getGrantStore("spot"), settings = getSettingsStore("spot");
const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw);
await applyLedgerSchema(db);
raw.exec("CREATE TABLE IF NOT EXISTS agent_commands(id TEXT PRIMARY KEY,agent_id TEXT,kind TEXT,args TEXT,created_at INTEGER,claimed_at INTEGER,done_at INTEGER,result TEXT)");
orch.setPerpsBotDbForTest(db);
class Proc extends EventEmitter {
  pid = 65000; stdout = null; stderr = null;
  kill() { setImmediate(() => this.emit("exit", null, "SIGTERM")); return true; }
}
orch.setSpawnForTest((_c: string, _a: readonly string[], _o: SpawnOptions) => new Proc() as unknown as ChildProcess);
orch.setSpawnPacingForTest(0, 0); orch.setLeaseAcquireForTest(acquireTenantLease);
orch.setPaperRestoreForTest(async () => ({ ok: true, line: null }));
orch.setPerpsFeedStartForTest(() => ({ stop() {} }));
orch.setSolanaKillForTest(async () => {}); orch.setKillConfirmForTest(async () => {});
let next = 0x7200, update = 1;
const owners: `0x${string}`[] = [];
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const now = () => Math.floor(Date.now() / 1000);
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
async function owner() {
  const tenant = address(next++), account = address(next++), token = `${next++}:test-bot-secret`, home = orch.childHome(tenant);
  owners.push(tenant);
  const key = `0x${"42".repeat(32)}` as `0x${string}`;
  const grant: StoredGrant = { owner: tenant, smartAccount: account, purpose: "perps", chainId: 4663, sessionKeyAddress: privateKeyToAccount(key).address,
    demoSessionPrivateKey: key, serialized: "test-permission", grantedAt: now() - 60, expiresAt: now() + 3600,
    caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 4 } };
  await perps.put(tenant, grant);
  await settings.put(tenant, { telegramEnabled: true, telegramBotToken: token, telegramControlEnabled: true, telegramAllowlist: [7] });
  await orch.reconcile(); await settle();
  raw.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,mode) VALUES(?,?,?,4663,'{}',1,9999999999,'paper')").run(account, tenant, grant.sessionKeyAddress);
  writeFileSync(path.join(home, "telegram.json"), JSON.stringify({ ownerId: 7, botId: botIdOf(token), tokenTag: tokenTagOf(token), linkedChatAt: { 7: now() - 60 } }));
  const request = (extra: Partial<PerpsBotRequest> = {}): PerpsBotRequest => ({ kind: "flatten", expectedAccount: account,
    requestId: `tg-perps-${botIdOf(token)}-${update++}`, askedAtSec: now(), authority: readPerpsBotAuthority(home)!, ...extra });
  return { tenant, account, home, token, request, grant };
}
const count = () => Number(raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get()!.n);
const results = (home: string) => readdirSync(path.join(home, PERPS_BOT_OUTBOX)).filter(n => n.endsWith(".result.json")).map(n => JSON.parse(readFileSync(path.join(home, PERPS_BOT_OUTBOX, n), "utf8")) as { line: string });
afterEach(async () => {
  for (const tenant of owners.splice(0)) { await perps.remove(tenant); await spot.remove(tenant); }
  await orch.reconcile(); await settle();
  raw.exec("DELETE FROM agent_commands; DELETE FROM agents");
  for (const dir of ["children", "children-perps", "tenants", "tenants-perps", "tenant-settings", "tenant-settings-perps"]) rmSync(path.join(fleet, dir), { recursive: true, force: true });
});
after(() => { orch.setPerpsBotDbForTest(null); raw.close(); rmSync(fleet, { recursive: true, force: true }); });

test("parent publishes only the owner's view and admits one durable exit across duplicate drains", async () => {
  const o = await owner(), r = o.request();
  writePerpsBotRequest(o.home, r);
  await orch.syncPerpsBotBridges();
  assert.equal(count(), 1); assert.equal(raw.prepare("SELECT agent_id FROM agent_commands").get()!.agent_id, o.account);
  assert.deepEqual(readPerpsBotSnapshot(o.home), { state: "ready", account: o.account, grantExpiresAt: o.grant.expiresAt, report: null });
  writePerpsBotRequest(o.home, r); await orch.syncPerpsBotBridges(); assert.equal(count(), 1);
  assert.match(results(o.home)[0]!.line, /queued/);
});

test("foreign account and missing authority never reach the shared order queue", async () => {
  const a = await owner(), b = await owner();
  writePerpsBotRequest(a.home, a.request({ expectedAccount: b.account }));
  writePerpsBotRequest(b.home, b.request({ authority: undefined }));
  await orch.syncPerpsBotBridges(); assert.equal(count(), 0);
  assert.match(results(a.home)[0]!.line, /permission changed/);
  assert.match(results(b.home)[0]!.line, /owner link or controls changed/);
});

test("stored token revocation and local owner relink invalidate queued requests", async () => {
  const a = await owner(), b = await owner();
  writePerpsBotRequest(a.home, a.request()); writePerpsBotRequest(b.home, b.request());
  await settings.put(a.tenant, { telegramEnabled: true, telegramBotToken: `${botIdOf(a.token)}:rotated-secret`, telegramAllowlist: [7] });
  const file = path.join(b.home, "telegram.json"), state = JSON.parse(readFileSync(file, "utf8"));
  state.linkedChatAt[7] += 1; writeFileSync(file, JSON.stringify(state));
  await orch.syncPerpsBotBridges(); assert.equal(count(), 0);
  for (const o of [a, b]) assert.match(results(o.home)[0]!.line, /owner link or controls changed/);
});

test("a lost owner lease cannot publish, consume or execute a queued request", async () => {
  const o = await owner(); writePerpsBotRequest(o.home, o.request());
  orch.loseLeaseForTest(o.tenant); await orch.syncPerpsBotBridges(); assert.equal(count(), 0);
  assert.equal(results(o.home).length, 0);
});

test("Perps-only login pause and resume leave the entry switch and Close-all halt alone", async () => {
  const o = await owner();
  await getSettingsStore("perps").put(o.tenant, { perpsEnabled: false });
  writePerpsBotRequest(o.home, o.request({ kind: "pause" })); await orch.syncPerpsBotBridges();
  assert.equal(existsSync(path.join(o.home, "paused")), true);
  writePerpsBotRequest(o.home, o.request({ kind: "resume" })); await orch.syncPerpsBotBridges();
  assert.equal(existsSync(path.join(o.home, "paused")), false);
  assert.equal((await getSettingsStore("perps").get(o.tenant))?.perpsEnabled, false);
  assert.equal(count(), 0);
});

/** Run the real SQL, then change local authority while that read is awaited. */
function changeDuringRead(inner: import("./db").Db, match: RegExp, change: () => void): import("./db").Db {
  return {
    exec: sql => inner.exec(sql),
    tx: fn => inner.tx(tx => fn(changeDuringRead(tx, match, change))),
    prepare(sql) {
      const statement = inner.prepare(sql);
      return { ...statement,
        get: async (...args) => {
          const row = await statement.get(...args);
          if (match.test(sql)) change();
          return row;
        },
        all: async (...args) => {
          const rows = await statement.all(...args);
          if (match.test(sql)) change();
          return rows;
        },
      };
    },
  };
}

test("an owner relink during a shared pause read cannot commit an already-authorized resume", async t => {
  const o = await owner();
  writePerpsBotRequest(o.home, o.request({ kind: "pause" }));
  await orch.syncPerpsBotBridges();
  assert.ok(existsSync(path.join(o.home, "paused")));
  const resume = o.request({ kind: "resume" });
  writePerpsBotRequest(o.home, resume);
  let changed = false;
  orch.setPerpsBotDbForTest(changeDuringRead(db, /SELECT paused_at FROM tenant_telegram/, () => {
    if (changed) return;
    changed = true;
    const file = path.join(o.home, "telegram.json"), state = JSON.parse(readFileSync(file, "utf8"));
    state.linkedChatAt[7] += 1;
    writeFileSync(file, JSON.stringify(state));
  }));
  t.after(() => orch.setPerpsBotDbForTest(db));
  await orch.syncPerpsBotBridges();
  assert.equal(changed, true, "authority changed inside the awaited control transaction");
  assert.ok(existsSync(path.join(o.home, "paused")));
  assert.ok(raw.prepare("SELECT paused_at FROM tenant_telegram WHERE tenant = ?").get(o.tenant)!.paused_at);
  assert.equal(raw.prepare("SELECT request_id FROM perps_telegram_control_receipts WHERE tenant = ? AND request_id = ?")
    .get(o.tenant, resume.requestId), undefined, "the old owner cannot acquire a successful resume receipt");
});

test("a token rotation during paper-book admission cannot enqueue an already-authorized exit", async t => {
  const o = await owner();
  writePerpsBotRequest(o.home, o.request());
  let changed = false;
  orch.setPerpsBotDbForTest(changeDuringRead(db, /SELECT mode\b/, () => {
    if (changed) return;
    changed = true;
    const file = path.join(o.home, "settings.json"), cfg = JSON.parse(readFileSync(file, "utf8"));
    cfg.telegramBotToken = `${botIdOf(o.token)}:new-token-generation`;
    writeFileSync(file, JSON.stringify(cfg));
  }));
  t.after(() => orch.setPerpsBotDbForTest(db));
  await orch.syncPerpsBotBridges();
  assert.equal(changed, true, "authority changed inside the awaited queue admission");
  assert.equal(count(), 0);
  assert.match(results(o.home)[0]!.line, /handing over|could not be reached|not confirmed/);
});
