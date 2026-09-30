/**
 * The chat answering from trades made BEFORE a hosted redeploy.
 *
 * The ledger here is the one a redeploy leaves: empty but for one bare restart
 * copy the reconciler wrote at the restart, and one fill made since. The
 * trades and decisions from before arrive the way the orchestrator delivers
 * them — `trade-history.json` in the agent's home (history-files.ts) — and
 * every lookup must see them, one row per operation, without the ledger file
 * itself ever holding a carried row.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-history-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_HOSTED = "1";

const { closeStoreForTest, initStore } = await import("../store");
const { toolByName } = await import("./chat-tools");
const { readTrades } = await import("./reads");
const { overlayHistory } = await import("./history-overlay");
const { CASH } = await import("../../../packages/core/src/index");
const { DatabaseSync } = await import("node:sqlite");
const { homePaths } = await import("../home");
const { writeHistoryFile, historyFilePath, readHistory, HISTORY_FILE } = await import("../history-files");
type TradeHistory = import("../history-files").TradeHistory;
type HistoryTrade = import("../history-files").HistoryTrade;

const SHOGUN = "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487";
const VAULT = "0x2ca2b5bd3b6635d630419c57a13c6b6a856ec96d";
const MUSE = "0x7a11ce0000000000000000000000000000000001";
const NEWCOIN = "0x7a11ce0000000000000000000000000000000002";
const PAPERCOIN = "0x7a11ce0000000000000000000000000000000003";
const FILLCOIN = "0x7a11ce0000000000000000000000000000000004";
const LATECOIN = "0x7a11ce0000000000000000000000000000000006";
const GHOSTCOIN = "0x7a11ce0000000000000000000000000000000007";
const USDG = CASH.USDG;
const NOW = Math.floor(Date.now() / 1000);
const RESTART = NOW - 3_600;
const DAY = 86_400;

function ctx() {
  return {
    status: { agentId: SHOGUN, name: "Shogun", strategy: "trencher", venue: "uniswap", paused: false, workerAliveSec: 5, grant: null, chainId: 4663, telegramMaxActionUsdg: 25 },
    cfg: { customTokens: [], liveTradingEnabled: true, paperTradingEnabled: false, classSnipeEnabled: false, classPerEntryUsdg: 0, trencherLiveEnabled: true, sponsorGasEnabled: true },
    paused: false,
    grant: null,
    book: [SHOGUN, VAULT],
    client: null,
    now: NOW,
  } as never;
}

const run = (name: string, input: Record<string, unknown> = {}) => toolByName(name)!.run(input, ctx());

function trade(p: Partial<HistoryTrade> & Pick<HistoryTrade, "created_at">): HistoryTrade {
  return {
    kind: "swap",
    target: VAULT,
    sell_token: null,
    buy_token: null,
    amount_usdg: 5,
    user_op_hash: null,
    tx_hash: null,
    status: "landed",
    reject_rule: null,
    decision_id: null,
    fill_side: null,
    fill_symbol: null,
    fill_qty_raw: null,
    fill_price_usd: null,
    realized_pnl_usdg: null,
    fill_cash_usdg: null,
    gas_usdg: null,
    gas_wei: null,
    epoch: 1,
    ...p,
  };
}

const HISTORY: TradeHistory = {
  schema: 1,
  agentId: SHOGUN.toUpperCase().replace("0X", "0x"),
  writtenAt: NOW,
  since: NOW - 30 * DAY,
  decisionsFrom: NOW - 3 * DAY,
  trades: [
    // The ORIGINAL of the op the ledger only holds as a restart copy.
    trade({ user_op_hash: "0xAAAA000000000000000000000000000000000000000000000000000000000001", tx_hash: "0xt1", sell_token: USDG, buy_token: MUSE, fill_side: "buy", fill_cash_usdg: 13.3, amount_usdg: 13.3, decision_id: "hd-1", created_at: NOW - 2 * DAY }),
    // A sale the ledger never saw.
    trade({ user_op_hash: "0xaaaa000000000000000000000000000000000000000000000000000000000002", tx_hash: "0xt2", sell_token: MUSE, buy_token: USDG, fill_side: "sell", fill_cash_usdg: 14.1, realized_pnl_usdg: 0.8, gas_usdg: 0.04, decision_id: "hd-2", created_at: NOW - DAY }),
    // A copy of the op the ledger holds from its own executor — must not show twice.
    trade({ user_op_hash: "0xaaaa000000000000000000000000000000000000000000000000000000000003", tx_hash: "0xt3", target: SHOGUN, created_at: RESTART + 5 }),
    // A practice fill older than anything on the ledger — carried.
    trade({ status: "paper", sell_token: USDG, buy_token: PAPERCOIN, fill_side: "buy", fill_cash_usdg: 2, amount_usdg: 2, decision_id: "hd-0", created_at: NOW - 3 * DAY }),
    // A refusal from just before the redeploy — carried, and shown as a sample, never a count.
    trade({ status: "rejected", reject_rule: "CARRIED_RULE", created_at: RESTART - 100 }),
    // A refusal NEWER than the ledger's first row — the ledger's own, mirrored up. Not carried.
    trade({ status: "rejected", reject_rule: "OVERLAP_REFUSAL", sell_token: USDG, buy_token: NEWCOIN, created_at: NOW - 100 }),
    // A coin with no decision at all — named by the symbol the shared ledger read off its receipt.
    trade({ user_op_hash: "0xaaaa000000000000000000000000000000000000000000000000000000000005", tx_hash: "0xt5", sell_token: USDG, buy_token: FILLCOIN, fill_side: "buy", fill_cash_usdg: 1, fill_symbol: "FILLSYM", created_at: NOW - 4 * DAY }),
    // Sent seconds before the redeploy: the shared copy never learned it landed. The ledger's restart copy did.
    trade({ user_op_hash: "0xaaaa000000000000000000000000000000000000000000000000000000000006", status: "submitted", sell_token: USDG, buy_token: LATECOIN, amount_usdg: 4, decision_id: "hd-6", created_at: RESTART - 30 }),
    // Sent before a restart, and nothing anywhere says how it ended.
    trade({ user_op_hash: "0xaaaa000000000000000000000000000000000000000000000000000000000007", status: "submitted", sell_token: USDG, buy_token: GHOSTCOIN, amount_usdg: 6, decision_id: "hd-7", created_at: NOW - 3.5 * DAY }),
  ],
  decisions: [
    { id: "hd-6", source: "brain", strategy: "trencher", symbol: "LATE", action: "buy", size_usdg: 4, reason: null, dropped_rule: null, provenance: null, display_name: null, at: RESTART - 31 },
    { id: "hd-7", source: "brain", strategy: "trencher", symbol: "GHOST", action: "buy", size_usdg: 6, reason: null, dropped_rule: null, provenance: null, display_name: null, at: NOW - 3.5 * DAY },
    { id: "hd-0", source: "strategy:trencher", strategy: "trencher", symbol: "PAPERCOIN", action: "buy", size_usdg: 2, reason: null, dropped_rule: null, provenance: null, display_name: null, at: NOW - 3 * DAY },
    { id: "hd-1", source: "brain", strategy: "trencher", symbol: "MUSE", action: "buy", size_usdg: 13.3, reason: "HIST_BUY_REASON real buyers on the curve", dropped_rule: null, provenance: null, display_name: "Musebook", at: NOW - 2 * DAY },
    { id: "hd-2", source: "brain", strategy: "trencher", symbol: "MUSE", action: "sell", size_usdg: 14, reason: "HIST_SELL_REASON took the gain", dropped_rule: null, provenance: null, display_name: "Musebook", at: NOW - DAY },
    // Same id as a decision the ledger holds — the ledger's wins.
    { id: "ld-1", source: "brain", strategy: "trencher", symbol: "NEW", action: "buy", size_usdg: 3, reason: "STALE_COPY_REASON", dropped_rule: null, provenance: null, display_name: null, at: NOW - 600 },
  ],
};

function ledgerCount(): number {
  const db = new DatabaseSync(homePaths.db(), { readOnly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

before(() => {
  initStore();
  const db = new DatabaseSync(homePaths.db());
  // What the arm-time reconciler writes back after a redeploy: no legs, no
  // decision, the account itself as target, stamped at the restart.
  db.prepare(
    `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, created_at)
     VALUES (?, 'swap', ?, 13.3, ?, '0xt1', 'landed', ?)`,
  ).run(SHOGUN, SHOGUN, "0xaaaa000000000000000000000000000000000000000000000000000000000001", RESTART);
  db.prepare(
    `INSERT INTO decisions (id, agent_id, source, symbol, action, size_usdg, reason, at) VALUES ('ld-1', ?, 'brain', 'NEW', 'buy', 3, 'LOCAL_REASON fresh one', ?)`,
  ).run(SHOGUN, NOW - 600);
  db.prepare(
    `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, fill_side, fill_cash_usdg, decision_id, created_at)
     VALUES (?, 'swap', ?, ?, ?, 3, ?, '0xt3', 'landed', 'buy', 3, 'ld-1', ?)`,
  ).run(SHOGUN, VAULT, USDG, NEWCOIN, "0xaaaa000000000000000000000000000000000000000000000000000000000003", NOW - 600);
  // The restart copy of the op sent just before the redeploy — it exists because the chain says it landed.
  db.prepare(
    `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, created_at)
     VALUES (?, 'swap', ?, 4, ?, '0xt6', 'landed', ?)`,
  ).run(SHOGUN, SHOGUN, "0xaaaa000000000000000000000000000000000000000000000000000000000006", RESTART);
  // One refusal of this run's own.
  db.prepare(
    `INSERT INTO trades (agent_id, kind, target, amount_usdg, status, reject_rule, created_at) VALUES (?, 'swap', ?, 5, 'rejected', 'DAILY_CAP', ?)`,
  ).run(SHOGUN, VAULT, NOW - 500);
  // The account-value readings restart with the ledger.
  db.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 20, 0, 20, ?, 1, 'live')").run(SHOGUN, RESTART + 60);
  db.close();
  writeHistoryFile(HOME, HISTORY);
});

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("trades from before the redeploy", () => {
  it("list_trades shows them by name at their real time, and the restart copy is replaced, not doubled", async () => {
    const out = await run("list_trades", { limit: 15, since_hours: 720 });
    assert.match(out, /bought MUSE for \$13\.30/, "the original replaces the nameless copy");
    assert.match(out, /sold MUSE for \$14\.10 \(\+\$0\.80\)/, "a sale only the shared ledger saw");
    assert.match(out, /bought FILLSYM for \$1\.00/, "named from the receipt's symbol");
    assert.match(out, /bought PAPERCOIN for \$2\.00 \(practice\)/);
    assert.doesNotMatch(out, /after a restart/, "no row should still be the bare copy");
    assert.doesNotMatch(out, /a coin I can't name/);
    assert.equal(out.match(/bought MUSE/g)?.length, 1, "one row per operation");
    assert.equal(out.match(/for \$3\.00/g)?.length, 1, "the ledger's own fill is not shown twice");
  });

  it("/trades sees them too", async () => {
    const out = await readTrades(SHOGUN);
    assert.match(out, /sold MUSE/);
    assert.doesNotMatch(out, /recorded .* after a restart/);
  });

  it("a refusal the ledger already holds is not carried a second time", async () => {
    const out = await run("list_trades", { filter: "refused", since_hours: 720 });
    assert.doesNotMatch(out, /OVERLAP_REFUSAL/);
  });

  it("decisions and token_report carry the reasons from before", async () => {
    const d = await run("decisions", { limit: 12 });
    assert.match(d, /HIST_SELL_REASON/);
    assert.match(d, /LOCAL_REASON/);
    assert.doesNotMatch(d, /STALE_COPY_REASON/, "the ledger's own decision wins over a carried one with its id");
    const r = await run("token_report", { coin: MUSE });
    assert.match(r, /My trades in it: 2 \(bought \$13\.30, sold \$14\.10, closed result \+\$0\.80\)/);
    assert.match(r, /HIST_(SELL|BUY)_REASON/);
  });

  it("pnl_breakdown books the closed trade by coin, and says its account-value readings start later", async () => {
    const out = await run("pnl_breakdown", { period: "7d" });
    assert.match(out, /MUSE: \+\$0\.80 over 1 sale/);
    assert.match(out, /Network fees paid: about \$0\.04/);
    assert.match(out, /account-value readings only go back to/);
  });

  it("the horizon reaches back to the carried rows", async () => {
    const out = await run("list_trades");
    const start = new Date((NOW - 4 * DAY) * 1000).getUTCDate();
    assert.match(out, new RegExp(`My trade records here start \\w+ ${start},`));
  });

  it("the ledger file itself never holds a carried row", () => {
    assert.equal(ledgerCount(), 4);
  });

  it("a trade sent just before the redeploy shows how it really ended, not 'waiting to confirm'", async () => {
    const out = await run("list_trades", { limit: 15, since_hours: 720 });
    assert.match(out, /✅ bought LATE for \$4\.00/, "the ledger's copy knows it landed");
    assert.doesNotMatch(out, /waiting to confirm/);
    const all = await run("list_trades", { filter: "all", limit: 15, since_hours: 720 });
    assert.match(all, /tried to buy GHOST for \$6\.00 \(sent before a restart — how it ended isn't on record\)/);
  });

  it("find_token finds a coin /trades named from its receipt", async () => {
    const out = await run("find_token", { query: "FILLSYM" });
    assert.match(out, new RegExp(FILLCOIN));
  });

  it("the log and the decisions say where THEY start, not where the carried trades do", async () => {
    const log = await run("recent_activity", { contains: "NOTHING_LIKE_THIS" });
    assert.match(log, /no log yet|My log here starts/);
    assert.doesNotMatch(log, /trade records/);
    const d = await run("decisions", { coin: "NOPE" });
    const from = new Date((NOW - 3 * DAY) * 1000).getUTCDate();
    assert.match(d, new RegExp(`My decision records here start \\w+ ${from},.*Before that I only kept the decisions behind trades I made`));
  });

  it("agent_status counts only this run's refusals, and says since when", async () => {
    const out = await run("agent_status");
    assert.match(out, /Blocked 1× since \w+ \d+, \d\d:\d\d UTC: /);
    assert.match(out, /Before my last restart, the newest refusals I kept were: CARRIED_RULE \(1\)\. That is a sample, not a full count\./);
  });

  it("laying the overlay twice on one connection keeps it", () => {
    const db = new DatabaseSync(homePaths.db(), { readOnly: true });
    try {
      assert.equal(overlayHistory(db, SHOGUN), true);
      const count = () => (db.prepare("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n;
      const n = count();
      assert.ok(n > 4, "carried rows are visible");
      assert.equal(overlayHistory(db, SHOGUN), true);
      assert.equal(count(), n);
    } finally {
      db.close();
    }
  });

  it("another agent's file, or a broken one, is no history — never an error", async () => {
    assert.equal(readHistory(HOME, "0x0000000000000000000000000000000000000b0b"), null);
    writeFileSync(historyFilePath(HOME), "{not json");
    const out = await run("list_trades");
    assert.match(out, /bought NEW for \$3\.00/, "the plain ledger still answers");
    assert.doesNotMatch(out, /MUSE/);
    writeHistoryFile(HOME, HISTORY);
    assert.equal(path.basename(historyFilePath(HOME)), HISTORY_FILE);
  });
});
