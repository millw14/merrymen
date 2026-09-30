import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { rankPnl } from "@/lib/rank-pnl";
import { pnlBasisOf } from "@/lib/feed-pnl";

/**
 * THE OWNER'S DESK SHOWS THE VALUE AS READ, AND MEASURES THE RETURN ON A
 * MEASURED MARK.
 *
 * A row written while flow inference was held (store.ts `flows_held`) is the
 * book's true value, so "equity now", the curve and the daily change keep it.
 * But the /you page's return subtracted the booked contributions from it, and
 * a held row can carry a top-up not booked yet — for up to 26 hours of a
 * dropped op, the owner's own deposit read as "+50% all time". Driven through
 * the real GET, self-hosted, against the worker's own schema.
 */
const ACCOUNT = "0xa6e17a1b2c3d4e5f60718293a4b5c6d7e8f90123";
const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED, database: process.env.DATABASE_URL };
let dir: string;
let GET: (req: Request) => Promise<Response>;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "mm-feed-held-"));
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
    const flow = db.prepare("INSERT INTO flows (agent_id, epoch, direction, amount_usdg, tx_hash, source, at) VALUES (?, 2, ?, ?, ?, ?, ?)");
    const mark = db.prepare(
      "INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode, flows_held) VALUES (?, '0', ?, 0, 0, ?, ?, 2, 'live', ?)",
    );
    const now = Math.floor(Date.now() / 1000);
    await flow.run(ACCOUNT, "in", 100, "0xa1", "chain-log", now - 4_000);
    await db.prepare(
      "INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, created_at, epoch) VALUES (?, 'swap', 'x', 5, '0xop1', '0xtx1', 'landed', ?, 2)",
    ).run(ACCOUNT, now - 3_900);
    await mark.run(ACCOUNT, 100, 100, now - 3_000, 0);
    // The hold: the owner's transfer of 10 lands and is booked, and a 50 USDG
    // top-up arrives that only the look closing the hold can book.
    await flow.run(ACCOUNT, "out", 10, "0xa2", "transfer-intent", now - 2_000);
    await mark.run(ACCOUNT, 140, 140, now - 1_000, 1);
    await mark.run(ACCOUNT, 140, 140, now - 60, 1);
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

it("the curve ends on the held mark; the return is measured on the newest measured mark over the flows booked by it", async () => {
  const feed = (await (await GET(new Request("http://localhost/api/feed"))).json()) as Record<string, any>;
  // "Equity now" is the value the book has: the held mark.
  assert.deepEqual(feed.equity.map((p: { equity_usdg: number }) => p.equity_usdg), [100, 140, 140]);
  assert.equal(feed.netContributionsUsdg, 90, "every booked flow, as before");
  assert.equal(feed.measured?.equityUsdg, 100);
  assert.equal(feed.measured?.netContributionsUsdg, 100, "only what was booked by the measured mark");
  // The /you page's return, through the shared gate: flat, not +55.6%.
  const basis = pnlBasisOf(feed);
  const rank = rankPnl({ ...basis, gasUsdg: feed.gasUsdg, landed: feed.landed, contributionsKnown: feed.contributionsKnown });
  assert.equal(rank.pnlBps, 0);
});
