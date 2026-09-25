/**
 * Retention for the MCP tables, run by the orchestrator at most once an hour.
 *
 * Nothing here is needed for correctness — expired codes, tokens and exports
 * are already refused by the code that reads them — it only stops the tables
 * growing forever. Each statement is bounded by an index on its time column.
 */
import type { Db } from "../db";

export const MCP_RETENTION = {
  /** Consent requests and authorization codes: a day after they expire. */
  requestsAndCodesSec: 86_400,
  /** Tokens: a month after they expired or were revoked (the audit trail keeps the history). */
  tokensSec: 30 * 86_400,
  /** Audit rows: 180 days. */
  auditSec: 180 * 86_400,
  /** Rate-limit windows: 3 days. */
  rateSec: 3 * 86_400,
  /** Deliveries: 90 days. */
  deliveriesSec: 90 * 86_400,
  /** Finished jobs: 30 days. */
  jobsSec: 30 * 86_400,
} as const;

let lastRun = 0;

export async function runMcpMaintenancePass(shared: Db, now = Math.floor(Date.now() / 1000), force = false): Promise<{ ran: boolean; errors: number }> {
  if (!force && now - lastRun < 3600) return { ran: false, errors: 0 };
  lastRun = now;
  const r = MCP_RETENTION;
  const statements: Array<[string, unknown[]]> = [
    ["DELETE FROM mcp_auth_requests WHERE expires_at < ?", [now - r.requestsAndCodesSec]],
    ["DELETE FROM mcp_codes WHERE expires_at < ?", [now - r.requestsAndCodesSec]],
    ["DELETE FROM mcp_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)", [now - r.tokensSec, now - r.tokensSec]],
    ["DELETE FROM mcp_audit WHERE at < ?", [now - r.auditSec]],
    ["DELETE FROM mcp_rate WHERE window_start < ?", [now - r.rateSec]],
    ["DELETE FROM mcp_exports WHERE expires_at < ?", [now]],
    ["DELETE FROM mcp_research WHERE expires_at < ?", [now - 30 * 86_400]],
    // Conversations: a year of history is kept; older messages go.
    ["DELETE FROM mcp_messages WHERE created_at < ?", [now - 365 * 86_400]],
    ["DELETE FROM notify_deliveries WHERE created_at < ? AND status IN ('sent','dead','skipped')", [now - r.deliveriesSec]],
    ["DELETE FROM mcp_jobs WHERE finished_at IS NOT NULL AND finished_at < ?", [now - r.jobsSec]],
    // Dynamically registered clients that never became (or no longer are) a
    // live connection: some clients register afresh on every connect.
    ["DELETE FROM mcp_clients WHERE kind = 'dcr' AND created_at < ? AND client_id NOT IN (SELECT client_id FROM mcp_connections WHERE status = 'active')", [now - 30 * 86_400]],
    // Cached metadata documents are re-fetched on use; stale copies can go.
    ["DELETE FROM mcp_clients WHERE kind = 'cimd' AND expires_at < ?", [now - 7 * 86_400]],
  ];
  let errors = 0;
  for (const [sql, params] of statements) {
    try {
      await shared.prepare(sql).run(...params);
    } catch {
      // A missing table on a database that never served MCP is not an error worth more than a count.
      errors += 1;
    }
  }
  return { ran: true, errors };
}

export function resetMaintenanceForTest(): void {
  lastRun = 0;
}
