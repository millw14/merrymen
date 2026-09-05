/**
 * STEP 2 — what a SHARED orphan sweep would cost, and whether one sweep can
 * serve N tenants.
 *
 * Three things are measured, in order:
 *   (A) FILTER IDENTITY. Build the filter two different tenants construct, with
 *       the real addressTopic() and the real ENTRYPOINT, and diff them field by
 *       field. This answers "per-tenant or fleet-common?" as data, not reading.
 *   (B) OR-LIST SEMANTICS, VERIFIED AGAINST THIS PROVIDER. inflight-reconcile's
 *       ReconcileChain.getLogs already types topics as (Hex | Hex[] | null)[],
 *       and index.ts's makeReconcileChain passes the array through untouched —
 *       but that only means the CODE permits it. Whether THIS endpoint honours
 *       an array in topic position is an empirical question, so: find real
 *       senders in a recent window, fetch each alone, then fetch them together
 *       in one OR-list, and check the union is exact.
 *   (C) COST OF THE SHARED SWEEP over the same 200,001-block range as step 1,
 *       with an 11-sender OR-list — the size of one real chain cohort.
 *
 * READ-ONLY: eth_blockNumber and eth_getLogs only. Nothing signed or sent.
 */
import { createPublicClient, http, type Hex } from "viem";
import { installBudget, budgetReport, wireCount } from "./budget";
import { metered, rpcSummaryLines, resetRpcMetersForTest } from "../../worker/src/rpc-meter";
import { getLogsAdaptive, addressTopic, type ReconcileChain, type RawLog } from "../../worker/src/inflight-reconcile";
import { robinhoodChain, ENTRYPOINT } from "../../packages/core/src/index";

installBudget(Number(process.env.BUDGET ?? 60));

const RPC = process.env.RPC ?? robinhoodChain.rpcUrls.default.http[0];
const USEROP_EVENT_TOPIC = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f" as Hex;

const client = createPublicClient({ chain: robinhoodChain, transport: metered(http(RPC), "read") });

// VERBATIM from worker/src/index.ts:642-666.
const chain: ReconcileChain = {
  getBlockNumber: () => client.getBlockNumber(),
  async getLogs(a) {
    return (await client.request({
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
  },
  async getReceiptLogs() {
    return null;
  },
};

/** The filter findOrphanOps builds, extracted so two tenants can be compared. */
function tenantFilter(smartAccount: string) {
  return {
    address: ENTRYPOINT.v07 as `0x${string}`,
    topics: [USEROP_EVENT_TOPIC, null, addressTopic(smartAccount)] as (Hex | Hex[] | null)[],
  };
}

async function main() {
  resetRpcMetersForTest();

  // ---------- (A) filter identity across two tenants ----------
  const tA = "0x00000000000000000000000000000000dead0001";
  const tB = "0x00000000000000000000000000000000dead0002";
  const fA = tenantFilter(tA);
  const fB = tenantFilter(tB);
  console.log("=== (A) FILTER IDENTITY ===");
  console.log(`address   same: ${fA.address === fB.address}  (${fA.address})`);
  console.log(`topic0    same: ${fA.topics[0] === fB.topics[0]}  (${fA.topics[0]})`);
  console.log(`topic1    same: ${fA.topics[1] === fB.topics[1]}  (${fA.topics[1]})`);
  console.log(`topic2    same: ${fA.topics[2] === fB.topics[2]}`);
  console.log(`  tenantA topic2 = ${fA.topics[2]}`);
  console.log(`  tenantB topic2 = ${fB.topics[2]}`);

  // ---------- (B) OR-list semantics against the live provider ----------
  console.log("\n=== (B) OR-LIST SEMANTICS ===");
  const head = await client.getBlockNumber();
  const PROBE_SPAN = 3_000n;
  const from = head - PROBE_SPAN;
  // One unfiltered-by-sender probe to discover real senders in a recent window.
  const all = await chain.getLogs({
    address: ENTRYPOINT.v07 as `0x${string}`,
    fromBlock: from,
    toBlock: head,
    topics: [USEROP_EVENT_TOPIC],
  });
  const senders = [...new Set(all.map((l) => l.topics[2]))].slice(0, 3) as Hex[];
  console.log(`probe ${from}..${head} (${PROBE_SPAN} blocks): ${all.length} UserOperationEvent logs, ${new Set(all.map((l) => l.topics[2])).size} distinct senders`);
  if (senders.length < 2) {
    console.log("FEWER THAN 2 DISTINCT SENDERS IN THE PROBE WINDOW — OR-list check not conclusive here.");
  } else {
    const singles: Record<string, Set<string>> = {};
    for (const s of senders) {
      const logs = await chain.getLogs({
        address: ENTRYPOINT.v07 as `0x${string}`,
        fromBlock: from,
        toBlock: head,
        topics: [USEROP_EVENT_TOPIC, null, s],
      });
      singles[s] = new Set(logs.map((l) => `${l.transactionHash}:${l.topics[1]}`));
      console.log(`  single sender ${s.slice(0, 12)}… → ${logs.length} logs`);
    }
    // The OR-list: the real senders PLUS synthetic ones, exactly as a fleet
    // cohort would look (most members having no logs at all).
    const orList = [...senders, addressTopic(tA), addressTopic(tB)] as Hex[];
    const orLogs = await chain.getLogs({
      address: ENTRYPOINT.v07 as `0x${string}`,
      fromBlock: from,
      toBlock: head,
      topics: [USEROP_EVENT_TOPIC, null, orList],
    });
    const orSet = new Set(orLogs.map((l) => `${l.transactionHash}:${l.topics[1]}`));
    const union = new Set<string>();
    for (const s of senders) for (const k of singles[s]) union.add(k);
    const missing = [...union].filter((k) => !orSet.has(k));
    const extra = [...orSet].filter((k) => !union.has(k));
    console.log(`  OR-list of ${orList.length} senders → ${orLogs.length} logs`);
    console.log(`  union of singles = ${union.size} · OR-list set = ${orSet.size}`);
    console.log(`  MISSING from OR-list: ${missing.length} · EXTRA in OR-list: ${extra.length}`);
    console.log(`  OR-LIST HONOURED EXACTLY: ${missing.length === 0 && extra.length === 0 && orSet.size === union.size}`);
    // Sanity: every returned log's sender must be in the requested set.
    const requested = new Set(orList.map((x) => x.toLowerCase()));
    const offSet = orLogs.filter((l) => !requested.has(String(l.topics[2]).toLowerCase()));
    console.log(`  logs returned whose sender was NOT requested: ${offSet.length} (must be 0)`);
  }

  // ---------- (C) cost of the shared 200,001-block sweep ----------
  console.log("\n=== (C) SHARED SWEEP, 200,001 BLOCKS, 11-SENDER OR-LIST ===");
  const cohort: Hex[] = [];
  for (const s of senders) cohort.push(s);
  for (let i = cohort.length; i < 11; i++) {
    cohort.push(addressTopic(`0x${"0".repeat(32)}dead${String(i).padStart(4, "0")}`));
  }
  const before = wireCount();
  const t0 = Date.now();
  const res = await getLogsAdaptive(
    chain,
    { address: ENTRYPOINT.v07 as `0x${string}`, topics: [USEROP_EVENT_TOPIC, null, cohort] },
    head - 200_000n,
    head,
    10_000n,
    (m) => console.log(`  [adaptive] ${m}`),
  );
  const ms = Date.now() - t0;
  const bytes = Buffer.byteLength(JSON.stringify(res.logs));
  console.log(`  cohort size ${cohort.length} · chunks(HTTP) ${wireCount() - before} · wall-clock ${ms}ms`);
  console.log(`  complete=${res.complete} scannedTo=${res.scannedTo} · logs=${res.logs.length} · payload≈${bytes} bytes`);
  const bySender = new Map<string, number>();
  for (const l of res.logs) bySender.set(String(l.topics[2]), (bySender.get(String(l.topics[2])) ?? 0) + 1);
  console.log(`  distinct senders in result: ${bySender.size}`);
  for (const [s, n] of bySender) console.log(`    ${s.slice(0, 14)}… ${n}`);

  console.log("");
  for (const line of rpcSummaryLines()) console.log(line);
  console.log(budgetReport());
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : String(e));
  console.log(budgetReport());
  process.exit(1);
});
