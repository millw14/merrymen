/**
 * The chat's lookups against a REAL sqlite ledger holding two agents.
 *
 * What these protect: every lookup names coins, never mistakes a launch-scan
 * line for the pause button, and never shows one agent another's rows.
 * MERRYMEN_HOME is a throwaway temp dir and MERRYMEN_HOSTED is set, so the
 * no-guess branch of resolveAgent is the one exercised. node --test runs each
 * file in its own process.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-tools-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_HOSTED = "1";

const { closeStoreForTest, initStore, addTrade, addEvent, addDecision, newDecisionId, addEquity } = await import("../store");
const { toolByName } = await import("./chat-tools");
const { CASH } = await import("../../../packages/core/src/index");
const { DatabaseSync } = await import("node:sqlite");
const { homePaths } = await import("../home");

const SHOGUN = "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487";
const OTHER = "0x0000000000000000000000000000000000000b0b";
const CASHCAT = "0x020bfc650a365f8bb26819deaabf3e21291018b4";
const USDG = CASH.USDG;
const NOW = Math.floor(Date.now() / 1000);

function ctx(agentId: string | null) {
  return {
    status: { agentId, name: "Shogun", strategy: "trencher", venue: "uniswap", paused: false, workerAliveSec: 5, grant: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiresInDays: 12 }, chainId: 4663, telegramMaxActionUsdg: 25 },
    cfg: { customTokens: [], liveTradingEnabled: true, paperTradingEnabled: false, classSnipeEnabled: false, classPerEntryUsdg: 0, trencherLiveEnabled: true, sponsorGasEnabled: true },
    paused: false,
    grant: null,
    book: agentId ? [agentId] : [],
    client: null,
    now: NOW,
  } as never;
}

async function run(name: string, input: Record<string, unknown> = {}, who: string | null = SHOGUN): Promise<string> {
  return toolByName(name)!.run(input, ctx(who));
}

before(async () => {
  initStore();
  const d1 = newDecisionId();
  await addDecision({ id: d1, agent_id: SHOGUN, source: "brain", symbol: "CASHCAT", action: "buy", size_usdg: 5, reason: "SHOGUN_REASON fresh launch with real buyers" });
  await addTrade({ agent_id: SHOGUN, kind: "swap", target: "0x2ca2b5bd3b6635d630419c57a13c6b6a856ec96d", sell_token: USDG, buy_token: CASHCAT, amount_usdg: 5, fill_side: "buy", fill_cash_usdg: 5, status: "landed", tx_hash: "0xaa", decision_id: d1 });
  const d2 = newDecisionId();
  await addDecision({ id: d2, agent_id: SHOGUN, source: "brain", symbol: "CASHCAT", action: "sell", size_usdg: 5, reason: "took the small gain" });
  await addTrade({ agent_id: SHOGUN, kind: "swap", target: "0x2ca2b5bd3b6635d630419c57a13c6b6a856ec96d", sell_token: CASHCAT, buy_token: USDG, amount_usdg: 5, fill_side: "sell", fill_cash_usdg: 5.025718, realized_pnl_usdg: 0.025718, status: "landed", tx_hash: "0xbb", decision_id: d2 });
  await addEvent(SHOGUN, "ok", "Scanning 12 tokens on the launchpad… Trading is paused.");
  await addEquity(SHOGUN, { mode: "live", ethWei: 0n, cashUsdg: 20, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 20.03 });
  // The other tenant — none of this may ever appear in Shogun's answers.
  await addTrade({ agent_id: OTHER, kind: "swap", target: "0x1", sell_token: USDG, buy_token: "0x000000000000000000000000000000000000c0de", amount_usdg: 77.77, status: "landed", tx_hash: "0xcc" });
  await addEvent(OTHER, "ok", "OTHER_SECRET_EVENT");
  const db = new DatabaseSync(homePaths.db());
  db.prepare("INSERT OR REPLACE INTO discovered_pools (address, symbol, liquidity_usd) VALUES (?, 'CASHCAT', 1234)").run(CASHCAT);
  db.close();
});

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the lookups answer with names, and truthfully", () => {
  it("list_trades names the coin and the side — the question Shogun couldn't answer", async () => {
    const out = await run("list_trades");
    assert.match(out, /sold CASHCAT for \$5\.03 \(\+\$0\.03\)/);
    assert.match(out, /bought CASHCAT for \$5\.00/);
    assert.doesNotMatch(out, /swap 5\.00 USDG/);
  });

  it("agent_status never calls launch buying being off 'paused'", async () => {
    const out = await run("agent_status");
    assert.match(out, /pause button is off/);
    assert.match(out, /launchpad coins is switched off in settings/);
    assert.match(out, /not the pause button/);
  });

  it("recent_activity labels the launch-scan line so it can't be misread", async () => {
    const out = await run("recent_activity");
    assert.match(out, /launch buying is switched off — NOT the pause button/);
  });

  it("decisions carry the reason, by coin name", async () => {
    const out = await run("decisions", { coin: "CASHCAT" });
    assert.match(out, /SHOGUN_REASON/);
  });

  it("pnl_breakdown splits the result by coin", async () => {
    const out = await run("pnl_breakdown", { period: "all" });
    assert.match(out, /CASHCAT: \+\$0\.03 over 1 sale/);
  });

  it("find_token and token_report go from a ticker to what I know", async () => {
    assert.match(await run("find_token", { query: "cashcat" }), /0x020bfc650a365f8bb26819deaabf3e21291018b4/);
    const report = await run("token_report", { coin: "CASHCAT" });
    assert.match(report, /My trades in it: 2/);
    assert.match(report, /\$1234\.00/);
    assert.match(report, /My reason to/);
  });

  it("an unknown coin is said to be unknown, not invented", async () => {
    assert.match(await run("token_report", { coin: "KIST" }), /don't know a coin called KIST/);
  });

  it("explain_term defines a word, or says it can't", async () => {
    assert.ok((await run("explain_term", { question: "what is practice mode" })).length > 0);
  });
});

describe("one owner never sees another's ledger", () => {
  it("no lookup leaks the other tenant", async () => {
    for (const name of ["list_trades", "recent_activity", "pnl_breakdown", "agent_status", "decisions"]) {
      const out = await run(name, { filter: "all" });
      assert.doesNotMatch(out, /77\.77|OTHER_SECRET_EVENT|c0de/i, `${name} leaked the other agent`);
    }
  });

  it("hosted, no agent means no answer — never a guess", async () => {
    const out = await run("list_trades", {}, null);
    assert.match(out, /No agent is set up yet/);
  });
});

describe("review fixes on a real ledger", () => {
  const CAROL = "0x000000000000000000000000000000000000ca01";
  const LAUNCH = "0x39dbed3a2bd333467115de45665cc57f813c4571";

  it("pnl_breakdown never counts a deposit twice — money before the opening mark is already in it", async () => {
    // Opening mark at T, a $100 deposit BEFORE it (already inside the mark),
    // then +$1 of trading. Counting the deposit again read as "−$99 trading".
    const T = NOW - 3_600;
    const db = new DatabaseSync(homePaths.db());
    db.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 100, 0, 100, ?, 1, 'live')").run(CAROL, T);
    db.prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 101, 0, 101, ?, 1, 'live')").run(CAROL, NOW - 60);
    db.prepare("INSERT INTO flows (agent_id, direction, amount_usdg, source, at, epoch) VALUES (?, 'in', 100, 'chain-log', ?, 1)").run(CAROL, T - 10);
    // The +$1 is a trade's: without one in the step, a cash move nothing
    // explains is reported as unexplained (period-pnl.ts), not as trading.
    db.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at) VALUES (?, 'swap', '0xrouter', 1, 'landed', ?)").run(CAROL, T + 5);
    const counted = db.prepare("SELECT COUNT(*) AS n FROM flows WHERE agent_id = ?").get(CAROL) as { n: number };
    db.close();
    assert.equal(counted.n, 1, "the deposit is really on the ledger — this test must not pass by accident");
    const out = await run("pnl_breakdown", { period: "24h" }, CAROL);
    assert.match(out, /\+\$1\.00/);
    assert.doesNotMatch(out, /money put in/, "a deposit before the mark is already inside it");
    assert.match(out, /the change is all trading and price moves/);
  });

  it("positions shows held launch coins, recovered ones included, with the cost read from its 6-decimal text", async () => {
    const db = new DatabaseSync(homePaths.db());
    db.prepare("INSERT INTO class_positions (agent_id, token, symbol, state, cost_usdg, first_seen) VALUES (?, ?, 'x', 'open', '5000000', ?)").run(SHOGUN, LAUNCH, NOW - 100);
    db.prepare("INSERT INTO class_positions (agent_id, token, symbol, state, cost_usdg, first_seen) VALUES (?, ?, 'y', 'recovered', NULL, ?)").run(SHOGUN, CASHCAT, NOW - 50);
    db.prepare("INSERT INTO class_positions (agent_id, token, symbol, state, first_seen) VALUES (?, ?, 'cash', 'open', ?)").run(SHOGUN, USDG.toLowerCase(), NOW - 10);
    db.close();
    const out = await run("positions");
    assert.match(out, /for \$5\.00/, "the raw '5000000' is five dollars, not an unknown amount");
    assert.match(out, /CASHCAT — bought .* \(cost unknown\)/, "a recovered position is held, cost unknown");
    assert.doesNotMatch(out, /USDG — bought/, "the vault's own cash row is not a coin");
  });
});
