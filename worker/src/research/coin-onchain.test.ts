/**
 * WHAT THE ONCHAIN ANALYST IS TOLD, AND WHAT IT IS NEVER TOLD.
 *
 * The verdicts are tested where they are computed (onchain-forensics.test.ts)
 * and the rows where they are read (onchain-reader.test.ts). What is left here
 * is the part that only exists in prose, and it is the part that decides
 * whether a model draws the right conclusion: the sample travelling with every
 * number, the distribution section being ABSENT rather than hedged when the
 * window missed the beginning, and the standing refusal to be read as a safety
 * check.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderOnchain } from "./coin-onchain";
import type { OnchainScan } from "./onchain-reader";

const at = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const CURVE = at(999);

const scanOf = (over: Partial<OnchainScan> = {}): OnchainScan => ({
  fromBlock: 0n,
  toBlock: 1_000_000n,
  scanned: true,
  wholeHistory: true,
  why: null,
  holders: [],
  acquisitions: [],
  trades: [],
  amounts: [],
  transfers: 10,
  ...over,
});

const render = (over: Partial<OnchainScan> = {}) =>
  renderOnchain({ symbol: "WSB", scan: scanOf(over), venues: [CURVE] });

describe("the sample travels with the verdict", () => {
  it("IT SAYS WHAT IT READ BEFORE IT SAYS ANYTHING IT READ", () => {
    const out = render({ transfers: 757 })!;
    const head = out.split("\n\n")[0]!;
    assert.match(head, /757 Transfer logs/);
    assert.match(head, /28\.0 hours/, "the window is stated as time, not as a block count");
  });

  it("and a complete window says so, because it is better than an explorer's page", () => {
    const out = render({ holders: [{ address: at(1), raw: 10n }] })!;
    assert.match(out, /COMPLETE — every holder, not a top-N page/);
  });
});

describe("a window that missed the beginning", () => {
  it("WITHHOLDS DISTRIBUTION ENTIRELY — not hedged, not marked approximate", () => {
    // Balances rebuilt from a partial window are net flow. A hedged wrong
    // number is still read as a number.
    const out = render({
      wholeHistory: false,
      why: "3 addresses spent more than we saw arrive, so this window starts after the token did",
      holders: [{ address: at(1), raw: 900n }, { address: at(2), raw: 100n }],
      acquisitions: [{ address: at(1), block: 5 }, { address: at(2), block: 6 }, { address: at(3), block: 7 }],
    })!;
    assert.ok(!/CONCENTRATION/.test(out), "no concentration from a partial window");
    assert.ok(!/BUNDLING|Bundling/.test(out), "and no claim about how the holders arrived");
    assert.match(out, /DISTRIBUTION IS UNAVAILABLE/);
    assert.match(out, /spent more than we saw arrive/, "it repeats the reader's own reason");
  });

  it("AND NAMES THE ABSENCE AS OURS, not as the token looking fine", () => {
    const out = render({ wholeHistory: false, why: "the sweep did not finish" })!;
    assert.match(out, /never as "there was nothing there"/);
  });

  it("but still reports what a window CAN answer", () => {
    // Round trips and clustering are claims about a period. They do not need
    // the token's earlier history to be true, and dropping them would lose
    // real evidence to a flag about a different question.
    const out = render({
      wholeHistory: false,
      why: "the sweep did not finish",
      trades: [
        { trader: at(1), block: 100, delta: 5n },
        { trader: at(1), block: 200, delta: -5n },
      ],
      amounts: [7n, 7n, 7n, 1n],
    })!;
    assert.match(out, /ROUND TRIPS/);
    assert.match(out, /AMOUNT CLUSTERING/);
  });
});

describe("the curve is not a whale", () => {
  it("IT IS EXCLUDED, AND THE EXCLUSION IS STATED", () => {
    // Counting the curve makes every launchpad coin read as 99% owned by one
    // address — true about the rows, false about the coin. Saying so in the
    // prose is what stops a model reading the exclusion as us hiding a whale.
    const out = render({
      holders: [
        { address: CURVE, raw: 92_000n },
        { address: at(1), raw: 4_000n },
        { address: at(2), raw: 4_000n },
      ],
    })!;
    assert.match(out, /CONCENTRATION: the largest 2 of 2 holders control 100\.0%/);
    assert.match(out, /a bonding curve holding most of its own supply is the market, not a whale/);
  });

  it("and everything still in the curve is NO FLOAT, not 0% and not 100%", () => {
    const out = render({ holders: [{ address: CURVE, raw: 1_000n }] })!;
    assert.match(out, /No float/);
    assert.match(out, /Not 0% concentrated and not 100%/);
  });
});

describe("round trips are a ratio, never a verdict", () => {
  it("THE DENOMINATOR IS IN THE SENTENCE", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ trader: at(i + 10), block: 1, delta: 5n }));
    const out = render({
      trades: [...many, { trader: at(10), block: 2, delta: -5n }],
    })!;
    assert.match(out, /1 of 40 wallets/);
    assert.match(out, /Read the ratio, not the count/);
  });

  it("and no trades at all is stated as nothing to judge, not as clean", () => {
    const out = render({ trades: [] })!;
    assert.match(out, /no venue trades in this window at all/);
  });
});

describe("clustering is judged by share, not by count", () => {
  it("A SHOUTED HEADING NEEDS A MATERIAL SHARE", () => {
    // Straight from the live probe: seven repeats among 617 real transfers
    // rendered as "AMOUNT CLUSTERING: … 1.1%". A model reading a shouted
    // heading does not go on to weigh the ratio underneath it.
    const noise = [...Array.from({ length: 610 }, (_, i) => BigInt(i + 1)), ...Array(7).fill(9_999n)];
    const out = render({ amounts: noise })!;
    assert.ok(!/AMOUNT CLUSTERING/.test(out), "1.1% is not a finding");
    assert.match(out, /which is not a pattern/);
    assert.match(out, /7 times in 617 transfers/, "the evidence is kept, only the framing changes");
  });

  it("and a distributor still gets the heading", () => {
    const out = render({ amounts: [5n, 5n, 5n, 5n, 5n, 1n, 2n, 3n, 4n, 6n] })!;
    assert.match(out, /AMOUNT CLUSTERING: 5 of 10/);
  });
});

describe("the refusal", () => {
  it("EVERY REPORT SAYS IT IS NOT A SAFETY CHECK", () => {
    // The most expensive conclusion an analyst could draw from a clean
    // distribution is "safe to buy". None of the things that would justify
    // that were available to build this from, so the prose says so every time
    // rather than leaving it to a reader who has just been handed four
    // reassuring numbers.
    for (const scan of [{}, { wholeHistory: false, why: "x" }, { trades: [] }]) {
      const out = render(scan)!;
      assert.match(out, /WHAT THIS IS NOT: a safety check/);
      assert.match(out, /no honeypot simulation/);
      assert.match(out, /must\s+not be treated as permission to size up/);
    }
  });
});

describe("nothing to say is null, not an empty report", () => {
  it("no transfers at all omits the lens", () => {
    assert.equal(render({ transfers: 0 }), null);
  });
});
