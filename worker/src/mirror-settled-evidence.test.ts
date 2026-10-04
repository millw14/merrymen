import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { wrapSqlite, translateQuery, type Db, type RunResult } from "./db";
import { applyLedgerSchema } from "./store";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";

const ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CASED = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const NOW = 1_800_000_000;
const CREATED = NOW - 7 * 86_400;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

// Exercise the production placeholder translation as well as native SQLite.
// This is not a live PostgreSQL test; transaction behavior stays SQLite's.
function translated(inner: Db, raw: DatabaseSync): Db {
  const bindings = (params: unknown[]) => Object.fromEntries(params.map((p, i) => [`$${i + 1}`, p])) as never;
  const wrap = (db: Db): Db => ({
    ...db, prepare(sql) { const text = translateQuery(sql); return {
      run: async (...p) => raw.prepare(text).run(bindings(p)) as RunResult,
      get: async (...p) => raw.prepare(text).get(bindings(p)),
      all: async (...p) => raw.prepare(text).all(bindings(p)),
    }; }, tx: (fn) => db.tx((scoped) => fn(wrap(scoped))),
  });
  return wrap(inner);
}

async function pair(pg = false) {
  const childRaw = new DatabaseSync(":memory:");
  const sharedRaw = new DatabaseSync(":memory:");
  const child = wrapSqlite(childRaw);
  const sharedSqlite = wrapSqlite(sharedRaw);
  await applyLedgerSchema(child);
  await applyLedgerSchema(sharedSqlite);
  await sharedSqlite.exec(MIRROR_STATE_DDL);
  // Also model a rolling schema while the receipt-time writer is being added.
  for (const raw of [childRaw, sharedRaw]) {
    if (!raw.prepare("PRAGMA table_info(trades)").all().some((r) => r.name === "gas_recorded_at"))
      raw.exec("ALTER TABLE trades ADD COLUMN gas_recorded_at INTEGER");
  }
  return { child, shared: pg ? translated(sharedSqlite, sharedRaw) : sharedSqlite,
    childRaw, sharedRaw, close() { childRaw.close(); sharedRaw.close(); } };
}

async function trade(db: Db, n: number, extra: Record<string, unknown> = {}) {
  const row = { agent_id: ACCOUNT, epoch: 2, kind: "swap", target: OTHER, amount_usdg: 5,
    user_op_hash: hash(n), tx_hash: hash(n + 100), status: "landed", created_at: CREATED,
    ...extra };
  const columns = Object.keys(row);
  await db.prepare(`INSERT INTO trades (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
    .run(...Object.values(row));
}
async function row(db: Db, n: number) {
  return await db.prepare("SELECT * FROM trades WHERE LOWER(user_op_hash) = ? ORDER BY id LIMIT 1")
    .get(hash(n)) as Record<string, unknown>;
}

for (const pg of [false, true]) test(`historical receipt enrichment preserves settled provenance (${pg ? "translated" : "SQLite"})`, async () => {
  const p = await pair(pg);
  try {
    await trade(p.shared, 1, { decision_id: "original-decision", fill_side: "buy", fill_qty_raw: "1000",
      fill_cash_usdg: 5, basis_source: "receipt", user_op_nonce: "123" });
    const before = await row(p.shared, 1);
    await trade(p.child, 1, { kind: "curve-trade", amount_usdg: 999, decision_id: "late-decision",
      gas_wei: "100", gas_usdg: 0.25, gas_units: "50", gas_recorded_at: CREATED + 3,
      budget_settled_at: CREATED + 5 });
    const report = await mirrorTenant({ tenant: ACCOUNT, child: p.child, shared: p.shared, nowSec: NOW });
    const after = await row(p.shared, 1);
    assert.equal(report.failed, undefined);
    assert.equal(report.copied.trades, 0, "the operation already exists; no duplicate is inserted");
    assert.equal(report.copied.trades_enriched, 1, "the source is older than the ordinary resync window");
    assert.deepEqual({ ...after }, { ...before, gas_wei: "100", gas_usdg: 0.25, gas_units: "50",
      gas_recorded_at: CREATED + 3 });
    assert.equal(after.budget_settled_at, null, "historical gas recovery does not move a risk-budget window");
    assert.equal((await mirrorTenant({ tenant: ACCOUNT, child: p.child, shared: p.shared, nowSec: NOW + 15 }))
      .copied.trades_enriched, undefined, "a second pass writes no settled facts");
  } finally { p.close(); }
});

test("settled enrichment matches arbitrary address/hash casing, outcome and epoch without crossing books", async () => {
  const p = await pair();
  try {
    const op = "0x" + "ab".repeat(32);
    await trade(p.child, 1, { user_op_hash: op, sponsored_gas_wei: "120", gas_units: "60", gas_recorded_at: CREATED + 4 });
    await trade(p.shared, 1, { agent_id: CASED, user_op_hash: op.toUpperCase().replace("0X", "0x") });
    await trade(p.shared, 1, { agent_id: OTHER, user_op_hash: op });
    await trade(p.shared, 1, { epoch: 1, user_op_hash: op });
    await trade(p.shared, 1, { status: "reverted", user_op_hash: op });
    await p.shared.prepare(`INSERT INTO mirror_state (tenant, table_name, last_id, last_stamp, updated_at)
      VALUES (?, 'trades', 1, ?, ?)`).run(ACCOUNT, CREATED, NOW);
    const report = await mirrorTenant({ tenant: ACCOUNT, child: p.child, shared: p.shared, nowSec: NOW });
    assert.equal(report.copied.trades_enriched, 1);
    const rows = await p.shared.prepare("SELECT agent_id, epoch, status, sponsored_gas_wei FROM trades ORDER BY id").all();
    assert.deepEqual(rows.map((r) => ({ ...r as Record<string, unknown> })), [
      { agent_id: CASED, epoch: 2, status: "landed", sponsored_gas_wei: "120" },
      { agent_id: OTHER, epoch: 2, status: "landed", sponsored_gas_wei: null },
      { agent_id: ACCOUNT, epoch: 1, status: "landed", sponsored_gas_wei: null },
      { agent_id: ACCOUNT, epoch: 2, status: "reverted", sponsored_gas_wei: null },
    ]);
  } finally { p.close(); }
});

test("receipt, cost, payer, units and timestamps cannot overwrite a conflicting settled fact", async () => {
  const conflicts = [
    { tx_hash: hash(999) }, { gas_wei: "101" }, { gas_usdg: 0.3 }, { gas_units: "51" },
    { sponsored_gas_wei: "100" }, { gas_recorded_at: CREATED + 4 },
  ];
  const p = await pair();
  try {
    for (let i = 0; i < conflicts.length; i++) {
      await trade(p.child, i + 1, { gas_wei: "100", gas_usdg: 0.25, gas_units: "50",
        gas_recorded_at: CREATED + 3, budget_settled_at: CREATED + 5 });
      await trade(p.shared, i + 1, conflicts[i]);
    }
    const before = await p.shared.prepare("SELECT * FROM trades ORDER BY id").all();
    const report = await mirrorTenant({ tenant: ACCOUNT, child: p.child, shared: p.shared, nowSec: NOW });
    assert.equal(report.copied.trades_enriched, undefined);
    assert.deepEqual(await p.shared.prepare("SELECT * FROM trades ORDER BY id").all(), before);
    await trade(p.child, 20, { sponsored_gas_wei: "100", gas_units: "50" });
    await trade(p.shared, 20, { gas_wei: "100" });
    const owned = await row(p.shared, 20);
    await mirrorTenant({ tenant: ACCOUNT, child: p.child, shared: p.shared, nowSec: NOW });
    assert.deepEqual(await row(p.shared, 20), owned, "sponsor proof cannot replace a known owner payer either");
    await trade(p.child, 21, { gas_wei: "0", gas_recorded_at: CREATED + 3 });
    await trade(p.shared, 21, { gas_usdg: 0.5 });
    const priced = await row(p.shared, 21);
    await mirrorTenant({ tenant: ACCOUNT, child: p.child, shared: p.shared, nowSec: NOW });
    assert.deepEqual(await row(p.shared, 21), priced, "a zero native cost cannot be added beside a known positive expense");
    await trade(p.child, 22, { gas_usdg: 0.5, gas_recorded_at: CREATED + 3 });
    await trade(p.shared, 22, { gas_wei: "0" });
    const free = await row(p.shared, 22);
    await mirrorTenant({ tenant: ACCOUNT, child: p.child, shared: p.shared, nowSec: NOW });
    assert.deepEqual(await row(p.shared, 22), free, "known zero owner cost cannot acquire a conflicting positive price");
  } finally { p.close(); }
});

test("reverted gas enriches only missing evidence; unread or absent gas is never made free", async () => {
  const p = await pair();
  try {
    await trade(p.child, 1, { status: "reverted", gas_wei: "100", gas_usdg: 0.25, gas_recorded_at: CREATED + 3 });
    await trade(p.shared, 1, { status: "reverted", gas_wei: "100" });
    await trade(p.child, 2);
    await trade(p.shared, 2);
    const unknown = await row(p.shared, 2);
    await mirrorTenant({ tenant: ACCOUNT, child: p.child, shared: p.shared, nowSec: NOW });
    const paid = await row(p.shared, 1);
    assert.equal(paid.status, "reverted");
    assert.equal(paid.gas_usdg, 0.25);
    assert.equal(paid.budget_settled_at, null, "no timing is invented for risk budgets");
    assert.deepEqual(await row(p.shared, 2), unknown);
    await p.child.exec("ALTER TABLE trades DROP COLUMN gas_recorded_at");
    await trade(p.child, 3, { sponsored_gas_wei: "100" });
    await trade(p.shared, 3);
    const legacy = await mirrorTenant({ tenant: ACCOUNT, child: p.child, shared: p.shared, nowSec: NOW });
    assert.equal(legacy.failed, undefined, "a child without the new optional column remains supported");
    assert.equal((await row(p.shared, 3)).sponsored_gas_wei, "100");
    assert.equal((await row(p.shared, 3)).gas_recorded_at, null);
  } finally { p.close(); }
});

test("bounded history replay cycles to pick up later evidence behind its watermark", async () => {
  const p = await pair();
  try {
    for (let n = 1; n <= 3; n++) {
      await trade(p.child, n, { sponsored_gas_wei: "100" });
      await trade(p.shared, n);
    }
    const run = () => mirrorTenant({ tenant: ACCOUNT, child: p.child, shared: p.shared, nowSec: NOW, batch: 2 });
    assert.equal((await run()).copied.trades_enriched, 2);
    assert.equal((await row(p.shared, 3)).sponsored_gas_wei, null, "a pass never exceeds its row budget");
    assert.equal((await run()).copied.trades_enriched, 1);
    await p.child.prepare("UPDATE trades SET gas_recorded_at = ? WHERE user_op_hash = ?").run(CREATED + 3, hash(1));
    assert.equal((await run()).copied.trades_enriched, 1, "late evidence on an old id is revisited after the cycle");
    assert.equal((await row(p.shared, 1)).gas_recorded_at, CREATED + 3);
    assert.equal((await p.shared.prepare("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n, 3);
  } finally { p.close(); }
});

test("an interrupted history enrichment rolls back both rows and replay progress", async () => {
  const p = await pair();
  try {
    for (let n = 1; n <= 2; n++) {
      await trade(p.child, n, { sponsored_gas_wei: "100" });
      await trade(p.shared, n);
    }
    let updates = 0;
    const wrap = (db: Db): Db => ({ ...db, prepare(sql) { const statement = db.prepare(sql); return {
      ...statement, run: async (...params) => {
        if (sql.startsWith("UPDATE trades SET tx_hash = COALESCE(NULLIF") && ++updates === 2)
          throw new Error("interrupted evidence write");
        return statement.run(...params);
      },
    }; }, tx: (fn) => db.tx((scoped) => fn(wrap(scoped))) });
    const failed = await mirrorTenant({ tenant: ACCOUNT, child: p.child, shared: wrap(p.shared), nowSec: NOW, batch: 2 });
    assert.match(failed.failed?.trades_settled_evidence ?? "", /interrupted/);
    assert.equal((await row(p.shared, 1)).sponsored_gas_wei, null);
    assert.equal(await p.shared.prepare("SELECT * FROM mirror_state WHERE table_name = 'trades_settled_evidence'").get(), undefined);
    assert.equal((await mirrorTenant({ tenant: ACCOUNT, child: p.child, shared: p.shared, nowSec: NOW, batch: 2 }))
      .copied.trades_enriched, 2, "the exact same batch remains recoverable");
  } finally { p.close(); }
});

test("a rebuilt child cannot leave the evidence cursor beyond its new row ids forever", async () => {
  const p = await pair();
  try {
    await trade(p.shared, 1);
    await trade(p.child, 1, { sponsored_gas_wei: "100" });
    await p.shared.prepare(`INSERT INTO mirror_state (tenant, table_name, last_id, updated_at)
      VALUES (?, 'trades_settled_evidence', 500, ?)`).run(ACCOUNT, NOW - 60);
    const run = () => mirrorTenant({ tenant: ACCOUNT, child: p.child, shared: p.shared, nowSec: NOW });
    assert.equal((await run()).copied.trades_enriched, undefined);
    assert.equal((await row(p.shared, 1)).sponsored_gas_wei, null);
    assert.equal((await run()).copied.trades_enriched, 1);
    assert.equal((await row(p.shared, 1)).sponsored_gas_wei, "100");
  } finally { p.close(); }
});

test("an unread optional gas-time column cannot silently discard its source evidence", async () => {
  const p = await pair();
  try {
    await trade(p.shared, 1);
    await trade(p.child, 1, { sponsored_gas_wei: "100", gas_recorded_at: CREATED + 3 });
    const child: Db = { ...p.child, prepare(sql) {
      if (sql === "SELECT gas_recorded_at FROM trades LIMIT 0") throw new Error("permission denied for gas-time evidence");
      return p.child.prepare(sql);
    } };
    const report = await mirrorTenant({ tenant: ACCOUNT, child, shared: p.shared, nowSec: NOW });
    assert.match(report.failed?.trades_settled_evidence ?? "", /permission denied/);
    assert.equal((await row(p.shared, 1)).sponsored_gas_wei, null);
    assert.equal((await row(p.shared, 1)).gas_recorded_at, null);
    assert.equal(await p.shared.prepare("SELECT * FROM mirror_state WHERE table_name = 'trades_settled_evidence'").get(), undefined);
  } finally { p.close(); }
});

test("new receipt block time travels in both the first copy and submitted resolution", async () => {
  const p = await pair();
  try {
    await trade(p.child, 1, { sponsored_gas_wei: "100", gas_recorded_at: CREATED + 3 });
    await trade(p.child, 2, { status: "submitted", tx_hash: null });
    await mirrorTenant({ tenant: ACCOUNT, child: p.child, shared: p.shared, nowSec: NOW });
    assert.equal((await row(p.shared, 1)).gas_recorded_at, CREATED + 3);
    await p.child.prepare(`UPDATE trades SET status = 'reverted', tx_hash = ?, sponsored_gas_wei = '120',
      gas_recorded_at = ?, budget_settled_at = ? WHERE user_op_hash = ?`).run(hash(102), NOW - 1, NOW, hash(2));
    const report = await mirrorTenant({ tenant: ACCOUNT, child: p.child, shared: p.shared, nowSec: NOW });
    assert.equal(report.copied.trades_resolved, 1);
    assert.equal((await row(p.shared, 2)).gas_recorded_at, NOW - 1);
    assert.equal((await row(p.shared, 2)).created_at, CREATED);
  } finally { p.close(); }
});
