import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { wrapSqlite, type Db } from "../db";
import { applyLedgerSchema, canonicalJson, JOURNAL_GENESIS, journalHash } from "../store";
import { captureFinancialCapsule, validateFinancialCapsule } from "./hosted-financial-capsule";
import { decodeFinancialRecords, inspectFinancialStream, type FinancialChunks } from "./hosted-financial-stream";
import { HostedLiveCheckpointBridge } from "./hosted-live-supervisor";
import { HostedLiveCheckpointStore, HostedStanddownStore } from "./hosted-standdown-store";
import { durableHostedPerpStore, hostedPerpSendFence } from "./hosted-live-checkpoint";
import { recoverHostedChild } from "./hosted-recovery-retry";

const TENANT = "0x00000000000000000000000000000000000000aa";
const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const PUB = `0x${"01".repeat(40)}`;
const DEK = Buffer.alloc(32, 19);

async function fixture() {
  const home = mkdtempSync(path.join(os.tmpdir(), "mm-live-capsule-"));
  const sharedRaw = new DatabaseSync(":memory:"), shared = wrapSqlite(sharedRaw);
  const raw = new DatabaseSync(path.join(home, "merrymen.db")), local = wrapSqlite(raw);
  await applyLedgerSchema(shared); await applyLedgerSchema(local);
  await shared.exec("CREATE TABLE grants (tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
  await new HostedStanddownStore(shared, DEK).init();
  await shared.prepare("INSERT INTO grants VALUES (?, ?, 1)").run(TENANT, JSON.stringify({ smartAccount: ACCOUNT, perp: { apiPublicKey: PUB } }));
  await local.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, ?, ?, 4663, '{}', 1, 2000000000)").run(ACCOUNT, TENANT, TENANT);
  await local.prepare("INSERT INTO perp_accounts (agent_id, mode, nonce_high_water) VALUES (?, 'live', '456')").run(ACCOUNT);
  await local.prepare("INSERT INTO perp_orders (id, agent_id, mode, epoch, status, effect, reduce_only, worst_notional_micro, tx_info, nonce, tx_hash, account_index, api_key_index) VALUES ('held-close', ?, 'live', 1, 'submitted', 'close', 1, '0', 'EXACT_SIGNED_BYTES', 456, 'hash-held', 123, 16)").run(ACCOUNT);
  await local.prepare("INSERT INTO paper_book (agent_id, cash_usdg, vault_usdg, hwm_usdg, shares) VALUES (?, 50, 7, 100, '{}')").run(ACCOUNT);
  const prepare = (target = home) => HostedLiveCheckpointBridge.prepare({ shared, dek: DEK, tenant: TENANT, account: ACCOUNT, publicKey: PUB, home: target, healthy: () => true });
  return { home, shared, local, raw, prepare, close() { raw.close(); sharedRaw.close(); rmSync(home, { recursive: true, force: true }); } };
}

async function spotFact(db: Db, amount: number): Promise<void> {
  await db.tx(async tx => {
    await tx.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, user_op_hash) VALUES (?, 'swap', 'pool', ?, 'landed', ?)").run(ACCOUNT, amount, `op-${amount}`);
    await tx.prepare("INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg) VALUES (?, 'live', ?, '100', ?)").run(ACCOUNT, `TOKEN${amount}`, String(amount * 1e6));
    await tx.prepare("UPDATE paper_book SET cash_usdg = cash_usdg - ? WHERE agent_id = ?").run(amount, ACCOUNT);
    const prev = await tx.prepare("SELECT hash FROM journal WHERE agent_id = ? AND epoch = 1 ORDER BY seq DESC LIMIT 1").get(ACCOUNT) as { hash: string } | undefined;
    const payload = canonicalJson({ kind: "fill", amount, op: `op-${amount}` });
    const hash = prev?.hash ?? JOURNAL_GENESIS;
    await tx.prepare("INSERT INTO journal (agent_id, epoch, kind, payload_json, prev_hash, hash, at) VALUES (?, 1, 'fill', ?, ?, ?, 100)").run(ACCOUNT, payload, hash, journalHash(hash, payload));
  });
}
const capture = (db: Db) => db.tx(tx => captureFinancialCapsule(tx, ACCOUNT));
async function materialize(chunks:FinancialChunks) {
 const tables:Record<string,Record<string,unknown>[]>={};let table="";
 for await(const r of decodeFinancialRecords(chunks)){if(r.type==="table"){table=r.name;tables[table]=[];}else if(r.type==="row")tables[table]!.push(r.value);}
 return {v:2,account:ACCOUNT,tables};
}


describe("ordinary hosted financial recovery", () => {
  it("a temporary initial checkpoint failure recovers a stopped child's exact newer book without owner action", async () => {
    const f = await fixture();
    try {
      await spotFact(f.local, 3);
      const unavailable: Db = { ...f.shared, tx: fn => f.shared.tx(fn), exec: sql => f.shared.exec(sql), prepare() { throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" }); } };
      await assert.rejects(HostedLiveCheckpointBridge.prepare({ shared: unavailable, dek: DEK, tenant: TENANT, account: ACCOUNT, publicKey: PUB, home: f.home, healthy: () => true }), /connection reset/);
      await spotFact(f.local, 4); // spot/paper continued while venue sends were held
      const expected = validateFinancialCapsule(await capture(f.local), ACCOUNT);
      let stopped = false;
      await recoverHostedChild({ healthy: () => true, probe: async () => { await f.shared.prepare("SELECT 1").get(); },
        stop: async () => { stopped = true; return true; },
        mirror: async () => { assert.equal(stopped, true); return true; },
        restart: async () => { assert.equal(stopped, true); await f.prepare(); },
      });
      const store = new HostedLiveCheckpointStore(f.shared, DEK);
      assert.deepEqual(await materialize(store.loadStream((await store.latest(TENANT, ACCOUNT))!)), expected);
    } finally { f.close(); }
  });
  it("cold recovery restores the exact mixed financial book and the spot suffix captured by a parent mirror", async () => {
    const f = await fixture();
    try {
      await spotFact(f.local, 3);
      const bridge = await f.prepare();
      await spotFact(f.local, 4); // no perps mutation happened after this spot fact
      const expected = validateFinancialCapsule(await capture(f.local), ACCOUNT);
      await bridge.mirrorSnapshot(f.local, async snapshot => {
        assert.equal((await snapshot.prepare("SELECT COUNT(*) AS n FROM journal").get() as { n: number }).n, 2);
      });
      const cold = path.join(f.home, "replacement"); mkdirSync(cold);
      await f.prepare(cold);
      const replacement = new DatabaseSync(path.join(cold, "merrymen.db"));
      try {
        const restored = validateFinancialCapsule(await capture(wrapSqlite(replacement)), ACCOUNT);
        assert.deepEqual(restored, expected);
        assert.equal(restored.tables.perp_orders![0]!.tx_info, "EXACT_SIGNED_BYTES");
        assert.equal(restored.tables.paper_book![0]!.cash_usdg, 43);
        assert.equal(restored.tables.cost_basis!.length, 2);
      } finally { replacement.close(); }
    } finally { f.close(); }
  });

  it("a warm restart keeps a committed mixed-domain suffix that had not reached the parent", async () => {
    const f = await fixture();
    try {
      await spotFact(f.local, 3); await f.prepare();
      await spotFact(f.local, 4);
      const expected = validateFinancialCapsule(await capture(f.local), ACCOUNT);
      await f.prepare();
      assert.deepEqual(validateFinancialCapsule(await capture(f.local), ACCOUNT), expected);
      const store = new HostedLiveCheckpointStore(f.shared, DEK);
      assert.deepEqual(await materialize(store.loadStream((await store.latest(TENANT, ACCOUNT))!)), expected);
    } finally { f.close(); }
  });

  it("a corrupt local chain is restored from the authenticated complete capsule", async () => {
    const f = await fixture();
    try {
      await spotFact(f.local, 3); await f.prepare();
      const expected = validateFinancialCapsule(await capture(f.local), ACCOUNT);
      await f.local.prepare("UPDATE journal SET hash = 'broken'").run();
      await f.prepare();
      assert.deepEqual(validateFinancialCapsule(await capture(f.local), ACCOUNT), expected);
    } finally { f.close(); }
  });

  it("a warm submitted order and reserved nonce survive before there is any new fill journal entry", async () => {
    const f = await fixture();
    try {
      await spotFact(f.local, 3); await f.prepare();
      await f.local.tx(async tx => {
        await tx.prepare("UPDATE perp_accounts SET nonce_high_water = '457' WHERE agent_id = ? AND mode = 'live'").run(ACCOUNT);
        await tx.prepare("INSERT INTO perp_orders (id, agent_id, mode, epoch, status, effect, reduce_only, worst_notional_micro, tx_info, nonce, tx_hash, account_index, api_key_index) VALUES ('unacknowledged-close', ?, 'live', 1, 'submitted', 'close', 1, '0', 'PERSISTED_BEFORE_FIRST_SEND', 457, 'hash-new', 123, 16)").run(ACCOUNT);
      });
      const expected = validateFinancialCapsule(await capture(f.local), ACCOUNT);
      await f.prepare();
      assert.deepEqual(validateFinancialCapsule(await capture(f.local), ACCOUNT), expected);
      const live = new HostedLiveCheckpointStore(f.shared, DEK);
      const saved = (await materialize(live.loadStream((await live.latest(TENANT, ACCOUNT))!)));
      assert.equal(saved.tables.perp_orders!.find(row => row.id === "unacknowledged-close")!.tx_info, "PERSISTED_BEFORE_FIRST_SEND");
      assert.equal(saved.tables.perp_accounts![0]!.nonce_high_water, "457");
    } finally { f.close(); }
  });

  it("a valid-chain warm book with changed cash and no new journal facts is refused without overwriting it", async () => {
    const f = await fixture();
    try {
      await spotFact(f.local, 3); await f.prepare();
      await f.local.prepare("UPDATE paper_book SET cash_usdg = 999 WHERE agent_id = ?").run(ACCOUNT);
      await assert.rejects(f.prepare(), /diverge|audit/);
      assert.equal((await f.local.prepare("SELECT cash_usdg FROM paper_book").get() as { cash_usdg: number }).cash_usdg, 999);
      const live = new HostedLiveCheckpointStore(f.shared, DEK);
      assert.equal((await materialize(live.loadStream((await live.latest(TENANT, ACCOUNT))!))).tables.paper_book![0]!.cash_usdg, 47);
    } finally { f.close(); }
  });

  it("warm recovery preserves pending transfer and leg identities plus monotone payout remainders", async () => {
    const f=await fixture();try {
      await spotFact(f.local,3);
      await f.local.prepare("INSERT INTO perp_transfers(id,agent_id,mode,epoch,direction,amount_micro,initiator,state,venue_tx_hash) VALUES ('withdraw',?,'live',1,'withdraw','50','agent','submitted','vtx')").run(ACCOUNT);
      await f.local.prepare("INSERT INTO perp_order_legs(agent_id,mode,order_id,role,client_order_index,status) VALUES (?,'live','held-close','close',8,'submitted')").run(ACCOUNT);
      await f.local.prepare("INSERT INTO perp_payouts(id,agent_id,mode,epoch,chain_id,tx_hash,log_index,block_number,amount_micro,remaining_micro) VALUES ('payout',?,'live',1,4663,'chain-tx',0,'1','100','50')").run(ACCOUNT);
      await f.prepare();
      await f.local.prepare("UPDATE perp_transfers SET state='executed'").run();
      await f.local.prepare("UPDATE perp_order_legs SET status='open',venue_order_index='venue-leg'").run();
      await f.local.prepare("UPDATE perp_payouts SET remaining_micro='25'").run();
      await f.prepare();
      await f.local.prepare("UPDATE perp_payouts SET remaining_micro='50'").run();
      await assert.rejects(f.prepare(),/diverge/);
      await f.local.prepare("UPDATE perp_payouts SET remaining_micro='25'").run();
      await f.local.prepare("DELETE FROM perp_transfers WHERE id='withdraw'").run();
      await assert.rejects(f.prepare(),/diverge/);
      const saved=await materialize(new HostedLiveCheckpointStore(f.shared,DEK).loadStream((await new HostedLiveCheckpointStore(f.shared,DEK).latest(TENANT,ACCOUNT))!));
      assert.equal(saved.tables.perp_transfers!.length,1);assert.equal(saved.tables.perp_payouts![0]!.remaining_micro,'25');
    }finally{f.close();}
  });

  it("first migration refuses equal counts with different shared financial facts", async () => {
    const f = await fixture();
    try {
      await spotFact(f.local, 3);
      const held = await f.local.prepare("SELECT * FROM trades").get() as Record<string, unknown>;
      const changed: Record<string, unknown> = { ...held, amount_usdg: 99 };
      const keys = Object.keys(changed);
      await f.shared.prepare(`INSERT INTO trades (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map(k => changed[k]));
      await assert.rejects(f.prepare(), /diverges/);
      assert.equal(await new HostedLiveCheckpointStore(f.shared, DEK).latest(TENANT, ACCOUNT), null);
    } finally { f.close(); }
  });
});

describe("ordinary hosted final send checkpoint", () => {
  it("replay after a failed checkpoint waits for full durable bytes before the authority fence and send", async () => {
    const f = await fixture();
    const original = { hosted: process.env.MERRYMEN_HOSTED, home: process.env.MERRYMEN_HOME, send: process.send, connected: Object.getOwnPropertyDescriptor(process, "connected") };
    const oldMessageListeners = new Set(process.listeners("message")), oldDisconnectListeners = new Set(process.listeners("disconnect"));
    const calls: { kind: string; id: number; payload?: string }[] = [];
    const ack = (id: number, ok: boolean) => (process as unknown as EventEmitter).emit("message", { kind: "perp-ack", id, ok });
    try {
      process.env.MERRYMEN_HOSTED = "1"; process.env.MERRYMEN_HOME = f.home;
      Object.defineProperty(process, "connected", { configurable: true, value: true });
      process.send = ((msg: { kind: string; id: number; payload?: string }) => { calls.push(msg); return true; }) as typeof process.send;
      const waitCall = async (n: number) => {
        for (let i = 0; i < 100 && calls.length < n; i++) await new Promise(resolve => setImmediate(resolve));
        assert.ok(calls.length >= n, `IPC call ${n} arrived`); return calls[n - 1]!;
      };
      const wrapped = durableHostedPerpStore({ insertPerpOrderSubmitted: async (_args: { agentId: string }) => {
        await f.local.prepare("UPDATE perp_orders SET tx_info = 'LOCALLY_COMMITTED_UNACKNOWLEDGED'").run(); return "held-close";
      } });
      const mutation = wrapped.insertPerpOrderSubmitted({ agentId: ACCOUNT });
      const rejected = assert.rejects(mutation, /refused authority/);
      const first = await waitCall(1); ack(first.id, false); await rejected;
      let sent = false;
      const replay = hostedPerpSendFence(ACCOUNT).then(() => { sent = true; });
      const checkpoint = await waitCall(2);
      assert.equal(checkpoint.kind, "perp-checkpoint-begin"); assert.equal(sent, false); assert.equal(calls.length, 2);
      ack(checkpoint.id, true);
      const pages:Buffer[]=[];let n=3;
      for(;;){const call=await waitCall(n++);if(call.kind==="perp-checkpoint-commit"){
       const saved=await materialize(pages);assert.equal(saved.tables.perp_orders![0]!.tx_info,"LOCALLY_COMMITTED_UNACKNOWLEDGED");
       await inspectFinancialStream(pages,ACCOUNT,{scope:"financial"});assert.equal(sent,false);ack(call.id,true);break;
      }assert.equal(call.kind,"perp-checkpoint-page");pages.push(Buffer.from(JSON.parse(call.payload!).data,"base64"));ack(call.id,true);}
      const fence = await waitCall(n); assert.equal(fence.kind, "perp-fence"); assert.equal(sent, false);
      ack(fence.id, true); await replay; assert.equal(sent, true);
    } finally {
      if (original.hosted === undefined) delete process.env.MERRYMEN_HOSTED; else process.env.MERRYMEN_HOSTED = original.hosted;
      if (original.home === undefined) delete process.env.MERRYMEN_HOME; else process.env.MERRYMEN_HOME = original.home;
      process.send = original.send;
      if (original.connected) Object.defineProperty(process, "connected", original.connected); else delete (process as { connected?: boolean }).connected;
      for (const listener of process.listeners("message")) if (!oldMessageListeners.has(listener)) process.removeListener("message", listener as (...args: unknown[]) => void);
      for (const listener of process.listeners("disconnect")) if (!oldDisconnectListeners.has(listener)) process.removeListener("disconnect", listener as (...args: unknown[]) => void);
      f.close();
    }
  });
});
