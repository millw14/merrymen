/**
 * ORDERS CROSS IN SECONDS, AND ONLY ORDERS, AND STILL AT MOST ONCE.
 *
 * The ferry ran once per orchestrator pass — after the reconcile, the mirror,
 * the builder desk and the news desk — then slept fifteen seconds. An owner's
 * order waited on all of that before its file even reached the child. The
 * short loop carries TRADE commands only, on its own clock, and brings every
 * child's answers back on the same clock so the receipt reaches the owner as
 * fast as the order reached the worker.
 *
 * Like ferry-commands.test.ts, every test here joins a tenant to an account
 * that is a DIFFERENT address: the whole difficulty of this join is that the
 * two sides are not the same thing.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { commandDir, writeCommandResult } from "./command-files";
import { wrapSqlite } from "./db";
import { COMMAND_RECEIPT_DDL, ferryForChild, ferryOrders } from "./orchestrator";

const TENANT_A = "0x1111111111111111111111111111111111111111";
const ACCOUNT_A = "0x2222222222222222222222222222222222222222";
const TENANT_B = "0x3333333333333333333333333333333333333333";
const ACCOUNT_B = "0x4444444444444444444444444444444444444444";

const homes: string[] = [];
const newHome = () => {
  const h = mkdtempSync(path.join(tmpdir(), "merry-order-ferry-"));
  homes.push(h);
  return h;
};
after(() => {
  for (const h of homes) {
    try {
      rmSync(h, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** The table as production has it before this change: no receipt column. */
function newDb(withReceipt = true) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE agent_commands (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, args TEXT,
    created_at INTEGER NOT NULL, claimed_at INTEGER, done_at INTEGER, result TEXT)`);
  if (withReceipt) raw.exec(COMMAND_RECEIPT_DDL);
  return { raw, db: wrapSqlite(raw) };
}

const insert = (raw: DatabaseSync, r: { id: string; agent_id?: string; kind?: string; created_at?: number }) =>
  raw
    .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(r.id, r.agent_id ?? ACCOUNT_A, r.kind ?? "trade", JSON.stringify({ side: "buy", symbol: "TSLA", usdgAmount: 5 }), r.created_at ?? 1_000);

const files = (home: string) => {
  try {
    return readdirSync(commandDir(home)).sort();
  } catch {
    return [];
  }
};

const row = (raw: DatabaseSync, id: string) =>
  raw.prepare("SELECT * FROM agent_commands WHERE id = ?").get(id) as Record<string, unknown>;

const filled = {
  status: "filled" as const,
  side: "buy" as const,
  symbol: "TSLA",
  token: "0x00000000000000000000000000000000000075a1",
  usdgActual: 5,
  txHash: "0x" + "ef".repeat(32),
  rejectRule: null,
};

describe("the short loop carries orders", () => {
  it("A QUEUED ORDER REACHES ITS CHILD, claimed before the file is written", async () => {
    const { raw, db } = newDb();
    const a = newHome();
    insert(raw, { id: "o-a" });
    await ferryOrders(db, [{ home: a, smartAccount: ACCOUNT_A, tag: TENANT_A }]);
    assert.deepEqual(files(a), ["o-a.json"]);
    assert.ok(row(raw, "o-a").claimed_at, "claimed, so no other pass can hand it over again");
  });

  it("AND ONLY ORDERS — a probe or a reset waits for the reconcile pass, as it always did", async () => {
    const { raw, db } = newDb();
    const a = newHome();
    insert(raw, { id: "probe", kind: "selftest" });
    insert(raw, { id: "reset", kind: "paper-reset" });
    await ferryOrders(db, [{ home: a, smartAccount: ACCOUNT_A, tag: TENANT_A }]);
    assert.deepEqual(files(a), []);
    assert.equal(row(raw, "probe").claimed_at, null);
  });

  it("EACH CHILD GETS ITS OWN ORDERS, joined on the smart account and never the tenant wallet", async () => {
    const { raw, db } = newDb();
    const a = newHome();
    const b = newHome();
    insert(raw, { id: "for-a", agent_id: ACCOUNT_A });
    insert(raw, { id: "for-b", agent_id: ACCOUNT_B });
    insert(raw, { id: "under-tenant", agent_id: TENANT_A });
    insert(raw, { id: "stranger", agent_id: "0x5555555555555555555555555555555555555555" });
    await ferryOrders(db, [
      { home: a, smartAccount: ACCOUNT_A, tag: TENANT_A },
      { home: b, smartAccount: ACCOUNT_B, tag: TENANT_B },
    ]);
    assert.deepEqual(files(a), ["for-a.json"]);
    assert.deepEqual(files(b), ["for-b.json"]);
    assert.equal(row(raw, "under-tenant").claimed_at, null);
    assert.equal(row(raw, "stranger").claimed_at, null, "an order for an agent this replica does not run is not taken");
  });

  it("A ROW ANOTHER PASS ALREADY CLAIMED IS NOT WRITTEN AGAIN — the two loops share one claim", async () => {
    const { raw, db } = newDb();
    const a = newHome();
    insert(raw, { id: "once" });
    await ferryForChild(db, { home: a, smartAccount: ACCOUNT_A, tag: TENANT_A });
    // The child claims it, runs it, and the file is gone.
    rmSync(path.join(commandDir(a), "once.json"));
    await ferryOrders(db, [{ home: a, smartAccount: ACCOUNT_A, tag: TENANT_A }]);
    assert.deepEqual(files(a), [], "a second delivery of an order is a second fill");
  });

  it("THE CLAIM DECIDES, NOT THE READ — a pass that read the row before another claimed it writes nothing", async () => {
    // The race the two loops actually run: both SELECT the unclaimed row, one
    // claims it and the child takes the file, then the other arrives holding
    // its stale read. Only the conditional UPDATE can tell it the order is
    // gone; a pass that wrote on the strength of its read would put the order
    // back in the child's queue after the child already ran it.
    const { raw, db } = newDb();
    const a = newHome();
    insert(raw, { id: "stale" });
    const staleRows = raw.prepare("SELECT id, agent_id, kind, args, created_at FROM agent_commands").all();
    const t = { home: a, smartAccount: ACCOUNT_A, tag: TENANT_A };
    await ferryOrders(db, [t]);
    rmSync(path.join(commandDir(a), "stale.json")); // the child claimed and ran it
    const staleRead = {
      ...db,
      prepare: (sql: string) => {
        const st = db.prepare(sql);
        return /^\s*SELECT id, agent_id, kind/.test(sql) ? { ...st, all: async () => staleRows } : st;
      },
    };
    await ferryOrders(staleRead, [t]);
    assert.deepEqual(files(a), [], "the order must not reach the child a second time");
  });

  it("and the two loops racing each other still deliver an order once", async () => {
    const { raw, db } = newDb();
    const a = newHome();
    insert(raw, { id: "race" });
    const t = { home: a, smartAccount: ACCOUNT_A, tag: TENANT_A };
    await Promise.all([ferryOrders(db, [t]), ferryForChild(db, t), ferryOrders(db, [t])]);
    assert.deepEqual(files(a), ["race.json"]);
    const claimed = raw.prepare("SELECT COUNT(*) AS n FROM agent_commands WHERE claimed_at IS NOT NULL").get() as { n: number };
    assert.equal(claimed.n, 1);
  });

  it("no children, no query — an idle replica asks the database nothing", async () => {
    let asked = 0;
    const { db } = newDb();
    const spy = { ...db, prepare: (sql: string) => ((asked += 1), db.prepare(sql)) };
    await ferryOrders(spy, []);
    assert.equal(asked, 0);
  });
});

describe("and brings the answers back on the same clock", () => {
  it("A RESULT LANDS WITH ITS RECEIPT, the line untouched beside it, and the file goes", async () => {
    const { raw, db } = newDb();
    const a = newHome();
    insert(raw, { id: "r1" });
    const t = { home: a, smartAccount: ACCOUNT_A, tag: TENANT_A };
    await ferryOrders(db, [t]);
    rmSync(path.join(commandDir(a), "r1.json")); // the child's claim is the unlink
    writeCommandResult(a, { id: "r1", ok: true, line: "✅ bought 5.00 USDG of TSLA. It is on your tape.", at: 9, receipt: filled });
    await ferryOrders(db, [t]);
    const r = row(raw, "r1");
    assert.ok(r.done_at);
    assert.equal(r.result, "✅ bought 5.00 USDG of TSLA. It is on your tape.");
    assert.deepEqual(JSON.parse(String(r.receipt)), filled);
    assert.deepEqual(files(a), [], "the result file is dropped once its row is written");
  });

  it("A RESULT WITH NO RECEIPT WRITES NULL, not an empty object", async () => {
    const { raw, db } = newDb();
    const a = newHome();
    insert(raw, { id: "r2", kind: "selftest" });
    await ferryForChild(db, { home: a, smartAccount: ACCOUNT_A, tag: TENANT_A });
    writeCommandResult(a, { id: "r2", ok: true, line: "PASSED", at: 9 });
    await ferryOrders(db, [{ home: a, smartAccount: ACCOUNT_A, tag: TENANT_A }]);
    assert.equal(row(raw, "r2").receipt, null);
    assert.equal(row(raw, "r2").result, "PASSED");
  });

  it("A DATABASE THAT HAS NOT GROWN THE COLUMN YET STILL GETS THE LINE — the receipt waits, the answer does not", async () => {
    // Web and orchestrator deploy at the same moment and the column is added
    // by a pass that may not have run yet. Losing the whole answer to a
    // missing column would leave the owner's order spinning with its one-at-
    // a-time slot held — for want of a field every reader treats as optional.
    const { raw, db } = newDb(false);
    const a = newHome();
    insert(raw, { id: "r3" });
    const t = { home: a, smartAccount: ACCOUNT_A, tag: TENANT_A };
    await ferryOrders(db, [t]);
    writeCommandResult(a, { id: "r3", ok: true, line: "bought", at: 9, receipt: filled });
    await ferryOrders(db, [t]);
    const r = row(raw, "r3");
    assert.ok(r.done_at, "answered");
    assert.equal(r.result, "bought");
    assert.equal(Object.hasOwn(r, "receipt"), false);
  });

  it("the reconcile pass writes the receipt too — one up-leg, two clocks", async () => {
    const { raw, db } = newDb();
    const a = newHome();
    insert(raw, { id: "r4" });
    const t = { home: a, smartAccount: ACCOUNT_A, tag: TENANT_A };
    await ferryForChild(db, t);
    writeCommandResult(a, { id: "r4", ok: false, line: "🧱 refused", at: 9, receipt: { ...filled, status: "refused", usdgActual: null, txHash: null, rejectRule: "per-trade-cap" } });
    await ferryForChild(db, t);
    assert.equal(JSON.parse(String(row(raw, "r4").receipt)).rejectRule, "per-trade-cap");
  });

  it("the column is added idempotently — a second run is a no-op the caller swallows, never a changed table", () => {
    const { raw } = newDb(false);
    raw.exec(COMMAND_RECEIPT_DDL);
    assert.throws(() => raw.exec(COMMAND_RECEIPT_DDL));
    const cols = (raw.prepare("PRAGMA table_info(agent_commands)").all() as { name: string; notnull: number; dflt_value: unknown }[]);
    const receipt = cols.find((c) => c.name === "receipt");
    assert.ok(receipt, "the column exists");
    assert.equal(receipt.notnull, 0, "nullable — a row from before it existed has no receipt, which is not an empty one");
    assert.equal(receipt.dflt_value, null, "and no default");
  });
});
