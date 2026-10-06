/**
 * Opt-in real, disposable LOCAL PostgreSQL: the chain-gap booking through the
 * operator's shell against the production dialect. Never reads DATABASE_URL.
 *
 * What only Postgres can show: grant_json as JSONB read field by field
 * (->> and ->), a connection opened with default_transaction_read_only that
 * the server itself holds to (a write on it fails at the server, not only at
 * the shell's gate), REPEATABLE READ READ ONLY proved by current_setting,
 * BIGINT ids returned by INSERT … RETURNING, the flows identity's partial
 * unique index with ON CONFLICT DO NOTHING RETURNING, the receipts' partial
 * unique index, the row lock the apply takes, and the recorded fills read
 * back (BIGINT times, TEXT quantities) for a trade's holding to be judged on.
 *
 * Each run creates its own database and drops it. Run with
 * MERRYMEN_TEST_PG_URL=postgres://…@127.0.0.1:<port>/<db> and the `pg`
 * driver resolvable (NODE_PATH works: it is loaded with require here).
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CASH } from "../../packages/core/src/index";
import { translateQuery, translateSchema, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL } from "./ledger-mirror";
import { CHAIN_REFUSAL, knownChainFacts } from "./ledger-resume";
import { ensureLedgerResumeSchema } from "./ledger-import";
import type { RpcCall } from "./chain-capital";
import { BOOKINGS_TABLE, BookingRefused } from "./chain-gap-booking";
import { connectBooking, main, type PgClient } from "./chain-gap-booking-cli";

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
const loadPg = async () => createRequire(import.meta.url)("pg") as unknown;

const TENANT = "0x4b6dcd559c82ea897c34dacfb785fb0c8f85d4c5";
const ACCOUNT = `0x${"a4".repeat(20)}`, POOL = `0x${"9f".repeat(20)}`, COIN = `0x${"c0".repeat(20)}`;
const USDG = String(CASH.USDG).toLowerCase();
const EP = "0x0000000071727de22e5e9d8baf0edac6f37da032";
const TR = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const UOE = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const BEFORE = "0xbb47ee3e183a558b1a2ff0874b079f3fc5478b7454eacf2bfc5af2ff5878f972";
const BLOCK = 79_000_000n, HEAD = BLOCK + 900_000n, AT = 1_791_000_000, NOW = AT + 4 * 86_400;
const h32 = (s: string) => `0x${createHash("sha256").update(s).digest("hex")}`;
const topic = (a: string) => `0x${a.replace(/^0x/, "").padStart(64, "0")}`;
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const OP = h32("a session buy"), OP_TX = h32("its transaction"), DEP_TX = h32("a deposit");
const SESSION_NONCE = (0x0002d5cb71d8n << 208n) | 11n;

/** A session-key buy (USDG out, COIN in) and an outside deposit, each in its own receipt. */
const TXS = [
  { tx: OP_TX, block: BLOCK, logs: [
    [EP, [BEFORE], "0x", "0x1"],
    [USDG, [TR, topic(ACCOUNT), topic(POOL)], `0x${word(3_000_000n)}`, "0x2"],
    [COIN, [TR, topic(POOL), topic(ACCOUNT)], `0x${word(1_500_000_000_000_000_000n)}`, "0x3"],
    [EP, [UOE, OP, topic(ACCOUNT), topic(`0x${"77".repeat(20)}`)], `0x${word(SESSION_NONCE)}${word(1n)}${word(123_456n)}${word(70_000n)}`, "0x4"],
  ] },
  { tx: DEP_TX, block: BLOCK + 50n, logs: [[USDG, [TR, topic(`0x${"d0".repeat(20)}`), topic(ACCOUNT)], `0x${word(20_000_000n)}`, "0x0"]] },
] as Array<{ tx: string; block: bigint; logs: Array<[string, string[], string, string]> }>;
const rpc: RpcCall = async (method, params) => {
  const blockOf = (b: bigint) => ({ number: `0x${b.toString(16)}`, hash: h32(`block ${b}`), timestamp: `0x${(AT + Math.floor(Number(b - BLOCK) / 10)).toString(16)}` });
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
    return { status: "0x1", blockNumber: `0x${t.block.toString(16)}`, blockHash: blockOf(t.block).hash, from: `0x${"d0".repeat(20)}`, to: EP, logs: logsOf(t) };
  }
  if (method === "eth_call") {
    // decimals() is 18; the account still holds what the buy brought it.
    const data = (params[0] as { data: string }).data;
    return data.startsWith("0x70a08231") ? `0x${word(data.endsWith(ACCOUNT.slice(2)) ? 1_500_000_000_000_000_000n : 0n)}` : `0x${word(18n)}`;
  }
  throw new Error(method);
};

test("Postgres: preview read-only, apply once, revert — through the operator's shell", { skip: !url, timeout: 60_000 }, async (t) => {
  const target = new URL(url!);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "only a disposable LOCAL PostgreSQL is allowed");
  const pg = (await loadPg()) as { Client: new (c: { connectionString: string }) => PgClient & { connect(): Promise<void> } };
  const name = `mm_chaingap_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: target.toString() }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const scoped = new URL(target); scoped.pathname = `/${name}`;
  const clients: PgClient[] = [];
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mm-chaingap-pg-")));
  t.after(async () => {
    await Promise.allSettled(clients.map((c) => c.end()));
    try { await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); } finally { await admin.end(); rmSync(tmp, { recursive: true, force: true }); }
  });
  const setup = new pg.Client({ connectionString: scoped.toString() }); await setup.connect(); clients.push(setup);
  const db: Db = {
    prepare(sql) { return {
      async run(...a) { const r = await setup.query(translateQuery(sql), a); return { changes: r.rowCount ?? 0, lastInsertRowid: 0 }; },
      async get(...a) { return (await setup.query(translateQuery(sql), a)).rows[0]; },
      async all(...a) { return (await setup.query(translateQuery(sql), a)).rows; },
    }; },
    async exec(sql) { await setup.query(translateSchema(sql)); },
    async tx() { throw new Error("not here"); },
  };
  await applyLedgerSchema(db); await db.exec(MIRROR_STATE_DDL);
  // The grant store's own shape: grant_json is JSONB, the sealed key a column this tool never selects.
  await setup.query(`CREATE TABLE grants (tenant TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, grant_json JSONB NOT NULL, sealed_session_key TEXT, updated_at BIGINT NOT NULL)`);
  await setup.query("INSERT INTO grants VALUES ($1, 4663, $2, 'SEALED-NEVER-READ', 1)", [TENANT,
    JSON.stringify({ smartAccount: ACCOUNT, owner: TENANT, chainId: 4663, grantFeatures: ["tradeable-v2"], serialized: "never-read" })]);
  await setup.query(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
    VALUES ($1, $2, $3, 4663, '{}', 1, 9999999999, 'armed', 2, 50, 'live')`, [ACCOUNT, TENANT, `0x${"01".repeat(20)}`]);
  await setup.query(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, at, epoch, chain_id)
    VALUES ($1, 'in', 50, $2, 1, 1, 'chain-log', $3, 2, 4663)`, [ACCOUNT, h32("first"), AT - 10 * 86_400]);
  for (const table of ["trades", "flows", "equity"]) {
    await setup.query("INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES ($1, $2, 1, 1, $3)", [TENANT, table, AT - 3600]);
  }
  // The lost book's last mirror, taken after the buy: the position and the basis the attested book would be seeded from already hold it.
  await setup.query(`INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, price_source, value_usdg, updated_at)
    VALUES ($1, 'COIN', $2, '1500000000000000000', '1', 2, 0, 'pool', 3, $3)`, [ACCOUNT, COIN, AT + 30]);
  await setup.query("INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at) VALUES ($1, 'live', 'COIN', '1500000000000000000', '3000000', $2)", [ACCOUNT, AT + 30]);
  // What holds it, in the resume tables as the orchestrator creates them on Postgres: admission's chain refusal, a day after both facts landed.
  await ensureLedgerResumeSchema(db);
  await setup.query(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run, state, reason,
      created_at_ms, updated_at_ms) VALUES ('a1', $1, $2, 4663, $1, $3, '{}', 'r', 'refused', $4, $5, $5)`,
  [TENANT, ACCOUNT, "e".repeat(64), `${CHAIN_REFUSAL}: operation ${OP} in tx ${OP_TX} at block ${BLOCK}`, (AT + 86_400) * 1000]);

  // THE SERVER HOLDS THE READ-ONLY CONNECTION TO IT, whatever the shell lets through.
  const ro = await connectBooking(scoped.toString(), true, loadPg); clients.push(ro);
  await assert.rejects(ro.query("INSERT INTO events (agent_id, message) VALUES ('x', 'y')"), /read-only transaction/);

  const printed: string[] = [];
  const deps = { connect: (u: string, r: boolean) => connectBooking(u, r, loadPg), rpc, nowMs: () => NOW * 1000, out: (l: string) => printed.push(l),
    source: { test: "pg" }, sleep: async () => {} };
  const env = { DATABASE_URL: scoped.toString() };
  const previewFile = path.join(tmp, "preview.json");
  assert.equal(await main(["--tenant", TENANT, "--output", previewFile], env, deps), 0, printed.join("\n"));
  const plan = JSON.parse(readFileSync(previewFile, "utf8")) as { verdict: string; previewDigest: string; items: Array<{ key: string; class: string; proposal: { row: Record<string, unknown> } | null }> };
  assert.deepEqual(plan.items.map((i) => [i.key, i.class]), [[`log:${OP_TX}#2`, "operation-leg"], [`op:${OP}`, "session-trade"], [`log:${DEP_TX}#0`, "deposit"]]);
  assert.equal(plan.verdict, "ready");
  assert.equal(Number((await setup.query("SELECT COUNT(*) AS n FROM trades")).rows[0]!.n), 0, "the preview wrote nothing");

  const applied = path.join(tmp, "apply.json");
  assert.equal(await main(["--tenant", TENANT, "--apply", "--confirm", plan.previewDigest, "--backup-ref", "pg-local-drill", "--output", applied], env, deps), 0, printed.join("\n"));
  const trade = (await setup.query("SELECT * FROM trades WHERE user_op_hash = $1", [OP])).rows[0]!;
  assert.deepEqual([trade.fill_side, trade.sell_token, trade.buy_token, Number(trade.amount_usdg), trade.fill_qty_raw, Number(trade.fill_price_usd), trade.sponsored_gas_wei,
    trade.gas_units, Number(trade.created_at), trade.status, Number(trade.epoch)],
  ["buy", USDG, COIN, 3, "1500000000000000000", 2, "123456", "70000", AT, "landed", 2]);
  const flow = (await setup.query("SELECT * FROM flows WHERE tx_hash = $1", [DEP_TX])).rows[0]!;
  assert.deepEqual([flow.direction, Number(flow.amount_usdg), Number(flow.log_index), flow.source, Number(flow.chain_id), Number(flow.at)], ["in", 20, 0, "chain-log", 4663, AT + 5]);
  const k = await knownChainFacts(db, ACCOUNT);
  assert.ok(k.ops.has(OP) && k.txs.has(OP_TX) && k.flows.has(`${DEP_TX}:0`), "what admission's chain check reads now answers every fact");
  // The receipts' key: a second applied booking of the same evidence is refused by the server.
  await assert.rejects(setup.query(`INSERT INTO ${BOOKINGS_TABLE} (booking_id, tenant, account, epoch, chain_id, evidence_key, table_name, row_id, row_json, row_digest,
    preview_digest, backup_ref, admission_json, state, applied_at_ms) VALUES ('other', $1, $2, 2, 4663, $3, 'trades', 1, '{}', 'd', 'p', 'b', '{}', 'applied', 1)`,
  [TENANT, ACCOUNT, `op:${OP}`]), /duplicate key/);
  // Each receipt keeps where the tenant stood with admission — read on Postgres, inside the apply's transaction — and the report says the same.
  const report = JSON.parse(readFileSync(applied, "utf8")) as { appliedAtMs: number; admission: { approvals: Array<{ approvalId: string; chainRefusal: boolean }> } };
  const kept = (await setup.query(`SELECT DISTINCT admission_json, applied_at_ms FROM ${BOOKINGS_TABLE}`)).rows;
  assert.equal(kept.length, 1);
  assert.deepEqual(JSON.parse(String(kept[0]!.admission_json)), report.admission);
  assert.equal(Number(kept[0]!.applied_at_ms), report.appliedAtMs);
  assert.deepEqual(report.admission.approvals.map((a) => [a.approvalId, a.chainRefusal]), [["a1", true]]);
  // Applied once: a second apply finds nothing missing.
  await assert.rejects(main(["--tenant", TENANT, "--apply", "--confirm", plan.previewDigest, "--backup-ref", "pg-local-drill", "--output", path.join(tmp, "again.json")], env, deps),
    (e: unknown) => e instanceof BookingRefused && e.code === "nothing-missing");

  assert.equal(await main(["--revert", applied, "--output", path.join(tmp, "revert.json")], env, deps), 0);
  assert.equal(Number((await setup.query("SELECT COUNT(*) AS n FROM trades WHERE user_op_hash = $1", [OP])).rows[0]!.n), 0);
  assert.equal(Number((await setup.query("SELECT COUNT(*) AS n FROM flows WHERE tx_hash = $1", [DEP_TX])).rows[0]!.n), 0);
  assert.deepEqual((await setup.query(`SELECT state FROM ${BOOKINGS_TABLE} ORDER BY evidence_key`)).rows.map((r) => r.state), ["reverted", "reverted"]);

  // THE CONTENTS, NEVER THE TIMES ALONE, read on Postgres: a round trip in COIN that the executor recorded before the buy (read back as
  // the fill walk's rows), and a basis rewritten after the buy that still covers only part of what the chain holds. The preview refuses.
  for (const [tag, side, at] of [["an earlier buy", "buy", AT - 200], ["its sell", "sell", AT - 100]] as const) {
    await setup.query(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, created_at, epoch,
        fill_side, fill_qty_raw, fill_symbol, basis_source) VALUES ($1, 'swap', $2, $3, $4, 1, $5, $6, 'landed', $7, 2, $8, '500000000000000000', 'COIN', 'receipt')`,
    [ACCOUNT, POOL, side === "buy" ? USDG : COIN, side === "buy" ? COIN : USDG, h32(tag), h32(`${tag} tx`), at, side]);
  }
  await setup.query("UPDATE cost_basis SET qty_raw = '1000000000000000000', updated_at = $1", [AT + 60]);
  const refusedFile = path.join(tmp, "refused.json");
  assert.equal(await main(["--tenant", TENANT, "--output", refusedFile], env, deps), 2, printed.join("\n"));
  const refused = JSON.parse(readFileSync(refusedFile, "utf8")) as { verdict: string; items: Array<{ key: string; class: string; why: string;
    evidence: { holding?: { refusal: string; fills: { verdict: string; anchor: string } } } }> };
  const buy = refused.items.find((i) => i.key === `op:${OP}`)!;
  assert.deepEqual([refused.verdict, buy.class, buy.evidence.holding?.refusal], ["blocked", "unresolved", "basis-differs"]);
  assert.match(buy.why, /covers 1000000000000000000 base units, and the book held 1500000000000000000 on chain at the pinned block/);
  const sellId = Number((await setup.query("SELECT id FROM trades WHERE user_op_hash = $1", [h32("its sell")])).rows[0]!.id);
  assert.deepEqual([buy.evidence.holding?.fills.verdict, buy.evidence.holding?.fills.anchor], ["reproduced", `after trades#${sellId}`], "flat after the round trip");
  assert.ok(printed.every((l) => !l.includes(scoped.toString())), "the URL is never printed");
});
