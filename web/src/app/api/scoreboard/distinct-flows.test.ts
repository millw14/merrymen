import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

/**
 * THE SCOREBOARD COUNTS EACH CAPITAL FLOW AND EACH OPERATION'S GAS ONCE.
 *
 * Its P&L summed raw flow rows and raw landed trade rows. So an opening carry
 * the mirror copied twice, or a deposit on record with and without its chain
 * stamp, was capital twice; a re-recorded copy of a paid op was gas twice; and
 * a reverted op, which burns gas too, was never charged. Rows that contradict
 * each other now leave the P&L null instead of one of them, and say why.
 * Driven through the real GET, self-hosted, against a ledger built by the
 * worker's own schema.
 */
const ACCOUNT = "0xa6e17a1b2c3d4e5f60718293a4b5c6d7e8f90123";
const CASED = "0xA6E17A1B2C3D4E5F60718293A4B5C6D7E8F90123";
const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED, database: process.env.DATABASE_URL };
let dir: string;
let GET: (req: Request) => Promise<Response>;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mm-scoreboard-flows-"));
  process.env.MERRYMEN_HOME = dir;
  delete process.env.MERRYMEN_HOSTED;
  delete process.env.DATABASE_URL;
  ({ GET } = await import("./route"));
  const { wrapSqlite } = await import("../../../../../worker/src/db");
  const { applyLedgerSchema } = await import("../../../../../worker/src/store");
  const raw = new DatabaseSync(path.join(dir, "merrymen.db"));
  try {
    const db = wrapSqlite(raw);
    await applyLedgerSchema(db);
    await db.prepare(
      `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode, epoch)
       VALUES (?, 'Shogun', '0x1', '0x2', 4663, '{}', 0, 0, 'live', 2)`,
    ).run(ACCOUNT);
    const flow = db.prepare(`INSERT INTO flows (agent_id, epoch, direction, amount_usdg, tx_hash, log_index, chain_id, source, at)
      VALUES (?, 2, 'in', ?, ?, ?, ?, ?, ?)`);
    // The opening carry, and the mirror's exact re-copy of it.
    await flow.run(ACCOUNT, 100, null, null, null, "epoch-carry", 1_000);
    await flow.run(ACCOUNT, 100, null, null, null, "epoch-carry", 1_000);
    // A top-up from its log, on record again with no chain stamp.
    await flow.run(ACCOUNT, 50, "0xtopup", 0, 4663, "chain-log", 1_100);
    await flow.run(ACCOUNT, 50, "0xtopup", 0, null, "chain-log", 1_150);
    const trade = db.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, gas_wei, gas_usdg, created_at, epoch)
      VALUES (?, 'swap', 'x', 5, ?, ?, ?, ?, ?, 2)`);
    await trade.run(ACCOUNT, "0xOP1", "landed", "200", 0.2, 1_050);
    // A redeploy's copy of the same paid op, under another spelling.
    await trade.run(CASED, "0xop1", "landed", "200", 0.2, 1_160);
    // A revert burns gas: one priced, one not.
    await trade.run(ACCOUNT, "0xop2", "reverted", "100", 0.1, 1_070);
    await trade.run(ACCOUNT, "0xop3", "reverted", "300", null, 1_080);
    await db.prepare(
      "INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode, flows_held) VALUES (?, '0', 160, 0, 0, 160, 1200, 2, 'live', 0)",
    ).run(ACCOUNT);
  } finally {
    raw.close();
  }
});

after(async () => {
  for (const [k, v] of [["MERRYMEN_HOME", saved.home], ["MERRYMEN_HOSTED", saved.hosted], ["DATABASE_URL", saved.database]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(dir, { recursive: true, force: true });
});

type Board = { agents: { pnl_usdg: number | null; contributions_withheld: string | null; gas_usdg: number; gas_unpriced_trades: number }[] };
const board = async () => (await (await GET(new Request("http://localhost/api/scoreboard"))).json()) as Board;

it("capital is counted once per movement", async () => {
  const [a] = (await board()).agents;
  assert.ok(a);
  // 160 − 150 of capital − 0.3 of gas. Summed raw, the capital was 300.
  assert.ok(Math.abs(a.pnl_usdg! - 9.7) < 1e-9, `pnl ${a.pnl_usdg}`);
  assert.equal(a.contributions_withheld, null);
});

it("gas is charged once per operation, reverts included — a deliberate correction", async () => {
  const [a] = (await board()).agents;
  assert.ok(a);
  // Summed raw, this was the landed row alone: 0.2, and no unpriced count.
  assert.ok(Math.abs(a.gas_usdg - 0.3) < 1e-12, `the copy is not charged twice and the revert is charged: ${a.gas_usdg}`);
  assert.equal(a.gas_unpriced_trades, 1, "the unpriced revert is counted, once");
});

it("a transfer booked as both our intent and its chain log leaves the P&L unpublished, never summed", async () => {
  const raw = new DatabaseSync(path.join(dir, "merrymen.db"));
  try {
    const flow = raw.prepare(`INSERT INTO flows (agent_id, epoch, direction, amount_usdg, tx_hash, log_index, chain_id, source, at)
      VALUES (?, 2, 'out', 10, '0xhome', ?, 4663, ?, ?)`);
    flow.run(ACCOUNT, null, "transfer-intent", 1_110);
    flow.run(ACCOUNT, 2, "chain-log", 1_120);
  } finally {
    raw.close();
  }
  const [a] = (await board()).agents;
  assert.equal(a!.pnl_usdg, null);
  assert.equal(a!.contributions_withheld, "review");
});

it("records that contradict each other are withheld as unread", async () => {
  const raw = new DatabaseSync(path.join(dir, "merrymen.db"));
  try {
    raw.prepare(`INSERT INTO flows (agent_id, epoch, direction, amount_usdg, source, at) VALUES (?, 2, 'in', 90, 'epoch-carry', 1000)`)
      .run(ACCOUNT);
  } finally {
    raw.close();
  }
  const [a] = (await board()).agents;
  assert.equal(a!.pnl_usdg, null);
  assert.equal(a!.contributions_withheld, "unread");
});
