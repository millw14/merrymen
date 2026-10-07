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
import { BookingRefused, BOOKINGS_TABLE, parseApplyReport } from "./chain-gap-booking";
import {
  CliError, commitRolledBack, CommitOutcomeUnknown, conflictRolledBack, createBookingRpc, createReportFile, failureLine, finishReportFile, main, parseBookingArgs, pgClientDb,
  replaceReportFile, targetDigest, type PgClient,
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

/**
 * Postgres's dialect, answered by sqlite: $n placeholders, the read-only
 * transaction held to query_only, the isolation a BEGIN named reported back
 * (`level` overrides what the write transaction's reports), and COMMIT's tag.
 */
function pgOverSqlite(raw: DatabaseSync, said: string[], o: { level?: string } = {}): PgClient {
  let readOnly = false, iso = "read committed";
  const empty = { rows: [], rowCount: 0 };
  return {
    async query(sql, params = []) {
      said.push(sql);
      if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") { raw.exec("BEGIN"); raw.exec("PRAGMA query_only = ON"); readOnly = true; iso = "repeatable read"; return empty; }
      if (sql === "BEGIN ISOLATION LEVEL SERIALIZABLE") { raw.exec("BEGIN"); iso = o.level ?? "serializable"; return empty; }
      if (/current_setting\('transaction_read_only'\)/.test(sql)) return { rows: [{ ro: readOnly ? "on" : "off", iso }], rowCount: 1 };
      // Postgres's catalogue, from sqlite's.
      if (/FROM information_schema\.tables WHERE table_schema = current_schema\(\)/.test(sql)) {
        const rows = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<Record<string, unknown>>).map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }
      if (/FROM information_schema\.columns WHERE table_schema = current_schema\(\) AND table_name = \$1/.test(sql)) {
        const rows = (raw.prepare("SELECT name FROM pragma_table_info(?)").all(params[0] as string) as Array<Record<string, unknown>>).map((r) => ({ ...r }));
        return { rows, rowCount: rows.length };
      }
      if (sql === "BEGIN") { raw.exec(sql); return empty; }
      if (sql === "COMMIT") { raw.exec(sql); iso = "read committed"; return { ...empty, command: "COMMIT" }; }
      if (sql === "ROLLBACK") { raw.exec("ROLLBACK"); iso = "read committed"; if (readOnly) { raw.exec("PRAGMA query_only = OFF"); readOnly = false; } return empty; }
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
  // What holds it: admission's chain refusal, an hour before the preview, naming the deposit, and where its read began (the cursors, less 600s).
  await ensureLedgerResumeSchema(db);
  raw.prepare(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run, state, reason,
      created_at_ms, updated_at_ms, chain_read_from_sec) VALUES ('a1', ?, ?, 4663, ?, ?, '{}', 'r', 'refused', ?, ?, ?, ?)`)
    .run(TENANT, ACCOUNT, TENANT, "e".repeat(64), `${CHAIN_REFUSAL}: USDG in 9.000000 in tx ${DEPOSIT_TX} log 2 at block ${BLOCK}`, (NOW - 3660) * 1000, (NOW - 3600) * 1000,
      DEPOSIT_AT - 4200);
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
    // --revert with --dry-run only reads the booking's receipts.
    assert.deepEqual(parseBookingArgs(["--revert", out, "--dry-run", "--output", `${out}.c`]), { mode: "receipts", report: out, output: `${out}.c` });
    assert.deepEqual(parseBookingArgs(["--dry-run", "--revert", out, "--output", `${out}.c`]), { mode: "receipts", report: out, output: `${out}.c` });
    for (const bad of [
      ["--revert", out, "--dry-run", "--apply", "--output", out], ["--revert", out, "--dry-run", "--confirm", d, "--output", out], ["--revert", out, "--dry-run"],
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
  it("admits a fixed list of reads, and eth_call for decimals() at latest and balanceOf(one address) at a pinned block number only", async () => {
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
    assert.equal(await rpc("eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder}` }, "0x4dfe3ca"]), "0x12");
    for (const [method, params] of [["eth_sendRawTransaction", ["0x"]], ["eth_getBalance", []], ["eth_call", [{ to: token, data: "0xa9059cbb" }, "latest"]],
      ["eth_call", [{ to: token, data: "0x313ce567" }, "0x1"]], ["eth_call", [{ to: token, data: "0x313ce567", from: `0x${"bb".repeat(20)}` }, "latest"]],
      // balanceOf with anything but one zero-padded address: a second word, a dirty pad, a short address.
      ["eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder}${"0".repeat(64)}` }, "0x4dfe3ca"]],
      ["eth_call", [{ to: token, data: `0x70a08231${"1".repeat(24)}${holder}` }, "0x4dfe3ca"]],
      ["eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder.slice(2)}` }, "0x4dfe3ca"]],
      // ...or at anything but a block number: a tag ("latest" too: it could hold what landed after the facts), a padded or upper-case quantity, a hash, an object.
      ["eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder}` }, "latest"]],
      ["eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder}` }, "earliest"]],
      ["eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder}` }, "0x04dfe3ca"]],
      ["eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder}` }, "0x4DFE3CA"]],
      ["eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder}` }, `0x${"ab".repeat(32)}`]],
      ["eth_call", [{ to: token, data: `0x70a08231${"0".repeat(24)}${holder}` }, { blockNumber: "0x4dfe3ca" }]],
      // transfer(address,uint256) shaped like it: the selector is what is admitted, not the length.
      ["eth_call", [{ to: token, data: `0xa9059cbb${"0".repeat(24)}${holder}` }, "0x4dfe3ca"]]] as const) {
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
    said.length = 0;
    assert.equal(await main(["--tenant", TENANT, "--apply", "--confirm", plan.previewDigest, "--backup-ref", "bk-2026-10-06", "--output", applied], env, deps), 0);
    assert.ok(printed.some((l) => /^APPLIED booking [0-9a-f-]{36} — 1 row\(s\) for tenant/.test(l)), printed.join("\n"));
    assert.equal(statSync(applied).mode & 0o777, 0o600);
    // The booking id said before anything was read, the write transaction SERIALIZABLE, and the report marked committed once the COMMIT was answered.
    const appliedReport = JSON.parse(readFileSync(applied, "utf8")) as { bookingId: string; commitOutcome: string };
    assert.ok(printed[0]!.startsWith(`booking ${appliedReport.bookingId}: its apply report is written to ${applied} before the COMMIT is sent`), printed[0]);
    assert.equal(appliedReport.commitOutcome, "committed");
    assert.equal(existsSync(`${applied}.committed.tmp`), false);
    assert.deepEqual(said.filter((s) => /^(BEGIN|COMMIT|ROLLBACK)/.test(s)),
      ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "ROLLBACK", "BEGIN ISOLATION LEVEL SERIALIZABLE", "COMMIT"]);
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
    assert.deepEqual(said.filter((s) => /^(BEGIN|COMMIT|ROLLBACK)/.test(s)).slice(-2), ["BEGIN ISOLATION LEVEL SERIALIZABLE", "COMMIT"], "the revert is SERIALIZABLE too");
    // A forged report reverts nothing.
    const forged = path.join(dir, "forged.json");
    writeFileSync(forged, readFileSync(applied, "utf8").replace('"bk-2026-10-06"', '"bk-other"'));
    await assert.rejects(main(["--revert", forged, "--output", path.join(dir, "forged-out.json")], env, deps), (e: unknown) => (e as BookingRefused).code === "report");
  });

  it("without DATABASE_URL nothing runs", async () => {
    await assert.rejects(main(["--tenant", TENANT, "--output", path.join(dir, "n.json")], {}, {}), (e: unknown) => (e as CliError).code === "database-url-required");
  });
});

// ── the write transaction and what its COMMIT's answer proves ────────────────

const ISO_CHECK = "SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso";
/** A driver's error, its message carrying the URL (as a real one can): the shell must never print it. */
const pgError = (code: unknown) => Object.assign(new Error(`connection to ${DATABASE_URL} failed`), code === undefined ? {} : { code });
/** SQLSTATEs that prove the transaction rolled back at COMMIT: class 40 but 40003, and class 23 (a deferred constraint). */
const ROLLED_BACK = ["40001", "40P01", "40002", "40000", "23505", "23503", "23514", "23P01", "23000"];
/**
 * What does not: a dropped or reset connection, a terminated backend or a server going down or starting, a connection exception (08007
 * "transaction resolution unknown" among them), a cancelled or timed-out statement, 40003 "statement completion unknown", a resource or
 * internal error, no code at all — and codes that only look like SQLSTATEs (EPIPE is five capitals), a lowercase one, a number.
 */
const UNKNOWN: unknown[] = ["EPIPE", "ECONNRESET", "ETIMEDOUT", "57P01", "57P02", "57P03", "08000", "08003", "08006", "08007", "57014", "40003", "53100", "53300", "XX000",
  "25P02", undefined, "40p01", 40001, "4000", "400011"];

describe("the write transaction: SERIALIZABLE, and what a COMMIT's answer proves", () => {
  /** A connection that answers every statement, reports `level`, and answers COMMIT as `commit` does. */
  const scripted = (commit: () => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null; command?: string }>, level = "serializable") => {
    const said: string[] = [];
    const client: PgClient = {
      async query(sql) {
        said.push(sql);
        if (sql === "COMMIT") return commit();
        if (sql === ISO_CHECK) return { rows: [{ ro: "off", iso: level }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      async end() {},
    };
    return { said, db: pgClientDb(client, { readOnly: false }) };
  };
  const committed = async () => ({ rows: [], rowCount: null, command: "COMMIT" });

  it("begins SERIALIZABLE and proves it before the work runs; at any other level nothing runs and it rolls back", async () => {
    const ok = scripted(committed);
    assert.equal(await ok.db.tx(async (tx) => { await tx.prepare("SELECT 1").get(); return 7; }), 7);
    assert.deepEqual(ok.said, ["BEGIN ISOLATION LEVEL SERIALIZABLE", ISO_CHECK, "SELECT 1", "COMMIT"]);
    for (const level of ["read committed", "repeatable read"]) {
      const other = scripted(committed, level);
      let ran = false;
      await assert.rejects(other.db.tx(async () => { ran = true; }), (e: unknown) => e instanceof CliError && e.code === "serializable-not-established", level);
      assert.equal(ran, false, level);
      assert.deepEqual(other.said, ["BEGIN ISOLATION LEVEL SERIALIZABLE", ISO_CHECK, "ROLLBACK"], level);
    }
  });

  it("a COMMIT refused with class 40 (but 40003) or class 23 is rethrown as itself: it rolled back", async () => {
    for (const code of ROLLED_BACK) {
      assert.equal(commitRolledBack(pgError(code)), true, code);
      const s = scripted(async () => { throw pgError(code); });
      await assert.rejects(s.db.tx(async () => 1), (e: unknown) => !(e instanceof CommitOutcomeUnknown) && (e as { code?: string }).code === code, code);
      assert.equal(conflictRolledBack(pgError(code)), code.startsWith("40"), `${code}: only class 40 is a conflict to run again`);
    }
  });

  it("every other COMMIT failure is an unknown outcome — never 'nothing happened'", async () => {
    for (const code of UNKNOWN) {
      assert.equal(commitRolledBack(pgError(code)), false, String(code));
      assert.equal(conflictRolledBack(pgError(code)), false, String(code));
      const s = scripted(async () => { throw pgError(code); });
      await assert.rejects(s.db.tx(async () => 1), (e: unknown) => e instanceof CommitOutcomeUnknown, String(code));
    }
    for (const thrown of [null, undefined, "a string", 40001]) {
      assert.equal(commitRolledBack(thrown), false, String(thrown));
      await assert.rejects(scripted(async () => { throw thrown; }).db.tx(async () => 1), (e: unknown) => e instanceof CommitOutcomeUnknown, String(thrown));
    }
  });

  it("a COMMIT the server answered with ROLLBACK's tag (a transaction already failed) is a rollback, not a commit", async () => {
    const s = scripted(async () => ({ rows: [], rowCount: null, command: "ROLLBACK" }));
    await assert.rejects(s.db.tx(async () => 1), (e: unknown) => e instanceof CliError && e.code === "commit-answered-rollback");
  });

  it("before the COMMIT, any failure — a dropped connection too — rolls back and is never an unknown outcome: the COMMIT was never sent", async () => {
    for (const code of [...UNKNOWN, ...ROLLED_BACK]) {
      const s = scripted(committed);
      await assert.rejects(s.db.tx(async () => { throw pgError(code); }), (e: unknown) => !(e instanceof CommitOutcomeUnknown) && (e as { code?: unknown }).code === code, String(code));
      assert.equal(s.said.includes("COMMIT"), false, String(code));
      assert.equal(s.said.at(-1), "ROLLBACK", String(code));
    }
  });
});

describe("through the shell: an apply's report outlives a COMMIT whose answer is lost, and only a proven rollback removes it", () => {
  const BOOKING_ID = "0b0c1d2e-3f40-4152-8364-758697a8b9ca";
  const env = { DATABASE_URL };
  type Wrap = (c: PgClient) => PgClient;
  /** A run over one sqlite database; `write` wraps the write connection (the read-only one is always plain), `level` is what it reports. */
  const runner = (raw: DatabaseSync, o: { write?: Wrap; level?: string } = {}) => {
    const said: string[] = [], printed: string[] = [];
    const deps = {
      connect: async (_u: string, readOnly: boolean) => {
        const c = pgOverSqlite(raw, said, { level: o.level });
        return readOnly || !o.write ? c : o.write(c);
      },
      rpc: chain, nowMs: () => NOW * 1000, out: (l: string) => printed.push(l), source: { "chain-gap-booking.ts": "fixed" }, sleep: async () => {}, bookingId: () => BOOKING_ID,
    };
    return { said, printed, deps, run: (args: string[]) => main(args, env, deps) };
  };
  /** COMMIT answered by `error`: after it took effect ("lost": the answer never came), or in place of it ("refused": rolled back). Or with ROLLBACK's tag. */
  const commitAnswered = (how: "lost" | "refused" | "rollback-tag", error?: unknown): Wrap => (c) => ({
    async query(sql, params) {
      if (sql !== "COMMIT") return c.query(sql, params);
      if (how === "lost") { await c.query("COMMIT"); throw error; }
      await c.query("ROLLBACK");
      if (how === "rollback-tag") return { rows: [], rowCount: null, command: "ROLLBACK" };
      throw error;
    },
    end: () => c.end(),
  });
  /** The agent row moved after the write transaction's snapshot: locking it fails with 40001, as Postgres's first-updater-wins does. */
  const lockConflict: Wrap = (c) => ({
    async query(sql, params) { if (/^UPDATE agents SET epoch = epoch/.test(sql)) throw pgError("40001"); return c.query(sql, params); },
    end: () => c.end(),
  });
  let n = 0;
  const file = (tag: string) => path.join(dir, `${tag}-${++n}.json`);
  const flows = (raw: DatabaseSync) => Number(raw.prepare("SELECT COUNT(*) AS n FROM flows WHERE tx_hash = ?").get(DEPOSIT_TX)!.n);
  const receipts = (raw: DatabaseSync) => (raw.prepare(`SELECT name FROM sqlite_master WHERE name = '${BOOKINGS_TABLE}'`).get()
    ? (raw.prepare(`SELECT state FROM ${BOOKINGS_TABLE}`).all() as Array<{ state: string }>).map((r) => r.state) : []);
  /** A fresh database, previewed: its digest. */
  const reviewed = async () => {
    const raw = await shared();
    const previewFile = file("preview");
    assert.equal(await runner(raw).run(["--tenant", TENANT, "--output", previewFile]), 0);
    return { raw, digest: (JSON.parse(readFileSync(previewFile, "utf8")) as { previewDigest: string }).previewDigest };
  };
  const applyArgs = (digest: string, output: string) => ["--tenant", TENANT, "--apply", "--confirm", digest, "--backup-ref", "bk-2026-10-06", "--output", output];
  const noSecret = (printed: string[]) => assert.ok(printed.every((l) => !/s3cret|operator@|db\.internal/.test(l)), printed.join("\n"));

  it("a COMMIT that took effect and whose answer was lost keeps the report, says OUTCOME UNKNOWN with both commands, and the receipts settle it", async () => {
    for (const code of ["EPIPE", "ECONNRESET", "57P01", "57P02", "57P03", "08006", "08007", "57014", "40003", undefined]) {
      const { raw, digest } = await reviewed();
      const apply = runner(raw, { write: commitAnswered("lost", pgError(code)) });
      const out = file("lost");
      await assert.rejects(apply.run(applyArgs(digest, out)), (e: unknown) => e instanceof CliError && e.code === "apply-outcome-unknown", String(code));
      assert.equal(flows(raw), 1, `${code}: it committed`);
      assert.deepEqual(receipts(raw), ["applied"], String(code));
      // The report: kept, whole, verifying, saying its outcome is unknown — and the booking the receipts hold.
      const report = parseApplyReport(readFileSync(out, "utf8"));
      assert.deepEqual([report.bookingId, report.commitOutcome, report.rows.length], [BOOKING_ID, "unknown", 1], String(code));
      assert.equal(statSync(out).mode & 0o777, 0o600);
      const said = apply.printed.join("\n");
      assert.ok(said.includes(`OUTCOME UNKNOWN for booking ${BOOKING_ID}: the COMMIT was sent and no answer proved it rolled back`), said);
      assert.ok(said.includes(`--revert ${out} --dry-run --output /absolute/new-receipts-report.json`), said);
      assert.ok(said.includes(`--revert ${out} --output /absolute/new-revert-report.json`), said);
      assert.equal(apply.printed.some((l) => l.startsWith("APPLIED")), false);
      noSecret(apply.printed);
      // Did it commit? Read only: yes.
      const look = runner(raw), lookOut = file("receipts");
      assert.equal(await look.run(["--revert", out, "--dry-run", "--output", lookOut]), 0);
      assert.ok(look.printed[0]!.startsWith(`COMMITTED booking ${BOOKING_ID} — tenant ${TENANT}: 1 receipt(s) 'applied'`), look.printed.join("\n"));
      const view = JSON.parse(readFileSync(lookOut, "utf8")) as { verdict: string; writesPerformed: number; receipts: Array<{ state: string }> };
      assert.deepEqual([view.verdict, view.writesPerformed, view.receipts.map((r) => r.state)], ["applied", 0, ["applied"]]);
      assert.deepEqual(look.said.filter((s) => !/^\s*(SELECT|WITH)\b/i.test(s)), ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "ROLLBACK"], "the look writes nothing");
    }
    // ...and the report it kept is what --revert takes.
    const { raw, digest } = await reviewed();
    const out = file("lost");
    await assert.rejects(runner(raw, { write: commitAnswered("lost", pgError("ECONNRESET")) }).run(applyArgs(digest, out)), (e: unknown) => (e as CliError).code === "apply-outcome-unknown");
    const back = runner(raw);
    assert.equal(await back.run(["--revert", out, "--output", file("revert")]), 0);
    assert.ok(back.printed[0]!.startsWith(`REVERTED booking ${BOOKING_ID}`), back.printed.join("\n"));
    assert.equal(flows(raw), 0);
    const after = runner(raw);
    assert.equal(await after.run(["--revert", out, "--dry-run", "--output", file("receipts")]), 0);
    assert.ok(after.printed[0]!.startsWith("COMMITTED, THEN REVERTED booking"), after.printed.join("\n"));
  });

  it("the connection lost before the COMMIT reached the server: the same OUTCOME UNKNOWN, and the receipts say it never committed", async () => {
    const { raw, digest } = await reviewed();
    const out = file("unsent");
    await assert.rejects(runner(raw, { write: commitAnswered("refused", pgError("ECONNRESET")) }).run(applyArgs(digest, out)),
      (e: unknown) => (e as CliError).code === "apply-outcome-unknown");
    assert.equal(flows(raw), 0);
    assert.deepEqual(receipts(raw), []);
    assert.equal(parseApplyReport(readFileSync(out, "utf8")).commitOutcome, "unknown");
    const look = runner(raw), lookOut = file("receipts");
    assert.equal(await look.run(["--revert", out, "--dry-run", "--output", lookOut]), 0);
    assert.ok(look.printed[0]!.startsWith(`NOT COMMITTED booking ${BOOKING_ID} — tenant ${TENANT}: no receipt, so that apply rolled back and wrote nothing`), look.printed.join("\n"));
    assert.equal((JSON.parse(readFileSync(lookOut, "utf8")) as { verdict: string }).verdict, "not-committed");
    // A revert of it is refused by name, changing nothing; and the apply, run again, books it.
    await assert.rejects(runner(raw).run(["--revert", out, "--output", file("revert")]), (e: unknown) => e instanceof BookingRefused && e.code === "not-committed");
    assert.equal(await runner(raw).run(applyArgs(digest, file("again"))), 0);
    assert.equal(flows(raw), 1);
  });

  it("a COMMIT whose answer proves a rollback (class 40 but 40003, class 23) leaves no report and writes nothing; a conflict says to run it again", async () => {
    for (const code of ["40001", "40P01", "40002", "23505", "23514"]) {
      const { raw, digest } = await reviewed();
      const apply = runner(raw, { write: commitAnswered("refused", pgError(code)) });
      const out = file("refused");
      const failure = await apply.run(applyArgs(digest, out)).then(() => assert.fail(`${code}: applied`), (e: unknown) => e);
      if (code.startsWith("40")) {
        assert.ok(failure instanceof BookingRefused && failure.code === "conflict", code);
        assert.match(failureLine(failure), new RegExp(`^refused \\(conflict\\): Postgres rolled the apply back for a conflict with another transaction \\(SQLSTATE ${code}`));
        assert.match(failureLine(failure), /nothing was written — run the same command again/);
      } else {
        assert.ok(!(failure instanceof CommitOutcomeUnknown) && (failure as { code?: string }).code === code, code);
        assert.match(failureLine(failure), /^booking-failed: nothing was applied unless an APPLIED or an OUTCOME UNKNOWN line was printed/);
      }
      assert.doesNotMatch(failureLine(failure), /s3cret|operator|db\.internal/);
      assert.equal(existsSync(out), false, `${code}: no report of a booking that does not exist`);
      assert.equal(flows(raw), 0, code);
      assert.deepEqual(receipts(raw), [], code);
      assert.equal(apply.printed.some((l) => /OUTCOME UNKNOWN|^APPLIED/.test(l)), false, code);
      // Run again, as it says: it applies.
      assert.equal(await runner(raw).run(applyArgs(digest, file("retry"))), 0, code);
      assert.equal(flows(raw), 1, code);
    }
  });

  it("a COMMIT answered with ROLLBACK's tag leaves no report and writes nothing", async () => {
    const { raw, digest } = await reviewed();
    const out = file("tag");
    await assert.rejects(runner(raw, { write: commitAnswered("rollback-tag") }).run(applyArgs(digest, out)),
      (e: unknown) => e instanceof CliError && e.code === "commit-answered-rollback");
    assert.equal(existsSync(out), false);
    assert.equal(flows(raw), 0);
  });

  it("a serialization failure inside the transaction (the agent row moved after its snapshot) rolls back, writes nothing, and says to run again", async () => {
    const { raw, digest } = await reviewed();
    const apply = runner(raw, { write: lockConflict });
    const out = file("lock");
    await assert.rejects(apply.run(applyArgs(digest, out)), (e: unknown) => e instanceof BookingRefused && e.code === "conflict" && /SQLSTATE 40001/.test(e.message));
    assert.equal(existsSync(out), false);
    assert.equal(flows(raw), 0);
    assert.equal(apply.said.includes("COMMIT"), false);
    assert.equal(apply.said.at(-1), "ROLLBACK");
  });

  it("a server that does not grant SERIALIZABLE runs nothing: refused, no report, nothing written", async () => {
    const { raw, digest } = await reviewed();
    const apply = runner(raw, { level: "read committed" });
    const out = file("level");
    await assert.rejects(apply.run(applyArgs(digest, out)), (e: unknown) => e instanceof CliError && e.code === "serializable-not-established");
    assert.equal(existsSync(out), false);
    assert.equal(flows(raw), 0);
    assert.equal(apply.said.some((s) => /^UPDATE agents/.test(s)), false, "not even the lock");
  });

  it("a report that cannot be marked committed after an acknowledged COMMIT stays, saying unknown, and is still what --revert takes", async () => {
    const { raw, digest } = await reviewed();
    const out = file("unmarked");
    writeFileSync(`${out}.committed.tmp`, "someone else's");
    const apply = runner(raw);
    await assert.rejects(apply.run(applyArgs(digest, out)), (e: unknown) => e instanceof CliError && e.code === "applied-report-not-marked-committed");
    assert.ok(apply.printed.some((l) => l.startsWith(`APPLIED booking ${BOOKING_ID}`)), apply.printed.join("\n"));
    assert.equal(flows(raw), 1);
    assert.equal(parseApplyReport(readFileSync(out, "utf8")).commitOutcome, "unknown");
    assert.equal(readFileSync(`${out}.committed.tmp`, "utf8"), "someone else's", "never written through");
    assert.equal(await runner(raw).run(["--revert", out, "--output", file("revert")]), 0);
    assert.equal(flows(raw), 0);
  });

  it("an empty or cut-short report — an apply that died before its COMMIT — is named as one that never sent it", async () => {
    const raw = await shared();
    for (const text of ["", '{"format":"merrymen.chain-gap-booking.apply.v1","bookingId":"0b0c']) {
      const cut = file("cut");
      writeFileSync(cut, text);
      await assert.rejects(runner(raw).run(["--revert", cut, "--dry-run", "--output", file("receipts")]),
        (e: unknown) => e instanceof BookingRefused && e.code === "report-unfinished" && /never sent its COMMIT/.test(e.message));
    }
  });

  it("a revert whose COMMIT's answer was lost says so, keeps no report, and runs again safely; a conflict rolls it back and says to run again", async () => {
    const { raw, digest } = await reviewed();
    const applied = file("apply");
    assert.equal(await runner(raw).run(applyArgs(digest, applied)), 0);
    const conflicted = file("revert");
    await assert.rejects(runner(raw, { write: lockConflict }).run(["--revert", applied, "--output", conflicted]),
      (e: unknown) => e instanceof BookingRefused && e.code === "conflict" && /rolled the revert back/.test(e.message));
    assert.equal(existsSync(conflicted), false);
    assert.equal(flows(raw), 1, "nothing changed");
    const lost = runner(raw, { write: commitAnswered("lost", pgError("57P01")) });
    const lostOut = file("revert");
    await assert.rejects(lost.run(["--revert", applied, "--output", lostOut]), (e: unknown) => e instanceof CliError && e.code === "revert-outcome-unknown");
    assert.equal(existsSync(lostOut), false);
    assert.ok(lost.printed[0]!.startsWith(`OUTCOME UNKNOWN for the revert of booking ${BOOKING_ID}`), lost.printed.join("\n"));
    assert.ok(lost.printed[0]!.includes(`--revert ${applied} --dry-run --output`));
    assert.equal(flows(raw), 0, "it took effect");
    const again = runner(raw);
    assert.equal(await again.run(["--revert", applied, "--output", file("revert")]), 0);
    assert.ok(again.printed[0]!.startsWith("ALREADY REVERTED booking"), again.printed.join("\n"));
  });

  it("replacing a report is whole or nothing: the path holds the old report or the new one, never a cut-short one", () => {
    const target = file("whole");
    finishReportFile(createReportFile(target), target, { v: 1 });
    replaceReportFile(target, { v: 2 });
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { v: 2 });
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal(existsSync(`${target}.committed.tmp`), false);
    writeFileSync(`${target}.committed.tmp`, "x");
    assert.throws(() => replaceReportFile(target, { v: 3 }), (e: unknown) => (e as CliError).code === "report-exists-or-unsafe");
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { v: 2 }, "the old one, whole");
  });
});
