/**
 * A GATE IS A REFUSAL THE WALL WOULD MAKE ANYWAY — NEVER ONE IT WOULD NOT.
 *
 * entry-gates.ts lets a strategy skip a buy before proposing it. That is only
 * safe in one direction: every gate must be a refusal checkPolicy writes with
 * the SAME rule, given limits that pass everything else. A gate the wall would
 * accept is this mirror going stricter than the chain, which policy.ts calls a
 * real bug in as many words — so the sweep below drives every gated case
 * through checkPolicy itself rather than restating its rules.
 *
 * And the other half of the contract: an exit is never gated, and the per-arm
 * backstop lets exactly one gated buy per (token, rule) reach the wall.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "./policy";
import { entryGateFor, entryGateLatch, entryGatesOf, intentEntryGate, type EntryVenue } from "./entry-gates";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const ADAPTER = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const CLASS_VAULT = "0x4444444444444444444444444444444444444444" as const;
const TRENCH_VAULT = "0x5555555555555555555555555555555555555555" as const;
const CURVE = "0x6666666666666666666666666666666666666666" as const;
/** Allowed and sellable — the ordinary case. */
const OK = "0xaAaaAaAaaAaAaaaAaAAAaaAaaAaaAAaAAaaAAAaA" as const;
/** Watched (allowed) but not covered by the signature — the `no-exit` case. */
const WATCHED = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
/** In the signature but not watched. */
const SIGNED = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
/** Neither. */
const NEITHER = "0xdddddddddddddddddddddddddddddddddddddddd" as const;
const TOKENS = [OK, WATCHED, SIGNED, NEITHER] as const;

const NOW = 1_800_000_000;

/** Limits that pass EVERYTHING except the two rules under test. */
function limits(over: Partial<AgentLimits> = {}): AgentLimits {
  return {
    perTradeUsdg: 1_000_000_000n,
    dailyUsdg: 10_000_000_000n,
    allowedTargets: [ROUTER, ADAPTER, USDG, CLASS_VAULT, TRENCH_VAULT],
    allowedAssets: [USDG, OK, WATCHED],
    sellableAssets: [USDG, OK, SIGNED],
    quoteAssets: [USDG],
    cashToken: USDG,
    knownCurves: [CURVE],
    maxDrawdownBps: 1_000,
    expiresAt: NOW + 86_400,
    maxOpsPerDay: 1_000,
    ...over,
  };
}

const state: AgentState = { spentTodayUsdg: 0n, opsToday: 0, highWaterMarkUsdg: 0n, equityUsdg: 0n, nowSec: NOW };

const buySwap = (token: `0x${string}`): TradeIntent => ({
  kind: "swap",
  target: ROUTER,
  sellToken: USDG,
  buyToken: token,
  sellAmountRaw: 5_000_000n,
  notionalUsdg: 5_000_000n,
});

const buyCurve = (token: `0x${string}`, target: `0x${string}` = ADAPTER): TradeIntent => ({
  kind: "curve-trade",
  target,
  curve: CURVE,
  assetIn: USDG,
  assetOut: token,
  amountInRaw: 5_000_000n,
  minAmountOutRaw: 1n,
  notionalUsdg: 5_000_000n,
});

const intentFor = (venue: EntryVenue, token: `0x${string}`) => (venue === "curve" ? buyCurve(token) : buySwap(token));

/** Every shape of the two lists a grant can produce, including "the rule cannot run". */
const SHAPES: { name: string; over: Partial<AgentLimits> }[] = [
  { name: "both lists", over: {} },
  { name: "no sellable list (fixture/backtest)", over: { sellableAssets: undefined } },
  { name: "an empty sellable list", over: { sellableAssets: [] } },
  { name: "mixed-case lists", over: { allowedAssets: [USDG, OK.toUpperCase().replace("0X", "0x") as `0x${string}`, WATCHED], sellableAssets: [USDG.toUpperCase().replace("0X", "0x"), OK, SIGNED] } },
];

describe("one-direction parity: a gate implies checkPolicy refuses with the same rule", () => {
  for (const shape of SHAPES) {
    for (const venue of ["swap", "curve"] as const) {
      it(`${venue}, ${shape.name}`, () => {
        const l = limits(shape.over);
        const gates = entryGatesOf(l);
        let gated = 0;
        for (const token of TOKENS) {
          const rule = entryGateFor(gates, token, venue);
          const intent = intentFor(venue, token);
          const verdict = checkPolicy(intent, l, state);
          if (rule !== null) {
            gated += 1;
            assert.equal(verdict.ok, false, `${venue} gate ${rule} on ${token} but the wall would accept it`);
            assert.equal(!verdict.ok && verdict.rule, rule, `${venue} gate names ${rule}, the wall names another`);
          }
          // The intent-level gate is the same answer, for the same token.
          const whole = intentEntryGate(intent, l);
          assert.deepEqual(whole, rule === null ? null : { token: token.toLowerCase(), rule });
        }
        // The sweep must actually exercise the rule, or it proves nothing. The
        // one shape with nothing to gate is a curve with no sellable list: the
        // wall's curve rule cannot run there, so neither can this.
        if (l.sellableAssets !== undefined || venue === "swap") assert.ok(gated > 0, "nothing was gated");
      });
    }
  }

  it("the swap gate asks in the wall's order: not watched is asset-allowlist before it is no-exit", () => {
    const gates = entryGatesOf(limits());
    assert.equal(entryGateFor(gates, NEITHER), "asset-allowlist");
    assert.equal(entryGateFor(gates, WATCHED), "no-exit");
    assert.equal(entryGateFor(gates, SIGNED), "asset-allowlist");
    assert.equal(entryGateFor(gates, OK), null);
  });

  it("the curve gate never reads allowedAssets — the wall does not, so neither may this", () => {
    const l = limits();
    assert.equal(entryGateFor(entryGatesOf(l), SIGNED, "curve"), null, "signed but not watched is buyable on a curve");
    assert.deepEqual(checkPolicy(buyCurve(SIGNED), l, state), { ok: true });
  });

  it("unread gates gate nothing", () => {
    for (const token of TOKENS) {
      assert.equal(entryGateFor(undefined, token), null);
      assert.equal(entryGateFor(null, token, "curve"), null);
    }
  });
});

describe("what a gate must never touch", () => {
  it("AN EXIT IS NEVER GATED — not into cash, not out of a coin the key cannot even sell", () => {
    const l = limits();
    for (const token of TOKENS) {
      const sell: TradeIntent = { kind: "swap", target: ROUTER, sellToken: token, buyToken: USDG, sellAmountRaw: 1n, notionalUsdg: 1n };
      assert.equal(intentEntryGate(sell, l), null, `swap exit out of ${token}`);
      const curveSell: TradeIntent = { ...(buyCurve(USDG) as Extract<TradeIntent, { kind: "curve-trade" }>), assetIn: token, assetOut: USDG };
      assert.equal(intentEntryGate(curveSell, l), null, `curve exit out of ${token}`);
    }
  });

  it("the autonomous trencher rail is judged by its vault's assets, not these lists", () => {
    const intent: TradeIntent = { ...(buySwap(NEITHER) as Extract<TradeIntent, { kind: "swap" }>), target: TRENCH_VAULT, custody: "trencher" };
    assert.equal(intentEntryGate(intent, limits()), null);
  });

  it("a class trade may leave the class token un-enumerated, so it is not gated", () => {
    const l = limits({ ponsClassVault: CLASS_VAULT });
    assert.equal(intentEntryGate(buyCurve(NEITHER, CLASS_VAULT), l), null);
    assert.deepEqual(checkPolicy(buyCurve(NEITHER, CLASS_VAULT), l, state), { ok: true });
  });

  it("vault movements, transfers and the energy buy are not these rules' business", () => {
    const l = limits();
    const others: TradeIntent[] = [
      { kind: "vault-deposit", target: USDG, amountUsdg: 1n },
      { kind: "vault-withdraw", target: USDG, amountUsdg: 1n },
      { kind: "transfer", target: USDG, recipient: OK, amountUsdg: 1n },
      { kind: "energy-buy", target: ROUTER, sellToken: USDG, buyToken: NEITHER, sellAmountRaw: 1n, notionalUsdg: 1n },
      { kind: "equity-order", ticker: "AAPL", side: "buy", notionalUsdg: 1n },
    ];
    for (const intent of others) assert.equal(intentEntryGate(intent, l), null, intent.kind);
  });
});

describe("the backstop: one rejected row per (token, rule) per arm, then withheld", () => {
  it("lets the FIRST gated buy through so the wall writes its own refusal, and withholds every repeat", () => {
    const latch = entryGateLatch();
    const l = limits();
    assert.equal(latch.withhold(buySwap(WATCHED), l), false, "the one row this arm");
    for (let tick = 0; tick < 50; tick++) assert.equal(latch.withhold(buySwap(WATCHED), l), true);
  });

  it("keys on token AND rule, case-blind", () => {
    const latch = entryGateLatch();
    const l = limits();
    assert.equal(latch.withhold(buySwap(WATCHED), l), false);
    assert.equal(latch.withhold(buySwap(NEITHER), l), false, "another token gets its own row");
    assert.equal(latch.withhold(buySwap(WATCHED.toUpperCase().replace("0X", "0x") as `0x${string}`), l), true);
    // The same token refused under a different rule is a different fact, and
    // gets its own row: the owner is owed both sentences.
    const narrow = limits({ sellableAssets: [USDG] });
    assert.equal(latch.withhold(buyCurve(OK), narrow), false, "asset-allowlist on the curve venue");
    assert.equal(latch.withhold(buySwap(OK), narrow), false, "no-exit on the swap venue is a different rule");
    assert.equal(latch.withhold(buyCurve(OK), narrow), true);
    assert.equal(latch.withhold(buySwap(OK), narrow), true);
  });

  it("never withholds what is not gated, and never an exit", () => {
    const latch = entryGateLatch();
    const l = limits();
    for (let tick = 0; tick < 5; tick++) {
      assert.equal(latch.withhold(buySwap(OK), l), false);
      assert.equal(
        latch.withhold({ kind: "swap", target: ROUTER, sellToken: WATCHED, buyToken: USDG, sellAmountRaw: 1n, notionalUsdg: 1n }, l),
        false,
      );
    }
  });

  it("an arm clears it, so a re-sign starts with its own first row", () => {
    const latch = entryGateLatch();
    const l = limits();
    latch.withhold(buySwap(WATCHED), l);
    assert.equal(latch.withhold(buySwap(WATCHED), l), true);
    latch.clear();
    assert.equal(latch.withhold(buySwap(WATCHED), l), false);
  });
});
