/**
 * WHAT WENT WRONG, AND WHOSE FAULT IT IS.
 *
 * merrymen's whole doctrine is that "we could not read" must never render as
 * "there is nothing there". Every module that gets this right — `delivery.ts`
 * on a balance, `read-candles.ts` on a chart, `recover.ts` on a token, the
 * three-way policy-contract probe in `index.ts` — reaches the same shape: a
 * closed union with a distinct arm for the failure to ask, never a sentinel.
 *
 * On the RPC path that shape was missing, and the cost was measured. Every
 * quote helper catches and returns `null`, so an HTTP 429 and a pool that does
 * not exist produce the identical value; the worker then books `no-route` and
 * the public feed publishes "no route to trade it" — a claim about the chain,
 * manufactured out of our own rate limit. And `getLogsAdaptive` read every
 * failure as "block range too large", halving its span on a 429 until it was
 * asking one block at a time, then STEPPING OVER that block.
 *
 * This is the classifier those paths need. It is pure, it does not throw, and
 * it mirrors the vocabulary the repo already uses everywhere else — a `kind`
 * from a closed union of string literals plus the one bit callers actually
 * branch on, `retryable`, which `revert.ts` established.
 *
 * STAGE A USES IT IN EXACTLY ONE PLACE: `getLogsAdaptive`. Rewiring the quote
 * helpers onto it is deliberately a separate change, because altering what a
 * 429 MEANS at the same time as altering how often we make requests would make
 * the fleet measurement that follows uninterpretable.
 */

export type RpcErrorKind =
  /** The provider refused because we asked too often. Ours to fix, not the chain's. */
  | "rate-limited"
  /** The request timed out or the socket died. Says nothing about the answer. */
  | "timeout"
  /** DNS, TLS, connection refused — the provider was not reachable at all. */
  | "transport"
  /** The provider will answer, but not for a window this wide. A real hint. */
  | "range-too-large"
  /** The contract itself reverted. This IS an answer, and usually a business one. */
  | "reverted"
  /** Classified as nothing. Treated as NOT retryable — see below. */
  | "other";

export interface RpcErrorVerdict {
  kind: RpcErrorKind;
  /**
   * Is asking again, unchanged, a reasonable thing to do?
   *
   * FALSE FOR `other`, deliberately. An unrecognised failure retried forever is
   * how a rate limit became eleven million requests; an unrecognised failure
   * surfaced once is a bug report. When in doubt, stop.
   */
  retryable: boolean;
  /** Milliseconds the provider asked us to wait, when it said so. */
  retryAfterMs?: number;
  /** The original text, bounded, for a log line a person will read. */
  detail: string;
}

/** `Retry-After` is seconds, or an HTTP date. Returns ms, or undefined. */
function retryAfterMs(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw * 1000;
  if (typeof raw !== "string") return undefined;
  const secs = Number(raw.trim());
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/** Pull a `Retry-After` out of whatever shape the error carries it in. */
function headerRetryAfter(e: unknown): number | undefined {
  const o = e as { headers?: unknown; response?: { headers?: unknown } } | null;
  for (const h of [o?.headers, o?.response?.headers]) {
    if (!h) continue;
    // A real Headers object, or a plain record.
    const get = (h as { get?: (k: string) => string | null }).get;
    if (typeof get === "function") {
      const v = get.call(h, "retry-after");
      const ms = retryAfterMs(v);
      if (ms !== undefined) return ms;
      continue;
    }
    const rec = h as Record<string, unknown>;
    const ms = retryAfterMs(rec["retry-after"] ?? rec["Retry-After"]);
    if (ms !== undefined) return ms;
  }
  return undefined;
}

/**
 * Classify a caught RPC failure.
 *
 * Matches on TEXT as well as on codes, because the shape that actually arrives
 * from this chain is a viem `RpcRequestError` whose JSON-RPC body says
 * `Rate Limit Hit, limit will reset in 60 seconds` — there is no HTTP status on
 * it at all, so a status-only classifier would miss every real case.
 */
export function classifyRpcError(e: unknown): RpcErrorVerdict {
  const err = e as { name?: string; message?: string; details?: string; shortMessage?: string; code?: unknown; status?: unknown; cause?: unknown } | null;
  const text = [err?.message, err?.details, err?.shortMessage, err?.name]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  const lower = text.toLowerCase();
  const detail = text.replace(/\s+/g, " ").trim().slice(0, 200) || "no message";

  const codes: unknown[] = [err?.code, err?.status, (err?.cause as { code?: unknown } | null)?.code, (err?.cause as { status?: unknown } | null)?.status];
  const is = (n: number) => codes.some((c) => c === n || c === String(n));

  // ── rate limited ──────────────────────────────────────────────────────
  // Checked FIRST. A 429 can also mention "limit", and reading it as a range
  // hint is the exact bug this module was written to end.
  if (is(429) || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { kind: "rate-limited", retryable: true, retryAfterMs: headerRetryAfter(e), detail };
  }

  // ── range too large ───────────────────────────────────────────────────
  // A genuine hint about the QUESTION, not about our rate. Narrowing helps.
  if (
    lower.includes("block range") ||
    lower.includes("range too large") ||
    lower.includes("too many blocks") ||
    lower.includes("query returned more than") ||
    lower.includes("log response size exceeded") ||
    lower.includes("exceeds the limit")
  ) {
    return { kind: "range-too-large", retryable: false, detail };
  }

  // ── reverted ──────────────────────────────────────────────────────────
  // The chain answered. Retrying an identical call gets an identical revert.
  if (
    lower.includes("execution reverted") ||
    lower.includes("reverted with") ||
    err?.name === "ContractFunctionRevertedError" ||
    err?.name === "CallExecutionError"
  ) {
    return { kind: "reverted", retryable: false, detail };
  }

  // ── timeout ───────────────────────────────────────────────────────────
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    err?.name === "TimeoutError" ||
    err?.name === "AbortError" ||
    is(408)
  ) {
    return { kind: "timeout", retryable: true, retryAfterMs: headerRetryAfter(e), detail };
  }

  // ── transport ─────────────────────────────────────────────────────────
  if (
    lower.includes("fetch failed") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("enotfound") ||
    lower.includes("socket hang up") ||
    lower.includes("network") ||
    err?.name === "HttpRequestError" ||
    is(502) ||
    is(503) ||
    is(504)
  ) {
    return { kind: "transport", retryable: true, retryAfterMs: headerRetryAfter(e), detail };
  }

  return { kind: "other", retryable: false, detail };
}

/** Base delay for the nth retry (0-indexed), exponential and jittered. */
export function backoffMs(attempt: number, baseMs = 500, capMs = 30_000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  // FULL jitter, not a ±10% wobble. The failure being spread here is a fleet of
  // agents that were rate-limited by the same provider at the same instant, so
  // they must not come back in step either.
  return Math.floor(Math.random() * exp);
}
