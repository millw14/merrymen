/**
 * WHEN THE CONFIGURED RPC STOPS ANSWERING, READ FROM THE CHAIN'S OWN.
 *
 * 2026-09-28 01:48 UTC: the house endpoint's monthly quota ran out and it
 * answered every request with a 429 — "Monthly capacity limit exceeded" — for
 * days. The chain's public endpoint served normally the whole time. The fleet
 * had exactly one URL, so every child was blind: every tick "market
 * unreadable", no trading, no exits, until an operator changed a variable.
 *
 * So a read that the configured endpoint will not serve is sent to the chain's
 * public endpoint instead, and the configured one is asked again once it has
 * had time to recover.
 *
 * WHAT THE FALLBACK IS, AND WHAT IT IS NOT. It is the chain definition's own
 * default RPC (packages/core/src/chain.ts) — the endpoint the fleet reads from
 * when no house RPC is configured at all, run by the chain itself. It is not
 * configurable, so failover adds no new party a read can be answered by, and
 * it cannot point a mainnet client at another chain: the URL comes from the
 * same `chain` object the client was built with.
 *
 * READS ONLY. This sits under `chainRead`. The bundler is built elsewhere and
 * is never failed over: a send must go exactly once to exactly one place.
 *
 * PURE. Decisions over a status, a body and a clock. The transport is
 * rpc-meter.ts's.
 */
import { createHash } from "node:crypto";
import { saysQuotaExhausted } from "./rpc-error";

/** What one endpoint's answer means for where the next request should go. */
export type EndpointVerdict =
  /** Served, or refused for a reason another endpoint would share (a bad request). Return it. */
  | "answer"
  /** Asked too often. Transient: this request goes elsewhere, the governor counts the strike. */
  | "refused"
  /** Will not serve this account for a while: quota spent, key rejected, bill unpaid. */
  | "down"
  /** Broken right now — a 5xx, a dead socket, a hang. Try elsewhere, and look again soon. */
  | "error";

/**
 * How long a DOWN endpoint is left alone before it is asked again.
 *
 * Long enough that a spent monthly quota costs one wasted request per child
 * every five minutes rather than one per read; short enough that when the
 * operator pays the bill, the fleet is back on the house endpoint within five
 * minutes without anyone restarting anything.
 */
export const DOWN_HOLD_MS = 5 * 60_000;
/** How long a merely BROKEN endpoint is left alone. A blip should not cost five minutes. */
export const ERROR_HOLD_MS = 30_000;
/**
 * How long the configured endpoint gets before its request moves on, when
 * there is somewhere to move it to.
 *
 * viem gives a whole request 10s, and one signal governs every attempt at it.
 * A configured endpoint that HANGS would otherwise spend all ten, and the
 * fallback would be handed a request that is already cancelled — failover that
 * only works when the primary fails fast. Six leaves four for the fallback,
 * and is well above anything a healthy read took in the production meter.
 */
export const PRIMARY_BUDGET_MS = 6_000;

/**
 * Classify one HTTP answer. `body` is read only for non-2xx responses, and
 * only this function sees it: a provider's words are never logged.
 */
export function verdictFor(status: number, body: string): EndpointVerdict {
  if (status >= 200 && status < 300) return "answer";
  // A spent quota arrives as a 429, and is the case this module exists for.
  if (saysQuotaExhausted(body)) return "down";
  // The key is rejected, or the account will not be served until it pays.
  if (status === 401 || status === 402 || status === 403) return "down";
  if (status === 429 || status === 503) return "refused";
  if (status >= 500) return "error";
  // Any other 4xx is about the REQUEST — malformed, too large, unsupported.
  // Another endpoint would say the same, so moving it on only doubles the load.
  return "answer";
}

/** How long an endpoint that gave this verdict is skipped. Zero: not skipped. */
export function holdFor(v: EndpointVerdict): number {
  if (v === "down") return DOWN_HOLD_MS;
  if (v === "error") return ERROR_HOLD_MS;
  return 0;
}

/**
 * The endpoints a read may go to, in order of preference.
 *
 * The configured one first, always — it is the operator's choice, and failover
 * is for when it cannot serve, not a second opinion. The chain's own default
 * after it, when that is a different endpoint. With nothing configured the two
 * are the same URL and there is exactly one endpoint, which is precisely the
 * behaviour before this module existed.
 */
export function failoverEndpoints(configured: string | undefined, chainDefault: string | undefined): string[] {
  const out: string[] = [];
  for (const u of [configured, chainDefault]) {
    const url = typeof u === "string" ? u.trim() : "";
    if (!url || out.some((o) => sameEndpoint(o, url))) continue;
    out.push(url);
  }
  return out;
}

/** Match viem's fetch URL: canonical URL spelling, without Basic auth userinfo. */
export function transportUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return value;
  }
}

function sameEndpoint(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/**
 * A short name for an endpoint that is safe to write down.
 *
 * Configured URLs carry API keys in their paths, so a URL never goes into a
 * file name or a log line. This is a stable, non-reversible label for one.
 */
export function endpointKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}
