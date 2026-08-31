import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

/**
 * WHERE THE MONEY GOES, so this is worth pinning precisely.
 *
 * A user with 1010 USDG followed every step correctly, pasted his exchange
 * address, and found the sweep button disabled with nothing said. The address
 * was bare 40-hex with no `0x` — which plenty of wallets and explorers copy that
 * way, and which is unambiguously an address missing its prefix.
 *
 * The rule this file guards is narrow on purpose: normalise ONLY what cannot be
 * anything else, and leave everything else invalid so the user is told rather
 * than guessed at. A normaliser that got clever here would send funds somewhere
 * nobody typed.
 *
 * The rule lives in its own module rather than inside the panel precisely so it
 * can be tested without a browser — the component is "use client", the rule is
 * pure. The last assertion still reads the component source, because what it
 * checks is a property OF the panel: that the confirm dialog shows the same
 * address the operation will pay.
 */

import { isAddr, normalizeAddr } from "./address";

const SRC = readFileSync(new URL("../components/RecoverPanel.tsx", import.meta.url), "utf8");
const REAL = "0x7060B218E0B11F37450A8835664fa748dB1FcC1E";
const BARE = "7060B218E0B11F37450A8835664fa748dB1FcC1E";

describe("what a person may paste", () => {
  it("accepts a normal address unchanged", () => {
    assert.equal(normalizeAddr(REAL), REAL);
    assert.equal(isAddr(REAL), true);
  });

  it("ACCEPTS bare 40-hex — the case that blocked a real withdrawal", () => {
    assert.equal(normalizeAddr(BARE), `0x${BARE}`);
    assert.equal(isAddr(BARE), true);
  });

  it("survives the whitespace a phone paste adds", () => {
    for (const v of [` ${REAL}`, `${REAL} `, `\n${REAL}\n`, ` ${BARE} `]) {
      assert.equal(isAddr(v), true, JSON.stringify(v));
      assert.match(normalizeAddr(v), /^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("handles an ethereum: URI from a QR scan", () => {
    assert.equal(normalizeAddr(`ethereum:${REAL}`), REAL);
    assert.equal(normalizeAddr(`ethereum:${REAL}?value=0`), REAL);
    assert.equal(isAddr(`ethereum:${REAL}`), true);
  });
});

describe("what it must NOT quietly accept", () => {
  it("refuses anything that is not exactly an address", () => {
    // Each of these could only be normalised by GUESSING, and a guess here sends
    // somebody's balance to an address they never typed.
    for (const v of [
      "",
      "0x",
      REAL.slice(0, -1), // one char short
      `${REAL}0`, // one char long
      BARE.slice(0, -1),
      "0xZZZZ218E0B11F37450A8835664fa748dB1FcC1E",
      "my okx wallet",
      "0x7060B218E0B11F37450A8835664fa748dB1FcC1E extra",
    ]) {
      assert.equal(isAddr(v), false, `must refuse: ${JSON.stringify(v)}`);
    }
  });

  it("does not invent a prefix for a short hex string", () => {
    // 39 hex is not an address with a missing prefix; it is a typo.
    assert.equal(isAddr("7060B218E0B11F37450A8835664fa748dB1FcC1"), false);
  });
});

describe("the confirm dialog shows the address that will be paid", () => {
  it("uses the normalised value, not the raw input", () => {
    // Otherwise the prompt says one thing and the operation does another — which
    // on an irreversible transfer is the worst possible place for a mismatch.
    assert.doesNotMatch(
      SRC,
      /Sweep \$\{list\} to \$\{to\.trim\(\)\}/,
      "the confirm text must show the normalised destination",
    );
    assert.match(SRC, /Sweep \$\{list\} to \$\{normalizeAddr\(to\)\}/);
  });
});
