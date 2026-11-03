/**
 * A PERPS WORKER HELD PAUSED WHERE NO BOT CAN HEAR /resume IS SAID, AND STAYS PAUSED.
 *
 * A login's /pause is the Spot home's, mirrored onto its Perps worker, and only
 * the Spot bot's /resume lifts it (a Perps worker runs no bot until slice 6a).
 * A Perps-only login whose earlier Spot wallet was killed keeps that pause: its
 * recorded pause (a legacy "Telegram: paused by chat" event, or the durable
 * stamp, read across the owner's accounts) or the `paused` file the Spot home
 * kept after Kill all. Nothing unpauses (recovery-reply-arm.ts: only
 * restrictive), so the orchestrator says so instead (sayPerpsPauseUnheard),
 * once and then hourly, with how it lifts; never for a login whose Spot worker
 * runs, which hears /resume itself.
 *
 * Real reconcile() and the pause mirror over file stores, a sqlite stand-in for
 * the shared database, a fake worker process.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, it } from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/index";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-perps-unheard-pause-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
delete process.env.MERRYMEN_FLEET_RECOVERY_REPORT_ONLY;
delete process.env.MERRYMEN_PERSISTENT_HOME_REQUIRED;
delete process.env.MERRYMEN_FLEET_ROLLOUT;
for (const key of Object.keys(process.env)) if (key.startsWith("RAILWAY_")) delete process.env[key];
const dek = Buffer.alloc(32, 53);
process.env.MERRYMEN_STORE_DEK = dek.toString("base64");
process.env.MERRYMEN_PERPS = "paper";

const orch = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { getSettingsStore } = await import("./settings-store");
const { wrapSqlite } = await import("./db");
const { applyLedgerSchema } = await import("./store");
const { MIRROR_STATE_DDL } = await import("./ledger-mirror");
const { ensureTelegramSchema, recordDurablePause } = await import("./telegram-store");

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const nowSec = () => Math.floor(Date.now() / 1000);
let keyByte = 0x40;
const grant = (owner: `0x${string}`, account: `0x${string}`, extra: Partial<StoredGrant> = {}): StoredGrant => {
  const sk = `0x${(keyByte++).toString(16).padStart(2, "0").repeat(32)}` as `0x${string}`;
  return {
    owner, smartAccount: account, chainId: 4663, demoSessionPrivateKey: sk,
    sessionKeyAddress: privateKeyToAccount(sk).address, serialized: `permission-${account}-${keyByte}`,
    grantedAt: nowSec() - 60, expiresAt: nowSec() + 86_400, grantFeatures: ["tradeable-v2"], grantTokens: [],
    caps: { perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 4 },
    ...extra,
  } as StoredGrant;
};

class FakeProc extends EventEmitter {
  static next = 98_000;
  readonly pid = FakeProc.next++;
  readonly stdout = null; readonly stderr = null;
  gone = false;
  constructor(readonly env: NodeJS.ProcessEnv) { super(); }
  kill(): boolean { setImmediate(() => { if (!this.gone) { this.gone = true; this.emit("exit", null, "SIGTERM"); } }); return true; }
}
const spawned: FakeProc[] = [];
orch.setSpawnForTest((_c: string, _a: readonly string[], o: SpawnOptions) => { const p = new FakeProc(o.env ?? {}); spawned.push(p); return p as unknown as ChildProcess; });
orch.setKillConfirmForTest(async () => {});
orch.setSolanaKillForTest(async () => {});
orch.setPaperRestoreForTest(async () => ({ ok: true, line: null }));
orch.setPerpsFeedStartForTest(() => ({ stop: () => {} }));
const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ").replace(/^\[orchestrator\] /, "")); };
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const spot = getGrantStore("spot"), perps = getGrantStore("perps");
const perpsKey = (owner: string) => `${owner}:perps`;
const live = (tenant: string) => spawned.filter((p) => p.env.MERRYMEN_HOME === orch.childHome(tenant) && !p.gone);
const pausedHere = (tenant: string) => existsSync(path.join(orch.childHome(tenant), "paused"));
const unheard = (owner: string) => said.filter((l) => l.startsWith(`perps: ${perpsKey(owner)} is paused by its owner's`));

const raw = new DatabaseSync(":memory:");
const shared = wrapSqlite(raw);
await applyLedgerSchema(shared);
await shared.exec(MIRROR_STATE_DDL);
await ensureTelegramSchema(shared);
orch.setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });

after(() => {
  console.log = realLog;
  orch.setRetirementMemoryStoreForTest(null);
  orch.setPaperRestoreForTest(null);
  orch.setPerpsFeedStartForTest(null);
  raw.close();
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const passes = async (n: number) => { for (let i = 0; i < n; i++) { await orch.reconcile(); await settle(); await orch.mirrorLoginPausesForTest(); } };

it("a Perps-only login's standing pause from a killed Spot wallet stays, and is said; a login whose Spot worker runs is not", async () => {
  // Recorded pauses of killed Spot wallets, in the shared database: their agents rows (owner = the login, D4) stay.
  const LEGACY = address(0x1e1), S1 = address(0x1e2), P1 = address(0x1e3);
  const DURABLE = address(0x2e1), S2 = address(0x2e2), P2 = address(0x2e3);
  const RESUMED = address(0x3e1), S3 = address(0x3e2), P3 = address(0x3e3);
  const FRESH = address(0x4e1), P4 = address(0x4e3);
  const t = nowSec();
  const agent = raw.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, ?, ?, 4663, '{}', ?, ?)");
  const ev = raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'warn', ?, ?)");
  for (const [l, s] of [[LEGACY, S1], [DURABLE, S2], [RESUMED, S3]] as const) agent.run(s, l, address(0xeee), t - 10 * 86_400, t - 86_400);
  ev.run(S1, "Telegram: paused by chat 7", t - 5 * 86_400);
  await recordDurablePause(shared, DURABLE, t - 5 * 86_400);
  ev.run(S3, "Telegram: paused by chat 7", t - 5 * 86_400);
  ev.run(S3, "Telegram: resumed by chat 7", t - 4 * 86_400);

  // A two-wallet login whose Spot home is paused: its Spot bot hears /resume, so nothing is said.
  const BOTH = address(0x5e1), SB = address(0x5e2), PB = address(0x5e3);
  // A Spot login that paused, then pressed Kill all; its Spot home kept `paused` (the removed-tenant cleanup keeps a home with a ledger).
  const KILLED = address(0x6e1), SK = address(0x6e2), PK = address(0x6e3);
  await spot.put(BOTH, grant(BOTH, SB));
  await perps.put(BOTH, grant(BOTH, PB, { purpose: "perps" }));
  await getSettingsStore("perps").put(BOTH, { perpsEnabled: true, perpsMarkets: ["BTC-PERP"] });
  await spot.put(KILLED, grant(KILLED, SK));
  await passes(2);
  for (const l of [BOTH, KILLED]) {
    assert.equal(live(l).length, 1);
    // The Spot worker's own (empty) ledger, as a real one leaves: its final pass reads it.
    const book = new DatabaseSync(path.join(orch.childHome(l), "merrymen.db"));
    try { await applyLedgerSchema(wrapSqlite(book)); } finally { book.close(); }
    writeFileSync(path.join(orch.childHome(l), "paused"), "paused", "utf8");
  }
  await orch.mirrorLoginPausesForTest();
  await spot.remove(KILLED);
  await passes(3);
  assert.equal(live(KILLED).length, 0, "set-up: Kill all stopped it");
  assert.equal(pausedHere(KILLED), true, "set-up: the Spot home kept its `paused`");

  // Then each Perps-only login makes its Perps wallet (POST /api/grants?wallet=perps) and turns practice perps on.
  for (const [l, p] of [[LEGACY, P1], [DURABLE, P2], [RESUMED, P3], [FRESH, P4], [KILLED, PK]] as const) {
    await perps.put(l, grant(l, p, { purpose: "perps" }));
    await getSettingsStore("perps").put(l, { perpsEnabled: true, perpsMarkets: ["BTC-PERP"] });
  }
  await passes(12);

  for (const l of [LEGACY, DURABLE, RESUMED, FRESH, KILLED, BOTH]) assert.equal(live(perpsKey(l)).length, 1, `${l}'s Perps worker runs`);
  // The pauses stand: nothing here unpauses.
  for (const l of [LEGACY, DURABLE, KILLED, BOTH]) assert.equal(pausedHere(perpsKey(l)), true, `${l}'s Perps worker stays paused`);
  for (const l of [RESUMED, FRESH]) assert.equal(pausedHere(perpsKey(l)), false, `${l}'s is not paused`);
  // Said once (the hourly resay has not come round), with how it lifts; not for a login with no pause, nor one whose Spot bot hears it.
  assert.equal(unheard(LEGACY).length, 1);
  assert.match(unheard(LEGACY)[0]!, /is paused by its owner's \/pause, kept in its Spot home; no owner bot is currently answering/);
  assert.match(unheard(LEGACY)[0]!, /The pause stands; link or restore the owner's bot and send \/resume in the private owner DM/);
  assert.equal(unheard(DURABLE).length, 1);
  assert.equal(unheard(KILLED).length, 1);
  assert.match(unheard(KILLED)[0]!, /is paused by its owner's \/pause, kept in its Spot home/);
  for (const l of [RESUMED, FRESH, BOTH]) assert.deepEqual(unheard(l), [], `nothing said for ${l}`);
});
