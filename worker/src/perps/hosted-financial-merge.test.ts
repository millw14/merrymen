import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite } from "../db";
import { JOURNAL_GENESIS, journalHash } from "../store";
import { FINANCIAL_CAPSULE_TABLES } from "./hosted-financial-capsule";
import { mergeFinancialStreams } from "./hosted-financial-merge";
import { PAGED_CHECKPOINT_SCHEMA, savePagedCheckpointStream } from "./hosted-financial-pages";
import { encodeFinancialRecord, inspectFinancialStream, STANDDOWN_STREAM_TABLES, type FinancialRow, type FinancialScope } from "./hosted-financial-stream";

const ACCOUNT = `0x${"17".repeat(20)}`;
const AGENT: FinancialRow = { smart_account: ACCOUNT, name: "Vector", epoch: 1 };
function journal(seq: number, prev: string, kind: string): FinancialRow {
  const payload_json = JSON.stringify({ event: seq });
  return { seq, agent_id: ACCOUNT, epoch: 1, kind, payload_json, prev_hash: prev, hash: journalHash(prev, payload_json), at: seq };
}
const FIRST = journal(1, JOURNAL_GENESIS, "flow"), CLOSE = journal(2, String(FIRST.hash), "perp-fill");
function fixture() {
  const full: Record<string, FinancialRow[]> = { agents: [{ ...AGENT, status: "armed" }], journal: [FIRST],
    trades: [{ agent_id: ACCOUNT, id: 1, amount_usdg: 12 }], paper_book: [{ agent_id: ACCOUNT, cash_usdg: 71 }],
    perp_accounts: [{ agent_id: ACCOUNT, mode: "live", nonce_high_water: "7" }, { agent_id: ACCOUNT, mode: "paper", nonce_high_water: "0" }],
    perp_orders: [{ agent_id: ACCOUNT, mode: "live", id: "open", tx_info: "old signed entry" }, { agent_id: ACCOUNT, mode: "paper", id: "practice", tx_info: null }],
    perp_payouts: [{ agent_id: ACCOUNT, mode: "live", id: "payout", amount_micro: "150", remaining_micro: "50" }],
  };
  const shutdown: Record<string, FinancialRow[]> = { agents: [AGENT], journal: [FIRST, CLOSE],
    perp_accounts: [{ agent_id: ACCOUNT, mode: "live", nonce_high_water: "8" }],
    perp_orders: [{ agent_id: ACCOUNT, mode: "live", id: "close", tx_info: "signed close to retire" }],
    perp_payouts: [{ agent_id: ACCOUNT, mode: "live", id: "payout", amount_micro: "150", remaining_micro: "0" }],
  };
  return { full, shutdown };
}
async function* source(scope: FinancialScope, rows: Record<string, FinancialRow[]>, tail?: Buffer) {
  yield encodeFinancialRecord({ type: "header", v: 3, scope, account: ACCOUNT });
  for (const name of scope === "financial" ? FINANCIAL_CAPSULE_TABLES : STANDDOWN_STREAM_TABLES) {
    yield encodeFinancialRecord({ type: "table", name });
    for (const value of rows[name] ?? []) yield encodeFinancialRecord({ type: "row", value });
  }
  yield encodeFinancialRecord({ type: "end" }); if (tail) yield tail;
}
async function collect(full: Record<string, FinancialRow[]>, shutdown: Record<string, FinancialRow[]>) {
  const rows: Record<string, FinancialRow[]> = {};
  const summary = await inspectFinancialStream(mergeFinancialStreams(source("financial", full), source("standdown", shutdown), ACCOUNT), ACCOUNT, {
    scope: "financial", onRow: (table, row) => { (rows[table] ??= []).push(row); },
  });
  return { rows, summary };
}
describe("streamed shutdown accounting merge", () => {
  it("keeps spot and paper money, takes completed live custody and exact extended journal, and retires signed bytes", async () => {
    const f = fixture(), result = await collect(f.full, f.shutdown);
    assert.deepEqual(result.rows.agents, f.full.agents);
    assert.deepEqual(result.rows.trades, f.full.trades);
    assert.deepEqual(result.rows.paper_book, f.full.paper_book);
    assert.deepEqual(result.rows.journal, [FIRST, CLOSE]);
    assert.deepEqual(result.rows.perp_accounts, [f.full.perp_accounts![1], f.shutdown.perp_accounts![0]]);
    assert.deepEqual(result.rows.perp_orders, [f.full.perp_orders![1], { ...f.shutdown.perp_orders![0], tx_info: null }]);
    assert.deepEqual(result.rows.perp_payouts, f.shutdown.perp_payouts);
    assert.equal(result.summary.journalProof.count, 2);
  });
  it("refuses replaced journal metadata even when the payload hash chain still verifies, rolling back staged pages", async () => {
    const f = fixture(); f.shutdown.journal = [{ ...FIRST, kind: "mark" }, CLOSE];
    const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw);
    try {
      await db.exec(PAGED_CHECKPOINT_SCHEMA);
      await assert.rejects(db.tx(tx => savePagedCheckpointStream(tx, { id: "live:merge", tenant: ACCOUNT, smartAccount: ACCOUNT, generation: 2 },
        mergeFinancialStreams(source("financial", f.full), source("standdown", f.shutdown), ACCOUNT), Buffer.alloc(32, 7))), /prefix replaced/);
      assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM perp_checkpoint_pages").get()?.n, 0);
      assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM perp_checkpoint_manifests").get()?.n, 0);
    } finally { raw.close(); }
  });
  it("refuses narrowed authority changing the accounting epoch or including a paper row", async () => {
    let f = fixture(); f.shutdown.agents = [{ ...AGENT, epoch: 2 }];
    await assert.rejects(collect(f.full, f.shutdown), /agent identity changed/);
    f = fixture(); f.shutdown.perp_accounts![0]!.mode = "paper";
    await assert.rejects(collect(f.full, f.shutdown), /paper row/);
  });
  it("exhausts both source validators before yielding a completed output", async () => {
    const f = fixture(); let ended = false;
    await assert.rejects(async () => {
      for await (const part of mergeFinancialStreams(source("financial", f.full, Buffer.from("corrupt suffix\n")), source("standdown", f.shutdown), ACCOUNT)) {
        if (part.toString() === '{"type":"end"}\n') ended = true;
      }
    });
    assert.equal(ended, false);
  });
  it("closes both source iterators when its consumer cancels", async () => {
    const f = fixture(); let closed = 0;
    async function* watched(scope: FinancialScope, rows: Record<string, FinancialRow[]>) {
      try { yield* source(scope, rows); } finally { closed++; }
    }
    for await (const part of mergeFinancialStreams(watched("financial", f.full), watched("standdown", f.shutdown), ACCOUNT)) {
      if (part.toString().includes('"name":"perp_orders"')) break;
    }
    assert.equal(closed, 2);
  });
});
