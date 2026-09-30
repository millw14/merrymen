/**
 * THE LLM STRATEGIST STOPS PROPOSING BUYS WHILE THE BREAKER IS TRIPPED — AND
 * STOPS PAYING FOR THEM.
 *
 * Every other builtin reads the drawdown from the snapshot and goes quiet on
 * buys once the wall would refuse them (strategies/breaker-tripped.test.ts).
 * The strategist is a builtin too, and it still asked a model every window and
 * sent its buys to be refused, tick after tick: the refusal-a-tick and
 * cost-a-window this was meant to end, left in place on the strategy that
 * thinks.
 *
 *   - FLAT AND TRIPPED: nothing it could do is allowed, so no model is asked.
 *   - HOLDING AND TRIPPED: the model may still want to SELL, so it is asked,
 *     and any buy it proposes is withheld before it becomes an intent.
 *   - EXITS GO regardless — the stop floor never waits for the model.
 *   - AN UNMEASURED drawdown is not a tripped one.
 *
 * Intents are run through the real checkPolicy at the same drawdown, so what
 * this withholds is exactly what the wall would have refused.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkPolicy, type AgentLimits, type AgentState } from "../policy";
import { makeLlmStrategist, type StrategistDecision } from "./strategy";
import { publishesIdle } from "../strategies/reasons";
import { drawdownOf, type Snapshot, type Tick } from "../strategies/types";

const TSLA = "0x0000000000000000000000000000000000000001" as const;
const NVDA = "0x0000000000000000000000000000000000000002" as const;
const USDG = "0x00000000000000000000000000000000000000dd" as const;
const ROUTER = "0x00000000000000000000000000000000000000ff" as const;

/** 12.5% below the peak against a 10% limit: tripped, by the wall's own arithmetic. */
const TRIPPED = drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg: 875_000_000n, equityKnown: true, maxDrawdownBps: 1_000 });
const CLEAR = drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg: 980_000_000n, equityKnown: true, maxDrawdownBps: 1_000 });

const limits: AgentLimits = {
  perTradeUsdg: 10_000_000n,
  dailyUsdg: 1_000_000_000n,
  maxOpsPerDay: 100,
  allowedTargets: [ROUTER],
  allowedAssets: [USDG, TSLA, NVDA],
  // What makes a swap into USDG an exit the breaker never blocks.
  cashToken: USDG,
  maxDrawdownBps: 1_000,
  expiresAt: 4_000_000_000,
};
const walled = (equityUsdg: bigint): AgentState => ({
  spentTodayUsdg: 0n,
  opsToday: 0,
  highWaterMarkUsdg: 1_000_000_000n,
  equityUsdg,
  nowSec: 1_800_000_000,
});

/** A driver that records each time it is asked and answers with `actions`. */
const driverSaying = (actions: unknown[]) => {
  const calls: number[] = [];
  return {
    calls,
    driver: {
      name: "spy",
      propose: async () => {
        calls.push(calls.length);
        return { actions };
      },
    },
  };
};

const holding = () =>
  new Map([
    [
      "TSLA",
      {
        token: TSLA,
        rawBalance: 5_000_000_000_000_000_000n,
        valueUsdg: 9_000_000n,
        priceStale: false,
        costUsdg: 10_000_000n,
      },
    ],
  ]);

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  cashUsdg: 100_000_000n,
  vaultUsdg: 0n,
  ethWei: 10n ** 16n,
  holdings: new Map(),
  prices: new Map([
    ["TSLA", { price8: 180_00000000n, stale: false }],
    ["NVDA", { price8: 120_00000000n, stale: false }],
  ]) as unknown as Snapshot["prices"],
  pausedTokens: new Set(),
  staleFeeds: new Set(),
  sequencerUp: true,
  spendHeadroomUsdg: 1_000_000_000n,
  perTradeCapUsdg: 10_000_000n,
  ...over,
});

const build = (
  driver: { name: string; propose: () => Promise<unknown> },
  over: { clock?: { t: number }; stopLossBps?: number; decisions?: StrategistDecision[]; notes?: string[] } = {},
) =>
  makeLlmStrategist({
    driver: driver as never,
    universe: {
      legs: new Map([["TSLA", TSLA], ["NVDA", NVDA]]),
      swapRouter: ROUTER,
      usdg: USDG,
      maxPerActionUsdg: 10_000_000n,
      maxActionsPerTick: 4,
    },
    stopLossBps: over.stopLossBps ?? 0,
    decisionIntervalMs: 30 * 60_000,
    now: () => over.clock?.t ?? 1_000_000,
    ...(over.decisions ? { onDecision: (d: StrategistDecision) => void over.decisions!.push(d) } : {}),
    ...(over.notes ? { onNote: (_: string, m: string) => void over.notes!.push(m) } : {}),
  });

const tickOf = async (s: ReturnType<typeof build>, sn: Snapshot): Promise<Tick> => {
  const r = await s.tick(sn);
  return Array.isArray(r) ? { intents: r, why: r.map(() => null) } : r;
};

const BUY = { action: "buy", symbol: "NVDA", sizeUsdg: 5, reason: "breadth is back" };
const SELL = { action: "sell", symbol: "TSLA", sizeUsdg: 9, reason: "the thesis broke" };

describe("flat and tripped: nothing it could do is allowed", () => {
  it("THE MODEL IS NOT ASKED, and the owner is told why", async () => {
    const spy = driverSaying([BUY]);
    const t = await tickOf(build(spy.driver), snap({ drawdown: TRIPPED }));
    assert.equal(spy.calls.length, 0, "no model call is paid for a buy the wall must refuse");
    assert.equal(t.intents.length, 0);
    assert.equal(t.idle?.code, "breaker-tripped");
    assert.equal(publishesIdle(t.idle!), false, "account state: the owner's sentence, not a post");
  });

  it("the window it skipped is not spent: once the breaker clears, the model is asked at once", async () => {
    const spy = driverSaying([]);
    const clock = { t: 1_000_000 };
    const s = build(spy.driver, { clock });
    await tickOf(s, snap({ drawdown: TRIPPED }));
    clock.t += 1_000;
    await tickOf(s, snap({ drawdown: CLEAR }));
    assert.equal(spy.calls.length, 1);
  });
});

describe("holding and tripped: sells only", () => {
  it("THE MODEL IS STILL ASKED — it may want out — and its buy never becomes an intent", async () => {
    const spy = driverSaying([BUY, SELL]);
    const decisions: StrategistDecision[] = [];
    const notes: string[] = [];
    const t = await tickOf(build(spy.driver, { decisions, notes }), snap({ holdings: holding(), drawdown: TRIPPED }));
    assert.equal(spy.calls.length, 1);
    assert.equal(t.intents.length, 1, "the sell, and only the sell");
    const out = t.intents[0]!;
    assert.ok(out.kind === "swap" && out.sellToken === TSLA, "a sell of what is held");
    assert.equal(t.idle, undefined, "a tick that sells is not idle");
    // The wall agrees: what went out passes at this drawdown.
    const exit = checkPolicy(t.intents[0]!, limits, walled(875_000_000n));
    assert.equal(exit.ok, true, JSON.stringify(exit));
    // The withheld buy is not journaled — a drop row publishes, and a tripped
    // breaker is account state the public feed leaves out — but the owner's
    // log says it happened.
    assert.deepEqual(decisions.map((d) => d.action), ["sell"]);
    assert.ok(!decisions.some((d) => d.dropped_rule));
    assert.ok(notes.some((n) => /1 buy .*withheld.*drawdown breaker/i.test(n)), notes.join("\n"));
    assert.ok(!notes.some((n) => /strategist: buy /.test(n)), "a withheld buy is not narrated as if it were happening");
  });

  it("A BUY-ONLY ANSWER SENDS NOTHING, and says the breaker — not 'the model held'", async () => {
    const spy = driverSaying([BUY]);
    const t = await tickOf(build(spy.driver), snap({ holdings: holding(), drawdown: TRIPPED }));
    assert.equal(t.intents.length, 0);
    assert.equal(t.idle?.code, "breaker-tripped");
  });

  it("the buy the model proposed WOULD have been refused by the wall — this withholds nothing the wall allows", async () => {
    const spy = driverSaying([BUY]);
    const open = await tickOf(build(spy.driver), snap({ holdings: holding(), drawdown: CLEAR }));
    assert.equal(open.intents.length, 1, "with the breaker clear the same answer is a buy");
    const verdict = checkPolicy(open.intents[0]!, limits, walled(875_000_000n));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok ? null : verdict.rule, "drawdown-breaker");
  });

  it("BETWEEN WINDOWS THE REASON STAYS SAID, so the once-per-change channel does not repeat it", async () => {
    const spy = driverSaying([]);
    const s = build(spy.driver);
    const first = await tickOf(s, snap({ holdings: holding(), drawdown: TRIPPED }));
    const between = await tickOf(s, snap({ holdings: holding(), drawdown: TRIPPED }));
    assert.equal(spy.calls.length, 1, "one window, one call");
    assert.equal(first.idle?.code, "breaker-tripped");
    assert.equal(between.idle?.code, "breaker-tripped", "not a bare [] that would reset the idle channel");
  });
});

describe("exits never wait on the breaker", () => {
  it("THE STOP FLOOR STILL FIRES, and no model is asked", async () => {
    const spy = driverSaying([BUY]);
    const losing = new Map([["TSLA", { ...holding().get("TSLA")!, valueUsdg: 7_000_000n }]]);
    const t = await tickOf(build(spy.driver, { stopLossBps: 2_000 }), snap({ holdings: losing, drawdown: TRIPPED }));
    assert.equal(t.intents.length, 1);
    assert.equal(t.why[0]?.code, "stop-floor");
    assert.equal(spy.calls.length, 0);
  });
});

describe("a drawdown nobody measured is not a tripped breaker", () => {
  for (const [label, drawdown] of [["absent", undefined], ["null", null], ["clear", CLEAR]] as const) {
    it(`${label}: the model is asked and its buy goes out`, async () => {
      const spy = driverSaying([BUY]);
      const t = await tickOf(build(spy.driver), snap(drawdown === undefined ? {} : { drawdown }));
      assert.equal(spy.calls.length, 1);
      assert.equal(t.intents.length, 1);
      const out = t.intents[0]!;
      assert.ok(out.kind === "swap" && out.buyToken === NVDA, "a buy of what the model named");
    });
  }
});
