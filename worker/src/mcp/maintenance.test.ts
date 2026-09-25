import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../db";
import { ensureMcpSchema } from "./schema";
import { MCP_RETENTION, resetMaintenanceForTest, retentionStatements, runMcpMaintenancePass } from "./maintenance";

test("retention deletes only what is past its window, and runs at most hourly", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await ensureMcpSchema(db, "sqlite");
  const now = 2_000_000_000;
  const old = now - MCP_RETENTION.tokensSec - 10;
  raw.prepare(`INSERT INTO mcp_tokens (token_hash, connection_id, kind, family, scopes, resource, client_id, created_at, expires_at, family_expires_at)
    VALUES ('old', 'c', 'access', 'f', '', 'r', 'x', 1, ?, ?)`).run(old, old);
  raw.prepare(`INSERT INTO mcp_tokens (token_hash, connection_id, kind, family, scopes, resource, client_id, created_at, expires_at, family_expires_at, revoked_at)
    VALUES ('revoked-long-ago', 'c', 'refresh', 'f', '', 'r', 'x', 1, ?, ?, ?)`).run(now + 60, now + 60, old);
  raw.prepare(`INSERT INTO mcp_tokens (token_hash, connection_id, kind, family, scopes, resource, client_id, created_at, expires_at, family_expires_at)
    VALUES ('live', 'c', 'access', 'f', '', 'r', 'x', 1, ?, ?)`).run(now + 60, now + 60);
  raw.prepare(`INSERT INTO mcp_connections (id, tenant, client_id, kind, scopes, agent_slugs, status, created_at, updated_at) VALUES ('c1', 't', 'mcpc_kept', 'oauth', '', '[]', 'active', 1, 1)`).run();
  for (const id of ["mcpc_kept", "mcpc_orphan"]) {
    raw.prepare(`INSERT INTO mcp_clients (client_id, kind, redirect_uris, auth_method, metadata_json, created_at, fetched_at) VALUES (?, 'dcr', '[]', 'none', '{}', 1, 1)`).run(id);
  }
  raw.prepare(`INSERT INTO mcp_audit (id, at, action, outcome) VALUES ('a-old', ?, 'x', 'ok'), ('a-new', ?, 'x', 'ok')`).run(now - MCP_RETENTION.auditSec - 1, now - 5);
  raw.prepare(`INSERT INTO mcp_rate (bucket, window_start, hits) VALUES ('b', ?, 1), ('b', ?, 1)`).run(now - MCP_RETENTION.rateSec - 60, now - 60);
  resetMaintenanceForTest();
  const first = await runMcpMaintenancePass(db, now);
  assert.deepEqual(first, { ran: true, errors: 0 });
  assert.deepEqual(raw.prepare("SELECT token_hash FROM mcp_tokens").all().map((r) => (r as { token_hash: string }).token_hash), ["live"]);
  assert.deepEqual(raw.prepare("SELECT client_id FROM mcp_clients").all().map((r) => (r as { client_id: string }).client_id), ["mcpc_kept"]);
  assert.deepEqual(raw.prepare("SELECT id FROM mcp_audit").all().map((r) => (r as { id: string }).id), ["a-new"]);
  assert.deepEqual(raw.prepare("SELECT window_start FROM mcp_rate").all().map((r) => (r as { window_start: number }).window_start), [now - 60]);
  assert.equal((await runMcpMaintenancePass(db, now + 10)).ran, false, "not again within the hour");
});

test("a cached client metadata document no active connection uses goes as soon as it expires; one a live connection uses goes once its stale window has passed", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await ensureMcpSchema(db, "sqlite");
  const now = 2_000_000_000;
  const stale = MCP_RETENTION.cimdStaleOkSec;
  assert.equal(stale, 86_400, "the window web/src/mcp/oauth/clients.ts serves an expired copy in (CIMD_STALE_OK_SEC)");
  const cimd = (id: string, fetchedAt: number, expiresAt: number | null) =>
    raw.prepare(`INSERT INTO mcp_clients (client_id, kind, redirect_uris, auth_method, metadata_json, created_at, fetched_at, expires_at)
      VALUES (?, 'cimd', '[]', 'none', '{}', ?, ?, ?)`).run(id, fetchedAt, fetchedAt, expiresAt);
  const connection = (id: string, clientId: string, status: string) =>
    raw.prepare(`INSERT INTO mcp_connections (id, tenant, client_id, kind, scopes, agent_slugs, status, created_at, updated_at) VALUES (?, 't', ?, 'oauth', '', '[]', ?, 1, 1)`)
      .run(id, clientId, status);
  const live = (clientId: string) => connection(`c-${clientId}`, clientId, "active");
  // Nobody uses these: gone the moment the cache expires, however recently fetched.
  cimd("https://stranger.example/c1", now - 60, now - 1);
  cimd("https://stranger.example/c2", now - 60, now - 30);
  connection("c-revoked", "https://stranger.example/c2", "revoked");
  cimd("https://stranger.example/c3", now - 60, null); // no expiry reads as expired
  // A live connection uses these.
  cimd("https://app.example/stale-over", now - stale - 1, now - 3600); // expired and past the stale window: re-fetched on use
  live("https://app.example/stale-over");
  cimd("https://app.example/legacy", now - 90 * 86_400, now - 89 * 86_400); // stored long ago (and never refreshed): not kept for ever
  live("https://app.example/legacy");
  cimd("https://app.example/stale-ok", now - stale + 3600, now - 3600); // expired, but still servable if a fetch fails
  live("https://app.example/stale-ok");
  cimd("https://app.example/null-over", now - stale - 1, null);
  live("https://app.example/null-over");
  cimd("https://app.example/null-ok", now - 60, null);
  live("https://app.example/null-ok");
  cimd("https://fresh.example/c", now - 60, now + 3600); // still fresh, used by nobody
  resetMaintenanceForTest();
  assert.deepEqual(await runMcpMaintenancePass(db, now), { ran: true, errors: 0 });
  const left = raw.prepare("SELECT client_id FROM mcp_clients ORDER BY client_id").all().map((r) => (r as { client_id: string }).client_id);
  assert.deepEqual(left, ["https://app.example/null-ok", "https://app.example/stale-ok", "https://fresh.example/c"]);
});

test("every retention statement searches its table through an index on the time column it prunes by, never a scan", async () => {
  const raw = new DatabaseSync(":memory:");
  await ensureMcpSchema(wrapSqlite(raw), "sqlite");
  const now = 2_000_000_000;
  for (const [sql, params] of retentionStatements(now)) {
    const table = /^DELETE FROM (\w+)/.exec(sql)![1]!;
    // The column the statement prunes by: the first one its WHERE tests, after the kind.
    const where = sql.slice(sql.indexOf(" WHERE ") + " WHERE ".length).replace(/^kind = '\w+' AND /, "");
    const column = /^(\w+) /.exec(where)![1]!;
    const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>).map((r) => r.detail);
    // Only the table being pruned: the small NOT IN list over mcp_connections may be read whole.
    const own = plan.filter((d) => new RegExp(`^(SEARCH|SCAN) ${table}\\b`).test(d));
    assert.equal(own.length, 1, `${sql}: ${plan.join(" | ")}`);
    assert.match(own[0]!, new RegExp(`^SEARCH ${table} USING (COVERING )?INDEX \\w+ \\(.*\\b${column}[<=>]`), `${sql}: ${plan.join(" | ")}`);
  }
});

test("the request path never prunes the rate table: retention does", () => {
  const observe = readFileSync(path.join(process.cwd(), "web", "src", "mcp", "observe.ts"), "utf8");
  assert.doesNotMatch(observe, /DELETE\s+FROM\s+mcp_rate/i, "rateHit must not delete on the request path");
  assert.ok(retentionStatements(2_000_000_000).some(([sql]) => /^DELETE FROM mcp_rate WHERE window_start < \?$/.test(sql)));
});
