/**
 * Observability for the MCP server: structured logs, per-process metrics,
 * durable audit records and shared rate limits.
 *
 * Private data stays out of all of it. Logs and metric labels carry a short
 * one-way hash of the tenant and connection, never the address, token,
 * message text or balances. Audit rows (owner-visible on the Connected apps
 * page) carry ids and argument NAMES, not free text an owner typed.
 */
import { createHash, randomBytes } from "node:crypto";
import type { McpDb } from "./db";

export function traceId(): string {
  return randomBytes(8).toString("hex");
}

export function pseudonym(value: string | null | undefined): string | null {
  if (!value) return null;
  return createHash("sha256").update(`mcp-log:${value.toLowerCase()}`).digest("hex").slice(0, 12);
}

export function logEvent(event: string, fields: Record<string, unknown>): void {
  // One JSON line per event, stdout. Railway indexes it; nothing here is secret.
  try {
    console.log(JSON.stringify({ mcp: event, at: new Date().toISOString(), ...fields }));
  } catch {
    /* never let logging fail a request */
  }
}

// ── metrics ─────────────────────────────────────────────────────────────────

const BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

interface ToolStats {
  calls: number;
  errors: Record<string, number>;
  latency: number[];
  totalMs: number;
  maxMs: number;
}

const tools = new Map<string, ToolStats>();
const counters = new Map<string, number>();
const startedAt = Date.now();

export function recordToolCall(tool: string, outcome: string, ms: number): void {
  let s = tools.get(tool);
  if (!s) {
    s = { calls: 0, errors: {}, latency: new Array(BUCKETS_MS.length + 1).fill(0), totalMs: 0, maxMs: 0 };
    tools.set(tool, s);
  }
  s.calls += 1;
  if (outcome !== "ok") s.errors[outcome] = (s.errors[outcome] ?? 0) + 1;
  const i = BUCKETS_MS.findIndex((b) => ms <= b);
  s.latency[i === -1 ? BUCKETS_MS.length : i] += 1;
  s.totalMs += ms;
  s.maxMs = Math.max(s.maxMs, ms);
}

export function count(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function metricsSnapshot(): Record<string, unknown> {
  return {
    since: new Date(startedAt).toISOString(),
    buckets_ms: BUCKETS_MS,
    tools: Object.fromEntries([...tools].map(([name, s]) => [name, {
      calls: s.calls,
      errors: s.errors,
      mean_ms: s.calls ? Math.round(s.totalMs / s.calls) : 0,
      max_ms: s.maxMs,
      latency_histogram: s.latency,
    }])),
    counters: Object.fromEntries(counters),
  };
}

export function resetMetricsForTest(): void {
  tools.clear();
  counters.clear();
}

// ── audit ───────────────────────────────────────────────────────────────────

export interface AuditRecord {
  action: string;
  outcome: string;
  tenant?: string | null;
  connectionId?: string | null;
  clientId?: string | null;
  capability?: string | null;
  latencyMs?: number | null;
  traceId?: string | null;
  detail?: Record<string, unknown>;
}

/** Keys whose short values are ids or enums, safe to keep; every other value is reduced to its type and size. */
const AUDIT_VALUE_KEYS = new Set([
  "agent", "side", "token", "chain_id", "kind", "period", "book", "id", "proposal_id", "job_id", "subscription_id",
  "export_id", "format", "strategy", "channel", "symbol", "window", "status", "conversation_id", "decision_id",
]);

export function auditDetail(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>).slice(0, 24)) {
    if (AUDIT_VALUE_KEYS.has(k) && (typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && v.length <= 80))) out[k] = v;
    else if (typeof v === "string") out[k] = `<${v.length} chars>`;
    else if (Array.isArray(v)) out[k] = `<${v.length} items>`;
    else if (v && typeof v === "object") out[k] = "<object>";
    else out[k] = v ?? null;
  }
  return out;
}

export async function writeAudit(d: McpDb, r: AuditRecord, now = Math.floor(Date.now() / 1000)): Promise<void> {
  try {
    await d.db.prepare(`INSERT INTO mcp_audit (id, at, tenant, connection_id, client_id, action, capability, outcome, latency_ms, trace_id, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`aud_${randomBytes(12).toString("hex")}`, now, r.tenant?.toLowerCase() ?? null, r.connectionId ?? null, r.clientId ?? null,
        r.action.slice(0, 80), r.capability ?? null, r.outcome.slice(0, 40), r.latencyMs ?? null, r.traceId ?? null,
        r.detail ? JSON.stringify(r.detail).slice(0, 2000) : null);
  } catch (error) {
    // An audit write failure is logged loudly; it does not turn a read into an error.
    logEvent("audit_write_failed", { action: r.action, error: error instanceof Error ? error.name : "unknown" });
  }
}

// ── rate limits ─────────────────────────────────────────────────────────────

export interface RateVerdict {
  ok: boolean;
  count: number;
  retryAfterSec: number;
}

/**
 * Fixed-window counter in the shared database, so the limit holds across web
 * replicas. One upsert per check. A database error propagates (fails closed):
 * an unreachable database also means the tool could not read its data, so
 * refusing costs nothing and never lets a flood through.
 *
 * Old windows are pruned by the orchestrator's hourly retention pass
 * (worker/src/mcp/maintenance.ts), never here: a DELETE on the request path
 * made that request wait on a scan of the table, and two replicas pruning at
 * once waited on each other's row locks.
 */
export async function rateHit(d: McpDb, bucket: string, windowSec: number, limit: number, now: number): Promise<RateVerdict> {
  const windowStart = Math.floor(now / windowSec) * windowSec;
  const row = await d.db.prepare(`INSERT INTO mcp_rate (bucket, window_start, hits) VALUES (?, ?, 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET hits = mcp_rate.hits + 1 RETURNING hits`).get(bucket, windowStart) as { hits: number | string };
  const hits = Number(row.hits);
  return { ok: hits <= limit, count: hits, retryAfterSec: Math.max(1, windowStart + windowSec - now) };
}

// ── bounded concurrency ─────────────────────────────────────────────────────

export class Gate {
  private active = 0;
  private perKey = new Map<string, number>();
  constructor(private max: number, private maxPerKey: number) {}
  tryEnter(key: string): (() => void) | null {
    const k = this.perKey.get(key) ?? 0;
    if (this.active >= this.max || k >= this.maxPerKey) return null;
    this.active += 1;
    this.perKey.set(key, k + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const n = (this.perKey.get(key) ?? 1) - 1;
      if (n <= 0) this.perKey.delete(key);
      else this.perKey.set(key, n);
    };
  }
  get inFlight(): number {
    return this.active;
  }
}
