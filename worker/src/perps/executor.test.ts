/**
 * THE PAPER PERP EXECUTOR against a real sqlite ledger — the accounting-
 * atomicity harness: an isolated home, the store's own connection, and a raw
 * second connection to read the file and inject failures with triggers.
 *
 * What each block pins:
 *   an action   one open or exit is ONE transaction: the rule-9 row resolved on
 *               the spot, its legs (the stop child always), the journaled
 *               fill, the position and the paper_book cash — and a failure in
 *               any of them leaves every one of them where it was.
 *   pricing     no fill without a book ≤ 10 s old; no open without prices
 *               ≤ 30 s old, isolated leverage set, and a stop.
 *   exits       clamped to the position, never flipped, never refused for size.
 *   the clock   funding once per hour however often a tick (or a restart)
 *               sees it; a stop that gaps leaves the position open; the
 *               liquidation engine closes what the stop could not.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, describe, it } from "node:test";
import { verifyChain } from "../audit";
import type { PerpOrderIntent } from "../policy";
import { parseLighterFeed, specToJson, type LighterFeedFileMarket, type LighterFeedRead } from "./feed-reader";
import { parseOrderBookDetails } from "./markets";
import { PerpRefused, createPaperPerpExecutor, type PerpExecutor } from "./executor";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-executor-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("../store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME, "merrymen.db"));

after(() => {
  raw.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const DETAILS = parseOrderBookDetails(JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "orderBookDetails.perp.json"), "utf8")))!;
const BTC = DETAILS.markets.get(1)!;

/** An hour boundary, unix seconds; the tests open half an hour before it. */
const H = 1_790_708_400;
const T_OPEN = (H - 1800) * 1000;

let nextAccount = 1;
/** Mixed case on purpose: perp rows are lowercased, paper_book and the journal keep the agents row's spelling. */
async function agent(): Promise<string> {
  const hex = (nextAccount++).toString(16).padStart(38, "0");
  return store.ensureAgent({
    smartAccount: `0xAb${hex}`,
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_000_000,
    expiresAt: 2_000_000_000,
    chainId: 4663,
  } as never);
}

// ── the market, as the feed file carries it ─────────────────────────────────

interface Venue {
  mark: bigint;
  index: bigint;
  bids: [number, number][];
  asks: [number, number][];
  /** ms before the clock that the prices / book were last current. */
  priceAge: number;
  bookAge: number;
  lastFunding: { pct: string; atMs: number } | null;
}

let clock = T_OPEN;
let venue: Venue;

beforeEach(() => {
  clock = T_OPEN;
  venue = {
    mark: 800_000n,
    index: 800_000n,
    bids: [[799_900, 1_000]],
    asks: [[800_000, 1_000]],
    priceAge: 1_000,
    bookAge: 1_000,
    lastFunding: null,
  };
});

function feed(): LighterFeedRead | null {
  const m: LighterFeedFileMarket = {
    observedAt: clock - venue.priceAge,
    priceSource: "ws",
    mark: venue.mark.toString(),
    index: venue.index.toString(),
    status: BTC.spec.status,
    spec: specToJson(BTC.spec),
    specObservedAt: clock - 60_000,
    takerFeePpm: 0,
    makerFeePpm: 0,
    bids: venue.bids.map(([p, s]) => [String(p), String(s)]),
    asks: venue.asks.map(([p, s]) => [String(p), String(s)]),
    bookObservedAt: clock - venue.bookAge,
    bookSource: "ws",
  };
  if (venue.lastFunding) {
    m.lastFundingRatePctPerHour = venue.lastFunding.pct;
    m.lastFundingAt = venue.lastFunding.atMs;
  }
  return parseLighterFeed({ v: 1, observedAt: clock - 500, markets: { "1": m } }, clock);
}

function executor(agentId: string): PerpExecutor {
  return createPaperPerpExecutor({ agentId, epoch: () => 1, feed, store, now: () => clock, paperStartUsdg: 100 });
}

/** 0.0002 BTC (the market minimum) long at up to 80,400.0, stop 76,000.0 / 74,480.0, 2x. */
function openLong(over: Record<string, unknown> = {}): PerpOrderIntent {
  return {
    kind: "perp-order",
    venue: "lighter",
    market: "BTC-PERP",
    marketId: 1,
    effect: "open",
    side: "long",
    reduceOnly: false,
    baseAmount: 20n,
    worstPrice: 804_000n,
    markPrice: 800_000n,
    notionalUsdg: 16_080_000n,
    imfBp: 5000,
    stopTrigger: 760_000n,
    stopPrice: 744_800n,
    ...over,
  } as PerpOrderIntent;
}

function exitLong(effect: "reduce" | "close", baseAmount: bigint, worstPrice = 760_000n): PerpOrderIntent {
  return {
    kind: "perp-order",
    venue: "lighter",
    market: "BTC-PERP",
    marketId: 1,
    effect,
    side: "long",
    reduceOnly: true,
    baseAmount,
    worstPrice,
    markPrice: 800_000n,
    notionalUsdg: 0n,
  } as PerpOrderIntent;
}

async function refusedWith(p: Promise<unknown>, rule: string): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof PerpRefused && e.rule === rule);
}

function rows(sql: string, ...args: (string | number)[]): Record<string, unknown>[] {
  return raw.prepare(sql).all(...args) as Record<string, unknown>[];
}

function cash(agentId: string): number {
  return Number((raw.prepare("SELECT cash_usdg FROM paper_book WHERE agent_id = ?").get(agentId) as { cash_usdg: number }).cash_usdg);
}

function position(agentId: string): Record<string, unknown> | undefined {
  return raw.prepare("SELECT * FROM perp_positions WHERE agent_id = ? AND mode = 'paper' AND market_id = 1").get(agentId.toLowerCase()) as
    | Record<string, unknown>
    | undefined;
}

/** A fresh agent, 2x isolated on BTC, holding the standard long. */
async function holding(ex?: (id: string) => PerpExecutor): Promise<{ id: string; ex: PerpExecutor; nonce: bigint }> {
  const id = await agent();
  const e = (ex ?? executor)(id);
  await e.setLeverage!(1, 5000);
  const intent = openLong();
  const placed = await e.place(intent, await e.review(intent), { decisionId: null, agentId: id });
  assert.equal(placed.status, "filled");
  return { id, ex: e, nonce: placed.nonce! };
}

// ── an action ───────────────────────────────────────────────────────────────

describe("one paper open is one transaction", () => {
  it("books the resolved order, its entry, stop and take legs, the journaled fill, the position and the cash", async () => {
    const id = await agent();
    const ex = executor(id);
    await ex.setLeverage!(1, 5000);
    const intent = openLong({ takeTrigger: 880_000n, takePrice: 862_400n });
    const review = await ex.review(intent);
    assert.equal(review.expectedFill, "full");
    assert.equal(review.avgPrice, 800_000n);
    assert.equal(review.notionalAtFillMicro, 16_000_000n);
    assert.equal(review.marginNeededMicro, 8_000_000n);
    assert.ok(review.liqPriceEstimate !== null && review.liqPriceEstimate < 760_000n);
    const placed = await ex.place(intent, review, { decisionId: "d-1", agentId: id });
    assert.equal(placed.status, "filled");
    assert.equal(placed.filledBase, 20n);
    assert.equal(placed.filledQuoteMicro, 16_000_000n);
    const nonce = placed.nonce!;
    assert.equal(await store.getNonceHighWater(id, "paper"), nonce, "the nonce came from the paper high-water");

    const agentLc = id.toLowerCase();
    const [order] = rows("SELECT * FROM perp_orders WHERE agent_id = ?", agentLc);
    assert.equal(order?.id, placed.orderRowId);
    assert.equal(order?.mode, "paper");
    assert.equal(order?.status, "filled", "a paper order is resolved the moment it is written");
    assert.equal(order?.effect, "open");
    assert.equal(order?.reduce_only, 0);
    assert.equal(order?.nonce, Number(nonce));
    assert.equal(order?.filled_quote_micro, "16000000");
    assert.equal(order?.worst_notional_micro, "16080000");
    assert.equal(order?.decision_id, "d-1");
    assert.equal(order?.tx_info, null, "paper signs nothing");
    const legs = rows("SELECT role, client_order_index AS coi, status FROM perp_order_legs WHERE order_id = ? ORDER BY coi", String(order?.id));
    assert.deepEqual(legs.map((l) => [l.role, BigInt(l.coi as number), l.status]), [
      ["entry", nonce * 8n, "filled"],
      ["sl", nonce * 8n + 1n, "open"],
      ["tp", nonce * 8n + 2n, "open"],
    ]);
    const [fill] = rows("SELECT * FROM perp_fills WHERE agent_id = ?", agentLc);
    assert.equal(fill?.venue_trade_id, `paper:open:1:${nonce}`);
    assert.equal(fill?.attribution, "intent");
    assert.equal(fill?.order_id, order?.id);
    assert.equal(BigInt(fill?.client_order_index as number), nonce * 8n);
    assert.equal(fill?.realized_micro, "0");
    const pos = position(id)!;
    assert.equal(pos.side, "long");
    assert.equal(pos.base, "20");
    assert.equal(pos.entry_price, "800000");
    assert.equal(pos.allocated_margin_micro, "8000000");
    assert.equal(pos.imf_bp, 5000);
    assert.equal(pos.margin_mode, "isolated");
    assert.equal(pos.stop_trigger, "760000");
    assert.equal(pos.stop_price, "744800");
    assert.equal(pos.take_trigger, "880000");
    assert.equal(pos.source, "paper");
    assert.equal(cash(id), 92, "8 USDG of margin left the paper cash");
    const journal = await store.readJournal(id, 1);
    assert.deepEqual(journal.map((j) => j.kind), ["perp-fill"]);
    assert.deepEqual(verifyChain(journal), []);
    // The budgets see it on the paper rail, once.
    const since = Math.floor(Date.now() / 1000) - 60;
    assert.equal(await store.perpOpenNotionalSince(id, "paper", since), 16_000_000n);
    assert.equal(await store.perpOpsSince(id, "paper", since), 1);
    assert.equal(await store.perpOpenNotionalSince(id, "live", since), 0n);
  });

  for (const table of ["perp_fills", "journal", "perp_order_legs", "perp_positions"] as const) {
    it(`moves nothing when the ${table} write fails, and a retry books cleanly`, async () => {
      const id = await agent();
      const ex = executor(id);
      await ex.setLeverage!(1, 5000);
      const before = { ...position(id) };
      const intent = openLong();
      const review = await ex.review(intent);
      const trigger = table === "perp_positions" ? "BEFORE UPDATE" : "BEFORE INSERT";
      raw.exec(`CREATE TRIGGER fail_paper ${trigger} ON ${table} BEGIN SELECT RAISE(ABORT, 'injected ${table} failure'); END`);
      try {
        await assert.rejects(ex.place(intent, review, { decisionId: null, agentId: id }), new RegExp(`injected ${table} failure`));
      } finally {
        raw.exec("DROP TRIGGER fail_paper");
      }
      const agentLc = id.toLowerCase();
      assert.equal(rows("SELECT id FROM perp_orders WHERE agent_id = ?", agentLc).length, 0, "no order row");
      assert.equal(rows("SELECT order_id FROM perp_order_legs WHERE agent_id = ?", agentLc).length, 0, "no legs");
      assert.equal(rows("SELECT venue_trade_id FROM perp_fills WHERE agent_id = ?", agentLc).length, 0, "no fill");
      assert.deepEqual({ ...position(id) }, before, "the position row is where it was");
      assert.equal(cash(id), 100, "no margin left the cash");
      assert.equal((await store.readJournal(id, 1)).length, 0, "nothing journaled");
      const placed = await ex.place(intent, await ex.review(intent), { decisionId: null, agentId: id });
      assert.equal(placed.status, "filled");
      assert.equal(cash(id), 92);
    });
  }

  it("refuses a booking computed from a book that has since moved, or in an epoch that has closed", async () => {
    const { id } = await holding();
    const common = { agentId: id, positions: [], cashDeltaMicro: -1_000_000n };
    await assert.rejects(store.bookPaperPerp({ ...common, epoch: 1, expect: [{ marketId: 1, held: null }] }), /moved.*holds a position/);
    await assert.rejects(store.bookPaperPerp({ ...common, epoch: 2, expect: [] }), /epoch 1, not the 2/);
    await assert.rejects(
      store.bookPaperPerp({ ...common, epoch: 1, expect: [], positions: [{ marketId: 3, side: null, base: 0n, allocatedMarginMicro: 0n }] }),
      /without reading it/,
    );
    await assert.rejects(store.bookPaperPerp({ ...common, epoch: 1, expect: [], cashDeltaMicro: -93_000_000n }), /cannot fund/);
    assert.equal(cash(id), 92, "none of them moved the cash");
  });
});

// ── pricing ─────────────────────────────────────────────────────────────────

describe("the paper venue prices only against what it can see", () => {
  it("refuses to fill against a book older than 10 s, and writes nothing", async () => {
    const id = await agent();
    const ex = executor(id);
    await ex.setLeverage!(1, 5000);
    const intent = openLong();
    const review = await ex.review(intent);
    venue.bookAge = 10_500;
    await refusedWith(ex.review(intent), "perp-unpriced");
    await refusedWith(ex.place(intent, review, { decisionId: null, agentId: id }), "perp-unpriced");
    assert.equal(rows("SELECT id FROM perp_orders WHERE agent_id = ?", id.toLowerCase()).length, 0);
    assert.equal(cash(id), 100);
  });

  it("refuses an open on prices older than 30 s, but still fills an exit against a fresh book", async () => {
    const { id, ex } = await holding();
    venue.priceAge = 31_000;
    await refusedWith(ex.review(openLong()), "perp-unpriced");
    venue.bids = [[790_000, 1_000]];
    const exit = exitLong("close", 20n);
    const placed = await ex.place(exit, await ex.review(exit), { decisionId: null, agentId: id });
    assert.equal(placed.status, "filled");
    assert.equal(position(id)?.base, "0");
  });

  it("an unread feed is perp-unpriced, never a fill at some older price", async () => {
    const id = await agent();
    const ex = createPaperPerpExecutor({ agentId: id, epoch: 1, feed: () => null, store, now: () => clock, paperStartUsdg: 100 });
    await refusedWith(ex.review(openLong()), "perp-unpriced");
  });

  it("an open needs the market isolated at exactly its IMF, a stop, and a flat market", async () => {
    const id = await agent();
    const ex = executor(id);
    await refusedWith(ex.review(openLong()), "perp-leverage-unset");
    await ex.setLeverage!(1, 1000);
    await refusedWith(ex.review(openLong()), "perp-leverage-mismatch");
    await refusedWith(ex.setLeverage!(1, 100), "perp-leverage-mismatch"); // below BTC's 200 bp minimum
    await ex.setLeverage!(1, 5000);
    await refusedWith(ex.review(openLong({ stopTrigger: undefined, stopPrice: undefined })), "perp-stop-required");
    await refusedWith(ex.review(openLong({ market: "ETH-PERP" })), "perp-order-malformed");
    await refusedWith(ex.review(openLong({ reduceOnly: true })), "perp-order-malformed");
    const intent = openLong();
    await ex.place(intent, await ex.review(intent), { decisionId: null, agentId: id });
    await refusedWith(ex.review(openLong()), "perp-add-to-position");
    await refusedWith(ex.setLeverage!(1, 1000), "perp-leverage-mismatch"); // not while a position is open
    await refusedWith(ex.place(intent, await ex.review(exitLong("close", 20n)), { decisionId: null, agentId: "0xsomeoneelse" }), "perp-order-malformed");
  });

  it("an IOC with nothing inside its worst price is booked cancelled, children and all, and moves no money", async () => {
    const id = await agent();
    const ex = executor(id);
    await ex.setLeverage!(1, 5000);
    venue.asks = [[805_000, 1_000]];
    const intent = openLong();
    const review = await ex.review(intent);
    assert.equal(review.expectedFill, "none");
    const placed = await ex.place(intent, review, { decisionId: null, agentId: id });
    assert.equal(placed.status, "cancelled");
    const legs = rows("SELECT role, status FROM perp_order_legs WHERE order_id = ? ORDER BY client_order_index", placed.orderRowId);
    assert.deepEqual(legs.map((l) => `${l.role}:${l.status}`), ["entry:cancelled", "sl:cancelled"]);
    assert.equal(rows("SELECT 1 FROM perp_fills WHERE agent_id = ?", id.toLowerCase()).length, 0);
    assert.equal(position(id)?.base, "0");
    assert.equal(cash(id), 100);
    assert.equal(await store.perpOpenNotionalSince(id, "paper", Math.floor(Date.now() / 1000) - 60), 0n, "an IOC that filled nothing spent nothing");
  });
});

// ── exits ───────────────────────────────────────────────────────────────────

describe("exits are clamped, never flipped", () => {
  it("a close returns the margin and the realized P&L, and cancels the resting children", async () => {
    const { id, ex } = await holding();
    venue.bids = [[840_000, 1_000]];
    venue.asks = [[840_100, 1_000]];
    const exit = exitLong("close", 20n, 830_000n);
    const placed = await ex.place(exit, await ex.review(exit), { decisionId: "d-2", agentId: id });
    assert.equal(placed.status, "filled");
    assert.equal(placed.realizedMicro, 800_000n);
    assert.equal(cash(id), 100.8);
    const pos = position(id)!;
    assert.equal(pos.base, "0");
    assert.equal(pos.side, null);
    assert.equal(pos.imf_bp, 5000, "a flat row keeps the market's leverage state");
    const [order] = rows("SELECT * FROM perp_orders WHERE agent_id = ? AND effect = 'close'", id.toLowerCase());
    assert.equal(order?.reduce_only, 1);
    const legs = rows("SELECT role, status, venue_status FROM perp_order_legs WHERE agent_id = ? ORDER BY client_order_index", id.toLowerCase());
    assert.deepEqual(legs.map((l) => `${l.role}:${l.status}`), ["entry:filled", "sl:cancelled", "close:filled"]);
    assert.equal(await store.perpOpenNotionalSince(id, "paper", Math.floor(Date.now() / 1000) - 60), 16_000_000n, "an exit is never spend");
    assert.deepEqual(verifyChain(await store.readJournal(id, 1)), []);
  });

  it("a reduce larger than the position is a close — the account ends flat, never short", async () => {
    const { id, ex } = await holding();
    const exit = exitLong("reduce", 50n);
    const review = await ex.review(exit);
    assert.equal(review.effect, "close");
    assert.equal(review.baseAmount, 20n);
    await ex.place(exit, review, { decisionId: null, agentId: id });
    assert.equal(position(id)?.base, "0");
    assert.equal(position(id)?.side, null);
    await refusedWith(ex.review(exitLong("close", 20n)), "perp-no-position");
  });

  it("a reduce that would leave less than the market minimum closes the whole position", async () => {
    const id = await agent();
    const ex = executor(id);
    await ex.setLeverage!(1, 5000);
    const open = openLong({ baseAmount: 40n, notionalUsdg: 32_160_000n });
    await ex.place(open, await ex.review(open), { decisionId: null, agentId: id });
    const r = await ex.review(exitLong("reduce", 30n));
    assert.equal(r.effect, "close", "a 0.0001 BTC stub is under BTC's 0.0002 minimum");
    const ok = await ex.review(exitLong("reduce", 20n));
    assert.equal(ok.effect, "reduce");
    assert.equal(ok.baseAmount, 20n);
    await refusedWith(ex.review({ ...exitLong("close", 40n), side: "short" } as PerpOrderIntent), "perp-side-mismatch");
  });
});

// ── the venue's own clock ───────────────────────────────────────────────────

describe("tick: funding, resting children and liquidation", () => {
  it("charges each funding hour once, however often a tick — or a restarted worker — sees it", async () => {
    const { id, ex } = await holding();
    clock = H * 1000 + 60_000;
    venue.lastFunding = { pct: "0.0012", atMs: H * 1000 + 40 };
    const first = await ex.tick!();
    assert.deepEqual(first.events.map((e) => `${e.kind}:${e.outcome}:${e.paymentMicro}`), ["funding:paid:-192"]);
    const again = await ex.tick!();
    assert.deepEqual(again.events, [], "the same hour is not charged twice");
    const restarted = executor(id);
    assert.deepEqual((await restarted.tick!()).events, [], "nor after a restart");
    const funding = rows("SELECT funding_id, funding_hour, payment_micro FROM perp_funding WHERE agent_id = ?", id.toLowerCase());
    assert.deepEqual(funding.map((f) => ({ ...f })), [{ funding_id: `paper:funding:1:${H}`, funding_hour: H, payment_micro: "-192" }]);
    assert.equal(position(id)?.allocated_margin_micro, String(8_000_000 - 192));
    assert.equal(position(id)?.funding_hour_applied, H);
    assert.equal(cash(id), 92, "funding moves the isolated margin, not the cash");
    // The next hour is a new payment.
    clock += 3_600_000;
    venue.lastFunding = { pct: "0.0012", atMs: (H + 3600) * 1000 + 40 };
    assert.equal((await restarted.tick!()).events.length, 1);
    assert.equal(rows("SELECT 1 FROM perp_funding WHERE agent_id = ?", id.toLowerCase()).length, 2);
    const journal = await store.readJournal(id, 1);
    assert.deepEqual(journal.map((j) => j.kind), ["perp-fill", "funding", "funding"]);
    assert.deepEqual(verifyChain(journal), []);
  });

  it("a booked funding hour replayed straight at the ledger is a duplicate that moves nothing", async () => {
    const { id, ex } = await holding();
    clock = H * 1000 + 60_000;
    venue.lastFunding = { pct: "0.0012", atMs: H * 1000 + 40 };
    await ex.tick!();
    const replay = {
      agentId: id,
      epoch: 1,
      // A replay is recognised by its identity before the book is consulted.
      expect: [{ marketId: 1, held: null }],
      funding: { fundingId: `paper:funding:1:${H}`, marketId: 1, fundingHour: H, paymentMicro: -192n, ratePpm: 12, positionBase: 20n, positionSide: "long" as const },
      positions: [],
      cashDeltaMicro: 0n,
    };
    assert.equal(await store.bookPaperPerp(replay), "duplicate");
    assert.equal(await store.bookPaperPerp({ ...replay, funding: { ...replay.funding, fundingId: "paper:funding:1:other" } }), "duplicate", "one payment per hour, whatever its id");
    assert.equal(rows("SELECT 1 FROM perp_funding WHERE agent_id = ?", id.toLowerCase()).length, 1);
  });

  it("a stop crossed on mark fills into the book as a venue-stop, closing the position and the take with it", async () => {
    const id = await agent();
    const ex = executor(id);
    await ex.setLeverage!(1, 5000);
    const intent = openLong({ takeTrigger: 880_000n, takePrice: 862_400n });
    await ex.place(intent, await ex.review(intent), { decisionId: null, agentId: id });
    clock += 5_000;
    venue.mark = 750_000n;
    venue.bids = [[750_000, 1_000]];
    const r = await ex.tick!();
    assert.equal(r.failed, null);
    assert.deepEqual(r.events.map((e) => `${e.kind}:${e.outcome}`), ["sl:closed"]);
    assert.equal(r.events[0]?.realizedMicro, -1_000_000n);
    const [f] = rows("SELECT * FROM perp_fills WHERE agent_id = ? AND attribution = 'venue-stop'", id.toLowerCase());
    assert.match(String(f?.venue_trade_id), /^paper:sl:1:\d+$/);
    const sl = rows("SELECT * FROM perp_order_legs WHERE agent_id = ? AND role = 'sl'", id.toLowerCase())[0];
    assert.equal(f?.order_id, sl?.order_id, "the stop's fill is tied to the open that placed it");
    assert.equal(f?.client_order_index, sl?.client_order_index);
    const legs = rows("SELECT role, status, venue_status FROM perp_order_legs WHERE agent_id = ? ORDER BY client_order_index", id.toLowerCase());
    assert.deepEqual(legs.map((l) => `${l.role}:${l.status}:${l.venue_status}`), ["entry:filled:paper", "sl:filled:paper-stop", "tp:cancelled:paper-stop"]);
    assert.equal(position(id)?.base, "0");
    assert.equal(cash(id), 99);
    assert.deepEqual((await ex.tick!()).events, [], "nothing left to fire");
  });

  it("a stop that gaps past its bound is spent and leaves the position open, as the venue does", async () => {
    const { id, ex } = await holding();
    clock += 5_000;
    venue.mark = 750_000n;
    venue.bids = [[740_000, 1_000]];
    const r = await ex.tick!();
    assert.deepEqual(r.events.map((e) => `${e.kind}:${e.outcome}`), ["sl:gapped"]);
    const pos = position(id)!;
    assert.equal(pos.base, "20", "still open");
    assert.equal(pos.stop_trigger, null, "and without its stop");
    assert.equal(pos.allocated_margin_micro, "8000000");
    const sl = rows("SELECT status, venue_status FROM perp_order_legs WHERE agent_id = ? AND role = 'sl'", id.toLowerCase())[0];
    assert.deepEqual({ ...sl }, { status: "cancelled", venue_status: "paper-gapped" });
    assert.equal(rows("SELECT 1 FROM perp_fills WHERE agent_id = ? AND attribution = 'venue-stop'", id.toLowerCase()).length, 0);
    assert.equal(cash(id), 92);
  });

  it("the liquidation engine closes what the stop could not, as a venue-forced fill with the venue's fee", async () => {
    const id = await agent();
    const ex = executor(id);
    await ex.setLeverage!(1, 1000);
    const intent = openLong({ imfBp: 1000 });
    await ex.place(intent, await ex.review(intent), { decisionId: null, agentId: id });
    assert.equal(cash(id), 98.4, "10x: 1.6 USDG of margin");
    clock += 5_000;
    venue.mark = 728_000n;
    venue.bids = [[700_000, 1_000]];
    const r = await ex.tick!();
    assert.equal(r.failed, null);
    assert.deepEqual(r.events.map((e) => `${e.kind}:${e.outcome}`), ["sl:gapped", "liq:liquidated"]);
    const liq = r.events[1]!;
    assert.equal(liq.realizedMicro, -1_440_000n);
    assert.equal(liq.feeMicro, 145_600n);
    assert.equal(liq.cashDeltaMicro, 14_400n);
    const [f] = rows("SELECT * FROM perp_fills WHERE agent_id = ? AND trade_type = 'liquidation'", id.toLowerCase());
    assert.equal(f?.attribution, "venue-forced");
    assert.equal(f?.order_id, null, "no intent of ours produced it");
    assert.equal(position(id)?.base, "0");
    assert.ok(Math.abs(cash(id) - 98.4144) < 1e-9);
    const journal = await store.readJournal(id, 1);
    assert.deepEqual(journal.map((j) => j.kind), ["perp-fill", "perp-fill"]);
    assert.deepEqual(verifyChain(journal), []);
  });

  it("an event whose booking fails moves nothing, stops the pass, and fires again next tick", async () => {
    const { id, ex } = await holding();
    clock += 5_000;
    venue.mark = 750_000n;
    venue.bids = [[750_000, 1_000]];
    raw.exec("CREATE TRIGGER fail_journal BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END");
    let r;
    try {
      r = await ex.tick!();
    } finally {
      raw.exec("DROP TRIGGER fail_journal");
    }
    assert.equal(r.failed?.kind, "sl");
    assert.match(r.failed?.error ?? "", /injected journal failure/);
    assert.deepEqual(r.events, []);
    assert.equal(position(id)?.base, "20");
    assert.equal(position(id)?.stop_trigger, "760000");
    assert.equal(cash(id), 92);
    assert.equal(rows("SELECT 1 FROM perp_fills WHERE agent_id = ? AND attribution = 'venue-stop'", id.toLowerCase()).length, 0);
    const again = await ex.tick!();
    assert.deepEqual(again.events.map((e) => `${e.kind}:${e.outcome}`), ["sl:closed"]);
    assert.equal(cash(id), 99);
  });

  it("says what it could not judge: stale prices fire nothing and are named", async () => {
    const { id, ex } = await holding();
    clock += 5_000;
    venue.mark = 700_000n;
    venue.priceAge = 31_000;
    const r = await ex.tick!();
    assert.deepEqual(r.events, []);
    assert.ok(r.unread.some((u) => u.marketId === 1 && /no fresh mark/.test(u.why)));
    assert.equal(position(id)?.base, "20");
  });

  it("a paper reset takes the book, the children and the cash back to the start", async () => {
    const { id } = await holding();
    await store.resetPaperLedger(id, 100);
    assert.equal(position(id), undefined);
    assert.equal(cash(id), 100);
    const open = rows("SELECT 1 FROM perp_order_legs WHERE agent_id = ? AND status = 'open'", id.toLowerCase());
    assert.equal(open.length, 0, "no simulated stop outlives the reset");
  });
});
