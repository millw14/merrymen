/**
 * Retention for the MCP tables, run by the orchestrator at most once an hour.
 *
 * Nothing here is needed for correctness — expired codes, tokens and exports
 * are already refused by the code that reads them — it only stops the tables
 * growing forever. Each statement filters on a time column that leads an index
 * of its own (schema.ts), so it is an index range scan, never a sequential scan
 * of the whole audit or rate table; maintenance.test.ts checks every plan. The
 * request path never deletes: mcp_rate is pruned here and only here.
 *
 * Each DELETE runs in its own short transaction, so the orchestrator's bounded
 * database (background.ts boundedDb) can put a statement_timeout and a
 * lock_timeout on it, and one slow table cannot hold another's locks.
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
  /** Dynamically registered clients no active connection uses: 30 days after registration. */
  dcrUnusedSec: 30 * 86_400,
  /**
   * How long after it was fetched an expired client metadata document may
   * still be served when a fresh fetch fails (web/src/mcp/oauth/clients.ts
   * CIMD_STALE_OK_SEC). Past it the row is used by nothing: resolveClient
   * fetches the document again, and without a row the same.
   */
  cimdStaleOkSec: 86_400,
} as const;

/** The retention statements for one run, in order. Exported so the test can check each one's plan. */
export function retentionStatements(now: number): Array<[string, unknown[]]> {
  const r = MCP_RETENTION;
  return [
    ["DELETE FROM mcp_auth_requests WHERE expires_at < ?", [now - r.requestsAndCodesSec]],
    ["DELETE FROM mcp_codes WHERE expires_at < ?", [now - r.requestsAndCodesSec]],
    // Two statements, one index each, rather than an OR the planner may not split.
    ["DELETE FROM mcp_tokens WHERE expires_at < ?", [now - r.tokensSec]],
    ["DELETE FROM mcp_tokens WHERE revoked_at IS NOT NULL AND revoked_at < ?", [now - r.tokensSec]],
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
    ["DELETE FROM mcp_clients WHERE kind = 'dcr' AND created_at < ? AND client_id NOT IN (SELECT client_id FROM mcp_connections WHERE status = 'active')", [now - r.dcrUnusedSec]],
    // A cached client metadata document (CIMD) is only a cache: an expired one
    // is fetched again on its next use whether its row is here or not. Anyone
    // can make the server cache one (any URL is a client_id until fetched), so
    // a document no active connection uses goes AS SOON AS it expires — a week
    // of grace let one caller park gigabytes in the shared database. One an
    // active connection uses goes once it is expired AND past the window in
    // which an expired copy may still be served when a fetch fails
    // (cimdStaleOkSec from its fetch): after that nothing reads it, and the
    // next use fetches it afresh. Nothing is kept for ever, including rows
    // stored before only the parsed fields were kept.
    // (A row with no expiry at all is read as expired, as resolveClient reads it.)
    ["DELETE FROM mcp_clients WHERE kind = 'cimd' AND expires_at < ? AND (fetched_at < ? OR client_id NOT IN (SELECT client_id FROM mcp_connections WHERE status = 'active'))", [now, now - r.cimdStaleOkSec]],
    ["DELETE FROM mcp_clients WHERE kind = 'cimd' AND expires_at IS NULL AND (fetched_at < ? OR client_id NOT IN (SELECT client_id FROM mcp_connections WHERE status = 'active'))", [now - r.cimdStaleOkSec]],
  ];
}

let lastRun = 0;

export async function runMcpMaintenancePass(shared: Db, now = Math.floor(Date.now() / 1000), force = false): Promise<{ ran: boolean; errors: number }> {
  if (!force && now - lastRun < 3600) return { ran: false, errors: 0 };
  lastRun = now;
  let errors = 0;
  for (const [sql, params] of retentionStatements(now)) {
    try {
      await shared.tx((tx) => tx.prepare(sql).run(...params));
    } catch {
      // A missing table on a database that never served MCP, or a statement
      // the database cut off, is not an error worth more than a count; the
      // next hour tries again.
      errors += 1;
    }
  }
  return { ran: true, errors };
}

export function resetMaintenanceForTest(): void {
  lastRun = 0;
}
