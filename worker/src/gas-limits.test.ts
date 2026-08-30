import assert from "node:assert/strict";
import test from "node:test";
import { GAS_BOUNDS, boundGas, totalGas, type UserOpGas } from "./gas-limits";

/**
 * The gap this closes was total: no floor, no ceiling, whatever the bundler
 * returned was what got signed. These tests are about the two asymmetries that
 * make the policy the shape it is.
 */

const est = (call: bigint, ver: bigint, pre: bigint): UserOpGas => ({
  callGasLimit: call,
  verificationGasLimit: ver,
  preVerificationGas: pre,
});
const NORMAL = est(180_000n, 90_000n, 55_000n);

test("headroom is applied to every field, not just the call", () => {
  // verificationGasLimit covers the session-key signature check and the FIRST
  // op also carries enable data and account deployment — the most expensive
  // verification this account will ever do, and the one we care most about
  // not clipping.
  const v = boundGas(NORMAL, null);
  assert.ok(v.ok);
  assert.deepEqual(v.gas, est(360_000n, 180_000n, 110_000n));
  assert.equal(v.total, 650_000n);
  assert.equal(totalGas(NORMAL) * 2n, v.total);
});

test("being generous is FREE and being tight is total — so the bound is one-sided", () => {
  // A UserOp is charged for gas USED, not gas requested; the EntryPoint refunds
  // the rest. So a limit that is too high costs a slightly larger prefund, while
  // one that is too low costs the whole operation AND still charges for it.
  // Nothing here should ever reduce an estimate.
  const v = boundGas(NORMAL, null);
  assert.ok(v.ok);
  for (const k of ["callGasLimit", "verificationGasLimit", "preVerificationGas"] as const) {
    assert.ok(v.gas[k] > NORMAL[k], `${k} must never be clamped downward`);
  }
});

test("REFUSES rather than clamps when the estimate is absurd", () => {
  // Clamping would submit an operation we have positively decided is
  // under-provisioned — the OOG case, on purpose. An approve plus an
  // exactInputSingle does not approach 3M, so crossing it means this is not the
  // operation we think it is.
  const v = boundGas(est(2_000_000n, 500_000n, 100_000n), null);
  assert.equal(v.ok, false);
  assert.equal(v.rule, "gas-absurd");
  assert.match(v.detail, /nothing was spent/i);
});

test("two estimates far apart is a refusal — the estimator disagreeing with itself", () => {
  // Vex re-estimated one unchanged calldata across twelve consecutive blocks and
  // got 804,028-1,660,619, a 2.07x spread. Their four mined-reverted swaps had
  // burned ~97.3% of their limit with zero logs. 4x is the line past which
  // neither figure is one to sign against.
  const v = boundGas(est(100_000n, 50_000n, 25_000n), est(500_000n, 250_000n, 125_000n));
  assert.equal(v.ok, false);
  assert.equal(v.rule, "gas-unstable");
});

test("a normal spread between two estimates is fine, and bounds against the HIGHER", () => {
  // The cheap one may be the wrong one, and headroom is the direction where
  // being wrong is free.
  const lo = est(100_000n, 50_000n, 25_000n);
  const hi = est(150_000n, 75_000n, 30_000n);
  const a = boundGas(lo, hi);
  const b = boundGas(hi, lo);
  assert.ok(a.ok && b.ok);
  assert.deepEqual(a.gas, b.gas, "order must not matter");
  assert.equal(a.total, totalGas(hi) * 2n);
});

test("instability is judged on the TOTAL, because the fields trade off", () => {
  // Verification moving into preVerification between estimator versions is a
  // re-attribution, not instability — and the total is what the account posts a
  // prefund against. Per-field comparison would refuse this, wrongly.
  const a = est(200_000n, 150_000n, 20_000n);
  const b = est(200_000n, 20_000n, 150_000n);
  assert.equal(totalGas(a), totalGas(b));
  assert.equal(boundGas(a, b).ok, true);
});

test("A REFUSAL TO QUOTE IS NOT A QUOTE OF ZERO", () => {
  // The same conflation delivery.ts refuses to make about a balance. Signing
  // limits we invented is precisely the OOG this file exists to prevent.
  const v = boundGas(null, null);
  assert.equal(v.ok, false);
  assert.equal(v.rule, "gas-unreadable");
  assert.match(v.detail, /not a quote of zero/i);
});

test("a zero or negative field is not an estimate either", () => {
  // The shape a malformed RPC reply takes, and signing it guarantees the OOG.
  for (const bad of [est(0n, 90_000n, 55_000n), est(180_000n, -1n, 55_000n), est(180_000n, 90_000n, 0n)]) {
    const v = boundGas(bad, null);
    assert.equal(v.ok, false, "must not be treated as a very cheap operation");
    assert.equal(v.rule, "gas-unreadable");
  }
});

test("the disagreement check is SKIPPED, never assumed, when there is one estimate", () => {
  // A check that did not run must not read as one that passed. With a single
  // estimate the verdict is ok on the headroom alone — and gas-unstable is
  // simply unreachable, rather than silently satisfied.
  const v = boundGas(est(100_000n, 50_000n, 25_000n), null);
  assert.ok(v.ok);
  assert.equal(v.total, 350_000n);
});

test("the bounds are the numbers the comments claim", () => {
  assert.equal(GAS_BOUNDS.headroomBps, 20_000, "2x");
  assert.equal(GAS_BOUNDS.disagreementBps, 40_000, "4x");
  assert.equal(GAS_BOUNDS.absoluteMax, 3_000_000n);
  assert.ok(GAS_BOUNDS.disagreementBps > GAS_BOUNDS.headroomBps, "a refusal must be looser than the headroom it guards");
});

test("REGRESSION: a zero field in the SECOND estimate is caught too", () => {
  // The guard checked `first` only, and boundGas then reassigns
  // `first = second` whenever the second total is higher. So a zero
  // callGasLimit riding in on an otherwise-inflated second estimate was signed
  // unchecked — an op that passes validation and prefund, runs out of gas in
  // the inner call, and is charged in full. Exactly the indistinguishable OOG
  // this module exists to prevent, produced by the guard against it.
  //
  // These numbers are the reviewer's: 175,000 vs 600,000 is 3.43x, UNDER the 4x
  // disagreement line, so nothing else would have caught it.
  const good = est(100_000n, 50_000n, 25_000n);
  const zeroBearing = est(0n, 400_000n, 200_000n);
  assert.equal(totalGas(zeroBearing) <= totalGas(good) * 4n, true, "under the disagreement line, as the scenario requires");

  const v = boundGas(good, zeroBearing);
  assert.equal(v.ok, false, "must not be signed");
  assert.equal(v.rule, "gas-unreadable");
  // And in the other order, since which call returns the zero is chance.
  assert.equal(boundGas(zeroBearing, good).ok, false);
});

test("REGRESSION: the zero check runs BEFORE the disagreement math", () => {
  // A zero field also skews the total that the 4x test compares, so validating
  // first is what makes that comparison trustworthy rather than incidentally
  // correct. A zero-bearing pair far apart must read as unreadable, not unstable
  // — the honest answer is "that is not an estimate", not "they disagree".
  const v = boundGas(est(0n, 10n, 10n), est(900_000n, 900_000n, 900_000n));
  assert.equal(v.ok, false);
  assert.equal(v.rule, "gas-unreadable", "not 'gas-unstable'");
});
