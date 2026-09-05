/**
 * PROPOSED REPLACEMENT for the two tests in worker/src/gas-limits.test.ts that
 * pin the first-enable gate. Runnable from here against either source file:
 *
 *   GATE_SRC=worker/src/executor.ts            npx tsx --test   (must FAIL)
 *   GATE_SRC=spikes/.../executor.patched.ts    npx tsx --test   (must PASS)
 *
 * On landing, drop the GATE_SRC indirection and read ./executor.ts directly.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  FIRST_ENABLE_GAS_BOUNDS,
  GAS_BOUNDS,
  boundGas,
  type UserOpGas,
} from "../../worker/src/gas-limits";
import { isFirstEnable } from "../../worker/src/executor";

const est = (call: bigint, ver: bigint, pre: bigint): UserOpGas => ({
  callGasLimit: call,
  verificationGasLimit: ver,
  preVerificationGas: pre,
});

const GATE_SRC = process.env.GATE_SRC ?? "worker/src/executor.ts";

/**
 * THE CODE, WITHOUT THE PROSE. Every claim below is about what the executor
 * DOES, and this file's comments quote the expression they replaced — so a
 * source pin that matched raw text would fail on its own explanation, and the
 * obvious way to make it pass again is to delete the explanation.
 *
 * Block comments and whole-line `//` comments only. A trailing comment is left
 * in place, which is safe here because nothing this file asserts on appears in
 * one, and it keeps the stripper too simple to be wrong about a string literal.
 */
const src = () =>
  readFileSync(GATE_SRC, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

// ── THREE MEASURED NONCES FROM CHAIN 4663, 2026-09-03 ───────────────────────
//
// Kernel v3 packs `mode(1) ‖ vType(1) ‖ validator(20) ‖ key(2) ‖ seq(8)`, and for
// a permission validator the 20-byte validator field carries the 4-byte
// permissionId left-aligned. These are three DIFFERENT permissionIds on purpose:
// the fixtures are not interchangeable, so a test that passes on one cannot be
// satisfied by another.
//
//   FIRST_ARM   an account with no code, first grant          (pId acff7589)
//   RENEWAL     0xa48cE91e…, 61 bytes of code, a FRESH key    (pId d791f13e)
//   STEADY      0xa48cE91e…, the key whose validator LANDED   (pId 3ca1cec8)
const FIRST_ARM = 0x0102acff75890000000000000000000000000000000000000000000000000000n;
const RENEWAL = 0x0102d791f13e0000000000000000000000000000000000000000000000000000n;
const STEADY = 0x00023ca1cec80000000000000000000000000000000000000000000000000000n;

// ── AND THREE MEASURED ESTIMATES OF THE SAME 18-PERMISSION WALL ─────────────
// Pimlico, chain 4663, 2026-09-03. The first is the undeployed first op the
// ceiling was derived from; the other two are that same wall enabled on real
// already-deployed Kernel v3.3 accounts, with no factory and no initCode.
const MEASURED_WALL = est(50_180n, 7_418_031n, 243_443n); // undeployed first arm
const MEASURED_RENEWAL = est(50_180n, 7_279_603n, 240_042n); // dearest renewal seen
const MEASURED_RENEWAL_CHEAPEST = est(50_180n, 7_111_512n, 240_001n); // perm #2 beside #1

test("A RENEWAL IS AN ENABLE ON AN ACCOUNT THAT ALREADY HAS CODE", () => {
  // THE CASE THE OLD GATE GOT WRONG, and the one thing that distinguishes it
  // from a first arm: the account is LIVE. `accountLive` is true here, so
  // `!accountLive && isFirstEnable(nonce)` was false and this operation — the
  // most expensive one a session key ever signs — was handed 3,000,000.
  //
  // The enable is one-time per SESSION KEY, not per account. permissionId is
  // keccak(policies ‖ flag ‖ signer)[0:4], so a renewed key is a new id with an
  // empty permissionConfig slot, and Kernel answers ENABLE regardless of code.
  const accountLive = true; // measured: 0xa48cE91e… holds 61 bytes
  assert.equal(isFirstEnable(RENEWAL), true, "a renewal IS a permission-validator enable");
  assert.notEqual(RENEWAL, FIRST_ARM, "a different permissionId — not the first-arm fixture");

  // The gate as it must now read. Written out rather than imported because the
  // expression is the thing under test.
  const ceiling = (live: boolean, nonce: bigint) =>
    (isFirstEnable(nonce) ? FIRST_ENABLE_GAS_BOUNDS : GAS_BOUNDS).absoluteMax;
  assert.equal(ceiling(accountLive, RENEWAL), 12_000_000n, "a renewal reaches the wide ceiling");
  assert.equal(ceiling(false, FIRST_ARM), 12_000_000n, "and so does a first arm, as before");

  // THE OLD GATE, kept as the thing this test refuses to let back in.
  const old = (live: boolean, nonce: bigint) =>
    (!live && isFirstEnable(nonce) ? FIRST_ENABLE_GAS_BOUNDS : GAS_BOUNDS).absoluteMax;
  assert.equal(old(false, FIRST_ARM), 12_000_000n, "the old gate was right about first arms");
  assert.equal(old(accountLive, RENEWAL), 3_000_000n, "and wrong about every renewal");
});

test("THE RENEWAL'S MEASURED GAS: refused at 3,000,000, signable at 12,000,000", () => {
  // Not a hypothetical. eth_estimateUserOperationGas against real deployed
  // Kernel v3.3 accounts on 4663 with a fresh 18-permission wall pinned to them.
  const refused = boundGas(MEASURED_RENEWAL, MEASURED_RENEWAL, GAS_BOUNDS);
  assert.equal(refused.ok, false, "the ceiling PR #56 hands a renewal");
  assert.equal(refused.ok === false ? refused.rule : null, "gas-absurd");

  const ok = boundGas(MEASURED_RENEWAL, MEASURED_RENEWAL, FIRST_ENABLE_GAS_BOUNDS);
  assert.equal(ok.ok, true, "the ceiling it earns");
  assert.ok(ok.ok);
  assert.equal(ok.total, 9_499_915n, "9,099,503 + 300,052 + 100,360");

  // The cheapest renewal measured — permission #2 installed alongside a live
  // #1 — is refused at 3,000,000 too, so this is not an artefact of one target.
  const alsoRefused = boundGas(MEASURED_RENEWAL_CHEAPEST, MEASURED_RENEWAL_CHEAPEST, GAS_BOUNDS);
  assert.equal(alsoRefused.ok, false);
  const alsoOk = boundGas(
    MEASURED_RENEWAL_CHEAPEST,
    MEASURED_RENEWAL_CHEAPEST,
    FIRST_ENABLE_GAS_BOUNDS,
  );
  assert.ok(alsoOk.ok);
  assert.equal(alsoOk.total, 9_289_751n);
});

test("12,000,000 NEEDS NO RE-DERIVATION: a renewal is strictly cheaper than a first arm", () => {
  // The constant was derived from the UNDEPLOYED first op. Dropping the deploy
  // can only make the operation smaller, so the existing ceiling covers the
  // renewal a fortiori — the fix is a boolean, never a constant.
  const arm = boundGas(MEASURED_WALL, MEASURED_WALL, FIRST_ENABLE_GAS_BOUNDS);
  const renew = boundGas(MEASURED_RENEWAL, MEASURED_RENEWAL, FIRST_ENABLE_GAS_BOUNDS);
  assert.ok(arm.ok && renew.ok);
  assert.equal(arm.total, 9_677_201n);
  assert.ok(renew.total < arm.total, "no initCode, no CREATE2, no root-validator install");
  assert.equal(arm.total - renew.total, 177_286n, "what the deployment was worth: 1.8%");

  // callGasLimit is IDENTICAL in both, which is what proves the saving is the
  // deployment and not a different operation: the deploy never touches the call
  // phase, and preVerificationGas moves only by the calldata price of the ~320
  // factory bytes that are gone.
  assert.equal(MEASURED_WALL.callGasLimit, MEASURED_RENEWAL.callGasLimit);
  assert.equal(MEASURED_WALL.preVerificationGas - MEASURED_RENEWAL.preVerificationGas, 3_401n);

  // The documented five-custom-token margin survives, with room to spare.
  const perExtraToken = 462_874n;
  assert.ok(
    (FIRST_ENABLE_GAS_BOUNDS.absoluteMax - renew.total) / perExtraToken >= 5n,
    "a renewal still buys the five extra tokens the constant promises",
  );
});

test("THE STEADY STATE IS UNTOUCHED: an installed validator still gets 3,000,000", () => {
  // The regression the fix must not cause. Dropping `!accountLive` would be
  // dangerous if the wide ceiling then applied to every op of a live account —
  // it does not, because the chain closes the latch: the instant that
  // permissionId is installed, Kernel answers mode DEFAULT. Measured on four
  // live accounts whose validators had landed.
  assert.equal(isFirstEnable(STEADY), false, "mode 0x00 — installed, not enabling");
  const bounds = isFirstEnable(STEADY) ? FIRST_ENABLE_GAS_BOUNDS : GAS_BOUNDS;
  assert.equal(bounds.absoluteMax, 3_000_000n, "every trade after the enable");

  // Same account, same session key, one operation later. Measured 657,108
  // verification with a 66-byte signature instead of a 10,932-byte enable blob.
  const steadyOp = est(50_180n, 657_108n, 54_538n);
  const v = boundGas(steadyOp, steadyOp, bounds);
  assert.equal(v.ok, true, "an ordinary trade is nowhere near the ordinary ceiling");

  // And the wide ceiling is reachable exactly ONCE per (account, permissionId):
  // the same account is at 12M for a new id and 3M for the installed one.
  assert.equal(RENEWAL >> 240n, 0x0102n, "new id: ENABLE + PERMISSION");
  assert.equal(STEADY >> 240n, 0x0002n, "installed id: DEFAULT + PERMISSION");
});

test("THE CALL SITE: the ceiling is keyed on the OPERATION, and the deploy state does not vote", () => {
  // A constant nothing reads is worth nothing, and a condition that reads the
  // wrong fact is worse. Pin the expression itself.
  const s = src();
  assert.match(s, /const firstEnable = isFirstEnable\(nonce\);/, "the operation decides, alone");
  assert.match(
    s,
    /firstEnable \? FIRST_ENABLE_GAS_BOUNDS : GAS_BOUNDS/,
    "anything else gets the ordinary ceiling",
  );
  assert.doesNotMatch(s, /!accountLive/, "the deploy state must not gate the ceiling");
  assert.doesNotMatch(s, /accountLive &&|&& accountLive/, "nor in any other conjunction");
  assert.doesNotMatch(s, /DEPLOY_GAS_BOUNDS/, "the undeployed-only ceiling is gone");

  // THE STRONG FORM, and the one worth having: `accountLive` survives as a
  // LABEL, so prove that every place it is READ is inside the log line. Counting
  // occurrences would pin the wrong thing — the label legitimately gets used
  // twice there, and a count would have to move each time the line is reworded.
  // This does not: a use anywhere else is a use that decides something.
  const decl = s.indexOf("const accountLive = await isDeployed();");
  assert.ok(decl > 0, "still read — the [gas] line needs it");
  const logAt = s.indexOf("`[gas] account");
  assert.ok(logAt > decl, "and read after the decision it no longer takes part in");
  const logEnd = s.indexOf(");", logAt);
  for (const m of s.matchAll(/accountLive/g)) {
    const i = m.index!;
    const inDecl = i >= decl && i < decl + "const accountLive = await isDeployed();".length;
    const inLog = i > logAt && i < logEnd;
    assert.ok(inDecl || inLog, `accountLive read outside the log line, at offset ${i}`);
  }

  // And the label has to tell the two enables apart, or reading a refusal in the
  // logs means guessing which of them it was.
  assert.match(s, /accountLive \? "deployed" : "NOT deployed"/, "the deploy state");
  assert.match(s, /accountLive \? "RENEWAL-ENABLE" : "FIRST-ENABLE"/, "and which enable it is");

  // Still retired after a landed send — for the label's sake now, not a ceiling's.
  assert.match(s, /deployed = true;/, "a landed send keeps the label honest");
});
