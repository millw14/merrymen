/**
 * THE NUMBERS THAT REACHED A REAL OWNER'S SCREEN, pinned so they cannot again.
 *
 * Each case here is a figure this system actually published: +999.48 on a book
 * that was down 0.52, a fabricated -100%, a -66.7% derived from netting trade
 * legs as withdrawals. The gate that stops them is now in ONE place, and these
 * are the inputs that used to get past the five that disagreed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPortfolioSnapshot,
  computePnl,
  microToString,
  pnlPercent,
  toMicro,
  type PortfolioQuality,
  type SnapshotPosition,
} from "./portfolio-snapshot";

const GOOD: PortfolioQuality = {
  auditPassed: true,
  epoch: 2,
  contributionsKnown: true,
  equityComplete: true,
  gasBasis: "net",
  positionHistoryAvailable: true,
  quarantinedAssetsPresent: false,
  assessedAt: 1_788_000_000,
};

const pos = (over: Partial<SnapshotPosition> = {}): SnapshotPosition => ({
  instrumentId: "merrymen:tsla",
  symbol: "TSLA",
  qtyRaw: "4420417000000000",
  valueUsdg: toMicro(6.55),
  costBasisUsdg: toMicro(6.666),
  priceSource: "chainlink",
  quarantined: false,
  ...over,
});

const build = (over: Partial<Parameters<typeof buildPortfolioSnapshot>[0]> = {}) =>
  buildPortfolioSnapshot({
    snapshotId: "snap_1",
    agentId: "0xagent",
    asOf: 1_788_000_000,
    epoch: 2,
    cashUsdg: toMicro(3.334),
    netContributionsUsdg: toMicro(10),
    gasUsdg: toMicro(0.01),
    positions: [pos()],
    quality: GOOD,
    ...over,
  });

describe("money never becomes a float across the boundary", () => {
  it("round-trips through integer micro-USDG", () => {
    assert.equal(toMicro(3.334), 3_334_000);
    assert.equal(microToString(3_334_000), "3.334000");
    assert.equal(microToString(10_000_000), "10.000000");
    assert.equal(microToString(-59_000_000_000), "-59000.000000");
    assert.equal(microToString(1), "0.000001");
  });

  it("does not lose the sixth decimal the way a float would", () => {
    // 0.1 + 0.2 territory. The ledger stores REAL and the chain speaks base
    // units; this is the seam where the difference used to disappear.
    const m = toMicro(1.666500) * 4;
    assert.equal(m, 6_666_000);
    assert.equal(microToString(m), "6.666000");
  });
});

describe("the equity identity is computed in one place", () => {
  it("is cash + vault + positions + quarantined", () => {
    const s = build({
      cashUsdg: toMicro(3.334),
      vaultUsdg: toMicro(1),
      quarantinedUsdg: toMicro(2),
      positions: [pos({ valueUsdg: toMicro(6.55) })],
    });
    assert.equal(s.equityUsdg, toMicro(3.334) + toMicro(1) + toMicro(6.55) + toMicro(2));
    assert.equal(microToString(s.equityUsdg), "12.884000");
  });

  it("does not double-count a quarantined position", () => {
    // Quarantined holdings are carried at cost in `quarantinedUsdg`, so counting
    // their market value again in `positionsUsdg` would inflate the book by an
    // asset that cannot be sold.
    const s = build({
      quarantinedUsdg: toMicro(5),
      positions: [pos({ valueUsdg: toMicro(6.55) }), pos({ symbol: "DEAD", valueUsdg: toMicro(99), quarantined: true })],
    });
    assert.equal(s.positionsUsdg, toMicro(6.55));
    assert.equal(s.equityUsdg, toMicro(3.334) + toMicro(6.55) + toMicro(5));
  });
});

describe("P&L refuses rather than fabricating", () => {
  it("publishes when the book supports it", () => {
    const s = build();
    assert.equal(s.pnl.publishable, true);
    // 9.884 equity − 10 contributed − 0.01 gas
    assert.equal(microToString(s.pnl.usdgSinceContribution!), "-0.126000");
    assert.equal(s.pnl.gasBasis, "net");
  });

  it("REFUSES when contributions are unknown — the +999.48 case", () => {
    // A ledger written before flow tracking knows nothing about what was put in.
    // Equity minus zero is the bankroll, and it was once published as profit on
    // a book that was actually down 0.52.
    const s = build({ netContributionsUsdg: null, cashUsdg: toMicro(999.48), positions: [] });
    assert.equal(s.pnl.publishable, false);
    assert.equal(s.pnl.unavailable, "contributions-unknown");
    assert.equal(s.pnl.usdgSinceContribution, null);
    assert.equal(pnlPercent(s), null);
  });

  it("REFUSES when the flag says unknown even if a figure is present", () => {
    // Both halves have to agree. A number with `contributionsKnown: false`
    // behind it is exactly the inferred row this system spent a repair removing.
    const s = build({ quality: { ...GOOD, contributionsKnown: false } });
    assert.equal(s.pnl.unavailable, "contributions-unknown");
  });

  it("REFUSES on zero contributed capital rather than dividing by it", () => {
    // The repaired paper books land here: known, and known to be zero. That is
    // knowledge, but it is not a denominator — this is the -100% case.
    const s = build({ netContributionsUsdg: 0 });
    assert.equal(s.pnl.unavailable, "no-capital-contributed");
    assert.equal(pnlPercent(s), null);
  });

  it("REFUSES in epoch 1, which is forensic by construction", () => {
    const s = build({ quality: { ...GOOD, epoch: 1 } });
    assert.equal(s.pnl.unavailable, "epoch-unauditable");
  });

  it("REFUSES on a gappy equity series", () => {
    const s = build({ quality: { ...GOOD, equityComplete: false } });
    assert.equal(s.pnl.unavailable, "equity-incomplete");
  });

  it("reports the reasons in the order they actually bite", () => {
    // Unknown contributions and epoch 1 together must report UNKNOWN, not
    // EPOCH: they send whoever reads it to different places, and the
    // denominator is the more fundamental problem.
    const s = build({ netContributionsUsdg: null, quality: { ...GOOD, epoch: 1, contributionsKnown: false } });
    assert.equal(s.pnl.unavailable, "contributions-unknown");
  });
});

describe("gross-of-gas never masquerades as net", () => {
  it("marks the basis gross when gas could not be priced", () => {
    const s = build({ gasUsdg: null });
    assert.equal(s.pnl.publishable, true);
    assert.equal(s.pnl.gasBasis, "gross", "the qualifier travels with the figure");
    // Unsubtracted, because it is unknown — not silently treated as zero cost.
    assert.equal(microToString(s.pnl.usdgSinceContribution!), "-0.116000");
  });

  it("carries the qualifier even on a healthy book", () => {
    const s = build({ quality: { ...GOOD, gasBasis: "gross" } });
    assert.equal(s.pnl.gasBasis, "gross");
  });
});

describe("the canary, after its repair", () => {
  it("reads 10 USDG contributed and a publishable P&L", () => {
    // The real post-repair figures: 3.334 cash, 6.55 in TSLA, 10.000000
    // contributed and evidenced. Before the repair this account carried three
    // inferred rows totalling 30 and contributionsKnown was false.
    const s = build({
      cashUsdg: toMicro(3.334),
      positions: [pos({ valueUsdg: toMicro(6.55) })],
      netContributionsUsdg: toMicro(10),
      grossContributionsUsdg: toMicro(10),
      grossWithdrawalsUsdg: 0,
      gasUsdg: null,
    });
    assert.equal(microToString(s.equityUsdg), "9.884000");
    assert.equal(microToString(s.netContributionsUsdg!), "10.000000");
    assert.equal(s.pnl.publishable, true);
    assert.equal(microToString(s.pnl.usdgSinceContribution!), "-0.116000");
    assert.ok(Math.abs(pnlPercent(s)! - -1.16) < 0.001);
    // And never the pre-repair figure derived from netting trade legs.
    assert.notEqual(microToString(s.netContributionsUsdg!), "3.334000");
  });

  it("keeps gross apart from net, because net zero is not 'never funded'", () => {
    const s = build({
      netContributionsUsdg: 0,
      grossContributionsUsdg: toMicro(1010),
      grossWithdrawalsUsdg: toMicro(1010),
    });
    assert.equal(microToString(s.grossContributionsUsdg!), "1010.000000");
    assert.equal(s.netContributionsUsdg, 0);
    assert.equal(s.pnl.unavailable, "no-capital-contributed");
  });
});

describe("computePnl is the only gate", () => {
  it("is pure and agrees with the snapshot that uses it", () => {
    const s = build();
    const direct = computePnl({
      equityUsdg: s.equityUsdg,
      netContributionsUsdg: s.netContributionsUsdg,
      gasUsdg: s.gasUsdg,
      quality: s.quality,
    });
    assert.deepEqual(direct, s.pnl, "one implementation, not two that drift");
  });
});
