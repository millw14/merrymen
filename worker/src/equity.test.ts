import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { peakBasisMicro } from "../../packages/core/src/perps";
import { accrueAboveHwm } from "./fees";
import {
  bookGaps,
  composeEquityUsdg,
  drawdownBps,
  gasQualifier,
  peakBasisUsdg,
  perpAccountUsdg,
  pnlUsdg,
  PERP_VENUE_GAP,
  type PerpBookPart,
} from "./equity";

const usdg = (v: number) => BigInt(Math.round(v * 1e6));

describe("composeEquityUsdg — one definition, not two", () => {
  it("sums cash, vault, positions and quarantined cost", () => {
    const e = composeEquityUsdg({
      cashUsdg: usdg(700),
      vaultUsdg: usdg(100),
      positionsUsdg: usdg(199.48),
      quarantinedCostUsdg: usdg(25),
    });
    assert.equal(e, usdg(1024.48));
  });

  it("THE DIVERGENCE: dropping quarantined cost understates the book", () => {
    // The equity ROW used to re-derive cash + vault + positions while the fee
    // and the breaker were judged against a total that also included
    // quarantine — so the published curve sat permanently below the figure the
    // performance fee ratcheted on.
    const parts = {
      cashUsdg: usdg(700),
      vaultUsdg: 0n,
      positionsUsdg: usdg(200),
      quarantinedCostUsdg: usdg(50),
    };
    const whole = composeEquityUsdg(parts);
    const rowUsedToWrite = parts.cashUsdg + parts.vaultUsdg + parts.positionsUsdg;
    assert.equal(whole - rowUsedToWrite, usdg(50));
  });

  it("a scout buy is not an instant loss — cash out, cost carried", () => {
    // Cash leaves the wallet for a token we cannot yet price. Without the
    // quarantine term equity drops by the full spend and books a drawdown that
    // never happened.
    const before = composeEquityUsdg({ cashUsdg: usdg(1000), vaultUsdg: 0n, positionsUsdg: 0n, quarantinedCostUsdg: 0n });
    const after = composeEquityUsdg({ cashUsdg: usdg(950), vaultUsdg: 0n, positionsUsdg: 0n, quarantinedCostUsdg: usdg(50) });
    assert.equal(before, after);
  });
});

// The whole reporting path is float — `equity`, `flows` and `fee_accruals` are
// all REAL columns — so these compare within a cent rather than exactly. The
// bigint side of the house (basis, policy) is exact; this side is not, and
// pretending otherwise in a test would just make it flaky.
const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-6, `${a} vs ${b}`);

describe("pnlUsdg — unknown is not zero", () => {
  it("subtracts capital from equity", () => {
    near(pnlUsdg(999.48, 1000), -0.52);
  });

  it("is NULL when contributions are unknown, never the bankroll", () => {
    // The regression in one line: equity minus nothing is what the account
    // holds, and reporting that as profit is the whole bug.
    assert.equal(pnlUsdg(999.48, null), null);
  });

  it("a withdrawal reduces contributions, so profit survives it", () => {
    // Put in 1000, took out 400, book worth 700 → made 100.
    near(pnlUsdg(700, 600), 100);
  });

  it("subtracts gas — the cost equity cannot see", () => {
    // Gas leaves in ETH and equity_usdg is cash + vault + positions, so without
    // this every figure was gross of gas. At the sizes this thing trades that
    // is most of the cost, not a rounding detail.
    near(pnlUsdg(1010, 1000, 3.45), 6.55);
  });

  it("gas cannot turn an unknown into a number", () => {
    assert.equal(pnlUsdg(1010, null, 3.45), null);
  });
});

describe("gasQualifier — 'net of gas' is a claim", () => {
  it("says so plainly when every trade's gas was priced", () => {
    assert.equal(gasQualifier({ usdg: 3.45, unpricedTrades: 0 }), "net of gas");
  });

  it("does not claim 'net of gas' when some gas could not be priced", () => {
    const s = gasQualifier({ usdg: 3.45, unpricedTrades: 2 });
    assert.match(s, /not the full cost/);
    assert.match(s, /2 trade\(s\)/);
  });

  it("distinguishes no gas from unpriced gas", () => {
    assert.equal(gasQualifier({ usdg: 0, unpricedTrades: 0 }), "no gas costs recorded");
  });
});

describe("drawdownBps", () => {
  it("measures the fall from the mark", () => {
    assert.equal(drawdownBps(usdg(1000), usdg(900)), 1_000); // 10%
  });

  it("is zero at or above the mark", () => {
    assert.equal(drawdownBps(usdg(1000), usdg(1000)), 0);
    assert.equal(drawdownBps(usdg(1000), usdg(1200)), 0);
  });

  it("an unset mark is not a 100% drawdown", () => {
    assert.equal(drawdownBps(0n, usdg(500)), 0);
  });

  it("a withdrawal is NOT a drawdown once the mark has moved with it", () => {
    // 1000 in, owner takes 400 home. The mark moves to 600 with the capital, so
    // the book is flat — not 40% under water and tripping the breaker.
    assert.equal(drawdownBps(usdg(600), usdg(600)), 0);
  });
});

describe("bookGaps — an unknown must never be bookable", () => {
  it("is empty when everything read cleanly", () => {
    assert.deepEqual(bookGaps({ unreadBalances: [], positionsReadFailed: false, missingPrice: [] }), []);
  });

  it("names each kind of gap so the operator is told which", () => {
    assert.deepEqual(
      bookGaps({ unreadBalances: ["cash", "vault"], positionsReadFailed: true, missingPrice: ["NVDA"] }),
      ["cash", "vault", "positions", "NVDA"],
    );
  });

  it("a failed position read counts even though it reports no symbols", () => {
    // The silent case: three empty arrays used to look identical to "holds
    // nothing", so the tick wrote positionsUsdg = 0 for a held book.
    assert.deepEqual(
      bookGaps({ unreadBalances: [], positionsReadFailed: true, missingPrice: [] }),
      ["positions"],
    );
  });
});

// ── the perp venue (docs/perps.md rules 11 and 12) ──────────────────────────

/** A venue read, built from per-position U so the gain term is what peakBasis would compute. */
function venue(c: number, m: number, perPosition: readonly number[], transit = 0): PerpBookPart {
  const u = perPosition.map(usdg);
  return {
    collateralMicro: usdg(c),
    isolatedMarginMicro: usdg(m),
    unrealizedMicro: u.reduce((a, b) => a + b, 0n),
    unrealizedGainMicro: u.reduce((a, b) => a + (b > 0n ? b : 0n), 0n),
    inTransitMicro: usdg(transit),
    snapshotTime: 1_790_000_000_000_000,
  };
}
const spot = { cashUsdg: usdg(100), vaultUsdg: 0n, positionsUsdg: usdg(50), quarantinedCostUsdg: 0n };

describe("the venue in equity — C + ΣM + ΣU + T", () => {
  it("AN AGENT WITH NO PERPS COMPOSES EXACTLY AS BEFORE — absent is the known zero, not a different path", () => {
    assert.equal(composeEquityUsdg(spot), usdg(150));
    assert.equal(composeEquityUsdg({ ...spot, perp: undefined }), usdg(150));
    assert.equal(perpAccountUsdg(undefined), 0n);
  });

  it("counts cross collateral, isolated margin, unrealized and in-transit — isolated margin included", () => {
    // Account 22149's shape: nearly everything is isolated margin. The first
    // draft of rule 12 left ΣM out and would have read 150 USDG as 0.10.
    const v = venue(0.329402, 150.733618, [-3.357267]);
    assert.equal(perpAccountUsdg(v), usdg(147.705753));
    assert.equal(composeEquityUsdg({ ...spot, perp: v }), usdg(150) + usdg(147.705753));
  });

  it("AN ISOLATED OPEN AT ZERO PRICE MOVE LEAVES EQUITY WHERE IT WAS — margin moved from C to M, nothing was lost", () => {
    const before = composeEquityUsdg({ ...spot, perp: venue(30, 0, []) });
    const after = composeEquityUsdg({ ...spot, perp: venue(17.5, 12.5, [0]) });
    assert.equal(before, after);
  });

  it("a deposit in transit is still the owner's money: cash down, T up, equity unmoved", () => {
    const before = composeEquityUsdg({ ...spot, perp: venue(0, 0, []) });
    const during = composeEquityUsdg({ ...spot, cashUsdg: usdg(90), perp: venue(0, 0, [], 10) });
    const landed = composeEquityUsdg({ ...spot, cashUsdg: usdg(90), perp: venue(10, 0, []) });
    assert.equal(during, before);
    assert.equal(landed, before);
  });

  it("AN UNREAD VENUE REFUSES TO COMPOSE — a partial total is how a drawdown gets invented", () => {
    assert.throws(() => composeEquityUsdg({ ...spot, perp: "unread" }), /not read/);
  });

  it("and it is a book gap, named, exactly like an unread balance; a read venue or no perps is none", () => {
    const base = { unreadBalances: [] as string[], positionsReadFailed: false, missingPrice: [] as string[] };
    assert.deepEqual(bookGaps({ ...base, perp: "unread" }), [PERP_VENUE_GAP]);
    assert.deepEqual(bookGaps({ ...base, unreadBalances: ["cash"], perp: "unread" }), ["cash", PERP_VENUE_GAP]);
    assert.deepEqual(bookGaps({ ...base, perp: venue(1, 0, []) }), []);
    assert.deepEqual(bookGaps({ ...base, perp: undefined }), []);
    assert.deepEqual(bookGaps(base), []);
  });
});

describe("peakBasisUsdg — every peak ratchets on what is real", () => {
  it("IS EQUITY FOR AN AGENT WITH NO PERPS — every ratchet behaves exactly as before", () => {
    assert.equal(peakBasisUsdg(usdg(150), undefined), usdg(150));
  });

  it("takes each open GAIN out, per position — never the net", () => {
    // Account 6560's mix: two winners, two losers, net negative. The net
    // reading would subtract nothing; per position subtracts both winners.
    const v = venue(1700, 0, [3.56, 4.61, -5.06, -12.42]);
    const equity = composeEquityUsdg({ ...spot, perp: v });
    assert.equal(peakBasisUsdg(equity, v), equity - usdg(8.17));
    // One definition with core's per-position helper.
    assert.equal(peakBasisUsdg(equity, v), peakBasisMicro(equity, [3.56, 4.61, -5.06, -12.42].map(usdg)));
  });

  it("A +100 / −100 PAIR DOES NOT RATCHET — the loss is in equity, the gain is not in the peak", () => {
    const flat = composeEquityUsdg({ ...spot, perp: venue(50, 0, []) });
    const hedged = venue(50, 0, [100, -100]);
    const equity = composeEquityUsdg({ ...spot, perp: hedged });
    assert.equal(equity, flat, "the pair nets to nothing in equity");
    const hwm = flat;
    const accrual = accrueAboveHwm(peakBasisUsdg(equity, hedged), hwm, 2_000);
    assert.equal(accrual.profitUsdg, 0n, "no fee");
    assert.ok(accrual.newHwmUsdg <= hwm, "and no peak on the winner's wick");
  });

  it("A WICK AND ITS REVERT MOVE NO PEAK", () => {
    const hwm = composeEquityUsdg({ ...spot, perp: venue(50, 0, [0]) });
    const wick = venue(50, 0, [40]);
    const atWick = accrueAboveHwm(peakBasisUsdg(composeEquityUsdg({ ...spot, perp: wick }), wick), hwm, 2_000);
    assert.equal(atWick.profitUsdg, 0n);
    assert.equal(atWick.newHwmUsdg, hwm);
  });

  it("CLOSING A +G POSITION CHARGES THE FEE ON G ONCE — the basis rises by exactly what was realized", () => {
    const hwm = composeEquityUsdg({ ...spot, perp: venue(50, 12.5, [0]) });
    const open = venue(50, 12.5, [20]);
    const whileOpen = accrueAboveHwm(peakBasisUsdg(composeEquityUsdg({ ...spot, perp: open }), open), hwm, 2_000);
    assert.equal(whileOpen.profitUsdg, 0n, "nothing while it is open");
    const closed = venue(82.5, 0, []); // margin back to C, plus the 20 realized
    const atClose = accrueAboveHwm(peakBasisUsdg(composeEquityUsdg({ ...spot, perp: closed }), closed), whileOpen.newHwmUsdg, 2_000);
    assert.equal(atClose.profitUsdg, usdg(20));
    const again = accrueAboveHwm(peakBasisUsdg(composeEquityUsdg({ ...spot, perp: closed }), closed), atClose.newHwmUsdg, 2_000);
    assert.equal(again.profitUsdg, 0n, "and never again");
  });

  it("the breaker still sees the whole loss — only peaks leave gains out", () => {
    const hwm = composeEquityUsdg({ ...spot, perp: venue(50, 12.5, [0]) });
    const losing = venue(50, 12.5, [-10]);
    const equity = composeEquityUsdg({ ...spot, perp: losing });
    assert.equal(drawdownBps(hwm, equity), Number((usdg(10) * 10_000n) / hwm));
  });

  it("refuses a negative gain term — it would lift every peak above equity", () => {
    assert.throws(() => peakBasisUsdg(usdg(10), { ...venue(1, 0, []), unrealizedGainMicro: -1n }), /negative/);
  });
});
