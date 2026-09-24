/**
 * "How did I do this week" across a hosted redeploy.
 *
 * The ledger here is the one a redeploy leaves: it began after the orchestrator
 * read the shared ledger, and holds only readings since. The account's value
 * from before comes in the history file, already attributed (history-files.ts
 * HistoryAccount). The chat must join the two — and a deposit made while the
 * agent was down, which nobody booked, must be reported as unexplained, never
 * as trading profit.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-pnl-restart-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_HOSTED = "1";

const { closeStoreForTest, initStore } = await import("../store");
const { toolByName } = await import("./chat-tools");
const { DatabaseSync } = await import("node:sqlite");
const { homePaths } = await import("../home");
const { writeHistoryFile } = await import("../history-files");
type TradeHistory = import("../history-files").TradeHistory;

const SHOGUN = "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487";
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const RESTART = NOW - 3_600;

function ctx() {
  return {
    status: { agentId: SHOGUN, name: "Shogun", strategy: "trencher", venue: "uniswap", paused: false, workerAliveSec: 5, grant: null, chainId: 4663, telegramMaxActionUsdg: 25 },
    cfg: { customTokens: [], liveTradingEnabled: true, paperTradingEnabled: false, classSnipeEnabled: false, classPerEntryUsdg: 0, trencherLiveEnabled: true, sponsorGasEnabled: true },
    paused: false,
    grant: null,
    book: [SHOGUN],
    client: null,
    now: NOW,
  } as never;
}
const pnl = (period = "7d") => toolByName("pnl_breakdown")!.run({ period }, ctx());

function file(account: Partial<NonNullable<TradeHistory["account"]>> = {}): TradeHistory {
  return {
    schema: 1,
    agentId: SHOGUN,
    writtenAt: RESTART,
    since: NOW - 30 * DAY,
    decisionsFrom: RESTART,
    trades: [],
    decisions: [],
    account: {
      epoch: 2,
      until: RESTART,
      // Two days ago $100 (cash $60); just before the restart $102, cash unchanged.
      points: [
        { at: NOW - 2 * DAY, book: "live", equity: 100, cash: 60, flows: 0, unattributed: 0 },
        { at: RESTART - 600, book: "live", equity: 102, cash: 60, flows: 0, unattributed: 0 },
      ],
      tail: [],
      complete: true,
      ...account,
    },
  };
}

before(() => {
  initStore();
  const db = new DatabaseSync(homePaths.db());
  db.prepare(
    "INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, epoch) VALUES (?, 'o', 's', 4663, '{}', 0, 0, 2)",
  ).run(SHOGUN);
  // After the restart: $50 more cash than before (deposited while down, booked by nobody).
  const m = db.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', ?, 0, ?, ?, 2, 'live')");
  m.run(SHOGUN, 110, 153, RESTART + 60);
  m.run(SHOGUN, 110, 154, NOW - 60);
  db.close();
});

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("pnl_breakdown across a redeploy", () => {
  it("opens before the restart, and a deposit made while down is unexplained — not trading", async () => {
    writeHistoryFile(HOME, file());
    const out = await pnl();
    assert.match(out, /Account value went from \$100\.00 .* to \$154\.00 .*: \+\$54\.00\./);
    assert.match(out, /The first figure is from before my last restart/);
    assert.match(out, /\+\$51\.00 changed where my records can't say why/);
    assert.match(out, /trading and price moves made \+\$3\.00/);
  });

  it("a deposit booked just before the restart counts as money put in", async () => {
    writeHistoryFile(HOME, file({ tail: [{ book: "live", evidenced: 50, unevidenced: 0 }] }));
    const out = await pnl();
    assert.match(out, /\$50\.00 was money put in/);
    assert.doesNotMatch(out, /can't say why/);
    assert.match(out, /trading and price moves made \+\$4\.00/);
  });

  it("from another accounting epoch, the carried record is not used", async () => {
    writeHistoryFile(HOME, file({ epoch: 3 }));
    const out = await pnl();
    assert.match(out, /went from \$153\.00/);
    assert.doesNotMatch(out, /before my last restart/);
  });

  it("nor when this ledger began before the record was taken — the two would overlap", async () => {
    writeHistoryFile(HOME, file({ until: NOW }));
    const out = await pnl();
    assert.match(out, /went from \$153\.00/);
    assert.doesNotMatch(out, /before my last restart/);
  });

  it("a period this ledger covers on its own opens on its own reading", async () => {
    writeHistoryFile(HOME, file());
    const out = await pnl("today");
    // "today" starts at 00:00 UTC; the carried record is used only if this ledger has nothing at or before it.
    assert.match(out, /Account value went from/);
    assert.doesNotMatch(out, /NaN|undefined/);
  });
});
