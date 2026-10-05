/**
 * EACH CAPITAL FLOW ONCE, AND NONE WHEN THE ROWS DISAGREE.
 *
 * Driven against a ledger built by the worker's own schema — so the identity
 * index is there and a copy has to be written the ways production wrote them:
 * under another spelling of the account, with no chain stamp, or with no
 * identity at all. Run against sqlite AND against the Postgres translation of
 * the same SQL (placeholders renumbered, bound by name), because the hosted web
 * reads Postgres. It cannot stand in for the Postgres planner; it does catch a
 * statement the translation breaks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { translateQuery, wrapSqlite, type Db, type RunResult } from "./db";
import { applyLedgerSchema } from "./store";
import {
  CapitalFlowsWithheld, collapseFlows, flowDuplicateReport, netFlows, readDistinctFlows, type FlowRecord,
} from "./distinct-flows";

const ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CASED = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FOREIGN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TX = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

/** The store's SQL, run the way PgDb would send it: translated, then bound as $1..$n. */
function pgTranslated(raw: DatabaseSync): Db {
  const bind = (params: unknown[]) => Object.fromEntries(params.map((p, i) => [`$${i + 1}`, p])) as never;
  const db: Db = {
    prepare(sql: string) {
      const text = translateQuery(sql);
      return {
        run: async (...p: unknown[]) => raw.prepare(text).run(bind(p)) as RunResult,
        get: async (...p: unknown[]) => raw.prepare(text).get(bind(p)),
        all: async (...p: unknown[]) => raw.prepare(text).all(bind(p)),
      };
    },
    exec: async (sql: string) => raw.exec(sql),
    tx: async (fn) => fn(db),
  };
  return db;
}

async function ledger() {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  await db.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps,
    granted_at, expires_at, mode, epoch) VALUES (?, 'Desk', '0x1', '0x2', 4663, '{}', 0, 0, 'live', 2)`).run(ACCOUNT);
  return { raw, db, readers: [db, pgTranslated(raw)] as const };
}

interface Row { account?: string; epoch?: number; direction?: "in" | "out"; amount?: number; tx?: string | null;
  log?: number | null; chain?: number | null; source?: string; at?: number; block?: number | null }
async function flow(db: Db, r: Row = {}) {
  await db.prepare(`INSERT INTO flows (agent_id, epoch, direction, amount_usdg, tx_hash, block_number, log_index, source, chain_id, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.account ?? ACCOUNT, r.epoch ?? 2, r.direction ?? "in", r.amount ?? 100,
    r.tx === undefined ? null : r.tx, r.block === undefined ? null : r.block, r.log === undefined ? null : r.log,
    r.source ?? "chain-log", r.chain === undefined ? null : r.chain, r.at ?? 1);
}

async function withheld(read: Promise<unknown>): Promise<"unread" | "review"> {
  try {
    await read;
  } catch (e) {
    assert.ok(e instanceof CapitalFlowsWithheld, String(e));
    return e.verdict;
  }
  assert.fail("the figure was read, not withheld");
}

test("an exact duplicate carry collapses; a different carry in the same epoch makes the figure unavailable", async () => {
  const { raw, db, readers } = await ledger();
  try {
    await flow(db, { source: "epoch-carry", amount: 250, at: 10 });
    // The mirror's re-copy, and the same carry booked again under another
    // spelling at another time: one epoch opens once, with one balance.
    await flow(db, { source: "epoch-carry", amount: 250, at: 10 });
    await flow(db, { account: CASED, source: "epoch-carry", amount: 250, at: 40 });
    await flow(db, { tx: TX(1), log: 0, chain: 4663, amount: 50, at: 20 });
    // Another run's carry and another account's are not this run's.
    await flow(db, { source: "epoch-carry", amount: 999, epoch: 1 });
    await flow(db, { account: FOREIGN, source: "epoch-carry", amount: 999 });
    for (const reader of readers) {
      const flows = await readDistinctFlows(reader, CASED, 2);
      assert.deepEqual(flows.map((f) => [f.source, f.amountUsdg, f.at]), [["epoch-carry", 250, 10], ["chain-log", 50, 20]]);
      assert.deepEqual(netFlows(flows), { n: 2, net: 300 });
      const report = await flowDuplicateReport(reader, ACCOUNT);
      assert.equal(report.epoch, 2);
      assert.deepEqual(report.copies, { log: 0, nullChain: 0, carry: 2, identical: 0 });
      assert.equal(report.verdict, "ok");
      assert.equal(report.clean, false, "a collapsed copy is still a copy the worker's own sums would add");
    }
    await flow(db, { source: "epoch-carry", amount: 240, at: 11 });
    for (const reader of readers) {
      assert.equal(await withheld(readDistinctFlows(reader, ACCOUNT, 2)), "unread");
      await assert.rejects(readDistinctFlows(reader, ACCOUNT, 2), /^CapitalFlowsWithheld: Unread capital accounting$/);
      const report = await flowDuplicateReport(reader, ACCOUNT);
      assert.equal(report.conflicts.carries, 1);
      assert.equal(report.verdict, "unread");
    }
  } finally { raw.close(); }
});

test("a transfer intent and a chain log on the same tx and direction are never summed: contributions under review", async () => {
  const { raw, db, readers } = await ledger();
  try {
    await flow(db, { tx: TX(1), log: 0, chain: 4663, amount: 100, at: 1 });
    // The executor's booking of a transfer home: its tx, no log index.
    await flow(db, { tx: TX(0xabcdef), source: "transfer-intent", direction: "out", amount: 10, chain: 4663, at: 5 });
    // The same tx touching the account the OTHER way is another leg, not a twin.
    await flow(db, { tx: TX(0xabcdef), log: 4, chain: 4663, direction: "in", amount: 1, at: 5 });
    for (const reader of readers) assert.deepEqual(netFlows(await readDistinctFlows(reader, ACCOUNT, 2)), { n: 3, net: 91 });
    // A scan that no longer had the trade row to skip books it again from its
    // log — in whatever case the RPC returned the hash.
    await flow(db, { tx: TX(0xabcdef).toUpperCase().replace("0X", "0x"), log: 3, chain: 4663, direction: "out", amount: 10, at: 900 });
    for (const reader of readers) {
      assert.equal(await withheld(readDistinctFlows(reader, ACCOUNT, 2)), "review");
      await assert.rejects(readDistinctFlows(reader, ACCOUNT, 2), /Contributions under review/);
      const report = await flowDuplicateReport(reader, ACCOUNT, 2);
      assert.equal(report.conflicts.intentTwins, 1);
      assert.equal(report.verdict, "review");
      assert.equal(report.clean, false);
    }
  } finally { raw.close(); }
});

test("an intent booked from its receipt is the same log as its chain-log copy, not a twin", async () => {
  const { raw, db, readers } = await ledger();
  try {
    await flow(db, { tx: TX(1), log: 0, chain: 4663, amount: 100, at: 1 });
    // The resolver books a transfer home with its log index (energy-settle.ts);
    // a copy of that log under another spelling is the same movement.
    await flow(db, { tx: TX(2), log: 3, chain: 4663, source: "transfer-intent", direction: "out", amount: 10, at: 5 });
    await flow(db, { account: CASED, tx: TX(2), log: 3, chain: 4663, source: "chain-log", direction: "out", amount: 10, at: 9 });
    for (const reader of readers) {
      assert.deepEqual(netFlows(await readDistinctFlows(reader, ACCOUNT, 2)), { n: 2, net: 90 });
      const report = await flowDuplicateReport(reader, ACCOUNT);
      assert.deepEqual(report.copies, { log: 1, nullChain: 0, carry: 0, identical: 0 });
      assert.equal(report.conflicts.intentTwins, 0);
    }
  } finally { raw.close(); }
});

test("a NULL-chain twin merges with its chain-stamped copy, read as the account's registered chain", async () => {
  const { raw, db, readers } = await ledger();
  try {
    await flow(db, { tx: TX(7), log: 7, chain: null, amount: 100, at: 1 });
    await flow(db, { tx: TX(7), log: 7, chain: 4663, amount: 100, at: 30 });
    for (const reader of readers) {
      const flows = await readDistinctFlows(reader, ACCOUNT, 2);
      assert.deepEqual(flows.map((f) => [f.amountUsdg, f.at, f.chainId]), [[100, 1, null]], "the first booking speaks for it");
      // A cutoff between the copies keeps the movement once, at its first booking.
      assert.deepEqual(netFlows(flows, 10), { n: 1, net: 100 });
      assert.deepEqual(netFlows(flows, 0), { n: 0, net: 0 });
      const report = await flowDuplicateReport(reader, ACCOUNT);
      assert.deepEqual(report.copies, { log: 0, nullChain: 1, carry: 0, identical: 0 });
    }
    // Copies of one log that disagree cannot both be the log.
    await flow(db, { account: CASED, tx: TX(7), log: 7, chain: 4663, amount: 90, at: 40 });
    for (const reader of readers) {
      assert.equal(await withheld(readDistinctFlows(reader, ACCOUNT, 2)), "unread");
      assert.equal((await flowDuplicateReport(reader, ACCOUNT)).conflicts.logs, 1);
    }
  } finally { raw.close(); }
});

test("an unstamped log on an account whose chain cannot be named is unread, never guessed", async () => {
  const { raw, db, readers } = await ledger();
  try {
    await flow(db, { tx: TX(7), log: 7, chain: 4663, amount: 100, at: 1 });
    await flow(db, { tx: TX(7), log: 7, chain: null, amount: 100, at: 2 });
    // A second registration of the same address on another chain: the
    // unstamped row may be either chain's, so neither copy can be dropped.
    await db.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps,
      granted_at, expires_at, mode, epoch) VALUES (?, 'Desk', '0x1', '0x2', 46630, '{}', 0, 0, 'live', 2)`).run(CASED);
    for (const reader of readers) {
      assert.equal(await withheld(readDistinctFlows(reader, ACCOUNT, 2)), "unread");
      assert.equal((await flowDuplicateReport(reader, ACCOUNT)).conflicts.unresolvedChain, 1);
    }
  } finally { raw.close(); }
});

test("same-amount deposits in different transactions both count; only byte-identical unidentified rows collapse", async () => {
  const { raw, db, readers } = await ledger();
  try {
    await flow(db, { tx: TX(1), log: 0, chain: 4663, amount: 50, at: 1 });
    await flow(db, { tx: TX(2), log: 0, chain: 4663, amount: 50, at: 1 });
    // Two inferred top-ups of the same size at different times are two.
    await flow(db, { source: "inferred", amount: 5, at: 3 });
    await flow(db, { source: "inferred", amount: 5, at: 4 });
    // The mirror's exact copy of one of them is not.
    await flow(db, { source: "inferred", amount: 5, at: 4 });
    // A legacy chain log with no tx, and its copy filed under another spelling:
    // not byte-identical, so nothing proves it is the same row.
    await flow(db, { amount: 3, at: 6 });
    await flow(db, { account: CASED, amount: 3, at: 6 });
    for (const reader of readers) {
      assert.deepEqual(netFlows(await readDistinctFlows(reader, ACCOUNT, 2)), { n: 6, net: 116 });
      const report = await flowDuplicateReport(reader, ACCOUNT);
      assert.deepEqual(report.copies, { log: 0, nullChain: 0, carry: 0, identical: 1 });
      assert.equal(report.rows, 7);
      assert.equal(report.distinct, 6);
    }
  } finally { raw.close(); }
});

test("the same tx#log on chain 1 and on chain 4663 stays two movements", async () => {
  const { raw, db, readers } = await ledger();
  try {
    await flow(db, { tx: TX(9), log: 2, chain: 4663, amount: 100, at: 1 });
    await flow(db, { tx: TX(9), log: 2, chain: 1, amount: 10, at: 2 });
    // And a different log index in the same tx is a different transfer.
    await flow(db, { tx: TX(9), log: 3, chain: 4663, amount: 100, at: 3 });
    for (const reader of readers) {
      assert.deepEqual(netFlows(await readDistinctFlows(reader, ACCOUNT, 2)), { n: 3, net: 210 });
      assert.equal((await flowDuplicateReport(reader, ACCOUNT)).clean, true);
    }
  } finally { raw.close(); }
});

test("the report reads the current run, writes nothing, and refuses an account with no registration", async () => {
  const { raw, db, readers } = await ledger();
  try {
    // A closed epoch's copies are in no figure.
    await flow(db, { source: "inferred", amount: 5, at: 4, epoch: 1 });
    await flow(db, { source: "inferred", amount: 5, at: 4, epoch: 1 });
    await flow(db, { tx: TX(1), log: 0, chain: 4663, amount: 50, at: 1 });
    const before = raw.prepare("SELECT COUNT(*) AS n FROM flows").get() as { n: number };
    for (const reader of readers) {
      const report = await flowDuplicateReport(reader, CASED);
      assert.equal(report.account, ACCOUNT);
      assert.equal(report.epoch, 2);
      assert.equal(report.clean, true);
      assert.equal((await flowDuplicateReport(reader, ACCOUNT, 1)).copies.identical, 1);
      await assert.rejects(flowDuplicateReport(reader, FOREIGN), /no registration/);
    }
    assert.deepEqual(raw.prepare("SELECT COUNT(*) AS n FROM flows").get(), before);
  } finally { raw.close(); }
});

test("a row that does not read as a flow makes the run unread, and a failed read throws as itself", async () => {
  const { raw, db, readers } = await ledger();
  try {
    await flow(db, { tx: TX(1), log: 0, chain: 4663, amount: 50, at: 1 });
    await flow(db, { direction: "sideways" as "in", amount: 5, at: 2 });
    for (const reader of readers) assert.equal(await withheld(readDistinctFlows(reader, ACCOUNT, 2)), "unread");
    const failing: Db = { ...db, prepare(sql) {
      if (sql.includes("FROM flows")) throw new Error("permission denied");
      return db.prepare(sql);
    } };
    await assert.rejects(readDistinctFlows(failing, ACCOUNT, 2), /permission denied/);
  } finally { raw.close(); }
});

test("a ledger older than the identity columns collapses only exact copies", async () => {
  const raw = new DatabaseSync(":memory:");
  try {
    raw.exec(`CREATE TABLE flows (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, direction TEXT NOT NULL,
      amount_usdg REAL NOT NULL, tx_hash TEXT, block_number INTEGER, source TEXT NOT NULL, at INTEGER NOT NULL)`);
    const insert = raw.prepare("INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, source, at) VALUES (?, 'in', ?, ?, 'chain-log', ?)");
    insert.run(ACCOUNT, 100, TX(1), 1);
    insert.run(ACCOUNT, 100, TX(1), 1);
    insert.run(ACCOUNT, 100, TX(2), 1);
    for (const reader of [wrapSqlite(raw), pgTranslated(raw)]) {
      // No epoch column either: a pre-epoch ledger's every row is its one run.
      assert.deepEqual(netFlows(await readDistinctFlows(reader, CASED, null)), { n: 2, net: 200 });
    }
    // A reader's fixture with no id, tx or source at all is still a run read.
    raw.exec(`DROP TABLE flows; CREATE TABLE flows (agent_id TEXT, epoch INTEGER, direction TEXT, amount_usdg REAL, at INTEGER);
      INSERT INTO flows VALUES ('${ACCOUNT}', 2, 'in', 100, 1), ('${ACCOUNT}', 2, 'out', 10, 2), ('${ACCOUNT}', 2, 'out', 10, 2)`);
    for (const reader of [wrapSqlite(raw), pgTranslated(raw)]) {
      assert.deepEqual(netFlows(await readDistinctFlows(reader, ACCOUNT, 2)), { n: 2, net: 90 }, "an exact copy is still one");
    }
  } finally { raw.close(); }
});

test("collapse is a pure function of the rows, taken earliest first whatever order they arrive in", () => {
  const row = (over: Partial<FlowRecord>): FlowRecord => ({ id: 1, agentId: ACCOUNT, direction: "in", amountUsdg: 100, txHash: TX(1),
    blockNumber: 5, logIndex: 0, source: "chain-log", chainId: 4663, at: 10, ...over });
  const late = row({ id: 1, at: 30 });
  const early = row({ id: 2, at: 10, chainId: null });
  const out = collapseFlows([late, early], 4663);
  assert.deepEqual(out.flows, [early]);
  assert.equal(out.verdict, "ok");
  assert.equal(collapseFlows([late, early], null).verdict, "unread");
  // An empty hash is no hash: a row keyed by nothing is not a log.
  assert.equal(collapseFlows([row({ id: 3, txHash: "" }), row({ id: 4, txHash: "", at: 11 })], null).flows.length, 2);
});
