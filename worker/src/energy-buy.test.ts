import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ENERGY, ENERGY_FULL_RAW, MERRYMEN_TOKEN } from "../../packages/core/src/index";
import {
  ENERGY_BUFFER_BPS,
  energyAskFor,
  energyGrossFor,
  planEnergyBuy,
  resolveOrderToken,
  sayEnergyOutcome,
  sayEnergyPlan,
  type EnergyBook,
  type EnergyCaps,
  type EnergyPlan,
  type EnergyPricing,
  type EnergyReads,
} from "./energy-buy";
import { grossNeededFor } from "./venues/uniswap-v2";

const TOKEN = 10n ** 18n;
const USDG = 1_000_000n;
/** A pool that sells 2,000 $MERRYMEN (pre-tax) per USDG, rounding the input up like getAmountsIn. */
const perUsdg = 2_000n * TOKEN;
const linear = (gross: bigint) => (gross * USDG + perUsdg - 1n) / perUsdg;

const reads = (over: Partial<EnergyReads> = {}): EnergyReads => ({
  holder: 20_000n * TOKEN,
  account: 0n,
  cashUsdg: 200n * USDG,
  inFlight: false,
  ...over,
});
const caps = (over: Partial<EnergyCaps> = {}): EnergyCaps => ({
  ownerMaxRaw: 25n * USDG,
  perTradeRaw: 10n * USDG,
  dailyRaw: 50n * USDG,
  spentTodayRaw: 0n,
  opsRemaining: 24,
  maxOpsPerDay: 24,
  ...over,
});
const pricing = (over: Partial<EnergyPricing> = {}): EnergyPricing => ({
  taxBps: 100,
  amountInFor: async (g) => linear(g),
  ...over,
});
const book = (over: Partial<EnergyBook> = {}): EnergyBook => ({
  paper: false,
  equityKnown: true,
  equityUsdg: 1_000n * USDG,
  netContributionsUsdg: 1_000n * USDG,
  lifetimePeakUsdg: 1_000n * USDG,
  breakerPeakUsdg: 1_000n * USDG,
  maxDrawdownBps: 500,
  ...over,
});
const plan = (r = reads(), c = caps(), p = pricing(), b = book()) => planEnergyBuy(r, c, p, b);
const buyOf = (p: EnergyPlan) => {
  assert.equal(p.kind, "buy", JSON.stringify(p, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  return p as Extract<EnergyPlan, { kind: "buy" }>;
};
const refusal = (p: EnergyPlan) => {
  assert.equal(p.kind, "refuse");
  return p as Extract<EnergyPlan, { kind: "refuse" }>;
};
/**
 * What the uncapped shortfall would cost, computed independently of the
 * planner: the shortfall plus the margin, grossed up for the tax alone, at the
 * expected rate — the owner's slippage tolerance is never in the size.
 */
const needFor = (short: bigint, tax = 100) => {
  const want = (short * BigInt(10_000 + ENERGY_BUFFER_BPS) + 9_999n) / 10_000n;
  const raw = linear(grossNeededFor(want, tax, 0));
  return raw % 10_000n === 0n ? raw : raw + (10_000n - (raw % 10_000n));
};
const NO_PRICE_WORDS = /price|returns?\b|profit|moon|pump|investment|worth|\d+(\.\d+)?\s*%/i;

describe("planEnergyBuy — every unknown refuses, by name", () => {
  it("each unreadable balance refuses and says 'could not read', never 'you hold nothing'", async () => {
    for (const r of [reads({ holder: null }), reads({ account: null }), reads({ cashUsdg: null }), reads({ holder: null, account: null })]) {
      const p = refusal(await plan(r));
      assert.equal(p.rule, "energy-unreadable");
      assert.match(p.line, /could not read/);
      assert.doesNotMatch(p.line, /hold (nothing|0|none)|you have 0/i);
    }
  });

  it("an absent half is not an unread one: no wallet counted still plans on the account alone", async () => {
    const p = buyOf(await plan(reads({ holder: undefined, account: 10_000n * TOKEN })));
    assert.equal(p.heldRaw, 10_000n * TOKEN);
  });

  it("an energy buy still settling refuses — and so does a ledger that will not say", async () => {
    assert.equal(refusal(await plan(reads({ inFlight: true }))).rule, "energy-in-flight");
    const unknown = refusal(await plan(reads({ inFlight: null })));
    assert.equal(unknown.rule, "energy-in-flight");
    assert.match(unknown.line, /could not read my own ledger/);
  });

  it("full energy is said as such, and nothing is bought", async () => {
    for (const r of [reads({ holder: ENERGY_FULL_RAW, account: 0n }), reads({ holder: 60_000n * TOKEN, account: 40_000n * TOKEN }), reads({ holder: undefined, account: ENERGY_FULL_RAW + 1n })]) {
      const p = await plan(r);
      assert.equal(p.kind, "full");
      assert.match(p.line, /full energy/);
    }
  });

  it("the tax: unreadable refuses, above the ceiling refuses, AT the ceiling plans", async () => {
    assert.equal(refusal(await plan(reads(), caps(), pricing({ taxBps: null }))).rule, "energy-tax-unreadable");
    assert.equal(refusal(await plan(reads(), caps(), pricing({ taxBps: ENERGY.maxTaxBps + 1 }))).rule, "energy-tax");
    assert.equal(refusal(await plan(reads(), caps(), pricing({ taxBps: 9_000 }))).rule, "energy-tax");
    buyOf(await plan(reads(), caps(), pricing({ taxBps: ENERGY.maxTaxBps })));
  });

  it("today's trades exhausted → ops-cap", async () => {
    assert.equal(refusal(await plan(reads(), caps({ opsRemaining: 0 }))).rule, "ops-cap");
  });

  it("a route that will not quote → energy-no-quote, never a guessed amount", async () => {
    assert.equal(refusal(await plan(reads(), caps(), pricing({ amountInFor: async () => null }))).rule, "energy-no-quote");
    assert.equal(refusal(await plan(reads(), caps(), pricing({ amountInFor: async () => 0n }))).rule, "energy-no-quote");
  });
});

describe("planEnergyBuy — the size", () => {
  it("UNCAPPED, one chunk covers the whole shortfall at exactly its v2 cost, cent-rounded up", async () => {
    const r = reads({ holder: 98_000n * TOKEN });
    const p = buyOf(await plan(r, caps({ ownerMaxRaw: 1_000n * USDG, perTradeRaw: 1_000n * USDG, dailyRaw: 1_000n * USDG })));
    const short = ENERGY_FULL_RAW - 98_000n * TOKEN;
    assert.equal(p.shortRaw, short);
    assert.equal(p.needInRaw, needFor(short));
    assert.equal(p.amountInRaw, p.needInRaw);
    assert.equal(p.amountInRaw % 10_000n, 0n, "whole cents");
    assert.equal(p.coversShortfall, true);
    assert.equal(p.binding, null);
    assert.equal(p.asksLeft, 0);
  });

  it("each cap wins when it is the smallest, and is floored to the cent", async () => {
    const big = { ownerMaxRaw: 900n * USDG, perTradeRaw: 900n * USDG, dailyRaw: 900n * USDG };
    const cases: [Partial<EnergyCaps>, Partial<EnergyReads>, string, bigint][] = [
      [{ ...big, ownerMaxRaw: 7_555_555n }, {}, "owner", 7_550_000n],
      [{ ...big, perTradeRaw: 6_123_456n }, {}, "per-trade", 6_120_000n],
      [{ ...big, dailyRaw: 50n * USDG, spentTodayRaw: 44_990_001n }, {}, "daily", 5_000_000n],
      [big, { cashUsdg: 3_999_999n }, "cash", 3_990_000n],
    ];
    for (const [c, r, binding, amount] of cases) {
      const p = buyOf(await plan(reads(r), caps(c)));
      assert.equal(p.binding, binding);
      assert.equal(p.amountInRaw, amount);
      assert.equal(p.coversShortfall, false);
    }
  });

  it("below one USDG refuses, naming the cap that bound it", async () => {
    const big = { ownerMaxRaw: 900n * USDG, perTradeRaw: 900n * USDG, dailyRaw: 900n * USDG };
    const owner = refusal(await plan(reads(), caps({ ...big, ownerMaxRaw: 999_999n })));
    assert.equal(owner.rule, "energy-too-small");
    assert.match(owner.line, /the most you set for this ask/);
    const trade = refusal(await plan(reads(), caps({ ...big, perTradeRaw: 500_000n })));
    assert.equal(trade.rule, "energy-too-small");
    assert.match(trade.line, /per-trade cap of 0\.50 USDG/);
    const daily = refusal(await plan(reads(), caps({ ...big, dailyRaw: 50n * USDG, spentTodayRaw: 49_500_000n })));
    assert.equal(daily.rule, "daily-cap");
    assert.match(daily.line, /today's 50\.00 USDG budget/);
    const overspent = refusal(await plan(reads(), caps({ ...big, dailyRaw: 50n * USDG, spentTodayRaw: 60n * USDG })));
    assert.equal(overspent.rule, "daily-cap");
    const cash = refusal(await plan(reads({ cashUsdg: 0n }), caps(big)));
    assert.equal(cash.rule, "no-cash");
    assert.match(cash.line, /the USDG in my account/);
  });

  it("a shortfall that costs under a dollar is bought AT the smallest chunk, never left unfixable", async () => {
    const p = buyOf(await plan(reads({ holder: ENERGY_FULL_RAW - 10n * TOKEN })));
    assert.ok(p.needInRaw < ENERGY.minChunkUsdg6);
    assert.equal(p.amountInRaw, ENERGY.minChunkUsdg6);
    assert.equal(p.coversShortfall, true);
  });

  it("says how many more asks the rest would take, at the per-ask ceiling", async () => {
    // The review's worked default: 20,000 held, per-trade 10, owner max 25.
    const p = buyOf(await plan());
    assert.equal(p.binding, "per-trade");
    assert.equal(p.amountInRaw, 10n * USDG);
    const rest = p.needInRaw - p.amountInRaw;
    assert.equal(p.asksLeft, Number((rest + 10n * USDG - 1n) / (10n * USDG)));
    assert.ok(p.asksLeft >= 1);
    assert.match(sayEnergyPlan(p), /≈\d+ more ask/);
  });

  it("PROPERTY: the amount never exceeds ANY cap, and is never below the smallest chunk", async () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const big = (max: number) => BigInt(Math.floor(rnd() * max));
    let bought = 0;
    for (let i = 0; i < 1500; i++) {
      const c = caps({
        ownerMaxRaw: big(40_000_000),
        perTradeRaw: big(40_000_000),
        dailyRaw: big(80_000_000),
        spentTodayRaw: big(60_000_000),
        opsRemaining: 1 + Math.floor(rnd() * 5),
      });
      const r = reads({ holder: big(100_000) * TOKEN, account: big(20_000) * TOKEN, cashUsdg: big(50_000_000) });
      const p = await plan(r, c, pricing({ taxBps: Math.floor(rnd() * 201) }));
      if (p.kind !== "buy") continue;
      bought += 1;
      const dailyLeft = c.dailyRaw > c.spentTodayRaw ? c.dailyRaw - c.spentTodayRaw : 0n;
      for (const [name, capv] of [["owner", c.ownerMaxRaw], ["per-trade", c.perTradeRaw], ["daily", dailyLeft], ["cash", r.cashUsdg!]] as const) {
        assert.ok(p.amountInRaw <= capv, `${name}: ${p.amountInRaw} > ${capv}`);
      }
      assert.ok(p.amountInRaw >= ENERGY.minChunkUsdg6);
      assert.equal(p.amountInRaw % 10_000n, 0n);
    }
    assert.ok(bought > 100, `the property must actually run (${bought} buys)`);
  });

  it("THE ESTIMATE AND THE ASK ARE ONE RULE — energyGrossFor/energyAskFor size exactly what the planner buys", async () => {
    // index.ts's "about $X" estimate prices energyAskFor(amountIn(energyGrossFor(...))).
    // Uncapped, that must be the planner's own amount, to the cent — it once
    // priced the bare shortfall and under-stated the ask.
    const big = caps({ ownerMaxRaw: 900n * USDG, perTradeRaw: 900n * USDG, dailyRaw: 900n * USDG });
    for (const [held, tax] of [
      [20_000n, 100],
      [12_345n, 0],
      [99_000n, 200],
      [99_995n, 100], // a few tokens short: the smallest buy
    ] as const) {
      const short = ENERGY_FULL_RAW - held * TOKEN;
      const p = buyOf(await plan(reads({ holder: held * TOKEN, cashUsdg: 900n * USDG }), big, pricing({ taxBps: tax })));
      const estimate = energyAskFor(linear(energyGrossFor(short, tax)));
      assert.equal(estimate, p.amountInRaw, `held ${held}, tax ${tax}`);
      assert.equal(p.needInRaw, needFor(short, tax), "and the independent arithmetic agrees");
      // A card sized at the estimate covers the shortfall in one ask.
      const atEstimate = buyOf(await plan(reads({ holder: held * TOKEN, cashUsdg: 900n * USDG }), caps({ ...big, ownerMaxRaw: estimate }), pricing({ taxBps: tax })));
      assert.equal(atEstimate.coversShortfall, true, `held ${held}: the estimate is enough`);
      assert.equal(atEstimate.asksLeft, 0);
    }
  });

  it("the ask is rounded up to the cent and is never under the smallest buy", () => {
    assert.equal(energyAskFor(1n), ENERGY.minChunkUsdg6);
    assert.equal(energyAskFor(ENERGY.minChunkUsdg6 - 1n), ENERGY.minChunkUsdg6);
    assert.equal(energyAskFor(ENERGY.minChunkUsdg6 + 1n), ENERGY.minChunkUsdg6 + 10_000n);
    assert.equal(energyAskFor(37_120_000n), 37_120_000n);
  });

  it("THE SIZE IS THE EXPECTED-RATE COST: the margin and the tax are in it, the owner's slippage is NOT", () => {
    const short = 87_655n * TOKEN;
    const bare = grossNeededFor(short, 100, 0);
    const sized = energyGrossFor(short, 100);
    assert.ok(sized > bare, "the margin is in the size");
    // Exactly the shortfall plus 50 bps, grossed up for the tax alone.
    assert.equal(sized, grossNeededFor((short * 10_050n + 9_999n) / 10_000n, 100, 0));
    // What arrives at the quoted rate is the shortfall plus the margin — not
    // plus the slippage setting too, which bought ~11.7% over at the maximum.
    const afterTax = (sized * 9_900n) / 10_000n;
    assert.ok(afterTax >= short && afterTax - short <= (short * 51n) / 10_000n, "over by the margin, and only the margin");
  });

  it("THE OWNER'S SLIPPAGE TOLERANCE DOES NOT CHANGE THE SIZE — it is the router's floor, nothing else", async () => {
    // The plan has no slippage input at all; what the executor floors at is
    // energyMinOut(re-quote, tax, cfg.slippageBps) — pinned in energy-buy-wiring.
    const big = caps({ ownerMaxRaw: 900n * USDG, perTradeRaw: 900n * USDG, dailyRaw: 900n * USDG });
    const p = buyOf(await plan(reads({ holder: 20_000n * TOKEN, cashUsdg: 900n * USDG }), big));
    const short = ENERGY_FULL_RAW - 20_000n * TOKEN;
    const worstCase = energyAskFor(linear(grossNeededFor((short * 10_050n + 9_999n) / 10_000n, 100, 1_000)));
    assert.ok(p.amountInRaw < worstCase, "no longer sized for the worst case");
    assert.equal(p.amountInRaw, needFor(short));
  });

  it("DETERMINISTIC: the same reads give the same plan", async () => {
    const a = await plan();
    const b = await plan();
    assert.deepEqual(a, b);
  });
});

describe("planEnergyBuy — the accounting gate, on the size to be spent", () => {
  it("an untotalled book refuses", async () => {
    assert.equal(refusal(await plan(reads(), caps(), pricing(), book({ equityKnown: false }))).rule, "book-untotalled");
  });
  it("no contribution record refuses, live", async () => {
    assert.equal(refusal(await plan(reads(), caps(), pricing(), book({ netContributionsUsdg: null }))).rule, "no-contribution-record");
  });
  it("a spend that would put the drawdown at the limit refuses, and the limit is not loosened", async () => {
    // P=100, E=97: 3% now; spending 10 makes it 3/90 = 3.33% — under 5%; at a
    // 300 bps limit it trips.
    const b = book({ breakerPeakUsdg: 100n * USDG, lifetimePeakUsdg: 100n * USDG, equityUsdg: 97n * USDG, maxDrawdownBps: 300 });
    const p = refusal(await plan(reads(), caps(), pricing(), b));
    assert.equal(p.rule, "would-trip-breaker");
    assert.match(p.line, /the limit is not loosened/);
    buyOf(await plan(reads(), caps(), pricing(), { ...b, maxDrawdownBps: 500 }));
  });
  it("A SPEND THAT WOULD LEAVE NOTHING, OR A SLIVER, CONTRIBUTED REFUSES — on the size actually to be spent", async () => {
    // The worked default spends 10 (the per-trade cap binds). With 10 on
    // record that leaves nothing; with 10.01 it leaves a cent — a sliver, also
    // refused. The floor is a tenth of the record, never under 1 USDG, so
    // 11.12 (leaving 1.12 over a floor of 1.112) is the first that is planned.
    const p = refusal(await plan(reads(), caps(), pricing(), book({ netContributionsUsdg: 10n * USDG })));
    assert.equal(p.rule, "would-exhaust-contributions");
    assert.match(p.line, /^I did not buy: spending 10\.00 USDG on energy would use up all 10\.00 USDG of capital on record for me/);
    assert.match(p.line, /send USDG to me first and ask again/);
    const sliver = refusal(await plan(reads(), caps(), pricing(), book({ netContributionsUsdg: 10n * USDG + 10_000n })));
    assert.equal(sliver.rule, "would-exhaust-contributions");
    assert.match(sliver.line, /would leave only 0\.01 of the 10\.01 USDG of capital on record for me/);
    assert.equal(refusal(await plan(reads(), caps(), pricing(), book({ netContributionsUsdg: 11_110_000n }))).rule, "would-exhaust-contributions");
    assert.equal(buyOf(await plan(reads(), caps(), pricing(), book({ netContributionsUsdg: 11_120_000n }))).amountInRaw, 10n * USDG);
  });
  it("a paper book is never bought on — a skip is a refusal here", async () => {
    assert.equal(refusal(await plan(reads(), caps(), pricing(), book({ paper: true, netContributionsUsdg: null }))).rule, "no-contribution-record");
  });
});

describe("sayEnergyOutcome — the ledger row decides the sentence", () => {
  const p = async () => buyOf(await plan());
  it("says 'bought' ONLY for a landed row", async () => {
    const pl = await p();
    for (const status of ["submitted", "reverted", "rejected", "paper"] as const) {
      const s = sayEnergyOutcome({ status, rejectRule: "energy-tax" }, pl, 50_000n * TOKEN);
      assert.doesNotMatch(s.line, /\bbought energy\b|✅/, status);
    }
    const landed = sayEnergyOutcome({ status: "landed", amountUsdg: 10 }, pl, 50_000n * TOKEN);
    assert.equal(landed.ok, true);
    assert.match(landed.line, /bought energy — 10\.00 USDG/);
  });
  it("a submitted row is PLACED and in flight", async () => {
    const s = sayEnergyOutcome({ status: "submitted" }, await p(), null);
    assert.match(s.line, /placed the energy buy/);
    assert.equal(s.ok, true);
  });
  it("after landing: full energy, still short (with asks), or 'could not re-read' — never a guess", async () => {
    const pl = await p();
    assert.match(sayEnergyOutcome({ status: "landed", amountUsdg: 10 }, pl, ENERGY_FULL_RAW).line, /That's full energy/);
    const short = sayEnergyOutcome({ status: "landed", amountUsdg: 10 }, pl, 70_000n * TOKEN).line;
    assert.match(short, /Still 30,000 short of 100,000/);
    assert.match(short, /more asks? like this one/);
    assert.match(sayEnergyOutcome({ status: "landed", amountUsdg: 10 }, pl, null).line, /couldn't re-read/);
  });
  it("a refusal carries its label and remedy, and the slug for support", async () => {
    const s = sayEnergyOutcome({ status: "rejected", rejectRule: "energy-needs-live" }, await p(), null);
    assert.equal(s.ok, false);
    assert.match(s.line, /only while trading live/);
    assert.match(s.line, /Turn on Live trading/);
    assert.match(s.line, /\(energy-needs-live\)/);
    assert.match(s.line, /Nothing was sent/);
  });
  it("no row at all says nothing was sent — never 'bought'", async () => {
    const s = sayEnergyOutcome(null, await p(), null);
    assert.equal(s.ok, false);
    assert.doesNotMatch(s.line, /bought/);
  });
  it("NOTHING IT SAYS is about price, returns, or a percentage", async () => {
    const lines: string[] = [];
    for (const r of [reads({ holder: null }), reads({ inFlight: true }), reads({ holder: ENERGY_FULL_RAW })]) lines.push((await plan(r) as { line: string }).line);
    lines.push((await plan(reads(), caps(), pricing({ taxBps: null })) as { line: string }).line);
    lines.push((await plan(reads(), caps(), pricing({ taxBps: 900 })) as { line: string }).line);
    lines.push((await plan(reads(), caps(), pricing({ amountInFor: async () => null })) as { line: string }).line);
    lines.push((await plan(reads(), caps({ opsRemaining: 0 })) as { line: string }).line);
    lines.push((await plan(reads({ cashUsdg: 0n })) as { line: string }).line);
    const pl = await p();
    for (const f of [{ status: "landed" as const, amountUsdg: 10 }, { status: "submitted" as const }, { status: "reverted" as const }]) {
      lines.push(sayEnergyOutcome(f, pl, 70_000n * TOKEN).line);
    }
    for (const l of lines) assert.doesNotMatch(l, NO_PRICE_WORDS, l);
  });
});

describe("the fixed sentences — each names what to do instead", async () => {
  const m = await import("./energy-buy");
  const { liveBlockerText } = await import("./exec-mode");
  it("not an order: the app chat's get-energy, or send it directly — never /settings", () => {
    assert.match(m.ENERGY_NOT_AN_ORDER, /get my energy/);
    assert.match(m.ENERGY_NOT_AN_ORDER, /Merrymen app chat/);
    assert.match(m.ENERGY_NOT_AN_ORDER, /Robinhood Chain directly/);
    assert.doesNotMatch(m.ENERGY_NOT_AN_ORDER, /\/settings/);
  });
  it("no sell: the key cannot, recover can", () => {
    assert.match(m.ENERGY_NO_SELL, /can't sell/);
    assert.match(m.ENERGY_NO_SELL, /merrymen recover/);
  });
  it("not mainnet: keep it in your own wallet on Robinhood Chain", () => {
    assert.match(m.ENERGY_NOT_MAINNET, /own wallet on Robinhood Chain/);
  });
  it("resign: re-sign at /grant (free), or send it directly", () => {
    assert.match(m.ENERGY_RESIGN, /re-sign at \/grant/);
    assert.match(m.ENERGY_RESIGN, /free/);
    assert.match(m.ENERGY_RESIGN, /directly/);
  });
  it("needs live: says why it is not live, and both ways round it", () => {
    const line = m.energyNeedsLiveLine(liveBlockerText("live-not-enabled"));
    assert.match(line, /only while trading live/);
    assert.match(line, /live trading is off/);
    assert.match(line, /Turn on Live trading, or send \$MERRYMEN to my account on Robinhood Chain directly/);
    assert.match(m.energyNeedsLiveLine(null), /and I'm not\. Turn on/);
  });
  it("none of them says anything about price, returns or a percentage", () => {
    for (const l of [m.ENERGY_NOT_AN_ORDER, m.ENERGY_NO_SELL, m.ENERGY_NOT_MAINNET, m.ENERGY_RESIGN, m.energyNeedsLiveLine("x")]) {
      assert.doesNotMatch(l, NO_PRICE_WORDS, l);
    }
  });
});

/**
 * AN ORDINARY ORDER IS RESOLVED BY ADDRESS — the watch set first.
 *
 * submitChatTrade refused any symbol reading MERRYMEN before it looked at the
 * watch set, so a watched coin at another address under that name could be
 * neither bought nor sold by its owner, and every surface told them "I never
 * sell it" about a coin they held. resolveOrderToken is the decision it now
 * makes first; index.ts's use of it is pinned in energy-buy-wiring.test.ts.
 */
describe("resolveOrderToken — the reserve by address, a lookalike like any coin", () => {
  const CLONE = "0x00000000000000000000000000000000000c1011";
  const TSLA = { symbol: "TSLA", address: "0x00000000000000000000000000000000000000a5" };

  it("A WATCHED LOOKALIKE CALLED MERRYMEN RESOLVES TO ITS OWN ADDRESS — bought and sold like any token", () => {
    assert.deepEqual(resolveOrderToken("MERRYMEN", [TSLA, { symbol: "MERRYMEN", address: CLONE }]), { kind: "token", address: CLONE, symbol: "MERRYMEN" });
  });

  it("A MIXED-CASE LOOKALIKE IS FOUND HOWEVER THE ORDER SPELLS IT — never told 'I never sell it' about a coin its owner holds", () => {
    // Settings keeps "MerryMen" as typed; the app's sell card and Telegram
    // upper-case the order's symbol. An exact match missed it, fell through to
    // the reserve's name, and the owner got ENERGY_NOT_AN_ORDER.
    const watch = [TSLA, { symbol: "MerryMen", address: CLONE }];
    for (const s of ["MERRYMEN", "merrymen", "MerryMen", "$MERRYMEN", " MERRYMEN "]) {
      assert.deepEqual(resolveOrderToken(s, watch), { kind: "token", address: CLONE, symbol: "MerryMen" }, s);
    }
    // The name comes back as the watch set spells it — the book's key for the position a sell reads.
    assert.deepEqual(resolveOrderToken("pepe", [{ symbol: "Pepe", address: CLONE }]), { kind: "token", address: CLONE, symbol: "Pepe" });
  });

  it("case folding never reaches past the address check: the reserve itself, however spelt, is still refused", () => {
    assert.deepEqual(resolveOrderToken("merrymen", [{ symbol: "MERRYMEN", address: MERRYMEN_TOKEN.address }]), { kind: "reserve" });
  });

  it("NOTHING WATCHED ANSWERS AND THE NAME IS THE RESERVE'S: refused as the reserve, never 'unknown'", () => {
    for (const s of ["MERRYMEN", "$MERRYMEN", "merrymen"]) assert.deepEqual(resolveOrderToken(s, [TSLA]), { kind: "reserve" }, s);
  });

  it("a watched entry AT the reserve address is refused whatever it is called (defence in depth)", () => {
    assert.deepEqual(resolveOrderToken("MM", [{ symbol: "MM", address: MERRYMEN_TOKEN.address }]), { kind: "reserve" });
    assert.deepEqual(resolveOrderToken("MERRYMEN", [{ symbol: "MERRYMEN", address: MERRYMEN_TOKEN.address.toUpperCase().replace("0X", "0x") }]), { kind: "reserve" });
  });

  it("an ordinary watched symbol resolves; an unwatched one is unknown", () => {
    assert.deepEqual(resolveOrderToken("TSLA", [TSLA]), { kind: "token", address: TSLA.address, symbol: "TSLA" });
    assert.deepEqual(resolveOrderToken("NVDA", [TSLA]), { kind: "unknown" });
  });
});
