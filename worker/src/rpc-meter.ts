/**
 * WHAT WE ACTUALLY ASK THE CHAIN FOR, COUNTED — AT BOTH LAYERS.
 *
 * Nothing in the worker used to know. Every transport was `http()` with no
 * options, built at five separate sites, so there was no chokepoint — nowhere to
 * count, and nowhere to put a limiter later.
 *
 * THE GAP THAT REMAINED AFTER THE FIRST VERSION, and the reason this file now
 * has two layers rather than one. `metered()` wraps the object `http()` RETURNS,
 * and viem builds its retry loop INSIDE that object (createTransport.js:19
 * `request: buildRequest(request, { retryCount, retryDelay })`, default
 * retryCount 3). So the wrapper sits ABOVE the retries and counts one LOGICAL
 * operation no matter how many HTTP requests actually left the box.
 *
 * That is not a rounding error. Measured directly, 2026-09-03: one 21-chunk
 * eth_getLogs sweep produced 22 HTTP requests — `statuses 200:26 429:1` from a
 * fetch-level counter — because a 429 was retried into a success. The sweep
 * reported 21 chunks and no error; `metered()` saw one clean call; a provider
 * quota, which is denominated in HTTP requests, had been charged twice. A 429
 * retried into success left no trace anywhere.
 *
 * So there are now two counters and they answer different questions:
 *
 *   logical_rpc_calls      what the WORKER asked for. The unit our own code
 *                          reasons in — one quote, one sweep chunk, one getCode.
 *   provider_http_attempts what the PROVIDER was actually sent. The unit a
 *                          quota, a rate limit and a bill are denominated in.
 *
 * The difference between them IS the retry amplification, per method, per
 * provider, without inferring anything.
 *
 * WHERE THE SECOND LAYER LIVES. viem's `http()` accepts `fetchFn`
 * (clients/transports/http.js:24 → utils/rpc/http.js:43 `await fetchFn(...)`),
 * called once per HTTP attempt from inside the retry loop. That is the exact
 * boundary, it needs no monkey-patching of global fetch, and it cannot miss an
 * attempt viem makes.
 *
 * THIS STILL CHANGES NO BEHAVIOUR. Neither layer queues, delays, retries,
 * batches, dedupes or refuses. Both forward everything untouched and record what
 * happened. Retries are deliberately left ON: the instruction is to make them
 * observable before deciding whether to own them, and a meter that removed the
 * thing it was built to measure would be worthless.
 *
 * THE SEND EDGE. `metered()` forwards its second argument, which is how
 * `eth_sendUserOperation`'s per-call `retryCount: 0` survives the wrapper
 * (sendUserOperation.js:55, merged by buildRequest.js:9-13). A wrapper that
 * dropped it would silently restore three retries on a broadcast. `meteredFetch`
 * only observes — it never re-issues — so a metered send is still sent once.
 */
import { http, type Transport } from "viem";
import { AsyncLocalStorage } from "node:async_hooks";
import { basename } from "node:path";
import { classifyRpcError, type RpcErrorKind } from "./rpc-error";

/**
 * WHICH PROVIDER, ON WHICH CHAIN, FOR WHAT.
 *
 * The first version keyed every meter on `label` alone, and three different
 * hosts shared the label "read": the mainnet RPC, the testnet RPC, and the
 * chain default that snapshot.ts falls back to before setMainnetRpc runs. All
 * 263,776 calls of a 9-hour window landed in one bucket, and the split was
 * unrecoverable afterwards — which mattered, because it turned out those two
 * endpoints do NOT carry half the traffic each. Essentially all of it goes to
 * mainnet, from all 22 children.
 */
export interface RpcTarget {
  /** What this transport is FOR: "read", "bundler", "paymaster". */
  label: string;
  /** Chain id, so 4663 and 46630 can never share a bucket. */
  chainId: number;
  /**
   * The provider's HOSTNAME, and only the hostname.
   *
   * An RPC URL can carry an API key in its path or query — Pimlico's does — and
   * this string reaches logs. `providerOf` extracts the host and nothing else.
   */
  provider: string;
}

/** Hostname of an RPC URL, or "unknown". NEVER the path, which can hold a key. */
export function providerOf(url: string | undefined): string {
  if (!url) return "chain-default";
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

const keyOf = (t: RpcTarget) => `${t.label}:${t.chainId}:${t.provider}`;

/**
 * WHICH TENANT.
 *
 * Derived rather than passed, because the orchestrator does not hand children a
 * tenant variable — it hands them their own MERRYMEN_HOME under
 * `…/children/<tenant>` (orchestrator.ts:140). Reading it here needs no change
 * to the spawn path. Absent (self-hosted, CLI, tests) it is simply unknown, and
 * an unknown tenant is not a wrong tenant.
 */
function tenantOfProcess(): string {
  const home = process.env.MERRYMEN_HOME;
  if (!home) return "local";
  const leaf = basename(home);
  return /^0x[0-9a-fA-F]{40}$/.test(leaf) ? leaf.slice(0, 8).toLowerCase() : "local";
}
const TENANT = tenantOfProcess();

// ── the logical layer ───────────────────────────────────────────────────────

interface MethodStat {
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  byKind: Partial<Record<RpcErrorKind, number>>;
}

interface Meter {
  key: string;
  target: RpcTarget;
  since: number;
  calls: number;
  errors: number;
  inFlight: number;
  peakInFlight: number;
  byMethod: Map<string, MethodStat>;
}

const meters = new Map<string, Meter>();

function meterFor(target: RpcTarget): Meter {
  const key = keyOf(target);
  let m = meters.get(key);
  if (!m) {
    m = {
      key,
      target,
      since: Date.now(),
      calls: 0,
      errors: 0,
      inFlight: 0,
      peakInFlight: 0,
      byMethod: new Map(),
    };
    meters.set(key, m);
  }
  return m;
}

function statFor(m: Meter, method: string): MethodStat {
  let s = m.byMethod.get(method);
  if (!s) {
    s = { calls: 0, errors: 0, totalMs: 0, maxMs: 0, byKind: {} };
    m.byMethod.set(method, s);
  }
  return s;
}

// ── correlating attempts back to the operation that caused them ─────────────

interface LogicalContext {
  /** Stable within one logical operation, so its retries group together. */
  id: string;
  method: string;
  target: RpcTarget;
  /** Incremented by meteredFetch. 1 is the first try, 2+ are viem's retries. */
  attempts: number;
}

/**
 * The link between the two layers.
 *
 * `metered()` opens a context; `meteredFetch` reads it. AsyncLocalStorage rather
 * than a parameter because nothing in viem's path between them would carry one —
 * the retry loop, the batch scheduler and the http client all sit in between and
 * none of them is ours.
 *
 * A fetch with NO context is still counted. That is not a defect to paper over:
 * it means an HTTP attempt reached the provider from a path the logical layer
 * does not wrap, which is exactly the kind of blind spot this file exists to
 * expose (paymaster.ts and recover.ts each build transports metered() never saw).
 */
const logicalContext = new AsyncLocalStorage<LogicalContext>();
let logicalSeq = 0;

// ── the HTTP layer ─────────────────────────────────────────────────────────

interface AttemptStat {
  attempts: number;
  /** Attempts beyond the first for one logical operation — i.e. viem's retries. */
  retries: number;
  byStatus: Map<number, number>;
  rateLimited: number;
  transportErrors: number;
  totalMs: number;
  /** Bounded sample for percentiles; a window is a few thousand calls at most. */
  latencies: number[];
  latenciesDropped: number;
}

interface HttpMeter {
  key: string;
  target: RpcTarget;
  since: number;
  inFlight: number;
  peakInFlight: number;
  byMethod: Map<string, AttemptStat>;
  noContext: number;
}

const httpMeters = new Map<string, HttpMeter>();
const LATENCY_SAMPLE_CAP = 4096;

function httpMeterFor(target: RpcTarget): HttpMeter {
  const key = keyOf(target);
  let m = httpMeters.get(key);
  if (!m) {
    m = { key, target, since: Date.now(), inFlight: 0, peakInFlight: 0, byMethod: new Map(), noContext: 0 };
    httpMeters.set(key, m);
  }
  return m;
}

function attemptFor(m: HttpMeter, method: string): AttemptStat {
  let s = m.byMethod.get(method);
  if (!s) {
    s = {
      attempts: 0,
      retries: 0,
      byStatus: new Map(),
      rateLimited: 0,
      transportErrors: 0,
      totalMs: 0,
      latencies: [],
      latenciesDropped: 0,
    };
    m.byMethod.set(method, s);
  }
  return s;
}

/** Bodies large enough to be real data are not scanned. See scanBody. */
const BODY_SCAN_MAX = 4096;

/**
 * IS THIS 200 ACTUALLY A RATE LIMIT?
 *
 * Robinhood Chain returns rate limiting two ways: an HTTP 429, and an HTTP 200
 * carrying a JSON-RPC error whose message reads "Rate Limit Hit, limit will
 * reset in Ns" (rpc-error.ts documents the shape). Status alone catches the
 * first and misses the second.
 *
 * BEST EFFORT, AND SAID SO. Only small bodies are scanned — a JSON-RPC error is
 * a few hundred bytes while an eth_call result can be large, and buffering every
 * response to search it would cost more than the answer is worth. So a 200 that
 * is really a rate limit inside a big body is not counted here; it is still
 * counted at the logical layer if it survives to throw. This is a heuristic on
 * a counter, never an input to a safety decision.
 *
 * OFF THE REQUEST PATH. The response is cloned and read AFTER it has been handed
 * back to viem, so this adds no latency to the call it is measuring.
 */
function scanBody(res: Response, s: AttemptStat): void {
  const len = Number(res.headers.get("content-length") ?? "0");
  if (!Number.isFinite(len) || len === 0 || len > BODY_SCAN_MAX) return;
  let clone: Response;
  try {
    clone = res.clone();
  } catch {
    return; // already consumed or unclonable — not our business to force
  }
  void clone
    .text()
    .then((text) => {
      const lower = text.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("too many requests")) s.rateLimited += 1;
    })
    .catch(() => {});
}

/**
 * A `fetchFn` for viem's `http()` that counts every HTTP attempt.
 *
 * Pass it as `http(url, { fetchFn: meteredFetch(target) })`. It is called once
 * per attempt from inside viem's retry loop, so it sees what the provider sees.
 */
export function meteredFetch(target: RpcTarget): typeof fetch {
  const m = httpMeterFor(target);
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const ctx = logicalContext.getStore();
    const method = ctx?.method ?? "unattributed";
    const s = attemptFor(m, method);

    // The attempt number is the whole point: 1 is the try, 2+ are viem's.
    let attempt = 1;
    if (ctx) {
      ctx.attempts += 1;
      attempt = ctx.attempts;
    } else {
      m.noContext += 1;
    }
    s.attempts += 1;
    if (attempt > 1) s.retries += 1;

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
      // A socket hang-up, a DNS failure, an abort. No status exists for these,
      // and calling them status 0 would put them in the same column as a real
      // response — so they get their own counter.
      s.transportErrors += 1;
      throw e;
    } finally {
      m.inFlight -= 1;
      const ms = Date.now() - started;
      s.totalMs += ms;
      if (s.latencies.length < LATENCY_SAMPLE_CAP) s.latencies.push(ms);
      else s.latenciesDropped += 1;
    }
  };
}

/**
 * Wrap a viem transport so every LOGICAL request is counted, and so the HTTP
 * attempts it causes can be attributed back to it.
 */
export function metered(transport: Transport, target: RpcTarget): Transport {
  return ((opts) => {
    const inner = transport(opts);
    const m = meterFor(target);
    return {
      ...inner,
      async request(args: { method: string; params?: unknown }, reqOpts?: unknown) {
        const method = typeof args?.method === "string" ? args.method : "unknown";
        const s = statFor(m, method);
        const started = Date.now();
        m.calls += 1;
        s.calls += 1;
        m.inFlight += 1;
        if (m.inFlight > m.peakInFlight) m.peakInFlight = m.inFlight;
        const ctx: LogicalContext = {
          id: `${TENANT}-${(logicalSeq += 1).toString(36)}`,
          method,
          target,
          attempts: 0,
        };
        try {
          // FORWARDED UNTOUCHED, INCLUDING reqOpts. No retry, no queue, no
          // transformation of the result or of the error — a meter that changed
          // an outcome would be measuring itself. reqOpts carries
          // eth_sendUserOperation's retryCount: 0 and MUST survive.
          return await logicalContext.run(ctx, () =>
            (inner.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, reqOpts),
          );
        } catch (e) {
          m.errors += 1;
          s.errors += 1;
          const kind = classifyRpcError(e).kind;
          s.byKind[kind] = (s.byKind[kind] ?? 0) + 1;
          throw e;
        } finally {
          m.inFlight -= 1;
          const ms = Date.now() - started;
          s.totalMs += ms;
          if (ms > s.maxMs) s.maxMs = ms;
        }
      },
    };
  }) as Transport;
}

/**
 * ONE PLACE THAT BUILDS A COUNTED TRANSPORT.
 *
 * Both layers at once: `metered()` over the logical request, `meteredFetch()`
 * inside viem's retry loop over each HTTP attempt. Six sites used to write
 * `metered(http(url), "read")`, and three different hosts shared that one label;
 * passing the chain and the host through here is what makes a summary line
 * describe one endpoint instead of two.
 *
 * The URL's HOST is recorded, never the URL — Pimlico's carries an API key.
 */
export function countedHttp(url: string | undefined, label: string, chainId: number): Transport {
  const target: RpcTarget = { label, chainId, provider: providerOf(url) };
  return metered(http(url, { fetchFn: meteredFetch(target) }), target);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

/**
 * Two line kinds per target: what we asked for, and what the provider was sent.
 *
 * The key now carries label, chain and provider host, which is the conflation
 * fix — a line can no longer describe two endpoints at once.
 */
export function rpcSummaryLines(): string[] {
  const out: string[] = [];
  for (const m of meters.values()) {
    if (m.calls === 0) continue;
    const secs = Math.max(1, Math.round((Date.now() - m.since) / 1000));
    const top = [...m.byMethod.entries()]
      .sort((a, b) => b[1].calls - a[1].calls)
      .slice(0, 6)
      .map(([method, s]) => {
        const avg = Math.round(s.totalMs / Math.max(1, s.calls));
        const kinds = Object.entries(s.byKind)
          .map(([k, n]) => `${k}:${n}`)
          .join(",");
        return `${method} ${s.calls}${s.errors ? `/${s.errors}err` : ""} avg${avg}ms${kinds ? ` [${kinds}]` : ""}`;
      })
      .join(" · ");
    const rateLimited = [...m.byMethod.values()].reduce((n, s) => n + (s.byKind["rate-limited"] ?? 0), 0);
    out.push(
      `[rpc:${m.key}] tenant ${TENANT} · logical_rpc_calls ${m.calls} in ${secs}s ` +
        `(${(m.calls / secs).toFixed(2)}/s) · ${m.errors} err · ${rateLimited} rate-limited · ` +
        `peak concurrency ${m.peakInFlight} · ${top}`,
    );
  }
  for (const m of httpMeters.values()) {
    const attempts = [...m.byMethod.values()].reduce((n, s) => n + s.attempts, 0);
    if (attempts === 0) continue;
    const secs = Math.max(1, Math.round((Date.now() - m.since) / 1000));
    const retries = [...m.byMethod.values()].reduce((n, s) => n + s.retries, 0);
    const rateLimited = [...m.byMethod.values()].reduce((n, s) => n + s.rateLimited, 0);
    const transport = [...m.byMethod.values()].reduce((n, s) => n + s.transportErrors, 0);
    const statuses = new Map<number, number>();
    const all: number[] = [];
    for (const s of m.byMethod.values()) {
      for (const [code, n] of s.byStatus) statuses.set(code, (statuses.get(code) ?? 0) + n);
      all.push(...s.latencies);
    }
    all.sort((a, b) => a - b);
    const statusStr = [...statuses.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => `${code}:${n}`)
      .join(",");
    const top = [...m.byMethod.entries()]
      .sort((a, b) => b[1].attempts - a[1].attempts)
      .slice(0, 6)
      .map(([method, s]) => `${method} ${s.attempts}${s.retries ? `/+${s.retries}retry` : ""}`)
      .join(" · ");
    out.push(
      `[http:${m.key}] tenant ${TENANT} · provider_http_attempts ${attempts} in ${secs}s ` +
        `(${(attempts / secs).toFixed(2)}/s) · +${retries} retries · ${rateLimited} rate-limited · ` +
        `${transport} transport-err · statuses ${statusStr || "none"} · ` +
        `peak http concurrency ${m.peakInFlight} · p50 ${percentile(all, 50)}ms p95 ${percentile(all, 95)}ms ` +
        `max ${all.length ? all[all.length - 1] : 0}ms` +
        `${m.noContext ? ` · ${m.noContext} unattributed` : ""} · ${top}`,
    );
  }
  return out;
}

/**
 * Reset the counters after a summary so each line covers one window rather than
 * all of history. `peakInFlight` resets too — a high-water mark from an hour ago
 * says nothing about what a limiter needs to bound now.
 */
export function resetRpcMeters(): void {
  for (const m of meters.values()) {
    m.since = Date.now();
    m.calls = 0;
    m.errors = 0;
    m.peakInFlight = m.inFlight;
    m.byMethod.clear();
  }
  for (const m of httpMeters.values()) {
    m.since = Date.now();
    m.peakInFlight = m.inFlight;
    m.noContext = 0;
    m.byMethod.clear();
  }
}

/** Test seam. */
export function rpcMeterSnapshot(): {
  key: string;
  label: string;
  chainId: number;
  provider: string;
  calls: number;
  errors: number;
  peakInFlight: number;
}[] {
  return [...meters.values()].map((m) => ({
    key: m.key,
    label: m.target.label,
    chainId: m.target.chainId,
    provider: m.target.provider,
    calls: m.calls,
    errors: m.errors,
    peakInFlight: m.peakInFlight,
  }));
}

/** Test seam: the HTTP layer, which is the one that sees retries. */
export function httpMeterSnapshot(): {
  key: string;
  attempts: number;
  retries: number;
  rateLimited: number;
  transportErrors: number;
  peakInFlight: number;
  noContext: number;
  byStatus: Record<number, number>;
}[] {
  return [...httpMeters.values()].map((m) => {
    const byStatus: Record<number, number> = {};
    for (const s of m.byMethod.values()) for (const [c, n] of s.byStatus) byStatus[c] = (byStatus[c] ?? 0) + n;
    return {
      key: m.key,
      attempts: [...m.byMethod.values()].reduce((n, s) => n + s.attempts, 0),
      retries: [...m.byMethod.values()].reduce((n, s) => n + s.retries, 0),
      rateLimited: [...m.byMethod.values()].reduce((n, s) => n + s.rateLimited, 0),
      transportErrors: [...m.byMethod.values()].reduce((n, s) => n + s.transportErrors, 0),
      peakInFlight: m.peakInFlight,
      noContext: m.noContext,
      byStatus,
    };
  });
}

/** Test seam: forget every meter. */
export function resetRpcMetersForTest(): void {
  meters.clear();
  httpMeters.clear();
}
