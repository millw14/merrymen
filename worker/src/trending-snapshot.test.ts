import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TRENDING_EXECUTABLE_RESERVE, pickShortlist, safeSymbol } from "./trending-snapshot";

/**
 * THE SHORTLIST MUST ALWAYS CONTAIN THE TICK'S OWN UNIVERSE.
 *
 * The trending score is quote-blind, and on the live tape the ETH-quoted
 * curves out-trade the USDG ones many times over, so a top-N cut by score
 * held zero executable candidates on the first widened run — and the
 * comparison the shadow exists for (Brain vs `chooseEntry`) never ran. The
 * reserved slots make that impossible by construction.
 */

const item = (score: number, executable: boolean, name: string) => ({ score, executable, name });

describe("pickShortlist", () => {
  it("top-N by score, plus the top-K executable that the score left out, tagged", () => {
    const ranked = [item(9, false, "e1"), item(8, false, "e2"), item(7, false, "e3"), item(6, true, "u1"), item(5, false, "e4"), item(4, true, "u2"), item(3, true, "u3")];
    const { picked, executableOutside } = pickShortlist(ranked, 3, 2);
    assert.deepEqual(
      picked.map((p) => [p.item.name, p.by]),
      [
        ["e1", "trending"],
        ["e2", "trending"],
        ["e3", "trending"],
        ["u1", "executable-reserve"],
        ["u2", "executable-reserve"],
      ],
    );
    assert.equal(executableOutside, 1, "u3 traded but was not read — the report must say so");
  });

  it("an executable curve already in the top-N counts against the reserve and is listed once", () => {
    const ranked = [item(9, true, "u1"), item(8, false, "e1"), item(7, true, "u2"), item(6, true, "u3")];
    const { picked, executableOutside } = pickShortlist(ranked, 2, 2);
    assert.deepEqual(
      picked.map((p) => [p.item.name, p.by]),
      [
        ["u1", "trending"],
        ["e1", "trending"],
        ["u2", "executable-reserve"],
      ],
    );
    assert.equal(executableOutside, 1);
  });

  it("with no executable curves at all the list is just the top-N and nothing is 'outside'", () => {
    const ranked = [item(3, false, "a"), item(2, false, "b")];
    const { picked, executableOutside } = pickShortlist(ranked, 1, TRENDING_EXECUTABLE_RESERVE);
    assert.deepEqual(picked.map((p) => p.item.name), ["a"]);
    assert.equal(executableOutside, 0);
  });

  it("the reserve is the tick's own read cap", () => {
    // index.ts CLASS_MAX_READS = 8: the executable universe the tick would
    // have read is exactly what the shadow must always read too.
    assert.equal(TRENDING_EXECUTABLE_RESERVE, 8);
  });
});

describe("safeSymbol", () => {
  it("never yields anything hex-shaped, and falls back to the handle", () => {
    assert.equal(safeSymbol("0xDEADBEEFDEADBEEFDEAD", "TC01"), "TC01");
    assert.equal(safeSymbol("", "TC01"), "TC01");
    assert.equal(safeSymbol("WIF!!", "TC01"), "WIF");
  });
});
