/**
 * Staff diagnostics: a separate catalogue for Merrymen operators.
 *
 * Granted only to tenants on MERRYMEN_MCP_STAFF_TENANTS, never advertised,
 * and re-checked on every call (policy.ts requires the staff flag as well as
 * the scope, so a token minted while someone was staff stops working the
 * moment they are removed from the list).
 *
 * These tools read ACROSS owners, which is exactly why they say so little
 * about any one of them: fleet counts, distributions and normalised patterns.
 * An agent is named only by pseudonym() of its account (the same one-way hash
 * the structured logs use, so an operator can line a row up with a log line);
 * never an address, slug, name, balance, message text, chat id or tenant. The
 * aggregation lives in lib/services/staff-diagnostics.ts; these adapters add
 * the policy, the process-local facts and the output contract.
 */
import * as z from "zod";
import { describeDeployment, readExecutionFailures, readFleetHealth, readMcpUsage, readPackageVersion, readProviderErrors } from "@/lib/services/staff-diagnostics";
import { settingsReader } from "@/lib/services/settings-view";
import { mcpConfig } from "../config";
import { SERVER_VERSION } from "../instructions";
import { metricsSnapshot, pseudonym } from "../observe";
import { defineTool } from "../tool";
import { UNTRUSTED_NOTE, untrusted } from "./shared";

const WINDOW_ARG = z.number().int().min(1).max(168).default(24).describe("Look-back window in hours (1–168, default 24)");

/**
 * Budgets follow what each call costs the SHARED database the dashboards read:
 * the unreconciled count reads every trade row older than 30 minutes, the
 * event scan reads the whole `events` table (no time index), and the audit
 * count reads the whole `mcp_audit` table. Each gets its own bucket so one
 * cannot starve another, and each is tight.
 */
const TRADES_BUDGET = { bucket: "staff_trades", perMinute: 6, perHour: 90 } as const;
const EVENTS_BUDGET = { bucket: "staff_events", perMinute: 4, perHour: 60 } as const;
const MCP_TABLES_BUDGET = { bucket: "staff_mcp_tables", perMinute: 10, perHour: 180 } as const;

const ANNOTATIONS = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

const ADDRESS = /^0x[0-9a-f]{40}$/;

const statusCounts = z.object({ armed: z.number(), active: z.number(), killed: z.number(), expired: z.number(), error: z.number(), unknown: z.number() });
const modeCounts = z.object({ paper: z.number(), live: z.number(), idle: z.number(), unknown: z.number() });
const statusWord = z.enum(["armed", "active", "killed", "expired", "error", "unknown"]);
const modeWord = z.enum(["paper", "live", "idle", "unknown"]);
const lagStats = z.object({ min: z.number().nullable(), median: z.number().nullable(), p90: z.number().nullable(), max: z.number().nullable() });

const fleetHealth = defineTool({
  name: "staff_fleet_health",
  title: "Fleet health (staff)",
  description: "Staff only. Fleet-wide agent health with owners redacted: agents by status and mode, heartbeat freshness (fresh / stale / frozen after expiry, kill or arm error), the live-blocker histogram, equity-mark age range and mirror lag per table. Agents appear only as one-way hashes.",
  capability: "staff.diagnostics",
  input: z.object({}).strict(),
  output: z.object({
    agents: z.object({
      rows_read: z.number(),
      truncated: z.boolean(),
      current: z.number().describe("Agents whose account is the smart account of a current grant"),
      without_current_grant: z.number().describe("Retired accounts (owner re-signed onto a new one) or grants the kill switch removed"),
      by_status: statusCounts,
      by_mode: modeCounts,
    }),
    heartbeat: z.object({
      fresh: z.number(),
      stale: z.number(),
      never_beat: z.number(),
      frozen: z.object({ expired: z.number(), killed: z.number(), error: z.number() }),
      stale_age_histogram: z.array(z.object({ bucket: z.string(), count: z.number() })),
      tick_seconds: z.object({ from_settings: z.number(), defaulted: z.number(), default_fresh_within_s: z.number() }),
      stale_agents: z.array(z.object({ agent: z.string().nullable().describe("One-way hash of the agent's account"), heartbeat_age_s: z.number(), fresh_within_s: z.number(), status: statusWord, mode: modeWord })),
      rule: z.string(),
    }),
    live_blockers: z.object({ none: z.number(), rules: z.array(z.object({ rule: z.string(), count: z.number(), is_fault: z.boolean() })) }),
    equity_marks: z.object({
      agents_considered: z.number(),
      with_mark: z.number(),
      without_mark: z.number(),
      newest_mark_age_s: z.number().nullable(),
      median_mark_age_s: z.number().nullable(),
      oldest_mark_age_s: z.number().nullable(),
      latest_mark_book: z.object({ paper: z.number(), live: z.number(), unknown: z.number() }),
      note: z.string(),
    }),
    mirror: z.object({
      tables: z.array(z.object({ table: z.string(), tenants: z.number(), never_copied: z.number(), lag_s: lagStats })),
      note: z.string(),
    }).nullable().describe("Null when mirror_state does not exist yet (lag unknown, not zero)"),
    observed_at: z.string(),
    warnings: z.array(z.string()),
  }),
  annotations: ANNOTATIONS,
  budget: { bucket: "staff_fleet", perMinute: 6, perHour: 60 },
  timeoutMs: 25_000,
  async handler(_args, ctx) {
    const now = ctx.now();
    // Each owner's tick comes from the allowlisted settings projection; only
    // the number is used, and the tenant never leaves the service.
    const data = await ctx.ledger((db) => readFleetHealth(db, {
      now,
      hash: pseudonym,
      signal: ctx.signal,
      tickFor: async (tenant) => (ADDRESS.test(tenant) ? (await settingsReader().settingsFor(tenant))?.tickSeconds ?? null : null),
    }));
    const h = data.heartbeat;
    return {
      data,
      summary: `${data.agents.current} current agent(s): ${h.fresh} fresh, ${h.stale} stale, ${h.never_beat} never beat, ${h.frozen.expired + h.frozen.killed + h.frozen.error} frozen; ${data.agents.without_current_grant} retired account row(s).`,
    };
  },
});

const tradeStatus = z.enum(["landed", "paper", "submitted", "rejected", "reverted", "other"]);

const executionFailures = defineTool({
  name: "staff_execution_failures",
  title: "Execution failures (staff)",
  description: "Staff only. Fleet-wide trade outcomes over a window: counts by status (each labelled with its book), by normalised reject rule (free-text rules collapsed to their prefix), reverted operations by rule, and live operations still 'submitted' after 30 minutes by hashed agent. Never raw error text.",
  capability: "staff.diagnostics",
  input: z.object({ window_hours: WINDOW_ARG }).strict(),
  output: z.object({
    window_hours: z.number(),
    since: z.string(),
    by_status: z.array(z.object({
      status: tradeStatus,
      book: z.enum(["live", "paper", "none", "unknown"]),
      count: z.number(),
      with_tx_hash: z.number().describe("Rows carrying an on-chain tx hash; a 'landed' row is a confirmed live trade only with one"),
    })),
    by_rule: z.array(z.object({ status: tradeStatus, rule: z.string(), known: z.boolean(), label: z.string().nullable(), count: z.number() })),
    reverted_by_rule: z.array(z.object({ rule: z.string(), known: z.boolean(), label: z.string().nullable(), count: z.number() })),
    rules_complete: z.boolean().describe("False when the rule grouping hit its cap and some rule-bearing rows are not attributed"),
    unreconciled: z.object({
      older_than_s: z.number(),
      operations: z.number(),
      rows: z.number(),
      oldest_age_s: z.number().nullable(),
      beyond_resync_window_operations: z.number(),
      agents_total: z.number(),
      agents: z.array(z.object({ agent: z.string().nullable(), operations: z.number(), oldest_age_s: z.number() })),
      note: z.string(),
    }),
    observed_at: z.string(),
    notes: z.array(z.string()),
    untrusted_note: z.string(),
  }),
  annotations: ANNOTATIONS,
  budget: TRADES_BUDGET,
  timeoutMs: 25_000,
  async handler({ window_hours }, ctx) {
    const now = ctx.now();
    const d = await ctx.ledger((db) => readExecutionFailures(db, { now, windowHours: window_hours, hash: pseudonym, signal: ctx.signal }));
    // A collapsed or normalised rule can still carry a producer's words.
    const clean = (rule: string) => untrusted(rule, 80) ?? "other";
    const data = {
      ...d,
      by_rule: d.by_rule.map((r) => ({ ...r, rule: clean(r.rule) })),
      reverted_by_rule: d.reverted_by_rule.map((r) => ({ ...r, rule: clean(r.rule) })),
      untrusted_note: `${UNTRUSTED_NOTE} Here: every rule outside the known vocabulary (known=false).`,
    };
    const count = (s: string) => d.by_status.find((x) => x.status === s)?.count ?? 0;
    const landedWithTx = d.by_status.find((x) => x.status === "landed")?.with_tx_hash ?? 0;
    return {
      data,
      summary: `Last ${window_hours}h: ${count("landed")} landed (live; ${landedWithTx} with a tx hash), ${count("paper")} paper, ${count("rejected")} rejected, ${count("reverted")} reverted; ${d.unreconciled.operations} live operation(s) unreconciled after 30 min.`,
    };
  },
});

const providerErrors = defineTool({
  name: "staff_provider_errors",
  title: "Provider and worker errors (staff)",
  description: "Staff only. Warn and error events across the fleet over a window, grouped by a normalised message pattern (numbers, addresses, URLs, ids, quoted text and agent names stripped), with counts, affected-agent counts and first/last seen. Never raw messages.",
  capability: "staff.diagnostics",
  input: z.object({ window_hours: WINDOW_ARG }).strict(),
  output: z.object({
    window_hours: z.number(),
    since: z.string(),
    totals: z.object({ warn: z.number(), err: z.number() }),
    scanned: z.number(),
    complete: z.boolean().describe("False when more events exist than were scanned (the newest are scanned first)"),
    patterns: z.array(z.object({
      level: z.enum(["warn", "err"]),
      pattern: z.string().describe("untrusted: normalised worker text"),
      count: z.number(),
      agents: z.number(),
      first_at: z.string().nullable(),
      last_at: z.string().nullable(),
    })),
    pattern_groups_total: z.number(),
    observed_at: z.string(),
    untrusted_note: z.string(),
  }),
  annotations: ANNOTATIONS,
  budget: EVENTS_BUDGET,
  timeoutMs: 25_000,
  async handler({ window_hours }, ctx) {
    const now = ctx.now();
    const d = await ctx.ledger((db) => readProviderErrors(db, { now, windowHours: window_hours, signal: ctx.signal }));
    const data = {
      ...d,
      patterns: d.patterns.map((p) => ({ ...p, pattern: untrusted(p.pattern, 160) ?? "(empty)" })),
      untrusted_note: `${UNTRUSTED_NOTE} Here: every pattern is derived from worker and provider messages, which can quote third parties.`,
    };
    const top = d.patterns[0];
    return {
      data,
      summary: `Last ${window_hours}h: ${d.totals.err} error and ${d.totals.warn} warning event(s) in ${d.pattern_groups_total} pattern(s)${top ? `; most frequent (${top.count}×) is a ${top.level} pattern` : ""}.`,
    };
  },
});

const deployment = defineTool({
  name: "staff_deployment",
  title: "Deployment (staff)",
  description: "Staff only. What this web process is running: MCP server and package version, commit, Node version, uptime, whether MCP is enabled (and why not), and the configured issuer and resource URL.",
  capability: "staff.diagnostics",
  input: z.object({}).strict(),
  output: z.object({
    mcp_server_version: z.string(),
    package_version: z.string().nullable(),
    commit: z.string().nullable(),
    node_version: z.string(),
    process_started_at: z.string(),
    uptime_s: z.number(),
    mcp: z.object({ enabled: z.boolean(), disabled_why: z.string().nullable(), issuer: z.string().nullable(), resource: z.string().nullable() }),
    observed_at: z.string(),
    warnings: z.array(z.string()),
  }),
  annotations: ANNOTATIONS,
  budget: { bucket: "staff_cheap", perMinute: 30 },
  async handler(_args, ctx) {
    const cfg = mcpConfig();
    const data = describeDeployment({
      env: process.env,
      serverVersion: SERVER_VERSION,
      packageVersion: await readPackageVersion(),
      uptimeSec: process.uptime(),
      nodeVersion: process.version,
      now: ctx.now(),
      mcp: { enabled: cfg.enabled, disabledWhy: cfg.disabledWhy, issuer: cfg.issuer, resource: cfg.resource },
    });
    return {
      data,
      summary: `MCP ${data.mcp_server_version}, package ${data.package_version ?? "unknown"}, commit ${data.commit ?? "unknown"}, ${data.node_version}, up ${Math.round(data.uptime_s / 60)} min; MCP ${data.mcp.enabled ? "enabled" : `disabled (${data.mcp.disabled_why})`}.`,
    };
  },
});

const toolStats = z.object({
  tool: z.string(),
  calls: z.number(),
  errors: z.record(z.string(), z.number()),
  mean_ms: z.number(),
  max_ms: z.number(),
  latency_histogram: z.array(z.number()),
});

interface SnapshotShape {
  since: string;
  buckets_ms: number[];
  tools: Record<string, { calls: number; errors: Record<string, number>; mean_ms: number; max_ms: number; latency_histogram: number[] }>;
  counters: Record<string, number>;
}

const mcpMetrics = defineTool({
  name: "staff_mcp_metrics",
  title: "MCP metrics (staff)",
  description: "Staff only. MCP server metrics: per-tool call counts, errors and latency for this process, audit outcomes over the last 24 hours by action (no owners), active connections and registered clients by kind.",
  capability: "staff.diagnostics",
  input: z.object({}).strict(),
  output: z.object({
    process: z.object({
      since: z.string(),
      scope: z.string(),
      buckets_ms: z.array(z.number()),
      tools: z.array(toolStats),
      counters: z.record(z.string(), z.number()),
    }),
    audit_24h: z.array(z.object({ action: z.string(), outcome: z.string(), count: z.number() })),
    audit_24h_total: z.number(),
    connections: z.object({ active: z.number(), oauth: z.number(), personal: z.number(), owners: z.number(), used_24h: z.number() })
      .describe("Connections with status 'active' (not revoked); an active connection's tokens may still have lapsed, which used_24h shows"),
    clients: z.array(z.object({ kind: z.string(), count: z.number() })),
    observed_at: z.string(),
  }),
  annotations: ANNOTATIONS,
  budget: MCP_TABLES_BUDGET,
  async handler(_args, ctx) {
    const now = ctx.now();
    const { db } = await ctx.mcp();
    const usage = await readMcpUsage(db, { now });
    const snap = metricsSnapshot() as unknown as SnapshotShape;
    const tools = Object.entries(snap.tools)
      .map(([tool, s]) => ({ tool, calls: s.calls, errors: { ...s.errors }, mean_ms: s.mean_ms, max_ms: s.max_ms, latency_histogram: [...s.latency_histogram] }))
      .sort((a, b) => b.calls - a.calls);
    return {
      data: {
        process: {
          since: snap.since,
          scope: "This web process only, since it started. Other replicas keep their own counters; the audit counts below cover every replica, but a call refused for a missing scope is refused before the audit database is opened, so it appears only here.",
          buckets_ms: [...snap.buckets_ms],
          tools,
          counters: { ...snap.counters },
        },
        ...usage,
        observed_at: new Date(now * 1000).toISOString(),
      },
      summary: `${usage.audit_24h_total} audited call(s) in 24h; ${usage.connections.active} active connection(s) for ${usage.connections.owners} owner(s); ${tools.length} tool(s) called on this process.`,
    };
  },
});

export const STAFF_TOOLS = [fleetHealth, executionFailures, providerErrors, deployment, mcpMetrics];
