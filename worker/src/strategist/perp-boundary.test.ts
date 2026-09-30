/**
 * THE STRATEGIST'S PERP BOUNDARY (docs/perps.md rule 15; the review's
 * strategist-perp-boundary).
 *
 *   1. A window that does not offer perps is BYTE-IDENTICAL to before perps
 *      existed — tool schema, system prompt and Signals — for both tools. The
 *      hashes below were taken from the pre-perps driver.ts and desk.ts.
 *   2. A window that does offers an OPTIONAL perpActions array: never in the
 *      top-level required, no leverage anywhere, a market enum of this
 *      window's keys, and a paragraph that says the things the owner
 *      consented to.
 *   3. proposalsToPerpIntents REFUSES opens (never repairs) and CLAMPS exits.
 *   4. The strategy counts perp opens as entries, never withholds a perp exit,
 *      asks an agent holding only a perp, and journals under perp:strategist.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { PerpKey } from "../../../packages/core/src/perps";
import { NOW_SEC, breakout, marketView, policyVerdict, position, settings, u, view } from "../perps/testkit-perps";
import type { PerpRouteIntent } from "../perps/route";
import type { PerpsView, Snapshot } from "../strategies/types";
import { deskRequest, runDesk, type DeskWorld } from "./desk";
import { nullDriver, proposeRequest, type ProposalDriver, type Signals } from "./driver";
import {
  PERP_STOP_FLOOR_PCT,
  parsePerpProposals,
  proposalsToIntents,
  proposalsToPerpIntents,
  type PerpBoundaryCaps,
  type PerpProposal,
  type StrategistUniverse,
} from "./proposals";
import { makeLlmStrategist, mentionsPerps, type StrategistDecision } from "./strategy";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** sha256 of JSON.stringify({ system, tool }) from the pre-perps driver.ts (git HEAD 738891bf). */
const DRIVER_BASELINE = "1855b6ed9ecdbeee5224f527c999863d0a1f93bb614f0830100d49db83a21063";
/** sha256 of JSON.stringify({ system, tools: researchTools(world, [], []) }) from the pre-perps desk.ts. */
const DESK_BASELINE = "3835404f827a46f12e532d206e8f35da7a2011c2b28d7ae91ce69801516bd1bb";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const AAPL = "0x4444444444444444444444444444444444444444" as const;

function universe(over: Partial<StrategistUniverse> = {}): StrategistUniverse {
  return { legs: new Map([["AAPL", AAPL]]), swapRouter: ROUTER, usdg: USDG, maxPerActionUsdg: u(50), maxActionsPerTick: 4, ...over };
}
function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    cashUsdg: u(100),
    vaultUsdg: 0n,
    holdings: new Map(),
    prices: new Map(),
    pausedTokens: new Set(),
    staleFeeds: new Set(),
    sequencerUp: true,
    spendHeadroomUsdg: u(1_000),
    perTradeCapUsdg: u(100),
    ...over,
  };
}
const baseSignals = (): Signals => ({
  cashUsdg: 100,
  vaultUsdg: 0,
  equityUsdg: 100,
  holdings: [],
  prices: [],
  tradableSymbols: ["AAPL"],
  maxPerActionUsdg: 50,
  utcHour: 1,
  utcDay: 2,
});
const perpSignals = (): NonNullable<Signals["perps"]> => ({
  collateralUsdg: 0,
  freeCollateralUsdg: 0,
  openNotionalLeftUsdg: 50,
  maxPerOpenUsdg: 25,
  minStopPct: 1,
  maxStopPct: 5,
  opensLeftToday: 4,
  markets: [{ key: "BTC-PERP", mark: 80_500, index: 80_500, fundingPctPerHour: 0.001, status: "active", leverage: 2, minOrderUsdg: 16.1 }],
  positions: [],
});
const world: DeskWorld = { lookUp: async () => "", recall: async () => "" };

// ── 1 & 2: the tools ────────────────────────────────────────────────────────

describe("propose_trades: byte-identical without perps; an optional perpActions with them", () => {
  it("without perps the request is exactly the pre-perps one", () => {
    const r = proposeRequest(baseSignals());
    assert.equal(sha(JSON.stringify(r)), DRIVER_BASELINE);
    assert.ok(!JSON.stringify(r).toLowerCase().includes("perp"));
  });

  it("a perps block that names no market is no perps at all", () => {
    const s = { ...baseSignals(), perps: { ...perpSignals(), markets: [] } };
    assert.equal(sha(JSON.stringify(proposeRequest(s))), DRIVER_BASELINE);
  });

  it("with perps: perpActions is a property, never required; the items have no leverage; the market enum is this window's keys", () => {
    const s = { ...baseSignals(), perps: { ...perpSignals(), positions: [{ key: "ETH-PERP", side: "short" as const, notionalUsdg: 20, entry: 2681, mark: 2690, unrealizedPnlUsdg: -0.07, liqPrice: 3900, liqDistancePct: 45, stopPrice: 2760, fundingUsdg: 0, heldHours: 3 }] } };
    const r = proposeRequest(s);
    const schema = r.tool.schema as { required: string[]; properties: Record<string, { items: { properties: Record<string, { enum?: string[] }>; required: string[]; additionalProperties: boolean } }> };
    assert.deepEqual(schema.required, ["actions"]);
    const items = schema.properties.perpActions!.items;
    assert.deepEqual(items.properties.market!.enum, ["BTC-PERP", "ETH-PERP"]);
    assert.deepEqual(items.properties.effect!.enum, ["open", "reduce", "close"]);
    assert.deepEqual(items.properties.side!.enum, ["long", "short"]);
    assert.deepEqual(items.required, ["market", "effect", "side", "notionalUsdg"]);
    assert.equal(items.additionalProperties, false);
    assert.deepEqual(Object.keys(items.properties).sort(), ["effect", "market", "notionalUsdg", "reason", "side", "stopPct"]);
    assert.ok(!/"leverage"/.test(JSON.stringify(schema.properties.perpActions)), "no leverage field anywhere");
    // The spot half is untouched.
    const baseline = proposeRequest(baseSignals()).tool.schema as { properties: Record<string, unknown> };
    assert.deepEqual(schema.properties.actions, baseline.properties.actions);
  });

  it("with perps the system prompt says the things the owner consented to", () => {
    const sys = proposeRequest({ ...baseSignals(), perps: perpSignals() }).system;
    assert.ok(sys.startsWith(proposeRequest(baseSignals()).system), "today's prompt, then the paragraph");
    for (const re of [/COLLATERAL/, /LEVERAGE IS SET BY THE OWNER, NOT BY YOU/, /LIQUIDATED/, /FUNDING IS PAID OR RECEIVED EVERY HOUR/, /EVERY OPEN MUST CARRY A STOP/, /SHORTS EXIST ONLY AS PERPS/, /Never\s+spell a short "sell"/, /Never add to or flip a position/, /not the tokens of the same name/, /PERPS ARE NEVER PUBLISHED/]) {
      assert.match(sys, re);
    }
  });
});

describe("submit_view: the same, for the desk", () => {
  it("without perps the desk's system and tools are exactly the pre-perps ones", () => {
    assert.equal(sha(JSON.stringify(deskRequest(baseSignals(), world, [], []))), DESK_BASELINE);
  });

  it("with perps: perpActions optional on submit_view, the paragraph appended", () => {
    const r = deskRequest({ ...baseSignals(), perps: perpSignals() }, world, [], []);
    const submit = r.tools.find((t) => t.name === "submit_view")!;
    const schema = submit.schema as { required: string[]; properties: Record<string, unknown> };
    assert.deepEqual(schema.required, ["actions", "thesis"]);
    assert.ok(schema.properties.perpActions);
    assert.match(r.system, /SHORTS EXIST ONLY AS PERPS/);
  });

  it("the desk returns perpActions only when the window offered them", async () => {
    const submit = { actions: [], thesis: "flat", perpActions: [{ market: "BTC-PERP", effect: "open", side: "short", notionalUsdg: 20, stopPct: 3 }] };
    const turn = async () => ({ text: "", toolUses: [{ id: "1", name: "submit_view", input: submit }] });
    const offered = await runDesk({ creds: {} as never, signals: { ...baseSignals(), perps: perpSignals() }, world, turn: turn as never });
    assert.equal(offered.perpActions.length, 1);
    assert.equal(offered.perpActions[0]!.side, "short");
    const notOffered = await runDesk({ creds: {} as never, signals: baseSignals(), world, turn: turn as never });
    assert.deepEqual(notOffered.perpActions, []);
  });
});

// ── 3: the boundary ─────────────────────────────────────────────────────────

const S = () => settings({ perpsDriver: "strategist" });
const CAPS: PerpBoundaryCaps = { perTradeSealedMicro: u(100), maxPerActionMicro: u(50), spendHeadroomMicro: u(1_000) };
const open = (over: Partial<PerpProposal> = {}): PerpProposal => ({ market: "BTC-PERP", effect: "open", side: "long", notionalUsdg: 20, stopPct: 3, reason: "r", ...over });
const holdingBtc = (side: "long" | "short" = "long", base?: bigint): PerpsView =>
  view({ positions: new Map([["BTC-PERP", position("BTC-PERP", side, base === undefined ? {} : { baseAmount: base })]]) });

describe("proposalsToPerpIntents: opens are refused, never repaired", () => {
  it("a valid open becomes an intent the wall accepts; no leverage chosen, the stop from the proposal", () => {
    const v = view();
    const r = proposalsToPerpIntents([open()], v, S(), CAPS);
    assert.equal(r.dropped.length, 0, JSON.stringify(r.dropped));
    const i = r.intents[0]!;
    assert.equal(i.effect, "open");
    assert.equal(i.imfBp, v.markets.get("BTC-PERP")!.imfBp);
    assert.ok(i.notionalUsdg <= u(20));
    assert.deepEqual(policyVerdict(i, v), { ok: true });
    assert.equal(r.accepted[0]!.reason, "r");
    // A short, too.
    const sh = proposalsToPerpIntents([open({ side: "short" })], v, S(), CAPS);
    assert.deepEqual(policyVerdict(sh.intents[0]!, v), { ok: true });
  });

  it("the owner's take-profit rides a strategist open, and the wall accepts it", () => {
    const v = view();
    const r = proposalsToPerpIntents([open()], v, settings({ perpsDriver: "strategist", perpsTakeProfitPct: 6 }), CAPS);
    const i = r.intents[0]! as Extract<PerpRouteIntent, { effect: "open" }>;
    assert.ok(i.takeTrigger !== undefined && i.takeTrigger > i.markPrice);
    assert.deepEqual(policyVerdict(i, v), { ok: true });
  });

  const cases: Array<[string, () => { p: PerpProposal; v?: PerpsView | null; s?: ReturnType<typeof settings>; c?: PerpBoundaryCaps }, string]> = [
    ["a market the owner did not allow", () => ({ p: open({ market: "SOL-PERP" }) }), "perp-market-not-allowed"],
    ["not a market at all", () => ({ p: open({ market: "FOO-PERP" as PerpKey }) }), "perp-market-not-allowed"],
    ["no stop", () => ({ p: open({ stopPct: undefined }) }), "perp-stop-required"],
    ["a stop tighter than the floor", () => ({ p: open({ stopPct: PERP_STOP_FLOOR_PCT - 0.5 }) }), "perp-stop-out-of-range"],
    ["a stop wider than perpsStopLossPct", () => ({ p: open({ stopPct: 6 }) }), "perp-stop-out-of-range"],
    ["zero size", () => ({ p: open({ notionalUsdg: 0 }) }), "non-positive"],
    ["NaN size", () => ({ p: open({ notionalUsdg: Number.NaN }) }), "non-positive"],
    ["over perpsPerTradeUsdg", () => ({ p: open({ notionalUsdg: 30 }) }), "perp-per-trade-cap"],
    ["over the strategist ceiling", () => ({ p: open({ notionalUsdg: 22 }), c: { ...CAPS, maxPerActionMicro: u(20) } }), "perp-per-trade-cap"],
    ["over the sealed per-trade cap", () => ({ p: open({ notionalUsdg: 22 }), c: { ...CAPS, perTradeSealedMicro: u(20) } }), "perp-per-trade-cap"],
    [
      "over the open size left",
      () => ({ p: open({ notionalUsdg: 22 }), v: view({ headroom: { perTradeNotionalMicro: u(25), openNotionalLeftMicro: u(20), collateralLeftMicro: u(30), opensLeftToday: 4 } }) }),
      "perp-open-notional-cap",
    ],
    ["over today's spend", () => ({ p: open(), c: { ...CAPS, spendHeadroomMicro: u(10) } }), "daily-cap"],
    ["under the venue minimum", () => ({ p: open({ notionalUsdg: 5 }) }), "perp-below-min"],
    [
      "more margin than can be committed",
      () => ({ p: open(), v: view({ headroom: { perTradeNotionalMicro: u(25), openNotionalLeftMicro: u(50), collateralLeftMicro: u(5), opensLeftToday: 4 } }) }),
      "perp-collateral-cap",
    ],
    ["a position already there (no adds)", () => ({ p: open(), v: holdingBtc() }), "perp-add-to-position"],
    ["a position on the other side (no flips)", () => ({ p: open({ side: "short" }), v: holdingBtc("long") }), "perp-add-to-position"],
    ["an unresolved order there", () => ({ p: open(), v: view({ unresolved: new Set(["BTC-PERP" as const]) }) }), "perp-order-unresolved"],
    ["the market reduce-only", () => ({ p: open(), v: view({ markets: new Map([["BTC-PERP", marketView("BTC-PERP", { status: "reduce-only" })]]) }) }), "perp-market-inactive"],
    ["the market unread", () => ({ p: open(), v: view({ markets: new Map() }) }), "perp-unpriced"],
    ["perps off", () => ({ p: open(), s: settings({ perpsDriver: "strategist", perpsEnabled: false }) }), "perp-not-enabled"],
    ["opens blocked", () => ({ p: open(), v: view({ opensBlocked: "perps-entries-halted" }) }), "perp-opens-blocked"],
    [
      "a stop that cannot beat liquidation at 10x",
      () => ({
        p: open({ stopPct: 5 }),
        v: view({ markets: new Map([["BTC-PERP", marketView("BTC-PERP", {}, 10)]]) }),
        s: settings({ perpsDriver: "strategist", perpsLiqBufferPct: 5 }),
      }),
      "perp-stop-inside-liquidation",
    ],
    ["the strategist is not the driver", () => ({ p: open(), s: settings({ perpsDriver: "perp-trend" }) }), "perp-not-driver"],
    ["Lighter unread", () => ({ p: open(), v: null }), "perp-unpriced"],
  ];
  for (const [what, make, rule] of cases) {
    it(what, () => {
      const { p, v, s, c } = make();
      const r = proposalsToPerpIntents([p], v === undefined ? view() : v, s ?? S(), c ?? CAPS);
      assert.equal(r.intents.length, 0, `${what}: never repaired into an intent`);
      assert.equal(r.dropped[0]?.why, rule, `${what}: ${JSON.stringify(r.dropped[0])}`);
    });
  }

  it("one action per market; opens limited by the window's slots", () => {
    const r = proposalsToPerpIntents([open(), open({ notionalUsdg: 21 })], view(), S(), CAPS);
    assert.equal(r.intents.length, 1);
    assert.equal(r.dropped[0]!.why, "perp-duplicate");
    const slots = proposalsToPerpIntents([open(), open({ market: "ETH-PERP" })], view(), S(), { ...CAPS, maxOpens: 1 });
    assert.equal(slots.intents.length, 1);
    assert.equal(slots.dropped[0]!.why, "max-actions");
  });
});

describe("proposalsToPerpIntents: exits are clamped, never refused for size", () => {
  it("a close is the whole venue-read position, reduce-only, on the side held — and the wall accepts it", () => {
    const v = holdingBtc("long", 70n);
    const r = proposalsToPerpIntents([{ market: "BTC-PERP", effect: "close", side: "long", notionalUsdg: 0, reason: "" }], v, S(), CAPS);
    const x = r.intents[0]!;
    assert.equal(x.effect, "close");
    assert.equal(x.reduceOnly, true);
    assert.equal(x.baseAmount, 70n);
    assert.equal(x.side, "long");
    assert.deepEqual(policyVerdict(x, v), { ok: true });
  });

  it("a reduce bigger than the position is cut to it — and becomes a close", () => {
    const r = proposalsToPerpIntents([{ market: "BTC-PERP", effect: "reduce", side: "long", notionalUsdg: 10_000, reason: "" }], holdingBtc("long", 70n), S(), CAPS);
    assert.equal(r.intents[0]!.effect, "close");
    assert.equal(r.intents[0]!.baseAmount, 70n);
  });

  it("a reduce under the venue minimum is raised to it; one that would leave dust becomes a close", () => {
    // BTC: min 0.00020 (20 units) at ~80,500 (≈16.1 USDG). Holding 100 units ≈ 80.5 USDG.
    const small = proposalsToPerpIntents([{ market: "BTC-PERP", effect: "reduce", side: "long", notionalUsdg: 1, reason: "" }], holdingBtc("long", 100n), S(), CAPS);
    assert.equal(small.intents[0]!.effect, "reduce");
    assert.ok(small.intents[0]!.baseAmount >= 20n && small.intents[0]!.baseAmount < 100n);
    const dust = proposalsToPerpIntents([{ market: "BTC-PERP", effect: "reduce", side: "long", notionalUsdg: 70, reason: "" }], holdingBtc("long", 100n), S(), CAPS);
    assert.equal(dust.intents[0]!.effect, "close", "the remainder would be under the minimum");
    assert.equal(dust.intents[0]!.baseAmount, 100n);
    const zero = proposalsToPerpIntents([{ market: "BTC-PERP", effect: "reduce", side: "long", notionalUsdg: 0, reason: "" }], holdingBtc("long", 100n), S(), CAPS);
    assert.equal(zero.intents.length, 1, "a zero reduce is clamped up, not refused");
  });

  it("the wrong side is refused — never reinterpreted — and nothing held is nothing to exit", () => {
    const wrong = proposalsToPerpIntents([{ market: "BTC-PERP", effect: "close", side: "short", notionalUsdg: 0, reason: "" }], holdingBtc("long"), S(), CAPS);
    assert.equal(wrong.dropped[0]!.why, "perp-side-mismatch");
    const none = proposalsToPerpIntents([{ market: "BTC-PERP", effect: "close", side: "long", notionalUsdg: 0, reason: "" }], view(), S(), CAPS);
    assert.equal(none.dropped[0]!.why, "perp-no-position");
  });

  it("an exit needs no allowed market, no perps switch and no cap", () => {
    const r = proposalsToPerpIntents(
      [{ market: "BTC-PERP", effect: "close", side: "long", notionalUsdg: 0, reason: "" }],
      holdingBtc("long"),
      settings({ perpsDriver: "strategist", perpsEnabled: false, perpsMarkets: ["ETH-PERP"] }),
      { perTradeSealedMicro: 0n, maxPerActionMicro: 0n, spendHeadroomMicro: 0n, maxOpens: 0 },
    );
    assert.equal(r.intents.length, 1);
  });
});

describe("parsePerpProposals and the spot backstop", () => {
  it("absent is not malformed; junk is dropped, never repaired; a leverage field never survives", () => {
    assert.deepEqual(parsePerpProposals({ actions: [] }), { actions: [], malformed: 0 });
    assert.deepEqual(parsePerpProposals({ perpActions: "open BTC" }), { actions: [], malformed: 1 });
    const r = parsePerpProposals({
      perpActions: [
        { market: "BTC-PERP", effect: "open", side: "long", notionalUsdg: 20, stopPct: 3, leverage: 50, reason: "x".repeat(500) },
        { market: "BTC", effect: "open", side: "long", notionalUsdg: 20 },
        { market: "BTC-PERP", effect: "sell", side: "short", notionalUsdg: 20 },
        { market: "BTC-PERP", effect: "open", side: "long", notionalUsdg: "20" },
        { market: "BTC-PERP", effect: "open", side: "long", notionalUsdg: 20, stopPct: "3" },
      ],
    });
    assert.equal(r.malformed, 4);
    assert.equal(r.actions.length, 1);
    assert.ok(!("leverage" in r.actions[0]!));
    assert.equal(r.actions[0]!.reason.length, 300);
  });

  it("proposalsToIntents refuses a perp key spelled as a spot buy or sell", () => {
    const r = proposalsToIntents([{ action: "sell", symbol: "BTC-PERP", sizeUsdg: 5, reason: "" }, { action: "buy", symbol: "tsla-perp", sizeUsdg: 5, reason: "" }], universe(), snap());
    assert.equal(r.intents.length, 0);
    assert.equal(r.rejected.length, 2);
    assert.match(r.rejected[0]!, /not a spot symbol/);
  });
});

// ── 4: the strategy ─────────────────────────────────────────────────────────

function strategist(answer: unknown, opts: { perps?: boolean; driverName?: string; perpsSettings?: ReturnType<typeof settings>; null?: boolean } = {}) {
  const seen: Signals[] = [];
  const decisions: StrategistDecision[] = [];
  const delivered: PerpRouteIntent[][] = [];
  const notes: string[] = [];
  const driver: ProposalDriver = opts.null
    ? nullDriver
    : {
        name: opts.driverName ?? "fake",
        propose: async (s: Signals) => {
          seen.push(s);
          return answer;
        },
      };
  const s = makeLlmStrategist({
    driver,
    universe: universe(),
    decisionIntervalMs: 0,
    now: () => NOW_SEC * 1000,
    onDecision: (d) => {
      decisions.push(d);
    },
    onNote: (_l, m) => notes.push(m),
    ...(opts.perps === false ? {} : { perps: { settings: () => opts.perpsSettings ?? S(), deliver: (i: PerpRouteIntent[]) => delivered.push(i) } }),
  });
  return { s, seen, decisions, delivered, notes };
}

describe("the strategy: perps offered only when they should be; spot byte-identical otherwise", () => {
  const PERPS_ANSWER = { actions: [], perpActions: [{ market: "ETH-PERP", effect: "open", side: "long", notionalUsdg: 20, stopPct: 3, reason: "eth broke out" }] };

  it("Signals are identical, and carry no perps, whenever perps are not offered", async () => {
    const snapWith = snap({ perps: view() });
    const runs = [
      strategist({ actions: [] }, { perps: false }),
      strategist({ actions: [] }, { perpsSettings: settings({ perpsDriver: "strategist", perpsEnabled: false }) }),
      strategist({ actions: [] }, { perpsSettings: settings({ perpsDriver: "perp-trend" }) }),
      strategist({ actions: [] }, { perpsSettings: settings({ perpsDriver: "manual" }) }),
    ];
    const jsons: string[] = [];
    for (const r of runs) {
      await r.s.tick(snapWith);
      jsons.push(JSON.stringify(r.seen[0], null, 2));
      assert.equal(r.delivered.length, 0);
    }
    const unread = strategist({ actions: [] });
    await unread.s.tick(snap({ perps: null }));
    jsons.push(JSON.stringify(unread.seen[0], null, 2));
    const off = strategist({ actions: [] });
    await off.s.tick(snap());
    jsons.push(JSON.stringify(off.seen[0], null, 2));
    for (const j of jsons) {
      assert.equal(j, jsons[0]);
      assert.ok(!j.includes("perp"), j);
    }
    // And the request built from them is the pre-perps one.
    assert.equal(sha(JSON.stringify(proposeRequest(runs[0]!.seen[0]!))), DRIVER_BASELINE);
  });

  it("offered: the model sees the perp book; a surviving open is journaled under perp:strategist and handed to the route", async () => {
    const r = strategist(PERPS_ANSWER);
    const tick = await r.s.tick(snap({ perps: view() }));
    const signals = r.seen[0]!;
    assert.ok(signals.perps);
    assert.deepEqual(
      signals.perps.markets.map((m) => m.key),
      ["BTC-PERP", "ETH-PERP"],
    );
    assert.ok(!JSON.stringify(signals.perps).includes("marketId"), "no market ids");
    assert.equal(r.delivered.length, 1);
    const [intent] = r.delivered[0]!;
    assert.equal(intent!.market, "ETH-PERP");
    const row = r.decisions.find((d) => d.id === intent!.decisionId)!;
    assert.equal(row.source, "perp:strategist");
    assert.equal(row.action, "open-long");
    assert.equal(row.symbol, "ETH-PERP");
    assert.equal(row.reason, "eth broke out");
    // Nothing perp comes back as this strategy's own intents; no model-held idle about it.
    const t = tick as { intents?: unknown[]; idle?: unknown };
    assert.equal(Array.isArray(tick) ? tick.length : t.intents?.length, 0);
    assert.equal(Array.isArray(tick) ? undefined : t.idle, undefined);
  });

  it("perpActions from a window that did not offer them are ignored", async () => {
    const r = strategist(PERPS_ANSWER, { perpsSettings: settings({ perpsDriver: "perp-trend" }) });
    await r.s.tick(snap({ perps: view() }));
    assert.equal(r.delivered.length, 0);
    assert.ok(!r.decisions.some((d) => d.source === "perp:strategist"));
  });

  it("the null driver is never offered perps", async () => {
    const r = strategist(PERPS_ANSWER, { null: true });
    await r.s.tick(snap({ perps: view() }));
    assert.equal(r.delivered.length, 0);
  });
});

describe("the strategy: perp opens are entries, perp exits never wait", () => {
  const holdingOnlyPerp = () =>
    snap({ perps: holdingBtc("long", 70n), drawdown: { bps: 2_000, limitBps: 1_500 } });
  const both = {
    actions: [],
    perpActions: [
      { market: "BTC-PERP", effect: "close", side: "long", notionalUsdg: 0, reason: "cut it" },
      { market: "ETH-PERP", effect: "open", side: "short", notionalUsdg: 20, stopPct: 3, reason: "fade" },
    ],
  };

  it("under the breaker, an agent holding ONLY a perp is still asked; its close goes, its open is withheld", async () => {
    const r = strategist(both);
    await r.s.tick(holdingOnlyPerp());
    assert.equal(r.seen.length, 1, "asked");
    assert.deepEqual(
      r.delivered[0]!.map((i) => `${i.effect}-${i.side} ${i.market}`),
      ["close-long BTC-PERP"],
    );
    assert.ok(r.notes.some((n) => /1 new position\(s\) withheld — the drawdown breaker/.test(n)), r.notes.join("\n"));
    assert.ok(!r.decisions.some((d) => d.symbol === "ETH-PERP"), "a withheld open is never journaled");
  });

  it("flat on BOTH books under the breaker, the model is not asked (or billed)", async () => {
    const r = strategist(both);
    await r.s.tick(snap({ perps: view(), drawdown: { bps: 2_000, limitBps: 1_500 } }));
    assert.equal(r.seen.length, 0);
  });

  it("energy spent, holding only a perp: asked; the close goes, the open waits", async () => {
    const r = strategist(both);
    await r.s.tick(snap({ perps: holdingBtc("long", 70n), energy: { entriesLeft: 0 } }));
    assert.equal(r.seen.length, 1);
    assert.equal(r.delivered[0]!.length, 1);
    assert.equal(r.delivered[0]![0]!.effect, "close");
  });

  it("one entry left: the model's spot buy takes it, the perp open is withheld — a short is an entry too", async () => {
    const answer = {
      actions: [{ action: "buy", symbol: "AAPL", sizeUsdg: 10, reason: "value" }],
      perpActions: [{ market: "ETH-PERP", effect: "open", side: "short", notionalUsdg: 20, stopPct: 3, reason: "fade" }],
    };
    const r = strategist(answer);
    const tick = await r.s.tick(snap({ perps: view(), energy: { entriesLeft: 1 } }));
    const intents = Array.isArray(tick) ? tick : tick.intents;
    assert.equal(intents.length, 1, "the spot buy");
    assert.deepEqual(r.delivered[0], []);
    const two = strategist(answer);
    await two.s.tick(snap({ perps: view(), energy: { entriesLeft: 2 } }));
    assert.equal(two.delivered[0]!.length, 1, "with two left, both");
  });

  it("a thesis or spot reason that talks about perps stays private", async () => {
    assert.ok(mentionsPerps("closing my BTC-PERP long"));
    assert.ok(mentionsPerps("leverage is too high"));
    assert.ok(!mentionsPerps("AAPL looks cheap against its range"));
    const r = strategist({ actions: [{ action: "buy", symbol: "AAPL", sizeUsdg: 10, reason: "hedging my short perp" }], perpActions: [] });
    await r.s.tick(snap({ perps: view() }));
    const spot = r.decisions.find((d) => d.symbol === "AAPL")!;
    assert.equal(spot.source, "strategist");
    assert.equal(spot.reason, "");
  });
});

it("fixture sanity: the default view breaks out and is read", () => {
  assert.equal(breakout("BTC-PERP", 0n).length, 120);
  assert.equal(view().markets.size, 2);
});
