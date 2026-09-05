/** The canary's actual intended trade, quoted read-only. Nothing signed. */
import { createPublicClient, http } from "viem";
import { bestRoute } from "../../worker/src/venues/uniswap";
import { CASH, STOCK_TOKENS, robinhoodChain, USDG_DECIMALS } from "../../packages/core/src/index";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
let attempts = 0, inFlight = 0, peak = 0, rate429 = 0;
const lat: number[] = [];
const fetchFn: typeof fetch = async (u, i) => {
  attempts++; inFlight++; if (inFlight > peak) peak = inFlight;
  const t0 = Date.now();
  try { const r = await fetch(u, i); if (r.status === 429) rate429++; return r; }
  finally { inFlight--; lat.push(Date.now() - t0); }
};
const pct = (a: number[], p: number) => { const s=[...a].sort((x,y)=>x-y); return s.length? s[Math.min(s.length-1,Math.ceil(p/100*s.length)-1)]! : 0; };

async function main() {
  const client = createPublicClient({ chain: robinhoodChain, transport: http(RPC, { fetchFn }) });
  const sizes = [5, 8.33, 12.5];
  for (const sym of ["AAPL", "AMD", "COIN"]) {
    const tok = STOCK_TOKENS.find((t) => t.symbol === sym);
    if (!tok) continue;
    for (const usdg of sizes) {
      attempts = 0; peak = 0; rate429 = 0; lat.length = 0;
      const t0 = Date.now();
      const q = await bestRoute(client, {
        tokenIn: CASH.USDG as `0x${string}`,
        tokenOut: tok.address as `0x${string}`,
        amountIn: BigInt(Math.round(usdg * 10 ** USDG_DECIMALS)),
        via: CASH.WETH as `0x${string}`,
        v4: true,
      }).catch((e) => { console.log("  threw:", String(e).slice(0, 90)); return null; });
      const ms = Date.now() - t0;
      console.log(
        `${sym.padEnd(5)} ${String(usdg).padStart(6)} USDG → ${q ? `out ${q.amountOut} ${q.v4 ? "(v4)" : `(v3 fee ${q.fee})`}` : "NO ROUTE"}`,
      );
      console.log(
        `      logical 1 bestRoute · HTTP attempts ${attempts} · peak concurrency ${peak} · ` +
          `429s ${rate429} · route ${ms}ms · call p50 ${pct(lat,50)}ms p95 ${pct(lat,95)}ms`,
      );
    }
  }
}
main().catch((e) => { console.error(String(e).slice(0, 200)); process.exit(1); });
