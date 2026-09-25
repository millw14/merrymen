/**
 * Quotes, proposals and approvals: binding, idempotency, replay, expiry,
 * cross-owner isolation, scope separation, and the status machine from
 * "submitted" to "confirmed" (only with an on-chain receipt AND the ledger's
 * landed row). Every chain read is a fake; nothing reaches an RPC, and no
 * order is ever delivered to a worker.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { PublicClient } from "viem";
import { STOCK_TOKENS } from "@merrymen/core";
import { runTool, type ToolDef } from "../tool";
import { PROPOSAL_TOOLS, KNOWN_STRATEGIES } from "./proposals";
import { setQuoteClientForTest } from "@/lib/services/trade-quote";
import {
  EVIDENCE_GRACE_SEC, approveProposal, cancelProposal, followTrade, orderIdFor, proposalRow, queueApprovedTrade, rejectProposal, workerSentence,
  type DraftBinding, type TradeBinding,
} from "@/lib/services/proposals";
import { BUILTIN_STRATEGIES } from "../../../../worker/src/strategies/registry";
import { ACCOUNT_A, OWNER_A, OWNER_B, SLUG_A, agentFixture, connectAs, fixtureDirectory, installFixtures, makeDeps, makeTestDb, type TestDb } from "../testing";

// Approval links are built from the configured public origin.
process.env.MERRYMEN_PUBLIC_ORIGIN = "https://app.test";
// The house's fallback owner-order ceiling is read from the web process's own
// settings file and env (resolveConfig): pinned to the shipped default here, so
// no settings file on the machine running the tests can move it.
process.env.MERRYMEN_SETTINGS_FILE = join(tmpdir(), `merrymen-no-settings-${randomBytes(6).toString("hex")}.json`);
delete process.env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG;

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
  ownerOrderTrade(d, { status: "paper", at: NOW + 5 });
  assert.equal((await followTrade(d.db, d.db, (await proposalRow(d.db, OWNER_A, id))!, NOW + 20)).status, "paper_filled");

  const p2 = await propose(run, "flow-00004");
  const id2 = String(p2.proposal_id);
  await approveProposal(d.db, OWNER_A, id2, String(p2.binding_hash), NOW + 30, { revalidate: async () => ({ ok: true, notes: [] }), act: (b) => queueApprovedTrade(d.db, b as TradeBinding, id2, 60, (NOW + 700) * 1000) });
  d.raw.prepare("UPDATE agent_commands SET claimed_at = ?, done_at = ?, result = ?, receipt = ? WHERE id = ?")
    .run(NOW * 1000, NOW * 1000, "daily cap", JSON.stringify({ status: "refused", side: "buy", symbol: "NVDA", token: null, usdgActual: null, txHash: null, rejectRule: "daily-cap" }), orderIdFor(id2));
  const refused = await followTrade(d.db, d.db, (await proposalRow(d.db, OWNER_A, id2))!, NOW + 40);
  assert.equal(refused.status, "refused");
  const why = JSON.parse(refused.result_json!) as Record<string, unknown>;
  assert.equal(why.rule, "daily-cap");
  assert.equal(typeof why.rule_label, "string", "described in Merrymen's own words");
  assert.equal("worker_line" in why, false);
});

// ── an owner order's own trade row (C2) ─────────────────────────────────────

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
let decisionSeq = 0;

/**
 * A trade row the way the worker writes one for an owner order: under a
 * decision it minted with source 'chat' (submitChatTrade → ensureDecision).
 * `source` lets a test write a strategy's own trade of the same token instead.
 */
function ownerOrderTrade(d: TestDb, o: { status: string; at: number; side?: "buy" | "sell"; token?: string; tx?: string | null; userOp?: string; source?: string; rule?: string }) {
  const side = o.side ?? "buy";
  const token = o.token ?? NVDA;
  const decision = `dec-${++decisionSeq}`;
  d.raw.prepare("INSERT INTO decisions (id, agent_id, source, symbol, action, size_usdg, reason, at) VALUES (?, ?, ?, 'NVDA', ?, 10, 'owner asked', ?)")
    .run(decision, ACCOUNT_A, o.source ?? "chat", side, o.at);
  d.raw.prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, reject_rule, decision_id, created_at, epoch)
    VALUES (?, 'swap', '0x0', ?, ?, 10, ?, ?, ?, ?, ?, ?, 1)`)
    .run(ACCOUNT_A, side === "buy" ? USDG : token, side === "buy" ? token : USDG, o.userOp ?? null, o.tx ?? null, o.status, o.rule ?? null, decision, o.at);
}

/** Propose, approve and have the worker answer the order: claimed at NOW, answered `doneAfter` seconds later. */
async function answered(ctx: Awaited<ReturnType<typeof setup>>, key: string, o: { doneAfter: number; line: string; receipt?: Record<string, unknown> }) {
  const { d, run } = ctx;
  const p = await propose(run, key);
  const id = String(p.proposal_id);
  await approveProposal(d.db, OWNER_A, id, String(p.binding_hash), NOW, { revalidate: async () => ({ ok: true, notes: [] }), act: (b) => queueApprovedTrade(d.db, b as TradeBinding, id, 60, NOW * 1000) });
  d.raw.prepare("UPDATE agent_commands SET claimed_at = ?, done_at = ?, result = ?, receipt = ? WHERE id = ?")
    .run(NOW * 1000, (NOW + o.doneAfter) * 1000, o.line, o.receipt ? JSON.stringify(o.receipt) : null, orderIdFor(id));
  const follow = async (at: number) => followTrade(d.db, d.db, (await proposalRow(d.db, OWNER_A, id))!, at);
  return { id, follow };
}

test("a paper fill that reaches the ledger after the worker answered is paper_filled, never failed", async () => {
  const ctx = await setup({ mode: "paper" });
  const { follow } = await answered(ctx, "late-paper-1", { doneAfter: 10, line: "📝 simulated buy 10.00 USDG of NVDA instead of trading for real. Your money did not move." });
  // The order is done but the mirror has not carried the row yet: nothing is concluded.
  const early = await follow(NOW + 12);
  assert.equal(early.status, "executing");
  assert.match(JSON.parse(early.result_json!).note, /waiting for its trade record/);
  assert.equal((await follow(NOW + 20)).status, "executing", "a second poll before the row arrives changes nothing");
  ownerOrderTrade(ctx.d, { status: "paper", at: NOW + 6 });
  const filled = await follow(NOW + 30);
  assert.equal(filled.status, "paper_filled");
  assert.match(JSON.parse(filled.result_json!).note, /no money moved/);
});

test("a live trade that lands after the worker answered 'in flight' ends confirmed, never failed", async () => {
  const ctx = await setup();
  const { follow } = await answered(ctx, "late-live-1", { doneAfter: 40, line: "🏹 sent buy 10.00 USDG of NVDA — it is in flight. Watch your trades for the fill." });
  assert.equal((await follow(NOW + 45)).status, "executing");
  const op = `0x${"cd".repeat(32)}`;
  ownerOrderTrade(ctx.d, { status: "submitted", at: NOW + 8, userOp: op });
  const sent = await follow(NOW + 50);
  assert.equal(sent.status, "executing");
  assert.match(JSON.parse(sent.result_json!).note, /sent to the chain/);
  // Long past the evidence deadline, a row that says 'submitted' is still evidence it was sent: not failed.
  assert.equal((await follow(NOW + 3600)).status, "executing");
  // Settled in place (store.ts addTrade / the mirror's resolution pass): same row, same created_at.
  const tx = `0x${"ef".repeat(32)}`;
  ctx.d.raw.prepare("UPDATE trades SET status = 'landed', tx_hash = ?, basis_source = 'receipt', fill_cash_usdg = 10 WHERE user_op_hash = ?").run(tx, op);
  const done = await follow(NOW + 3700);
  assert.equal(done.status, "confirmed");
  const r = JSON.parse(done.result_json!) as Record<string, unknown>;
  assert.equal(r.tx_hash, tx);
  assert.equal(r.usdg_actual, 10);
});

test("an unrelated trade of the same token is never taken for this order", async () => {
  const ctx = await setup();
  // Before the order was claimed: an earlier owner order for the same token.
  ownerOrderTrade(ctx.d, { status: "landed", at: NOW - 60, tx: `0x${"11".repeat(32)}` });
  const { follow } = await answered(ctx, "unrelated-1", { doneAfter: 20, line: "🏹 sent buy 10.00 USDG of NVDA — it is in flight." });
  // Inside the window, but the strategy's own buy, and an owner SELL of the same token.
  ownerOrderTrade(ctx.d, { status: "landed", at: NOW + 5, tx: `0x${"22".repeat(32)}`, source: "strategy:steady-basket" });
  ownerOrderTrade(ctx.d, { status: "reverted", at: NOW + 6, side: "sell", tx: `0x${"33".repeat(32)}` });
  const r = await follow(NOW + 30);
  assert.equal(r.status, "executing", JSON.stringify(r.result_json));
  assert.equal(JSON.parse(r.result_json!).tx_hash, undefined, "no other trade's hash is attributed to this order");
});

test("past the evidence deadline with no row of its own, the outcome is unknown: failed, and it says so", async () => {
  const ctx = await setup();
  const { follow } = await answered(ctx, "deadline-1", { doneAfter: 10, line: "🏹 sent buy 10.00 USDG of NVDA — it is in flight." });
  // The order's own deadline is NOW + the 5-minute floor (tick 60 s); the grace runs from there.
  const deadline = NOW + 300 + EVIDENCE_GRACE_SEC;
  assert.equal((await follow(deadline - 1)).status, "executing");
  const late = await follow(deadline + 1);
  assert.equal(late.status, "failed");
  const r = JSON.parse(late.result_json!) as Record<string, unknown>;
  assert.equal(r.outcome_unknown, true);
  assert.match(String(r.why), /could not be confirmed/);
});

// ── results never relay raw worker text (C11) ───────────────────────────────

const RAW = "🧱 refused. Nothing was sent and nothing was spent. (couldn't submit: RPC Request failed. URL: https://api.pimlico.io/v2/4663/rpc?apikey=pim_SECRETKEY)";
const leaks = (s: string) => /pim_|pimlico|apikey|couldn.?t submit|https?:/i.test(s);

test("a refusal's result is built from the rule vocabulary and the agent's sentence without its raw tail", async () => {
  const ctx = await setup();
  const refused = { status: "refused", side: "buy", symbol: "NVDA", token: null, usdgActual: null, txHash: null, rejectRule: null };
  // No rule anywhere: the agent's own sentence, cut before the provider text.
  const a = await answered(ctx, "raw-line-1", { doneAfter: 5, line: JSON.stringify({ line: RAW, receipt: refused }) });
  const first = await a.follow(NOW + 10);
  assert.equal(first.status, "refused");
  assert.equal(leaks(first.result_json!), false, first.result_json!);
  const r1 = JSON.parse(first.result_json!) as Record<string, unknown>;
  assert.equal(r1.agent_said_untrusted, "🧱 refused. Nothing was sent and nothing was spent.");
  assert.equal("worker_line" in r1, false);

  // The rule is on this order's own row, as free text the receipt's slug check dropped: classified, detail withheld.
  const b = await answered(ctx, "raw-line-2", { doneAfter: 5, line: RAW, receipt: refused });
  ownerOrderTrade(ctx.d, { status: "rejected", at: NOW + 2, rule: "couldn't submit: RPC Request failed. URL: https://api.pimlico.io/v2/4663/rpc?apikey=pim_SECRETKEY" });
  const second = await b.follow(NOW + 10);
  assert.equal(second.status, "refused");
  assert.equal(leaks(second.result_json!), false, second.result_json!);
  const r2 = JSON.parse(second.result_json!) as Record<string, unknown>;
  assert.equal(r2.rule, "couldnt-submit");
  assert.equal(r2.rule_detail_withheld, true);

  // And through the tool: nothing raw in the text or the structured result.
  const view = await ctx.run("get_proposal", { proposal_id: b.id });
  assert.equal(leaks(JSON.stringify(view)), false);
});

test("workerSentence keeps a bare rule slug and drops raw tails and links", () => {
  assert.equal(workerSentence("🧱 refused: over the daily cap. Nothing was sent. (daily-cap)"), "🧱 refused: over the daily cap. Nothing was sent. (daily-cap)");
  assert.equal(workerSentence("📝 simulated buy instead (preflight: quote 0x12 via https://rpc.example/key=abc)"), "📝 simulated buy instead");
  assert.equal(workerSentence("see https://evil.example/x now"), "see now");
  assert.equal(workerSentence(null), null);
});

// ── connections see only what they were given (C1) ─────────────────────────

test("a connection with no agent shared cannot see, read or cancel proposals about the agent", async () => {
  const ctx = await setup({ settings: { strategy: "steady-basket", strategistStopLossBps: 1000, customTokens: [{ symbol: "CASHCAT", address: "0x00000000000000000000000000000000000ca7ca", decimals: 18 }] } });
  const agentless = await connectAs(ctx.deps, OWNER_A, { scopes: ["drafts:write"], agents: [] });
  assert.deepEqual(agentless.principal.agentSlugs, []);
  const settings = data(await ctx.run("propose_settings_change", { changes: { strategistStopLossBps: 800 }, idempotency_key: "c1-set-001" }));
  const trade = await propose(ctx.run, "c1-trade-01");
  for (const p of [settings, trade]) {
    assert.equal(code(await ctx.run("get_proposal", { proposal_id: p.proposal_id }, agentless.principal)), "not_found");
    assert.equal(code(await ctx.run("cancel_proposal", { proposal_id: p.proposal_id }, agentless.principal)), "not_found");
  }
  assert.equal((await proposalRow(ctx.d.db, OWNER_A, String(settings.proposal_id)))?.status, "awaiting_approval", "not cancelled");
  // An agentless draft is its to make and to see — and only that.
  const draft = data(await ctx.run("create_agent_draft", { strategy: "trencher", idempotency_key: "c1-draft-01" }, agentless.principal));
  assert.equal(draft.status, "awaiting_approval");
  assert.equal(draft.diff, null, "no current values for a connection with no agent");
  assert.equal(JSON.stringify(draft.summary).includes("steady-basket"), false, "the owner's current strategy is not in what it reads");
  const listed = data(await ctx.run("list_proposals", { status: "all" }, agentless.principal)).proposals as Array<{ proposal_id: string }>;
  assert.deepEqual(listed.map((x) => x.proposal_id), [draft.proposal_id]);
  // The agent-shared connection still sees all three.
  assert.equal((data(await ctx.run("list_proposals", { status: "all" })).proposals as unknown[]).length, 3);
});

test("an agentless draft's basket reply does not depend on the owner's added tokens", async () => {
  const ctx = await setup({ settings: { customTokens: [{ symbol: "CASHCAT", address: "0x00000000000000000000000000000000000ca7ca", decimals: 18 }] } });
  const agentless = await connectAs(ctx.deps, OWNER_A, { scopes: ["drafts:write"], agents: [] });
  const mine = await ctx.run("create_agent_draft", { basket: ["CASHCAT"], idempotency_key: "c1-bask-01" }, agentless.principal);
  const notMine = await ctx.run("create_agent_draft", { basket: ["NOTMINE"], idempotency_key: "c1-bask-02" }, agentless.principal);
  assert.equal(mine.isError, undefined);
  assert.equal(notMine.isError, undefined, "same answer either way; the approval checks it");
  // With the agent shared, it is checked (and refused) here, as before.
  assert.equal(code(await ctx.run("create_agent_draft", { basket: ["NOTMINE"], idempotency_key: "c1-bask-03" })), "invalid_input");
});

// ── drafts carry only chat-settable settings (C3) ───────────────────────────

test("a risk-level draft leaves the price-impact floor out and says so", async () => {
  const ctx = await setup({ settings: { slippageBps: 50, strategistStopLossBps: 1500 } });
  const r = data(await ctx.run("create_agent_draft", { risk_level: "bold", idempotency_key: "c3-bold-01" }));
  const row = (await proposalRow(ctx.d.db, OWNER_A, String(r.proposal_id)))!;
  const b = JSON.parse(row.binding_json) as DraftBinding;
  assert.equal("maxImpactBps" in b.settings, false);
  assert.deepEqual(b.left_out, ["maxImpactBps"]);
  assert.equal(b.settings.slippageBps, 200);
  assert.deepEqual((r.left_out as Array<{ key: string }>).map((x) => x.key), ["maxImpactBps"]);
  assert.equal("maxImpactBps" in (r.risk_profile as { settings: Record<string, number> }).settings, false);
  // Bound against what is there now, and shown as a change to a connection with the agent.
  assert.equal(b.before.slippageBps, 50);
  assert.match(b.salt, /^[0-9a-f]{32}$/, "the hash of a binding holding current values cannot be brute-forced back to them");
  const diff = r.diff as Array<{ key: string; current: string; proposed: string }>;
  assert.deepEqual(diff.find((x) => x.key === "slippageBps"), { key: "slippageBps", label: "max slippage", current: "0.5%", proposed: "2%", help: "the worst price move I accept while a trade fills" });
});

// ── what approval enforces, said exactly (C4) ───────────────────────────────

test("a trade proposal says what approval checks and what the agent re-decides at execution", async () => {
  const ctx = await setup({ mode: "paper" });
  const s = data(await ctx.run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 10, idempotency_key: "c4-note-01" })).summary as Record<string, string>;
  assert.match(s.execution_note, /refuses if the expected amount has fallen below min_out/);
  assert.match(s.execution_note, /fresh price when it executes, with its own slippage limit/);
  assert.match(s.execution_note, /whatever mode it is in when it picks the order up/);
  assert.match(s.book_note, /If it is still in practice mode when it executes/);
});

// ── the owner-order ceiling (L5) ────────────────────────────────────────────

test("with no ceiling stored, the house's owner-order ceiling applies, as on the orders route", async () => {
  const wide = fixtureDirectory({ [OWNER_A]: [agentFixture(SLUG_A, ACCOUNT_A, { caps: { perTradeUsdg: 100, dailyUsdg: 1000, expiryDays: 30, maxDrawdownPct: 20, maxOpsPerDay: 20 } })] });
  const ctx = await setup({ directory: wide, settings: { telegramMaxActionUsdg: undefined } });
  const over = await ctx.run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 60, idempotency_key: "l5-ceil-01" });
  assert.equal(code(over), "invalid_input");
  assert.match(JSON.stringify(over.structuredContent), /25 USDG limit/);
  const ok = data(await ctx.run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 20, idempotency_key: "l5-ceil-02" }));
  const b = JSON.parse((await proposalRow(ctx.d.db, OWNER_A, String(ok.proposal_id)))!.binding_json) as TradeBinding;
  assert.equal(b.limits.chat_ceiling_usdg, 25);
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
