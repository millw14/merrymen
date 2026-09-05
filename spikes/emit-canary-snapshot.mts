/**
 * The canary's canonical snapshot, built from the figures production actually
 * holds after the repair — so the Brain wiring is tested against the real
 * object rather than a hand-written approximation of it.
 */
import { buildPortfolioSnapshot, toMicro } from "../packages/core/src/portfolio-snapshot";

const snap = buildPortfolioSnapshot({
  snapshotId: "snap_canary_postrepair",
  agentId: "0x3E34E58e39DC6614e047dFD3BAD5B7DEA45DCd62",
  asOf: 1788600000,
  epoch: 1,
  cashUsdg: toMicro(3.334),
  netContributionsUsdg: toMicro(10),      // repaired: 1 chain-log row, evidenced
  grossContributionsUsdg: toMicro(10),
  grossWithdrawalsUsdg: 0,
  gasUsdg: null,                          // never priced at burn time
  positions: [{
    instrumentId: "merrymen:tsla", symbol: "TSLA",
    qtyRaw: "4420417000000000", valueUsdg: toMicro(6.55),
    costBasisUsdg: toMicro(6.666), priceSource: "chainlink", quarantined: false,
  }],
  quality: {
    auditPassed: false, epoch: 1, currentAccountingHistoryAuditable: true, contributionsKnown: true, equityComplete: false,
    gasBasis: "unknown", positionHistoryAvailable: false,
    quarantinedAssetsPresent: false, assessedAt: 1788600000,
  },
});
console.log(JSON.stringify(snap, null, 2));
