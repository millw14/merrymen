/**
 * A TICK THAT BOUGHT NOTHING HAS TO SAY WHY.
 *
 * `steadyBasketTick` skips any leg whose price feed is stale — correctly, since
 * there is no reference price to buy against. All 24 Chainlink equity feeds go
 * stale when the underlying markets shut, so over a weekend every leg is
 * skipped and the function returns an empty intent list.
 *
 * Which is exactly what a healthy quiet tick returns. Thirty-four agents spent
 * a weekend in that state, saying nothing, and their owners reported it as
 * "no trading is being done" — a reasonable reading of the evidence they had.
 *
 * Only this function can tell the two silences apart. The caller sees an empty
 * array either way.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { steadyBasketTick, type SteadyBasketConfig } from "./steady-basket";
import { renderWhy } from "./reasons";
import type { Snapshot } from "./types";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const QQQ = "0x4444444444444444444444444444444444444444" as const;
const NVDA = "0x5555555555555555555555555555555555555555" as const;
const TSLA = "0x6666666666666666666666666666666666666666" as const;

const cfg = (over: Partial<SteadyBasketConfig> = {}): SteadyBasketConfig => ({
  legs: [
    { symbol: "QQQ", token: QQQ, weightBps: 3333 },
    { symbol: "NVDA", token: NVDA, weightBps: 3333 },
    { symbol: "TSLA", token: TSLA, weightBps: 3333 },
  ],
  buyPerTickUsdg: 25_000_000n,
  idleFloorUsdg: 50_000_000n,
  swapRouter: ROUTER,
  vault: VAULT,
  usdg: USDG,
  ...over,
});

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  cashUsdg: 100_000_000n,
  vaultUsdg: 0n,
  holdings: new Map(),
  prices: new Map(),
  pausedTokens: new Set(),
  staleFeeds: new Set(),
  sequencerUp: true,
  spendHeadroomUsdg: 1_000_000_000_000n,
  perTradeCapUsdg: 1_000_000_000_000n,
  ...over,
});

describe("a stale weekend is reported, not just endured", () => {
  it("EVERY LEG STALE — no intents, and a reason saying so", () => {
    const t = steadyBasketTick(cfg(), snap({ staleFeeds: new Set(["QQQ", "NVDA", "TSLA"]) }));
    assert.equal(t.intents.filter((i) => i.kind === "swap").length, 0, "no reference price, no buy");
    assert.ok(t.idle, "a tick that wanted to buy and could not must say why");
    assert.equal(t.idle!.code, "all-legs-stale");
    const said = renderWhy(t.idle!);
    assert.match(said, /stale/);
    // The distinction this whole codebase turns on: our reads, not the market.
    assert.match(said, /about the feeds, not about the market/);
    assert.doesNotMatch(said, /0x/, "a reason is published — it may never carry an address");
  });

  it("one fresh leg is enough — it buys, and says nothing about idling", () => {
    const t = steadyBasketTick(cfg(), snap({ staleFeeds: new Set(["QQQ", "NVDA"]) }));
    assert.equal(t.intents.filter((i) => i.kind === "swap").length, 1);
    assert.equal(t.idle, undefined, "a tick that bought must not also claim it could not");
  });

  it("SHORT OF CASH IS A DIFFERENT SILENCE, and it gets its own sentence", () => {
    // This used to assert `idle === undefined`, and it was RIGHT about the
    // wrong sentence — telling an owner whose account is empty that "the feeds
    // are stale" sends them to wait for Monday instead of to the deposit
    // screen. It was wrong to conclude that saying nothing was the answer.
    //
    // Nothing at all was the worse outcome: the buy loop never runs, so
    // skippedStale stays 0, so `shut` is false, so no reason fires — and the
    // live rail is only blocked by an EXACT zero, so the agent reports
    // "trading for real — every leg available" beside an empty tape, forever,
    // on stock defaults. That is the "nothing happens" complaint, and it had no
    // sentence anywhere in the system.
    const t = steadyBasketTick(cfg(), snap({ cashUsdg: 1_000_000n, staleFeeds: new Set(["QQQ", "NVDA", "TSLA"]) }));
    assert.equal(t.idle?.code, "under-one-buy");
    // The BALANCE, not the feeds — even though the feeds are stale here too.
    // Whichever is reported is the one the owner will act on.
    const said = renderWhy(t.idle!);
    assert.match(said, /1\.00 USDG on hand and one buy costs 25\.00/);
    assert.match(said, /Add funds or lower the size per trade/);
    assert.ok(!/stale/.test(said), "the actionable fact is the money, not the weekend");
  });

  it("and when the vault can cover it, it says the problem clears itself", () => {
    // Cash short WITH a vault balance is the unpark tick — a different remedy
    // again, and one the agent performs on its own. Telling that owner to add
    // funds would be wrong.
    const t = steadyBasketTick(cfg(), snap({ cashUsdg: 1_000_000n, vaultUsdg: 50_000_000n }));
    assert.equal(t.idle, undefined, "a tick that DID something is not idle");
    assert.equal(t.intents[0]?.kind, "vault-withdraw");
  });

  it("no legs configured is not a silence this reports", () => {
    // An empty basket is a different fact and the basket screen already states
    // it. Reporting "you have 1.00 USDG and a buy costs 25.00" about a strategy
    // with nothing to buy would be a true sentence about the wrong problem.
    const bare = { ...cfg(), legs: [] };
    assert.equal(steadyBasketTick(bare, snap({ cashUsdg: 1_000_000n })).idle, undefined);
  });

  it("counts paused legs separately, because pausing is not staleness", () => {
    const t = steadyBasketTick(
      cfg(),
      snap({ staleFeeds: new Set(["QQQ", "NVDA"]), pausedTokens: new Set([TSLA.toLowerCase()]) }),
    );
    assert.ok(t.idle);
    assert.equal(t.idle!.code === "all-legs-stale" && t.idle!.paused, 1);
    assert.match(renderWhy(t.idle!), /paused/);
  });

  it("still reports while it sweeps cash to the vault", () => {
    // Over a weekend the sweep is the ONLY thing a basket agent does, and its
    // owner is still owed the sentence about why nothing was bought. An earlier
    // shape keyed on "produced no intents at all" and went silent in exactly
    // the case that matters.
    const t = steadyBasketTick(cfg(), snap({ cashUsdg: 500_000_000n, staleFeeds: new Set(["QQQ", "NVDA", "TSLA"]) }));
    assert.ok(t.intents.some((i) => i.kind === "vault-deposit"), "idle cash is still parked");
    assert.ok(t.idle, "and the silence about buying is still explained");
  });

  it("the worker reports it once per CHANGE, not once per tick", async () => {
    // A stale weekend is ~360 ticks. This repo already carries the incident
    // where 1,242 identical rows told nobody anything.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    assert.match(src, /lastIdleReason/, "the worker must remember what it last said");
    const guard = src.indexOf("if (idleNow !== lastIdleReason)");
    const write = src.indexOf("await addEvent(agentId, \"ok\", idleNow)");
    assert.ok(guard > 0 && write > guard, "the event must sit inside the change guard");
  });
});
