/**
 * A PERPS WORKER'S LAST ROWS REACH THE SHARED LEDGER (slice 4): every way a
 * hosted Perps worker stops, through the real reconcile() and drain, with a
 * sqlite stand-in for the shared database and a Perps book on disk.
 *
 *  - killed, its grant removed: the removed home's final pass;
 *  - MERRYMEN_PERPS leaving paper, and a Spot worker taking its process slot:
 *    the stood-down worker's final pass, then its lease back;
 *  - held before its grant was handed over, then removed: the account it was
 *    read with, not one only a handed-over grant would have named;
 *  - after a restart, with no account in memory: the durable perps_wallets
 *    record, only when the book agrees with it;
 *  - its grant expiring under it: expiry retirement's final pass;
 *  - the SIGTERM drain: the drain's final pass, as a Railway variable change
 *    actually stops one.
 *
 * And the wiring no reconcile() reaches: the order ferry mirrors the login's
 * pause, the main loop refreshes the fleet feed, the drain stops the feed
 * before children are signalled.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, describe, it } from "node:test";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { privateKeyToAccount } from "viem/accounts";
import type { StoredGrant } from "../../packages/core/src/index";

const fleet = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-perps-final-")));
process.env.MERRYMEN_HOME = fleet;
process.env.MERRYMEN_HOSTED = "1";
delete process.env.DATABASE_URL;
delete process.env.MERRYMEN_ACCOUNTING_HOLD_TENANTS;
delete process.env.MERRYMEN_FLEET_RECOVERY_REPORT_ONLY;
delete process.env.MERRYMEN_PERSISTENT_HOME_REQUIRED;
delete process.env.MERRYMEN_FLEET_ROLLOUT;
delete process.env.MERRYMEN_DRAIN_BUDGET_MS;
for (const key of Object.keys(process.env)) if (key.startsWith("RAILWAY_")) delete process.env[key];
const dek = Buffer.alloc(32, 43);
process.env.MERRYMEN_STORE_DEK = dek.toString("base64");
process.env.MERRYMEN_PERPS = "paper";

const orch = await import("./orchestrator");
const { getGrantStore } = await import("./grant-store");
const { writeKillRequest } = await import("./kill-request");
const { acquireTenantLease } = await import("./tenant-lease");
const { wrapSqlite } = await import("./db");
const { applyLedgerSchema } = await import("./store");
const { MIRROR_STATE_DDL } = await import("./ledger-mirror");
const { ensureTelegramSchema } = await import("./telegram-store");
const { SHUTDOWN_RECEIPT_FILE, shutdownReceiptDir } = await import("./fleet-drain");

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
  static next = 96_000;
  readonly pid = FakeProc.next++;
  readonly stdout = null;
  readonly stderr = null;
  readonly signals: string[] = [];
  gone = false;
  constructor(readonly env: NodeJS.ProcessEnv) { super(); }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal ?? "SIGTERM"));
    setImmediate(() => {
      if (this.gone) return;
      this.gone = true;
      this.emit("exit", null, "SIGTERM");
    });
    return true;
  }
}
const spawned: FakeProc[] = [];
orch.setSpawnForTest((_c: string, _a: readonly string[], o: SpawnOptions) => {
  const p = new FakeProc(o.env ?? {});
  spawned.push(p);
  return p as unknown as ChildProcess;
});
orch.setLeaseAcquireForTest(async (t) => acquireTenantLease(t));
orch.setKillConfirmForTest(async () => {});
orch.setSolanaKillForTest(async () => {});
orch.setPaperRestoreForTest(async () => ({ ok: true, line: null }));
orch.setPerpsFeedStartForTest(() => ({ stop: () => {} }));
const said: string[] = [];
const realLog = console.log;
console.log = (...a: unknown[]) => { said.push(a.map(String).join(" ")); };
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const spot = getGrantStore("spot"), perps = getGrantStore("perps");
const perpsKey = (owner: string) => `${owner}:perps` as `0x${string}`;
const live = (tenant: string) => spawned.filter((p) => p.env.MERRYMEN_HOME === orch.childHome(tenant) && !p.gone);
const used: `0x${string}`[] = [];
const ownerAt = (n: number) => { const o = address(n); used.push(o); return o; };

/**
 * The shared database, as the hosted fleet has it: ledger, mirror state, owner
 * controls. `onRecordRead` runs once, the first time anything reads the
 * perps_wallets record (not when the orchestrator writes it).
 */
async function sharedDb(opts: { controls?: boolean; onRecordRead?: () => void } = {}) {
  const raw = new DatabaseSync(":memory:");
  const inner = wrapSqlite(raw);
  await applyLedgerSchema(inner);
  await inner.exec(MIRROR_STATE_DDL);
  if (opts.controls !== false) await ensureTelegramSchema(inner);
  let onRecordRead = opts.onRecordRead ?? null;
  const shared: typeof inner = {
    prepare(sql) {
      if (onRecordRead && /perps_wallets/.test(sql) && !/INSERT|CREATE/.test(sql)) {
        const f = onRecordRead;
        onRecordRead = null;
        f();
      }
      return inner.prepare(sql);
    },
    exec: (sql) => inner.exec(sql),
    tx: (fn) => inner.tx(fn),
  };
  orch.setRetirementMemoryStoreForTest({ shared, dek, dialect: "sqlite" });
  const fills = (account: string) =>
    (raw.prepare("SELECT agent_id FROM perp_fills WHERE agent_id = ?").all(account.toLowerCase()) as unknown[]).length;
  return { raw, shared, fills };
}

/** What a hosted Perps worker leaves in its home: its agent, its paper account, one fill. `alsoAgent` is a second agents row no Perps book should hold. */
async function perpsBook(owner: `0x${string}`, account: `0x${string}`, alsoAgent?: `0x${string}`): Promise<void> {
  const home = orch.childHome(perpsKey(owner));
  mkdirSync(home, { recursive: true });
  const raw = new DatabaseSync(path.join(home, "merrymen.db"));
  try {
    await applyLedgerSchema(wrapSqlite(raw));
    for (const agent of [account, ...(alsoAgent ? [alsoAgent] : [])])
      raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at)
        VALUES (?, ?, ?, 4663, '{}', 1, 9999999999)`).run(agent, owner, agent);
    raw.prepare(`INSERT INTO perp_accounts (agent_id, mode, paper_collateral_micro, nonce_high_water) VALUES (?, 'paper', '1000000', '5')`)
      .run(account.toLowerCase());
    raw.prepare(`INSERT INTO perp_fills (agent_id, mode, epoch, venue_trade_id, side_role, market_id, side, base, price, quote_micro, fee_micro,
      trade_type, attribution, venue_ts_ms, created_at) VALUES (?, 'paper', 1, 'paper:open:1:5', 'taker', 1, 'buy', '10', '100', '1000', '0',
      'trade', 'own', 1, ?)`).run(account.toLowerCase(), nowSec() - 5);
  } finally { raw.close(); }
}

async function passes(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await orch.reconcile();
    await settle();
  }
}

after(() => {
  console.log = realLog;
  orch.setLeaseAcquireForTest(null);
  orch.setPaperRestoreForTest(null);
  orch.setPerpsFeedStartForTest(null);
  orch.setRetirementMemoryStoreForTest(null);
  orch.setPhantomProcessesForTest(0);
  rmSync(fleet, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
afterEach(async () => {
  process.env.MERRYMEN_PERPS = "paper";
  orch.setPhantomProcessesForTest(0);
  for (const o of used.splice(0)) {
    await spot.remove(o);
    await perps.remove(o);
  }
  await passes(2);
  orch.setRetirementMemoryStoreForTest(null);
  for (const dir of ["children", "children-perps", "tenants", "tenants-perps", "tenant-settings", "tenant-settings-perps"]) rmSync(path.join(fleet, dir), { recursive: true, force: true });
  spawned.length = 0;
  said.length = 0;
});

describe("a stopped Perps worker's final pass", () => {
  it("killed from the Spot bot: its perp rows reach the shared ledger under its own account, then its lease goes", async () => {
    const { fills } = await sharedDb();
    const o = ownerAt(0x71), spotAcct = address(0x72), perpsAcct = address(0x73);
    await spot.put(o, grant(o, spotAcct));
    await perps.put(o, grant(o, perpsAcct, { purpose: "perps" }));
    await passes(1);
    assert.equal(live(perpsKey(o)).length, 1);
    await perpsBook(o, perpsAcct);
    writeKillRequest(orch.childHome(o), (await spot.get(o))!, nowSec());
    await orch.honourPendingKills();
    await settle();
    assert.equal(await perps.get(o), null, "the kill takes the Perps grant too");
    await passes(2);
    assert.equal(fills(perpsAcct), 1, "the Perps worker's last fill is on the shared tape");
    assert.equal(fills(spotAcct), 0, "and never under the Spot account");
    assert.equal(orch.hasLeaseForTest(perpsKey(o)), false, "its lease is given back");
    assert.ok(existsSync(path.join(orch.childHome(perpsKey(o)), "merrymen.db")), "its original book is kept");
    assert.ok(!existsSync(path.join(orch.childHome(perpsKey(o)), "grant.json")), "and its revoked grant's copy is gone");
  });

  it("MERRYMEN_PERPS leaving paper: stood down, final-passed, its lease back; its grant is kept", async () => {
    const { fills } = await sharedDb();
    const o = ownerAt(0x81), perpsAcct = address(0x83);
    await perps.put(o, grant(o, perpsAcct, { purpose: "perps" }));
    await passes(1);
    assert.equal(live(perpsKey(o)).length, 1);
    await perpsBook(o, perpsAcct);
    process.env.MERRYMEN_PERPS = "off";
    await passes(2);
    assert.equal(live(perpsKey(o)).length, 0);
    assert.equal(fills(perpsAcct), 1);
    assert.equal(orch.hasLeaseForTest(perpsKey(o)), false);
    assert.ok(await perps.get(o), "off freezes the book; the grant stays for the next paper");
  });

  it("a Spot worker taking its process slot: stood down, final-passed, its lease back", async () => {
    const { fills } = await sharedDb();
    orch.setPhantomProcessesForTest(46);
    const a = ownerAt(0x91), b = ownerAt(0x92), c = ownerAt(0x93), perpsAcct = address(0x94);
    await spot.put(a, grant(a, address(0x95)));
    await perps.put(b, grant(b, perpsAcct, { purpose: "perps" }));
    await passes(1);
    assert.equal(live(perpsKey(b)).length, 1, "the last slot went to a Perps worker");
    await perpsBook(b, perpsAcct);
    await spot.put(c, grant(c, address(0x96)));
    await passes(3);
    assert.equal(live(c).length, 1, "the Spot worker has the slot");
    assert.equal(live(perpsKey(b)).length, 0);
    assert.equal(fills(perpsAcct), 1, "the yielded worker's last fill is on the shared tape");
    assert.equal(orch.hasLeaseForTest(perpsKey(b)), false, "and its lease is given back");
  });

  it("held before its grant was handed over, then removed: copied under the account its spawn read", async () => {
    // No owner-controls schema: perpsOwnerControls cannot read, and holds the
    // spawn before writeGrantForChild — where a journalled /kill awaiting its
    // /confirm holds it too.
    const { fills } = await sharedDb({ controls: false });
    const o = ownerAt(0xa1), perpsAcct = address(0xa3);
    await perpsBook(o, perpsAcct);
    await perps.put(o, grant(o, perpsAcct, { purpose: "perps" }));
    await passes(1);
    assert.equal(live(perpsKey(o)).length, 0, "held");
    assert.equal(orch.hasLeaseForTest(perpsKey(o)), true, "under its lease");
    await perps.remove(o);
    said.length = 0;
    await passes(3);
    assert.equal(fills(perpsAcct), 1, "the book's last fill is on the shared tape");
    assert.equal(orch.hasLeaseForTest(perpsKey(o)), false, "and its lease is given back");
    assert.ok(!said.some((l) => /STALLED/.test(l)), said.filter((l) => /STALLED/.test(l)).join("\n"));
  });

  it("after a restart, with no account in memory: the durable record names it — only when the book agrees", async () => {
    const { raw, fills } = await sharedDb();
    const o = ownerAt(0xb1), perpsAcct = address(0xb3);
    const p = ownerAt(0xb5), otherAcct = address(0xb7);
    await perps.put(o, grant(o, perpsAcct, { purpose: "perps" }));
    await perps.put(p, grant(p, otherAcct, { purpose: "perps" }));
    await passes(1);
    assert.equal(live(perpsKey(o)).length, 1);
    assert.equal(live(perpsKey(p)).length, 1);
    await perpsBook(o, perpsAcct);
    await perpsBook(p, otherAcct);
    // p's record names some other account: it is not p's book's, so nothing
    // may be copied under it.
    raw.prepare("UPDATE perps_wallets SET smart_account = ? WHERE owner = ?").run(address(0xbf), p);
    orch.forgetPerpsSlotAccountsForTest();
    await perps.remove(o);
    await perps.remove(p);
    await passes(3);
    assert.equal(fills(perpsAcct), 1, "the record and the book agree: copied");
    assert.equal(orch.hasLeaseForTest(perpsKey(o)), false);
    assert.equal(fills(otherAcct), 0, "they disagree: nothing copied");
    assert.equal(orch.hasLeaseForTest(perpsKey(p)), true, "and the lease and home are kept for recovery");
    assert.ok(existsSync(path.join(orch.childHome(perpsKey(p)), "merrymen.db")));
  });

  it("a book that is not one account's: nothing is copied, and its lease and home are kept", async () => {
    const { fills } = await sharedDb();
    const o = ownerAt(0xb9), perpsAcct = address(0xba);
    await perps.put(o, grant(o, perpsAcct, { purpose: "perps" }));
    await passes(1);
    assert.equal(live(perpsKey(o)).length, 1);
    await perpsBook(o, perpsAcct, address(0xbb));
    await perps.remove(o);
    await passes(3);
    assert.equal(fills(perpsAcct), 0, "no account's rows are settled as another's");
    assert.equal(orch.hasLeaseForTest(perpsKey(o)), true, "the lease is kept");
    assert.ok(existsSync(path.join(orch.childHome(perpsKey(o)), "merrymen.db")), "and the home");
    assert.ok(said.some((l) => l.includes("This Perps book is not one account's")), "and it is said");
  });

  it("a lease lost while the account is read leaves no recovery barrier, and copies nothing", async () => {
    let o = "" as `0x${string}`;
    const { fills } = await sharedDb({ onRecordRead: () => orch.loseLeaseForTest(perpsKey(o)) });
    o = ownerAt(0xbc);
    const perpsAcct = address(0xbd);
    await perps.put(o, grant(o, perpsAcct, { purpose: "perps" }));
    await passes(1);
    assert.equal(live(perpsKey(o)).length, 1);
    await perpsBook(o, perpsAcct);
    orch.forgetPerpsSlotAccountsForTest();
    await perps.remove(o);
    await passes(3);
    assert.equal(fills(perpsAcct), 0, "no copy without the lease");
    assert.ok(!existsSync(path.join(orch.childHome(perpsKey(o)), "ledger-source-blocked.json")), "and no barrier left behind");
    assert.ok(existsSync(path.join(orch.childHome(perpsKey(o)), "merrymen.db")), "the book is kept");
  });

  it("its grant expiring under it: stood down, final-passed by expiry retirement, its lease back", async () => {
    const { fills } = await sharedDb();
    const o = ownerAt(0xc1), perpsAcct = address(0xc3);
    const signed = grant(o, perpsAcct, { purpose: "perps" });
    await perps.put(o, signed);
    await passes(1);
    assert.equal(live(perpsKey(o)).length, 1);
    await perpsBook(o, perpsAcct);
    await perps.put(o, { ...signed, expiresAt: nowSec() - 1 });
    await passes(3);
    assert.equal(live(perpsKey(o)).length, 0, "an expired grant runs no Perps worker");
    assert.equal(fills(perpsAcct), 1, "its last fill is on the shared tape");
    assert.equal(orch.hasLeaseForTest(perpsKey(o)), false, "its lease is given back");
    assert.ok(await perps.get(o), "expiry keeps the stored grant");
  });
});

describe("a re-sign under a running Perps worker", () => {
  it("is never handed over when it names another account: the worker keeps its own, and the record is unchanged", async () => {
    const { readPerpsWallets } = await import("./perps-wallets");
    const { shared } = await sharedDb();
    const o = ownerAt(0xe1), perpsAcct = address(0xe2), other = address(0xe3);
    await perps.put(o, grant(o, perpsAcct, { purpose: "perps" }));
    await passes(1);
    assert.equal(live(perpsKey(o)).length, 1);
    await perps.put(o, grant(o, other, { purpose: "perps" }));
    await passes(1);
    const handed = JSON.parse(readFileSync(path.join(orch.childHome(perpsKey(o)), "grant.json"), "utf8")) as { smartAccount: string };
    assert.equal(handed.smartAccount.toLowerCase(), perpsAcct, "the running worker's grant still names its own account");
    assert.equal(live(perpsKey(o)).length, 1, "and the worker is not stood down by the refresh");
    assert.deepEqual([...await readPerpsWallets(shared)], [perpsAcct], "no account the record never named runs");
    assert.ok(said.some((l) => l.includes("names another account than the running Perps worker's")), "it is an alert");
  });
});

describe("wiring no reconcile() pass reaches", () => {
  const source = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
  const body = (name: string) => {
    const at = source.search(new RegExp(`\\n(?:export )?(?:async )?function ${name}\\(`));
    assert.ok(at >= 0, `${name} is defined`);
    return source.slice(at, source.indexOf("\n}\n", at));
  };

  it("the order ferry mirrors the login's pause into its Perps home every turn", () => {
    assert.match(body("orderFerryLoop"), /mirrorLoginPauses\(\)/);
  });

  it("the main loop refreshes the fleet feed, and the drain stops it before children are signalled", () => {
    assert.match(source, /\n\s+await refreshPerpsFeed\(\);/);
    assert.match(source, /onDrainBeforeChildren\("perps feed",/);
  });
});

// Last: a drain closes this process's copies for good.
describe("the SIGTERM drain (how a Railway variable change stops a Perps worker)", () => {
  it("final-passes a running Perps worker's book under its own account", async () => {
    const { fills } = await sharedDb();
    const o = ownerAt(0xd1), spotAcct = address(0xd2), perpsAcct = address(0xd3);
    await spot.put(o, grant(o, spotAcct));
    await perps.put(o, grant(o, perpsAcct, { purpose: "perps" }));
    await passes(1);
    assert.equal(live(perpsKey(o)).length, 1);
    await perpsBook(o, perpsAcct);
    const spotBook = new DatabaseSync(path.join(orch.childHome(o), "merrymen.db"));
    await applyLedgerSchema(wrapSqlite(spotBook));
    spotBook.close();
    const exits: number[] = [];
    await orch.drainFleetForTest("SIGTERM", {
      budgetMs: 15_000,
      limits: { hooksMs: 500, settleMs: 5_000, exitWaitMs: 300, killGraceMs: 100, pendingKillsMs: 1_000, finalPassMinMs: 0, reserveMs: 50, pollMs: 5 },
      exit: (code: number) => { exits.push(code); },
    });
    assert.deepEqual(exits, [0]);
    assert.equal(live(perpsKey(o)).length, 0);
    assert.equal(fills(perpsAcct), 1, "the Perps worker's last fill is on the shared tape");
    const receipt = JSON.parse(readFileSync(path.join(shutdownReceiptDir(fleet), SHUTDOWN_RECEIPT_FILE), "utf8"));
    assert.equal(receipt.clean, true, JSON.stringify(receipt));
    assert.equal(receipt.finalPass.saved, 2, "both of the login's homes saved");
    orch.resetDrainForTest();
  });
});
