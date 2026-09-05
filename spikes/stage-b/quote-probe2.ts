/**
 * Stage B — quote path, part 2.
 *
 * Closes two gaps left by quote-probe.ts:
 *   (7) TRUE no-pool behaviour. Every "no v3 pool" pair from tokens.ts:207 turned
 *       out to quote via v4 or via WETH, so the no-route cost was never measured.
 *       Here: pairs that quote nowhere, including a fabricated address that is not
 *       a contract at all — the floor of "discovering there is nothing".
 *   (8) DOES A PARTIAL 429 CHANGE THE ANSWER? Records amountOut, not just
 *       "quoted true/false", so a silently worse route is visible.
 *
 * READ-ONLY. eth_call only. Nothing built, signed or sent.
 */
import { createPublicClient, type PublicClient } from "viem";
import { robinhoodChain, CASH, STOCK_TOKENS } from "../../packages/core/src/index";
import { bestRoute } from "../../worker/src/venues/uniswap";
import { probeTransport, wire, resetWire, readMeter, resetRpcMeters, setInjector } from "./quote-instrument";
import { writeFileSync } from "node:fs";

const RPC = process.env.PROBE_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const OUT = process.env.PROBE_OUT ?? "quote-probe2.json";
const PACE = Number(process.env.PROBE_PACE ?? 700);
const tok = (s: string) => STOCK_TOKENS.find((t) => t.symbol === s)!.address;
const USDG = CASH.USDG as `0x${string}`;
const WETH = CASH.WETH as `0x${string}`;
const C = createPublicClient({ chain: robinhoodChain, transport: probeTransport(RPC) }) as PublicClient;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SEL: Record<string, string> = {
  "0xc6a5026a": "v3-direct", "0xcdca1753": "v3-hop",
  "0xc815641c": "v4-slot0", "0xfa6793d5": "v4-liquidity", "0xaa9d21cb": "v4-quote",
};

interface R {
  phase: string; pair: string; mode: string; rep: number;
  calls: number; err: number; rl: number; peak: number; wire: number; injected: number;
  ms: number; quoted: boolean; kind: string; amountOut: string; fee: number;
  buckets: Record<string, number>;
}
const rows: R[] = [];

async function run(phase: string, pair: string, mode: string, rep: number, args: Parameters<typeof bestRoute>[1]): Promise<R> {
  resetWire(); resetRpcMeters();
  const t = Date.now();
  const q = await bestRoute(C, args);
  const ms = Date.now() - t;
  const m = readMeter()[0];
  const buckets: Record<string, number> = {};
  for (const w of wire) { const b = SEL[w.selector ?? ""] ?? "other"; buckets[b] = (buckets[b] ?? 0) + 1; }
  const r: R = {
    phase, pair, mode, rep,
    calls: m?.calls ?? 0, err: m?.errors ?? 0, rl: m?.rateLimited ?? 0, peak: m?.peak ?? 0,
    wire: wire.length, injected: wire.filter((w) => w.injected).length,
    ms, quoted: q !== null, kind: q ? (q.v4 ? "v4" : q.path ? "hop" : "direct") : "none",
    amountOut: q ? q.amountOut.toString() : "0", fee: q?.fee ?? 0, buckets,
  };
  rows.push(r);
  return r;
}

const NOPOOL: [string, `0x${string}`][] = [
  ["USDG->BE", tok("BE")],
  ["USDG->CRWV", tok("CRWV")],
  ["USDG->INTC", tok("INTC")],
  ["USDG->META", tok("META")],
  ["USDG->ORCL", tok("ORCL")],
  ["USDG->SNDK", tok("SNDK")],
  // Not a contract at all. The floor: what does "nothing here" cost?
  ["USDG->0xdead(not a contract)", "0xdeaDDeADDEaDdeaDdEAddEADDEAdDeadDEADDEaD"],
];

async function phase7() {
  console.log("\n===== PHASE 7: pairs with no route anywhere =====");
  for (const [name, addr] of NOPOOL) {
    for (let r = 0; r < 5; r++) {
      const x = await run("nopool", name, "full", r, {
        tokenIn: USDG, tokenOut: addr, amountIn: 100_000_000n, via: WETH, v4: true,
      });
      console.log(`  ${name.padEnd(28)} r${r}: calls ${x.calls} · wire ${x.wire} · ${x.ms}ms · quoted=${x.quoted} ${x.kind} out=${x.amountOut} · ${JSON.stringify(x.buckets)}`);
      await sleep(PACE);
    }
  }
}

async function phase8() {
  console.log("\n===== PHASE 8: does a partial 429 change the ANSWER? (amountOut recorded) =====");
  for (const frac of [0, 0.25, 0.5]) {
    for (let r = 0; r < 10; r++) {
      if (frac > 0) setInjector(() => Math.random() < frac);
      const x = await run("degrade", "USDG->NVDA", `429@${frac}`, r, {
        tokenIn: USDG, tokenOut: tok("NVDA"), amountIn: 1_000_000_000n, via: WETH, v4: true,
      });
      setInjector(null);
      console.log(`  frac ${frac} r${r}: calls ${x.calls} (${x.rl}rl) wire ${x.wire}(${x.injected}inj) · ${x.kind} fee ${x.fee} out ${x.amountOut} · ${x.ms}ms`);
      await sleep(PACE);
    }
  }
}

async function main() {
  await phase7();
  await phase8();
  writeFileSync(OUT, JSON.stringify({ rpc: RPC, rows }, null, 2));
  console.log(`\nserial bestRoutes: ${rows.length} · wire POSTs: ${rows.reduce((a, r) => a + r.wire, 0)} (of which ${rows.reduce((a, r) => a + r.injected, 0)} synthetic, never sent)`);
  console.log(`wrote ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
