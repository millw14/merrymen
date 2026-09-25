/**
 * Tables behind the hosted MCP server (web/src/mcp) and the two background
 * passes the orchestrator runs for it (notification delivery, backtest jobs).
 *
 * One DDL string in the ledger's sqlite dialect; db.ts translates it for
 * Postgres. It lives in worker/src so the orchestrator can create and read the
 * same tables without importing web code.
 *
 * Secrets are never stored in the clear here: OAuth codes, access and refresh
 * tokens, client secrets and consent-request ids are stored as SHA-256 hashes
 * of 256-bit random values. Nothing in these tables can sign a transaction.
 */
import type { Db } from "../db";

export const MCP_SCHEMA = `
CREATE TABLE IF NOT EXISTS mcp_clients (
  client_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  secret_hash TEXT,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE TABLE IF NOT EXISTS mcp_auth_requests (
  id_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  state TEXT,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_auth_requests_expiry ON mcp_auth_requests (expires_at);
CREATE TABLE IF NOT EXISTS mcp_connections (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  client_id TEXT NOT NULL,
  client_name TEXT,
  client_host TEXT,
  kind TEXT NOT NULL,
  scopes TEXT NOT NULL,
  agent_slugs TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  revoked_why TEXT
);
CREATE INDEX IF NOT EXISTS mcp_connections_tenant ON mcp_connections (tenant, status);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_connections_one_active
  ON mcp_connections (tenant, client_id) WHERE status = 'active' AND kind = 'oauth';
CREATE TABLE IF NOT EXISTS mcp_codes (
  code_hash TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scopes TEXT NOT NULL,
  family TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS mcp_tokens (
  token_hash TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  family TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT NOT NULL,
  client_id TEXT NOT NULL,
  label TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  family_expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_tokens_connection ON mcp_tokens (connection_id);
CREATE INDEX IF NOT EXISTS mcp_tokens_family ON mcp_tokens (family);
CREATE TABLE IF NOT EXISTS mcp_audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  tenant TEXT,
  connection_id TEXT,
  client_id TEXT,
  action TEXT NOT NULL,
  capability TEXT,
  outcome TEXT NOT NULL,
  latency_ms INTEGER,
  trace_id TEXT,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS mcp_audit_tenant ON mcp_audit (tenant, at);
CREATE INDEX IF NOT EXISTS mcp_audit_connection ON mcp_audit (connection_id, at);
CREATE TABLE IF NOT EXISTS mcp_rate (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
CREATE TABLE IF NOT EXISTS mcp_messages (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  agent_slug TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  connection_id TEXT,
  request_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  status TEXT NOT NULL,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_messages_request ON mcp_messages (tenant, request_id, role);
CREATE INDEX IF NOT EXISTS mcp_messages_conversation ON mcp_messages (tenant, conversation_id, created_at);
CREATE TABLE IF NOT EXISTS mcp_research (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  agent_slug TEXT NOT NULL,
  connection_id TEXT,
  client_name TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  tokens_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_research_tenant ON mcp_research (tenant, created_at);
CREATE TABLE IF NOT EXISTS mcp_watchlist (
  tenant TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  token TEXT NOT NULL,
  symbol TEXT,
  label TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant, chain_id, token)
);
CREATE TABLE IF NOT EXISTS mcp_proposals (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  agent_slug TEXT,
  agent_account TEXT,
  connection_id TEXT,
  client_name TEXT,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL,
  binding_json TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER,
  order_id TEXT,
  result_json TEXT
);
CREATE INDEX IF NOT EXISTS mcp_proposals_tenant ON mcp_proposals (tenant, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_proposals_idempotency ON mcp_proposals (tenant, idempotency_key);
CREATE TABLE IF NOT EXISTS mcp_jobs (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  connection_id TEXT,
  kind TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL NOT NULL,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  idempotency_key TEXT,
  cancel_requested INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  lease_until INTEGER,
  deadline_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_jobs_queue ON mcp_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS mcp_jobs_tenant ON mcp_jobs (tenant, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS mcp_jobs_idempotency ON mcp_jobs (tenant, idempotency_key);
CREATE TABLE IF NOT EXISTS mcp_exports (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  connection_id TEXT,
  kind TEXT NOT NULL,
  format TEXT NOT NULL,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_exports_tenant ON mcp_exports (tenant, created_at);
CREATE TABLE IF NOT EXISTS notify_subscriptions (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  agent_slug TEXT,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL,
  params_json TEXT NOT NULL,
  status TEXT NOT NULL,
  connection_id TEXT,
  cursor_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_evaluated_at INTEGER
);
CREATE INDEX IF NOT EXISTS notify_subscriptions_tenant ON notify_subscriptions (tenant, status);
CREATE INDEX IF NOT EXISTS notify_subscriptions_due ON notify_subscriptions (status, last_evaluated_at);
CREATE TABLE IF NOT EXISTS notify_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  last_error_code TEXT,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS notify_deliveries_dedupe ON notify_deliveries (dedupe_key);
CREATE INDEX IF NOT EXISTS notify_deliveries_due ON notify_deliveries (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS notify_deliveries_tenant ON notify_deliveries (tenant, created_at);
`;

/** Advisory-lock key serialising concurrent schema creation across replicas. */
export const MCP_SCHEMA_LOCK = 1_297_692_101;

/** Create the MCP tables if missing. Idempotent; safe on every boot. */
export async function ensureMcpSchema(db: Db, dialect: "postgres" | "sqlite"): Promise<void> {
  await db.tx(async (tx) => {
    if (dialect === "postgres") await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(MCP_SCHEMA_LOCK);
    await tx.exec(MCP_SCHEMA);
  });
}
