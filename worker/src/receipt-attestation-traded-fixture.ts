/** Isolated traded-book accounting fixture; no production URLs, secrets or writes. */
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CASH } from "../../packages/core/src/index";
import { TRANSFER_TOPIC, type RpcCall } from "./chain-capital";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema, canonicalJson, JOURNAL_GENESIS, journalHash } from "./store";
import { LEDGER_IMPORT_SCHEMA, LEDGER_IMPORT_GENERATIONS_SCHEMA } from "./ledger-import-schema";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import type { TradedReceiptAttestationOptions } from "./receipt-attestation-traded";
import type { TenantLease } from "./tenant-lease";
import { TEST_ACCOUNT, TEST_TENANT } from "./receipt-attestation-fixture";

export { TEST_ACCOUNT, TEST_TENANT };
export const DEPOSITOR = "0x00000000000000000000000000000000000000f1";
const POOL = "0x00000000000000000000000000000000000000e7";
const TOKEN = "0x00000000000000000000000000000000000000c5";
/** Alan's 10-18 top-up, to the micro-USDG. */
export const TOP_UP = 59.95446;
export const TOP_UP_RAW = 59_954_460n;
export const BLOCK = { open: 1_000, baseline: 2_000_000, deposit: 2_000_600, booking: 2_000_700, trade: 2_001_194, next: 2_001_300 } as const;
export const HEAD = 2_300_000n;
export const LOCAL_FLOW = 2, SHARED_FLOW = 428;
const tx = (fill: string) => `0x${fill.repeat(64 / fill.length)}`;
export const TX = { open: tx("0a"), deposit: tx("a8"), early: tx("e1"), trade: tx("7d") };
export const blockHash = (n: bigint | number) => { const h = BigInt(n).toString(16); return `0x${"b".repeat(64 - h.length)}${h}`; };
/** ~10 blocks a second around the deposit. */
export const blockTime = (n: bigint | number) => 1_792_000_000 + Math.floor((Number(n) - BLOCK.baseline) / 10);
export const BOOKED_AT = blockTime(BLOCK.booking) + 2;
const topic = (address: string) => `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
export interface FixtureLog { address: string; topics: string[]; data: string; blockNumber: string; blockHash: string; transactionHash: string; logIndex: string; removed: boolean }
export function transferLog(o: { token?: string; from: string; to: string; raw: bigint; block: number; tx: string; index: number }): FixtureLog {
  return { address: o.token ?? CASH.USDG, topics: [TRANSFER_TOPIC, topic(o.from), topic(o.to)], data: word(o.raw),
    blockNumber: `0x${o.block.toString(16)}`, blockHash: blockHash(o.block), transactionHash: o.tx, logIndex: `0x${o.index.toString(16)}`, removed: false };
}

/** A book that funded, traded on both sides of an inferred top-up, accrued a fee and holds a position. */
export async function tradedFixture(sharedDb?: Db, lease?: TenantLease, opts: { heldBeforeEntry?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mm-traded-attestation-")));
  const homeRoot = path.join(root, "fleet"), home = path.join(homeRoot, "children", TEST_TENANT);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, "merrymen.db"), raw = new DatabaseSync(file), local = wrapSqlite(raw);
  chmodSync(file, 0o600);
  const memory = sharedDb ? null : new DatabaseSync(":memory:");
  const shared = sharedDb ?? wrapSqlite(memory!);
  await applyLedgerSchema(local); await applyLedgerSchema(shared);
  for (const ddl of [LEDGER_IMPORT_SCHEMA, LEDGER_IMPORT_GENERATIONS_SCHEMA, MIRROR_STATE_DDL]) await shared.exec(ddl);
  if (!sharedDb) await shared.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY,grant_json TEXT,updated_at INTEGER,row_version INTEGER)");
  await shared.prepare("INSERT INTO grants(tenant,grant_json,updated_at,row_version) VALUES(?,?,?,?)").run(TEST_TENANT,
    JSON.stringify({ smartAccount: TEST_ACCOUNT, owner: TEST_TENANT, chainId: 4663 }), 1234, 1);
  const flowAt = { open: blockTime(BLOCK.open) + 5, inferred: BOOKED_AT };
  for (const [db, ids] of [[local, { open: 1, inferred: LOCAL_FLOW, trade: 1 }], [shared, { open: 501, inferred: SHARED_FLOW, trade: 900 }]] as const) {
    await db.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,mode,hwm_usdg,epoch,hwm_withdrawn_usdg,accrued_fee_usdg) VALUES(?,?,?,4663,?,1,9999999999,'live',?,1,0,0.12)")
      .run(TEST_ACCOUNT, TEST_TENANT, DEPOSITOR, '{"perTradeUsdg":40,"dailyUsdg":100,"maxDrawdownPct":5}', 100 + TOP_UP);
    await db.prepare("INSERT INTO flows(id,agent_id,direction,amount_usdg,tx_hash,block_number,log_index,source,at,epoch,chain_id) VALUES(?,?,'in',100,?,?,4,'chain-log',?,1,4663)")
      .run(ids.open, TEST_ACCOUNT, TX.open, BLOCK.open, flowAt.open);
    await db.prepare("INSERT INTO flows(id,agent_id,direction,amount_usdg,source,at,epoch,chain_id) VALUES(?,?,'in',?,'inferred',?,1,4663)")
      .run(ids.inferred, TEST_ACCOUNT, TOP_UP, flowAt.inferred);
    for (const [i, t] of [[0, { hash: TX.early, op: tx("01"), at: blockTime(BLOCK.baseline) - 900 }], [1, { hash: TX.trade, op: tx("02"), at: blockTime(BLOCK.trade) }]] as const) {
      await db.prepare("INSERT INTO trades(id,agent_id,kind,target,amount_usdg,user_op_hash,tx_hash,status,fill_side,fill_cash_usdg,created_at,epoch) VALUES(?,?,'swap','pool',2.5,?,?,'landed','buy',2.5,?,1)")
        .run(ids.trade + i, TEST_ACCOUNT, t.op, t.hash, t.at);
    }
    await db.prepare("INSERT INTO trades(id,agent_id,kind,target,amount_usdg,status,reject_rule,created_at,epoch) VALUES(?,?,'swap','pool',2.5,'rejected','portfolio-quality-insufficient',?,1)")
      .run(ids.trade + 2, TEST_ACCOUNT, BOOKED_AT + 600);
    await db.prepare("INSERT INTO fee_accruals(agent_id,profit_usdg,fee_usdg,hwm_before_usdg,hwm_after_usdg,at,epoch) VALUES(?,0.6,0.12,100,100.6,?,1)").run(TEST_ACCOUNT, flowAt.open + 60);
    await db.prepare("INSERT INTO positions(agent_id,symbol,token,raw_balance,ui_multiplier,price_usd,value_usdg) VALUES(?,'COIN',?,'1000','1',2.4,2.4)").run(TEST_ACCOUNT, TOKEN);
    for (const [cash, block] of [[97.5, BLOCK.baseline], [157.45446, BLOCK.booking], [154.95446, BLOCK.next]] as const) {
      await db.prepare("INSERT INTO equity(agent_id,eth_wei,cash_usdg,vault_usdg,positions_usdg,equity_usdg,at,epoch,mode,flows_held,cash_read_at) VALUES(?,'100',?,0,2.4,?,?,1,'live',0,?)")
        .run(TEST_ACCOUNT, cash, cash + 2.4, blockTime(block) + 3, blockTime(block));
    }
  }
  await local.exec("CREATE TABLE ledger_source_identity(id INTEGER PRIMARY KEY,book_id TEXT,tenant TEXT,smart_account TEXT,chain_id INTEGER)");
  await local.prepare("INSERT INTO ledger_source_identity VALUES(1,?,?,?,4663)").run("original-book-id", TEST_TENANT, TEST_ACCOUNT.toLowerCase());
  // THE ORIGINAL JOURNAL, as the worker appends it (store.ts appendJournalRow).
  let head = JOURNAL_GENESIS;
  const journal = async (kind: string, payload: unknown, at: number) => {
    const json = canonicalJson(payload);
    await local.prepare("INSERT INTO journal(agent_id,epoch,kind,payload_json,prev_hash,hash,at) VALUES(?,1,?,?,?,?,?)").run(TEST_ACCOUNT, kind, json, head, journalHash(head, json), at);
    head = journalHash(head, json);
  };
  const mark = (block: number, cash: number, extra: Record<string, unknown> = {}) => journal("mark",
    { blockNumber: String(block), cashUsdg: cash, equityUsdg: cash + 2.4, ethWei: "100", marks: [], mode: "live", positionsUsdg: 2.4, vaultUsdg: 0, ...extra }, blockTime(block) + 3);
  await journal("flow", { amountUsdg: 100, blockNumber: BLOCK.open, direction: "in", logIndex: 4, source: "chain-log", txHash: TX.open }, flowAt.open);
  await mark(BLOCK.open + 10, 100);
  await journal("fill", { amountUsdg: 2.5, status: "landed", txHash: TX.early, userOpHash: tx("01") }, blockTime(BLOCK.baseline) - 900);
  await mark(BLOCK.baseline - 600, 97.5);
  await mark(BLOCK.baseline, 97.5);
  // A look held by an op in flight keeps its baseline: its reading is no cash baseline (store.ts flows_held).
  if (opts.heldBeforeEntry) await mark(BLOCK.baseline + 300, 97.5, { flowsHeld: true });
  await journal("flow", { amountUsdg: TOP_UP, blockNumber: null, direction: "in", logIndex: null, source: "inferred", txHash: null }, flowAt.inferred);
  await mark(BLOCK.booking, 157.45446);
  await journal("fill", { amountUsdg: 2.5, status: "landed", txHash: TX.trade, userOpHash: tx("02") }, blockTime(BLOCK.trade));
  await mark(BLOCK.next, 154.95446);
  const mount = lstatSync(root, { bigint: true }), stat = lstatSync(file, { bigint: true });
  const volume = { id: "vol_traded_fixture", mountPath: root, homeRoot, device: String(mount.dev), inode: String(mount.ino) };
  await shared.prepare("INSERT INTO tenant_ledger_import(tenant,generation,target_volume_id,state,sealed,bytes,sha256,source_digest,source_inode,source_identity,bindings_json,created_at_ms,consumed_at_ms,grant_updated_at,grant_row_version) VALUES(?,?,?,'consumed',NULL,0,'original-sha','original-source-digest',?,?,'{}',1230,1231,'1234','1')")
    .run(TEST_TENANT, "22222222-2222-4222-8222-222222222222", volume.id, String(stat.ino), "original-book-id");
  await shared.prepare("INSERT INTO tenant_ledger_import_generations VALUES(?,?,'consumed')").run("22222222-2222-4222-8222-222222222222", TEST_TENANT);
  for (const [table, id, stamp] of [["flows", LOCAL_FLOW, flowAt.inferred], ["trades", 3, BOOKED_AT + 600], ["equity", 3, blockTime(BLOCK.next) + 3], ["fee_accruals", 1, flowAt.open + 60]] as const) {
    await shared.prepare("INSERT INTO mirror_state(tenant,table_name,last_id,last_stamp,updated_at) VALUES(?,?,?,?,?)").run(TEST_TENANT, table, id, stamp, BOOKED_AT + 700);
  }
  // THE CHAIN: the opening deposit, the top-up, and two trades whose USDG leg pairs with a token leg.
  const deposit = transferLog({ from: DEPOSITOR, to: TEST_ACCOUNT, raw: TOP_UP_RAW, block: BLOCK.deposit, tx: TX.deposit, index: 2 });
  const logs: FixtureLog[] = [
    transferLog({ from: DEPOSITOR, to: TEST_ACCOUNT, raw: 100_000_000n, block: BLOCK.open, tx: TX.open, index: 4 }),
    deposit,
    transferLog({ from: TEST_ACCOUNT, to: POOL, raw: 2_500_000n, block: BLOCK.baseline - 9_000, tx: TX.early, index: 7 }),
    transferLog({ from: TEST_ACCOUNT, to: POOL, raw: 2_500_000n, block: BLOCK.trade, tx: TX.trade, index: 7 }),
  ];
  const tokenLegs: FixtureLog[] = [
    transferLog({ token: TOKEN, from: POOL, to: TEST_ACCOUNT, raw: 1_000n, block: BLOCK.baseline - 9_000, tx: TX.early, index: 8 }),
    transferLog({ token: TOKEN, from: POOL, to: TEST_ACCOUNT, raw: 1_000n, block: BLOCK.trade, tx: TX.trade, index: 8 }),
  ];
  let chainHead = HEAD, healthy = true, quiet = true;
  const state = { logs, tokenLegs, receipts: new Map<string, unknown>(), calls: [] as string[] };
  const rpc: RpcCall = async (method, params) => {
    state.calls.push(method);
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_blockNumber") return `0x${chainHead.toString(16)}`;
    if (method === "eth_getBlockByNumber") {
      const n = BigInt(String(params[0]));
      return n > chainHead ? null : { number: params[0], hash: blockHash(n), timestamp: `0x${blockTime(n).toString(16)}` };
    }
    if (method === "eth_getTransactionReceipt") {
      const hash = String(params[0]).toLowerCase();
      if (state.receipts.has(hash)) return state.receipts.get(hash);
      const own = [...state.logs, ...state.tokenLegs].filter(l => l.transactionHash.toLowerCase() === hash);
      if (!own.length) return null;
      return { status: "0x1", transactionHash: own[0]!.transactionHash, blockNumber: own[0]!.blockNumber, blockHash: own[0]!.blockHash, logs: own };
    }
    if (method === "eth_getLogs") {
      const filter = params[0] as { address: string; fromBlock: string; toBlock: string; topics: (string | string[] | null)[] };
      return state.logs.filter(l => l.address.toLowerCase() === filter.address.toLowerCase()
        && BigInt(filter.fromBlock) <= BigInt(l.blockNumber) && BigInt(filter.toBlock) >= BigInt(l.blockNumber)
        && filter.topics.every((item, i) => item == null || (Array.isArray(item) ? item : [item]).some(t => t.toLowerCase() === l.topics[i]!.toLowerCase())));
    }
    throw new Error(`Unexpected fixture RPC ${method}`);
  };
  const options: TradedReceiptAttestationOptions = { tenant: TEST_TENANT, smartAccount: TEST_ACCOUNT, chainId: 4663, home, volume, shared, rpc,
    sharedFlowId: SHARED_FLOW,
    lease: lease ?? { tenant: TEST_TENANT, backend: "postgres", healthy: () => healthy, async release() { healthy = false; } },
    assertQuiescent() { if (!quiet) throw new Error("Supervisor still owns a process"); }, dialect: sharedDb ? "postgres" : "sqlite" };
  return { options, file, local, raw, shared, deposit, state, rpc, setHead(value: bigint) { chainHead = value; }, setHealthy(value: boolean) { healthy = value; },
    setQuiet(value: boolean) { quiet = value; }, journalHead: () => head,
    close() { raw.close(); memory?.close(); rmSync(root, { recursive: true, force: true }); } };
}
