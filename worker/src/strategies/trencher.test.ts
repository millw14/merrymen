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
import { entryGatesOf } from "../entry-gates";

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

  it("REFUSES anything it had no price for", () => {
    const v = shouldEnter(candidate({ priceable: false }), cfg, NOW);
    assert.equal(v.enter, false);
    // No cause recorded, so it must say that rather than name one.
    assert.match(v.enter === false ? v.why : "", /nobody recorded why/);
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
  it("keeps entry quality, and halves the size to trade ten times in the vault's day", () => {
    // The vault caps 25 USDG of buys a day at most 5 a buy: dollars, not trades.
    assert.equal(TRENCHER_FAST.perEntryUsdg, 2_500_000n);
    assert.equal(25_000_000n / TRENCHER_FAST.perEntryUsdg, 10n);
    assert.ok(TRENCHER_FAST.perEntryUsdg <= TRENCHER_DEFAULTS.perEntryUsdg, "fast never sizes above the default");
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
      else {
        const order = orders[0];
        assert.ok(order?.kind === "swap");
        assert.equal(order.notionalUsdg, BigInt(Math.min(amount, 5) * 1e6));
      }
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

/**
 * A COIN THE KEY CANNOT SELL BACK IS NOT A CANDIDATE.
 *
 * It cleared every entry bound, took the tick's one entry — and with the Brain
 * required, a paid review first — and the wall refused it `no-exit`, every
 * tick. Skipped before shouldEnter and before the Brain now, so the next
 * candidate gets the slot; said once per coin, because the refusal used to be
 * where the owner learned to re-sign.
 */
describe("entry gates: skipped before shouldEnter and the Brain", () => {
  const USDG = "0x00000000000000000000000000000000000000aa" as const;
  const LOCKED = "0x00000000000000000000000000000000000000c1" as const;
  const OPEN = "0x00000000000000000000000000000000000000c2" as const;
  const VAULT = "0x00000000000000000000000000000000000000f1" as const;
  const gates = entryGatesOf({ allowedAssets: [USDG, LOCKED, OPEN], sellableAssets: [USDG, OPEN] });

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
      entryGates: gates,
      ...over,
    }) as Snapshot;

  const build = (candidates: Candidate[], over: Record<string, unknown> = {}) => {
    const notes: string[] = [];
    const asked: string[] = [];
    const s = makeTrencher({
      cfg: TRENCHER_DEFAULTS,
      swapRouter: "0x00000000000000000000000000000000000000f0",
      usdgToken: USDG,
      candidates: () => candidates,
      open: () => [],
      liquidityOf: () => null,
      onNote: (_level, message) => notes.push(message),
      brainOrder: (symbol) => {
        asked.push(symbol);
        return { side: "buy", usdgAmount: 5, decisionId: `d-${symbol}` } as never;
      },
      ...over,
    });
    return { s, notes, asked };
  };

  it("SKIPS THE LOCKED COIN and enters the next one in the same tick", async () => {
    const { s } = build([candidate({ symbol: "LOCK", token: LOCKED }), candidate({ symbol: "OPEN", token: OPEN })]);
    const intents = await run(s, snap());
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.kind === "swap" && intents[0].buyToken, OPEN);
  });

  it("the Brain is never asked about it — the paid review was the expensive half", async () => {
    const { s, asked } = build([candidate({ symbol: "LOCK", token: LOCKED })], { brainRequired: true });
    assert.deepEqual(await run(s, snap()), []);
    assert.deepEqual(asked, []);
  });

  it("and shouldEnter never writes its 'passing on' note for it: the one sentence is the gate's, once", async () => {
    const { s, notes } = build([candidate({ symbol: "LOCK", token: LOCKED, liquidityUsd: 1 })]);
    for (let tick = 0; tick < 5; tick++) await run(s, snap());
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /^trencher: skipping LOCK — this key can't approve it for a sell.*no-exit/);
  });

  it("AN ARM DOES NOT REBUILD THIS: a coin seen covered, then gated again, earns a fresh note", async () => {
    // A re-sign reuses the strategy (only a settings change builds a new one),
    // so the once-per-coin set is forgotten for a coin the moment it is seen
    // ungated — not by an arm that never reaches it.
    const covered = entryGatesOf({ allowedAssets: [USDG, LOCKED, OPEN], sellableAssets: [USDG, LOCKED, OPEN] });
    const { s, notes } = build([candidate({ symbol: "LOCK", token: LOCKED })]);
    const skips = () => notes.filter((n) => /^trencher: skipping LOCK/.test(n)).length;
    await run(s, snap());
    await run(s, snap());
    assert.equal(skips(), 1, "once while the gate stands");
    assert.equal((await run(s, snap({ entryGates: covered }))).length, 1, "a re-sign covers it: bought");
    await run(s, snap());
    assert.equal(skips(), 2, "a later re-sign drops it again: a new fact, said again");
  });

  it("WATCHED TOKENS ONLY: an unwatched candidate keeps shouldEnter's own sentence", async () => {
    const stranger = "0x00000000000000000000000000000000000000d9" as const;
    const { s, notes } = build([candidate({ symbol: "ANON", token: stranger, priceable: false, unpriceable: "not-watched" })]);
    await run(s, snap());
    assert.deepEqual(notes, ["trencher: passing on ANON — no watched token matches that symbol and address"]);
  });

  it("a custody candidate is judged by its vault, not by these lists", async () => {
    const { s } = build([candidate({ symbol: "LOCK", token: LOCKED, custodyVault: VAULT })]);
    const intents = await run(s, snap());
    assert.equal(intents.length, 1);
    assert.equal(intents[0]?.kind === "swap" && intents[0].custody, "trencher");
  });

  it("an absent hint gates nothing", async () => {
    const { s } = build([candidate({ symbol: "LOCK", token: LOCKED })]);
    assert.equal((await run(s, snap({ entryGates: undefined }))).length, 1);
  });
});
