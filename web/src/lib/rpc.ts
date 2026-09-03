/**
 * THE ONE PLACE WEB DECIDES WHICH RPC IT TALKS TO, AND COUNTS WHAT IT SENT.
 *
 * Eleven sites in `web` built their own viem client. Two hard-coded
 * `https://rpc.mainnet.chain.robinhood.com` as a literal, so no configuration
 * could move them; eight passed a bare `http()` and inherited the chain default;
 * one read the settings file. Every one of them therefore pointed at the SAME
 * host as the hosted worker fleet — which is provable: `MERRYMEN_RPC_MAINNET` on
 * the web service resolves to host `rpc.mainnet.chain.robinhood.com`, and
 * `packages/core/src/chain.ts` gives exactly that as `rpcUrls.default`.
 *
 * WHAT THAT DOES AND DOES NOT MEAN. Same provider, same endpoint: proven. Same
 * QUOTA BUCKET: not proven, and probably not. The endpoint is keyless — the
 * configured value is the bare URL with no path or query, so there is no account
 * for two services to share — which leaves source IP as the only plausible
 * limiting dimension, and `web` and `orchestrator` are separate Railway
 * containers. Settling it needs the two services' egress addresses, which needs
 * in-container execution this repo cannot currently do (`railway ssh` wants a
 * registered key). So web is NOT folded into the worker's fleet figure, and this
 * module exists so that decision can be revisited from data rather than re-argued.
 *
 * WHY NOT IMPORT worker/src/rpc-meter.ts. Three reasons, all structural:
 *   - it uses `node:async_hooks` to correlate an HTTP attempt with the logical
 *     operation that caused it, and `web` ships a browser bundle;
 *   - `web` is a separate tsconfig project that imports `packages/core`, never
 *     `worker/src`, and reaching across would drag the worker's module graph
 *     into Next's build;
 *   - the correlation ALS buys is not needed here. viem hands `fetchFn` the
 *     request body, and the body carries the method — so this file reads it from
 *     there and needs no context at all.
 * What is NOT reproduced is retry grouping: without a logical id, an attempt
 * cannot be attributed to the operation it retries. Attempts are still counted
 * in full, so the total is right; only the retries-per-operation split is
 * missing, and this comment is the record of that.
 *
 * NEVER THE URL, ONLY THE HOST. An RPC URL can carry a credential in its path or
 * query. Nothing here logs more than a hostname.
 */
import { http, type Transport } from "viem";
import { chainForId, robinhoodChain, robinhoodTestnet } from "../../../packages/core/src/index";

/** Hostname only. See the header. */
export function providerOf(url: string | undefined): string {
  if (!url) return "chain-default";
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

/**
 * THE CANONICAL RESOLUTION, mirroring worker/src/settings.ts:260-261.
 *
 * A tenant's settings file first, then the house environment, then the chain
 * default. Hosted, the house strips `rpcMainnet`/`rpcTestnet` from a tenant's
 * file (they are HOUSE_KEY_FIELDS), so the env value is what applies — and the
 * chain default is the last resort rather than the first, which is the bug the
 * eight bare `http()` calls had.
 */
export function rpcUrlFor(
  chainId: number,
  settings?: { rpcMainnet?: string; rpcTestnet?: string },
): string | undefined {
  const testnet = chainId === robinhoodTestnet.id;
  const fromFile = testnet ? settings?.rpcTestnet : settings?.rpcMainnet;
  const fromEnv = testnet ? process.env.MERRYMEN_RPC_TESTNET : process.env.MERRYMEN_RPC_MAINNET;
  const chosen = (fromFile ?? "").trim() || (fromEnv ?? "").trim();
  if (chosen) return chosen;
  // Explicit rather than implicit: returning the chain's own default makes the
  // provider visible to the counter below, where `http()`'s internal fallback
  // would have been invisible to it.
  return chainForId(chainId).rpcUrls.default.http[0];
}

interface Stat {
  attempts: number;
  byStatus: Map<number, number>;
  rateLimited: number;
  transportErrors: number;
  latencies: number[];
}

interface WebMeter {
  key: string;
  since: number;
  inFlight: number;
  peakInFlight: number;
  byMethod: Map<string, Stat>;
}

const meters = new Map<string, WebMeter>();
const LATENCY_CAP = 2048;
const BODY_SCAN_MAX = 4096;

function meterFor(key: string): WebMeter {
  let m = meters.get(key);
  if (!m) {
    m = { key, since: Date.now(), inFlight: 0, peakInFlight: 0, byMethod: new Map() };
    meters.set(key, m);
  }
  return m;
}

function statFor(m: WebMeter, method: string): Stat {
  let s = m.byMethod.get(method);
  if (!s) {
    s = { attempts: 0, byStatus: new Map(), rateLimited: 0, transportErrors: 0, latencies: [] };
    m.byMethod.set(method, s);
  }
  return s;
}

/** The JSON-RPC method, read off the outgoing body. No context needed. */
function methodOf(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== "string") return "unknown";
  try {
    const parsed = JSON.parse(body) as { method?: string } | { method?: string }[];
    if (Array.isArray(parsed)) return parsed.length === 1 ? (parsed[0]?.method ?? "batch") : "batch";
    return parsed.method ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Rate limiting arrives two ways on this chain: an HTTP 429, and an HTTP 200
 * whose JSON-RPC error reads "Rate Limit Hit". Only small bodies are scanned —
 * an error is a few hundred bytes, a result can be large — and the response is
 * handed back before the clone is read, so this adds no latency. Best effort on
 * a counter, never an input to a decision.
 */
function scanBody(res: Response, s: Stat): void {
  const len = Number(res.headers.get("content-length") ?? "0");
  if (!Number.isFinite(len) || len === 0 || len > BODY_SCAN_MAX) return;
  let clone: Response;
  try {
    clone = res.clone();
  } catch {
    return;
  }
  void clone
    .text()
    .then((t) => {
      const lower = t.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("too many requests")) s.rateLimited += 1;
    })
    .catch(() => {});
}

/**
 * A viem transport that counts every HTTP attempt the provider is actually sent.
 *
 * `fetchFn` is called from INSIDE viem's retry loop
 * (viem/utils/rpc/http.js: `await fetchFn(...)`), so a 429 retried into a
 * success is visible here and nowhere else.
 */
export function countedHttp(url: string | undefined, label: string, chainId: number): Transport {
  const key = `${label}:${chainId}:${providerOf(url)}`;
  const m = meterFor(key);
  const fetchFn: typeof fetch = async (input, init) => {
    const s = statFor(m, methodOf(init as RequestInit | undefined));
    s.attempts += 1;
    m.inFlight += 1;
    if (m.inFlight > m.peakInFlight) m.peakInFlight = m.inFlight;
    const started = Date.now();
    try {
      const res = await fetch(input, init);
      s.byStatus.set(res.status, (s.byStatus.get(res.status) ?? 0) + 1);
      if (res.status === 429) s.rateLimited += 1;
      else scanBody(res, s);
      return res;
    } catch (e) {
      s.transportErrors += 1;
      throw e;
    } finally {
      m.inFlight -= 1;
      if (s.latencies.length < LATENCY_CAP) s.latencies.push(Date.now() - started);
    }
  };
  return http(url, { fetchFn });
}

/** Resolve and count in one step — what every call site should use. */
export function rpcTransportFor(
  chainId: number,
  label: string,
  settings?: { rpcMainnet?: string; rpcTestnet?: string },
): Transport {
  return countedHttp(rpcUrlFor(chainId, settings), label, chainId);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

/**
 * What `web` sent, in the same shape the worker emits, so the two can be read
 * side by side the day the quota question is settled.
 */
export function webRpcSummaryLines(): string[] {
  const out: string[] = [];
  for (const m of meters.values()) {
    const attempts = [...m.byMethod.values()].reduce((n, s) => n + s.attempts, 0);
    if (attempts === 0) continue;
    const secs = Math.max(1, Math.round((Date.now() - m.since) / 1000));
    const rateLimited = [...m.byMethod.values()].reduce((n, s) => n + s.rateLimited, 0);
    const transport = [...m.byMethod.values()].reduce((n, s) => n + s.transportErrors, 0);
    const statuses = new Map<number, number>();
    const all: number[] = [];
    for (const s of m.byMethod.values()) {
      for (const [c, n] of s.byStatus) statuses.set(c, (statuses.get(c) ?? 0) + n);
      all.push(...s.latencies);
    }
    all.sort((a, b) => a - b);
    const top = [...m.byMethod.entries()]
      .sort((a, b) => b[1].attempts - a[1].attempts)
      .slice(0, 6)
      .map(([method, s]) => `${method} ${s.attempts}`)
      .join(" · ");
    out.push(
      `[http:web:${m.key}] provider_http_attempts ${attempts} in ${secs}s ` +
        `(${(attempts / secs).toFixed(2)}/s) · ${rateLimited} rate-limited · ${transport} transport-err · ` +
        `statuses ${[...statuses.entries()].map(([c, n]) => `${c}:${n}`).join(",") || "none"} · ` +
        `peak http concurrency ${m.peakInFlight} · p50 ${percentile(all, 50)}ms p95 ${percentile(all, 95)}ms · ${top}`,
    );
  }
  return out;
}

/** Test seam. */
export function webRpcSnapshot(): {
  key: string;
  attempts: number;
  rateLimited: number;
  peakInFlight: number;
  byStatus: Record<number, number>;
  methods: string[];
}[] {
  return [...meters.values()].map((m) => {
    const byStatus: Record<number, number> = {};
    for (const s of m.byMethod.values()) for (const [c, n] of s.byStatus) byStatus[c] = (byStatus[c] ?? 0) + n;
    return {
      key: m.key,
      attempts: [...m.byMethod.values()].reduce((n, s) => n + s.attempts, 0),
      rateLimited: [...m.byMethod.values()].reduce((n, s) => n + s.rateLimited, 0),
      peakInFlight: m.peakInFlight,
      byStatus,
      methods: [...m.byMethod.keys()],
    };
  });
}

/** Test seam. */
export function resetWebRpcForTest(): void {
  meters.clear();
}

/** Re-exported so a call site never needs to import two modules to build a client. */
export { robinhoodChain, robinhoodTestnet };
