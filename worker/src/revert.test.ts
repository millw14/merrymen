import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { toFunctionSelector } from "viem";
import { PATTERN_SOURCES, PONS_ERROR_SELECTORS, classifyRevert, suppressionKey, suppressionLegs } from "./revert";

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


/**
 * PONS REVERTS — permanent conditions that used to look retryable.
 *
 * Before this, every curve failure fell to `unclassified`, which this file
 * deliberately treats as retryable. So a graduated curve would be re-proposed
 * every tick for the life of the arm: the 1,242-identical-rejections failure the
 * header warns about, arriving through a venue the table had never heard of.
 */
describe("Pons adapter reverts", () => {
  const revertData = (selector: string, args = "") => `execution reverted: ${selector}${args}`;

  it("a graduated curve is permanent, not something to retry", () => {
    const v = classifyRevert(revertData("0x025ac17e"));
    assert.equal(v.rule, "curve-graduated");
    assert.equal(v.retryable, false);
    assert.match(v.detail, /graduated/);
  });

  it("shape refusals are permanent", () => {
    for (const sel of [
      "0xf51cd3d9", // NativeQuoteNotSupported
      "0xe3716feb", // AssetsDoNotMatchCurve
      "0x09ee12d5", // NotAContract
      "0x5048bd62", // IdenticalAssets
      "0x1f2a2005", // ZeroAmount
      "0xed3ba6a6", // Reentrant
      "0xe6208274", // TokenDoesNotMatchCurve — the vault's, raised since v1 shipped
    ]) {
      const v = classifyRevert(revertData(sel));
      assert.equal(v.rule, "curve-unsupported", sel);
      assert.equal(v.retryable, false, sel);
    }
  });

  it("a v2 spend cap is the SAME verdict as a v1 one, through a different selector", () => {
    // THE REGRESSION THIS TEST EXISTS TO CATCH. PonsClassVaultV2 keys its ceiling
    // by the asset the trade was funded in, so the error names that asset —
    // SpendCapExceeded(address,uint256,uint256) rather than (uint256,uint256) —
    // and a wider signature is a different four bytes. Versioning the contract
    // would otherwise have dropped v2 reverts into `unclassified`, which is
    // retryable, against a window that is a DAY: up to a thousand reverted
    // UserOperations paying gas to be told the same thing. That is the exact
    // loop this file was written to stop, reintroduced by a contract upgrade.
    const v1 = classifyRevert(revertData("0x605cd727"));
    const v2 = classifyRevert(revertData("0xa6dfc94a"));
    assert.equal(v1.rule, "spend-cap");
    assert.equal(v2.rule, "spend-cap", "a v2 spend cap must not fall through to unclassified");
    assert.equal(v2.retryable, false);
    assert.equal(v1.detail, v2.detail, "same remedy, so the owner reads the same sentence");
  });

  it("BOTH spend-cap selectors stay, because v1 is deployed and may still be traded", () => {
    // Not a redundant restatement of the test above: that one asserts v2 is
    // recognised, this one asserts v1 was not REPLACED. A version bump that
    // swapped the selector instead of adding to it would pass the first test and
    // silently un-classify every trade on the live v1 vault.
    assert.ok(PONS_ERROR_SELECTORS.includes("0x605cd727"), "v1 SpendCapExceeded");
    assert.ok(PONS_ERROR_SELECTORS.includes("0xa6dfc94a"), "v2 SpendCapExceeded");
  });

  it("QuoteNotApproved is its own answer, because waiting is the wrong one", () => {
    // Both are non-retryable, so collapsing them into one class would have been
    // mechanically correct and practically useless. A spend cap clears when the
    // window rolls. This never clears on its own: in v2 a cap of zero IS how an
    // asset is refused, and only the owner's key can seal one. The only thing
    // anyone does with this class is read the sentence and act.
    const v = classifyRevert(revertData("0xae9665be"));
    assert.equal(v.rule, "quote-not-approved");
    assert.equal(v.retryable, false);
    assert.notEqual(v.rule, "spend-cap", "the whole point is that these are different instructions");
    assert.match(v.detail, /seal a cap/, "it has to say what to DO about it");
    assert.doesNotMatch(v.detail, /window/, "and must not tell the owner to wait for a window");
  });

  it("InsufficientOutput is slippage and IS worth retrying", () => {
    // The one transient member of the set. It is the adapter's floor firing
    // against the account's own balance delta, which is the market moving.
    const v = classifyRevert(revertData("0x2c19b8b8", "0000000000000000000000000000000000000000000000000000000000000001"));
    assert.equal(v.rule, "slippage");
    assert.equal(v.retryable, true);
  });

  it("NoOutput is NOT slippage — a curve that pays nothing is not a market", () => {
    const v = classifyRevert(revertData("0x5a7cfa65"));
    assert.equal(v.rule, "curve-unsupported");
    assert.equal(v.retryable, false);
  });

  it("Expired is a deadline and retryable", () => {
    const v = classifyRevert(revertData("0x203d82d8"));
    assert.equal(v.rule, "deadline");
    assert.equal(v.retryable, true);
  });

  it("matches whatever case the RPC hex-encodes with", () => {
    assert.equal(classifyRevert(revertData("0x025AC17E")).rule, "curve-graduated");
  });

  it("PONS ITSELF still classifies unclassified, and that is deliberate", () => {
    // A scoping pass reported Pons's SlippageExceeded as 0x71c4efed while
    // deriving `SlippageExceeded()` gives 0x8199f5f3. The two disagree, so
    // neither is evidence, and this file's rule is to add nothing from memory.
    // Retryable-and-visible beats confidently-wrong.
    assert.equal(classifyRevert(revertData("0x71c4efed")).rule, "unclassified");
    assert.equal(classifyRevert(revertData("0x71c4efed")).retryable, true);
  });

  it("a spend cap is refused for THIS arm, not retried a thousand times until the window rolls", async () => {
    // The one class whose cause changes on its own — the window is a day — and
    // still not retryable. A retry every tick is up to a thousand reverted
    // UserOperations paying gas to be told the same thing, which is the loop
    // this file's header exists to have stopped. The suppression map is cleared
    // at every arm (worker/src/index.ts), so this self-heals rather than
    // lasting for ever, and the owner's own key can raise the cap meanwhile.
    const { toFunctionSelector } = await import("viem");
    const sel = toFunctionSelector("function SpendCapExceeded(uint256,uint256)");
    const v = classifyRevert(revertData(sel));
    assert.equal(v.rule, "spend-cap");
    assert.equal(v.retryable, false);
    assert.match(v.detail, /clears when the window rolls/);
    // Derived, not remembered: the table's entry must be this selector.
    assert.ok(PONS_ERROR_SELECTORS.includes(sel), `${sel} is not in the table`);
  });

  it("the selectors are four bytes and all distinct", () => {
    // Cheap guard against a paste error turning two errors into one bucket.
    for (const s of PONS_ERROR_SELECTORS) assert.match(s, /^0x[0-9a-f]{8}$/);
    assert.equal(new Set(PONS_ERROR_SELECTORS).size, PONS_ERROR_SELECTORS.length);
  });

  it("EVERY error declared in PonsSelfTrade.sol is classified", () => {
    // The drift guard that matters. Adding an error to the .sol without adding
    // it here means a new permanent failure silently becomes retryable — which
    // is precisely the bug this whole block exists to fix, one release later.
    const sol = readFileSync(
      new URL("../../contracts/contracts/PonsSelfTrade.sol", import.meta.url),
      "utf8",
    );
    const declared = errorsIn(sol);
    assert.ok(declared.length >= 12, `expected the .sol to declare errors, found ${declared.length}`);
    for (const sig of declared) {
      const sel = toFunctionSelector(`function ${sig}`);
      assert.notEqual(
        classifyRevert(`execution reverted: ${sel}`).rule,
        "unclassified",
        `${sig} (${sel}) is declared in PonsSelfTrade.sol but classifies as unclassified`,
      );
    }
  });

  it("EVERY error a session key can reach in PonsClassVaultV2.sol is classified", () => {
    /**
     * THE GUARD THAT WOULD HAVE CAUGHT THE DEFECT ABOVE.
     *
     * v2 widened SpendCapExceeded by one argument, which changes the selector.
     * A scan of the .sol is the only check of the right shape: the signature
     * lives in one file and the classification in another, and nothing else
     * connects them.
     *
     * SCOPED TO WHAT A SESSION KEY CAN REACH, and the exclusions are the point
     * rather than a convenience. The setter and constructor errors are raised
     * only by an OWNER transaction — the wall does not name `setQuoteCaps`, and
     * a constructor runs once inside a batch that reverts whole — so a session
     * key cannot produce them. Classifying an error for a path the worker cannot
     * take would be a guess wearing a citation, which is exactly what this
     * file's header forbids.
     */
    const sol = readFileSync(
      new URL("../../contracts/contracts/PonsClassVaultV2.sol", import.meta.url),
      "utf8",
    );
    const OWNER_ONLY = new Set([
      "CapTooLarge", // setQuoteCaps, owner tx
      "ZeroCap", // constructor
      "DuplicateQuote", // constructor
      "ZeroQuote", // setQuoteCaps / constructor
      "EmptySeed", // constructor and factory constructor
      "TooManyQuotes", // setQuoteCaps
      "LengthMismatch", // setQuoteCaps and factory constructor
      "TooManySeedQuotes", // factory constructor
      "DuplicateSeedQuote", // factory constructor
      "SeedCapTooLarge", // factory constructor
      "ZeroSeedQuote", // factory constructor
      "ZeroSeedCap", // factory constructor
      "ZeroOwner", // constructor
      "NotOwner", // a wrong caller, which is a wiring fault and not a trade outcome
    ]);
    const declared = errorsIn(sol).filter((sig) => !OWNER_ONLY.has(sig.slice(0, sig.indexOf("("))));
    assert.ok(declared.length >= 8, `expected reachable errors, found ${declared.length}: ${declared}`);
    for (const sig of declared) {
      const sel = toFunctionSelector(`function ${sig}`);
      assert.notEqual(
        classifyRevert(`execution reverted: ${sel}`).rule,
        "unclassified",
        `${sig} (${sel}) is declared in PonsClassVaultV2.sol and a session key can reach it, but it ` +
          `classifies as unclassified — which this file treats as RETRYABLE`,
      );
    }
  });

  it("and the v1 vault's reachable errors stay classified — it is still deployed", () => {
    const sol = readFileSync(
      new URL("../../contracts/contracts/PonsClassVault.sol", import.meta.url),
      "utf8",
    );
    const OWNER_ONLY = new Set(["ZeroOwner", "NotOwner"]);
    for (const sig of errorsIn(sol).filter((s) => !OWNER_ONLY.has(s.slice(0, s.indexOf("("))))) {
      const sel = toFunctionSelector(`function ${sig}`);
      assert.notEqual(
        classifyRevert(`execution reverted: ${sel}`).rule,
        "unclassified",
        `${sig} (${sel}) is declared in the DEPLOYED v1 vault but classifies as unclassified`,
      );
    }
  });
});

/** Every `error Name(args);` a .sol declares, as a canonical signature. */
function errorsIn(sol: string): string[] {
  return [...sol.matchAll(/^\s*error\s+(\w+)\s*\(([^)]*)\)\s*;/gm)].map((m) => {
    const args = (m[2] ?? "")
      .split(",")
      .map((a) => a.trim().split(/\s+/)[0])
      .filter(Boolean)
      .join(",");
    return `${m[1]}(${args})`;
  });
}

/**
 * THE KEY THE WRITER STORES MUST BE THE KEY THE READER LOOKS UP.
 *
 * `suppressionKey` was tested here in isolation — case, direction, kind — and
 * every one of those tests passed while curve suppression was completely dead.
 * Both call sites were correct about the function and wrong about each other:
 * the writer passed the curve's legs, the reader passed undefined, and
 * `curve-trade:0xin->0xout` never matched `curve-trade:->`.
 *
 * A non-retryable curve revert was therefore classified, warned about, recorded
 * as suppressed, and re-proposed sixty seconds later — forever, each attempt a
 * real UserOp and real gas — while the tape said it had been stopped.
 *
 * These tests are the round trip, which is the only shape that could have
 * caught it.
 */
describe("suppression survives the round trip, for every kind that has legs", () => {
  const A = "0xAAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA";
  const B = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb";

  const intents = [
    { kind: "swap", sellToken: A, buyToken: B },
    { kind: "curve-trade", assetIn: A, assetOut: B, curve: A, target: B },
    { kind: "vault-deposit", target: A },
    { kind: "transfer", target: A, recipient: B },
    { kind: "energy-buy", target: B, sellToken: A, buyToken: B },
  ] as const;

  for (const intent of intents) {
    it(`${intent.kind}: what is written is what is read`, () => {
      // The writer's key.
      const written = suppressionKey(intent.kind, ...suppressionLegs(intent));
      const store = new Map<string, string>([[written, "graduated"]]);
      // The reader's key, derived independently the same way.
      const read = suppressionKey(intent.kind, ...suppressionLegs(intent));
      assert.equal(store.get(read), "graduated", `${intent.kind} suppression did not survive`);
    });
  }

  it("a curve suppression is scoped to ITS pair, not to the whole venue", () => {
    // The over-broad version this replaced: one graduated token took every
    // curve trade down with it for the rest of the arm.
    const one = suppressionKey("curve-trade", ...suppressionLegs(intents[1]));
    const other = suppressionKey(
      "curve-trade",
      ...suppressionLegs({ kind: "curve-trade", assetIn: A, assetOut: A }),
    );
    assert.notEqual(one, other);
  });

  it("and a swap and a curve trade over the same pair stay distinct", () => {
    assert.notEqual(
      suppressionKey("swap", ...suppressionLegs(intents[0])),
      suppressionKey("curve-trade", ...suppressionLegs(intents[1])),
    );
  });

  it("a kind with no legs still gets a stable key rather than throwing", () => {
    assert.equal(suppressionKey("vault-deposit", ...suppressionLegs(intents[2])), "vault-deposit:->");
  });

  it("THE ENERGY BUY NAMES ITS LEGS, and its key never collides with a swap over the same tokens", () => {
    // Legs, not `energy-buy:->`: a suppression is scoped to its pair like every
    // other kind that has one. And the kind is in the key, so a non-retryable
    // energy revert never silences an ordinary swap of the same pair.
    const energy = suppressionKey("energy-buy", ...suppressionLegs(intents[4]));
    assert.notEqual(energy, "energy-buy:->");
    assert.notEqual(energy, suppressionKey("swap", ...suppressionLegs(intents[0])));
    assert.deepEqual(suppressionLegs(intents[4]), [A, B]);
  });
});

describe("both call sites derive the key the same way", () => {
  // The round-trip tests above prove the FUNCTION is consistent. They cannot
  // prove index.ts calls it at both ends, and "one end was updated" is the
  // entire bug. So this reads the source.
  const CODE = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

  it("every suppressionKey call in the worker goes through suppressionLegs", () => {
    const calls = CODE.match(/suppressionKey\([^)]*\)/g) ?? [];
    assert.ok(calls.length >= 2, "expected a read site and a write site");
    for (const call of calls) {
      assert.match(call, /suppressionLegs\(intent\)/, `hand-rolled legs: ${call}`);
    }
  });

  it("and no site special-cases swap on its own any more", () => {
    assert.ok(
      !/suppressionKey\(\s*intent\.kind,\s*intent\.kind === "swap"/.test(CODE),
      "the read site's swap-only derivation is what silently disabled curve suppression",
    );
  });
});
