/**
 * THE PERP BRANCH OF checkPolicy — for perp orders this IS the wall.
 *
 * docs/perps.md rule 4: the session-key wall bounds what reaches Lighter per
 * deposit and nothing after; order size, leverage, market and rate are enforced
 * by checkPolicy alone. So every rule here is tested ALONE — one valid open,
 * one thing broken, one exact rule back — because a rule that only ever fires
 * behind another is a rule nobody has seen work. And the other half of the
 * contract, rule 8, is tested as hard: no cap, brake, halt, mode or expiry ever
 * refuses a reduce-only exit or money coming home.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LIGHTER_ROUTE_V1,
  baseForNotional,
  effectiveMinNotionalMicro,
  leverageTarget,
  notionalMicro,
  stopPrices,
  takePrices,
  worstPriceForTaker,
  type PerpMarketSpec,
} from "../../packages/core/src/perps";
import { countsAsEntry } from "./energy";
import {
  checkPolicy,
  isExitIntent,
  type AgentLimits,
  type AgentState,
  type PerpOpenIntent,
  type PerpPolicyState,
  type TradeIntent,
  type Verdict,
} from "./policy";

const NOW = 1_800_000_000;
const DAY = 86_400;
const USDG = "0x00000000000000000000000000000000000000dd" as const;
const TSLA = "0x0000000000000000000000000000000000000001" as const;
const ROUTER = "0x00000000000000000000000000000000000000ff" as const;
const VAULT = "0x00000000000000000000000000000000000000aa" as const;
const EVIL = "0x000000000000000000000000000000000000dead" as const;
const PUB = `0x01${"00".repeat(39)}` as `0x${string}`;
const u = (n: number) => BigInt(Math.round(n * 1e6));

/** BTC on Lighter as orderBookDetails shaped it on 2026-09-29 (sd 5, pd 1, min 0.0002, MMF 1.2%). */
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
const MARK = 830_000n; // 83,000.0

function limits(over: Partial<AgentLimits> = {}): AgentLimits {
  return {
    perTradeUsdg: u(25),
    dailyUsdg: u(100),
    allowedTargets: [ROUTER, VAULT, USDG],
    allowedAssets: [USDG, TSLA],
    cashToken: USDG,
    maxDrawdownBps: 1_500,
    expiresAt: NOW + 30 * DAY,
    maxOpsPerDay: 10,
    perp: { proxy: LIGHTER_ROUTE_V1.proxy, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PUB },
    ...over,
  };
}

function settings(over: Partial<PerpPolicyState["settings"]> = {}): PerpPolicyState["settings"] {
  return {
    markets: ["BTC-PERP", "ETH-PERP"],
    maxLeverage: 2,
    perTradeMicro: u(25),
    maxOpenNotionalMicro: u(50),
    maxCollateralMicro: u(30),
    maxOpensPerDay: 4,
    stopLossBps: 500,
    stopSlipBps: 200,
    liqBufferBps: 200,
    maxSlippageBps: 50,
    ...over,
  };
}

function marketState(maxLeverage = 2, over: Partial<ReturnType<typeof marketRow>> = {}): PerpPolicyState["markets"] {
  return new Map([[1, { ...marketRow(maxLeverage), ...over }]]);
}
function marketRow(maxLeverage: number) {
  const imf = leverageTarget(maxLeverage, BTC).imfBp;
  return {
    status: "active" as "active" | "reduce-only" | "inactive",
    effMinNotionalMicro: effectiveMinNotionalMicro(BTC, MARK),
    imfBpTarget: imf,
    venueImfBp: imf as number | null,
    venueMarginMode: "isolated" as "isolated" | "cross" | null,
    mmfBp: BTC.mmfBp,
    spec: BTC,
  };
}

function perp(over: Partial<PerpPolicyState> = {}): PerpPolicyState {
  return {
    mode: "live",
    refuseRule: null,
    settings: settings(),
    openNotionalMicro: 0n,
    committedCollateralMicro: 0n,
    opensToday: 0,
    positions: new Map(),
    markets: marketState(),
    unresolvedMarkets: new Set(),
    closeInFlightMarkets: new Set(),
    incident: false,
    entriesHalted: false,
    grantExpiresAtSec: NOW + 30 * DAY,
    nowSec: NOW,
    ...over,
  };
}

/** `p: null` means NO perps lane state at all (a default parameter would swallow `undefined`). */
function state(over: Partial<AgentState> = {}, p: PerpPolicyState | null = perp()): AgentState {
  return {
    spentTodayUsdg: 0n,
    opsToday: 0,
    highWaterMarkUsdg: 0n,
    equityUsdg: 0n,
    nowSec: NOW,
    ...(p ? { perp: p } : {}),
    ...over,
  };
}

/** An open built exactly as the route builds one: worst from mark, stop from mark, notional at the worse price. */
function open(
  side: "long" | "short" = "long",
  target = u(20),
  o: { maxLeverage?: number; stopLossBps?: number; slip?: number; take?: number } = {},
): PerpOpenIntent {
  const worst = worstPriceForTaker({ isAsk: side === "short", mark: MARK, maxSlippageBps: o.slip ?? 50 });
  const ref = worst > MARK ? worst : MARK;
  const base = baseForNotional(target, ref, BTC, "floor");
  const stop = stopPrices({ side, entryRefPrice: MARK, stopLossBps: o.stopLossBps ?? 500, stopSlipBps: 200 });
  const take = o.take ? takePrices({ side, entryRefPrice: MARK, takeProfitBps: o.take, stopSlipBps: 200 }) : null;
  return {
    kind: "perp-order",
    venue: "lighter",
    market: "BTC-PERP",
    marketId: 1,
    effect: "open",
    side,
    reduceOnly: false,
    baseAmount: base,
    worstPrice: worst,
    markPrice: MARK,
    notionalUsdg: notionalMicro(base, ref, BTC, "ceil"),
    imfBp: leverageTarget(o.maxLeverage ?? 2, BTC).imfBp,
    stopTrigger: stop.trigger,
    stopPrice: stop.price,
    ...(take ? { takeTrigger: take.trigger, takePrice: take.price } : {}),
  };
}

function exit(effect: "reduce" | "close" = "close", side: "long" | "short" = "long", base = 23n): TradeIntent {
  return {
    kind: "perp-order",
    venue: "lighter",
    market: "BTC-PERP",
    marketId: 1,
    effect,
    side,
    reduceOnly: true,
    baseAmount: base,
    worstPrice: worstPriceForTaker({ isAsk: side === "long", mark: MARK, maxSlippageBps: 150 }),
    markPrice: MARK,
    notionalUsdg: notionalMicro(base, MARK, BTC, "ceil"),
  };
}

const holding = (side: "long" | "short" = "long", base = 23n) =>
  perp({ positions: new Map([[1, { side, baseAmount: base }]]), openNotionalMicro: notionalMicro(base, MARK, BTC) });

const withdraw: TradeIntent = { kind: "perp-margin", direction: "withdraw", amountUsdg: u(5) };
const claim: TradeIntent = { kind: "perp-margin", direction: "claim", amountUsdg: u(5) };
const deposit = (amount = u(10), target: `0x${string}` = LIGHTER_ROUTE_V1.proxy): TradeIntent => ({
  kind: "perp-margin",
  direction: "deposit",
  target,
  amountUsdg: amount,
});

const TRIPPED: Partial<AgentState> = { highWaterMarkUsdg: u(1000), equityUsdg: u(800) };

function rule(v: Verdict): string {
  return v.ok ? "ok" : v.rule;
}
function ask(intent: TradeIntent, s: AgentState = state(), l: AgentLimits = limits()): string {
  return rule(checkPolicy(intent, l, s));
}

// ── the fixtures are honest ─────────────────────────────────────────────────

describe("the fixture open is a real, passable order", () => {
  it("a long and a short both pass every rule", () => {
    assert.equal(ask(open("long")), "ok");
    assert.equal(ask(open("short")), "ok");
    assert.equal(ask(open("long", u(20), { take: 1_000 })), "ok", "with a take-profit child too");
    assert.equal(ask(open("short", u(20), { take: 1_000 })), "ok");
  });
  it("and the same verdict twice — pure, so the caller can run it on the proposed AND the reviewed terms", () => {
    const i = open();
    const s = state();
    assert.deepEqual(checkPolicy(i, limits(), s), checkPolicy(i, limits(), s));
  });
});

// ── the predicates (rule 8, made mechanical) ────────────────────────────────

describe("exit and entry predicates for every kind", () => {
  const l = limits();
  // Typed over EVERY kind, so adding one to TradeIntent fails here until
  // somebody decides what it is to the breaker and to the energy gate.
  const TABLE = {
    swap: [
      { i: { kind: "swap", target: ROUTER, sellToken: TSLA, buyToken: USDG, sellAmountRaw: 1n, notionalUsdg: 1n }, exit: true, entry: false },
      { i: { kind: "swap", target: ROUTER, sellToken: USDG, buyToken: TSLA, sellAmountRaw: 1n, notionalUsdg: 1n }, exit: false, entry: true },
    ],
    "vault-deposit": [{ i: { kind: "vault-deposit", target: VAULT, amountUsdg: 1n }, exit: false, entry: false }],
    "vault-withdraw": [{ i: { kind: "vault-withdraw", target: VAULT, amountUsdg: 1n }, exit: true, entry: false }],
    transfer: [{ i: { kind: "transfer", target: USDG, recipient: EVIL, amountUsdg: 1n }, exit: true, entry: false }],
    "equity-order": [
      { i: { kind: "equity-order", ticker: "TSLA", side: "sell", notionalUsdg: 1n }, exit: true, entry: false },
      { i: { kind: "equity-order", ticker: "TSLA", side: "buy", notionalUsdg: 1n }, exit: false, entry: true },
    ],
    "curve-trade": [
      {
        i: { kind: "curve-trade", target: ROUTER, curve: EVIL, assetIn: TSLA, assetOut: USDG, amountInRaw: 1n, minAmountOutRaw: 0n, notionalUsdg: 1n },
        exit: true,
        entry: false,
      },
    ],
    "energy-buy": [
      { i: { kind: "energy-buy", target: ROUTER, sellToken: USDG, buyToken: TSLA, sellAmountRaw: 1n, notionalUsdg: 1n }, exit: false, entry: true },
    ],
    "perp-order": [
      { i: open("long"), exit: false, entry: true },
      { i: open("short"), exit: false, entry: true },
      { i: exit("close", "long"), exit: true, entry: false },
      { i: exit("reduce", "short"), exit: true, entry: false },
    ],
    "perp-margin": [
      { i: deposit(), exit: false, entry: false },
      { i: withdraw, exit: true, entry: false },
      { i: claim, exit: true, entry: false },
    ],
  } satisfies Record<TradeIntent["kind"], { i: TradeIntent; exit: boolean; entry: boolean }[]>;

  for (const [kind, rows] of Object.entries(TABLE)) {
    it(`${kind}: isExitIntent and countsAsEntry`, () => {
      for (const row of rows as { i: TradeIntent; exit: boolean; entry: boolean }[]) {
        const e = isExitIntent(row.i, l);
        assert.equal(e, row.exit, `${JSON.stringify(row.i, (_k, v) => (typeof v === "bigint" ? String(v) : v))} exit`);
        assert.equal(countsAsEntry(row.i.kind, e), row.entry, `${row.i.kind} entry`);
      }
    });
  }

  it("A PERP EXIT IS THE FLAG THE VENUE ENFORCES: 'close' without reduceOnly is not an exit", () => {
    const unflagged = { ...exit("close"), reduceOnly: false } as unknown as TradeIntent;
    assert.equal(isExitIntent(unflagged, l), false);
    const flaggedOpen = { ...open(), reduceOnly: true } as unknown as TradeIntent;
    assert.equal(isExitIntent(flaggedOpen, l), false, "and an open with the flag set is not one either");
    // And the branch refuses both rather than letting either through as anything.
    assert.equal(ask(unflagged, state({}, holding())), "perp-order-malformed");
    assert.equal(ask(flaggedOpen), "perp-order-malformed");
  });

  it("a kind the type does not know is not an exit", () => {
    assert.equal(isExitIntent({ kind: "mystery" } as unknown as TradeIntent, l), false);
  });
});

// ── every open rule, alone ──────────────────────────────────────────────────

type Ctx = { intent: TradeIntent; state: AgentState; limits: AgentLimits };
const base = (): Ctx => ({ intent: open(), state: state(), limits: limits() });
const withPerp = (patch: Partial<PerpPolicyState>) => (c: Ctx): Ctx => ({ ...c, state: { ...c.state, perp: { ...c.state.perp!, ...patch } } });
const withOpen = (patch: Record<string, unknown>) => (c: Ctx): Ctx => ({ ...c, intent: { ...(c.intent as PerpOpenIntent), ...patch } as TradeIntent });

const ALONE: [string, string, (c: Ctx) => Ctx][] = [
  // the rail
  ["no perps lane at all", "perp-not-enabled", (c) => ({ ...c, state: state({}, null) })],
  ["perps off", "perp-not-enabled", withPerp({ mode: "off" })],
  ["live account, real perps not consented", "perp-live-not-enabled", withPerp({ mode: "refuse", refuseRule: "perp-live-not-enabled" })],
  ["the rail says not granted", "perp-not-granted", withPerp({ mode: "refuse", refuseRule: "perp-not-granted" })],
  ["the venue account is not ready", "perp-venue-unready", withPerp({ mode: "refuse", refuseRule: "perp-venue-unready" })],
  ["the operator has perps off", "perp-operator-off", withPerp({ mode: "refuse", refuseRule: "perp-operator-off" })],
  ["the account itself is refused", "no-cash", withPerp({ mode: "refuse", refuseRule: "no-cash" })],
  ["live rail, but the limits carry no sealed route", "perp-not-granted", (c) => ({ ...c, limits: limits({ perp: undefined }) })],
  // account-wide stops
  ["a venue incident", "perp-venue-incident", withPerp({ incident: true })],
  ["entries halted", "perp-entries-halted", withPerp({ entriesHalted: true })],
  // the market
  ["a market the owner did not allow", "perp-market-not-allowed", withPerp({ settings: settings({ markets: ["ETH-PERP"] }) })],
  ["a key outside the frozen table", "perp-market-not-allowed", withOpen({ market: "FOO-PERP" })],
  ["a key and an id that disagree", "perp-market-not-allowed", withOpen({ marketId: 0 })],
  ["a market read reduce-only", "perp-market-inactive", withPerp({ markets: marketState(2, { status: "reduce-only" }) })],
  ["a market read inactive", "perp-market-inactive", withPerp({ markets: marketState(2, { status: "inactive" }) })],
  ["a market whose terms were not read", "perp-market-inactive", withPerp({ markets: new Map() })],
  // time
  ["the grant expires in under a day", "perp-grant-expiring", withPerp({ grantExpiresAtSec: NOW + DAY - 1 })],
  ["…falling back to the limits' expiry when the grant's is unknown", "perp-grant-expiring", (c) => withPerp({ grantExpiresAtSec: null })({ ...c, limits: limits({ expiresAt: NOW + 3_600 }) })],
  // what is there
  ["a position already open on the same side", "perp-add-to-position", withPerp({ positions: new Map([[1, { side: "long", baseAmount: 5n }]]) })],
  ["a position open on the other side (a flip)", "perp-add-to-position", withPerp({ positions: new Map([[1, { side: "short", baseAmount: 5n }]]) })],
  ["a close in flight", "perp-close-in-flight", withPerp({ closeInFlightMarkets: new Set([1]) })],
  ["an order with no final outcome", "perp-close-in-flight", withPerp({ unresolvedMarkets: new Set([1]) })],
  // leverage
  ["the venue has no leverage entry for the market", "perp-leverage-unset", withPerp({ markets: marketState(2, { venueImfBp: null }) })],
  ["the venue reads cross margin", "perp-leverage-unset", withPerp({ markets: marketState(2, { venueMarginMode: "cross" }) })],
  ["the order asserts 20x", "perp-leverage-mismatch", withOpen({ imfBp: 500 })],
  ["the venue reads a different leverage", "perp-leverage-mismatch", withPerp({ markets: marketState(2, { venueImfBp: 1_000 }) })],
  [
    // Intent, venue and lane all agree on 10x — and the owner's setting is 2x.
    // The target is re-derived from the setting, so a lane that computed it
    // wrong cannot choose a leverage the owner did not.
    "intent, venue and lane agree on a leverage the owner did not set",
    "perp-leverage-mismatch",
    (c) => withOpen({ imfBp: 1_000 })(withPerp({ markets: marketState(2, { imfBpTarget: 1_000, venueImfBp: 1_000 }) })(c)),
  ],
  // shape
  ["a notional below base × max(worst, mark)", "perp-order-malformed", (c) => withOpen({ notionalUsdg: (c.intent as PerpOpenIntent).notionalUsdg - 1n })(c)],
  ["a worst price past the owner's slippage", "perp-order-malformed", (c) => ({ ...c, intent: open("long", u(20), { slip: 80 }) })],
  ["a buy whose worst price is under the mark", "perp-order-malformed", withOpen({ worstPrice: MARK - 1n })],
  ["a price the signer cannot carry", "perp-order-malformed", withOpen({ worstPrice: 2n ** 32n })],
  ["a zero size", "non-positive", withOpen({ baseAmount: 0n })],
  // the stop
  ["no stop at all", "perp-stop-required", withOpen({ stopTrigger: undefined, stopPrice: undefined })],
  ["a zero stop", "perp-stop-required", withOpen({ stopTrigger: 0n, stopPrice: 0n })],
  ["a long's stop above the mark", "perp-stop-required", withOpen({ stopTrigger: MARK + 10n, stopPrice: MARK + 5n })],
  ["a stop farther than the owner's stop-loss", "perp-stop-required", (c) => ({ ...c, intent: open("long", u(20), { stopLossBps: 600 }) })],
  ["a stop whose bound is past the stop slippage", "perp-stop-required", (c) => withOpen({ stopPrice: (c.intent as PerpOpenIntent).stopTrigger * 9_000n / 10_000n })(c)],
  ["a take-profit on the losing side", "perp-stop-required", withOpen({ takeTrigger: MARK - 1_000n, takePrice: MARK - 1_100n })],
  ["half a take-profit", "perp-stop-required", withOpen({ takeTrigger: MARK + 50_000n })],
  [
    "a stop past liquidation at 10x",
    "perp-stop-inside-liquidation",
    (c) => ({
      ...c,
      intent: open("long", u(20), { maxLeverage: 10, stopLossBps: 1_200 }),
      state: { ...c.state, perp: { ...c.state.perp!, settings: settings({ maxLeverage: 10, stopLossBps: 2_500 }), markets: marketState(10) } },
    }),
  ],
  [
    "a stop that beats liquidation but not by the buffer",
    "perp-stop-inside-liquidation",
    withPerp({ settings: settings({ liqBufferBps: 5_000 }) }),
  ],
  // the caps
  ["under the venue's minimum notional", "perp-below-min", (c) => ({ ...c, intent: open("long", u(15)) })],
  ["under the venue's minimum base", "perp-below-min", withPerp({ markets: marketState(2, { spec: { ...BTC, minBaseAmount: 1_000n } }) })],
  ["over the perp per-trade cap", "perp-per-trade-cap", withPerp({ settings: settings({ perTradeMicro: u(19) }) })],
  ["over the SEALED cap though the setting is higher", "perp-per-trade-cap", (c) => ({ ...c, limits: limits({ perTradeUsdg: u(19) }) })],
  ["past the open-notional limit", "perp-open-notional-cap", withPerp({ openNotionalMicro: u(35) })],
  ["past the collateral limit", "perp-collateral-cap", withPerp({ committedCollateralMicro: u(25) })],
  ["the day's opens used", "perp-max-opens", withPerp({ opensToday: 4 })],
  // the shared brakes an open meets like any entry
  ["the day's operations used", "ops-cap", (c) => ({ ...c, state: { ...c.state, opsToday: 10 } })],
  ["the day's budget spent", "daily-cap", (c) => ({ ...c, state: { ...c.state, spentTodayUsdg: u(90) } })],
  ["Lighter unread with money there", "perp-unpriced", (c) => ({ ...c, state: { ...c.state, perpVenueUnread: true, perpLastKnownMicro: u(5) } })],
  ["the drawdown breaker tripped", "drawdown-breaker", (c) => ({ ...c, state: { ...c.state, ...TRIPPED } })],
  ["the session key expired though the grant clock is stale", "expiry", (c) => ({ ...c, limits: limits({ expiresAt: NOW - 1 }) })],
];

describe("every open rule refuses ALONE, with its own slug", () => {
  for (const [name, want, mutate] of ALONE) {
    it(`${name} → ${want}`, () => {
      const c = mutate(base());
      assert.equal(rule(checkPolicy(c.intent, c.limits, c.state)), want);
    });
  }

  it("a paper rail needs no grant — the paper book never touches the chain", () => {
    assert.equal(ask(open(), state({}, perp({ mode: "paper" })), limits({ perp: undefined })), "ok");
  });

  it("A SHORT IS JUDGED AT THE MARK, not only at its lower worst price", () => {
    // Stage-1 note 'short-notional-judged-at-lowest-fill': a short sized by its
    // best fill under-counts exposure. Its notional must be base × mark.
    const s = open("short");
    assert.ok(s.worstPrice < s.markPrice);
    assert.equal(s.notionalUsdg, notionalMicro(s.baseAmount, s.markPrice, BTC, "ceil"));
    const understated = { ...s, notionalUsdg: notionalMicro(s.baseAmount, s.worstPrice, BTC, "ceil") };
    assert.equal(ask(understated), "perp-order-malformed");
  });

  it("the caps judge EXPOSURE, not margin: a 2x open of 20 is judged at 20, never at its 10 of margin", () => {
    assert.equal(ask(open(), state({}, perp({ settings: settings({ perTradeMicro: u(15) }) }))), "perp-per-trade-cap");
  });

  it("a stop built exactly to the owner's setting passes, one tick wider does not", () => {
    const exact = open("long", u(20), { stopLossBps: 500 });
    assert.equal(ask(exact), "ok");
    assert.equal(ask({ ...exact, stopTrigger: exact.stopTrigger - 1n, stopPrice: exact.stopPrice - 1n }), "perp-stop-required");
    const short = open("short", u(20), { stopLossBps: 500 });
    assert.equal(ask(short), "ok");
    assert.equal(ask({ ...short, stopTrigger: short.stopTrigger + 1n, stopPrice: short.stopPrice + 1n }), "perp-stop-required");
  });
});

describe("the order is stable: with everything wrong, rules come off one at a time in the documented order", () => {
  it("rail → incident → halt → market → inactive → expiring → position → in-flight → leverage → stop → liquidation → min → per-trade → open-notional → collateral → opens", () => {
    // Everything broken at once, then each fixed in turn: the next rule in the
    // documented order must be the one that answers.
    let p = perp({
      mode: "off",
      incident: true,
      entriesHalted: true,
      settings: settings({
        markets: ["ETH-PERP"],
        liqBufferBps: 5_000,
        perTradeMicro: u(19),
        maxOpenNotionalMicro: u(20),
        maxCollateralMicro: u(9),
        maxOpensPerDay: 1,
      }),
      markets: marketState(2, { status: "reduce-only" }),
      grantExpiresAtSec: NOW + 60,
      positions: new Map([[1, { side: "long", baseAmount: 1n }]]),
      closeInFlightMarkets: new Set([1]),
      opensToday: 1,
      openNotionalMicro: u(5),
      committedCollateralMicro: u(1),
    });
    let i: PerpOpenIntent = { ...open(), stopTrigger: 0n, stopPrice: 0n };
    const seen: string[] = [];
    const fixes: (() => void)[] = [
      () => (p = { ...p, mode: "live" }),
      () => (p = { ...p, incident: false }),
      () => (p = { ...p, entriesHalted: false }),
      () => (p = { ...p, settings: { ...p.settings, markets: ["BTC-PERP"] } }),
      () => (p = { ...p, markets: marketState(2, { venueImfBp: null }) }),
      () => (p = { ...p, grantExpiresAtSec: NOW + 30 * DAY }),
      () => (p = { ...p, positions: new Map() }),
      () => (p = { ...p, closeInFlightMarkets: new Set() }),
      () => (p = { ...p, markets: marketState(2, { effMinNotionalMicro: u(100) }) }),
      () => (i = open()),
      () => (p = { ...p, settings: { ...p.settings, liqBufferBps: 200 } }),
      () => (p = { ...p, markets: marketState(2) }),
      () => (p = { ...p, settings: { ...p.settings, perTradeMicro: u(25) } }),
      () => (p = { ...p, settings: { ...p.settings, maxOpenNotionalMicro: u(50) } }),
      () => (p = { ...p, settings: { ...p.settings, maxCollateralMicro: u(30) } }),
      () => (p = { ...p, settings: { ...p.settings, maxOpensPerDay: 4 } }),
    ];
    for (const fix of fixes) {
      seen.push(ask(i, state({}, p)));
      fix();
    }
    seen.push(ask(i, state({}, p)));
    assert.deepEqual(seen, [
      "perp-not-enabled",
      "perp-venue-incident",
      "perp-entries-halted",
      "perp-market-not-allowed",
      "perp-market-inactive",
      "perp-grant-expiring",
      "perp-add-to-position",
      "perp-close-in-flight",
      "perp-leverage-unset",
      "perp-stop-required",
      "perp-stop-inside-liquidation",
      "perp-below-min",
      "perp-per-trade-cap",
      "perp-open-notional-cap",
      "perp-collateral-cap",
      "perp-max-opens",
      "ok",
    ]);
  });
});

// ── exits: never refused by a brake (rule 8) ───────────────────────────────

describe("a perp exit is ALWAYS attemptable", () => {
  const BRAKES: [string, Partial<AgentState>, Partial<PerpPolicyState>, Partial<AgentLimits>][] = [
    ["the breaker tripped", TRIPPED, {}, {}],
    ["the day's budget spent", { spentTodayUsdg: u(100) }, {}, {}],
    ["the day's operations used", { opsToday: 10 }, {}, {}],
    ["Lighter unread with money there", { perpVenueUnread: true, perpLastKnownMicro: u(50) }, {}, {}],
    ["the session key expired", { nowSec: NOW + 60 * DAY }, { nowSec: NOW + 60 * DAY }, {}],
    ["a venue incident", {}, { incident: true }, {}],
    ["entries halted", {}, { entriesHalted: true }, {}],
    ["the grant expiring", {}, { grantExpiresAtSec: NOW + 60 }, {}],
    ["perps switched off", {}, { mode: "off" }, {}],
    ["the rail refused", {}, { mode: "refuse", refuseRule: "perp-live-not-enabled" }, {}],
    ["the market removed from the owner's list", {}, { settings: settings({ markets: [] }) }, {}],
    ["the market reduce-only", {}, { markets: marketState(2, { status: "reduce-only" }) }, {}],
    ["the market's terms unread", {}, { markets: new Map() }, {}],
    ["a close already in flight", {}, { closeInFlightMarkets: new Set([1]), unresolvedMarkets: new Set([1]) }, {}],
    ["every perp cap spent", {}, { opensToday: 99, openNotionalMicro: u(999), committedCollateralMicro: u(999) }, {}],
    ["no sealed route on the limits", {}, {}, { perp: undefined }],
    ["a per-trade cap far below the position", {}, {}, { perTradeUsdg: 1n }],
  ];

  for (const [name, s, p, l] of BRAKES) {
    it(`${name}: a close, a reduce and a withdrawal all go`, () => {
      const st = state(s, { ...holding(), ...p, positions: holding().positions });
      assert.equal(ask(exit("close"), st, limits(l)), "ok", "close");
      assert.equal(ask(exit("reduce", "long", 10n), st, limits(l)), "ok", "reduce");
      assert.equal(ask(withdraw, st, limits(l)), "ok", "withdraw");
    });
  }

  it("an oversized reduce is not refused for its size — the boundary clamps it and ReduceOnly bounds it", () => {
    assert.equal(ask(exit("reduce", "long", 10_000_000n), state({}, holding())), "ok");
  });

  it("refused only for not being an exit of what is held", () => {
    assert.equal(ask(exit("close", "short"), state({}, holding("long"))), "perp-side-mismatch");
    assert.equal(ask(exit("close"), state({}, perp())), "perp-no-position");
    assert.equal(ask(exit("close"), state({}, perp({ positions: new Map([[1, { side: "long", baseAmount: 0n }]]) }))), "perp-no-position");
    assert.equal(ask(exit("close"), state({}, null)), "perp-no-position", "no lane state: nothing venue-read to size or side it against");
    assert.equal(ask({ ...exit("close"), baseAmount: 0n } as TradeIntent, state({}, holding())), "non-positive");
    assert.equal(ask({ ...exit("close"), stopTrigger: 1n } as unknown as TradeIntent, state({}, holding())), "perp-order-malformed");
    assert.equal(ask({ ...exit("close"), marketId: 0 } as TradeIntent, state({}, holding())), "perp-order-malformed");
  });
});

describe("money coming home and money going out", () => {
  it("a claim is an exit through the wall: it needs the sealed route and a live key, and nothing else", () => {
    assert.equal(ask(claim, state(TRIPPED, perp({ mode: "off" }))), "ok");
    assert.equal(ask(claim, state({ opsToday: 10, spentTodayUsdg: u(100) })), "ok");
    assert.equal(ask(claim, state({}, null)), "ok");
    assert.equal(ask(claim, state(), limits({ perp: undefined })), "perp-not-granted");
    assert.equal(ask(claim, state({ nowSec: NOW + 60 * DAY })), "expiry");
    assert.equal(ask({ kind: "perp-margin", direction: "claim", amountUsdg: 0n }), "non-positive");
  });

  it("a withdrawal needs nothing — it is how a stand-down brings collateral home after expiry", () => {
    assert.equal(ask(withdraw, state({ nowSec: NOW + 60 * DAY }, null), limits({ perp: undefined })), "ok");
    assert.equal(ask({ kind: "perp-margin", direction: "withdraw", amountUsdg: -1n }), "non-positive");
  });

  it("a deposit mirrors the wall: the sealed proxy, perTradeUsdg per call, counted as spend", () => {
    assert.equal(ask(deposit()), "ok");
    assert.equal(ask(deposit(u(10), EVIL)), "target-allowlist");
    assert.equal(ask(deposit(u(26))), "per-trade-cap", "the approve the wall caps it with");
    assert.equal(ask(deposit(u(10)), state({ spentTodayUsdg: u(95) })), "daily-cap", "money that can be lost counts as spend");
    assert.equal(ask(deposit()), "ok");
  });

  it("…and every brake an entry meets, because it is not an exit", () => {
    assert.equal(ask(deposit(), state({ opsToday: 10 })), "ops-cap");
    assert.equal(ask(deposit(), state(TRIPPED)), "drawdown-breaker");
    assert.equal(ask(deposit(), state({ perpVenueUnread: true, perpLastKnownMicro: null })), "perp-unpriced");
  });

  it("…and the contract's own bounds on what may sit at the venue", () => {
    assert.equal(ask(deposit(), state({}, null)), "perp-not-enabled");
    assert.equal(ask(deposit(), state({}, perp({ mode: "off" }))), "perp-not-enabled");
    assert.equal(ask(deposit(), state({}, perp({ mode: "paper" }))), "perp-live-not-enabled", "only a live rail moves real USDG");
    assert.equal(ask(deposit(), state({}, perp({ mode: "refuse", refuseRule: "perp-operator-off" }))), "perp-operator-off");
    assert.equal(ask(deposit(), state(), limits({ perp: undefined })), "perp-not-granted");
    assert.equal(ask(deposit(0n)), "non-positive");
    assert.equal(ask(deposit(u(0.5))), "perp-below-min", "Lighter's 1 USDG minimum deposit reverts");
    assert.equal(ask(deposit(), state({}, perp({ incident: true }))), "perp-venue-incident");
    assert.equal(ask(deposit(), state({}, perp({ entriesHalted: true }))), "perp-entries-halted");
    assert.equal(ask(deposit(), state({}, perp({ grantExpiresAtSec: NOW + 60 }))), "perp-grant-expiring");
    assert.equal(ask(deposit(u(10)), state({}, perp({ committedCollateralMicro: u(25) }))), "perp-collateral-cap");
  });
});

describe("the shared rails did not move for anything else", () => {
  it("a spot buy is still judged exactly as before, and the proxy is not a swap target", () => {
    const buy: TradeIntent = { kind: "swap", target: ROUTER, sellToken: USDG, buyToken: TSLA, sellAmountRaw: u(5), notionalUsdg: u(5) };
    assert.equal(ask(buy), "ok");
    assert.equal(ask({ ...buy, target: LIGHTER_ROUTE_V1.proxy }), "target-allowlist");
    assert.equal(ask({ kind: "vault-deposit", target: LIGHTER_ROUTE_V1.proxy, amountUsdg: u(5) }), "target-allowlist");
  });
});
