/**
 * The /mcp endpoint through the real SDK handler, for both protocol eras:
 * off-switch, Host and Origin checks, the 401 discovery challenge, scope-based
 * tool listing, per-call authorization, cross-owner isolation, rate limits,
 * and the structured output contract.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import * as z from "zod";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { handleMcpRequest } from "./http";
import {
  ACCOUNT_A, ACCOUNT_B, MODEL_INSTRUCTION, OTHER_TOOLS, OWNER_A, OWNER_B, SLUG_A, SLUG_B, connectAs, errorOf, installFixtures, makeDeps, makeTestDb, mcpRequest, rpcResult, schemaDescriptions, testConfig, toolNamePattern, type Era,
} from "./testing";
import { resetMetricsForTest } from "./observe";
import { McpError } from "./errors";
import { ADVERTISED_SCOPES, SCOPES, capabilityAllowedIn, scopeFor } from "./scopes";
import { buildServer, principalOf, resourceInProfile, toolInProfile } from "./server";
import { APP_RESOURCES, APP_VIEW_URI } from "./apps";
import { ALL_TOOLS } from "./tools";
import { ALL_RESOURCES } from "./resources-catalog";
import { hasCapability, requireCapability } from "./policy";
import type { Principal } from "./oauth/server";
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

test("the 401 without a token says what to do in plain words, with the help page, not \"sign in\" (the website sign-in never helps here)", async () => {
  const res = await call(mcpRequest(null, "tools/list"));
  assert.equal(res.status, 401);
  const body = await res.json() as { error: string; error_description: string };
  assert.equal(body.error, "unauthorized");
  assert.equal(body.error_description, "Add this server to your assistant as a connector, then sign in to Merrymen when it asks. Help: https://app.test/connect/mcp");
});

/** A person opening the server address in a browser tab. */
function pageLoad(host: string, o: { method?: string; headers?: Record<string, string> } = {}): Request {
  return new Request(`https://${host}/mcp`, {
    method: o.method ?? "GET",
    headers: { host, accept: "text/html,application/xhtml+xml,*/*;q=0.8", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none", ...o.headers },
  });
}

test("the server address opened in a browser goes to the connect help page on the issuer, on both hosts", async () => {
  const cfg = testConfig({ resource: "https://mcp.test/mcp", allowedHosts: new Set(["app.test", "mcp.test"]), allowedOrigins: new Set(["https://app.test", "https://mcp.test"]) });
  const at = (req: Request) => handleMcpRequest(req, { cfg, now: () => NOW });
  for (const host of ["mcp.test", "app.test"]) {
    for (const method of ["GET", "HEAD"]) {
      const res = await at(pageLoad(host, { method }));
      assert.equal(res.status, 307, `${method} ${host}`);
      assert.equal(res.headers.get("location"), "https://app.test/connect/mcp", `${method} ${host}`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("www-authenticate"), null, "a page, not a challenge");
    }
  }
  // A browser without Sec-Fetch headers is known by its Accept.
  const old = await at(new Request("https://mcp.test/mcp", { headers: { host: "mcp.test", accept: "text/html" } }));
  assert.equal(old.status, 307);
});

test("every client request to /mcp still meets the Host, Origin and bearer checks", async () => {
  const { a } = await setup();
  // The resource stays testConfig's (the token is bound to it); only the host is added.
  const cfg = testConfig({ allowedHosts: new Set(["app.test", "mcp.test"]) });
  const at = (req: Request) => handleMcpRequest(req, { cfg, now: () => NOW });
  const challenged = (res: Response, what: string) => {
    assert.equal(res.status, 401, what);
    assert.match(res.headers.get("www-authenticate") ?? "", /^Bearer resource_metadata=/, what);
  };
  // The 2025-era GET stream and a plain GET: no token → the discovery challenge, as before.
  challenged(await at(new Request("https://mcp.test/mcp", { headers: { host: "mcp.test", accept: "text/event-stream" } })), "GET text/event-stream");
  challenged(await at(new Request("https://mcp.test/mcp", { headers: { host: "mcp.test", accept: "*/*" } })), "GET */*");
  // A fetch() from a page asking for HTML is not a page load.
  challenged(await at(new Request("https://mcp.test/mcp", { headers: { host: "mcp.test", accept: "text/html", "sec-fetch-dest": "empty" } })), "fetch()");
  // A form POST from a page is not either.
  challenged(await at(pageLoad("mcp.test", { method: "POST" })), "POST");
  // Page-load headers plus a token or an MCP header: a client, and the token is checked.
  const bad = await at(pageLoad("mcp.test", { headers: { authorization: `Bearer mcp_at_${"x".repeat(43)}` } }));
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  challenged(await at(pageLoad("mcp.test", { headers: { "mcp-protocol-version": "2025-06-18" } })), "MCP-Protocol-Version");
  const ok = await at(mcpRequest(a.tokens.access_token, "tools/list", {}, { host: "mcp.test" }));
  assert.equal(ok.status, 200);
  await ok.text();
  // The earlier checks come first, for a browser too: nothing redirects past them.
  assert.equal((await at(pageLoad("evil.test"))).status, 421);
  assert.equal((await at(pageLoad("mcp.test", { headers: { origin: "https://evil.test" } }))).status, 403);
  assert.equal((await handleMcpRequest(pageLoad("mcp.test"), { cfg: testConfig({ enabled: false, disabledWhy: "off" }) })).status, 404);
});

test("serverInfo offers the current SVG mark, a file the app serves", async () => {
  const { a } = await setup();
  // buildServer reads the issuer from the environment, which these tests leave unset.
  const saved = process.env.MERRYMEN_PUBLIC_ORIGIN;
  process.env.MERRYMEN_PUBLIC_ORIGIN = "https://app.test";
  try {
    const res = await rpcResult(await call(mcpRequest(a.tokens.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } })));
    const icons = (res.result?.serverInfo as { icons?: Array<{ src: string; mimeType: string; sizes: string[] }> } | undefined)?.icons ?? [];
    assert.deepEqual(icons.map((i) => [i.src, i.mimeType, i.sizes.join(" ")]), [
      ["https://app.test/mcp-icon.svg", "image/svg+xml", "any"],
    ]);
    // Only the SVG: the PNG app icons still carry the old mark until PR #166 regenerates them.
    for (const icon of icons) {
      assert.match(readFileSync(new URL(`../../public${new URL(icon.src).pathname}`, import.meta.url), "utf8"), /<svg/, icon.src);
    }
  } finally {
    if (saved === undefined) delete process.env.MERRYMEN_PUBLIC_ORIGIN;
    else process.env.MERRYMEN_PUBLIC_ORIGIN = saved;
  }
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

// ── the directory profile (/mcp/directory) ──────────────────────────────────

/** Every tool reachable with trade:propose, drafts:write or social:write (see scopes.ts and tools/). */
const DIRECTORY_EXCLUDED_TOOLS = [
  "cancel_proposal", "create_agent_draft", "draft_post", "follow_agent", "get_proposal", "list_proposals",
  "propose_settings_change", "propose_trade", "quote_trade", "unfollow_agent",
];
const DIR_PATH = "/mcp/directory";
const callDir = (req: Request, cfg = testConfig()) => handleMcpRequest(req, { cfg, now: () => NOW, profile: "directory" });
const dirRequest = (token: string | null, method: string, params: Record<string, unknown> = {}, o: { era?: Era } = {}) => mcpRequest(token, method, params, { ...o, path: DIR_PATH });
const listNames = async (res: Response) => ((await rpcResult(res)).result?.tools as Array<{ name: string }>).map((t) => t.name);

/** Owner A connected to both addresses from the same app: the full server with trade:propose, and the directory. */
async function setupBoth() {
  const { d, deps, a } = await setup(["market:read", "agents:read", "portfolio:read", "decisions:read", "trade:propose", "drafts:write", "social:write", "offline_access"]);
  const dir = await connectAs(deps, OWNER_A, { profile: "directory", clientId: a.clientId });
  return { d, deps, full: a, dir };
}

/** Force every scope onto a connection and its tokens, as if every check before verification had failed. */
function forceAllScopes(d: Awaited<ReturnType<typeof setup>>["d"], connectionId: string) {
  const all = [...SCOPES.map((s) => s.id)].sort().join(" ");
  d.raw.prepare("UPDATE mcp_connections SET scopes = ? WHERE id = ?").run(all, connectionId);
  d.raw.prepare("UPDATE mcp_tokens SET scopes = ? WHERE connection_id = ?").run(all, connectionId);
}

test("the excluded tools are exactly those reachable with a sensitive scope, and none exists on the directory profile", () => {
  const isStaff = (t: (typeof ALL_TOOLS)[number]) => t.capability === "staff.diagnostics";
  const excluded = ALL_TOOLS.filter((t) => !isStaff(t) && !toolInProfile(t, "directory")).map((t) => t.name).sort();
  assert.deepEqual(excluded, DIRECTORY_EXCLUDED_TOOLS);
  for (const t of ALL_TOOLS) {
    const outside = [t.capability, ...(t.anyOf ?? [])].some((c) => ["trade:propose", "drafts:write", "social:write", "staff:diagnostics"].includes(scopeFor(c)));
    assert.equal(toolInProfile(t, "directory"), !outside, t.name);
    assert.equal(toolInProfile(t, "full"), true, `${t.name} on the full server`);
  }
});

test("directory endpoint: no token → 401 whose challenge names the directory's own metadata and only the scopes it can grant", async () => {
  await setup();
  const res = await callDir(dirRequest(null, "tools/list"));
  assert.equal(res.status, 401);
  const challenge = res.headers.get("www-authenticate") ?? "";
  assert.match(challenge, /resource_metadata="https:\/\/app\.test\/\.well-known\/oauth-protected-resource\/mcp\/directory"/);
  const asked = (/scope="([^"]*)"/.exec(challenge)?.[1] ?? "").split(" ");
  assert.deepEqual(asked, ADVERTISED_SCOPES.filter((s) => !["trade:propose", "drafts:write", "social:write"].includes(s)));
  const bad = await callDir(dirRequest(`mcp_at_${"x".repeat(43)}`, "tools/list"));
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  assert.doesNotMatch(bad.headers.get("www-authenticate") ?? "", /trade:propose/);
  // The canonical endpoint's challenge is unchanged.
  assert.match((await call(mcpRequest(null, "tools/list"))).headers.get("www-authenticate") ?? "", /oauth-protected-resource\/mcp", scope="[^"]*trade:propose/);
});

test("a directory token is refused at /mcp, and a /mcp token at the directory endpoint", async () => {
  const { full, dir } = await setupBoth();
  const fullAtDir = await callDir(dirRequest(full.tokens.access_token, "tools/list"));
  assert.equal(fullAtDir.status, 401);
  assert.match(fullAtDir.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  assert.match(fullAtDir.headers.get("www-authenticate") ?? "", /oauth-protected-resource\/mcp\/directory/);
  const dirAtFull = await call(mcpRequest(dir.tokens.access_token, "tools/list"));
  assert.equal(dirAtFull.status, 401);
  assert.match(dirAtFull.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  // Each works where it belongs.
  assert.ok((await listNames(await call(mcpRequest(full.tokens.access_token, "tools/list")))).includes("propose_trade"));
  assert.ok((await listNames(await callDir(dirRequest(dir.tokens.access_token, "tools/list")))).includes("list_agents"));
});

test("tools/list on the directory endpoint never includes a trade, setting, draft, follow or post tool, even with every scope forced onto the connection", async () => {
  const { d, full, dir } = await setupBoth();
  for (const era of ["legacy", "modern"] as const) {
    const names = await listNames(await callDir(dirRequest(dir.tokens.access_token, "tools/list", {}, { era })));
    for (const t of DIRECTORY_EXCLUDED_TOOLS) assert.ok(!names.includes(t), `${era}: ${t}`);
    assert.ok(names.includes("get_agent_status") && names.includes("get_portfolio"), era);
  }
  // Every earlier check bypassed: the connection and its tokens hold every scope.
  forceAllScopes(d, dir.principal.connectionId);
  forceAllScopes(d, full.principal.connectionId);
  const forced = await listNames(await callDir(dirRequest(dir.tokens.access_token, "tools/list")));
  for (const t of DIRECTORY_EXCLUDED_TOOLS) assert.ok(!forced.includes(t), `forced: ${t}`);
  assert.ok(!forced.some((n) => ALL_TOOLS.find((t) => t.name === n)?.capability === "staff.diagnostics"), "no staff tool either");
  // The same forcing on the full server does list them, so the test would see a leak.
  const fullNames = await listNames(await call(mcpRequest(full.tokens.access_token, "tools/list")));
  for (const t of DIRECTORY_EXCLUDED_TOOLS) assert.ok(fullNames.includes(t), `full: ${t}`);
  // Calling one by name gets no tool.
  for (const name of ["propose_trade", "quote_trade", "follow_agent", "draft_post", "create_agent_draft"]) {
    const res = await rpcResult(await callDir(dirRequest(dir.tokens.access_token, "tools/call", { name, arguments: {} })));
    assert.ok(res.error || res.result?.isError, name);
    assert.ok(!JSON.stringify(res).includes("approval_url"), name);
  }
  // Resources and prompts: nothing that needs an excluded capability.
  const excludedResources = ALL_RESOURCES.filter((r) => r.capability && !capabilityAllowedIn("directory", r.capability)).map((r) => r.uri);
  const resources = (await rpcResult(await callDir(dirRequest(dir.tokens.access_token, "resources/list")))).result?.resources as Array<{ uri: string }>;
  const templates = (await rpcResult(await callDir(dirRequest(dir.tokens.access_token, "resources/templates/list")))).result?.resourceTemplates as Array<{ uriTemplate: string }>;
  for (const uri of excludedResources) {
    assert.ok(!resources.some((r) => r.uri === uri), uri);
    assert.ok(!templates.some((r) => r.uriTemplate === uri), uri);
  }
  // The proposal view needs no scope, but renders only quote_trade, propose_trade and
  // get_proposal: not offered on the directory, and not readable there either.
  assert.ok(!resources.some((r) => r.uri === APP_VIEW_URI.proposal), "no proposal view on the directory");
  for (const view of ["portfolio", "decision", "token"] as const) assert.ok(resources.some((r) => r.uri === APP_VIEW_URI[view]), view);
  const proposalRead = await rpcResult(await callDir(dirRequest(dir.tokens.access_token, "resources/read", { uri: APP_VIEW_URI.proposal })));
  assert.ok(proposalRead.error && !proposalRead.result, JSON.stringify(proposalRead));
  const fullResources = (await rpcResult(await call(mcpRequest(full.tokens.access_token, "resources/list")))).result?.resources as Array<{ uri: string }>;
  assert.ok(fullResources.some((r) => r.uri === APP_VIEW_URI.proposal), "the full server still offers it");
  const prompts = (await rpcResult(await callDir(dirRequest(dir.tokens.access_token, "prompts/list")))).result?.prompts as Array<{ name: string }>;
  assert.ok(Array.isArray(prompts));
  // The scope catalogue a directory connection reads describes only what it can hold.
  const doc = await rpcResult(await callDir(dirRequest(dir.tokens.access_token, "resources/read", { uri: "merrymen://docs/capabilities" })));
  const text = ((doc.result?.contents as Array<{ text: string }>)[0]!).text;
  assert.ok(text.includes("`market:read`") && !text.includes("`trade:propose`"), text.slice(0, 300));
});

test("tools/list on the directory endpoint names no other tool and instructs nothing in any description; the full server keeps its pointers", async () => {
  const { d, full, dir } = await setupBoth();
  forceAllScopes(d, dir.principal.connectionId);
  forceAllScopes(d, full.principal.connectionId);
  const toolName = toolNamePattern(ALL_TOOLS.map((t) => t.name));
  const offence = (self: string, text: string) => {
    const others = [...text.matchAll(toolName)].map((m) => m[1]).filter((n) => n !== self);
    return others.length ? `names ${others.join(", ")}` : OTHER_TOOLS.test(text) ? "points at other tools" : MODEL_INSTRUCTION.test(text) ? "instructs the model" : null;
  };
  type Listed = { name: string; title?: string; description?: string; inputSchema?: unknown; outputSchema?: unknown };
  const expected = ALL_TOOLS.filter((t) => toolInProfile(t, "directory")).map((t) => t.name).sort();
  for (const era of ["legacy", "modern"] as const) {
    const tools = (await rpcResult(await callDir(dirRequest(dir.tokens.access_token, "tools/list", {}, { era })))).result?.tools as Listed[];
    assert.deepEqual(tools.map((t) => t.name).sort(), expected, era);
    for (const t of tools) {
      const def = ALL_TOOLS.find((x) => x.name === t.name)!;
      assert.equal(t.description, def.directoryDescription ?? def.description, `${era}: ${t.name} is served its directory description`);
      for (const text of [t.title ?? "", t.description ?? "", ...schemaDescriptions(t.inputSchema), ...schemaDescriptions(t.outputSchema)]) {
        assert.equal(offence(t.name, text), null, `${era}: ${t.name}: ${text}`);
      }
    }
    // The resources it lists describe themselves without naming a tool either.
    const resources = (await rpcResult(await callDir(dirRequest(dir.tokens.access_token, "resources/list", {}, { era })))).result?.resources as Array<{ uri: string; description?: string }>;
    const templates = (await rpcResult(await callDir(dirRequest(dir.tokens.access_token, "resources/templates/list", {}, { era })))).result?.resourceTemplates as Array<{ uriTemplate: string; description?: string }>;
    assert.ok(resources.length > 0 && templates.length > 0, era);
    for (const r of [...resources.map((x) => ({ id: x.uri, text: x.description ?? "" })), ...templates.map((x) => ({ id: x.uriTemplate, text: x.description ?? "" }))]) {
      assert.equal(offence("", r.text), null, `${era}: ${r.id}: ${r.text}`);
    }
  }
  // The full server serves the full descriptions, pointers included.
  const fullTools = (await rpcResult(await call(mcpRequest(full.tokens.access_token, "tools/list")))).result?.tools as Listed[];
  for (const def of ALL_TOOLS.filter((t) => t.directoryDescription !== undefined)) {
    const served = fullTools.find((t) => t.name === def.name);
    assert.equal(served?.description, def.description, def.name);
  }
  assert.match(fullTools.find((t) => t.name === "run_backtest")!.description!, /Poll get_job/);
});

test("resourceInProfile: only the proposal view among the views is left off the directory, and every resource stays on the full server", () => {
  for (const r of APP_RESOURCES) {
    assert.equal(r.capability, null, r.uri);
    assert.equal(resourceInProfile(r, "directory"), r.uri !== APP_VIEW_URI.proposal, r.uri);
  }
  for (const r of ALL_RESOURCES) assert.equal(resourceInProfile(r, "full"), true, r.uri);
  // A resource that only needs a capability the directory lacks is left off by capability alone.
  const needs = (capability: ResourceDef["capability"], profileAnyOf?: ResourceDef["profileAnyOf"]) =>
    ({ name: "x", title: "x", description: "x", mimeType: "text/plain", capability, profileAnyOf, uri: "merrymen://x", read: async () => ({ mimeType: "text/plain", text: "" }) }) as ResourceDef;
  assert.equal(resourceInProfile(needs("trade.propose"), "directory"), false);
  assert.equal(resourceInProfile(needs(null, ["trade.propose", "portfolio.read"]), "directory"), true, "any one allowed capability is enough");
  assert.equal(resourceInProfile(needs(null, []), "directory"), true, "an empty list restricts nothing");
});

test("a principal carrying every scope on the directory profile can use none of the sensitive capabilities", () => {
  const principal: Principal = {
    tenant: OWNER_A, connectionId: "mcpcon_x", clientId: "c", clientName: null, clientHost: null, kind: "oauth",
    scopes: new Set(SCOPES.map((s) => s.id)), agentSlugs: [SLUG_A], tokenExpiresAt: NOW + 60, staff: true, profile: "directory",
  };
  for (const c of ["trade.propose", "drafts.write", "social.write", "staff.diagnostics"] as const) {
    assert.equal(hasCapability(principal, c), false, c);
    assert.throws(() => requireCapability(principal, c), (e: unknown) => e instanceof McpError && e.code === "insufficient_scope" && /directory listing/.test(e.message), c);
  }
  assert.equal(hasCapability(principal, "portfolio.read"), true);
  assert.equal(hasCapability({ ...principal, profile: "full" }, "trade.propose"), true, "the same principal on the full server");
  // The server built for the directory profile narrows even a full-profile principal handed to it.
  assert.ok(buildServer({ ...principal, profile: "full" }, { profile: "directory" }));
});

test("the directory endpoint serves the directory instructions, and the canonical one the full ones", async () => {
  const { full, dir } = await setupBoth();
  const init = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } };
  const d = await rpcResult(await callDir(dirRequest(dir.tokens.access_token, "initialize", init)));
  assert.match(String(d.result?.instructions), /cannot propose trades/);
  const f = await rpcResult(await call(mcpRequest(full.tokens.access_token, "initialize", init)));
  assert.match(String(f.result?.instructions), /Trade and setting "proposals"/);
});

test("the directory endpoint keeps /mcp's Host, Origin and browser checks, and is absent when switched off", async () => {
  const { dir, full } = await setupBoth();
  const cfg = testConfig({ allowedHosts: new Set(["app.test", "mcp.test"]) });
  // A person opening the address in a browser goes to the help page.
  const page = await callDir(new Request("https://mcp.test/mcp/directory", { headers: { host: "mcp.test", accept: "text/html", "sec-fetch-dest": "document" } }), cfg);
  assert.equal(page.status, 307);
  assert.equal(page.headers.get("location"), "https://app.test/connect/mcp");
  assert.equal((await callDir(new Request("https://evil.test/mcp/directory", { method: "POST", headers: { host: "evil.test" } }), cfg)).status, 421);
  assert.equal((await callDir(dirRequest(dir.tokens.access_token, "tools/list"), testConfig({ allowedOrigins: new Set(["https://app.test"]) }))).status, 200);
  const foreign = await callDir(mcpRequest(dir.tokens.access_token, "tools/list", {}, { path: DIR_PATH, headers: { origin: "https://evil.test" } }));
  assert.equal(foreign.status, 403);
  // MERRYMEN_MCP_DIRECTORY=0: 404 there, and /mcp untouched.
  const off = testConfig({ directoryResource: "" });
  assert.equal((await callDir(dirRequest(dir.tokens.access_token, "tools/list"), off)).status, 404);
  assert.equal((await callDir(dirRequest(null, "tools/list"), off)).status, 404);
  assert.equal((await handleMcpRequest(mcpRequest(full.tokens.access_token, "tools/list"), { cfg: off, now: () => NOW })).status, 200);
});

test("the directory route and its discovery document, through the Next route handlers", async () => {
  const keys = ["MERRYMEN_HOSTED", "DATABASE_URL", "MERRYMEN_PUBLIC_ORIGIN", "MERRYMEN_MCP_RESOURCE_URL", "MERRYMEN_SESSION_SECRET", "MERRYMEN_OAUTH_ISSUER", "MERRYMEN_MCP_DIRECTORY", "MERRYMEN_MCP_DIRECTORY_RESOURCE_URL"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    Object.assign(process.env, {
      MERRYMEN_HOSTED: "1", DATABASE_URL: "postgres://unused", MERRYMEN_PUBLIC_ORIGIN: "https://app.test",
      MERRYMEN_MCP_RESOURCE_URL: "https://mcp.test/mcp", MERRYMEN_SESSION_SECRET: "s".repeat(40),
    });
    for (const k of ["MERRYMEN_OAUTH_ISSUER", "MERRYMEN_MCP_DIRECTORY", "MERRYMEN_MCP_DIRECTORY_RESOURCE_URL"] as const) delete process.env[k];
    const wellKnown = await import("../app/.well-known/oauth-protected-resource/[[...path]]/route");
    const route = await import("../app/mcp/directory/route");
    const doc = async (path?: string[]) => wellKnown.GET(new Request("https://mcp.test/x"), { params: Promise.resolve({ path }) });
    const dirDoc = await doc(["mcp", "directory"]);
    assert.equal(dirDoc.status, 200);
    const body = await dirDoc.json() as { resource: string; scopes_supported: string[] };
    assert.equal(body.resource, "https://mcp.test/mcp/directory");
    assert.ok(!body.scopes_supported.includes("trade:propose") && body.scopes_supported.includes("market:read"));
    for (const path of [undefined, ["mcp"]]) {
      const canon = await (await doc(path)).json() as { resource: string; scopes_supported: string[] };
      assert.equal(canon.resource, "https://mcp.test/mcp", String(path));
      assert.ok(canon.scopes_supported.includes("trade:propose"), "root and /mcp documents unchanged");
    }
    assert.equal((await doc(["mcp", "other"])).status, 404);
    // The route itself: the directory challenge, before any database work.
    const res = await route.POST(new Request("https://mcp.test/mcp/directory", { method: "POST", headers: { host: "mcp.test", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" }));
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/mcp\.test\/\.well-known\/oauth-protected-resource\/mcp\/directory"/);
    assert.equal(route.OPTIONS(new Request("https://mcp.test/mcp/directory", { method: "OPTIONS" })).status, 204);
    // The kill switch: route, preflight and document all gone; /mcp's document stays.
    process.env.MERRYMEN_MCP_DIRECTORY = "0";
    assert.equal((await route.POST(new Request("https://mcp.test/mcp/directory", { method: "POST", headers: { host: "mcp.test" }, body: "{}" }))).status, 404);
    assert.equal(route.OPTIONS(new Request("https://mcp.test/mcp/directory", { method: "OPTIONS" })).status, 404);
    assert.equal((await doc(["mcp", "directory"])).status, 404);
    assert.equal((await doc(["mcp"])).status, 200);
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

test("the server built for the directory profile registers no excluded tool even for a principal that verified with every scope on the full server", async () => {
  const { d, full } = await setupBoth();
  forceAllScopes(d, full.principal.connectionId);
  // Only the server build differs: the token verifies as a full-server principal holding everything.
  const handler = createMcpHandler(({ authInfo }) => buildServer(principalOf(authInfo), { profile: "directory" }), { legacy: "stateless", responseMode: "auto" });
  const res = await handleMcpRequest(mcpRequest(full.tokens.access_token, "tools/list"), { cfg: testConfig(), now: () => NOW, fetch: (r, auth) => handler.fetch(r, { authInfo: auth }) });
  const names = await listNames(res);
  for (const t of DIRECTORY_EXCLUDED_TOOLS) assert.ok(!names.includes(t), t);
  assert.ok(names.includes("get_portfolio"));
});
