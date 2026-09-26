/**
 * Test fixtures for the MCP server: an in-memory SQLite database holding the
 * MCP tables, the ledger schema and a grants table, a fixed config, an agent
 * directory made of plain objects, and a helper that runs the real OAuth flow
 * to mint a token. Not imported by production code.
 */
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { applyLedgerSchema } from "../../../worker/src/store";
import { ensureMcpSchema } from "../../../worker/src/mcp/schema";
import type { McpConfig } from "./config";
import type { McpDb } from "./db";
import { setMcpDbForTest } from "./db";
import { agentFromParts, setAgentDirectoryForTest, type AgentDirectory, type OwnedAgent } from "./agents";
import { registerClient } from "./oauth/clients";
import { pkceS256 } from "./oauth/crypto";
import { decideRequest, exchangeCode, startAuthorization, type OAuthDeps, type Principal, type TokenResponse, verifyAccessToken } from "./oauth/server";
import { setLedgerForTest } from "./tool";
import { projectSettings, projectSpecValues, setSettingsReaderForTest } from "@/lib/services/settings-view";

export const OWNER_A = "0x00000000000000000000000000000000000000aa" as const;
export const OWNER_B = "0x00000000000000000000000000000000000000bb" as const;
export const ACCOUNT_A = "0x000000000000000000000000000000000000a001" as const;
export const ACCOUNT_B = "0x000000000000000000000000000000000000b001" as const;
export const SLUG_A = "aaaaaaaaaaaaaaaa";
export const SLUG_B = "bbbbbbbbbbbbbbbb";

export function testConfig(over: Partial<McpConfig> = {}): McpConfig {
  return {
    enabled: true,
    disabledWhy: null,
    issuer: "https://app.test",
    resource: "https://app.test/mcp",
    directoryResource: "https://app.test/mcp/directory",
    allowedOrigins: new Set(["https://app.test"]),
    allowedHosts: new Set(["app.test"]),
    staffTenants: new Set<string>(),
    accessTtlSec: 3600,
    refreshTtlSec: 30 * 86_400,
    refreshFamilyMaxSec: 90 * 86_400,
    codeTtlSec: 300,
    requestTtlSec: 1200,
    personalTokenMaxSec: 90 * 86_400,
    ...over,
  };
}

export interface TestDb extends McpDb {
  raw: DatabaseSync;
}

export async function makeTestDb(): Promise<TestDb> {
  const raw = new DatabaseSync(":memory:");
  const db: Db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  await ensureMcpSchema(db, "sqlite");
  await db.exec(`CREATE TABLE IF NOT EXISTS grants (tenant TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, grant_json TEXT NOT NULL, sealed_session_key TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  return { db, dialect: "sqlite", raw };
}

export function agentFixture(slug: string, account: `0x${string}`, over: Partial<OwnedAgent> = {}): OwnedAgent {
  return {
    ...agentFromParts({ slug, accounts: [account] }, {
      chain_id: 4663, smart_account: account, granted_at: "1700000000", expires_at: "4102444800",
      caps: JSON.stringify({ perTradeUsdg: 25, dailyUsdg: 100, expiryDays: 30, maxDrawdownPct: 20, maxOpsPerDay: 20 }),
      features: "[]", tokens: "[]",
    })!,
    ...over,
  };
}

/** Owner A owns SLUG_A, owner B owns SLUG_B. */
export function fixtureDirectory(map: Record<string, OwnedAgent[]> = {
  [OWNER_A]: [agentFixture(SLUG_A, ACCOUNT_A)],
  [OWNER_B]: [agentFixture(SLUG_B, ACCOUNT_B)],
}): AgentDirectory {
  return { async agentsFor(tenant) { return map[tenant.toLowerCase()] ?? []; } };
}

export interface TestDeps extends OAuthDeps {
  /** Move the fixed clock forward. */
  advance(seconds: number): void;
}

export function makeDeps(d: McpDb, over: Partial<OAuthDeps> = {}): TestDeps {
  let clock = 1_800_000_000;
  return {
    d,
    cfg: testConfig(),
    agents: fixtureDirectory(),
    ...over,
    now: () => clock,
    advance: (s: number) => { clock += s; },
  };
}

export const VERIFIER = "v".repeat(20) + "erifier-0123456789-abcdefghij";

/**
 * Run the real flow: register a public client, authorize, consent as `tenant`,
 * exchange the code. Returns the tokens and the principal they resolve to.
 */
export async function connectAs(deps: OAuthDeps, tenant: `0x${string}`, o: {
  scopes?: string[]; agents?: string[]; redirect?: string;
  /** Connect to the directory profile instead of the canonical resource. */
  profile?: "full" | "directory";
  /** Reuse an already registered client (the same app connecting to both resources). */
  clientId?: string;
} = {}): Promise<{ tokens: TokenResponse; principal: Principal; clientId: string }> {
  const redirect = o.redirect ?? "http://127.0.0.1:33418/callback";
  const profile = o.profile ?? "full";
  const resource = profile === "directory" ? deps.cfg.directoryResource : deps.cfg.resource;
  const clientId = o.clientId ?? String((await registerClient(deps.d, { redirect_uris: [redirect], token_endpoint_auth_method: "none", client_name: "Test client" }, deps.now())).body.client_id);
  const params = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: pkceS256(VERIFIER), code_challenge_method: "S256",
    state: "st", scope: (o.scopes ?? ["market:read", "agents:read", "portfolio:read", "decisions:read", "offline_access"]).join(" "), resource,
  });
  const start = await startAuthorization(deps, params);
  if (start.kind !== "consent") throw new Error(`authorize failed: ${JSON.stringify(start)}`);
  const requestId = decodeURIComponent(start.location.split("#request=")[1]);
  const decided = await decideRequest(deps, requestId, tenant, { approve: true, scopes: o.scopes, agentSlugs: o.agents ?? [tenant === OWNER_B ? SLUG_B : SLUG_A] });
  const code = new URL(decided.location).searchParams.get("code")!;
  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: VERIFIER, client_id: clientId, resource });
  const client = { clientId, kind: "dcr" as const, clientName: "Test client", redirectUris: [redirect], authMethod: "none" as const, secretHash: null, displayHost: "127.0.0.1" };
  const tokens = await exchangeCode(deps, form, client);
  const principal = await verifyAccessToken(deps.d, deps.cfg, tokens.access_token, deps.now(), profile);
  if (!principal) throw new Error("token did not verify");
  return { tokens, principal, clientId };
}

/** Route production singletons (MCP db, ledger, agent directory, settings) to fixtures for tests that go through the HTTP layer. */
export function installFixtures(d: McpDb, o: { directory?: AgentDirectory; settings?: Record<string, Record<string, unknown>> } = {}): () => void {
  setMcpDbForTest(d);
  setLedgerForTest(d.db);
  setAgentDirectoryForTest(o.directory ?? fixtureDirectory());
  const settings = o.settings ?? {};
  setSettingsReaderForTest({
    async settingsFor(tenant) { return projectSettings(settings[tenant.toLowerCase()] ?? {}); },
    async specValuesFor(tenant) { return projectSpecValues(settings[tenant.toLowerCase()] ?? {}); },
  });
  return () => {
    setMcpDbForTest(null);
    setLedgerForTest(null);
    setAgentDirectoryForTest(null);
    setSettingsReaderForTest(null);
  };
}

// ── what the directory profile may say (Anthropic's connector directory asks
// that tool descriptions carry no instructions about model behaviour or other
// tools) ────────────────────────────────────────────────────────────────────

/** Any of these tool names as a whole word (get_trade does not match inside get_trades). */
export function toolNamePattern(names: readonly string[]): RegExp {
  return new RegExp(`(?<![a-z_])(${names.join("|")})(?![a-z_])`, "g");
}

/** A pointer at other tools in general ("use the id in other tools"). */
export const OTHER_TOOLS = /\bother tools?\b/i;

/**
 * Wording that tells the reading model what to do, instead of saying what a
 * tool, field or resource is. Tool names are matched separately (the full
 * server may point at the next tool; the directory profile may not).
 */
export const MODEL_INSTRUCTION = /\btreat\b[^.]{0,40}\bas\b|\binstructions?\b|\bignore\b|\byou (?:must|should)\b|\b(?:always|never|first) (?:ask|call|use|confirm|show|tell|follow)\b|\b(?:ask|tell|confirm with) the user\b|\bbefore (?:treating|reading|calling|acting)\b/i;

/** Every "description" string anywhere in a JSON Schema (a tool's inputSchema or outputSchema). */
export function schemaDescriptions(node: unknown, into: string[] = []): string[] {
  if (Array.isArray(node)) for (const v of node) schemaDescriptions(v, into);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "description" && typeof v === "string") into.push(v);
      else schemaDescriptions(v, into);
    }
  }
  return into;
}

// ── a minimal MCP client over the handler, for tests ────────────────────────

export type Era = "legacy" | "modern";
let rpcId = 0;

export function mcpRequest(token: string | null, method: string, params: Record<string, unknown> = {}, o: { era?: Era; headers?: Record<string, string>; host?: string; path?: string } = {}): Request {
  const era = o.era ?? "legacy";
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", host: o.host ?? "app.test", ...o.headers };
  if (token) headers.authorization = `Bearer ${token}`;
  let body: Record<string, unknown>;
  if (era === "modern") {
    headers["mcp-protocol-version"] = "2026-07-28";
    headers["mcp-method"] = method;
    if (method === "tools/call" || method === "prompts/get") headers["mcp-name"] = String(params.name);
    if (method === "resources/read") headers["mcp-name"] = String(params.uri);
    body = { jsonrpc: "2.0", id: ++rpcId, method, params: { ...params, _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": { name: "merrymen-test", version: "1" },
    } } };
  } else {
    if (method !== "initialize") headers["mcp-protocol-version"] = "2025-06-18";
    body = { jsonrpc: "2.0", id: ++rpcId, method, params };
  }
  return new Request(`https://app.test${o.path ?? "/mcp"}`, { method: "POST", headers, body: JSON.stringify(body) });
}

/** The JSON-RPC message in a response, whether it came back as JSON or as a one-event SSE stream. */
export async function rpcResult(res: Response): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const text = await res.text();
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).pop();
    return data ? JSON.parse(data) : {};
  }
  return text ? JSON.parse(text) : {};
}

/** The error envelope of an isError tool result ({code, message, retryable, retry_after_s, trace_id, details?}), from _meta. */
export interface ToolErrorEnvelope {
  code: string;
  message: string;
  retryable: boolean;
  retry_after_s: number | null;
  trace_id: string;
  details?: Record<string, unknown>;
}
export function errorOf(r: unknown): ToolErrorEnvelope {
  const meta = (r as { _meta?: Record<string, unknown> | null } | null | undefined)?._meta;
  const e = meta?.["dev.merrymen/error"] as ToolErrorEnvelope | undefined;
  if (!e) throw new Error(`not an error result: ${JSON.stringify(r)?.slice(0, 300)}`);
  return e;
}
