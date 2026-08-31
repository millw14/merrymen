import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseProposals, proposalsToIntents, type StrategistUniverse } from "./proposals";
import { makeLlmStrategist } from "./strategy";
import type { ProposalDriver } from "./driver";
import type { Snapshot } from "../strategies/types";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const AAPL = "0x4444444444444444444444444444444444444444" as const;
const MSFT = "0x5555555555555555555555555555555555555555" as const;

function universe(over: Partial<StrategistUniverse> = {}): StrategistUniverse {
  return {
    legs: new Map([
      ["AAPL", AAPL],
      ["MSFT", MSFT],
    ]),
    swapRouter: ROUTER,
    usdg: USDG,
    maxPerActionUsdg: 50_000_000n, // 50 USDG
    maxActionsPerTick: 4,
    ...over,
  };
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    cashUsdg: 100_000_000n,
    vaultUsdg: 0n,
    holdings: new Map(),
    prices: new Map(),
    pausedTokens: new Set(),
    staleFeeds: new Set(),
    sequencerUp: true,
    // Wide open by default: these fixtures predate cap-aware sizing, so the
    // headroom must not clamp them. Clamping is pinned in its own test.
    spendHeadroomUsdg: 1_000_000_000_000n,
    perTradeCapUsdg: 1_000_000_000_000n,
    ...over,
  };
}

describe("parseProposals — the model's output is untrusted", () => {
  it("accepts well-formed actions and truncates reasons", () => {
    const { actions, malformed } = parseProposals({
      actions: [{ action: "buy", symbol: "AAPL", sizeUsdg: 10, reason: "x".repeat(500) }],
    });
    assert.equal(malformed, 0);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.reason.length, 300);
  });

  it("drops junk without repair", () => {
    const { actions, malformed } = parseProposals({
      actions: [
        { action: "yolo", symbol: "AAPL", sizeUsdg: 10, reason: "" },
        { action: "buy", symbol: 42, sizeUsdg: 10, reason: "" },
        { action: "buy", symbol: "AAPL", sizeUsdg: "ten", reason: "" },
        { action: "hold", symbol: "AAPL", sizeUsdg: "irrelevant", reason: "" },
      ],
    });
    assert.equal(actions.length, 1); // only the hold survives (size ignored for hold)
    assert.equal(actions[0]!.action, "hold");
    assert.equal(malformed, 3);
  });

  it("non-object output means zero actions", () => {
    assert.equal(parseProposals("I think you should buy AAPL").actions.length, 0);
    assert.equal(parseProposals(null).actions.length, 0);
  });
});

describe("proposalsToIntents — deterministic code disposes", () => {
  it("converts a legal buy into a policy-shaped swap intent", () => {
    const { intents, rejected } = proposalsToIntents(
      [{ action: "buy", symbol: "AAPL", sizeUsdg: 25, reason: "" }],
      universe(),
      snap(),
    );
    assert.equal(rejected.length, 0);
    assert.equal(intents.length, 1);
    const i = intents[0]!;
    assert.equal(i.kind === "swap" && i.buyToken, AAPL);
    assert.equal(i.kind === "swap" && i.sellAmountRaw, 25_000_000n);
    assert.equal(i.kind === "swap" && i.notionalUsdg, 25_000_000n);
  });

  it("returns `accepted` parallel to intents — accepted[i] is the action behind intents[i]", () => {
    const { intents, accepted } = proposalsToIntents(
      [
        { action: "buy", symbol: "AAPL", sizeUsdg: 25, reason: "dip" },
        { action: "buy", symbol: "GME", sizeUsdg: 10, reason: "dropped — not in universe" },
        { action: "buy", symbol: "MSFT", sizeUsdg: 15, reason: "trend" },
      ],
      universe(),
      snap(),
    );
    assert.equal(intents.length, accepted.length);
    assert.deepEqual(accepted.map((a) => a.symbol), ["AAPL", "MSFT"]); // GME dropped, not in accepted
    assert.deepEqual(accepted.map((a) => a.reason), ["dip", "trend"]);
  });

  it("rejects symbols outside the universe — the model cannot add assets", () => {
    const { intents, rejected } = proposalsToIntents(
      [{ action: "buy", symbol: "GME", sizeUsdg: 10, reason: "moon" }],
      universe(),
      snap(),
    );
    assert.equal(intents.length, 0);
    assert.match(rejected[0]!, /not in the tradable universe/);
  });

  it("rejects sizes above the strategist ceiling and non-finite sizes", () => {
    const { intents, rejected } = proposalsToIntents(
      [
        { action: "buy", symbol: "AAPL", sizeUsdg: 51, reason: "" },
        { action: "buy", symbol: "MSFT", sizeUsdg: Number.NaN, reason: "" },
        { action: "buy", symbol: "MSFT", sizeUsdg: -5, reason: "" },
      ],
      universe(),
      snap(),
    );
    assert.equal(intents.length, 0);
    assert.equal(rejected.length, 3);
  });

  it("buys cannot exceed cash, cumulatively", () => {
    const { intents, rejected } = proposalsToIntents(
      [
        { action: "buy", symbol: "AAPL", sizeUsdg: 50, reason: "" },
        { action: "buy", symbol: "MSFT", sizeUsdg: 50, reason: "" },
        { action: "buy", symbol: "AAPL", sizeUsdg: 50, reason: "" }, // cash gone
      ],
      universe(),
      snap({ cashUsdg: 100_000_000n }),
    );
    assert.equal(intents.length, 2);
    assert.match(rejected[0]!, /exceeds available cash/);
  });

  it("sells convert size to raw shares proportionally and cap at the holding", () => {
    const holding = { token: AAPL, rawBalance: 1_000n, valueUsdg: 40_000_000n, priceStale: false };
    const partial = proposalsToIntents(
      [{ action: "sell", symbol: "AAPL", sizeUsdg: 10, reason: "" }],
      universe(),
      snap({ holdings: new Map([["AAPL", holding]]) }),
    );
    const p = partial.intents[0]!;
    assert.equal(p.kind === "swap" && p.sellAmountRaw, 250n); // 10/40 of 1000
    assert.equal(p.kind === "swap" && p.notionalUsdg, 10_000_000n);

    const oversized = proposalsToIntents(
      [{ action: "sell", symbol: "AAPL", sizeUsdg: 50, reason: "" }],
      universe(),
      snap({ holdings: new Map([["AAPL", holding]]) }),
    );
    const o = oversized.intents[0]!;
    assert.equal(o.kind === "swap" && o.sellAmountRaw, 1_000n); // full holding
    assert.equal(o.kind === "swap" && o.notionalUsdg, 40_000_000n);
  });

  it("cannot sell what is not held; cannot trade paused tokens", () => {
    const { intents, rejected } = proposalsToIntents(
      [
        { action: "sell", symbol: "AAPL", sizeUsdg: 10, reason: "" },
        { action: "buy", symbol: "MSFT", sizeUsdg: 10, reason: "" },
      ],
      universe(),
      snap({ pausedTokens: new Set([MSFT.toLowerCase()]) }),
    );
    assert.equal(intents.length, 0);
    assert.equal(rejected.length, 2);
  });

  it("caps actions per tick", () => {
    const many = Array.from({ length: 6 }, () => ({
      action: "buy" as const,
      symbol: "AAPL",
      sizeUsdg: 1,
      reason: "",
    }));
    const { intents, rejected } = proposalsToIntents(many, universe(), snap());
    assert.equal(intents.length, 4);
    assert.equal(rejected.length, 2);
  });
});

describe("makeLlmStrategist — decision windows, not per-tick chatter", () => {
  function mockDriver(result: unknown): ProposalDriver & { calls: number } {
    const d = {
      name: "mock",
      calls: 0,
      async propose() {
        d.calls += 1;
        return result;
      },
    };
    return d;
  }

  it("calls the driver once per decision window", async () => {
    const driver = mockDriver({ actions: [] });
    let t = 0;
    const s = makeLlmStrategist({
      driver,
      universe: universe(),
      decisionIntervalMs: 60_000,
      now: () => t,
    });
    await s.tick(snap());
    t = 30_000;
    await s.tick(snap()); // within the window — no call
    t = 61_000;
    await s.tick(snap()); // new window
    assert.equal(driver.calls, 2);
  });

  it("driver failure degrades to no trades, never a crash", async () => {
    const driver: ProposalDriver = {
      name: "broken",
      propose: async () => {
        throw new Error("api down");
      },
    };
    const notes: string[] = [];
    const s = makeLlmStrategist({
      driver,
      universe: universe(),
      decisionIntervalMs: 0,
      now: (() => {
        let t = 0;
        return () => (t += 1);
      })(),
      onNote: (_l, m) => notes.push(m),
    });
    const intents = await s.tick(snap());
    assert.deepEqual(intents, []);
    assert.match(notes[0]!, /driver failed/);
  });

  it("valid proposals become intents end-to-end", async () => {
    const driver = mockDriver({
      actions: [
        { action: "buy", symbol: "AAPL", sizeUsdg: 20, reason: "weekend gap setup" },
        { action: "buy", symbol: "DOGE", sizeUsdg: 20, reason: "vibes" },
      ],
    });
    const notes: string[] = [];
    const s = makeLlmStrategist({
      driver,
      universe: universe(),
      decisionIntervalMs: 0,
      now: (() => {
        let t = 0;
        return () => (t += 1);
      })(),
      onNote: (_l, m) => notes.push(m),
    });
    const intents = await s.tick(snap());
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.kind === "swap" && intents[0]!.buyToken, AAPL);
    assert.ok(notes.some((n) => /DOGE/.test(n) && /not in the tradable universe/.test(n)));
  });

  it("journals a decision per survivor + per drop, and stamps the survivor's intent", async () => {
    const driver = mockDriver({
      actions: [
        { action: "buy", symbol: "AAPL", sizeUsdg: 20, reason: "weekend gap setup" },
        { action: "buy", symbol: "DOGE", sizeUsdg: 20, reason: "vibes" }, // not in universe → drop
      ],
    });
    const decisions: import("./strategy").StrategistDecision[] = [];
    const s = makeLlmStrategist({
      driver,
      universe: universe(),
      decisionIntervalMs: 0,
      now: (() => { let t = 0; return () => (t += 1); })(),
      provider: "groq",
      model: "llama-3.3-70b",
      onDecision: (d) => { decisions.push(d); },
    });
    const intents = await s.tick(snap());

    const survivors = decisions.filter((d) => !d.dropped_rule);
    const drops = decisions.filter((d) => d.dropped_rule);
    assert.equal(survivors.length, 1, "one survivor decision");
    assert.equal(drops.length, 1, "one drop decision");

    // The survivor carries the model's own reason + labels, and its id is stamped
    // onto the intent that goes to the wall — that's the join key for /why.
    const sv = survivors[0]!;
    assert.equal(sv.symbol, "AAPL");
    assert.equal(sv.action, "buy");
    assert.equal(sv.size_usdg, 20);
    assert.equal(sv.reason, "weekend gap setup");
    assert.equal(sv.provider, "groq");
    assert.equal(sv.model, "llama-3.3-70b");
    assert.ok(sv.signals_json && sv.signals_json.includes("AAPL"), "signals captured");
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.decisionId, sv.id, "intent links to its decision");
    assert.match(drops[0]!.dropped_rule!, /DOGE/);
  });

  it("without an onDecision sink, no ids are minted (backtest path stays pure)", async () => {
    const driver = mockDriver({ actions: [{ action: "buy", symbol: "AAPL", sizeUsdg: 20, reason: "x" }] });
    const s = makeLlmStrategist({ driver, universe: universe(), decisionIntervalMs: 0, now: (() => { let t = 0; return () => (t += 1); })() });
    const intents = await s.tick(snap());
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.decisionId, undefined);
  });

  it("emits nothing when the sequencer is down — no model call either", async () => {
    const driver = mockDriver({ actions: [] });
    const s = makeLlmStrategist({
      driver,
      universe: universe(),
      decisionIntervalMs: 0,
      now: () => 1,
    });
    assert.deepEqual(await s.tick(snap({ sequencerUp: false })), []);
    assert.equal(driver.calls, 0);
  });
});


/**
 * THE VENUE THE AGENT COULD NEVER PROPOSE.
 *
 * Every arm of proposalsToIntents constructed `kind: "swap"` against a single
 * swapRouter over a symbol→token legs map, so no strategy — deterministic or
 * LLM — could emit a curve trade no matter what else shipped. Meanwhile
 * memecoin-scout already tells the model that coins launch on the Pons
 * launchpad, so the model would name a curve coin and this boundary would
 * answer "not in the tradable universe", forever.
 */
describe("the curve venue at the proposal boundary", () => {
  const CURVE = "0x7777777777777777777777777777777777777777" as const;
  const ADAPTER = "0x8888888888888888888888888888888888888888" as const;
  const MEME = "0x9999999999999999999999999999999999999999" as const;

  // A curve with real reserves: 2 units of quote against 3,000,000 tokens.
  const reserves = {
    quoteRaw: 2_000_000_000_000_000_000n,
    tokenRaw: 3_000_000_000_000_000_000_000_000n,
    quoteDecimals: 18,
    tokenDecimals: 18,
    graduationThresholdRaw: 5_000_000_000_000_000_000n,
  };

  const curveUniverse = (over: Partial<StrategistUniverse> = {}) =>
    universe({
      curveLegs: new Map([["PEPE", { curve: CURVE, quoteToken: USDG, adapter: ADAPTER, reserves }]]),
      curveTokens: new Map([["PEPE", MEME]]),
      slippageBps: 100,
      ...over,
    });

  it("emits a curve-trade for a token that trades on a curve", () => {
    const r = proposalsToIntents(
      [{ action: "buy", symbol: "PEPE", sizeUsdg: 10, reason: "launchpad momentum" }],
      curveUniverse(),
      snap(),
    );
    assert.equal(r.intents.length, 1, r.rejected.join("; "));
    const i = r.intents[0]!;
    assert.equal(i.kind, "curve-trade");
    if (i.kind !== "curve-trade") return;
    // The TARGET is the adapter, never the curve — the curve is an argument the
    // wall cannot pin, which is the whole reason the adapter exists.
    assert.equal(i.target, ADAPTER);
    assert.equal(i.curve, CURVE);
    assert.equal(i.assetIn, USDG);
    assert.equal(i.assetOut, MEME);
    // And it carries a real floor, derived from the SAME reserves that sized it.
    assert.ok(i.minAmountOutRaw > 0n, "a curve trade without a floor is unbounded");
  });

  it("a curve token is NOT rejected as 'not in the tradable universe'", () => {
    // The specific failure a user would have hit: the pool-leg lookup rejects
    // anything missing from `legs`, and a curve token is missing from `legs` by
    // definition — it has no pool. Ordering is the fix and this pins it.
    const r = proposalsToIntents(
      [{ action: "buy", symbol: "PEPE", sizeUsdg: 10, reason: "x" }],
      curveUniverse(),
      snap(),
    );
    assert.equal(r.rejected.length, 0, r.rejected.join("; "));
  });

  it("refuses a native-quoted curve by name rather than by revert", () => {
    // The adapter is non-payable and every wall permission carries valueLimit 0,
    // so this can never work. ~47% of launches are native-quoted.
    const r = proposalsToIntents(
      [{ action: "buy", symbol: "PEPE", sizeUsdg: 10, reason: "x" }],
      curveUniverse({
        curveLegs: new Map([
          [
            "PEPE",
            {
              curve: CURVE,
              quoteToken: "0x0000000000000000000000000000000000000000" as const,
              adapter: ADAPTER,
              reserves,
            },
          ],
        ]),
      }),
      snap(),
    );
    assert.equal(r.intents.length, 0);
    assert.match(r.rejected.join(" "), /native ETH/);
  });

  it("refuses a graduated curve — its market has moved to a pool", () => {
    // Graduation is the TOKEN side emptying, not the quote side filling —
    // PonsSelfTrade.sol describes exactly this shape: “quote side back at the
    // virtual seed, token side empty”.
    const graduated = { ...reserves, tokenRaw: 0n };
    const r = proposalsToIntents(
      [{ action: "buy", symbol: "PEPE", sizeUsdg: 10, reason: "x" }],
      curveUniverse({
        curveLegs: new Map([["PEPE", { curve: CURVE, quoteToken: USDG, adapter: ADAPTER, reserves: graduated }]]),
      }),
      snap(),
    );
    assert.equal(r.intents.length, 0);
    assert.match(r.rejected.join(" "), /graduated/);
  });

  it("sells the WHOLE holding when the curve mark is unpriceable", () => {
    // valueUsdg 0 is the normal state for a curve token the price guard refuses,
    // and the right answer is to sell all of it rather than nothing. Refusing
    // would strand the position exactly when it most needs an exit.
    const r = proposalsToIntents(
      [{ action: "sell", symbol: "PEPE", sizeUsdg: 10, reason: "x" }],
      curveUniverse(),
      snap({
        // A real holding. 500 raw units against a 3e24 token reserve is dust: the
        // quote rounds to zero and the trade is correctly refused, which would
        // have made this test pass for the wrong reason.
        holdings: new Map([["PEPE", { token: MEME, rawBalance: 500_000_000_000_000_000_000n, valueUsdg: 0n, priceStale: false }]]),
      }),
    );
    assert.equal(r.intents.length, 1, r.rejected.join("; "));
    const i = r.intents[0]!;
    if (i.kind !== "curve-trade") throw new Error("expected a curve trade");
    assert.equal(
      i.amountInRaw,
      500_000_000_000_000_000_000n,
      "an unpriceable holding must still be fully sellable",
    );
    assert.equal(i.assetIn, MEME);
    assert.equal(i.assetOut, USDG);
  });

  it("a universe with no curve legs behaves exactly as before", () => {
    // The change must be additive — every existing caller and fixture passes no
    // curve legs at all.
    const r = proposalsToIntents(
      [{ action: "buy", symbol: "AAPL", sizeUsdg: 10, reason: "x" }],
      universe(),
      snap(),
    );
    assert.equal(r.intents.length, 1);
    assert.equal(r.intents[0]!.kind, "swap");
  });
});
