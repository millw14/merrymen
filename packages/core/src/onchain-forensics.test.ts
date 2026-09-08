/**
 * THE FOUR QUESTIONS, AND THE ANSWERS THEY MUST REFUSE TO GIVE.
 *
 * Ported from ChainMind's holder and swap forensics, which is the indexer-side
 * analysis merrymen's `onchain` lens has never had a supplier for.
 *
 * The tests that matter are the refusals, for the same reason they were in the
 * snipe resolver: a forensics module that always returns a number gets believed.
 * A bonding curve holding 92% of supply is not a whale; a hundred wallets that
 * arrived in one block window are not a hundred holders; and a window measured
 * in blocks means nothing at all if it is carried to a chain with a different
 * block time.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  amountClusters,
  concentrationOf,
  detectBundle,
  excludedSet,
  roundTrips,
  type HolderRow,
} from "./onchain-forensics";

const at = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const h = (n: number, raw: bigint): HolderRow => ({ address: at(n), raw });

describe("concentration is over the real float", () => {
  it("THE CURVE IS NOT A WHALE", () => {
    // A launchpad token holds most of its own supply in its curve by
    // construction. Counting it makes every one of them read as 99% owned by a
    // single address — a true statement about the rows and a false one about
    // the coin.
    const curve = at(999);
    const rows = [h(1, 10n), h(2, 10n), h(3, 10n), h(4, 10n), { address: curve, raw: 100_000n }];
    const c = concentrationOf(rows, { top: 1, exclude: { venues: [curve] } })!;
    assert.equal(c.counted, 4);
    assert.equal(c.excluded, 1);
    assert.equal(c.topBps, 2_500, "one of four equal holders is 25%, not 99%");
  });

  it("and burn addresses are excluded supply, not somebody's holding", () => {
    const rows = [h(1, 50n), { address: "0x000000000000000000000000000000000000dEaD", raw: 50n }];
    const c = concentrationOf(rows, { top: 1 })!;
    assert.equal(c.counted, 1);
    assert.equal(c.topBps, 10_000, "the only real holder has all of the float");
  });

  it("NO FLOAT MEANS NO CONCENTRATION — not zero, and not a hundred percent", () => {
    // Everything still in the curve. Both 0% and 100% would be inventions about
    // a distribution that does not exist yet.
    const curve = at(999);
    assert.equal(concentrationOf([{ address: curve, raw: 1_000n }], { exclude: { venues: [curve] } }), null);
    assert.equal(concentrationOf([], {}), null);
  });

  it("and the sample travels with the verdict", () => {
    // A top-10 share computed over the first page of an indexer is a different
    // claim from one over every holder, and only one of them is what it looks
    // like.
    const partial = concentrationOf([h(1, 5n), h(2, 5n)], { complete: false })!;
    assert.equal(partial.complete, false);
    assert.equal(concentrationOf([h(1, 5n)], {})!.complete, true);
  });

  it("and asking for more holders than exist does not fabricate them", () => {
    const c = concentrationOf([h(1, 5n), h(2, 5n)], { top: 50 })!;
    assert.equal(c.n, 2);
    assert.equal(c.topBps, 10_000);
  });
});

describe("bundling: did they arrive as one actor", () => {
  it("A HUNDRED WALLETS IN ONE WINDOW IS ONE ACTOR", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ address: at(i + 1), block: 1_000 + i }));
    const b = detectBundle(rows, 2_500)!;
    assert.equal(b.size, 100);
    assert.equal(b.shareBps, 10_000);
  });

  it("and genuine arrivals spread over time are not a bundle", () => {
    // One acquisition every 10,000 blocks against a 2,500-block window.
    const rows = Array.from({ length: 20 }, (_, i) => ({ address: at(i + 1), block: 1 + i * 10_000 }));
    assert.equal(detectBundle(rows, 2_500), null);
  });

  it("IT FINDS THE DENSEST WINDOW, not merely the first", () => {
    // Three early stragglers then a cluster of six. A scan that stopped at the
    // first window would report the stragglers and miss the bundle.
    const rows = [
      { address: at(1), block: 10 },
      { address: at(2), block: 5_000 },
      { address: at(3), block: 12_000 },
      ...Array.from({ length: 6 }, (_, i) => ({ address: at(20 + i), block: 50_000 + i })),
    ];
    const b = detectBundle(rows, 100)!;
    assert.equal(b.size, 6);
    assert.equal(b.fromBlock, 50_000);
  });

  it("AND A WINDOW IT CANNOT TRUST PRODUCES NOTHING", () => {
    // ChainMind's 2,500 blocks was derived from chain 4663 at ~9.4 blocks a
    // second. Carried to a chain with another block time it measures nothing —
    // so the window is a required argument and a nonsensical one refuses.
    const rows = Array.from({ length: 50 }, (_, i) => ({ address: at(i + 1), block: 1_000 + i }));
    for (const bad of [0, -1, Number.NaN]) assert.equal(detectBundle(rows, bad), null, String(bad));
  });

  it("and two neighbours are not a bundle", () => {
    assert.equal(detectBundle([{ address: at(1), block: 5 }, { address: at(2), block: 6 }], 100), null);
  });
});

describe("round trips: is the volume real", () => {
  it("A WALLET THAT BOUGHT AND SOLD INSIDE THE WINDOW IS COUNTED", () => {
    const r = roundTrips(
      [
        { trader: at(1), block: 100, delta: 5n },
        { trader: at(1), block: 120, delta: -5n },
        { trader: at(2), block: 100, delta: 5n },
      ],
      100,
    )!;
    assert.equal(r.traders, 1);
    assert.equal(r.total, 2);
    assert.equal(r.shareBps, 5_000);
  });

  it("and a buy held past the window is not a round trip", () => {
    const r = roundTrips(
      [
        { trader: at(1), block: 100, delta: 5n },
        { trader: at(1), block: 100_000, delta: -5n },
      ],
      100,
    )!;
    assert.equal(r.traders, 0);
  });

  it("IT REPORTS A RATIO, NOT A VERDICT", () => {
    // 8 of 10 and 8 of 400 are different facts about a market and the second is
    // unremarkable. Returning the denominator is what keeps the reader honest.
    const many = Array.from({ length: 400 }, (_, i) => ({ trader: at(i + 1), block: 1, delta: 5n }));
    const r = roundTrips([...many, { trader: at(1), block: 2, delta: -5n }], 100)!;
    assert.equal(r.total, 400);
    assert.equal(r.traders, 1);
  });

  it("and nothing to examine is null rather than a clean bill", () => {
    assert.equal(roundTrips([], 100), null);
    assert.equal(roundTrips([{ trader: at(1), block: 1, delta: 0n }], 100), null);
  });
});

describe("amount clustering: are the amounts human", () => {
  it("THE SAME RAW AMOUNT REPEATED IS A SCRIPT", () => {
    const c = amountClusters([100n, 100n, 100n, 100n, 37n, 91n])!;
    assert.equal(c.amount, 100n);
    assert.equal(c.count, 4);
    assert.ok(c.shareBps > 6_000);
  });

  it("and amounts that all differ cluster on nothing", () => {
    assert.equal(amountClusters([1n, 2n, 3n, 4n, 5n, 6n]), null);
  });

  it("and too few transfers to have a pattern says nothing", () => {
    assert.equal(amountClusters([100n, 100n]), null);
  });
});

describe("the exclusion set", () => {
  it("ALWAYS CARRIES ZERO AND DEAD, whatever the caller passes", () => {
    const s = excludedSet();
    assert.ok(s.has("0x0000000000000000000000000000000000000000"));
    assert.ok(s.has("0x000000000000000000000000000000000000dead"));
  });

  it("and it is case-insensitive, because addresses arrive checksummed", () => {
    const s = excludedSet({ venues: ["0xAbCdEf0000000000000000000000000000000001"] });
    assert.ok(s.has("0xabcdef0000000000000000000000000000000001"));
  });
});
