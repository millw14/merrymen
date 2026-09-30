import test from "node:test";
import assert from "node:assert/strict";
import { createPartnerBridge } from "./partner-bridge.mjs";
import { createPartnerApi } from "./partner-api.mjs";

const key = { appId: "partner_app_123", keyId: "abcdefghjkmn", name: "Test App", scopes: ["read:agents", "write:agents", "chat:agents"] };
const secret = "partner-test-secret-with-at-least-32-characters";
test("bridge forwards only signed context to a fixed origin and refuses redirects", async () => {
  const forward = createPartnerBridge({ secret, fetchImpl: async (url, options) => {
    assert.equal(url, "https://app.merrymen.dev/api/partner/agents");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, undefined);
    assert.equal(options.headers.cookie, undefined);
    assert.equal(options.body, '{"external_user_id":"one"}');
    const context = JSON.parse(Buffer.from(options.headers["x-merrymen-partner-context"], "base64url"));
    assert.equal(context.app_id, key.appId);
    assert.equal(context.key_id, key.keyId);
    assert.ok(!JSON.stringify(options).includes("mmp_"));
    return Response.json({ id: "pa_test", status: "pending_authorization" }, { status: 202 });
  } });
  assert.equal((await forward({ key, method: "POST", path: "/agents", body: '{"external_user_id":"one"}' })).status, 202);
  for (const origin of ["http://remote.example", "https://user:password@app.example", "https://app.example/path"]) assert.throws(() => createPartnerBridge({ secret, origin }));
});
test("upstream failures never reflect credentials or provider details", async () => {
  const forward = createPartnerBridge({ secret, fetchImpl: async () => { throw new Error("secret=hidden-provider-secret"); } });
  const result = await forward({ key, method: "GET", path: "/agents" });
  assert.equal(result.status, 503);
  assert.ok(!JSON.stringify(result).includes("hidden-provider-secret"));
});
test("every agent operation enforces its distinct scope before forwarding", async () => {
  let actualKey = key, forwards = 0;
  const api = createPartnerApi({ partners: { verify: async () => ({ ok: true, key: actualKey }), allows: (k, scope) => k.scopes.includes(scope) },
    store: { rateHit: async () => true }, forward: async () => { forwards++; return { status: 200, json: {} }; } });
  const routes = [["POST", "/agents", "write:agents"], ["GET", "/agents", "read:agents"], ["GET", "/agents/pa_123456789abc", "read:agents"],
    ["POST", "/agents/pa_123456789abc/challenge", "write:agents"], ["POST", "/agents/pa_123456789abc/activate", "write:agents"],
    ["POST", "/agents/pa_123456789abc/messages", "chat:agents"], ["GET", "/agents/pa_123456789abc/messages", "chat:agents"],
    ["DELETE", "/agents/pa_123456789abc/connection", "write:agents"]];
  for (const [method, path, scope] of routes) {
    actualKey = { ...key, scopes: key.scopes.filter(s => s !== scope) };
    const before = forwards;
    assert.equal((await api.handle({ method, pathname: `/partner/v1${path}` })).status, 403);
    assert.equal(forwards, before);
    actualKey = { ...key, scopes: [scope] };
    assert.equal((await api.handle({ method, pathname: `/partner/v1${path}` })).status, 200);
    assert.equal(forwards, before + 1);
  }
});
