/**
 * Stage B — quote-path instrumentation.
 *
 * READ-ONLY. This file builds a viem transport that is metered by the REPO'S OWN
 * rpc-meter (worker/src/rpc-meter.ts, the same `metered()` production wraps every
 * transport with) and, underneath it, a `fetchFn` that records the WIRE.
 *
 * Two instruments, deliberately:
 *   - rpc-meter counts LOGICAL requests (one per viem request(), retries folded in)
 *     and owns peakInFlight. If it is wrong here it is wrong in production.
 *   - fetchFn counts HTTP POSTs (retries visible), and is the only place that can
 *     see the `to` address, so v3-quoter vs v4-quoter vs v4-stateview can be split.
 *
 * Nothing is signed, built or sent. Every call is eth_call.
 */
import { http, type Transport } from "viem";
import { metered, rpcSummaryLines, resetRpcMeters } from "../../worker/src/rpc-meter";

export interface WireCall {
  /** monotonic ms since probe start */
  t0: number;
  t1: number;
  ms: number;
  method: string;
  /** eth_call target, lowercased. undefined for non-eth_call */
  to?: string;
  /** first 10 chars of calldata = selector */
  selector?: string;
  /** sha of the full JSON-RPC params array, for the dedup question */
  paramsHash: string;
  paramsJson: string;
  ok: boolean;
  /** true when this response was synthesized by the fault injector */
  injected: boolean;
}

export interface Injector {
  /** return true to synthesize a 429 for this request instead of hitting the wire */
  (body: { method: string; params?: unknown }, seq: number): boolean;
}

const START = Date.now();
export const wire: WireCall[] = [];
let injector: Injector | null = null;
let seq = 0;

export function setInjector(f: Injector | null): void {
  injector = f;
}
export function resetWire(): void {
  wire.length = 0;
}

function hash(s: string): string {
  // cyrb53-ish; only needs to distinguish, not to be cryptographic.
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** The exact shape this chain sends, per worker/src/rpc-error.test.ts:13-20. */
function rateLimitResponse(id: unknown): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? 1,
      error: { code: 429, message: "Rate Limit Hit, limit will reset in 60 seconds" },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const recordingFetch: typeof fetch = async (url, init) => {
  const n = seq++;
  let body: { method: string; params?: unknown; id?: unknown } = { method: "unknown" };
  try {
    body = JSON.parse(String((init as RequestInit).body));
  } catch {
    /* leave as unknown */
  }
  const params = (body.params ?? []) as unknown[];
  const first = params[0] as { to?: string; data?: string } | undefined;
  const paramsJson = JSON.stringify(params);
  const t0 = Date.now() - START;
  const rec: WireCall = {
    t0,
    t1: t0,
    ms: 0,
    method: body.method,
    to: typeof first?.to === "string" ? first.to.toLowerCase() : undefined,
    selector: typeof first?.data === "string" ? first.data.slice(0, 10) : undefined,
    paramsHash: hash(`${body.method}|${paramsJson}`),
    paramsJson,
    ok: true,
    injected: false,
  };
  wire.push(rec);

  if (injector?.(body, n)) {
    rec.injected = true;
    rec.ok = false;
    rec.t1 = Date.now() - START;
    rec.ms = rec.t1 - rec.t0;
    return rateLimitResponse(body.id);
  }
  try {
    const res = await fetch(url as string, init);
    rec.ok = res.ok;
    return res;
  } catch (e) {
    rec.ok = false;
    throw e;
  } finally {
    rec.t1 = Date.now() - START;
    rec.ms = rec.t1 - rec.t0;
  }
};

/** Production's transport, plus the wire recorder underneath it. */
export function probeTransport(url: string): Transport {
  return metered(http(url, { fetchFn: recordingFetch }), "read");
}

export interface MeterWindow {
  label: string;
  calls: number;
  secs: number;
  errors: number;
  rateLimited: number;
  peak: number;
  byMethod: { method: string; calls: number; errors: number; avgMs: number; kinds: string }[];
  raw: string;
}

const LINE =
  /^\[rpc:([^\]]+)\] (\d+) calls in (\d+)s \([\d.]+\/s\) · (\d+) err · (\d+) rate-limited · peak concurrency (\d+) · (.*)$/;

/** Parse the production summary line. Deltas come from resetRpcMeters(), as in the tick. */
export function readMeter(): MeterWindow[] {
  return rpcSummaryLines().map((raw) => {
    const m = LINE.exec(raw);
    if (!m) return { label: "?", calls: 0, secs: 0, errors: 0, rateLimited: 0, peak: 0, byMethod: [], raw };
    const byMethod = m[7]!.split(" · ").filter(Boolean).map((part) => {
      const mm = /^(\S+) (\d+)(?:\/(\d+)err)? avg(\d+)ms(?: \[(.*)\])?$/.exec(part);
      return mm
        ? { method: mm[1]!, calls: Number(mm[2]), errors: Number(mm[3] ?? 0), avgMs: Number(mm[4]), kinds: mm[5] ?? "" }
        : { method: part, calls: 0, errors: 0, avgMs: 0, kinds: "" };
    });
    return {
      label: m[1]!,
      calls: Number(m[2]),
      secs: Number(m[3]),
      errors: Number(m[4]),
      rateLimited: Number(m[5]),
      peak: Number(m[6]),
      byMethod,
      raw,
    };
  });
}

export { resetRpcMeters };
