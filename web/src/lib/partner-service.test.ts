import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilePartnerStore } from "./partner-store";
import { createPartnerService } from "./partner-service";
import { verifyPartnerRequest } from "./partner-bridge";
// Exercise the actual gateway signer against the app verifier.
import { signPartnerRequest } from "../../../gateway/lib/partner-bridge.mjs";

const secret = "partner-test-bridge-secret-that-is-long-enough";
const key = { appId: "integration_app_a", keyId: "abcdefghjkmn", name: "Test App", scopes: ["read:agents", "write:agents", "chat:agents"] };
const tenant = "0x1111111111111111111111111111111111111111" as const;
const runtime = { exists: true, smart_account: tenant, name: "Robin", slug: "robin", status: "starting" as const,
  mode: null, last_observed_mode: null, worker_alive_at: null, heartbeat_fresh: false, live_blocker: null,
  last_observed_live_blocker: null, strategy: "steady-basket", live_trading_enabled: false, paper_trading_enabled: true, ledger_available: false };
const fixtures: Array<{ home: string; store: FilePartnerStore }> = [];
// Windows clears a WAL database's -shm mapping after close() returns, so a
// zero-retry rmSync rmdir's into ENOTEMPTY under a loaded full-suite run; see the
// cleanup note in partner-store.test.ts. Retry, and close everything even if one
// teardown throws, so a stuck directory cannot strand the rest of this file.
after(() => {
  const failures: unknown[] = [];
  const attempt = (fn: () => void) => { try { fn(); } catch (error) { failures.push(error); } };
  for (const { store } of fixtures) attempt(() => store.close());
  for (const { home } of fixtures) attempt(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  if (failures.length) throw failures[0];
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "merrymen-partner-service-"));
  const store = new FilePartnerStore(home, undefined, () => secret);
  fixtures.push({ home, store });
  let replies = 0;
  const service = createPartnerService({ store, secret,
    readRuntime: async () => runtime,
    reply: async (actualTenant, { message }) => {
      assert.equal(actualTenant, tenant);
      replies++;
      await Promise.resolve();
      return { reply: `Received ${message}`, generation: "model", runtime };
    },
  });
  const call = async (method: string, path: string, body?: unknown, selectedKey = key) => {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers = signPartnerRequest({ secret, key: selectedKey, method, path, body: raw });
    const response = await service.handle(new Request(`https://app.merrymen.dev/api/partner${path}`, { method, headers, ...(raw ? { body: raw } : {}) }), path);
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { store, call, service, replies: () => replies };
}

test("gateway signatures bind exact method, body, path and principal, and reject replay", async () => {
  const path = "/agents", raw = '{"external_user_id":"user-1"}';
  const headers = signPartnerRequest({ secret, key, method: "POST", path, body: raw });
  const req = new Request("https://app.merrymen.dev/api/partner/agents", { method: "POST", headers, body: raw });
  const used = new Set<string>();
  const consumeNonce = async (n: string) => { if (used.has(n)) return false; used.add(n); return true; };
  for (const [request, body, route] of [
    [req, raw + " ", path], [req, raw, "/agents/other"],
    [new Request(req.url, { method: "GET", headers }), raw, path],
  ] as const) await assert.rejects(verifyPartnerRequest(request, body, route, { secret, consumeNonce }), /Invalid gateway/);
  assert.equal(used.size, 0);
  assert.equal((await verifyPartnerRequest(req, raw, path, { secret, consumeNonce })).app_id, key.appId);
  await assert.rejects(verifyPartnerRequest(req, raw, path, { secret, consumeNonce }), /already used/);
  const old = signPartnerRequest({ secret, key, method: "POST", path, body: raw, now: Date.now() - 65_000 });
  await assert.rejects(verifyPartnerRequest(new Request(req.url, { method: "POST", headers: old }), raw, path, { secret, consumeNonce }), /Invalid gateway/);
});

test("direct requests cannot forge a tenant, app identity or gateway principal", async () => {
  const { service } = fixture();
  const r = await service.handle(new Request("https://app.merrymen.dev/api/partner/agents", {
    method: "POST", headers: { "x-tenant": tenant, "authorization": "Bearer fake", "cookie": "mm_session=fake" },
    body: JSON.stringify({ external_user_id: "u1" }),
  }), "/agents");
  assert.equal(r.status, 401);
});

test("create is repeatable and never accepts caller-supplied ownership or private fields", async () => {
  const { call } = fixture();
  const first = await call("POST", "/agents", { external_user_id: "user-1", name: "Robin" });
  const retry = await call("POST", "/agents", { external_user_id: "user-1", name: "Robin" });
  assert.equal(first.status, 202);
  assert.deepEqual(retry.body, first.body);
  assert.equal(first.body.status, "pending_authorization");
  assert.match(first.body.onboarding_url, /^https:\/\/app\.merrymen\.dev\/connect#token=/);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.ok(!JSON.stringify(first.body).includes("tokenHash"));
  assert.equal((await call("POST", "/agents", { external_user_id: "u2", tenant })).status, 400);
  assert.equal((await call("POST", "/agents", { external_user_id: "u2", grant: {} })).status, 400);
  assert.equal((await call("POST", "/agents", { external_user_id: "u2" }, { ...key, scopes: ["read:agents"] })).status, 403);
});

test("pending agents cannot chat; other apps cannot read or activate their connections", async () => {
  const { call } = fixture();
  const created = await call("POST", "/agents", { external_user_id: "user-1" });
  const path = `/agents/${created.body.id}`;
  assert.equal((await call("POST", `${path}/messages`, { message: "hello", request_id: "request_1" })).status, 409);
  const other = { ...key, appId: "integration_app_b" };
  for (const [method, suffix] of [["GET", ""], ["POST", "/challenge"], ["POST", "/activate"], ["DELETE", "/connection"]]) {
    assert.equal((await call(method, path + suffix, method === "POST" ? {} : undefined, other)).status, 404);
  }
  assert.deepEqual((await call("GET", "/agents", undefined, other)).body, { data: [] });
});

test("chat is grounded to the consented tenant, serialized and idempotent; disconnect revokes access", async () => {
  const { store, call, replies } = fixture();
  const created = await call("POST", "/agents", { external_user_id: "user-1" });
  const id = created.body.id, path = `/agents/${id}`;
  await store.bindAuthorized(id, key.appId, tenant, ["read:agents", "chat:agents"]);
  const results = await Promise.all(Array.from({ length: 5 }, () => call("POST", `${path}/messages`, { message: "status", request_id: "request_1" })));
  assert.ok(results.every(r => r.status === 200));
  assert.equal(replies(), 1);
  assert.ok(results.every(r => JSON.stringify(r.body) === JSON.stringify(results[0].body)));
  assert.equal((await call("POST", `${path}/messages`, { message: "different", request_id: "request_1" })).status, 409);
  assert.equal((await call("GET", `${path}/messages`)).body.messages.length, 2);
  const detail = await call("GET", path);
  assert.equal(detail.body.status, "starting");
  assert.equal(detail.body.agent.heartbeat_fresh, false);
  assert.ok(!JSON.stringify(detail.body).includes(tenant));
  assert.equal((await call("DELETE", `${path}/connection`)).status, 200);
  assert.equal((await call("GET", `${path}/messages`)).status, 409);
  assert.equal((await call("POST", `${path}/messages`, { message: "status", request_id: "request_2" })).status, 409);
  assert.equal(replies(), 1);
});

test("key chat scope cannot substitute for owner consent", async () => {
  const { store, call } = fixture();
  const created = await call("POST", "/agents", { external_user_id: "user-1" }, { ...key, scopes: ["write:agents", "read:agents"] });
  const id = created.body.id;
  await store.bindAuthorized(id, key.appId, tenant, ["read:agents"]);
  assert.equal((await call("POST", `/agents/${id}/messages`, { message: "hi", request_id: "request_1" })).status, 403);
});

test("body limits apply before parsing or signature verification", async () => {
  const { service } = fixture();
  const r = await service.handle(new Request("https://app.merrymen.dev/api/partner/agents", { method: "POST", body: "x".repeat(32_769) }), "/agents");
  assert.equal(r.status, 413);
});
