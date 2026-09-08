/**
 * LIVE PROOF THAT THE onchain LENS WORKS AGAINST THE REAL CHAIN.
 *
 * The Blockscout port was abandoned because a fetcher can be green in every
 * test and 403 in production. This runs the actual reader against the actual
 * RPC and prints what the analyst would be handed.
 *
 *   npx tsx scripts/probe-onchain-lens.mts <token> [curve]
 */
import { createPublicClient, http, parseAbi } from "viem";
import { renderOnchain } from "../worker/src/research/coin-onchain";
import { scanToken } from "../worker/src/research/onchain-reader";
import type { RawLog, ReconcileChain } from "../worker/src/inflight-reconcile";

const token = (process.argv[2] ?? "").toLowerCase() as `0x${string}`;
const curve = (process.argv[3] ?? "").toLowerCase();
if (!/^0x[0-9a-f]{40}$/.test(token)) throw new Error("usage: probe-onchain-lens <token> [curve]");

const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });
const chain: ReconcileChain = {
  getBlockNumber: () => client.getBlockNumber(),
  async getLogs(a) {
    return (await client.request({
      method: "eth_getLogs",
      params: [{ address: a.address, fromBlock: `0x${a.fromBlock.toString(16)}`, toBlock: `0x${a.toBlock.toString(16)}`, topics: a.topics }],
    } as never)) as RawLog[];
  },
  getReceiptLogs: async () => null,
};

const head = await client.getBlockNumber();
const t0 = Date.now();
const scan = await scanToken(
  {
    chain,
    totalSupply: async (t) =>
      (await client
        .readContract({ address: t, abi: parseAbi(["function totalSupply() view returns (uint256)"]), functionName: "totalSupply" })
        .catch(() => null)) as bigint | null,
  },
  { token, head, windowBlocks: 1_000_000n, venues: curve ? [curve] : [], log: (m) => console.log("  ", m) },
);
console.log(`\nscanned in ${Date.now() - t0}ms · blocks ${scan.fromBlock}-${scan.toBlock}`);
console.log(`transfers ${scan.transfers} · holders ${scan.holders.length} · trades ${scan.trades.length} · wholeHistory ${scan.wholeHistory}`);
if (scan.why) console.log(`why: ${scan.why}`);
console.log("\n──────── the lens ────────\n");
console.log(renderOnchain({ symbol: process.env.SYM ?? "TOKEN", scan, venues: curve ? [curve] : [] }) ?? "(null — no material)");
