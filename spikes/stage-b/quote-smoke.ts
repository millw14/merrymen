/** One bestRoute, printed in full. Confirms connectivity and shows the exact JSON-RPC params. */
import { createPublicClient, type PublicClient } from "viem";
import { robinhoodChain, CASH, STOCK_TOKENS } from "../../packages/core/src/index";
import { bestRoute } from "../../worker/src/venues/uniswap";
import { probeTransport, wire, resetWire, readMeter, resetRpcMeters } from "./quote-instrument";

const RPC = process.env.PROBE_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const tok = (s: string) => STOCK_TOKENS.find((t) => t.symbol === s)!.address;

const client = createPublicClient({ chain: robinhoodChain, transport: probeTransport(RPC) }) as PublicClient;

async function one(label: string, args: Parameters<typeof bestRoute>[1]) {
  resetWire();
  resetRpcMeters();
  const t = Date.now();
  const q = await bestRoute(client, args);
  const ms = Date.now() - t;
  console.log(`\n### ${label} — ${ms}ms — quote=${q ? `fee ${q.fee} out ${q.amountOut}${q.v4 ? " V4" : ""}${q.path ? " HOP" : ""}` : "null"}`);
  for (const l of readMeter()) console.log("  " + l.raw);
  console.log(`  wire posts: ${wire.length}`);
  for (const w of wire) console.log(`   ${w.method} to=${w.to} sel=${w.selector} ${w.ms}ms ok=${w.ok}`);
  console.log("  FIRST PARAMS:", wire[0]?.paramsJson.slice(0, 400));
}

async function main() {
  await one("USDG->NVDA direct-only 100 USDG", {
    tokenIn: CASH.USDG as `0x${string}`,
    tokenOut: tok("NVDA"),
    amountIn: 100_000_000n,
  });

  await one("USDG->NVDA full (via WETH + v4) 100 USDG", {
    tokenIn: CASH.USDG as `0x${string}`,
    tokenOut: tok("NVDA"),
    amountIn: 100_000_000n,
    via: CASH.WETH as `0x${string}`,
    v4: true,
  });
}
main();
