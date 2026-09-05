import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  FIRST_ENABLE_GAS_BOUNDS,
  GAS_BOUNDS,
  boundGas,
  checkPrefund,
  totalGas,
  type UserOpGas,
} from "./gas-limits";
import {
  isFirstEnable,
  nonceSequence,
  noncePermissionId,
  readEnableState,
  type EnableState,
} from "./executor";

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
  //
  // Every field still gets headroom. What changed in Stage E is HOW MUCH: the
  // blanket 2x below was measured to be the entire reason a real first
  // operation was refused, and the per-field figures are justified on
  // GAS_BOUNDS. The invariant this test defends — no field goes unpadded — is
  // unchanged.
  const v = boundGas(NORMAL, null);
  assert.ok(v.ok);
  assert.deepEqual(v.gas, est(360_000n, 112_500n, 68_750n));
  assert.equal(v.total, 541_250n);
  for (const [field, raw] of Object.entries(NORMAL) as [keyof UserOpGas, bigint][]) {
    assert.ok(v.gas[field]! > raw, `${field} must be padded, not passed through`);
  }
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
  // The higher estimate, padded per field: 300,000 + 93,750 + 37,500.
  assert.equal(a.total, 431_250n);
  assert.ok(a.total > totalGas(hi), "and it is the higher one that was padded");
  assert.ok(a.total > totalGas(lo) * 2n, "not merely the lower one doubled");
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
  assert.equal(v.total, 293_750n); // 200,000 + 62,500 + 31,250
});

test("the bounds are the numbers the comments claim", () => {
  assert.equal(GAS_BOUNDS.callHeadroomBps, 20_000, "2x");
  assert.equal(GAS_BOUNDS.verificationHeadroomBps, 12_500, "1.25x");
  assert.equal(GAS_BOUNDS.preVerificationHeadroomBps, 12_500, "1.25x");
  assert.equal(GAS_BOUNDS.disagreementBps, 40_000, "4x");
  assert.equal(GAS_BOUNDS.absoluteMax, 3_000_000n);
  assert.ok(
    GAS_BOUNDS.disagreementBps > GAS_BOUNDS.callHeadroomBps,
    "a refusal must be looser than the widest headroom it guards",
  );
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

// ────────────────────────────────────────────────────────────────────────────
// STAGE E. The first operation of a merrymen account installs the entire policy
// wall inside validation, and the blanket 2x headroom turned a 7,711,654-gas
// operation into a 15,423,308-gas refusal — on the one operation in an
// account's life that has to succeed. These pin what changed and what did not.
// ────────────────────────────────────────────────────────────────────────────

/** The measured first-enable estimate. Pimlico, chain 4663, 2026-09-03. */
const MEASURED_WALL = est(50_180n, 7_418_031n, 243_443n);

test("callGasLimit gets 2x, and it is the only field that does", () => {
  // The asymmetry is the point. callGasLimit too low OOGs the call, success is
  // false, and THE ACCOUNT PAYS IN FULL. The other two fail during validation,
  // before the op enters a bundle, and cost nothing.
  const v = boundGas(est(100_000n, 200_000n, 40_000n), null);
  assert.ok(v.ok);
  assert.equal(v.gas.callGasLimit, 200_000n, "2x");
});

test("verification and preVerification get 1.25x, not 2x", () => {
  const v = boundGas(est(100_000n, 200_000n, 40_000n), null);
  assert.ok(v.ok);
  assert.equal(v.gas.verificationGasLimit, 250_000n, "1.25x");
  assert.equal(v.gas.preVerificationGas, 50_000n, "1.25x");
  // Pinned as a comparison too, so an edit that sets all three equal fails here
  // rather than quietly restoring the bug.
  assert.ok(
    GAS_BOUNDS.verificationHeadroomBps < GAS_BOUNDS.callHeadroomBps,
    "verification is deterministic given fixed calldata; the call is not",
  );
});

test("THE 18-PERMISSION WALL PASSES. This is the operation that was refused.", () => {
  const v = boundGas(MEASURED_WALL, MEASURED_WALL, FIRST_ENABLE_GAS_BOUNDS);
  assert.equal(v.ok, true, "the measured full wall must be signable");
  assert.ok(v.ok);
  assert.equal(v.gas.callGasLimit, 100_360n);
  assert.equal(v.gas.verificationGasLimit, 9_272_538n);
  assert.equal(v.gas.preVerificationGas, 304_303n);
  assert.equal(v.total, 9_677_201n, "the arithmetic in the constant's comment");

  // The same estimate under the OLD blanket 2x is still refused, so the
  // per-field headroom did the work — not the ceiling on its own.
  const blanket2x = totalGas(MEASURED_WALL) * 2n;
  assert.equal(blanket2x, 15_423_308n);
  assert.ok(blanket2x > FIRST_ENABLE_GAS_BOUNDS.absoluteMax, "15.4M is past 12M");
});

test("THE FIRST-ENABLE CEILING IS DERIVED, not chosen", () => {
  // Every term of the comment, recomputed. Widen the ceiling without widening
  // the justification and this fails.
  const bounded = 9_677_201n; // asserted above
  const perExtraToken = 462_874n; // measured ~370,299 raw x 1.25
  const withMargin = bounded + 5n * perExtraToken;
  assert.equal(withMargin, 11_991_571n);
  assert.equal(FIRST_ENABLE_GAS_BOUNDS.absoluteMax, 12_000_000n);
  assert.ok(
    FIRST_ENABLE_GAS_BOUNDS.absoluteMax >= withMargin,
    "the ceiling must cover the margin it claims",
  );
  assert.ok(
    FIRST_ENABLE_GAS_BOUNDS.absoluteMax - withMargin < perExtraToken,
    "and must not quietly exceed it by another token's worth",
  );
  // ONLY the ceiling moved. A first op gets the same headroom as any other.
  assert.equal(FIRST_ENABLE_GAS_BOUNDS.callHeadroomBps, GAS_BOUNDS.callHeadroomBps);
  assert.equal(FIRST_ENABLE_GAS_BOUNDS.verificationHeadroomBps, GAS_BOUNDS.verificationHeadroomBps);
  assert.equal(
    FIRST_ENABLE_GAS_BOUNDS.preVerificationHeadroomBps,
    GAS_BOUNDS.preVerificationHeadroomBps,
  );
  assert.equal(FIRST_ENABLE_GAS_BOUNDS.disagreementBps, GAS_BOUNDS.disagreementBps);
});

test("THE ORDINARY CEILING DID NOT MOVE. An op that is not an enable cannot reach 12M.", () => {
  assert.equal(GAS_BOUNDS.absoluteMax, 3_000_000n, "unchanged by Stage E");
  // The same measured wall, offered the ordinary bounds, is refused.
  const v = boundGas(MEASURED_WALL, MEASURED_WALL);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false ? v.rule : null, "gas-absurd");
});

test("the first-enable ceiling is a CEILING, not an exemption", () => {
  // 12M is not "safe because it is large". An operation past it is as suspect
  // on the first op as on the thousandth.
  const absurd = est(3_000_000n, 8_000_000n, 3_000_000n);
  const v = boundGas(absurd, absurd, FIRST_ENABLE_GAS_BOUNDS);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false ? v.rule : null, "gas-absurd");
});

test("PAYMASTER GAS CANNOT WALK UNDER THE CEILING", () => {
  // paymaster.ts allows up to 500,000 in each of these, and totalGas counted
  // neither — so up to a million gas of prefund sat outside every bound in this
  // file. The EntryPoint's prefund counts them; now so do we.
  const withPm: UserOpGas = {
    ...est(400_000n, 600_000n, 100_000n), // bounded: 800k + 750k + 125k = 1.675M
    paymasterVerificationGasLimit: 500_000n,
    paymasterPostOpGasLimit: 500_000n,
  };
  assert.equal(totalGas(withPm), 2_100_000n, "totalGas sees the paymaster fields");

  // Sponsored: admitted, counted, and NOT multiplied — they are the sponsor's
  // numbers, bounded by paymaster.ts, and inflating them is not ours to do.
  const ok = boundGas(withPm, withPm, GAS_BOUNDS, true);
  assert.ok(ok.ok);
  assert.equal(ok.gas.paymasterVerificationGasLimit, 500_000n, "carried, never inflated");
  assert.equal(ok.gas.paymasterPostOpGasLimit, 500_000n);
  assert.equal(ok.total, 2_675_000n, "1.675M of ours plus 1M of theirs");

  // And the ceiling is enforced against the total INCLUDING them: the same
  // three fields alone clear 3M, and refuse once the sponsor's are counted.
  const ours = est(600_000n, 800_000n, 160_000n); // bounded 1.2M + 1M + 200k = 2.4M
  assert.equal(boundGas(ours, ours).ok, true, "2.4M alone clears the 3M ceiling");
  const big: UserOpGas = {
    ...ours,
    paymasterVerificationGasLimit: 500_000n,
    paymasterPostOpGasLimit: 500_000n,
  };
  const refused = boundGas(big, big, GAS_BOUNDS, true);
  assert.equal(refused.ok, false, "3.4M does not");
  assert.equal(refused.ok === false ? refused.rule : null, "gas-absurd");
});

test("a paymaster on a SELF-PAYING operation is refused, not ignored", () => {
  // The other half of "include them or prove they are absent". If nobody asked
  // a sponsor to pay and the estimate returns paymaster gas, the operation
  // being priced is not the operation about to be signed.
  const withPm: UserOpGas = {
    ...est(100_000n, 100_000n, 40_000n),
    paymasterVerificationGasLimit: 1n,
  };
  const v = boundGas(withPm, withPm);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false ? v.rule : null, "gas-paymaster-unexpected");
  // The default is the strict reading, so a caller that forgets to say gets it.
  assert.equal(boundGas(withPm, withPm, GAS_BOUNDS, true).ok, true, "sponsored is fine");
});

// ── FAIL CLOSED ON EXECUTION STATE ──────────────────────────────────────────

test("isFirstEnable reads the operation's own nonce, and needs BOTH bytes", () => {
  // Kernel v3 packs mode(1) vType(1) validator(20) id(2) seq(8). Measured on
  // 4663: a walled account's first nonce is 0x0102…, a sudo-only one 0x0000….
  const walled = 0x0102630974640000000000000000000000000000000000000000000000000000n;
  const sudoOnly = 0x0000845adb2c0000000000000000000000000000000000000000000000000000n;
  assert.equal(isFirstEnable(walled), true, "mode ENABLE, type PERMISSION");
  assert.equal(isFirstEnable(sudoOnly), false, "mode DEFAULT is not an enable");

  // Mode alone is not enough: an enable of some OTHER validator type is not the
  // operation this ceiling was measured for.
  const enableOfSudo = 0x0100000000000000000000000000000000000000000000000000000000000000n;
  assert.equal(isFirstEnable(enableOfSudo), false, "an enable, but not of a permission validator");
  // And an ALREADY-INSTALLED permission validator — mode DEFAULT, type
  // PERMISSION — is the steady state, every op after the first.
  const installed = 0x0002000000000000000000000000000000000000000000000000000000000000n;
  assert.equal(isFirstEnable(installed), false, "installed is not enabling");
  // The sequence bytes must not change the answer either way.
  assert.equal(isFirstEnable(walled + 7n), true, "the sequence is not consulted");
});

// ── A RENEWAL IS AN ENABLE ON AN ACCOUNT THAT ALREADY HAS CODE ──────────────
//
// The gate was '!accountLive && isFirstEnable(nonce)', on the belief that a
// validator enable is one-time per ACCOUNT. It is one-time per SESSION KEY.
// Measured on 4663, 2026-09-03: a renewal on a deployed account costs 96-98% of
// the undeployed first op, so every one-click renewal was routed through the
// 3,000,000 ceiling and refused.
// ────────────────────────────────────────────────────────────────────────────

/** Measured nonces. Real ids, so no fixture can stand in for another. */
const FIRST_ARM = 0x0102acff75890000000000000000000000000000000000000000000000000000n;
const RENEWAL = 0x01023ca1cec80000000000000000000000000000000000000000000000000000n;
const LANDED_ENABLE = 0x01023ca1cec80000000000000000000000000000000000000000000000000001n;
const STEADY_STATE = 0x00023ca1cec80000000000000000000000000000000000000000000000000004n;

/** Measured on the deployed accounts, in raw bundler figures. */
const MEASURED_RENEWAL = est(50_180n, 7_279_603n, 240_042n);
const MEASURED_RENEWAL_CHEAPEST = est(50_180n, 7_111_512n, 239_988n);

const ADDR = "0x032Da6A0Ccf866474e45854E7fDEF9afd1509036" as `0x${string}`;

/** A fake chain. word0 offset, word1 flag, word2 signer — the real layout. */
function chain(opts: { code?: string; signer?: string; codeThrows?: boolean; callThrows?: boolean; short?: boolean }) {
  return {
    async getCode() {
      if (opts.codeThrows) throw new Error("connection reset");
      return (opts.code ?? "0x") as `0x${string}` | undefined;
    },
    async call() {
      if (opts.callThrows) throw new Error("429 Rate Limit Hit");
      if (opts.short) return { data: "0x1234" as `0x${string}` };
      const signer = (opts.signer ?? "0x" + "0".repeat(40)).slice(2).padStart(64, "0");
      return { data: ("0x" + "20".padStart(64, "0") + "2".padStart(64, "0") + signer) as `0x${string}` };
    },
  };
}

test("THE RENEWAL CASE: a deployed account enabling a NEW key gets the wide ceiling", async () => {
  // The account has code and the id is absent — which is exactly a renewal.
  const state = await readEnableState(chain({ code: "0x" + "ef".repeat(61) }), ADDR, RENEWAL);
  assert.equal(state.kind, "fresh-enable");

  // And the measured renewal fits. Under GAS_BOUNDS it would not have.
  const wide = boundGas(MEASURED_RENEWAL, MEASURED_RENEWAL, FIRST_ENABLE_GAS_BOUNDS);
  assert.equal(wide.ok, true, "a renewal must be signable");
  assert.ok(wide.ok);
  assert.equal(wide.total, 9_499_915n);
  const narrow = boundGas(MEASURED_RENEWAL, MEASURED_RENEWAL);
  assert.equal(narrow.ok, false, "the old gate sent it here");
  assert.equal(narrow.ok === false ? narrow.rule : null, "gas-absurd");

  // Both measured deployed accounts, not just the dearest.
  const cheap = boundGas(MEASURED_RENEWAL_CHEAPEST, MEASURED_RENEWAL_CHEAPEST, FIRST_ENABLE_GAS_BOUNDS);
  assert.equal(cheap.ok, true);
});

test("the renewal is CHEAPER than the first arm, so 12M still binds on the first arm", () => {
  // The constant was derived from the undeployed case. This proves that is the
  // larger of the two, which is why the derivation did not have to change.
  const arm = boundGas(MEASURED_WALL, null, FIRST_ENABLE_GAS_BOUNDS);
  const renew = boundGas(MEASURED_RENEWAL, null, FIRST_ENABLE_GAS_BOUNDS);
  assert.ok(arm.ok && renew.ok);
  assert.ok(renew.total < arm.total, "deployment is worth something, just not much");
  assert.ok(arm.total - renew.total < 200_000n, "and what it is worth is a rounding error");
  assert.equal(arm.total, 9_677_201n, "the number in the constant's comment");
});

test("THE STEADY STATE IS UNTOUCHED: an installed validator is not an enable", async () => {
  // Mode 0x00. The wide ceiling is not even considered, which is the property
  // that makes dropping '!accountLive' safe.
  assert.equal(isFirstEnable(STEADY_STATE), false);
  const state = await readEnableState(chain({ code: "0xef" }), ADDR, STEADY_STATE);
  assert.equal(state.kind, "not-an-enable");
});

test("FAIL CLOSED: an enable we cannot verify is REFUSED, never widened", async () => {
  // @zerodev's isPluginEnabled catches every read error to false, so one flaky
  // eth_call produces an ENABLE-shaped op for an already-installed validator.
  // On the nonce alone that would have been handed 12,000,000.
  const installed = await readEnableState(
    chain({ code: "0xef", signer: "0x6a6f069e2a08c2468e7724ab3250cdbfba14d4ff" }),
    ADDR,
    RENEWAL,
  );
  assert.equal(installed.kind, "already-installed");

  // A read we could not make is its own answer, and it is not "fresh".
  for (const broken of [chain({ code: "0xef", callThrows: true }), chain({ codeThrows: true }), chain({ code: "0xef", short: true })]) {
    const state = await readEnableState(broken, ADDR, RENEWAL);
    assert.equal(state.kind, "unreadable", "an unreadable chain must not widen a ceiling");
  }

  // This INVERTS isDeployed's rule, deliberately: there a failed read answers
  // "not deployed" because that only ever narrowed. Here "no code" widens.
  const src = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.match(src, /INVERTS the rule isDeployed uses/, "and the inversion is explained where it happens");
});

test("an enable that already LANDED is refused, and the EntryPoint is the witness", async () => {
  // The sequence is the one part of the nonce nothing local chooses — the
  // EntryPoint increments it only on INCLUSION. Measured on 4663: a landed
  // enable key reads 1 forever; one that never landed reads 0.
  assert.equal(nonceSequence(LANDED_ENABLE), 1n);
  assert.equal(nonceSequence(RENEWAL), 0n);
  const state = await readEnableState(chain({ code: "0xef" }), ADDR, LANDED_ENABLE);
  assert.equal(state.kind, "replayed-enable");
  // So the wide ceiling admits at most ONE included operation per (account, id),
  // without any ledger to go stale.
});

test("an UNDEPLOYED first arm still gets the wide ceiling — the fix did not trade one for the other", async () => {
  const state = await readEnableState(chain({ code: "0x" }), ADDR, FIRST_ARM);
  assert.equal(state.kind, "fresh-enable");
  assert.equal(state.kind === "fresh-enable" ? state.permissionId : null, "0xacff7589");
});

test("THE PERMISSION ID IS BYTES 2..5, and the off-by-two would be a no-op gate", () => {
  // Verified against a landed enable on 4663: nonce 0x01023ca1cec8…0001 is the
  // operation that installed 0x3ca1cec8.
  assert.equal(noncePermissionId(LANDED_ENABLE), "0x3ca1cec8");
  // Shifting by 224 returns the mode and type bytes glued to half the id — an id
  // no operation will ever present, so permissionConfig would answer "absent"
  // for everything and the check would always pass. Pin the trap.
  const trap = "0x" + (((LANDED_ENABLE >> 224n) & 0xffffffffn).toString(16).padStart(8, "0"));
  assert.equal(trap, "0x01023ca1");
  assert.notEqual(noncePermissionId(LANDED_ENABLE), trap);
});

test("THE CALL SITE: the ceiling is keyed on the OPERATION, and the deploy state does not vote", () => {
  const src = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.match(src, /const enable = await readEnableState\(/, "the chain is asked");
  assert.match(src, /const firstEnable = enable\.kind === "fresh-enable";/, "and only one answer widens");
  assert.match(src, /firstEnable \? FIRST_ENABLE_GAS_BOUNDS : GAS_BOUNDS/, "anything else gets the ordinary ceiling");
  // Asserted against CODE, not prose. The comment above readEnableState names
  // the old condition on purpose — a fix that erases the record of what it fixed
  // invites the next person to reinstate it.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /!accountLive/, "the deploy state must not gate the ceiling");
  assert.doesNotMatch(code, /accountLive &&|&& accountLive/, "nor in any conjunction");
  assert.doesNotMatch(code, /DEPLOY_GAS_BOUNDS/, "the undeployed-only ceiling is gone");
  assert.match(src, /!accountLive && isFirstEnable\(nonce\)/, "and the old gate is on the record");

  // THE STRONG FORM: every READ of accountLive must be inside the log line.
  // Counting occurrences would pin the wrong thing and break on a reword; this
  // breaks only if the deploy state starts deciding something again.
  const at = src.indexOf("[gas] account");
  const log = src.slice(src.lastIndexOf("console.log(", at), src.indexOf(");", at) + 2);
  const outside = src.replace(log, "");
  assert.doesNotMatch(outside.slice(outside.indexOf("const accountLive")+20), /accountLive/, "accountLive is a label, not a guard");

  // And each refusal exists by name, so a renewal never presents as an RPC fault.
  for (const rule of ["enable-replayed", "enable-redundant", "enable-unverified"]) {
    assert.ok(src.includes('"' + rule + '"'), rule + " must be a named refusal");
  }
  assert.match(src, /deployed = true;/, "a landed send must still retire the memo");
});

// ── THE OVERRIDE IS A PARAMETER OF ONE RPC CALL ─────────────────────────────

test("stateOverride appears ONLY on the estimation request", () => {
  const src = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.equal([...src.matchAll(/stateOverride:/g)].length, 1, "exactly one use");

  // And it is inside the estimate call's own argument object.
  const at = src.indexOf("estimateUserOperationGas({");
  assert.ok(at > 0, "the estimate call is where we think it is");
  const call = src.slice(at, src.indexOf("})) as Partial<UserOpGas>", at));
  assert.match(call, /stateOverride:/, "the override is an argument of the estimate");

  // Nowhere near the send. If it ever migrates there, this fails.
  const sendAt = src.indexOf("sendUserOperation(");
  assert.ok(sendAt > at, "the send comes after the estimate");
  assert.doesNotMatch(src.slice(sendAt), /stateOverride/, "never on the send");
});

test("the balance override cannot reach the UserOperation, signed or otherwise", () => {
  // A state override is a parameter of eth_estimateUserOperationGas — it is not
  // a field of a UserOperation, so it cannot be signed, hashed or broadcast.
  // What is provable here is that our own code never lets the value travel.
  const src = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.match(src, /balance: bounds\.absoluteMax \* simulationFee \* 2n/, "computed in one place");
  assert.doesNotMatch(
    src,
    /const\s+\w*[Bb]alance\w*\s*=\s*bounds\.absoluteMax/,
    "the override balance is not hoisted into a variable that could travel",
  );
  // feeCeiling exists to size the override and to price the prefund CHECK. It
  // must never appear in what we sign.
  const send = src.slice(src.indexOf("sendUserOperation("));
  assert.doesNotMatch(send, /simulationFee/, "the override's fee never prices the real op");
  assert.doesNotMatch(send, /bounds\.absoluteMax/, "nor does the ceiling");
});

// ── THE PREFUND CHECK, AND THE FEE THAT PRICES IT ───────────────────────────
//
// One variable used to size the estimation override AND price this refusal. The
// fallback that makes the override safe — 5 gwei, about 11x the live rate on
// 4663 — would have demanded roughly ten times the ETH an operation needs, and
// reported funded accounts as short.
// ────────────────────────────────────────────────────────────────────────────

/** Measured on 4663, 2026-09-03: base 0.4516 gwei, so a signed fee near 0.9033. */
const REAL_FEE = 903_284_000n;
const FALLBACK_FEE = 5_000_000_000n; // what the SIMULATION may use, and this may not
const WALL_GAS = est(100_360n, 9_272_538n, 304_303n); // the bounded first enable
const REQUIRED_AT_REAL = totalGas(WALL_GAS) * REAL_FEE;

test("THE SPLIT: a funded account is not refused merely because the SIMULATION fee is generous", () => {
  // The case that made this change necessary. The account holds enough for the
  // fee its operation will actually carry, and nowhere near enough for the
  // conservative fallback. Pricing the refusal from the fallback rejects it.
  const held = REQUIRED_AT_REAL + 1n;

  const honest = checkPrefund({ gas: WALL_GAS, maxFeePerGas: REAL_FEE, balance: held, deposit: 0n });
  assert.equal(honest.ok, true, "the operation it is about to sign is affordable");

  // And the arithmetic of what the old shared variable would have demanded.
  const wouldHaveDemanded = totalGas(WALL_GAS) * FALLBACK_FEE;
  assert.ok(wouldHaveDemanded > held * 5n, "the fallback demands over 5x what the account holds");
  const cruel = checkPrefund({ gas: WALL_GAS, maxFeePerGas: FALLBACK_FEE, balance: held, deposit: 0n });
  assert.equal(cruel.ok, false, "priced from the fallback, the same account is 'short'");
});

test("A FAILED FEE RPC DOES NOT PRODUCE A prefund-short", () => {
  // The specific failure the split is for. When the fee cannot be known, the
  // honest answer is that WE could not check — not that the ACCOUNT is short.
  // A wealthy account must not be slandered by our own broken read.
  const rich = checkPrefund({
    gas: WALL_GAS,
    maxFeePerGas: null,
    balance: 10n ** 21n, // 1000 ETH
    deposit: 0n,
  });
  assert.equal(rich.ok, false);
  assert.equal(rich.ok === false ? rich.rule : null, "prefund-unverified");
  assert.notEqual(rich.ok === false ? rich.rule : null, "prefund-short");
  assert.match(rich.ok === false ? rich.detail : "", /could demand many times/);

  // Zero is not a fee either — at 0 wei/gas everything is affordable.
  const zero = checkPrefund({ gas: WALL_GAS, maxFeePerGas: 0n, balance: 0n, deposit: 0n });
  assert.equal(zero.ok === false ? zero.rule : null, "prefund-unverified", "a zero fee is not free gas");
});

test("THE SIMULATION KEEPS ITS GENEROUS FALLBACK — the two fees are separate variables", () => {
  const src = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  // The override is still sized generously, and still from its own number.
  assert.match(src, /const SIMULATION_FEE_FALLBACK = 5_000_000_000n;/, "the conservative fallback stays");
  assert.match(
    src,
    /balance: bounds\.absoluteMax \* simulationFee \* 2n/,
    "and it is what sizes the override",
  );
  // The refusal is priced from the PREPARED operation, never from that number.
  assert.match(src, /maxFeePerGas: typeof preparedFee === "bigint" \? preparedFee : null/);
  assert.doesNotMatch(src, /feeCeiling/, "the shared variable is gone");
  // The two must never be the same identifier again.
  const check = src.slice(src.indexOf("const prefund = checkPrefund("), src.indexOf("const signature ="));
  assert.doesNotMatch(check, /simulationFee|SIMULATION_FEE_FALLBACK/, "the simulation fee cannot price a refusal");
});

test("the check runs AFTER prepare and BEFORE any signature", () => {
  // Its whole value is the fee being the signed fee, which only exists after
  // prepareUserOperation — and its whole safety is running before signing.
  const src = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  const prepareAt = src.indexOf("await client.prepareUserOperation(");
  const checkAt = src.indexOf("const prefund = checkPrefund(");
  const signAt = src.indexOf("await account.signUserOperation(");
  const sendAt = src.indexOf("await client.sendUserOperation(");
  assert.ok(prepareAt > 0 && checkAt > 0 && signAt > 0 && sendAt > 0, "all four exist");
  assert.ok(checkAt > prepareAt, "priced from the prepared operation");
  assert.ok(checkAt < signAt, "and nothing is signed by a check that refuses");
  assert.ok(signAt < sendAt);
});

test("A DEPOSIT COUNTS. An account that pre-funded the EntryPoint is not short.", () => {
  // The EntryPoint charges the sender's DEPOSIT and only pulls from the balance
  // for the shortfall. Reading the balance alone would refuse an operation the
  // chain would have accepted.
  const onDeposit = checkPrefund({
    gas: WALL_GAS,
    maxFeePerGas: REAL_FEE,
    balance: 0n,
    deposit: REQUIRED_AT_REAL,
  });
  assert.equal(onDeposit.ok, true, "fully deposited, empty wallet, still fine");

  const split = checkPrefund({
    gas: WALL_GAS,
    maxFeePerGas: REAL_FEE,
    balance: REQUIRED_AT_REAL / 2n,
    deposit: REQUIRED_AT_REAL - REQUIRED_AT_REAL / 2n,
  });
  assert.equal(split.ok, true, "and the two halves add up");
});

test("a genuinely short account is told BY HOW MUCH, and that it is liquidity not price", () => {
  // 0.000445 ETH — what 0x032Da6A0… actually held on 2026-09-03.
  const held = 445_000_000_000_000n;
  const short = checkPrefund({ gas: WALL_GAS, maxFeePerGas: REAL_FEE, balance: held, deposit: 0n });
  assert.ok(short.ok === false && short.rule === "prefund-short", "genuinely short");
  assert.equal(short.required, REQUIRED_AT_REAL);
  assert.equal(short.covered, held);
  assert.ok(short.detail.includes(String(REQUIRED_AT_REAL - held)), "the exact shortfall, in wei");
  assert.match(
    short.detail,
    /charged only for the gas it USES/,
    "an owner must not read this as the cost of a trade",
  );
});

test("AN UNREADABLE BALANCE OR DEPOSIT FAILS CLOSED, and says which it could not read", () => {
  // "Could not read" is never "is zero" — a zero balance would be reported as a
  // shortfall against an account that may be perfectly funded.
  for (const [balance, deposit, word] of [
    [null, 0n, /balance could not be read/],
    [0n, null, /deposit could not be read/],
    [null, null, /balance and deposit could not be read/],
  ] as [bigint | null, bigint | null, RegExp][]) {
    const v = checkPrefund({ gas: WALL_GAS, maxFeePerGas: REAL_FEE, balance, deposit });
    assert.equal(v.ok, false);
    assert.equal(v.ok === false ? v.rule : null, "prefund-unverified");
    assert.match(v.ok === false ? v.detail : "", word);
  }
});

test("no gas figures means nothing to price — refused, not waved through", () => {
  const v = checkPrefund({ gas: null, maxFeePerGas: REAL_FEE, balance: 0n, deposit: 0n });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false ? v.rule : null, "prefund-unverified");
});

test("the requirement counts the PAYMASTER fields too, because the EntryPoint does", () => {
  const withPm: UserOpGas = { ...WALL_GAS, paymasterVerificationGasLimit: 500_000n, paymasterPostOpGasLimit: 500_000n };
  const v = checkPrefund({ gas: withPm, maxFeePerGas: REAL_FEE, balance: REQUIRED_AT_REAL, deposit: 0n });
  assert.ok(v.ok === false && v.rule === "prefund-short", "a million gas of sponsor limits is a million gas of prefund");
  assert.equal(v.required, (totalGas(WALL_GAS) + 1_000_000n) * REAL_FEE);
});


test("A ZERO PAYMASTER FIELD IS AN ANSWER, NOT A MISSING ESTIMATE", () => {
  // Measured live on 4663, 2026-09-03. The canary's first enable estimated
  // cleanly — call 203,258 + verif 7,447,694 + preVerif 247,647 — and was
  // refused `gas-unreadable` because the bundler returned 0 for
  // paymasterVerificationGasLimit. An unsponsored operation HAS no paymaster,
  // so zero there is the truth. The zero-guard iterated every field of
  // UserOpGas, which was correct when UserOpGas had exactly three.
  const measured: UserOpGas = {
    callGasLimit: 203_258n,
    verificationGasLimit: 7_447_694n,
    preVerificationGas: 247_647n,
    paymasterVerificationGasLimit: 0n,
    paymasterPostOpGasLimit: 0n,
  };
  const v = boundGas(measured, measured, FIRST_ENABLE_GAS_BOUNDS);
  assert.ok(v.ok, `the real first enable must be signable, got ${v.ok === false ? v.rule : ""}`);
  assert.equal(v.total, 10_025_691n, "406,516 + 9,309,617 + 309,558");
  assert.ok(v.total < FIRST_ENABLE_GAS_BOUNDS.absoluteMax, "and it clears the derived ceiling");

  // THE GUARD KEEPS ITS FULL STRENGTH where it earns it: a zero in any of the
  // three real limits is still unreadable, because a zero callGasLimit
  // guarantees the OOG this file exists to prevent.
  for (const field of ["callGasLimit", "verificationGasLimit", "preVerificationGas"] as const) {
    const bad = { ...measured, [field]: 0n };
    const r = boundGas(bad, bad, FIRST_ENABLE_GAS_BOUNDS);
    assert.equal(r.ok, false, `a zero ${field} must still be refused`);
    assert.equal(r.ok === false ? r.rule : null, "gas-unreadable");
  }

  // And the direction that can actually hide prefund is still refused: a
  // NONZERO paymaster on a self-paying operation.
  const sneaky = { ...measured, paymasterVerificationGasLimit: 1n };
  const s = boundGas(sneaky, sneaky, FIRST_ENABLE_GAS_BOUNDS);
  assert.equal(s.ok, false);
  assert.equal(s.ok === false ? s.rule : null, "gas-paymaster-unexpected");
});
