/**
 * The Fomo research tools, through runTool — capability check, the shared
 * rate bucket, strict zod, timeout, output validation, audit — against an
 * in-memory SQLite and a fixture-backed provider (worker/src/fomo/testdata).
 * No network and no real key.
 *
 * What must hold: one MCP tool per registered READ tool, same names, and no
 * mutation; public reads need market:read and the owner's own research
 * state needs agents:read; the tenant is the connection's owner, never an
 * argument; the registry's validator has the last word on arguments; an
 * owner who switched Fomo off gets not-authorized with no provider call; the
 * output is the research envelope with third-party text labelled.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import * as z from "zod";
import { createWebFomoRuntime, setFomoRuntimeForTest, type FomoRuntime } from "@/lib/fomo-runtime";
import { wrapSqlite } from "../../../../worker/src/db";
import { FOMO_ATTRIBUTION } from "../../../../worker/src/fomo/render";
import { FOMO_TOOL_DEFS, MUTATION_TOOL_NAMES, READ_TOOL_NAMES } from "../../../../worker/src/fomo/tools";
import type { Principal } from "../oauth/server";
import { resetMetricsForTest } from "../observe";
import { handleMcpRequest } from "../http";
import { buildServer, principalOf, toolInProfile } from "../server";
import { runTool, type ToolDef } from "../tool";
import { OWNER_A, OWNER_B, connectAs, errorOf, installFixtures, makeDeps, makeTestDb, mcpRequest, rpcResult, testConfig } from "../testing";
import { ALL_TOOLS } from "./index";
import { FOMO_MCP_TOOLS } from "./fomo";
import { UNTRUSTED_NOTE } from "./shared";

type Rec = Record<string, unknown>;

const NOW = 1_800_000_000; // seconds, as ctx.now() counts
const ALERTS_NEWEST = 1788378000000;
const PONS = "0x39dbed3a00000000000000000000000000000c0d";

function fixture(name: string): Rec {
  return JSON.parse(readFileSync(new URL(`../../../../worker/src/fomo/testdata/${name}.json`, import.meta.url), "utf8")) as Rec;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-credits-cost": "250" } });

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  setFomoRuntimeForTest(null);
  resetMetricsForTest();
});

async function setup(o: { scopes?: string[]; settings?: Record<string, Record<string, unknown>> } = {}) {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  restore = installFixtures(d, { settings: o.settings ?? {} });
  const provider: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    provider.push(u.pathname + u.search);
    const p = u.pathname;
    if (p === "/v2/tokens/search") return json(fixture("tokens-search"));
    if (p === "/v2/search") return json(fixture("search"));
    if (p === "/v2/alerts") {
      const body = fixture("alerts");
      const shift = NOW * 1000 - 60_000 - ALERTS_NEWEST;
      for (const a of body.alerts as Rec[]) {
        if (typeof a.ts === "number") a.ts += shift;
        if (typeof a.execTs === "number") a.execTs += shift;
      }
      return json(body);
    }
    if (p.startsWith("/v2/thesis/token/")) return json(fixture("theses-token"));
    if (/\/stats$/.test(p)) return json(fixture("token-stats"));
    if (/\/balances$/.test(p)) return json(fixture("balances"));
    return json({ error: "not_found" }, 404);
  }) as typeof fetch;
  const raw = new DatabaseSync(":memory:");
  const rt: FomoRuntime = await createWebFomoRuntime({
    hosted: true, db: wrapSqlite(raw), dialect: "sqlite", apiKey: "fixture-key-not-a-credential", fetchImpl,
    now: () => NOW * 1000, planCreditsPerMonth: 100_000_000, log: () => {},
  });
  setFomoRuntimeForTest(rt);
  const scopes = o.scopes ?? ["market:read", "agents:read", "offline_access"];
  const ca = await connectAs(deps, OWNER_A, { scopes });
  const b = (await connectAs(deps, OWNER_B, { scopes })).principal;
  return { d, raw, rt, provider, a: ca.principal, b, tokenA: ca.tokens.access_token };
}

const def = (name: string) => FOMO_MCP_TOOLS.find((t) => t.name === name)! as unknown as ToolDef;
const call = (p: Principal, name: string, args: unknown) => runTool(def(name), args, p, "trace-fomo", { now: () => NOW });
const ok = async (p: Principal, name: string, args: unknown): Promise<any> => {
  const r = await call(p, name, args);
  assert.equal(r.isError, undefined, JSON.stringify(r.content).slice(0, 400));
  return r.structuredContent;
};
const errCode = async (p: Principal, name: string, args: unknown): Promise<string> => {
  const r = await call(p, name, args);
  assert.equal(r.isError, true, `expected an error from ${name}`);
  return errorOf(r).code;
};

// ── the catalogue ───────────────────────────────────────────────────────────

test("one MCP tool per registered read tool, by the same name; no mutation is offered", () => {
  assert.deepEqual(FOMO_MCP_TOOLS.map((t) => t.name), [...READ_TOOL_NAMES]);
  const names = new Set(ALL_TOOLS.map((t) => t.name));
  for (const n of READ_TOOL_NAMES) assert.ok(names.has(n), `${n} is registered`);
  for (const n of MUTATION_TOOL_NAMES) assert.ok(!names.has(n), `${n} must not reach a model choosing tools`);
  for (const t of FOMO_MCP_TOOLS) {
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.capability, t.name === "fomo_get_research_status" ? "agents.read" : "market.read", t.name);
    assert.equal(t.annotations.openWorldHint, t.name !== "fomo_get_research_status", t.name);
    assert.equal(t.timeoutMs, 25_000);
    if (t.name !== "fomo_get_research_status") assert.deepEqual(t.budget, { bucket: "fomo-provider", perMinute: 10, perHour: 120 });
    assert.ok(toolInProfile(t, "directory"), `${t.name} needs only read scopes, so the directory profile lists it`);
  }
});

test("each input mirrors the registry's own schema: the same argument names, nothing extra", () => {
  for (const t of FOMO_MCP_TOOLS) {
    const mine = Object.keys((z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as { properties?: Rec }).properties ?? {}).sort();
    const registry = Object.keys((FOMO_TOOL_DEFS[t.name as keyof typeof FOMO_TOOL_DEFS].schema as { properties: Rec }).properties).sort();
    assert.deepEqual(mine, registry, t.name);
  }
});

// ── public reads ────────────────────────────────────────────────────────────

test("a public read runs the registered tool for the connection's owner and returns the labelled envelope", async () => {
  const { raw, provider, a } = await setup();
  const r = await ok(a, "fomo_get_token_theses", { token: "$PONS" });
  assert.equal(r.tool, "fomo_get_token_theses");
  assert.ok(["ok", "capped"].includes(r.status), r.status);
  assert.match(r.answer, /^\$PONS on robinhood \(0x39db…0c0d\): 3 theses/);
  assert.ok(r.answer.endsWith(FOMO_ATTRIBUTION));
  assert.equal(r.attribution, FOMO_ATTRIBUTION);
  assert.equal(r.untrusted_note, UNTRUSTED_NOTE);
  assert.equal(r.observed_at, new Date(NOW * 1000).toISOString(), "ctx.now() seconds became the service's milliseconds");
  assert.equal(r.data_omitted, false);
  assert.equal((r.subject as Rec).kind, "token");
  assert.ok(Array.isArray((r.data as Rec).theses));
  assert.ok(provider.some((p) => p.startsWith("/v2/thesis/token/")));
  const rows = raw.prepare("SELECT request_id, tenant, surface, tool FROM fomo_requests").all() as Rec[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.tenant, OWNER_A);
  assert.equal(rows[0]!.surface, "mcp");
  assert.match(String(rows[0]!.request_id), /^trace-fomo\.[0-9a-f]{8}$/, "traceable to the MCP call");
  assert.equal(r.request_id, rows[0]!.request_id);
});

test("market:read is required for public reads; nothing is read without it", async () => {
  const { provider, a } = await setup({ scopes: ["agents:read", "offline_access"] });
  assert.equal(await errCode(a, "fomo_get_token_theses", { token: "PONS" }), "insufficient_scope");
  assert.equal(await errCode(a, "fomo_find_opportunities", {}), "insufficient_scope");
  assert.deepEqual(provider, []);
});

test("strict inputs: no tenant, URL, unknown key, control character or deep research; nothing reaches the provider", async () => {
  const { provider, raw, a } = await setup();
  assert.equal(await errCode(a, "fomo_get_token_theses", { token: "PONS", tenant: OWNER_B }), "invalid_input");
  assert.equal(await errCode(a, "fomo_get_token_theses", { token: "https://evil.example/x" }), "invalid_input");
  assert.equal(await errCode(a, "fomo_get_token_theses", {}), "invalid_input", "a token, a trader, or both");
  assert.equal(await errCode(a, "fomo_resolve_subject", { query: "PO\u0000NS" }), "invalid_input");
  assert.equal(await errCode(a, "fomo_research_coin", { token: PONS, depth: "deep" }), "invalid_input", "a deep read starts an owner-charged job");
  assert.equal(await errCode(a, "fomo_get_rankings", { limit: 51 }), "invalid_input");
  assert.deepEqual(provider, []);
  assert.equal(Number((raw.prepare("SELECT COUNT(*) AS n FROM fomo_jobs").get() as { n: number }).n), 0);
});

test("the registry's validator has the last word: a chain the registry does not know is refused before the service", async () => {
  const { provider, raw, a } = await setup();
  const r = await call(a, "fomo_get_token_theses", { token: "PONS", chain: "notachain" });
  assert.equal(r.isError, true);
  assert.equal(errorOf(r).code, "invalid_input");
  assert.match(errorOf(r).message, /chain-unknown/);
  assert.deepEqual(provider, []);
  assert.equal(Number((raw.prepare("SELECT COUNT(*) AS n FROM fomo_requests").get() as { n: number }).n), 0);
});

test("an owner who switched Fomo data off gets not-authorized, with no provider call", async () => {
  const { provider, a, b } = await setup({ settings: { [OWNER_B]: { fomoDataAccess: false } } });
  const r = await ok(b, "fomo_get_token_theses", { token: "PONS" });
  assert.equal(r.status, "not-authorized");
  assert.equal(r.reason, "data-access-off");
  assert.equal(r.data, null);
  assert.deepEqual(provider, []);
  // Owner A's permission is A's own.
  assert.notEqual((await ok(a, "fomo_get_token_theses", { token: "PONS" })).status, "not-authorized");
});

test("the provider-reading tools share one per-connection bucket", async () => {
  const { a } = await setup();
  for (let i = 0; i < 10; i++) await ok(a, i % 2 ? "fomo_get_rankings" : "fomo_resolve_subject", i % 2 ? {} : { query: "PONS", kind: "token" });
  assert.equal(await errCode(a, "fomo_get_token_theses", { token: "PONS" }), "rate_limited");
});

// ── the owner's own research state ──────────────────────────────────────────

test("research status needs agents:read and shows only the connection owner's own state", async () => {
  const { rt, a, b } = await setup();
  // Owner A asked, in a direct conversation, to watch a coin (the planner's mutation; not an MCP tool).
  const watched = await rt.service.invoke(
    { tenant: OWNER_A, surface: "app-chat", audience: "owner", conversationKey: null, requestId: "watch-a", now: NOW * 1000, priority: "interactive" },
    "fomo_watch_coin",
    { token: PONS, chain: "robinhood", days: 7 },
  );
  assert.ok(["ok", "empty"].includes(watched.status), JSON.stringify(watched).slice(0, 300));
  const mine = await ok(a, "fomo_get_research_status", {});
  assert.equal(mine.tool, "fomo_get_research_status");
  assert.equal((mine.data as { watches: unknown[] }).watches.length, 1);
  const theirs = await ok(b, "fomo_get_research_status", {});
  assert.equal((theirs.data as { watches: unknown[] }).watches.length, 0, "B never sees A's watches");

  const { a: marketOnly } = await setup({ scopes: ["market:read", "offline_access"] });
  assert.equal(await errCode(marketOnly, "fomo_get_research_status", {}), "insufficient_scope");
});

// ── through the real MCP handler ────────────────────────────────────────────

test("through the SDK: the family is listed read-only with output schemas, and a call returns the envelope", async () => {
  const { tokenA, provider } = await setup({ scopes: ["market:read", "offline_access"] });
  const handler = createMcpHandler(({ authInfo }) => buildServer(principalOf(authInfo), { tools: ALL_TOOLS as ToolDef[], deps: { now: () => NOW } }), { legacy: "stateless", responseMode: "auto" });
  const send = (req: Request) => handleMcpRequest(req, { cfg: testConfig(), now: () => NOW, fetch: (r, authInfo) => handler.fetch(r, { authInfo }) });
  const list = await rpcResult(await send(mcpRequest(tokenA, "tools/list")));
  const tools = (list.result?.tools ?? []) as Array<{ name: string; outputSchema?: unknown; annotations?: { readOnlyHint?: boolean } }>;
  const fomo = tools.filter((t) => t.name.startsWith("fomo_")).map((t) => t.name).sort();
  assert.deepEqual(fomo, READ_TOOL_NAMES.filter((n) => n !== "fomo_get_research_status").sort(), "market:read alone does not list the owner's research status");
  for (const t of tools.filter((x) => x.name.startsWith("fomo_"))) {
    assert.ok(t.outputSchema, `${t.name} declares an output schema`);
    assert.equal(t.annotations?.readOnlyHint, true, t.name);
  }
  const r = await rpcResult(await send(mcpRequest(tokenA, "tools/call", { name: "fomo_get_token_theses", arguments: { token: "PONS" } })));
  assert.equal(r.result?.isError, undefined, JSON.stringify(r).slice(0, 400));
  const out = r.result?.structuredContent as Rec;
  assert.equal(out.tool, "fomo_get_token_theses");
  assert.equal(out.untrusted_note, UNTRUSTED_NOTE);
  assert.ok(provider.some((p) => p.startsWith("/v2/thesis/token/")));
});
