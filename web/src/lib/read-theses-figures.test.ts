/**
 * THE FEED READS WHAT A CALL WAS WORTH — FROM THE LEDGER, OR NOT AT ALL.
 *
 * Wave 2 puts the call's own figure under a trade instead of the token's 24h
 * change: what a buy paid, what a sell booked, the price a view was posted at,
 * and a memecoin's size when the tape gave one. Everything here runs the real
 * query against a real SQLite ledger, because every figure is folded per group
 * in SQL and the defects worth catching are in that fold: an estimated fill
 * standing in for a read one, two copies at different prices averaged into a
 * price nobody paid, or a mark column that does not exist yet taking the whole
 * feed down in the minute between two deploys.
 *
 * And a production follow-up from Wave 1 that is a reader's problem too: a
 * tripped breaker's refusals filling the trade lane.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { readTheses } from "./read-theses";

const SLUG = "ems76d3cncwbt3dz";
const OTHER = "hr5k2m9q4w7x3z8n";
const NOW = Math.floor(Date.now() / 1000);
const COIN = "T3139F043B88";
const USDG = "0x05d0000000000000000000000000000000000005";

type Decision = {
  id: string;
  agent?: string;
  action: string | null;
  symbol: string | null;
  size?: number | null;
  source?: string;
  reason: string;
  at: number;
  display?: string | null;
  mark?: number | null;
  mcap?: number | null;
};
type Fill = {
  decision: string;
  status: string;
  rule?: string | null;
  side?: string | null;
  price?: number | null;
  cash?: number | null;
  pnl?: number | null;
  basis?: string | null;
  /** The trade's own account, when it is not the decision's usual author. */
  agent?: string;
  /** The coin that moved: bought on a buy, sold on a sell. */
  token?: string;
  /** When the trade was written — its order against the account's other trades. */
  at?: number;
};

/**
 * A ledger shaped like the worker's. `premark` is one the writer has not yet
 * migrated to carry `mark_usd`/`mcap_usd` — the minute between two deploys.
 */
async function ledger(decisions: Decision[], fills: Fill[] = [], opts: { premark?: boolean } = {}) {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  raw.exec(`CREATE TABLE agents(smart_account TEXT, name TEXT, x_handle TEXT, mode TEXT, x_verified INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT, size_usdg REAL, source TEXT,
      reason TEXT, dropped_rule TEXT, hold_kind TEXT, ${opts.premark ? "" : "mark_usd REAL, mcap_usd REAL,"} at INTEGER);
    CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, sell_token TEXT, buy_token TEXT, created_at INTEGER,
      decision_id TEXT, status TEXT, reject_rule TEXT,
      fill_side TEXT, fill_price_usd REAL, fill_cash_usdg REAL, realized_pnl_usdg REAL, basis_source TEXT);
    CREATE TABLE posts(decision_id TEXT, body TEXT);
    INSERT INTO agents VALUES ('0xabc', 'Shogun', NULL, 'live', 0);
    INSERT INTO agents VALUES ('0xdef', 'SirSendIt', NULL, 'live', 0);`);
  const insert = opts.premark
    ? raw.prepare("INSERT INTO decisions (id, agent_id, action, symbol, display_name, size_usdg, source, reason, at) VALUES (?,?,?,?,?,?,?,?,?)")
    : raw.prepare("INSERT INTO decisions (id, agent_id, action, symbol, display_name, size_usdg, source, reason, at, mark_usd, mcap_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  for (const d of decisions) {
    const base = [d.id, d.agent ?? "0xabc", d.action, d.symbol, d.display ?? null, d.size ?? null, d.source ?? "brain", d.reason, d.at];
    if (opts.premark) insert.run(...(base as never[]));
    else insert.run(...(base as never[]), (d.mark ?? null) as never, (d.mcap ?? null) as never);
  }
  const trade = raw.prepare(
    "INSERT INTO trades (agent_id, sell_token, buy_token, created_at, decision_id, status, reject_rule, fill_side, fill_price_usd, fill_cash_usdg, realized_pnl_usdg, basis_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const f of fills) {
    // Shaped like the worker's rows: a buy spends USDG for the coin, a sell
    // the reverse.
    const coin = f.token ?? "0xc0170000000000000000000000000000000000c0";
    const [sold, bought] = f.side === "sell" ? [coin, USDG] : [USDG, coin];
    trade.run(f.agent ?? "0xabc", sold, bought, f.at ?? NOW - 100, f.decision, f.status, f.rule ?? null, f.side ?? null, f.price ?? null, f.cash ?? null, f.pnl ?? null, f.basis ?? null);
  }
  return { raw, db };
}

const identities = async () => [
  { tenant: "0x1" as const, slug: SLUG, accounts: ["0xabc" as const], createdAt: 1, updatedAt: 1 },
  { tenant: "0x2" as const, slug: OTHER, accounts: ["0xdef" as const], createdAt: 1, updatedAt: 1 },
];

async function read(decisions: Decision[], fills: Fill[] = [], opts: { premark?: boolean; publicBook?: `0x${string}`[] } = {}) {
  const { raw, db } = await ledger(decisions, fills, opts);
  // Shogun's owner (0x1) is the one who may have opted in; SirSendIt's never did.
  const settings = async (tenant: `0x${string}`) => ({ strategy: "trencher" as const, publicBook: (opts.publicBook ?? []).includes(tenant) });
  try {
    return await readTheses({}, (fn) => fn(db), identities, settings as never);
  } finally {
    raw.close();
  }
}

const buy = (id: string, over: Partial<Decision> = {}): Decision => ({
  id, action: "buy", symbol: COIN, size: 5, display: "JUGGERNAUT", reason: `Entry ${id}: flow flipped to net buying.`, at: NOW - 3600, ...over,
});

describe("a buy is measured from what it paid", () => {
  it("A RECEIPT-BACKED FILL publishes its price", async () => {
    const r = await read([buy("b1")], [{ decision: "b1", status: "landed", side: "buy", price: 0.0004, cash: 5, basis: "receipt" }]);
    assert.equal(r.theses[0]!.entryPriceUsd, 0.0004);
  });

  it("A QUOTED FILL IS AN ESTIMATE, and an estimated entry price is never shown", async () => {
    const r = await read([buy("b1")], [{ decision: "b1", status: "landed", side: "buy", price: 0.0004, cash: 5, basis: "quote" }]);
    assert.equal(r.theses[0]!.outcome, "landed");
    assert.equal(r.theses[0]!.entryPriceUsd, null);
  });

  it("two fills of one post are averaged by what was paid, not by price", async () => {
    // Same words and size, so one post "×2": 4 USDG at 2.00 (2 units) and
    // 6 USDG at 3.00 (2 units) is 10 USDG for 4 units — 2.50, not 2.60.
    const same = { reason: "The schedule says buy.", source: "strategy:steady-basket", symbol: "TSLA", display: null };
    const r = await read(
      [buy("b1", { ...same, at: NOW - 7200 }), buy("b2", { ...same, at: NOW - 3600 })],
      [
        { decision: "b1", status: "paper", side: "buy", price: 2, cash: 4, basis: "paper" },
        { decision: "b2", status: "paper", side: "buy", price: 3, cash: 6, basis: "paper" },
      ],
    );
    assert.equal(r.theses.length, 1);
    assert.equal(r.theses[0]!.said, 2);
    assert.equal(r.theses[0]!.entryPriceUsd, 2.5);
  });

  it("ONE UNEVIDENCED COPY AND THE POST HAS NO ENTRY — a partial average is a guess", async () => {
    const same = { reason: "The schedule says buy.", source: "strategy:steady-basket", symbol: "TSLA", display: null };
    const r = await read(
      [buy("b1", { ...same, at: NOW - 7200 }), buy("b2", { ...same, at: NOW - 3600 })],
      [
        { decision: "b1", status: "paper", side: "buy", price: 2, cash: 4, basis: "paper" },
        { decision: "b2", status: "paper", side: "buy", price: null, cash: 6, basis: "paper" },
      ],
    );
    assert.equal(r.theses[0]!.said, 2);
    assert.equal(r.theses[0]!.entryPriceUsd, null);
  });
});

describe("a sell is measured by what it booked", () => {
  const sell = (id: string, over: Partial<Decision> = {}): Decision => ({
    id, action: "sell", symbol: COIN, size: 6.5, display: "JUGGERNAUT", reason: `Exit ${id}: sellers returned.`, at: NOW - 600, ...over,
  });

  it("realized percent, in public, for everyone", async () => {
    const r = await read([sell("s1")], [{ decision: "s1", status: "landed", side: "sell", price: 0.0005, cash: 6.5, pnl: 1.5, basis: "receipt" }]);
    assert.equal(r.theses[0]!.realizedPct, 30);
    assert.equal(r.theses[0]!.realizedUsd, null, "percentages are the public default");
  });

  it("dollars only for an author whose owner made the book public", async () => {
    const fills: Fill[] = [
      { decision: "s1", status: "landed", side: "sell", price: 0.0005, cash: 6.5, pnl: 1.5, basis: "receipt" },
      { decision: "s2", status: "landed", side: "sell", price: 0.0005, cash: 6.5, pnl: 1.5, basis: "receipt" },
    ];
    const r = await read([sell("s1"), sell("s2", { agent: "0xdef", at: NOW - 700 })], fills, { publicBook: ["0x1"] });
    const shogun = r.theses.find((t) => t.name === "Shogun")!;
    const sir = r.theses.find((t) => t.name === "SirSendIt")!;
    assert.equal(shogun.realizedUsd, 1.5);
    assert.equal(sir.realizedUsd, null, "the other author's book stayed private");
    assert.equal(sir.realizedPct, 30);
  });

  it("NOTHING when the sell's cost was never booked", async () => {
    const r = await read([sell("s1")], [{ decision: "s1", status: "landed", side: "sell", price: 0.0005, cash: 6.5, pnl: null, basis: "receipt" }], { publicBook: ["0x1"] });
    assert.equal(r.theses[0]!.realizedPct, null);
    assert.equal(r.theses[0]!.realizedUsd, null);
  });
});

describe("a view is measured from the price it was posted at", () => {
  const hold = (id: string, over: Partial<Decision> = {}): Decision => ({
    id, action: "hold", symbol: "TSLA", display: null, reason: "TSLA +1.1% over 20h, above its mean.", source: "market-review", at: NOW - 900, ...over,
  });

  it("carries the mark it was written with", async () => {
    const r = await read([hold("h1", { mark: 412.5 })]);
    assert.equal(r.theses[0]!.outcome, "view");
    assert.equal(r.theses[0]!.markUsd, 412.5);
  });

  it("A REPEATED VIEW SEEN AT TWO PRICES HAS NO ONE 'WHEN POSTED' — so no mark", async () => {
    const r = await read([hold("h1", { mark: 410, at: NOW - 1800 }), hold("h2", { mark: 412.5, at: NOW - 900 })]);
    assert.equal(r.theses[0]!.said, 2);
    assert.equal(r.theses[0]!.markUsd, null);
  });

  it("and the same view at one price keeps it", async () => {
    const r = await read([hold("h1", { mark: 410, at: NOW - 1800 }), hold("h2", { mark: 410, at: NOW - 900 })]);
    assert.equal(r.theses[0]!.markUsd, 410);
  });
});

describe("a memecoin carries its size", () => {
  it("the market cap the decision was made at", async () => {
    const r = await read([buy("b1", { mcap: 3_100_000 })], [{ decision: "b1", status: "landed", side: "buy", price: 0.0004, cash: 5, basis: "receipt" }]);
    assert.equal(r.theses[0]!.mcapUsd, 3_100_000);
  });
});

describe("the minute between two deploys", () => {
  it("A LEDGER WITHOUT THE MARK COLUMNS STILL READS — names, fills and all", async () => {
    const r = await read(
      [buy("b1")],
      [{ decision: "b1", status: "landed", side: "buy", price: 0.0004, cash: 5, basis: "receipt" }],
      { premark: true },
    );
    assert.equal(r.source, "sqlite");
    assert.equal(r.theses.length, 1);
    assert.equal(r.theses[0]!.displayName, "JUGGERNAUT", "the name column is still read");
    assert.equal(r.theses[0]!.entryPriceUsd, 0.0004, "and so are the trade's fills, which were never missing");
    assert.equal(r.theses[0]!.markUsd, null);
    assert.equal(r.theses[0]!.mcapUsd, null);
  });
});

describe("a tripped breaker does not fill the trade lane", () => {
  it("THIRTY REFUSED BUYS IN FRESH WORDS, ONE LANDED BUY — only the landed one publishes", async () => {
    const refused = Array.from({ length: 30 }, (_, i) => buy(`r${i}`, { reason: `Review ${i}: five-minute flow turned net positive.`, at: NOW - i * 30 }));
    const fills: Fill[] = refused.map((d) => ({ decision: d.id, status: "rejected", rule: "drawdown-breaker" }));
    const landed = buy("b1", { symbol: "TABCDEF01234", display: "CASHCAT", at: NOW - 5 * 3600 });
    fills.push({ decision: "b1", status: "landed", side: "buy", price: 0.001, cash: 5, basis: "receipt" });
    const r = await read([...refused, landed], fills);
    const trades = r.theses.filter((t) => t.action === "buy");
    assert.equal(trades.length, 1);
    assert.equal(trades[0]!.displayName, "CASHCAT");
    assert.equal(r.tradesComplete, true);
  });
});

describe("a private book's size stays private (D1: a size is dollars)", () => {
  // The review's probe, on the real reader: SirSendIt's owner never opened the
  // book, Shogun's did. With the size public, "sell AAPL 4.00 USDG" beside
  // −20% realized WAS the −1.00 USDG the dollar gate withheld.
  const sir = (over: Partial<Decision> = {}): Decision => ({
    id: "p1", agent: "0xdef", action: "sell", symbol: "AAPL", size: 4, reason: "Cutting AAPL.", at: NOW - 900, display: null, ...over,
  });
  const sirFill: Fill = { decision: "p1", status: "landed", side: "sell", price: 200, cash: 4, pnl: -1, basis: "receipt" };

  it("THE REVIEW'S PROBE: a private −20% sell carries its percent and no size, in the field or the sentence", async () => {
    const r = await read([sir()], [sirFill], { publicBook: ["0x1"] });
    const post = r.theses[0]!;
    assert.equal(post.realizedPct, -20);
    assert.equal(post.realizedUsd, null);
    assert.equal(post.sizeUsdg, null);
    assert.equal(post.head, "sell AAPL");
    assert.ok(!/4\.00|USDG/.test(JSON.stringify(post)), "no size anywhere a reader can fetch");
  });

  it("a private buy's size over its entry price was its holding — withheld", async () => {
    const r = await read([buy("b1")], [{ decision: "b1", status: "landed", side: "buy", price: 0.0004, cash: 5, basis: "receipt" }]);
    assert.equal(r.theses[0]!.entryPriceUsd, 0.0004);
    assert.equal(r.theses[0]!.sizeUsdg, null);
    assert.equal(r.theses[0]!.head, "buy JUGGERNAUT (T3139F043B88)");
  });

  it("A PUBLIC BOOK keeps its size, its sized head and its dollars", async () => {
    const r = await read([sir({ agent: "0xabc" })], [sirFill], { publicBook: ["0x1"] });
    const post = r.theses[0]!;
    assert.equal(post.sizeUsdg, 4);
    assert.equal(post.head, "sell AAPL 4.00 USDG");
    assert.equal(post.realizedUsd, -1);
  });

  it("THE LIKE KEY DOES NOT HASH THE SIZE IT WITHHOLDS — post-id.ts publishes the id beside its preimage", async () => {
    // A size is a handful of round numbers; a hash of an otherwise-published
    // preimage plus the size is an encoding of the size. So a private post's
    // id is built from the post as published — without it.
    const { postIdOf } = await import("./post-id");
    const priv = (await read([sir()], [sirFill])).theses[0]!;
    assert.equal(priv.postId, postIdOf({ slug: OTHER, action: "sell", symbol: "AAPL", sizeUsdg: null, reason: "Cutting AAPL.", shadow: false }));
    for (const guess of [1, 2, 3, 4, 5, 10]) {
      assert.notEqual(priv.postId, postIdOf({ slug: OTHER, action: "sell", symbol: "AAPL", sizeUsdg: guess, reason: "Cutting AAPL.", shadow: false }), String(guess));
    }
    // A public book's id is what it always was, so a like cast on it stays.
    const pub = (await read([sir({ agent: "0xabc" })], [sirFill], { publicBook: ["0x1"] })).theses[0]!;
    assert.equal(pub.postId, postIdOf({ slug: SLUG, action: "sell", symbol: "AAPL", sizeUsdg: 4, reason: "Cutting AAPL.", shadow: false }));
  });
});

describe("a sell's realized return is only as read as the basis it closed", () => {
  // FD5. The fold checked `basis_source` on the SELL's own row. But the P&L a
  // sell books is its proceeds minus the average cost of what it closed, and
  // that cost was booked by the BUYS — one of which may have been booked from
  // the pre-trade quote because its receipt could not be read (index.ts logs
  // "cost basis booked from the quote (an estimate)"). A receipt-read sell over
  // an estimated basis is an estimated return, published as a read one.
  const TSLA = "0x7e5a000000000000000000000000000000007e5a";
  const bought = (id: string, over: Partial<Decision> = {}): Decision =>
    ({ id, action: "buy", symbol: "TSLA", size: 5, display: null, reason: `Buying TSLA ${id}.`, at: NOW - 7200, ...over });
  const sold: Decision = { id: "s1", action: "sell", symbol: "TSLA", size: 6.5, display: null, reason: "Selling TSLA.", at: NOW - 600 };
  const sellFill: Fill = { decision: "s1", status: "landed", side: "sell", price: 250, cash: 6.5, pnl: 1.5, basis: "receipt", token: TSLA, at: NOW - 600 };
  const buyFill = (decision: string, basis: string, over: Partial<Fill> = {}): Fill =>
    ({ decision, status: basis === "paper" ? "paper" : "landed", side: "buy", price: 200, cash: 5, pnl: 0, basis, token: TSLA, at: NOW - 7200, ...over });
  const realized = async (decisions: Decision[], fills: Fill[]) =>
    (await read(decisions, fills)).theses.find((t) => t.action === "sell")!.realizedPct;

  it("A BUY BOOKED FROM THE QUOTE MAKES THE SELL'S RETURN AN ESTIMATE — and an estimate is not shown", async () => {
    assert.equal(await realized([bought("b1"), sold], [buyFill("b1", "quote"), sellFill]), null);
  });

  it("the same round trip on a receipt-read buy is measured", async () => {
    assert.equal(await realized([bought("b1"), sold], [buyFill("b1", "receipt"), sellFill]), 30);
  });

  it("one estimated buy among several is enough — the average cost carries every one", async () => {
    const fills = [buyFill("b1", "receipt"), buyFill("b2", "quote", { at: NOW - 3600 }), sellFill];
    assert.equal(await realized([bought("b1"), bought("b2", { at: NOW - 3600 }), sold], fills), null);
  });

  it("the token is matched as an address, whatever its case", async () => {
    const fills = [buyFill("b1", "quote", { token: TSLA.toUpperCase().replace("0X", "0x") }), sellFill];
    assert.equal(await realized([bought("b1"), sold], fills), null);
  });

  it("ONLY THIS AGENT'S BUYS OF THIS COIN, BEFORE THE SELL, built its basis", async () => {
    // Another agent's estimated buy of the same coin is another book.
    assert.equal(await realized([bought("b1", { agent: "0xdef" }), sold], [buyFill("b1", "quote", { agent: "0xdef" }), sellFill]), 30);
    // An estimated buy of a different coin is another position.
    assert.equal(await realized([bought("b1"), sold], [buyFill("b1", "quote", { token: "0x0000000000000000000000000000000000000bad" }), sellFill]), 30);
    // An estimated buy AFTER the sell opened the next position, not this one.
    assert.equal(await realized([bought("b1", { at: NOW - 60 }), sold], [buyFill("b1", "quote", { at: NOW - 60 }), sellFill]), 30);
  });

  it("a paper sell closes the paper book, which no quoted fill ever touches", async () => {
    const paperSell: Fill = { ...sellFill, status: "paper", basis: "paper" };
    assert.equal(await realized([bought("b1"), sold], [buyFill("b1", "quote"), paperSell]), 30);
  });
});
