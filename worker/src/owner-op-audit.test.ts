/**
 * THE READ-ONLY FLEET AUDIT: which trades rows are the owner's own key, and
 * where each one counts.
 *
 * A ledger holding what the old in-flight reconciler wrote for 0x4b6dcd's
 * account — reconciler-shape 'swap' rows for its invalidateNonce, its vault's
 * sweep(USDG) and its recoverFunds — beside its session key's own sell, over
 * the real receipts and blocks read from the public chain
 * (testdata/owner-operations-receipts.json). "Postgres" is a real sqlite
 * database behind a stand-in for a node-postgres client, held to query_only
 * inside the read-only transaction, as chain-gap-booking-cli.test.ts does.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { wrapSqlite } from "./db";
import { applyLedgerSchema } from "./store";
import { GRANT_PONS_CLASS } from "../../packages/core/src/index";
import type { RpcCall } from "./chain-capital";
import { CliError, connectBooking, pgClientDb, type PgClient } from "./chain-gap-booking-cli";
import { auditExitCode, auditReport, auditRpc, AuditRefused, readAuditChain, readAuditSnapshot } from "./owner-op-audit";
import { AUDIT_APPLICATION_NAME, failureLine, main, parseAuditArgs } from "./owner-op-audit-cli";

const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-owner-op-audit-")));
const handles: DatabaseSync[] = [];
after(() => { for (const h of handles) h.close(); rmSync(dir, { recursive: true, force: true }); });

type FixtureLog = [string, string[], string, string];
interface Fixture { tx: string; block: string; blockHash: string; timestamp: number; logs: FixtureLog[] }
const FX = JSON.parse(readFileSync(new URL("./testdata/owner-operations-receipts.json", import.meta.url), "utf8")) as Record<string, Fixture>;
const TENANT = "0x4b6dcd559c82ea897c34dacfb785fb0c8f85d4c5";
const ACCOUNT = "0xa96bf429888e1aab4255762d17d29c53f6a0370d";
const VAULT = "0xc8776faff15212c359b23bae531ff3ac7d760e0f";
const ROUTER = "0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const DATABASE_URL = "postgres://operator:s3cret@db.internal.example:6543/railway";
const RPC_URL = "https://rpc.secret-provider.example/key-abc123";
const OP = {
  invalidateNonce: "0x496e7211db25d250d9142105ab5024debcf05519c734d83191145af8eac09ffa",
  vaultSweep: "0x0ea85970d6cd230721eb03d667ad46795f1f215647cbad9d1f456779be91c9b9",
  recoverFunds: "0x04f8241f6d02241469b9c2bc2d2f8cc4cca719eb5c6d54f3a77077c7e41ab3a7",
  sessionEnable: "0x75ab968e2c2dad36467d00f665ab8a2667539517a86d64fdd05d0aadb2c5e905",
} as const;
/** A second past a day after the invalidateNonce's row: the sweep's and the recoverFunds' rows (15 hours later) are inside the trailing day, it is not. */
const NOW = FX.invalidateNonce!.timestamp + 60 + 86_401;

/** The chain as read: each fixture's receipt and block, nothing else. `fail` names transactions whose receipt is unreadable. */
function chainRpc(o: { fail?: string[] } = {}): RpcCall & { calls: string[] } {
  const calls: string[] = [];
  const rpc = (async (method: string, params: unknown[]) => {
    calls.push(method);
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_blockNumber") return "0x4c4b400";
    const all = Object.values(FX).filter((f): f is Fixture => typeof f === "object" && f !== null && "tx" in f);
    if (method === "eth_getTransactionReceipt") {
      if (o.fail?.includes(String(params[0]))) throw new Error("rpc-read-failed");
      const f = all.find((x) => x.tx === params[0]);
      return f ? { status: "0x1", blockNumber: f.block, blockHash: f.blockHash, logs: f.logs.map(([address, topics, data, logIndex]) => ({ address, topics, data, logIndex,
        blockNumber: f.block, transactionHash: f.tx })) } : null;
    }
    if (method === "eth_getBlockByNumber") {
      const f = all.find((x) => BigInt(x.block) === BigInt(String(params[0])));
      return f ? { number: f.block, hash: f.blockHash, timestamp: `0x${f.timestamp.toString(16)}` } : null;
    }
    throw new Error(`unexpected ${method}`);
  }) as RpcCall & { calls: string[] };
  rpc.calls = calls;
  return rpc;
}

/** The ledger as the old reconciler left it: three root ops as agent 'swap' rows, the session key's sell, a dropped op with no tx. */
async function ledger() {
  const raw = new DatabaseSync(":memory:"); handles.push(raw);
  await applyLedgerSchema(wrapSqlite(raw));
  raw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL, row_version INTEGER NOT NULL, sealed_session_key TEXT)");
  raw.prepare("INSERT INTO grants VALUES (?, ?, 1, 1, 'SEALED-SECRET')").run(TENANT, JSON.stringify({ smartAccount: ACCOUNT, owner: TENANT, chainId: 4663,
    grantFeatures: ["tradeable-v2", GRANT_PONS_CLASS], ponsClassVaultAddress: VAULT, serialized: "SERIALIZED-PERMISSION-SECRET" }));
  raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
    VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 1, 349, 'idle')`).run(ACCOUNT, TENANT, `0x${"01".repeat(20)}`);
  const swap = raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, basis_source, created_at, epoch)
    VALUES (?, 'swap', ?, ?, ?, ?, 'landed', 'receipt', ?, 1)`);
  // What reconcileInFlightAtArm wrote: kind 'swap', target the account, notional |USDG|, at the arm.
  swap.run(ACCOUNT, ACCOUNT, 0, OP.invalidateNonce, FX.invalidateNonce!.tx, FX.invalidateNonce!.timestamp + 60);
  swap.run(ACCOUNT, ACCOUNT, 1.162301, OP.vaultSweep, FX.vaultSweep!.tx, FX.vaultSweep!.timestamp + 60);
  swap.run(ACCOUNT, ACCOUNT, 348.368488, OP.recoverFunds, FX.recoverFunds!.tx, FX.recoverFunds!.timestamp + 60);
  // The session key's own sell, as the executor wrote it.
  raw.prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, decision_id, fill_side, created_at, epoch)
    VALUES (?, 'swap', ?, ?, ?, 5.370997, ?, ?, 'landed', 'd-1', 'sell', ?, 1)`).run(ACCOUNT, ROUTER, NVDA, USDG, OP.sessionEnable, FX.sessionEnable!.tx, FX.sessionEnable!.timestamp);
  // An op the bundler dropped: a hash, no transaction.
  raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, created_at, epoch) VALUES (?, 'swap', ?, 1, ?, 'dropped', ?, 1)`)
    .run(ACCOUNT, ROUTER, `0x${"de".repeat(32)}`, FX.recoverFunds!.timestamp);
  return raw;
}

async function audit(raw: DatabaseSync, o: { rpc?: RpcCall; maxReceipts?: number; tenant?: string } = {}) {
  const snap = await wrapSqlite(raw).tx((db) => readAuditSnapshot(db, { dialect: "sqlite", ...(o.tenant ? { tenant: o.tenant } : {}) }));
  const ev = await readAuditChain(auditRpc(o.rpc ?? chainRpc()), snap.trades.flatMap((t) => (t.txHash ? [t.txHash] : [])), { maxReceipts: o.maxReceipts ?? 5000, sleep: async () => {} });
  return auditReport(snap, ev, { nowSec: NOW, source: { files: "test" }, target: "test-db", maxReceipts: o.maxReceipts ?? 5000 });
}

describe("the audit", () => {
  it("lists exactly the three root-key rows, each with where it counts; the session key's sell is not among them", async () => {
    const r = await audit(await ledger());
    assert.deepEqual(r.rootRows.map((x) => x.userOpHash).sort(), [OP.invalidateNonce, OP.vaultSweep, OP.recoverFunds].sort());
    assert.deepEqual(r.totals.byValidator, { root: 3, permission: 1, secondary: 0, unknown: 0, "not-in-receipt": 0, unread: 0, "other-chain": 0, "no-tx": 1 });
    const recover = r.rootRows.find((x) => x.userOpHash === OP.recoverFunds)!;
    assert.deepEqual({ tenant: recover.tenant, tx: recover.txHash, block: recover.block, blockTime: recover.blockTime, kind: recover.kind, status: recover.status,
      amount: recover.amountUsdg, epoch: recover.epoch, currentEpoch: recover.currentEpoch, mode: recover.mode, createdAt: recover.createdAt, canonical: recover.blockCanonical },
    { tenant: TENANT, tx: FX.recoverFunds!.tx, block: "78267605", blockTime: 1790947791, kind: "swap", status: "landed", amount: 348.368488, epoch: 1, currentEpoch: 1,
      mode: "idle", createdAt: FX.recoverFunds!.timestamp + 60, canonical: true });
    assert.deepEqual(recover.counted, {
      budgetSeedTrailingDay: true, budgetSeedOps: 1, budgetSeedSpendUsdg: 348.368488, budgetSeedGrossUsdg: 348.368488,
      scoreboardLanded: true, scoreboardVolumeUsdg: 348.368488, tradeTape: true, chatTrades: true, restartCopyShape: true, liveBasisBooked: false, ownerRecord: null,
    });
    assert.equal(recover.reading?.disposition, "review");
    assert.deepEqual(recover.reading?.usdgLegs.map((l) => [l.logIndex, l.kind, l.answeredBy, l.flowHeld]), [[8, "capital-out", "flow", false]]);
    // The invalidateNonce, a day earlier: outside the trailing day, still on every tape.
    const invalidate = r.rootRows.find((x) => x.userOpHash === OP.invalidateNonce)!;
    assert.equal(invalidate.counted.budgetSeedTrailingDay, false);
    assert.equal(invalidate.counted.scoreboardLanded, true);
    // The sweep's leg from the vault is custody-internal: the record would answer it, no flow is needed.
    assert.deepEqual(r.rootRows.find((x) => x.userOpHash === OP.vaultSweep)!.reading?.covers, [`${FX.vaultSweep!.tx}:13`]);
  });

  it("totals: the root rows, their amount and where they count, and the capital leg no flow holds", async () => {
    const r = await audit(await ledger());
    assert.equal(r.totals.root.rows, 3);
    assert.equal(r.totals.root.tenants, 1);
    assert.equal(r.totals.root.amountUsdg, "349.530789");
    assert.equal(r.totals.root.inBudgetSeedTrailingDay, 2);
    assert.equal(r.totals.root.budgetSeedSpendUsdg, "349.530789");
    assert.equal(r.totals.root.scoreboardLanded, 3);
    assert.equal(r.totals.rowsWithoutTxOther, 1, "the dropped op: no transaction, and no settlement to audit");
    assert.deepEqual(r.totals.capitalLegsWithoutFlow.out, { count: 1, amountRaw: "348368488" });
    assert.deepEqual(r.totals.capitalLegsWithoutFlow.legs.map((l) => [l.txHash, l.logIndex, l.direction]), [[FX.recoverFunds!.tx, 8, "out"]]);
    assert.equal(r.coverage.complete, true);
    assert.equal(auditExitCode(r), 2, "root rows found");
  });

  it("once a flow holds the withdrawal's leg, it is no longer listed; an owner record beside a row is named", async () => {
    const raw = await ledger();
    raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, at, epoch, chain_id)
      VALUES (?, 'out', 348.368488, ?, 78267605, 8, 'chain-log', ?, 1, 4663)`).run(ACCOUNT, FX.recoverFunds!.tx, FX.recoverFunds!.timestamp);
    raw.prepare(`INSERT INTO owner_operations (tenant, agent_id, chain_id, user_op_hash, tx_hash, block_number, block_time, log_index, nonce, validator, disposition, review_reason,
        usdg_legs_json, covers_logs_json, token_moves_json, paymaster, gas_wei, source, recorded_epoch, created_at)
      VALUES (?, ?, 46630, ?, ?, 1, 1, 11, '0x0', 'root', 'review', 'token-departed', '[]', '[]', '[]', ?, '1', 'arm-reconcile', 1, 1)`)
      .run(TENANT, ACCOUNT, OP.recoverFunds, FX.recoverFunds!.tx, `0x${"0".repeat(40)}`);
    const r = await audit(raw);
    assert.equal(r.totals.capitalLegsWithoutFlow.out.count, 0);
    assert.equal(r.rootRows.find((x) => x.userOpHash === OP.recoverFunds)!.counted.ownerRecord, "review");
    assert.equal(r.ownerRecords.rows?.length, 1, "records of both dispositions are listed");
    assert.equal(r.ownerRecords.onAnotherChain.length, 1, "and one on a chain other than its grant's is called out");
  });

  it("a record of the same hash under ANOTHER account is never named beside this account's row (the identity is per account)", async () => {
    const raw = await ledger();
    raw.prepare(`INSERT INTO owner_operations (tenant, agent_id, chain_id, user_op_hash, tx_hash, block_number, block_time, log_index, nonce, validator, disposition, review_reason,
        usdg_legs_json, covers_logs_json, token_moves_json, paymaster, gas_wei, source, recorded_epoch, created_at)
      VALUES (?, ?, 4663, ?, ?, 1, 1, 11, '0x0', 'root', 'acknowledged', NULL, '[]', '[]', '[]', ?, '1', 'arm-reconcile', 1, 1)`)
      .run(`0x${"0d".repeat(20)}`, `0x${"0c".repeat(20)}`, OP.recoverFunds, FX.recoverFunds!.tx, `0x${"0".repeat(40)}`);
    const r = await audit(raw);
    assert.equal(r.rootRows.find((x) => x.userOpHash === OP.recoverFunds)!.counted.ownerRecord, null);
    assert.equal(r.ownerRecords.rows?.length, 1, "still listed among the records, under its own account");
  });

  it("a receipt that cannot be read leaves coverage incomplete: exit 3, whatever else was found", async () => {
    const r = await audit(await ledger(), { rpc: chainRpc({ fail: [FX.vaultSweep!.tx] }) });
    assert.equal(r.coverage.complete, false);
    assert.match(r.coverage.why.join(" "), /1 receipt\(s\) could not be read/);
    assert.equal(r.totals.byValidator.unread, 1);
    assert.equal(auditExitCode(r), 3);
  });

  it("the receipt bound stops short and says by how much", async () => {
    const r = await audit(await ledger(), { maxReceipts: 1 });
    assert.equal(r.totals.receiptsSkippedByBound, 3);
    assert.equal(r.coverage.complete, false);
    assert.match(r.coverage.why.join(" "), /--max-receipts 1 was reached/);
    assert.equal(auditExitCode(r), 3);
  });

  it("a row whose hash is not the account's operation in its own receipt is an anomaly, never a guess", async () => {
    const raw = await ledger();
    raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, created_at, epoch) VALUES (?, 'swap', ?, 2, ?, ?, 'landed', ?, 1)`)
      .run(ACCOUNT, ACCOUNT, `0x${"ab".repeat(32)}`, FX.recoverFunds!.tx, NOW - 60);
    const r = await audit(raw);
    assert.equal(r.totals.byValidator["not-in-receipt"], 1);
    assert.deepEqual(r.anomalies.map((a) => a.userOpHash), [`0x${"ab".repeat(32)}`]);
  });

  it("--tenant scopes every read to that tenant's account", async () => {
    const raw = await ledger();
    const r = await audit(raw, { tenant: TENANT });
    assert.equal(r.totals.root.rows, 3);
    await assert.rejects(wrapSqlite(raw).tx((db) => readAuditSnapshot(db, { dialect: "sqlite", tenant: `0x${"99".repeat(20)}` })),
      (e: unknown) => e instanceof AuditRefused && e.code === "no-grant-for-tenant");
  });

  it("the digest binds what was read: the same inputs give the same digest; a changed row a different one", async () => {
    const raw = await ledger();
    const a = await audit(raw), b = await audit(raw);
    assert.equal(a.auditDigest, b.auditDigest);
    raw.prepare("UPDATE trades SET amount_usdg = 1 WHERE user_op_hash = ?").run(OP.vaultSweep);
    assert.notEqual((await audit(raw)).auditDigest, a.auditDigest);
  });
});

describe("what the audit may touch", () => {
  it("the RPC admits its four reads and nothing else — refused before anything leaves the process", async () => {
    const asked: string[] = [];
    const rpc = auditRpc(async (method) => { asked.push(method); return "0x1"; });
    for (const method of ["eth_call", "eth_getLogs", "eth_sendRawTransaction", "eth_sendTransaction", "eth_sign"]) {
      await assert.rejects(rpc(method, []), (e: unknown) => e instanceof AuditRefused && e.code === "rpc-method-outside-audit-allowlist");
    }
    for (const method of ["eth_chainId", "eth_blockNumber", "eth_getTransactionReceipt", "eth_getBlockByNumber"]) await rpc(method, []);
    assert.deepEqual(asked, ["eth_chainId", "eth_blockNumber", "eth_getTransactionReceipt", "eth_getBlockByNumber"]);
  });

  it("the read-only connection: its own application_name, default_transaction_read_only; the shell refuses a write statement", async () => {
    let config: Record<string, unknown> | null = null;
    const fakePg = { Client: class { constructor(c: Record<string, unknown>) { config = c; } async connect() {} async query() { return { rows: [], rowCount: 0 }; } async end() {} },
      types: { setTypeParser() {} } };
    await connectBooking(DATABASE_URL, true, async () => fakePg, AUDIT_APPLICATION_NAME);
    assert.equal(config!.application_name, "merrymen-owner-op-audit-readonly");
    assert.match(String(config!.options), /default_transaction_read_only=on/);
    await connectBooking(DATABASE_URL, true, async () => fakePg);
    assert.equal(config!.application_name, "merrymen-chain-gap-preview-readonly", "the booking tool's own name is unchanged");
    const db = pgClientDb({ async query() { return { rows: [], rowCount: 0 }; }, async end() {} }, { readOnly: true });
    assert.throws(() => db.prepare("INSERT INTO trades (agent_id) VALUES ('x')"), (e: unknown) => e instanceof CliError && e.code === "non-read-query-refused");
  });

  it("arguments: fixed codes, never the argument's text", () => {
    assert.deepEqual(parseAuditArgs(["--output", "/abs/x.json"]), { output: "/abs/x.json", maxReceipts: 5000 });
    assert.deepEqual(parseAuditArgs(["--output", "/abs/x.json", "--tenant", TENANT.toUpperCase().replace("0X", "0x"), "--max-receipts", "12"]),
      { output: "/abs/x.json", tenant: TENANT, maxReceipts: 12 });
    for (const bad of [[], ["--output", "rel.json"], ["--output", "/a", "--tenant", "nope"], ["--output", "/a", "--max-receipts", "0"], ["--output", "/a", "--apply"], ["--output", "/a", "--output", "/b"]]) {
      assert.throws(() => parseAuditArgs(bad), (e: unknown) => e instanceof CliError && e.code === "invalid-arguments");
    }
  });
});

/** Postgres's dialect, answered by sqlite: $n placeholders, the read-only transaction held to query_only (chain-gap-booking-cli.test.ts's stand-in). */
function pgOverSqlite(raw: DatabaseSync, said: string[]): PgClient {
  let readOnly = false;
  const empty = { rows: [], rowCount: 0 };
  return {
    async query(sql, params = []) {
      said.push(sql);
      if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") { raw.exec("BEGIN"); raw.exec("PRAGMA query_only = ON"); readOnly = true; return empty; }
      if (/current_setting\('transaction_read_only'\)/.test(sql)) return { rows: [{ ro: readOnly ? "on" : "off", iso: readOnly ? "repeatable read" : "read committed" }], rowCount: 1 };
      if (/FROM information_schema\.tables WHERE table_schema = current_schema\(\)/.test(sql)) {
        const rows = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<Record<string, unknown>>).map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }
      if (/FROM information_schema\.columns WHERE table_schema = current_schema\(\) AND table_name = \$1/.test(sql)) {
        const rows = (raw.prepare("SELECT name FROM pragma_table_info(?)").all(params[0] as string) as Array<Record<string, unknown>>).map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }
      if (sql === "ROLLBACK") { raw.exec("ROLLBACK"); if (readOnly) { raw.exec("PRAGMA query_only = OFF"); readOnly = false; } return empty; }
      // The grants projection in Postgres's JSON operators, as sqlite spells them.
      const text = sql.replace(/grant_json->>'(\w+)'/g, "json_extract(grant_json, '$.$1')").replace(/grant_json->'(\w+)'/g, "json_extract(grant_json, '$.$1')").replace(/\$(\d+)/g, "?$1");
      const rows = (raw.prepare(text).all(...(params as never[])) as Array<Record<string, unknown>>).map((r) => ({ ...r }));
      return { rows, rowCount: rows.length };
    },
    async end() {},
  };
}

describe("the shell, through one whole run", () => {
  it("creates its report once (0600), reads in one read-only snapshot that is rolled back, prints no secret, and exits 2 on root rows", async () => {
    const raw = await ledger();
    const said: string[] = [], lines: string[] = [];
    const before = raw.prepare("SELECT (SELECT COUNT(*) FROM trades) AS t, (SELECT COUNT(*) FROM flows) AS f, (SELECT COUNT(*) FROM owner_operations) AS o").get();
    const output = path.join(dir, "audit.json");
    const code = await main(["--output", output], { DATABASE_URL, MERRYMEN_CHAIN_GAP_RPC: RPC_URL }, {
      connect: async () => pgOverSqlite(raw, said), rpc: chainRpc(), nowMs: () => NOW * 1000, out: (l) => lines.push(l), source: { files: "test" }, sleep: async () => {},
    });
    assert.equal(code, 2);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const report = JSON.parse(readFileSync(output, "utf8")) as { rootRows: unknown[]; writesPerformed: number; auditDigest: string };
    assert.equal(report.rootRows.length, 3);
    assert.equal(report.writesPerformed, 0);
    assert.ok(said.includes("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") && said.at(-1) === "ROLLBACK", "one read-only snapshot, rolled back");
    assert.ok(said.filter((s) => !/^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|ROLLBACK)$/.test(s)).every((s) => /^\s*(SELECT|WITH)\b/i.test(s)), "nothing but reads");
    assert.ok(!said.some((s) => /sealed_session_key|SELECT[^;]*\bgrant_json\s*(,|FROM)/i.test(s)), "never the sealed key, never the whole grant");
    assert.deepEqual(raw.prepare("SELECT (SELECT COUNT(*) FROM trades) AS t, (SELECT COUNT(*) FROM flows) AS f, (SELECT COUNT(*) FROM owner_operations) AS o").get(), before);
    const text = `${lines.join("\n")}\n${readFileSync(output, "utf8")}`;
    for (const secret of ["s3cret", "db.internal.example", "secret-provider", "key-abc123", "SEALED-SECRET", "SERIALIZED-PERMISSION-SECRET"]) {
      assert.ok(!text.includes(secret), `the console and the report never carry ${secret}`);
    }
    assert.ok(lines.some((l) => l.includes(`auditDigest ${report.auditDigest}`)));
    assert.ok(lines.some((l) => l.startsWith("READ ONLY — 0 database writes.")));
  });

  it("refuses an existing report path, and removes its report when the run fails", async () => {
    const raw = await ledger();
    const existing = path.join(dir, "exists.json");
    writeFileSync(existing, "keep me");
    await assert.rejects(main(["--output", existing], { DATABASE_URL }, { connect: async () => pgOverSqlite(raw, []), rpc: chainRpc() }),
      (e: unknown) => e instanceof CliError && e.code === "report-exists-or-unsafe");
    assert.equal(readFileSync(existing, "utf8"), "keep me");
    const failing = path.join(dir, "failing.json");
    await assert.rejects(main(["--output", failing], { DATABASE_URL }, { connect: async () => { throw new Error(`connect ${DATABASE_URL} failed`); }, rpc: chainRpc() }));
    assert.throws(() => statSync(failing), "the half-made report is gone");
    assert.equal(failureLine(new Error(`connect ${DATABASE_URL}`)), "audit-failed: nothing was written. Use --help for invocation.");
    assert.equal(failureLine(new AuditRefused("rpc-method-outside-audit-allowlist")), "rpc-method-outside-audit-allowlist. Use --help for invocation.");
  });
});
