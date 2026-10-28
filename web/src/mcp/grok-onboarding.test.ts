/**
 * The generic text-only MCP path used by clients such as Grok: real OAuth
 * grant/token services and the production HTTP/SDK handler, with no MCP Apps
 * capability, iframe, browser session or wallet. This is protocol regression
 * coverage, not evidence that a real Grok account completed its connector UI.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setSettingsReaderForTest } from "@/lib/services/settings-view";
import { handleMcpRequest } from "./http";
import { resetMetricsForTest } from "./observe";
import {
  ACCOUNT_B, OWNER_A, OWNER_B, SLUG_B, agentFixture, connectAs, errorOf,
  fixtureDirectory, installFixtures, makeDeps, makeTestDb, mcpRequest, rpcResult,
  type Era, type TestDb,
} from "./testing";

const ENV_KEYS = ["MERRYMEN_PUBLIC_ORIGIN", "MERRYMEN_OAUTH_ISSUER"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
let restore: (() => void) | null = null;
let database: TestDb | null = null;

afterEach(() => {
  restore?.(); restore = null;
  database?.raw.close(); database = null;
  resetMetricsForTest();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

type Rpc = Awaited<ReturnType<typeof rpcResult>>;
type TextToolResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

/** Read only the text fallback, as a client with no Apps/structured renderer can. */
function textData(rpc: Rpc): Record<string, unknown> {
  assert.equal(rpc.error, undefined, JSON.stringify(rpc));
  const result = rpc.result as TextToolResult | undefined;
  assert.ok(result, JSON.stringify(rpc));
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.ok(result.content.length > 0);
  assert.ok(result.content.every(item => item.type === "text" && typeof item.text === "string"));
  const text = result.content.map(item => item.text).join("\n");
  const data = JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
  assert.deepEqual(data, result.structuredContent, "all instructions and links survive without reading MCP Apps or structuredContent");
  return data;
}

async function setup(era: Era, scopes = ["market:read", "drafts:write"]) {
  for (const key of ENV_KEYS) process.env[key] = "https://app.test";
  const d = database = await makeTestDb();
  const directory = fixtureDirectory({
    [OWNER_A]: [],
    [OWNER_B]: [agentFixture(SLUG_B, ACCOUNT_B)],
  });
  const deps = makeDeps(d, { agents: directory });
  restore = installFixtures(d, { directory });
  // The first-agent flow has no private-agent grant and must not consult settings.
  setSettingsReaderForTest({ settingsFor: async () => { throw new Error("unshared settings read"); } });
  const a = await connectAs(deps, OWNER_A, {
    scopes, agents: [], redirect: "https://generic-client.example/callback",
  });
  const send = async (method: string, params: Record<string, unknown> = {}, token: string | null = a.tokens.access_token) => {
    const response = await handleMcpRequest(mcpRequest(token, method, params, { era }), { cfg: deps.cfg, now: deps.now });
    return { response, rpc: await rpcResult(response) };
  };
  const rpc = async (method: string, params: Record<string, unknown> = {}, token?: string) => {
    const result = await send(method, params, token);
    assert.equal(result.response.status, 200, JSON.stringify(result.rpc));
    return result.rpc;
  };
  const tool = (name: string, args: Record<string, unknown> = {}, token?: string) => rpc("tools/call", { name, arguments: args }, token);
  const count = (table: "mcp_proposals" | "grants" | "agents" | "agent_commands") =>
    (d.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  return { d, deps, a, send, rpc, tool, count };
}

const DRAFT = { name: "Robin", strategy: "trencher", idempotency_key: "grok-text-setup-01" };

for (const era of ["legacy", "modern"] as Era[]) {
  test(`${era}: a generic text-only client can discover, prepare and resume owner-reviewed setup without MCP Apps`, async () => {
    const { d, a, send, rpc, tool, count } = await setup(era);
    const discovery = era === "legacy" ? "initialize" : "server/discover";
    const params = era === "legacy"
      ? { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "generic-text-client", version: "1" } }
      : {};
    const challenge = await send(discovery, params, null);
    assert.equal(challenge.response.status, 401);
    assert.match(challenge.response.headers.get("www-authenticate") ?? "", /resource_metadata="https:\/\/app\.test\/\.well-known\/oauth-protected-resource\/mcp"/);

    const connected = await send(discovery, params);
    assert.equal(connected.response.status, 200);
    assert.equal(connected.rpc.error, undefined);
    const serverInfo = era === "legacy" ? connected.rpc.result?.serverInfo
      : (connected.rpc.result?._meta as Record<string, unknown>)?.["io.modelcontextprotocol/serverInfo"];
    assert.equal((serverInfo as { name: string } | undefined)?.name, "merrymen");
    assert.equal(connected.response.headers.get("mcp-session-id"), null, "later requests do not need a sticky session");
    const listed = (await rpc("tools/list")).result?.tools as Array<{ name: string }>;
    for (const name of ["get_merryman_setup", "create_merryman", "get_proposal"]) {
      assert.ok(listed.some(item => item.name === name), name);
    }
    for (const name of ["approve_proposal", "enable_live_trading", "sign_transaction", "get_private_key"]) {
      assert.ok(!listed.some(item => item.name === name), `${name} is not an assistant authority`);
    }

    const before = textData(await tool("get_merryman_setup"));
    assert.equal(before.phase, "no_shared_agent");
    assert.equal(before.agent, null);
    const next = before.next_steps as Array<{ tool: string | null }>;
    assert.ok(next.some(step => step.tool === "create_merryman"));
    assert.equal((before.runtime as { keep_chat_open: boolean }).keep_chat_open, false);

    const draft = textData(await tool("create_merryman", DRAFT));
    assert.equal(draft.status, "awaiting_approval");
    assert.equal(draft.created, true);
    assert.equal(draft.approval_url, `https://app.test/connect/approve/${draft.proposal_id}`);
    assert.equal((draft.summary as { purpose: string }).purpose, "create");
    assert.match(String(draft.next_steps), /has not created an agent or enabled trading/);
    assert.equal(draft.diff, null);

    // A resumed chat can repeat the same request without making another proposal.
    const repeated = textData(await tool("create_merryman", DRAFT));
    assert.equal(repeated.proposal_id, draft.proposal_id);
    assert.equal(repeated.created, false);
    const status = textData(await tool("get_proposal", { proposal_id: draft.proposal_id }));
    assert.equal(status.status, "awaiting_approval");
    assert.equal(status.approval_url, draft.approval_url);
    assert.equal(status.order_id, null);
    assert.equal(status.decided_at, null);
    assert.equal(textData(await tool("get_merryman_setup")).phase, "no_shared_agent");

    const stored = d.raw.prepare("SELECT tenant, connection_id, status, binding_json FROM mcp_proposals WHERE id = ?").get(String(draft.proposal_id)) as {
      tenant: string; connection_id: string; status: string; binding_json: string;
    };
    assert.equal(stored.tenant, OWNER_A);
    assert.equal(stored.connection_id, a.principal.connectionId);
    assert.equal(stored.status, "awaiting_approval");
    const binding = JSON.parse(stored.binding_json) as { purpose: string; before: object; settings: Record<string, unknown> };
    assert.equal(binding.purpose, "create");
    assert.deepEqual(binding.before, {});
    assert.deepEqual(binding.settings, { agentName: "Robin", strategy: "trencher" });
    assert.equal(count("mcp_proposals"), 1);
    for (const table of ["grants", "agents", "agent_commands"] as const) assert.equal(count(table), 0, table);
  });

  test(`${era}: read-only consent cannot discover or invoke setup writes by naming them`, async () => {
    const { rpc, tool, count } = await setup(era, ["market:read"]);
    const setupView = textData(await tool("get_merryman_setup"));
    assert.equal((setupView.connection as { can_create_draft: boolean }).can_create_draft, false);
    const listed = (await rpc("tools/list")).result?.tools as Array<{ name: string }>;
    for (const name of ["create_merryman", "get_proposal", "cancel_proposal", "propose_settings_change"]) {
      assert.ok(!listed.some(item => item.name === name), name);
      const denied = await tool(name, DRAFT);
      assert.equal(denied.error?.code, -32602, JSON.stringify(denied));
    }
    assert.equal(count("mcp_proposals"), 0);
    assert.equal(count("grants"), 0);
  });

  test(`${era}: another owner cannot read or cancel a setup proposal or discover its agent`, async () => {
    const { deps, tool, count } = await setup(era);
    const draft = textData(await tool("create_merryman", DRAFT));
    const b = await connectAs(deps, OWNER_B, { scopes: ["market:read", "drafts:write"], agents: [] });
    for (const name of ["get_proposal", "cancel_proposal"]) {
      const denied = await tool(name, { proposal_id: draft.proposal_id }, b.tokens.access_token);
      assert.equal(denied.result?.isError, true);
      assert.equal(errorOf(denied.result).code, "not_found");
      assert.equal(denied.result?.structuredContent, undefined);
      assert.ok(!JSON.stringify(denied).includes("Robin"), "no other owner's setup is disclosed");
    }
    assert.deepEqual(textData(await tool("list_proposals", {}, b.tokens.access_token)).proposals, []);
    const foreign = await tool("get_merryman_setup", { agent: SLUG_B });
    assert.equal(errorOf(foreign.result).code, "not_found");
    assert.ok(!JSON.stringify(foreign).includes(ACCOUNT_B));
    assert.equal(textData(await tool("get_proposal", { proposal_id: draft.proposal_id })).status, "awaiting_approval");
    assert.equal(count("mcp_proposals"), 1);
    assert.equal(count("agent_commands"), 0);
  });

  test(`${era}: a setup call cannot supply live consent, wallet keys or a different tenant`, async () => {
    const { tool, count } = await setup(era);
    for (const extra of [
      { live_trading: true },
      { liveTradingEnabled: true },
      { private_key: "synthetic-not-a-real-key" },
      { tenant: OWNER_B },
    ]) {
      const denied = await tool("create_merryman", { ...DRAFT, ...extra });
      assert.ok(denied.error || denied.result?.isError, JSON.stringify(denied));
      assert.equal(denied.result?.structuredContent, undefined);
    }
    for (const table of ["mcp_proposals", "grants", "agents", "agent_commands"] as const) assert.equal(count(table), 0, table);
  });
}
