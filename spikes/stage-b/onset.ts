/**
 * STEP 3 — where does this endpoint START rate-limiting?
 *
 * DECLARED BUDGET: 400 HTTP requests, hard-capped by budget.ts (it THROWS, it
 * does not queue). The ramp ABORTS COMPLETELY at the first 429. We want the
 * onset, not the ceiling; the live fleet depends on this endpoint and
 * characterising the whole curve would mean deliberately degrading it.
 *
 * DESIGN.
 *  - Ramp CONCURRENCY from below: 1, 2, 4, 6, 8, 12, 16, 24, 32.
 *  - Each level is a RESTED BURST: 30 requests at that concurrency, then a 2s
 *    rest. Rested bursts are the right shape because the event we care about is
 *    the cold arm — 22 processes spawning inside a 3ms window after idle — not
 *    a sustained load.
 *  - Method is eth_call, which is 97.28% of the fleet's measured traffic, and
 *    it ROTATES over the 25 stock tokens so a server-side cache cannot flatter
 *    the result.
 *  - retryCount is not in play at all: this uses raw fetch, so every 429 is
 *    seen exactly once and none is amplified.
 *
 * READ-ONLY: eth_call only. Nothing signed, sent, or mutated.
 */
import { encodeFunctionData } from "viem";
import { installBudget, budgetReport, wireCount, statusCount } from "./budget";
import { robinhoodChain, STOCK_TOKENS } from "../../packages/core/src/index";

const BUDGET = Number(process.env.BUDGET ?? 400);
installBudget(BUDGET);

const RPC = process.env.RPC ?? robinhoodChain.rpcUrls.default.http[0];
const LEVELS = [1, 2, 4, 6, 8, 12, 16, 24, 32];
const PER_LEVEL = 30;
const REST_MS = 2000;

const STOCK_ABI = [{ type: "function", name: "tokenPaused", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" }] as const;
const CALLDATA = encodeFunctionData({ abi: STOCK_ABI, functionName: "tokenPaused" });

interface Res {
  status: number;
  ms: number;
  retryAfter: string | null;
  jsonRpcError: string | null;
}

let seq = 0;

async function one(): Promise<Res> {
  const token = STOCK_TOKENS[seq % STOCK_TOKENS.length];
  const id = ++seq;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "eth_call",
    params: [{ to: token.address, data: CALLDATA }, "latest"],
  });
  const t = Date.now();
  const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body });
  const text = await res.text();
  let jsonRpcError: string | null = null;
  try {
    const j = JSON.parse(text);
    if (j?.error) jsonRpcError = String(j.error.message ?? j.error.code);
  } catch {
    jsonRpcError = `unparseable body (${text.slice(0, 80)})`;
  }
  return { status: res.status, ms: Date.now() - t, retryAfter: res.headers.get("retry-after"), jsonRpcError };
}

async function burst(concurrency: number, n: number): Promise<{ results: Res[]; wallMs: number }> {
  const results: Res[] = [];
  let issued = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (issued < n) {
      issued += 1;
      results.push(await one());
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { results, wallMs: Date.now() - t0 };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];

async function main() {
  console.log(`BUDGET: ${BUDGET} HTTP requests, hard-capped. Aborting at the first 429.`);
  console.log(`endpoint host: ${new URL(RPC).host} · method eth_call (tokenPaused), rotating ${STOCK_TOKENS.length} tokens`);
  console.log(`levels: concurrency ${LEVELS.join(", ")} · ${PER_LEVEL} requests each · ${REST_MS}ms rest between\n`);
  console.log("conc  reqs   wall_ms   achieved_rps   p50_ms  p95_ms  max_ms   429  other  rpc_err");

  for (const c of LEVELS) {
    if (wireCount() + PER_LEVEL > BUDGET) {
      console.log(`\nSTOPPED: next level would exceed the declared budget (${wireCount()}/${BUDGET}).`);
      break;
    }
    const { results, wallMs } = await burst(c, PER_LEVEL);
    const lat = results.map((r) => r.ms);
    const n429 = results.filter((r) => r.status === 429).length;
    const other = results.filter((r) => r.status !== 200 && r.status !== 429).length;
    const rpcErr = results.filter((r) => r.jsonRpcError).length;
    const rps = (results.length / (wallMs / 1000)).toFixed(1);
    console.log(
      `${String(c).padStart(4)}  ${String(results.length).padStart(4)}  ${String(wallMs).padStart(7)}   ${rps.padStart(12)}   ${String(pct(lat, 0.5)).padStart(6)}  ${String(pct(lat, 0.95)).padStart(6)}  ${String(Math.max(...lat)).padStart(6)}   ${String(n429).padStart(3)}  ${String(other).padStart(5)}  ${String(rpcErr).padStart(6)}`,
    );
    if (n429 > 0) {
      const ra = results.find((r) => r.retryAfter)?.retryAfter ?? "(none)";
      const firstIdx = results.findIndex((r) => r.status === 429);
      console.log(`\nONSET: first 429 at concurrency ${c} — ${n429}/${results.length} of the burst, first at request ${firstIdx + 1} of the level.`);
      console.log(`Retry-After header: ${ra}`);
      console.log(`achieved rate at onset: ${rps} req/s at concurrency ${c}`);
      console.log(`STOPPING THE RAMP HERE. The ceiling is deliberately not characterised.`);
      break;
    }
    if (other > 0 || rpcErr > 0) {
      const sample = results.find((r) => r.jsonRpcError)?.jsonRpcError ?? results.find((r) => r.status !== 200)?.status;
      console.log(`  note: non-429 failure at this level — ${sample}`);
    }
    await sleep(REST_MS);
  }

  console.log(`\ntotal 429s seen across the whole ramp: ${statusCount(429)}`);
  console.log(budgetReport());
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? e.message : String(e));
  console.log(budgetReport());
  process.exit(1);
});
