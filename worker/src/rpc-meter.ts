/**
 * WHAT WE ACTUALLY ASK THE CHAIN FOR, COUNTED.
 *
 * Nothing in the worker has ever known. Every transport is `http()` with no
 * options, built at five separate sites, so there is no chokepoint — nowhere to
 * count, and nowhere to put a limiter later.
 *
 * The gap this leaves is not academic. In the logs no `eth_call` has EVER
 * appeared in a rate-limit line, because every quote helper catches and returns
 * `null`; the only 429s that get seen are the handful that escape a catch. So
 * roughly 95% of the traffic by count is invisible, and any limiter sized
 * against what the logs show would be sized against the wrong number.
 *
 * THIS CHANGES NO BEHAVIOUR. It does not queue, delay, retry, batch, dedupe or
 * refuse. It forwards every request untouched and records what happened. That
 * is deliberate: the fleet is currently in a restart storm of its own making,
 * and the whole point of measuring first is to size the limiter against a
 * healthy fleet rather than against the storm.
 *
 * It is also the seam. When the limiter arrives it goes here, and no call site
 * changes.
 */
import { http, type Transport } from "viem";
import { classifyRpcError, type RpcErrorKind } from "./rpc-error";
import { merrymenHome } from "./home";
import { clearCooldown, publishCooldown, readCooldown } from "./rpc-cooldown";
import {
  DEFAULT_LIMITS,
  adoptShared,
  begin,
  decide,
  end,
  freshState,
  shouldPublish,
} from "./rpc-governor";

interface MethodStat {
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  byKind: Partial<Record<RpcErrorKind, number>>;
}

interface Meter {
  label: string;
  since: number;
  calls: number;
  errors: number;
  inFlight: number;
  peakInFlight: number;
  byMethod: Map<string, MethodStat>;
}

const meters = new Map<string, Meter>();

function meterFor(label: string): Meter {
  let m = meters.get(label);
  if (!m) {
    m = { label, since: Date.now(), calls: 0, errors: 0, inFlight: 0, peakInFlight: 0, byMethod: new Map() };
    meters.set(label, m);
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

/**
 * Wrap a viem transport so every request is counted.
 *
 * `label` separates the read RPC from the bundler, because they are different
 * providers with different quotas and conflating them would hide which one is
 * under pressure.
 */
export function metered(transport: Transport, label: string): Transport {
  return ((opts) => {
    const inner = transport(opts);
    const m = meterFor(label);
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
        try {
          // FORWARDED UNTOUCHED. No retry, no queue, no transformation of the
          // result or of the error — a meter that changed an outcome would be
          // measuring itself.
          return await (inner.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, reqOpts);
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
 * HOW MANY LOGICAL CALLS TRAVEL IN ONE HTTP REQUEST.
 *
 * Kept small on purpose. The cap is not about the node's patience with long
 * bodies — it is that a batch fails as a unit: one 429 refuses every call
 * riding in it. Twenty keeps a refusal cheap while still collapsing a
 * multicall-shaped tick into a handful of requests.
 */
const BATCH_SIZE = 20;

/** How long to hold a request open for others to join it. */
const BATCH_WAIT_MS = 20;

/**
 * THE READ TRANSPORT FOR THIS CHAIN — the one place it is built.
 *
 * The header above says the limiter goes here, and the measurement it asked
 * for has now happened. From a hosted child, on 2026-09-06:
 *
 *   [rpc:read] 103 calls in 248s (0.42/s) · 81 err · 81 rate-limited ·
 *              peak concurrency 81 · eth_call 100/79err [rate-limited:79]
 *
 * and a tick that ends, over and over, "market unreadable — no trading this
 * tick". Thirty-two children, each holding its own `http()` with no options,
 * all pointed at one keyless public endpoint, all waking on the same cadence.
 * Nothing was wrong with the agents; they could not see the chain.
 *
 * The first fix is not a queue, it is BATCHING, because the traffic is already
 * the right shape for it: viem's `multicall` fans out per-token reads that are
 * issued together and awaited together, which is exactly the window a JSON-RPC
 * batch collects. Measured against rpc.mainnet.chain.robinhood.com the node
 * answers a batch correctly (three calls, three results, one request), and the
 * same tick then costs a handful of requests instead of eighty.
 *
 * WHAT THIS DOES NOT DO. It does not retry, dedupe, cache or reorder, and it
 * must not: the meter's own note is that a transport which changed an outcome
 * would be measuring itself. Batching changes how many HTTP requests carry the
 * calls, not which calls are made or what any of them returns.
 *
 * NOT FOR THE BUNDLER. `eth_sendUserOperation` lives under the send-edge rules
 * — persist the hash, send once, never re-send — and a batch that fails as a
 * unit is the wrong shape for an operation that must not be silently retried
 * alongside somebody else's read.
 */
export function chainRead(url: string | undefined, label = "read"): Transport {
  return governed(
    metered(
    http(url, {
      /**
       * ── THE AMPLIFIER, TURNED OFF ──────────────────────────────────────
       *
       * viem's `buildRequest` retries on status 429 — `shouldRetry` returns
       * true for it (utils/buildRequest.js:141) — and this options object never
       * set `retryCount`, so its default of 3 applied to every refusal. One
       * refused read became FOUR requests, issued 150ms, 300ms and 600ms after
       * the endpoint said stop, into the limiter that had just said it.
       *
       * The arithmetic is legible in production: refused calls averaged 1624ms
       * against 210ms for successful ones, which is one request plus that exact
       * ladder of waits.
       *
       * WHY ZERO RATHER THAN A SMALLER NUMBER. The http transport exposes
       * `retryCount` and `retryDelay` and NOT `shouldRetry`, so there is no
       * setting that keeps a retry for a network blip and drops it for a 429 —
       * and retrying a rate limit is the one thing that must not happen here.
       * The policy moves to rpc-governor.ts, which can tell the two apart, and
       * `getLogsAdaptive` keeps its own retry for the range walk it owns.
       *
       * This does not make the fleet ask for less. It stops it asking FOUR
       * TIMES for the thing it was already told it could not have.
       */
      retryCount: 0,
      batch: { wait: BATCH_WAIT_MS, batchSize: BATCH_SIZE },
      // ── A REFUSED BATCH MUST STILL SAY IT WAS REFUSED ──────────────────
      //
      // Batching cost the fleet its own error messages, and that was very
      // nearly worse than the rate limiting it fixed. Measured against
      // rpc.mainnet.chain.robinhood.com: a batch it will not serve comes back
      //
      //   HTTP 429  {"jsonrpc":"2.0","error":{"code":429,"message":"Too Many Requests"}}
      //
      // — a SINGLE object where the batch protocol says an array. viem indexes
      // the array it expected, finds undefined, and raises "An unknown RPC
      // error occurred. Details: Cannot read properties of undefined (reading
      // 'error')". The 429 is thrown away on the way past, so classifyRpcError
      // files it as `other`: unrecognised, not retryable, and indistinguishable
      // in a log from a bug in our own code. Measured: 460 refusals, 460 filed
      // as `other`, zero as rate-limited.
      //
      // The status is right here, before viem touches the body. Raising it as
      // an error keeps the one fact the fleet is steered by — with this hook,
      // the same 420 refusals classify as `rate-limited` again — and it costs
      // nothing on the single-request path, where viem raises the same thing
      // itself a moment later.
      onFetchResponse(response: Response) {
        if (!response.ok) {
          /**
           * ── AND THE HEADERS COME WITH IT, which they did not ──────────────
           *
           * This hook threw a PLAIN Error. viem re-wrapped it as an
           * HttpRequestError carrying no `status` and no `headers`, with two
           * consequences that pulled in opposite directions and were both bad:
           *
           *   `shouldRetry` fell through to its unconditional `return true`, so
           *   the refusal was retried on the catch-all rather than on the 429
           *   branch — retried harder than a recognised rate limit would have
           *   been; and
           *
           *   `classifyRpcError`'s `headerRetryAfter` had nothing to read, so
           *   NOTHING IN THIS SYSTEM HAS EVER HONOURED Retry-After. The
           *   endpoint has been telling us when to come back and the answer was
           *   discarded at this line.
           *
           * The status was always right here, before viem touched the body.
           * Carrying it and the headers onto the error costs nothing and makes
           * the endpoint's own back-pressure usable: rpc-governor.ts takes
           * `retryAfterMs` as a floor on its backoff and could never receive one.
           */
          const e = new Error(
            `HTTP request failed. Status: ${response.status}` +
              (response.status === 429 ? " Too Many Requests" : ""),
          ) as Error & { status?: number; headers?: Headers };
          e.status = response.status;
          e.headers = response.headers;
          throw e;
        }
      },
    }),
    label,
    ),
  );
}

/**
 * THE GOVERNOR, WRAPPED ROUND THE METER.
 *
 * Outside `metered` on purpose, so the meter still counts exactly what left this
 * process and a request the breaker refuses is NOT counted as a call we made —
 * it is a call we declined to make, and conflating the two would hide whether
 * the breaker is working.
 *
 * The decisions are rpc-governor.ts (pure); the clock, the randomness and the
 * shared file are here.
 */
function governed(transport: Transport): Transport {
  return ((opts) => {
    const inner = transport(opts);
    return {
      ...inner,
      async request(args: { method: string; params?: unknown }, reqOpts?: unknown) {
        await admit();
        let refused = false;
        let retryAfterMs: number | null = null;
        try {
          return await (inner.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, reqOpts);
        } catch (e) {
          const v = classifyRpcError(e);
          refused = v.kind === "rate-limited";
          retryAfterMs = v.retryAfterMs ?? null;
          throw e;
        } finally {
          state = end(state, Date.now(), LIMITS, { refused, retryAfterMs }, Math.random());
          if (refused) publishIfNew();
        }
      },
    };
  }) as Transport;
}

let state = freshState(Date.now());
const LIMITS = DEFAULT_LIMITS;
/** Last shared value read, and when — the file is polled, not watched. */
let sharedSeen: { until: number | null; at: number } = { until: null, at: 0 };
/** How stale a read of the shared file may be. A breaker measured in seconds does not need better. */
const SHARED_POLL_MS = 250;

function shared(now: number): number | null {
  if (now - sharedSeen.at < SHARED_POLL_MS) return sharedSeen.until;
  sharedSeen = { until: readCooldown(merrymenHome()), at: now };
  return sharedSeen.until;
}

function publishIfNew(): void {
  const s = shared(Date.now());
  if (!shouldPublish(state, s)) return;
  publishCooldown(merrymenHome(), state.coolUntil, process.env.MERRYMEN_HOME ?? "worker");
  sharedSeen = { until: state.coolUntil, at: Date.now() };
}

/**
 * Hold, or refuse, until this request may go.
 *
 * A REFUSAL THROWS RATHER THAN QUEUEING, and the distinction is the fix. "You
 * are going too fast" is a wait; "the endpoint told us to stop" is not
 * something waiting fixes, and holding the request would only reassemble the
 * burst a moment later. The error is shaped so `classifyRpcError` files it as
 * rate-limited, because that is what it is — and every read path above already
 * turns a failed read into `unread`, which is the honest rendering: we did not
 * ask, so we do not know. It must never become a zero.
 */
async function admit(): Promise<void> {
  for (;;) {
    const now = Date.now();
    state = adoptShared(state, shared(now), now, LIMITS);
    const d = decide(state, now, LIMITS);
    if (d.act === "send") {
      state = begin(state, now, LIMITS);
      return;
    }
    if (d.act === "refuse") {
      throw new Error(
        `Too Many Requests — not sent: the endpoint refused this process ${state.strikes} time(s) in a row, ` +
          `holding off ${Math.ceil(d.ms / 1000)}s. Asking again now is what caused it.`,
      );
    }
    await new Promise((r) => setTimeout(r, d.ms));
  }
}

/** Test seam: forget the governor's state between cases. */
export function resetGovernorForTest(): void {
  state = freshState(Date.now());
  sharedSeen = { until: null, at: 0 };
  // AND THE FILE, because the shared cooldown outlives the process. Forgetting
  // it here is what makes a test measure the transport rather than the previous
  // case's warning to the rest of the fleet — and finding that out is how the
  // cap in `adoptShared` came to exist.
  clearCooldown(merrymenHome());
}

/** One line per meter: totals, peak concurrency, and the busiest methods. */
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
      `[rpc:${m.label}] ${m.calls} calls in ${secs}s (${(m.calls / secs).toFixed(2)}/s) · ` +
        `${m.errors} err · ${rateLimited} rate-limited · peak concurrency ${m.peakInFlight} · ${top}`,
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
}

/** Test seam. */
export function rpcMeterSnapshot(): { label: string; calls: number; errors: number; peakInFlight: number }[] {
  return [...meters.values()].map((m) => ({
    label: m.label,
    calls: m.calls,
    errors: m.errors,
    peakInFlight: m.peakInFlight,
  }));
}

/** Test seam: forget every meter. */
export function resetRpcMetersForTest(): void {
  meters.clear();
}
