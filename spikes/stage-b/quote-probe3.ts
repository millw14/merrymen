/**
 * Stage B — quote path, part 3: SILENT ROUTE DEGRADATION, measured deterministically.
 *
 * Random injection made this a coin flip. Here the 429 is aimed: every v3-DIRECT
 * quote (selector 0xc6a5026a) is rate-limited and nothing else is. If bestRoute
 * still returns a quote, then a rate limit did not fail the trade — it changed
 * which pool the trade goes through, and the caller cannot tell.
 *
 * READ-ONLY. eth_call only. Nothing built, signed or sent.
 */
import { createPublicClient, type PublicClient } from "viem";
import { robinhoodChain, CASH, STOCK_TOKENS } from "../../packages/core/src/index";
import { bestRoute } from "../../worker/src/venues/uniswap";
import { probeTransport, wire, resetWire, readMeter, resetRpcMeters, setInjector } from "./quote-instrument";

const RPC = process.env.PROBE_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const tok = (s: string) => STOCK_TOKENS.find((t) => t.symbol === s)!.address;
const USDG = CASH.USDG as `0x${string}`;
const WETH = CASH.WETH as `0x${string}`;
const C = createPublicClient({ chain: robinhoodChain, transport: probeTransport(RPC) }) as PublicClient;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const selOf = (b: { params?: unknown }) => {
  const p = (b.params as { data?: string }[] | undefined)?.[0];
  return typeof p?.data === "string" ? p.data.slice(0, 10) : "";
};

async function one(label: string, tokenOut: `0x${string}`, amountIn: bigint) {
  resetWire(); resetRpcMeters();
  const t = Date.now();
  const q = await bestRoute(C, { tokenIn: USDG, tokenOut, amountIn, via: WETH, v4: true });
  const ms = Date.now() - t;
  const m = readMeter()[0];
  console.log(
    `  ${label.padEnd(26)} calls ${m?.calls} (${m?.errors}err ${m?.rateLimited}rl) wire ${wire.length}(${wire.filter((w) => w.injected).length}inj) ${ms}ms · ` +
      `${q ? `${q.v4 ? "V4" : q.path ? "HOP" : "DIRECT"} fee ${q.fee} out ${q.amountOut}` : "NULL"}`,
  );
  return q;
}

async function main() {
  console.log("===== PHASE 9: aimed 429 — deterministic route degradation =====");
  console.log("pair USDG->NVDA, amountIn 1000 USDG");
  const base: bigint[] = [];
  for (let i = 0; i < 3; i++) {
    const q = await one(`baseline r${i}`, tok("NVDA"), 1_000_000_000n);
    if (q) base.push(q.amountOut);
    await sleep(700);
  }

  console.log("\n  -- every v3 DIRECT quote rate-limited, nothing else --");
  const degraded: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    setInjector((b) => selOf(b) === "0xc6a5026a");
    const q = await one(`direct-429 r${i}`, tok("NVDA"), 1_000_000_000n);
    setInjector(null);
    if (q) degraded.push(q.amountOut);
    await sleep(700);
  }

  console.log("\n  -- every v3 HOP quote rate-limited, nothing else --");
  for (let i = 0; i < 2; i++) {
    setInjector((b) => selOf(b) === "0xcdca1753");
    await one(`hop-429 r${i}`, tok("NVDA"), 1_000_000_000n);
    setInjector(null);
    await sleep(700);
  }

  console.log("\n  -- v4 StateView rate-limited (discovery blinded) --");
  for (let i = 0; i < 2; i++) {
    setInjector((b) => selOf(b) === "0xc815641c");
    await one(`slot0-429 r${i}`, tok("NVDA"), 1_000_000_000n);
    setInjector(null);
    await sleep(700);
  }

  if (base.length && degraded.length) {
    const b = base.reduce((a, x) => a + x, 0n) / BigInt(base.length);
    const d = degraded.reduce((a, x) => a + x, 0n) / BigInt(degraded.length);
    const bpsWorse = Number(((b - d) * 10_000n) / b);
    console.log(`\n  baseline mean amountOut ${b}`);
    console.log(`  degraded mean amountOut ${d}`);
    console.log(`  the rate limit cost the fill ${bpsWorse} bps (${(bpsWorse / 100).toFixed(2)}%), reported to the caller as a normal quote`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
