/**
 * THE PERP MIRROR CANNOT STALL (docs/perps.md, "Ledger" → "Hosted").
 *
 * Two review findings, each driven through mirrorPerpLedger over two real
 * sqlite ledgers built from PERP_LEDGER_DDL:
 *
 *   mirror-transfer-update-unique-stall  a child transfer whose identities
 *       point at TWO shared rows used to COALESCE-fill one of them into a
 *       partial unique index; the error rolled back the whole batch, the
 *       cursor never moved, and every later transfer of the tenant was never
 *       copied. Now one target is resolved, only free identities are filled,
 *       and a contradiction is a recorded conflict the batch commits past.
 *   mirror-perp-page-cap-permanent-skip  a bare-time cursor that reopened 300 s
 *       behind the newest stamp read re-read the same first PERP_MAX_PAGES ×
 *       batch rows for ever once more than that many shared one span. Now a
 *       (stamp, rowid) keyset moves every pass that finds rows.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import { MIRROR_STATE_DDL, mirrorPerpLedger } from "./ledger-mirror";
import { PERP_LEDGER_DDL } from "./store";

function perpDb(): { db: Db; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  for (const ddl of PERP_LEDGER_DDL) {
    try {
      raw.exec(ddl);
    } catch (e) {
      // The DDL also ALTERs tables this bare ledger does not have (equity).
      if (!/no such table|duplicate column/.test(String(e))) throw e;
    }
  }
  raw.exec(MIRROR_STATE_DDL);
  return { db: wrapSqlite(raw), raw };
}

const A = "0xabcabcabcabcabcabcabcabcabcabcabcabcabca";
const U = `0x${"11".repeat(32)}`;
const T = `0x${"22".repeat(32)}`;
const TENANT = "0xten";

async function pass(child: Db, shared: Db, nowSec: number, batch = 500) {
  const copied: Record<string, number> = {};
  const failed: Record<string, string> = {};
  await mirrorPerpLedger({ child, shared, tenant: TENANT, nowSec, batch, copied, failed });
  return { copied, failed };
}

function transfer(raw: DatabaseSync, row: Record<string, string | number | null>) {
  const cols = Object.keys(row);
  raw.prepare(`INSERT INTO perp_transfers (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(row) as never[]));
}
const base = { agent_id: A, mode: "live", epoch: 1, direction: "deposit", amount_micro: "5000000", initiator: "agent" };
const sharedRow = (raw: DatabaseSync, id: string) => raw.prepare("SELECT * FROM perp_transfers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
const count = (raw: DatabaseSync, table: string) => Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

describe("perp_transfers: one contradictory row never stalls the table", () => {
  it("the review's scenario: a rebuilt child's row later learns an identity ANOTHER shared row holds", async () => {
    const shared = perpDb();
    // Incarnation 1: the deposit, UserOp known, receipt not read yet.
    const child1 = perpDb();
    transfer(child1.raw, { ...base, id: "x", state: "submitted", user_op_hash: U, created_at: 1000, updated_at: 1000 });
    assert.deepEqual((await pass(child1.db, shared.db, 1010)).failed, {});
    // Incarnation 2 (a wiped hosted ledger) books the same deposit from the
    // proxy log alone — no identity overlaps yet, so it is a second row.
    const child2 = perpDb();
    transfer(child2.raw, { ...base, id: "y", state: "landed", chain_id: 4663, tx_hash: T, log_index: 7, created_at: 2000, updated_at: 2000 });
    assert.deepEqual((await pass(child2.db, shared.db, 2010)).failed, {});
    assert.equal(count(shared.raw, "perp_transfers"), 2);

    // y learns its UserOp — the identity x already holds — and is credited.
    child2.raw.prepare("UPDATE perp_transfers SET user_op_hash = ?, state = 'credited', updated_at = 2100 WHERE id = 'y'").run(U);
    // …and an unrelated withdrawal is written after it.
    transfer(child2.raw, { ...base, id: "z", direction: "withdraw", amount_micro: "1000000", state: "executed", venue_tx_hash: "ab".repeat(40), created_at: 2200, updated_at: 2200 });
    const r = await pass(child2.db, shared.db, 2210);

    assert.equal(r.failed.perp_transfers, undefined, "the table did not fail: its batch committed");
    assert.match(r.failed.perp_transfers_conflict ?? "", /1 transfer row\(s\) contradict the shared ledger and were not merged \(y\)/);
    assert.ok(sharedRow(shared.raw, "z"), "the later withdrawal was copied — nothing is stuck behind the conflict");
    const y = sharedRow(shared.raw, "y")!;
    assert.equal(y.state, "credited", "the child's own row still moves forward");
    assert.equal(y.user_op_hash, null, "…but takes no identity another shared row holds");
    const x = sharedRow(shared.raw, "x")!;
    assert.equal(x.state, "submitted");
    assert.equal(x.tx_hash, null, "the other row was never filled into the unique index");
    assert.equal(x.user_op_hash, U);

    // And later passes keep moving: a new transfer after the conflict arrives.
    transfer(child2.raw, { ...base, id: "w", direction: "withdraw", amount_micro: "2000000", state: "executed", venue_tx_hash: "cd".repeat(40), created_at: 3000, updated_at: 3000 });
    const later = await pass(child2.db, shared.db, 3010);
    assert.equal(later.failed.perp_transfers, undefined);
    assert.ok(sharedRow(shared.raw, "w"));
  });

  it("a transfer a rebuilt child re-derived under a NEW id advances the row already here, and learns its identity", async () => {
    const shared = perpDb();
    const child1 = perpDb();
    transfer(child1.raw, { ...base, id: "x", state: "submitted", user_op_hash: U, created_at: 1000, updated_at: 1000 });
    await pass(child1.db, shared.db, 1010);
    const child2 = perpDb();
    transfer(child2.raw, { ...base, id: "q", state: "landed", user_op_hash: U, chain_id: 4663, tx_hash: T, log_index: 7, created_at: 2000, updated_at: 2000 });
    const r = await pass(child2.db, shared.db, 2010);
    assert.deepEqual(r.failed, {});
    assert.equal(count(shared.raw, "perp_transfers"), 1, "one transfer, one row");
    const x = sharedRow(shared.raw, "x")!;
    assert.equal(x.state, "landed");
    assert.equal(x.tx_hash, T);
    assert.equal(Number(x.log_index), 7);
    assert.equal(Number(x.chain_id), 4663);
  });

  it("a holder of another amount or direction is a conflict: nothing merged, nothing inserted, later rows copied", async () => {
    const shared = perpDb();
    const child1 = perpDb();
    transfer(child1.raw, { ...base, id: "x", state: "submitted", user_op_hash: U, created_at: 1000, updated_at: 1000 });
    await pass(child1.db, shared.db, 1010);
    const child2 = perpDb();
    transfer(child2.raw, { ...base, id: "q", amount_micro: "9000000", state: "landed", user_op_hash: U, created_at: 2000, updated_at: 2000 });
    transfer(child2.raw, { ...base, id: "z", direction: "withdraw", state: "executed", venue_tx_hash: "ab".repeat(40), created_at: 2001, updated_at: 2001 });
    const r = await pass(child2.db, shared.db, 2010);
    assert.equal(r.failed.perp_transfers, undefined);
    assert.match(r.failed.perp_transfers_conflict ?? "", /\(q\)/);
    assert.equal(sharedRow(shared.raw, "q"), undefined);
    assert.equal(sharedRow(shared.raw, "x")!.state, "submitted", "a contradicting row never moves the one here");
    assert.ok(sharedRow(shared.raw, "z"));
  });

  it("any unique violation the resolution did not foresee is rolled back ALONE, under its savepoint", async () => {
    const shared = perpDb();
    // A stand-in for an index this code does not know about.
    shared.raw.exec("CREATE UNIQUE INDEX test_only_order ON perp_transfers (order_id) WHERE order_id IS NOT NULL");
    const child = perpDb();
    transfer(child.raw, { ...base, id: "a", state: "landed", order_id: "o1", created_at: 1000, updated_at: 1000 });
    transfer(child.raw, { ...base, id: "b", amount_micro: "7000000", state: "landed", created_at: 1001, updated_at: 1001 });
    await pass(child.db, shared.db, 1010);
    // b now names a's order id; the fill would collide with that index.
    child.raw.prepare("UPDATE perp_transfers SET order_id = 'o1', state = 'credited', updated_at = 1100 WHERE id = 'b'").run();
    transfer(child.raw, { ...base, id: "c", amount_micro: "3000000", state: "landed", created_at: 1101, updated_at: 1101 });
    const r = await pass(child.db, shared.db, 1110);
    assert.equal(r.failed.perp_transfers, undefined, "the batch committed");
    assert.match(r.failed.perp_transfers_conflict ?? "", /\(b\)/);
    assert.equal(sharedRow(shared.raw, "b")!.state, "landed", "b's update was rolled back alone");
    assert.ok(sharedRow(shared.raw, "c"), "the row after it was copied in the same batch");
  });

  it("anything that is NOT a unique violation still fails the table and holds the cursor", async () => {
    const shared = perpDb();
    const child = perpDb();
    shared.raw.exec("DROP TABLE perp_transfers");
    shared.raw.exec("CREATE TABLE perp_transfers (id TEXT PRIMARY KEY)");
    transfer(child.raw, { ...base, id: "a", state: "landed", created_at: 1000, updated_at: 1000 });
    const r = await pass(child.db, shared.db, 1010);
    assert.ok(r.failed.perp_transfers, "a schema mismatch is a failure, as before");
    assert.equal(shared.raw.prepare("SELECT last_id FROM mirror_state WHERE table_name = 'perp_transfers'").get(), undefined);
  });
});

describe("the keyset cursor: a burst of any size is copied, and nothing after it is skipped", () => {
  it("append-only: more rows than pages × batch sharing ONE created_at all arrive, and so does a later row", async () => {
    const shared = perpDb();
    const child = perpDb();
    for (let i = 0; i < 45; i++) {
      child.raw
        .prepare("INSERT INTO perp_funding (agent_id, mode, epoch, market_id, funding_id, funding_hour, payment_micro, created_at) VALUES (?, 'live', 1, 1, ?, ?, '-1', 5000)")
        .run(A, `f${String(i).padStart(3, "0")}`, 3600 * (i + 1));
    }
    // batch 2 → a pass reads at most 20 × 2 = 40 forward rows: the old cap.
    await pass(child.db, shared.db, 5400, 2);
    assert.equal(count(shared.raw, "perp_funding"), 40, "one pass is bounded…");
    await pass(child.db, shared.db, 5800, 2);
    assert.equal(count(shared.raw, "perp_funding"), 45, "…and the next resumes after the last row it copied");
    child.raw
      .prepare("INSERT INTO perp_funding (agent_id, mode, epoch, market_id, funding_id, funding_hour, payment_micro, created_at) VALUES (?, 'live', 1, 1, 'late', ?, '-1', 7000)")
      .run(A, 3600 * 100);
    await pass(child.db, shared.db, 7400, 2);
    assert.ok(shared.raw.prepare("SELECT 1 FROM perp_funding WHERE funding_id = 'late'").get(), "a row written after the burst is never skipped");
  });

  it("rank-guarded: a burst of legs sharing one updated_at all arrive", async () => {
    const shared = perpDb();
    const child = perpDb();
    for (let i = 0; i < 45; i++) {
      child.raw
        .prepare("INSERT INTO perp_order_legs (agent_id, mode, order_id, role, client_order_index, status, created_at, updated_at) VALUES (?, 'live', 'o', 'entry', ?, 'open', 5000, 5000)")
        .run(A, i);
    }
    await pass(child.db, shared.db, 5400, 2);
    await pass(child.db, shared.db, 5800, 2);
    assert.equal(count(shared.raw, "perp_order_legs"), 45);
  });

  it("the lookback still catches what a keyset alone would pass: a same-second update, and an older stamp committed late", async () => {
    const shared = perpDb();
    const child = perpDb();
    for (const coi of [1, 2]) {
      child.raw
        .prepare("INSERT INTO perp_order_legs (agent_id, mode, order_id, role, client_order_index, status, created_at, updated_at) VALUES (?, 'live', 'o', 'entry', ?, 'open', 5000, 5000)")
        .run(A, coi);
    }
    await pass(child.db, shared.db, 5001);
    // Leg 1 (rowid BEHIND the cursor) fills within the cursor's own second.
    child.raw.prepare("UPDATE perp_order_legs SET status = 'filled' WHERE client_order_index = 1").run();
    // A leg whose stamp was taken before a slower commit.
    child.raw
      .prepare("INSERT INTO perp_order_legs (agent_id, mode, order_id, role, client_order_index, status, created_at, updated_at) VALUES (?, 'live', 'o', 'entry', 3, 'open', 4900, 4900)")
      .run(A);
    await pass(child.db, shared.db, 5002);
    assert.equal((shared.raw.prepare("SELECT status FROM perp_order_legs WHERE client_order_index = 1").get() as { status: string }).status, "filled");
    assert.ok(shared.raw.prepare("SELECT 1 FROM perp_order_legs WHERE client_order_index = 3").get());
  });

  it("the cursor is (stamp, rowid), moves only forward, and a cursor from before the keyset resumes at its stamp with ties", async () => {
    const shared = perpDb();
    const child = perpDb();
    const fund = (id: string, at: number, hour: number) =>
      child.raw
        .prepare("INSERT INTO perp_funding (agent_id, mode, epoch, market_id, funding_id, funding_hour, payment_micro, created_at) VALUES (?, 'live', 1, 1, ?, ?, '-1', ?)")
        .run(A, id, hour, at);
    fund("a", 6000, 3600);
    fund("b", 6000, 7200);
    // A cursor written by the bare-time code: a stamp, no rowid.
    shared.raw.prepare("INSERT INTO mirror_state (tenant, table_name, last_id, updated_at) VALUES (?, 'perp_funding', 6000, 1)").run(TENANT);
    await pass(child.db, shared.db, 6010);
    assert.equal(count(shared.raw, "perp_funding"), 2, "ties at a legacy cursor's stamp are re-read, not skipped");
    const mark = shared.raw.prepare("SELECT last_id, last_stamp FROM mirror_state WHERE tenant = ? AND table_name = 'perp_funding'").get(TENANT) as { last_id: number; last_stamp: number };
    assert.deepEqual([Number(mark.last_id), Number(mark.last_stamp)], [6000, 2]);
    // A rebuilt child (rowids restarted) with only older rows never pulls it back.
    const rebuilt = perpDb();
    rebuilt.raw
      .prepare("INSERT INTO perp_funding (agent_id, mode, epoch, market_id, funding_id, funding_hour, payment_micro, created_at) VALUES (?, 'live', 1, 1, 'old', 10800, '-1', 5990)")
      .run(A);
    await pass(rebuilt.db, shared.db, 6020);
    const after = shared.raw.prepare("SELECT last_id, last_stamp FROM mirror_state WHERE tenant = ? AND table_name = 'perp_funding'").get(TENANT) as { last_id: number; last_stamp: number };
    assert.deepEqual([Number(after.last_id), Number(after.last_stamp)], [6000, 2]);
    assert.ok(shared.raw.prepare("SELECT 1 FROM perp_funding WHERE funding_id = 'old'").get(), "…and its row inside the lookback is still copied");
  });
});
