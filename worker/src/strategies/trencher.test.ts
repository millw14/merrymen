/**
 * The trencher's two decisions. These tests are mostly about the ASYMMETRY:
 * entering must require every condition, leaving must require only one, and the
 * exits that precede a total loss (unpriceable, liquidity walking out) must fire
 * before the ordinary stop-loss ever gets a chance to.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  TRENCHER_DEFAULTS,
  TRENCHER_FAST,
  makeTrencher,
  priceMoveBps,
  shouldEnter,
  shouldExit,
  type Candidate,
  type OpenPosition,
} from "./trencher";
import { takeTick, type Snapshot, type Strategy } from "./types";

/**
 * A strategy may now return reasons alongside its intents. These tests are about
 * the intents, so normalise and keep asserting on those.
 */
const run = async (s: Strategy, sn: Snapshot) => takeTick(await s.tick(sn)).intents;

const p8 = (v: number) => BigInt(Math.round(v * 1e8));

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  symbol: "CATE",
  token: "0x00000000000000000000000000000000000000c1",
  decimals: 18,
  priceable: true,
  liquidityUsd: 120_000,
  fdvUsd: 800_000,
  ageSec: 45 * 60,
  price8: p8(0.001),
  ...over,
});

const cfg = TRENCHER_DEFAULTS;
const NOW = 1_800_000_000;

describe("shouldEnter — every condition must hold", () => {
  it("accepts a candidate that clears everything", () => {
    assert.equal(shouldEnter(candidate(), cfg, NOW).enter, true);
  });

  it("REFUSES anything the pool guards wouldn't price", () => {
    const v = shouldEnter(candidate({ priceable: false }), cfg, NOW);
    assert.equal(v.enter, false);
    assert.match(v.enter === false ? v.why : "", /can't be priced/);
  });

  it("REFUSES a pool too thin to leave", () => {
    const v = shouldEnter(candidate({ liquidityUsd: 5_000 }), cfg, NOW);
    assert.equal(v.enter, false);
    assert.match(v.enter === false ? v.why : "", /deep/);
  });

  it("REFUSES both ends of the FDV band", () => {
    assert.equal(shouldEnter(candidate({ fdvUsd: 1_000 }), cfg, NOW).enter, false);
    assert.equal(shouldEnter(candidate({ fdvUsd: 50_000_000 }), cfg, NOW).enter, false);
  });

  it("REFUSES the first minutes — the window where anything happens", () => {
    const v = shouldEnter(candidate({ ageSec: 60 }), cfg, NOW);
    assert.equal(v.enter, false);
    assert.match(v.enter === false ? v.why : "", /too early/);
  });

  it("REFUSES something that isn't a new pair any more", () => {
    assert.equal(shouldEnter(candidate({ ageSec: 5 * 86_400 }), cfg, NOW).enter, false);
  });

  it("names a reason on every refusal — silence is indistinguishable from a broken feed", () => {
    for (const c of [
      candidate({ priceable: false }),
      candidate({ liquidityUsd: 0 }),
      candidate({ fdvUsd: 0 }),
      candidate({ fdvUsd: 1e12 }),
      candidate({ ageSec: 0 }),
      candidate({ ageSec: 1e9 }),
    ]) {
      const v = shouldEnter(c, cfg, NOW);
      assert.equal(v.enter, false);
      assert.ok(v.enter === false && v.why.length > 0);
    }
  });

  it("one failing condition is enough, even when the rest look excellent", () => {
    const great = candidate({ liquidityUsd: 5_000_000, fdvUsd: 400_000, ageSec: 3600 });
    assert.equal(shouldEnter(great, cfg, NOW).enter, true);
    assert.equal(shouldEnter({ ...great, priceable: false }, cfg, NOW).enter, false);
  });
});

const position = (over: Partial<OpenPosition> = {}): OpenPosition => ({
  symbol: "CATE",
  token: "0x00000000000000000000000000000000000000c1",
  entryPrice8: p8(0.001),
  entryLiquidityUsd: 120_000,
  entrySec: NOW - 3600,
  costUsdg: 5_000_000n,
  qtyRaw: 10n ** 18n,
  ...over,
});

describe("shouldExit — any one condition is enough", () => {
  const flat = { price8: p8(0.001), liquidityUsd: 120_000, nowSec: NOW };

  it("holds when nothing has broken", () => {
    assert.equal(shouldExit(position(), flat, cfg).exit, false);
  });

  it("LEAVES when it can no longer be priced, before anything else is checked", () => {
    const v = shouldExit(position(), { ...flat, price8: null }, cfg);
    assert.equal(v.exit, true);
    assert.match(v.exit === true ? v.why : "", /can't be priced/);
  });

  it("LEAVES when liquidity walks out — the shape a rug actually takes", () => {
    const v = shouldExit(position(), { ...flat, liquidityUsd: 40_000 }, cfg);
    assert.equal(v.exit, true);
    assert.match(v.exit === true ? v.why : "", /liquidity has left/);
  });

  it("checks the drain BEFORE the stop-loss — it precedes the price move", () => {
    // Liquidity gone AND price still flat: a stop-loss alone would not fire, and
    // by the time it did there might be no route out.
    const v = shouldExit(position(), { ...flat, liquidityUsd: 10_000 }, cfg);
    assert.equal(v.exit === true && /liquidity/.test(v.why), true);
  });

  it("stops out on a drawdown", () => {
    const v = shouldExit(position(), { ...flat, price8: p8(0.0005) }, cfg);
    assert.equal(v.exit, true);
    assert.match(v.exit === true ? v.why : "", /down/);
  });

  it("takes profit on the way up", () => {
    const v = shouldExit(position(), { ...flat, price8: p8(0.0025) }, cfg);
    assert.equal(v.exit, true);
    assert.match(v.exit === true ? v.why : "", /up/);
  });

  it("leaves after the maximum hold — a trench position isn't an investment", () => {
    const v = shouldExit(position({ entrySec: NOW - 10 * 86_400 }), flat, cfg);
    assert.equal(v.exit, true);
    assert.match(v.exit === true ? v.why : "", /past the window/);
  });

  it("tolerates an unreadable depth without forcing an exit on its own", () => {
    // Depth we couldn't read is not evidence of a drain. The price is still
    // good, so this holds — treating a failed read as a rug would churn.
    assert.equal(shouldExit(position(), { ...flat, liquidityUsd: null }, cfg).exit, false);
  });

  it("survives a zero entry depth without dividing by it", () => {
    const v = shouldExit(position({ entryLiquidityUsd: 0 }), { ...flat, liquidityUsd: 1 }, cfg);
    assert.equal(v.exit, false);
  });
});

describe("fast Trencher exits", () => {
  const fresh = () => position({ entrySec: NOW - 60 });
  const mark = (price: number, nowSec = NOW) => ({ price8: p8(price), liquidityUsd: 120_000, nowSec });
  it("allows ordinary volatility but exits at the loss and profit thresholds", () => {
    assert.equal(shouldExit(fresh(), mark(0.00095), TRENCHER_FAST).exit, false);
    assert.equal(shouldExit(fresh(), mark(0.0009), TRENCHER_FAST).exit, true);
    assert.equal(shouldExit(fresh(), mark(0.0012), TRENCHER_FAST).exit, true);
    assert.equal(shouldExit(fresh(), mark(0.0012), TRENCHER_DEFAULTS).exit, false);
  });

  it("allows established high-value memecoins in fast mode while rejecting invalid data", () => {
    assert.equal(shouldEnter(candidate({ fdvUsd: 400_000_000, ageSec: 365 * 86400 }), TRENCHER_FAST, NOW).enter, true);
    for (const fdvUsd of [NaN, Infinity, -Infinity]) {
      assert.equal(shouldEnter(candidate({ fdvUsd }), TRENCHER_FAST, NOW).enter, false);
    }
    assert.equal(shouldEnter(candidate({ fdvUsd: 400_000_000, liquidityUsd: 5000 }), TRENCHER_FAST, NOW).enter, false);
  });
  it("exits after 30 minutes even at a flat price", () => {
    assert.equal(shouldExit(fresh(), mark(0.001, NOW + 1800), TRENCHER_FAST).exit, true);
    assert.equal(shouldExit(fresh(), mark(0.001, NOW + 1800), TRENCHER_DEFAULTS).exit, false);
  });
  it("keeps entry quality and size unchanged", () => {
    assert.equal(TRENCHER_FAST.perEntryUsdg, TRENCHER_DEFAULTS.perEntryUsdg);
    assert.equal(shouldEnter(candidate({ liquidityUsd: 5000 }), TRENCHER_FAST, NOW).enter, false);
    assert.equal(shouldEnter(candidate({ ageSec: 30 }), TRENCHER_FAST, NOW).enter, false);
    assert.equal(shouldEnter(candidate(), TRENCHER_FAST, NOW).enter, true);
  });
});

describe("priceMoveBps", () => {
  it("measures both directions from entry", () => {
    assert.equal(priceMoveBps(p8(1), p8(2)), 10_000);
    assert.equal(priceMoveBps(p8(1), p8(0.5)), -5_000);
    assert.equal(priceMoveBps(p8(1), p8(1)), 0);
  });

  it("returns 0 on a zero entry rather than dividing by it", () => {
    assert.equal(priceMoveBps(0n, p8(1)), 0);
  });
});

/**
 * The exit that exists for "the venue went dark", and could never fire.
 *
 * shouldExit checks `price8 === null` FIRST, deliberately: a position nobody can
 * value may not be exitable at all in an hour. But makeTrencher skipped anything
 * missing from snap.holdings, and readPositions only reports what it could
 * value — so the branch was unreachable by construction. The most urgent exit
 * was the one guaranteed never to run.
 */
describe("the unpriceable exit, once it can actually be reached", () => {
  const HELD = "0x00000000000000000000000000000000000000c1" as const;

  const snap = (over: Partial<Snapshot> = {}): Snapshot =>
    ({
      cashUsdg: 1_000_000_000n,
      vaultUsdg: 0n,
      holdings: new Map(),
      prices: new Map(),
      pausedTokens: new Set<string>(),
      staleFeeds: new Set<string>(),
      sequencerUp: true,
      spendHeadroomUsdg: 1_000_000_000n,
      perTradeCapUsdg: 100_000_000n,
      ...over,
    }) as Snapshot;

  const deps = (over: Record<string, unknown> = {}) => ({
    cfg: TRENCHER_DEFAULTS,
    swapRouter: "0x00000000000000000000000000000000000000f0" as `0x${string}`,
    usdgToken: "0x00000000000000000000000000000000000000aa" as `0x${string}`,
    candidates: async () => [],
    open: async () => [position({ symbol: "CATE", token: HELD, qtyRaw: 7n * 10n ** 18n })],
    liquidityOf: () => null,
    unpriceable: () => new Set<string>(["CATE"]),
    ...over,
  });

  it("SELLS a held position nobody can price, sized from the ledger", async () => {
    // The position is absent from snap.holdings — that is what "unpriceable"
    // means here — so the quantity has to come from the cost-basis ledger.
    const intents = await run(makeTrencher(deps() as never), snap());
    assert.equal(intents.length, 1, "the whole point: an exit is proposed at all");
    const sell = intents[0] as unknown as { kind: string; sellToken: string; sellAmountRaw: bigint; notionalUsdg: bigint };
    assert.equal(sell.kind, "swap");
    assert.equal(sell.sellToken, HELD);
    assert.equal(sell.sellAmountRaw, 7n * 10n ** 18n, "the whole position, from the ledger");
  });

  it("values that sell at COST, because there is no mark to use", async () => {
    // The same substitution quarantine makes carrying an unvaluable holding
    // into equity. Inventing a mark for a token nobody can price would be
    // exactly the fabrication this repo keeps getting burned by.
    const intents = await run(makeTrencher(deps() as never), snap());
    assert.equal((intents[0] as { notionalUsdg: bigint }).notionalUsdg, 5_000_000n);
  });

  it("does NOT sell a position that is simply absent from the ledger's view", async () => {
    // Absence from snap.holdings has two causes and only one of them is a
    // reason to sell. A drifted ledger must not produce a phantom exit.
    const intents = await run(makeTrencher(deps({ unpriceable: () => new Set<string>() }) as never), snap());
    assert.deepEqual(intents, []);
  });

  it("does not sell a position with nothing left in it", async () => {
    const d = deps({ open: async () => [position({ symbol: "CATE", token: HELD, qtyRaw: 0n })] });
    assert.deepEqual(await run(makeTrencher(d as never), snap()), []);
  });

  it("still prefers the PRICED holding's own numbers when there is one", async () => {
    // The unpriceable path must not take over the ordinary one.
    const holdings = new Map([["CATE", { symbol: "CATE", token: HELD, rawBalance: 3n * 10n ** 18n, valueUsdg: 9_000_000n, decimals: 18 }]]);
    const prices = new Map([["CATE", { price8: 1n, stale: false, source: "pool" as const }]]);
    const d = deps({ unpriceable: () => new Set<string>() });
    const intents = await run(makeTrencher(d as never), snap({ holdings: holdings as never, prices: prices as never }));
    // price8 of 1 against an entry of 0.001 is a catastrophic drop — the stop
    // fires, and it sizes from the holding, not the ledger.
    assert.equal(intents.length, 1);
    assert.equal((intents[0] as { sellAmountRaw: bigint }).sellAmountRaw, 3n * 10n ** 18n);
  });

  it("respects smaller Brain-approved entries without increasing them to five dollars", async () => {
    for (const amount of [2, 5, 10, 0, NaN, Infinity]) {
      const d = deps({ open: () => [], candidates: () => [candidate()], brainRequired: true,
        brainOrder: () => ({ side: "buy", usdgAmount: amount, decisionId: "approved" }) });
      const orders = await run(makeTrencher(d as never), snap());
      if (!Number.isFinite(amount) || amount <= 0) assert.equal(orders.length, 0);
      else assert.equal(orders[0]?.notionalUsdg, BigInt(Math.min(amount, 5) * 1e6));
      assert.equal((await run(makeTrencher(d as never), snap({ perTradeCapUsdg: 1_000_000n }))).length, 0);
    }
  });
  it("exits only the vault quantity when the same asset also sits in the account", async () => {
    const custodyVault="0x00000000000000000000000000000000000000f1" as const;
    const holdings=new Map([["CATE",{symbol:"CATE",token:HELD,rawBalance:10n*10n**18n,valueUsdg:10_000_000n,decimals:18}]]);
    const prices=new Map([["CATE",{price8:1n,stale:false,source:"pool" as const}]]);
    const d=deps({open:async()=>[position({symbol:"CATE",token:HELD,custodyVault,qtyRaw:3n*10n**18n})],unpriceable:()=>new Set<string>()});
    const [intent]=await run(makeTrencher(d as never),snap({holdings:holdings as never,prices:prices as never}));
    assert.ok(intent?.kind==="swap");
    assert.equal(intent.custody,"trencher");
    assert.equal(intent.target,custodyVault);
    assert.equal(intent.sellAmountRaw,3n*10n**18n);
    assert.equal(intent.notionalUsdg,3_000_000n);
  });
});
