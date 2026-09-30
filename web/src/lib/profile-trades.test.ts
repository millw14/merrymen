import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { BASIS_REPLAY_ROWS, OPENING_READ_LIMIT, TOP_TRADES_SCAN_ROWS, readProfileTrades, readRoundTrips, readTopTrades, vouchedSells } from "./profile-trades";
import { averageHoldSec } from "./hold-time";
import { STOCK_TOKENS } from "../../../packages/core/src/tokens";

test("profile history reads fills beyond the social window, keeps repeats, and respects book privacy", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT);
      CREATE TABLE trades(id INTEGER, decision_id TEXT, agent_id TEXT, epoch INTEGER, kind TEXT, fill_side TEXT, status TEXT, created_at INTEGER, amount_usdg REAL);
      INSERT INTO decisions VALUES ('d','a','buy','USAR',NULL);
      INSERT INTO trades VALUES
      (1,'d','a',1,'swap','buy','landed',1,12),
      (2,'d','a',1,'swap','buy','landed',2,12),
      (3,NULL,'a',1,'curve-trade','sell','paper',3,5),
      (4,'d','a',1,'swap','buy','rejected',4,50),
      (5,'d','a',1,'transfer','sell','landed',5,50),
      (6,'d','other',1,'swap','buy','landed',6,50),
      (7,'d','a',2,'swap','buy','landed',7,50);`);
    await db.exec("ALTER TABLE trades ADD COLUMN fill_symbol TEXT; ALTER TABLE trades ADD COLUMN buy_token TEXT; ALTER TABLE trades ADD COLUMN sell_token TEXT; ALTER TABLE trades ADD COLUMN user_op_hash TEXT;");
    await db.exec("ALTER TABLE trades ADD COLUMN realized_pnl_usdg REAL; ALTER TABLE trades ADD COLUMN fill_cash_usdg REAL; ALTER TABLE trades ADD COLUMN basis_source TEXT;");
    const privateBook = await readProfileTrades(db, "a", 1, false);
    assert.equal(privateBook.read, true);
    assert.deepEqual(privateBook.trades.map(t => t.id), ["3", "2", "1"]);
    assert.equal(privateBook.trades[0].paper, true);
    assert.equal(privateBook.trades[1].symbol, "USAR");
    assert.ok(privateBook.trades.every(t => t.sizeUsdg === null));
    assert.ok(privateBook.trades.every(t => !('agent_id' in t)));
    const published = await readProfileTrades(db, "a", 1, true);
    assert.equal(published.trades[1].sizeUsdg, 12);
    await db.exec("UPDATE decisions SET symbol = '0x0123456789abcdef0123456789abcdef01234567'");
    assert.equal((await readProfileTrades(db, "a", 1, true)).trades[1].symbol, null);
    await db.prepare("UPDATE trades SET decision_id = NULL, fill_side = NULL, buy_token = ? WHERE id = 1").run(STOCK_TOKENS[0].address);
    const legacy = (await readProfileTrades(db, "a", 1, false)).trades.find(t => t.id === "1");
    assert.equal(legacy?.action, "buy");
    assert.equal(legacy?.symbol, STOCK_TOKENS[0].symbol);
    await db.exec("UPDATE trades SET buy_token = NULL WHERE id = 1");
    assert.equal((await readProfileTrades(db, "a", 1, false)).trades.find(t => t.id === "1")?.action, "swap");
  } finally { raw.close(); }
});

test("paper and live sales publish evidenced P&L without exposing private amounts", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT);
      CREATE TABLE trades(id INTEGER, decision_id TEXT, agent_id TEXT, epoch INTEGER, kind TEXT, fill_side TEXT, status TEXT, created_at INTEGER, amount_usdg REAL, buy_token TEXT, sell_token TEXT, realized_pnl_usdg REAL, fill_cash_usdg REAL, basis_source TEXT);
      INSERT INTO trades VALUES
        (1,NULL,'a',1,'swap','sell','paper',1,12,'0xusdg','0xc1',2,12,'paper'),
        (2,NULL,'a',1,'swap','sell','landed',2,8,'0xusdg','0xc2',-2,8,'receipt'),
        (3,NULL,'a',1,'swap','sell','paper',3,10,'0xusdg','0xc3',0,10,'paper'),
        (4,NULL,'a',1,'swap','sell','paper',4,10,'0xusdg','0xc4',NULL,10,'paper'),
        (5,NULL,'a',1,'swap','sell','landed',5,10,'0xusdg','0xc5',2,12,'quote'),
        (6,NULL,'a',1,'swap','buy','paper',6,10,'0xc6','0xusdg',2,12,'paper');`);
    await db.exec("ALTER TABLE trades ADD COLUMN fill_symbol TEXT; ALTER TABLE trades ADD COLUMN user_op_hash TEXT; ALTER TABLE trades ADD COLUMN fill_qty_raw TEXT");
    const privateRows = (await readProfileTrades(db, 'a', 1, false)).trades;
    assert.deepEqual(privateRows.map(t => t.realizedPnlBps), [null, null, null, 0, -2000, 2000]);
    assert.ok(privateRows.every(t => t.realizedPnlUsdg === null && t.sizeUsdg === null));
    const publicRows = (await readProfileTrades(db, 'a', 1, true)).trades;
    assert.deepEqual(publicRows.map(t => t.realizedPnlUsdg), [null, null, null, 0, -2, 2]);
    await db.exec('UPDATE trades SET fill_cash_usdg = NULL WHERE id = 1');
    assert.equal((await readProfileTrades(db, 'a', 1, true)).trades.find(t => t.id === '1')?.realizedPnlBps, null);
  } finally { raw.close(); }
});

test("a redeploy's re-recorded copy of a fill never stands in for the fill", async () => {
  // The production shape: the executor's row carries the side, the decision and
  // the coin; after a redeploy the reconciler writes the same op again as a bare
  // 'swap' stamped at the restart, and the mirror carried it up beside the
  // original. Newest-first, the copy came first and read "Swapped token".
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT);
      CREATE TABLE trades(id INTEGER, decision_id TEXT, agent_id TEXT, epoch INTEGER, kind TEXT, fill_side TEXT, status TEXT,
        created_at INTEGER, amount_usdg REAL, user_op_hash TEXT, fill_symbol TEXT, buy_token TEXT, sell_token TEXT,
        realized_pnl_usdg REAL, fill_cash_usdg REAL, basis_source TEXT);
      INSERT INTO decisions VALUES ('d','a','buy','CASHCAT','Cash Cat'), ('e','a','buy','CHUMP','CHUMP');
      INSERT INTO trades (id, decision_id, agent_id, epoch, kind, fill_side, status, created_at, amount_usdg, user_op_hash) VALUES
        (1,'d','a',1,'curve-trade','buy','landed',1000,5,'0xOPHASH'),
        (2,NULL,'a',1,'swap',NULL,'landed',5000,5,'0xophash'),
        (3,NULL,'a',1,'vault-deposit',NULL,'landed',1500,5,'0xvault'),
        (4,NULL,'a',1,'swap',NULL,'landed',5000,5,'0xVAULT'),
        (5,'e','a',1,'curve-trade','buy','landed',1600,5,'0xchump');`);
    const { trades, read } = await readProfileTrades(db, "a", 1, false);
    assert.equal(read, true);
    // Row 2 is row 1 written again; row 4 is a vault deposit written again as a
    // 'swap', and it must not surface as a trade merely because the original
    // is a kind this list does not show.
    assert.deepEqual(trades.map(t => t.id), ["5", "1"]);
    assert.equal(trades[1].action, "buy");
    assert.equal(trades[1].symbol, "CASHCAT");
    assert.equal(trades[1].displayName, "Cash Cat", "the coin's own name travels with the fill");
    assert.equal(trades[0].displayName, null, "a name that only repeats the symbol adds nothing");
  } finally { raw.close(); }
});

test("a missing trades table reports unavailable rather than an empty history", async () => {
  const raw = new DatabaseSync(":memory:");
  try { assert.equal((await readProfileTrades(wrapSqlite(raw), "a", 1, false)).read, false); }
  finally { raw.close(); }
});

/**
 * The production columns a top-trades read touches, on a real sqlite ledger.
 * Every row is a sell unless it says otherwise.
 */
async function sellsLedger() {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await db.exec(`CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT);
    CREATE TABLE trades(id INTEGER, decision_id TEXT, agent_id TEXT, epoch INTEGER, kind TEXT, fill_side TEXT, status TEXT,
      created_at INTEGER, amount_usdg REAL, user_op_hash TEXT, fill_symbol TEXT, buy_token TEXT, sell_token TEXT,
      realized_pnl_usdg REAL, fill_cash_usdg REAL, basis_source TEXT, fill_qty_raw TEXT);`);
  return { raw, db };
}
const sellRow = (id: number, pnl: number | null, cash: number | null, over: Record<string, unknown> = {}) => ({
  id, decision_id: null, agent_id: "a", epoch: 1, kind: "swap", fill_side: "sell", status: "landed", created_at: id,
  amount_usdg: 5, user_op_hash: `0xop${id}`, fill_symbol: `C${id}`, buy_token: "0xusdg", sell_token: `0xtok${id}`,
  realized_pnl_usdg: pnl, fill_cash_usdg: cash, basis_source: "receipt", fill_qty_raw: "1", ...over,
});
async function insert(db: ReturnType<typeof wrapSqlite>, rows: Record<string, unknown>[]) {
  for (const r of rows) {
    const cols = Object.keys(r);
    await db.prepare(`INSERT INTO trades (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(r) as never[]));
  }
}

test("TOP TRADES are the best evidenced sells by RETURN, not by dollars, and only five", async () => {
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      // +10 on a cost of 100 = +10%: the biggest dollar win, not the best trade.
      sellRow(1, 10, 110),
      // +5 on a cost of 10 = +50%.
      sellRow(2, 5, 15),
      sellRow(3, 1, 11), // +10% on 10
      sellRow(4, 3, 13), // +30%
      sellRow(5, -2, 8), // -20%
      sellRow(6, 2, 12), // +20%
      sellRow(7, 0.5, 10.5), // +5%
    ]);
    const { trades, read } = await readTopTrades(db, "a", 1, false, "landed");
    assert.equal(read, true);
    // 1 and 3 tie at +10%; the newer one ranks first.
    assert.deepEqual(trades.map((t) => t.id), ["2", "4", "6", "3", "1"], "ranked by bps, cut at five");
    assert.deepEqual(trades.map((t) => t.realizedPnlBps), [5000, 3000, 2000, 1000, 1000]);
    assert.ok(trades.every((t) => t.action === "sell"));
    assert.ok(trades.every((t) => t.realizedPnlUsdg === null && t.sizeUsdg === null), "a private book shows no dollars");
    const pub = await readTopTrades(db, "a", 1, true, "landed");
    assert.equal(pub.trades[0].realizedPnlUsdg, 5, "and a public one does");
  } finally { raw.close(); }
});

test("a top trade is EVIDENCED, in this book, after the dedupe", async () => {
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      sellRow(1, 1, 11), // +10%, the only honest one
      sellRow(2, 9, 10, { basis_source: "quote" }), // a quote is an estimate
      sellRow(3, 9, 10, { status: "paper", basis_source: "paper" }), // the other book
      sellRow(4, 9, 10, { kind: "transfer" }), // not a trade
      sellRow(5, 9, 10, { agent_id: "b" }), // not this agent
      sellRow(6, 9, 10, { epoch: 2 }), // not this period
      sellRow(7, 9, 10, { fill_side: "buy" }), // not a sell
      sellRow(8, null, 10), // P&L never attributed
      sellRow(9, 9, 9), // no cost left to divide by
      sellRow(10, 9, null), // cash leg unread
      // A redeploy's copy of op 1, stamped later, carrying a wild figure: it
      // collapses into op 1 and never stands as a trade of its own.
      sellRow(11, 50, 60, { user_op_hash: "0xOP1", created_at: 999 }),
    ]);
    const live = await readTopTrades(db, "a", 1, false, "landed");
    assert.deepEqual(live.trades.map((t) => t.id), ["1"]);
    const paper = await readTopTrades(db, "a", 1, false, "paper");
    assert.deepEqual(paper.trades.map((t) => t.id), ["3"], "a paper agent ranks its paper sells");
    assert.equal(paper.trades[0].paper, true);
  } finally { raw.close(); }
});

test("the ranking sees only what the page will print, so estimates cannot crowd a real trade out of the five", async () => {
  // Filtering after the LIMIT would rank five quoted or mis-sided rows first,
  // drop them all, and publish "No closed trades yet" over a real +10%.
  const { raw, db } = await sellsLedger();
  try {
    const crowd = [1, 2, 3, 4, 5].map((i) => sellRow(i, 9, 10, { basis_source: "quote" }));
    const buys = [6, 7, 8, 9, 10].map((i) => sellRow(i, 9, 10, { fill_side: "buy" }));
    await insert(db, [...crowd, ...buys, sellRow(11, 1, 11)]);
    assert.deepEqual((await readTopTrades(db, "a", 1, false, "landed")).trades.map((t) => t.id), ["11"]);
  } finally { raw.close(); }
});

test("no closed trades is an empty list that was READ; a broken ledger is not", async () => {
  const { raw, db } = await sellsLedger();
  try {
    assert.deepEqual(await readTopTrades(db, "a", 1, false, "landed"), { trades: [], read: true });
  } finally { raw.close(); }
  const bare = new DatabaseSync(":memory:");
  try { assert.equal((await readTopTrades(wrapSqlite(bare), "a", 1, false, "landed")).read, false); }
  finally { bare.close(); }
});

test("round trips read every fill of the book, oldest first, keyed by the token each one moved", async () => {
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      // The buy's token and the sell's meet whatever case each was written in.
      sellRow(1, null, null, { fill_side: "buy", fill_symbol: "CASH", buy_token: "0xCASH", sell_token: "0xusdg", fill_qty_raw: "10", created_at: 100 }),
      sellRow(2, 1, 6, { fill_symbol: "CASH", sell_token: "0xcash", fill_qty_raw: "10", created_at: 400 }),
      // A stock fill that predates fill_side and fill_symbol: the executed pair names it.
      sellRow(3, null, null, { fill_side: null, fill_symbol: null, buy_token: STOCK_TOKENS[0].address, sell_token: "0xusdg", fill_qty_raw: "2", created_at: 500 }),
      sellRow(4, null, null, { status: "paper", basis_source: "paper", created_at: 50 }), // the other book
      sellRow(5, null, null, { status: "rejected", created_at: 60 }), // filled nothing
      // A redeploy's copy of op 2: collapses into it rather than reading as a fill with no quantity.
      sellRow(6, null, null, { user_op_hash: "0xOP2", fill_side: null, fill_symbol: null, fill_qty_raw: null, basis_source: null, created_at: 999 }),
    ]);
    const r = await readRoundTrips(db, "a", 1, "landed");
    assert.ok(r);
    assert.equal(r.truncated, false);
    assert.deepEqual(r.fills.map((f) => [f.side, f.coin, f.qty, f.at]), [
      ["buy", "0xcash", 10n, 100],
      ["sell", "0xcash", 10n, 400],
      ["buy", STOCK_TOKENS[0].address.toLowerCase(), 2n, 500],
    ]);
    assert.deepEqual(r.opening, new Map(), "nothing before the period, so nothing carried");
    assert.equal(averageHoldSec(r.fills, r.opening, r.dust), 300);
    // A cap the read reaches says so: the count becomes a floor, and the hold —
    // which needs the earliest buys — is not computed from a partial tape.
    const capped = await readRoundTrips(db, "a", 1, "landed", 2);
    assert.equal(capped?.truncated, true);
    assert.equal(capped?.fills.length, 2);
  } finally { raw.close(); }
  const bare = new DatabaseSync(":memory:");
  try { assert.equal(await readRoundTrips(wrapSqlite(bare), "a", 1, "landed"), null, "unread is null, never an empty history"); }
  finally { bare.close(); }
});

test("a fill whose quantity or coin was not recorded is carried as unread", async () => {
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      sellRow(1, null, null, { fill_side: "buy", buy_token: "0xcash", sell_token: "0xusdg", fill_qty_raw: "10", created_at: 100 }),
      sellRow(2, 1, 6, { sell_token: "0xcash", fill_qty_raw: null, created_at: 400 }),
      sellRow(3, null, null, { fill_side: "buy", buy_token: null, fill_qty_raw: "3", created_at: 500 }),
      // Neither the fill, its decision nor the executed pair says which way it went.
      sellRow(4, null, null, { fill_side: null, fill_symbol: "CASH", buy_token: "0xcash", fill_qty_raw: "4", created_at: 600 }),
    ]);
    const r = await readRoundTrips(db, "a", 1, "landed");
    assert.deepEqual(r?.fills.map((f) => [f.side, f.coin, f.qty]), [["buy", "0xcash", 10n], ["sell", "0xcash", null], ["buy", null, 3n], [null, null, 4n]]);
    assert.equal(averageHoldSec(r!.fills, r!.opening, r!.dust), null);
  } finally { raw.close(); }
});

// ── PF2: what the book carried into the period is sold first ─────────────────
const heldBuy = (id: number, token: string, qty: string, at: number, over: Record<string, unknown> = {}) =>
  sellRow(id, null, null, { fill_side: "buy", buy_token: token, sell_token: "0xusdg", fill_qty_raw: qty, created_at: at, ...over });
const heldSell = (id: number, token: string, qty: string, at: number, over: Record<string, unknown> = {}) =>
  sellRow(id, null, null, { sell_token: token, fill_qty_raw: qty, created_at: at, ...over });

test("a trim of a position carried into the period is no round trip of the period", async () => {
  // The reviewer's case: 1,000 TSLA held from the last period, 10 bought and
  // 10 trimmed a minute apart. Under FIFO the trim sold carried units.
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      heldBuy(1, "0xtsla", "1000", 10, { epoch: 0 }),
      heldBuy(2, "0xtsla", "10", 100),
      heldSell(3, "0xtsla", "10", 160),
    ]);
    const r = (await readRoundTrips(db, "a", 1, "landed"))!;
    assert.deepEqual(r.opening, new Map([["0xtsla", 1_000n]]));
    assert.equal(r.fills.length, 2, "the count is this period's fills only");
    assert.equal(averageHoldSec(r.fills, r.opening, r.dust), null);
  } finally { raw.close(); }
});

test("a position sold out before the period carries nothing, and an estimated one is unknown", async () => {
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      heldBuy(1, "0xtsla", "1000", 10, { epoch: 0 }),
      heldSell(2, "0xtsla", "1000", 20, { epoch: 0 }),
      heldBuy(3, "0xtsla", "10", 100),
      heldSell(4, "0xtsla", "10", 160),
    ]);
    const flat = (await readRoundTrips(db, "a", 1, "landed"))!;
    assert.equal(averageHoldSec(flat.fills, flat.opening, flat.dust), 60);
    // Bought last period from the quote: what arrived was never read.
    await insert(db, [heldBuy(5, "0xcat", "1000", 30, { epoch: 0, basis_source: "quote" }), heldBuy(6, "0xcat", "10", 200), heldSell(7, "0xcat", "10", 260)]);
    const estimated = (await readRoundTrips(db, "a", 1, "landed"))!;
    assert.equal(estimated.opening?.get("0xcat"), null);
    assert.equal(averageHoldSec(estimated.fills, estimated.opening, estimated.dust), null);
  } finally { raw.close(); }
});

test("a paper carry stands only on the period's first valuation, because a reset clears the book without a fill", async () => {
  const ONE = "1000000000000000000";
  const paper = { status: "paper", basis_source: "paper", user_op_hash: null };
  const { raw, db } = await sellsLedger();
  try {
    await db.exec(`CREATE TABLE equity(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, epoch INTEGER, mode TEXT,
      cash_usdg REAL, vault_usdg REAL, positions_usdg REAL, equity_usdg REAL, at INTEGER)`);
    await insert(db, [
      heldBuy(1, "0xtsla", ONE, 10, { ...paper, epoch: 0 }),
      heldBuy(2, "0xtsla", ONE, 100, paper),
      heldSell(3, "0xtsla", ONE, 160, paper),
      heldSell(4, "0xtsla", ONE, 220, paper),
    ]);
    // Carried: the sell at 160 closes the carried share and the one at 220 the
    // share bought at 100 (120s). Reset: the sell at 160 closes that share (60s).
    const hold = async () => { const r = (await readRoundTrips(db, "a", 1, "paper"))!; return averageHoldSec(r.fills, r.opening, r.dust); };
    assert.equal(await hold(), null, "no valuation: a reset and a carry look the same");
    // The book's composition, as the worker writes it: equity is cash + vault +
    // positions + the cost of holdings it cannot price (composeEquityUsdg).
    const mark = (positions: number, at: number, quarantined = 0) =>
      db.prepare("INSERT INTO equity (agent_id, epoch, mode, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at) VALUES ('a', 1, 'paper', 900, 0, ?, ?, ?)")
        .run(positions, 900 + positions + quarantined, at);
    await mark(0, 50);
    assert.equal(await hold(), 60, "nothing held when the period opened: the book was reset");
    await db.exec("DELETE FROM equity");
    await mark(25, 50);
    assert.equal(await hold(), 120, "positions held when it opened: the first sell sold the carried share");
    await db.exec("DELETE FROM equity");
    await mark(0, 200);
    assert.equal(await hold(), null, "a valuation taken after the first fill says nothing about the opening");
    // CP3: nothing priced, but the total carries 5 USDG more than cash and
    // vault — a holding the worker cannot price, kept at cost outside
    // `positions`. A zero there is not a flat book.
    await db.exec("DELETE FROM equity");
    await mark(0, 50, 5);
    assert.equal(await hold(), null, "a book holding only what it cannot price was not reset");
    await db.exec("DELETE FROM equity");
    await db.prepare("INSERT INTO equity (agent_id, epoch, mode, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at) VALUES ('a', 1, 'paper', NULL, NULL, 0, NULL, 50)").run();
    assert.equal(await hold(), null, "a composition nobody wrote cannot show that nothing was held");
    // The funded book is never reset, and its valuation proves nothing.
    await db.exec("DELETE FROM equity");
    await mark(0, 50);
    await insert(db, [heldBuy(4, "0xnvda", "5", 10, { epoch: 0 }), heldBuy(5, "0xnvda", "5", 100), heldSell(6, "0xnvda", "5", 160)]);
    const live = (await readRoundTrips(db, "a", 1, "landed"))!;
    assert.equal(averageHoldSec(live.fills, live.opening, live.dust), null);
  } finally { raw.close(); }
});

// ── PF4: a top trade's return rests on an evidenced cost ─────────────────────
const buyRow = (id: number, token: string, qty: string, over: Record<string, unknown> = {}) =>
  sellRow(id, null, null, { fill_side: "buy", buy_token: token, sell_token: "0xusdg", fill_qty_raw: qty, ...over });

test("a sell whose cost a QUOTED buy built is not a top trade, however good it looks", async () => {
  // realized_pnl_usdg is proceeds minus the running cost basis, and a buy whose
  // receipt could not be read books that basis from the quote — an estimate.
  // Checking only the sell's own basis_source let such a sell rank first.
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      buyRow(1, "0xmeme", "10", { basis_source: "quote" }),
      sellRow(2, 9, 10, { sell_token: "0xmeme", fill_qty_raw: "10" }), // +900% on an estimated cost
      sellRow(3, 1, 11), // +10%, on no estimate at all
    ]);
    assert.deepEqual((await readTopTrades(db, "a", 1, false, "landed")).trades.map((t) => t.id), ["3"]);
  } finally { raw.close(); }
});

test("an estimate stops counting once the position it built was sold out", async () => {
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      buyRow(1, "0xmeme", "10", { basis_source: "quote" }),
      sellRow(2, 9, 10, { sell_token: "0xmeme", fill_qty_raw: "10" }), // closes the estimated lot: not vouched
      buyRow(3, "0xmeme", "5"), // a fresh position, from a receipt
      sellRow(4, 2, 6, { sell_token: "0xmeme", fill_qty_raw: "5" }), // +50%, on that receipt alone
    ]);
    assert.deepEqual((await readTopTrades(db, "a", 1, false, "landed")).trades.map((t) => t.id), ["4"]);
    // A PARTIAL sell leaves the estimate in what is still held.
    await insert(db, [buyRow(5, "0xcat", "10", { basis_source: "quote" }), sellRow(6, 1, 2, { sell_token: "0xcat", fill_qty_raw: "4" }), sellRow(7, 1, 2, { sell_token: "0xcat", fill_qty_raw: "6" })]);
    assert.deepEqual((await readTopTrades(db, "a", 1, false, "landed")).trades.map((t) => t.id), ["4"]);
  } finally { raw.close(); }
});

test("a cost carried in from an earlier period is still that cost", async () => {
  // cost_basis is not epoch-scoped: a position bought last period is sold
  // against the basis that period booked.
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      buyRow(1, "0xmeme", "10", { basis_source: "quote", epoch: 0 }),
      sellRow(2, 9, 10, { sell_token: "0xmeme", fill_qty_raw: "10" }),
    ]);
    assert.deepEqual((await readTopTrades(db, "a", 1, false, "landed")).trades, []);
  } finally { raw.close(); }
});

test("a movement the ledger cannot size keeps an estimate in, because flat can no longer be told", async () => {
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      buyRow(1, "0xmeme", "10", { basis_source: "quote" }),
      // The reconciler booked a cost for an op it recovered, and wrote no side.
      sellRow(2, null, null, { fill_side: null, buy_token: "0xmeme", sell_token: "0xusdg", fill_qty_raw: null, basis_source: "receipt" }),
      sellRow(3, 1, 2, { sell_token: "0xmeme", fill_qty_raw: "10" }),
      buyRow(4, "0xmeme", "5"),
      sellRow(5, 1, 2, { sell_token: "0xmeme", fill_qty_raw: "5" }),
    ]);
    assert.deepEqual((await readTopTrades(db, "a", 1, false, "landed")).trades, []);
  } finally { raw.close(); }
});

test("estimates ranked above a real trade cannot push it out of the list, past the first page too", async () => {
  const { raw, db } = await sellsLedger();
  try {
    const rows: Record<string, unknown>[] = [];
    for (let i = 1; i <= 30; i++) {
      rows.push(buyRow(100 + i, `0xq${i}`, "1", { basis_source: "quote", created_at: i }));
      rows.push(sellRow(200 + i, 9, 10, { sell_token: `0xq${i}`, created_at: 1_000 + i }));
    }
    rows.push(sellRow(300, 1, 11, { created_at: 2_000 }));
    await insert(db, rows);
    assert.deepEqual((await readTopTrades(db, "a", 1, false, "landed")).trades.map((t) => t.id), ["300"]);
  } finally { raw.close(); }
});

// ── CP1: a replay cut short says so, and one coin's volume cannot cut another's ──
/**
 * `pairs` receipt round trips of each coin — every buy 10 units for a cost of
 * 10, every sell +1 on it, so +10% — with the coins INTERLEAVED in time, the
 * way a basket trades them, so one page of ranked candidates holds all of them.
 */
function busyBook(raw: DatabaseSync, coins: readonly string[], pairs: number, firstId = 1) {
  const ins = raw.prepare(`INSERT INTO trades (id, agent_id, epoch, kind, fill_side, status, created_at, amount_usdg, user_op_hash, fill_symbol,
      buy_token, sell_token, realized_pnl_usdg, fill_cash_usdg, basis_source, fill_qty_raw)
    VALUES (?, 'a', 1, 'swap', ?, 'landed', ?, 5, ?, ?, ?, ?, ?, ?, 'receipt', '10')`);
  raw.exec("BEGIN");
  let id = firstId - 1;
  for (let i = 0; i < pairs; i++) {
    for (const coin of coins) {
      const symbol = coin.slice(2).toUpperCase();
      id += 1;
      ins.run(id, "buy", id, `0xbuy${id}`, symbol, coin, "0xusdg", null, 10);
      id += 1;
      ins.run(id, "sell", id, `0xsell${id}`, symbol, "0xusdg", coin, 1, 11);
    }
  }
  raw.exec("COMMIT");
}

test("each coin's cost is replayed on its own, so a busy basket's coins are not cut short together", async () => {
  // The replay read every coin of a page in one query under one cap, so a
  // basket whose coins TOGETHER passed it vouched for nothing — and TOP TRADES
  // came back an empty list read as true: "No closed trades yet" over hundreds.
  const coins = ["0xa1", "0xa2", "0xa3"];
  const pairs = Math.ceil(BASIS_REPLAY_ROWS / 4) + 1;
  assert.ok(2 * pairs + 1 < BASIS_REPLAY_ROWS && 2 * pairs * coins.length > BASIS_REPLAY_ROWS, "each coin fits one replay; together they do not");
  const { raw, db } = await sellsLedger();
  try {
    // A1's first lot was bought from the quote and never sold out, so every A1
    // sell stands on that estimate — which only a replay of A1's WHOLE history
    // can see: a cap shared across the coins would cut exactly that row off.
    await insert(db, [buyRow(0, "0xa1", "10", { basis_source: "quote", created_at: 0, fill_symbol: "A1" })]);
    busyBook(raw, coins, pairs);
    const top = await readTopTrades(db, "a", 1, false, "landed");
    assert.equal(top.read, true);
    assert.deepEqual(top.trades.map((t) => [t.symbol, t.realizedPnlBps]), [["A3", 1_000], ["A2", 1_000], ["A3", 1_000], ["A2", 1_000], ["A3", 1_000]]);
    const list = await readProfileTrades(db, "a", 1, false);
    const sells = list.trades.filter((t) => t.action === "sell");
    assert.equal(sells.length, 50);
    assert.ok(sells.every((t) => t.realizedPnlBps === (t.symbol === "A1" ? null : 1_000)), "every listed sell keeps the return its own coin's whole history gives it");
  } finally { raw.close(); }
});

test("a coin with exactly as many fills as one replay reads was read whole", async () => {
  const { raw, db } = await sellsLedger();
  try {
    busyBook(raw, ["0xedge"], BASIS_REPLAY_ROWS / 2);
    const top = await readTopTrades(db, "a", 1, false, "landed");
    assert.equal(top.read, true);
    assert.equal(top.trades.length, 5);
  } finally { raw.close(); }
});

test("a coin traded more often than one replay reads leaves TOP TRADES unread — never 'no closed trades'", async () => {
  const { raw, db } = await sellsLedger();
  try {
    busyBook(raw, ["0xbusy"], BASIS_REPLAY_ROWS / 2 + 1);
    assert.deepEqual(await readTopTrades(db, "a", 1, false, "landed"), { trades: [], read: false });
    // A checked trade ranked BELOW the unchecked ones cannot stand in for the
    // list: any of them might belong above it.
    await insert(db, [buyRow(20_001, "0xcalm", "10", { created_at: 20_001 }), sellRow(20_002, 0.5, 10.5, { sell_token: "0xcalm", fill_qty_raw: "10", created_at: 20_002 })]);
    assert.deepEqual(await readTopTrades(db, "a", 1, false, "landed"), { trades: [], read: false });
    // Buys & sells still lists every fill it read; the busy coin's sells carry
    // no return, because their cost could not be checked — the checked one does.
    const list = await readProfileTrades(db, "a", 1, false);
    assert.equal(list.read, true);
    assert.deepEqual(
      list.trades.filter((t) => t.action === "sell").map((t) => t.realizedPnlBps),
      [500, ...Array(49).fill(null)],
    );
  } finally { raw.close(); }
});

test("an unchecked sell ranked below five checked ones leaves the five exact", async () => {
  const { raw, db } = await sellsLedger();
  try {
    busyBook(raw, ["0xbusy"], BASIS_REPLAY_ROWS / 2 + 1);
    // Five coins, each one +50% round trip, all ranked above every busy sell.
    const rows: Record<string, unknown>[] = [];
    for (let i = 1; i <= 5; i++) {
      rows.push(buyRow(20_000 + 2 * i, `0xgood${i}`, "10", { created_at: 20_000 + 2 * i }));
      rows.push(sellRow(20_001 + 2 * i, 5, 15, { sell_token: `0xgood${i}`, fill_qty_raw: "10", created_at: 20_001 + 2 * i }));
    }
    await insert(db, rows);
    const top = await readTopTrades(db, "a", 1, false, "landed");
    assert.equal(top.read, true, "nothing unchecked outranks the five");
    assert.deepEqual(top.trades.map((t) => t.realizedPnlBps), [5_000, 5_000, 5_000, 5_000, 5_000]);
  } finally { raw.close(); }
});

// ── R3P-1: a scan cut by its own page bound says so too ─────────────────────
/**
 * A core lot bought from the QUOTE and never sold out, then `trims` receipt
 * round trips of the same coin at +10%: every one of those sells stands on
 * the estimate, so none is vouched for — and every one ranks above a +5%.
 * Each is an unvouched candidate, NOT a cut coin: the coin's whole history
 * fits one replay, so only the page bound can stop the scan.
 */
function estimatedCore(raw: DatabaseSync, trims: number, firstId: number) {
  raw.prepare(`INSERT INTO trades (id, agent_id, epoch, kind, fill_side, status, created_at, amount_usdg, user_op_hash, fill_symbol,
      buy_token, sell_token, realized_pnl_usdg, fill_cash_usdg, basis_source, fill_qty_raw)
    VALUES (?, 'a', 1, 'swap', 'buy', 'landed', ?, 5, ?, 'CORE', '0xcore', '0xusdg', NULL, 10, 'quote', '1000')`).run(firstId, firstId, `0xcorelot${firstId}`);
  busyBook(raw, ["0xcore"], trims, firstId + 1);
}

test("a TOP TRADES scan that stops at its page bound is unread — never 'no closed trades'", async () => {
  // The page loop read at most TOP_TRADES_SCAN_ROWS ranked candidates and then
  // answered read:true with whatever it had. With more unvouched sells than
  // that ranked above every checked one, the checked trades were never reached
  // and the page printed "No closed trades yet" over them.
  assert.ok(2 * (TOP_TRADES_SCAN_ROWS + 1) + 1 < BASIS_REPLAY_ROWS, "the core coin is replayed whole: nothing here is a cut coin");
  const { raw, db } = await sellsLedger();
  try {
    // One candidate short of the bound, plus the checked +5%: exactly the
    // bound, every candidate read, so the list is whole and says so.
    estimatedCore(raw, TOP_TRADES_SCAN_ROWS - 1, 1);
    await insert(db, [buyRow(90_001, "0xcalm", "10", { created_at: 90_001 }), sellRow(90_002, 0.5, 10.5, { sell_token: "0xcalm", fill_qty_raw: "10", created_at: 90_002 })]);
    const whole = await readTopTrades(db, "a", 1, false, "landed");
    assert.equal(whole.read, true, "a scan that read every candidate answered");
    assert.deepEqual(whole.trades.map((t) => [t.id, t.realizedPnlBps]), [["90002", 500]]);

    // One more unvouched sell above it: the checked trade is now past the
    // bound, unread. The list cannot be stated, and must not read as empty.
    busyBook(raw, ["0xcore"], 1, 95_001);
    assert.deepEqual(await readTopTrades(db, "a", 1, false, "landed"), { trades: [], read: false });

    // Nor as a short list: two checked trades ranked first are not the five
    // when the scan stopped with candidates left below them.
    await insert(db, [
      buyRow(96_001, "0xgood1", "10", { created_at: 96_001 }), sellRow(96_002, 5, 15, { sell_token: "0xgood1", fill_qty_raw: "10", created_at: 96_002 }),
      buyRow(96_003, "0xgood2", "10", { created_at: 96_003 }), sellRow(96_004, 5, 15, { sell_token: "0xgood2", fill_qty_raw: "10", created_at: 96_004 }),
    ]);
    assert.deepEqual(await readTopTrades(db, "a", 1, false, "landed"), { trades: [], read: false });
  } finally { raw.close(); }
});

test("five checked trades found before the page bound are the five, whatever lies past it", async () => {
  const { raw, db } = await sellsLedger();
  try {
    estimatedCore(raw, TOP_TRADES_SCAN_ROWS + 5, 1);
    const rows: Record<string, unknown>[] = [];
    for (let i = 1; i <= 5; i++) {
      rows.push(buyRow(90_000 + 2 * i, `0xgood${i}`, "10", { created_at: 90_000 + 2 * i }));
      rows.push(sellRow(90_001 + 2 * i, 5, 15, { sell_token: `0xgood${i}`, fill_qty_raw: "10", created_at: 90_001 + 2 * i }));
    }
    await insert(db, rows);
    const top = await readTopTrades(db, "a", 1, false, "landed");
    assert.equal(top.read, true, "the five rank above everything the bound left unread");
    assert.deepEqual(top.trades.map((t) => t.realizedPnlBps), [5_000, 5_000, 5_000, 5_000, 5_000]);
  } finally { raw.close(); }
});

test("the replay that vouches for a cost vouches for nothing it could not read whole", () => {
  const fills = [
    { op: "b", side: "buy" as const, token: "0xm", qty: "10", source: "receipt" },
    { op: "s", side: "sell" as const, token: "0xm", qty: "10", source: "receipt" },
  ];
  assert.deepEqual([...vouchedSells(fills, true)], ["s"]);
  assert.deepEqual([...vouchedSells(fills, false)], [], "a truncated read cannot know what came before its first row");
  assert.deepEqual([...vouchedSells([{ ...fills[0]!, source: null }, fills[1]!], true)], [], "a cost of unknown provenance is not evidence");
  assert.deepEqual([...vouchedSells([{ ...fills[0]!, source: "paper" }, { ...fills[1]!, source: "paper" }], true)], ["s"], "a paper fill is exact");
  // A row with no side that booked a cost from a quote put that estimate in.
  assert.deepEqual([...vouchedSells([{ op: "r", side: null, token: "0xm", qty: null, source: "quote" }, fills[1]!], true)], []);
  // A sell is judged by what it sold against, whatever its own quantity; and a
  // sell adds no cost, so its own quoted proceeds put no estimate in the basis.
  assert.deepEqual(
    [...vouchedSells([fills[0]!, { op: "s1", side: "sell", token: "0xm", qty: null, source: "quote" }, { ...fills[1]!, op: "s2", qty: "5" }], true)],
    ["s1", "s2"],
  );
});

test("a fill with no side before the period makes only its own tokens unknown", async () => {
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      // The reconciler's bare row for some other coin, last period.
      sellRow(1, null, null, { epoch: 0, fill_side: null, buy_token: "0xother", sell_token: "0xusdg", fill_qty_raw: null, created_at: 5 }),
      heldBuy(2, "0xtsla", "10", 100),
      heldSell(3, "0xtsla", "10", 160),
    ]);
    const r = (await readRoundTrips(db, "a", 1, "landed"))!;
    assert.equal(r.opening?.get("0xother"), null);
    assert.equal(averageHoldSec(r.fills, r.opening, r.dust), 60, "TSLA was not touched by it");
  } finally { raw.close(); }
});

test("a fill before the period that names no coin could have moved any of them, so nothing carried is known", async () => {
  // The reconciler's row for an op the ledger had no row for: landed, no side,
  // and token legs only when the receipt named them — none on every row it
  // wrote before the legs were added. Dropped from the replay, it read as
  // "flat, known" for a coin it may have bought, and a trim of that coin was
  // paired with the period's buy.
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      sellRow(1, null, null, { epoch: 0, fill_side: null, fill_symbol: null, buy_token: null, sell_token: null, fill_qty_raw: null, user_op_hash: "0xorphan", created_at: 5 }),
      heldBuy(2, "0xmeme", "10", 100),
      heldSell(3, "0xmeme", "10", 160),
    ]);
    const orphan = (await readRoundTrips(db, "a", 1, "landed"))!;
    assert.equal(orphan.opening, null);
    assert.equal(averageHoldSec(orphan.fills, orphan.opening, orphan.dust), null);
    // One leg named and the other not: the unnamed one could still be any coin.
    await db.exec("UPDATE trades SET buy_token = '0xother' WHERE id = 1");
    const oneLeg = (await readRoundTrips(db, "a", 1, "landed"))!;
    assert.equal(oneLeg.opening, null);
    // Both legs named: only those two are unknown (the case above this one).
    await db.exec("UPDATE trades SET sell_token = '0xusdg' WHERE id = 1");
    const named = (await readRoundTrips(db, "a", 1, "landed"))!;
    assert.equal(averageHoldSec(named.fills, named.opening, named.dust), 60);
  } finally { raw.close(); }
});

test("the paper book's rounding is read as rounding, the funded book's units as exact", async () => {
  const ONE = 10n ** 18n;
  const drift = 5n * 10n ** 11n;
  const rows = (status: string) => {
    const o = { status, basis_source: status === "paper" ? "paper" : "receipt", user_op_hash: null };
    return [
      heldBuy(1, "0xtsla", String(ONE), 100, o),
      heldSell(2, "0xtsla", String(ONE - drift), 160, o),
      heldBuy(3, "0xtsla", String(ONE), 200, o),
      heldSell(4, "0xtsla", String(ONE), 300, o),
    ];
  };
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, rows("paper"));
    const paper = (await readRoundTrips(db, "a", 1, "paper"))!;
    // 60 and 100: the half-millionth of a share left at 160 is the paper book's
    // rounding, not a lot the sell at 300 held for 200 seconds.
    assert.equal(averageHoldSec(paper.fills, paper.opening, paper.dust), 80);
  } finally { raw.close(); }
  const live = await sellsLedger();
  try {
    await insert(live.db, rows("landed"));
    const r = (await readRoundTrips(live.db, "a", 1, "landed"))!;
    assert.equal(averageHoldSec(r.fills, r.opening, r.dust), (60 + 200 + 100) / 3, "a receipt's leftover is a real leftover");
  } finally { live.raw.close(); }
});

test("a read of the fills before the period that was cut short says nothing about what was carried", async () => {
  const { raw, db } = await sellsLedger();
  try {
    raw.exec("BEGIN");
    const ins = raw.prepare("INSERT INTO trades (id, agent_id, epoch, kind, fill_side, status, created_at, amount_usdg, buy_token, sell_token, basis_source, fill_qty_raw) VALUES (?, 'a', 0, 'swap', ?, 'landed', ?, 5, ?, ?, 'receipt', '1')");
    for (let i = 0; i < OPENING_READ_LIMIT + 1; i++) {
      const buy = i % 2 === 0;
      ins.run(10_000 + i, buy ? "buy" : "sell", i, buy ? "0xold" : "0xusdg", buy ? "0xusdg" : "0xold");
    }
    raw.exec("COMMIT");
    await insert(db, [heldBuy(1, "0xtsla", "10", 20_000), heldSell(2, "0xtsla", "10", 20_060)]);
    const r = (await readRoundTrips(db, "a", 1, "landed"))!;
    assert.equal(r.opening, null, "its first row is not the book's first");
    assert.equal(averageHoldSec(r.fills, r.opening, r.dust), null);
  } finally { raw.close(); }
});

test("a paper period its first valuation proves flat is flat, however many fills came before it", async () => {
  // CP4: a paper book's fills pile up across resets, and once the read of them
  // was cut, the valuation that proves the reset was never consulted — so a
  // long-lived paper agent never showed an average hold again.
  const ONE = "1000000000000000000";
  const { raw, db } = await sellsLedger();
  try {
    await db.exec(`CREATE TABLE equity(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, epoch INTEGER, mode TEXT,
      cash_usdg REAL, vault_usdg REAL, positions_usdg REAL, equity_usdg REAL, at INTEGER)`);
    raw.exec("BEGIN");
    const ins = raw.prepare(`INSERT INTO trades (id, agent_id, epoch, kind, fill_side, status, created_at, amount_usdg, buy_token, sell_token, basis_source, fill_qty_raw)
      VALUES (?, 'a', 0, 'swap', ?, 'paper', ?, 5, ?, ?, 'paper', ?)`);
    // Earlier periods: round trips that end holding a share, then a reset.
    for (let i = 0; i < OPENING_READ_LIMIT + 1; i++) {
      const buy = i % 2 === 0;
      ins.run(10_000 + i, buy ? "buy" : "sell", i, buy ? "0xtsla" : "0xusdg", buy ? "0xusdg" : "0xtsla", ONE);
    }
    raw.exec("COMMIT");
    const paper = { status: "paper", basis_source: "paper", user_op_hash: null };
    await insert(db, [heldBuy(1, "0xtsla", ONE, 20_000, paper), heldSell(2, "0xtsla", ONE, 20_060, paper)]);
    const hold = async () => { const r = (await readRoundTrips(db, "a", 1, "paper"))!; return averageHoldSec(r.fills, r.opening, r.dust); };
    assert.equal(await hold(), null, "no valuation, and a cut read: nothing is known");
    const mark = (positions: number, quarantined = 0) =>
      db.prepare("INSERT INTO equity (agent_id, epoch, mode, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at) VALUES ('a', 1, 'paper', 1000, 0, ?, ?, 19000)")
        .run(positions, 1000 + positions + quarantined);
    await mark(0);
    assert.equal(await hold(), 60, "zero held, zero quarantined, before the first fill: the book opened flat");
    await db.exec("DELETE FROM equity");
    await mark(0, 5);
    assert.equal(await hold(), null, "something it cannot price was held, so the cut read decides — and says nothing");
    await db.exec("DELETE FROM equity");
    await mark(25);
    assert.equal(await hold(), null, "a book that came over whole needs the fills to say what, and they were cut");
  } finally { raw.close(); }
});

test("a redeploy's copy, stamped this period, of an operation from the last one is that operation", async () => {
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      heldBuy(1, "0xtsla", "10", 10, { epoch: 0, user_op_hash: "0xabc" }),
      // Re-recorded at the restart, in the new period, with nothing on it.
      sellRow(2, null, null, { epoch: 1, user_op_hash: "0xABC", fill_side: null, fill_qty_raw: null, basis_source: null, created_at: 500 }),
    ]);
    const r = (await readRoundTrips(db, "a", 1, "landed"))!;
    assert.deepEqual(r.fills, [], "not a fill of this period, and not an unread one");
    assert.deepEqual(r.opening, new Map([["0xtsla", 10n]]));
  } finally { raw.close(); }
});

test("Buys & sells shows no return on a sell whose cost a quoted buy built, the rule TOP TRADES keeps", async () => {
  // The same page lists the same sell twice: ranked in TOP TRADES and as a row
  // with a P&L chip. One rule for both, or the chip prints the +900% the
  // ranking refused.
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      buyRow(1, "0xmeme", "10", { basis_source: "quote" }),
      sellRow(2, 9, 10, { sell_token: "0xmeme", fill_qty_raw: "10" }),
      sellRow(3, 1, 11),
      sellRow(4, 1, 2, { status: "paper", basis_source: "paper", user_op_hash: null }),
    ]);
    const pub = (await readProfileTrades(db, "a", 1, true)).trades;
    assert.deepEqual(pub.map((t) => [t.id, t.realizedPnlBps, t.realizedPnlUsdg]), [["4", 10_000, 1], ["3", 1_000, 1], ["2", null, null], ["1", null, null]]);
  } finally { raw.close(); }
});
