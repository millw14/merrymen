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
  const lines = [];
  const forward = createPartnerBridge({ secret, log: line => lines.push(line), fetchImpl: async () => { throw new Error("secret=hidden-provider-secret"); } });
  const result = await forward({ key, method: "GET", path: "/agents" });
  assert.equal(result.status, 503);
  assert.ok(!JSON.stringify(result).includes("hidden-provider-secret"));
  assert.ok(!lines.join("\n").includes("hidden-provider-secret"), "the log carries the error's name, never its message");
});
/** A bridge whose upstream answers `respond()` and whose log is captured. */
function bridge(respond, options = {}) {
  const lines = [];
  return { lines, forward: createPartnerBridge({ secret, log: line => lines.push(line), fetchImpl: async (_url, init) => respond(init), ...options }) };
}
test("an upstream that answers without its JSON is told apart from one that never answers", async () => {
  // The production incident: the web app's cross-site block answered every
  // forwarded POST with a text/plain 403, and the partner and the operator
  // both saw only "temporarily unavailable".
  const refused = bridge(() => new Response("Forbidden: cross-site request", { status: 403, headers: { "content-type": "text/plain" } }));
  const answer = await refused.forward({ key, method: "POST", path: "/agents", body: "{}", requestId: "req_0123456789ab" });
  assert.equal(answer.status, 503);
  assert.equal(answer.json.error.code, "upstream_invalid_response");
  assert.ok(!JSON.stringify(answer).includes("Forbidden"), "an upstream body is never relayed");
  assert.equal(refused.lines.length, 1);
  for (const fact of ["POST /agents", "req_0123456789ab", key.keyId, "HTTP 403", "text/plain"]) assert.ok(refused.lines[0].includes(fact), fact);
  for (const kept of [secret, "Forbidden", "x-merrymen-partner-signature"]) assert.ok(!refused.lines[0].includes(kept), kept);

  const offline = bridge(() => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:3000"), { code: "ECONNREFUSED" }) }); });
  const none = await offline.forward({ key, method: "GET", path: "/agents" });
  assert.equal(none.status, 503); assert.equal(none.json.error.code, "upstream_unavailable");
  assert.match(offline.lines[0], /got no answer: TypeError \(ECONNREFUSED\)/);

  // A raw object, because Response itself refuses the CR/LF a hostile proxy could send.
  const forged = { status: 502, headers: new Map([["content-type", "text/html\r\n[gateway] forged line"]]), text: async () => "<html>Bad gateway</html>" };
  for (const respond of [() => new Response("null"), () => forged]) {
    const odd = bridge(respond);
    assert.equal((await odd.forward({ key, method: "GET", path: "/agents" })).json.error.code, "upstream_invalid_response");
    assert.ok(!odd.lines[0].includes("\n") && !odd.lines[0].includes("\r"), "a header cannot add a log line");
  }
  const cut = bridge(() => new Response(new ReadableStream({ start: c => c.error(new Error("socket hang up")) }), { status: 200 }));
  assert.equal((await cut.forward({ key, method: "GET", path: "/agents" })).json.error.code, "upstream_unavailable");
  assert.match(cut.lines[0], /answered HTTP 200, then its body failed/);
});
test("the runtime's own JSON is relayed untouched; its 5xx is logged; a missing secret is named", async () => {
  const ok = bridge(() => Response.json({ data: [] }));
  assert.deepEqual(await ok.forward({ key, method: "GET", path: "/agents" }), { status: 200, json: { data: [] } });
  assert.deepEqual(ok.lines, []);
  const failing = bridge(() => Response.json({ error: { code: "storage_unavailable", message: "Try later" } }, { status: 503 }));
  assert.equal((await failing.forward({ key, method: "GET", path: "/agents" })).json.error.code, "storage_unavailable");
  assert.match(failing.lines[0], /HTTP 503 storage_unavailable/);
  let sent = false;
  const unset = bridge(() => { sent = true; return Response.json({}); }, { secret: "short" });
  assert.equal((await unset.forward({ key, method: "GET", path: "/agents" })).json.error.code, "upstream_unavailable");
  assert.equal(sent, false);
  assert.match(unset.lines[0], /MERRYMEN_PARTNER_BRIDGE_SECRET/);
});
test("the request_id a partner reports is the one in the operator's log", async () => {
  const refused = bridge(() => new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } }));
  const api = createPartnerApi({ partners: { verify: async () => ({ ok: true, key }), allows: () => true },
    store: { rateHit: async () => true }, forward: refused.forward });
  const answer = await api.handle({ method: "GET", pathname: "/partner/v1/agents" });
  assert.equal(answer.json.error.code, "upstream_invalid_response");
  assert.ok(refused.lines[0].includes(answer.json.error.request_id));
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
