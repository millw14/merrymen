/**
 * WHAT ONE ROUTE SEARCH ACTUALLY COSTS THE PROVIDER.
 *
 * Nine hours of production produced ZERO quotes: all 312 [exec] intents ran
 * mode=paper and returned before bestRoute. So the single largest consumer of
 * RPC in the design has never been observed, and Stage B cannot size a quote
 * budget without this.
 *
 * PRODUCTION CODE PATH, UNMODIFIED. This imports the real `bestRoute` from
 * worker/src/venues/uniswap.ts and the real token/protocol registries. Nothing
 * is reimplemented, so what is measured is what the fleet would do.
 *
 * READ-ONLY. `bestRoute` reaches the chain through `simulateContract` and
 * `readContract` — eth_call only. Nothing is signed, nothing is broadcast, no
 * UserOperation is built, no funds move. A hard request budget throws rather
 * than degrading the endpoint the live fleet depends on.
 *
 * HOW THE BOUNDED COMPARISON KEEPS THE CANDIDATE SET IDENTICAL. It does NOT
 * reimplement bestRoute with a concurrency limiter — that would measure a
 * different function and quietly risk evaluating fewer routes. Instead the limit
 * is applied AT THE TRANSPORT: bestRoute still issues its full `Promise.all`,
 * and the transport gates how many of those calls are in flight at once. Same
 * candidates by construction, same code, only the scheduling differs.
 *
 * Run: railway run --service orchestrator -- npx tsx spikes/stage-b/quote-probe.ts
 * (or plain `npx tsx` — no bundler key is needed, this never leaves eth_call.)
 */
import { createPublicClient, http, type Transport } from "viem";
import { bestRoute, FEE_TIERS } from "../../worker/src/venues/uniswap";
import {
  CASH,
  STOCK_TOKENS,
  UNISWAP,
  robinhoodChain,
  USDG_DECIMALS,
} from "../../packages/core/src/index";

const RPC = process.env.MERRYMEN_RPC_MAINNET || "https://rpc.mainnet.chain.robinhood.com";
const BUDGET = 4000;

// ── the instrument ──────────────────────────────────────────────────────────

interface Attempt {
  ms: number;
  status: number | "throw";
  selector: string;
  to: string;
  bodyKey: string;
  attemptNo: number;
}

class Meter {
  attempts: Attempt[] = [];
  logical = 0;
  inFlight = 0;
  peak = 0;
  retries = 0;
  rateLimited = 0;
  spent = 0;
  private seenBody = new Map<string, number>();

  reset() {
    this.attempts = [];
    this.logical = 0;
    this.inFlight = 0;
    this.peak = 0;
    this.retries = 0;
    this.rateLimited = 0;
    this.seenBody.clear();
  }
  noteBody(k: string): number {
    const n = (this.seenBody.get(k) ?? 0) + 1;
    this.seenBody.set(k, n);
    return n;
  }
  duplicates(): { key: string; times: number }[] {
    return [...this.seenBody.entries()].filter(([, n]) => n > 1).map(([key, times]) => ({ key, times }));
  }
  distinctBodies(): number {
    return this.seenBody.size;
  }
}

/** Selector → which part of the route search issued it. */
function categorise(selector: string, to: string): string {
  const t = to.toLowerCase();
  if (t === UNISWAP.v3QuoterV2.toLowerCase()) {
    // quoteExactInputSingle vs quoteExactInput (the multi-hop path form).
    return selector === "0xc6a5026a" ? "direct-v3" : selector === "0xcdca1753" ? "two-hop-v3" : `v3-other:${selector}`;
  }
  if (UNISWAP.v4Quoter && t === String(UNISWAP.v4Quoter).toLowerCase()) return "v4-quote";
  if (UNISWAP.v4PoolManager && t === String(UNISWAP.v4PoolManager).toLowerCase()) return "v4-poolmanager";
  if (UNISWAP.v3Factory && t === String(UNISWAP.v3Factory).toLowerCase()) return "pool-discovery-v3";
  if (UNISWAP.v4StateView && t === String(UNISWAP.v4StateView).toLowerCase()) return "v4-discovery(stateView)";
  return `other:${t.slice(0, 10)}:${selector}`;
}

/**
 * A transport that counts every HTTP attempt and, optionally, bounds how many
 * are in flight at once. The bound is the ONLY difference between the three
 * runs compared below.
 */
function probeTransport(meter: Meter, limit: number | null): Transport {
  let active = 0;
  const queue: (() => void)[] = [];
  const acquire = async () => {
    if (limit === null) return;
    if (active < limit) {
      active += 1;
      return;
    }
    await new Promise<void>((r) => queue.push(r));
    active += 1;
  };
  const release = () => {
    if (limit === null) return;
    active -= 1;
    const next = queue.shift();
    if (next) next();
  };

  const fetchFn: typeof fetch = async (input, init) => {
    if (++meter.spent > BUDGET) throw new Error(`request budget of ${BUDGET} exhausted — stopping`);
    const body = typeof init?.body === "string" ? init.body : "";
    let selector = "";
    let to = "";
    try {
      const parsed = JSON.parse(body) as { method?: string; params?: [{ to?: string; data?: string }] };
      to = parsed.params?.[0]?.to ?? "";
      selector = (parsed.params?.[0]?.data ?? "").slice(0, 10);
    } catch {
      /* not an eth_call shape */
    }
    // THE TRUE IDENTITY OF AN eth_call IS (to, data). An earlier version keyed
    // on a 120-character tail, which can collide between different calls and
    // would inflate the duplicate count — the one number here most worth
    // getting right, since it is the case for caching.
    const callData = (() => { try { const p = JSON.parse(body); return String(p.params?.[0]?.data ?? body); } catch { return body; } })();
    const bodyKey = `${to}:${callData}`;
    const attemptNo = meter.noteBody(bodyKey);
    if (attemptNo > 1) {
      /* counted as a duplicate below, not as a retry — retries are per-HTTP */
    }

    await acquire();
    meter.inFlight += 1;
    if (meter.inFlight > meter.peak) meter.peak = meter.inFlight;
    const t0 = Date.now();
    try {
      const res = await fetch(input, init);
      if (res.status === 429) {
        meter.rateLimited += 1;
      }
      meter.attempts.push({ ms: Date.now() - t0, status: res.status, selector, to, bodyKey, attemptNo });
      return res;
    } catch (e) {
      meter.attempts.push({ ms: Date.now() - t0, status: "throw", selector, to, bodyKey, attemptNo });
      throw e;
    } finally {
      meter.inFlight -= 1;
      release();
    }
  };

  return http(RPC, { fetchFn });
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};

// ── the workload ────────────────────────────────────────────────────────────

/** Representative pairs: several assets, not one. */
const PAIRS = STOCK_TOKENS.slice(0, 6).map((t) => ({ symbol: t.symbol, token: t.address as `0x${string}` }));
/** Realistic merrymen sizes, in USDG (6dp). Per-trade caps are tens of dollars. */
const SIZES_USDG = [5, 25, 100, 500];

async function runOne(
  meter: Meter,
  limit: number | null,
  pair: { symbol: string; token: `0x${string}` },
  usdg: number,
  v4: boolean,
) {
  const client = createPublicClient({ chain: robinhoodChain, transport: probeTransport(meter, limit) });
  const amountIn = BigInt(Math.round(usdg * 10 ** USDG_DECIMALS));
  const t0 = Date.now();
  meter.logical += 1;
  const quote = await bestRoute(client, {
    tokenIn: CASH.USDG as `0x${string}`,
    tokenOut: pair.token,
    amountIn,
    // The same candidate set every run: direct tiers, two-hop via WETH, and v4.
    via: (CASH.WETH ?? undefined) as `0x${string}` | undefined,
    v4,
  }).catch(() => null);
  return { ms: Date.now() - t0, quote };
}

async function main() {
  console.log(`RPC host ${new URL(RPC).hostname} · budget ${BUDGET} HTTP requests`);
  console.log(`pairs ${PAIRS.map((p) => p.symbol).join(",")} · sizes ${SIZES_USDG.join("/")} USDG`);
  console.log(
    `candidate shape: ${FEE_TIERS.length} direct tiers + ${FEE_TIERS.length ** 2} two-hop combos + v4\n`,
  );

  // ── A. the real thing, unbounded, across pairs and sizes ─────────────────
  console.log("=== A. PRODUCTION bestRoute (unbounded Promise.all) ===");
  const perRun: { label: string; ms: number; attempts: number; peak: number; ok: boolean; out: string }[] = [];
  const catTotals = new Map<string, number>();
  let dupTotal = 0;
  let distinctTotal = 0;
  const allLat: number[] = [];

  for (const pair of PAIRS) {
    for (const usdg of SIZES_USDG) {
      const m = new Meter();
      m.spent = 0;
      const { ms, quote } = await runOne(m, null, pair, usdg, true);
      allLat.push(ms);
      for (const a of m.attempts) {
        const c = categorise(a.selector, a.to);
        catTotals.set(c, (catTotals.get(c) ?? 0) + 1);
      }
      const dups = m.duplicates();
      dupTotal += dups.reduce((n, d) => n + (d.times - 1), 0);
      distinctTotal += m.distinctBodies();
      perRun.push({
        label: `${pair.symbol} ${usdg}`,
        ms,
        attempts: m.attempts.length,
        peak: m.peak,
        ok: quote !== null,
        out: quote ? String(quote.amountOut) : "no route",
      });
      console.log(
        `  ${pair.symbol.padEnd(6)} ${String(usdg).padStart(4)} USDG → ` +
          `${String(m.attempts.length).padStart(3)} HTTP · peak ${String(m.peak).padStart(2)} · ` +
          `${String(ms).padStart(5)}ms · ${quote ? `out ${quote.amountOut}` : "NO ROUTE"}` +
          `${dups.length ? ` · ${dups.reduce((n, d) => n + d.times - 1, 0)} dup` : ""}`,
      );
    }
  }

  const usable = perRun.filter((r) => r.ok).length;
  console.log(
    `\n  runs ${perRun.length} · usable quotes ${usable} (${((usable / perRun.length) * 100).toFixed(0)}%) · ` +
      `p50 ${pct(allLat, 50)}ms · p95 ${pct(allLat, 95)}ms`,
  );
  console.log(`  HTTP attempts per route search: ${(perRun.reduce((n, r) => n + r.attempts, 0) / perRun.length).toFixed(1)} avg`);
  console.log(`  peak HTTP concurrency, worst run: ${Math.max(...perRun.map((r) => r.peak))}`);
  console.log("  by category:");
  for (const [c, n] of [...catTotals.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${c.padEnd(20)} ${String(n).padStart(4)} (${(n / perRun.length).toFixed(1)}/route)`);
  }
  console.log(
    `  repeated identical eth_call WITHIN one route search: ${dupTotal} across ${perRun.length} runs ` +
      `(${distinctTotal} distinct bodies total)\n`,
  );

  // ── B. same pair/size, three schedules ───────────────────────────────────
  console.log("=== B. SCHEDULING COMPARISON — identical candidate set, transport-gated ===");
  const probe = PAIRS[0]!;
  const size = 100;
  for (const limit of [null, 4, 2] as const) {
    const m = new Meter();
    const { ms, quote } = await runOne(m, limit, probe, size, true);
    const lat = m.attempts.map((a) => a.ms);
    console.log(
      `  ${limit === null ? "Promise.all (unbounded)" : `bounded ${limit}`.padEnd(23)} → ` +
        `${String(m.attempts.length).padStart(3)} attempts · peak ${String(m.peak).padStart(2)} · ` +
        `route ${String(ms).padStart(5)}ms · call p50 ${pct(lat, 50)}ms p95 ${pct(lat, 95)}ms · ` +
        `${m.rateLimited} 429 · out ${quote ? quote.amountOut : "none"}` +
        `${quote?.v4 ? " (v4)" : quote ? ` (v3 fee ${quote.fee})` : ""}`,
    );
  }

  // ── C. immutability: which calls could be cached across runs? ────────────
  console.log("\n=== C. REPEATED ACROSS RUNS — the cacheable surface ===");
  const m1 = new Meter();
  await runOne(m1, null, probe, size, true);
  const first = new Set(m1.attempts.map((a) => a.bodyKey));
  const m2 = new Meter();
  await runOne(m2, null, probe, size, true);
  const second = m2.attempts.map((a) => a.bodyKey);
  const repeated = second.filter((k) => first.has(k)).length;
  console.log(
    `  identical run twice: ${second.length} attempts, ${repeated} byte-identical to the first ` +
      `(${((repeated / Math.max(1, second.length)) * 100).toFixed(0)}%)`,
  );
  const byCat = new Map<string, number>();
  for (const a of m2.attempts) if (first.has(a.bodyKey)) byCat.set(categorise(a.selector, a.to), (byCat.get(categorise(a.selector, a.to)) ?? 0) + 1);
  for (const [c, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) console.log(`    repeatable ${c.padEnd(20)} ${n}`);
  console.log(
    `  NOTE: a repeated QUOTE body is not automatically cacheable — a quote is a\n` +
      `  price and it moves. Pool DISCOVERY (which pool exists, its key) is the part\n` +
      `  that is immutable or slow-changing. The split above is what separates them.`,
  );

  console.log(`\ntotal HTTP requests spent: ${m1.spent + m2.spent + perRun.reduce((n, r) => n + r.attempts, 0)}`);
}

main().catch((e) => {
  console.error(String(e).slice(0, 400));
  process.exit(1);
});
