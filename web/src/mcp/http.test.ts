/**
 * The /mcp endpoint through the real SDK handler, for both protocol eras:
 * off-switch, Host and Origin checks, the 401 discovery challenge, scope-based
 * tool listing, per-call authorization, cross-owner isolation, rate limits,
 * and the structured output contract.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as z from "zod";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { handleMcpRequest } from "./http";
import {
  ACCOUNT_A, ACCOUNT_B, OWNER_A, OWNER_B, SLUG_A, SLUG_B, connectAs, errorOf, installFixtures, makeDeps, makeTestDb, mcpRequest, rpcResult, testConfig, type Era,
} from "./testing";
import { resetMetricsForTest } from "./observe";
import { McpError } from "./errors";
import { ADVERTISED_SCOPES } from "./scopes";
import { buildServer, principalOf } from "./server";
import type { ResourceDef } from "./resources";
import { defineTool, runTool } from "./tool";

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
  // Clients request exactly this scope, and consent can offer only what was
  // requested: it names every grantable scope (write and sensitive ones
  // included, which the consent page leaves to the owner), never staff.
  const asked = (/scope="([^"]*)"/.exec(challenge)?.[1] ?? "").split(" ");
  assert.deepEqual(asked, [...ADVERTISED_SCOPES]);
  for (const s of ["trade:propose", "drafts:write", "social:write", "jobs:run", "notifications:manage", "watchlist:manage"]) assert.ok(asked.includes(s), s);
  assert.ok(!asked.includes("staff:diagnostics"));
  const bad = await call(mcpRequest(`mcp_at_${"x".repeat(43)}`, "tools/list"));
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  assert.match(bad.headers.get("www-authenticate") ?? "", /trade:propose/, "a reconnect after a revoked token asks for everything too");
});

test("CORS: a configured browser origin can read every real answer, not only the preflight", async () => {
  const { a } = await setup();
  const cfg = testConfig({ allowedOrigins: new Set(["https://app.test", "https://inspector.example"]) });
  const at = (req: Request) => handleMcpRequest(req, { cfg, now: () => NOW });
  const origin = { origin: "https://inspector.example" };
  const expectCors = (res: Response, what: string) => {
    assert.equal(res.headers.get("access-control-allow-origin"), "https://inspector.example", what);
    assert.match(res.headers.get("vary") ?? "", /\bOrigin\b/, what);
    const exposed = (res.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    for (const h of ["www-authenticate", "mcp-session-id", "x-trace-id", "retry-after"]) assert.ok(exposed.includes(h), `${what}: ${h}`);
    assert.equal(res.headers.get("access-control-allow-credentials"), null, what);
  };
  const ok = await at(mcpRequest(a.tokens.access_token, "tools/list", {}, { headers: origin }));
  assert.equal(ok.status, 200);
  expectCors(ok, "200");
  await ok.text();
  const challenge = await at(mcpRequest(null, "tools/list", {}, { headers: origin }));
  assert.equal(challenge.status, 401);
  expectCors(challenge, "401 (discovery)");
  const invalid = await at(mcpRequest(`mcp_at_${"x".repeat(43)}`, "tools/list", {}, { headers: origin }));
  expectCors(invalid, "401 invalid_token");
  let limited: Response | null = null;
  for (let i = 0; i < 245 && limited?.status !== 429; i++) {
    const r = await at(mcpRequest(a.tokens.access_token, "tools/list", {}, { headers: origin }));
    if (r.status === 429) limited = r;
    else await r.text();
  }
  assert.equal(limited?.status, 429);
  expectCors(limited!, "429");
  // A server-side client (no Origin) and a foreign origin get no CORS headers.
  const plain = await at(mcpRequest(null, "tools/list"));
  assert.equal(plain.headers.get("access-control-allow-origin"), null);
  const foreign = await at(mcpRequest(null, "tools/list", {}, { headers: { origin: "https://evil.test" } }));
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers.get("access-control-allow-origin"), null);
});

for (const era of ["legacy", "modern"] as Era[]) {
  test(`${era}: tools, resources and prompts do not promise list_changed notifications the stateless server cannot send`, async () => {
    const { a } = await setup();
    const res = era === "legacy"
      ? await rpcResult(await call(mcpRequest(a.tokens.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } })))
      : await rpcResult(await call(mcpRequest(a.tokens.access_token, "server/discover", {}, { era })));
    const caps = res.result?.capabilities as Record<string, { listChanged?: boolean }> | undefined;
    assert.ok(caps, JSON.stringify(res));
    for (const k of ["tools", "resources", "prompts"]) assert.equal(caps[k]?.listChanged, false, `${k}: ${JSON.stringify(caps)}`);
  });

  test(`${era}: resources/read of another owner's object is resource-not-found (-32602 {uri}), exactly like an absent one`, async () => {
    const { a } = await setup();
    const foreign = `merrymen://agents/${SLUG_B}/portfolio`;
    const res = await rpcResult(await call(mcpRequest(a.tokens.access_token, "resources/read", { uri: foreign }, { era })));
    const err = res.error as { code: number; message: string; data?: unknown } | undefined;
    assert.equal(err?.code, -32602, JSON.stringify(res));
    assert.deepEqual(err?.data, { uri: foreign });
    assert.ok(!JSON.stringify(res).includes(ACCOUNT_B));
    const absent = await rpcResult(await call(mcpRequest(a.tokens.access_token, "resources/read", { uri: "merrymen://nothing/here" }, { era })));
    assert.equal(absent.error?.code, err?.code);
    assert.deepEqual(Object.keys((absent.error as { data?: object }).data ?? {}), ["uri"]);
  });

  test(`${era}: a failed resources/read keeps its stable code: bad input is -32602, a retryable failure keeps retry_after_s`, async () => {
    const { deps } = await setup();
    const b = await connectAs(deps, OWNER_B, { scopes: ["market:read"], agents: [SLUG_B] });
    const probe: ResourceDef = {
      name: "probe", title: "Probe", description: "test", mimeType: "text/plain", capability: "market.read", uri: "merrymen://probe/{kind}",
      async read(_uri, vars) {
        if (vars.kind === "bad") throw new McpError("invalid_input", "kind is malformed");
        if (vars.kind === "busy") throw new McpError("rate_limited", "slow down", { retryAfterSec: 7 });
        if (vars.kind === "gone") throw new McpError("not_found", "No such probe.");
        return { text: "ok", mimeType: "text/plain" };
      },
    };
    const handler = createMcpHandler(({ authInfo }) => buildServer(principalOf(authInfo), { tools: [], resources: [probe], deps: { now: () => NOW } }), { legacy: "stateless", responseMode: "auto" });
    const read = async (kind: string) => (await rpcResult(await handleMcpRequest(mcpRequest(b.tokens.access_token, "resources/read", { uri: `merrymen://probe/${kind}` }, { era }), {
      cfg: testConfig(), now: () => NOW, fetch: (r, auth) => handler.fetch(r, { authInfo: auth }),
    }))).error as { code: number; message: string; data?: Record<string, unknown> } | undefined;
    const bad = await read("bad");
    assert.equal(bad?.code, -32602);
    assert.equal(bad?.data?.code, "invalid_input");
    assert.equal(bad?.data?.retryable, false);
    assert.ok(!("uri" in (bad?.data ?? {})), "not mistaken for resource-not-found");
    const busy = await read("busy");
    assert.equal(busy?.code, -32603);
    assert.equal(busy?.data?.code, "rate_limited");
    assert.equal(busy?.data?.retryable, true);
    assert.equal(busy?.data?.retry_after_s, 7);
    const gone = await read("gone");
    assert.equal(gone?.code, -32602);
    assert.deepEqual(gone?.data, { uri: "merrymen://probe/gone" });
    assert.match(gone?.message ?? "", /not_found/);
  });
}

test("a timed-out tool call cannot start new database work: the abandoned handler stops at its next statement", async () => {
  const { d, a } = await setup();
  let resume!: () => void;
  const paused = new Promise<void>((r) => { resume = r; });
  let finished!: () => void;
  const done = new Promise<void>((r) => { finished = r; });
  const after: string[] = [];
  let beforeTimeout = "";
  const probe = defineTool({
    name: "slow_probe", title: "Slow probe", description: "test", capability: "market.read",
    input: z.object({}).strict(), output: z.object({ ok: z.boolean() }),
    annotations: { readOnlyHint: true, openWorldHint: false }, timeoutMs: 20,
    async handler(_args, ctx) {
      try {
        const m = await ctx.mcp();
        beforeTimeout = JSON.stringify(await m.db.prepare("SELECT 1 AS one").get());
        await paused; // the call times out while the handler is busy elsewhere
        const steps: Array<[string, () => Promise<unknown>]> = [
          ["statement", () => m.db.prepare("SELECT 1").get()],
          ["transaction", () => m.db.tx(async (db) => db.prepare("SELECT 1").get())],
          ["mcp()", () => ctx.mcp()],
          ["ledger", () => ctx.ledger((db) => db.prepare("SELECT 1").get())],
          ["agent()", () => ctx.agent()],
          ["agents()", () => ctx.agents()],
        ];
        for (const [name, step] of steps) {
          try {
            await step();
            after.push(`${name}: ran`);
          } catch (e) {
            after.push(`${name}: ${e instanceof McpError ? e.code : String(e)}`);
          }
        }
        return { data: { ok: true } };
      } finally {
        finished();
      }
    },
  });
  const res = await runTool(probe, {}, a.principal, "trace-t", { now: () => NOW, mcp: async () => d, ledger: (fn) => fn(d.db) });
  assert.equal(errorOf(res).code, "timeout");
  assert.equal(beforeTimeout, JSON.stringify({ one: 1 }), "work before the timeout ran normally");
  resume();
  await done;
  assert.deepEqual(after, ["statement: timeout", "transaction: timeout", "mcp(): timeout", "ledger: timeout", "agent(): timeout", "agents(): timeout"]);
  // The call itself is still audited (runTool's own handle, not the handler's).
  const audited = d.raw.prepare("SELECT outcome FROM mcp_audit WHERE action = 'tool:slow_probe'").all() as Array<{ outcome: string }>;
  assert.deepEqual(audited.map((r) => r.outcome), ["timeout"]);
});

test("a tool that settles after a timeout (send_message) can still store what its paid call produced", async () => {
  const { d, a } = await setup();
  let resume!: () => void;
  const paused = new Promise<void>((r) => { resume = r; });
  let finished!: (v: string) => void;
  const done = new Promise<string>((r) => { finished = r; });
  const probe = defineTool({
    name: "settling_probe", title: "Settling probe", description: "test", capability: "market.read",
    input: z.object({}).strict(), output: z.object({ ok: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, timeoutMs: 20, settlesAfterTimeout: true,
    async handler(_args, ctx) {
      const m = await ctx.mcp();
      const settle = await ctx.settleMcp!();
      await paused; // the model answers after the client was told "timeout"
      const outcome: string[] = [];
      for (const [name, db] of [["guarded", m.db], ["settle", settle.db]] as const) {
        try {
          await db.prepare(`INSERT INTO mcp_rate (bucket, window_start, hits) VALUES ('settle-probe-${name}', 1, 1)`).run();
          outcome.push(`${name}: stored`);
        } catch (e) {
          outcome.push(`${name}: ${e instanceof McpError ? e.code : String(e)}`);
        }
      }
      finished(outcome.join(", "));
      return { data: { ok: true } };
    },
  });
  const res = await runTool(probe, {}, a.principal, "trace-s", { now: () => NOW, mcp: async () => d, ledger: (fn) => fn(d.db) });
  assert.equal(errorOf(res).code, "timeout");
  resume();
  // Only the settle handle outlives the timeout; ctx.mcp() still stops.
  assert.equal(await done, "guarded: timeout, settle: stored");
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM mcp_rate WHERE bucket LIKE 'settle-probe-%'").get() as { n: number }).n, 1);
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
