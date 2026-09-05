/**
 * PRICE HISTORICAL GAS THAT LANDED WITHOUT A PRICE — read-only by default.
 *
 *   npx tsx spikes/accounting-repair/price-gas.ts                 # the canary, dry
 *   npx tsx spikes/accounting-repair/price-gas.ts --account 0x…   # any account
 *
 * Uses the SHIPPED logic in worker/src/gas-backfill.ts rather than a copy, so
 * what this prints is what a backfill would write.
 *
 * WHY THIS IS POSSIBLE WITHOUT AN ARCHIVE NODE. Robinhood Chain's public RPC
 * refuses historical state (`eth_call` at an old block returns "metadata is not
 * found"), so the feed cannot be re-read as of the trade. But a Chainlink
 * aggregator keeps its past rounds readable from CURRENT state via
 * `getRoundData(uint80)` — the round IN FORCE when the trade landed is
 * recoverable from a plain node.
 */
import { findRoundAt, priceGasAtRound, type FeedRound } from "../../worker/src/gas-backfill";

const RPC = process.env.MERRYMEN_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const ETH_USD = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";

const argAt = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

/** The canary's four landed fills, from their receipts. */
const CANARY = [
  { tx: "0xc4e130d3a4803dc78a8d08c429b70dbaea19d6b951e63c7132d7cc866a54fa65", blk: 53755217, gasWei: 1_898_579_000_000_000n },
  { tx: "0xfa7883d1b1354f95b12614f12c1311a27a2e2591c6c1a7516163822b3342e088", blk: 53757619, gasWei: 154_023_000_000_000n },
  { tx: "0xb4556fb55b59f82646b51509779c21258911efb852403394ae12078296b2e60c", blk: 53760100, gasWei: 274_022_000_000_000n },
  { tx: "0x4564b9ef58b2d3aa8d6701a3c6f6deb37a3fd125a0fa57939e9aad39d46654e8", blk: 53762498, gasWei: 268_881_000_000_000n },
];

let id = 1;
let rpcCalls = 0;
async function rpc(method: string, params: unknown[]): Promise<string> {
  rpcCalls++;
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  });
  const j = (await r.json()) as { result?: string; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? "rpc error");
  return j.result ?? "0x";
}

const word = (hex: string, i: number) => BigInt("0x" + hex.slice(2).slice(i * 64, (i + 1) * 64));
const call = (data: string) => rpc("eth_call", [{ to: ETH_USD, data }, "latest"]);

async function main() {
  const decimals = Number(await call("0x313ce567").then((h) => BigInt(h)));
  const latestHex = await call("0xfeaf968c"); // latestRoundData()
  const latest: FeedRound = {
    roundId: word(latestHex, 0),
    priceUsd: Number(word(latestHex, 1)) / 10 ** decimals,
    updatedAt: Number(word(latestHex, 3)),
  };
  console.log(
    `ETH/USD feed ${ETH_USD}  decimals ${decimals}  latest round ${latest.roundId} ` +
      `$${latest.priceUsd.toFixed(2)} @ ${new Date(latest.updatedAt * 1000).toISOString()}\n`,
  );

  // getRoundData(uint80)
  const readRound = async (roundId: bigint): Promise<FeedRound | null> => {
    const hex = await call("0x9a6fc8f5" + roundId.toString(16).padStart(64, "0"));
    return {
      roundId: word(hex, 0),
      priceUsd: Number(word(hex, 1)) / 10 ** decimals,
      updatedAt: Number(word(hex, 3)),
    };
  };

  let total = 0;
  let priced = 0;
  for (const fill of CANARY) {
    const blk = (await rpc("eth_getBlockByNumber", ["0x" + fill.blk.toString(16), false])) as unknown as {
      timestamp: string;
    };
    const tradeAtSec = Number(BigInt(blk.timestamp));
    const round = await findRoundAt(tradeAtSec, latest, readRound);
    const r = priceGasAtRound({ gasWei: fill.gasWei, tradeAtSec, round });
    if (r.kind === "priced") {
      priced++;
      total += r.usdg;
      console.log(
        `${fill.tx.slice(0, 12)}  blk ${fill.blk}  round ${r.roundId}  $${r.priceUsd.toFixed(2)}  ` +
          `(published ${Math.round(r.lagSec / 60)} min before the fill)  ` +
          `${(Number(fill.gasWei) / 1e18).toFixed(9)} ETH = ${r.usdg.toFixed(6)} USDG`,
      );
    } else {
      console.log(`${fill.tx.slice(0, 12)}  blk ${fill.blk}  UNPRICED — ${r.why}`);
    }
  }

  console.log(`\n${priced}/${CANARY.length} priced · ${rpcCalls} RPC call(s)`);
  console.log(`total gas ${total.toFixed(6)} USDG`);
  if (priced === CANARY.length) {
    const nav = 9.873005;
    const contributed = 10;
    console.log(`\nNAV                ${nav.toFixed(6)} USDG`);
    console.log(`contributed        ${contributed.toFixed(6)} USDG  (one chain-log transfer, ever)`);
    console.log(`P&L gross of gas   ${(nav - contributed).toFixed(6)} USDG`);
    console.log(`P&L NET of gas     ${(nav - contributed - total).toFixed(6)} USDG`);
    console.log(
      `\nThe two differ by ${total.toFixed(6)} USDG on a book that deployed 6.666 — which is why\n` +
        `\`gas_accounting\` is a published quality flag rather than a footnote.`,
    );
  }
}

void main();
