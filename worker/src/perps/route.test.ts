import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isolatedMarginMicro } from "../../../packages/core/src/perps";
import type { PerpsView } from "../strategies/types";
import { buildExitDraft, buildOpenDraft, type PerpOpenDraft } from "./drafts";
import { perpTrendTick } from "./perp-trend";
import { depositToFund, runPerpRoute, type PerpRouteIntent } from "./route";
import { NOW_SEC, breakout, candles, ctx, marketView, position, settings, u, view } from "./testkit-perps";

/**
 * The route decides WHO may produce and in WHAT ORDER: one producer per
 * driver, exits before the one entry, nothing from unread state.
 */

const withBtcExit = (): PerpsView => {
  const closes = [...Array.from({ length: 100 }, () => 820_000n), ...Array.from({ length: 19 }, () => 800_000n), 800_100n];
  const v = view({ positions: new Map([["BTC-PERP", position("BTC-PERP", "long")]]) });
  const markets = new Map(v.markets);
  markets.set("BTC-PERP", marketView("BTC-PERP", { closed4h: candles(closes, 200n) }));
  return { ...v, markets };
};

function strategistOpen(v: PerpsView, key: "BTC-PERP" | "ETH-PERP" = "ETH-PERP", decisionId = "d-open"): PerpRouteIntent {
  const built = buildOpenDraft({ market: v.markets.get(key)!, side: "long", notionalCapMicro: u(20), stopBps: 300, maxSlippageBps: 50, stopSlipBps: 200, liqBufferBps: 200 });
  assert.ok(built.ok);
  return { ...built.draft, decisionId };
}
function strategistClose(v: PerpsView, key: "BTC-PERP" = "BTC-PERP", side: "long" | "short" = "long"): PerpRouteIntent {
  const pos = v.positions.get(key)!;
  const d = buildExitDraft({ market: v.markets.get(key)!, position: { ...pos, side }, effect: "close", maxSlippageBps: 50 });
  assert.ok(d);
  return { ...d, decisionId: "d-close" };
}

describe("runPerpRoute: one producer per driver", () => {
  it("perp-trend: its own exits first, then its one entry, filed under perp-route", () => {
    const v = withBtcExit();
    const r = runPerpRoute({ view: v, settings: settings(), driver: "perp-trend", perpTrendCtx: ctx(), strategistPerpIntents: [strategistOpen(v)] });
    assert.equal(r.source, "perp-route");
    assert.equal(r.exits.length, 1);
    assert.equal(r.exits[0]!.market, "BTC-PERP");
    assert.equal(r.entry?.market, "ETH-PERP");
    assert.equal(r.entry?.decisionId, undefined, "the strategist's intent is IGNORED under perp-trend");
    assert.deepEqual(
      r.why.map((w) => w?.code),
      ["perp-exit", "perp-open"],
    );
    assert.equal(typeof r.entryCandleT, "number");
    // Exactly what perp-trend itself said.
    const t = perpTrendTick(v, settings(), ctx());
    assert.deepEqual(r.entry, t.entry);
  });

  it("Brain keeps deterministic exits while entries wait for a matching review", () => {
    const v = withBtcExit();
    const input = { view: v, settings: settings(), driver: "brain" as const, perpTrendCtx: ctx() };
    const waiting = runPerpRoute(input), approved = runPerpRoute({ ...input, brainApproved: true });
    const baseline = runPerpRoute({ ...input, driver: "perp-trend" });
    assert.deepEqual(waiting.exits, baseline.exits);
    assert.equal(waiting.entry, null);
    assert.deepEqual(approved.entry, baseline.entry, "Brain never changes size, leverage or stop");
    assert.deepEqual(approved.exits, baseline.exits);
  });

  it("strategist: only the strategist's intents, exits first, at most one entry, filed under perp:strategist", () => {
    const v = withBtcExit();
    const intents = [strategistOpen(v, "ETH-PERP", "a"), strategistClose(v), strategistOpen(v, "ETH-PERP", "b")];
    const r = runPerpRoute({ view: v, settings: settings({ perpsDriver: "strategist" }), driver: "strategist", perpTrendCtx: ctx(), strategistPerpIntents: intents });
    assert.equal(r.source, "perp:strategist");
    assert.deepEqual(
      r.exits.map((x) => x.decisionId),
      ["d-close"],
    );
    assert.equal(r.entry?.decisionId, "a", "the first open; the second waits");
    assert.equal(r.dropped.length, 1);
    assert.deepEqual(r.why[0], null, "a model's exit speaks through its decision row");
    assert.equal(r.why[1]?.code, "perp-open");
    // perp-trend would have exited BTC and opened on its own signal — it did not run.
    assert.equal(r.entryCandleT, null);
  });

  it("manual: nothing at all, whatever is handed in", () => {
    const v = withBtcExit();
    const r = runPerpRoute({ view: v, settings: settings({ perpsDriver: "manual" }), driver: "manual", perpTrendCtx: ctx(), strategistPerpIntents: [strategistClose(v), strategistOpen(v)] });
    assert.deepEqual(r, { exits: [], entry: null, why: [], idle: null, source: null, entryCandleT: null, dropped: [] });
  });

  it("an unknown driver produces nothing — it never falls back to perp-trend", () => {
    const r = runPerpRoute({ view: withBtcExit(), settings: settings(), driver: "future-driver" as "manual", perpTrendCtx: ctx() });
    assert.equal(r.source, null);
    assert.equal(r.exits.length + (r.entry ? 1 : 0), 0);
  });

  it("Lighter unread: no entry and no exit from any driver", () => {
    for (const driver of ["perp-trend", "brain", "strategist", "manual"] as const) {
      for (const v of [null, undefined]) {
        const r = runPerpRoute({ view: v, settings: settings(), driver, perpTrendCtx: ctx(), strategistPerpIntents: [strategistClose(withBtcExit())] });
        assert.equal(r.exits.length, 0, driver);
        assert.equal(r.entry, null, driver);
        assert.equal(r.source, null, driver);
      }
    }
    assert.deepEqual(runPerpRoute({ view: null, settings: settings(), driver: "perp-trend", perpTrendCtx: ctx() }).idle, { code: "perp-signal-unread", market: null });
  });

  it("perps off in Settings stops OPENS only: the strategy still closes what it holds", () => {
    const v = withBtcExit();
    const r = runPerpRoute({ view: v, settings: settings({ perpsEnabled: false }), driver: "perp-trend", perpTrendCtx: ctx() });
    assert.equal(r.exits.length, 1);
    assert.equal(r.entry, null);
    assert.equal(r.why.length, 1);
    const s = runPerpRoute({ view: v, settings: settings({ perpsEnabled: false }), driver: "strategist", perpTrendCtx: ctx(), strategistPerpIntents: [strategistClose(v), strategistOpen(v)] });
    assert.equal(s.exits.length, 1);
    assert.equal(s.entry, null);
  });
});

describe("runPerpRoute: the strategist's intents are held to this tick's view", () => {
  it("an exit for a position no longer held, or on the other side, is dropped — never re-read as an open", () => {
    const v = withBtcExit();
    const close = strategistClose(v);
    const flat = { ...v, positions: new Map() };
    const r = runPerpRoute({ view: flat, settings: settings(), driver: "strategist", perpTrendCtx: ctx(), strategistPerpIntents: [close] });
    assert.equal(r.exits.length, 0);
    assert.match(r.dropped[0]!.why, /nothing is held/);
    const wrongSide = strategistClose(v, "BTC-PERP", "short");
    const w = runPerpRoute({ view: v, settings: settings(), driver: "strategist", perpTrendCtx: ctx(), strategistPerpIntents: [wrongSide] });
    assert.equal(w.exits.length, 0);
    assert.match(w.dropped[0]!.why, /is long, not short/);
  });

  it("two exits for one market: the first", () => {
    const v = withBtcExit();
    const r = runPerpRoute({ view: v, settings: settings(), driver: "strategist", perpTrendCtx: ctx(), strategistPerpIntents: [strategistClose(v), strategistClose(v)] });
    assert.equal(r.exits.length, 1);
  });

  it("the brakes stop the strategist's entry and never its exits", () => {
    const v = withBtcExit();
    for (const c of [ctx({ breakerIdle: false }), ctx({ energyEntriesLeft: false }), ctx({ opsHeadroom: false })]) {
      const r = runPerpRoute({ view: v, settings: settings(), driver: "strategist", perpTrendCtx: c, strategistPerpIntents: [strategistClose(v), strategistOpen(v)] });
      assert.equal(r.exits.length, 1);
      assert.equal(r.entry, null);
    }
    const blocked = runPerpRoute({ view: { ...v, opensBlocked: "perps-entries-halted" }, settings: settings(), driver: "strategist", perpTrendCtx: ctx(), strategistPerpIntents: [strategistOpen(v)] });
    assert.equal(blocked.entry, null);
  });

  it("no open where a position, an unresolved order or this tick's exit already is", () => {
    const v = withBtcExit();
    const onHeld = strategistOpen(v, "BTC-PERP");
    const r = runPerpRoute({ view: v, settings: settings(), driver: "strategist", perpTrendCtx: ctx(), strategistPerpIntents: [onHeld] });
    assert.equal(r.entry, null);
    const pending = runPerpRoute({ view: { ...v, unresolved: new Set(["ETH-PERP" as const]) }, settings: settings(), driver: "strategist", perpTrendCtx: ctx(), strategistPerpIntents: [strategistOpen(v)] });
    assert.equal(pending.entry, null);
  });
});

describe("depositToFund: margin + 10% for the open in hand, within every cap, never shrunk", () => {
  const open = (notional: bigint, imfBp = 5_000) => ({ notionalUsdg: notional, imfBp }) as Pick<PerpOpenDraft, "notionalUsdg" | "imfBp">;
  const v = (free: bigint, left = u(30)) => ({ account: { collateralMicro: free, freeCollateralMicro: free, accountValueMicro: free, inTransitMicro: 0n }, headroom: { perTradeNotionalMicro: u(25), openNotionalLeftMicro: u(50), collateralLeftMicro: left, opensLeftToday: 4 } });
  const caps = { perTradeSealedMicro: u(25), spendHeadroomMicro: u(100) };

  it("margin 10 + 10% = 11 with nothing at the venue", () => {
    assert.equal(isolatedMarginMicro(u(20), 5_000), u(10));
    assert.deepEqual(depositToFund(open(u(20)), v(0n), caps), { ok: true, amountMicro: u(11) });
  });
  it("free collateral already there is used first; enough of it needs no deposit", () => {
    assert.deepEqual(depositToFund(open(u(20)), v(u(4)), caps), { ok: true, amountMicro: u(7) });
    assert.deepEqual(depositToFund(open(u(20)), v(u(11)), caps), { ok: true, amountMicro: 0n });
  });
  it("raised to the 1 USDG venue minimum", () => {
    assert.deepEqual(depositToFund(open(u(20)), v(u(10.5)), caps), { ok: true, amountMicro: u(1) });
  });
  it("refused — not shrunk — past the collateral room, the sealed per-trade cap or the day's spend", () => {
    assert.equal(depositToFund(open(u(20)), v(0n, u(10)), caps).ok, false);
    assert.equal(depositToFund(open(u(20)), v(0n), { ...caps, perTradeSealedMicro: u(10) }).ok, false);
    assert.equal(depositToFund(open(u(20)), v(0n), { ...caps, spendHeadroomMicro: u(5) }).ok, false);
    assert.equal(depositToFund(open(u(20)), v(0n), { ...caps, spendHeadroomMicro: null }).ok, true, "unread spend is not zero");
  });
});

it("route fixtures: the default view breaks out on both markets (sanity for the cases above)", () => {
  const r = perpTrendTick(view(), settings(), ctx());
  assert.ok(r.entry);
  assert.equal(breakout("BTC-PERP", 0n).length, 120);
  assert.equal(NOW_SEC % 3600, 0);
});
