/**
 * STEP 3b — the rested-burst ramp (onset.ts) found NO 429 up to concurrency 32.
 * That does not clear the endpoint; it means the shape was wrong for the
 * mechanism. A token bucket with a generous burst allowance absorbs a rested
 * 30-request burst at any concurrency and only refuses once the bucket is
 * DRAINED — which needs a sustained window, not a burst.
 *
 * So: hold concurrency 16 (the measured throughput knee) continuously and watch
 * for the first refusal.
 *
 * DECLARED BUDGET: 150 HTTP requests, hard-capped. ABORT at the first 429.
 * Session cumulative before this script: 352 requests (28 + 27 + 27 + 270).
 *
 * READ-ONLY: eth_call only.
 */
import { encodeFunctionData } from "viem";
import { installBudget, budgetReport, wireCount, statusCount } from "./budget";
import { robinhoodChain, STOCK_TOKENS } from "../../packages/core/src/index";

const BUDGET = Number(process.env.BUDGET ?? 150);
installBudget(BUDGET);

const RPC = process.env.RPC ?? robinhoodChain.rpcUrls.default.http[0];
const CONCURRENCY = Number(process.env.CONC ?? 16);

const STOCK_ABI = [{ type: "function", name: "tokenPaused", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" }] as const;
const CALLDATA = encodeFunctionData({ abi: STOCK_ABI, functionName: "tokenPaused" });

let seq = 0;
let stop = false;
const marks: { t: number; status: number; ms: number }[] = [];
const t0 = Date.now();

async function one() {
  const token = STOCK_TOKENS[seq % STOCK_TOKENS.length];
  const id = ++seq;
  const t = Date.now();
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: token.address, data: CALLDATA }, "latest"] }),
  });
  await res.text();
  marks.push({ t: Date.now() - t0, status: res.status, ms: Date.now() - t });
  if (res.status === 429) {
    stop = true;
    console.log(`\nONSET: 429 at t=${Date.now() - t0}ms, request #${marks.length} of the sustained window.`);
    console.log(`Retry-After: ${res.headers.get("retry-after") ?? "(none)"}`);
  }
}

async function main() {
  console.log(`SUSTAINED WINDOW · concurrency ${CONCURRENCY} · budget ${BUDGET} HTTP requests · abort at first 429`);
  console.log(`endpoint host: ${new URL(RPC).host}\n`);
  const worker = async () => {
    while (!stop && wireCount() < BUDGET - CONCURRENCY) await one();
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const wall = Date.now() - t0;

  const n429 = marks.filter((m) => m.status === 429).length;
  const ok = marks.filter((m) => m.status === 200).length;
  console.log(`requests ${marks.length} in ${wall}ms → ${(marks.length / (wall / 1000)).toFixed(1)} req/s sustained`);
  console.log(`200s ${ok} · 429s ${n429} · other ${marks.length - ok - n429}`);

  // Per-second histogram: did throughput or latency change as the window ran on?
  const bySec = new Map<number, { n: number; totMs: number; n429: number }>();
  for (const m of marks) {
    const s = Math.floor(m.t / 1000);
    const b = bySec.get(s) ?? { n: 0, totMs: 0, n429: 0 };
    b.n += 1;
    b.totMs += m.ms;
    if (m.status === 429) b.n429 += 1;
    bySec.set(s, b);
  }
  console.log(`\nsec   reqs   avg_ms   429`);
  for (const [s, b] of [...bySec.entries()].sort((a, b2) => a[0] - b2[0])) {
    console.log(`${String(s).padStart(3)}   ${String(b.n).padStart(4)}   ${String(Math.round(b.totMs / b.n)).padStart(6)}   ${String(b.n429).padStart(3)}`);
  }
  console.log(`\ntotal 429s: ${statusCount(429)}`);
  console.log(budgetReport());
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : String(e));
  console.log(budgetReport());
  process.exit(1);
});
