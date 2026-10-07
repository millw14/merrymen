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
import { applyBooking, BOOKINGS_TABLE, BookingRefused, readBookingSnapshot, type BookingPlan, type StaleBasis } from "./chain-gap-booking";
import { connectBooking, main, pgClientDb, type PgClient } from "./chain-gap-booking-cli";

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
/** A chain of these transactions, on which the account holds `held` of COIN (and no other address any). */
const chainOf = (txs: typeof TXS, held: bigint): RpcCall => async (method, params) => {
  const blockOf = (b: bigint) => ({ number: `0x${b.toString(16)}`, hash: h32(`block ${b}`), timestamp: `0x${(AT + Math.floor(Number(b - BLOCK) / 10)).toString(16)}` });
  const logsOf = (t: (typeof TXS)[number]) => t.logs.map(([address, topics, data, logIndex]) => ({ address, topics, data, logIndex, blockNumber: `0x${t.block.toString(16)}`, transactionHash: t.tx }));
  if (method === "eth_chainId") return "0x1237";
  if (method === "eth_blockNumber") return `0x${HEAD.toString(16)}`;
  if (method === "eth_getBlockByNumber") return blockOf(BigInt(params[0] as string));
  if (method === "eth_getLogs") {
    const f = params[0] as { address: string; fromBlock: string; toBlock: string; topics: Array<string | null> };
    return txs.filter((t) => t.block >= BigInt(f.fromBlock) && t.block <= BigInt(f.toBlock)).flatMap(logsOf)
      .filter((l) => l.address === f.address.toLowerCase() && f.topics.every((x, i) => x === null || x.toLowerCase() === l.topics[i]));
  }
  if (method === "eth_getTransactionReceipt") {
    const t = txs.find((x) => x.tx === params[0])!;
    return { status: "0x1", blockNumber: `0x${t.block.toString(16)}`, blockHash: blockOf(t.block).hash, from: `0x${"d0".repeat(20)}`, to: EP, logs: logsOf(t) };
  }
  if (method === "eth_call") {
    const data = (params[0] as { data: string }).data;
    return data.startsWith("0x70a08231") ? `0x${word(data.endsWith(ACCOUNT.slice(2)) ? held : 0n)}` : `0x${word(18n)}`;
  }
  throw new Error(method);
};
/** decimals() is 18; the account still holds what the buy brought it. */
const rpc = chainOf(TXS, 1_500_000_000_000_000_000n);

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
      created_at_ms, updated_at_ms, chain_read_from_sec) VALUES ('a1', $1, $2, 4663, $1, $3, '{}', 'r', 'refused', $4, $5, $5, $6)`,
  [TENANT, ACCOUNT, "e".repeat(64), `${CHAIN_REFUSAL}: operation ${OP} in tx ${OP_TX} at block ${BLOCK}`, (AT + 86_400) * 1000, AT - 4200]);

  // THE SERVER HOLDS THE READ-ONLY CONNECTION TO IT, whatever the shell lets through.
  const ro = await connectBooking(scoped.toString(), true, loadPg); clients.push(ro);
  await assert.rejects(ro.query("INSERT INTO events (agent_id, message) VALUES ('x', 'y')"), /read-only transaction/);

  const printed: string[] = [];
  const deps = { connect: (u: string, r: boolean) => connectBooking(u, r, loadPg), rpc, nowMs: () => NOW * 1000, out: (l: string) => printed.push(l),
    source: { test: "pg" }, sleep: async () => {} };
  const env = { DATABASE_URL: scoped.toString() };
  const previewFile = path.join(tmp, "preview.json");
  assert.equal(await main(["--tenant", TENANT, "--output", previewFile], env, deps), 0, printed.join("\n"));
  const plan = JSON.parse(readFileSync(previewFile, "utf8")) as { verdict: string; previewDigest: string; items: Array<{ key: string; class: string;
    proposal: { row: Record<string, unknown> } | null; evidence: { holding?: { cost: unknown } } }> };
  assert.deepEqual(plan.items.map((i) => [i.key, i.class]), [[`log:${OP_TX}#2`, "operation-leg"], [`op:${OP}`, "session-trade"], [`log:${DEP_TX}#0`, "deposit"]]);
  assert.equal(plan.verdict, "ready");
  // The buy, from flat, is the basis exactly: its quantity, and the 3 USDG it cost.
  assert.deepEqual(plan.items.find((i) => i.key === `op:${OP}`)!.evidence.holding?.cost,
    { verdict: "replayed", why: null, basis: { qtyRaw: "1500000000000000000", costUsdg: "3000000" } });
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
  for (const [tag, side, at, cash] of [["an earlier buy", "buy", AT - 200, 1.25], ["its sell", "sell", AT - 100, 1.5]] as const) {
    await setup.query(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, created_at, epoch,
        fill_side, fill_qty_raw, fill_cash_usdg, fill_symbol, basis_source)
        VALUES ($1, 'swap', $2, $3, $4, 1, $5, $6, 'landed', $7, 2, $8, '500000000000000000', $9, 'COIN', 'receipt')`,
    [ACCOUNT, POOL, side === "buy" ? USDG : COIN, side === "buy" ? COIN : USDG, h32(tag), h32(`${tag} tx`), at, side, cash]);
  }
  // fill_cash_usdg is DOUBLE PRECISION on Postgres, and reads back as the micro-USDG bookFill applied, exactly.
  assert.deepEqual((await readBookingSnapshot(db, { tenant: TENANT, dialect: "postgres", nowSec: NOW })).fills.map((f) => [f.side, f.qtyRaw, f.cashUsdg]),
    [["buy", "500000000000000000", "1250000"], ["sell", "500000000000000000", "1500000"]]);
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
  // The basis's quantity the chain's again, and its cost a micro-USDG short of what the buy cost from flat: refused on the cost.
  await setup.query("UPDATE cost_basis SET qty_raw = '1500000000000000000', cost_usdg = '2999999'");
  const costFile = path.join(tmp, "cost.json");
  assert.equal(await main(["--tenant", TENANT, "--output", costFile], env, deps), 2, printed.join("\n"));
  const costed = JSON.parse(readFileSync(costFile, "utf8")) as { items: Array<{ key: string; why: string; evidence: { holding?: { refusal: string } } }> };
  const again = costed.items.find((i) => i.key === `op:${OP}`)!;
  assert.equal(again.evidence.holding?.refusal, "basis-cost-differs");
  assert.match(again.why, /at a cost of 2\.999999 USDG, and the fills since it last opened .* give 1500000000000000000 at 3\.000000 USDG/);

  // THE WINDOW, FROM THE REFUSAL'S OWN START: the snapshot reads where the refused read began, inside its read-only transaction.
  const startFile = path.join(tmp, "start.json");
  assert.equal(await main(["--tenant", TENANT, "--output", startFile], env, deps), 2, printed.join("\n"));
  const fromRecorded = BigInt(String((JSON.parse(readFileSync(startFile, "utf8")) as { capture: { fromBlock: string } }).capture.fromBlock));
  // A TABLE FROM BEFORE THE COLUMN, read in that transaction: its absence is asked of the catalogue, never learnt from a statement that
  // fails (which would abort the snapshot, 25P02), and the refusal is read as one from before it — its start derived, and here, with no
  // cursors in its evidence to date it, the first block of all.
  await setup.query("ALTER TABLE ledger_resume_approvals DROP COLUMN chain_read_from_sec");
  const legacyFile = path.join(tmp, "legacy.json");
  assert.equal(await main(["--tenant", TENANT, "--output", legacyFile], env, deps), 2, printed.join("\n"));
  const legacy = JSON.parse(readFileSync(legacyFile, "utf8")) as { verdict: string; capture: { fromBlock: string }; refusals: string[] };
  assert.equal(legacy.verdict, "blocked");
  assert.deepEqual(legacy.refusals, [], "held as before: only the basis refuses");
  assert.equal(legacy.capture.fromBlock, "0", "read from the first block of all");
  assert.ok(fromRecorded > 0n, "where the recorded start had it read from a later block");
  await ensureLedgerResumeSchema(db);
  assert.ok(printed.every((l) => !l.includes(scoped.toString())), "the URL is never printed");
});

/**
 * A BASIS LEFT OVER A FLAT TOKEN, on Postgres (Shogun's TSLA, in shape): the
 * session buy above is the one Postgres lacks; it records the other buy with
 * no fill and one sell of both lots; the live basis still covers the other
 * lot, written after the sell; the chain holds none. What only Postgres shows:
 * admission's own seed (planAttestedSeed) asked inside the read-only
 * REPEATABLE READ snapshot through the shell's SELECT-only gate, each basis
 * row's spelling read back, and the apply's compare-and-set on the named basis.
 */
test("Postgres: a basis left over a flat token is named, not booked, and compared again by the apply", { skip: !url, timeout: 60_000 }, async (t) => {
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
  await setup.query(`CREATE TABLE grants (tenant TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, grant_json JSONB NOT NULL, sealed_session_key TEXT, updated_at BIGINT NOT NULL)`);
  await setup.query("INSERT INTO grants VALUES ($1, 4663, $2, 'SEALED-NEVER-READ', 1)", [TENANT,
    JSON.stringify({ smartAccount: ACCOUNT, owner: TENANT, chainId: 4663, grantFeatures: ["tradeable-v2"], serialized: "never-read" })]);
  await setup.query(`INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, epoch, hwm_usdg, mode)
    VALUES ($1, $2, $3, 4663, '{}', 1, 9999999999, 'armed', 1, 50, 'live')`, [ACCOUNT, TENANT, `0x${"01".repeat(20)}`]);
  await setup.query(`INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, at, epoch, chain_id)
    VALUES ($1, 'in', 50, $2, 1, 1, 'chain-log', $3, 1, 4663)`, [ACCOUNT, h32("first"), AT - 10 * 86_400]);
  for (const table of ["trades", "flows", "equity"]) {
    await setup.query("INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at) VALUES ($1, $2, 1, 1, $3)", [TENANT, table, AT - 3600]);
  }
  const LOT = "1500000000000000000";
  // The other buy, its legs and no fill; then one sell of both lots.
  await setup.query(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, created_at, epoch, basis_source)
    VALUES ($1, 'swap', $1, $2, $3, 3, $4, $5, 'landed', $6, 1, 'receipt')`, [ACCOUNT, USDG, COIN, h32("the other buy"), h32("the other buy tx"), AT + 600]);
  await setup.query(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, created_at, epoch,
      fill_side, fill_symbol, fill_qty_raw, fill_cash_usdg, basis_source) VALUES ($1, 'swap', $1, $2, $3, 6.5, $4, $5, 'landed', $6, 1, 'sell', 'COIN', $7, 6.5, 'receipt')`,
  [ACCOUNT, COIN, USDG, h32("the sell"), h32("the sell tx"), AT + 7200, "3000000000000000000"]);
  // The live basis still covering the other lot, written after that sell.
  await setup.query("INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at) VALUES ($1, 'live', 'COIN', $2, '3000000', $3)", [ACCOUNT, LOT, AT + 9000]);
  await ensureLedgerResumeSchema(db);
  await setup.query(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run, state, reason,
      created_at_ms, updated_at_ms, chain_read_from_sec) VALUES ('a1', $1, $2, 4663, $1, $3, '{}', 'r', 'refused', $4, $5, $5, $6)`,
  [TENANT, ACCOUNT, "e".repeat(64), `${CHAIN_REFUSAL}: operation ${OP} in tx ${OP_TX} at block ${BLOCK}`, (AT + 86_400) * 1000, AT - 4200]);

  const printed: string[] = [];
  const deps = { connect: (u: string, r: boolean) => connectBooking(u, r, loadPg), rpc: chainOf([TXS[0]!], 0n), nowMs: () => NOW * 1000, out: (l: string) => printed.push(l),
    source: { test: "pg" }, sleep: async () => {} };
  const env = { DATABASE_URL: scoped.toString() };
  const previewTo = async (file: string, code: number) => {
    assert.equal(await main(["--tenant", TENANT, "--output", path.join(tmp, file)], env, deps), code, printed.join("\n"));
    return JSON.parse(readFileSync(path.join(tmp, file), "utf8")) as BookingPlan;
  };
  const holdingIn = (p: BookingPlan) => p.items.find((i) => i.key === `op:${OP}`)!.evidence.holding as { refusal: string | null; staleBasis?: StaleBasis["evidence"] };
  const plan = await previewTo("preview.json", 0);
  assert.equal(plan.verdict, "ready");
  assert.deepEqual(plan.items.map((i) => [i.key, i.class]), [[`log:${OP_TX}#2`, "operation-leg"], [`op:${OP}`, "session-trade"]]);
  const stale = holdingIn(plan).staleBasis!;
  assert.deepEqual(stale.rows, [{ agentId: ACCOUNT, symbol: "COIN", qtyRaw: LOT, costUsdg: "3000000", updatedAt: AT + 9000 }]);
  assert.deepEqual([stale.seededUnderNames, stale.heldUnderNames, stale.deletedAs], [[], [], ACCOUNT]);
  assert.match(stale.note!, /It is not booked here and not changed\. It cannot reach the attested book/);
  assert.ok(printed.some((l) => l.startsWith(`  note: ${COIN}: Postgres's live cost basis under COIN`)), printed.join("\n"));

  // A HELD POSITION UNDER ITS NAME, another token's: admission's own seed, asked on Postgres, would carry the basis. Refused.
  await setup.query(`INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, price_source, value_usdg, updated_at)
    VALUES ($1, 'COIN', $2, '5', '1', 2, 0, 'pool', 3, $3)`, [ACCOUNT, `0x${"0b".repeat(20)}`, AT + 9000]);
  const held = await previewTo("held.json", 2);
  const refused = holdingIn(held);
  assert.deepEqual([held.verdict, refused.refusal, refused.staleBasis?.seededUnderNames], ["blocked", "basis-without-position", [{ symbol: "COIN", qtyRaw: LOT, costUsdg: "3000000" }]]);
  await setup.query("DELETE FROM positions");

  // THE BASIS MOVED SINCE THE REVIEW: the apply's own compare-and-set refuses the reviewed plan, and the shell's recomputed digest is not the reviewed one.
  await setup.query("UPDATE cost_basis SET cost_usdg = '3000001'");
  const writer = await connectBooking(scoped.toString(), false, loadPg); clients.push(writer);
  await assert.rejects(applyBooking(pgClientDb(writer, { readOnly: false }), plan, { confirm: plan.previewDigest, backupRef: "pg-local-drill", dialect: "postgres", nowMs: NOW * 1000 }),
    (e: unknown) => e instanceof BookingRefused && e.code === "cas" && /\(holdings\)/.test(e.message));
  await assert.rejects(main(["--tenant", TENANT, "--apply", "--confirm", plan.previewDigest, "--backup-ref", "pg-local-drill", "--output", path.join(tmp, "moved.json")], env, deps),
    (e: unknown) => e instanceof BookingRefused && e.code === "confirm-mismatch");
  assert.equal(Number((await setup.query("SELECT COUNT(*) AS n FROM trades WHERE user_op_hash = $1", [OP])).rows[0]!.n), 0, "nothing written");

  // As reviewed again, it applies: the trade, and the basis exactly as it was.
  await setup.query("UPDATE cost_basis SET cost_usdg = '3000000'");
  assert.equal(await main(["--tenant", TENANT, "--apply", "--confirm", plan.previewDigest, "--backup-ref", "pg-local-drill", "--output", path.join(tmp, "apply.json")], env, deps), 0,
    printed.join("\n"));
  const trade = (await setup.query("SELECT fill_side, fill_qty_raw, buy_token FROM trades WHERE user_op_hash = $1", [OP])).rows;
  assert.deepEqual(trade.map((r) => [r.fill_side, r.fill_qty_raw, r.buy_token]), [["buy", LOT, COIN]]);
  assert.deepEqual((await setup.query("SELECT agent_id, mode, symbol, qty_raw, cost_usdg, updated_at FROM cost_basis")).rows.map((r) => ({ ...r, updated_at: Number(r.updated_at) })),
    [{ agent_id: ACCOUNT, mode: "live", symbol: "COIN", qty_raw: LOT, cost_usdg: "3000000", updated_at: AT + 9000 }]);
});
