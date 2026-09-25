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
import { STOCK_TOKENS, TRADEABLE_V2 } from "@merrymen/core";
import { runTool, type ToolDef } from "../tool";
import { PROPOSAL_TOOLS, KNOWN_STRATEGIES, addressableSymbol } from "./proposals";
import { setQuoteClientForTest } from "@/lib/services/trade-quote";
import { projectSettings } from "@/lib/services/settings-view";
import { revokeConnection } from "../oauth/server";
import {
  DISCONNECTED_WHY, EVIDENCE_GRACE_SEC, ROW_SKEW_SEC, SETTLE_AFTER_SEC, approveProposal, cancelAwaitingForConnection, cancelProposal, followTrade, orderIdFor, proposalRow,
  APPROVED_STALE_SEC, queueApprovedTrade, rejectProposal, resumeStranded, settingsOutcome, workerSentence, type StrandedProbe,
  type DraftBinding, type TradeBinding,
} from "@/lib/services/proposals";
import { BUILTIN_STRATEGIES } from "../../../../worker/src/strategies/registry";
import { errorOf, ACCOUNT_A, OWNER_A, OWNER_B, SLUG_A, agentFixture, connectAs, fixtureDirectory, installFixtures, makeDeps, makeTestDb, type TestDb } from "../testing";

// Approval links are built from the configured public origin.
process.env.MERRYMEN_PUBLIC_ORIGIN = "https://app.test";
// The house's fallback owner-order ceiling is read from the web process's own
// settings file and env (resolveConfig): pinned to the shipped default here, so
// no settings file on the machine running the tests can move it.
process.env.MERRYMEN_SETTINGS_FILE = join(tmpdir(), `merrymen-no-settings-${randomBytes(6).toString("hex")}.json`);
delete process.env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG;

const NVDA = STOCK_TOKENS.find((t) => t.symbol === "NVDA")!.address.toLowerCase();
const NOW = 1_800_000_000;
/** When one row in the window of an order answered at `doneSec` is taken as that order's (services/proposals.ts orderWindow). */
const settledAt = (doneSec: number) => doneSec + ROW_SKEW_SEC + SETTLE_AFTER_SEC;
const tool =(name: string) => PROPOSAL_TOOLS.find((t) => t.name === name) as unknown as ToolDef;

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
const code = (r: Awaited<ReturnType<typeof runTool>>) => errorOf(r).code;

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

test("a basket is stored in the spelling the settings route matches, and a spelling that names two tokens is refused", async () => {
  const WBTC = { symbol: "wBTC", address: "0x00000000000000000000000000000000000b7c01", decimals: 8 };
  const CAT_A = { symbol: "Cat", address: "0x00000000000000000000000000000000000ca701", decimals: 18 };
  const CAT_B = { symbol: "CAT", address: "0x00000000000000000000000000000000000ca702", decimals: 18 };
  const { d, run } = await setup({ settings: { customTokens: [WBTC, CAT_A, CAT_B] } });
  const r = data(await run("propose_settings_change", { changes: { basketSymbols: ["nvda", "WBTC", "NVDA"] }, idempotency_key: "bask-case-1" }));
  const b = JSON.parse((await proposalRow(d.db, OWNER_A, String(r.proposal_id)))!.binding_json) as { changes: Record<string, unknown> };
  assert.deepEqual(b.changes.basketSymbols, ["NVDA", "wBTC"], "spelled as the stock list and the owner's token spell them, once each");
  assert.equal((r.diff as Array<{ proposed: string }>)[0]!.proposed.includes("nvda"), false);
  // "Cat" is exact; "cat" could be either of two tokens, so it is not guessed.
  const exact = data(await run("propose_settings_change", { changes: { basketSymbols: ["Cat"] }, idempotency_key: "bask-case-2" }));
  assert.deepEqual((JSON.parse((await proposalRow(d.db, OWNER_A, String(exact.proposal_id)))!.binding_json) as { changes: Record<string, unknown> }).changes.basketSymbols, ["Cat"]);
  assert.equal(code(await run("propose_settings_change", { changes: { basketSymbols: ["cat"] }, idempotency_key: "bask-case-3" })), "invalid_input");
  // Drafts spell them the same way.
  assert.equal(code(await run("create_agent_draft", { basket: ["cat"], idempotency_key: "bask-case-4" })), "invalid_input");
  const draft = data(await run("create_agent_draft", { basket: ["wbtc", "Cat"], idempotency_key: "bask-case-5" }));
  assert.deepEqual((draft.summary as { settings: Record<string, unknown> }).settings.basketSymbols, ["wBTC", "Cat"]);
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
  assert.equal((await followTrade(d.db, d.db, (await proposalRow(d.db, OWNER_A, id))!, settledAt(NOW + 1))).status, "paper_filled");

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
function ownerOrderTrade(d: TestDb, o: { status: string; at: number; side?: "buy" | "sell"; token?: string; tx?: string | null; userOp?: string; source?: string; rule?: string; action?: string; quote?: string }) {
  const side = o.side ?? "buy";
  const token = o.token ?? NVDA;
  // The other leg: USDG for a swap, the curve's quote asset (WETH on most Pons curves) for a curve trade.
  const quote = o.quote ?? USDG;
  const decision = `dec-${++decisionSeq}`;
  d.raw.prepare("INSERT INTO decisions (id, agent_id, source, symbol, action, size_usdg, reason, at) VALUES (?, ?, ?, 'NVDA', ?, 10, 'owner asked', ?)")
    .run(decision, ACCOUNT_A, o.source ?? "chat", o.action ?? side, o.at);
  d.raw.prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, reject_rule, decision_id, created_at, epoch)
    VALUES (?, ?, '0x0', ?, ?, 10, ?, ?, ?, ?, ?, ?, 1)`)
    .run(ACCOUNT_A, o.quote ? "curve-trade" : "swap", side === "buy" ? quote : token, side === "buy" ? token : quote, o.userOp ?? null, o.tx ?? null, o.status, o.rule ?? null, decision, o.at);
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
  const filled = await follow(settledAt(NOW + 10));
  assert.equal(filled.status, "paper_filled");
  assert.match(JSON.parse(filled.result_json!).note, /no money moved/);
});

test("a live trade that lands after the worker answered 'in flight' ends confirmed, never failed", async () => {
  const ctx = await setup();
  const { follow } = await answered(ctx, "late-live-1", { doneAfter: 40, line: "🏹 sent buy 10.00 USDG of NVDA — it is in flight. Watch your trades for the fill." });
  assert.equal((await follow(NOW + 45)).status, "executing");
  const op = `0x${"cd".repeat(32)}`;
  ownerOrderTrade(ctx.d, { status: "submitted", at: NOW + 8, userOp: op });
  const sent = await follow(settledAt(NOW + 40));
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
  // Read once the window has settled, when one row of its own would be taken.
  const r = await follow(settledAt(NOW + 20));
  assert.equal(r.status, "executing", JSON.stringify(r.result_json));
  assert.equal(JSON.parse(r.result_json!).tx_hash, undefined, "no other trade's hash is attributed to this order");
});

test("a curve-coin sell recorded under a 'buy' decision is still this sell order's row (C2)", async () => {
  // describeIntent labels a curve trade 'buy' whenever its output is not USDG,
  // so selling a coin whose curve is quoted in WETH carries action 'buy'. The
  // leg (sell_token = the coin) and source 'chat' are what name the order.
  const WETH = "0x0b2d4b6e2e8a1ef5b0d4e0d3c1d7c7a5f0e3b9a1";
  const ctx = await setup({ mode: "paper" });
  const p = data(await ctx.run("propose_trade", { side: "sell", token: NVDA, amount_usdg: 5, idempotency_key: "curve-sell-1" }));
  const id = String(p.proposal_id);
  await approveProposal(ctx.d.db, OWNER_A, id, String(p.binding_hash), NOW, { revalidate: async () => ({ ok: true, notes: [] }), act: (b) => queueApprovedTrade(ctx.d.db, b as TradeBinding, id, 60, NOW * 1000) });
  ctx.d.raw.prepare("UPDATE agent_commands SET claimed_at = ?, done_at = ?, result = ? WHERE id = ?")
    .run(NOW * 1000, (NOW + 5) * 1000, "📝 simulated sell 5.00 USDG of NVDA instead of trading for real.", orderIdFor(id));
  ownerOrderTrade(ctx.d, { status: "paper", at: NOW + 2, side: "sell", action: "buy", quote: WETH });
  const r = await followTrade(ctx.d.db, ctx.d.db, (await proposalRow(ctx.d.db, OWNER_A, id))!, settledAt(NOW + 5));
  assert.equal(r.status, "paper_filled", r.result_json ?? "");

  // Live, sent and not yet settled: the row keeps the proposal executing with its hash, and never lets it fail.
  restore?.();
  const live = await setup();
  const q = data(await live.run("propose_trade", { side: "sell", token: NVDA, amount_usdg: 5, idempotency_key: "curve-sell-2" }));
  const qid = String(q.proposal_id);
  await approveProposal(live.d.db, OWNER_A, qid, String(q.binding_hash), NOW, { revalidate: async () => ({ ok: true, notes: [] }), act: (b) => queueApprovedTrade(live.d.db, b as TradeBinding, qid, 60, NOW * 1000) });
  live.d.raw.prepare("UPDATE agent_commands SET claimed_at = ?, done_at = ?, result = ? WHERE id = ?")
    .run(NOW * 1000, (NOW + 5) * 1000, "🏹 sent sell 5.00 USDG of NVDA — it is in flight.", orderIdFor(qid));
  const tx = `0x${"5e".repeat(32)}`;
  ownerOrderTrade(live.d, { status: "submitted", at: NOW + 2, side: "sell", action: "buy", quote: WETH, tx });
  const sent = await followTrade(live.d.db, live.d.db, (await proposalRow(live.d.db, OWNER_A, qid))!, NOW + 300 + EVIDENCE_GRACE_SEC + 60);
  assert.equal(sent.status, "executing", "a submitted row is evidence money was sent: never failed");
  assert.equal(JSON.parse(sent.result_json!).tx_hash, tx);
});

test("one row is not taken as this order's until the window has settled: a concurrent owner order's row reads as ambiguous (C2)", async () => {
  const ctx = await setup({ mode: "paper" });
  const { follow } = await answered(ctx, "settle-001", { doneAfter: 10, line: "📝 simulated buy 10.00 USDG of NVDA instead of trading for real." });
  // A Telegram owner order for the same token and side, answered inside this
  // order's window, reached the ledger first. Alone, it fits.
  ownerOrderTrade(ctx.d, { status: "paper", at: NOW + 4 });
  const early = await follow(NOW + 20);
  assert.equal(early.status, "executing", "a lone row in an unsettled window is not concluded on");
  assert.match(JSON.parse(early.result_json!).note, /waiting for its trade record/);
  assert.equal((await follow(settledAt(NOW + 10) - 1)).status, "executing");
  // This order's own row arrives on the next pass: two rows, so neither is taken.
  ownerOrderTrade(ctx.d, { status: "paper", at: NOW + 7 });
  const both = await follow(settledAt(NOW + 10));
  assert.equal(both.status, "executing", "two rows that fit are ambiguous, never the first one's outcome");
  // And past the evidence deadline, ambiguity is an unknown outcome, not a fill.
  const late = await follow(NOW + 300 + EVIDENCE_GRACE_SEC + 1);
  assert.equal(late.status, "failed");
  assert.equal(JSON.parse(late.result_json!).outcome_unknown, true);
});

test("a refusal read before the window settles is explained by the agent's own sentence, not a row that may be another order's (C2)", async () => {
  const ctx = await setup();
  const refused = { status: "refused", side: "buy", symbol: "NVDA", token: null, usdgActual: null, txHash: null, rejectRule: null };
  const a = await answered(ctx, "settle-002", { doneAfter: 5, line: "🧱 refused: I'm paused. Nothing was sent.", receipt: refused });
  // Someone else's refused owner order for the same token, in this window.
  ownerOrderTrade(ctx.d, { status: "rejected", at: NOW + 3, rule: "daily-cap" });
  const r = await a.follow(NOW + 8);
  assert.equal(r.status, "refused");
  const res = JSON.parse(r.result_json!) as Record<string, unknown>;
  assert.equal(res.rule, null, "the other order's rule is not claimed as this one's cause");
  assert.equal(res.agent_said_untrusted, "🧱 refused: I'm paused. Nothing was sent.");
});

test("a refusal decided before any intent was built (no token on its receipt) never borrows a row, even once the window has settled", async () => {
  const ctx = await setup();
  const refused = { status: "refused", side: "buy", symbol: "NVDA", token: null, usdgActual: null, txHash: null, rejectRule: null };
  const a = await answered(ctx, "prebuild-1", { doneAfter: 5, line: "🧱 refused: I'm paused. Nothing was sent.", receipt: refused });
  // A concurrent Telegram order's refused row is the only row in the window.
  ownerOrderTrade(ctx.d, { status: "rejected", at: NOW + 3, rule: "daily-cap" });
  const r = await a.follow(settledAt(NOW + 5) + 60);
  assert.equal(r.status, "refused");
  const res = JSON.parse(r.result_json!) as Record<string, unknown>;
  assert.equal(res.rule, null, "a pre-build refusal wrote no row; the window's row is another order's");
  assert.equal(res.agent_said_untrusted, "🧱 refused: I'm paused. Nothing was sent.");
});

test("a revert with no rule slug on its receipt is described from the row with its hash, whenever it is read", async () => {
  const ctx = await setup();
  const tx = `0x${"7a".repeat(32)}`;
  const failed = { status: "failed", side: "buy", symbol: "NVDA", token: NVDA, usdgActual: null, txHash: tx, rejectRule: null };
  const a = await answered(ctx, "revert-tx-1", { doneAfter: 5, line: "💥 it reverted on-chain.", receipt: failed });
  ownerOrderTrade(ctx.d, { status: "reverted", at: NOW + 3, tx, rule: "reverted on-chain (resolved by reconciliation)" });
  const r = await a.follow(NOW + 8);
  assert.equal(r.status, "failed");
  const res = JSON.parse(r.result_json!) as Record<string, unknown>;
  assert.equal(res.tx_hash, tx);
  assert.equal(res.rule, "reverted-resolved");
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
  // A receipt built from a row names that row's token leg.
  const b = await answered(ctx, "raw-line-2", { doneAfter: 5, line: RAW, receipt: { ...refused, token: NVDA } });
  ownerOrderTrade(ctx.d, { status: "rejected", at: NOW + 2, rule: "couldn't submit: RPC Request failed. URL: https://api.pimlico.io/v2/4663/rpc?apikey=pim_SECRETKEY" });
  const second = await b.follow(settledAt(NOW + 5));
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
  assert.match(errorOf(over).message, /25 USDG limit/);
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

// ── only tokens the worker watches (C1) ─────────────────────────────────────

const AAPL = STOCK_TOKENS.find((t) => t.symbol === "AAPL")!.address.toLowerCase();

test("propose_trade refuses a registry stock outside the agent's basket: the worker does not watch it and would always refuse the order (C1)", async () => {
  // A wide grant CAN sell AAPL, so only the watch set stands in the way. With the
  // default basket (QQQ, NVDA, TSLA), AAPL is a registry stock the worker does not watch.
  const wideGrant = () => fixtureDirectory({ [OWNER_A]: [agentFixture(SLUG_A, ACCOUNT_A, { features: [TRADEABLE_V2] })] });
  const { d, run } = await setup({ directory: wideGrant() });
  const r = await run("propose_trade", { side: "buy", token: AAPL, amount_usdg: 10, idempotency_key: "c1-aapl-01" });
  assert.equal(code(r), "unsupported");
  assert.match(errorOf(r).message, /registry stock token, but not in the agent's basket, so the worker does not watch it and cannot trade it\. The owner can add it to the basket in Settings/);
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM mcp_proposals").get() as { n: number }).n, 0);
  // A sell of it is refused the same way (it has left the basket, or never was in it).
  assert.equal(code(await run("propose_trade", { side: "sell", token: AAPL, amount_usdg: 5, idempotency_key: "c1-aapl-02" })), "unsupported");
  // With AAPL in the basket, it is the agent's token again.
  restore?.();
  const inBasket = await setup({ settings: { basketSymbols: ["AAPL"] }, directory: wideGrant() });
  const ok = await inBasket.run("propose_trade", { side: "sell", token: AAPL, amount_usdg: 5, idempotency_key: "c1-aapl-03" });
  assert.equal(ok.isError, undefined, JSON.stringify(ok));
  assert.equal((JSON.parse((await proposalRow(inBasket.d.db, OWNER_A, String(data(ok).proposal_id)))!.binding_json) as TradeBinding).symbol, "AAPL");
});

test("addressableSymbol resolves through the worker's watch set: basket stocks, owner tokens that survive the collision rule, and the official-coins switch", () => {
  const settings = (raw: Record<string, unknown>) => projectSettings(raw);
  // The default basket: NVDA is watched, AAPL is not.
  assert.deepEqual(addressableSymbol(NVDA, settings({}), 4663), { symbol: "NVDA" });
  assert.match((addressableSymbol(AAPL, settings({}), 4663) as { why: string }).why, /not in the agent's basket/);
  assert.deepEqual(addressableSymbol(AAPL, settings({ basketSymbols: ["AAPL"] }), 4663), { symbol: "AAPL" });
  // NVDA left the basket: an order for it is one the worker would refuse.
  assert.match((addressableSymbol(NVDA, settings({ basketSymbols: ["AAPL"] }), 4663) as { why: string }).why, /not in the agent's basket/);
  // An owner token is watched unless the worker drops it (a symbol a registry stock already uses, in any case).
  const CAT = { symbol: "CAT", address: "0x00000000000000000000000000000000000ca7ca", decimals: 18 };
  assert.deepEqual(addressableSymbol(CAT.address, settings({ customTokens: [CAT] }), 4663), { symbol: "CAT" });
  const FAKE = { symbol: "aapl", address: "0x00000000000000000000000000000000000faa01", decimals: 18 };
  assert.match((addressableSymbol(FAKE.address, settings({ customTokens: [FAKE] }), 4663) as { why: string }).why, /The owner added it, but the worker does not watch it/);
  // Of two owner tokens under one symbol the worker keeps the first; the second is never addressable.
  const CAT2 = { symbol: "CAT", address: "0x00000000000000000000000000000000000ca7cb", decimals: 18 };
  assert.deepEqual(addressableSymbol(CAT.address, settings({ customTokens: [CAT, CAT2] }), 4663), { symbol: "CAT" });
  assert.equal("why" in addressableSymbol(CAT2.address, settings({ customTokens: [CAT, CAT2] }), 4663), true);
  // Nothing the agent knows.
  assert.match((addressableSymbol("0x000000000000000000000000000000000000dead", settings({}), 4663) as { why: string }).why, /not one of the agent's tokens/);
});

// ── notes refuse control characters (L9) ────────────────────────────────────

test("a proposal note with NUL or another control character is invalid input, never stored; tabs and line breaks are fine", async () => {
  const { d, run } = await setup();
  const NUL = String.fromCharCode(0);
  const BEL = String.fromCharCode(7);
  for (const [i, bad] of [`from a pdf${NUL}page`, `ring${BEL}`].entries()) {
    assert.equal(code(await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 10, idempotency_key: `l9-note-t${i}`, note: bad })), "invalid_input");
    assert.equal(code(await run("propose_settings_change", { changes: { slippageBps: 80 }, idempotency_key: `l9-note-s${i}`, note: bad })), "invalid_input");
  }
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM mcp_proposals").get() as { n: number }).n, 0);
  const fine = await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 10, idempotency_key: "l9-note-ok", note: "line one\n\tline two" });
  assert.equal(fine.isError, undefined, JSON.stringify(fine));
});

// ── what the settings route answered (C2) ──────────────────────────────────

test("an approved settings change whose every key the settings route ignored is failed, never 'applied'; some ignored is applied and partial", () => {
  const changes = { classExitAtGraduationPct: 50, slippageBps: 80 };
  const none = settingsOutcome({ classExitAtGraduationPct: 50 }, { ok: true, body: { ok: true, ignored: ["classExitAtGraduationPct"] } as never });
  assert.equal(none.status, "failed");
  assert.match(String(none.result.why), /did not accept any of these changes; nothing was changed/);
  assert.deepEqual(none.result.not_applied, ["classExitAtGraduationPct"]);
  const some = settingsOutcome(changes, { ok: true, body: { ignored: ["classExitAtGraduationPct", "somethingElse"] } });
  assert.equal(some.status, "applied");
  assert.deepEqual(some.result.applied, ["slippageBps"]);
  assert.equal(some.result.partial, true);
  assert.deepEqual(some.result.not_applied, ["classExitAtGraduationPct"]);
  const all = settingsOutcome(changes, { ok: true, body: {} });
  assert.deepEqual(all, { status: "applied", result: { applied: ["classExitAtGraduationPct", "slippageBps"] } });
  const refused = settingsOutcome(changes, { ok: false, body: { errors: ["slippageBps: must be a number between 1 and 1000"] } });
  assert.equal(refused.status, "failed");
  assert.deepEqual(refused.result.errors, ["slippageBps: must be a number between 1 and 1000"]);
});

// ── the app that asked must still stand behind it (S0) ──────────────────────

test("disconnecting an app cancels what it left waiting; an order the owner already approved stays theirs", async () => {
  const { d, a, run } = await setup();
  const waiting = await propose(run, "s0-wait-01");
  const post = data(await run("draft_post", { text: "gm merrymen", idempotency_key: "s0-post-01" }));
  const approved = await propose(run, "s0-appr-01");
  await approveProposal(d.db, OWNER_A, String(approved.proposal_id), String(approved.binding_hash), NOW, { revalidate: async () => ({ ok: true, notes: [] }), act: (b) => queueApprovedTrade(d.db, b as TradeBinding, String(approved.proposal_id), 60, NOW * 1000) });
  assert.equal(await revokeConnection(d, OWNER_A, a.principal.connectionId, NOW + 1), true);
  // Another owner's disconnect of this id touches nothing.
  assert.equal(await cancelAwaitingForConnection(d.db, OWNER_B, a.principal.connectionId, NOW + 1), 0);
  assert.equal(await cancelAwaitingForConnection(d.db, OWNER_A, a.principal.connectionId, NOW + 1), 2);
  for (const p of [waiting, post]) {
    const row = (await proposalRow(d.db, OWNER_A, String(p.proposal_id)))!;
    assert.equal(row.status, "cancelled");
    assert.equal(JSON.parse(row.result_json!).why, DISCONNECTED_WHY);
  }
  assert.equal((await proposalRow(d.db, OWNER_A, String(approved.proposal_id)))!.status, "submitted", "not withdrawn by a disconnect");
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM agent_commands WHERE claimed_at IS NULL").get() as { n: number }).n, 1);
});

test("approval refuses and cancels a proposal whose app was disconnected, lost the scope, or no longer shares the agent", async () => {
  const { d, deps, run } = await setup();
  const ok = { revalidate: async () => ({ ok: true as const, notes: [] }), act: async () => ({ status: "applied" as const, result: {} }) };
  const approve = (p: Record<string, unknown>) => approveProposal(d.db, OWNER_A, String(p.proposal_id), String(p.binding_hash), NOW, ok);
  const statusOf = async (p: Record<string, unknown>) => (await proposalRow(d.db, OWNER_A, String(p.proposal_id)))!;

  // Revoked, with nothing cancelled yet (a proposal created by a call already in flight when the owner disconnected).
  const gone = await connectAs(deps, OWNER_A, { scopes: SCOPES });
  const p1 = data(await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 10, idempotency_key: "s0-gone-01" }, gone.principal));
  await revokeConnection(d, OWNER_A, gone.principal.connectionId, NOW);
  await assert.rejects(approve(p1), /cancelled, not approved: the app that prepared it was disconnected/);
  assert.equal((await statusOf(p1)).status, "cancelled");

  // Re-consented without trade:propose.
  const narrowed = await connectAs(deps, OWNER_A, { scopes: SCOPES });
  const p2 = data(await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 10, idempotency_key: "s0-narr-01" }, narrowed.principal));
  d.raw.prepare("UPDATE mcp_connections SET scopes = ? WHERE id = ?").run("agents:read drafts:write", narrowed.principal.connectionId);
  await assert.rejects(approve(p2), /no longer allowed to ask for this/);
  assert.equal((await statusOf(p2)).status, "cancelled");

  // The agent is no longer shared with it.
  const unshared = await connectAs(deps, OWNER_A, { scopes: SCOPES });
  const p3 = data(await run("propose_settings_change", { changes: { slippageBps: 80 }, idempotency_key: "s0-unsh-01" }, unshared.principal));
  d.raw.prepare("UPDATE mcp_connections SET agent_slugs = '[]' WHERE id = ?").run(unshared.principal.connectionId);
  await assert.rejects(approve(p3), /no longer has access to this agent/);
  const r3 = await statusOf(p3);
  assert.equal(r3.status, "cancelled");
  assert.equal(JSON.parse(r3.result_json!).requester_withdrawn, true);
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get() as { n: number }).n, 0);

  // Seen by another of the owner's connections, it reads as cancelled, with the reason.
  const view = data(await run("get_proposal", { proposal_id: p3.proposal_id }));
  assert.equal(view.status, "cancelled");
  assert.match(String(view.status_explained), /Cancelled because the app that prepared it no longer has access to this agent/);
  assert.equal(view.approval_url, null);
});

test("get_proposal and list_proposals show a proposal whose app lost its standing as cancelled, not waiting", async () => {
  const { d, deps, run } = await setup();
  const other = await connectAs(deps, OWNER_A, { scopes: SCOPES });
  const p = data(await run("draft_post", { text: "gm merrymen", idempotency_key: "s0-list-01" }, other.principal));
  await revokeConnection(d, OWNER_A, other.principal.connectionId, NOW);
  const listed = data(await run("list_proposals", { status: "all" })).proposals as Array<{ proposal_id: string; status: string; approval_url: string | null }>;
  const mine = listed.find((x) => x.proposal_id === p.proposal_id)!;
  assert.equal(mine.status, "cancelled");
  assert.equal(mine.approval_url, null);
});

test("status_explained says when an approved settings change was only partly applied", async () => {
  const { d, run } = await setup();
  const p = data(await run("propose_settings_change", { changes: { slippageBps: 80, strategistStopLossBps: 900 }, idempotency_key: "c2-part-01" }));
  await approveProposal(d.db, OWNER_A, String(p.proposal_id), String(p.binding_hash), NOW, {
    revalidate: async () => ({ ok: true, notes: [] }),
    act: async (b) => settingsOutcome((b as { changes: Record<string, unknown> }).changes, { ok: true, body: { ignored: ["strategistStopLossBps"] } }),
  });
  const view = data(await run("get_proposal", { proposal_id: p.proposal_id }));
  assert.equal(view.status, "applied");
  assert.match(String(view.status_explained), /only some of the changes were applied/);
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

test("proposal text inputs refuse NUL and other control characters (a post, a draft name, a settings value)", async () => {
  const { run } = await setup();
  const nul = String.fromCharCode(0);
  assert.equal(code(await run("draft_post", { text: `hello${nul}`, idempotency_key: "ctl-post-01" })), "invalid_input");
  assert.equal(code(await run("create_agent_draft", { name: `Bot${nul}`, idempotency_key: "ctl-draft-01" })), "invalid_input");
  assert.equal(code(await run("propose_settings_change", { changes: { strategy: `steady-basket${nul}` }, idempotency_key: "ctl-set-001" })), "invalid_input");
  // Tabs and newlines are text.
  const ok = await run("draft_post", { text: "line one\nline two", idempotency_key: "ctl-post-02" });
  assert.equal(ok.isError, undefined, JSON.stringify(ok));
});

// ── an approval interrupted between acting and recording its outcome ────────

/** Put a proposal where a crashed approval leaves it: 'approved', decided at `at`. */
function strand(d: TestDb, id: string, at: number) {
  d.raw.prepare("UPDATE mcp_proposals SET status = 'approved', decided_at = ?, updated_at = ? WHERE id = ?").run(at, at, id);
}
const probe = (o: Partial<StrandedProbe>): StrandedProbe => ({
  orderQueued: async () => null, settingsNow: async () => null, postStored: async () => null, ...o,
});

test("a stranded trade approval whose order reached the queue becomes submitted, and is then tracked and cancellable", async () => {
  const { d, run } = await setup();
  const p = data(await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 5, idempotency_key: "strand-trade-1" }));
  const id = String(p.proposal_id);
  // The crash happened after the order was queued (deterministic id) and before the status write.
  const row0 = (await proposalRow(d.db, OWNER_A, id))!;
  const binding = JSON.parse(row0.binding_json) as TradeBinding;
  await queueApprovedTrade(d.db, binding, id, 60, NOW * 1000);
  strand(d, id, NOW);
  // Still inside the window an approval may take: untouched.
  const early = await resumeStranded(d.db, (await proposalRow(d.db, OWNER_A, id))!, NOW + APPROVED_STALE_SEC - 1, probe({ orderQueued: async () => true }));
  assert.equal(early.status, "approved");
  // Through the tool, with the real queue as evidence: recovered, then followed.
  const later = NOW + APPROVED_STALE_SEC + 1;
  const view = data(await runTool(tool("get_proposal"), { proposal_id: id }, (await connectAs(makeDeps(d), OWNER_A, { scopes: SCOPES })).principal, "t", { now: () => later }));
  assert.equal(view.status, "submitted");
  const row = (await proposalRow(d.db, OWNER_A, id))!;
  assert.equal(row.order_id, orderIdFor(id));
  assert.equal(JSON.parse(row.result_json!).recovered, true);
});

test("a stranded trade approval whose order never reached the queue goes back to the owner (or expires), and approving again cannot trade twice", async () => {
  const { d, run } = await setup();
  const p = data(await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 5, idempotency_key: "strand-trade-2" }));
  const id = String(p.proposal_id);
  strand(d, id, NOW);
  const back = await resumeStranded(d.db, (await proposalRow(d.db, OWNER_A, id))!, NOW + APPROVED_STALE_SEC + 1, probe({ orderQueued: async () => false }));
  assert.equal(back.status, "awaiting_approval");
  assert.equal((d.raw.prepare("SELECT COUNT(*) AS n FROM agent_commands").get() as { n: number }).n, 0);
  // Past the proposal's own expiry it is not offered again.
  strand(d, id, NOW);
  const gone = await resumeStranded(d.db, (await proposalRow(d.db, OWNER_A, id))!, NOW + 3600 * 24, probe({ orderQueued: async () => false }));
  assert.equal(gone.status, "expired");
  // Evidence that cannot be read leaves it for a later read.
  const other = data(await run("propose_trade", { side: "buy", token: NVDA, amount_usdg: 6, idempotency_key: "strand-trade-3" }));
  strand(d, String(other.proposal_id), NOW);
  const unknown = await resumeStranded(d.db, (await proposalRow(d.db, OWNER_A, String(other.proposal_id)))!, NOW + APPROVED_STALE_SEC + 1, probe({}));
  assert.equal(unknown.status, "approved");
});

test("a stranded settings approval is applied, back with the owner, or unconfirmed, by what the settings now hold", async () => {
  const { d, run } = await setup({ settings: { strategy: "steady-basket", buyPerTickUsdg: 5 } });
  const make = async (key: string, changes: Record<string, unknown>) => {
    const p = data(await run("propose_settings_change", { changes, idempotency_key: key }));
    const id = String(p.proposal_id);
    strand(d, id, NOW);
    return (await proposalRow(d.db, OWNER_A, id))!;
  };
  const at = NOW + APPROVED_STALE_SEC + 1;
  const all = await make("strand-set-1", { buyPerTickUsdg: 2, strategy: "weekend-gap" });
  assert.equal((await resumeStranded(d.db, all, at, probe({ settingsNow: async () => ({ buyPerTickUsdg: 2, strategy: "weekend-gap" }) }))).status, "applied");
  const none = await make("strand-set-2", { buyPerTickUsdg: 3 });
  assert.equal((await resumeStranded(d.db, none, at, probe({ settingsNow: async () => ({ buyPerTickUsdg: 5 }) }))).status, "awaiting_approval");
  const some = await make("strand-set-3", { buyPerTickUsdg: 4, strategy: "dip-hunter" });
  const partial = await resumeStranded(d.db, some, at, probe({ settingsNow: async () => ({ buyPerTickUsdg: 4, strategy: "steady-basket" }) }));
  assert.equal(partial.status, "failed");
  assert.equal(JSON.parse(partial.result_json!).outcome_unknown, true);
});

test("a stranded post approval is applied when its line is in the room, and goes back to the owner when it is not", async () => {
  const { d, run } = await setup();
  const make = async (key: string) => {
    const p = data(await run("draft_post", { text: "Testing the connection.", idempotency_key: key }));
    const id = String(p.proposal_id);
    strand(d, id, NOW);
    return (await proposalRow(d.db, OWNER_A, id))!;
  };
  const at = NOW + APPROVED_STALE_SEC + 1;
  const seen: string[] = [];
  const posted = await make("strand-post-1");
  assert.equal((await resumeStranded(d.db, posted, at, probe({ postStored: async (_t, clientId) => { seen.push(clientId); return true; } }))).status, "applied");
  assert.deepEqual(seen, [posted.id.slice(4, 36)], "looked up by the post's own idempotency key");
  const lost = await make("strand-post-2");
  assert.equal((await resumeStranded(d.db, lost, at, probe({ postStored: async () => false }))).status, "awaiting_approval");
});

test("the post probe names the group-chat route's own idempotency key (a drift would make every stranded post look unsent)", async () => {
  const { ownerPostKey } = await import("@/lib/services/proposal-probes");
  const { readFileSync } = await import("node:fs");
  const route = readFileSync(join(process.cwd(), "web", "src", "app", "api", "groupchat", "route.ts"), "utf8");
  assert.ok(route.includes("`owner:${tenant.toLowerCase()}:${clientId}`"), "the route's retryKey format");
  assert.equal(ownerPostKey("0xABC", "client-1"), "owner:0xabc:client-1");
});
