/**
 * Stable error codes for MCP tools and the OAuth/HTTP layer.
 *
 * Clients branch on `code`; `message` is for people and may change. A tool
 * never turns an infrastructure failure into an empty successful answer: it
 * returns `upstream_unavailable` (retryable) instead. Messages never carry a
 * tenant, token, key or raw provider error text.
 */

export const ERROR_CODES = {
  unauthenticated: { http: 401, retryable: false, what: "No valid access token. Reconnect the app." },
  insufficient_scope: { http: 403, retryable: false, what: "The connection was not granted the scope this needs." },
  forbidden: { http: 403, retryable: false, what: "This connection may not act on that object." },
  not_found: { http: 404, retryable: false, what: "No such object, or it is not yours." },
  invalid_input: { http: 400, retryable: false, what: "An argument is missing, malformed or out of range." },
  conflict: { http: 409, retryable: false, what: "The object changed or is in the wrong state for this." },
  expired: { http: 410, retryable: false, what: "The object expired." },
  rate_limited: { http: 429, retryable: true, what: "Too many requests. Retry after the given delay." },
  quota_exceeded: { http: 429, retryable: true, what: "A daily budget is used up. Retry after the given delay." },
  timeout: { http: 504, retryable: true, what: "The work did not finish in time. Retry shortly." },
  upstream_unavailable: { http: 503, retryable: true, what: "A data source or dependency is unavailable. Retry shortly." },
  unsupported: { http: 422, retryable: false, what: "Merrymen does not support this yet." },
  internal: { http: 500, retryable: true, what: "Unexpected server error." },
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class McpError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterSec: number | null;
  readonly details: Record<string, unknown> | undefined;
  constructor(code: ErrorCode, message?: string, opts: { retryAfterSec?: number; details?: Record<string, unknown> } = {}) {
    super(message ?? ERROR_CODES[code].what);
    this.name = "McpError";
    this.code = code;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.details = opts.details;
  }
  get retryable(): boolean {
    return ERROR_CODES[this.code].retryable;
  }
}

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    retry_after_s: number | null;
    details?: Record<string, unknown>;
    trace_id?: string;
  };
}

export function errorBody(e: McpError, traceId?: string): ErrorBody {
  return {
    error: {
      code: e.code,
      message: e.message,
      retryable: e.retryable,
      retry_after_s: e.retryAfterSec,
      ...(e.details ? { details: e.details } : {}),
      ...(traceId ? { trace_id: traceId } : {}),
    },
  };
}

/**
 * Postgres refusing a character in text it was handed: 22021
 * (character_not_in_repertoire, e.g. NUL in a TEXT value: 'invalid byte
 * sequence for encoding "UTF8": 0x00') and 22P05 (untranslatable_character,
 * e.g. an escaped NUL in jsonb). The same request fails the same way every
 * time, so it is the caller's input, never a retryable server fault.
 */
const PG_UNSTORABLE_TEXT = new Set(["22021", "22P05"]);

function sqlState(error: unknown): string | null {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : null;
}

/**
 * Anything thrown that is not an McpError becomes `internal`, with no text
 * from the original error — except a timeout, and Postgres refusing a
 * character it cannot store, which is `invalid_input` with Merrymen's own words.
 */
export function asMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new McpError("timeout");
  }
  const state = sqlState(error);
  if (state !== null && PG_UNSTORABLE_TEXT.has(state)) {
    return new McpError("invalid_input", "An argument holds a character Merrymen cannot store (such as NUL). Remove it and try again.");
  }
  return new McpError("internal");
}
