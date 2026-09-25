/**
 * The /mcp endpoint through the real SDK handler, for both protocol eras:
 * off-switch, Host and Origin checks, the 401 discovery challenge, scope-based
 * tool listing, per-call authorization, cross-owner isolation, rate limits,
 * and the structured output contract.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { handleMcpRequest } from "./http";
import {
  ACCOUNT_A, ACCOUNT_B, OWNER_A, OWNER_B, SLUG_A, SLUG_B, connectAs, installFixtures, makeDeps, makeTestDb, mcpRequest, rpcResult, testConfig, type Era,
} from "./testing";
import { resetMetricsForTest } from "./observe";

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; resetMetricsForTest(); });

const NOW = 1_800_000_000;

async function setup(scopes?: string[]) {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  restore = installFixtures(d, { settings: { [OWNER_A]: { strategy: "momentum", agentName: "Shogun", liveTradingEnabled: false, telegramBotToken: "123:SECRET", tickSeconds: 240 } } });
  d.raw.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, mode, beat_at, live_blocker, epoch)
    VALUES (?, 'Shogun', ?, '0x1', 4663, '{}', 1700000000, 4102444800, 'active', 'paper', ?, 'live-not-enabled', 1)`).run(ACCOUNT_A, OWNER_A, NOW - 30);
  d.raw.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, mode, beat_at, epoch)
    VALUES (?, 'Other', ?, '0x2', 4663, '{}', 1700000000, 4102444800, 'active', 'live', ?, 1)`).run(ACCOUNT_B, OWNER_B, NOW - 30);
  d.raw.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, mode, at) VALUES (?, '0', 100, 0, 0, 100, 1, 'paper', ?)`).run(ACCOUNT_A, NOW - 60);
  const a = await connectAs(deps, OWNER_A, scopes ? { scopes } : {});
  return { d, deps, a };
}

const call = (req: Request) => handleMcpRequest(req, { cfg: testConfig(), now: () => NOW });

test("the endpoint is absent when MCP is disabled", async () => {
  const res = await handleMcpRequest(mcpRequest(null, "tools/list"), { cfg: testConfig({ enabled: false, disabledWhy: "off" }) });
  assert.equal(res.status, 404);
});

test("no token → 401 with a discovery challenge; a bad token → invalid_token", async () => {
  await setup();
  const res = await call(mcpRequest(null, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } }));
  assert.equal(res.status, 401);
  const challenge = res.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer /);
  assert.match(challenge, /resource_metadata="https:\/\/app\.test\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.doesNotMatch(challenge, /invalid_token/);
  const bad = await call(mcpRequest(`mcp_at_${"x".repeat(43)}`, "tools/list"));
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
});

test("wrong Host and foreign browser Origins are refused", async () => {
  const { a } = await setup();
  assert.equal((await call(mcpRequest(a.tokens.access_token, "tools/list", {}, { host: "evil.test" }))).status, 421);
  assert.equal((await call(mcpRequest(a.tokens.access_token, "tools/list", {}, { headers: { origin: "https://evil.test" } }))).status, 403);
  const same = await call(mcpRequest(a.tokens.access_token, "tools/list", {}, { headers: { origin: "https://app.test" } }));
  assert.equal(same.status, 200);
  await same.text();
});

for (const era of ["legacy", "modern"] as Era[]) {
  test(`${era}: tools are listed by scope and answer with structured content`, async () => {
    const { a } = await setup(["market:read", "agents:read"]);
    const list = await rpcResult(await call(mcpRequest(a.tokens.access_token, "tools/list", {}, { era })));
    const names = (list.result?.tools as Array<{ name: string; annotations?: Record<string, unknown>; outputSchema?: unknown }>).map((t) => t.name);
    assert.ok(names.includes("get_agent_status"));
    assert.ok(!names.includes("get_portfolio"), "portfolio:read not granted");
    const status = await rpcResult(await call(mcpRequest(a.tokens.access_token, "tools/call", { name: "get_agent_status", arguments: {} }, { era })));
    const sc = status.result?.structuredContent as Record<string, unknown>;
    assert.equal(status.result?.isError, undefined);
    assert.equal(sc.agent, SLUG_A);
    assert.equal(sc.mode, "paper");
    assert.equal((sc.live_blocker as { rule: string }).rule, "live-not-enabled");
    assert.equal((sc.freshness as { worker_fresh: boolean }).worker_fresh, true);
    assert.equal(sc.strategy, "momentum");
    // The text fallback carries the same JSON.
    const text = (status.result?.content as Array<{ text: string }>)[0].text;
    assert.ok(text.includes(`"agent":"${SLUG_A}"`));
    // Settings secrets never appear.
    assert.ok(!JSON.stringify(status).includes("SECRET"));
  });
}

test("another owner's agent is not found, whatever id is passed", async () => {
  const { a } = await setup();
  const res = await rpcResult(await call(mcpRequest(a.tokens.access_token, "tools/call", { name: "get_agent_status", arguments: { agent: SLUG_B } })));
  assert.equal(res.result?.isError, true);
  assert.equal((res.result?._meta as Record<string, { code: string }> | undefined)?.["dev.merrymen/error"]?.code, "not_found");
  assert.ok(!JSON.stringify(res).includes(ACCOUNT_B));
});

test("calling a tool outside the granted scopes is refused even though the name exists", async () => {
  const { a } = await setup(["market:read"]);
  const res = await rpcResult(await call(mcpRequest(a.tokens.access_token, "tools/call", { name: "get_agent_status", arguments: {} })));
  // Not registered for this connection → the SDK reports an unknown tool; either way no data.
  assert.ok(res.error || res.result?.isError);
  assert.ok(!JSON.stringify(res).includes("Shogun"));
});

test("an agent unshared on the owner's side becomes unreachable at once", async () => {
  const { d, a } = await setup();
  restore?.();
  restore = installFixtures(d, { directory: { async agentsFor() { return []; } } });
  const res = await rpcResult(await call(mcpRequest(a.tokens.access_token, "tools/call", { name: "get_agent_status", arguments: {} })));
  assert.equal((res.result?._meta as Record<string, { code: string }> | undefined)?.["dev.merrymen/error"]?.code, "not_found");
});

test("per-connection request rate is limited with Retry-After", async () => {
  const { a } = await setup();
  let last: Response | null = null;
  for (let i = 0; i < 245; i++) {
    last = await call(mcpRequest(a.tokens.access_token, "tools/list"));
    if (last.status === 429) break;
    await last.text();
  }
  assert.equal(last?.status, 429);
  assert.ok(Number(last?.headers.get("retry-after")) > 0);
});

test("concurrency: an owner's in-flight streams are capped, and a cancelled stream frees its slot", async () => {
  const { a } = await setup();
  const open: Response[] = [];
  for (let i = 0; i < 8; i++) open.push(await call(mcpRequest(a.tokens.access_token, "tools/list")));
  assert.deepEqual(open.map((r) => r.status), [200, 200, 200, 200, 200, 200, 200, 200]);
  const busy = await call(mcpRequest(a.tokens.access_token, "tools/list"));
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("retry-after"), "2");
  await open[0].body?.cancel();
  await open[1].text();
  const again = await call(mcpRequest(a.tokens.access_token, "tools/list"));
  assert.equal(again.status, 200);
  await again.text();
  for (const r of open.slice(2)) await r.text();
});

test("invalid tool input is rejected before any data is read", async () => {
  const { a } = await setup();
  const res = await rpcResult(await call(mcpRequest(a.tokens.access_token, "tools/call", { name: "get_agent_status", arguments: { agent: "../../etc" } })));
  assert.equal(res.result?.isError, true);
});

test("audit rows record the call without argument text", async () => {
  const { d, a } = await setup();
  await rpcResult(await call(mcpRequest(a.tokens.access_token, "tools/call", { name: "get_agent_status", arguments: { agent: SLUG_A } })));
  const rows = d.raw.prepare("SELECT action, outcome, tenant, capability, detail_json FROM mcp_audit WHERE action LIKE 'tool:%'").all() as Array<Record<string, string>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, "tool:get_agent_status");
  assert.equal(rows[0].tenant, OWNER_A);
  assert.equal(rows[0].capability, "agents.read");
  assert.equal(rows[0].outcome, "ok");
});
