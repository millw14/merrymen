import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { applyLedgerSchema } from "../../../worker/src/store";
import { ownBookOf, profileOf } from "./read-agent";
import { BASIS_REPLAY_ROWS, OPENING_READ_LIMIT } from "./profile-trades";

/**
 * ONE AGENT'S PUBLIC PAGE, read from a ledger built by the worker's own schema.
 *
 * The profile's new figures — the stats line, TOP TRADES, the gasless claim and
 * the full-period chart — are claims about a named agent, so they are driven
 * through the real read against real columns rather than trusted.
 */
const ACCOUNT = "0xa6e17a1b2c3d4e5f60718293a4b5c6d7e8f90123";
const H = 3_600;
const T0 = 2_000_000 * H; // an hour boundary, long after ACCOUNTING_FIXED_AT

async function ledger(): Promise<{ raw: DatabaseSync; db: Db }> {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  await db.prepare(
    `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode, epoch, beat_at, contributions_known)
     VALUES (?, 'Shogun', '0x1', '0x2', 4663, '{}', 0, 0, 'live', 2, ?, 1)`,
  ).run(ACCOUNT, T0 + 40 * 24 * H);
  await db.prepare(`INSERT INTO flows (agent_id, epoch, direction, amount_usdg, tx_hash, source, at) VALUES (?, 2, 'in', 100, '0xtx', 'chain-log', ?)`).run(ACCOUNT, T0);
  return { raw, db };
}
async function mark(db: Db, at: number, equity: number) {
  await db.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 0, 0, ?, ?, 2, 'live')`).run(ACCOUNT, equity, at);
}
let op = 0;
/** The cash leg, and a coin's address: the ledger keys a fill's coin by the token it moved. */
const USDG = "0x00000000000000000000000000000000000000c0";
const tokenOf = (coin: string) => `0x${Buffer.from(coin.toLowerCase()).toString("hex").padStart(40, "0")}`;
async function fill(db: Db, over: { side: "buy" | "sell"; coin: string; qty: string; at: number; pnl?: number; cash?: number; sponsored?: boolean; epoch?: number; source?: string | null; status?: string }) {
  op += 1;
  const coin = tokenOf(over.coin);
  await db.prepare(
    `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, status, created_at, epoch, fill_side, fill_symbol, fill_qty_raw,
                         fill_cash_usdg, realized_pnl_usdg, basis_source, gas_wei, gas_usdg, sponsored_gas_wei)
     VALUES (?, 'swap', 'x', ?, ?, 5, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(ACCOUNT, over.side === "buy" ? USDG : coin, over.side === "buy" ? coin : USDG, `0xop${op}`, over.status ?? "landed", over.at, over.epoch ?? 2,
    over.side, over.coin, over.qty, over.cash ?? 5, over.pnl ?? null, over.source === undefined ? "receipt" : over.source,
    over.sponsored ? null : "1000", over.sponsored ? null : 0.01, over.sponsored ? "1000" : null);
}
const identity = { slug: "shogun", accounts: [ACCOUNT], createdAt: T0 - 86_400 };

test("the profile reports the whole period: its chart, its stats line and its best trades", async () => {
  const { raw, db } = await ledger();
  try {
    // Forty days of readings, several an hour, ending at +21%.
    for (let h = 0; h <= 40 * 24; h++) {
      await mark(db, T0 + h * H + 60, 100 + (21 * h) / (40 * 24));
      await mark(db, T0 + h * H + 1_800, 100 + (21 * h) / (40 * 24));
    }
    await fill(db, { side: "buy", coin: "CASH", qty: "10", at: T0 + 100, sponsored: true });
    await fill(db, { side: "sell", coin: "CASH", qty: "10", at: T0 + 100 + 2 * H, pnl: 2, cash: 12, sponsored: true });
    await fill(db, { side: "buy", coin: "CHUMP", qty: "5", at: T0 + 10 * H, sponsored: true });
    await fill(db, { side: "sell", coin: "CHUMP", qty: "5", at: T0 + 14 * H, pnl: -1, cash: 4, sponsored: true });

    const p = await profileOf(db, identity, false);
    assert.ok(p);
    // THE CHART COVERS WHAT THE HEADLINE COVERS. The old read stopped at the
    // newest 500 rows — a little over ten days of this tape — so its left edge
    // was not the period's opening.
    assert.equal(p.growthComplete, true);
    assert.equal(p.growth[0]!.at, T0 + 60, "it opens on the period's first reading");
    assert.equal(p.growth.at(-1)!.at, T0 + 40 * 24 * H + 1_800, "and ends on the newest");
    assert.equal(p.growth.length, 40 * 24 + 2, "one close an hour, plus the opening mark");
    assert.ok(Math.abs(p.growth.at(-1)!.g - 1.21) < 1e-9, "the right-hand end is the headline's +21%");

    assert.equal(p.tradeCount, 4);
    assert.equal(p.tradeCountFloor, false);
    assert.equal(p.avgHoldSec, 3 * H, "CASH held 2h, CHUMP 4h");
    assert.equal(p.joinedAt, T0 - 86_400);

    assert.equal(p.topTradesRead, true);
    assert.deepEqual(p.topTrades.map((t) => [t.symbol, t.realizedPnlBps, t.realizedPnlUsdg]), [
      ["CASH", 2_000, null],
      ["CHUMP", -2_000, null],
    ]);
    assert.equal(p.gasless, true, "every landed operation was sponsored");
  } finally { raw.close(); }
});

test("gasless is claimed only when EVERY landed operation was sponsored", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, T0, 100);
    assert.equal((await profileOf(db, identity, false))!.gasless, false, "nothing landed is not 'every trade sponsored'");
    await fill(db, { side: "buy", coin: "CASH", qty: "1", at: T0 + 1, sponsored: true });
    assert.equal((await profileOf(db, identity, false))!.gasless, true);
    // A redeploy re-records that op as a bare copy with no gas on it. It is the
    // same operation, so it cannot end the claim.
    await db.prepare(
      `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, created_at, epoch) VALUES (?, 'swap', 'x', 5, ?, 'landed', ?, 2)`,
    ).run(ACCOUNT, `0xOP${op}`, T0 + 9_999);
    assert.equal((await profileOf(db, identity, false))!.gasless, true, "a copy is not a self-paid op");
    // An empty sponsor figure is no sponsor — gas-audit.ts reads it the same way.
    await db.prepare("UPDATE trades SET sponsored_gas_wei = '' WHERE user_op_hash = ?").run(`0xop${op}`);
    assert.equal((await profileOf(db, identity, false))!.gasless, false, "an empty figure is not a sponsor");
    await db.prepare("UPDATE trades SET sponsored_gas_wei = '1000' WHERE user_op_hash = ?").run(`0xop${op}`);
    // A sponsored op writes no owner gas. One that carries some contradicts the
    // claim, and the page would print both — so neither is claimed.
    await db.prepare("UPDATE trades SET gas_usdg = 0.4 WHERE user_op_hash = ?").run(`0xop${op}`);
    assert.equal((await profileOf(db, identity, false))!.gasless, false, "gasless beside a gas charge is a contradiction");
    await db.prepare("UPDATE trades SET gas_usdg = NULL WHERE user_op_hash = ?").run(`0xop${op}`);
    await fill(db, { side: "sell", coin: "CASH", qty: "1", at: T0 + 2, sponsored: false });
    assert.equal((await profileOf(db, identity, false))!.gasless, false, "one self-paid fill ends the claim");
  } finally { raw.close(); }
});

test("an unread join date, hold or trade count is left out, never invented", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, T0, 100);
    // One buy, never sold: a trade, but no round trip.
    await fill(db, { side: "buy", coin: "CASH", qty: "1", at: T0 + 1 });
    const p = await profileOf(db, { slug: "shogun", accounts: [ACCOUNT], createdAt: undefined }, false);
    assert.equal(p!.joinedAt, null);
    assert.equal(p!.tradeCount, 1);
    assert.equal(p!.avgHoldSec, null, "no round trip, no average");
    assert.deepEqual(p!.topTrades, [], "no closed trade is an empty list…");
    assert.equal(p!.topTradesRead, true, "…that was read");
    for (const bad of [0, -5, Number.NaN, "yesterday", 1e13]) {
      const q = await profileOf(db, { slug: "shogun", accounts: [ACCOUNT], createdAt: bad }, false);
      assert.equal(q!.joinedAt, null, `createdAt ${String(bad)}`);
    }
  } finally { raw.close(); }
});

test("a paper agent's stats are its paper book's, and a live agent's are not its practice", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, T0, 100);
    await fill(db, { side: "buy", coin: "CASH", qty: "1", at: T0 + 1 });
    await fill(db, { side: "sell", coin: "CASH", qty: "1", at: T0 + 61, pnl: 1, cash: 11 });
    await db.prepare(
      `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, created_at, epoch, fill_side, fill_symbol, fill_qty_raw, fill_cash_usdg, realized_pnl_usdg, basis_source)
       VALUES (?, 'swap', 'x', ?, ?, 5, 'paper', ?, 2, 'buy', 'TSLA', '2000000000000000000', 5, NULL, 'paper'), (?, 'swap', 'x', ?, ?, 5, 'paper', ?, 2, 'sell', 'TSLA', '2000000000000000000', 6, 1, 'paper'),
              (?, 'swap', 'x', ?, ?, 5, 'paper', ?, 2, 'buy', 'TSLA', '3000000000000000000', 5, NULL, 'paper')`,
    ).run(ACCOUNT, USDG, tokenOf("TSLA"), T0 + 100, ACCOUNT, tokenOf("TSLA"), USDG, T0 + 400, ACCOUNT, USDG, tokenOf("TSLA"), T0 + 500);
    // Paper fills are booked at 1e18 raw units a share (paper.ts), the scale its
    // rounding is measured in.
    const live = (await profileOf(db, identity, false))!;
    assert.deepEqual([live.tradeCount, live.avgHoldSec, live.topTrades.map((t) => t.symbol)], [2, 60, ["CASH"]]);
    await db.prepare("UPDATE agents SET mode = 'paper'").run();
    const paper = (await profileOf(db, identity, false))!;
    assert.deepEqual([paper.tradeCount, paper.avgHoldSec, paper.topTrades.map((t) => t.symbol)], [3, 300, ["TSLA"]]);
  } finally { raw.close(); }
});

test("a trade count from a capped read is a floor, and no hold is computed from a partial tape", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, T0, 100);
    raw.exec("BEGIN");
    const ins = raw.prepare(
      `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, status, created_at, epoch, fill_side, fill_symbol, fill_qty_raw, basis_source)
       VALUES (?, 'swap', 'x', ?, ?, 5, ?, 'landed', ?, 2, ?, 'CASH', '1', 'receipt')`,
    );
    for (let i = 0; i < 5_001; i++) {
      const buy = i % 2 === 0;
      ins.run(ACCOUNT, buy ? USDG : tokenOf("CASH"), buy ? tokenOf("CASH") : USDG, `0xbulk${i}`, T0 + i, buy ? "buy" : "sell");
    }
    raw.exec("COMMIT");
    const p = (await profileOf(db, identity, false))!;
    assert.equal(p.tradeCount, 5_000);
    assert.equal(p.tradeCountFloor, true);
    assert.equal(p.avgHoldSec, null);
  } finally { raw.close(); }
});

test("a public book shows the best trade's dollars; a private one does not", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, T0, 100);
    await fill(db, { side: "buy", coin: "CASH", qty: "1", at: T0 + 1 });
    await fill(db, { side: "sell", coin: "CASH", qty: "1", at: T0 + 2, pnl: 3, cash: 13 });
    assert.equal((await profileOf(db, identity, false))!.topTrades[0]!.realizedPnlUsdg, null);
    assert.equal((await profileOf(db, identity, true))!.topTrades[0]!.realizedPnlUsdg, 3);
  } finally { raw.close(); }
});

test("the owner's own read carries the sizes and dollars a private profile withholds", async () => {
  // PF6: the spec's rule is "$ only when the book is public OR it is the
  // owner's own view". The public read takes no session, so it withholds a
  // private book's money from everyone, its owner included; ownBookOf is the
  // read the owner's session-checked route serves.
  const { raw, db } = await ledger();
  try {
    await mark(db, T0, 100);
    await fill(db, { side: "buy", coin: "CASH", qty: "1", at: T0 + 1 });
    await fill(db, { side: "sell", coin: "CASH", qty: "1", at: T0 + 2, pnl: 3, cash: 13 });
    const pub = (await profileOf(db, identity, false))!;
    assert.ok(pub.recentTrades.every((t) => t.sizeUsdg === null && t.realizedPnlUsdg === null), "the public read stays private");
    const own = (await ownBookOf(db, identity))!;
    assert.equal(own.activityRead, true);
    assert.deepEqual(own.recentTrades.map((t) => [t.action, t.sizeUsdg, t.realizedPnlUsdg]), [["sell", 5, 3], ["buy", 5, null]]);
    assert.equal(own.topTradesRead, true);
    assert.deepEqual(own.topTrades.map((t) => [t.symbol, t.realizedPnlBps, t.realizedPnlUsdg]), [["CASH", 3_000, 3]]);
    assert.equal(await ownBookOf(db, { slug: "x", accounts: ["0x00000000000000000000000000000000000000ff"] }), null, "no agent, no book");
  } finally { raw.close(); }
});

test("avg hold does not pair a trim of a carried position with the buy beside it", async () => {
  // PF2, on the worker's own schema. openNextEpoch carries positions over; the
  // reviewer's probe held 1,000 CASH into the period, bought 10 and trimmed 10
  // a minute later, and the profile printed "avg hold 1m" for units held weeks.
  const { raw, db } = await ledger();
  try {
    await mark(db, T0, 100);
    await fill(db, { side: "buy", coin: "CASH", qty: "1000", at: T0 - 20 * 86_400, epoch: 1 });
    await fill(db, { side: "buy", coin: "CASH", qty: "10", at: T0 + 100 });
    await fill(db, { side: "sell", coin: "CASH", qty: "10", at: T0 + 160, pnl: 0.1, cash: 5.1 });
    const p = (await profileOf(db, identity, false))!;
    assert.equal(p.tradeCount, 2, "this period's fills only");
    assert.equal(p.avgHoldSec, null, "the trim sold carried units: no round trip this period");
    // Sold out last period, the same two fills are a round trip of a minute.
    await fill(db, { side: "sell", coin: "CASH", qty: "1000", at: T0 - 10 * 86_400, epoch: 1 });
    assert.equal((await profileOf(db, identity, false))!.avgHoldSec, 60);
  } finally { raw.close(); }
});

test("a coin traded more often than one cost replay reads leaves TOP TRADES unread, never 'no closed trades'", async () => {
  // CP1, the reviewer's probe on the worker's own schema: 2,501 receipt round
  // trips of one coin, every sell +10%. The replay was cut, vouched for
  // nothing, and TOP TRADES came back an empty list read as true.
  const { raw, db } = await ledger();
  try {
    await mark(db, T0, 100);
    raw.exec("BEGIN");
    const ins = raw.prepare(
      `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, status, created_at, epoch, fill_side, fill_symbol,
                           fill_qty_raw, fill_cash_usdg, realized_pnl_usdg, basis_source)
       VALUES (?, 'swap', 'x', ?, ?, 5, ?, 'landed', ?, 2, ?, 'TSLA', '10', ?, ?, 'receipt')`,
    );
    for (let i = 0; i <= BASIS_REPLAY_ROWS / 2; i++) {
      ins.run(ACCOUNT, USDG, tokenOf("TSLA"), `0xb${i}`, T0 + 10 + i * 10, "buy", 10, null);
      ins.run(ACCOUNT, tokenOf("TSLA"), USDG, `0xs${i}`, T0 + 15 + i * 10, "sell", 11, 1);
    }
    raw.exec("COMMIT");
    const p = (await profileOf(db, identity, true))!;
    assert.equal(p.topTradesRead, false, "a list that could not be checked was not read");
    assert.deepEqual(p.topTrades, []);
    assert.equal(p.activityRead, true);
    assert.ok(p.recentTrades.filter((t) => t.action === "sell").every((t) => t.realizedPnlBps === null), "and no return on a cost nobody checked");
  } finally { raw.close(); }
});

test("a fill carried in that names no coin leaves the hold unknown, as it does inside the period", async () => {
  // CP2, the reviewer's probe: the reconciler's row for an op the ledger had
  // no row for — landed, no side, no legs — in the last period.
  const { raw, db } = await ledger();
  try {
    await mark(db, T0, 100);
    await db.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, created_at, epoch, basis_source) VALUES (?, 'swap', ?, 50, '0xorphan', 'landed', ?, 1, 'receipt')`)
      .run(ACCOUNT, ACCOUNT, T0 - 86_400);
    await fill(db, { side: "buy", coin: "MEME", qty: "10", at: T0 + 100 });
    await fill(db, { side: "sell", coin: "MEME", qty: "10", at: T0 + 160, pnl: 0.1, cash: 5.1 });
    assert.equal((await profileOf(db, identity, false))!.avgHoldSec, null, "carried in");
    await db.prepare("UPDATE trades SET epoch = 2, created_at = ? WHERE user_op_hash = '0xorphan'").run(T0 + 50);
    assert.equal((await profileOf(db, identity, false))!.avgHoldSec, null, "and in the period, as before");
  } finally { raw.close(); }
});

test("a paper period is flat only when nothing was held at all — priced, or kept at cost", async () => {
  // CP3 and CP4, the reviewer's probes: a paper book whose only holding is a
  // coin the worker cannot price values `positions` at zero and carries the
  // coin at cost inside the total; and a long-lived paper book whose earlier
  // fills pass the opening read still opens flat when its valuation says so.
  const ONE = "1000000000000000000";
  const { raw, db } = await ledger();
  try {
    await db.prepare("UPDATE agents SET mode = 'paper'").run();
    const paperFill = (side: "buy" | "sell", at: number, epoch = 2) =>
      fill(db, { side, coin: "MEME", qty: ONE, at, epoch, status: "paper", source: "paper", pnl: side === "sell" ? 1 : undefined, cash: side === "sell" ? 6 : 5 });
    await paperFill("buy", T0 - 86_400, 1);
    const valuation = db.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', ?, 0, 0, ?, ?, 2, 'paper')`);
    await valuation.run(ACCOUNT, 95, 100, T0 + 50);
    await paperFill("buy", T0 + 100);
    await paperFill("sell", T0 + 160);
    assert.equal((await profileOf(db, identity, false))!.avgHoldSec, null, "5 USDG held at cost: the carried share was sold first");
    await db.prepare("UPDATE equity SET cash_usdg = 100 WHERE agent_id = ?").run(ACCOUNT);
    assert.equal((await profileOf(db, identity, false))!.avgHoldSec, 60, "nothing held at all: a reset, and a one-minute round trip");
    // The same proof with more earlier fills than the opening read takes.
    raw.exec("BEGIN");
    const ins = raw.prepare(
      `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, created_at, epoch, fill_side, fill_symbol, fill_qty_raw, basis_source)
       VALUES (?, 'swap', 'x', ?, ?, 5, 'paper', ?, 1, ?, 'MEME', ?, 'paper')`,
    );
    for (let i = 0; i <= OPENING_READ_LIMIT; i++) {
      const buy = i % 2 === 0;
      ins.run(ACCOUNT, buy ? USDG : tokenOf("MEME"), buy ? tokenOf("MEME") : USDG, T0 - 80_000 + i, buy ? "buy" : "sell", ONE);
    }
    raw.exec("COMMIT");
    assert.equal((await profileOf(db, identity, false))!.avgHoldSec, 60, "a cut read of the past does not undo a valuation that proves the opening");
  } finally { raw.close(); }
});

async function heldMark(db: Db, at: number, equity: number) {
  await db.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, equity_usdg, at, epoch, mode, flows_held) VALUES (?, '0', 0, 0, ?, ?, 2, 'live', 1)`).run(ACCOUNT, equity, at);
}
let flowTx = 0;
async function flow(db: Db, direction: "in" | "out", amount: number, at: number, source: string) {
  flowTx += 1;
  await db.prepare(`INSERT INTO flows (agent_id, epoch, direction, amount_usdg, tx_hash, source, at) VALUES (?, 2, ?, ?, ?, ?, ?)`).run(ACCOUNT, direction, amount, `0xheld${flowTx}`, source, at);
}

test("a held dip is no drawdown: the growth index and max drawdown skip marks taken while flow inference was held", async () => {
  // An energy buy spends 11 USDG and its receipt wait times out: the next
  // tick holds (store.ts `flows_held`) and values the book at 99 with the 11
  // not yet booked as capital out. The resolver books it; the next measured
  // mark reads 99 with the flow divided out, which is flat. Over the held row
  // the index read 0.99 — a 10% "drawdown" the page would have kept for good.
  const { raw, db } = await ledger();
  try {
    await mark(db, T0 + 60, 100);
    await fill(db, { side: "buy", coin: "CASH", qty: "1", at: T0 + 100, sponsored: true });
    await mark(db, T0 + H + 60, 110);
    await heldMark(db, T0 + 2 * H + 60, 99);
    await flow(db, "out", 11, T0 + 2 * H + 120, "energy-buy");
    await mark(db, T0 + 3 * H + 60, 99);

    const p = (await profileOf(db, identity, false))!;
    assert.deepEqual(p.growth.map((g) => g.at), [T0 + 60, T0 + H + 60, T0 + 3 * H + 60], "the held mark is not a point");
    assert.ok(p.growth.every((g, i) => i === 0 || g.g >= p.growth[i - 1]!.g - 1e-12), "no dip anywhere");
    assert.ok(Math.abs(p.growth.at(-1)!.g - 1.1) < 1e-9);
    assert.equal(p.maxDdBps, 0);
    // The return: the newest measured mark over the flows booked by then.
    assert.equal(p.pnlBps, Math.round(((99 - 89) / 89) * 10_000));
  } finally { raw.close(); }
});

test("a return is the newest MEASURED mark over the flows booked by then, while a hold goes on", async () => {
  // A dropped op holds for up to 26 hours. Meanwhile the owner's transfer of
  // 10 lands and is booked, and a 50 USDG top-up arrives that only the look
  // closing the hold can book. The held marks read 140: calling that a return
  // over the 90 now on record publishes +55.6% nobody earned. The measured
  // mark is 100, and what was on record by it is the first 100 — flat. Pairing
  // 100 with the 90 booked since would be +11% the other way.
  const { raw, db } = await ledger();
  try {
    await fill(db, { side: "buy", coin: "CASH", qty: "1", at: T0 + 30, sponsored: true });
    await mark(db, T0 + 60, 100);
    await flow(db, "out", 10, T0 + H, "transfer-intent");
    await heldMark(db, T0 + H + 60, 140);
    await heldMark(db, T0 + 2 * H + 60, 140);

    const p = (await profileOf(db, identity, false))!;
    assert.equal(p.pnlBps, 0);
    assert.deepEqual(p.growth.map((g) => g.at), [T0 + 60]);
    assert.equal(p.funded, true, "funded still says flow rows exist");
  } finally { raw.close(); }
});
