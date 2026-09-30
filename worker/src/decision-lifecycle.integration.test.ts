import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import type { BrainDecision, BrainResult } from "./brain-client";
import type { PortfolioSnapshot } from "../../packages/core/src/index";
import type { Db } from "./db";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-decision-lifecycle-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("./store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME, "merrymen.db"));
const { persistBrainDecision } = await import("./brain-shadow");
const { withDecisionOutcome, recordDecisionRefusal } = await import("./decision-identity");
const { readPublicDecisionLifecycle } = await import("../../web/src/lib/read-decision-lifecycle");
const { createReadDb } = await import("../../web/src/lib/ledger");
const { wrapSqlite } = await import("./db");
const { GET } = await import("../../web/src/app/api/decision/[id]/route");

after(() => {
  raw.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const AGENT = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
for (const account of [AGENT, OTHER, "rh:private-account"]) {
  await store.ensureAgent({ smartAccount: account, owner: OTHER, sessionKeyAddress: OTHER, serialized: "fixture", caps: {}, grantedAt: 1, expiresAt: 2_000_000_000, chainId: 4663 } as never);
  await store.setAgentMode(account, "live", 1, false);
}
const cost = { model_calls: 1, tokens_in: 1, tokens_out: 1, usd: 0 };
const snapshot = { snapshotId: "fixture-snapshot", quality: {}, pnl: { publishable: true } } as PortfolioSnapshot;
const decision = (id: string, action: BrainDecision["action"] = "buy"): BrainDecision => ({
  schema_version: "1", decision_id: id, agent_id: AGENT, created_at: 1, trigger_id: "fixture-trigger",
  action, symbol: "MOON", instrument_id: "fixture-instrument", confidence: .5, suggested_delta_usdg: action === "hold" ? 0 : 5e6,
  target_position_usdg: null, thesis: "Buyers are staying.", evidence: [], risks: [], invalidation: [], bull_case: "", bear_case: "",
  time_horizon: "", tier: "", depth_used: "", escalation_reasons: [], candidate_action: null, models: [], cost,
  hold_kind: action === "hold" ? "MODEL_HOLD" : null,
});
const persist = (result: BrainResult, source = "brain") => persistBrainDecision(AGENT, source, "fixture-run", "fixture-trigger",
  { fire: true, reason: "scheduled-review", detail: "fixture", candidates: ["scheduled-review"] }, snapshot, result, { priceUsd: "1", priceStale: false }, () => {});
const get = (id: string) => GET(new Request(`https://app.example/api/decision/${id}`), { params: Promise.resolve({ id }) });

test("actual Brain writer, trade writer, lifecycle reader and public route share one identity", async () => {
  const d = decision("dec_landed_fixture");
  await persist({ ok: true, decision: d, seconds: 0 });
  const op = `0x${"ab".repeat(32)}`;
  assert.equal(await store.addTrade({ agent_id: AGENT, decision_id: d.decision_id, kind: "swap", target: OTHER, amount_usdg: 5,
    status: "landed", user_op_hash: op, fill_side: "buy", fill_qty_raw: "1000", fill_cash_usdg: 5, fill_price_usd: .005, basis_source: "receipt" }), true);
  await store.addPost(AGENT, d.decision_id, "The demand persisted.");
  const life = await store.lifecycleOf(d.decision_id);
  assert.equal(life?.decision.provenance, "brain");
  assert.equal(life?.trades.length, 1);
  assert.equal(life?.trades[0]?.realized_pnl_usdg, null);
  const response = await get(d.decision_id);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.decision.id, d.decision_id);
  assert.equal(body.decision.provenance, "brain");
  assert.equal(body.trades[0].user_op_hash, op);
  assert.equal(body.post.body, "The demand persisted.");
  assert.equal("signals_json" in body.decision, false);
  assert.equal("evidence_json" in body.decision, false);
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM decisions WHERE id = ?").get(d.decision_id) as { n: number }).n, 1);
});

test("live and shadow holds preserve provenance and the actual hold kind without inventing fills", async () => {
  for (const source of ["brain", "brain-shadow"]) {
    const d = decision(`dec_hold_${source}`, "hold");
    await persist({ ok: true, decision: d, seconds: 0 }, source);
    const response = await get(d.decision_id);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.decision.provenance, "brain");
    assert.equal(body.decision.hold_kind, "MODEL_HOLD");
    assert.deepEqual(body.trades, []);
    assert.equal(body.post, null);
  }
  const gated = { ...decision("dec_hold_gated", "hold"), hold_kind: "GATE_FORCED_HOLD" as const };
  await persist({ ok: true, decision: gated, seconds: 0 });
  assert.equal((await store.lifecycleOf(gated.decision_id))?.decision.hold_kind, "GATE_FORCED_HOLD");
  assert.equal((await get(gated.decision_id)).status, 404, "an operational gate is not a public market view");
});

test("Brain sell size is an absolute amount and pre-trade metadata does not claim execution", async () => {
  for (const source of ["brain", "brain-shadow"]) {
    const d = { ...decision(`dec_sell_${source}`, "sell"), suggested_delta_usdg: -5e6 };
    await persist({ ok: true, decision: d, seconds: 0 }, source);
    const life = await store.lifecycleOf(d.decision_id);
    assert.equal(life?.decision.size_usdg, 5);
    const row = raw.prepare("SELECT signals_json FROM decisions WHERE id = ?").get(d.decision_id) as { signals_json: string };
    const signals = JSON.parse(row.signals_json);
    assert.equal(signals.execution_connected, source === "brain");
    assert.equal("executor_calls" in signals, false);
    assert.deepEqual(life?.trades, []);
  }
});

test("Brain refused/error rows carry provenance and remain private", async () => {
  for (const result of [
    { ok: false, kind: "refused", reason: "portfolio-quality-insufficient", detail: "private balances", cost },
    { ok: false, kind: "unreachable", detail: "fixture transport failure" },
    { ok: false, kind: "malformed", detail: "fixture response failure" },
  ] as BrainResult[]) {
    await persist(result);
  }
  const rows = raw.prepare("SELECT id, provenance FROM decisions WHERE dropped_rule LIKE 'brain-%'").all() as { id: string; provenance: string }[];
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.provenance, "brain");
    assert.equal((await get(row.id)).status, 404);
  }
});

test("the actual route refuses private sources, brokerage identities and unsafe public prose", async () => {
  const cases = [
    { id: "private_chat_fixture", source: "chat", agent_id: AGENT, reason: `owner asked to transfer 25 USDG to ${OTHER} in chat` },
    { id: "private_unknown_fixture", source: "unclassified", agent_id: AGENT, reason: "private book" },
    { id: "private_broker_fixture", source: "brain", agent_id: "rh:private-account", reason: "Buyers are staying." },
    { id: "private_address_fixture", source: "brain", agent_id: AGENT, reason: `the owner's address is ${OTHER}` },
  ];
  for (const row of cases) {
    await store.addDecision({ ...row, action: "buy", symbol: "MOON" });
    const response = await get(row.id);
    assert.equal(response.status, 404, row.id);
    assert.deepEqual(await response.json(), { error: "not found" });
  }
});

test("public outcomes never echo raw rejection text or unsafe posts", async () => {
  const d = decision("dec_refusal_fixture");
  await persist({ ok: true, decision: d, seconds: 0 });
  const reply = await withDecisionOutcome(AGENT, d.decision_id, async () => ({ ok: false, line: `no curve at ${OTHER}` }));
  assert.equal(reply.ok, false);
  const life = await store.lifecycleOf(d.decision_id);
  assert.equal(life?.trades.length, 1);
  assert.equal(life?.trades[0]?.status, "rejected");
  assert.equal(life?.trades[0]?.fill_cash_usdg, null);
  assert.equal(life?.trades[0]?.tx_hash, null);
  await store.addPost(AGENT, d.decision_id, `send to ${OTHER}`);
  const body = await (await get(d.decision_id)).json();
  assert.equal(body.trades[0].reject_rule, null);
  assert.equal(body.trades[0].rejection, "execution was refused");
  assert.equal(body.post, null);
  assert.equal(JSON.stringify(body).includes(OTHER), false);
  assert.equal(await recordDecisionRefusal(d.decision_id, AGENT, "retry"), false, "do not duplicate an existing outcome");
});

test("outcome capture cannot attach to another agent or duplicate a wall outcome", async () => {
  const d = decision("dec_owner_fixture");
  await persist({ ok: true, decision: d, seconds: 0 });
  assert.equal(await recordDecisionRefusal(d.decision_id, OTHER, "wrong owner"), false);
  assert.equal(await recordDecisionRefusal("dec_missing_fixture", AGENT, "missing"), false);
  await withDecisionOutcome(AGENT, d.decision_id, async () => {
    await store.addTrade({ agent_id: AGENT, decision_id: d.decision_id, kind: "swap", target: OTHER, amount_usdg: 5, status: "rejected", reject_rule: "drawdown-breaker" });
    return { ok: false, line: "wall refused" };
  });
  assert.equal((await store.lifecycleOf(d.decision_id))?.trades.length, 1);
});

test("a foreign agent's incorrectly linked trade and post never enter the lifecycle", async () => {
  const d = decision("dec_foreign_fixture");
  await persist({ ok: true, decision: d, seconds: 0 });
  await store.addTrade({ agent_id: OTHER, decision_id: d.decision_id, kind: "swap", target: AGENT, amount_usdg: 99, status: "landed" });
  await store.addPost(OTHER, d.decision_id, "A foreign account's post.");
  const life = await store.lifecycleOf(d.decision_id);
  assert.deepEqual(life?.trades, []);
  assert.equal(life?.post, null);
});

test("hosted readers initialize and share their read driver without running writer migrations", async () => {
  let opens = 0;
  const reads = wrapSqlite(raw);
  const readOnly: Db = {
    prepare(sql) {
      assert.match(sql.trim(), /^SELECT/i);
      const stmt = reads.prepare(sql);
      return { get: stmt.get, all: stmt.all, run: async () => { throw new Error("writes forbidden"); } };
    },
    exec: async () => { throw new Error("migrations forbidden"); },
    tx: async () => { throw new Error("transactions forbidden"); },
  };
  const readDb = createReadDb(async (url) => {
    assert.equal(url, "postgres://fixture.invalid/ledger");
    opens++;
    return readOnly;
  });
  process.env.DATABASE_URL = "postgres://fixture.invalid/ledger";
  try {
    const results = await Promise.all([1, 2].map(() => readPublicDecisionLifecycle("dec_landed_fixture", readDb)));
    assert.equal(opens, 1);
    for (const life of results) assert.equal(life?.decision.id, "dec_landed_fixture");
    const unavailable = createReadDb(async () => { throw new Error("fixture offline"); });
    assert.equal(await readPublicDecisionLifecycle("dec_landed_fixture", unavailable), null);
  } finally {
    delete process.env.DATABASE_URL;
  }
});

test("a read against an empty home returns 404 without creating a database", async () => {
  const previous = process.env.MERRYMEN_HOME;
  process.env.MERRYMEN_HOME = path.join(scratch, "empty-home");
  try {
    assert.equal((await get("dec_missing_fixture")).status, 404);
    assert.equal(existsSync(process.env.MERRYMEN_HOME), false);
  } finally {
    process.env.MERRYMEN_HOME = previous;
  }
});
