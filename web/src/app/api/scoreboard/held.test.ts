import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

/**
 * THE SCOREBOARD'S P&L IS NOT MADE OF A HELD MARK.
 *
 * A row written while flow inference was held (store.ts `flows_held`) can
 * carry a top-up or a withdrawal the flows table has not booked yet. The board
 * subtracted every flow on record from the newest row, so for the length of a
 * hold — up to 26 hours for a dropped op — an owner's own cash was published
 * as the agent's profit. Driven through the real GET, self-hosted, against a
 * ledger built by the worker's own schema.
 */
const ACCOUNT = "0xa6e17a1b2c3d4e5f60718293a4b5c6d7e8f90123";
const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED, database: process.env.DATABASE_URL };
let dir: string;
let GET: (req: Request) => Promise<Response>;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mm-scoreboard-held-"));
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
    const flow = db.prepare("INSERT INTO flows (agent_id, epoch, direction, amount_usdg, tx_hash, source, at) VALUES (?, 2, ?, ?, ?, ?, ?)");
    const mark = db.prepare(
      "INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode, flows_held) VALUES (?, '0', ?, 0, 0, ?, ?, 2, 'live', ?)",
    );
    await flow.run(ACCOUNT, "in", 100, "0xa1", "chain-log", 1_000);
    await mark.run(ACCOUNT, 100, 100, 1_060, 0);
    // The hold: the owner's transfer of 10 lands and is booked, and a 50 USDG
    // top-up arrives that only the look closing the hold can book.
    await flow.run(ACCOUNT, "out", 10, "0xa2", "transfer-intent", 1_200);
    await mark.run(ACCOUNT, 140, 140, 1_260, 1);
    await mark.run(ACCOUNT, 140, 140, 1_320, 1);
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

it("P&L is the newest measured mark less the flows booked by it; the chart still ends on the held mark", async () => {
  const body = (await (await GET(new Request("http://localhost/api/scoreboard"))).json()) as {
    agents: { pnl_usdg: number | null; equity: { equity_usdg: number }[]; max_drawdown_bps: number | null }[];
  };
  const [a] = body.agents;
  assert.ok(a);
  // 140 − 90 = +50 was the owner's own top-up and transfer, called profit.
  assert.equal(a.pnl_usdg, 0);
  // The equity chart is the value the book had, held or not: a late booking
  // cannot move a raw series, so it keeps the held marks and its newest one.
  assert.deepEqual(a.equity.map((p) => p.equity_usdg), [100, 140, 140]);
  assert.equal(a.max_drawdown_bps, 0);
});
