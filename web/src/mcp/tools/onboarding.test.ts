import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setSettingsReaderForTest } from "@/lib/services/settings-view";
import { FLEET_RECOVERY_SCHEMA } from "../../../../worker/src/fleet-recovery";
import { readGrantProjection, type AgentDirectory, type OwnedAgent } from "../agents";
import { resetMetricsForTest } from "../observe";
import { runTool, type ToolDef } from "../tool";
import {
  ACCOUNT_A, OWNER_A, SLUG_A, SLUG_B, agentFixture, connectAs, errorOf, fixtureDirectory,
  installFixtures, makeDeps, makeTestDb, type TestDb,
} from "../testing";
import { ONBOARDING_TOOLS } from "./onboarding";

const NOW = 1_800_000_000;
const def = ONBOARDING_TOOLS[0] as unknown as ToolDef;
let restore: (() => void) | null = null;
let database: TestDb | null = null;
const originalIssuer = process.env.MERRYMEN_OAUTH_ISSUER;
afterEach(() => {
  restore?.(); restore = null;
  database?.raw.close(); database = null;
  resetMetricsForTest();
  if (originalIssuer === undefined) delete process.env.MERRYMEN_OAUTH_ISSUER;
  else process.env.MERRYMEN_OAUTH_ISSUER = originalIssuer;
});

type Setup = {
  phase: string; summary: string;
  connection: { id: string; can_read_agents: boolean; can_create_draft: boolean; can_propose_settings: boolean; shared_agent_count: number; available_tools: string[] };
  agent: null | { id: string; account: string | null; mode: string; worker_fresh: boolean | null; energy: null | { fresh: boolean; entry_allowance_exhausted: boolean | null } };
  next_steps: Array<{ action: string; label: string; detail: string; url: string | null; tool: string | null }>;
  links: Record<string, string>;
  runtime: { hosted: boolean; keep_chat_open: boolean; explanation: string };
  controls: Array<{ control: string; effect: string; available_here: boolean }>;
};

async function setup(o: {
  scopes?: string[]; shared?: string[]; agent?: Partial<OwnedAgent>; settings?: Record<string, unknown>; profile?: "full" | "directory";
} = {}) {
  process.env.MERRYMEN_OAUTH_ISSUER = "https://app.test";
  const d = database = await makeTestDb();
  const directory = fixtureDirectory({ [OWNER_A]: [agentFixture(SLUG_A, ACCOUNT_A, o.agent)] });
  restore = installFixtures(d, { directory, settings: { [OWNER_A]: { liveTradingEnabled: true, strategy: "steady-basket", ...o.settings } } });
  const deps = makeDeps(d, { agents: directory });
  const { principal } = await connectAs(deps, OWNER_A, {
    scopes: o.scopes ?? ["market:read", "agents:read"], agents: o.shared ?? [SLUG_A], profile: o.profile,
  });
  const call = (args: Record<string, unknown> = {}, overrides: { directory?: AgentDirectory } = {}) => runTool(def, args, principal, "setup-test", { now: () => NOW, ...overrides });
  const read = async (args: Record<string, unknown> = {}) => {
    const r = await call(args);
    assert.equal(r.isError, undefined, r.content[0]?.text);
    return r.structuredContent as unknown as Setup;
  };
  const seed = async (o: { beat?: number | null; mode?: string; status?: string; blocker?: string | null; energy?: unknown } = {}) => {
    await d.db.prepare(`INSERT INTO agents(smart_account,owner_address,session_key_address,chain_id,caps,granted_at,expires_at,status,mode,beat_at,live_blocker,energy)
      VALUES(?,?,?,4663,'{}',1700000000,4102444800,?,?,?,?,?)`).run(
      ACCOUNT_A, OWNER_A, OWNER_A, o.status ?? "armed", o.mode ?? "live", o.beat === undefined ? NOW - 20 : o.beat, o.blocker ?? null,
      o.energy === undefined ? null : JSON.stringify(o.energy),
    );
  };
  return { d, principal, read, call, seed };
}

test("a new unshared connection receives usable setup links without claiming no account exists", async () => {
  const { read, principal } = await setup({ scopes: ["market:read", "drafts:write"], shared: [] });
  const r = await read();
  assert.equal(r.phase, "no_shared_agent");
  assert.equal(r.agent, null);
  assert.match(r.summary, /does not mean the owner has no agent/);
  assert.equal(r.connection.can_create_draft, true);
  assert.equal(r.connection.id, principal.connectionId, "a view can separate account connections even before an agent is shared");
  assert.equal(r.connection.can_propose_settings, false);
  assert.deepEqual(r.connection.available_tools, ["get_merryman_setup", "create_merryman", "get_proposal", "list_proposals", "cancel_proposal"]);
  assert.equal(r.next_steps.find(s => s.action === "draft_setup")?.tool, "create_merryman");
  assert.equal(r.links.funding, "https://app.test/deposit");
  assert.ok(Object.values(r.links).every(url => new URL(url).origin === "https://app.test"));
  assert.equal(r.runtime.hosted, true);
  assert.equal(r.runtime.keep_chat_open, false);
  assert.match(r.runtime.explanation, /terminal do not need to stay open/);
});

test("public scope cannot inspect hidden agents, settings or ledger, even if an agent slug is on the connection", async () => {
  const { call } = await setup({ scopes: ["market:read"], shared: [SLUG_A] });
  setSettingsReaderForTest({ settingsFor: async () => { throw new Error("private settings touched"); } });
  let reads = 0;
  const directory: AgentDirectory = { async agentsFor() { reads++; throw new Error("hidden directory touched"); } };
  const r = await call({}, { directory });
  assert.equal(r.isError, undefined, r.content[0]?.text);
  assert.equal((r.structuredContent as unknown as Setup).agent, null);
  assert.equal(reads, 0);
  const targeted = await call({ agent: SLUG_A }, { directory });
  assert.equal(errorOf(targeted).code, "not_found");
  assert.equal(reads, 0);
});

test("a drafts-only connection can prepare its first setup without private agent access", async () => {
  const { call } = await setup({ scopes: ["drafts:write"], shared: [] });
  setSettingsReaderForTest({ settingsFor: async () => { throw new Error("hidden settings touched"); } });
  const result = await call({}, { directory: { async agentsFor() { throw new Error("hidden agents touched"); } } });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  const r = result.structuredContent as unknown as Setup;
  assert.equal(r.phase, "no_shared_agent");
  assert.equal(r.connection.can_read_agents, false);
  assert.equal(r.next_steps.find(s => s.action === "draft_setup")?.tool, "create_merryman");
});

test("no shared agent never reads hidden settings despite an agents:read scope on a forged test principal", async () => {
  const { principal, d } = await setup({ scopes: ["market:read"], shared: [] });
  setSettingsReaderForTest({ settingsFor: async () => { throw new Error("hidden settings touched"); } });
  const r = await runTool(def, {}, { ...principal, scopes: new Set(["market:read", "agents:read"]) }, "setup-test", {
    now: () => NOW, mcp: async () => d,
    directory: { async agentsFor() { throw new Error("hidden directory touched"); } },
    ledger: async () => { throw new Error("hidden ledger touched"); },
  });
  assert.equal(r.isError, undefined, r.content[0]?.text);
  assert.equal((r.structuredContent as unknown as Setup).phase, "no_shared_agent");
});

test("a shared placeholder identity needs owner permission, not a new MCP connection", async () => {
  const { read } = await setup({ scopes: ["market:read", "agents:read", "drafts:write"], agent: { account: null, orderAgentId: null, accounts: [], grantedAt: null, expiresAt: null, chainId: null, caps: null } });
  const r = await read();
  assert.equal(r.phase, "permission_required");
  assert.equal(r.agent?.id, SLUG_A);
  assert.equal(r.agent?.account, null);
  assert.ok(r.connection.available_tools.includes("create_merryman"));
  assert.equal(r.next_steps.find(s => s.action === "draft_setup")?.tool, "create_merryman");
  assert.match(r.next_steps.find(s => s.action === "draft_setup")!.detail, /resume the saved wallet otherwise/);
  assert.ok(r.next_steps.some(s => s.action === "sign_permission" && s.url === "https://app.test/grant"));
  assert.ok(!r.next_steps.some(s => s.action === "share_agent"));
});

test("an unshared or foreign requested agent stays not_found before settings reads", async () => {
  const { call } = await setup();
  setSettingsReaderForTest({ settingsFor: async () => { throw new Error("private settings touched"); } });
  assert.equal(errorOf(await call({ agent: SLUG_B })).code, "not_found");
});

test("a failed or malformed grant projection cannot offer wallet creation", async () => {
  const { call, d } = await setup();
  const directory: AgentDirectory = { async agentsFor() { await readGrantProjection(d.db, OWNER_A); return []; } };
  setSettingsReaderForTest({ settingsFor: async () => { throw new Error("settings must not be read after projection failure"); } });
  await d.db.prepare("INSERT INTO grants VALUES (?,4663,'invalid-json','not-read',1)").run(OWNER_A);
  let result = await call({}, { directory });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  await d.db.prepare("UPDATE grants SET grant_json='{}'").run();
  result = await call({}, { directory });
  assert.equal(result.isError, true, "valid JSON without an account is still an unreadable stored grant");
  assert.equal(result.structuredContent, undefined);
  await d.db.exec("DROP TABLE grants");
  result = await call({}, { directory });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
});

test("an expired permission overrides a fresh live report and requires owner renewal", async () => {
  const { seed, read } = await setup({ agent: { expiresAt: NOW - 1 } });
  await seed();
  const r = await read();
  assert.equal(r.phase, "permission_expired");
  assert.ok(r.next_steps.some(s => s.action === "renew_permission"));
  assert.ok(!r.next_steps.some(s => s.action === "review_funding"));
});

test("a stale LIVE row is historical and does not ask for funds or a signature", async () => {
  const { seed, read } = await setup();
  await seed({ beat: NOW - 3600 });
  const r = await read();
  assert.equal(r.phase, "worker_stale");
  assert.equal(r.agent?.worker_fresh, false);
  assert.match(r.summary, /historical/);
  assert.deepEqual(r.next_steps.map(s => s.action), ["check_worker"]);
});

test("the mirror grace period does not call an in-flight worker stopped", async () => {
  const { seed, read } = await setup({ settings: { tickSeconds: 60 } });
  await seed({ beat: NOW - 500 });
  const r = await read();
  assert.equal(r.phase, "live");
  assert.equal(r.agent?.worker_fresh, true);
});

test("no heartbeat, a future heartbeat and a heartbeat preceding the new grant cannot confirm activation", async () => {
  const { seed, read, d } = await setup({ agent: { grantedAt: NOW - 10 } });
  await seed({ beat: null });
  assert.equal((await read()).phase, "awaiting_worker");
  await d.db.prepare("UPDATE agents SET beat_at=? WHERE smart_account=?").run(NOW + 3600, ACCOUNT_A);
  assert.equal((await read()).phase, "awaiting_worker");
  await d.db.prepare("UPDATE agents SET beat_at=? WHERE smart_account=?").run(NOW - 20, ACCOUNT_A);
  assert.equal((await read()).phase, "awaiting_worker");
});

test("a fresh heartbeat from an old permission or different chain does not confirm the new permission", async () => {
  const { seed, read, d } = await setup({ agent: { grantedAt: NOW - 100 } });
  await seed({ beat: NOW - 20 });
  assert.equal((await read()).phase, "awaiting_worker", "old granted_at even when the heartbeat is newer than the grant");
  await d.db.prepare("UPDATE agents SET granted_at=?, expires_at=4102444801").run(NOW - 100);
  assert.equal((await read()).phase, "awaiting_worker", "different permission expiry");
  await d.db.prepare("UPDATE agents SET expires_at=4102444800, chain_id=46630").run();
  assert.equal((await read()).phase, "awaiting_worker", "different chain");
  await d.db.prepare("UPDATE agents SET chain_id=4663").run();
  assert.equal((await read()).phase, "live");
});

test("a fresh live report offers owner-reviewed management without inventing remote pause", async () => {
  const { seed, read } = await setup({ scopes: ["market:read", "agents:read", "drafts:write"] });
  await seed();
  const r = await read();
  assert.equal(r.phase, "live");
  assert.equal(r.agent?.worker_fresh, true);
  assert.equal(r.connection.can_propose_settings, true);
  assert.ok(!r.connection.available_tools.includes("create_merryman"));
  assert.equal(r.next_steps.find(s => s.action === "propose_settings")?.tool, "propose_settings_change");
  const pause = r.controls.find(c => c.control === "pause / resume")!;
  assert.equal(pause.available_here, false);
  assert.match(pause.effect, /entries AND exits/);
});

test("fresh error status cannot become live merely because its old mode was live", async () => {
  const { seed, read } = await setup();
  await seed({ status: "error" });
  assert.equal((await read()).phase, "blocked");
});

test("paper is simulated and a deliberate live switch off does not demand funding", async () => {
  const { seed, read } = await setup({ settings: { liveTradingEnabled: false } });
  await seed({ mode: "paper", blocker: "live-not-enabled" });
  const r = await read();
  assert.equal(r.phase, "paper");
  assert.match(r.summary, /simulated/);
  assert.deepEqual(r.next_steps.map(s => s.action), ["review_live_mode"]);
});

test("known funding, permission and infrastructure blockers have distinct remedies", async () => {
  const { seed, read, d } = await setup();
  await seed({ mode: "paper", blocker: "no-gas" });
  let r = await read();
  assert.equal(r.next_steps[0]?.url, "https://app.test/deposit");
  assert.match(r.next_steps[0]!.label, /ETH/);
  await d.db.prepare("UPDATE agents SET live_blocker='wrong-chain'").run();
  r = await read();
  assert.equal(r.next_steps[0]?.action, "review_permission");
  assert.match(r.next_steps[0]!.detail, /Robinhood Chain/);
  await d.db.prepare("UPDATE agents SET live_blocker='no-executor'").run();
  r = await read();
  assert.equal(r.next_steps[0]?.action, "check_blocker");
  assert.match(r.next_steps[0]!.detail, /ours to fix/);
});

test("recovery holds override old LIVE and even expiry without recommending a re-sign", async () => {
  const { seed, read, d } = await setup({ agent: { expiresAt: NOW - 1 } });
  await seed();
  await d.db.exec(FLEET_RECOVERY_SCHEMA);
  await d.db.prepare("INSERT INTO fleet_recovery_health VALUES(?,?,4663,1,'source-continuity',?,?)").run(OWNER_A, ACCOUNT_A, NOW - 60, NOW);
  const r = await read();
  assert.equal(r.phase, "recovery_hold");
  assert.deepEqual(r.next_steps.map(s => s.action), ["review_recovery"]);
});

test("an unreadable recovery report is an error, not a healthy setup", async () => {
  const { seed, call, d } = await setup();
  await seed();
  await d.db.exec(FLEET_RECOVERY_SCHEMA);
  await d.db.prepare("INSERT INTO fleet_recovery_health VALUES(?,?,4663,1,'unknown-cause',?,?)").run(OWNER_A, ACCOUNT_A, NOW - 60, NOW);
  const r = await call();
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent, undefined);
});

test("only a current enforced energy report marks the new-entry allowance exhausted", async () => {
  const { seed, read, d } = await setup();
  const energy = { v: 1, gated: true, mode: "enforce", level: "low", agentTokens: 0, holderTokens: null,
    holderCounted: false, needTokens: 1000, day: new Date(NOW * 1000).toISOString().slice(0, 10), resetsAt: NOW + 3600,
    reviews: null, entries: { used: 2, allowed: 2 }, spent: true, buy: "ready", estimateUsdg: null, at: NOW - 20 };
  await seed({ energy });
  assert.equal((await read()).phase, "energy_limited");
  await d.db.prepare("UPDATE agents SET energy=?").run(JSON.stringify({ ...energy, at: NOW - 3600 }));
  let r = await read();
  assert.equal(r.phase, "live");
  assert.equal(r.agent?.energy?.entry_allowance_exhausted, null);
  await d.db.prepare("UPDATE agents SET energy=?").run(JSON.stringify({ ...energy, gated: false, mode: "observe" }));
  r = await read();
  assert.equal(r.phase, "live");
  assert.equal(r.agent?.energy?.entry_allowance_exhausted, false);
});

test("directory connections get read-only setup without proposal capabilities", async () => {
  const { seed, read } = await setup({ profile: "directory" });
  await seed();
  const r = await read();
  assert.equal(r.phase, "live");
  assert.equal(r.connection.can_create_draft, false);
  assert.equal(r.connection.can_propose_settings, false);
  assert.ok(r.next_steps.every(s => s.tool !== "create_merryman" && s.tool !== "propose_settings_change"));
  assert.ok(!r.connection.available_tools.includes("create_merryman"));
  assert.ok(!r.connection.available_tools.includes("propose_settings_change"));
});

test("directory profile suppresses sensitive drafts while honoring its allowed notification capability", async () => {
  const { seed, principal } = await setup({ profile: "directory" });
  await seed();
  const result = await runTool(def, {}, { ...principal, scopes: new Set([...principal.scopes, "notifications:manage", "drafts:write"]) }, "setup-test", { now: () => NOW });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  const r = result.structuredContent as unknown as Setup;
  assert.equal(r.connection.can_create_draft, false);
  assert.ok(!r.connection.available_tools.some(tool => ["create_merryman", "propose_settings_change", "create_agent_draft"].includes(tool)));
  assert.ok(["subscribe", "unsubscribe", "list_subscriptions", "list_notification_channels"].every(tool => r.connection.available_tools.includes(tool)));
});

test("home actions expose only real tools covered by the selected agent's connection", async () => {
  const { seed, read } = await setup({ scopes: ["market:read", "agents:read", "portfolio:read", "decisions:read", "notifications:manage", "drafts:write"] });
  await seed();
  const r = await read();
  assert.deepEqual(r.connection.available_tools, ["get_merryman_setup", "list_agents", "get_proposal", "list_proposals", "cancel_proposal", "get_agent_status", "get_agent_controls", "get_agent_settings",
    "get_portfolio", "get_trades", "list_decisions", "get_refusals", "list_notification_channels", "list_subscriptions",
    "subscribe", "unsubscribe", "create_agent_draft", "propose_settings_change"]);
  assert.ok(r.connection.available_tools.includes("get_agent_settings"));
});
