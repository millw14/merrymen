import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LIGHTER_MARKETS_V1, isolatedLiqPriceFromCost } from "../../../packages/core/src/index";
import {
  FUNDING_VALUE_DECIMALS,
  openPositions,
  accountReadsEmpty,
  parseAccount,
  parseAccountsByL1Address,
  parseApiKeys,
  parseDepth,
  parseFundings,
  parseMarkCandles,
  parseNextNonce,
  parseOrderBookDetails,
  parseOrderBooks,
  parseOrders,
  parsePositionFunding,
  parseSendTx,
  parseTrades,
  parseTx,
  parseWithdrawalDelay,
  parseWithdrawHistory,
  scaleLooseDecimal,
  totalAssetValueConsistent,
  type PerpAccountRead,
  type PerpDecimals,
} from "./markets";

const FIXTURES = path.join(import.meta.dirname, "fixtures");
// Fixtures are mutated freely to build malformed variants; `any` keeps that terse.
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const load = (f: string): Json => JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8")) as Json;
/** A fresh deep copy to mutate. */
const fresh = (f: string): Json => structuredClone(load(f));

const OBD = parseOrderBookDetails(load("orderBookDetails.perp.json"));
assert.ok(OBD !== null);
const DEC: ReadonlyMap<number, PerpDecimals> = OBD.decimals;

// ── orderBookDetails ────────────────────────────────────────────────────────

test("orderBookDetails: all 57 live perps parse and agree with LIGHTER_MARKETS_V1", () => {
  assert.equal(OBD.markets.size, 57);
  assert.deepEqual(OBD.refused, []);
  assert.equal(DEC.size, 57);
  for (const m of LIGHTER_MARKETS_V1) {
    const v = OBD.markets.get(m.marketId);
    assert.ok(v, `${m.key} missing`);
    assert.equal(v.market.key, m.key);
    assert.equal(v.spec.status, "active");
    // Every perp at ship time: size + price decimals = 6 (perps.ts header).
    assert.equal(v.spec.sizeDecimals + v.spec.priceDecimals, 6);
    assert.ok(v.spec.closeoutBp < v.spec.mmfBp && v.spec.mmfBp < v.spec.minImfBp && v.spec.minImfBp <= v.spec.defaultImfBp);
  }
  const btc = OBD.markets.get(1)!;
  assert.deepEqual(btc.spec, {
    marketId: 1,
    sizeDecimals: 5,
    priceDecimals: 1,
    minBaseAmount: 20n, // "0.00020"
    minQuoteMicro: 10_000_000n, // "10.000000"
    minImfBp: 200,
    defaultImfBp: 5000,
    mmfBp: 120, // 60% of the MINIMUM IMF — a per-market constant
    closeoutBp: 80,
    liquidationFeeBp: 100, // "1.0000" percent
    status: "active",
  });
  assert.equal(btc.markPrice, 832_186n);
  assert.equal(btc.indexPrice, 832_520n);
  assert.equal(btc.takerFeePpm, 0);
  assert.equal(btc.makerFeePpm, 0);
  assert.equal(btc.tradingHours, "");
});

test("orderBookDetails: a renumbered or unlisted market is refused alone; the rest stand", () => {
  const raw = fresh("orderBookDetails.perp.json");
  const rows = raw.order_book_details as Json[];
  const btc = rows.find((r) => r.market_id === 1)!;
  btc.symbol = "BTC2";
  rows.push({ ...structuredClone(rows.find((r) => r.market_id === 0)!), market_id: 57, symbol: "NEWCOIN" });
  const r = parseOrderBookDetails(raw)!;
  assert.equal(r.markets.size, 56);
  assert.equal(r.markets.has(1), false);
  assert.match(r.refused.find((x) => x.marketId === 1)!.reason, /symbol mismatch/);
  assert.match(r.refused.find((x) => x.marketId === 57)!.reason, /not in LIGHTER_MARKETS_V1/);
  // Decimals are kept for both: a position there can still be READ exactly.
  assert.ok(r.decimals.has(57) && r.decimals.has(1));
});

test("orderBookDetails: a duplicated id is refused both times", () => {
  const raw = fresh("orderBookDetails.perp.json");
  const rows = raw.order_book_details as Json[];
  rows.push(structuredClone(rows.find((r) => r.market_id === 3)!));
  const r = parseOrderBookDetails(raw)!;
  assert.equal(r.markets.has(3), false);
  assert.equal(r.refused.filter((x) => x.marketId === 3).length, 2);
});

test("orderBookDetails: force-reduce-only, hours, hidden and inactive all stop opens through spec.status", () => {
  const set = (id: number, f: (r: Json) => void) => {
    const raw = fresh("orderBookDetails.perp.json");
    f((raw.order_book_details as Json[]).find((r) => r.market_id === id)!);
    return parseOrderBookDetails(raw)!.markets.get(id)!;
  };
  assert.equal(set(1, (r) => (r.market_config.force_reduce_only = true)).spec.status, "reduce-only");
  const hours = set(16, (r) => (r.market_config.trading_hours = "09:30-16:00 America/New_York"));
  assert.equal(hours.spec.status, "inactive");
  assert.equal(hours.venueStatus, "active");
  assert.equal(set(1, (r) => (r.market_config.hidden = true)).spec.status, "inactive");
  assert.equal(set(1, (r) => (r.status = "inactive")).spec.status, "inactive");
});

test("orderBookDetails: each malformed field refuses that market, never guesses", () => {
  const cases: Array<[string, (r: Json) => void]> = [
    ["mark with more decimals than the market carries", (r) => (r.mark_price = "83218.65")],
    ["mark as a number", (r) => (r.mark_price = 83218.6)],
    ["zero mark", (r) => (r.mark_price = "0.0")],
    ["min base zero", (r) => (r.min_base_amount = "0.00000")],
    ["min quote float noise", (r) => (r.min_quote_amount = "10.0000001")],
    ["maintenance above the minimum IMF", (r) => (r.maintenance_margin_fraction = 250)],
    ["IMF as a percent string", (r) => (r.min_initial_margin_fraction = "2.00")],
    ["fractional decimals", (r) => (r.size_decimals = 5.5)],
    ["market_config missing", (r) => delete r.market_config],
    ["force_reduce_only as a string", (r) => (r.market_config.force_reduce_only = "false")],
    ["unknown status", (r) => (r.status = "paused")],
    ["spot typed", (r) => (r.market_type = "spot")],
    ["fee with 5 decimals", (r) => (r.taker_fee = "0.00001")],
  ];
  for (const [what, f] of cases) {
    const raw = fresh("orderBookDetails.perp.json");
    f((raw.order_book_details as Json[]).find((r) => r.market_id === 1)!);
    const r = parseOrderBookDetails(raw);
    assert.ok(r !== null, what);
    assert.equal(r.markets.has(1), false, what);
    assert.equal(r.markets.size, 56, what);
  }
  assert.equal(parseOrderBookDetails(null), null);
  assert.equal(parseOrderBookDetails({ code: 200 }), null);
  assert.equal(parseOrderBookDetails({ code: 21602, order_book_details: [] }), null);
  assert.equal(parseOrderBookDetails({ order_book_details: "x" }), null);
});

test("orderBooks: the listing parses; a bad row refuses the whole list", () => {
  const books = parseOrderBooks(load("orderBooks.json"))!;
  assert.equal(books.length, 84);
  assert.equal(books.filter((b) => b.marketType === "perp").length, 57);
  const raw = fresh("orderBooks.json");
  (raw.order_books as Json[])[0]!.market_type = "future";
  assert.equal(parseOrderBooks(raw), null);
});

// ── the account ─────────────────────────────────────────────────────────────

function acct(f: string): PerpAccountRead {
  const a = parseAccount(load(f), DEC);
  assert.ok(a !== null, `${f} did not parse`);
  return a;
}

test("account (isolated): equity is C + ΣM + ΣU from one read — never `collateral` alone", () => {
  const a = acct("account.22149.isolated.json");
  assert.equal(a.accountIndex, 22149);
  assert.equal(a.l1Address, "0x8e93b78ef08d5e36da2e2473cd9027f8c286c176");
  assert.equal(a.collateralMicro, 329_402n);
  assert.equal(a.isolatedMarginMicro, 76_476_136n + 74_277_343n);
  assert.equal(a.unrealizedMicro, 647_589n - 873_438n);
  assert.equal(a.unrealizedGainMicro, 647_589n);
  assert.equal(a.venueValueMicro, 150_857_032n);
  assert.equal(a.totalAssetValueMicro, 150_857_032n);
  assert.ok(totalAssetValueConsistent(a));
  // The trap the contract names: `collateral` is 0.2% of this account.
  assert.ok(a.collateralMicro * 100n < a.venueValueMicro);
  assert.equal(a.transactionTimeUs, 1_790_694_641_487_929);
  assert.equal(a.positions.length, 19);
  const open = openPositions(a);
  assert.deepEqual(
    open.map((p) => [p.key, p.side, p.baseAmount, p.avgEntryPrice, p.marginMode, p.imfBp, p.liqPrice]),
    [
      ["NVDA-PERP", "long", 39_685n, 23_083n, "isolated", 833, 21_810n], // "218.0989960890466" rounded UP, toward the entry
      ["QQQ-PERP", "long", 12_054n, 73_909n, "isolated", 833, 68_571n], // "685.702541162609"
    ],
  );
  const nvda = open[0]!;
  assert.equal(nvda.allocatedMarginMicro, 76_476_136n);
  assert.equal(nvda.totalFundingPaidOutMicro, 0n); // omitted by the venue when zero
  assert.equal(open[1]!.totalFundingPaidOutMicro, -12_472n);
  // Flat rows keep their per-market margin mode and IMF (rule 6 reads them while flat).
  const eth = a.positions.find((p) => p.marketId === 0)!;
  assert.deepEqual([eth.side, eth.baseAmount, eth.marginMode, eth.imfBp, eth.liqPrice], [null, 0n, "isolated", 200, null]);
});

test("account: core's liquidation math reproduces the venue's price from the parsed exact cost", () => {
  const a = acct("account.22149.isolated.json");
  for (const p of openPositions(a)) {
    const spec = OBD.markets.get(p.marketId)!.spec;
    const sign = p.side === "long" ? 1n : -1n;
    const cost = p.positionValueMicro - sign * p.unrealizedMicro;
    const liq = isolatedLiqPriceFromCost({ side: p.side!, entryCostMicro: cost, baseAmount: p.baseAmount, allocatedMarginMicro: p.allocatedMarginMicro, mmfBp: spec.mmfBp, spec });
    assert.ok(liq !== null && p.liqPrice !== null);
    const diff = liq - p.liqPrice;
    assert.ok(diff >= -1n && diff <= 1n, `${p.key}: ${liq} vs venue ${p.liqPrice}`);
  }
});

test("account (cross): ΣM = 0 and the float-rendered total is within tolerance", () => {
  for (const f of ["account.10196.cross.json", "account.7951.cross.json", "account.18958.tied.json"]) {
    const a = acct(f);
    assert.ok(totalAssetValueConsistent(a), f);
  }
  const b = acct("account.7951.cross.json");
  assert.equal(b.isolatedMarginMicro, 0n);
  // "79395.48811299999…" is 5 micro under the exact parts: noise, not money.
  assert.equal(b.venueValueMicro - b.totalAssetValueMicro!, 5n);
  const t = acct("account.18958.tied.json");
  const tied = t.positions.filter((p) => p.positionTiedOrderCount > 0).map((p) => [p.symbol, p.positionTiedOrderCount, p.pendingOrderCount]);
  assert.deepEqual(tied, [
    ["ETH", 3, 3],
    ["LIT", 3, 3],
    ["NEAR", 2, 2],
  ]);
});

test("totalAssetValueConsistent: 2 micro × (open positions + 1), and unread is inconsistent", () => {
  const a = acct("account.22149.isolated.json"); // 2 open → tolerance 6
  assert.equal(totalAssetValueConsistent({ ...a, totalAssetValueMicro: a.venueValueMicro + 6n }), true);
  assert.equal(totalAssetValueConsistent({ ...a, totalAssetValueMicro: a.venueValueMicro - 6n }), true);
  assert.equal(totalAssetValueConsistent({ ...a, totalAssetValueMicro: a.venueValueMicro + 7n }), false);
  // A missing isolated margin is not noise.
  assert.equal(totalAssetValueConsistent({ ...a, totalAssetValueMicro: a.venueValueMicro + 76_476_136n }), false);
  assert.equal(totalAssetValueConsistent({ ...a, totalAssetValueMicro: null }), false);
  const raw = fresh("account.22149.isolated.json");
  raw.accounts[0].total_asset_value = "1e2";
  const b = parseAccount(raw, DEC)!;
  assert.equal(b.totalAssetValueMicro, null);
  assert.equal(totalAssetValueConsistent(b), false);
});

test("account: omitempty allowlist — total_funding_paid_out and total_discount may be absent; present-and-bad refuses", () => {
  const raw = fresh("account.22149.isolated.json");
  delete raw.accounts[0].positions[0].total_funding_paid_out;
  assert.ok(parseAccount(raw, DEC) !== null);
  raw.accounts[0].positions[0].total_discount = "0.000000";
  assert.ok(parseAccount(raw, DEC) !== null);
  raw.accounts[0].positions[0].total_discount = "zero";
  assert.equal(parseAccount(raw, DEC), null);
});

test("account: any malformed field makes the whole account UNREAD — never a row dropped, never a zero", () => {
  const nvda = (raw: Json) => (raw.accounts[0].positions as Json[]).find((p) => p.market_id === 15)!;
  const cases: Array<[string, (raw: Json) => void]> = [
    ["collateral with 7 dp", (r) => (r.accounts[0].collateral = "0.3294021")],
    ["collateral as a number", (r) => (r.accounts[0].collateral = 0.329402)],
    ["collateral missing", (r) => delete r.accounts[0].collateral],
    ["transaction_time missing", (r) => delete r.accounts[0].transaction_time],
    ["positions not a list", (r) => (r.accounts[0].positions = {})],
    ["shares missing", (r) => delete r.accounts[0].shares],
    ["two accounts", (r) => r.accounts.push(structuredClone(r.accounts[0]))],
    ["index ≠ account_index", (r) => (r.accounts[0].account_index = 1)],
    ["bad l1 address", (r) => (r.accounts[0].l1_address = "0x1234")],
    ["envelope error code", (r) => (r.code = 21100)],
    ["sign 2", (r) => (nvda(r).sign = 2)],
    ["sign 0 on an open position", (r) => (nvda(r).sign = 0)],
    ["margin mode 2", (r) => (nvda(r).margin_mode = 2)],
    ["cross row carrying margin", (r) => (nvda(r).margin_mode = 0)],
    ["IMF not a percent", (r) => (nvda(r).initial_margin_fraction = "eight")],
    ["size past the market's decimals", (r) => (nvda(r).position = "3.96851")],
    ["signed size", (r) => (nvda(r).position = "-3.9685")],
    ["zero entry on an open position", (r) => (nvda(r).avg_entry_price = "0.00")],
    ["exponent liquidation price", (r) => (nvda(r).liquidation_price = "2.18e2")],
    ["unrealized as float", (r) => (nvda(r).unrealized_pnl = "0.6475891")],
    ["allocated margin negative", (r) => (nvda(r).allocated_margin = "-1.000000")],
    ["funding paid present and bad", (r) => (nvda(r).total_funding_paid_out = "n/a")],
    ["order count negative", (r) => (nvda(r).open_order_count = -1)],
    ["listed id, other symbol", (r) => (nvda(r).symbol = "AMD")],
    ["duplicate market rows", (r) => r.accounts[0].positions.push(structuredClone(nvda(r)))],
  ];
  for (const [what, f] of cases) {
    const raw = fresh("account.22149.isolated.json");
    f(raw);
    assert.equal(parseAccount(raw, DEC), null, what);
  }
  // Answering for another account than asked is not an answer.
  assert.equal(parseAccount(load("account.22149.isolated.json"), DEC, { accountIndex: 22150 }), null);
  assert.equal(parseAccount(load("account.22149.isolated.json"), DEC, { l1Address: "0x0000000000000000000000000000000000000001" }), null);
  assert.ok(parseAccount(load("account.22149.isolated.json"), DEC, { accountIndex: 22149, l1Address: "0x8E93B78EF08D5E36DA2E2473CD9027F8C286C176" }));
});

test("account: spot-route balances and pending unlocks are money outside C + ΣM + ΣU — read, never dropped", () => {
  // Live: account 39 holds 308,244.59 USDG locked in the SPOT route and 15
  // stock-token balances, and total_asset_value equals the perps sum to the
  // micro — so neither the venue term nor the rule-12 cross-check sees them.
  const a = acct("account.39.spot.json");
  assert.ok(totalAssetValueConsistent(a), "the cross-check passes WITHOUT the spot money: it cannot be the guard");
  assert.equal(a.spotUsdgMicro, 308_244_594_200n);
  assert.equal(a.spotHoldings.length, 16);
  assert.deepEqual(a.spotHoldings[0], { assetId: 3, symbol: "USDG", balance: "0.000000", lockedBalance: "308244.594200" });
  assert.deepEqual(a.spotHoldings[1], { assetId: 5, symbol: "AMZN", balance: "192.5856779536", lockedBalance: "80.890000" });
  assert.equal(accountReadsEmpty(a), false);
  // Every other live capture: USDG on the perps route only, nothing in spot.
  for (const f of ["account.22149.isolated.json", "account.10196.cross.json", "account.7951.cross.json", "account.18958.tied.json"]) {
    const b = acct(f);
    assert.deepEqual([b.spotHoldings, b.spotUsdgMicro, b.pendingUnlockCount], [[], 0n, 0], f);
  }

  // A stolen key parks 5,000 USDG in spot on an otherwise EMPTY account: the
  // venue term and total_asset_value both still read zero, and only these
  // fields say the account is not empty.
  const empty = () => {
    const raw = fresh("account.22149.isolated.json");
    const r = raw.accounts[0];
    r.collateral = "0.000000";
    r.total_asset_value = "0";
    r.positions = [];
    return raw;
  };
  const flat = parseAccount(empty(), DEC)!;
  assert.equal(accountReadsEmpty(flat), true);
  const parked = empty();
  parked.accounts[0].assets[0].balance = "5000.000000";
  const p = parseAccount(parked, DEC)!;
  assert.equal(p.venueValueMicro, 0n);
  assert.equal(p.spotUsdgMicro, 5_000_000_000n);
  assert.equal(p.spotHoldings.length, 1);
  assert.equal(accountReadsEmpty(p), false);
  const unlocking = empty();
  unlocking.accounts[0].pending_unlocks = [{ asset_id: 3, amount: "5000.000000", unlock_time: 1_790_700_000_000 }];
  const u = parseAccount(unlocking, DEC)!;
  assert.equal(u.pendingUnlockCount, 1);
  assert.equal(accountReadsEmpty(u), false);
  // And the other things rule 5 counts: pool shares, orders.
  const shares = empty();
  shares.accounts[0].shares = [{ public_pool_index: 7, shares_amount: 100, entry_usdc: "100.000000" }];
  assert.equal(accountReadsEmpty(parseAccount(shares, DEC)!), false);
  const orders = empty();
  orders.accounts[0].total_order_count = 1;
  assert.equal(accountReadsEmpty(parseAccount(orders, DEC)!), false);

  // Malformed is unread, never "no spot money".
  const cases: Array<[string, (r: Json) => void]> = [
    ["assets missing", (r) => delete r.accounts[0].assets],
    ["assets not a list", (r) => (r.accounts[0].assets = {})],
    ["pending_unlocks missing", (r) => delete r.accounts[0].pending_unlocks],
    ["pending_unlocks not a list", (r) => (r.accounts[0].pending_unlocks = "none")],
    ["pending_unlocks entry not an object", (r) => (r.accounts[0].pending_unlocks = [5])],
    ["balance as a number", (r) => (r.accounts[0].assets[0].balance = 0)],
    ["balance negative", (r) => (r.accounts[0].assets[0].balance = "-1.000000")],
    ["locked balance missing", (r) => delete r.accounts[0].assets[0].locked_balance],
    ["USDG past 6 dp", (r) => (r.accounts[0].assets[0].locked_balance = "1.0000001")],
    ["asset 3 is not USDG", (r) => (r.accounts[0].assets[0].symbol = "USDC")],
    ["asset id missing", (r) => delete r.accounts[0].assets[0].asset_id],
    ["duplicate asset", (r) => r.accounts[0].assets.push(structuredClone(r.accounts[0].assets[0]))],
  ];
  for (const [what, f] of cases) {
    const raw = fresh("account.22149.isolated.json");
    f(raw);
    assert.equal(parseAccount(raw, DEC), null, what);
  }
});

test("account: a position in a market we have no decimals for is readable only while flat", () => {
  const noNvda = new Map(DEC);
  noNvda.delete(15);
  assert.equal(parseAccount(load("account.22149.isolated.json"), noNvda), null);
  const noEth = new Map(DEC);
  noEth.delete(0); // ETH is flat on this account
  const a = parseAccount(load("account.22149.isolated.json"), noEth)!;
  assert.equal(a.positions.find((p) => p.marketId === 0)!.baseAmount, 0n);
});

// ── depth ───────────────────────────────────────────────────────────────────

test("depth: venue integers, best first, top N — the whole book checked", () => {
  const d = parseDepth(load("orderBookOrders.1.json"), 1, DEC.get(1)!, 5)!;
  assert.equal(d.bids.length, 5);
  assert.equal(d.asks.length, 5);
  assert.deepEqual(d.bids[0], { price: 831_582n, baseAmount: 62_613n });
  assert.deepEqual(d.asks[0], { price: 831_631n, baseAmount: 500n });
  for (let i = 1; i < 5; i++) {
    assert.ok(d.bids[i]!.price <= d.bids[i - 1]!.price);
    assert.ok(d.asks[i]!.price >= d.asks[i - 1]!.price);
  }
  const bad = (f: (r: Json) => void) => {
    const raw = fresh("orderBookOrders.1.json");
    f(raw);
    return parseDepth(raw, 1, DEC.get(1)!, 5);
  };
  assert.equal(bad((r) => (r.asks[19].price = "abc")), null, "a bad row deep in the book");
  assert.equal(bad((r) => (r.asks[1].price = "80000.0")), null, "asks out of order");
  assert.equal(bad((r) => (r.bids[0].price = "83200.0")), null, "crossed");
  assert.equal(bad((r) => (r.bids[0].remaining_base_amount = "0.00000")), null, "empty level");
  assert.equal(bad((r) => (r.bids[0].price = "83158.25")), null, "price past the market's decimals");
  assert.equal(bad((r) => delete r.asks), null);
});

// ── funding ─────────────────────────────────────────────────────────────────

test("fundings: exact 8-dp value per base unit, rate as ppm of an hour, payer side", () => {
  const f = parseFundings(load("fundings.1.json"))!;
  assert.equal(f.resolution, "1h");
  assert.equal(FUNDING_VALUE_DECIMALS, 8);
  assert.deepEqual(f.fundings[0], { timestampSec: 1_790_686_800, valuePerBase: 84_333_200n, ratePpm: 10, direction: "long" });
  assert.equal(f.fundings.length, 4);
  assert.equal(parseFundings(load("fundings.2.json"))!.fundings.length, 48);
  const bad = (f2: (r: Json) => void) => {
    const raw = fresh("fundings.1.json");
    f2(raw);
    return parseFundings(raw);
  };
  assert.equal(bad((r) => (r.fundings[1].direction = "both")), null);
  assert.equal(bad((r) => (r.fundings[1].value = "0.505252801")), null, "9 dp");
  assert.equal(bad((r) => (r.fundings[1].rate = "0.00060")), null, "5 dp");
  assert.equal(bad((r) => (r.fundings[1].timestamp += 1)), null, "off the hour");
  assert.equal(bad((r) => (r.fundings[1].timestamp = r.fundings[0].timestamp)), null, "not increasing");
  assert.equal(bad((r) => (r.resolution = "8h")), null);
  assert.equal(bad((r) => (r.fundings[1].value = 0.5)), null, "a number");
});

test("positionFunding (synthetic, openapi shape): venue identity and exact change", () => {
  const p = parsePositionFunding(load("synthetic.positionFunding.json"), DEC)!;
  assert.deepEqual(p.rows[0], {
    timestampSec: 1_790_686_800,
    marketId: 15,
    fundingId: "881234",
    changeMicro: -12_472n,
    discountMicro: 0n,
    ratePpm: 4,
    positionSize: 39_685n,
    positionSide: "long",
  });
  assert.equal(p.nextCursor, null);
  const raw = fresh("synthetic.positionFunding.json");
  raw.position_fundings[0].change = "-0.0124721";
  assert.equal(parsePositionFunding(raw, DEC), null);
});

// ── candles ─────────────────────────────────────────────────────────────────

test("mark candles: JSON-number prices held to the market's decimals, on the grid, bounded", () => {
  const c = parseMarkCandles(load("markPriceCandles.1.1h.json"), 1)!;
  assert.equal(c.resolution, "1h");
  assert.equal(c.candles.length, 120);
  assert.deepEqual(c.candles[0], { tMs: 1_790_265_600_000, open: 843_842n, high: 848_917n, low: 840_072n, close: 844_571n });
  for (const k of c.candles) assert.equal(k.tMs % 3_600_000, 0);
  const bad = (f: (r: Json) => void) => {
    const raw = fresh("markPriceCandles.1.1h.json");
    f(raw);
    return parseMarkCandles(raw, 1);
  };
  assert.equal(bad((r) => (r.c[3].o = 88109.95)), null, "past the price decimals");
  assert.equal(bad((r) => (r.c[3].h = r.c[3].l - 1)), null, "high under low");
  assert.equal(bad((r) => (r.c[3].t = r.c[2].t)), null, "not increasing");
  assert.equal(bad((r) => (r.c[3].t += 1)), null, "off the grid");
  assert.equal(bad((r) => (r.c[3].c = "88000.0")), null, "a string");
  assert.equal(bad((r) => (r.c[3].l = 1e-7)), null, "exponent rendering");
  assert.equal(bad((r) => (r.r = "2h")), null);
  // Wrong decimals for the market refuse too (BTC at ETH's 2 would pass; at 0 it cannot).
  assert.equal(parseMarkCandles(load("markPriceCandles.1.1h.json"), 0), null);
});

// ── transactions ────────────────────────────────────────────────────────────

test("tx: status, and the order index trades are filtered by", () => {
  const t = parseTx(load("tx.1d806b89.json"))!;
  assert.equal(t.status, "executed");
  assert.equal(t.statusCode, 2);
  assert.equal(t.type, 14);
  assert.equal(t.accountIndex, 6560);
  assert.equal(t.apiKeyIndex, 6);
  assert.equal(t.nonce, 1_790_696_714_356);
  assert.equal(t.expireAtMs, 1_790_697_314_357);
  assert.equal(t.marketId, 26);
  assert.equal(t.orderIndex, "7599824390440187");
  assert.equal(t.clientOrderIndex, 696_714_356);
  assert.equal(t.appError, "");
  assert.equal(t.outcome, "executed");
  assert.equal(parseTx(load("tx.43de174b.json"), "0x43DE174B14E98B35FCE519602DEE70FEB317BC2950E49E685B5A5BC87E8D4B1EEA2C598006ACC8E2")!.orderIndex, "562950059464847");
  const mod = (f: (r: Json) => void) => {
    const raw = fresh("tx.1d806b89.json");
    f(raw);
    return parseTx(raw);
  };
  const failed = mod((r) => (r.status = 0))!;
  assert.deepEqual([failed.status, failed.outcome], ["failed", "rejected"]);
  assert.deepEqual([mod((r) => (r.status = 1))!.status, mod((r) => (r.status = 1))!.outcome], ["pending", "pending"]);
  const empty = mod((r) => (r.event_info = ""))!;
  assert.deepEqual([empty.orderIndex, empty.appError, empty.marketId], [null, null, null]);
  assert.equal(mod((r) => (r.status = 6)), null);
  assert.equal(mod((r) => (r.status = -1)), null);
  assert.equal(mod((r) => (r.event_info = "{not json")), null);
  assert.equal(mod((r) => (r.event_info = JSON.stringify({ to: { i: "7599824390440187", u: 1 } }))), null);
  assert.equal(mod((r) => (r.hash = "abc")), null);
  assert.equal(mod((r) => delete r.info), null);
  assert.equal(parseTx(load("tx.1d806b89.json"), "43de174b14e98b35fce519602dee70feb317bc2950e49e685b5a5bc87e8d4b1eea2c598006acc8e2"), null, "another tx than asked");
  assert.equal(parseTx(load("tx.notfound.json")), null);
});

test("tx: Packed, Committed and Verified are all executed — our own tx stays readable after its first minute", () => {
  // lighter-ts TX_STATUSES: 3 Packed, 4 Committed, 5 Verified, all after
  // Executed. Every /tx capture in the spike was seconds old (status 2); an
  // explorer capture shows txs Committed within a minute and Verified within
  // minutes, so a rule-9 lookup after a restart meets 4 or 5, not 2.
  for (const [code, stage] of [
    [2, "executed"],
    [3, "packed"],
    [4, "committed"],
    [5, "verified"],
  ] as const) {
    const raw = fresh("tx.1d806b89.json");
    raw.status = code;
    if (code >= 4) raw.committed_at = 1_790_696_760_000;
    if (code === 5) raw.verified_at = 1_790_697_000_000;
    const t = parseTx(raw)!;
    assert.ok(t, `status ${code} must parse`);
    assert.equal(t.status, stage);
    assert.equal(t.statusCode, code);
    assert.equal(t.outcome, "executed");
    assert.equal(t.orderIndex, "7599824390440187");
  }
});

test("tx: an application error is its own final outcome, never executed", () => {
  // lighter-ts checkTxStatus: `status === Failed || !!ae` is a failure. The
  // nonce is consumed and the order did not happen as asked.
  for (const code of [2, 3, 4, 5]) {
    const raw = fresh("tx.1d806b89.json");
    raw.status = code;
    raw.event_info = (raw.event_info as string).replace('"ae":""', '"ae":"not enough margin"');
    const t = parseTx(raw)!;
    assert.equal(t.outcome, "app-error", `status ${code}`);
    assert.equal(t.appError, "not enough margin");
  }
  const zero = fresh("tx.1d806b89.json");
  zero.status = 0;
  zero.event_info = (zero.event_info as string).replace('"ae":""', '"ae":"x"');
  assert.equal(parseTx(zero)!.outcome, "rejected");
});

test("tx: an order index past 2^53 (every market with id ≥ 31) is read exactly, never refused", () => {
  // Order indexes are (market_id + 1) << 48 plus a sequence: the live fixture
  // is market 26 with to.i >> 48 = 27. The same tx moved to market 40 (TSM's
  // neighbourhood — 26 of the 57 listed markets have id ≥ 31) has an index no
  // double can hold. Built by editing the TEXT, so the digits stay exact.
  const live = fresh("tx.1d806b89.json");
  assert.equal(BigInt(parseTx(live)!.orderIndex!) >> 48n, 27n);
  const seq = 7_599_824_390_440_187n - (27n << 48n);
  for (const m of [31, 40, 56]) {
    const idx = ((BigInt(m) + 1n) << 48n) + seq;
    assert.ok(idx > BigInt(Number.MAX_SAFE_INTEGER));
    const raw = fresh("tx.1d806b89.json");
    raw.event_info = (raw.event_info as string).replace('"m":26', `"m":${m}`).replace('"to":{"i":7599824390440187', `"to":{"i":${idx}`);
    const t = parseTx(raw);
    assert.ok(t, `market ${m} must parse`);
    assert.equal(t.marketId, m);
    assert.equal(t.outcome, "executed");
    assert.equal(t.orderIndex, idx.toString(), `market ${m}: exact, not rounded`);
    assert.equal(BigInt(t.orderIndex!) >> 48n, BigInt(m) + 1n);
  }
  // Not an order index at all still refuses: a string, a fraction, zero.
  for (const bad of ['"7599824390440187"', "1.5", "0", "-3"]) {
    const raw = fresh("tx.1d806b89.json");
    raw.event_info = (raw.event_info as string).replace('"to":{"i":7599824390440187', `"to":{"i":${bad}`);
    assert.equal(parseTx(raw), null, bad);
  }
});

test("sendTx receipt: code 200 and an 80-hex hash, or nothing", () => {
  const h = "1d806b896ed335c5c943e0beac9b5ab886a460c62c6aacdee5035b087ac5f4bb5e32507566babdd0";
  assert.deepEqual(parseSendTx({ code: 200, message: "", tx_hash: h, predicted_execution_time_ms: 300, volume_quota_remaining: 5 }), {
    txHash: h,
    predictedExecutionMs: 300,
    volumeQuotaRemaining: 5,
  });
  assert.equal(parseSendTx(load("sendTx.400.invalid-market.json")), null);
  assert.equal(parseSendTx({ code: 200, tx_hash: "0x12" }), null);
});

// ── trades ──────────────────────────────────────────────────────────────────

test("trades: ids as strings, exact size/price/usd, our side and role, fees in ppm", () => {
  const t = parseTrades(load("recentTrades.1.json"), DEC, { accountIndex: 26085 })!;
  assert.equal(t.trades.length, 20);
  const first = t.trades[0]!;
  // The fill of known-answer tx 43de174b: account 26085 sold into a resting bid.
  assert.equal(first.txHash, "43de174b14e98b35fce519602dee70feb317bc2950e49e685b5a5bc87e8d4b1eea2c598006acc8e2");
  assert.equal(first.tradeId, "1150930974");
  assert.equal(first.size, 500n);
  assert.equal(first.price, 831_306n);
  assert.equal(first.usdAmountMicro, 415_653_000n);
  assert.equal(first.askOrderIndex, "562950059464847");
  assert.deepEqual(first.ours, [{ side: "ask", role: "taker", feePpm: 0 }]); // taker_fee omitted = 0
  assert.equal(first.makerFeePpm, 102);
  assert.equal(first.askAccountPnlMicro, null); // absent publicly: unknown, not zero
  assert.equal(t.trades.filter((x) => x.makerFeePpm === 0).length >= 3, true); // maker_fee omitted = 0
  assert.ok(t.trades.some((x) => x.takerPositionSignChanged));
  // Signed position-before survives.
  assert.ok(t.trades.some((x) => x.takerPositionSizeBefore < 0n || x.makerPositionSizeBefore < 0n));
  // One live trade in market 3 omits taker_initial_margin_fraction_before (a
  // zero, omitted): the page still parses, every trade of it.
  const raw3 = load("recentTrades.3.json");
  assert.ok((raw3.trades as Json[]).some((x) => !("taker_initial_margin_fraction_before" in x)));
  assert.equal(parseTrades(raw3, DEC)!.trades.length, (raw3.trades as Json[]).length);
});

test("trades: a self-trade is two of our sides", () => {
  const raw = fresh("recentTrades.1.json");
  raw.trades[0].bid_account_id = 26085;
  const t = parseTrades(raw, DEC, { accountIndex: 26085 })!;
  assert.deepEqual(t.trades[0]!.ours, [
    { side: "ask", role: "taker", feePpm: 0 },
    { side: "bid", role: "maker", feePpm: 102 },
  ]);
});

test("trades: one bad trade refuses the page", () => {
  const cases: Array<[string, (r: Json) => void]> = [
    ["no trade_id_str", (r) => delete r.trades[5].trade_id_str],
    ["unknown type", (r) => (r.trades[5].type = "airdrop")],
    ["size past decimals", (r) => (r.trades[5].size = "0.000501")],
    ["usd with 7 dp", (r) => (r.trades[5].usd_amount = "1.0000001")],
    ["fee as a string", (r) => (r.trades[5].maker_fee = "102")],
    ["pnl present and bad", (r) => (r.trades[5].ask_account_pnl = "lots")],
    ["is_maker_ask missing", (r) => delete r.trades[5].is_maker_ask],
    ["tx hash short", (r) => (r.trades[5].tx_hash = "abc")],
    ["unknown market", (r) => (r.trades[5].market_id = 999)],
  ];
  for (const [what, f] of cases) {
    const raw = fresh("recentTrades.1.json");
    f(raw);
    assert.equal(parseTrades(raw, DEC), null, what);
  }
  const raw = fresh("recentTrades.1.json");
  raw.trades[0].ask_account_pnl = "1.500000";
  assert.equal(parseTrades(raw, DEC)!.trades[0]!.askAccountPnlMicro, 1_500_000n);
});

// ── orders, keys, accounts, withdrawals ─────────────────────────────────────

test("orders (synthetic, openapi shape): position-tied child and a resting limit; omitempty bools", () => {
  const o = parseOrders(load("synthetic.accountActiveOrders.json"), DEC)!;
  assert.equal(o.orders.length, 2);
  const [sl, lim] = o.orders as [NonNullable<typeof o.orders[0]>, NonNullable<typeof o.orders[0]>];
  assert.deepEqual(
    [sl.type, sl.isAsk, sl.reduceOnly, sl.initialBaseAmount, sl.triggerPrice, sl.price, sl.status, sl.parentOrderIndex, sl.clientOrderIndex],
    ["stop-loss", true, true, 0n, 800_000n, 784_000n, "pending", "7599824390440187", "14325614980065"],
  );
  assert.deepEqual([lim.isAsk, lim.reduceOnly, lim.triggerPrice, lim.initialBaseAmount, lim.price], [false, false, 0n, 500n, 250_000n]);
  const raw = fresh("synthetic.accountActiveOrders.json");
  raw.orders[0].status = "vanished";
  assert.equal(parseOrders(raw, DEC), null);
});

test("apikeys: the venue's bare 80 hex becomes the wall's 0x-lowercase", () => {
  const k = parseApiKeys(load("synthetic.apikeys.json"))!;
  assert.equal(k[0]!.publicKey, `0x${("01" + "00".repeat(7)).repeat(5)}`);
  assert.equal(k[0]!.apiKeyIndex, 16);
  const raw = fresh("synthetic.apikeys.json");
  raw.api_keys[0].public_key = "ab".repeat(39);
  assert.equal(parseApiKeys(raw), null);
});

test("accountsByL1Address, nextNonce, withdrawalDelay, withdraw history", () => {
  const l1 = parseAccountsByL1Address(load("synthetic.accountsByL1Address.json"), "0x8e93b78ef08d5e36da2e2473cd9027f8c286c176")!;
  assert.deepEqual(l1.accounts, [{ accountIndex: 22149, accountType: 0, collateralMicro: 329_402n }]);
  assert.equal(parseAccountsByL1Address(load("synthetic.accountsByL1Address.json"), "0x0000000000000000000000000000000000000001"), null);
  assert.equal(parseNextNonce(load("nextNonce.6560.6.json")), 1_790_694_494_082);
  assert.equal(parseNextNonce({ code: 200, nonce: -1 }), null);
  assert.equal(parseWithdrawalDelay(load("withdrawalDelay.json")), 1114);
  assert.equal(parseWithdrawalDelay({ seconds: "1114" }), null);
  const w = parseWithdrawHistory(load("synthetic.withdrawHistory.json"))!;
  assert.deepEqual(
    w.rows.map((r) => [r.id, r.amountMicro, r.status, r.l1TxHash === null]),
    [
      ["w-1", 25_000_000n, "claimable", true],
      ["w-0", 10_000_000n, "completed", false],
    ],
  );
  const raw = fresh("synthetic.withdrawHistory.json");
  raw.withdraws[0].status = "lost";
  assert.equal(parseWithdrawHistory(raw), null);
});

// ── the loose-decimal reader ────────────────────────────────────────────────

test("scaleLooseDecimal rounds in the named direction, and only for decimal renderings", () => {
  assert.equal(scaleLooseDecimal("1679.8316029999999", 6, "nearest"), 1_679_831_603n);
  assert.equal(scaleLooseDecimal("464531.73885900003", 6, "nearest"), 464_531_738_859n);
  assert.equal(scaleLooseDecimal("218.0989960890466", 2, "ceil"), 21_810n);
  assert.equal(scaleLooseDecimal("218.0989960890466", 2, "floor"), 21_809n);
  assert.equal(scaleLooseDecimal("-1.005", 2, "floor"), -101n);
  assert.equal(scaleLooseDecimal("-1.005", 2, "ceil"), -100n);
  assert.equal(scaleLooseDecimal("-1.005", 2, "nearest"), -101n);
  assert.equal(scaleLooseDecimal("7", 2, "ceil"), 700n);
  assert.equal(scaleLooseDecimal("1e3", 2, "ceil"), null);
  assert.equal(scaleLooseDecimal(12.5, 2, "ceil"), null);
  assert.equal(scaleLooseDecimal("", 2, "ceil"), null);
});
