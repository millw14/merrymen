/**
 * THE STRATEGIST PAYS FOR A WINDOW ONLY WHEN ITS ENERGY ALLOWS — AND NEVER
 * WAITS ON ENERGY TO EXIT.
 *
 * A low-energy agent gets about a tenth of a standard day's AI reviews (worker/src/energy.ts).
 * For the strategist a review is a model window, so the window is CLAIMED
 * against that allowance before it is stamped:
 *
 *   - refused: no model call, no stamp, and the very next tick asks again;
 *   - flat with today's new trades used up: nothing it could do is allowed,
 *     so it is not even asked (the breaker's rule, for energy);
 *   - holding with no new trades left: the model may still sell, and any buy
 *     it proposes is withheld before it is journaled;
 *   - the stop floor never asks anything: it is an exit.
 *
 * And the claim is forwarded by the registry only when there is a real model
 * to pay for — the null driver spends nothing, so it must claim nothing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { capEntries, makeLlmStrategist, type StrategistDecision } from "./strategy";
import { buildStrategy } from "../strategies/registry";
import type { Snapshot, Strategy, Tick } from "../strategies/types";

const TSLA = "0x0000000000000000000000000000000000000001" as const;
const NVDA = "0x0000000000000000000000000000000000000002" as const;
const USDG = "0x00000000000000000000000000000000000000dd" as const;
const ROUTER = "0x00000000000000000000000000000000000000ff" as const;

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

const holding = (valueUsdg = 9_000_000n, costUsdg = 10_000_000n) =>
  new Map([["TSLA", { token: TSLA, rawBalance: 5n * 10n ** 18n, valueUsdg, priceStale: false, costUsdg }]]);

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
  over: { clock?: { t: number }; claimWindow?: () => Promise<boolean>; stopLossBps?: number; decisions?: StrategistDecision[]; notes?: string[] } = {},
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
    ...(over.claimWindow ? { claimWindow: over.claimWindow } : {}),
    ...(over.decisions ? { onDecision: (d: StrategistDecision) => void over.decisions!.push(d) } : {}),
    ...(over.notes ? { onNote: (_: string, m: string) => void over.notes!.push(m) } : {}),
  });

const tickOf = async (s: Strategy, sn: Snapshot): Promise<Tick> => {
  const r = await s.tick(sn);
  return Array.isArray(r) ? { intents: r, why: r.map(() => null) } : r;
};

const BUY = { action: "buy", symbol: "NVDA", sizeUsdg: 5, reason: "breadth is back" };
const SELL = { action: "sell", symbol: "TSLA", sizeUsdg: 9, reason: "the thesis broke" };

describe("the window is claimed before it is paid for", () => {
  it("REFUSED: no model call — and the next tick asks again, because nothing was stamped", async () => {
    const spy = driverSaying([BUY]);
    let asked = 0;
    let allow = false;
    const clock = { t: 1_000_000 };
    const s = build(spy.driver, {
      clock,
      claimWindow: async () => {
        asked++;
        return allow;
      },
    });
    const t = await tickOf(s, snap());
    assert.equal(spy.calls.length, 0, "no paid call");
    assert.equal(t.intents.length, 0);
    assert.equal(asked, 1);
    clock.t += 1_000; // one tick later, well inside a 30-minute window
    allow = true;
    const next = await tickOf(s, snap());
    assert.equal(asked, 2, "asked again at once — the refused window was not stamped");
    assert.equal(spy.calls.length, 1);
    assert.equal(next.intents.length, 1);
  });

  it("ADMITTED: the window runs exactly as it always has, and is claimed once", async () => {
    const spy = driverSaying([BUY]);
    let asked = 0;
    const clock = { t: 1_000_000 };
    const s = build(spy.driver, { clock, claimWindow: async () => (asked++, true) });
    assert.equal((await tickOf(s, snap())).intents.length, 1);
    clock.t += 1_000;
    await tickOf(s, snap());
    assert.equal(spy.calls.length, 1, "one window, one call");
    assert.equal(asked, 1, "between windows nothing is claimed");
  });
});

describe("today's new trades used up", () => {
  it("FLAT: NOT ASKED, NOT CLAIMED — the only answer would be a buy that is withheld", async () => {
    const spy = driverSaying([BUY]);
    let asked = 0;
    const t = await tickOf(build(spy.driver, { claimWindow: async () => (asked++, true) }), snap({ energy: { entriesLeft: 0 } }));
    assert.equal(spy.calls.length, 0);
    assert.equal(asked, 0, "no review spent on a window that could not act");
    assert.equal(t.intents.length, 0);
  });

  it("HOLDING: asked, because it may sell — and its buy is withheld before it is journaled", async () => {
    const spy = driverSaying([BUY, SELL]);
    const decisions: StrategistDecision[] = [];
    const notes: string[] = [];
    const t = await tickOf(
      build(spy.driver, { claimWindow: async () => true, decisions, notes }),
      snap({ holdings: holding(), energy: { entriesLeft: 0 } }),
    );
    assert.equal(spy.calls.length, 1);
    assert.equal(t.intents.length, 1, "the sell, and only the sell");
    const out = t.intents[0]!;
    assert.ok(out.kind === "swap" && out.sellToken === TSLA && out.buyToken === USDG);
    assert.deepEqual(decisions.filter((d) => d.action).map((d) => d.action), ["sell"], "no public decision for a buy that cannot happen");
    assert.ok(notes.some((n) => /withheld — today's energy for new trades is used up; sells still run/.test(n)), notes.join("\n"));
  });

  it("an entry still left, or no energy figure at all, withholds nothing", async () => {
    for (const energy of [{ entriesLeft: 1 }, null, undefined]) {
      const spy = driverSaying([BUY]);
      const t = await tickOf(build(spy.driver, { claimWindow: async () => true }), snap({ energy }));
      assert.equal(t.intents.length, 1, JSON.stringify(energy));
    }
  });
});

describe("some of today's new trades left", () => {
  const BUY_TSLA = { action: "buy", symbol: "TSLA", sizeUsdg: 5, reason: "the dip is bought" };

  it("ONE LEFT, TWO BUYS: the first is journaled and announced; the second is only counted as withheld", async () => {
    const spy = driverSaying([BUY, BUY_TSLA]);
    const decisions: StrategistDecision[] = [];
    const notes: string[] = [];
    const t = await tickOf(
      build(spy.driver, { claimWindow: async () => true, decisions, notes }),
      snap({ energy: { entriesLeft: 1 } }),
    );
    assert.equal(t.intents.length, 1, "no more buys than today has left");
    const out = t.intents[0]!;
    assert.ok(out.kind === "swap" && out.sellToken === USDG && out.buyToken === NVDA, "the model's first, in its order");
    assert.deepEqual(
      decisions.filter((d) => d.action).map((d) => [d.action, d.symbol]),
      [["buy", "NVDA"]],
      "no public decision for the buy index.ts would withhold",
    );
    assert.equal(decisions.filter((d) => d.dropped_rule).length, 0, "withheld is not dropped: a drop row publishes");
    assert.ok(notes.some((n) => /^strategist: 1 buy proposal\(s\) withheld — today's energy for new trades is used up; sells still run$/.test(n)), notes.join("\n"));
    assert.ok(!notes.some((n) => /buy 5 USDG TSLA/.test(n)), "and the owner is not told of a buy that will not happen");
    assert.ok(notes.some((n) => /buy 5 USDG NVDA/.test(n)));
  });

  it("THE CAP COUNTS VALID BUYS: one validation drops does not use up the allowance", async () => {
    const spy = driverSaying([{ action: "buy", symbol: "NOPE", sizeUsdg: 5, reason: "x" }, BUY]);
    const t = await tickOf(build(spy.driver, { claimWindow: async () => true }), snap({ energy: { entriesLeft: 1 } }));
    assert.equal(t.intents.length, 1);
    const out = t.intents[0]!;
    assert.ok(out.kind === "swap" && out.buyToken === NVDA);
  });

  it("sells are never capped", async () => {
    const spy = driverSaying([BUY, BUY_TSLA, SELL]);
    const t = await tickOf(
      build(spy.driver, { claimWindow: async () => true }),
      snap({ holdings: holding(), energy: { entriesLeft: 1 } }),
    );
    assert.equal(t.intents.length, 2);
    assert.ok(t.intents.some((i) => i.kind === "swap" && i.sellToken === TSLA && i.buyToken === USDG), "the sell");
    assert.ok(t.intents.some((i) => i.kind === "swap" && i.buyToken === NVDA), "and one buy");
  });

  it("A WITHHELD BUY GIVES BACK ITS ACTION SLOT — a sell behind it still fits the tick", () => {
    const universe = {
      legs: new Map([["TSLA", TSLA], ["NVDA", NVDA]]),
      swapRouter: ROUTER,
      usdg: USDG,
      maxPerActionUsdg: 10_000_000n,
      maxActionsPerTick: 2,
    };
    const proposals = [BUY, BUY_TSLA, SELL] as Parameters<typeof capEntries>[0];
    const once = capEntries(proposals, universe, snap({ holdings: holding() }));
    assert.equal(once.intents.length, 2, "not limited: two buys fill the tick");
    assert.equal(once.rejected.length, 1, "and the sell is turned away for the slot");
    const capped = capEntries(proposals, universe, snap({ holdings: holding(), energy: { entriesLeft: 1 } }));
    assert.equal(capped.withheld, 1);
    assert.deepEqual(capped.rejected, []);
    assert.deepEqual(
      capped.accepted.map((a) => [a.action, a.symbol]),
      [["buy", "NVDA"], ["sell", "TSLA"]],
    );
    assert.deepEqual(capped.kept, [proposals[0], proposals[2]]);
  });

  it("a buy refused for cash stays a refusal, not a withheld one", () => {
    const universe = {
      legs: new Map([["TSLA", TSLA], ["NVDA", NVDA]]),
      swapRouter: ROUTER,
      usdg: USDG,
      maxPerActionUsdg: 10_000_000n,
      maxActionsPerTick: 4,
    };
    const r = capEntries([BUY, BUY_TSLA] as Parameters<typeof capEntries>[0], universe, snap({ cashUsdg: 6_000_000n, energy: { entriesLeft: 1 } }));
    assert.equal(r.intents.length, 1);
    assert.equal(r.withheld, 0);
    assert.equal(r.rejected.length, 1);
  });
});

describe("exits never wait on energy", () => {
  it("THE STOP FLOOR FIRES WITH THE WINDOW REFUSED — it never asks", async () => {
    const spy = driverSaying([BUY]);
    let asked = 0;
    const t = await tickOf(
      build(spy.driver, { stopLossBps: 500, claimWindow: async () => (asked++, false) }),
      snap({ holdings: holding(8_000_000n, 10_000_000n), energy: { entriesLeft: 0 } }),
    );
    assert.equal(t.intents.length, 1);
    assert.equal(t.why[0]?.code, "stop-floor");
    assert.equal(asked, 0, "an exit claims nothing");
    assert.equal(spy.calls.length, 0);
  });
});

describe("the registry forwards the claim only for a real model", () => {
  const opts = (creds: unknown, claimWindow: () => Promise<boolean>) => ({
    swapRouter: ROUTER,
    usdg6: (v: number) => BigInt(Math.round(v * 1e6)),
    basketSymbols: ["TSLA"],
    buyPerTickUsdg: 5,
    idleFloorUsdg: 5,
    gapEnterBudgetUsdg: 5,
    llm: { creds: creds as never, intervalMin: 30, maxActionUsdg: 10, claimWindow },
  });

  it("THE NULL DRIVER CLAIMS NOTHING — it answers nothing and costs nothing", async () => {
    let asked = 0;
    const s = buildStrategy("llm-strategist", opts(null, async () => (asked++, true)));
    await s.tick(snap());
    assert.equal(asked, 0);
  });

  it("a real model's window is claimed (refused here, so no request leaves)", async () => {
    let asked = 0;
    const creds = { provider: "fixture", transport: "openai", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m", vision: false };
    const s = buildStrategy("llm-strategist", opts(creds, async () => (asked++, false)));
    const r = await s.tick(snap());
    assert.equal(asked, 1);
    assert.deepEqual(Array.isArray(r) ? r : (r as Tick).intents, []);
  });
});
