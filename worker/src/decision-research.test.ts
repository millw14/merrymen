import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicClient } from "viem";
import { CASH } from "../../packages/core/src/index";
import { DECISION_RESEARCH_GUIDANCE, decisionResearchBootLine, decisionResearchEnabledFor, entryCostEvidence, entryCostResearch, researchEntrySize, trenchBreakEven, trenchMomentumBrief, type BreakEven } from "./decision-research";
import { TRENCHER_DEFAULTS, TRENCHER_FAST } from "./strategies/trencher";
import { trencherStrategyTerms } from "./strategy-terms";
import { trenchBrainPersona } from "./trencher-brain";
import { withAgentBrief } from "./agent-brief";

const TOKEN = `0x${"a".repeat(40)}` as const;
const OTHER = `0x${"b".repeat(40)}` as const;
const quote = (amountOut: bigint) => ({ amountOut, fee: 3000, gasEstimate: 100_000n });
const args = {
  client: {} as PublicClient, token: TOKEN,
  facts: { token0: CASH.USDG, token1: TOKEN, fee: 3000 },
  sizeUsdg: 2_500_000n, gasPerOperationUsdg: 10_000n, tradeFeeBps: 25,
};

test("research opt-in binds exact account addresses and accepts no wildcard or prefix", () => {
  assert.equal(decisionResearchEnabledFor(TOKEN, {}), false);
  for (const value of ["all", "*", TOKEN.slice(0, 10), `${TOKEN}junk`, "0x" + "0".repeat(40)]) {
    assert.equal(decisionResearchEnabledFor(TOKEN, { MERRYMEN_DECISION_RESEARCH_ACCOUNTS: value }), false);
  }
  const env = { MERRYMEN_DECISION_RESEARCH_ACCOUNTS: `${OTHER},\n${TOKEN.toUpperCase().replace("0X", "0x")}` };
  assert.equal(decisionResearchEnabledFor(TOKEN, env), true);
  assert.equal(decisionResearchEnabledFor(`0x${"c".repeat(40)}`, env), false);
});

test("the boot line names the allowlisted accounts and only counts what is not an address", () => {
  assert.equal(decisionResearchBootLine({}), "decision research: nobody");
  assert.equal(decisionResearchBootLine({ MERRYMEN_DECISION_RESEARCH_ACCOUNTS: "secret-ish, *" }), "decision research: nobody (2 entries are not an address)");
  const line = decisionResearchBootLine({ MERRYMEN_DECISION_RESEARCH_ACCOUNTS: `${TOKEN}, alan ,0x${"0".repeat(40)}` });
  assert.equal(line, `decision research: 1 account(s) — ${TOKEN}; 2 entries are not an address`);
  assert.doesNotMatch(line, /alan/);
});

test("research sizing cannot exceed the strategy, signed cap, remaining daily spend, cash or early bound", () => {
  assert.equal(researchEntrySize([2_500_000n, 10_000_000n, 50_000_000n, 100_000_000n]), 2_500_000n);
  assert.equal(researchEntrySize([2_500_000n, 1_000_000n, 50_000_000n]), 1_000_000n);
  assert.equal(researchEntrySize([2_500_000n, 10_000_000n, 750_000n]), 750_000n);
  assert.equal(researchEntrySize([2_500_000n, 0n]), 0n);
  assert.equal(researchEntrySize([2_500_000n, -1n]), 0n);
  assert.equal(researchEntrySize([]), 0n);
});

test("quotes the exact entry output back to cash, counting two gas costs and both turnover fees once", async () => {
  const calls: { tokens: readonly string[]; amount: bigint }[] = [];
  const text = await entryCostEvidence(args, { quote: async (route, amount) => {
    calls.push({ tokens: route.tokens, amount });
    return quote(calls.length === 1 ? 1_234_000n : 2_450_000n);
  } });
  assert.deepEqual(calls, [
    { tokens: [CASH.USDG, TOKEN], amount: 2_500_000n },
    { tokens: [TOKEN, CASH.USDG], amount: 1_234_000n },
  ]);
  assert.match(text, /2\.450000 USDG back/);
  assert.match(text, /turnover fees for both legs: 0\.012375 USDG/);
  assert.match(text, /gas for two operations: 0\.020000 USDG/);
  assert.match(text, /round-trip drag: 0\.082375 USDG \(3\.29% of entry\)/);
  assert.match(text, /not a sequential transaction simulation/);
  assert.match(text, /not expected profit, a guaranteed exit, or permission to trade/);
  assert.doesNotMatch(text, /0x[a-f0-9]{40}/i);
});

test("WETH bridge search is bounded and reverses the winning route's fee order", async () => {
  const calls: { tokens: readonly string[]; fees: readonly number[]; amount: bigint }[] = [];
  const text = await entryCostEvidence({ ...args, facts: { token0: TOKEN, token1: CASH.WETH, fee: 10000 } }, {
    quote: async (route, amount) => {
      calls.push({ ...route, amount });
      return quote(route.tokens[0] === CASH.USDG ? BigInt(route.fees[0]!) : 2_400_000n);
    },
  });
  assert.equal(calls.length, 5);
  assert.deepEqual(calls.at(-1), { tokens: [TOKEN, CASH.WETH, CASH.USDG], fees: [10000, 10000], amount: 10000n });
  assert.match(text, /2\.400000 USDG back/);
});

test("missing or failed exit quotes are unknown, not evidence of a cheap trade", async () => {
  let calls = 0;
  const text = await entryCostEvidence(args, { quote: async () => ++calls === 1 ? quote(100n) : null });
  assert.match(text, /unavailable/);
  assert.doesNotMatch(text, /0\.00|drag:/);
  const missingGas = await entryCostEvidence({ ...args, gasPerOperationUsdg: null }, { quote: async route => quote(route.tokens[0] === TOKEN ? 2_490_000n : 100n) });
  assert.match(missingGas, /gas for two operations: unknown/);
  assert.match(missingGas, /Total round-trip drag is unknown/);
});

test("unknown, unsupported and mismatched verified pool facts make no quote requests", async () => {
  let calls = 0;
  for (const facts of [undefined, { token0: OTHER, token1: CASH.USDG, fee: 3000 }, { token0: TOKEN, token1: OTHER, fee: 3000 }]) {
    assert.match(await entryCostEvidence({ ...args, facts }, { quote: async () => { calls++; return null; } }), /unavailable/);
  }
  assert.equal(calls, 0);
});

test("a budget miss returns promptly and late entry evidence cannot start an exit request", async () => {
  let time = 1000;
  let finish!: (q: ReturnType<typeof quote>) => void;
  let calls = 0;
  const result = await entryCostEvidence(args, { now: () => time, budgetMs: 1, quote: async () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  } });
  assert.match(result, /unavailable/);
  time = 1002;
  finish(quote(100n));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

// ─── The momentum entry plan (research accounts, entry reviews) ──────────

test("cost research returns the figures its sentence states, and none when the sentence says unknown", async () => {
  const deps = { now: () => 1_800_000_000_000, quote: async (route: { tokens: readonly string[] }) => quote(route.tokens[0] === TOKEN ? 2_450_000n : 1_234_000n) };
  const quoted = await entryCostResearch(args, deps);
  assert.deepEqual([quoted.sizeUsdg, quoted.backUsdg, quoted.dragUsdg], [2_500_000n, 2_450_000n, 82_375n]);
  assert.match(quoted.text, /round-trip drag: 0\.082375 USDG/);
  const noGas = await entryCostResearch({ ...args, gasPerOperationUsdg: null }, { quote: async route => quote(route.tokens[0] === TOKEN ? 2_450_000n : 1_234_000n) });
  assert.equal(noGas.backUsdg, 2_450_000n);
  assert.equal(noGas.dragUsdg, null, "drag unknown in the text, unknown in the figures");
  const none = await entryCostResearch({ ...args, facts: undefined });
  assert.match(none.text, /unavailable/);
  assert.deepEqual([none.backUsdg, none.dragUsdg], [null, null]);
  assert.equal(await entryCostEvidence(args, deps), quoted.text, "the text API is the same sentence");
});

const fallback = { sizeUsdg: 2_500_000n, gasPerOperationUsdg: 10_000n, tradeFeeBps: 25 };
/** The quoted round trip of the cost tests above: 50,000 venue friction, 12,375 turnover fees, 20,000 gas. */
const sane = { sizeUsdg: 2_500_000n, backUsdg: 2_450_000n, dragUsdg: 82_375n };
/** The odds threshold a brief prints, as a number. */
const threshold = (brief: string) => Number(/P is above (?:at least )?about (\d+)%/.exec(brief)?.[1]);

test("break-even: brackets run from the fill, so each exit pays the exit leg, both turnover fees and gas — never the entry leg twice", () => {
  const q = trenchBreakEven(sane, fallback);
  assert.equal(q.basis, "quoted");
  if (q.basis !== "quoted") return;
  assert.ok(Math.abs(q.roundTripPct - 3.295) < 1e-9, "the whole round trip over the entry");
  assert.ok(Math.abs(q.bracketCostPct - 2.295) < 1e-9, "less the entry leg's half of the venue friction, which the fill price already carries");
  const floor = trenchBreakEven({ ...sane, dragUsdg: null }, fallback);
  assert.equal(floor.basis, "gas-and-fees", "no gas in the quote: fall back to the floor");
  if (floor.basis !== "gas-and-fees") return;
  assert.ok(Math.abs(floor.roundTripPct - 1.3) < 1e-9, "two gas operations and two turnover fees over the entry");
  assert.equal(floor.bracketCostPct, floor.roundTripPct, "the floor has no venue friction to split");
  assert.deepEqual(trenchBreakEven(null, { ...fallback, gasPerOperationUsdg: null }), { basis: "unknown" });
  assert.deepEqual(trenchBreakEven(null, { ...fallback, sizeUsdg: 0n }), { basis: "unknown" });
});

test("an anomalous quote is not a cost: more back than went in, or a drag under the gas-and-fee floor, falls back — never negative", () => {
  for (const anomaly of [
    { sizeUsdg: 2_500_000n, backUsdg: 2_600_000n, dragUsdg: -67_625n },
    { sizeUsdg: 2_500_000n, backUsdg: 2_500_000n, dragUsdg: 1_000n },
  ]) {
    const be = trenchBreakEven(anomaly, fallback);
    assert.equal(be.basis, "gas-and-fees");
    assert.ok(be.roundTripPct >= 0 && be.bracketCostPct >= 0);
    const brief = trenchMomentumBrief(TRENCHER_FAST, be, 2_500_000n);
    assert.doesNotMatch(brief, /-\d+(\.\d+)?% in gas|about -|least -/, "no negative cost printed");
    assert.ok(threshold(brief) >= 100 * 1_000 / (1_000 + 2_000), "never below stop / (take + stop)");
  }
});

test("the momentum brief reads its exits from the strategy, states where the brackets run from, and keeps every check", () => {
  const brief = trenchMomentumBrief(TRENCHER_FAST, trenchBreakEven(sane, fallback), 2_500_000n);
  assert.match(brief, /Horizon: minutes, not days/);
  assert.match(brief, /stop -10%, take \+20%, close at 30 minutes, or early if 50% of entry liquidity drains/);
  assert.match(brief, /Brackets run from your average fill, which includes the entry leg's venue cost/);
  assert.match(brief, /A round trip at 2\.50 USDG costs about 3\.(29|3)% \(quoted\)\. c, each exit's cost beyond the fill, is about 2\.(29|3)% \(exit leg's half of the venue friction/);
  assert.match(brief, /s your average realised stop-out loss \(10 at best, never priced at the trigger\)/);
  assert.match(brief, /P x \(20 - c\)% - \(1 - P\) x \(s \+ c\)%, positive only when P is above about 41% at s = 10, 49% at s = 15/, "(10 + 2.3) / 30, then (15 + 2.3) / 35");
  assert.match(brief, /a time-stopped exit takes the 30-minute mark, less c/);
  assert.doesNotMatch(brief, /near flat/, "nothing unmeasured about where a time stop lands");
  assert.match(brief, /give that estimate at entry size as expected_edge_usdg/);
  assert.match(brief, /Continuation: buyers and buy share rising/);
  assert.match(brief, /one sender doing most of a material sell flow \(may be a router or bundler\)/);
  assert.match(brief, /Missing news, fundamentals or social-media data is not by itself a reason to hold here/);
  assert.match(brief, /All checks above still apply\.$/);
  // NOT HARDCODED: another config says other numbers.
  const other = trenchMomentumBrief({ stopLossBps: 1_500, takeProfitBps: 3_000, maxHoldSec: 45 * 60, liquidityDrainFraction: 0.6 }, { basis: "unknown" }, 1_000_000n);
  assert.match(other, /stop -15%, take \+30%, close at 45 minutes, or early if 40% of entry liquidity drains/);
  assert.match(other, /c could not be priced; treat a marginal setup as insufficient/);
  assert.match(other, /clearly above 33% at s = 15, 43% at s = 22\.5, plus the unknown cost/);
  const floor = trenchMomentumBrief(TRENCHER_FAST, trenchBreakEven(null, fallback), 2_500_000n);
  assert.match(floor, /costs at least 1\.3% in gas and turnover fees \(venue fee and impact not quoted\)/);
  assert.match(floor, /P is above at least about 38%/, "a floor's threshold is a floor too");
});

test("the momentum plan and the desk policy state the same exits, the same s and c, and the same bars", () => {
  // Research accounts' entry reviews carry both: the plan in the fenced
  // brief, the terms as trusted DESK POLICY (strategy-terms.ts). Two bars, or
  // a loss priced at the trigger in one and past it in the other, would hand
  // the manager a choice the code never offers.
  const num = (t: string, re: RegExp) => Number(re.exec(t)?.[1]);
  for (const cfg of [TRENCHER_FAST, TRENCHER_DEFAULTS, { ...TRENCHER_FAST, stopLossBps: 1_250, takeProfitBps: 3_000 }]) {
    const terms = trencherStrategyTerms(cfg)!.terms!;
    const unknown = trenchMomentumBrief(cfg, { basis: "unknown" }, 2_500_000n);
    const stop = num(terms, /triggers at -([\d.]+)% \(stop-loss\)/), take = num(terms, /and \+([\d.]+)% \(take-profit\)/);
    const realised = num(terms, /average realised stop of -([\d.]+)%/);
    assert.ok(unknown.includes(`stop -${stop}%, take +${take}%`), "the same triggers");
    // c unknown prints the bracket at c = 0: the terms' floor and realised bar exactly.
    assert.equal(num(unknown, /clearly above (\d+)% at s = /), num(terms, /take-profit about (\d+)% of the time/), "the same floor");
    assert.equal(num(unknown, /at s = [\d.]+, (\d+)% at s = /), num(terms, /the bar is about (\d+)%/), "the same realised bar");
    assert.equal(num(unknown, /, \d+% at s = ([\d.]+)/), realised, "the same realised stop");
    // Losses are never priced at the trigger, in either.
    assert.ok(terms.includes(`never at -${stop}%.`));
    assert.match(unknown, /never priced at the trigger/);
    assert.ok(!unknown.includes(`(1 - P) x (${stop} + c)`), "no edge formula priced at the nominal stop");
    // c is each exit's cost past the average fill in both, never a round trip.
    assert.match(terms, /Costs c beyond your average fill \(exit impact, fees, gas both ways\) raise it to \(s \+ c\) \/ \(s \+ [\d.]+\)/);
    assert.match(unknown, /\(1 - P\) x \(s \+ c\)%/);
    assert.doesNotMatch(terms, /Round-trip drag c/);
  }
  // With a priced c, the brief's bars are the terms' formula at that c.
  const be = trenchBreakEven(sane, fallback);
  if (be.basis !== "quoted") throw new Error("quoted");
  const brief = trenchMomentumBrief(TRENCHER_FAST, be, 2_500_000n);
  assert.equal(threshold(brief), Math.round(100 * (10 + be.bracketCostPct) / 30));
  assert.ok(brief.includes(`, ${Math.round(100 * (15 + be.bracketCostPct) / 35)}% at s = 15;`));
});

test("when the take-profit cannot cover the cost, no odds threshold is printed; a printed one stays under 100%", () => {
  const dear = trenchBreakEven(null, { ...fallback, gasPerOperationUsdg: 400_000n });
  assert.equal(dear.basis, "gas-and-fees");
  const brief = trenchMomentumBrief(TRENCHER_FAST, dear, 2_500_000n);
  assert.match(brief, /no odds make it positive: the take-profit cannot cover c at this size/);
  assert.doesNotMatch(brief, /P is above/);
  const edge = trenchMomentumBrief(TRENCHER_FAST, { basis: "quoted", roundTripPct: 20, bracketCostPct: 19.85 }, 2_500_000n);
  assert.equal(threshold(edge), 99, "99.5% prints as 99, never 100");
});

test("the whole research persona fits inside the Brain's 4000-character strategy brief", () => {
  // graph.py fences `req.persona[:4000]`: anything past it is cut, and the
  // momentum plan is last. EVERY BRANCH, at its longest: the longest symbol a
  // token may carry (16, packages/core tokens.ts), an owner brief with a voice
  // line, the research guidance, three-digit costs — which on the quoted and
  // floor bases also take the long "no odds" clause — and a threshold branch.
  const branches: BreakEven[] = [
    { basis: "quoted", roundTripPct: 123.456, bracketCostPct: 123.456 },
    { basis: "gas-and-fees", roundTripPct: 123.456, bracketCostPct: 123.456 },
    { basis: "quoted", roundTripPct: 12.345, bracketCostPct: 9.876 },
    { basis: "gas-and-fees", roundTripPct: 12.345, bracketCostPct: 9.876 },
    { basis: "unknown" },
  ];
  for (const be of branches) {
    const persona = withAgentBrief(trenchBrainPersona("X".repeat(16), false), "dry sarcastic casual") +
      `\n\n${DECISION_RESEARCH_GUIDANCE}\n\n` + trenchMomentumBrief(TRENCHER_FAST, be, 2_500_000n);
    assert.ok(persona.length <= 3900, `${JSON.stringify(be)}: ${persona.length} characters leaves too little room under 4000`);
    assert.match(persona, /All checks above still apply\.$/, "the last check sentence is inside the cut");
  }
  // And the fleet persona is untouched: the plan is added by index.ts, research accounts only.
  assert.doesNotMatch(trenchBrainPersona("MEME", false), /MOMENTUM ENTRY PLAN/);
});
