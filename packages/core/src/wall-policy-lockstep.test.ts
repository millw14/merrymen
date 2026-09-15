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

/**
 * THE CLASS VAULT IS A PLATFORM ANSWER, NOT A THING EACH OWNER MUST TYPE.
 *
 * `session.ts` read the factory from the tenant's own settings and skipped the
 * whole vault block when it was absent — which it is for everyone, because
 * nothing ever asked them for it. So the class route, whose entire purpose is
 * trading a launch that did not exist at signing, could only be reached by an
 * owner who had somehow learned a deploy address and pasted it in. A re-sign
 * would have sealed nothing and reported success.
 *
 * This is NOT the adapter, and the difference is the safety case:
 * `ponsAdapterForSigning` refuses to default because `tradeExactIn` takes the
 * curve as a caller-supplied argument the wall cannot pin and hands it a live
 * allowance. The wall pins a class VAULT as a literal target, and the vault's
 * `sweep` has no recipient — it pays `owner`, fixed at construction.
 */
describe("a re-sign actually seals a class vault", () => {
  const SESSION = strip(read(SITES["web signer"]));

  it("FALLS BACK TO THE PLATFORM FACTORY when the owner has not named one", () => {
    assert.match(
      SESSION,
      /ponsClassVaultFactory\s*\?\?\s*\(\(PONS_CLASS_VAULT_FACTORY\[chainId\]/,
      "the deploy constant must be the default",
    );
  });

  it("and the owner's own choice still wins", () => {
    // Grant-first precedence, exactly as the adapter path does.
    const at = SESSION.indexOf("const sealedClassFactory");
    const line = SESSION.slice(at, at + 200);
    assert.match(line, /ponsClassVaultFactory\s*\?\?/, "settings are consulted before the constant");
  });

  it("and the vault and factory travel TOGETHER into the grant", () => {
    // buildCallPermissions throws when a vault is sealed without a factory —
    // two of three is a key that can reach a vault it can never create. So
    // every remaining use must follow the resolved value, not the raw setting.
    assert.doesNotMatch(
      SESSION,
      /ponsClassVaultFactoryAddress: ponsClassVaultFactory/,
      "the grant record must carry the factory that was actually used",
    );
    assert.match(SESSION, /ponsClassVaultFactoryAddress: sealedClassFactory/);
  });

  it("but the ADAPTER still refuses to default — that one is unsafe", () => {
    // The distinction this whole change rests on. If someone ever "makes these
    // consistent", this fails.
    const protocols = strip(read("../../../packages/core/src/protocols.ts"));
    assert.match(
      protocols,
      /export function ponsAdapterForSigning[\s\S]*?if \(!fromSettings/,
      "the adapter must still require an explicit setting",
    );
    assert.doesNotMatch(
      protocols,
      /return PONS_SELF_TRADE\[chainId\]/,
      "the adapter must never fall back to the deploy constant",
    );
  });
});
