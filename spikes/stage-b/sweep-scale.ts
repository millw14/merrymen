/**
 * STEP 2b — does a SHARED filter break the property inflight-reconcile relies on?
 *
 * inflight-reconcile.ts:100-103 states, as the reason the span cap is about
 * provider limits and not result volume: "Every caller filters by an indexed
 * address topic, so only ONE account's logs come back however wide the window."
 * A cohort OR-list removes that guarantee. So measure the thing it guaranteed:
 * payload size and latency for a 22-sender cohort of ACTIVE accounts over the
 * full 200,001 blocks — deliberately harsher than merrymen's own fleet, 20 of
 * whose 22 accounts have never been deployed at all.
 *
 * Also runs the real readMarketSafety() from worker/src/snapshot.ts, which is
 * the first-tick leg that is reproducible without ledger or discovery state.
 *
 * READ-ONLY: eth_blockNumber, eth_getLogs, eth_getBlockByNumber, eth_call.
 */
import { createPublicClient, http, type Hex } from "viem";
import { installBudget, budgetReport, wireCount } from "./budget";
import { getLogsAdaptive, type ReconcileChain, type RawLog } from "../../worker/src/inflight-reconcile";
import { robinhoodChain, ENTRYPOINT } from "../../packages/core/src/index";

installBudget(Number(process.env.BUDGET ?? 80));

const RPC = process.env.RPC ?? robinhoodChain.rpcUrls.default.http[0];
const USEROP_EVENT_TOPIC = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f" as Hex;
const client = createPublicClient({ chain: robinhoodChain, transport: http(RPC) });

const chain: ReconcileChain = {
  getBlockNumber: () => client.getBlockNumber(),
  async getLogs(a) {
    return (await client.request({
      method: "eth_getLogs",
      params: [
        { address: a.address, fromBlock: `0x${a.fromBlock.toString(16)}`, toBlock: `0x${a.toBlock.toString(16)}`, topics: a.topics },
      ],
    } as never)) as RawLog[];
  },
  async getReceiptLogs() {
    return null;
  },
};

async function main() {
  const head = await client.getBlockNumber();
  const probe = await chain.getLogs({
    address: ENTRYPOINT.v07 as `0x${string}`,
    fromBlock: head - 3_000n,
    toBlock: head,
    topics: [USEROP_EVENT_TOPIC],
  });
  // 22 senders that demonstrably DO emit UserOperationEvents — a worst case for
  // result volume, unlike merrymen's own cohort.
  const active = [...new Set(probe.map((l) => String(l.topics[2])))].slice(0, 22) as Hex[];
  console.log(`=== 22-SENDER ACTIVE COHORT, 200,001 BLOCKS ===`);
  console.log(`cohort of ${active.length} senders, all known-active in the last 3,000 blocks`);

  const before = wireCount();
  const t0 = Date.now();
  const res = await getLogsAdaptive(
    chain,
    { address: ENTRYPOINT.v07 as `0x${string}`, topics: [USEROP_EVENT_TOPIC, null, active] },
    head - 200_000n,
    head,
    10_000n,
    (m) => console.log(`  [adaptive] ${m}`),
  );
  const ms = Date.now() - t0;
  const bytes = Buffer.byteLength(JSON.stringify(res.logs));
  const chunks = wireCount() - before;
  console.log(`chunks(HTTP) ${chunks} · wall-clock ${ms}ms · complete=${res.complete}`);
  console.log(`logs ${res.logs.length} · payload ${bytes} bytes (${(bytes / 1024).toFixed(1)} KiB) · ${(bytes / chunks / 1024).toFixed(1)} KiB per chunk`);
  const bySender = new Map<string, number>();
  for (const l of res.logs) bySender.set(String(l.topics[2]), (bySender.get(String(l.topics[2])) ?? 0) + 1);
  console.log(`distinct senders in result: ${bySender.size} of ${active.length} requested`);
  const counts = [...bySender.values()].sort((a, b) => b - a);
  console.log(`per-sender log counts: max ${counts[0]} · median ${counts[Math.floor(counts.length / 2)]} · total ${res.logs.length}`);
  console.log(`partitionable by topic2 without ambiguity: ${res.logs.every((l) => l.topics[2] !== undefined)}`);

  // ---- first-tick leg: the real readMarketSafety ----
  console.log(`\n=== readMarketSafety() — real module, first-tick leg ===`);
  const { readMarketSafety, setMainnetRpc } = await import("../../worker/src/snapshot");
  setMainnetRpc(RPC);
  const b2 = wireCount();
  const t2 = Date.now();
  const ms2 = await readMarketSafety();
  console.log(`HTTP requests ${wireCount() - b2} · wall-clock ${Date.now() - t2}ms`);
  console.log(`sequencerUp=${ms2.sequencerUp} unreadable=${ms2.unreadable} block=${ms2.blockNumber} prices=${Object.keys(ms2.prices ?? {}).length} unread=${(ms2.unread ?? []).length}`);

  console.log("");
  console.log(budgetReport());
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : String(e));
  console.log(budgetReport());
  process.exit(1);
});
