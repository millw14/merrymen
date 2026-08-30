import assert from "node:assert/strict";
import test from "node:test";
import { PATTERN_SOURCES, classifyRevert, suppressionKey } from "./revert";

/**
 * The value of this table is entirely in what it REFUSES to claim, so most of
 * these tests are about the default rather than the entries.
 */

test("the default is unclassified AND retryable — the safe direction", () => {
  // The dangerous failure here is not a missing entry; it is a wrong one that
  // suppresses a token because nobody recognised the message. So anything
  // unfamiliar stays retryable and says out loud that it is unrecognised.
  const v = classifyRevert("Panic: arithmetic underflow or overflow (0x11)");
  assert.equal(v.rule, "unclassified");
  assert.equal(v.retryable, true);
  assert.match(v.detail, /does not recognise/i);
});

test("an empty or garbage message does not match anything by accident", () => {
  for (const m of ["", "0x", "   ", "reverted"]) {
    assert.equal(classifyRevert(m).rule, "unclassified", `"${m}" must not be classified`);
  }
});

test("a slippage revert is transient and stays retryable", () => {
  // SwapRouter02's own string when amountOut < amountOutMinimum. This repo
  // builds that floor itself, so seeing it means the floor worked.
  const v = classifyRevert("reverted on-chain: Too little received (0xabc)");
  assert.equal(v.rule, "slippage");
  assert.equal(v.retryable, true);
});

test("insufficient balance and allowance are NOT retryable — and are different faults", () => {
  const bal = classifyRevert("ERC20: transfer amount exceeds balance");
  assert.equal(bal.rule, "insufficient-balance");
  assert.equal(bal.retryable, false);

  const allow = classifyRevert("ERC20: transfer amount exceeds allowance");
  assert.equal(allow.rule, "allowance");
  assert.equal(allow.retryable, false);
  // The distinction earns its keep in the detail: merrymen batches approve and
  // swap into ONE operation, so an allowance failure means the batch was built
  // wrong — a wiring fault, not a market one.
  assert.match(allow.detail, /wiring fault/i);
});

test("balance is matched before allowance, since the strings overlap", () => {
  // "transfer amount exceeds balance" and "...exceeds allowance" share a prefix.
  // Order in the table is the tiebreak, and getting it wrong would report every
  // empty account as an approval bug.
  assert.equal(classifyRevert("ERC20: transfer amount exceeds balance").rule, "insufficient-balance");
});

test("AA21 is a prefund problem, which no retry fixes", () => {
  const v = classifyRevert("UserOperation reverted: AA21 didn't pay prefund");
  assert.equal(v.rule, "prefund");
  assert.equal(v.retryable, false);
  assert.match(v.detail, /no paymaster/i);
});

test("a validation failure is the WALL, and is reported as the wall working", () => {
  // On this account the validator IS the sealed policy, so AA23/AA24 mean the
  // grant does not cover what was attempted. Retrying cannot make it succeed.
  const v = classifyRevert("AA24 signature error");
  assert.equal(v.rule, "wall-refused");
  assert.equal(v.retryable, false);
  assert.match(v.detail, /re-signed/i);
});

test("classification reads the RAW message, not a truncated one", () => {
  // index.ts stores 90 characters; matching against that would make the verdict
  // depend on where the cut landed. A long prefix must not hide the reason.
  const long = `${"context ".repeat(20)}Too little received`;
  assert.ok(long.length > 90);
  assert.equal(classifyRevert(long).rule, "slippage");
  assert.equal(classifyRevert(long.slice(0, 90)).rule, "unclassified", "which is exactly what truncating would cost");
});

test("every non-retryable class explains why retrying cannot help", () => {
  // The rule this table is judged by: a refusal the owner cannot act on is a
  // refusal they will assume is a bug.
  for (const m of [
    "ERC20: transfer amount exceeds balance",
    "ERC20: transfer amount exceeds allowance",
    "AA21 didn't pay prefund",
    "AA24 signature error",
    "SPL",
  ]) {
    const v = classifyRevert(m);
    assert.equal(v.retryable, false, m);
    assert.ok(v.detail.length > 60, `${v.rule} needs a real explanation, not a label`);
  }
});

test("the suppression key is about MEANING, not object identity", () => {
  // The same buy re-proposed next tick is a different object. Keying on the
  // pair is what makes suppression survive that.
  const a = suppressionKey("swap", "0xAAA", "0xBBB");
  assert.equal(a, suppressionKey("swap", "0xaaa", "0xbbb"), "case must not create a second key");
  assert.notEqual(a, suppressionKey("swap", "0xBBB", "0xAAA"), "direction matters — a sell is not the buy");
  assert.notEqual(a, suppressionKey("transfer", "0xAAA", "0xBBB"), "so does the kind");
});

/**
 * FOUR DEFECTS AN ADVERSARIAL REVIEW FOUND IN THIS BRANCH, pinned so they
 * cannot come back. Every one of them passed the original test suite.
 */

test("REGRESSION: STF is a balance/allowance failure, NOT slippage", () => {
  // STF is TransferHelper.safeTransferFrom's revert in v3-periphery — the INPUT
  // token's transferFrom failing. It was in the slippage entry, ABOVE the
  // balance and allowance entries, in a first-match-wins table. So on the
  // Uniswap v3 path (the only live venue) the two classes the whole suppression
  // mechanism exists for were unreachable, and an account that did not hold the
  // token was told "the floor doing its job; it is worth retrying" every tick.
  const v = classifyRevert("execution reverted: STF");
  assert.equal(v.rule, "insufficient-balance", "not 'slippage'");
  assert.equal(v.retryable, false, "and retrying it burns gas on a trade that cannot fill");
  assert.match(v.detail, /safeTransferFrom/);
});

test("REGRESSION: the real slippage revert still classifies as slippage", () => {
  // The other half — fixing STF must not lose the case it was standing in for.
  const v = classifyRevert("execution reverted: Too little received");
  assert.equal(v.rule, "slippage");
  assert.equal(v.retryable, true);
});

test("REGRESSION: three-letter codes are word-bounded and case-sensitive", () => {
  // /SPL/i matched inside any word containing those letters. A taxonomy that
  // fires on a substring is worse than one that abstains — it suppresses a
  // token on a coincidence.
  for (const innocent of [
    "reverted: SPLIT_FAILED",
    "reverted: token STFU has no pool",
    "the pool at 0xSTFa19b0Cd8 is empty",
    "reverted: BLOCKED",
    "stf",
    "spl",
  ]) {
    assert.equal(
      classifyRevert(innocent).rule,
      "unclassified",
      `"${innocent}" must not be classified — it only LOOKS like a code`,
    );
  }
  // And the real ones still match.
  assert.equal(classifyRevert("execution reverted: SPL").rule, "no-liquidity");
  assert.equal(classifyRevert("execution reverted: LOK").rule, "no-liquidity");
  assert.equal(classifyRevert("reverted: EXPIRED").rule, "deadline");
});

test("REGRESSION: no stray control characters in the pattern sources", () => {
  // \b written through one escaping layer too few becomes U+0008 BACKSPACE,
  // which silently matches nothing a revert string contains. It reads as a word
  // boundary in a diff and behaves as a character class of one control byte.
  for (const p of PATTERN_SOURCES) {
    // eslint-disable-next-line no-control-regex
    assert.equal(/[\u0000-\u001F]/.test(p), false, `pattern ${JSON.stringify(p)} carries a control character`);
  }
});
