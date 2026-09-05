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
import type { Transport } from "viem";
import { classifyRpcError, type RpcErrorKind } from "./rpc-error";

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
