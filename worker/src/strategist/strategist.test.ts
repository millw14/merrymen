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
