/**
 * THE RECEIPT IS THE WORKER'S LEDGER FACTS, CARRIED — NEVER COMPOSED HERE.
 *
 * C3: the child writes `{ ok, line, receipt }` when an order finishes, and
 * GET /api/orders?id= hands `receipt` back beside `result`. The browser then
 * templates "[Buy] $5.00 CASHCAT · Filled" from it. Every field is something
 * the worker read off a trade row or a verdict, so this side does two things
 * only: it passes the receipt through, and it refuses any field that is not the
 * shape a ledger fact has. A figure that fails the check is null — the card
 * then prints nothing for it, never a zero.
 *
 * Run against a real sqlite through the ledger's own driver, with and without
 * the column, and against a real command file — the same rails the route runs.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { readHostedOrder, receiptOf, resultOf, selfHostedOrderReply } from "./order-state";
import { wrapSqlite } from "../../../worker/src/db";
import { readCommandState, writeCommand, writeCommandResult, claimCommandFile, type FileCommandResult } from "../../../worker/src/command-files";

const AGENT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const T = 1_800_000_000_000;
const TX = "0x" + "ab".repeat(32);
const TOKEN = "0x" + "cd".repeat(20);

const FILLED = {
  status: "filled",
  side: "buy",
  symbol: "CASHCAT",
  token: TOKEN,
  usdgActual: 5,
  txHash: TX,
  rejectRule: null,
} as const;

function ledger(withReceiptColumn: boolean) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE agent_commands (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, args TEXT,
    created_at INTEGER NOT NULL, claimed_at INTEGER, done_at INTEGER, result TEXT
    ${withReceiptColumn ? ", receipt TEXT" : ""})`);
  return { raw, db: wrapSqlite(raw) };
}

const homes: string[] = [];
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a receipt is shape-checked field by field", () => {
  it("A LEDGER-SHAPED RECEIPT PASSES THROUGH UNCHANGED", () => {
    assert.deepEqual(receiptOf(FILLED), FILLED);
    // The worker may hand it over as the JSON it was stored as.
    assert.deepEqual(receiptOf(JSON.stringify(FILLED)), FILLED);
  });

  it("an unknown status is not a receipt at all", () => {
    // Without a status there is nothing to template — "[Buy] $5 · ???" would be
    // a sentence about somebody's money that says nothing true.
    assert.equal(receiptOf({ ...FILLED, status: "landed" }), null);
    assert.equal(receiptOf({ ...FILLED, status: undefined }), null);
    assert.equal(receiptOf("not json"), null);
    assert.equal(receiptOf(null), null);
    assert.equal(receiptOf([FILLED]), null);
  });

  it("A FIGURE THAT IS NOT A FIGURE IS NULL, NEVER ZERO", () => {
    for (const bad of [NaN, Infinity, -1, "5", null, undefined]) {
      assert.equal(receiptOf({ ...FILLED, usdgActual: bad })?.usdgActual, null, `usdgActual ${String(bad)}`);
    }
    assert.equal(receiptOf({ ...FILLED, usdgActual: 0 })?.usdgActual, 0, "a real zero is kept");
  });

  it("hashes, addresses, sides and rules must look like what they are", () => {
    const r = receiptOf({
      ...FILLED,
      side: "short",
      token: "0x1234",
      txHash: "0xnot-a-hash",
      rejectRule: "<script>",
      symbol: "x".repeat(80),
    })!;
    assert.equal(r.side, null);
    assert.equal(r.token, null);
    assert.equal(r.txHash, null);
    assert.equal(r.rejectRule, null);
    assert.equal(r.symbol, null);
    assert.equal(r.status, "filled", "and the parts that are sound survive");
  });

  it("a refusal keeps the rule that refused it", () => {
    const r = receiptOf({ status: "refused", side: "buy", symbol: "CASHCAT", token: null, usdgActual: null, txHash: null, rejectRule: "daily-cap" })!;
    assert.equal(r.rejectRule, "daily-cap");
    assert.equal(r.usdgActual, null);
  });
});

describe("the hosted row's result", () => {
  it("A BARE LINE IS THE LINE, with no receipt", () => {
    assert.deepEqual(resultOf("bought 5.00 USDG of CASHCAT"), { line: "bought 5.00 USDG of CASHCAT", receipt: null });
    assert.deepEqual(resultOf(null), { line: null, receipt: null });
  });

  it("an envelope carrying the receipt beside the line is unwrapped", () => {
    const env = JSON.stringify({ ok: true, line: "bought 5.00 USDG of CASHCAT", receipt: FILLED });
    assert.deepEqual(resultOf(env), { line: "bought 5.00 USDG of CASHCAT", receipt: FILLED });
  });

  it("a line that merely looks like JSON is still the line", () => {
    assert.deepEqual(resultOf("{not json"), { line: "{not json", receipt: null });
    assert.deepEqual(resultOf('{"no":"line"}'), { line: '{"no":"line"}', receipt: null });
  });
});

describe("GET /api/orders?id= hands the receipt back — hosted", () => {
  it("FROM A RECEIPT COLUMN, WHEN THE TABLE HAS ONE", async () => {
    const { raw, db } = ledger(true);
    raw
      .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at, claimed_at, done_at, result, receipt) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("a1", AGENT, "trade", JSON.stringify({ expiresAt: T + 300_000 }), T, T + 1, T + 2, "bought 5.00 USDG of CASHCAT", JSON.stringify(FILLED));
    const r = await readHostedOrder(db, AGENT, "a1", T + 3);
    assert.equal(r.status, 200);
    assert.equal((r.body as { state: string }).state, "done");
    assert.equal((r.body as { result: string }).result, "bought 5.00 USDG of CASHCAT");
    assert.deepEqual((r.body as { receipt?: unknown }).receipt, FILLED);
  });

  it("AND A TABLE WITHOUT THE COLUMN STILL ANSWERS — the reader deploys beside the writer", async () => {
    // The web and the orchestrator deploy at the same moment, so for a minute
    // the column may not exist yet. Selecting it by name would throw, and the
    // catch turns that into a 503: every order's card would stop hearing
    // anything at all. An answer without a receipt still renders its line.
    const { raw, db } = ledger(false);
    raw
      .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at, claimed_at, done_at, result) VALUES (?,?,?,?,?,?,?,?)")
      .run("a1", AGENT, "trade", null, T, T + 1, T + 2, "bought 5.00 USDG of CASHCAT");
    const r = await readHostedOrder(db, AGENT, "a1", T + 3);
    assert.equal(r.status, 200);
    assert.equal((r.body as { result: string }).result, "bought 5.00 USDG of CASHCAT");
    assert.equal("receipt" in r.body, false, "no receipt is claimed where none was written");
  });

  it("from an envelope in `result`, when that is how the ferry carried it", async () => {
    const { raw, db } = ledger(false);
    raw
      .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at, claimed_at, done_at, result) VALUES (?,?,?,?,?,?,?,?)")
      .run("a1", AGENT, "trade", null, T, T + 1, T + 2, JSON.stringify({ ok: true, line: "bought it", receipt: FILLED }));
    const r = await readHostedOrder(db, AGENT, "a1", T + 3);
    assert.equal((r.body as { result: string }).result, "bought it", "the owner reads the line, not the envelope");
    assert.deepEqual((r.body as { receipt?: unknown }).receipt, FILLED);
  });

  it("a row still open has no receipt, and says it is running", async () => {
    const { raw, db } = ledger(true);
    raw
      .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at, claimed_at) VALUES (?,?,?,?,?,?)")
      .run("a1", AGENT, "trade", null, T, T + 1);
    const r = await readHostedOrder(db, AGENT, "a1", T + 3);
    assert.equal((r.body as { state: string }).state, "running");
    assert.equal("receipt" in r.body, false);
  });

  it("an id is still never a way to read somebody else's order", async () => {
    const { raw, db } = ledger(true);
    raw
      .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at, claimed_at, done_at, result, receipt) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("theirs", "0x" + "b".repeat(40), "trade", null, T, T, T, "x", JSON.stringify(FILLED));
    assert.deepEqual(await readHostedOrder(db, AGENT, "theirs", T), { status: 200, body: { state: "none" } });
  });
});

describe("GET /api/orders?id= hands the receipt back — self-hosted", () => {
  it("THE RESULT FILE'S RECEIPT RIDES BESIDE ITS LINE", () => {
    const home = mkdtempSync(path.join(tmpdir(), "merry-receipt-"));
    homes.push(home);
    const id = "f".repeat(32);
    writeCommand(home, { id, kind: "trade", at: T, args: { side: "buy", symbol: "CASHCAT", usdgAmount: 5 } });
    assert.equal(claimCommandFile(home)?.id, id);
    // What the worker writes once it has read the trade row (C3). A variable,
    // not a literal: the worker's own type gains `receipt` in its cluster.
    const answered = { id, ok: true, line: "bought 5.00 USDG of CASHCAT", at: T + 5, receipt: FILLED };
    writeCommandResult(home, answered as FileCommandResult);
    const reply = selfHostedOrderReply(id, readCommandState(home, id), T + 6);
    assert.equal(reply.state, "done");
    assert.equal((reply as { result: string }).result, "bought 5.00 USDG of CASHCAT");
    assert.deepEqual((reply as { receipt?: unknown }).receipt, FILLED);
  });

  it("an older worker's result, with no receipt, still answers with its line", () => {
    const reply = selfHostedOrderReply("x", { state: "done", result: { ok: false, line: "refused: daily cap", at: T } }, T);
    assert.equal((reply as { result: string }).result, "refused: daily cap");
    assert.equal("receipt" in reply, false, "nothing about a receipt reaches the wire");
  });
});
