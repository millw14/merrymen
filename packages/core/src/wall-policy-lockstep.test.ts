import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * ONE DEPLOYABILITY POLICY, THREE CALLERS, NO SECOND ARITHMETIC.
 *
 * The defect this whole change exists to close was not a wrong number. It was
 * that the executor had a ceiling for the operation that installs a permission
 * wall, and signing had no idea it existed — so the product minted grants whose
 * first UserOp the executor was already designed to refuse, and two funded
 * agents retried one every ~97 seconds forever.
 *
 * Fixing that by teaching both sides the same arithmetic would reintroduce it
 * the day one side is edited. So there is one implementation — `wallShape` and
 * `firstEnableEnvelope` in first-enable-gas.ts — and the two signers and the
 * executor all call it over the SAME permission objects the signature is made
 * over. This file fails if any of them starts computing its own.
 *
 * Source scans rather than behaviour, deliberately, in the idiom of
 * signer-lockstep.test.ts: a behavioural test passes just as happily on two
 * implementations that currently agree, and the failure mode here is drift.
 */

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** Comments stripped — this codebase argues in prose next to the code. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const SITES = {
  "web signer": "../../../web/src/lib/session.ts",
  "mobile signer": "../../../mobile/src/crypto/signGrant.ts",
  "worker executor caller": "../../../worker/src/index.ts",
} as const;

describe("every caller imports the policy rather than reproducing it", () => {
  for (const [who, path] of Object.entries(SITES)) {
    it(`${who} calls the shared implementation`, () => {
      const src = strip(read(path));
      assert.match(
        src,
        /wallShape\(/,
        `${who} must size the wall with the shared wallShape, not its own count`,
      );
      assert.match(
        src,
        /buildCallPermissions\(/,
        `${who} must size the REAL permission objects, not a model of them`,
      );
    });
  }

  it("the signers refuse, and the executor bounds", () => {
    // Different verbs on purpose: a signer must not mint an undeployable wall,
    // and the executor must not sign an estimate larger than the wall justifies.
    // Same policy, two enforcement points.
    for (const path of [SITES["web signer"], SITES["mobile signer"]]) {
      const src = strip(read(path));
      assert.match(src, /wallSignable\(/, "a signer must ask whether the wall can be installed");
      assert.match(src, /if\s*\(!signable\.ok\)\s*throw/, "and refuse before any signature exists");
    }
    const worker = strip(read(SITES["worker executor caller"]));
    assert.match(worker, /firstEnableEnvelope\(/, "the executor's caller must size the enable");
    assert.match(worker, /allowedMaxBounded/, "and hand the executor that wall's own maximum");
  });

  it("NOBODY RE-DERIVES THE NUMBERS", () => {
    // The constants live in first-enable-gas.ts with their measurements. A
    // second copy anywhere is drift waiting to happen, and it is the exact
    // shape of the bug: two descriptions of one wall.
    for (const [who, path] of Object.entries(SITES)) {
      const src = strip(read(path));
      for (const forbidden of [/700_?945/, /169_?701/, /31_?412/, /27_?834_?594/]) {
        assert.ok(
          !forbidden.test(src),
          `${who} contains a copy of a gas-model constant (${forbidden}) — it must import the policy`,
        );
      }
    }
  });

  it("and nobody hardcodes the product maximum", () => {
    // `FIRST_ENABLE_HARD_MAX_BOUNDED` is a policy constant with a derivation
    // written beside it. A literal 14_000_000 somewhere else is a second policy.
    for (const [who, path] of Object.entries(SITES)) {
      const src = strip(read(path));
      assert.ok(
        !/14_?000_?000/.test(src),
        `${who} hardcodes the product maximum instead of importing it`,
      );
    }
  });

  it("the policy itself is exported from exactly one module", () => {
    const core = read("./first-enable-gas.ts");
    for (const sym of [
      "export function wallShape",
      "export function firstEnableEnvelope",
      "export function wallSignable",
      "export const FIRST_ENABLE_HARD_MAX_BOUNDED",
    ]) {
      assert.ok(core.includes(sym), `first-enable-gas.ts must own ${sym}`);
    }
    // And the worker's flat ceiling is still there as the fallback for a wall
    // that could not be sized — absent must not mean "widen".
    const limits = read("../../../worker/src/gas-limits.ts");
    assert.match(limits, /FIRST_ENABLE_GAS_BOUNDS/, "the flat fallback must survive");
  });
});
