import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { applyLedgerSchema } from "../../../worker/src/store";
import { profileOf } from "./read-agent";
import { readLeaderboard } from "./read-leaderboard";
import type { PublicIdentity } from "@merrymen/identity-store";

const ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ALIAS = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const REGRANT = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TENANT = "0xcccccccccccccccccccccccccccccccccccccccc";
const NOW = 2_000_000_000;

async function registration(db: Db, account: string, name: string, epoch: number, beat: number,
  created: number, mode: string, quality: number) {
  await db.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps,
    granted_at, expires_at, status, mode, epoch, beat_at, contributions_known, created_at, x_handle, x_verified)
    VALUES (?, ?, ?, 'PRIVATE-KEY', 4663, 'PRIVATE-CAPS', 0, ?, 'armed', ?, ?, ?, ?, ?, ?, ?)`)
    .run(account, name, TENANT, NOW + 86_400, mode, epoch, beat, quality, created,
      name === "Current desk" ? "current_desk" : "stale_desk", name === "Current desk" ? 1 : 0);
}

async function mark(db: Db, account: string, epoch: number, equity: number, mode: string, at: number) {
  await db.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg,
    equity_usdg, epoch, mode, at) VALUES (?, 'PRIVATE-ETH', ?, 0, 0, ?, ?, ?, ?)`)
    .run(account, equity, equity, epoch, mode, at);
}

test("profile and board choose the current alias before reading its run and publication setting", async () => {
  // The epoch wins first; if aliases are already in the same epoch, the newer
  // heartbeat wins. A tied registration timestamp cannot choose stale metadata.
  for (const staleEpoch of [1, 2]) {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      await applyLedgerSchema(db);
      await registration(db, ALIAS, "Stale desk", staleEpoch, staleEpoch === 1 ? NOW : NOW - 100, 100, "live", 0);
      await registration(db, ACCOUNT, "Current desk", 2, NOW - 1, 100, "paper", 1);
      await mark(db, ALIAS, 1, 250, "live", NOW - 200);
      await mark(db, ACCOUNT, 2, 333, "paper", NOW - 60);
      await mark(db, ACCOUNT, 2, 332, "paper", NOW - 10);
      const identity: PublicIdentity = { tenant: TENANT, slug: "current-desk", accounts: [ALIAS], createdAt: 100, updatedAt: 100 };
      for (const publicBook of [false, true]) {
        const board = await readLeaderboard(fn => fn(db), async () => [identity], () => NOW,
          async tenant => {
            assert.equal(tenant, TENANT);
            return { publicBook };
          });
        const profile = await profileOf(db, identity, publicBook);
        assert.ok(profile);
        assert.equal(board.retired, 0);
        assert.equal(board.agents.length, 1);
        const row = board.agents[0]!;
        for (const result of [row, profile]) {
          assert.equal(result.name, "Current desk");
          assert.equal(result.mode, "paper");
          assert.equal(result.handle, "current_desk");
          assert.equal(result.handleVerified, true);
          assert.equal(result.unrankedWhy, "paper");
          assert.equal(result.performance?.book, "paper");
          assert.equal(result.performance?.equityUsdg, publicBook ? 332 : null);
          assert.equal(result.performance?.pnlUsdg, publicBook ? -1 : null);
          assert.equal(result.performance?.equityAt, NOW - 10);
          assert.ok(Math.abs(result.performance!.pnlBps! - (-10_000 / 333)) < 1e-9);
          const serialized = JSON.stringify(result);
          for (const privateField of [ACCOUNT, ALIAS, TENANT, "PRIVATE-KEY", "PRIVATE-CAPS", "PRIVATE-ETH"]) {
            assert.ok(!serialized.includes(privateField), `public projection exposed ${privateField}`);
          }
        }
        assert.equal(profile.beatAt, NOW - 1);
        assert.equal(profile.contributionsEvidenced, true, "quality must come from the selected alias");
        assert.deepEqual(row.performance, profile.performance);
      }
    } finally { raw.close(); }
  }
});

test("a distinct account re-grant still wins by registration time after alias canonicalization", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await applyLedgerSchema(db);
    await registration(db, ALIAS, "Stale desk", 9, NOW, 100, "live", 0);
    await registration(db, ACCOUNT, "Older account", 10, NOW, 100, "paper", 1);
    await registration(db, REGRANT, "Current desk", 1, NOW - 1, 200, "paper", 1);
    await mark(db, ACCOUNT, 10, 999, "paper", NOW - 5);
    await mark(db, REGRANT, 1, 500, "paper", NOW - 20);
    await mark(db, REGRANT, 1, 501, "paper", NOW - 10);
    const identity: PublicIdentity = { tenant: TENANT, slug: "current-desk", accounts: [ALIAS, REGRANT], createdAt: 100, updatedAt: 200 };
    const board = await readLeaderboard(fn => fn(db), async () => [identity], () => NOW, async () => ({ publicBook: true }));
    const profile = await profileOf(db, identity, true);
    assert.ok(profile);
    assert.equal(board.agents.length, 1);
    assert.equal(board.retired, 0);
    assert.equal(board.agents[0]!.name, "Current desk");
    assert.equal(profile.name, "Current desk");
    assert.equal(profile.performance?.equityUsdg, 501);
    assert.equal(profile.performance?.pnlUsdg, 1);
    assert.deepEqual(board.agents[0]!.performance, profile.performance);
  } finally { raw.close(); }
});

test("profile history and operation counts agree with consolidated performance across address spellings", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await applyLedgerSchema(db);
    await registration(db, ACCOUNT, "Current desk", 2, NOW, 100, "live", 1);
    await registration(db, ALIAS, "Stale desk", 1, NOW - 100, 50, "paper", 0);
    await mark(db, ALIAS, 2, 100, "live", NOW - 7200);
    await mark(db, ACCOUNT, 2, 132, "live", NOW);
    const flow = db.prepare(`INSERT INTO flows
      (agent_id, epoch, direction, amount_usdg, tx_hash, log_index, chain_id, source, at)
      VALUES (?, ?, 'in', ?, ?, ?, ?, 'chain-log', ?)`);
    await flow.run(ALIAS, 2, 100, "0xDEPOSIT", 0, 4663, NOW - 7300);
    await flow.run(ACCOUNT, 2, 100, "0xdeposit", 0, 4663, NOW - 10);
    await flow.run(ALIAS, 2, 10, "0xDEPOSIT", 1, 4663, NOW - 1800);
    await flow.run(ACCOUNT, 2, 10, "0xdeposit", 0, 1, NOW - 1700);
    await flow.run(ALIAS, 1, 5000, "0xold", 0, 4663, NOW - 8000);
    await flow.run(REGRANT, 2, 5000, "0xother", 0, 4663, NOW - 7000);
    const cash = "0x00000000000000000000000000000000000000c0";
    const coin = "0xdddddddddddddddddddddddddddddddddddddddd";
    const fill = db.prepare(`INSERT INTO trades
      (agent_id, epoch, kind, target, sell_token, buy_token, amount_usdg, user_op_hash,
       status, fill_side, fill_symbol, fill_qty_raw, fill_cash_usdg, realized_pnl_usdg,
       basis_source, gas_wei, gas_usdg, sponsored_gas_wei, created_at)
      VALUES (?, ?, 'swap', 'PRIVATE-TARGET', ?, ?, 10, ?, 'landed', ?, 'CASH',
       '1000000000000000000', ?, ?, 'receipt', ?, ?, ?, ?)`);
    await fill.run(ALIAS, 2, cash, coin, "0xBUY", "buy", 10, null, "100", 0.25, null, NOW - 600);
    await fill.run(ACCOUNT, 2, cash, coin, "0xbuy", "buy", 10, null, "100", 0.25, null, NOW - 500);
    await fill.run(ACCOUNT, 2, coin, cash, "0xsell", "sell", 11, 1, null, null, "100", NOW - 60);
    await fill.run(REGRANT, 2, cash, coin, "0xBUY", "buy", 10, null, null, null, "100", NOW - 1);
    await fill.run(ALIAS, 1, cash, coin, "0xOLD", "buy", 10, null, null, null, "100", NOW - 9000);
    await fill.run(ALIAS, 1, coin, cash, "0xOLDCLOSE", "sell", 10, 0, null, null, "100", NOW - 8500);
    await db.prepare(`INSERT INTO decisions (id, agent_id, source, provider, model, at)
      VALUES ('alias-decision', ?, 'strategist', 'anthropic', 'model-v1', ?)`)
      .run(ALIAS, NOW - 100);
    // Snapshot tables retain the selected registration's own coherent copy.
    // A stale alias holding must not be resurrected when history is combined.
    const position = db.prepare(`INSERT INTO positions
      (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, value_usdg, updated_at)
      VALUES (?, ?, ?, '1000000000000000000', '1', 10, 10, ?)`);
    await position.run(ACCOUNT, "CASH", coin, NOW);
    await position.run(ALIAS, "SOLD", cash, NOW - 100);
    await db.prepare(`INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at)
      VALUES (?, 'live', 'CASH', '1000000000000000000', '10000000', ?)`)
      .run(ACCOUNT, NOW);
    const identity: PublicIdentity = { tenant: TENANT, slug: "current-desk", accounts: [ALIAS], createdAt: 100, updatedAt: 100 };
    for (const publicBook of [false, true]) {
      const board = await readLeaderboard(fn => fn(db), async () => [identity], () => NOW,
        async () => ({ publicBook }));
      const profile = await profileOf(db, identity, publicBook);
      assert.ok(profile);
      const row = board.agents[0]!;
      assert.equal(row.landed, 2, "both spellings form two operations, not three rows");
      assert.equal(profile.landed, 2);
      assert.equal(profile.tokensTouched, 1);
      assert.equal(profile.tradeCount, 2);
      assert.equal(profile.avgHoldSec, 540);
      assert.equal(profile.recentTrades.length, 2);
      assert.equal(profile.topTrades.length, 1);
      assert.equal(profile.topTrades[0]!.realizedPnlBps, 1000);
      assert.equal(profile.gas.usdg, publicBook ? 0.25 : null);
      assert.equal(profile.gasless, false);
      assert.equal(profile.flowsTotal, 3, "receipt copies collapse; distinct log and chain survive");
      assert.equal(profile.flowsWithTx, 3);
      assert.equal(profile.funded, true);
      assert.equal(profile.growth[0]!.at, NOW - 7200);
      assert.ok(Math.abs(profile.growth.at(-1)!.g - 1.12) < 1e-9,
        "20 in later deposits are removed from the 32 increase over the opening 100");
      assert.deepEqual(profile.how, { kind: "model", provider: "anthropic", model: "model-v1" });
      assert.deepEqual(row.performance, profile.performance);
      assert.equal(profile.performance!.equityUsdg, publicBook ? 132 : null);
      assert.equal(profile.performance!.pnlUsdg, publicBook ? 11.75 : null);
      assert.ok(Math.abs(profile.performance!.pnlBps! - (11.75 / 120 * 10_000)) < 1e-9);
      assert.deepEqual(profile.holdings.map(h => h.symbol), publicBook ? ["CASH"] : []);
      if (publicBook) assert.equal(profile.holdings[0]!.heldSince, NOW - 600);
      else {
        assert.ok(profile.recentTrades.every(t => t.realizedPnlUsdg === null));
        assert.ok(profile.topTrades.every(t => t.realizedPnlUsdg === null));
      }
    }
  } finally { raw.close(); }
});
