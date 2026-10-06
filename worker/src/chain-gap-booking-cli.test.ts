/**
 * THE OPERATOR'S SHELL AROUND THE BOOKING: its arguments, its chain transport,
 * its read-only Postgres connection, its report files, and one whole run —
 * preview, a refused apply, the apply, a second apply, the revert — against a
 * lone deposit (0x0e1ca0's shape).
 *
 * "Postgres" here is a real sqlite database behind a stand-in for a
 * node-postgres client: it takes the $n placeholders and the read-only
 * transaction the real one gets, and holds the read-only transaction to
 * query_only, so a write slipping past the shell's own gate would fail here
 * too. chain-gap-booking.postgres.test.ts runs the same against a real one.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { wrapSqlite } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import { ensureLedgerResumeSchema } from "./ledger-import";
import { CHAIN_REFUSAL } from "./ledger-resume";
import { CASH } from "../../packages/core/src/index";
import type { RpcCall } from "./chain-capital";
import { BookingRefused, BOOKINGS_TABLE } from "./chain-gap-booking";
import {
  CliError, createBookingRpc, createReportFile, failureLine, finishReportFile, main, parseBookingArgs, pgClientDb, targetDigest, type PgClient,
} from "./chain-gap-booking-cli";

const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "merrymen-chain-gap-cli-")));
const handles: DatabaseSync[] = [];
after(() => { for (const h of handles) h.close(); rmSync(dir, { recursive: true, force: true }); });

const TENANT = "0x0e1ca00202df6e686ac2317e10ed8ee8ae5e320d";
const ACCOUNT = `0x${"ac".repeat(20)}`;
const USDG = String(CASH.USDG).toLowerCase();
const TR = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const DATABASE_URL = "postgres://operator:s3cret@db.internal.example:6543/railway";
const BLOCK = 80_000_000n, HEAD = BLOCK + 500_000n, DEPOSIT_AT = 1_791_000_000;
const NOW = DEPOSIT_AT + 3 * 86_400;
const topic = (a: string) => `0x${a.replace(/^0x/, "").padStart(64, "0")}`;
const h32 = (s: string) => `0x${createHash("sha256").update(s).digest("hex")}`;
const DEPOSIT_TX = h32("the lone deposit");

/** Postgres's dialect, answered by sqlite: $n placeholders, the read-only transaction held to query_only. */
function pgOverSqlite(raw: DatabaseSync, said: string[]): PgClient {
  let readOnly = false;
  const empty = { rows: [], rowCount: 0 };
  return {
    async query(sql, params = []) {
      said.push(sql);
      if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") { raw.exec("BEGIN"); raw.exec("PRAGMA query_only = ON"); readOnly = true; return empty; }
      if (/current_setting\('transaction_read_only'\)/.test(sql)) return { rows: [{ ro: readOnly ? "on" : "off", iso: readOnly ? "repeatable read" : "read committed" }], rowCount: 1 };
      // Postgres's catalogue, from sqlite's.
      if (/FROM information_schema\.tables WHERE table_schema = current_schema\(\)/.test(sql)) {
        const rows = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<Record<string, unknown>>).map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }
      if (sql === "BEGIN" || sql === "COMMIT") { raw.exec(sql); return empty; }
      if (sql === "ROLLBACK") { raw.exec("ROLLBACK"); if (readOnly) { raw.exec("PRAGMA query_only = OFF"); readOnly = false; } return empty; }
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

async function shared() {
  const raw = new DatabaseSync(":memory:"); handles.push(raw);
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db); await db.exec(MIRROR_STATE_DDL);
  raw.exec("CREATE TABLE grants(tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL, row_version INTEGER NOT NULL)");
  raw.prepare("INSERT INTO grants VALUES (?, ?, 1, 1)").run(TENANT, JSON.stringify({ smartAccount: ACCOUNT, owner: TENANT, chainId: 4663, grantFeatures: ["tradeable-v2"], serialized: "never-read" }));
  raw.prepare(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
    VALUES (?, ?, ?, 4663, '{}', 1, 9999999999, 'armed', 3, 40, 'live')`).run(ACCOUNT, TENANT, `0x${"01".repeat(20)}`);
  raw.prepare(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, at, epoch, chain_id)
    VALUES (?, 'in', 40, ?, 70000000, 1, 'chain-log', ?, 3, 4663)`).run(ACCOUNT, h32("first"), DEPOSIT_AT - 10 * 86_400);
  for (const table of ["trades", "flows", "equity"]) {
    raw.prepare("INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES (?, ?, 4, 1, ?)").run(TENANT, table, DEPOSIT_AT - 3600);
  }
  // What holds it: admission's chain refusal, an hour before the preview, naming the deposit.
  await ensureLedgerResumeSchema(db);
  raw.prepare(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run, state, reason,
      created_at_ms, updated_at_ms) VALUES ('a1', ?, ?, 4663, ?, ?, '{}', 'r', 'refused', ?, ?, ?)`)
    .run(TENANT, ACCOUNT, TENANT, "e".repeat(64), `${CHAIN_REFUSAL}: USDG in 9.000000 in tx ${DEPOSIT_TX} log 2 at block ${BLOCK}`, (NOW - 3660) * 1000, (NOW - 3600) * 1000);
  return raw;
}

/** One deposit on chain, from an outside wallet; blocks at ten a second. */
const chain: RpcCall = async (method, params) => {
  const blockOf = (b: bigint) => ({ number: `0x${b.toString(16)}`, hash: h32(`block ${b}`), timestamp: `0x${(DEPOSIT_AT + Math.floor(Number(b - BLOCK) / 10)).toString(16)}` });
  const log = { address: USDG, topics: [TR, topic(`0x${"d0".repeat(20)}`), topic(ACCOUNT)], data: `0x${(9_000_000n).toString(16).padStart(64, "0")}`, logIndex: "0x2",
    blockNumber: `0x${BLOCK.toString(16)}`, transactionHash: DEPOSIT_TX };
  if (method === "eth_chainId") return "0x1237";
  if (method === "eth_blockNumber") return `0x${HEAD.toString(16)}`;
  if (method === "eth_getBlockByNumber") return blockOf(BigInt(params[0] as string));
  if (method === "eth_getLogs") {
    const f = params[0] as { address: string; fromBlock: string; toBlock: string; topics: Array<string | null> };
    const hit = f.address.toLowerCase() === USDG && BigInt(f.fromBlock) <= BLOCK && BLOCK <= BigInt(f.toBlock)
      && f.topics.every((t, i) => t === null || t.toLowerCase() === log.topics[i]);
    return hit ? [log] : [];
  }
  if (method === "eth_getTransactionReceipt") return { status: "0x1", blockNumber: log.blockNumber, blockHash: blockOf(BLOCK).hash, from: `0x${"d0".repeat(20)}`, to: USDG, logs: [log] };
  throw new Error(`unexpected ${method}`);
};

describe("arguments", () => {
  const out = path.join(dir, "x.json"), d = "a".repeat(64);
  it("parses the three modes and refuses anything else by a fixed code", () => {
    assert.deepEqual(parseBookingArgs(["--tenant", TENANT.toUpperCase().replace("0X", "0x"), "--output", out]), { mode: "preview", tenant: TENANT, output: out });
    assert.deepEqual(parseBookingArgs(["--dry-run", "--tenant", TENANT, "--output", out]), { mode: "preview", tenant: TENANT, output: out });
    assert.deepEqual(parseBookingArgs(["--tenant", TENANT, "--apply", "--confirm", d, "--backup-ref", "bk-1", "--output", out]),
      { mode: "apply", tenant: TENANT, output: out, confirm: d, backupRef: "bk-1" });
    assert.deepEqual(parseBookingArgs(["--revert", out, "--output", `${out}.r`]), { mode: "revert", report: out, output: `${out}.r` });
    for (const bad of [
      [], ["--tenant", TENANT], ["--tenant", TENANT, "--output", "relative.json"], ["--tenant", "0x1234", "--output", out],
      ["--tenant", TENANT, "--output", out, "--confirm", d], ["--tenant", TENANT, "--output", out, "--backup-ref", "bk"],
      ["--tenant", TENANT, "--output", out, "--apply", "--confirm", d], ["--tenant", TENANT, "--output", out, "--apply", "--backup-ref", "bk"],
      ["--tenant", TENANT, "--output", out, "--apply", "--dry-run", "--confirm", d, "--backup-ref", "bk"],
      ["--tenant", TENANT, "--output", out, "--apply", "--confirm", "A".repeat(64), "--backup-ref", "bk"],
      ["--tenant", TENANT, "--tenant", TENANT, "--output", out], ["--tenant", TENANT, "--output", out, "--everything"],
      ["--revert", out, "--tenant", TENANT, "--output", out], ["--revert", "rel.json", "--output", out], ["--tenant", "--output", out],
    ]) assert.throws(() => parseBookingArgs(bad), (e: unknown) => e instanceof CliError && e.code === "invalid-arguments", bad.join(" "));
  });
});

describe("the chain transport", () => {
  it("admits a fixed list of reads, and eth_call for decimals() and balanceOf(one address) at latest only", async () => {
    const asked: unknown[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { id: number; method: string };
      asked.push(body.method);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x12" }), { status: 200 });
    }) as unknown as typeof fetch;
    const rpc = createBookingRpc("https://rpc.example/", fetchImpl);
    const token = `0x${"aa".repeat(20)}`, holder = "bb".repeat(20);
    assert.equal(await rpc("eth_blockNumber", []), "0x12");
    assert.equal(await rpc("eth_call", [{ to: token, data: "0x313ce567" }, "latest"]), "0x12");
    assert.equal(await rpc("eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder}` }, "latest"]), "0x12");
    for (const [method, params] of [["eth_sendRawTransaction", ["0x"]], ["eth_getBalance", []], ["eth_call", [{ to: token, data: "0xa9059cbb" }, "latest"]],
      ["eth_call", [{ to: token, data: "0x313ce567" }, "0x1"]], ["eth_call", [{ to: token, data: "0x313ce567", from: `0x${"bb".repeat(20)}` }, "latest"]],
      // balanceOf with anything but one zero-padded address: a second word, a dirty pad, a short address, or another block.
      ["eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder}${"0".repeat(64)}` }, "latest"]],
      ["eth_call", [{ to: token, data: `0x70a08231${"1".repeat(24)}${holder}` }, "latest"]],
      ["eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder.slice(2)}` }, "latest"]],
      ["eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder}` }, "earliest"]],
      // transfer(address,uint256) shaped like it: the selector is what is admitted, not the length.
      ["eth_call", [{ to: token, data: `0xa9059cbb${"0".repeat(24)}${holder}` }, "latest"]]] as const) {
      await assert.rejects(rpc(method, params as unknown as unknown[]), (e: unknown) => e instanceof CliError && /allowlist/.test(e.code), `${method} ${JSON.stringify(params)}`);
    }
    assert.deepEqual(asked, ["eth_blockNumber", "eth_call", "eth_call"], "nothing refused left the process");
    assert.throws(() => createBookingRpc("ftp://rpc.example/"), (e: unknown) => (e as CliError).code === "unsupported-rpc-url");
  });
  it("a rate limit and a node's refusal keep what the adaptive reader needs to tell them apart; a forged answer is refused", async () => {
    const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    await assert.rejects(createBookingRpc("https://r/", reply(429, {}))("eth_blockNumber", []), (e: unknown) => (e as { status?: number }).status === 429);
    await assert.rejects(createBookingRpc("https://r/", reply(200, { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "query returned more than 10000 results" } }))("eth_getLogs", [{}]),
      /query returned more than/);
    await assert.rejects(createBookingRpc("https://r/", reply(200, { jsonrpc: "2.0", id: 99, result: "0x1" }))("eth_chainId", []), /rpc-read-failed/);
  });
});

describe("the read-only connection and the report files", () => {
  it("refuses a write on the read-only connection before it is sent, and always rolls its snapshot back", async () => {
    const said: string[] = [];
    const fake: PgClient = { async query(sql) { said.push(sql); return { rows: [{ ro: "on", iso: "repeatable read" }], rowCount: 1 }; }, async end() {} };
    const db = pgClientDb(fake, { readOnly: true });
    assert.throws(() => db.prepare("INSERT INTO trades (id) VALUES (1)"), (e: unknown) => (e as CliError).code === "non-read-query-refused");
    assert.throws(() => db.prepare("SELECT 1; UPDATE agents SET epoch = 1"), (e: unknown) => (e as CliError).code === "non-read-query-refused");
    await assert.rejects(db.exec("CREATE TABLE x (y)"), (e: unknown) => (e as CliError).code === "non-read-query-refused");
    assert.deepEqual(await db.tx(async (s) => s.prepare("SELECT ? AS x WHERE ? = ?").get(1, 2, 2)), { ro: "on", iso: "repeatable read" }, "the fake answers every read alike");
    assert.deepEqual(said.filter((s) => /^(BEGIN|ROLLBACK|COMMIT)/.test(s)), ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "ROLLBACK"]);
    assert.ok(said.includes("SELECT $1 AS x WHERE $2 = $3"), "the store's placeholders, translated");
    const notReadOnly: PgClient = { async query(sql) { said.push(sql); return { rows: [{ ro: "off", iso: "read committed" }], rowCount: 1 }; }, async end() {} };
    await assert.rejects(pgClientDb(notReadOnly, { readOnly: true }).tx(async () => 1), (e: unknown) => (e as CliError).code === "read-only-snapshot-not-established");
    assert.equal(said.at(-1), "ROLLBACK");
  });
  it("a report is created once, 0600, in a real directory: never over a file or through a link", () => {
    const file = path.join(dir, "once.json");
    const fd = createReportFile(file);
    finishReportFile(fd, file, { b: 2, a: 1n });
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: "1", b: 2 });
    assert.throws(() => createReportFile(file), (e: unknown) => (e as CliError).code === "report-exists-or-unsafe");
    const target = path.join(dir, "elsewhere.json"), link = path.join(dir, "link.json");
    symlinkSync(target, link);
    assert.throws(() => createReportFile(link), (e: unknown) => (e as CliError).code === "report-exists-or-unsafe");
    assert.equal(existsSync(target), false, "nothing written through the link");
    assert.throws(() => createReportFile(path.join(dir, "missing", "x.json")), (e: unknown) => (e as CliError).code === "report-path-unsafe");
  });
  it("the database is named by host, port and name only; a failure line never carries a URL", () => {
    assert.equal(targetDigest(DATABASE_URL), targetDigest("postgresql://other:pw@db.internal.example:6543/railway?sslmode=require".replace("postgresql", "postgres")));
    assert.notEqual(targetDigest(DATABASE_URL), targetDigest("postgres://operator:s3cret@db.internal.example:6543/other"));
    assert.throws(() => targetDigest("mysql://x"), (e: unknown) => (e as CliError).code === "invalid-database-url");
    const line = failureLine(new Error(`connect ECONNREFUSED ${DATABASE_URL}`));
    assert.doesNotMatch(line, /s3cret|operator|example/);
    assert.match(failureLine(new BookingRefused("cas", "the books changed since the preview (ledger)")), /^refused \(cas\): the books changed/);
    assert.equal(failureLine(new CliError("database-url-required")), "database-url-required. Use --help for invocation.");
  });
});

describe("one whole run: preview, a refused apply, the apply, a second apply, the revert", () => {
  it("books the lone deposit exactly once, through the shell an operator runs", async () => {
    const raw = await shared();
    const said: string[] = [], printed: string[] = [];
    const deps = { connect: async () => pgOverSqlite(raw, said), rpc: chain, nowMs: () => NOW * 1000, out: (l: string) => printed.push(l),
      source: { "chain-gap-booking.ts": "fixed" }, sleep: async () => {} };
    const env = { DATABASE_URL };
    const previewFile = path.join(dir, "preview.json");
    assert.equal(await main(["--tenant", TENANT, "--output", previewFile], env, deps), 0);
    const plan = JSON.parse(readFileSync(previewFile, "utf8")) as { verdict: string; previewDigest: string; mode: string; writesPerformed: number; items: Array<{ class: string }> };
    assert.deepEqual([plan.verdict, plan.mode, plan.writesPerformed, plan.items.map((i) => i.class)], ["ready", "preview", 0, ["deposit"]]);
    assert.ok(printed.some((l) => l.includes(`deposit: USDG in 9.000000 in tx ${DEPOSIT_TX} log 2 at block ${BLOCK} → flows row`)));
    assert.ok(printed.includes(`previewDigest ${plan.previewDigest}`));
    assert.ok(printed.every((l) => !/s3cret|operator@|db\.internal/.test(l)), "no credential, no host");
    assert.deepEqual(said.filter((s) => !/^\s*(SELECT|WITH)\b/i.test(s)), ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "ROLLBACK"], "the preview's only statements besides SELECTs");
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM flows").get()!.n, 1);

    // A digest nobody reviewed: refused, nothing written, and its report file not left behind.
    const wrong = path.join(dir, "apply-wrong.json");
    await assert.rejects(main(["--tenant", TENANT, "--apply", "--confirm", "b".repeat(64), "--backup-ref", "bk-2026-10-06", "--output", wrong], env, deps),
      (e: unknown) => (e as BookingRefused).code === "confirm-mismatch");
    assert.equal(existsSync(wrong), false);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM flows").get()!.n, 1);

    const applied = path.join(dir, "apply.json");
    printed.length = 0;
    assert.equal(await main(["--tenant", TENANT, "--apply", "--confirm", plan.previewDigest, "--backup-ref", "bk-2026-10-06", "--output", applied], env, deps), 0);
    assert.ok(printed.some((l) => /^APPLIED booking [0-9a-f-]{36} — 1 row\(s\) for tenant/.test(l)), printed.join("\n"));
    assert.equal(statSync(applied).mode & 0o777, 0o600);
    const flow = raw.prepare("SELECT agent_id, direction, amount_usdg, tx_hash, log_index, source, epoch, chain_id, at FROM flows WHERE tx_hash = ?").get(DEPOSIT_TX);
    assert.deepEqual({ ...flow }, { agent_id: ACCOUNT, direction: "in", amount_usdg: 9, tx_hash: DEPOSIT_TX, log_index: 2, source: "chain-log", epoch: 3, chain_id: 4663, at: DEPOSIT_AT });
    assert.equal(raw.prepare(`SELECT backup_ref FROM ${BOOKINGS_TABLE}`).get()!.backup_ref, "bk-2026-10-06");

    // Applied once: the next apply finds nothing missing, and writes nothing.
    const twice = path.join(dir, "apply-twice.json");
    await assert.rejects(main(["--tenant", TENANT, "--apply", "--confirm", plan.previewDigest, "--backup-ref", "bk-2026-10-06", "--output", twice], env, deps),
      (e: unknown) => (e as BookingRefused).code === "nothing-missing");
    assert.equal(existsSync(twice), false);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM flows WHERE tx_hash = ?").get(DEPOSIT_TX)!.n, 1);

    printed.length = 0;
    const reverted = path.join(dir, "revert.json");
    assert.equal(await main(["--revert", applied, "--output", reverted], env, deps), 0);
    assert.ok(printed.some((l) => /^REVERTED booking .* 1 row\(s\)/.test(l)));
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM flows WHERE tx_hash = ?").get(DEPOSIT_TX)!.n, 0);
    assert.equal(JSON.parse(readFileSync(reverted, "utf8")).outcome, "reverted");
    // A forged report reverts nothing.
    const forged = path.join(dir, "forged.json");
    writeFileSync(forged, readFileSync(applied, "utf8").replace('"bk-2026-10-06"', '"bk-other"'));
    await assert.rejects(main(["--revert", forged, "--output", path.join(dir, "forged-out.json")], env, deps), (e: unknown) => (e as BookingRefused).code === "report");
  });

  it("without DATABASE_URL nothing runs", async () => {
    await assert.rejects(main(["--tenant", TENANT, "--output", path.join(dir, "n.json")], {}, {}), (e: unknown) => (e as CliError).code === "database-url-required");
  });
});
