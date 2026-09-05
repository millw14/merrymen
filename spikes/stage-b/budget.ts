/**
 * HARD REQUEST BUDGET, ENFORCED AT THE WIRE.
 *
 * Every spike in this directory installs this before it builds a client. It
 * wraps globalThis.fetch, so it counts HTTP requests — not viem's logical
 * requests. That is deliberate and is itself a measurement: metered() in
 * worker/src/rpc-meter.ts wraps the transport from OUTSIDE viem's retry loop
 * (createTransport.js sets retryCount = 3), so one metered call can be up to
 * four HTTP requests. The difference between these two counters is the retry
 * amplification the log-based phases could only bound from below.
 *
 * The cap THROWS rather than queues. A spike that would exceed its declared
 * budget must die loudly; the live fleet depends on this endpoint and a runaway
 * loop here is the one way this measurement could hurt it.
 */

let wire = 0;
let cap = 0;
let installed = false;
const byHost = new Map<string, number>();
const statuses = new Map<number, number>();

export function installBudget(limit: number): void {
  if (installed) throw new Error("budget already installed");
  installed = true;
  cap = limit;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    if (wire >= cap) {
      throw new Error(`[budget] HARD CAP ${cap} HTTP requests reached — refusing to send another. This is the guard, not the endpoint.`);
    }
    wire += 1;
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    let host = "unknown";
    try {
      host = new URL(url).host;
    } catch {
      /* keep "unknown" */
    }
    byHost.set(host, (byHost.get(host) ?? 0) + 1);
    const res = await real(input, init);
    statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    return res;
  }) as typeof fetch;
}

export function wireCount(): number {
  return wire;
}

export function budgetReport(): string {
  const hosts = [...byHost.entries()].map(([h, n]) => `${h}=${n}`).join(" ");
  const st = [...statuses.entries()].sort((a, b) => a[0] - b[0]).map(([s, n]) => `${s}:${n}`).join(" ");
  return `[budget] ${wire}/${cap} HTTP requests · hosts ${hosts} · statuses ${st}`;
}

/** Statuses seen so far, for a caller that must stop at the first 429. */
export function statusCount(code: number): number {
  return statuses.get(code) ?? 0;
}
