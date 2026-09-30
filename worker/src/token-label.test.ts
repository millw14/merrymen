import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, it } from "node:test";

import { CASH, STOCK_TOKENS } from "../../packages/core/src/index";
import { loadTradeViews, renderTradeList, tradeViewLine } from "./telegram/trade-rows";
import {
  clearTokenLabelCacheForTest,
  isRestartCopy,
  labelText,
  nonCashLeg,
  receiptFacts,
  sideOf,
  tokenLabel,
  tokenLabelSync,
} from "./token-label";

const USDG = CASH.USDG.toLowerCase();
const AGENT = "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487";
const VAULT = "0x2ca2b5bd3b6635d630419c57a13c6b6a856ec96d";
const MUSE = "0x91a2dae9699f0b82540b5886b0d8759c22820ba3";
const CASHCAT = "0x020bfc650a365f8bb26819deaabf3e21291018b4";
const FAKE_USDG = "0x1111111111111111111111111111111111111111";

function ledger(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, target TEXT, sell_token TEXT, buy_token TEXT,
      amount_usdg REAL, fill_cash_usdg REAL, fill_side TEXT, realized_pnl_usdg REAL, status TEXT, reject_rule TEXT, tx_hash TEXT,
      decision_id TEXT, created_at INTEGER);
    CREATE TABLE decisions (id TEXT PRIMARY KEY, agent_id TEXT, symbol TEXT, display_name TEXT, at INTEGER);
    CREATE TABLE discovered_pools (address TEXT PRIMARY KEY, symbol TEXT);
    CREATE TABLE positions (agent_id TEXT, symbol TEXT, token TEXT);
  `);
  return db;
}

const padTopic = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const transfer = (token: string, from: string, to: string, value: bigint) => ({
  address: token,
  topics: [TRANSFER, padTopic(from), padTopic(to)],
  data: `0x${value.toString(16)}`,
});

/** A chain that knows one receipt and a few symbols, and counts its calls. */
function fakeChain(symbols: Record<string, string>) {
  const calls = { symbol: 0, receipt: 0 };
  return {
    calls,
    readContract: (async (a: { address: string }) => {
      calls.symbol += 1;
      const s = symbols[a.address.toLowerCase()];
      if (!s) throw new Error("revert");
      return s;
    }) as never,
    getTransactionReceipt: (async ({ hash }: { hash: string }) => {
      calls.receipt += 1;
      if (hash !== "0xtail") throw new Error("unknown tx");
      // The musebook tail: the VAULT loses 6.06 musebook, the ACCOUNT gains $0.002131.
      return {
        blockNumber: 100n,
        logs: [transfer(MUSE, VAULT, "0x000000000000000000000000000000000000dead", 6_061_100_000_000_000_000n), transfer(USDG, "0x000000000000000000000000000000000000beef", AGENT, 2_131n)],
      };
    }) as never,
    getBlock: (async () => ({ timestamp: 1_790_121_077n })) as never,
  };
}

beforeEach(() => clearTokenLabelCacheForTest());

describe("which leg is the coin, and which way it went", () => {
  it("the non-cash leg, whichever side it is on", () => {
    assert.equal(nonCashLeg({ sell_token: CASH.USDG, buy_token: MUSE }), MUSE);
    assert.equal(nonCashLeg({ sell_token: MUSE, buy_token: CASH.USDG }), MUSE);
    assert.equal(nonCashLeg({ sell_token: null, buy_token: null }), null);
    assert.equal(sideOf({ sell_token: CASH.USDG, buy_token: MUSE }), "buy");
    assert.equal(sideOf({ fill_side: "sell", sell_token: CASH.USDG }), "sell", "the fill's own side wins");
  });

  it("recognises a row re-recorded after a restart — the account targeting itself", () => {
    assert.ok(isRestartCopy({ kind: "swap", target: AGENT.toUpperCase(), agent_id: AGENT, decision_id: null, fill_side: null }));
    assert.ok(!isRestartCopy({ kind: "swap", target: VAULT, agent_id: AGENT, decision_id: "d1", fill_side: "sell" }));
  });
});

describe("tokenLabelSync — local sources, trusted first", () => {
  it("names stocks and cash from the curated tables", () => {
    const aapl = STOCK_TOKENS[0]!;
    assert.equal(tokenLabelSync(null, AGENT, aapl.address).ticker, aapl.symbol);
    assert.equal(tokenLabelSync(null, AGENT, CASH.USDG).source, "cash");
  });

  it("never calls the owner's own account or vault a coin", () => {
    const l = tokenLabelSync(null, AGENT, VAULT, { own: [AGENT, VAULT] });
    assert.equal(l.source, "account");
    assert.doesNotMatch(labelText(l), /0x/);
  });

  it("reads a launch coin's name from the decision that bought it", () => {
    const db = ledger();
    db.prepare("INSERT INTO decisions (id, agent_id, symbol, display_name, at) VALUES ('d1', ?, ?, 'musebook', 1)").run(AGENT, `T${MUSE.slice(-11).toUpperCase()}`);
    db.prepare("INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, decision_id, created_at) VALUES (?, 'swap', ?, ?, ?, 5, 'landed', 'd1', 1)").run(AGENT, VAULT, CASH.USDG, MUSE);
    const l = tokenLabelSync(db, AGENT, MUSE);
    assert.equal(labelText(l), "musebook", "the Trencher id is not a name; the display name is");
    assert.equal(l.trusted, false);
  });

  it("falls back to what discovery read off the token, and refuses address-shaped placeholders", () => {
    const db = ledger();
    db.prepare("INSERT INTO discovered_pools (address, symbol) VALUES (?, 'CASHCAT')").run(CASHCAT);
    db.prepare("INSERT INTO discovered_pools (address, symbol) VALUES (?, '0x0339f545…')").run("0x0339f5459fc690ac85f1782e15782a151b4a9e1b");
    assert.equal(tokenLabelSync(db, AGENT, CASHCAT).ticker, "CASHCAT");
    assert.equal(tokenLabelSync(db, AGENT, "0x0339f5459fc690ac85f1782e15782a151b4a9e1b").source, "none");
  });

  it("a coin that calls itself USDG is flagged, and always shown with its address", () => {
    const db = ledger();
    db.prepare("INSERT INTO discovered_pools (address, symbol) VALUES (?, 'USDG')").run(FAKE_USDG);
    const l = tokenLabelSync(db, AGENT, FAKE_USDG);
    assert.equal(l.clash, true);
    assert.match(labelText(l), /USDG \(0x1111…1111, not the real USDG\)/);
  });
});

describe("tokenLabel — the chain, only when nothing local knows it", () => {
  it("asks symbol() once and remembers it", async () => {
    const chain = fakeChain({ [CASHCAT]: "CASHCAT" });
    const a = await tokenLabel(null, AGENT, CASHCAT, { client: chain });
    const b = await tokenLabel(null, AGENT, CASHCAT, { client: chain });
    assert.equal(a.ticker, "CASHCAT");
    assert.equal(b.source, "chain");
    assert.equal(chain.calls.symbol, 1);
  });

  it("does not ask the chain for something the ledger already names", async () => {
    const chain = fakeChain({});
    await tokenLabel(null, AGENT, STOCK_TOKENS[0]!.address, { client: chain });
    assert.equal(chain.calls.symbol, 0);
  });

  it("an unreadable coin stays its short address, never an error", async () => {
    const l = await tokenLabel(null, AGENT, MUSE, { client: fakeChain({}) });
    assert.equal(labelText(l), "0x91a2…0ba3");
  });
});

describe("receiptFacts — the coin in a row that lost its legs", () => {
  it("nets the receipt over the account AND its vaults", async () => {
    const facts = await receiptFacts(fakeChain({}), "0xtail", [AGENT, VAULT]);
    assert.deepEqual(facts, { token: MUSE, side: "sell", cashUsdg: 2_131n, blockTime: 1_790_121_077 });
  });

  it("netted over the account alone, a vault trade is unreadable — which is why the reconciler lost it", async () => {
    assert.equal(await receiptFacts(fakeChain({}), "0xtail", [AGENT]), null);
  });
});

describe("the trade list the owner reads", () => {
  it("replays Shogun: restart copies with no legs become named sells at the chain's time", async () => {
    const db = ledger();
    db.prepare("INSERT INTO discovered_pools (address, symbol) VALUES (?, 'musebook')").run(MUSE);
    // What the reconciler wrote at the restart: target = the account, no legs, stamped 01:07:59.
    db.prepare(
      "INSERT INTO trades (agent_id, kind, target, amount_usdg, status, tx_hash, created_at) VALUES (?, 'swap', ?, 0.002131, 'landed', '0xtail', 1790125679)",
    ).run(AGENT, AGENT);
    const views = await loadTradeViews(db, AGENT, { book: [AGENT, VAULT], client: fakeChain({}) });
    assert.equal(views.length, 1);
    const v = views[0]!;
    assert.equal(v.copy, true);
    assert.equal(v.side, "sell");
    assert.equal(v.label, "musebook");
    assert.equal(v.at, 1_790_121_077, "the block's time, not the restart's");
    assert.equal(v.atIsRestart, false);
    const line = tradeViewLine(v, false);
    assert.match(line, /sold musebook for <\$0\.01/);
    assert.doesNotMatch(line, /0\.00/);
    assert.match(renderTradeList(views), /re-recorded when I restarted; the times shown are the chain's own/);
  });

  it("without a chain, a copy says its time is the restart's rather than pretending", async () => {
    const db = ledger();
    db.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, tx_hash, created_at) VALUES (?, 'swap', ?, 5, 'landed', '0xtail', 1790125679)").run(AGENT, AGENT);
    const [v] = await loadTradeViews(db, AGENT, { book: [AGENT, VAULT] });
    assert.match(tradeViewLine(v!, false), /recorded .* after a restart/);
  });

  it("an executor row names its coin and its result from the ledger alone", async () => {
    const db = ledger();
    db.prepare("INSERT INTO discovered_pools (address, symbol) VALUES (?, 'CASHCAT')").run(CASHCAT);
    db.prepare(
      "INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, fill_cash_usdg, fill_side, realized_pnl_usdg, status, created_at) VALUES (?, 'swap', ?, ?, ?, 5, 5.025718, 'sell', 0.025718, 'landed', 1790118605)",
    ).run(AGENT, VAULT, CASHCAT, CASH.USDG);
    const [v] = await loadTradeViews(db, AGENT, {});
    assert.match(tradeViewLine(v!, false), /✅ sold CASHCAT for \$5\.03 \(\+\$0\.03\)/);
  });

  it("scopes every row to this agent", async () => {
    const db = ledger();
    db.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at) VALUES ('0xother', 'swap', '0x1', 99, 'landed', 1)").run();
    assert.deepEqual(await loadTradeViews(db, AGENT, {}), []);
  });
});

describe("review fixes", () => {
  it("a coin that dresses up a trusted ticker with punctuation is still flagged", async () => {
    const db = ledger();
    db.prepare("INSERT INTO discovered_pools (address, symbol) VALUES (?, '$USDG')").run(FAKE_USDG);
    const l = tokenLabelSync(db, AGENT, FAKE_USDG);
    assert.equal(l.clash, true);
    const viaChain = await tokenLabel(null, AGENT, "0x2222222222222222222222222222222222222222", { client: fakeChain({ "0x2222222222222222222222222222222222222222": "TSLA." }) });
    assert.equal(viaChain.clash, true);
    assert.match(labelText(viaChain), /not the real/);
  });

  it("refusals past the limit never hide the real trades behind them", async () => {
    const db = ledger();
    db.prepare(
      "INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, fill_side, status, created_at) VALUES (?, 'swap', ?, ?, ?, 5, 'buy', 'landed', 100)",
    ).run(AGENT, VAULT, CASH.USDG, CASHCAT);
    for (let i = 0; i < 40; i++) {
      db.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, reject_rule, created_at) VALUES (?, 'swap', ?, 5, 'rejected', 'per-trade-cap', ?)").run(AGENT, VAULT, 200 + i);
    }
    const filled = await loadTradeViews(db, AGENT, { filter: "filled", limit: 5 });
    assert.equal(filled.length, 1, "the one real buy is found under forty newer refusals");
  });

  it("vault moves and equity orders get real names, never 'a coin I can't name'", async () => {
    const db = ledger();
    db.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at) VALUES (?, 'vault-deposit', ?, 50, 'landed', 1)").run(AGENT, VAULT);
    db.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at) VALUES (?, 'equity-order', 'aapl', 5, 'paper', 2)").run(AGENT);
    const views = await loadTradeViews(db, AGENT, {});
    const lines = views.map((v) => tradeViewLine(v, false)).join("\n");
    assert.match(lines, /moved cash into your savings vault for \$50\.00/);
    assert.match(lines, /AAPL/);
    assert.doesNotMatch(lines, /can't name/);
  });

  it("the HTML list escapes '<$0.01'", async () => {
    const db = ledger();
    db.prepare("INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, fill_cash_usdg, fill_side, status, created_at) VALUES (?, 'swap', ?, ?, ?, 0.002, 0.002, 'sell', 'landed', 1)").run(AGENT, VAULT, CASHCAT, CASH.USDG);
    const html = renderTradeList(await loadTradeViews(db, AGENT, {}));
    assert.doesNotMatch(html, /<\$/);
  });
});
