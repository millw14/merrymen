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

/**
 * The bundler's refusal of agent 0xbba115's class-vault buy, 2026-10-03T13:07:48Z
 * — the message `/AA23|AA24|.../i` misread.
 *
 * Pons reverted the simulation with its own 0x71c4efed, which revert.ts leaves
 * unclassified on purpose. But viem's error also carries its 'Request
 * Arguments:' dump, and the 29 KB `signature:` field in it happened to contain
 * `Aa24`. That was enough: the refusal was filed `wall-refused`, the executor
 * renamed `enable-too-wide` after it, and the owner was told to re-sign a grant
 * that was fine.
 *
 * VERBATIM EXCEPT FOR FOUR CUTS, each marked `…`, reassembled from the
 * worker's log lines into viem's own layout (the log prefixes each line and
 * drops the blank ones). The cuts are callData (2 KB), paymasterData, the
 * account's address, and the signature, which keeps its leading bytes and the
 * 86 characters around the `Aa24` that did the damage. The full dump holds an
 * owner-signed enable and a sponsor's signature, which do not belong in source;
 * it was run through classifyRevert in full when this was fixed, and came back
 * with the verdict pinned below.
 */
const SIMULATION_REVERT_MESSAGE =
  "Execution reverted with reason: UserOperation reverted during simulation with reason: " +
  "0x71c4efed0000000000000000000000000000000000000000000056da51aed7bd9c526b72" +
  "0000000000000000000000000000000000000000000065fabd2ee80e162af404.\n\n" +
  "Request Arguments:\n" +
  "  callData:                       0xe9ae5c53…\n" +
  "  maxFeePerGas:                   0.03108168 gwei\n" +
  "  maxPriorityFeePerGas:           0.000155408 gwei\n" +
  "  nonce:                          456336424456981077151081705750506175129171795645840516013162862051204268032\n" +
  "  paymaster:                      0x777777777777AeC03fd955926DbF81597e66834C\n" +
  "  paymasterData:                  0x01000000…\n" +
  "  paymasterPostOpGasLimit:        1\n" +
  "  paymasterVerificationGasLimit:  200000\n" +
  "  sender:                         0x1A7EC670…\n" +
  "  signature:                      0x0000000000000000…" +
  "2a00026A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF10D1484c05Aa24e6d1AEBF7B5B93115f7762604f…\n\n" +
  "Details: UserOperation reverted during simulation with reason: " +
  "0x71c4efed0000000000000000000000000000000000000000000056da51aed7bd9c526b72" +
  "0000000000000000000000000000000000000000000065fabd2ee80e162af404\n" +
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

describe("a request dump that happens to spell an AA code is not the wall", () => {
  it("the fixture still carries the hex that fooled the old pattern", () => {
    // Without this, tidying the fixture could quietly remove the one thing that
    // makes it a regression test. The old pattern, kept here as evidence only.
    assert.match(SIMULATION_REVERT_MESSAGE, /Aa24/);
    assert.ok(/AA23|AA24|signature error|InvalidSignature|PolicyFailed/i.test(SIMULATION_REVERT_MESSAGE));
  });

  it("classifies the 2026-10-03T13:07:48Z message as unclassified, and retryable", () => {
    // Pons's own reverts stay unclassified until one is observed with the
    // transaction that produced it (revert.ts). A dump that merely contains four
    // letters is not that observation.
    const v = classifyRevert(SIMULATION_REVERT_MESSAGE);
    assert.equal(v.rule, "unclassified");
    assert.equal(v.retryable, true);
    assert.match(v.detail, /does not recognise/);
  });

  it("does not send the owner to re-sign a grant that was fine", () => {
    assert.doesNotMatch(classifyRevert(SIMULATION_REVERT_MESSAGE).detail, /re-sign/i);
  });

  it("and a REAL validation revert under the same dump is still the wall", () => {
    // The other half. Narrowing the pattern must not lose the case it exists
    // for — the bundler's own words under `Details:`, upper-case as the
    // EntryPoint writes them, with the same hex around them.
    const withReason = (reason: string) =>
      SIMULATION_REVERT_MESSAGE.replace(
        /Details: [^\n]*/,
        `Details: UserOperation reverted during simulation with reason: ${reason}`,
      );
    const policy = classifyRevert(withReason("AA24 signature error"));
    assert.equal(policy.rule, "wall-refused");
    assert.match(policy.detail, /sealed policy does not permit/);
    const duplicate = classifyRevert(withReason("AA23 reverted duplicate permissionHash"));
    assert.equal(duplicate.rule, "wall-refused");
    assert.match(duplicate.detail, /installed twice/);
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

  it("leaves a simulation revert with the refusal it really was", () => {
    // 2026-10-03T13:07:48Z: renamed `wall-refused` over a gas refusal that was
    // `enable-too-wide`, because the request dump spelled Aa24. The gas verdict
    // was the true one and must keep its name.
    assert.equal(mayRename(SIMULATION_REVERT_MESSAGE), false);
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
