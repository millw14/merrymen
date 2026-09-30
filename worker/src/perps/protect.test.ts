/**
 * THE PROTECTIVE LOOP. Each priority is tested ALONE on an otherwise healthy
 * position — one condition broken, one action back — then in combination, to
 * prove the order and the one-close-per-market rule. The unread cases prove the
 * contract's hardest line: nothing here ever closes on state nobody read. The
 * clock and the lock are tested with real timers at millisecond scale.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { notionalMicro, stopPrices, worstPriceForTaker, type PerpKey, type PerpMarketSpec } from "../../../packages/core/src/index";
import type { PerpPositionView } from "../strategies/types";
import {
  PROTECT_THRESHOLDS,
  createPerpLaneLock,
  emptyProtectMemory,
  evaluateProtection,
  protectCadenceMs,
  protectCloseSlipBps,
  startProtectLoop,
  type ProtectAction,
  type ProtectMemory,
  type ProtectSettings,
} from "./protect";
import type { PerpPositionFacts, PerpsViewBuilt } from "./view";

const NOW = 1_800_000_000;
const DAY = 86_400;
const u = (usdg: number) => BigInt(Math.round(usdg * 1e6));

/** BTC as orderBookDetails shaped it on 2026-09-29 (sd 5, pd 1, MMF 1.2%). */
const BTC: PerpMarketSpec = {
  marketId: 1,
  sizeDecimals: 5,
  priceDecimals: 1,
  minBaseAmount: 20n,
  minQuoteMicro: u(10),
  minImfBp: 200,
  defaultImfBp: 5_000,
  mmfBp: 120,
  closeoutBp: 80,
  status: "active",
};
const ETH: PerpMarketSpec = { ...BTC, marketId: 0, sizeDecimals: 4, priceDecimals: 2, minBaseAmount: 50n };

const MARK = 830_000n; // 83,000.0
const STOP = stopPrices({ side: "long", entryRefPrice: MARK, stopLossBps: 500, stopSlipBps: 200 }); // 788,500 / 772,730
const SETTINGS: ProtectSettings = { perpsStopLossPct: 5, perpsStopSlipBps: 200, perpsLiqBufferPct: 2, perpsMaxSlippageBps: 50 };

type Pos = [PerpPositionView, PerpPositionFacts];

function pos(
  o: Partial<Omit<PerpPositionView, "stop" | "take">> & { stop?: PerpPositionView["stop"] } = {},
  f: Partial<PerpPositionFacts> = {},
): Pos {
  const key = o.key ?? "BTC-PERP";
  const marketId = o.marketId ?? 1;
  const spec = marketId === 0 ? ETH : BTC;
  const base = o.baseAmount ?? 30n;
  const mark = o.markPrice ?? MARK;
  const p: PerpPositionView = {
    key,
    marketId,
    side: o.side ?? "long",
    baseAmount: base,
    entryPrice: o.entryPrice ?? MARK,
    markPrice: mark,
    notionalMicro: notionalMicro(base, mark, spec, "ceil"),
    unrealizedMicro: o.unrealizedMicro ?? 0n,
    allocatedMarginMicro: o.allocatedMarginMicro ?? u(12.45),
    imfBp: o.imfBp ?? 5_000,
    liqPrice: o.liqPrice === undefined ? 420_000n : o.liqPrice,
    stop: o.stop === undefined ? { ...STOP, expiresAtSec: NOW + 20 * DAY, resting: true } : o.stop,
    take: null,
    openedAtSec: o.openedAtSec ?? NOW - 3_600,
    fundingMicro: o.fundingMicro ?? 0n,
  };
  const facts: PerpPositionFacts = {
    key,
    marketId,
    decimals: { sizeDecimals: spec.sizeDecimals, priceDecimals: spec.priceDecimals },
    markSource: "feed",
    markFresh: true,
    recordedStop: { ...STOP },
    stopState: "resting",
    stopExpiresAtSec: NOW + 20 * DAY,
    restingStopOrder: "501",
    otherStopOrders: [],
    openingUnresolved: false,
    openedAtKnown: true,
    held: { spec, status: "active", fundingPpmPerHour: 12, fresh: true },
    ...f,
  };
  return [p, facts];
}

/** Views built without an explicit read time are read "just now" at whatever time a pass evaluates them. */
const READ_JUST_NOW = new WeakSet<PerpsViewBuilt>();

function mkView(positions: Pos[], o: { readAtSec?: number; mode?: "paper" | "live" } = {}): PerpsViewBuilt {
  const mode = o.mode ?? "live";
  const v: PerpsViewBuilt = {
    mode,
    readAtSec: o.readAtSec ?? NOW - 2,
    account: { collateralMicro: 0n, freeCollateralMicro: 0n, accountValueMicro: 0n, inTransitMicro: 0n },
    positions: new Map(positions.map(([p]) => [p.key, p])),
    markets: new Map(),
    unresolved: new Set(),
    headroom: { perTradeNotionalMicro: u(25), openNotionalLeftMicro: u(50), collateralLeftMicro: u(30), opensLeftToday: 4 },
    opensBlocked: null,
    lastExit: new Map(),
    lastEntryCandleT: new Map(),
    grantExpiresAtSec: NOW + 30 * DAY,
    facts: {
      mode,
      accountIndex: mode === "live" ? 22149 : null,
      positions: new Map(positions.map(([p, f]) => [p.key, f])),
      foreign: [],
      venueDecimals: null,
      book: "unread",
      openNotionalMicro: 0n,
      committedCollateralMicro: 0n,
      depositsInTransitMicro: 0n,
      withdrawalsInTransitMicro: 0n,
      incident: false,
      entriesHalted: false,
      closeInFlight: new Set(),
      readAtMs: (o.readAtSec ?? NOW - 2) * 1000,
    },
  };
  if (o.readAtSec === undefined) READ_JUST_NOW.add(v);
  return v;
}

/** One pass. */
function run(view: PerpsViewBuilt | null, nowSec = NOW, prior: ProtectMemory = emptyProtectMemory(), feedFresh = true) {
  const v = view !== null && READ_JUST_NOW.has(view) ? { ...view, readAtSec: nowSec - 2 } : view;
  return evaluateProtection({ view: v, nowSec, settings: SETTINGS, prior, feedFresh });
}

/** Several passes over the same view at the given times, threading memory; returns each pass's actions. */
function passes(view: PerpsViewBuilt | null, times: number[], feedFresh = true): { acts: ProtectAction[][]; memory: ProtectMemory } {
  let memory = emptyProtectMemory();
  const acts: ProtectAction[][] = [];
  for (const t of times) {
    const r = run(view, t, memory, feedFresh);
    acts.push(r.actions);
    memory = r.memory;
  }
  return { acts, memory };
}

const kinds = (a: readonly ProtectAction[]) => a.map((x) => (x.kind === "close" ? `close:${x.cause}` : x.kind === "alert" ? `alert:${x.code}` : `replace:${x.reason}`));
const closes = (a: readonly ProtectAction[]) => a.filter((x): x is Extract<ProtectAction, { kind: "close" }> => x.kind === "close");

// ── a healthy position is left alone ────────────────────────────────────────

describe("a healthy position", () => {
  it("gets nothing: no close, no placement, no alert", () => {
    assert.deepEqual(run(mkView([pos()])).actions, []);
  });
  it("the thresholds are the contract's", () => {
    const t = PROTECT_THRESHOLDS;
    assert.equal(t.activeIntervalMs, 15_000);
    assert.equal(t.idleIntervalMs, 60_000);
    assert.equal(t.breachBps, 25);
    assert.equal(t.breachConfirmSec, 15);
    assert.equal(t.stopRenewSec, 7 * DAY, "the contract says 7 days, not 48 h");
    assert.equal(t.fundingPaidShareBps, 5_000);
    assert.equal(t.fundingAgainstPpmPerHour, 500, "0.05%/h");
    assert.equal(t.openGraceSec, 60);
    assert.equal(t.unreadAlertSec, 120);
    assert.equal(t.unreadRecoverAlertSec, 600);
  });
});

// ── P1 ──────────────────────────────────────────────────────────────────────

describe("P1 liquidation proximity", () => {
  it("within half the buffer: a reduce-only, full-size close with Why perp-risk-exit{liq-proximity}", () => {
    const liq = MARK - (MARK * 90n) / 10_000n; // 90 bp away; buffer 200 bp, half 100
    const [c, ...rest] = closes(run(mkView([pos({ liqPrice: liq })])).actions);
    assert.equal(rest.length, 0);
    assert.ok(c);
    assert.equal(c.rule, "P1");
    assert.equal(c.cause, "liq-proximity");
    assert.deepEqual(c.why, { code: "perp-risk-exit", market: "BTC-PERP", side: "long", cause: "liq-proximity" });
    const worst = worstPriceForTaker({ isAsk: true, mark: MARK, maxSlippageBps: 150 });
    assert.deepEqual(c.intent, {
      kind: "perp-order",
      venue: "lighter",
      market: "BTC-PERP",
      marketId: 1,
      effect: "close",
      side: "long",
      reduceOnly: true,
      baseAmount: 30n,
      worstPrice: worst,
      markPrice: MARK,
      notionalUsdg: notionalMicro(30n, MARK, BTC, "ceil"),
    });
  });

  it("within the buffer but not half: one alert per episode, no close", () => {
    const tightStop = { trigger: 826_000n, price: 825_000n };
    const near = pos({ liqPrice: MARK - (MARK * 150n) / 10_000n }, { recordedStop: tightStop });
    const far = pos({ liqPrice: 420_000n }, { recordedStop: tightStop });
    let mem = emptyProtectMemory();
    const seq: [Pos, string[]][] = [
      [near, ["alert:perp-liq-proximity"]],
      [near, []],
      [far, []],
      [near, ["alert:perp-liq-proximity"]],
    ];
    for (const [p, want] of seq) {
      const r = run(mkView([p]), NOW, mem);
      assert.deepEqual(kinds(r.actions), want);
      mem = r.memory;
    }
  });

  it("a recorded stop whose worst price no longer beats liquidation: close (liq-inside-stop)", () => {
    const liq = 780_000n; // above the stop's 772,730 worst price, 6% from mark
    assert.deepEqual(kinds(run(mkView([pos({ liqPrice: liq })])).actions), ["close:liq-inside-stop"]);
    // …but not against a DERIVED stop: that is our guess, not a stop that failed.
    assert.deepEqual(kinds(run(mkView([pos({ liqPrice: liq, stop: null }, { recordedStop: null, stopState: "unread" })])).actions), []);
  });

  it("a short mirrors it", () => {
    const liq = MARK + (MARK * 90n) / 10_000n;
    const shortStop = stopPrices({ side: "short", entryRefPrice: MARK, stopLossBps: 500, stopSlipBps: 200 });
    const p = pos({ side: "short", liqPrice: liq }, { recordedStop: shortStop });
    const [c] = closes(run(mkView([p])).actions);
    assert.ok(c);
    assert.equal(c.cause, "liq-proximity");
    assert.equal(c.intent.side, "short");
    assert.equal(c.intent.worstPrice, worstPriceForTaker({ isAsk: false, mark: MARK, maxSlippageBps: 150 }));
  });
});

// ── P2 ──────────────────────────────────────────────────────────────────────

describe("P2 stop breached", () => {
  const past30 = pos({ markPrice: 786_100n }); // 2,400 below the 788,500 trigger ≈ 30 bp
  const past20 = pos({ markPrice: 786_923n }); // ≈ 20 bp

  it("≥ 25 bp past on two reads ≥ 15 s apart closes; one read, or 10 s, does not", () => {
    const { acts } = passes(mkView([past30]), [NOW, NOW + 10, NOW + 15]);
    assert.deepEqual(acts.map(kinds), [[], [], ["close:stop-breached"]]);
    assert.equal(closes(acts[2]!)[0]!.rule, "P2");
  });

  it("20 bp past with the stop resting is the venue stop's to act on", () => {
    assert.deepEqual(passes(mkView([past20]), [NOW, NOW + 20]).acts.map(kinds), [[], []]);
  });

  it("a breach that clears restarts the two-read clock", () => {
    let mem = emptyProtectMemory();
    mem = run(mkView([past30]), NOW, mem).memory;
    mem = run(mkView([pos()]), NOW + 5, mem).memory;
    const r = run(mkView([past30]), NOW + 16, mem);
    assert.deepEqual(r.actions, []);
    assert.equal(r.memory.markets.get("BTC-PERP")!.firstBreachAt, NOW + 16);
  });

  it("with no stop resting the grace is 0 bp — and no stop is placed on the wrong side of mark", () => {
    const missing = pos({ markPrice: 788_400n, stop: null }, { stopState: "missing", restingStopOrder: null });
    const { acts } = passes(mkView([missing]), [NOW, NOW + 15]);
    assert.deepEqual(acts.map(kinds), [["alert:perp-stop-missing"], ["close:stop-breached"]]);
  });

  it("an unread order state keeps the 25 bp grace (the stop may be resting)", () => {
    const unread = pos({ markPrice: 786_923n }, { stopState: "unread" });
    assert.deepEqual(passes(mkView([unread]), [NOW, NOW + 20]).acts.map(kinds), [[], []]);
  });
});

// ── P3 ──────────────────────────────────────────────────────────────────────

describe("P3 stop missing, wrong or expiring", () => {
  const missing = pos({ stop: null }, { stopState: "missing", restingStopOrder: null });

  it("missing: alert, re-place at the recorded stop; wait 60 s between placements; two that never appear → close", () => {
    const { acts } = passes(mkView([missing]), [NOW, NOW + 30, NOW + 60, NOW + 120, NOW + 130]);
    assert.deepEqual(acts.map(kinds), [
      ["alert:perp-stop-missing", "replace:missing"],
      [],
      ["replace:missing"],
      ["close:stop-missing"],
      [],
    ]);
    const r = acts[0]![1]!;
    assert.ok(r.kind === "replace-stop");
    assert.equal(r.trigger, STOP.trigger);
    assert.equal(r.price, STOP.price);
    assert.deepEqual(r.supersedes, []);
    assert.equal(closes(acts[3]!)[0]!.rule, "P3");
  });

  it("a stop seen again ends the episode", () => {
    let mem = run(mkView([missing]), NOW).memory;
    mem = run(mkView([pos()]), NOW + 15, mem).memory;
    assert.deepEqual(kinds(run(mkView([missing]), NOW + 30, mem).actions), ["alert:perp-stop-missing", "replace:missing"]);
  });

  it("resting at another trigger: re-place at the recorded one, superseding the others only once it rests", () => {
    const other = pos({}, { stopState: "other", restingStopOrder: null, otherStopOrders: ["9", "10"] });
    const acts = run(mkView([other])).actions;
    assert.deepEqual(kinds(acts), ["alert:perp-stop-missing", "replace:other"]);
    const r = acts[1]!;
    assert.ok(r.kind === "replace-stop");
    assert.deepEqual(r.supersedes, ["9", "10"]);
  });

  it("expiring within 7 days is renewed (and never closed on); 8 days is left alone", () => {
    const six = pos({}, { stopExpiresAtSec: NOW + 6 * DAY, otherStopOrders: ["77"] });
    const acts = run(mkView([six])).actions;
    assert.deepEqual(kinds(acts), ["alert:perp-stop-expiring", "replace:expiring"]);
    const r = acts[1]!;
    assert.ok(r.kind === "replace-stop");
    assert.deepEqual(r.supersedes, ["501", "77"]);
    assert.deepEqual(run(mkView([pos({}, { stopExpiresAtSec: NOW + 8 * DAY })])).actions, []);
    // A renewal that keeps failing still leaves the old stop resting: retried, not closed.
    const { acts: many } = passes(mkView([six]), [NOW, NOW + 60, NOW + 120, NOW + 180]);
    assert.ok(many.every((a) => closes(a).length === 0));
  });

  it("an unknown expiry: a live stop is renewed (it cannot be shown to live); a paper stop has none", () => {
    const unknown = pos({}, { stopExpiresAtSec: null });
    assert.deepEqual(kinds(run(mkView([unknown], { mode: "live" })).actions), ["alert:perp-stop-expiring", "replace:expiring"]);
    assert.deepEqual(run(mkView([unknown], { mode: "paper" })).actions, []);
  });

  it("an UNREAD order state is not a missing stop: nothing is placed", () => {
    assert.deepEqual(run(mkView([pos({}, { stopState: "unread" })])).actions, []);
  });

  it("no record: the stop is derived from the entry and the owner's setting", () => {
    const adopted = pos({ stop: null, entryPrice: 840_000n }, { recordedStop: null, stopState: "missing", restingStopOrder: null });
    const r = run(mkView([adopted])).actions.find((a) => a.kind === "replace-stop");
    assert.ok(r && r.kind === "replace-stop");
    const want = stopPrices({ side: "long", entryRefPrice: 840_000n, stopLossBps: 500, stopSlipBps: 200 });
    assert.equal(r.trigger, want.trigger);
    assert.equal(r.price, want.price);
  });

  it("a stop that cannot be derived is said once, not every pass", () => {
    const bad = pos({ stop: null, entryPrice: 0n }, { recordedStop: null, stopState: "missing", restingStopOrder: null });
    const { acts } = passes(mkView([bad]), [NOW, NOW + 15]);
    assert.deepEqual(acts.map(kinds), [["alert:perp-stop-missing", "alert:perp-stop-underivable"], []]);
  });

  it("with the mark unread a missing stop is still put back — the venue fires it on its own mark", () => {
    const stale = pos({ stop: null }, { stopState: "missing", markFresh: false, restingStopOrder: null });
    assert.deepEqual(kinds(run(mkView([stale])).actions), ["alert:perp-stop-missing", "replace:missing"]);
  });
});

// ── P4 ──────────────────────────────────────────────────────────────────────

describe("P4 funding bleed", () => {
  // initial stop risk = 24.9 USDG × 5% = 1.245 USDG; half is 0.6225
  it("funding paid ≥ 50% of the initial stop risk closes; a micro less does not", () => {
    assert.deepEqual(kinds(run(mkView([pos({ fundingMicro: -622_500n })])).actions), ["close:funding-bleed"]);
    assert.deepEqual(run(mkView([pos({ fundingMicro: -622_499n })])).actions, []);
    assert.deepEqual(run(mkView([pos({ fundingMicro: 5_000_000n })])).actions, [], "funding received is not a bleed");
  });

  it("a current rate against the side of ≥ 0.05%/h closes; for the side does not", () => {
    const rate = (side: "long" | "short", ppm: number) =>
      kinds(run(mkView([pos({ side, liqPrice: null }, { recordedStop: null, stopState: "unread", held: { spec: BTC, status: "active", fundingPpmPerHour: ppm, fresh: true } })])).actions);
    assert.deepEqual(rate("long", 500), ["close:funding-bleed"]);
    assert.deepEqual(rate("long", 499), []);
    assert.deepEqual(rate("short", 500), []);
    assert.deepEqual(rate("short", -500), ["close:funding-bleed"]);
  });

  it("an unread rate is not a rate", () => {
    const p = pos({}, { held: { spec: BTC, status: null, fundingPpmPerHour: null, fresh: false } });
    assert.deepEqual(run(mkView([p])).actions, []);
  });
});

// ── P5 ──────────────────────────────────────────────────────────────────────

describe("P5 market status", () => {
  const status = (s: "active" | "reduce-only" | "inactive") => pos({}, { held: { spec: BTC, status: s, fundingPpmPerHour: 12, fresh: true } });

  it("reduce-only: one alert, no close (opens are refused by policy; the stop stays)", () => {
    const { acts } = passes(mkView([status("reduce-only")]), [NOW, NOW + 15, NOW + 60]);
    assert.deepEqual(acts.map(kinds), [["alert:perp-market-reduce-only"], [], []]);
  });

  it("inactive: an alert and ONE close attempt per episode", () => {
    let mem = emptyProtectMemory();
    const seq: [Pos, number, string[]][] = [
      [status("inactive"), NOW, ["alert:perp-market-inactive", "close:market-status"]],
      [status("inactive"), NOW + 60, []],
      [status("inactive"), NOW + 600, []],
      [status("active"), NOW + 700, []],
      [status("inactive"), NOW + 800, ["alert:perp-market-inactive", "close:market-status"]],
    ];
    for (const [p, t, want] of seq) {
      const r = run(mkView([p]), t, mem);
      assert.deepEqual(kinds(r.actions), want, `at +${t - NOW}`);
      mem = r.memory;
    }
  });
});

// ── P7 ──────────────────────────────────────────────────────────────────────

describe("P7 venue unread — alerts, never a close", () => {
  it("alerts at 2 and 10 minutes, once each per spell; reading again ends the spell", () => {
    const { acts, memory } = passes(null, [NOW, NOW + 119, NOW + 120, NOW + 300, NOW + 600, NOW + 900]);
    assert.deepEqual(acts.map(kinds), [[], [], ["alert:perp-venue-unread"], [], ["alert:perp-venue-unread-recover"], []]);
    const recover = acts[4]![0]!;
    assert.ok(recover.kind === "alert" && recover.text.includes("merrymen recover"));
    const back = run(mkView([pos()]), NOW + 915, memory);
    assert.equal(back.memory.unreadSince, null);
    assert.equal(back.memory.unreadAlerted, false);
  });

  it("THE PAPER BOOK'S P7 never sends the owner to `merrymen recover`: there is no venue account behind practice positions", () => {
    let memory = emptyProtectMemory();
    const texts: string[] = [];
    for (const t of [NOW, NOW + 120, NOW + 600]) {
      const r = evaluateProtection({ view: null, nowSec: t, settings: SETTINGS, prior: memory, feedFresh: true, book: "paper" });
      for (const a of r.actions) if (a.kind === "alert") texts.push(a.text);
      memory = r.memory;
    }
    assert.equal(texts.length, 2, "the same two alerts on the same clock");
    for (const t of texts) {
      assert.doesNotMatch(t, /merrymen recover/, "never tells a paper owner to run recover");
      assert.doesNotMatch(t, /owner key/);
      assert.match(t, /practice/);
    }
    assert.match(texts[1]!, /nothing to recover/);
  });

  it("a view older than a minute is unread, whatever it says — even a liquidation-close position", () => {
    const deadly = pos({ liqPrice: MARK - 1_000n });
    assert.deepEqual(run(mkView([deadly], { readAtSec: NOW - 61 })).actions, []);
    assert.equal(closes(run(mkView([deadly], { readAtSec: NOW - 60 })).actions).length, 1);
  });

  it("an outage between two breached reads does not confirm the breach", () => {
    const past30 = pos({ markPrice: 786_100n });
    let mem = run(mkView([past30]), NOW).memory;
    mem = run(null, NOW + 10, mem).memory;
    assert.deepEqual(run(mkView([past30]), NOW + 20, mem).actions, []);
  });

  it("a stale FEED mark is never closed on; a mark from this pass's own account read is", () => {
    const deadly = (source: "feed" | "account") => pos({ liqPrice: MARK - 1_000n }, { markSource: source });
    assert.deepEqual(run(mkView([deadly("feed")]), NOW, emptyProtectMemory(), false).actions, []);
    assert.equal(closes(run(mkView([deadly("account")]), NOW, emptyProtectMemory(), false).actions).length, 1);
    assert.deepEqual(run(mkView([pos({ liqPrice: MARK - 1_000n }, { markFresh: false })])).actions, []);
  });

  it("prices unread for every held position alerts on the same clock", () => {
    const { acts } = passes(mkView([pos({}, { markFresh: false })]), [NOW, NOW + 120], true);
    assert.deepEqual(acts.map(kinds), [[], ["alert:perp-venue-unread"]]);
    const a = acts[1]![0]!;
    assert.ok(a.kind === "alert" && a.text.startsWith("Lighter's prices"));
  });
});

// ── order, one close per market, and when to leave a market alone ──────────

describe("priority order and the one close", () => {
  it("P1 outranks P2 and P4 — one close, the highest cause", () => {
    // 63 bp from liquidation, 30 bp past the stop, and 5 USDG of funding paid: all three fire.
    const all = pos({ markPrice: 786_100n, liqPrice: 786_100n - 5_000n, fundingMicro: -u(5) });
    assert.deepEqual(kinds(run(mkView([all]), NOW).actions), ["close:liq-proximity"]);
  });

  it("P2 outranks P4 once confirmed; before it, P4 closes", () => {
    const both = pos({ markPrice: 786_100n, fundingMicro: -u(5) });
    const { acts } = passes(mkView([both]), [NOW, NOW + 15]);
    assert.deepEqual(acts.map(kinds), [["close:funding-bleed"], []], "the second pass is inside the 30 s close spacing");
    const fresh = passes(mkView([both]), [NOW]).memory;
    const later = run(mkView([both]), NOW + 15, { ...fresh, markets: new Map([["BTC-PERP", { ...fresh.markets.get("BTC-PERP")!, lastCloseAt: null }]]) });
    assert.deepEqual(kinds(later.actions), ["close:stop-breached"]);
  });

  it("P1 closes before a missing stop is replaced", () => {
    const p = pos({ liqPrice: MARK - 1_000n, stop: null }, { stopState: "missing", restingStopOrder: null });
    assert.deepEqual(kinds(run(mkView([p])).actions), ["close:liq-proximity"]);
  });

  it("one close per market, one per market that needs it", () => {
    const btc = pos({ liqPrice: MARK - 1_000n });
    const eth = pos({ key: "ETH-PERP" as PerpKey, marketId: 0, markPrice: 260_000n, entryPrice: 260_000n, liqPrice: 259_900n }, { recordedStop: stopPrices({ side: "long", entryRefPrice: 260_000n, stopLossBps: 500, stopSlipBps: 200 }) });
    const r = run(mkView([btc, eth]));
    assert.deepEqual(
      closes(r.actions).map((c) => c.market),
      ["ETH-PERP", "BTC-PERP"],
      "ordered by market id",
    );
  });

  it("no second close on a market within 30 s of the last", () => {
    const deadly = pos({ liqPrice: MARK - 1_000n });
    const { acts } = passes(mkView([deadly]), [NOW, NOW + 15, NOW + 29, NOW + 30]);
    assert.deepEqual(acts.map((a) => closes(a).length), [1, 0, 0, 1]);
  });

  it("an open still landing (unresolved, or under 60 s old) is left to its own stop", () => {
    const deadly = { liqPrice: MARK - 1_000n, stop: null } as const;
    assert.deepEqual(run(mkView([pos(deadly, { openingUnresolved: true, stopState: "missing" })])).actions, []);
    assert.deepEqual(run(mkView([pos({ ...deadly, openedAtSec: NOW - 30 }, { stopState: "missing" })])).actions, []);
    assert.equal(closes(run(mkView([pos({ ...deadly, openedAtSec: NOW - 60 }, { stopState: "missing" })])).actions).length, 1);
    // An undated open is old, and a stamp far in the future is a bad stamp, not a young position.
    assert.equal(closes(run(mkView([pos({ ...deadly, openedAtSec: 0 }, { openedAtKnown: false })])).actions).length, 1);
    assert.equal(closes(run(mkView([pos({ ...deadly, openedAtSec: NOW + 3_600 })])).actions).length, 1);
  });

  it("memory of a market that no longer holds a position is dropped", () => {
    const mem = run(mkView([pos({ stop: null }, { stopState: "missing" })]), NOW).memory;
    assert.ok(mem.markets.has("BTC-PERP"));
    assert.equal(run(mkView([]), NOW + 15, mem).memory.markets.size, 0);
  });

  it("evaluation is pure: the prior memory is never mutated", () => {
    const first = run(mkView([pos({ markPrice: 786_100n })]), NOW);
    const snapshot = JSON.stringify([...first.memory.markets]);
    run(mkView([pos({ markPrice: 786_100n })]), NOW + 15, first.memory);
    assert.equal(JSON.stringify([...first.memory.markets]), snapshot);
  });
});

describe("close pricing and cadence", () => {
  it("2 × the owner's slippage, floored at the stand-down's 150 bp, capped at 450 bp", () => {
    assert.equal(protectCloseSlipBps(50), 150);
    assert.equal(protectCloseSlipBps(100), 200);
    assert.equal(protectCloseSlipBps(300), 450);
    assert.equal(protectCloseSlipBps(Number.NaN), 150);
  });
  it("15 s with anything held or unknown, 60 s with nothing", () => {
    assert.equal(protectCadenceMs(null), 15_000);
    assert.equal(protectCadenceMs(mkView([])), 60_000);
    assert.equal(protectCadenceMs(mkView([pos()])), 15_000);
  });
});

// ── the lock ────────────────────────────────────────────────────────────────

describe("createPerpLaneLock", () => {
  it("serializes a protective send behind a lane send in flight; nonces stay ordered", async () => {
    const lock = createPerpLaneLock();
    let nonce = 0;
    const log: string[] = [];
    const lane = lock.run(async () => {
      const n = ++nonce;
      log.push(`lane:sign:${n}`);
      await sleep(20);
      log.push(`lane:sent:${n}`);
    });
    assert.equal(lock.busy, false, "acquisition is asynchronous");
    const protect = lock.run(async () => {
      const n = ++nonce;
      log.push(`protect:sign:${n}`);
      log.push(`protect:sent:${n}`);
      return n;
    });
    await sleep(5);
    assert.equal(lock.busy, true);
    assert.equal(lock.waiting, 1);
    assert.equal(await protect, 2);
    await lane;
    assert.deepEqual(log, ["lane:sign:1", "lane:sent:1", "protect:sign:2", "protect:sent:2"]);
    assert.equal(lock.busy, false);
  });

  it("a throwing holder releases the lock", async () => {
    const lock = createPerpLaneLock();
    await assert.rejects(lock.run(async () => {
      throw new Error("sendTx failed");
    }));
    assert.equal(await lock.run(async () => "next"), "next");
  });

  it("a holder past its bound loses the lock; the next waiter proceeds", async () => {
    const overruns: unknown[] = [];
    const lock = createPerpLaneLock({ holdMs: 15, onOverrun: (i) => overruns.push(i) });
    const started = Date.now();
    const hung = lock.run(() => sleep(80).then(() => "late"), { label: "lane" });
    const next = await lock.run(async () => Date.now() - started);
    assert.ok(next < 70, `waited ${next} ms`);
    assert.deepEqual(overruns, [{ label: "lane", holdMs: 15 }]);
    assert.equal(await hung, "late", "the overrunning send still completes on its own");
  });

  it("an aborted waiter never runs, and the queue moves on", async () => {
    const lock = createPerpLaneLock();
    const ac = new AbortController();
    let ran = false;
    const holder = lock.run(() => sleep(20));
    const aborted = lock.run(async () => {
      ran = true;
    }, { signal: ac.signal });
    const after = lock.run(async () => "after");
    ac.abort();
    await assert.rejects(aborted);
    assert.equal(await after, "after");
    await holder;
    assert.equal(ran, false);
    const pre = new AbortController();
    pre.abort();
    await assert.rejects(lock.run(async () => 1, { signal: pre.signal }));
  });
});

// ── the loop ────────────────────────────────────────────────────────────────

describe("startProtectLoop", () => {
  it("never overlaps itself, even when a pass is slower than its interval", async () => {
    let live = 0;
    let most = 0;
    const loop = startProtectLoop({
      intervalMs: () => 1,
      minIntervalMs: 0,
      lock: createPerpLaneLock(),
      run: async () => {
        live += 1;
        most = Math.max(most, live);
        await sleep(15);
        live -= 1;
      },
    });
    await sleep(100);
    await loop.stop();
    assert.equal(most, 1);
    assert.ok(loop.passes >= 3, `${loop.passes} passes`);
  });

  it("survives a throwing pass and a throwing interval; errors reach the reporter", async () => {
    const errors: unknown[] = [];
    let n = 0;
    const loop = startProtectLoop({
      intervalMs: () => {
        if (n >= 2) throw new Error("interval broke");
        return 1;
      },
      minIntervalMs: 0,
      lock: createPerpLaneLock(),
      onError: (e) => errors.push(e),
      run: async () => {
        n += 1;
        if (n === 1) throw new Error("pass 1 broke");
      },
    });
    await sleep(40);
    // Pass 1 threw, pass 2 ran; then the interval threw and the loop fell back to the fast cadence (15 s).
    assert.equal(n, 2);
    assert.deepEqual(
      errors.map((e) => (e as Error).message),
      ["pass 1 broke", "interval broke"],
    );
    loop.kick();
    await sleep(20);
    assert.equal(n, 3, "still alive: a kick runs a pass (and the broken interval parks it on the fast cadence again)");
    await loop.stop();
  });

  it("abandons a hung pass after its bound: its signal aborts, so it cannot take the lock, and the loop moves on", async () => {
    const lock = createPerpLaneLock();
    const signals: AbortSignal[] = [];
    const errors: unknown[] = [];
    let n = 0;
    const loop = startProtectLoop({
      intervalMs: () => 1,
      minIntervalMs: 0,
      abandonAfterMs: 20,
      lock,
      onError: (e) => errors.push(e),
      run: async ({ signal }) => {
        n += 1;
        signals.push(signal);
        if (n === 1) await new Promise<never>(() => {}); // hangs forever
      },
    });
    await sleep(60);
    await loop.stop();
    assert.ok(n >= 2, "the loop moved on");
    assert.equal(signals[0]!.aborted, true);
    await assert.rejects(lock.run(async () => "send", { signal: signals[0]! }));
    assert.ok(errors.some((e) => String((e as Error).message).includes("abandoned")));
  });

  it("serializes its sends with a lane send through the shared lock", async () => {
    const lock = createPerpLaneLock();
    const log: string[] = [];
    let laneHolding!: () => void;
    const laneStarted = new Promise<void>((r) => {
      laneHolding = r;
    });
    const lane = lock.run(async () => {
      log.push("lane:start");
      laneHolding();
      await sleep(30);
      log.push("lane:end");
    });
    await laneStarted;
    let done!: () => void;
    const protectDone = new Promise<void>((r) => {
      done = r;
    });
    const loop = startProtectLoop({
      intervalMs: () => 60_000,
      lock,
      run: async (ctx) => {
        await ctx.lock.run(async () => log.push("protect:send"), { signal: ctx.signal });
        done();
      },
    });
    await protectDone;
    await lane;
    await loop.stop();
    assert.deepEqual(log, ["lane:start", "lane:end", "protect:send"]);
  });

  it("stop() ends it: no pass starts after", async () => {
    let n = 0;
    const loop = startProtectLoop({
      intervalMs: () => 1,
      minIntervalMs: 0,
      lock: createPerpLaneLock(),
      run: async () => {
        n += 1;
      },
    });
    await sleep(15);
    await loop.stop();
    const at = n;
    await sleep(20);
    assert.equal(n, at);
    loop.kick();
    await sleep(10);
    assert.equal(n, at, "a kick after stop does nothing");
  });
});
