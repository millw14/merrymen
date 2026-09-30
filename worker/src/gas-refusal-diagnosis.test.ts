/**
 * WHEN THE BUNDLER WON'T ESTIMATE, SAY WHY IT WOULDN'T.
 *
 * ── THE FAILURE THIS IS WRITTEN AGAINST ──────────────────────────────────
 *
 * Measured in production on chain 4663 on 2026-09-20: agent 0x8e93ba produced
 * 20 refusals in 3.5 hours, every one of them AFTER a Brain BUY and an entry
 * the strategy had already approved. Every one was:
 *
 *   [gas] ... ENABLE 0x5f645dab ceiling 14000000 · estimate1 unreadable
 *         · estimate2 unreadable · signed refused (gas-unreadable)
 *   Details: UserOperation reverted during simulation with reason:
 *            AA23 reverted duplicate permissionHash
 *
 * The bundler said exactly what was wrong. `boundGas` could not — all it saw
 * was two nulls — so the refusal was filed as `gas-unreadable`, which is the
 * rule that lands in `trades.reject_rule` and drives the owner's remedy. It
 * reads as a transient bundler hiccup, so it was retried every few minutes,
 * indefinitely, on a condition that cannot change without a new grant.
 *
 * ── WHAT THESE TESTS PIN, AND WHAT THEY DELIBERATELY DO NOT ──────────────
 *
 * They pin the NAME and the SENTENCE on a refusal. They do not pin whether the
 * operation is refused — it is refused either way, before signing, and no test
 * here should be read as evidence about money moving.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyRevert } from "./revert";

/** The bundler's message, verbatim from the production log. */
const LIVE_MESSAGE =
  "The `validateUserOp` function on the Smart Account reverted.\n\n" +
  "Details: UserOperation reverted during simulation with reason: AA23 reverted duplicate permissionHash\n" +
  "Version: viem@2.56.0";

describe("the duplicate-enable refusal is named and explained", () => {
  it("classifies the exact production message", () => {
    const v = classifyRevert(LIVE_MESSAGE);
    assert.equal(v.rule, "wall-refused");
    assert.equal(v.retryable, false, "nothing about this changes by waiting");
  });

  it("does NOT blame the owner's trading policy", () => {
    // The generic AA23 entry says "the session key's sealed policy does not
    // permit it". That is false here and sends an owner to the wrong screen:
    // validation reverted before any policy was consulted, so the trade was
    // never judged at all.
    const v = classifyRevert(LIVE_MESSAGE);
    assert.doesNotMatch(v.detail, /sealed policy does not permit/);
    assert.match(v.detail, /already knows|installed twice/i, "must name the real cause");
  });

  it("names the remedy, because only one thing clears it", () => {
    assert.match(classifyRevert(LIVE_MESSAGE).detail, /re-sign/i);
  });

  it("still classifies an ordinary AA23 as the policy refusing", () => {
    // The specific entry sits above the general one; the general one must keep
    // working for the case it was written for.
    const v = classifyRevert("AA23 reverted (or OOG)");
    assert.equal(v.rule, "wall-refused");
    assert.match(v.detail, /sealed policy does not permit/);
  });

  it("orders specific above general — a duplicate is not the generic sentence", () => {
    // Both patterns match a message containing AA23 AND the duplicate text, so
    // first-match-wins is what decides. If the table is ever reordered, the
    // duplicate case silently reverts to the wrong explanation.
    assert.notEqual(classifyRevert(LIVE_MESSAGE).detail, classifyRevert("AA23 reverted (or OOG)").detail);
  });
});

describe("what may and may not rename a gas refusal", () => {
  /**
   * The executor renames a `gas-unreadable` refusal only when the bundler's
   * error classifies NON-RETRYABLY and is not `unclassified`. These pin that
   * predicate on the classifier's own answers, so the rule stays true as the
   * table grows rather than being restated here.
   */
  const mayRename = (message: string) => {
    const d = classifyRevert(message);
    return !d.retryable && d.rule !== "unclassified";
  };

  it("renames a validation revert", () => {
    assert.equal(mayRename(LIVE_MESSAGE), true);
  });

  it("leaves an unfamiliar message as gas-unreadable", () => {
    // The honest answer when we do not know why the estimate failed. Inventing
    // a cause here is how a taxonomy stops being trustworthy.
    assert.equal(mayRename("connection reset by peer"), false);
    assert.equal(classifyRevert("connection reset by peer").rule, "unclassified");
  });

  it("leaves a RETRYABLE class alone even though it is recognised", () => {
    // Slippage really can pass. Relabelling it would suppress a trade that
    // deserves another tick — the opposite of the bug being fixed.
    const slip = classifyRevert("Too little received");
    assert.equal(slip.retryable, true);
    assert.equal(mayRename("Too little received"), false);
  });

  it("does not rename a genuine prefund failure into something else", () => {
    // AA21 is about money at the account, not about validation, and it has its
    // own remedy. It is non-retryable, so it DOES rename — and must keep its
    // own rule rather than borrowing the wall's.
    assert.equal(classifyRevert("AA21 didn't pay prefund").rule, "prefund");
    assert.equal(mayRename("AA21 didn't pay prefund"), true);
  });
});
