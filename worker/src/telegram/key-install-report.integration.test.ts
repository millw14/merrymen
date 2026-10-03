import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

const taskHome = mkdtempSync(path.join(os.tmpdir(), "merrymen-install-report-"));
process.env.MERRYMEN_HOME = taskHome;
process.env.MERRYMEN_HOSTED = "1";
const { initStore, closeStoreForTest } = await import("../store");
const { homePaths } = await import("../home");
const { readReport, readBrag, readPnl } = await import("./reads");
const { KEY_INSTALL_KIND } = await import("./trade-rows");
const { toolByName } = await import("./chat-tools");

const OWNER = "0x0000000000000000000000000000000000000111";
const OTHER = "0x0000000000000000000000000000000000000222";
const NOW_MS = Date.parse("2026-10-03T12:00:00Z");
const NOW = NOW_MS / 1000;
const ctx = { agentId: OWNER, name: "test", strategy: "trencher", venue: "uniswap", paused: false,
  workerAliveSec: 0, grant: null, chainId: 4663, telegramMaxActionUsdg: 25 };

before(async () => { await initStore(); });
after(() => {
  closeStoreForTest();
  rmSync(taskHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function fixture() {
  const db = new DatabaseSync(homePaths.db());
  db.exec("DELETE FROM trades; DELETE FROM equity; DELETE FROM flows; DELETE FROM agents;");
  db.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, epoch) VALUES (?, 'owner', 'key', 4663, '{}', 0, 9999999999, 2)").run(OWNER);
  db.prepare("INSERT INTO flows (agent_id, direction, amount_usdg, source, at, epoch) VALUES (?, 'in', 100, 'chain-log', ?, 2)").run(OWNER, NOW - 120);
  for (const at of [NOW - 60, NOW]) {
    db.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 100, 0, 0, 100, ?, 2, 'live')").run(OWNER, at);
  }
  const row = (owner: string, kind: string, status: string, amount = 0, hash: string | null = null) => {
    db.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, epoch, user_op_hash) VALUES (?, ?, '0xrouter', ?, ?, ?, 2, ?)")
      .run(owner, kind, amount, status, NOW, hash);
  };
  return { db, row };
}

test("private and public daily trade totals omit key installs and retain only this owner's real trades", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW_MS });
  const { db, row } = fixture();
  try {
    row(OWNER, "swap", "landed", 4.25, "0xaaaa");
    row(OWNER, "swap", "landed", 4.25, "0xAAAA"); // restored copy of the same operation
    row(OWNER, "swap", "rejected", 5);
    row(OWNER, KEY_INSTALL_KIND, "landed", 0, "0xbbbb");
    row(OWNER, "swap", "landed", 0, "0xBBBB"); // a bare copy must not resurrect an install as a trade
    row(OWNER, KEY_INSTALL_KIND, "rejected");
    row(OWNER, KEY_INSTALL_KIND, "submitted");
    for (let i = 0; i < 3; i++) row(OTHER, "swap", "landed", 99);
  } finally { db.close(); }
  for (const publicSafe of [false, true]) {
    assert.match(readReport(ctx, publicSafe), /arrows today: 1 landed · 1 turned back by the wall/);
  }
});

test("an install-only ledger has no trade arrows or best shot; a subsequent real trade appears", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW_MS });
  const { db, row } = fixture();
  try {
    row(OWNER, KEY_INSTALL_KIND, "landed", 0, "0xcccc");
    row(OWNER, "swap", "landed", 0, "0xCCCC");
    assert.match(readReport(ctx), /arrows today: 0 landed · 0 turned back by the wall/);
    const brag = readBrag(ctx);
    assert.match(brag, /my merryman's scorecard/, "exercise the full report rather than an unavailable fallback");
    assert.doesNotMatch(brag, /best shot|key-install/);
    row(OWNER, "swap", "landed", 4.25);
    assert.match(readReport(ctx), /arrows today: 1 landed · 0 turned back by the wall/);
    assert.match(readBrag(ctx), /best shot: swap 4\.25 USDG/);
  } finally { db.close(); }
});

test("P&L includes proved reverted install gas and discloses an unavailable price, without charging sponsor gas", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW_MS });
  const { db } = fixture();
  try {
    const gas = (owner: string, epoch: number, status: string, wei: string | null, price: number | null, sponsor: string | null = null) => {
      db.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, epoch, gas_wei, gas_usdg, sponsored_gas_wei) VALUES (?, ?, '0xrouter', 0, ?, ?, ?, ?, ?, ?)")
        .run(owner, KEY_INSTALL_KIND, status, NOW, epoch, wei, price, sponsor);
    };
    gas(OWNER, 2, "reverted", "1000000000000000", 0.25);
    gas(OWNER, 2, "reverted", "2000000000000000", null);
    gas(OWNER, 2, "reverted", null, null, "3000000000000000");
    gas(OWNER, 2, "submitted", "4000000000000000", 5);
    gas(OWNER, 1, "reverted", "5000000000000000", 7);
    gas(OTHER, 2, "reverted", "6000000000000000", 9);
    const pnl = readPnl(OWNER);
    assert.match(pnl, /change: −\$0\.25/, "only the current owner's proved, settled USDG cost changes the return");
    assert.match(pnl, /1 trade\(s\) had unpriceable gas/, "an unavailable historical price cannot become free gas");
    const breakdown = await toolByName("pnl_breakdown")!.run({ period: "all" }, {
      status: ctx, cfg: { sponsorGasEnabled: true }, paused: false, grant: null, book: [OWNER], client: null, now: NOW,
    } as never);
    assert.match(breakdown, /Network fees paid: about \$0\.25/);
    assert.match(breakdown, /1 settled operation\(s\) paid gas that could not be priced/);
    assert.match(breakdown, /sponsor covered network fees for 1 settled operation/);
    assert.doesNotMatch(breakdown, /Network fees are covered/, "configured sponsorship cannot replace recorded payer evidence");
  } finally { db.close(); }
});
