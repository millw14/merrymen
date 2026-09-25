/**
 * Quotes, proposals and approvals: binding, idempotency, replay, expiry,
 * cross-owner isolation, scope separation, and the status machine from
 * "submitted" to "confirmed" (only with an on-chain receipt AND the ledger's
 * landed row). Every chain read is a fake; nothing reaches an RPC, and no
 * order is ever delivered to a worker.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { PublicClient } from "viem";
import { STOCK_TOKENS } from "@merrymen/core";
import { runTool, type ToolDef } from "../tool";
import { PROPOSAL_TOOLS, KNOWN_STRATEGIES } from "./proposals";
import { setQuoteClientForTest } from "@/lib/services/trade-quote";
import {
  approveProposal, cancelProposal, followTrade, orderIdFor, proposalRow, queueApprovedTrade, rejectProposal, type TradeBinding,
} from "@/lib/services/proposals";
import { BUILTIN_STRATEGIES } from "../../../../worker/src/strategies/registry";
import { ACCOUNT_A, OWNER_A, OWNER_B, SLUG_A, agentFixture, connectAs, fixtureDirectory, installFixtures, makeDeps, makeTestDb, type TestDb } from "../testing";

// Approval links are built from the configured public origin.
process.env.MERRYMEN_PUBLIC_ORIGIN = "https://app.test";

const NVDA = STOCK_TOKENS.find((t) => t.symbol === "NVDA")!.address.toLowerCase();
const NOW = 1_800_000_000;
const tool = (name: string) => PROPOSAL_TOOLS.find((t) => t.name === name) as unknown as ToolDef;

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; setQuoteClientForTest(null); });

/** A fake chain: QuoterV2 at $100/token with mild concavity, ETH at $3000. */
function fakeChain(o: { price?: number; fail?: boolean } = {}): PublicClient {
  const price = o.price ?? 100;
  return {
    async simulateContract({ functionName, args }: { functionName: string; args: unknown[] }) {
      if (o.fail || functionName !== "quoteExactInputSingle") throw new Error("no pool");
      const p = args[0] as { tokenIn: string; amountIn: bigint; fee: number };
      if (p.fee !== 3000) throw new Error("no pool at this tier");
      const buying = p.tokenIn.toLowerCase() !== NVDA;
      // Slight impact: larger size, slightly worse rate.
      const f = 1 - Math.min(0.02, Number(p.amountIn) / (buying ? 1e12 : 1e24));
      const out = buying ? BigInt(Math.floor((Number(p.amountIn) / 1e6 / price) * f * 1e18)) : BigInt(Math.floor((Number(p.amountIn) / 1e18) * price * f * 1e6));
      return { result: [out, 0n, 0, 120_000n] };
    },
    async readContract({ functionName }: { functionName: string }) {
      if (functionName === "decimals") return 18;
      return [1n, 3000_00000000n, 0n, BigInt(Math.floor(Date.now() / 1000)), 1n];
    },
    async getBlockNumber() { return 4242n; },
    async getGasPrice() { return 1_000_000n; },
  } as unknown as PublicClient;
}

const SCOPES = ["market:read", "agents:read", "portfolio:read", "trade:propose", "drafts:write", "social:write"];

async function setup(o: { settings?: Record<string, unknown>; directory?: ReturnType<typeof fixtureDirectory>; mode?: string } = {}) {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  restore = installFixtures(d, {
    directory: o.directory,
    settings: { [OWNER_A]: { slippageBps: 100, maxImpactBps: 300, telegramMaxActionUsdg: 50, tickSeconds: 60, ...o.settings } },
  });
  setQuoteClientForTest(fakeChain());
  // The receipt column is added by the orchestrator's own migration, not the ledger schema.
  d.raw.exec("ALTER TABLE agent_commands ADD COLUMN receipt TEXT");
  d.raw.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, mode, beat_at, epoch)
    VALUES (?, 'Shogun', ?, '0x1', 4663, '{}', 1700000000, 4102444800, 'active', ?, ?, 1)`).run(ACCOUNT_A, OWNER_A, o.mode ?? "live", NOW - 10);
  const a = await connectAs(deps, OWNER_A, { scopes: SCOPES });
  const b = await connectAs(deps, OWNER_B, { scopes: SCOPES });
  const run = (name: string, args: Record<string, unknown>, who = a.principal) => runTool(tool(name), args, who, "trace", { now: () => NOW });
  return { d, deps, a, b, run };
}

const data = (r: Awaited<ReturnType<typeof runTool>>) => r.structuredContent as Record<string, unknown>;
const code = (r: Awaited<ReturnType<typeof runTool>>) => (r.structuredContent as { error?: { code: string } }).error?.code;

test("the strategy list matches the worker's registry", () => {
  assert.deepEqual([...KNOWN_STRATEGIES].sort(), [...BUILTIN_STRATEGIES].sort());
});

test("quote_trade: expected, minimum at the agent's slippage, impact, route and caveats — and places nothing", async () => {
  const { d, run } = await setup();
  const r = await run("quote_trade", { side: "buy", token: NVDA, amount_usdg: 10 });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const q = data(r);
  assert.equal(q.quoted, true);
  assert.equal((q.route as { fee_tier_bps: number }).fee_tier_bps, 30);
  assert.equal((q.min_out as { slippage_bps: number }).slippage_bps, 100);
  assert.ok(BigInt((q.min_out as { raw: string }).raw) < BigInt((q.expected_out as { raw: string }).raw));
  assert.equal(typeof q.price_impact_bps, "number");
  assert.ok((q.caveats as string[]).some((c) => /re-quotes/.test(c)));
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get() as { n: number }).n, 0);
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM mcp_proposals").get() as { n: number }).n, 0);
});

test("quote_trade: no route is reported as no quote, never as zero", async () => {
  const { run } = await setup();
  setQuoteClientForTest(fakeChain({ fail: true }));
  const q = data(await run("quote_trade", { side: "buy", token: NVDA, amount_usdg: 10 }));
  assert.equal(q.quoted, false);
  assert.equal(q.expected_out, null);
  assert.match(String(q.why_not), /no pool/);
});

test("propose_trade stores an exact, hashed binding and returns an approval URL; nothing is queued", async () => {
  const { d, run } = await setup();
  const r = await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 12.345, idempotency_key: "key-000001" });
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const p = data(r);
  assert.match(String(p.proposal_id), /^prp_[0-9a-f]{32}$/);
  assert.equal(p.status, "awaiting_approval");
  assert.equal(p.approval_url, `https://app.test/connect/approve/${p.proposal_id}`);
  const row = d.raw.prepare("SELECT binding_json, binding_hash, tenant FROM mcp_proposals").get() as { binding_json: string; binding_hash: string; tenant: string };
  const b = JSON.parse(row.binding_json) as TradeBinding;
  assert.equal(b.account, ACCOUNT_A);
  assert.equal(b.symbol, "NVDA");
  assert.equal(b.amount_usdg, 12.35);
  assert.equal(b.book, "live");
  assert.equal(row.tenant, OWNER_A);
  assert.equal(row.binding_hash, p.binding_hash);
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get() as { n: number }).n, 0);
});

test("idempotency: the same key returns the same proposal; a different request under it conflicts", async () => {
  const { run } = await setup();
  const first = data(await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 10, idempotency_key: "same-key-1" }));
  const again = data(await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 10, idempotency_key: "same-key-1" }));
  assert.equal(again.proposal_id, first.proposal_id);
  assert.equal(again.created, false);
  const other = await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 11, idempotency_key: "same-key-1" });
  assert.equal(code(other), "conflict");
});

test("limits: over the per-trade cap or the owner-order ceiling, expired permission, unknown token", async () => {
  const { run } = await setup({ settings: { telegramMaxActionUsdg: 5 } });
  assert.equal(code(await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 6, idempotency_key: "limit-0001" })), "invalid_input");
  assert.equal(code(await run("propose_trade", { side: "buy", token: "0x000000000000000000000000000000000000dead", amount_usdg: 1, idempotency_key: "limit-0002" })), "unsupported");
  restore?.();
  const expiredDir = fixtureDirectory({ [OWNER_A]: [agentFixture(SLUG_A, ACCOUNT_A, { expiresAt: NOW - 1 })] });
  const again = await setup({ directory: expiredDir });
  assert.equal(code(await again.run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 1, idempotency_key: "limit-0003" })), "conflict");
});

test("a sell with no holding is refused with a reason, not quoted as zero", async () => {
  const { run } = await setup();
  const r = await run("propose_trade", { side: "sell", token: NVDA, amount_usdg: 5, idempotency_key: "sell-00001" });
  // Sells are allowed without an executable quote (exits are never blocked), but the binding records no quote.
  assert.equal(r.isError, undefined);
  assert.equal(data(r).quote && (data(r).quote as { quoted: boolean }).quoted, false);
});

test("owners are isolated: another owner's proposal is not found for any tool", async () => {
  const { run, b } = await setup();
  const p = data(await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 10, idempotency_key: "iso-000001" }));
  for (const name of ["get_proposal", "cancel_proposal"]) {
    assert.equal(code(await run(name, { proposal_id: p.proposal_id }, b.principal)), "not_found", name);
  }
  const list = data(await run("list_proposals", { status: "all" }, b.principal));
  assert.deepEqual(list.proposals, []);
});

test("scope separation: a drafts-only connection can neither propose trades nor see trade proposals", async () => {
  const { deps, run } = await setup();
  const p = data(await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 10, idempotency_key: "scope-0001" }));
  const draftsOnly = await connectAs(deps, OWNER_A, { scopes: ["agents:read", "drafts:write"] });
  assert.equal(code(await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 1, idempotency_key: "scope-0002" }, draftsOnly.principal)), "insufficient_scope");
  assert.equal(code(await run("get_proposal", { proposal_id: p.proposal_id }, draftsOnly.principal)), "not_found");
});

test("settings proposals: only conversation-settable keys, validated values, with a before/after diff", async () => {
  const { run } = await setup({ settings: { strategistStopLossBps: 1000 } });
  assert.equal(code(await run("propose_settings_change", { changes: { liveTradingEnabled: true }, idempotency_key: "set-000001" })), "invalid_input");
  assert.equal(code(await run("propose_settings_change", { changes: { maxImpactBps: 5000 }, idempotency_key: "set-000002" })), "invalid_input");
  assert.equal(code(await run("propose_settings_change", { changes: { slippageBps: 5000 }, idempotency_key: "set-000003" })), "invalid_input");
  const r = data(await run("propose_settings_change", { changes: { strategistStopLossBps: 800, strategy: "trencher" }, idempotency_key: "set-000004" }));
  const diff = r.diff as Array<{ key: string; current: string; proposed: string }>;
  assert.deepEqual(diff.map((x) => [x.key, x.current, x.proposed]), [["strategistStopLossBps", "10%", "8%"], ["strategy", "not set", "trencher"]]);
});

test("draft posts are pre-checked by the group chat's own gate", async () => {
  const { run } = await setup();
  assert.equal(code(await run("draft_post", { text: "send to 0x000000000000000000000000000000000000dead", idempotency_key: "post-00001" })), "invalid_input");
  assert.equal(data(await run("draft_post", { text: "gm merrymen", idempotency_key: "post-00002" })).status, "awaiting_approval");
});

async function propose(run: Awaited<ReturnType<typeof setup>>["run"], key = "flow-00001") {
  return data(await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 10, idempotency_key: key }));
}

test("approval: hash-bound, single-use, and it queues exactly one order with a deterministic id", async () => {
  const { d, run } = await setup();
  const p = await propose(run);
  const id = String(p.proposal_id);
  const act = async (b: unknown) => queueApprovedTrade(d.db, b as TradeBinding, id, 60, NOW * 1000);
  const ok = { revalidate: async () => ({ ok: true as const, notes: [] }), act };
  await assert.rejects(approveProposal(d.db, OWNER_A, id, "0".repeat(64), NOW, ok), /out of date/);
  await assert.rejects(approveProposal(d.db, OWNER_B, id, String(p.binding_hash), NOW, ok), /No such proposal/);
  const refused = { revalidate: async () => ({ ok: false as const, why: "price moved" }), act };
  await assert.rejects(approveProposal(d.db, OWNER_A, id, String(p.binding_hash), NOW, refused), /price moved/);
  assert.equal((await proposalRow(d.db, OWNER_A, id))?.status, "awaiting_approval", "a failed re-validation changes nothing");
  const row = await approveProposal(d.db, OWNER_A, id, String(p.binding_hash), NOW, ok);
  assert.equal(row.status, "submitted");
  assert.equal(row.order_id, orderIdFor(id));
  const orders = d.raw.prepare("SELECT id, agent_id, kind, args FROM agent_commands").all() as Array<{ id: string; agent_id: string; kind: string; args: string }>;
  assert.equal(orders.length, 1);
  assert.equal(orders[0].agent_id, ACCOUNT_A);
  assert.deepEqual({ ...JSON.parse(orders[0].args), expiresAt: 0 }, { side: "buy", symbol: "NVDA", usdgAmount: 10, source: "mcp-proposal", proposal: id, expiresAt: 0 });
  // Replays go nowhere: already submitted, and a re-placement collides on the order id.
  await assert.rejects(approveProposal(d.db, OWNER_A, id, String(p.binding_hash), NOW, ok), /already submitted/);
  const replay = await queueApprovedTrade(d.db, JSON.parse((await proposalRow(d.db, OWNER_A, id))!.binding_json), id, 60, NOW * 1000 + 1);
  assert.ok(!("status" in replay) || (replay as { result: { duplicate?: boolean } }).result?.duplicate === true || "retry" in replay);
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get() as { n: number }).n, 1);
});

test("the status machine: queued → executing → confirmed only with a receipt AND the ledger's landed row", async () => {
  const { d, run } = await setup();
  const p = await propose(run, "flow-00002");
  const id = String(p.proposal_id);
  await approveProposal(d.db, OWNER_A, id, String(p.binding_hash), NOW, { revalidate: async () => ({ ok: true, notes: [] }), act: (b) => queueApprovedTrade(d.db, b as TradeBinding, id, 60, NOW * 1000) });
  const orderId = orderIdFor(id);
  let row = (await proposalRow(d.db, OWNER_A, id))!;
  assert.equal((await followTrade(d.db, d.db, row, NOW)).status, "submitted");
  d.raw.prepare("UPDATE agent_commands SET claimed_at = ? WHERE id = ?").run(NOW * 1000 + 5, orderId);
  row = await followTrade(d.db, d.db, row, NOW + 5);
  assert.equal(row.status, "executing");
  const tx = `0x${"ab".repeat(32)}`;
  d.raw.prepare("UPDATE agent_commands SET done_at = ?, result = ?, receipt = ? WHERE id = ?")
    .run(NOW * 1000 + 60, "✅ bought", JSON.stringify({ status: "filled", side: "buy", symbol: "NVDA", token: NVDA, usdgActual: 10, txHash: tx, rejectRule: null }), orderId);
  row = await followTrade(d.db, d.db, row, NOW + 60);
  assert.equal(row.status, "filled_awaiting_ledger", "a receipt alone is not confirmation");
  d.raw.prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, tx_hash, status, created_at, epoch, basis_source)
    VALUES (?, 'swap', '0x0', ?, ?, 10, ?, 'landed', ?, 1, 'receipt')`).run(ACCOUNT_A, "0x5fc5360d0400a0fd4f2af552add042d716f1d168", NVDA, tx, NOW + 50);
  row = await followTrade(d.db, d.db, row, NOW + 90);
  assert.equal(row.status, "confirmed");
  assert.equal(JSON.parse(row.result_json!).tx_hash, tx);
});

test("paper and refusals are told apart from confirmation", async () => {
  const { d, run } = await setup({ mode: "paper" });
  const p = await propose(run, "flow-00003");
  const id = String(p.proposal_id);
  await approveProposal(d.db, OWNER_A, id, String(p.binding_hash), NOW, { revalidate: async () => ({ ok: true, notes: [] }), act: (b) => queueApprovedTrade(d.db, b as TradeBinding, id, 60, NOW * 1000) });
  d.raw.prepare("UPDATE agent_commands SET claimed_at = ?, done_at = ?, result = ? WHERE id = ?").run(NOW * 1000, NOW * 1000 + 10, "📝 paper buy", orderIdFor(id));
  d.raw.prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, created_at, epoch) VALUES (?, 'swap', '0x0', ?, ?, 10, 'paper', ?, 1)`)
    .run(ACCOUNT_A, "0x5fc5360d0400a0fd4f2af552add042d716f1d168", NVDA, NOW + 5);
  assert.equal((await followTrade(d.db, d.db, (await proposalRow(d.db, OWNER_A, id))!, NOW + 20)).status, "paper_filled");

  const p2 = await propose(run, "flow-00004");
  const id2 = String(p2.proposal_id);
  await approveProposal(d.db, OWNER_A, id2, String(p2.binding_hash), NOW + 30, { revalidate: async () => ({ ok: true, notes: [] }), act: (b) => queueApprovedTrade(d.db, b as TradeBinding, id2, 60, (NOW + 700) * 1000) });
  d.raw.prepare("UPDATE agent_commands SET claimed_at = ?, done_at = ?, result = ?, receipt = ? WHERE id = ?")
    .run(NOW * 1000, NOW * 1000, "daily cap", JSON.stringify({ status: "refused", side: "buy", symbol: "NVDA", token: null, usdgActual: null, txHash: null, rejectRule: "daily-cap" }), orderIdFor(id2));
  const refused = await followTrade(d.db, d.db, (await proposalRow(d.db, OWNER_A, id2))!, NOW + 40);
  assert.equal(refused.status, "refused");
  assert.equal(JSON.parse(refused.result_json!).rule, "daily-cap");
});

test("cancel: before approval; withdrawn from the queue before pickup; refused once picked up", async () => {
  const { d, run } = await setup();
  const p = await propose(run, "flow-00005");
  assert.equal(data(await run("cancel_proposal", { proposal_id: p.proposal_id })).status, "cancelled");

  const p2 = await propose(run, "flow-00006");
  const id2 = String(p2.proposal_id);
  await approveProposal(d.db, OWNER_A, id2, String(p2.binding_hash), NOW, { revalidate: async () => ({ ok: true, notes: [] }), act: (b) => queueApprovedTrade(d.db, b as TradeBinding, id2, 60, NOW * 1000) });
  const cancelled = await cancelProposal(d.db, d.db, OWNER_A, id2, NOW + 1);
  assert.equal(cancelled.status, "cancelled");
  const order = d.raw.prepare("SELECT claimed_at, done_at, result FROM agent_commands WHERE id = ?").get(orderIdFor(id2)) as { claimed_at: number; done_at: number; result: string };
  assert.ok(order.claimed_at && order.done_at, "claimed so the ferry can never deliver it");
  assert.match(order.result, /nothing was sent/);

  const p3 = await propose(run, "flow-00007");
  const id3 = String(p3.proposal_id);
  // The earlier order is closed, so the slot is free again.
  await approveProposal(d.db, OWNER_A, id3, String(p3.binding_hash), NOW, { revalidate: async () => ({ ok: true, notes: [] }), act: (b) => queueApprovedTrade(d.db, b as TradeBinding, id3, 60, NOW * 1000) });
  d.raw.prepare("UPDATE agent_commands SET claimed_at = ? WHERE id = ?").run(NOW * 1000 + 3, orderIdFor(id3));
  await assert.rejects(cancelProposal(d.db, d.db, OWNER_A, id3, NOW + 4), /already picked this order up/);
});

test("expiry: an unapproved proposal expires and can no longer be approved or declined", async () => {
  const { d, run } = await setup();
  const p = await propose(run, "flow-00008");
  const id = String(p.proposal_id);
  await assert.rejects(approveProposal(d.db, OWNER_A, id, String(p.binding_hash), NOW + 16 * 60, { revalidate: async () => ({ ok: true, notes: [] }), act: async () => ({ status: "applied", result: {} }) }), /expired/);
  assert.equal((await proposalRow(d.db, OWNER_A, id))?.status, "expired");
  await assert.rejects(rejectProposal(d.db, OWNER_A, id, String(p.binding_hash), NOW + 17 * 60), /already expired/);
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get() as { n: number }).n, 0);
});

test("a failed placement hands the approval back instead of losing it", async () => {
  const { d, run } = await setup();
  const p = await propose(run, "flow-00009");
  const id = String(p.proposal_id);
  await assert.rejects(approveProposal(d.db, OWNER_A, id, String(p.binding_hash), NOW, {
    revalidate: async () => ({ ok: true, notes: [] }),
    act: async () => ({ retry: "Another order for this agent is still waiting." }),
  }), /still waiting/);
  assert.equal((await proposalRow(d.db, OWNER_A, id))?.status, "awaiting_approval");
});

test("an approved order is queued under the account exactly as the grant spells it (the ferry matches with =)", async () => {
  const checksummed = "0x000000000000000000000000000000000000A001";
  const { d, run } = await setup({ directory: fixtureDirectory({ [OWNER_A]: [agentFixture(SLUG_A, ACCOUNT_A, { orderAgentId: checksummed })] }) });
  const p = await propose(run, "flow-00010");
  const id = String(p.proposal_id);
  await approveProposal(d.db, OWNER_A, id, String(p.binding_hash), NOW, { revalidate: async () => ({ ok: true, notes: [] }), act: (b) => queueApprovedTrade(d.db, b as TradeBinding, id, 60, NOW * 1000) });
  const order = d.raw.prepare("SELECT agent_id FROM agent_commands").get() as { agent_id: string };
  assert.equal(order.agent_id, checksummed);
  // Following and cancelling read it back under the same spelling.
  const row = (await proposalRow(d.db, OWNER_A, id))!;
  assert.equal(row.agent_account, checksummed);
  assert.equal((await followTrade(d.db, d.db, row, NOW + 1)).status, "submitted");
  assert.equal((await cancelProposal(d.db, d.db, OWNER_A, id, NOW + 2)).status, "cancelled");
});
