/**
 * THE OWNER'S RECORDED STOPS, THROUGH THE REAL SPAWN PATH.
 *
 * recovery-reply-arm.test.ts covers the fold and the arm on their own. This
 * drives reconcile() → spawnChild() over a real file-backed grant store and a
 * real sqlite shared database holding #259's journal, so what is checked is
 * what a worker would actually be handed: no key and no worker after a
 * recorded kill, a `paused` file already in the home at the moment of the
 * fork after a recorded /pause, and the owner's /resume standing across a
 * respawn.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { StoredGrant } from "../../packages/core/src/index";
import { wrapSqlite } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-owner-controls-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 9).toString("base64");

const { childHome, reconcile, setKillConfirmForTest, setPaperRestoreForTest, setRetirementMemoryStoreForTest, setSpawnForTest } = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { killRequested } = await import("./kill-request");

const raw = new DatabaseSync(":memory:"), shared = wrapSqlite(raw), dek = Buffer.alloc(32, 9);
await applyLedgerSchema(shared);
await shared.exec(MIRROR_STATE_DDL);
raw.exec(`CREATE TABLE recovery_reply_controls (
 bot_id TEXT NOT NULL, update_id BIGINT NOT NULL, tenant TEXT NOT NULL, smart_account TEXT NOT NULL, chain_id BIGINT NOT NULL,
 token_tag TEXT NOT NULL, claim_stamp BIGINT NOT NULL, grant_tag TEXT NOT NULL, owner_id BIGINT NOT NULL, chat_id BIGINT NOT NULL,
 kind TEXT NOT NULL, request_update_id BIGINT, message_at_sec BIGINT NOT NULL, recorded_at_ms BIGINT NOT NULL, expires_at_ms BIGINT,
 PRIMARY KEY(bot_id,update_id))`);

class FakeProc extends EventEmitter {
  readonly stdout = null; readonly stderr = null; readonly signals: string[] = [];
  constructor(readonly pid: number) { super(); }
  kill(signal?: NodeJS.Signals | number) { this.signals.push(String(signal)); this.emit("exit", 0, "SIGTERM"); return true; }
}
/** What the home held at each fork: the moment that matters is the one the worker starts in. */
const forks: Array<{ home: string; paused: boolean; grant: boolean; files: string[] }> = [];
const spawned: FakeProc[] = [];
const confirmed: string[] = [];
setSpawnForTest((_cmd, _args, options) => {
  const home = String(options.env?.MERRYMEN_HOME);
  forks.push({ home, paused: existsSync(path.join(home, "paused")), grant: existsSync(path.join(home, "grant.json")), files: readdirSync(home).sort() });
  const proc = new FakeProc(81_000 + spawned.length); spawned.push(proc);
  return proc as unknown as ChildProcess;
});
setKillConfirmForTest(async (t) => { confirmed.push(t); });
setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
setPaperRestoreForTest(async () => ({ ok: true, line: null }));
after(() => {
  setRetirementMemoryStoreForTest(null); setPaperRestoreForTest(null);
  raw.close(); rmSync(fleet, { recursive: true, force: true });
});

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const grant = (account: `0x${string}`): StoredGrant => ({
  smartAccount: account, owner: addr(0x77), sessionKeyAddress: addr(0x78), serialized: `fixture-owner-controls-${account}`,
  chainId: 4663, grantedAt: nowSec() - 60, expiresAt: nowSec() + 86_400,
  caps: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiryDays: 7 },
  grantFeatures: ["tradeable-v2"], grantTokens: [], demoSessionPrivateKey: `0x${"ab".repeat(32)}`,
}) as unknown as StoredGrant;
function control(tenant: string, account: string, row: { update: number; kind: string; request?: number; at: number; expires?: number }) {
  raw.prepare(`INSERT INTO recovery_reply_controls (bot_id,update_id,tenant,smart_account,chain_id,token_tag,claim_stamp,grant_tag,owner_id,chat_id,
    kind,request_update_id,message_at_sec,recorded_at_ms,expires_at_ms) VALUES (?,?,?,?,4663,'t',1,'g',7,7,?,?,?,?,?)`)
    .run(String(500 + next), row.update, tenant, account, row.kind, row.request ?? null, row.at, row.at * 1000, row.expires ?? null);
}
/** This test's forks only. */
const forksOf = (tenant: string) => forks.filter((f) => f.home === childHome(tenant));
let next = 0;
beforeEach(() => { forks.length = 0; confirmed.length = 0; next += 1; });

it("a /kill confirmed while held removes the stored grant before any key reaches the home, and nothing spawns", async () => {
  const tenant = addr(0xd100 + next), account = addr(0xe100 + next)
  await getGrantStore().put(tenant, grant(account));
  const at = nowSec() + 30; // confirmed after the grant was stored
  control(tenant, account, { update: 1, kind: "kill-request", at: at - 20, expires: (at + 60) * 1000 });
  control(tenant, account, { update: 2, kind: "kill-confirm", request: 1, at });
  const before = spawned.length;
  await reconcile();
  assert.equal(spawned.length, before, "no worker");
  assert.equal(await getGrantStore().get(tenant), null, "the stored grant is gone");
  assert.equal(existsSync(path.join(childHome(tenant), "grant.json")), false, "and its key never reached the home");
  assert.deepEqual(confirmed, [tenant], "the ✅ is the existing kill's own");
  const receipt = raw.prepare("SELECT kind FROM recovery_reply_control_receipts WHERE tenant = ?").all(tenant) as Array<{ kind: string }>;
  assert.deepEqual(receipt.map((r) => r.kind), ["kill-forwarded"]);
  await reconcile();
  assert.equal(spawned.length, before, "and it stays killed");
});

it("a kill request that cannot be carried out keeps the spawn refused until honourKill gets through", async () => {
  const tenant = addr(0xd100 + next), account = addr(0xe100 + next)
  await getGrantStore().put(tenant, grant(account));
  const at = nowSec() + 30;
  control(tenant, account, { update: 1, kind: "kill-request", at: at - 20, expires: (at + 60) * 1000 });
  control(tenant, account, { update: 2, kind: "kill-confirm", request: 1, at });
  // The store refuses the delete this pass.
  const store = getGrantStore() as unknown as { removeUnlessNewer: (...a: unknown[]) => Promise<unknown> };
  const real = store.removeUnlessNewer.bind(store);
  store.removeUnlessNewer = async () => { throw new Error("store briefly unavailable"); };
  try {
    const before = spawned.length;
    await reconcile();
    assert.equal(spawned.length, before);
    assert.equal(killRequested(childHome(tenant)), true, "the request stays pending in the home");
    assert.equal(existsSync(path.join(childHome(tenant), "grant.json")), false);
    assert.equal((raw.prepare("SELECT count(*) AS n FROM recovery_reply_control_receipts WHERE tenant = ?").get(tenant) as { n: number }).n, 0,
      "no receipt before honourKill returns");
  } finally { store.removeUnlessNewer = real; }
  await reconcile();
  assert.equal(await getGrantStore().get(tenant), null, "carried out on the next pass");
  await reconcile();
});

it("a /pause recorded while held is in the home when the worker forks, once; the owner's /resume stands across a respawn", async () => {
  const tenant = addr(0xd100 + next), account = addr(0xe100 + next)
  control(tenant, account, { update: 3, kind: "pause", at: nowSec() - 60 });
  await getGrantStore().put(tenant, grant(account));
  await reconcile();
  assert.equal(forksOf(tenant).length, 1);
  assert.deepEqual({ paused: forksOf(tenant)[0]!.paused, grant: forksOf(tenant)[0]!.grant }, { paused: true, grant: true });
  const events = raw.prepare("SELECT message FROM events WHERE agent_id = ?").all(account) as Array<{ message: string }>;
  assert.equal(events.length, 1);
  assert.match(events[0]!.message, /^Telegram: paused by chat 7 .*\(recorded during upgrade\)$/);
  // The owner says /resume to the running child, then it crashes and respawns.
  rmSync(path.join(childHome(tenant), "paused"));
  spawned.at(-1)!.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 10));
  await reconcile();
  for (let i = 0; i < 40 && forksOf(tenant).length < 2; i++) { await new Promise((r) => setTimeout(r, 250)); await reconcile(); }
  assert.equal(forksOf(tenant).length, 2, "respawned");
  assert.equal(forksOf(tenant)[1]!.paused, false, "the /resume was not undone");
  assert.equal((raw.prepare("SELECT count(*) AS n FROM events WHERE agent_id = ?").get(account) as { n: number }).n, 1, "nothing applied twice");
  await getGrantStore().remove(tenant); await reconcile();
});

it("the owner's /resume, mirrored, stands when the home is then lost with no respawn in between", async () => {
  const tenant = addr(0xd100 + next), account = addr(0xe100 + next)
  control(tenant, account, { update: 3, kind: "pause", at: nowSec() - 60 });
  await getGrantStore().put(tenant, grant(account));
  await reconcile();
  assert.equal(forksOf(tenant).length, 1);
  assert.equal(forksOf(tenant)[0]!.paused, true);
  // The owner says /resume to the running child: it removes its file and
  // records the event, and a mirror pass carries the event up.
  rmSync(path.join(childHome(tenant), "paused"));
  raw.prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?, 'warn', 'Telegram: resumed by chat 7', ?)").run(account, nowSec());
  // Then the child stops and its home is lost outright: nothing armed there
  // in between, so the rebuilt home has no arm record.
  spawned.at(-1)!.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 10));
  rmSync(childHome(tenant), { recursive: true, force: true });
  await reconcile();
  for (let i = 0; i < 40 && forksOf(tenant).length < 2; i++) { await new Promise((r) => setTimeout(r, 250)); await reconcile(); }
  assert.equal(forksOf(tenant).length, 2, "respawned into the rebuilt home");
  assert.equal(forksOf(tenant)[1]!.paused, false, "the mirrored /resume was not undone");
  assert.equal((raw.prepare("SELECT paused_at FROM tenant_telegram WHERE tenant = ?").get(tenant) as { paused_at: unknown }).paused_at, null, "and the stamp is lifted");
  await getGrantStore().remove(tenant); await reconcile();
});

it("a kill superseded by a grant signed after it keeps that grant, and the worker forks paused", async () => {
  const tenant = addr(0xd100 + next), account = addr(0xe100 + next)
  const at = nowSec() - 600; // confirmed well before the grant now in the store
  control(tenant, account, { update: 1, kind: "kill-request", at: at - 20, expires: (at + 60) * 1000 });
  control(tenant, account, { update: 2, kind: "kill-confirm", request: 1, at });
  await getGrantStore().put(tenant, grant(account));
  await reconcile();
  assert.ok(await getGrantStore().get(tenant), "the newer grant is kept");
  assert.equal(forksOf(tenant).length, 1);
  assert.equal(forksOf(tenant)[0]!.paused, true);
  assert.equal(killRequested(childHome(tenant)), false, "the superseded request latches nothing");
  await getGrantStore().remove(tenant); await reconcile();
});

it("a malformed journal holds the tenant: no key, no worker", async () => {
  const tenant = addr(0xd100 + next), account = addr(0xe100 + next)
  control(tenant, account, { update: 2, kind: "kill-confirm", request: 1, at: nowSec() - 10 });
  await getGrantStore().put(tenant, grant(account));
  const before = spawned.length;
  await reconcile();
  assert.equal(spawned.length, before);
  assert.equal(existsSync(path.join(childHome(tenant), "grant.json")), false);
  await getGrantStore().remove(tenant); await reconcile();
});
