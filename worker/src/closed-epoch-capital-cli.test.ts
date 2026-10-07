/**
 * THE OPERATOR'S SHELL AROUND THE CLOSED-EPOCH REPAIR: its arguments, its
 * narrower chain transport, its SERIALIZABLE write connection (and what it
 * says when a commit's answer never comes), its source fingerprint, and whole
 * runs — preview, a refused apply, the apply, a second apply, the revert, and
 * an apply whose commit acknowledgement is lost, reverted from its receipts.
 *
 * The plan itself is closed-epoch-capital.test.ts's, on 0x0e1ca0's real
 * chain. Here the chain is a small synthetic one of the same shape (an
 * outside deposit and the owner's root-key withdrawal inside epoch 1, a
 * paper epoch 2), and "Postgres" is a real sqlite behind a stand-in for a
 * node-postgres client that takes $n placeholders, holds the read-only
 * transaction to query_only, and answers the catalogue reads Postgres would.
 * closed-epoch-capital.postgres.test.ts runs the same against a real one.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { wrapSqlite } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import { PAPER_CHECKPOINT_SCHEMA } from "./paper-checkpoint";
import { ensureLedgerResumeSchema } from "./ledger-import";
import { CHAIN_REFUSAL } from "./ledger-resume";
import { CASH } from "../../packages/core/src/index";
import type { RpcCall } from "./chain-capital";
import { BookingRefused } from "./chain-gap-booking";
import { CliError, failureLine, type PgClient } from "./chain-gap-booking-cli";
import { REPAIRS_TABLE } from "./closed-epoch-capital";
import {
  closedEpochSourceFingerprint, CommitOutcomeUnknown, createClosedEpochRpc, main, parseClosedEpochArgs, pgWriteDb,
} from "./closed-epoch-capital-cli";

const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-closed-epoch-cli-")));
const handles: DatabaseSync[] = [];
after(() => { for (const h of handles) h.close(); rmSync(dir, { recursive: true, force: true }); });

const TENANT = "0x0e1ca00202df6e686ac2317e10ed8ee8ae5e320d";
const ACCOUNT = `0x${"ac".repeat(20)}`, OUTSIDE = `0x${"d0".repeat(20)}`, COIN = `0x${"c0".repeat(20)}`;
const USDG = String(CASH.USDG).toLowerCase();
const EP = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const TR = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const UOE = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const BEFORE = "0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972";
const DATABASE_URL = "postgres://operator:s3cret@db.internal.example:6543/railway";
const T0 = 1_789_000_000, DEPOSIT_BLOCK = 1_000n, SWEEP_BLOCK = 2_000n, HEAD = 120_000n;
const at = (b: bigint) => T0 + Math.floor(Number(b) / 10);
const DEPOSIT_AT = at(DEPOSIT_BLOCK), SWEEP_AT = at(SWEEP_BLOCK), EPOCH2_AT = SWEEP_AT + 700;
const NOW = at(HEAD) + 600;
const topic = (a: string) => `0x${a.replace(/^0x/, "").padStart(64, "0")}`;
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const h32 = (s: string) => `0x${createHash("sha256").update(s).digest("hex")}`;
const DEPOSIT_TX = h32("the deposit"), SWEEP_TX = h32("the sweep"), SWEEP_OP = h32("the sweep op");

/** Postgres's dialect, answered by sqlite: $n placeholders, the read-only transaction held to query_only, SERIALIZABLE said, the catalogue answered. */
function pgOverSqlite(raw: DatabaseSync, said: string[], o: { loseCommitAck?: boolean } = {}): PgClient {
  let readOnly = false, serializable = false;
  const empty = { rows: [], rowCount: 0 };
  return {
    async query(sql, params = []) {
      said.push(sql);
      if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") { raw.exec("BEGIN"); raw.exec("PRAGMA query_only = ON"); readOnly = true; return empty; }
      if (sql === "BEGIN ISOLATION LEVEL SERIALIZABLE") { raw.exec("BEGIN"); serializable = true; return empty; }
      if (/current_setting\('transaction_read_only'\)/.test(sql)) return { rows: [{ ro: readOnly ? "on" : "off", iso: readOnly ? "repeatable read" : "read committed" }], rowCount: 1 };
      if (/current_setting\('transaction_isolation'\)/.test(sql)) return { rows: [{ iso: serializable ? "serializable" : "read committed" }], rowCount: 1 };
      if (/FROM information_schema\.tables WHERE table_schema = current_schema\(\)/.test(sql)) {
        const rows = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<Record<string, unknown>>).map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }
      if (/FROM information_schema\.columns WHERE table_schema = current_schema\(\) AND table_name = \$1/.test(sql)) {
        const rows = (raw.prepare("SELECT name FROM pragma_table_info(?)").all(params[0] as string) as Array<Record<string, unknown>>).map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }
      // Postgres's own index catalogue: the flows identity as production defines it, while sqlite holds it.
      if (/FROM pg_index i JOIN pg_class c/.test(sql)) {
        const has = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'flows_chain_identity'").get();
        return has ? { rows: [{ indisunique: true, indisvalid: true, indisready: true, key_columns: ["chain_id", "agent_id", "tx_hash", "log_index"],
          definition: "CREATE UNIQUE INDEX flows_chain_identity ON public.flows USING btree (chain_id, agent_id, tx_hash, log_index) WHERE ((tx_hash IS NOT NULL) AND (log_index IS NOT NULL))" }],
        rowCount: 1 } : empty;
      }
      if (sql === "COMMIT") {
        raw.exec("COMMIT"); serializable = false;
        if (o.loseCommitAck) throw new Error("Connection terminated unexpectedly");
        return empty;
      }
      if (sql === "ROLLBACK") { raw.exec("ROLLBACK"); serializable = false; if (readOnly) { raw.exec("PRAGMA query_only = OFF"); readOnly = false; } return empty; }
      const stmt = raw.prepare(sql.replace(/\$(\d+)/g, "?$1"));
      if (/^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
        const rows = (stmt.all(...(params as never[])) as Array<Record<string, unknown>>).map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: Number(stmt.run(...(params as never[])).changes) };
    },
    async end() {},
  };
}

/** The tenant's Postgres: epoch 2 (paper) open, epoch 1 closed after the withdrawal, a live COIN basis the chain shows flat. */
async function shared() {
  const raw = new DatabaseSync(":memory:"); handles.push(raw);
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db); await db.exec(MIRROR_STATE_DDL); await db.exec(PAPER_CHECKPOINT_SCHEMA);
  raw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL, row_version INTEGER NOT NULL)");
  raw.prepare("INSERT INTO grants VALUES (?, ?, 1, 1)").run(TENANT, JSON.stringify({ smartAccount: ACCOUNT, owner: TENANT, chainId: 4663, grantFeatures: ["tradeable-v2"], serialized: "never-read" }));
  raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode, beat_at)
    VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 2, 9, 'paper', ?)`).run(ACCOUNT, TENANT, `0x${"01".repeat(20)}`, EPOCH2_AT + 100);
  raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, created_at, epoch) VALUES (?, 'swap', ?, 8.5, ?, ?, 'landed', ?, 1)`)
    .run(ACCOUNT, ACCOUNT, SWEEP_OP, SWEEP_TX, SWEEP_AT + 300);
  for (const [t, epoch, mode, cash] of [[DEPOSIT_AT + 60, 1, "live", 9], [SWEEP_AT + 200, 1, "live", 0.5], [EPOCH2_AT, 2, "paper", 1000]] as const) {
    raw.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, flows_held, cash_read_at, at) VALUES (?, '0', ?, 0, 0, ?, ?, ?, 0, ?, ?)`)
      .run(ACCOUNT, cash, cash, epoch, mode, t, t);
  }
  raw.prepare(`INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, value_usdg, updated_at) VALUES (?, 'COIN', ?, '700', '1', 1, 0, 1, ?)`)
    .run(ACCOUNT, COIN, SWEEP_AT - 100);
  raw.prepare("INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at) VALUES (?, 'live', 'COIN', '700', '450000', ?)").run(ACCOUNT, SWEEP_AT - 200);
  raw.prepare("INSERT INTO position_floors (agent_id, mode, symbol, stop_bps, rung, why, at) VALUES (?, 'live', 'COIN', 1500, 'standard', 'graded at entry', ?)").run(ACCOUNT, SWEEP_AT - 200);
  for (const table of ["trades", "flows", "equity"]) {
    raw.prepare("INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES (?, ?, 4, 1, ?)").run(TENANT, table, EPOCH2_AT + 120);
  }
  await ensureLedgerResumeSchema(db);
  raw.prepare(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run, state, reason,
      created_at_ms, updated_at_ms, chain_read_from_sec) VALUES ('a1', ?, ?, 4663, ?, ?, '{}', 'r', 'refused', ?, ?, ?, ?)`)
    .run(TENANT, ACCOUNT, TENANT, "e".repeat(64), `${CHAIN_REFUSAL}: USDG in 9.000000 in tx ${DEPOSIT_TX} log 0 at block ${DEPOSIT_BLOCK}`, (NOW - 3660) * 1000, (NOW - 3600) * 1000, T0);
  return raw;
}

/** An outside deposit of 9 USDG, and the owner's root-key withdrawal of 8.5 USDG (and the COIN) to the same outside wallet. */
const TXS = [
  { tx: DEPOSIT_TX, block: DEPOSIT_BLOCK, from: OUTSIDE, to: USDG, logs: [[USDG, [TR, topic(OUTSIDE), topic(ACCOUNT)], `0x${word(9_000_000n)}`, "0x0"]] },
  { tx: SWEEP_TX, block: SWEEP_BLOCK, from: `0x${"43".repeat(20)}`, to: EP, logs: [
    [EP, [BEFORE], "0x", "0x1"],
    [USDG, [TR, topic(ACCOUNT), topic(OUTSIDE)], `0x${word(8_500_000n)}`, "0x2"],
    [COIN, [TR, topic(ACCOUNT), topic(OUTSIDE)], `0x${word(700n)}`, "0x3"],
    // The owner's root key: nonce mode 0x00, validator type 0x00.
    [EP, [UOE, SWEEP_OP, topic(ACCOUNT), topic(`0x${"00".repeat(20)}`)], `0x${word(5n)}${word(1n)}${word(1000n)}${word(900n)}`, "0x4"],
  ] },
] as Array<{ tx: string; block: bigint; from: string; to: string; logs: Array<[string, string[], string, string]> }>;
const chain: RpcCall = async (method, params) => {
  const blockOf = (b: bigint) => ({ number: `0x${b.toString(16)}`, hash: h32(`block ${b}`), timestamp: `0x${at(b).toString(16)}` });
  const logsOf = (t: (typeof TXS)[number]) => t.logs.map(([address, topics, data, logIndex]) => ({ address, topics, data, logIndex, blockNumber: `0x${t.block.toString(16)}`, transactionHash: t.tx }));
  if (method === "eth_chainId") return "0x1237";
  if (method === "eth_blockNumber") return `0x${HEAD.toString(16)}`;
  if (method === "eth_getBlockByNumber") return blockOf(BigInt(params[0] as string));
  if (method === "eth_getLogs") {
    const f = params[0] as { address: string; fromBlock: string; toBlock: string; topics: Array<string | null> };
    return TXS.filter((t) => t.block >= BigInt(f.fromBlock) && t.block <= BigInt(f.toBlock)).flatMap(logsOf)
      .filter((l) => l.address === f.address.toLowerCase() && f.topics.every((x, i) => x === null || x.toLowerCase() === l.topics[i]));
  }
  if (method === "eth_getTransactionReceipt") {
    const t = TXS.find((x) => x.tx === params[0])!;
    return { status: "0x1", blockNumber: `0x${t.block.toString(16)}`, blockHash: blockOf(t.block).hash, from: t.from, to: t.to, logs: logsOf(t) };
  }
  if (method === "eth_call") {
    // What the logs leave: 0.5 USDG in the account; the COIN all gone.
    const call = params[0] as { to: string; data: string };
    return `0x${word(call.to.toLowerCase() === USDG && call.data.endsWith(ACCOUNT.slice(2)) ? 500_000n : 0n)}`;
  }
  throw new Error(`unexpected ${method}`);
};

describe("arguments", () => {
  const out = path.join(dir, "x.json"), d = "a".repeat(64), id = "0b5e2c3a-1d2e-4f50-8a6b-7c8d9e0f1a2b";
  it("parses the four modes and refuses anything else by a fixed code", () => {
    assert.deepEqual(parseClosedEpochArgs(["--tenant", TENANT.toUpperCase().replace("0X", "0x"), "--epoch", "1", "--output", out]), { mode: "preview", tenant: TENANT, epoch: 1, output: out });
    assert.deepEqual(parseClosedEpochArgs(["--dry-run", "--tenant", TENANT, "--epoch", "1", "--output", out]), { mode: "preview", tenant: TENANT, epoch: 1, output: out });
    assert.deepEqual(parseClosedEpochArgs(["--tenant", TENANT, "--epoch", "1", "--apply", "--confirm", d, "--backup-ref", "bk-1", "--output", out]),
      { mode: "apply", tenant: TENANT, epoch: 1, output: out, confirm: d, backupRef: "bk-1" });
    assert.deepEqual(parseClosedEpochArgs(["--revert", out, "--output", `${out}.r`]), { mode: "revert", report: out, output: `${out}.r` });
    assert.deepEqual(parseClosedEpochArgs(["--revert-repair", id, "--output", out]), { mode: "revert-repair", repairId: id, output: out, dryRun: false });
    assert.deepEqual(parseClosedEpochArgs(["--revert-repair", id, "--output", out, "--dry-run"]), { mode: "revert-repair", repairId: id, output: out, dryRun: true });
    for (const bad of [
      [], ["--tenant", TENANT, "--output", out], ["--tenant", TENANT, "--epoch", "0", "--output", out], ["--tenant", TENANT, "--epoch", "1.5", "--output", out],
      ["--tenant", TENANT, "--epoch", "-1", "--output", out], ["--tenant", TENANT, "--epoch", "01", "--output", out], ["--tenant", TENANT, "--epoch", "1", "--output", "rel.json"],
      ["--tenant", TENANT, "--epoch", "1", "--output", out, "--confirm", d], ["--tenant", TENANT, "--epoch", "1", "--output", out, "--backup-ref", "bk"],
      ["--tenant", TENANT, "--epoch", "1", "--output", out, "--apply", "--confirm", d], ["--tenant", TENANT, "--epoch", "1", "--output", out, "--apply", "--dry-run", "--confirm", d, "--backup-ref", "bk"],
      ["--revert", out, "--tenant", TENANT, "--output", out], ["--revert", out, "--output", out, "--dry-run"], ["--revert", "rel.json", "--output", out],
      ["--revert-repair", "not-a-uuid", "--output", out], ["--revert-repair", id, "--epoch", "1", "--output", out], ["--revert-repair", id],
      ["--tenant", TENANT, "--epoch", "1", "--epoch", "1", "--output", out], ["--tenant", TENANT, "--epoch", "1", "--output", out, "--everything"],
    ]) assert.throws(() => parseClosedEpochArgs(bad), (e: unknown) => e instanceof CliError && e.code === "invalid-arguments", bad.join(" "));
  });
});

describe("the chain transport", () => {
  it("admits the booking tool's reads, and eth_call for balanceOf(one address) at a block number only — never decimals(), never a tag", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { id: number; method: string };
      asked.push(body.method);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x12" }), { status: 200 });
    }) as unknown as typeof fetch;
    const rpc = createClosedEpochRpc("https://rpc.example/", fetchImpl);
    const token = `0x${"aa".repeat(20)}`, holder = "bb".repeat(20);
    assert.equal(await rpc("eth_getLogs", [{}]), "0x12");
    assert.equal(await rpc("eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder}` }, "0x4dfe3ca"]), "0x12");
    for (const [method, params] of [
      ["eth_call", [{ to: token, data: "0x313ce567" }, "latest"]], ["eth_call", [{ to: token, data: "0x313ce567" }, "0x4dfe3ca"]],
      ["eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder}` }, "latest"]],
      ["eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder}`, from: `0x${holder}` }, "0x1"]], ["eth_sendRawTransaction", ["0x"]], ["eth_getCode", [token, "latest"]],
    ] as const) {
      await assert.rejects(rpc(method, params as unknown as unknown[]), (e: unknown) => e instanceof CliError && /allowlist/.test(e.code), `${method} ${JSON.stringify(params)}`);
    }
    assert.deepEqual(asked, ["eth_getLogs", "eth_call"], "nothing refused left the process");
  });
});

describe("the write connection", () => {
  it("is SERIALIZABLE, proved; a commit the server refuses is rethrown as itself, and one whose answer never came is an unknown outcome", async () => {
    const said: string[] = [];
    const client = (o: { iso?: string; commit?: () => never } = {}): PgClient => ({
      async query(sql) {
        said.push(sql);
        if (sql === "COMMIT" && o.commit) o.commit();
        return { rows: [{ iso: o.iso ?? "serializable" }], rowCount: 1 };
      },
      async end() {},
    });
    assert.equal(await pgWriteDb(client()).tx(async () => 7), 7);
    assert.deepEqual(said.filter((s) => /^(BEGIN|COMMIT|ROLLBACK)/.test(s)), ["BEGIN ISOLATION LEVEL SERIALIZABLE", "COMMIT"]);
    await assert.rejects(pgWriteDb(client({ iso: "read committed" })).tx(async () => 1), (e: unknown) => (e as CliError).code === "serializable-not-established");
    assert.equal(said.at(-1), "ROLLBACK");
    const refused = Object.assign(new Error("could not serialize access"), { code: "40001" });
    await assert.rejects(pgWriteDb(client({ commit: () => { throw refused; } })).tx(async () => 1), (e: unknown) => e === refused);
    await assert.rejects(pgWriteDb(client({ commit: () => { throw new Error("Connection terminated unexpectedly"); } })).tx(async () => 1), (e: unknown) => e instanceof CommitOutcomeUnknown);
    await assert.rejects(pgWriteDb(client()).tx(async (db) => db.exec("CREATE TABLE x (y)")), /never inside it/);
  });

  it("the source fingerprint reads every file the plan depends on", () => {
    const f = closedEpochSourceFingerprint();
    assert.ok(Object.keys(f).length >= 20);
    assert.ok(Object.values(f).every((d) => /^[0-9a-f]{64}$/.test(d)));
    assert.ok("closed-epoch-capital.ts" in f && "chain-gap-booking.ts" in f && "accounting-repair.ts" in f && "../../packages/core/src/capital-classify.ts" in f);
  });
});

describe("whole runs through the shell", () => {
  const env = { DATABASE_URL };
  const run = (raw: DatabaseSync, said: string[], printed: string[], o: { loseCommitAck?: boolean; repairId?: string } = {}) => ({
    connect: async () => pgOverSqlite(raw, said, o), rpc: chain, nowMs: () => NOW * 1000, out: (l: string) => printed.push(l), source: { "closed-epoch-capital.ts": "fixed" },
    sleep: async () => {}, ...(o.repairId ? { repairId: () => o.repairId! } : {}),
  });

  it("preview, a refused apply, the apply, a second apply, and the revert", async () => {
    const raw = await shared();
    const said: string[] = [], printed: string[] = [];
    const deps = run(raw, said, printed);
    const previewFile = path.join(dir, "preview.json");
    assert.equal(await main(["--tenant", TENANT, "--epoch", "1", "--output", previewFile], env, deps), 0, printed.join("\n"));
    const plan = JSON.parse(readFileSync(previewFile, "utf8")) as { verdict: string; previewDigest: string; mode: string; writesPerformed: number;
      proposals: { inserts: Array<{ key: string }>; clears: Array<{ kind: string }> } };
    assert.deepEqual([plan.verdict, plan.mode, plan.writesPerformed], ["ready", "preview", 0]);
    assert.deepEqual(plan.proposals.inserts.map((i) => i.key), [`log:${DEPOSIT_TX}#0`, `log:${SWEEP_TX}#2`]);
    assert.deepEqual(plan.proposals.clears.map((c) => c.kind), ["clear-live-basis", "clear-live-floor"]);
    assert.equal(statSync(previewFile).mode & 0o777, 0o600);
    assert.ok(printed.includes(`previewDigest ${plan.previewDigest}`));
    assert.deepEqual(said.filter((s) => !/^\s*(SELECT|WITH)\b/i.test(s)), ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "ROLLBACK"], "the preview's only statements besides SELECTs");

    // A digest nobody reviewed: refused, nothing written, its report file not left behind.
    const wrong = path.join(dir, "apply-wrong.json");
    await assert.rejects(main(["--tenant", TENANT, "--epoch", "1", "--apply", "--confirm", "b".repeat(64), "--backup-ref", "bk-2026-10-07", "--output", wrong], env, deps),
      (e: unknown) => (e as BookingRefused).code === "confirm-mismatch");
    assert.equal(existsSync(wrong), false);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM flows").get()!.n, 0);

    const applied = path.join(dir, "apply.json");
    printed.length = 0; said.length = 0;
    assert.equal(await main(["--tenant", TENANT, "--epoch", "1", "--apply", "--confirm", plan.previewDigest, "--backup-ref", "bk-2026-10-07", "--output", applied], env, deps), 0);
    assert.match(printed[0]!, /^repair [0-9a-f-]{36} — if this process dies, see what was applied with --revert-repair [0-9a-f-]{36} --dry-run$/, "said before the transaction");
    assert.ok(printed.some((l) => /^APPLIED repair [0-9a-f-]{36} — 4 action\(s\) for tenant .*, epoch 1, under backup bk-2026-10-07/.test(l)), printed.join("\n"));
    assert.ok(said.indexOf("BEGIN ISOLATION LEVEL SERIALIZABLE") < said.indexOf("COMMIT"));
    assert.equal(statSync(applied).mode & 0o777, 0o600);
    const report = JSON.parse(readFileSync(applied, "utf8")) as { repairId: string; actions: unknown[] };
    assert.equal(report.actions.length, 4);
    assert.deepEqual(raw.prepare("SELECT direction, amount_usdg, log_index, source, epoch, at FROM flows ORDER BY id").all().map((r) => ({ ...r })), [
      { direction: "in", amount_usdg: 9, log_index: 0, source: "chain-log", epoch: 1, at: DEPOSIT_AT }, { direction: "out", amount_usdg: 8.5, log_index: 2, source: "chain-log", epoch: 1, at: SWEEP_AT }]);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM cost_basis").get()!.n, 0);
    assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM ${REPAIRS_TABLE} WHERE state = 'applied' AND repair_id = ?`).get(report.repairId)!.n, 4);

    // Applied once: the next apply finds nothing to do, writes nothing, and leaves no file.
    const twice = path.join(dir, "apply-twice.json");
    await assert.rejects(main(["--tenant", TENANT, "--epoch", "1", "--apply", "--confirm", plan.previewDigest, "--backup-ref", "bk-2026-10-07", "--output", twice], env, deps),
      (e: unknown) => (e as BookingRefused).code === "nothing-to-do");
    assert.equal(existsSync(twice), false);

    printed.length = 0;
    const reverted = path.join(dir, "revert.json");
    assert.equal(await main(["--revert", applied, "--output", reverted], env, deps), 0);
    assert.ok(printed.some((l) => /^REVERTED repair .* 4 action\(s\)/.test(l)));
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM flows").get()!.n, 0);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM cost_basis WHERE symbol = 'COIN'").get()!.n, 1);
    assert.equal(JSON.parse(readFileSync(reverted, "utf8")).outcome, "reverted");
    assert.equal(await main(["--revert", applied, "--output", path.join(dir, "revert-again.json")], env, deps), 0);
    assert.ok(printed.some((l) => /^ALREADY REVERTED/.test(l)));
    // A forged report reverts nothing.
    const forged = path.join(dir, "forged.json");
    writeFileSync(forged, readFileSync(applied, "utf8").replace('"bk-2026-10-07"', '"bk-other"'));
    await assert.rejects(main(["--revert", forged, "--output", path.join(dir, "forged-out.json")], env, deps), (e: unknown) => (e as BookingRefused).code === "report");
    assert.ok([...printed, ...said].every((l) => !/s3cret|operator@|db\.internal/.test(l)), "no credential, no host");
  });

  it("a commit whose acknowledgement is lost keeps its report and says so; the receipts show it committed, and revert from them alone", async () => {
    const raw = await shared();
    const said: string[] = [], printed: string[] = [];
    const before = raw.prepare("SELECT * FROM cost_basis").all().map((r) => ({ ...r }));
    const preview = path.join(dir, "lost-preview.json");
    assert.equal(await main(["--tenant", TENANT, "--epoch", "1", "--output", preview], env, run(raw, said, printed)), 0);
    const digest = (JSON.parse(readFileSync(preview, "utf8")) as { previewDigest: string }).previewDigest;
    const id = "4a1c2e3f-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
    const applied = path.join(dir, "lost-apply.json");
    await assert.rejects(main(["--tenant", TENANT, "--epoch", "1", "--apply", "--confirm", digest, "--backup-ref", "bk-lost", "--output", applied], env,
      run(raw, said, printed, { loseCommitAck: true, repairId: id })), (e: unknown) => (e as CliError).code === "apply-outcome-unknown");
    assert.ok(printed.some((l) => l.startsWith("outcome unknown:") && l.includes(`--revert-repair ${id} --dry-run`)));
    assert.equal((JSON.parse(readFileSync(applied, "utf8")) as { repairId: string }).repairId, id, "the report was written before the commit, and kept");
    const look = path.join(dir, "lost-receipts.json");
    printed.length = 0; said.length = 0;
    assert.equal(await main(["--revert-repair", id, "--output", look, "--dry-run"], env, run(raw, said, printed)), 0);
    assert.match(printed[0]!, /4 receipt\(s\) — 4 applied, 0 reverted\. It committed/);
    assert.deepEqual(said.filter((s) => !/^\s*(SELECT|WITH)\b/i.test(s)), ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "ROLLBACK"], "looking writes nothing");
    assert.equal(await main(["--revert-repair", id, "--output", path.join(dir, "lost-revert.json")], env, run(raw, said, printed)), 0);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM flows").get()!.n, 0);
    assert.deepEqual(raw.prepare("SELECT * FROM cost_basis").all().map((r) => ({ ...r })), before);
    // A repair that never committed: no receipts, said as such.
    printed.length = 0;
    assert.equal(await main(["--revert-repair", "0b5e2c3a-1d2e-4f50-8a6b-7c8d9e0f1a2b", "--output", path.join(dir, "none.json"), "--dry-run"], env, run(raw, said, printed)), 0);
    assert.match(printed[0]!, /no receipts — nothing was applied under it/);
  });

  it("a blocked preview exits 2; without DATABASE_URL nothing runs; a failure line never carries a URL", async () => {
    const raw = await shared();
    raw.exec("DELETE FROM ledger_resume_approvals");
    const printed: string[] = [];
    assert.equal(await main(["--tenant", TENANT, "--epoch", "1", "--output", path.join(dir, "blocked.json")], env, run(raw, [], printed)), 2);
    assert.ok(printed.some((l) => /^closed-epoch capital BLOCKED/.test(l)));
    await assert.rejects(main(["--tenant", TENANT, "--epoch", "1", "--output", path.join(dir, "n.json")], {}, {}), (e: unknown) => (e as CliError).code === "database-url-required");
    assert.doesNotMatch(failureLine(new Error(`connect ECONNREFUSED ${DATABASE_URL}`)), /s3cret|operator|example/);
  });
});
