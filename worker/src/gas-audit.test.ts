/**
 * THE AVERAGE IS THE BUG.
 *
 * The canary's four landed operations cost 6.969946 USDG of gas between them.
 * Divided evenly that is 1.742 USDG a trade, on trades sized ~1.67 — a number
 * which, handed to a model deciding whether the next trade is worth making,
 * says "never trade again". If most of that total was spent once, deploying the
 * account, then the honest marginal cost is a fraction of it and the answer
 * flips.
 *
 * So these tests are about refusing to average: separating what was paid once
 * from what will be paid again, refusing to guess when there is nothing to
 * compare against, and never quietly dropping a cost that could not be valued.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { decomposeGas, gasAuditLines, type GasOp } from "./gas-audit";

const op = (over: Partial<GasOp> = {}): GasOp => ({
  id: 1,
  kind: "swap",
  target: "TSLA",
  amountUsdg: 1.6665,
  status: "landed",
  userOpHash: "0xaaaa000000000000000000000000000000000000000000000000000000000001",
  txHash: "0xbbbb000000000000000000000000000000000000000000000000000000000001",
  gasWei: "1000000000000000",
  gasUnits: null,
  sponsoredGasWei: null,
  gasUsdg: 0.05,
  epoch: 1,
  createdAt: 1_788_000_000,
  ...over,
});

/** The shape the canary is expected to have: one expensive op, then three cheap. */
const deployedThenTraded = (): GasOp[] => [
  op({ id: 1, gasUsdg: 6.8, createdAt: 1_788_000_000 }),
  op({ id: 2, gasUsdg: 0.06, createdAt: 1_788_000_100 }),
  op({ id: 3, gasUsdg: 0.05, createdAt: 1_788_000_200 }),
  op({ id: 4, gasUsdg: 0.059946, createdAt: 1_788_000_300 }),
];

describe("one-time cost is not marginal cost", () => {
  it("does not let a deployment-inflated first op set the price of the next trade", () => {
    const d = decomposeGas("0xacct", 1, deployedThenTraded());
    assert.equal(d.totalLandedGasUsdg.toFixed(6), "6.969946");
    // The naive answer, and the one this module exists to refuse.
    assert.equal((d.totalLandedGasUsdg / 4).toFixed(3), "1.742");
    // The honest one.
    assert.equal(d.marginalGasUsdg, 0.059946);
    assert.equal(d.setupPremiumUsdg!.toFixed(6), "6.740054");
  });

  it("uses the median rather than the mean, so one outlier cannot set the rate", () => {
    // A single expensive later op — a congested block, a failed retry — must not
    // drag the expectation for every future trade with it.
    const d = decomposeGas("0xacct", 1, [
      op({ id: 1, gasUsdg: 6.8 }),
      op({ id: 2, gasUsdg: 0.05, createdAt: 1_788_000_100 }),
      op({ id: 3, gasUsdg: 0.05, createdAt: 1_788_000_200 }),
      op({ id: 4, gasUsdg: 4.0, createdAt: 1_788_000_300 }),
    ]);
    assert.equal(d.marginalGasUsdg, 0.05, "median, not the 1.37 mean");
    assert.equal(d.steadyMeanUsdg!.toFixed(4), "1.3667", "the mean is still reported, just not used");
    assert.equal(d.steadyMaxUsdg, 4.0, "and the worst case is visible");
  });

  it("refuses to call anything a setup premium when there is nothing to compare against", () => {
    // One landed op tells you nothing about which part of it was one-time.
    // Attributing all of it to setup would be a guess wearing a decomposition's
    // clothes, and the honest answer is that the question is unanswerable yet.
    const d = decomposeGas("0xacct", 1, [op({ gasUsdg: 6.8 })]);
    assert.equal(d.setupPremiumUsdg, null);
    assert.equal(d.marginalGasUsdg, null);
    assert.match(gasAuditLines(d).join("\n"), /not derivable — no later op to compare against/);
  });

  it("reports no premium when the first op was not the expensive one", () => {
    const d = decomposeGas("0xacct", 1, [
      op({ id: 1, gasUsdg: 0.05 }),
      op({ id: 2, gasUsdg: 0.06, createdAt: 1_788_000_100 }),
    ]);
    assert.equal(d.setupPremiumUsdg, null, "a first op below the steady rate has no premium to report");
  });

  it("says the deployment claim is unproven until somebody checks the chain", () => {
    // "The first op cost more" is arithmetic. "Because it deployed the account"
    // is a claim about the EntryPoint's AccountDeployed event, and this module
    // has not looked.
    const d = decomposeGas("0xacct", 1, deployedThenTraded());
    assert.equal(d.deploymentConfirmed, null);
    const text = gasAuditLines(d).join("\n");
    assert.ok(
      !/AccountDeployed CONFIRMED/i.test(text),
      "the module must not claim a chain fact it has not checked",
    );
    // It still reports the premium and says how it was derived — the claim it
    // withholds is WHY the first op cost more, not THAT it did.
    assert.match(text, /setup premium\s+6\.740054 USDG/);
  });
});

describe("what counts as the owner's cost", () => {
  it("excludes sponsored gas, because somebody else paid it", () => {
    // `gas_wei` means "what this owner spent" and `sponsored_gas_wei` means
    // "what somebody else did" — the store keeps two columns precisely so this
    // distinction survives into a P&L.
    const d = decomposeGas("0xacct", 1, [
      op({ id: 1, gasUsdg: 0.05 }),
      op({ id: 2, gasUsdg: 9.99, sponsoredGasWei: "5000000000000000", createdAt: 1_788_000_100 }),
    ]);
    assert.equal(d.totalLandedGasUsdg, 0.05);
    assert.equal(d.sponsored.length, 1);
    assert.match(gasAuditLines(d).join("\n"), /SPONSORED .* somebody else paid/);
  });

  it("names an unpriced op rather than treating it as free", () => {
    // A gas figure that could not be valued is unknown, and unknown is not
    // zero. A total that silently drops it understates the real cost, which is
    // the direction that flatters the product.
    const d = decomposeGas("0xacct", 1, [
      op({ id: 1, gasUsdg: 0.05 }),
      op({ id: 2, gasUsdg: null, createdAt: 1_788_000_100 }),
    ]);
    assert.equal(d.unpriced.length, 1);
    assert.equal(d.totalLandedGasUsdg, 0.05);
    assert.match(gasAuditLines(d).join("\n"), /UNPRICED .* cost unknown, not zero/);
  });

  it("surfaces gas burned on reverted ops, which the published figure omits", () => {
    // The leaderboard sums gas WHERE status='landed'. A reverted op still burned
    // the owner's ETH, so the published loss understates what was actually
    // spent — worth knowing before anyone calls the number complete.
    const d = decomposeGas("0xacct", 1, [
      op({ id: 1, gasUsdg: 0.05 }),
      op({ id: 2, status: "reverted", gasUsdg: 0.04, createdAt: 1_788_000_100 }),
    ]);
    assert.equal(d.totalLandedGasUsdg, 0.05);
    assert.equal(d.revertedGasUsdg, 0.04);
    assert.match(gasAuditLines(d).join("\n"), /reverted gas .* does NOT count/);
  });

  it("ignores rejected ops entirely — nothing was broadcast, nothing was burned", () => {
    const d = decomposeGas("0xacct", 1, [op({ id: 1, gasUsdg: 0.05 }), op({ id: 2, status: "rejected", gasUsdg: null })]);
    assert.equal(d.landed.length, 1);
    assert.equal(d.reverted.length, 0);
  });
});

describe("the gas-to-trade ratio uses trade sizes only", () => {
  it("does not divide by a vault deposit, which is not a trade", () => {
    // A vault deposit shuffles money between two pockets inside the same wall.
    // Its 500 USDG "size" is not a position, and letting it into the denominator
    // would make gas look negligible by dividing by money nobody traded.
    const d = decomposeGas("0xacct", 1, [
      op({ id: 1, gasUsdg: 6.8 }),
      op({ id: 2, kind: "vault-deposit", amountUsdg: 500, gasUsdg: 0.05, createdAt: 1_788_000_100 }),
      op({ id: 3, kind: "swap", amountUsdg: 1.6665, gasUsdg: 0.05, createdAt: 1_788_000_200 }),
    ]);
    assert.equal(d.typicalTradeUsdg, 1.6665, "the swap, not the 500 USDG shuffle");
    assert.equal(d.marginalShareOfTradePct!.toFixed(1), "3.0");
    // But its gas is still counted — it cost real money.
    assert.equal(d.totalLandedGasUsdg.toFixed(2), "6.90");
  });

  it("says so rather than inventing a ratio when nothing trade-sized landed", () => {
    const d = decomposeGas("0xacct", 1, [
      op({ id: 1, kind: "vault-deposit", amountUsdg: 500, gasUsdg: 0.05 }),
      op({ id: 2, kind: "vault-deposit", amountUsdg: 500, gasUsdg: 0.05, createdAt: 1_788_000_100 }),
    ]);
    assert.equal(d.marginalShareOfTradePct, null);
    assert.match(gasAuditLines(d).join("\n"), /no trade-sized op to measure against/);
  });

  it("breaks the total down by kind, so a costly operation type is visible", () => {
    const d = decomposeGas("0xacct", 1, [
      op({ id: 1, kind: "swap", gasUsdg: 0.05 }),
      op({ id: 2, kind: "vault-deposit", amountUsdg: 500, gasUsdg: 0.30, createdAt: 1_788_000_100 }),
      op({ id: 3, kind: "swap", gasUsdg: 0.05, createdAt: 1_788_000_200 }),
    ]);
    assert.equal(d.byKind["swap"]!.ops, 2);
    assert.equal(d.byKind["vault-deposit"]!.gasUsdg, 0.30);
  });
});

describe("ordering and purity", () => {
  it("takes the caller's order as given — first means first", () => {
    // The runner sorts ascending by created_at. If it ever sorted the other way
    // the setup cost would be attributed to the most recent trade, which is the
    // one number a marginal-cost estimate must not be built from.
    const d = decomposeGas("0xacct", 1, deployedThenTraded());
    assert.equal(d.first!.id, 1);
    assert.equal(d.subsequent.map((o) => o.id).join(","), "2,3,4");
  });

  it("reads no database, no clock and no environment", () => {
    // It is handed rows and returns strings. A reporting path that cannot write
    // cannot be argued with — the same property `accounting-preview` has, for
    // the same reason.
    const src = readFileSync(new URL("./gas-audit.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    for (const forbidden of [/INSERT/i, /UPDATE\s/i, /DELETE/i, /getDb\(/, /process\.env/, /Date\.now/, /node:fs/]) {
      assert.ok(!forbidden.test(src), `gas-audit must not contain ${forbidden}`);
    }
  });

  it("handles an account with nothing recorded", () => {
    const d = decomposeGas("0xacct", 1, []);
    assert.equal(d.totalLandedGasUsdg, 0);
    assert.equal(d.first, null);
    assert.equal(d.marginalGasUsdg, null);
    assert.doesNotThrow(() => gasAuditLines(d));
  });
});

describe("units are the stable quantity; USDG carries the base fee", () => {
  /** The canary's four operations, exactly as the chain reported them. */
  const canary = (): GasOp[] => [
    op({ id: 1, gasUsdg: 4.988562, gasWei: "1986770309895078", gasUnits: "6019786" }),
    op({ id: 2, gasUsdg: 0.437126, gasWei: "174092174020172", gasUnits: "526934", createdAt: 1_788_000_100 }),
    op({ id: 3, gasUsdg: 0.779371, gasWei: "310897376153100", gasUnits: "509850", createdAt: 1_788_000_200 }),
    op({ id: 4, gasUsdg: 0.764720, gasWei: "305053139433360", gasUnits: "510760", createdAt: 1_788_000_300 }),
  ];

  it("splits on gas units when they are recorded, and says so", () => {
    // Verified against the EntryPoint: op #1 used 6,019,786 units and emitted
    // AccountDeployed; the later three used ~510,000. The gas PRICE over the
    // same window ranged 0.330 to 0.610 gwei, and a USDG split hands that swing
    // to the operations instead of to the chain.
    const d = decomposeGas("0xacct", 1, canary());
    assert.equal(d.premiumBasis, "units");
    assert.equal(d.steadyMedianUnits, 510760);
    assert.equal(d.setupPremiumUsdg!.toFixed(3), "4.565", "the unit-based figure");
    assert.match(gasAuditLines(d).join("\n"), /split on GAS UNITS: 6019786 vs a steady 510760/);
  });

  it("the USDG split it replaces is measurably wrong, in a knowable direction", () => {
    // Same operations, units stripped — which is every row written before the
    // column existed. 4.224 against 4.565 is an 8% understatement of setup, and
    // therefore an 8% OVERSTATEMENT of what the next trade will cost. That is
    // the direction that talks a desk out of economic trades.
    const stripped = canary().map((o) => ({ ...o, gasUnits: null }));
    const d = decomposeGas("0xacct", 1, stripped);
    assert.equal(d.premiumBasis, "usdg");
    assert.equal(d.setupPremiumUsdg!.toFixed(3), "4.224");
    assert.match(gasAuditLines(d).join("\n"), /carries the base-fee movement/);
  });

  it("falls back rather than failing when only some rows carry units", () => {
    // A ledger mid-migration: the old rows have no units, the new ones do. The
    // first op is the old one, so there is no unit pair to compare and the USDG
    // path takes over — degraded, and labelled degraded.
    const mixed = canary().map((o, i) => (i === 0 ? { ...o, gasUnits: null } : o));
    const d = decomposeGas("0xacct", 1, mixed);
    assert.equal(d.premiumBasis, "usdg");
    assert.notEqual(d.setupPremiumUsdg, null);
  });

  it("reports the marginal cost as a share of a real trade", () => {
    const d = decomposeGas("0xacct", 1, canary());
    assert.equal(d.marginalGasUsdg, 0.764720);
    assert.equal(d.marginalShareOfTradePct!.toFixed(1), "45.9");
    // 45.9% of a 1.6665 USDG trade. Stated plainly because it is the number
    // that decides whether trading at this size is economic at all.
    assert.match(gasAuditLines(d).join("\n"), /45\.9% of a typical 1\.666500 USDG trade/);
  });
});
