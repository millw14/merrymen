/**
 * Render sample cards to files, so the layout can be LOOKED AT.
 *
 * Unit tests can prove the numbers and the geometry; they cannot tell you the
 * headline collides with the pattern on the right edge. Run:
 *
 *   npx tsx tools/preview-pnl-card.mts [outDir]
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import { pnlCaption, renderPnlCard, type PnlCardData } from "../worker/src/pnl-card";

const outDir = process.argv[2] ?? ".";

const usdg = (n: number) => BigInt(Math.round(n * 1e6));

const cases: Record<string, PnlCardData> = {
  win: {
    symbol: "DOGGOS",
    investedUsdg: usdg(5),
    proceedsUsdg: usdg(17.39),
    realisedUsdg: usdg(12.39),
  },
  loss: {
    symbol: "PONSCAT",
    investedUsdg: usdg(25),
    proceedsUsdg: usdg(15.47),
    realisedUsdg: usdg(-9.53),
  },
  huge: {
    symbol: "VERYLONGTICKERNAME",
    investedUsdg: usdg(2.5),
    proceedsUsdg: usdg(1840.02),
    realisedUsdg: usdg(1837.52),
  },
  nobasis: {
    symbol: "MYSTERY",
    investedUsdg: 0n,
    proceedsUsdg: usdg(9.1),
    realisedUsdg: 0n,
  },
};

for (const [name, data] of Object.entries(cases)) {
  const png = await renderPnlCard(data);
  const file = path.join(outDir, `pnl-${name}.png`);
  writeFileSync(file, png);
  console.log(`${file}  ${(png.length / 1024).toFixed(0)}kB`);
  console.log(`   ${pnlCaption(data)}`);
}
