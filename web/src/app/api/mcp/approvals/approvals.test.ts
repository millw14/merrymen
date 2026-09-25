/**
 * The owner-approval route: only the proposal's own owner, only same-origin,
 * only for the exact binding the page showed, only once, and refused when the
 * agent's book changed since the proposal (practice vs real money), when a
 * setting moved since it was proposed, or when a draft carries anything but
 * chat-settable settings.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, test } from "node:test";
import type { PublicClient } from "viem";
import { STOCK_TOKENS } from "@merrymen/core";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";
import { mintSession } from "@/lib/auth";
import { setQuoteClientForTest } from "@/lib/services/trade-quote";
import { createProposal } from "@/lib/services/proposals";
import { runTool, type ToolDef } from "@/mcp/tool";
import { PROPOSAL_TOOLS } from "@/mcp/tools/proposals";
import type { AgentDirectory } from "@/mcp/agents";
import { ACCOUNT_A, OWNER_A, OWNER_B, SLUG_A, agentFixture, connectAs, fixtureDirectory, installFixtures, makeDeps, makeTestDb, type TestDb } from "@/mcp/testing";
import { GET, POST } from "./[id]/route";
import { POST as connectionsPost } from "../connections/route";

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
  return { d, deps, settings, run, a };
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

test("a body that parses but is not an object (null, a number, an array) is a 400, not a crash", async () => {
  const { id } = await setup();
  for (const raw of ["null", "3", "[]", "\"approve\""]) {
    const r = new Request(`https://app.test/api/mcp/approvals/${id}`, {
      method: "POST", body: raw,
      headers: { "content-type": "application/json", origin: "https://app.test", cookie: `mm_session=${mintSession(OWNER_A)}` },
    });
    assert.equal((await POST(r, params(id))).status, 400, raw);
  }
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

test("the decision body is read bounded: an endless body is refused without being buffered, and the cap is in bytes", async () => {
  const { d, id, hash } = await setup();
  let pulled = 0;
  // 10 MiB offered one KiB at a time; the cap is 4 KiB.
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(1024).fill(0x20));
      if (pulled >= 10 * 1024) controller.close();
    },
  });
  const headers = { "content-type": "application/json", cookie: `mm_session=${mintSession(OWNER_A)}`, origin: "https://app.test" };
  const init = { method: "POST", headers, body: endless, duplex: "half" } as RequestInit;
  const res = await POST(new Request(`https://app.test/api/mcp/approvals/${id}`, init), params(id));
  assert.equal(res.status, 400);
  assert.ok(pulled <= 8, `read ${pulled} KiB of a body capped at 4 KiB`);
  // 1500 three-byte characters: under 4096 characters, over 4096 bytes.
  const wide = await POST(req(id, { body: { decision: "approve", hash, pad: "€".repeat(1500) } }), params(id));
  assert.equal(wide.status, 400);
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get() as { n: number }).n, 0);
  assert.equal(statusOf(d, id), "awaiting_approval");
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
  const { d, a } = await base({ scopes: ["agents:read", "drafts:write"] });
  const now = Math.floor(Date.now() / 1000);
  const draft = (key: string, connectionId: string | null) => createProposal(d.db, {
    tenant: OWNER_A, connectionId, clientName: "t", summary: {}, idempotencyKey: key, agentSlug: null, agentAccount: null, now,
    binding: { v: 1, kind: "agent_draft", tenant: OWNER_A, settings: { maxImpactBps: 500 }, before: { maxImpactBps: null }, risk_level: "bold", left_out: [], salt: "0".repeat(32), expires_at: now + 3600 },
  });
  const { row } = await draft("c3-floor-01", a.principal.connectionId);
  const res = await POST(req(row.id, { body: { decision: "approve", hash: row.binding_hash } }), params(row.id));
  assert.equal(res.status, 409);
  assert.match(((await res.json()) as { error_description: string }).error_description, /not allowed from here/);
  assert.equal(statusOf(d, row.id), "awaiting_approval");
  // A stored proposal no app can be traced to fails closed: cancelled, never approved.
  const { row: orphan } = await draft("c3-floor-02", null);
  const refused = await POST(req(orphan.id, { body: { decision: "approve", hash: orphan.binding_hash } }), params(orphan.id));
  assert.equal(refused.status, 409);
  assert.equal(statusOf(d, orphan.id), "cancelled");
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

// ── only tokens the worker watches (C1) ─────────────────────────────────────

const orders = (d: TestDb) => (d.raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get() as { n: number }).n;
const describe409 = async (res: Response) => ((await res.json()) as { error_description: string }).error_description;

test("approval re-resolves the token through the worker's watch set: a stock that left the basket is refused, nothing queued (C1)", async () => {
  const { d, settings, run } = await base();
  const { id, hash } = await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 5, idempotency_key: "c1-route-01" });
  // The owner narrows the basket on the dashboard: the worker no longer watches NVDA, so it would answer "I don't know NVDA".
  settings.basketSymbols = ["QQQ"];
  const res = await POST(req(id, { body: { decision: "approve", hash } }), params(id));
  assert.equal(res.status, 409);
  assert.match(await describe409(res), /not in the agent's basket, so the worker does not watch it and cannot trade it\..*Nothing was sent/);
  assert.equal(orders(d), 0);
  assert.equal(statusOf(d, id), "awaiting_approval");
});

// ── the app that asked must still stand behind it (S0) ──────────────────────

function connectionsReq(body: Record<string, unknown>) {
  return new Request("https://app.test/api/mcp/connections", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: "https://app.test", cookie: `mm_session=${mintSession(OWNER_A)}` },
  });
}
type Loose = { status: string; result: Record<string, unknown> | null; current_book?: string | null };
const looseView = async (id: string) => (await (await GET(req(id, { method: "GET" }), params(id))).json()) as Loose & Record<string, unknown>;

test("Disconnect cancels what the app left waiting, its approval link approves nothing, and an approved order stays the owner's (S0)", async () => {
  const { d, run, a } = await base();
  const done = await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 5, idempotency_key: "s0-route-1" });
  assert.equal((await POST(req(done.id, { body: { decision: "approve", hash: done.hash } }), params(done.id))).status, 200);
  const waiting = await run("propose_trade", { side: "sell", token: NVDA, amount_usdg: 5, idempotency_key: "s0-route-2" });
  const res = await connectionsPost(connectionsReq({ action: "revoke", id: a.principal.connectionId }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { revoked: true, proposals_cancelled: 1 });
  assert.equal(statusOf(d, waiting.id), "cancelled");
  assert.equal(statusOf(d, done.id), "submitted", "an order the owner already approved is not withdrawn by a disconnect");
  const shown = await looseView(waiting.id);
  assert.equal(shown.status, "cancelled");
  assert.match(String(shown.result?.why), /the app that prepared it was disconnected/);
  const approve = await POST(req(waiting.id, { body: { decision: "approve", hash: waiting.hash } }), params(waiting.id));
  assert.equal(approve.status, 409);
  assert.equal(orders(d), 1, "only the order approved before the disconnect");
});

test("the approval page cancels, and says why, a proposal whose app no longer holds the scope; approving it is refused (S0)", async () => {
  const { d, run, a } = await base();
  const { id, hash } = await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 5, idempotency_key: "s0-route-3" });
  // The owner re-consented the app without trade:propose.
  d.raw.prepare("UPDATE mcp_connections SET scopes = ? WHERE id = ?").run("agents:read", a.principal.connectionId);
  const shown = await looseView(id);
  assert.equal(shown.status, "cancelled");
  assert.match(String(shown.result?.why), /no longer allowed to ask for this/);
  assert.equal(shown.result?.requester_withdrawn, true);
  assert.equal((await POST(req(id, { body: { decision: "approve", hash } }), params(id))).status, 409);
  assert.equal(orders(d), 0);
});

// ── every chat-settable key reaches the store (C2) ──────────────────────────

test("an approved classExitAtGraduationPct change is saved and reported applied, never applied-but-ignored (C2)", async () => {
  const home = mkdtempSync(join(tmpdir(), "merrymen-approvals-settings-"));
  const saved = { home: process.env.MERRYMEN_HOME, db: process.env.DATABASE_URL };
  // The settings route writes the per-tenant store: a file store here, cached
  // before DATABASE_URL (which MCP needs to be enabled) is put back.
  process.env.MERRYMEN_HOME = home;
  delete process.env.DATABASE_URL;
  resetSettingsStoreForTest();
  getSettingsStore();
  process.env.DATABASE_URL = saved.db;
  try {
    const { run } = await base({ scopes: ["agents:read", "drafts:write"] });
    const { id, hash } = await run("propose_settings_change", { changes: { classExitAtGraduationPct: 50 }, idempotency_key: "c2-grad-01" });
    const res = await POST(req(id, { body: { decision: "approve", hash } }), params(id));
    const body = await res.json() as Loose;
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.status, "applied", JSON.stringify(body.result));
    assert.deepEqual(body.result?.applied, ["classExitAtGraduationPct"]);
    assert.equal(body.result?.not_applied, undefined);
    assert.equal(((await getSettingsStore().get(OWNER_A)) as unknown as Record<string, unknown>).classExitAtGraduationPct, 50);
  } finally {
    resetSettingsStoreForTest();
    if (saved.home === undefined) delete process.env.MERRYMEN_HOME;
    else process.env.MERRYMEN_HOME = saved.home;
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ── the practice / real-money box (L2) ──────────────────────────────────────

const approvePage = () => import("@/app/connect/approve/[id]/ApproveClient");

test("before a decision the box follows the agent's mode now, and a moved mode offers no Approve (L2)", async () => {
  const ui = await approvePage();
  const { d, id } = await setup("paper");
  const first = await looseView(id);
  assert.equal(first.current_book, "paper");
  assert.equal(ui.bookBox(first as never).warn, false);
  assert.equal(ui.approvable(first as never), true);
  d.raw.prepare("UPDATE agents SET mode = 'live' WHERE smart_account = ?").run(ACCOUNT_A);
  const moved = await looseView(id);
  assert.equal(moved.current_book, "live");
  const box = ui.bookBox(moved as never);
  assert.equal(box.warn, true);
  assert.match(box.text, /^Real money\..*When this was proposed it was in practice mode, so approving is refused/);
  assert.equal(ui.approvable(moved as never), false);
});

test("after a decision the box follows the outcome and says when it differs from the proposal; an unreported mode is a warning (L2)", async () => {
  const { bookBox } = await approvePage();
  const trade = (book: string, status: string, result: Record<string, unknown> | null = null, current_book: string | null = null) =>
    bookBox({ status, binding: { book }, result, current_book } as never);
  const wentLive = trade("paper", "confirmed", { tx_hash: `0x${"ab".repeat(32)}` });
  assert.equal(wentLive.warn, true);
  assert.match(wentLive.text, /went on chain with your agent.s real funds\. It was proposed while your agent was in practice mode\./);
  assert.doesNotMatch(wentLive.text, /practice mode right now/);
  const paper = trade("live", "paper_filled", { note: "a simulated fill" });
  assert.equal(paper.warn, false);
  assert.match(paper.text, /no money moved\. It was proposed while your agent was trading live\./);
  const reverted = trade("paper", "failed", { tx_hash: `0x${"cd".repeat(32)}` });
  assert.equal(reverted.warn, true, "a revert with a transaction was live");
  assert.match(reverted.text, /sent live and reverted on chain: nothing was traded, and only gas was spent/);
  assert.doesNotMatch(reverted.text, /went on chain with/, "a revert is not a trade that went through");
  const reported = trade("live", "filled_awaiting_ledger", { tx_hash: `0x${"ef".repeat(32)}` });
  assert.match(reported.text, /Your agent reports this trade went on chain.*the ledger has not confirmed it yet/);
  assert.doesNotMatch(trade("live", "confirmed", { tx_hash: `0x${"ab".repeat(32)}` }).text, /proposed while/);
  assert.match(trade("live", "refused", { why: "limits" }).text, /Nothing was traded/);
  const unknownOutcome = trade("live", "failed", { outcome_unknown: true });
  assert.equal(unknownOutcome.warn, true);
  assert.match(unknownOutcome.text, /could not be confirmed/);
  const unreported = trade("unknown", "awaiting_approval", null, "unknown");
  assert.equal(unreported.warn, true, "a mode the agent never reported may be live");
  assert.match(unreported.text, /may be live: real money/);
  const onTheWay = trade("paper", "submitted", null, "live");
  assert.equal(onTheWay.warn, true);
  assert.match(onTheWay.text, /trades live right now.*It was proposed while your agent was in practice mode/);
});

// ── the consent screen's badges (L1) ────────────────────────────────────────

test("the social:write badge does not promise an approval that follow and unfollow never ask for (L1)", async () => {
  const { scopeBadge } = await import("@/app/connect/app/ConsentClient");
  const social = scopeBadge({ id: "social:write", level: "sensitive" });
  assert.doesNotMatch(social, /each time/);
  assert.match(social, /^Change .*posts need your approval$/);
  // Scopes whose every action is a proposal keep the promise.
  assert.equal(scopeBadge({ id: "trade:propose", level: "sensitive" }), "Needs your approval each time");
  assert.equal(scopeBadge({ id: "drafts:write", level: "sensitive" }), "Needs your approval each time");
  assert.equal(scopeBadge({ id: "chat:write", level: "write" }), "Change");
});

// ── a session that ended mid-action (L3) ────────────────────────────────────

test("a session that ended mid-action reads 'sign in to finish', never a bare 'signed-out' (L3)", async () => {
  const approve = await approvePage();
  const apps = await import("@/app/connect/apps/AppsClient");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "login_required" }), { status: 401 })) as typeof fetch;
  try {
    const attempts = [
      approve.call(`prp_${"0".repeat(32)}`, { decision: "approve", hash: "0".repeat(64) }),
      apps.call("POST", { action: "revoke", id: `mcpcon_${"0".repeat(32)}` }),
      apps.call("POST", { action: "create_token", label: "x" }),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt, (e: Error & { signedOut?: boolean }) => {
        assert.equal(e.signedOut, true);
        assert.equal(e.message, "Your session ended; sign in to finish.");
        return true;
      });
    }
    assert.equal(approve.SESSION_ENDED, apps.SESSION_ENDED);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("after signing in again, a pressed decision is finished only for the same request, still waiting and still approvable (L3)", async () => {
  const { resumeDecision } = await approvePage();
  const nowMs = 1_800_000_000_000;
  const hash = "a".repeat(64);
  const v = (over: Record<string, unknown> = {}) => ({
    kind: "trade", status: "awaiting_approval", binding_hash: hash, expires_at: nowMs / 1000 + 600,
    binding: { book: "paper" }, settings_check: null, current_book: "paper", ...over,
  }) as never;
  assert.equal(resumeDecision({ decision: "approve", hash }, v(), nowMs), "approve");
  assert.equal(resumeDecision({ decision: "reject", hash }, v(), nowMs), "reject");
  assert.equal(resumeDecision(null, v(), nowMs), null);
  assert.equal(resumeDecision({ decision: "approve", hash }, null, nowMs), null, "signed in as someone else: the request is not theirs");
  assert.equal(resumeDecision({ decision: "approve", hash: "b".repeat(64) }, v(), nowMs), null);
  assert.equal(resumeDecision({ decision: "approve", hash }, v({ status: "cancelled" }), nowMs), null);
  assert.equal(resumeDecision({ decision: "approve", hash }, v({ expires_at: nowMs / 1000 - 1 }), nowMs), null);
  // The book moved while signed out: approving is not finished (the page offers no Approve); declining still is.
  assert.equal(resumeDecision({ decision: "approve", hash }, v({ current_book: "live" }), nowMs), null);
  assert.equal(resumeDecision({ decision: "reject", hash }, v({ current_book: "live" }), nowMs), "reject");
});

test("Connected apps finishes a Disconnect after sign-in only for an app the signed-in account still lists, and a token only for the same account (L3)", async () => {
  const { resumePlan } = await import("@/app/connect/apps/AppsClient");
  const listing = (ids: string[], agents: string[]) => ({ connections: ids.map((id) => ({ id })), agents: agents.map((slug) => ({ slug, account: null })) }) as never;
  const revoke = { kind: "revoke" as const, id: `mcpcon_${"1".repeat(32)}`, name: "Claude" };
  assert.deepEqual(resumePlan(revoke, listing([revoke.id], ["s1"]), listing([revoke.id], ["s1"])), { run: revoke });
  assert.match((resumePlan(revoke, listing([revoke.id], ["s1"]), listing([], ["s2"])) as { note: string }).note, /not connected to the account you signed in with, so nothing was disconnected/);
  assert.deepEqual(resumePlan({ kind: "create" }, listing([], ["s1"]), listing([], ["s1"])), { run: { kind: "create" } });
  assert.match((resumePlan({ kind: "create" }, listing([], ["s1"]), listing([], ["s2"])) as { note: string }).note, /different account, so no token was created/);
  assert.equal(resumePlan(revoke, null, null), null);
  assert.equal(resumePlan(null, null, listing([], [])), null);
});
