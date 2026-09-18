/**
 * Quarantine is the only thing between an owner and an unbounded position in
 * something nobody can value. These tests exist mostly to pin that it FAILS
 * CLOSED: every ambiguity, every missing setting, every edge must refuse.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { quarantineOf, scoutAllows, scoutGateShut, type ScoutLimits } from "./quarantine";
import { scoutFlagsFor } from "./class-side";
import type { TradeIntent } from "./policy";

const U = (n: number) => BigInt(Math.round(n * 1e6));

const limits = (over: Partial<ScoutLimits> = {}): ScoutLimits => ({
  enabled: true,
  budgetUsdg: U(100),
  perTokenUsdg: U(25),
  ...over,
});

describe("quarantineOf", () => {
  const cost = (s: string) => ({ CATE: U(10), WEN: U(5) })[s] ?? 0n;
  const reason = (s: string) => (s === "CATE" ? "pool too thin" : undefined);

  it("carries each unpriceable holding at its cost and totals them", () => {
    const q = quarantineOf(["CATE", "WEN"], cost, reason);
    assert.equal(q.totalCostUsdg, U(15));
    assert.deepEqual(q.holdings.map((h) => h.symbol), ["CATE", "WEN"]);
    assert.equal(q.holdings[0]?.costUsdg, U(10));
  });

  it("carries the guard's own reason, so the owner learns WHY not just THAT", () => {
    assert.equal(quarantineOf(["CATE"], cost, reason).holdings[0]?.reason, "pool too thin");
  });

  it("falls back to a truthful reason when the guard didn't give one", () => {
    assert.match(quarantineOf(["WEN"], cost, reason).holdings[0]!.reason, /no Chainlink feed/);
  });

  it("a zero-cost holding contributes nothing — we know neither value nor cost", () => {
    const q = quarantineOf(["AIRDROP"], () => 0n, () => undefined);
    assert.equal(q.totalCostUsdg, 0n);
    assert.equal(q.holdings.length, 1, "still reported — it IS held");
  });

  it("is empty-safe", () => {
    const q = quarantineOf([], cost, reason);
    assert.equal(q.totalCostUsdg, 0n);
    assert.deepEqual(q.holdings, []);
  });
});

describe("scoutAllows — fails closed", () => {
  const base = { spendUsdg: U(10), existingCostUsdg: 0n, quarantinedUsdg: 0n };

  it("refuses when scout mode is off — this is opt-in, never a default", () => {
    const v = scoutAllows(base, limits({ enabled: false }));
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.reason : "", /opt-in/);
  });

  it("refuses on a zero budget even when enabled", () => {
    const v = scoutAllows(base, limits({ budgetUsdg: 0n }));
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.reason : "", /set one in \/settings/);
  });

  it("allows a buy inside both ceilings", () => {
    assert.equal(scoutAllows(base, limits()).ok, true);
  });

  it("refuses when the PER-TOKEN cap would break", () => {
    const v = scoutAllows({ ...base, spendUsdg: U(26) }, limits());
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.reason : "", /per-token/);
  });

  it("counts what the token ALREADY cost toward its per-token cap", () => {
    // 20 already in, 10 more would be 30 — over the 25 ceiling. Topping up must
    // not be a way around a cap that a single buy would have hit.
    const v = scoutAllows({ ...base, existingCostUsdg: U(20) }, limits());
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.reason : "", /per-token/);
  });

  it("refuses when the TOTAL budget would break, even if per-token is fine", () => {
    const v = scoutAllows({ ...base, quarantinedUsdg: U(95) }, limits());
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.reason : "", /scout budget/);
  });

  it("allows landing exactly ON each ceiling, and refuses one unit past", () => {
    assert.equal(scoutAllows({ ...base, spendUsdg: U(25) }, limits()).ok, true);
    assert.equal(scoutAllows({ ...base, spendUsdg: U(25) + 1n }, limits()).ok, false);
    assert.equal(scoutAllows({ ...base, spendUsdg: U(25), quarantinedUsdg: U(75) }, limits()).ok, true);
    assert.equal(scoutAllows({ ...base, spendUsdg: U(25), quarantinedUsdg: U(75) + 1n }, limits()).ok, false);
  });

  it("refuses a zero or negative spend rather than treating it as free", () => {
    assert.equal(scoutAllows({ ...base, spendUsdg: 0n }, limits()).ok, false);
    assert.equal(scoutAllows({ ...base, spendUsdg: -1n }, limits()).ok, false);
  });

  it("the budget is about OUTSTANDING cost, so selling out frees it again", () => {
    // Full budget used → refused. Sell out (quarantined back to 0) → allowed.
    assert.equal(scoutAllows({ ...base, quarantinedUsdg: U(100) }, limits()).ok, false);
    assert.equal(scoutAllows({ ...base, quarantinedUsdg: 0n }, limits()).ok, true);
  });
});

describe("scoutGateShut — deterministic refusal, for the pre-proposal gate", () => {
  it("mirrors scoutAllows' unconditional branches exactly", () => {
    // Off → shut no matter the spend. The gate must agree with the wall on
    // every input where the wall doesn't need per-token state.
    assert.equal(scoutGateShut({ limits: limits({ enabled: false }), buyUnpriceable: true }), true);
    assert.equal(
      scoutAllows({ spendUsdg: U(1), existingCostUsdg: 0n, quarantinedUsdg: 0n }, limits({ enabled: false })).ok,
      false,
    );
    // Zero budget → shut.
    assert.equal(scoutGateShut({ limits: limits({ budgetUsdg: 0n }), buyUnpriceable: true }), true);
    assert.equal(
      scoutAllows({ spendUsdg: U(1), existingCostUsdg: 0n, quarantinedUsdg: 0n }, limits({ budgetUsdg: 0n })).ok,
      false,
    );
    // Funded + enabled → open (the wall may still refuse on spend — not ours to judge here).
    assert.equal(scoutGateShut({ limits: limits(), buyUnpriceable: true }), false);
  });

  it("never shuts a priceable buy, whatever the budget", () => {
    assert.equal(
      scoutGateShut({ limits: limits({ enabled: false, budgetUsdg: 0n }), buyUnpriceable: false }),
      false,
    );
  });

  it("never shuts an exit, even with the budget at zero", () => {
    // The #110 regression in gate terms: a class SELL targets the vault just
    // like a buy, so a target-only rule judges it an unpriceable purchase and
    // the gate would silently drop every exit. The flags come from
    // scoutFlagsFor (asset-side aware), never from the target alone.
    const USDG = "0x5fc5360d0400a0fd4f2af552ADD042D716F1d168" as const;
    const TOKEN = "0x1111111111111111111111111111111111111111" as const;
    const VAULT = "0x9999999999999999999999999999999999999999" as const;
    const sell = {
      kind: "curve-trade",
      target: VAULT,
      assetIn: TOKEN,
      assetOut: USDG,
    } as unknown as TradeIntent;
    const shut = limits({ enabled: false, budgetUsdg: 0n });
    const flags = scoutFlagsFor(sell, { vault: VAULT, cash: USDG, lastUnpriceable: new Set([TOKEN]) });
    assert.equal(flags.buyUnpriceable, false, "a sell acquires cash — precondition, not the gate");
    assert.equal(scoutGateShut({ limits: shut, buyUnpriceable: flags.buyUnpriceable }), false);
  });
});
