/**
 * A FIRST ENABLE IS TWO OPERATIONS, AND ITS CEILING JUDGED THEM AS ONE.
 *
 * Measured on a live canary (Shogun, 2026-09-12): fourteen executor attempts,
 * twelve of which SIMULATED SUCCESSFULLY and were then refused `gas-absurd`
 * before signing. Nothing was ever signed, so nothing was spent — but the first
 * class buy is the operation that installs the wall, so refusing it refuses the
 * route permanently. Twelve estimates, two distinct shapes, one outcome.
 *
 * IT WAS A FALSE REFUSAL, and the numbers say so plainly: the signed envelope is
 * 13,495,115 against a hard maximum of 14,000,000 — 504,885 UNDER it. What it
 * crossed is `allowedMaxBounded` (13,388,275), which is a MODEL OUTPUT, and the
 * model predicts the cost of INSTALLING A WALL from that wall's stub bytes. It
 * has no term for the trade riding along, and cannot have one: the wall is
 * sealed weeks before anyone picks a trade.
 *
 * For every wall shipped before this one the payload was a single swap — 50,180
 * raw call gas, 0.65% of the estimate — small enough to hide inside the 1.20
 * tolerance. A CLASS first enable's payload is deploy + approve + buy:
 * 1,307,017 raw, 13.1%, and 2,614,034 once `callHeadroomBps` doubles it. That
 * is 19.5% of the allowance spent on something the allowance never saw, against
 * a tolerance of 20%. The wall itself was never the problem — its enable half
 * is 10,881,081 against an allowance of 13,388,275, with 2.5M to spare.
 *
 * THE FIX CHANGES NO NUMBER THIS FILE SIGNS. Per-field headroom is untouched;
 * every previously signable operation signs for the identical gas, asserted
 * below. What changed is which ceiling each part is held to: the enable half
 * against the wall's envelope, the payload against the ordinary operation
 * ceiling, the sum against the 14,000,000 hard maximum — which now binds the
 * total directly instead of being reachable only through a model's output.
 *
 * These tests reproduce Shogun's exact observed estimates, the ordinary first
 * enable that must not regress, and an operation whose signed envelope
 * GENUINELY exceeds 14,000,000 and must still be refused.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FIRST_ENABLE_GAS_BOUNDS, GAS_BOUNDS, boundGas, totalGas, type UserOpGas } from "./gas-limits";
import {
  FIRST_ENABLE_HARD_MAX_BOUNDED,
  buildCallPermissions,
  firstEnableEnvelope,
  wallShape,
} from "../../packages/core/src/index";

const CAPS = { perTradeUsdg: 25, dailyUsdg: 100, maxOpsPerDay: 48, maxDrawdownBps: 2000, ttlDays: 14 };
const ME = "0x1111111111111111111111111111111111111111" as `0x${string}`;

/**
 * Walls sized the way `first-enable-gas.test.ts` sizes them — built, then
 * counted. A stub byte count typed in by hand would be a second description of
 * the wall, and the two can drift.
 */
const wallOfWidth = (extra: number) =>
  wallShape(
    buildCallPermissions(CAPS as never, ME, {
      extraTokens: Array.from({ length: extra }, (_, i) => ({
        symbol: `T${i}`,
        address: ("0x" + (i + 0x2000).toString(16).padStart(40, "0")) as `0x${string}`,
        decimals: 18,
      })),
    } as never) as never,
  );

/**
 * SHOGUN'S WALL IS THREE SLOTS WIDER THAN THE DEFAULT, and that is the whole of
 * what the model sees. The class vault's buy, approve and factory-deploy
 * permissions cost the same 512 bytes apiece that a custom token costs, so the
 * recorded sweep (0 -> 10,932, 1 -> 11,444, 5 -> 13,492) puts this wall at
 * 12,468 bytes. Asserted rather than assumed, below.
 */
const SHOGUN_WALL = wallOfWidth(3);
const DEFAULT_WALL = wallOfWidth(0);

/**
 * TRANSCRIBED FROM THE `[gas]` LINES THEMSELVES, not from a reconstruction:
 *
 *   [gas] account NOT deployed · ENABLE 0xfa63a64e ceiling 13388275
 *         · estimate1 call 1298961 + verif 8426575 + preVerif 278291 = 10050284
 *         · estimate2 ... · signed refused (gas-absurd)                    x16
 *   ... the same with call 1307017 = 10058340                              x1
 *   ... estimate1 unreadable · estimate2 unreadable (gas-unreadable)       x2
 *
 * Seventeen successful simulations, two distinct shapes. verificationGasLimit
 * and preVerificationGas were BYTE-IDENTICAL on every one — they are the cost
 * of installing a known wall, not of a trade — and only callGasLimit moved, by
 * 8,056 gas across the whole set.
 *
 * THE PRINTED TOTALS ARE 46,457 ABOVE THE THREE FIELDS, which is how this
 * account's SPONSOR shows up: 1,298,961 + 8,426,575 + 278,291 is 10,003,827,
 * and the line says 10,050,284. `totalGas` counts the paymaster's two limits
 * because the EntryPoint's prefund counts them. The log records only their sum,
 * so the split between them is unobserved — and irrelevant, since every check
 * here either sums them or excludes both.
 */
const SPONSOR_GAS = 46_457n;
const SHOGUN: readonly UserOpGas[] = [
  { callGasLimit: 1_307_017n, verificationGasLimit: 8_426_575n, preVerificationGas: 278_291n, paymasterVerificationGasLimit: SPONSOR_GAS },
  { callGasLimit: 1_298_961n, verificationGasLimit: 8_426_575n, preVerificationGas: 278_291n, paymasterVerificationGasLimit: SPONSOR_GAS },
];

/** The ordinary first enable, from gas-limits.ts's own recorded measurement. */
const ORDINARY: UserOpGas = {
  callGasLimit: 50_180n,
  verificationGasLimit: 7_418_031n,
  preVerificationGas: 243_443n,
};

/** Exactly what executor.ts builds for a sized first enable. Kept in one place
 *  so a divergence between this file and the call site shows up as a wiring
 *  test failure rather than as a green test over a shape nothing uses. */
const firstEnableBounds = (allowedMaxBounded: bigint) => ({
  ...FIRST_ENABLE_GAS_BOUNDS,
  absoluteMax: FIRST_ENABLE_HARD_MAX_BOUNDED,
  enableMax: allowedMaxBounded,
  callMax: GAS_BOUNDS.absoluteMax,
});

/** `sponsored` follows the estimate: an operation carrying paymaster gas HAS a
 *  sponsor, and saying otherwise would refuse it as `gas-paymaster-unexpected`
 *  before any ceiling here was reached. */
const sponsoredOf = (g: UserOpGas) =>
  (g.paymasterVerificationGasLimit ?? 0n) > 0n || (g.paymasterPostOpGasLimit ?? 0n) > 0n;
const bound = (g: UserOpGas, bounds: ReturnType<typeof firstEnableBounds> | typeof GAS_BOUNDS) =>
  boundGas(g, g, bounds, sponsoredOf(g));

describe("the observed estimates, reproduced", () => {
  it("Shogun's wall is 12,468 stub bytes — the recorded default plus three slots", () => {
    assert.equal(DEFAULT_WALL.stubBytes, 10_932, "the recorded 0-token sweep point");
    assert.equal(SHOGUN_WALL.stubBytes, 12_468);
    assert.equal(SHOGUN_WALL.stubBytes - DEFAULT_WALL.stubBytes, 3 * 512);
  });

  it("the envelope predicts the WALL, and the wall fits it with room to spare", () => {
    const env = firstEnableEnvelope(SHOGUN_WALL);
    assert.equal(env.expectedRaw, 8_819_681n);
    assert.equal(env.expectedBounded, 11_156_896n);
    assert.equal(env.allowedMaxBounded, 13_388_275n);
    assert.equal(env.withinHardMax, true, "this wall was always installable");

    // The enable half — what the envelope actually predicts — against what it
    // actually cost. 2.5M of margin. The wall was never the thing over budget.
    const enablePart = (8_426_575n * 12_500n) / 10_000n + (278_291n * 12_500n) / 10_000n;
    assert.equal(enablePart, 10_881_081n);
    assert.ok(enablePart < env.allowedMaxBounded, "the wall fits its own envelope");
  });

  it("the raw totals match the `[gas]` lines exactly, sponsor gas included", () => {
    // If this drifts, the estimates above were transcribed wrong and every
    // number downstream is fiction.
    assert.equal(totalGas(SHOGUN[0]!), 10_058_340n, "the logged estimate for the 1,307,017 call");
    assert.equal(totalGas(SHOGUN[1]!), 10_050_284n, "and for the 1,298,961 call");
  });

  it("THE OLD COMPARISON REFUSED IT, and refused it under the hard maximum", () => {
    // Pinned so the defect cannot come back silently. The old bounds put the
    // model's allowance on the TOTAL — wall plus payload plus sponsor — and the
    // payload was never in the prediction.
    const env = firstEnableEnvelope(SHOGUN_WALL);
    for (const est of SHOGUN) {
      const old = boundGas(est, est, { ...FIRST_ENABLE_GAS_BOUNDS, absoluteMax: env.allowedMaxBounded }, true);
      assert.equal(old.ok, false, "this is what production did");
      assert.equal(old.ok === false ? old.rule : null, "gas-absurd");
    }
    // And the two totals it refused, both comfortably under 14,000,000.
    assert.equal(signedTotal(SHOGUN[0]!), 13_541_572n);
    assert.equal(signedTotal(SHOGUN[1]!), 13_525_460n);
    for (const est of SHOGUN) {
      assert.ok(signedTotal(est) < FIRST_ENABLE_HARD_MAX_BOUNDED, "under the hard maximum");
      assert.ok(signedTotal(est) > env.allowedMaxBounded, "over the model's allowance");
    }
    assert.equal(FIRST_ENABLE_HARD_MAX_BOUNDED - signedTotal(SHOGUN[0]!), 458_428n, "the margin that was thrown away");
  });

  it("THE NEW COMPARISON SIGNS BOTH, at the same gas it always would have", () => {
    const env = firstEnableEnvelope(SHOGUN_WALL);
    for (const [i, est] of SHOGUN.entries()) {
      const v = bound(est, firstEnableBounds(env.allowedMaxBounded));
      assert.equal(v.ok, true, `estimate ${i + 1} must be signable, got ${v.ok === false ? v.detail : ""}`);
      assert.ok(v.ok);
      // Headroom untouched: 2x on the call, 1.25x on the other two, and the
      // sponsor's own limit carried through unmultiplied.
      assert.equal(v.gas.callGasLimit, est.callGasLimit * 2n);
      assert.equal(v.gas.verificationGasLimit, 10_533_218n);
      assert.equal(v.gas.preVerificationGas, 347_863n);
      assert.equal(v.gas.paymasterVerificationGasLimit, SPONSOR_GAS);
      assert.equal(v.total, signedTotal(est));
    }
  });
});

describe("what must not regress", () => {
  it("the ordinary first enable signs for byte-identical gas", () => {
    // Every number here is pinned in gas-limits.test.ts against the same
    // measurement. If the fix moved any of them it changed what we sign, which
    // it must not.
    const env = firstEnableEnvelope(DEFAULT_WALL);
    const v = boundGas(ORDINARY, ORDINARY, firstEnableBounds(env.allowedMaxBounded), false);
    assert.ok(v.ok, v.ok === false ? v.detail : "");
    assert.equal(v.gas.callGasLimit, 100_360n);
    assert.equal(v.gas.verificationGasLimit, 9_272_538n);
    assert.equal(v.gas.preVerificationGas, 304_303n);
    assert.equal(v.total, 9_677_201n, "the arithmetic in FIRST_ENABLE_GAS_BOUNDS's comment");
  });

  it("A NARROW WALL STILL CANNOT INHERIT A WIDE WALL'S HEADROOM", () => {
    // The property the flat ceiling had and the envelope was built to keep: an
    // anomalous enable estimate for a small wall is refused by that wall's own
    // size, even though the total is nowhere near the hard maximum. Splitting
    // the comparison must not have handed it a way through.
    const env = firstEnableEnvelope(DEFAULT_WALL);
    const anomalous: UserOpGas = { ...ORDINARY, verificationGasLimit: 10_000_000n };
    assert.ok(signedTotal(anomalous) < FIRST_ENABLE_HARD_MAX_BOUNDED, "under the product cap");
    const v = boundGas(anomalous, anomalous, firstEnableBounds(env.allowedMaxBounded), false);
    assert.equal(v.ok, false, "but over THIS wall's allowance");
    assert.equal(v.ok === false ? v.rule : null, "gas-absurd");
    assert.match(v.ok === false ? v.detail : "", /permission wall/, "and it must say which ceiling");
  });

  it("A PAYLOAD NO ORDINARY OPERATION COULD MAKE IS REFUSED", () => {
    // The half that did not exist before. Judging the enable against the wall
    // would otherwise leave the call gas of a first enable bounded by nothing
    // narrower than 14,000,000.
    const env = firstEnableEnvelope(SHOGUN_WALL);
    const fat: UserOpGas = { ...SHOGUN[0]!, callGasLimit: 1_600_000n };
    const v = bound(fat, firstEnableBounds(env.allowedMaxBounded));
    assert.equal(v.ok, false, "3,200,000 of call gas is past the ordinary ceiling");
    assert.equal(v.ok === false ? v.rule : null, "gas-absurd");
    assert.match(v.ok === false ? v.detail : "", /riding along/);
  });

  it("AN ENVELOPE THAT GENUINELY EXCEEDS 14,000,000 IS STILL REFUSED", () => {
    // The property no proposal may weaken, and the hard case: this operation
    // passes BOTH narrower ceilings — its enable half fits a wide wall's
    // allowance, its payload fits the ordinary ceiling — and is caught only by
    // the product maximum, which is exactly what that maximum is for.
    const wide = firstEnableEnvelope(wallOfWidth(15));
    assert.equal(wide.allowedMaxBounded, FIRST_ENABLE_HARD_MAX_BOUNDED, "a wide wall is capped by the product");
    const huge: UserOpGas = {
      callGasLimit: 1_400_000n,
      verificationGasLimit: 10_000_000n,
      preVerificationGas: 500_000n,
    };
    const enablePart = (10_000_000n * 12_500n) / 10_000n + (500_000n * 12_500n) / 10_000n;
    assert.equal(enablePart, 13_125_000n);
    assert.ok(enablePart <= wide.allowedMaxBounded, "the enable half clears the wall's allowance");
    assert.ok(1_400_000n * 2n <= GAS_BOUNDS.absoluteMax, "and the payload clears the ordinary ceiling");
    assert.equal(signedTotal(huge), 15_925_000n, "yet the envelope genuinely exceeds 14,000,000");

    const v = boundGas(huge, huge, firstEnableBounds(wide.allowedMaxBounded), false);
    assert.equal(v.ok, false, "so it must be refused");
    assert.equal(v.ok === false ? v.rule : null, "gas-absurd");
    assert.match(v.ok === false ? v.detail : "", /14000000/, "by the hard maximum, named");
  });

  it("STEADY STATE IS UNTOUCHED: neither new ceiling exists outside an enable", () => {
    // A missing value skips the check rather than defaulting to a number — an
    // operation we were not told the wall size of is not one with a wall of
    // size zero, and every ordinary operation has no wall at all.
    assert.equal(GAS_BOUNDS.enableMax, undefined);
    assert.equal(GAS_BOUNDS.callMax, undefined);
    assert.equal(FIRST_ENABLE_GAS_BOUNDS.enableMax, undefined, "the flat fallback keeps its single ceiling");
    assert.equal(FIRST_ENABLE_GAS_BOUNDS.callMax, undefined);
    // And the ordinary ceiling still refuses the wall it always refused.
    const v = boundGas(ORDINARY, ORDINARY, GAS_BOUNDS, false);
    assert.equal(v.ok, false);
    assert.equal(v.ok === false ? v.rule : null, "gas-absurd");
  });
});

/** What `boundGas` would sign for, computed independently of it. */
function signedTotal(g: UserOpGas): bigint {
  return totalGas({
    callGasLimit: (g.callGasLimit * 20_000n) / 10_000n,
    verificationGasLimit: (g.verificationGasLimit * 12_500n) / 10_000n,
    preVerificationGas: (g.preVerificationGas * 12_500n) / 10_000n,
    // The sponsor's limits are carried, never multiplied — boundGas does the
    // same, and inflating somebody else's numbers is not ours to do.
    ...(g.paymasterVerificationGasLimit ? { paymasterVerificationGasLimit: g.paymasterVerificationGasLimit } : {}),
    ...(g.paymasterPostOpGasLimit ? { paymasterPostOpGasLimit: g.paymasterPostOpGasLimit } : {}),
  });
}
