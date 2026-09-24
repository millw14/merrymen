/**
 * ONE LEDGER CONNECTION PER ANSWER.
 *
 * Every chat lookup lays the carried history over the ledger, and that copy is
 * the expensive part. An answer's lookups share one overlaid connection
 * (chat-tools.ts openToolSession), opened lazily and closed when the answer
 * ends — whatever way it ends. A lookup outside an answer keeps its own.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-session-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_HOSTED = "1";

const { closeStoreForTest, initStore } = await import("../store");
const { toolByName, toolSessionStatsForTest } = await import("./chat-tools");
const { answerQuestion } = await import("./answer");
const { overlayHistory } = await import("./history-overlay");
const { loadTradeViews } = await import("./trade-rows");
const { CASH } = await import("../../../packages/core/src/index");
const { DatabaseSync } = await import("node:sqlite");
const { homePaths } = await import("../home");
const { writeHistoryFile } = await import("../history-files");
type AgentTurn = import("../llm").AgentTurn;
type HistoryTrade = import("../history-files").HistoryTrade;

const SHOGUN = "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487";
const VAULT = "0x2ca2b5bd3b6635d630419c57a13c6b6a856ec96d";
const USDG = CASH.USDG.toLowerCase();
const NOW = Math.floor(Date.now() / 1000);
const RESTART = NOW - 3_600;
const coin = (i: number) => "0x7a11ce" + String(i).padStart(34, "0");

const tools = () =>
  ({
    status: { agentId: SHOGUN, name: "Shogun", strategy: "trencher", venue: "uniswap", paused: false, workerAliveSec: 5, grant: null, chainId: 4663, telegramMaxActionUsdg: 25 },
    cfg: { customTokens: [], liveTradingEnabled: true, paperTradingEnabled: false, classSnipeEnabled: false, classPerEntryUsdg: 0, trencherLiveEnabled: true, sponsorGasEnabled: true, tickSeconds: 15 },
    paused: false,
    grant: null,
    book: [SHOGUN, VAULT],
    client: null,
    now: NOW,
  }) as never;

const creds = { provider: "test", transport: "openai", baseUrl: "http://x", apiKey: "k", model: "m", vision: false } as never;

/** A model that asks for `rounds` of lookups, calling `between` before each turn, then answers. */
function scripted(rounds: { name: string; input?: Record<string, unknown> }[][], between: (turn: number) => void = () => {}) {
  let n = 0;
  return (async () => {
    between(n);
    const r = rounds[n];
    n += 1;
    if (!r) return { text: "done", toolUses: [] } satisfies AgentTurn;
    return { text: "", toolUses: r.map((c, i) => ({ id: `c${n}-${i}`, name: c.name, input: c.input ?? {} })) } satisfies AgentTurn;
  }) as never;
}

function trade(p: Partial<HistoryTrade> & Pick<HistoryTrade, "created_at">): HistoryTrade {
  return {
    kind: "swap", target: VAULT, sell_token: null, buy_token: null, amount_usdg: 5, user_op_hash: null, tx_hash: null, status: "landed",
    reject_rule: null, decision_id: null, fill_side: null, fill_symbol: null, fill_qty_raw: null, fill_price_usd: null,
    realized_pnl_usdg: null, fill_cash_usdg: null, gas_usdg: null, gas_wei: null, epoch: 1, ...p,
  };
}

function addLocalFill(tokenIdx: number, at: number): void {
  const w = new DatabaseSync(homePaths.db());
  w.prepare(
    `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, fill_side, fill_cash_usdg, created_at) VALUES (?, 'swap', ?, ?, ?, 7, 'landed', 'buy', 7, ?)`,
  ).run(SHOGUN, VAULT, USDG, coin(tokenIdx), at);
  w.close();
}

before(async () => {
  await initStore();
  addLocalFill(900, RESTART + 60);
  writeHistoryFile(HOME, {
    schema: 1,
    agentId: SHOGUN,
    writtenAt: RESTART - 1,
    since: NOW - 30 * 86_400,
    decisionsFrom: RESTART - 86_400,
    trades: [trade({ user_op_hash: "0xab01", tx_hash: "0xt1", sell_token: USDG, buy_token: coin(1), fill_side: "buy", fill_cash_usdg: 3, fill_symbol: "CARRIED", created_at: RESTART - 600 })],
    decisions: [],
  });
});

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("one ledger connection per answer", () => {
  it("every lookup in an answer shares one connection, and it is closed when the answer ends", async () => {
    const before = toolSessionStatsForTest();
    const seenOpen: number[] = [];
    const turn = scripted(
      [
        [{ name: "list_trades", input: { since_hours: 720 } }, { name: "agent_status" }],
        [{ name: "decisions" }, { name: "pnl_breakdown", input: { period: "7d" } }, { name: "recent_activity" }],
        [{ name: "list_trades", input: { filter: "all", since_hours: 720 } }],
      ],
      (n) => {
        if (n > 0) seenOpen.push(toolSessionStatsForTest().open);
      },
    );
    const a = await answerQuestion({ question: "what did you buy", name: "Shogun", identity: "", memory: "", gap: "", history: [], tools: tools(), creds, turn });
    assert.equal(a?.text, "done");
    assert.equal(a?.used.length, 6);
    assert.deepEqual(seenOpen, [1, 1, 1], "open across the whole answer, one connection");
    const now = toolSessionStatsForTest();
    assert.equal(now.opened - before.opened, 1, "opened once for six lookups");
    assert.equal(now.open, 0, "closed when the answer ended");
  });

  it("is closed when the answer fails, too", async () => {
    const before = toolSessionStatsForTest();
    let n = 0;
    const turn = (async () => {
      n += 1;
      if (n === 1) return { text: "", toolUses: [{ id: "c1", name: "list_trades", input: {} }] };
      throw new Error("provider down");
    }) as never;
    assert.equal(await answerQuestion({ question: "q", name: "Shogun", identity: "", memory: "", gap: "", history: [], tools: tools(), creds, turn }), null);
    assert.equal(toolSessionStatsForTest().opened - before.opened, 1);
    assert.equal(toolSessionStatsForTest().open, 0);
  });

  it("an answer with no ledger lookups opens nothing", async () => {
    const before = toolSessionStatsForTest();
    const turn = scripted([[{ name: "settings" }, { name: "explain_term", input: { question: "slippage" } }]]);
    await answerQuestion({ question: "q", name: "Shogun", identity: "", memory: "", gap: "", history: [], tools: tools(), creds, turn });
    assert.deepEqual(toolSessionStatsForTest(), before);
  });

  it("a trade written mid-answer is seen by the next lookup (the ledger moved, so the copy is rebuilt)", async () => {
    const before = toolSessionStatsForTest();
    const outs: string[] = [];
    const turn = (async (_c: unknown, o: { messages: { role: string; results?: { output: string }[] }[] }) => {
      const last = o.messages[o.messages.length - 1];
      if (last?.role === "tools") outs.push(last.results![0]!.output);
      if (outs.length === 1) addLocalFill(901, NOW - 5); // the tick writes between two lookups
      if (outs.length < 2) return { text: "", toolUses: [{ id: `c${outs.length}`, name: "list_trades", input: { since_hours: 720, limit: 15 } }] };
      return { text: "done", toolUses: [] };
    }) as never;
    await answerQuestion({ question: "q", name: "Shogun", identity: "", memory: "", gap: "", history: [], tools: tools(), creds, turn });
    assert.equal(outs.length, 2);
    assert.match(outs[0]!, /CARRIED/, "the carried row is laid over");
    assert.equal(outs[0]!.match(/for \$7\.00/g)?.length, 1);
    assert.equal(outs[1]!.match(/for \$7\.00/g)?.length, 2, "the new fill is there");
    assert.match(outs[1]!, /CARRIED/, "and the rebuilt copy still carries the history");
    assert.equal(toolSessionStatsForTest().opened - before.opened, 2);
    assert.equal(toolSessionStatsForTest().open, 0);
  });

  it("a lookup outside an answer keeps its own connection", async () => {
    const before = toolSessionStatsForTest();
    const out = await toolByName("list_trades")!.run({ since_hours: 720 }, tools());
    assert.match(out, /CARRIED/);
    assert.deepEqual(toolSessionStatsForTest(), before);
  });
});

describe("the newest trades, in true time", () => {
  it("a restart copy whose receipt is older than the rows after it gives up its place", async () => {
    const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const pad = (a: string) => "0x" + a.slice(2).padStart(64, "0");
    const POOL = "0x00000000000000000000000000000000000000aa";
    const T0 = RESTART - 20 * 3_600; // older than the carried row
    const w = new DatabaseSync(homePaths.db());
    w.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, created_at) VALUES (?, 'swap', ?, 5, '0xfeed', '0xcopytx', 'landed', ?)`).run(SHOGUN, SHOGUN, RESTART);
    w.close();
    const client = {
      getTransactionReceipt: async () => ({
        blockNumber: 1n,
        logs: [
          { address: USDG, topics: [TRANSFER, pad(SHOGUN), pad(POOL)], data: "0x" + (5_000_000).toString(16) },
          { address: coin(777), topics: [TRANSFER, pad(POOL), pad(SHOGUN)], data: "0x" + (10n ** 18n).toString(16) },
        ],
      }),
      getBlock: async () => ({ timestamp: BigInt(T0) }),
      readContract: async () => "COPYC",
    };
    const db = new DatabaseSync(homePaths.db(), { readOnly: true });
    try {
      overlayHistory(db, SHOGUN);
      const n = (db.prepare("SELECT COUNT(*) AS n FROM trades WHERE agent_id = ? AND created_at >= ?").get(SHOGUN, RESTART) as { n: number }).n;
      // Exactly the rows written at or after the restart, so the carried one is next in line.
      const views = await loadTradeViews(db, SHOGUN, { limit: n, book: [SHOGUN, VAULT], client: client as never });
      assert.ok(!views.some((v) => v.copy), "the copy happened before everything shown");
      assert.ok(views.some((v) => v.id < 0), "the carried trade takes its place");
      for (let i = 1; i < views.length; i++) assert.ok(views[i - 1]!.at >= views[i]!.at, "newest first");
    } finally {
      db.close();
    }
  });
});

describe("the copy's query plans", () => {
  it("a coin-name lookup searches the coin indexes, not every row of the agent", () => {
    // Enough rows that a whole-agent scan and an index search cost differently.
    const w = new DatabaseSync(homePaths.db());
    w.exec("BEGIN");
    const ins = w.prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, decision_id, created_at) VALUES (?, 'swap', ?, ?, ?, 5, 'rejected', ?, ?)`);
    for (let i = 0; i < 2000; i++) ins.run(SHOGUN, VAULT, USDG, coin(i % 50), `d-${i}`, RESTART + 100 + i);
    w.exec("COMMIT");
    w.close();
    const db = new DatabaseSync(homePaths.db(), { readOnly: true });
    try {
      assert.equal(overlayHistory(db, SHOGUN), true);
      const plan = (sql: string, ...a: string[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...a) as { detail: string }[]).map((p) => p.detail).join(" | ");
      // Searching the copy on agent_id ALONE is reading all of it: the copy holds one agent.
      const WHOLE_COPY = /SEARCH t?\s*(trades )?USING INDEX h_trades_\w+ \(agent_id=\?\)(?! AND)/;
      // token-label.ts's decision lookup, once per coin shown.
      const byCoin = plan(
        `SELECT d.symbol, d.display_name FROM trades t JOIN decisions d ON d.id = t.decision_id AND d.agent_id = t.agent_id
          WHERE t.agent_id = ? AND (lower(t.buy_token) = ? OR lower(t.sell_token) = ?) AND (d.symbol IS NOT NULL OR d.display_name IS NOT NULL)
          ORDER BY t.id DESC LIMIT 1`,
        SHOGUN, coin(3), coin(3),
      );
      assert.doesNotMatch(byCoin, WHOLE_COPY, byCoin);
      // token_report's totals: every trade in one coin.
      const totals = plan(
        `SELECT status, COUNT(*) AS n FROM trades WHERE agent_id = ? AND status IN ('landed','paper') AND (lower(buy_token) = ? OR lower(sell_token) = ?) GROUP BY status`,
        SHOGUN, coin(3), coin(3),
      );
      assert.doesNotMatch(totals, WHOLE_COPY, totals);
      // The decisions tool's "what became of it", once per decision shown.
      const byDecision = plan(`SELECT MAX(id) FROM trades WHERE decision_id = ? AND agent_id = ?`, "d-7", SHOGUN);
      assert.match(byDecision, /h_trades_decision/, byDecision);
    } finally {
      db.close();
    }
  });
});
