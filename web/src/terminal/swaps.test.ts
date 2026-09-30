import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DESK_TAPE_ROWS, isTrade, pnlChip, sizeText, swapItems, swapRowsOfDesk, swapRowsOfProfile, triedLine, type SwapItem, type SwapRow } from "./swaps";
import type { Thesis } from "./live";

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Local noon of a fixed day, so "today" does not depend on when the test runs. */
const NOON = new Date(2026, 8, 23, 12, 0, 0).getTime();
const S = (ms: number) => Math.floor(ms / 1000);

const move = (over: Partial<Thesis>): Thesis => ({
  name: "Shogun", slug: "shogun", handle: null, action: "buy", symbol: "CASHCAT", sizeUsdg: 5, reason: "momentum", paper: false,
  head: "swap", at: S(NOON), outcome: "landed", outcomeText: null, ...over,
});

describe("the owner's tape becomes table rows without inventing anything", () => {
  it("maps outcomes, keeps the wall's reason on refusals only, and never guesses a side", () => {
    const rows = swapRowsOfDesk([
      move({}),
      move({ action: "sell", outcome: "pending" }),
      move({ outcome: "refused", outcomeText: "past today's number of trades" }),
      move({ outcome: "reverted", outcomeText: "slippage" }),
      move({ action: null, outcome: "landed", outcomeText: "ignored on a fill" }),
    ]);
    assert.deepEqual(rows.map((r) => [r.side, r.status, r.reason]), [
      ["buy", "filled", null],
      ["sell", "pending", null],
      ["buy", "refused", "past today's number of trades"],
      ["buy", "reverted", "slippage"],
      [null, "filled", null],
    ]);
    assert.equal(rows[0]!.sizeUsdg, 5, "the owner's own size travels");
    assert.equal(rows[0]!.why, "momentum");
    assert.equal(rows[1]!.realizedBps, null, "the tape carries no P&L, so none is shown — never a zero");
    assert.deepEqual(rows.filter(isTrade).length, 3, "Trades · N counts fills and pending orders, not refusals");
  });

  it("a move of cash keeps its own kind, and only a trade kind is a trade", () => {
    const rows = swapRowsOfDesk([
      move({ head: "swap" }),
      move({ head: "curve-trade", action: "sell" }),
      move({ head: "equity-order", outcome: "pending" }),
      move({ head: "vault-deposit", action: null, symbol: null }),
      move({ head: "vault-withdraw", action: null, symbol: null }),
      move({ head: "transfer", action: null, symbol: null }),
      move({ head: "something-new", action: null, symbol: null }),
      move({ head: "vault-deposit", action: null, symbol: null, outcome: "refused", outcomeText: "vault paused" }),
    ]);
    assert.deepEqual(rows.map((r) => r.op), ["trade", "trade", "trade", "vault-in", "vault-out", "transfer", "other", "vault-in"]);
    assert.deepEqual(rows.filter(isTrade).length, 3, "a vault move, a transfer or an unknown kind is not a trade");
    // Every refusal still folds into a Tried line, whatever its kind.
    const items = swapItems(rows, "all");
    assert.ok(items.some((i) => i.kind === "tried" && i.reason === "vault paused"));
    // Buys and Sells are trades only, even where a decision named a side.
    const odd = swapRowsOfDesk([move({ head: "something-new", action: "buy", symbol: null })]);
    assert.deepEqual(swapItems(odd, "buys"), []);
    assert.equal(swapItems(odd, "all").length, 1, "still listed under All");
  });

  it("realized dollars reach the desk only when the tape vouches for the cost they were measured against (CP5)", () => {
    // The worker books realized_pnl_usdg on a sell whose proceeds came from the
    // quote, and on one whose cost a quoted buy built. Printed alone, the chip
    // presented that estimate as a result: the dollars travel only when the
    // tape says both halves were read (desk-trades.ts realized_vouched).
    const sale = (over: Record<string, unknown>) => swapRowsOfDesk([{ ...move({ action: "sell" }), realizedPnlUsdg: 1.25, ...over } as Thesis])[0]!;
    assert.equal(sale({}).realizedUsd, null, "a tape that does not say is not a vouch");
    assert.equal(sale({ realizedVouched: false }).realizedUsd, null);
    assert.equal(pnlChip(sale({ realizedVouched: false }), true), null, "so no chip, rather than an estimate dressed as a result");
    assert.equal(sale({ realizedVouched: true }).realizedUsd, 1.25);
    assert.equal(sale({ realizedVouched: "true" }).realizedUsd, null, "only the tape's own true");
  });

  it("the tape's own name for a coin and its realized dollars travel (D3), never a guessed percentage", () => {
    const [sell, buy] = swapRowsOfDesk([
      { ...move({ action: "sell", symbol: "T3139F043B88" }), displayName: " JUGGERNAUT ", realizedPnlUsdg: 1.25, realizedVouched: true, txHash: "0xabc" } as Thesis,
      { ...move({ action: "buy" }), displayName: "CASHCAT", realizedPnlUsdg: 0, realizedVouched: true } as Thesis,
    ]);
    assert.equal(sell!.displayName, "JUGGERNAUT");
    assert.equal(sell!.realizedUsd, 1.25);
    assert.equal(sell!.realizedBps, null, "the tape carries no cost, so no % is invented from the order size");
    assert.equal(buy!.displayName, null, "a name that only repeats the symbol adds nothing");
    assert.equal(buy!.realizedUsd, null, "a buy realizes nothing");
    assert.deepEqual(pnlChip(sell!, true), { text: "+$1.25", tone: "up" }, "the owner's desk shows its dollars without a %");
    assert.equal(pnlChip(sell!, false), null, "and nothing where dollars may not be shown");
    for (const bad of ["0x0123456789abcdef0123456789abcdef01234567", "a\u0007b", "x".repeat(65)]) {
      assert.equal(swapRowsOfDesk([{ ...move({}), displayName: bad } as Thesis])[0]!.displayName, null, JSON.stringify(bad));
    }
    assert.equal(swapRowsOfDesk([{ ...move({ action: "sell" }), realizedPnlUsdg: Number.NaN, realizedVouched: true } as Thesis])[0]!.realizedUsd, null);
  });

  it("a public fill keeps exactly what the server sent", () => {
    const [r] = swapRowsOfProfile([{ id: "7", action: "swap", symbol: null, displayName: null, at: 5, paper: true, sizeUsdg: null, realizedPnlUsdg: null, realizedPnlBps: null }]);
    assert.deepEqual([r!.side, r!.status, r!.symbol, r!.sizeUsdg, r!.paper], [null, "filled", null, null, true]);
  });
});

const row = (id: string, over: Partial<SwapRow>): SwapRow => ({
  id, op: "trade", side: "buy", status: "filled", symbol: "X", displayName: null, at: S(NOON), paper: false, sizeUsdg: 5,
  realizedBps: null, realizedUsd: null, reason: null, why: null, ...over,
});

describe("dollars and P&L, only where they may be shown", () => {
  it("a P&L chip is a sell's, with dollars only when the viewer may see dollars", () => {
    const sell = row("s", { side: "sell", realizedBps: 1_234, realizedUsd: 3.1 });
    assert.deepEqual(pnlChip(sell, false), { text: "+12.3%", tone: "up" });
    assert.deepEqual(pnlChip(sell, true), { text: "+12.3% · +$3.10", tone: "up" });
    assert.deepEqual(pnlChip(row("l", { side: "sell", realizedBps: -500, realizedUsd: -0.4 }), true), { text: "−5.0% · −$0.40", tone: "down" });
    assert.equal(pnlChip(row("b", { side: "buy", realizedBps: 900 }), true), null, "a buy realizes nothing, so it carries no chip");
    assert.equal(pnlChip(row("u", { side: "sell", realizedBps: null }), true), null, "an unevidenced sell shows no figure, not 0%");
  });

  it("a size prints only where dollars may be shown, and never as a measured zero", () => {
    assert.equal(sizeText(row("a", { sizeUsdg: 5 }), true), "$5.00");
    assert.equal(sizeText(row("a", { sizeUsdg: 5 }), false), null, "a size the server let through is still not printed on a private book");
    assert.equal(sizeText(row("a", { sizeUsdg: 0 }), true), null);
    assert.equal(sizeText(row("a", { sizeUsdg: null }), true), null);
  });
});
const describeItems = (items: SwapItem[]) => items.map((i) => (i.kind === "row" ? i.row.id : `tried:${i.count}:${i.reason}`));

describe("refusals collapse into one line per reason, where the newest of them sits", () => {
  const H = 3_600_000;
  const rows = [
    row("fill-1", { at: S(NOON - 1 * H) }),
    row("ref-a", { status: "refused", reason: "ops cap", at: S(NOON - 2 * H) }),
    row("ref-b", { status: "refused", reason: "ops cap", at: S(NOON - 3 * H) }),
    row("sell-1", { side: "sell", at: S(NOON - 4 * H), realizedBps: 1_200 }),
    row("ref-c", { status: "refused", reason: "daily cap", at: S(NOON - 5 * H) }),
    row("ref-d", { status: "refused", reason: "ops cap", at: S(NOON - 6 * H) }),
    row("ref-e", { side: "sell", status: "refused", reason: "ops cap", at: S(NOON - 7 * H) }),
  ];

  it("All: every fill, and each reason once", () => {
    assert.deepEqual(describeItems(swapItems(rows, "all")), ["fill-1", "tried:4:ops cap", "sell-1", "tried:1:daily cap"]);
  });

  it("Buys and Sells filter first, then collapse what is left", () => {
    assert.deepEqual(describeItems(swapItems(rows, "buys")), ["fill-1", "tried:3:ops cap", "tried:1:daily cap"]);
    assert.deepEqual(describeItems(swapItems(rows, "sells")), ["sell-1", "tried:1:ops cap"]);
  });

  it("says how many times, since when, and why — in one sentence", () => {
    const [, tried] = swapItems(rows, "all");
    assert.equal(triedLine(tried as Extract<SwapItem, { kind: "tried" }>, NOON, day), "Refused 4× today: ops cap");
    const older = swapItems([row("r1", { status: "refused", reason: "no gas", at: S(NOON - 2 * 86_400_000) }), row("r2", { status: "refused", reason: "no gas", at: S(NOON) })], "all");
    assert.equal(triedLine(older[0] as Extract<SwapItem, { kind: "tried" }>, NOON, day), `Refused 2× since ${day(NOON - 2 * 86_400_000)}: no gas`);
    const reverted = swapItems([row("v", { status: "reverted", reason: null })], "all");
    assert.equal(triedLine(reverted[0] as Extract<SwapItem, { kind: "tried" }>, NOON, day), "Reverted on chain 1× today");
  });

  it("a count from a cut tape is a floor only when the cut falls inside the span it names", () => {
    const H2 = 3_600;
    // Thirty rows a minute apart from 10:00, so the tape is cut at 09:31 this
    // morning: "today" may be missing whatever happened before that.
    const cutToday = Array.from({ length: DESK_TAPE_ROWS }, (_, i) => row(`r${i}`, { status: "refused", reason: "ops cap", at: S(NOON) - 2 * H2 - i * 60 }));
    const t1 = swapItems(cutToday, "all", { tapeFull: true })[0] as Extract<SwapItem, { kind: "tried" }>;
    assert.equal(triedLine(t1, NOON, day), `Refused ${DESK_TAPE_ROWS}+× today: ops cap`);
    // The same refusals, but the tape reaches back three days: today was read whole.
    const reachesBack = [...cutToday.slice(0, DESK_TAPE_ROWS - 1), row("old-fill", { at: S(NOON - 3 * 86_400_000) })];
    const t2 = swapItems(reachesBack, "all", { tapeFull: true }).find((i) => i.kind === "tried") as Extract<SwapItem, { kind: "tried" }>;
    assert.equal(triedLine(t2, NOON, day), `Refused ${DESK_TAPE_ROWS - 1}× today: ops cap`);
    // A tape that was not full is whole, whatever it holds.
    assert.equal(triedLine(swapItems(cutToday, "all")[0] as Extract<SwapItem, { kind: "tried" }>, NOON, day), `Refused ${DESK_TAPE_ROWS}× today: ops cap`);
  });
});

/**
 * THE DESK'S P&L CHIP, END TO END (R3P-2). desk-trades.ts marks each sell
 * `realized_vouched` and /api/feed spreads it onto the wire, and the table
 * prints dollars only for `realizedVouched === true`. But mineOf, between the
 * two, carried `realizedPnlUsdg` and never the flag, so it always arrived
 * undefined and the owner's desk showed no chip on any sell — the vouched
 * ones included. Driven here through every piece in order: the ledger read,
 * the route's row, the terminal's mapping, the table's rows.
 */
describe("the owner's desk prints realized dollars for a sell the tape vouches for, and only for one", () => {
  it("A SELL WHOSE PROCEEDS AND COST WERE BOTH READ GETS ITS CHIP; ONE WITH A COST BUILT FROM A QUOTE DOES NOT", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { wrapSqlite } = await import("../../../worker/src/db");
    const { readDeskTrades } = await import("../lib/desk-trades");
    const { fmtEpoch } = await import("../lib/ledger");
    const { mineOf } = await import("./live");
    const now = Math.floor(Date.now() / 1000);
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      await db.exec(`CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT, reason TEXT);
        CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, sell_token TEXT, buy_token TEXT,
          amount_usdg REAL, tx_hash TEXT, status TEXT, reject_rule TEXT, sim_quote_out TEXT, sim_min_out TEXT, sim_fee_tier INTEGER,
          sim_gas TEXT, created_at INTEGER, user_op_hash TEXT, decision_id TEXT, fill_side TEXT, fill_symbol TEXT,
          realized_pnl_usdg REAL, epoch INTEGER, fill_qty_raw TEXT, basis_source TEXT);`);
      const ins = db.prepare(
        `INSERT INTO trades (agent_id, kind, sell_token, buy_token, amount_usdg, status, created_at, user_op_hash, fill_side, fill_symbol,
                             realized_pnl_usdg, epoch, fill_qty_raw, basis_source) VALUES ('0xA','swap',?,?,5,'landed',?,?,?,?,?,2,'10',?)`,
      );
      await ins.run("0xUSDG", "0xRCPT", now - 900, "0xb1", "buy", "0xRCPT", null, "receipt");
      await ins.run("0xRCPT", "0xUSDG", now - 800, "0xs1", "sell", "0xRCPT", 1.25, "receipt"); // both halves read off receipts
      await ins.run("0xUSDG", "0xQUOTE", now - 700, "0xb2", "buy", "0xQUOTE", null, "quote");
      await ins.run("0xQUOTE", "0xUSDG", now - 600, "0xs2", "sell", "0xQUOTE", 9, "receipt"); // cost built from the quote

      const tape = await readDeskTrades(db, "0xA", 2, now - 86_400);
      // What /api/feed puts on the wire (route.ts: the row spread, the time formatted).
      const wire = tape.map((r) => ({ ...r, created_at: fmtEpoch(r.created_at) }));
      const mine = mineOf({ agent: { name: "Shogun", strategy: "trencher", slug: null }, trades: wire }, [])!;
      const sells = swapRowsOfDesk(mine.moves).filter((r) => r.side === "sell");
      const chipAt = (ago: number) => sells.find((r) => r.at === now - ago)?.realizedUsd;
      assert.equal(sells.length, 2);
      assert.equal(chipAt(800), 1.25, "the vouched sell shows what it realized");
      assert.equal(chipAt(600), null, "an estimated cost is not a result");
      const moved = mine.moves as (Thesis & { realizedVouched?: boolean })[];
      assert.deepEqual(moved.filter((m) => m.action === "sell").map((m) => m.realizedVouched).sort(), [false, true]);
    } finally {
      raw.close();
    }
  });

  it("a tape that does not say — a server from before the flag — vouches for nothing", async () => {
    const { mineOf } = await import("./live");
    const sell = { kind: "swap", sell_token: "0xRCPT", buy_token: "0xUSDG", amount_usdg: 5, tx_hash: "0xs", status: "landed", created_at: "2026-09-23 12:00:00", fill_side: "sell", realized_pnl_usdg: 1.25 };
    const mine = mineOf({ agent: { name: "Shogun", strategy: "trencher", slug: null }, trades: [sell] }, [])!;
    assert.deepEqual(swapRowsOfDesk(mine.moves).map((r) => [r.side, r.realizedUsd]), [["sell", null]]);
  });
});
