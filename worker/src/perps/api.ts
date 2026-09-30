/**
 * THE LIGHTER REST CLIENT — every request to api.rh.lighter.xyz, bounded in
 * size, time, rate and meaning.
 *
 * docs/perps.md ("api.ts" under Worker, the venue table's rate-limit row) is
 * the contract. What this file adds to a plain fetch, and why each exists:
 *
 *   BOUNDED READS   readBoundedJson with a byte cap. The venue is a third
 *                   party and this is a long-lived process holding a key.
 *   A DEADLINE      AbortSignal.timeout on the request AND the body (default
 *                   5 s). A read that hangs holds the perp lane's lock, and
 *                   the protective loop waits behind it.
 *   NO REDIRECTS    `redirect: "error"`. An auth token in a header must never
 *                   follow a Location somewhere else.
 *   A TAXONOMY      failed ≠ empty (rule 11). Every outcome is a value, and
 *                   every failure says which kind — because the callers do
 *                   different things with each (below).
 *   A FLEET BRAKE   429 OR 405 (Lighter signals a rate limit with both, and
 *                   sends no rate headers) publishes a ≥ 60 s cooldown file
 *                   every process in the container reads — the rpc-cooldown.ts
 *                   pattern — because a firewall block is per egress IP and
 *                   every child sits behind the same one.
 *   A BUDGET        a client-side rolling-minute budget per L1 address (60/min
 *                   by default, the Standard tier), of which the last 20 are
 *                   usable only by requests flagged `exit: true`. Opens and
 *                   routine reads can never spend the budget a close needs.
 *   ONE IDENTITY    a client is keyed on an L1 address OR on "public", and
 *                   every request it sends counts where its budget does. The
 *                   venue counts an UNAUTHENTICATED request against the IP as
 *                   well as the address, and every hosted child sits behind
 *                   one egress IP: children each staying under 60/min for
 *                   their own address can still sum past the IP's 60/min, and
 *                   the firewall block that follows stops every tenant's
 *                   opens and exits for 60 s. So an address-keyed client
 *                   sends NOTHING unauthenticated ("clients can authenticate
 *                   each request so that only L1-based rate limits apply" —
 *                   the venue's rate-limit page) except sendTx, which the
 *                   venue counts per L1 address only, never per IP. The
 *                   "public" client (the one market-data feed) never carries
 *                   a token and never sends a tx: its budget IS the IP's.
 *
 * WHAT THE ERROR KINDS MEAN TO A CALLER:
 *
 *   rate-limited  not sent (our budget or the fleet cooldown) or refused by
 *                 the venue's limiter. Nothing happened; try later.
 *   not-found     ONLY /tx answering HTTP 400 with venue code 21500. The one
 *                 answer rule 9 may count toward writing a row off as expired.
 *   rejected      READS ONLY: the venue read the request and said no (4xx
 *                 with a venue code, or a venue error code in a 200).
 *   refused-send  SENDTX ONLY, and it RESOLVES NOTHING. The venue refused
 *                 this attempt — but that is not evidence the tx is dead.
 *                 On a first send an API-level refusal leaves the nonce free;
 *                 on a re-send of persisted bytes (rule 9) whose first send
 *                 timed out and was then executed, the venue refuses the
 *                 duplicate too (21104 invalid nonce — SkipNonce needs new >
 *                 old; 21728 client order index exists). Reading either as
 *                 "the nonce is free" would mark an executed open dead and
 *                 sign a second one beside it. So the row stays `submitted`
 *                 and is resolved ONLY by /tx by hash; `maybeExecuted` flags
 *                 the codes that say so outright. There is deliberately no
 *                 `rejected` in sendTx's error type, so no caller can branch
 *                 on one.
 *   unavailable   5xx, network, timeout, redirect, or a 4xx with no venue
 *                 code. WE DO NOT KNOW what happened — for sendTx the row
 *                 stays `submitted` and is resolved by hash, never re-signed.
 *   malformed     an answer arrived and did not parse. Same as unavailable for
 *                 sendTx; for reads it is unread, never empty.
 *
 * sendTx IS NEVER RETRIED HERE. Nothing is, but sendTx is the one where it
 * matters: a retry of the same bytes is harmless only if the caller knows it
 * happened, and a retry decision belongs to the rule-9 row, not to a
 * transport.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LIGHTER_ROUTE_V1 } from "../../../packages/core/src/index";
import { readBoundedJson } from "../bounded-read";
import {
  parseAccount,
  parseAccountsByL1Address,
  parseApiKeys,
  parseDepth,
  parseFundings,
  parseMarkCandles,
  parseNextNonce,
  parseOrderBookDetails,
  parseOrderBooks,
  parseOrders,
  parsePositionFunding,
  parseSendTx,
  parseTrades,
  parseTx,
  parseWithdrawalDelay,
  parseWithdrawHistory,
  type ApiKeyRead,
  type DepthRead,
  type FundingRow,
  type L1Accounts,
  type MarkCandle,
  type OrderBookDetailsRead,
  type OrderBookListing,
  type PerpAccountRead,
  type PerpDecimals,
  type PerpTrade,
  type PositionFundingRow,
  type TxRead,
  type VenueOrder,
  type WithdrawHistoryRow,
} from "./markets";

// ── transport ───────────────────────────────────────────────────────────────

/**
 * The slice of fetch this client uses, injectable for tests (the rialto.ts
 * pattern, widened to POST, a signal and the redirect policy). The response
 * side is what bounded-read.ts needs: headers for content-length and the
 * Date, a stream when there is one, text() when there is not.
 */
export type LighterFetch = (
  url: string,
  init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect: "error";
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body?: unknown;
  text(): Promise<string>;
}>;

export type LighterApiError =
  | { kind: "rate-limited"; source: "venue" | "cooldown" | "budget"; status: number | null; retryAfterMs: number; retryable: true; detail: string }
  | { kind: "not-found"; status: 400; code: 21500; retryable: false; detail: string }
  | { kind: "rejected"; status: number; code: number | null; retryable: false; detail: string; marketId?: number }
  | { kind: "unavailable"; status: number | null; retryable: true; detail: string }
  | { kind: "malformed"; status: number | null; retryable: true; detail: string };

/**
 * What sendTx can answer besides a receipt: never `rejected`, never
 * `not-found` (see the taxonomy above). A refusal is an attempt refused, not
 * a row resolved.
 */
export type SendTxError =
  | {
      kind: "refused-send";
      status: number;
      code: number | null;
      retryable: false;
      /** The venue's code says an earlier send of these bytes may already have executed (21104, 21728). */
      maybeExecuted: boolean;
      detail: string;
    }
  | Extract<LighterApiError, { kind: "rate-limited" | "unavailable" | "malformed" }>;

export interface SendTxReceipt {
  txHash: string;
  predictedExecutionMs: number | null;
  volumeQuotaRemaining: number | null;
}

export type LighterResult<T, E = LighterApiError> =
  | {
      ok: true;
      value: T;
      /**
       * The venue's Date header, ms (second precision), or null. Rule 9 writes
       * a not-found row off only with a measured skew under 5 s; this is the
       * measurement.
       */
      serverDateMs: number | null;
    }
  | { ok: false; error: E; serverDateMs: number | null };

/** A caller bug (bad market id, limit, token shape). Thrown before anything is sent. */
export class LighterApiArgumentError extends Error {
  override readonly name = "LighterApiArgumentError";
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`lighter api: ${field} ${message}`);
  }
}

export interface RequestFlags {
  /**
   * This request serves an exit (a close, protective read, stand-down,
   * withdrawal or claim). It may spend the reserved end of the budget and is
   * still attempted while the fleet cooldown stands — a stop resting at the
   * venue is the protection during a block, but a close is worth one try.
   */
  exit?: boolean;
  /**
   * Auth token from the signer's createAuthToken. Sent ONLY as the
   * Authorization header (never the `auth` query parameter, which lands in
   * access logs), never logged, never in an error.
   */
  auth?: string;
}

export interface LighterApiOptions {
  /** MERRYMEN_HOME; the cooldown file lives under MERRYMEN_FLEET_HOME when set, else here. */
  home: string;
  /** The identity the venue counts this client's requests against: the L1 address (lowercase), or "public" for unauthenticated feed reads. */
  budgetKey: string;
  fetchFn?: LighterFetch;
  baseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
  budgetPerMinute?: number;
  exitReservePerMinute?: number;
  /** ≥ 60 s; the venue's firewall block is a static 60 s. */
  cooldownMs?: number;
  now?: () => number;
}

export const LIGHTER_API_DEFAULTS = Object.freeze({
  timeoutMs: 5_000,
  /** The largest real answer is orderBookDetails?filter=all, ~100 KB; ten times that. */
  maxBytes: 1_000_000,
  budgetPerMinute: 60,
  exitReservePerMinute: 20,
  cooldownMs: 60_000,
});

/** A cooldown file claiming more than this is treated as corrupt, not obeyed. */
const MAX_ADOPTED_COOLDOWN_MS = 10 * 60_000;
/** Venue body code for "Too Many Requests!" — a rate limit, whatever the HTTP status. */
const VENUE_TOO_MANY_REQUESTS = 23000;
/** Venue body code for "transaction not found". */
const VENUE_TX_NOT_FOUND = 21500;
/** "<deadline>:<account>:<keyIndex>:<160 hex>" as the signer mints it. */
const AUTH_RE = /^\d{9,11}:\d{1,16}:\d{1,3}:[0-9a-f]{160}$/;
/**
 * sendTx refusals that an earlier send of the SAME bytes having executed
 * would also produce: invalid nonce (SkipNonce: a nonce ≥ this one already
 * executed on the key) and client order index already exists.
 */
const SEND_TX_MAYBE_EXECUTED: ReadonlySet<number> = new Set([21104, 21728]);
/** The budget key of the one unauthenticated (market-data) client. */
const PUBLIC_BUDGET_KEY = "public";

// ── the fleet cooldown file ─────────────────────────────────────────────────

/**
 * Where the shared Lighter cooldown lives: the FLEET home when the
 * orchestrator set one (a child's own home is private to it, and a breaker
 * only it can see is no fleet breaker), else this process's home.
 */
export function lighterCooldownFile(home: string): string {
  const fleet = process.env.MERRYMEN_FLEET_HOME?.trim();
  return path.join(fleet && fleet.length > 0 ? fleet : home, "lighter-cooldown.json");
}

/**
 * The shared cooldown's end (ms), or null. Null for every failure — no advice
 * means per-process behaviour, never "resume"; and a value implausibly far in
 * the future is a corrupt file, not an instruction to stop trading for a day.
 */
export function readLighterCooldown(home: string, nowMs: number = Date.now()): number | null {
  try {
    const j = JSON.parse(readFileSync(lighterCooldownFile(home), "utf8")) as { until?: unknown };
    const until = typeof j.until === "number" && Number.isFinite(j.until) ? j.until : null;
    if (until === null || until - nowMs > MAX_ADOPTED_COOLDOWN_MS) return null;
    return until;
  } catch {
    return null;
  }
}

/** Publish a cooldown (write-then-rename, best effort — the caller's own brake is already set). */
export function publishLighterCooldown(home: string, until: number, by: string): void {
  try {
    const file = lighterCooldownFile(home);
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ until, at: Date.now(), by }), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    /* advisory only */
  }
}

/** Remove the shared cooldown. Test seam and operator escape hatch. */
export function clearLighterCooldown(home: string): void {
  try {
    rmSync(lighterCooldownFile(home), { force: true });
  } catch {
    /* advisory only */
  }
}

// ── the per-address budget ──────────────────────────────────────────────────

/**
 * Send times in the last rolling minute, per budget key, shared by every
 * client in this process: two clients for one L1 address are one venue
 * bucket. A rolling log rather than a refilling bucket, because the venue
 * counts "per rolling minute" and a bucket would allow a burst it refuses.
 */
const budgets = new Map<string, number[]>();
/** In-process cooldown end per base URL, set before the file is published. */
let localCooldownUntil = 0;

/** Forget every budget and the in-process cooldown. Tests only. */
export function resetLighterApiState(): void {
  budgets.clear();
  localCooldownUntil = 0;
}

function takeBudget(key: string, exit: boolean, now: number, limit: number, reserve: number): { ok: true } | { ok: false; retryAfterMs: number } {
  const log = (budgets.get(key) ?? []).filter((t) => t > now - 60_000);
  budgets.set(key, log);
  const cap = exit ? limit : Math.max(0, limit - reserve);
  if (log.length >= cap) {
    const oldestThatMatters = log[log.length - cap] ?? log[0] ?? now;
    return { ok: false, retryAfterMs: Math.max(1, oldestThatMatters + 60_000 - now) };
  }
  log.push(now);
  return { ok: true };
}

// ── the client ──────────────────────────────────────────────────────────────

function clip(s: string): string {
  // Venue messages are echoed into errors; nothing token- or key-shaped survives.
  return s
    .replace(/\d{9,11}:\d{1,16}:\d{1,3}:[0-9a-f]{160}/g, "[auth]")
    .replace(/(0x)?[0-9a-fA-F]{64,}/g, "[hex]")
    .slice(0, 200);
}

/** Rejects when the signal aborts; never resolves otherwise. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** Release an answer we will not read, so its connection is not held until GC. Best effort. */
function discard(res: { body?: unknown }): void {
  const b = res.body as { cancel?: () => Promise<void> } | null | undefined;
  if (b && typeof b.cancel === "function") void b.cancel().catch(() => {});
}

function serverDate(h: { get(name: string): string | null }): number | null {
  const d = h.get("date");
  if (d === null) return null;
  const ms = Date.parse(d);
  return Number.isFinite(ms) ? ms : null;
}

function checkInt(field: string, v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new LighterApiArgumentError(field, `must be an integer in ${min}..${max}`);
  }
  return v;
}

interface RequestSpec<T> {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  form?: Record<string, string>;
  flags?: RequestFlags;
  /** Require an auth token (the venue refuses the endpoint without one). */
  authRequired?: boolean;
  /**
   * sendTx: counted by the venue per L1 address only, never per IP, so an
   * address-keyed client may send it without a token — and the public
   * client, whose budget is the IP's, may not send it at all.
   */
  l1Counted?: boolean;
  /** /tx only: HTTP 400 + code 21500 is `not-found`. */
  notFound21500?: boolean;
  marketId?: number;
  parse: (raw: unknown) => T | null;
}

/**
 * A sendTx outcome in sendTx's own terms: a venue refusal becomes
 * `refused-send` (resolves nothing), and the read-only kinds cannot appear.
 */
function asSendTxResult<T>(r: LighterResult<T>): LighterResult<T, SendTxError> {
  if (r.ok) return r;
  const e = r.error;
  switch (e.kind) {
    case "rejected":
      return {
        ok: false,
        error: {
          kind: "refused-send",
          status: e.status,
          code: e.code,
          retryable: false,
          maybeExecuted: e.code !== null && SEND_TX_MAYBE_EXECUTED.has(e.code),
          detail: `${e.detail} (an attempt refused, not a tx resolved: resolve the row by hash)`,
        },
        serverDateMs: r.serverDateMs,
      };
    case "not-found":
      // Unreachable (only /tx maps 21500); if it ever were, it is still not
      // evidence about the tx — ambiguous, like every other sendTx failure.
      return { ok: false, error: { kind: "unavailable", status: e.status, retryable: true, detail: e.detail }, serverDateMs: r.serverDateMs };
    default:
      return { ok: false, error: e, serverDateMs: r.serverDateMs };
  }
}

export type LighterApi = ReturnType<typeof createLighterApi>;

/**
 * A client for one budget identity. Every method returns a LighterResult and
 * never throws for anything the venue or the network did; it throws
 * LighterApiArgumentError only for a caller's bad argument, before sending.
 */
export function createLighterApi(opts: LighterApiOptions) {
  const fetchFn = opts.fetchFn ?? (fetch as unknown as LighterFetch);
  const base = (opts.baseUrl ?? LIGHTER_ROUTE_V1.apiBase).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? LIGHTER_API_DEFAULTS.timeoutMs;
  const maxBytes = opts.maxBytes ?? LIGHTER_API_DEFAULTS.maxBytes;
  const limit = opts.budgetPerMinute ?? LIGHTER_API_DEFAULTS.budgetPerMinute;
  const reserve = opts.exitReservePerMinute ?? LIGHTER_API_DEFAULTS.exitReservePerMinute;
  const cooldownMs = Math.max(LIGHTER_API_DEFAULTS.cooldownMs, opts.cooldownMs ?? LIGHTER_API_DEFAULTS.cooldownMs);
  const now = opts.now ?? (() => Date.now());
  const budgetKey = typeof opts.budgetKey === "string" ? opts.budgetKey.toLowerCase() : "";
  if (budgetKey !== PUBLIC_BUDGET_KEY && !/^0x[0-9a-f]{40}$/.test(budgetKey)) {
    throw new LighterApiArgumentError("budgetKey", `must be an L1 address or "${PUBLIC_BUDGET_KEY}"`);
  }
  const addressKeyed = budgetKey !== PUBLIC_BUDGET_KEY;
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(reserve) || reserve < 0 || reserve >= limit) {
    throw new LighterApiArgumentError("budget", "needs 0 ≤ exitReservePerMinute < budgetPerMinute");
  }

  const rateLimited = (source: "venue" | "cooldown" | "budget", status: number | null, retryAfterMs: number, detail: string, date: number | null): LighterResult<never> => ({
    ok: false,
    error: { kind: "rate-limited", source, status, retryAfterMs, retryable: true, detail },
    serverDateMs: date,
  });

  /**
   * The venue's clock minus ours, from the last answer that carried a Date
   * header. Rule 9 writes a `not-found` row off as expired only while this is
   * measured under 5 s, and a persisted tx is re-sent only while the LATER of
   * the two clocks is before its ExpiredAt — both need a number, and every
   * answer already carries one.
   */
  let skew: { skewMs: number; atMs: number } | null = null;
  const noteSkew = (date: number | null): void => {
    if (date === null) return;
    const t = now();
    // The header is truncated to the second, so the venue's clock was
    // somewhere in [date, date + 1 s) when it answered: take the middle.
    skew = { skewMs: date + 500 - t, atMs: t };
  };

  const trip = (by: string): number => {
    const until = now() + cooldownMs;
    // Our own brake first; the file is advice to the rest of the fleet.
    if (until > localCooldownUntil) localCooldownUntil = until;
    publishLighterCooldown(opts.home, until, by);
    return until;
  };

  /**
   * Argument problems throw HERE, synchronously, before a promise exists — a
   * caller bug is not a venue outcome and must not be mistaken for one.
   */
  function request<T>(spec: RequestSpec<T>): Promise<LighterResult<T>> {
    const flags = spec.flags ?? {};
    if (flags.auth !== undefined && (typeof flags.auth !== "string" || !AUTH_RE.test(flags.auth))) {
      throw new LighterApiArgumentError("auth", "is not a Lighter auth token (value not shown)");
    }
    if (spec.authRequired === true && flags.auth === undefined) {
      throw new LighterApiArgumentError("auth", `is required for ${spec.path}`);
    }
    // ONE IDENTITY (header): what this client's budget counts is what the
    // venue counts, or the request is not sent.
    if (addressKeyed && flags.auth === undefined && spec.l1Counted !== true) {
      throw new LighterApiArgumentError(
        "auth",
        `is required for ${spec.path} from an address-keyed client: unauthenticated, it would also count against the shared egress IP, which no budget here tracks`,
      );
    }
    if (!addressKeyed && flags.auth !== undefined) {
      throw new LighterApiArgumentError("auth", "is not accepted by the public client: a token counts against its L1 address, so use that address's client");
    }
    if (!addressKeyed && spec.l1Counted === true) {
      throw new LighterApiArgumentError("budgetKey", `${spec.path} counts against the signer's L1 address; send it from that address's client`);
    }
    return send(spec, flags);
  }

  async function send<T>(spec: RequestSpec<T>, flags: RequestFlags): Promise<LighterResult<T>> {
    const exit = flags.exit === true;
    const t0 = now();
    const cooling = Math.max(localCooldownUntil, readLighterCooldown(opts.home, t0) ?? 0);
    if (cooling > t0 && !exit) {
      return rateLimited("cooldown", null, cooling - t0, `fleet cooldown for ${Math.ceil((cooling - t0) / 1000)} s after a Lighter rate limit; not sent`, null);
    }
    const budget = takeBudget(budgetKey, exit, t0, limit, reserve);
    if (!budget.ok) {
      return rateLimited("budget", null, budget.retryAfterMs, `${exit ? limit : limit - reserve} requests in the last minute for this address; not sent`, null);
    }

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(spec.query ?? {})) if (v !== undefined) qs.set(k, String(v));
    const url = `${base}${spec.path}${qs.size > 0 ? `?${qs.toString()}` : ""}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (flags.auth !== undefined) headers.authorization = flags.auth;
    let body: string | undefined;
    if (spec.form !== undefined) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(spec.form).toString();
    }
    const where = `${spec.method} ${spec.path}`;

    // One signal for the request AND the body: a server that answers headers
    // promptly and then trickles the body is still a hung read.
    const signal = AbortSignal.timeout(timeoutMs);
    let res: Awaited<ReturnType<LighterFetch>>;
    try {
      res = await fetchFn(url, { method: spec.method, headers, body, signal, redirect: "error" });
    } catch (e) {
      const timedOut = signal.aborted || (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError"));
      return {
        ok: false,
        error: { kind: "unavailable", status: null, retryable: true, detail: timedOut ? `${where} timed out after ${timeoutMs} ms` : `${where} failed: ${clip(e instanceof Error ? e.message : String(e))}` },
        serverDateMs: null,
      };
    }
    const date = serverDate(res.headers);
    noteSkew(date);
    const status = res.status;

    if (status === 429 || status === 405) {
      discard(res);
      const until = trip(`${where} → ${status}`);
      return rateLimited("venue", status, until - now(), `${where} → HTTP ${status} (Lighter rate limit); fleet cooldown published`, date);
    }
    if (status >= 500) {
      discard(res);
      return { ok: false, error: { kind: "unavailable", status, retryable: true, detail: `${where} → HTTP ${status}` }, serverDateMs: date };
    }

    let raw: unknown;
    try {
      // Raced against the deadline as well: real fetch aborts the body with
      // the signal, but a transport that does not must not get to hang us.
      const read = await Promise.race([readBoundedJson<unknown>(res, maxBytes), untilAborted(signal)]);
      if (!read.ok) {
        // An unreadable 4xx is not a venue DECISION we can name; for sendTx it
        // must stay ambiguous, so it is `unavailable`, not `rejected`.
        const kind = status >= 400 ? "unavailable" : "malformed";
        return { ok: false, error: { kind, status, retryable: true, detail: `${where} → HTTP ${status}, body unusable: ${clip(read.detail)}` }, serverDateMs: date };
      }
      raw = read.value;
    } catch (e) {
      discard(res);
      const timedOut = signal.aborted;
      return {
        ok: false,
        error: { kind: "unavailable", status, retryable: true, detail: timedOut ? `${where} body timed out after ${timeoutMs} ms` : `${where} body failed: ${clip(e instanceof Error ? e.message : String(e))}` },
        serverDateMs: date,
      };
    }

    const venueCode = typeof raw === "object" && raw !== null && typeof (raw as { code?: unknown }).code === "number" ? (raw as { code: number }).code : null;
    const venueMessage = typeof raw === "object" && raw !== null && typeof (raw as { message?: unknown }).message === "string" ? clip((raw as { message: string }).message) : "";
    if (venueCode === VENUE_TOO_MANY_REQUESTS) {
      const until = trip(`${where} → code ${venueCode}`);
      return rateLimited("venue", status, until - now(), `${where} → venue code ${venueCode} (too many requests); fleet cooldown published`, date);
    }
    if (status >= 400) {
      if (spec.notFound21500 === true && status === 400 && venueCode === VENUE_TX_NOT_FOUND) {
        return { ok: false, error: { kind: "not-found", status: 400, code: VENUE_TX_NOT_FOUND, retryable: false, detail: `${where} → transaction not found` }, serverDateMs: date };
      }
      if (venueCode === null) {
        return { ok: false, error: { kind: "unavailable", status, retryable: true, detail: `${where} → HTTP ${status} with no venue code` }, serverDateMs: date };
      }
      const err: LighterApiError = { kind: "rejected", status, code: venueCode, retryable: false, detail: `${where} → HTTP ${status} code ${venueCode}${venueMessage ? `: ${venueMessage}` : ""}` };
      if (spec.marketId !== undefined) err.marketId = spec.marketId;
      return { ok: false, error: err, serverDateMs: date };
    }
    if (status < 200 || status >= 300) {
      return { ok: false, error: { kind: "unavailable", status, retryable: true, detail: `${where} → HTTP ${status}` }, serverDateMs: date };
    }
    // A 200 whose body carries a venue error code is a refusal in a 200's clothing.
    if (venueCode !== null && venueCode !== 200) {
      const err: LighterApiError = { kind: "rejected", status, code: venueCode, retryable: false, detail: `${where} → code ${venueCode}${venueMessage ? `: ${venueMessage}` : ""}` };
      if (spec.marketId !== undefined) err.marketId = spec.marketId;
      return { ok: false, error: err, serverDateMs: date };
    }
    const value = spec.parse(raw);
    if (value === null) {
      return { ok: false, error: { kind: "malformed", status, retryable: true, detail: `${where} → HTTP ${status}, the answer did not parse (unread, not empty)` }, serverDateMs: date };
    }
    return { ok: true, value, serverDateMs: date };
  }

  const market = (field: string, v: unknown) => checkInt(field, v, 0, 32_767);
  const account = (field: string, v: unknown) => checkInt(field, v, 1, Number.MAX_SAFE_INTEGER);

  return {
    budgetKey,

    /**
     * The venue's clock minus ours in ms, from the most recent answer no older
     * than `maxAgeMs` (default 10 min), or null — unmeasured, never 0. Good to
     * about ±0.5 s plus one-way latency (the Date header has second
     * precision); a caller judging "under 5 s" should leave room for that.
     */
    clockSkewMs(maxAgeMs: number = 10 * 60_000): number | null {
      if (skew === null || !Number.isFinite(maxAgeMs) || now() - skew.atMs > maxAgeMs) return null;
      return skew.skewMs;
    },

    /** GET /api/v1/orderBooks — the venue's market list. */
    orderBooks(flags?: RequestFlags): Promise<LighterResult<OrderBookListing[]>> {
      return request({ method: "GET", path: "/api/v1/orderBooks", query: { filter: "perp" }, flags, parse: parseOrderBooks });
    },

    /** GET /api/v1/orderBookDetails — every perp (one call), or one market. */
    orderBookDetails(marketId?: number, flags?: RequestFlags): Promise<LighterResult<OrderBookDetailsRead>> {
      const query: Record<string, string | number> = { filter: "perp" };
      if (marketId !== undefined) query.market_id = market("marketId", marketId);
      return request({ method: "GET", path: "/api/v1/orderBookDetails", query, flags, marketId, parse: parseOrderBookDetails });
    },

    /** GET /api/v1/orderBookOrders — top of book for one market (limit ≤ 250). */
    orderBookOrders(marketId: number, limit: number, decimals: PerpDecimals, flags?: RequestFlags): Promise<LighterResult<DepthRead>> {
      const m = market("marketId", marketId);
      const n = checkInt("limit", limit, 1, 250);
      return request({ method: "GET", path: "/api/v1/orderBookOrders", query: { market_id: m, limit: n }, flags, marketId: m, parse: (raw) => parseDepth(raw, m, decimals, n) });
    },

    /**
     * GET /api/v1/markPriceCandles. start/end are unix SECONDS (as the venue
     * took them in the spike's history fetch); candle `t` comes back in ms.
     */
    markPriceCandles(
      args: { marketId: number; resolution: "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "12h" | "1d"; startSec: number; endSec: number; countBack: number; priceDecimals: number },
      flags?: RequestFlags,
    ): Promise<LighterResult<{ resolution: string; candles: MarkCandle[] }>> {
      const m = market("marketId", args.marketId);
      const start = checkInt("startSec", args.startSec, 0, 1e11);
      const end = checkInt("endSec", args.endSec, start, 1e11);
      const count = checkInt("countBack", args.countBack, 1, 1000);
      return request({
        method: "GET",
        path: "/api/v1/markPriceCandles",
        query: { market_id: m, resolution: args.resolution, start_timestamp: start, end_timestamp: end, count_back: count },
        flags,
        marketId: m,
        parse: (raw) => parseMarkCandles(raw, args.priceDecimals),
      });
    },

    /** GET /api/v1/fundings — hourly funding (rate is PERCENT per hour). Seconds in, seconds out. */
    fundings(
      args: { marketId: number; resolution: "1h" | "1d"; startSec: number; endSec: number; countBack: number },
      flags?: RequestFlags,
    ): Promise<LighterResult<{ resolution: string; fundings: FundingRow[] }>> {
      const m = market("marketId", args.marketId);
      const start = checkInt("startSec", args.startSec, 0, 1e11);
      const end = checkInt("endSec", args.endSec, start, 1e11);
      const count = checkInt("countBack", args.countBack, 1, 1000);
      return request({
        method: "GET",
        path: "/api/v1/fundings",
        query: { market_id: m, resolution: args.resolution, start_timestamp: start, end_timestamp: end, count_back: count },
        flags,
        marketId: m,
        parse: parseFundings,
      });
    },

    /**
     * GET /api/v1/account — one account by index or L1 address. Rule 12's
     * C, ΣM and ΣU come from exactly this one answer. An address-keyed client
     * must pass `auth` (ONE IDENTITY, above) so the read counts against the L1
     * address, not the shared egress IP.
     */
    account(
      who: { by: "index"; accountIndex: number } | { by: "l1_address"; l1Address: string },
      decimals: ReadonlyMap<number, PerpDecimals>,
      flags?: RequestFlags,
    ): Promise<LighterResult<PerpAccountRead>> {
      if (who.by === "index") {
        const idx = account("accountIndex", who.accountIndex);
        return request({ method: "GET", path: "/api/v1/account", query: { by: "index", value: idx }, flags, parse: (raw) => parseAccount(raw, decimals, { accountIndex: idx }) });
      }
      if (typeof who.l1Address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(who.l1Address)) throw new LighterApiArgumentError("l1Address", "must be a 0x address");
      const l1 = who.l1Address.toLowerCase();
      return request({ method: "GET", path: "/api/v1/account", query: { by: "l1_address", value: l1 }, flags, parse: (raw) => parseAccount(raw, decimals, { l1Address: l1 }) });
    },

    /** GET /api/v1/accountsByL1Address — every account under our L1 (rule 16: any but the master is an incident). */
    accountsByL1Address(l1Address: string, flags?: RequestFlags): Promise<LighterResult<L1Accounts>> {
      if (typeof l1Address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(l1Address)) throw new LighterApiArgumentError("l1Address", "must be a 0x address");
      const l1 = l1Address.toLowerCase();
      return request({ method: "GET", path: "/api/v1/accountsByL1Address", query: { l1_address: l1 }, flags, parse: (raw) => parseAccountsByL1Address(raw, l1) });
    },

    /**
     * GET /api/v1/apikeys — the key(s) registered at an index. 255 is the
     * venue's "all keys" query value, which a READ may use (incident
     * detection wants every index); the signer never signs with it.
     */
    apikeys(accountIndex: number, apiKeyIndex: number, flags?: RequestFlags): Promise<LighterResult<ApiKeyRead[]>> {
      const a = account("accountIndex", accountIndex);
      const k = checkInt("apiKeyIndex", apiKeyIndex, 0, 255);
      return request({
        method: "GET",
        path: "/api/v1/apikeys",
        query: { account_index: a, api_key_index: k },
        flags,
        parse: (raw) => {
          const keys = parseApiKeys(raw);
          // An answer about another account or index is not an answer to us.
          if (keys === null || keys.some((x) => x.accountIndex !== a || (k !== 255 && x.apiKeyIndex !== k))) return null;
          return keys;
        },
      });
    },

    /** GET /api/v1/nextNonce — read at arm only (rule 9); never evidence that a tx is dead. */
    nextNonce(accountIndex: number, apiKeyIndex: number, flags?: RequestFlags): Promise<LighterResult<number>> {
      const a = account("accountIndex", accountIndex);
      const k = checkInt("apiKeyIndex", apiKeyIndex, 0, 254);
      return request({ method: "GET", path: "/api/v1/nextNonce", query: { account_index: a, api_key_index: k }, flags, parse: parseNextNonce });
    },

    /**
     * POST /api/v1/sendTx — the signed bytes, exactly as persisted (rule 9).
     * Form-urlencoded `tx_type` and `tx_info`. NEVER retried: every failure
     * is returned to the caller, whose row decides. The venue's echoed hash
     * must equal the one we signed; anything else is `malformed`, which the
     * row treats as ambiguous and resolves by OUR hash.
     */
    sendTx(tx: { txType: number; txInfo: string; txHash: string }, flags?: RequestFlags & { priceProtection?: boolean }): Promise<LighterResult<SendTxReceipt, SendTxError>> {
      const txType = checkInt("txType", tx.txType, 0, 255);
      if (![13, 14, 15, 16, 20, 28].includes(txType)) throw new LighterApiArgumentError("txType", `${txType} is not a tx type this worker sends`);
      if (typeof tx.txInfo !== "string" || tx.txInfo.length === 0 || tx.txInfo.length > 4096) throw new LighterApiArgumentError("txInfo", "must be the signer's tx_info string");
      const want = typeof tx.txHash === "string" ? tx.txHash.toLowerCase() : "";
      if (!/^[0-9a-f]{80}$/.test(want)) throw new LighterApiArgumentError("txHash", "must be the signer's 80-hex tx hash");
      const form: Record<string, string> = { tx_type: String(txType), tx_info: tx.txInfo };
      if (flags?.priceProtection !== undefined) form.price_protection = String(flags.priceProtection);
      return request({
        method: "POST",
        path: "/api/v1/sendTx",
        form,
        flags,
        l1Counted: true,
        parse: (raw) => {
          const r = parseSendTx(raw);
          return r !== null && r.txHash === want ? r : null;
        },
      }).then(asSendTxResult);
    },

    /** GET /api/v1/tx?by=hash — HTTP 400 code 21500 is `not-found`; every other failure is not. */
    tx(txHash: string, flags?: RequestFlags): Promise<LighterResult<TxRead>> {
      const h = typeof txHash === "string" ? txHash.replace(/^0x/, "").toLowerCase() : "";
      if (!/^[0-9a-f]{80}$/.test(h)) throw new LighterApiArgumentError("txHash", "must be 80 hex");
      return request({ method: "GET", path: "/api/v1/tx", query: { by: "hash", value: h }, flags, notFound21500: true, parse: (raw) => parseTx(raw, h) });
    },

    /** GET /api/v1/accountActiveOrders (auth). */
    accountActiveOrders(
      accountIndex: number,
      decimals: ReadonlyMap<number, PerpDecimals>,
      flags: RequestFlags & { auth: string },
      marketId?: number,
    ): Promise<LighterResult<{ orders: VenueOrder[]; nextCursor: string | null }>> {
      const query: Record<string, string | number> = { account_index: account("accountIndex", accountIndex), market_type: "perp" };
      if (marketId !== undefined) query.market_id = market("marketId", marketId);
      return request({ method: "GET", path: "/api/v1/accountActiveOrders", query, flags, authRequired: true, marketId, parse: (raw) => parseOrders(raw, decimals) });
    },

    /** GET /api/v1/accountInactiveOrders (auth; limit ≤ 100; the venue keeps ~1K inactive orders from the last 24 h). */
    accountInactiveOrders(
      args: { accountIndex: number; limit: number; marketId?: number; cursor?: string },
      decimals: ReadonlyMap<number, PerpDecimals>,
      flags: RequestFlags & { auth: string },
    ): Promise<LighterResult<{ orders: VenueOrder[]; nextCursor: string | null }>> {
      const query: Record<string, string | number> = {
        account_index: account("accountIndex", args.accountIndex),
        limit: checkInt("limit", args.limit, 1, 100),
        market_type: "perp",
      };
      if (args.marketId !== undefined) query.market_id = market("marketId", args.marketId);
      if (args.cursor !== undefined) query.cursor = args.cursor;
      return request({ method: "GET", path: "/api/v1/accountInactiveOrders", query, flags, authRequired: true, marketId: args.marketId, parse: (raw) => parseOrders(raw, decimals) });
    },

    /**
     * GET /api/v1/trades (auth for our own account). Newest first (the venue
     * only sorts descending); the caller pages with an overlapping cursor and
     * ingests by trade id + side, idempotently (rule 10).
     */
    trades(
      args: { accountIndex: number; limit: number; cursor?: string; marketId?: number; orderIndex?: string },
      decimals: ReadonlyMap<number, PerpDecimals>,
      flags: RequestFlags & { auth: string },
    ): Promise<LighterResult<{ trades: PerpTrade[]; nextCursor: string | null }>> {
      const a = account("accountIndex", args.accountIndex);
      const query: Record<string, string | number | boolean> = { account_index: a, sort_by: "timestamp", limit: checkInt("limit", args.limit, 1, 100), market_type: "perp" };
      if (args.cursor !== undefined) query.cursor = args.cursor;
      if (args.marketId !== undefined) query.market_id = market("marketId", args.marketId);
      if (args.orderIndex !== undefined) {
        if (!/^\d{1,20}$/.test(args.orderIndex)) throw new LighterApiArgumentError("orderIndex", "must be a decimal order index");
        query.order_index = args.orderIndex;
      }
      return request({ method: "GET", path: "/api/v1/trades", query, flags, authRequired: true, marketId: args.marketId, parse: (raw) => parseTrades(raw, decimals, { accountIndex: a }) });
    },

    /** GET /api/v1/positionFunding (auth) — the venue-authoritative funding payments (limit ≤ 100). */
    positionFunding(
      args: { accountIndex: number; limit: number; cursor?: string; startSec?: number; endSec?: number },
      decimals: ReadonlyMap<number, PerpDecimals>,
      flags: RequestFlags & { auth: string },
    ): Promise<LighterResult<{ rows: PositionFundingRow[]; nextCursor: string | null }>> {
      const query: Record<string, string | number> = { account_index: account("accountIndex", args.accountIndex), limit: checkInt("limit", args.limit, 1, 100) };
      if (args.cursor !== undefined) query.cursor = args.cursor;
      if (args.startSec !== undefined) query.start_timestamp = checkInt("startSec", args.startSec, 0, 1e11);
      if (args.endSec !== undefined) query.end_timestamp = checkInt("endSec", args.endSec, 0, 1e11);
      return request({ method: "GET", path: "/api/v1/positionFunding", query, flags, authRequired: true, parse: (raw) => parsePositionFunding(raw, decimals) });
    },

    /** GET /api/v1/withdraw/history (auth). */
    withdrawHistory(
      args: { accountIndex: number; cursor?: string; filter?: "all" | "pending" | "claimable" },
      flags: RequestFlags & { auth: string },
    ): Promise<LighterResult<{ rows: WithdrawHistoryRow[]; cursor: string | null }>> {
      const query: Record<string, string | number> = { account_index: account("accountIndex", args.accountIndex) };
      if (args.cursor !== undefined) query.cursor = args.cursor;
      if (args.filter !== undefined) query.filter = args.filter;
      return request({ method: "GET", path: "/api/v1/withdraw/history", query, flags, authRequired: true, parse: parseWithdrawHistory });
    },

    /** GET /api/v1/withdrawalDelay — seconds, read per request (it varies: 626–1314 observed). */
    withdrawalDelay(flags?: RequestFlags): Promise<LighterResult<number>> {
      return request({ method: "GET", path: "/api/v1/withdrawalDelay", flags, parse: parseWithdrawalDelay });
    },
  };
}
