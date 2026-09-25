/**
 * The owner-approval route: only the proposal's own owner, only same-origin,
 * only for the exact binding the page showed, only once, and refused when the
 * agent's book changed since the proposal (practice vs real money), when a
 * setting moved since it was proposed, or when a draft carries anything but
 * chat-settable settings.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, test } from "node:test";
import type { PublicClient } from "viem";
import { STOCK_TOKENS } from "@merrymen/core";
import { mintSession } from "@/lib/auth";
import { setQuoteClientForTest } from "@/lib/services/trade-quote";
import { createProposal } from "@/lib/services/proposals";
import { runTool, type ToolDef } from "@/mcp/tool";
import { PROPOSAL_TOOLS } from "@/mcp/tools/proposals";
import type { AgentDirectory } from "@/mcp/agents";
import { ACCOUNT_A, OWNER_A, OWNER_B, SLUG_A, agentFixture, connectAs, fixtureDirectory, installFixtures, makeDeps, makeTestDb, type TestDb } from "@/mcp/testing";
import { GET, POST } from "./[id]/route";

const NVDA = STOCK_TOKENS.find((t) => t.symbol === "NVDA")!.address.toLowerCase();

before(() => {
  process.env.MERRYMEN_HOSTED = "1";
  process.env.DATABASE_URL = "postgres://unused-in-tests";
  process.env.MERRYMEN_PUBLIC_ORIGIN = "https://app.test";
  process.env.MERRYMEN_SESSION_SECRET = "s".repeat(48);
  // The house's fallback owner-order ceiling (resolveConfig): the shipped default, whatever this machine's settings file says.
  process.env.MERRYMEN_SETTINGS_FILE = join(tmpdir(), `merrymen-no-settings-${randomBytes(6).toString("hex")}.json`);
  delete process.env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG;
});

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; setQuoteClientForTest(null); });

const fakeChain = {
  async simulateContract({ args }: { args: unknown[] }) {
    const p = args[0] as { tokenIn: string; amountIn: bigint; fee: number };
    if (p.fee !== 3000) throw new Error("no pool");
    const out = p.tokenIn.toLowerCase() === NVDA ? p.amountIn / 10n ** 12n * 100n : (p.amountIn * 10n ** 12n) / 100n;
    return { result: [out, 0n, 0, 100_000n] };
  },
  async readContract() { return 18; },
  async getBlockNumber() { return 1n; },
  async getGasPrice() { return 1n; },
} as unknown as PublicClient;

const tool = (name: string) => PROPOSAL_TOOLS.find((t) => t.name === name) as unknown as ToolDef;

/**
 * The owner's settings are a live object the fixture reader reads on every
 * call, so a test can change them "on the dashboard" between proposal and
 * approval.
 */
async function base(o: { mode?: string; settings?: Record<string, unknown>; directory?: AgentDirectory; scopes?: string[] } = {}) {
  const d: TestDb = await makeTestDb();
  const settings: Record<string, unknown> = { telegramMaxActionUsdg: 50, slippageBps: 100, tickSeconds: 60, ...o.settings };
  restore = installFixtures(d, { settings: { [OWNER_A]: settings }, directory: o.directory });
  setQuoteClientForTest(fakeChain);
  d.raw.exec("ALTER TABLE agent_commands ADD COLUMN receipt TEXT");
  d.raw.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, mode, beat_at, epoch)
    VALUES (?, 'A', ?, '0x1', 4663, '{}', 1, 4102444800, 'active', ?, ?, 1)`).run(ACCOUNT_A, OWNER_A, o.mode ?? "paper", Math.floor(Date.now() / 1000));
  const deps = makeDeps(d);
  const a = await connectAs(deps, OWNER_A, { scopes: o.scopes ?? ["agents:read", "trade:propose"] });
  const run = async (name: string, args: Record<string, unknown>, who = a.principal) => {
    const r = await runTool(tool(name), args, who, "t");
    assert.equal(r.isError, undefined, JSON.stringify(r));
    const p = r.structuredContent as { proposal_id: string; binding_hash: string };
    return { id: p.proposal_id, hash: p.binding_hash };
  };
  return { d, deps, settings, run };
}

async function setup(mode = "paper") {
  const { d, run } = await base({ mode });
  const p = await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 5, idempotency_key: "route-test-1" });
  return { d, ...p };
}

function req(id: string, o: { owner?: `0x${string}` | null; method?: "GET" | "POST"; body?: unknown; origin?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const owner = o.owner === undefined ? OWNER_A : o.owner;
  if (owner) headers.cookie = `mm_session=${mintSession(owner)}`;
  const origin = o.origin === undefined ? "https://app.test" : o.origin;
  if (origin) headers.origin = origin;
  return new Request(`https://app.test/api/mcp/approvals/${id}`, { method: o.method ?? "POST", headers, body: o.body ? JSON.stringify(o.body) : undefined });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

test("only the proposal's owner can see or decide it, only same-origin, only with a session", async () => {
  const { id, hash } = await setup();
  assert.equal((await GET(req(id, { method: "GET", owner: null }), params(id))).status, 401);
  assert.equal((await GET(req(id, { method: "GET", owner: OWNER_B }), params(id))).status, 404);
  assert.equal((await GET(req(id, { method: "GET" }), params(id))).status, 200);
  assert.equal((await POST(req(id, { origin: "https://evil.test", body: { decision: "approve", hash } }), params(id))).status, 403);
  assert.equal((await POST(req(id, { origin: null, body: { decision: "approve", hash } }), params(id))).status, 403);
  assert.equal((await POST(req(id, { owner: OWNER_B, body: { decision: "approve", hash } }), params(id))).status, 404);
  assert.equal((await POST(req(id, { body: { decision: "approve", hash: "0".repeat(64) } }), params(id))).status, 409);
});

test("approve queues exactly one order under the agent's account, and a replay is refused", async () => {
  const { d, id, hash } = await setup();
  const res = await POST(req(id, { body: { decision: "approve", hash } }), params(id));
  const body = await res.json() as { status: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.status, "submitted");
  const orders = d.raw.prepare("SELECT agent_id, args FROM agent_commands").all() as Array<{ agent_id: string; args: string }>;
  assert.equal(orders.length, 1);
  assert.equal(orders[0].agent_id, ACCOUNT_A);
  assert.equal(JSON.parse(orders[0].args).symbol, "NVDA");
  const again = await POST(req(id, { body: { decision: "approve", hash } }), params(id));
  assert.equal(again.status, 409);
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get() as { n: number }).n, 1);
});

test("a book change between proposal and approval is refused: practice never becomes real money unseen", async () => {
  const { d, id, hash } = await setup("paper");
  d.raw.prepare("UPDATE agents SET mode = 'live' WHERE smart_account = ?").run(ACCOUNT_A);
  const res = await POST(req(id, { body: { decision: "approve", hash } }), params(id));
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error_description: string }).error_description, /live \(real money\)/);
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get() as { n: number }).n, 0);
  assert.equal((d.raw.prepare("SELECT status FROM mcp_proposals").get() as { status: string }).status, "awaiting_approval");
});

test("decline is final", async () => {
  const { d, id, hash } = await setup();
  assert.equal((await POST(req(id, { body: { decision: "reject", hash } }), params(id))).status, 200);
  assert.equal((await POST(req(id, { body: { decision: "approve", hash } }), params(id))).status, 409);
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get() as { n: number }).n, 0);
});

interface CheckRow { key: string; label: string; when_proposed: string; current: string; proposed: string; changed: boolean }
interface PageView { status: string; binding: Record<string, unknown>; settings_check: { rows: CheckRow[]; changed_since: string[]; applies_to_running_agent: boolean; left_out: string[] } }
const page = async (id: string) => (await (await GET(req(id, { method: "GET" }), params(id))).json()) as PageView;
const statusOf = (d: TestDb, id: string) => (d.raw.prepare("SELECT status FROM mcp_proposals WHERE id = ?").get(id) as { status: string }).status;
const CASHCAT = { symbol: "CASHCAT", address: "0x00000000000000000000000000000000000ca7ca", decimals: 18 };

test("a setting that moved since it was proposed is shown as it is now, and approving it is refused", async () => {
  const { d, settings, run } = await base({ settings: { strategistStopLossBps: 2500 }, scopes: ["agents:read", "drafts:write"] });
  const { id, hash } = await run("propose_settings_change", { changes: { strategistStopLossBps: 2000 }, idempotency_key: "l4-stop-01" });
  const first = await page(id);
  assert.deepEqual(first.settings_check.changed_since, []);
  assert.deepEqual([first.settings_check.rows[0].current, first.settings_check.rows[0].proposed], ["25%", "20%"]);
  // Meanwhile the owner tightens it on the dashboard: "25% → 20%" would now LOOSEN it from 10%.
  settings.strategistStopLossBps = 1000;
  const now = await page(id);
  assert.deepEqual(now.settings_check.changed_since, ["strategistStopLossBps"]);
  const row = now.settings_check.rows[0];
  assert.deepEqual([row.when_proposed, row.current, row.proposed, row.changed], ["25%", "10%", "20%", true]);
  const res = await POST(req(id, { body: { decision: "approve", hash } }), params(id));
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error_description: string }).error_description, /changed since this was proposed .*stop loss at.*fresh proposal/);
  assert.equal(statusOf(d, id), "awaiting_approval");
});

test("a draft for an owner who runs an agent is shown as a change to that agent, before and after", async () => {
  const { run } = await base({ settings: { slippageBps: 100 }, scopes: ["agents:read", "drafts:write"] });
  const { id } = await run("create_agent_draft", { risk_level: "careful", idempotency_key: "c3-run-001" });
  const v = await page(id);
  assert.equal(v.settings_check.applies_to_running_agent, true);
  const slip = v.settings_check.rows.find((r) => r.key === "slippageBps")!;
  assert.deepEqual([slip.current, slip.proposed], ["1%", "0.5%"]);
  assert.deepEqual(v.settings_check.left_out, ["maxImpactBps"]);
  assert.equal("maxImpactBps" in (v.binding.settings as Record<string, unknown>), false);
  assert.equal("salt" in v.binding, false);
});

test("a draft for an owner with no signed permission says it applies to nothing running yet", async () => {
  const noGrant = fixtureDirectory({ [OWNER_A]: [agentFixture(SLUG_A, ACCOUNT_A, { account: null, orderAgentId: null })] });
  const { run } = await base({ directory: noGrant, scopes: ["drafts:write"] });
  const { id } = await run("create_agent_draft", { strategy: "trencher", idempotency_key: "c3-new-001" });
  assert.equal((await page(id)).settings_check.applies_to_running_agent, false);
});

test("an approval never applies a safety floor, whatever a stored draft carries", async () => {
  const { d } = await base();
  const now = Math.floor(Date.now() / 1000);
  const { row } = await createProposal(d.db, {
    tenant: OWNER_A, connectionId: null, clientName: "t", summary: {}, idempotencyKey: "c3-floor-01", agentSlug: null, agentAccount: null, now,
    binding: { v: 1, kind: "agent_draft", tenant: OWNER_A, settings: { maxImpactBps: 500 }, before: { maxImpactBps: null }, risk_level: "bold", left_out: [], salt: "0".repeat(32), expires_at: now + 3600 },
  });
  const res = await POST(req(row.id, { body: { decision: "approve", hash: row.binding_hash } }), params(row.id));
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error_description: string }).error_description, /not allowed from here/);
  assert.equal(statusOf(d, row.id), "awaiting_approval");
});

test("an agentless draft's basket is checked against the owner's own tokens when they approve it", async () => {
  const { d, deps } = await base({ settings: { customTokens: [CASHCAT] } });
  const agentless = await connectAs(deps, OWNER_A, { scopes: ["drafts:write"], agents: [] });
  const draft = async (basket: string[], key: string) => {
    const r = await runTool(tool("create_agent_draft"), { basket, idempotency_key: key }, agentless.principal, "t");
    return r.structuredContent as { proposal_id: string; binding_hash: string };
  };
  const bad = await draft(["NOTMINE"], "c1-appr-01");
  const refused = await POST(req(bad.proposal_id, { body: { decision: "approve", hash: bad.binding_hash } }), params(bad.proposal_id));
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error_description: string }).error_description, /NOTMINE, which is not a stock token or a token you added/);
  assert.equal(statusOf(d, bad.proposal_id), "awaiting_approval");
  // The owner's own token passes the re-check and goes on to the settings route, which has no store in
  // this test: that is the 503 "nothing was changed, try again" — past revalidation, which answers 409.
  const good = await draft(["CASHCAT"], "c1-appr-02");
  const passed = await POST(req(good.proposal_id, { body: { decision: "approve", hash: good.binding_hash } }), params(good.proposal_id));
  assert.equal(passed.status, 503, await passed.text());
});

test("approval applies the house's owner-order ceiling when the owner has none stored", async () => {
  const wide = fixtureDirectory({ [OWNER_A]: [agentFixture(SLUG_A, ACCOUNT_A, { caps: { perTradeUsdg: 100, dailyUsdg: 1000, expiryDays: 30, maxDrawdownPct: 20, maxOpsPerDay: 20 } })] });
  const { d, settings, run } = await base({ directory: wide });
  const { id, hash } = await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 40, idempotency_key: "l5-route-1" });
  delete settings.telegramMaxActionUsdg;
  const res = await POST(req(id, { body: { decision: "approve", hash } }), params(id));
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error_description: string }).error_description, /over your 25 USDG limit/);
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get() as { n: number }).n, 0);
});
