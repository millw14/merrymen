/**
 * Read-only venue quote comparison on Robinhood Chain (4663): Stoa, Uniswap and Rialto.
 *
 * For each pair and input amount it asks every venue for an exact-input quote at the same moment and records:
 * the amount the trader would receive after the venue's own fees, how long the quote took, and failures (no route,
 * HTTP errors, timeouts). Nothing is signed or sent; all calls are eth_call or plain GETs.
 *
 *   npx tsx scripts/compare-venue-quotes.mts                    # Stoa + Uniswap
 *   RIALTO_API_KEY=… npx tsx scripts/compare-venue-quotes.mts   # + Rialto (its /quote needs an integrator key)
 *   … --json > out.json                                         # machine-readable rows
 *
 * Venues and what "amount received" means for each:
 * - Stoa: GET https://stoadex.com/api/v1/quote (no key). amountOut is net of Stoa's 2 bps router fee. Stoa itself
 *   routes through the chain's pools (Uniswap V2/V3/V4, Aero, Ramses, Pons curves), direct or via one hop token.
 * - Uniswap V2: Router02.getAmountsOut over [WETH, X] and through hop tokens (VIRTUAL, USDG). LP fee included.
 * - Uniswap V3: QuoterV2.quoteExactInputSingle at every fee tier, and two-hop quoteExactInput through the same hop
 *   tokens. LP fees included. (Uniswap V4 is not covered here: its pools need hook-specific keys; Merrymen's own
 *   worker/src/venues/uniswap-v4.ts can be plugged in for a fuller picture.)
 * - Rialto: GET {apiBase}/quote with the key from RIALTO_API_KEY (header RIALTO_API_KEY_HEADER, default x-api-key);
 *   buyAmount as returned (Rialto states an indicative platform fee of 50 bps).
 * Tokens that take a fee on every transfer: Uniswap's quoters ignore that fee, so for those tokens the Uniswap rows
 * also show the amount after it (TRANSFER_FEE_BPS, measured on chain with a simulated swap: MERRYMEN takes 1.00%).
 * Stoa's buy quotes with ETH already come from a simulated swap and include it; Stoa refuses to sell such tokens.
 * On-chain quotes are pinned to one block; the two HTTP APIs answer at their latest block, so rows list the block
 * the on-chain quotes used and the wall-clock time of each request.
 */
import { createPublicClient, formatUnits, http, parseAbi, parseUnits, type Address, type Hex } from "viem";

const RPC = process.env.RH_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const STOA = process.env.STOA_API ?? "https://stoadex.com";
const RIALTO = process.env.RIALTO_API_BASE ?? "https://rialto-trade-api.rialto.xyz";
const TIMEOUT_MS = Number(process.env.QUOTE_TIMEOUT_MS ?? 8000);

const T = {
  ETH: "0x0000000000000000000000000000000000000000",
  WETH: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  USDG: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  VIRTUAL: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31",
  MERRYMEN: "0xA15cD06dD305269A0f48BeBEB30aa3588Fba7b32",
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
} as const satisfies Record<string, Address>;
type Sym = keyof typeof T;
const DEC: Record<Sym, number> = { ETH: 18, WETH: 18, USDG: 6, VIRTUAL: 18, MERRYMEN: 18, NVDA: 18, TSLA: 18 };
const HOPS: Sym[] = ["VIRTUAL", "USDG", "WETH"];
/** fee taken on every transfer, in bps, measured 27 Nov 2026 (router-delivered vs quoter output on the same path) */
const TRANSFER_FEE_BPS: Partial<Record<Sym, number>> = { MERRYMEN: 100 };

/** pair and human input amount; ETH means native in, quoted as WETH on Uniswap */
const CASES: [Sym, Sym, string][] = [
  ["ETH", "MERRYMEN", "0.005"], ["ETH", "MERRYMEN", "0.02"], ["ETH", "MERRYMEN", "0.1"],
  ["MERRYMEN", "ETH", "50000"],
  ["ETH", "USDG", "0.01"], ["ETH", "USDG", "0.1"],
  ["USDG", "NVDA", "25"], ["USDG", "TSLA", "25"],
];

const UNI = {
  v2Router: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba",
  v3QuoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
} as const;
const v2Abi = parseAbi(["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)"]);
const v3Abi = parseAbi([
  "struct P { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(P p) returns (uint256 amountOut, uint160, uint32, uint256)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[], uint32[], uint256)",
]);
const FEES = [100, 500, 3000, 10000];

const client = createPublicClient({ transport: http(RPC, { timeout: TIMEOUT_MS }) });
const uniAddr = (s: Sym) => (s === "ETH" ? T.WETH : T[s]);
const v3Path = (toks: Address[], fees: number[]) =>
  ("0x" + toks.map((t, i) => t.slice(2).toLowerCase() + (i < fees.length ? fees[i].toString(16).padStart(6, "0") : "")).join("")) as Hex;

type Row = { pair: string; amountIn: string; venue: string; amountOut: string | null; route: string | null; ms: number; error: string | null; at: string; block?: string; note?: string };

async function timed<T>(fn: () => Promise<T>): Promise<{ v: T | null; ms: number; err: string | null }> {
  const t0 = performance.now();
  try {
    const v = await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout after ${TIMEOUT_MS} ms`)), TIMEOUT_MS))]);
    return { v, ms: Math.round(performance.now() - t0), err: null };
  } catch (e) {
    return { v: null, ms: Math.round(performance.now() - t0), err: e instanceof Error ? e.message.split("\n")[0].slice(0, 160) : String(e) };
  }
}

async function stoa(a: Sym, b: Sym, amt: bigint) {
  const u = `${STOA}/api/v1/quote?chain=robinhood&sellToken=${a === "ETH" ? "native" : T[a]}&buyToken=${b === "ETH" ? "native" : T[b]}&amount=${amt}`;
  const r = await fetch(u);
  const j = (await r.json()) as { amountOut?: string; error?: string; route?: { mid: string | null; legs: { name: string }[] } };
  if (!r.ok || !j.amountOut) throw new Error(j.error ?? `HTTP ${r.status}`);
  const hop = j.route?.mid ? (Object.entries(T).find(([, v]) => v.toLowerCase() === j.route!.mid!.toLowerCase())?.[0] ?? j.route.mid) : null;
  return { out: BigInt(j.amountOut), route: (j.route?.legs ?? []).map((l) => l.name).join(" → ") + (hop ? ` (via ${hop})` : "") };
}

async function uniV2(a: Sym, b: Sym, amt: bigint, block: bigint) {
  const paths: Sym[][] = [[a, b], ...HOPS.filter((h) => h !== a && h !== b && !(h === "WETH" && (a === "ETH" || b === "ETH"))).map((h) => [a, h, b])];
  let best: { out: bigint; route: string } | null = null;
  for (const p of paths) {
    try {
      const amounts = await client.readContract({ address: UNI.v2Router, abi: v2Abi, functionName: "getAmountsOut", args: [amt, p.map(uniAddr)], blockNumber: block });
      const out = amounts[amounts.length - 1];
      if (!best || out > best.out) best = { out, route: `V2 ${p.join("→")}` };
    } catch { /* no pair on this path */ }
  }
  if (!best) throw new Error("no V2 route");
  return best;
}

async function uniV3(a: Sym, b: Sym, amt: bigint, block: bigint) {
  let best: { out: bigint; route: string } | null = null;
  const consider = (out: bigint, route: string) => { if (!best || out > best.out) best = { out, route }; };
  await Promise.all(FEES.map(async (fee) => {
    try {
      const { result } = await client.simulateContract({ address: UNI.v3QuoterV2, abi: v3Abi, functionName: "quoteExactInputSingle", args: [{ tokenIn: uniAddr(a), tokenOut: uniAddr(b), amountIn: amt, fee, sqrtPriceLimitX96: 0n }], blockNumber: block });
      consider(result[0], `V3 ${a}→${b} ${fee / 1e4}%`);
    } catch { /* no pool at this tier */ }
  }));
  for (const h of HOPS.filter((h) => h !== a && h !== b && !(h === "WETH" && (a === "ETH" || b === "ETH")))) {
    await Promise.all(FEES.flatMap((f1) => FEES.map(async (f2) => {
      try {
        const { result } = await client.simulateContract({ address: UNI.v3QuoterV2, abi: v3Abi, functionName: "quoteExactInput", args: [v3Path([uniAddr(a), T[h], uniAddr(b)], [f1, f2]), amt], blockNumber: block });
        consider(result[0], `V3 ${a}→${h}→${b} ${f1 / 1e4}%/${f2 / 1e4}%`);
      } catch { /* no pools on this path */ }
    })));
  }
  if (!best) throw new Error("no V3 route");
  return best as { out: bigint; route: string };
}

async function rialto(a: Sym, b: Sym, amt: bigint) {
  const key = process.env.RIALTO_API_KEY;
  if (!key) throw new Error("skipped: set RIALTO_API_KEY");
  const taker = process.env.RIALTO_TAKER ?? "0x000000000000000000000000000000000000dEaD";
  const u = `${RIALTO}/quote?sellToken=${a === "ETH" ? T.ETH : T[a]}&buyToken=${b === "ETH" ? T.ETH : T[b]}&sellAmount=${amt}&taker=${taker}`;
  const r = await fetch(u, { headers: { [process.env.RIALTO_API_KEY_HEADER ?? "x-api-key"]: key } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = (await r.json()) as Record<string, unknown>;
  const f = j.buyAmount ?? j.outputAmount ?? j.amountOut;
  if (typeof f !== "string" && typeof f !== "number") throw new Error("no buyAmount in response");
  return { out: BigInt(f), route: "Rialto" };
}

const rows: Row[] = [];
for (const [a, b, human] of CASES) {
  const amt = parseUnits(human, DEC[a]);
  const block = await client.getBlockNumber();
  const at = new Date().toISOString();
  const pair = `${a}→${b}`;
  const res = await Promise.all([
    ["Stoa", () => stoa(a, b, amt)],
    ["Uniswap V2", () => uniV2(a, b, amt, block)],
    ["Uniswap V3", () => uniV3(a, b, amt, block)],
    ["Rialto", () => rialto(a, b, amt)],
  ].map(async ([venue, fn]) => ({ venue: venue as string, r: await timed(fn as () => Promise<{ out: bigint; route: string }>) })));
  for (const { venue, r } of res) {
    let out = r.v?.out ?? null; let note: string | undefined;
    // Uniswap quoters ignore a token's transfer fee: one transfer into the pool (selling it), one out (buying it)
    const fee = (TRANSFER_FEE_BPS[a] ?? 0) + (TRANSFER_FEE_BPS[b] ?? 0);
    if (out !== null && venue.startsWith("Uniswap") && fee > 0) { out = (out * BigInt(10_000 - fee)) / 10_000n; note = `after ${fee / 100}% token transfer fee`; }
    rows.push({ pair, amountIn: human, venue, amountOut: out !== null ? formatUnits(out, DEC[b]) : null, route: r.v?.route ?? null, ms: r.ms, error: r.err, at, block: block.toString(), ...(note ? { note } : {}) });
  }
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  let last = "";
  for (const r of rows) {
    const k = `${r.pair} ${r.amountIn}`;
    if (k !== last) {
      const best = Math.max(...rows.filter((x) => `${x.pair} ${x.amountIn}` === k && x.amountOut).map((x) => Number(x.amountOut)));
      console.log(`\n${r.pair}  in ${r.amountIn}  (block ${r.block}, ${r.at})`);
      last = k;
      for (const x of rows.filter((y) => `${y.pair} ${y.amountIn}` === k)) {
        const vs = x.amountOut && best > 0 ? ` ${((Number(x.amountOut) / best - 1) * 100).toFixed(2)}% vs best` : "";
        console.log(`  ${x.venue.padEnd(11)} ${(x.amountOut ? Number(x.amountOut).toPrecision(8) : "—").padStart(16)}  ${String(x.ms).padStart(5)} ms${vs}  ${x.error ?? x.route ?? ""}${x.note ? ` [${x.note}]` : ""}`);
      }
    }
  }
}
