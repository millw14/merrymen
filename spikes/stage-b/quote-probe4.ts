/** Stage B — the impact guard's marginal RPC cost (requoteRoute), measured. READ-ONLY. */
import { createPublicClient, type PublicClient } from "viem";
import { robinhoodChain, CASH, STOCK_TOKENS } from "../../packages/core/src/index";
import { bestRoute, requoteRoute } from "../../worker/src/venues/uniswap";
import { probeTransport, wire, resetWire, readMeter, resetRpcMeters } from "./quote-instrument";
const tok = (s: string) => STOCK_TOKENS.find((t) => t.symbol === s)!.address;
const USDG = CASH.USDG as `0x${string}`, WETH = CASH.WETH as `0x${string}`;
const C = createPublicClient({ chain: robinhoodChain, transport: probeTransport(process.env.PROBE_RPC ?? "https://rpc.mainnet.chain.robinhood.com") }) as PublicClient;
const sleep = (ms:number)=>new Promise(r=>setTimeout(r,ms));
async function main() {
  console.log("===== PHASE 10: full LIVE trade quote cost = bestRoute + requoteRoute =====");
  for (const [name, out] of [["NVDA(direct)", tok("NVDA")], ["ORCL(v4)", tok("ORCL")], ["BE(hop)", tok("BE")]] as [string,`0x${string}`][]) {
    for (let r = 0; r < 3; r++) {
      resetWire(); resetRpcMeters();
      const t0 = Date.now();
      const q = await bestRoute(C, { tokenIn: USDG, tokenOut: out, amountIn: 1_000_000_000n, via: WETH, v4: true });
      const a = readMeter()[0]!.calls; const tA = Date.now() - t0;
      resetRpcMeters();
      const t1 = Date.now();
      const probe = 1_000_000_000n / 20n;
      const re = q ? await requoteRoute(C, q, { tokenIn: USDG, tokenOut: out, amountIn: probe }) : null;
      const b = readMeter()[0]?.calls ?? 0; const tB = Date.now() - t1;
      console.log(`  ${name.padEnd(14)} r${r}: bestRoute ${a} calls ${tA}ms (${q ? (q.v4?"v4":q.path?"hop":"direct") : "null"}) + requoteRoute ${b} calls ${tB}ms (probeOut ${re}) = ${a+b} calls, ${tA+tB}ms`);
      await sleep(700);
    }
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
