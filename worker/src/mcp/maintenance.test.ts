import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../db";
import { ensureMcpSchema } from "./schema";
import { MCP_RETENTION, resetMaintenanceForTest, runMcpMaintenancePass } from "./maintenance";

test("retention deletes only what is past its window, and runs at most hourly", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await ensureMcpSchema(db, "sqlite");
  const now = 2_000_000_000;
  const old = now - MCP_RETENTION.tokensSec - 10;
  raw.prepare(`INSERT INTO mcp_tokens (token_hash, connection_id, kind, family, scopes, resource, client_id, created_at, expires_at, family_expires_at)
    VALUES ('old', 'c', 'access', 'f', '', 'r', 'x', 1, ?, ?)`).run(old, old);
  raw.prepare(`INSERT INTO mcp_tokens (token_hash, connection_id, kind, family, scopes, resource, client_id, created_at, expires_at, family_expires_at)
    VALUES ('live', 'c', 'access', 'f', '', 'r', 'x', 1, ?, ?)`).run(now + 60, now + 60);
  raw.prepare(`INSERT INTO mcp_connections (id, tenant, client_id, kind, scopes, agent_slugs, status, created_at, updated_at) VALUES ('c1', 't', 'mcpc_kept', 'oauth', '', '[]', 'active', 1, 1)`).run();
  for (const id of ["mcpc_kept", "mcpc_orphan"]) {
    raw.prepare(`INSERT INTO mcp_clients (client_id, kind, redirect_uris, auth_method, metadata_json, created_at, fetched_at) VALUES (?, 'dcr', '[]', 'none', '{}', 1, 1)`).run(id);
  }
  raw.prepare(`INSERT INTO mcp_audit (id, at, action, outcome) VALUES ('a-old', ?, 'x', 'ok'), ('a-new', ?, 'x', 'ok')`).run(now - MCP_RETENTION.auditSec - 1, now - 5);
  resetMaintenanceForTest();
  const first = await runMcpMaintenancePass(db, now);
  assert.deepEqual(first, { ran: true, errors: 0 });
  assert.deepEqual(raw.prepare("SELECT token_hash FROM mcp_tokens").all().map((r) => (r as { token_hash: string }).token_hash), ["live"]);
  assert.deepEqual(raw.prepare("SELECT client_id FROM mcp_clients").all().map((r) => (r as { client_id: string }).client_id), ["mcpc_kept"]);
  assert.deepEqual(raw.prepare("SELECT id FROM mcp_audit").all().map((r) => (r as { id: string }).id), ["a-new"]);
  assert.equal((await runMcpMaintenancePass(db, now + 10)).ran, false, "not again within the hour");
});
