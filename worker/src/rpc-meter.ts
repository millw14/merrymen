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
import { DECLINED_MARKER, QUOTA_MARKER, classifyRpcError, saysQuotaExhausted, type RpcErrorKind } from "./rpc-error";
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
  type GovernorState,
} from "./rpc-governor";
import { PRIMARY_BUDGET_MS, endpointKey, failoverEndpoints, holdFor, transportUrl, verdictFor, type EndpointVerdict } from "./rpc-failover";

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
  const transport = metered(
    http(url, {
      /**
       * ── THE GOVERNOR SITS HERE, BELOW THE BATCHING, NOT ABOVE IT ────────
       *
       * The obvious place to put a limiter is around the transport's
       * `request`, and it is the wrong one. `request` is called once per
       * LOGICAL call, and the `batch` option below is what turns twenty of
       * those into one HTTP request — by collecting everything issued inside a
       * 20ms window. A limiter above that spaces logical calls out, so they
       * stop landing in the same window, so they stop batching: a tick's three
       * collapsed calls become three requests, and the limiter added to reduce
       * load multiplies it. Throttling would have made this worse in exactly
       * the units that matter.
       *
       * `fetchFn` is under the batcher. One call here is one HTTP request —
       * the same thing the endpoint counts — so the bucket, the concurrency
       * cap and the breaker are all denominated in the endpoint's own units,
       * and batching is untouched.
       *
       * A refused fetch fails a whole batch, which is what a real 429 already
       * does: this file's own note is that "a batch fails as a unit".
       */
      fetchFn: governedFetch,
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
      async onFetchResponse(response: Response) {
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
          /**
           * ── AND THE BODY IS READ FOR ONE FACT, which the status hides ─────
           *
           * A 429 is two different things. Measured 2026-09-29, the house
           * endpoint answered every request — at 0.2 calls a second, from any
           * IP — with HTTP 429 and "Monthly capacity limit exceeded". Throwing
           * away the body filed that as a rate limit, so the fleet spent a day
           * backing off a quota that backing off cannot refill, and its meter
           * pointed at the egress IP and the governor instead of at the plan.
           *
           * ONLY THE VERDICT IS CARRIED, NEVER THE BODY. A provider's response
           * is not ours to put in a log line, so the error gains a fixed marker
           * and nothing the provider wrote. A body that cannot be read changes
           * nothing: the status is still raised exactly as before.
           */
          // BOUNDED, and only for a 4xx: a spent quota is a client-error
          // answer, and a 5xx page is somebody else's HTML of any size. The
          // prefix reader stops at 4KB and cancels the stream, so an endless or
          // enormous body costs this process nothing (review on #201).
          const body = response.status >= 400 && response.status < 500 ? await bodyPrefix(response) : "";
          const quota = saysQuotaExhausted(body);
          const e = new Error(
            `HTTP request failed. Status: ${response.status}` +
              (response.status === 429 ? " Too Many Requests" : "") +
              (quota ? ` · ${QUOTA_MARKER}: the provider says this endpoint's quota for the period is spent` : ""),
          ) as Error & { status?: number; headers?: Headers };
          e.status = response.status;
          e.headers = response.headers;
          throw e;
        }
      },
    }),
    label,
  );
  /**
   * ── AND WHERE A READ MAY GO WHEN THE CONFIGURED ENDPOINT WILL NOT SERVE IT ──
   *
   * Registered here because this is the one place that knows which chain the
   * client is for: viem hands the transport the client's `chain`, and the
   * fallback is that chain's own default endpoint — never another chain's, and
   * never a URL from configuration. See rpc-failover.ts.
   */
  return ((opts: Parameters<Transport>[0]) => {
    const chainDefault = opts?.chain?.rpcUrls.default.http[0];
    const configured = url || chainDefault;
    if (configured) {
      // MERRYMEN_RPC_FAILOVER=off keeps every read on the configured endpoint —
      // the operator's escape hatch, and how a test models a chain that is
      // unreachable everywhere rather than just at one URL. Read when the client
      // is built, like the URL itself; children inherit it from the orchestrator.
      const off = /^(0|off|false|no)$/i.test(process.env.MERRYMEN_RPC_FAILOVER?.trim() ?? "");
      // viem normalizes URLs before fetching (including a root trailing slash)
      // and moves Basic credentials into a header. Register that same URL.
      const primary = transportUrl(configured);
      const next = off ? [primary] : failoverEndpoints(primary, chainDefault && transportUrl(chainDefault));
      const prior = routes.get(primary);
      // ONE URL, TWO CHAINS is a misconfiguration, and its fallback would be
      // whichever chain registered last. Ambiguity gets no fallback at all —
      // the configured endpoint alone, which is where this began.
      routes.set(primary, prior && prior.join("\n") !== next.join("\n") ? [primary] : next);
    }
    return transport(opts);
  }) as Transport;
}

/**
 * ONE HTTP REQUEST, GOVERNED — AND SENT WHERE IT WILL BE SERVED.
 *
 * The decisions are rpc-governor.ts and rpc-failover.ts (pure); the clock, the
 * randomness and the shared file are here. This is the fetch viem calls once
 * per HTTP request — after batching — so everything it counts is denominated in
 * the endpoint's own units rather than in logical calls.
 *
 * THE STATUS IS READ HERE RATHER THAN FROM A THROWN ERROR. At this point the
 * Response has not been through viem, so a 429 is unambiguous and its
 * Retry-After is readable. The response is then returned untouched and
 * `onFetchResponse` above raises it exactly as before — this observes, it does
 * not change what any caller sees.
 *
 * FAILOVER, 2026-09-30. The configured endpoint's monthly quota ran out on
 * 2026-09-28 and every child was blind for days while the chain's own public
 * endpoint served normally. So a request the configured endpoint will not
 * serve — quota spent, key refused, rate-limited, 5xx, unreachable, too slow —
 * is sent to the chain's public endpoint instead (rpc-failover.ts says which,
 * and why only that one). Each endpoint has its own governor and its own shared
 * breaker file, so one refusing never stops the fleet asking the other.
 *
 * A REQUEST IS SENT TO AN ENDPOINT AT MOST ONCE. Moving a refused request to a
 * DIFFERENT endpoint is the point; sending it back into the one that refused
 * is the amplifier this module was written to remove, and nothing here does.
 * With one endpoint — no house RPC configured — this is exactly the governed
 * fetch it replaced.
 */
async function governedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const route = routes.get(url) ?? [url];
  for (let i = 0; i < route.length; i++) {
    const ep = endpointFor(route[i]!);
    const last = i === route.length - 1;
    // THE LAST ENDPOINT IS NEVER SKIPPED. With nowhere else to go, asking is
    // the only way to find out it has recovered — and it is what one endpoint
    // alone always did.
    if (!last && ep.downUntil > Date.now()) continue;
    // A breaker that is open on an endpoint with somewhere else to go is a
    // reason to go there, not a refusal. On the last one it declines, as before.
    if (!(await admit(ep, !last))) continue;
    let refused = false;
    let retryAfterMs: number | null = null;
    let verdict: EndpointVerdict = "answer";
    let res: Response | null = null;
    let failure: unknown = null;
    try {
      // Credentials describe the configured provider, never the public RPC.
      const headers = new Headers(init?.headers);
      if (i > 0) {
        headers.delete("authorization");
        headers.delete("proxy-authorization");
        headers.delete("cookie");
      }
      res = await fetch(ep.url, { ...init, headers, ...(i > 0 ? { credentials: "omit" as const } : {}), signal: last ? init?.signal : budgeted(init?.signal) });
      if (res.status === 429 || res.status === 503) {
        refused = true;
        retryAfterMs = retryAfterFrom(res.headers.get("retry-after"));
      }
      // The body is read for one fact, and only when the status says there is
      // one to find. It never leaves this line: see rpc-failover's verdictFor.
      // Bounded, and 4xx only — see `bodyPrefix`. The CLONE is read, so the
      // response viem receives is untouched.
      if (!res.ok) verdict = verdictFor(res.status, res.status >= 400 && res.status < 500 ? await bodyPrefix(res.clone()) : "");
    } catch (e) {
      failure = e;
      verdict = "error";
    } finally {
      ep.state = end(ep.state, Date.now(), LIMITS, { refused, retryAfterMs }, Math.random());
      if (refused) publishIfNew(ep);
    }
    if (res === null) {
      // viem's own deadline passed: the request is over, wherever it would go.
      if (last || init?.signal?.aborted) throw failure;
      markDown(ep, i, "error", "unreachable or too slow");
      continue;
    }
    if (verdict === "answer" || last) {
      if (i > 0) failover.served += 1;
      else if (verdict === "answer" && res.ok) markUp(ep);
      return res;
    }
    // Refused, down or broken, with somewhere else to go: this request moves on
    // — and lets go of the answer it is not using, or its connection stays
    // tied up until the collector gets round to it.
    discard(res);
    if (holdFor(verdict) > 0) markDown(ep, i, verdict, verdict === "down" ? downReason(res.status) : `HTTP ${res.status}`);
  }
  // Unreachable: the last endpoint always returns or throws.
  throw new Error(`${DECLINED_MARKER}: not sent — no endpoint to send it to`);
}

/** The configured endpoint's share of viem's deadline, when there is a fallback to hand the rest to. */
function budgeted(signal: AbortSignal | null | undefined): AbortSignal {
  const own = AbortSignal.timeout(PRIMARY_BUDGET_MS);
  return signal ? AbortSignal.any([signal, own]) : own;
}

function downReason(status: number): string {
  if (status === 401 || status === 402 || status === 403) return `the provider refused the key or the bill (HTTP ${status})`;
  return "its quota for the period is spent";
}

/** `Retry-After` as milliseconds: seconds, or an HTTP date. Null when absent or unusable. */
function retryAfterFrom(v: string | null): number | null {
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 300_000);
  const at = Date.parse(v);
  if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), 300_000));
  return null;
}

/** Release a response nobody will read. Never throws. */
function discard(res: Response): void {
  void res.body?.cancel().catch(() => {});
}

/** How much of a refusal's body is ever read. The phrase that matters is in the first line. */
const BODY_PREFIX_BYTES = 4096;

/**
 * AT MOST THE FIRST FEW KILOBYTES OF A BODY, then the stream is cancelled.
 *
 * `response.text()` buffers and decodes the WHOLE body before anything can
 * slice it, so an endless error stream or a decompression bomb from any
 * configured endpoint could hold this process's memory hostage. This reads
 * chunk by chunk and stops once it has enough. Never throws: a body that cannot
 * be read says nothing, and the status is still raised as before.
 */
async function bodyPrefix(res: Response, max = BODY_PREFIX_BYTES): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      n += value.byteLength;
    }
  } catch {
    /* unreadable says nothing */
  } finally {
    void reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(Math.min(n, max));
  let at = 0;
  for (const c of chunks) {
    if (at >= all.length) break;
    const take = c.subarray(0, all.length - at);
    all.set(take, at);
    at += take.length;
  }
  return new TextDecoder().decode(all);
}

/** One endpoint a read may go to, and everything this process knows about it. */
interface Endpoint {
  url: string;
  /** rpc-failover's `endpointKey`: the only name for it that is ever written down. */
  key: string;
  state: GovernorState;
  /** Last shared value read, and when — the file is polled, not watched. */
  sharedSeen: { until: number | null; at: number };
  /** Skipped, while another endpoint can serve, until then. */
  downUntil: number;
  /** When it went down, while it is still down — so a long outage is reported once, not every probe. */
  downSince: number | null;
  /** Why, in words safe to log. */
  downWhy: string | null;
}

const LIMITS = DEFAULT_LIMITS;
/** How stale a read of the shared file may be. A breaker measured in seconds does not need better. */
const SHARED_POLL_MS = 250;
const endpoints = new Map<string, Endpoint>();
/**
 * The URL a client was built with → every endpoint its reads may use, in order.
 * Filled by `chainRead`, which is the only place that knows the client's chain.
 */
const routes = new Map<string, string[]>();
/** HTTP requests a fallback served since the last summary. */
const failover = { served: 0, since: Date.now() };

function endpointFor(url: string): Endpoint {
  let ep = endpoints.get(url);
  if (!ep) {
    ep = { url, key: endpointKey(url), state: freshState(Date.now()), sharedSeen: { until: null, at: 0 }, downUntil: 0, downSince: null, downWhy: null };
    endpoints.set(url, ep);
  }
  return ep;
}

/**
 * Take this endpoint out of rotation for a while, and say so ONCE per outage.
 *
 * Never the URL — it carries an API key — and never the provider's words.
 * Position in the route is what an operator needs: the configured endpoint,
 * or a fallback.
 */
function markDown(ep: Endpoint, position: number, verdict: EndpointVerdict, why: string): void {
  const now = Date.now();
  ep.downUntil = Math.max(ep.downUntil, now + holdFor(verdict));
  ep.downWhy = why;
  if (ep.downSince !== null) return;
  ep.downSince = now;
  const who = position === 0 ? "the configured read RPC" : `read fallback #${position}`;
  console.warn(
    `[rpc] ${who} is unavailable (${why}) — reading from the chain's public RPC instead; ` +
      `asking it again in ${Math.round(holdFor(verdict) / 1000)}s`,
  );
}

function markUp(ep: Endpoint): void {
  if (ep.downSince === null) return;
  const mins = Math.max(1, Math.round((Date.now() - ep.downSince) / 60_000));
  ep.downSince = null;
  ep.downWhy = null;
  ep.downUntil = 0;
  console.warn(`[rpc] the configured read RPC is answering again after ~${mins}m — reads are back on it`);
}

function shared(ep: Endpoint, now: number): number | null {
  if (now - ep.sharedSeen.at < SHARED_POLL_MS) return ep.sharedSeen.until;
  ep.sharedSeen = { until: readCooldown(merrymenHome(), ep.key), at: now };
  return ep.sharedSeen.until;
}

function publishIfNew(ep: Endpoint): void {
  const s = shared(ep, Date.now());
  if (!shouldPublish(ep.state, s)) return;
  publishCooldown(merrymenHome(), ep.state.coolUntil, process.env.MERRYMEN_HOME ?? "worker", ep.key);
  ep.sharedSeen = { until: ep.state.coolUntil, at: Date.now() };
}

/**
 * Hold, or refuse, until this request may go to this endpoint.
 *
 * A REFUSAL THROWS RATHER THAN QUEUEING, and the distinction is the fix. "You
 * are going too fast" is a wait; "the endpoint told us to stop" is not
 * something waiting fixes, and holding the request would only reassemble the
 * burst a moment later. The error is shaped so `classifyRpcError` files it as
 * declined, because that is what it is — and every read path above already
 * turns a failed read into `unread`, which is the honest rendering: we did not
 * ask, so we do not know. It must never become a zero.
 *
 * `canSkip`: there is another endpoint to try. Then an open breaker answers
 * false — go there — instead of declining the request outright.
 */
async function admit(ep: Endpoint, canSkip: boolean): Promise<boolean> {
  for (;;) {
    const now = Date.now();
    ep.state = adoptShared(ep.state, shared(ep, now), now, LIMITS);
    const d = decide(ep.state, now, LIMITS);
    if (d.act === "send") {
      ep.state = begin(ep.state, now, LIMITS);
      return true;
    }
    if (d.act === "refuse") {
      if (canSkip) return false;
      // THE MARKER, NOT THE WORDS. This message used to say "Too Many
      // Requests", so `classifyRpcError` filed every request the breaker
      // declined as one the ENDPOINT had refused. The meter then reported 93%
      // rate-limited windows while the endpoint, measured at the same moment,
      // was serving 50/s cleanly — a limiter blaming the upstream for its own
      // caution, which is untunable because every symptom points away from it.
      throw new Error(
        `${DECLINED_MARKER}: not sent — the endpoint refused this process ${ep.state.strikes} time(s) ` +
          `in a row, holding off ${d.ms}ms. Asking again now is what caused it.`,
      );
    }
    await new Promise((r) => setTimeout(r, d.ms));
  }
}

/** Test seam: forget the governor's state between cases. */
export function resetGovernorForTest(): void {
  // AND THE FILES, because the shared cooldown outlives the process. Forgetting
  // them here is what makes a test measure the transport rather than the
  // previous case's warning to the rest of the fleet — and finding that out is
  // how the cap in `adoptShared` came to exist.
  const urls = new Set<string>([...endpoints.keys(), ...[...routes.values()].flat()]);
  for (const u of urls) clearCooldown(merrymenHome(), endpointKey(u));
  clearCooldown(merrymenHome());
  endpoints.clear();
  // Routes too: they are registered when a client is built, so a case builds
  // its clients after this — and must not inherit a previous case's route.
  routes.clear();
  failover.served = 0;
  failover.since = Date.now();
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
    const quota = [...m.byMethod.values()].reduce((n, s) => n + (s.byKind["quota-exhausted"] ?? 0), 0);
    out.push(
      `[rpc:${m.label}] ${m.calls} calls in ${secs}s (${(m.calls / secs).toFixed(2)}/s) · ` +
        `${m.errors} err · ${rateLimited} rate-limited · peak concurrency ${m.peakInFlight} · ${top}` +
        // IN WORDS, on the line an operator already reads. The bracketed kind is
        // easy to scroll past, and the day this was written it was scrolled past
        // as "rate-limited" by everyone who looked. The remedy is not in this
        // process, so the line names who has it.
        (quota > 0
          ? ` · PROVIDER QUOTA EXHAUSTED: the read endpoint says its allowance for the period is spent; ` +
            `backing off will not bring reads back — raise the provider's plan or point the read RPC elsewhere`
          : ""),
    );
  }
  // FAILOVER IS NOT SILENT. Once the fallback answers, callers see successful
  // reads and the quota line above never fires — so the fleet could run on the
  // chain's public endpoint for a month with nobody knowing the house one had
  // stopped. This line is how they find out, every window it is happening.
  if (failover.served > 0) {
    const secs = Math.max(1, Math.round((Date.now() - failover.since) / 1000));
    const why = [...endpoints.values()].map((e) => e.downWhy).find((w): w is string => !!w);
    out.push(
      `[rpc:failover] ${failover.served} request(s) in ${secs}s served by the chain's public RPC` +
        (why ? ` — the configured read RPC is unavailable: ${why}` : " — the configured read RPC refused or failed them"),
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
  failover.served = 0;
  failover.since = Date.now();
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
