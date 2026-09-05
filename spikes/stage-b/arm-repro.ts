/**
 * STEP 1 — reproduce ONE child's COLD ARM against mainnet 4663 and count it.
 *
 * FIDELITY. Every module that does the work is imported from worker/src, not
 * re-implemented: metered() from rpc-meter.ts, findOrphanOps/getLogsAdaptive
 * from inflight-reconcile.ts, WALL_POLICY_CONTRACTS and ENTRYPOINT from
 * packages/core. The two things that are copied rather than imported are:
 *   - makeReconcileChain, an inner closure of index.ts (not exported), copied
 *     VERBATIM from worker/src/index.ts:642-666;
 *   - the block-time sample + clamp, copied verbatim from index.ts:771-793.
 * Both copies are checked against the source by eye and cited in the report.
 *
 * WHAT IS DELIBERATELY NOT REPRODUCED: the ledger side (listSubmittedOps,
 * listOpHashes, addTrade, addEvent). Those are sqlite, not chain. On a cold arm
 * with no stranded rows resolveStrandedOps issues ZERO chain calls
 * (index.ts:693 `if (stranded.length > 0)` guards everything), and listOpHashes
 * only supplies the dedup set. So a synthetic tenant with an empty ledger is
 * chain-identical to the 22 real children, all of which found nothing.
 *
 * SYNTHETIC TENANT. The smart account below is a made-up address that has never
 * existed on any chain. That matches 20 of the 22 real children, which logged
 * "is not deployed yet". NOTHING IS SIGNED, SENT, OR BROADCAST — this file
 * issues eth_getCode, eth_blockNumber, eth_getBlockByNumber and eth_getLogs and
 * nothing else.
 */
import { createPublicClient, http, type Hex } from "viem";
import { installBudget, budgetReport, wireCount } from "./budget";
import { metered, rpcSummaryLines, resetRpcMetersForTest } from "../../worker/src/rpc-meter";
import { findOrphanOps, type ReconcileChain, type RawLog } from "../../worker/src/inflight-reconcile";
import { robinhoodChain, ENTRYPOINT, WALL_POLICY_CONTRACTS, CASH } from "../../packages/core/src/index";

// DECLARED BUDGET for this script: 40 HTTP requests per run. A faithful arm is
// 28 logical calls; the headroom is for viem retries only.
installBudget(Number(process.env.BUDGET ?? 40));

const RPC = process.env.RPC ?? robinhoodChain.rpcUrls.default.http[0];
const SYNTHETIC_ACCOUNT = "0x00000000000000000000000000000000dead0001" as `0x${string}`;

// VERBATIM from worker/src/index.ts:642-666.
const makeReconcileChain = (client: ReturnType<typeof createPublicClient>): ReconcileChain => ({
  getBlockNumber: () => client.getBlockNumber(),
  async getLogs(a) {
    const logs = (await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: a.address,
          fromBlock: `0x${a.fromBlock.toString(16)}`,
          toBlock: `0x${a.toBlock.toString(16)}`,
          topics: a.topics,
        },
      ],
    } as never)) as RawLog[];
    return logs;
  },
  async getReceiptLogs(txHash) {
    try {
      const r = await client.getTransactionReceipt({ hash: txHash });
      return r.logs as never;
    } catch {
      return null;
    }
  },
});

async function main() {
  resetRpcMetersForTest();
  const client = createPublicClient({ chain: robinhoodChain, transport: metered(http(RPC), "read") });
  const t0 = Date.now();

  // ---- syncGrant's getCode probes (index.ts:2280-2345) ----
  const missing: string[] = [];
  const unchecked: string[] = [];
  for (const c of WALL_POLICY_CONTRACTS) {
    try {
      const code = await client.getCode({ address: c.address });
      if (code === undefined || code === "0x") missing.push(c.name);
    } catch {
      unchecked.push(c.name);
    }
  }
  let accountDeployed: boolean | null = null;
  try {
    const code = await client.getCode({ address: SYNTHETIC_ACCOUNT });
    accountDeployed = code !== undefined && code !== "0x";
  } catch {
    accountDeployed = null;
  }
  console.log(`[arm] wall policy contracts: ${WALL_POLICY_CONTRACTS.length} probed · missing=${missing.length} unchecked=${unchecked.length}`);
  console.log(`[arm] synthetic smart account deployed = ${accountDeployed}`);
  const afterGetCode = wireCount();

  // ---- reconcileInFlightAtArm's block-time sample + clamp (index.ts:771-793) ----
  const head = await client.getBlockNumber();
  const SAMPLE = 2_000n;
  const lo = head > SAMPLE ? head - SAMPLE : 0n;
  let secPerBlock = 2;
  if (head > lo) {
    const [bHead, bLo] = await Promise.all([
      client.getBlock({ blockNumber: head }),
      client.getBlock({ blockNumber: lo }),
    ]);
    const dt = Number(bHead.timestamp - bLo.timestamp);
    if (dt > 0) secPerBlock = dt / Number(head - lo);
  }
  const WINDOW_SEC = 26 * 3600;
  const MAX_LOOKBACK = 200_000n;
  let lookbackBlocks = BigInt(Math.ceil(WINDOW_SEC / secPerBlock));
  const estimate = lookbackBlocks;
  if (lookbackBlocks > MAX_LOOKBACK) lookbackBlocks = MAX_LOOKBACK;
  console.log(`[arm] head=${head} secPerBlock=${secPerBlock.toFixed(4)} estimate=${estimate} clamped=${lookbackBlocks}`);
  const afterSample = wireCount();

  // ---- findOrphanOps: the 21-chunk sweep (index.ts:805-812) ----
  const chain = makeReconcileChain(client);
  const tSweep = Date.now();
  const orphans = await findOrphanOps({
    chain,
    smartAccount: SYNTHETIC_ACCOUNT,
    usdgToken: CASH.USDG,
    knownOpHashes: new Set<string>(),
    lookbackBlocks,
    log: (m) => console.log(`[reconcile] ${m}`),
  });
  const sweepMs = Date.now() - tSweep;
  console.log(`[arm] orphans found = ${orphans.length} · sweep wall-clock ${sweepMs}ms`);

  console.log(`[arm] TOTAL wall-clock ${Date.now() - t0}ms`);
  console.log(`[arm] wire split: getCode phase ${afterGetCode} · +sample ${afterSample - afterGetCode} · +sweep ${wireCount() - afterSample}`);
  for (const line of rpcSummaryLines()) console.log(line);
  console.log(budgetReport());
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : String(e));
  console.log(budgetReport());
  process.exit(1);
});
