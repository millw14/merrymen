/** Isolated accounting fixture; no production URLs, secrets or writes. */
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
import type { ReceiptAttestationOptions } from "./receipt-attestation";
import type { TenantLease } from "./tenant-lease";

export const TEST_TENANT = "0x00000000000000000000000000000000000000a8";
export const TEST_ACCOUNT = "0x000000000000000000000000000000000000aBcD";
const FROM = "0x00000000000000000000000000000000000000f1";
const TX = `0x${"cd".repeat(32)}`;
const BLOCK_HASH = `0x${"bc".repeat(32)}`;
const topic = (address: string) => `0x${address.toLowerCase().slice(2).padStart(64, "0")}`;

export async function receiptFixture(sharedDb?: Db, lease?: TenantLease) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mm-receipt-attestation-")));
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
  const original = { agentId: TEST_ACCOUNT, epoch: 1, direction: "in", amountUsdg: 200, source: "inferred", txHash: null };
  const payload = canonicalJson(original);
  for (const [db, id] of [[local, 7], [shared, 428]] as const) {
    await db.prepare("INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,mode,hwm_usdg,epoch,hwm_withdrawn_usdg) VALUES(?,?,?,4663,?,1,9999999999,'live',200,1,0)")
      .run(TEST_ACCOUNT, TEST_TENANT, FROM, '{"perTradeUsdg":40,"dailyUsdg":100,"maxDrawdownPct":5}');
    await db.prepare("INSERT INTO flows(id,agent_id,direction,amount_usdg,source,at,epoch) VALUES(?,?,'in',200,'inferred',1791595716,1)").run(id, TEST_ACCOUNT);
    await db.prepare("INSERT INTO equity(agent_id,eth_wei,cash_usdg,vault_usdg,positions_usdg,equity_usdg,at,epoch,mode) VALUES(?,'100',200,0,0,200,1791595800,1,'live')").run(TEST_ACCOUNT);
    await db.prepare("INSERT INTO trades(agent_id,kind,target,amount_usdg,status,reject_rule) VALUES(?,'swap','pool',2.5,'rejected','capital-provenance')").run(TEST_ACCOUNT);
  }
  await local.exec("CREATE TABLE ledger_source_identity(id INTEGER PRIMARY KEY,book_id TEXT,tenant TEXT,smart_account TEXT,chain_id INTEGER)");
  await local.prepare("INSERT INTO ledger_source_identity VALUES(1,?,?,?,4663)").run("original-book-id", TEST_TENANT, TEST_ACCOUNT.toLowerCase());
  await local.prepare("INSERT INTO journal(agent_id,epoch,kind,payload_json,prev_hash,hash,at) VALUES(?,1,'flow',?,?,?,1791595716)")
    .run(TEST_ACCOUNT, payload, JOURNAL_GENESIS, journalHash(JOURNAL_GENESIS, payload));
  const mount = lstatSync(root, { bigint: true }), stat = lstatSync(file, { bigint: true });
  const volume = { id: "vol_attestation_fixture", mountPath: root, homeRoot, device: String(mount.dev), inode: String(mount.ino) };
  await shared.prepare("INSERT INTO tenant_ledger_import(tenant,generation,target_volume_id,state,sealed,bytes,sha256,source_digest,source_inode,source_identity,bindings_json,created_at_ms,consumed_at_ms,grant_updated_at,grant_row_version) VALUES(?,?,?,'consumed',NULL,0,'original-sha','original-source-digest',?,?,'{}',1230,1231,'1234','1')")
    .run(TEST_TENANT, "11111111-1111-4111-8111-111111111111", volume.id, String(stat.ino), "original-book-id");
  await shared.prepare("INSERT INTO tenant_ledger_import_generations VALUES(?,?,'consumed')").run("11111111-1111-4111-8111-111111111111", TEST_TENANT);
  await shared.prepare("INSERT INTO mirror_state(tenant,table_name,last_id,last_stamp,updated_at) VALUES(?,'flows',7,1791595716,1791595801)").run(TEST_TENANT);
  const log = { address: CASH.USDG, topics: [TRANSFER_TOPIC, topic(FROM), topic(TEST_ACCOUNT)], data: `0x${(200_000_000n).toString(16).padStart(64, "0")}`,
    blockNumber: "0x50", blockHash: BLOCK_HASH, transactionHash: TX, logIndex: "0x11", removed: false };
  // The receipt at block 80 is older than the 64-block finality window at head 160.
  let head = 160n, healthy = true, quiet = true;
  const rpc: RpcCall = async (method, params) => {
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
    if (method === "eth_getBlockByNumber") return { number: params[0], hash: params[0] === "0x50" ? BLOCK_HASH : `0x${"ba".repeat(32)}`, timestamp: "0x6ac95d13" };
    if (method === "eth_call") return `0x${(BigInt(String(params[1])) >= 80n ? 200_000_000n : 0n).toString(16)}`;
    if (method === "eth_getTransactionReceipt") return { status: "0x1", transactionHash: TX, blockNumber: "0x50", blockHash: BLOCK_HASH, logs: [log] };
    if (method === "eth_getLogs") {
      const filter = params[0] as { fromBlock: string; toBlock: string; topics: (string | string[] | null)[] };
      return BigInt(filter.fromBlock) <= 80n && BigInt(filter.toBlock) >= 80n
        && filter.topics.every((item, i) => item == null || (Array.isArray(item) ? item : [item]).some(t => t.toLowerCase() === log.topics[i]!.toLowerCase())) ? [log] : [];
    }
    throw new Error(`Unexpected fixture RPC ${method}`);
  };
  const options: ReceiptAttestationOptions = { tenant: TEST_TENANT, smartAccount: TEST_ACCOUNT, chainId: 4663, home, volume, shared, rpc,
    lease: lease ?? { tenant: TEST_TENANT, backend: "postgres", healthy: () => healthy, async release() { healthy = false; } },
    assertQuiescent() { if (!quiet) throw new Error("Supervisor still owns a process"); }, dialect: sharedDb ? "postgres" : "sqlite" };
  return { options, file, local, raw, shared, log, rpc, setHead(value: bigint) { head = value; }, setHealthy(value: boolean) { healthy = value; }, setQuiet(value: boolean) { quiet = value; },
    close() { raw.close(); memory?.close(); rmSync(root, { recursive: true, force: true }); } };
}
