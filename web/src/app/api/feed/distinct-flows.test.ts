import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

/**
 * THE OWNER'S DESK COUNTS EACH CAPITAL FLOW ONCE.
 *
 * /api/feed summed raw flow rows, so the /you page's return divided by an
 * opening carry the mirror copied twice. Rows that contradict each other now
 * leave the contributions null — no return — instead of one of them. Driven
 * through the real GET, self-hosted, against the worker's schema.
 */
const ACCOUNT = "0xa6e17a1b2c3d4e5f60718293a4b5c6d7e8f90123";
const CASED = "0xA6E17A1B2C3D4E5F60718293A4B5C6D7E8F90123";
const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED, database: process.env.DATABASE_URL };
let dir: string;
let GET: (req: Request) => Promise<Response>;
const now = Math.floor(Date.now() / 1000);

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mm-feed-flows-"));
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
      `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode, epoch, contributions_known)
       VALUES (?, 'Shogun', '0x1', '0x2', 4663, '{}', 0, 0, 'live', 2, 1)`,
    ).run(ACCOUNT);
    const flow = db.prepare(`INSERT INTO flows (agent_id, epoch, direction, amount_usdg, tx_hash, log_index, chain_id, source, at)
      VALUES (?, 2, 'in', ?, ?, ?, ?, ?, ?)`);
    // The opening carry, and the mirror's exact re-copy of it.
    await flow.run(ACCOUNT, 100, null, null, null, "epoch-carry", now - 4_000);
    await flow.run(ACCOUNT, 100, null, null, null, "epoch-carry", now - 4_000);
    // A top-up from its log before the measured mark, on record again with no
    // chain stamp AFTER it: the movement is in the mark once, at its first booking.
    await flow.run(ACCOUNT, 50, "0xtopup", 0, 4663, "chain-log", now - 3_500);
    await flow.run(ACCOUNT, 50, "0xtopup", 0, null, "chain-log", now - 1_000);
    const trade = db.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, gas_wei, gas_usdg, created_at, epoch)
      VALUES (?, 'swap', 'x', 5, ?, ?, ?, ?, ?, 2)`);
    await trade.run(ACCOUNT, "0xOP1", "landed", "200", 0.2, now - 3_900);
    // A redeploy's copy of the same paid op, under another spelling.
    await trade.run(CASED, "0xop1", "landed", "200", 0.2, now - 900);
    // A revert burns gas: one priced, one not.
    await trade.run(ACCOUNT, "0xop2", "reverted", "100", 0.1, now - 3_800);
    await trade.run(ACCOUNT, "0xop3", "reverted", "300", null, now - 3_700);
    await db.prepare(
      "INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode, flows_held) VALUES (?, '0', 160, 0, 0, 160, ?, 2, 'live', 0)",
    ).run(ACCOUNT, now - 3_000);
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

const feed = async () => (await (await GET(new Request("http://localhost/api/feed"))).json()) as Record<string, any>;

it("contributions are counted once per movement", async () => {
  const f = await feed();
  assert.equal(f.netContributionsUsdg, 150, "the carry and the top-up, each once");
  assert.equal(f.measured?.netContributionsUsdg, 150, "the late unstamped copy is the top-up already in the mark");
  assert.equal(f.measured?.equityUsdg, 160);
});

it("a transfer booked as both our intent and its chain log leaves the contributions null, never summed", async () => {
  const raw = new DatabaseSync(path.join(dir, "merrymen.db"));
  try {
    const flow = raw.prepare(`INSERT INTO flows (agent_id, epoch, direction, amount_usdg, tx_hash, log_index, chain_id, source, at)
      VALUES (?, 2, 'out', 10, '0xhome', ?, 4663, ?, ?)`);
    flow.run(ACCOUNT, null, "transfer-intent", now - 3_400);
    flow.run(ACCOUNT, 2, "chain-log", now - 3_300);
  } finally {
    raw.close();
  }
  const f = await feed();
  assert.equal(f.netContributionsUsdg, null);
  assert.equal(f.measured, null, "no return is measured over withheld contributions");
  assert.deepEqual(f.equity.map((p: { equity_usdg: number }) => p.equity_usdg), [160], "the book's value is still shown");
});
