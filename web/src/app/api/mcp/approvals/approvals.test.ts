/**
 * The owner-approval route: only the proposal's own owner, only same-origin,
 * only for the exact binding the page showed, only once, and refused when the
 * agent's book changed since the proposal (practice vs real money).
 */
import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import type { PublicClient } from "viem";
import { STOCK_TOKENS } from "@merrymen/core";
import { mintSession } from "@/lib/auth";
import { setQuoteClientForTest } from "@/lib/services/trade-quote";
import { runTool, type ToolDef } from "@/mcp/tool";
import { PROPOSAL_TOOLS } from "@/mcp/tools/proposals";
import { ACCOUNT_A, OWNER_A, OWNER_B, connectAs, installFixtures, makeDeps, makeTestDb, type TestDb } from "@/mcp/testing";
import { GET, POST } from "./[id]/route";

const NVDA = STOCK_TOKENS.find((t) => t.symbol === "NVDA")!.address.toLowerCase();

before(() => {
  process.env.MERRYMEN_HOSTED = "1";
  process.env.DATABASE_URL = "postgres://unused-in-tests";
  process.env.MERRYMEN_PUBLIC_ORIGIN = "https://app.test";
  process.env.MERRYMEN_SESSION_SECRET = "s".repeat(48);
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

async function setup(mode = "paper") {
  const d: TestDb = await makeTestDb();
  restore = installFixtures(d, { settings: { [OWNER_A]: { telegramMaxActionUsdg: 50, slippageBps: 100, tickSeconds: 60 } } });
  setQuoteClientForTest(fakeChain);
  d.raw.exec("ALTER TABLE agent_commands ADD COLUMN receipt TEXT");
  d.raw.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, mode, beat_at, epoch)
    VALUES (?, 'A', ?, '0x1', 4663, '{}', 1, 4102444800, 'active', ?, ?, 1)`).run(ACCOUNT_A, OWNER_A, mode, Math.floor(Date.now() / 1000));
  const deps = makeDeps(d);
  const a = await connectAs(deps, OWNER_A, { scopes: ["agents:read", "trade:propose"] });
  const tool = PROPOSAL_TOOLS.find((t) => t.name === "propose_trade") as unknown as ToolDef;
  const r = await runTool(tool, { side: "buy", token: NVDA, amount_usdg: 5, idempotency_key: "route-test-1" }, a.principal, "t");
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const p = r.structuredContent as { proposal_id: string; binding_hash: string };
  return { d, id: p.proposal_id, hash: p.binding_hash };
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
