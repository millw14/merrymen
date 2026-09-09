/**
 * THE WEB SERVICE'S READ TRANSPORT — the one it never had.
 *
 * Twelve places in `web` built a bare `http()` and not one of them went through
 * a chokepoint. Two consequences, and the second is the one that hurt:
 *
 *   NOTHING BATCHED. A worker child's twenty logical calls ride in one HTTP
 *   request; web's eleven cost eleven. `/api/market` is two requests, and
 *   `App.tsx` runs `setInterval(refresh, 60_000)` in EVERY OPEN TAB, so the
 *   console alone was four unbatched requests per tab per minute, unbounded by
 *   anything, against the same keyless endpoint and the same egress IP the
 *   fleet reads.
 *
 *   AND NOTHING COUNTED IT. `rpcSummaryLines()` is only ever called from the
 *   worker, so no `[rpc:read]` line in any log has ever included a single web
 *   request. Every measurement of "what the fleet asks for" — including the
 *   11.2 calls/s this incident was sized against — excluded this service
 *   entirely.
 *
 * WHAT THIS SHARES WITH THE WORKER'S `chainRead`, and why it is a separate
 * file rather than an import: the policy is identical and deliberately so, but
 * the worker's version carries a filesystem-backed circuit breaker shared
 * between children in one container. `web` is a different container serving
 * user requests, so that breaker would neither see the fleet's cooldown nor be
 * seen by it, and a process-wide breaker in a request server turns one bad
 * minute into correlated failures on every page at once. The two halves that
 * are pure win — batching, and not retrying a refusal — are here.
 *
 * THE ONE THING IT MUST NOT DO is retry a 429. viem's `shouldRetry` returns
 * true for it and the http transport exposes no `shouldRetry` override, so the
 * only correct setting is `retryCount: 0`: a refusal answered with three more
 * requests at 150/300/600ms is what turned a 5% overshoot into a fleet-wide
 * outage on the worker side, and web was doing the same thing unmeasured.
 */
import { http, type Transport } from "viem";

/** Twenty logical calls in one request. A batch fails as a unit, so it stays small. */
const BATCH_SIZE = 20;
/** How long to hold a request open for others to join it. */
const BATCH_WAIT_MS = 20;

/**
 * A batched, non-retrying read transport.
 *
 * `url` is optional so a caller with nothing configured falls back to the
 * chain's declared endpoint, exactly as the bare `http()` calls did — this
 * changes how requests travel, never where they go.
 */
export function webChainRead(url?: string): Transport {
  return http(url, {
    retryCount: 0,
    batch: { wait: BATCH_WAIT_MS, batchSize: BATCH_SIZE },
    onFetchResponse(response: Response) {
      if (!response.ok) {
        /**
         * THE STATUS, CARRIED. A plain Error here is re-wrapped by viem with
         * no `status` and no `headers`, which is how a refused batch comes
         * back unrecognisable — the JSON-RPC batch protocol says an array and
         * a refusal is a single object, so viem indexes undefined and raises
         * "Cannot read properties of undefined". Keeping the status is what
         * lets a caller tell "the endpoint refused us" from "our code is
         * broken", and keeping the headers is what makes Retry-After readable
         * at all.
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
  });
}
