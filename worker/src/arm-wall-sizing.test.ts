/**
 * THE ARM-TIME SIZER MUST DESCRIBE THE GRANT IT IS SIZING.
 *
 * At arm time the worker rebuilds the wall from the stored grant to compute
 * this agent's first-enable gas envelope, "from the SAME inputs the signature
 * was made over ... so the ceiling the executor applies and the ceiling the
 * signer enforced are the same number by construction rather than by
 * agreement". That equality holds only while the rebuild passes every
 * capability the grant carries.
 *
 * It did not. The class route was passed as half a pair — vault, no factory —
 * so `wallShape` threw on its own two-of-three guard, the throw was caught, and
 * the only trace was a log line saying the wall could not be sized. The
 * executor then fell back to the flat first-enable ceiling: not an error, not a
 * refusal, just a different and unmeasured number, for a grant whose real
 * envelope had been computed at 12,603,984 against a 14,000,000 hard cap.
 *
 * The agent it was breaking is the worst possible one to break it for. A class
 * canary's FIRST class buy is the operation that carries the session-key
 * enable, so the single trade whose gas ceiling has to be right is precisely
 * the one the fallback was sizing by guesswork.
 *
 * Source-read, because the spread is an inline object literal inside an IIFE
 * inside `arm()`, reachable only by arming a real agent against a real chain.
 * The property is structural anyway: it is about which accessors the call site
 * mentions, and a shape test cannot pass on a branch that never ran.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildCallPermissions, firstEnableEnvelope, wallShape } from "../../packages/core/src/index";
import { FIRST_ENABLE_GAS_BOUNDS } from "./gas-limits";

const IDX = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

/** The arm-time rebuild: the `wallShape(buildCallPermissions(...))` call. */
const SIZER = (() => {
  const start = IDX.indexOf("    firstEnable = (() => {");
  assert.ok(start > 0, "the arm-time first-enable sizer moved — re-point this test, do not delete it");
  return IDX.slice(start, IDX.indexOf("const env = firstEnableEnvelope(shape);", start));
})();

describe("the arm-time wall sizer", () => {
  it("passes the class factory whenever it passes the class vault", () => {
    // The exact defect. `wallShape` refuses a vault with no factory — a vault
    // address is a CREATE2 prediction, and a key that can reach a vault nothing
    // can deploy would approve USDG into a codeless address, no-op, and report
    // `landed`. Sizing a grant that legitimately carries both must not trip the
    // guard meant for a grant that carries one.
    const hasVault = SIZER.includes("ponsClassVaultAddress:");
    const hasFactory = SIZER.includes("ponsClassVaultFactoryAddress:");
    assert.equal(hasVault, hasFactory, "the class vault and its factory must be passed as a pair");
    assert.ok(hasVault, "and the sizer must still describe the class route at all");
    assert.match(SIZER, /grantPonsClassVaultFactory\(grant\)/, "read from the grant, not from settings");
  });

  it("reads every capability from the GRANT, never from live settings", () => {
    // The whole point of the rebuild is to reproduce what was signed. Settings
    // can change after signing — that is what a sealed grant is FOR — so a
    // capability sourced from `cfg` here would size a wall nobody signed, and
    // would do it silently because the number still looks plausible.
    for (const accessor of [
      "grantWallOptions(grant)",
      "grantV4Adapter(grant)",
      "grantPonsAdapter(grant)",
      "grantPonsClassVault(grant)",
      "grantPonsClassVaultFactory(grant)",
    ]) {
      assert.ok(SIZER.includes(accessor), `${accessor} is missing from the arm-time rebuild`);
    }
    assert.doesNotMatch(SIZER, /cfg\./, "no live setting may reach the sizer");
  });

  it("and the pairing is LOAD-BEARING: a class wall does not fit the flat ceiling", () => {
    // This is what made the omission a blocker rather than an untidiness. The
    // flat ceiling was derived for the default 18-permission wall; a class wall
    // is 24 permissions and a 14,100-byte stub, and its enable does not fit.
    //
    // The measured canary: expected 12,603,984 against a flat 12,000,000. The
    // enable is refused by 603,984 gas, every tick, for ever — and a class
    // canary's FIRST class buy is the operation that carries the enable, so
    // this refuses the exact trade the route exists to make. Nothing is logged
    // but "could not size this wall", three thousand lines away.
    const CAPS = { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 5, maxOpsPerDay: 24 } as never;
    const SELF = "0xAE769E64125757e8D06f1e15c3CDc13e11E272FB" as const;
    const shape = wallShape(
      buildCallPermissions(CAPS, SELF, {
        extraTokens: [0, 1, 2].map((i) => ({
          symbol: `C${i}`,
          address: `0x${(0xc0000000 + i).toString(16).padStart(40, "0")}` as `0x${string}`,
          decimals: 18,
        })),
        ponsClassVaultAddress: "0x5fce8e09ce46433f7e7b21a2cdb78becb3fe05cd",
        ponsClassVaultFactoryAddress: "0x48a560371230ece659b2ba40fb19e8335866ab3d",
      } as never) as never,
    );
    const env = firstEnableEnvelope(shape);
    assert.ok(
      env.expectedBounded > FIRST_ENABLE_GAS_BOUNDS.absoluteMax,
      `a class wall's enable (${env.expectedBounded}) must not fit the flat ceiling ` +
        `(${FIRST_ENABLE_GAS_BOUNDS.absoluteMax}) — if it ever does, this test has stopped proving anything ` +
        `and the sizer's omission would be silent again`,
    );
    // The measured envelope DOES fit, which is why passing it is a fix and not
    // a widening: the hard product maximum is untouched and still binds.
    assert.ok(env.withinHardMax, "and the measured envelope is still under the product maximum");
    assert.ok(env.allowedMaxBounded >= env.expectedBounded);
  });

  it("still fails CLOSED when the shape cannot be computed", () => {
    // The fallback itself is correct and must stay. A shape we cannot compute
    // must never widen anything — absent means the executor keeps the flat
    // ceiling, which is the conservative prior. What was wrong was reaching it
    // for a grant that was perfectly sizable.
    const block = IDX.slice(IDX.indexOf("    firstEnable = (() => {"), IDX.indexOf("let executor: AgentExecutor | null = null;"));
    assert.match(block, /catch \(e\)/);
    assert.match(block, /return undefined;/, "an unsizable wall returns absent, not a guessed envelope");
    assert.match(block, /could not size this wall/, "and says so out loud");
  });
});
