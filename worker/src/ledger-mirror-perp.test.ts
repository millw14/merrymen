/**
 * THE PERP MIRROR (docs/perps.md, "Ledger" → "Hosted"): it cannot stall, it
 * copies only the worker's own account, and it is not there at all for a
 * child that holds no perp row.
 *
 * Each block is driven through the real mirror over real sqlite ledgers:
 *
 *   transfers   a child transfer whose identities point at TWO shared rows
 *               used to COALESCE-fill one of them into a partial unique
 *               index; the error rolled back the whole batch, the cursor
 *               never moved, and every later transfer of the tenant was never
 *               copied (the perps branch's review:
 *               mirror-transfer-update-unique-stall). Now one target is
 *               resolved, only free identities are filled, and a
 *               contradiction is a counted conflict the batch commits past —
 *               informational, never `failed` (see mirrorPerpLedger).
 *   keyset      a bare-time cursor that reopened 300 s behind the newest stamp
 *               read re-read the same first PERP_MAX_PAGES × batch rows for
 *               ever once more than that many shared one span
 *               (mirror-perp-page-cap-permanent-skip). Now a (stamp, rowid)
 *               keyset moves every pass that finds rows — and a pass that
 *               filled its last page says hasMore, which every completeness
 *               check reads.
 *   same second a position the child closed — written flat in place — in the
 *               same second a pass had copied it open was never copied: the
 *               copy took only a strictly newer row, and the flatten skips a
 *               market the child still holds, so the shared book showed the
 *               position open until that market next traded (the slice 4
 *               review: snapshot-same-second-close-lost). Now a tie goes to
 *               the child whenever it says something different.
 *   own account a row under another account is counted and never copied; with
 *               no account to name, nothing is.
 *   inert       a Spot child — every perp table, none holding a row — asks
 *               the shared database nothing about perps, and a shared perp
 *               fault cannot fail its pass.
 *   two wallets a login's Spot and Perps workers mirror side by side under
 *               their own keys: no cursor shared, and the Perps worker's owner
 *               operation attributed through perps_grants.
 *
 * The transfer fixtures carry chain identities because that is the only way a
 * contradiction can arise; the mirror is blind to `mode`, and a hosted Perps
 * book in this build is paper, whose transfers carry none.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import { MIRROR_STATE_DDL, mirrorCountsLine, mirrorPerpLedger, mirrorTenant, tenantGrantAccount } from "./ledger-mirror";
import { applyLedgerSchema, PERP_LEDGER_DDL } from "./store";
import { workerKey } from "./worker-key";

function perpDb(): { db: Db; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  for (const ddl of PERP_LEDGER_DDL) raw.exec(ddl);
  raw.exec(MIRROR_STATE_DDL);
  return { db: wrapSqlite(raw), raw };
}

/** A whole ledger, as a child or the shared database has one (applyLedgerSchema). */
async function ledger(): Promise<{ db: Db; raw: DatabaseSync }> {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  raw.exec(MIRROR_STATE_DDL);
  return { db, raw };
}

/** A statement that names a shared perp table (or the Perps grants), as opposed to a perp_* column elsewhere. */
const PERP_TABLE_SQL = /\bperp_(orders|order_legs|fills|funding|transfers|positions|accounts|carries)\b|\bperps_grants\b/;

const OWNER = "0x00000000000000000000000000000000000000a1";
const A = "0xabcabcabcabcabcabcabcabcabcabcabcabcabca";
const OTHER = "0xdefdefdefdefdefdefdefdefdefdefdefdefdefd";
const U = `0x${"11".repeat(32)}`;
const T = `0x${"22".repeat(32)}`;
const TENANT = workerKey(OWNER, "perps");

/** One pass, under the account the caller names — or, with "by-grant", none named, so the grant alone decides. */
async function pass(child: Db, shared: Db, nowSec: number, batch = 500, account: string | null | "by-grant" = A) {
  const copied: Record<string, number> = {};
  const failed: Record<string, string> = {};
  const r = await mirrorPerpLedger({ child, shared, tenant: TENANT, nowSec, batch, copied, failed, account: account === "by-grant" ? undefined : account });
  return { copied, failed, hasMore: r.hasMore };
}

function transfer(raw: DatabaseSync, row: Record<string, string | number | null>) {
  const cols = Object.keys(row);
  raw.prepare(`INSERT INTO perp_transfers (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(row) as never[]));
}
const base = { agent_id: A, mode: "live", epoch: 1, direction: "deposit", amount_micro: "5000000", initiator: "agent" };
const sharedRow = (raw: DatabaseSync, id: string) => raw.prepare("SELECT * FROM perp_transfers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
const count = (raw: DatabaseSync, table: string) => Number((raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
const fundingRow = (raw: DatabaseSync, agent: string, id: string, hour: number, at: number) =>
  raw
    .prepare("INSERT INTO perp_funding (agent_id, mode, epoch, market_id, funding_id, funding_hour, payment_micro, created_at) VALUES (?, 'paper', 1, 1, ?, ?, '-1', ?)")
    .run(agent, id, hour, at);

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

    assert.deepEqual(r.failed, {}, "the table did not fail, and the contradiction is not a failure: nothing is left a later pass could copy");
    assert.equal(r.copied.perp_transfers_conflict, 1, "…but it is counted, beside the copies");
    assert.match(mirrorCountsLine(TENANT, r) ?? "", /not copied 1 \(perp_transfers conflict 1\)/, "and printed as not copied, never as an arrival");
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
    assert.equal(r.copied.perp_transfers_conflict, undefined);
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
    assert.deepEqual(r.failed, {});
    assert.equal(r.copied.perp_transfers_conflict, 1);
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
    assert.deepEqual(r.failed, {}, "the batch committed");
    assert.equal(r.copied.perp_transfers_conflict, 1);
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
    for (let i = 0; i < 45; i++) fundingRow(child.raw, A, `f${String(i).padStart(3, "0")}`, 3600 * (i + 1), 5000);
    // batch 2 → a pass reads at most 20 × 2 = 40 forward rows: the old cap.
    const first = await pass(child.db, shared.db, 5400, 2);
    assert.equal(count(shared.raw, "perp_funding"), 40, "one pass is bounded…");
    assert.equal(first.hasMore, true, "…and says so, so no completeness check takes it for a finished copy");
    const second = await pass(child.db, shared.db, 5800, 2);
    assert.equal(count(shared.raw, "perp_funding"), 45, "…and the next resumes after the last row it copied");
    assert.equal(second.hasMore, false, "and the tape is now whole");
    fundingRow(child.raw, A, "late", 3600 * 100, 7000);
    await pass(child.db, shared.db, 7400, 2);
    assert.ok(shared.raw.prepare("SELECT 1 FROM perp_funding WHERE funding_id = 'late'").get(), "a row written after the burst is never skipped");
  });

  it("a burst larger than PERP_MAX_PAGES × batch reaches mirrorTenant's hasMore, and drains to a whole copy", async () => {
    const shared = await ledger();
    const child = await ledger();
    // MIRROR_BATCH-sized pages would need 10,001 rows; a batch of 5 needs 101.
    for (let i = 0; i < 101; i++) fundingRow(child.raw, A, `b${String(i).padStart(4, "0")}`, 3600 * (i + 1), 6000 + i);
    const r = await mirrorTenant({ tenant: TENANT, child: child.db, shared: shared.db, batch: 5, nowSec: 7000, account: A });
    assert.equal(r.failed, undefined, JSON.stringify(r.failed));
    assert.equal(r.copied.perp_funding, 100);
    assert.equal(r.hasMore, true, "the drain, the anchor's final pass and the fleet checkpoint all read this");
    let passes = 1;
    for (let more: boolean = r.hasMore === true; more; passes++) more = (await mirrorTenant({ tenant: TENANT, child: child.db, shared: shared.db, batch: 5, nowSec: 7000, account: A })).hasMore === true;
    assert.equal(count(shared.raw, "perp_funding"), 101);
    assert.equal(passes, 2, "one more pass, and no more: the lookback never claims there is more");
  });

  it("rank-guarded: a burst of legs sharing one updated_at all arrive", async () => {
    const shared = perpDb();
    const child = perpDb();
    for (let i = 0; i < 45; i++) {
      child.raw
        .prepare("INSERT INTO perp_order_legs (agent_id, mode, order_id, role, client_order_index, status, created_at, updated_at) VALUES (?, 'paper', 'o', 'entry', ?, 'open', 5000, 5000)")
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
        .prepare("INSERT INTO perp_order_legs (agent_id, mode, order_id, role, client_order_index, status, created_at, updated_at) VALUES (?, 'paper', 'o', 'entry', ?, 'open', 5000, 5000)")
        .run(A, coi);
    }
    await pass(child.db, shared.db, 5001);
    // Leg 1 (rowid BEHIND the cursor) fills within the cursor's own second.
    child.raw.prepare("UPDATE perp_order_legs SET status = 'filled' WHERE client_order_index = 1").run();
    // A leg whose stamp was taken before a slower commit.
    child.raw
      .prepare("INSERT INTO perp_order_legs (agent_id, mode, order_id, role, client_order_index, status, created_at, updated_at) VALUES (?, 'paper', 'o', 'entry', 3, 'open', 4900, 4900)")
      .run(A);
    await pass(child.db, shared.db, 5002);
    assert.equal((shared.raw.prepare("SELECT status FROM perp_order_legs WHERE client_order_index = 1").get() as { status: string }).status, "filled");
    assert.ok(shared.raw.prepare("SELECT 1 FROM perp_order_legs WHERE client_order_index = 3").get());
  });

  it("the cursor is (stamp, rowid), moves only forward, and a cursor from before the keyset resumes at its stamp with ties", async () => {
    const shared = perpDb();
    const child = perpDb();
    fundingRow(child.raw, A, "a", 3600, 6000);
    fundingRow(child.raw, A, "b", 7200, 6000);
    // A cursor written by bare-time code: a stamp, no rowid.
    shared.raw.prepare("INSERT INTO mirror_state (tenant, table_name, last_id, updated_at) VALUES (?, 'perp_funding', 6000, 1)").run(TENANT);
    await pass(child.db, shared.db, 6010);
    assert.equal(count(shared.raw, "perp_funding"), 2, "ties at a legacy cursor's stamp are re-read, not skipped");
    const mark = shared.raw.prepare("SELECT last_id, last_stamp FROM mirror_state WHERE tenant = ? AND table_name = 'perp_funding'").get(TENANT) as { last_id: number; last_stamp: number };
    assert.deepEqual([Number(mark.last_id), Number(mark.last_stamp)], [6000, 2]);
    // A rebuilt child (rowids restarted) with only older rows never pulls it back.
    const rebuilt = perpDb();
    fundingRow(rebuilt.raw, A, "old", 10800, 5990);
    await pass(rebuilt.db, shared.db, 6020);
    const after = shared.raw.prepare("SELECT last_id, last_stamp FROM mirror_state WHERE tenant = ? AND table_name = 'perp_funding'").get(TENANT) as { last_id: number; last_stamp: number };
    assert.deepEqual([Number(after.last_id), Number(after.last_stamp)], [6000, 2]);
    assert.ok(shared.raw.prepare("SELECT 1 FROM perp_funding WHERE funding_id = 'old'").get(), "…and its row inside the lookback is still copied");
  });
});

describe("the snapshots: a second write in the second a pass copied the first", () => {
  const position = (raw: DatabaseSync) =>
    ({ ...(raw.prepare("SELECT side, base, allocated_margin_micro, stop_trigger, recorded_stop_trigger, updated_at FROM perp_positions WHERE agent_id = ?").get(A) as Record<string, unknown>) });

  it("a position closed in the same second it was copied open goes flat here — and a tie that says nothing new is not rewritten", async () => {
    const shared = perpDb();
    const child = perpDb();
    child.raw.prepare("INSERT INTO perp_accounts (agent_id, mode, paper_collateral_micro, updated_at) VALUES (?, 'paper', '0', 100)").run(A);
    // The hour's funding booked on the open position (executor.ts), at 200…
    child.raw.prepare(`INSERT INTO perp_positions (agent_id, mode, market_id, side, base, entry_price, allocated_margin_micro, imf_bp, margin_mode,
       stop_trigger, stop_price, recorded_stop_trigger, recorded_stop_price, funding_hour_applied, opened_at, updated_at, source)
       VALUES (?, 'paper', 1, 'long', '100', '5000', '1000000', 500, 'isolated', '4900', '4890', '4900', '4890', 3600, 100, 200, 'paper')`).run(A);
    // …which a pass reads, from its own process, before the executor's next commit.
    assert.equal((await pass(child.db, shared.db, 200)).copied.perp_positions, 1);
    // Still in second 200, the same executor pass fires the stop: the row is
    // written flat IN PLACE, as setPerpPositions writes it — the child still
    // holds a row for the market, so the flatten-on-evidence never looks at it.
    child.raw.prepare(`UPDATE perp_positions SET side = NULL, base = '0', allocated_margin_micro = '0', entry_price = NULL, stop_trigger = NULL,
       stop_price = NULL, recorded_stop_trigger = NULL, recorded_stop_price = NULL, opened_at = NULL, updated_at = 200 WHERE agent_id = ?`).run(A);
    const closed = await pass(child.db, shared.db, 215);
    assert.deepEqual(closed.failed, {});
    assert.equal(closed.copied.perp_positions, 1, "the close arrives on the very next pass");
    assert.deepEqual(position(shared.raw), { side: null, base: "0", allocated_margin_micro: "0", stop_trigger: null, recorded_stop_trigger: null, updated_at: 200 },
      "flat, recorded stop and all — not the open position, indefinitely");
    // A flat row is not written again until the market trades: every later
    // pass meets the same tie, and it must say nothing.
    for (const now of [230, 3600]) assert.equal((await pass(child.db, shared.db, now)).copied.perp_positions, undefined, `${now}: an unchanged row is not rewritten`);
    // The tie goes to the child, and only the tie: an OLDER child row that
    // differs is still not a newer word about the position.
    child.raw.prepare("UPDATE perp_positions SET side = 'short', base = '5', updated_at = 199 WHERE agent_id = ?").run(A);
    assert.equal((await pass(child.db, shared.db, 3610)).copied.perp_positions, undefined);
    assert.equal(position(shared.raw).base, "0");
  });

  it("an account row rewritten in the same second it was copied: the shared row learns the second write", async () => {
    const shared = perpDb();
    const child = perpDb();
    child.raw.prepare("INSERT INTO perp_accounts (agent_id, mode, paper_collateral_micro, nonce_high_water, updated_at) VALUES (?, 'paper', '7000000', '5', 300)").run(A);
    assert.equal((await pass(child.db, shared.db, 300)).copied.perp_accounts, 1);
    // A close's credit (and an entries halt, should a writer ever set one) in second 300.
    child.raw.prepare(`UPDATE perp_accounts SET paper_collateral_micro = '9000000', entries_halted = 1, incident_json = '{"kind":"owner-pause","at":300,"detail":{"x":1}}', updated_at = 300 WHERE agent_id = ?`).run(A);
    assert.equal((await pass(child.db, shared.db, 315)).copied.perp_accounts, 1);
    const row = shared.raw.prepare("SELECT paper_collateral_micro, entries_halted, incident_json, nonce_high_water FROM perp_accounts WHERE agent_id = ?").get(A) as Record<string, unknown>;
    assert.deepEqual({ ...row, incident_json: JSON.parse(String(row.incident_json)) },
      { paper_collateral_micro: "9000000", entries_halted: 1, incident_json: { kind: "owner-pause", at: 300 }, nonce_high_water: "5" }, "kind and time only, as ever");
    for (const now of [330, 900]) assert.equal((await pass(child.db, shared.db, now)).copied.perp_accounts, undefined, `${now}: an unchanged row is not rewritten`);
    // And an older one still loses.
    child.raw.prepare("UPDATE perp_accounts SET paper_collateral_micro = '1', updated_at = 299 WHERE agent_id = ?").run(A);
    await pass(child.db, shared.db, 910);
    assert.equal((shared.raw.prepare("SELECT paper_collateral_micro FROM perp_accounts WHERE agent_id = ?").get(A) as { paper_collateral_micro: string }).paper_collateral_micro, "9000000");
  });
});

describe("only the worker's own account is copied", () => {
  it("a row under another agent_id is counted and never copied — keyset or snapshot — and the cursor passes it", async () => {
    const shared = perpDb();
    const child = perpDb();
    fundingRow(child.raw, A, "own", 3600, 1000);
    fundingRow(child.raw, OTHER, "theirs", 3600, 1001);
    // A shared row of the OTHER account's, which a foreign child row could otherwise flatten.
    shared.raw.prepare("INSERT INTO perp_positions (agent_id, mode, market_id, side, base, allocated_margin_micro, updated_at, source) VALUES (?, 'paper', 1, 'long', '9', '1', 10, 'paper')").run(OTHER);
    child.raw.prepare("INSERT INTO perp_accounts (agent_id, mode, paper_collateral_micro, updated_at) VALUES (?, 'paper', '0', 2000)").run(OTHER);
    child.raw.prepare("INSERT INTO perp_positions (agent_id, mode, market_id, side, base, allocated_margin_micro, updated_at, source) VALUES (?, 'paper', 2, 'short', '3', '1', 2000, 'paper')").run(OTHER);
    const r = await pass(child.db, shared.db, 2010);
    assert.deepEqual(r.failed, {});
    assert.equal(r.copied.perp_funding, 1);
    assert.equal(r.copied.perp_funding_foreign, 1);
    assert.equal(r.copied.perp_accounts_foreign, 1);
    assert.equal(r.copied.perp_positions_foreign, 1);
    assert.match(mirrorCountsLine(TENANT, r) ?? "", /\+1 rows \(perp_funding 1\) · not copied 3/, "never among the arrivals");
    assert.equal(count(shared.raw, "perp_funding"), 1);
    assert.equal(shared.raw.prepare("SELECT 1 FROM perp_funding WHERE agent_id = ?").get(OTHER), undefined);
    assert.equal(shared.raw.prepare("SELECT 1 FROM perp_accounts WHERE agent_id = ?").get(OTHER), undefined);
    assert.equal((shared.raw.prepare("SELECT base FROM perp_positions WHERE agent_id = ? AND market_id = 1").get(OTHER) as { base: string }).base, "9", "another account's book is never flattened from here");
    assert.equal(shared.raw.prepare("SELECT 1 FROM perp_positions WHERE agent_id = ? AND market_id = 2").get(OTHER), undefined);
    const mark = shared.raw.prepare("SELECT last_id, last_stamp FROM mirror_state WHERE tenant = ? AND table_name = 'perp_funding'").get(TENANT) as { last_id: number; last_stamp: number };
    assert.deepEqual([Number(mark.last_id), Number(mark.last_stamp)], [1001, 2], "the foreign row is settled: the cursor passed it");
    // Counted on the pass that passes it, not on every lookback re-read after.
    const again = await pass(child.db, shared.db, 2020);
    assert.equal(again.copied.perp_funding_foreign, undefined);
  });

  it("with no account to name, nothing is copied, no cursor moves, and the pass says it is not a finished copy", async () => {
    const shared = perpDb();
    const child = perpDb();
    fundingRow(child.raw, A, "own", 3600, 1000);
    const r = await pass(child.db, shared.db, 1010, 500, "by-grant");
    assert.match(r.failed.perp ?? "", /no account to be copied under/);
    assert.deepEqual(Object.keys(r.copied), []);
    assert.match((await pass(child.db, shared.db, 1010, 500, null)).failed.perp ?? "", /no account/, "a caller's null is no account either");
    assert.equal(count(shared.raw, "perp_funding"), 0);
    assert.equal(count(shared.raw, "mirror_state"), 0);
    // A caller's account that disagrees with the grant is no account either.
    shared.raw.exec("CREATE TABLE perps_grants (tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    shared.raw.prepare("INSERT INTO perps_grants VALUES (?, ?, 1)").run(OWNER, JSON.stringify({ smartAccount: A }));
    assert.match((await pass(child.db, shared.db, 1010, 500, OTHER)).failed.perp ?? "", /no account/);
    assert.equal(count(shared.raw, "perp_funding"), 0);
    // The grant alone names it.
    assert.deepEqual((await pass(child.db, shared.db, 1010, 500, "by-grant")).failed, {});
    assert.equal(count(shared.raw, "perp_funding"), 1);
  });
});

describe("tenantGrantAccount: a Perps worker's key names its own wallet's grant", () => {
  it("reads perps_grants for the owner of a ':perps' key, grants for anything else, and a missing table is no account", async () => {
    const shared = perpDb();
    const spot = workerKey(OWNER, "spot");
    assert.equal(await tenantGrantAccount(shared.db, TENANT), null, "perps_grants is made lazily: absent is no account, not a throw");
    shared.raw.exec("CREATE TABLE grants (tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    shared.raw.exec("CREATE TABLE perps_grants (tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
    shared.raw.prepare("INSERT INTO grants VALUES (?, ?, 1)").run(OWNER, JSON.stringify({ smartAccount: OTHER }));
    assert.equal(await tenantGrantAccount(shared.db, spot), OTHER);
    assert.equal(await tenantGrantAccount(shared.db, TENANT), null, "never the Spot wallet's account");
    shared.raw.prepare("INSERT INTO perps_grants VALUES (?, ?, 1)").run(OWNER, JSON.stringify({ smartAccount: A.toUpperCase().replace("0X", "0x") }));
    assert.equal(await tenantGrantAccount(shared.db, TENANT), A);
    assert.equal(await tenantGrantAccount(shared.db, `${OWNER}:PERPS`), null, "only the exact key shape is a Perps key");
    assert.equal(await tenantGrantAccount(shared.db, spot), OTHER, "and the Spot key is unchanged");
  });
});

describe("a Spot child is untouched by the perp mirror", () => {
  /** Every statement a Db is asked to run, its own and its transactions'. */
  function recording(db: Db, seen: string[]): Db {
    return {
      prepare(sql) {
        seen.push(sql);
        return db.prepare(sql);
      },
      exec(sql) {
        seen.push(sql);
        return db.exec(sql);
      },
      tx(fn) {
        return db.tx((inner) => fn(recording(inner, seen)));
      },
    };
  }

  it("with every perp table and no perp row, no shared perp table is read or written, and nothing perp is reported", async () => {
    const child = new DatabaseSync(":memory:");
    const sharedRaw = new DatabaseSync(":memory:");
    try {
      await applyLedgerSchema(wrapSqlite(child));
      await applyLedgerSchema(wrapSqlite(sharedRaw));
      sharedRaw.exec(MIRROR_STATE_DDL);
      const account = "0x00000000000000000000000000000000000000c7";
      child.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, 'o', 's', 4663, '{}', 0, 0)").run(account);
      child.prepare("INSERT INTO events (agent_id, message, created_at) VALUES (?, 'spot only', 1000)").run(account);
      const seen: string[] = [];
      const r = await mirrorTenant({ tenant: OWNER, child: wrapSqlite(child), shared: recording(wrapSqlite(sharedRaw), seen) });
      assert.equal(r.failed, undefined, JSON.stringify(r.failed));
      assert.equal(r.copied.events, 1, "the pass ran");
      assert.deepEqual(Object.keys(r.copied).filter((k) => /perp/.test(k)), [], "no perp key in copied");
      assert.ok(seen.length > 0, "the recorder saw the pass");
      assert.deepEqual(seen.filter((s) => PERP_TABLE_SQL.test(s)), [], "not one shared statement names a perp table");
      assert.equal(r.hasMore, undefined);
    } finally {
      child.close();
      sharedRaw.close();
    }
  });

  it("a shared perp fault cannot fail a Spot pass: the shared perp tables gone, the pass is exactly as before", async () => {
    const child = new DatabaseSync(":memory:");
    const sharedRaw = new DatabaseSync(":memory:");
    try {
      await applyLedgerSchema(wrapSqlite(child));
      await applyLedgerSchema(wrapSqlite(sharedRaw));
      sharedRaw.exec(MIRROR_STATE_DDL);
      for (const t of ["perp_orders", "perp_order_legs", "perp_fills", "perp_funding", "perp_transfers", "perp_positions", "perp_accounts", "perp_carries"]) {
        sharedRaw.exec(`DROP TABLE ${t}`);
      }
      const account = "0x00000000000000000000000000000000000000c8";
      child.prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at) VALUES (?, 'o', 's', 4663, '{}', 0, 0)").run(account);
      const r = await mirrorTenant({ tenant: OWNER, child: wrapSqlite(child), shared: wrapSqlite(sharedRaw) });
      assert.equal(r.failed, undefined, JSON.stringify(r.failed));
    } finally {
      child.close();
      sharedRaw.close();
    }
  });
});

describe("one login, two workers: Spot and Perps mirror side by side", () => {
  it("separate cursors for one owner's two ledgers, and the Perps worker's owner operation attributed through perps_grants", async () => {
    const sharedRaw = new DatabaseSync(":memory:");
    const spotRaw = new DatabaseSync(":memory:");
    const perpsRaw = new DatabaseSync(":memory:");
    try {
      const shared = wrapSqlite(sharedRaw);
      await applyLedgerSchema(shared);
      sharedRaw.exec(MIRROR_STATE_DDL);
      await applyLedgerSchema(wrapSqlite(spotRaw));
      await applyLedgerSchema(wrapSqlite(perpsRaw));
      const spotAccount = "0x00000000000000000000000000000000000005b0";
      const perpsAccount = "0x00000000000000000000000000000000000005b1";
      sharedRaw.exec("CREATE TABLE grants (tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
      sharedRaw.exec("CREATE TABLE perps_grants (tenant TEXT PRIMARY KEY, grant_json TEXT NOT NULL, updated_at INTEGER NOT NULL)");
      sharedRaw.prepare("INSERT INTO grants VALUES (?, ?, 1)").run(OWNER, JSON.stringify({ smartAccount: spotAccount }));
      sharedRaw.prepare("INSERT INTO perps_grants VALUES (?, ?, 1)").run(OWNER, JSON.stringify({ smartAccount: perpsAccount }));
      // Both children start their id spaces at 1: the collision a shared tenant key would be.
      spotRaw.prepare("INSERT INTO events (agent_id, message, created_at) VALUES (?, 'spot event', 1000)").run(spotAccount);
      perpsRaw.prepare("INSERT INTO events (agent_id, message, created_at) VALUES (?, 'perps event', 1001)").run(perpsAccount);
      perpsRaw.prepare("INSERT INTO events (agent_id, message, created_at) VALUES (?, 'perps event 2', 1002)").run(perpsAccount);
      fundingRow(perpsRaw, perpsAccount, "paper:funding:1:3600", 3600, 1003);
      const op = `0x${"0e".repeat(32)}`;
      perpsRaw.prepare(`INSERT INTO owner_operations (agent_id, chain_id, user_op_hash, tx_hash, block_number, block_time, log_index, nonce, validator, disposition, review_reason,
          usdg_legs_json, covers_logs_json, token_moves_json, paymaster, gas_wei, source, recorded_epoch, created_at)
        VALUES (?, 4663, ?, ?, 10, 1000, 3, '0x0', 'root', 'acknowledged', NULL, '[]', '[]', '[]', ?, '1', 'arm-reconcile', 1, 1060)`)
        .run(perpsAccount, op, `0x${"1e".repeat(32)}`, "0x0000000000000000000000000000000000000000");

      const spotKey = workerKey(OWNER, "spot");
      const spot = await mirrorTenant({ tenant: spotKey, child: wrapSqlite(spotRaw), shared });
      const perps = await mirrorTenant({ tenant: TENANT, child: wrapSqlite(perpsRaw), shared });
      assert.equal(spot.failed, undefined, JSON.stringify(spot.failed));
      assert.equal(perps.failed, undefined, JSON.stringify(perps.failed));
      assert.equal(spot.copied.events, 1);
      assert.equal(perps.copied.events, 2, "the Perps ledger's event id 1 is not taken for the Spot ledger's");
      assert.equal(perps.copied.owner_operations, 1, "attributed to the Perps wallet's grant, never unattributed");
      assert.equal(perps.copied.perp_funding, 1);
      const marks = (tenant: string) =>
        Object.fromEntries((sharedRaw.prepare("SELECT table_name, last_id FROM mirror_state WHERE tenant = ? ORDER BY table_name").all(tenant) as { table_name: string; last_id: number }[])
          .map((m) => [m.table_name, Number(m.last_id)]));
      assert.equal(marks(spotKey).events, 1);
      assert.equal(marks(TENANT).events, 2);
      assert.equal(marks(TENANT).perp_funding, 1003);
      assert.equal(marks(spotKey).perp_funding, undefined, "the Spot worker keeps no perp cursor");
      const opRow = sharedRaw.prepare("SELECT tenant, agent_id FROM owner_operations").get() as { tenant: string; agent_id: string };
      assert.deepEqual({ ...opRow }, { tenant: TENANT, agent_id: perpsAccount });
      // A second round copies nothing new for either, and neither rewinds.
      const again = [await mirrorTenant({ tenant: spotKey, child: wrapSqlite(spotRaw), shared }), await mirrorTenant({ tenant: TENANT, child: wrapSqlite(perpsRaw), shared })];
      for (const r of again) {
        assert.equal(r.failed, undefined);
        assert.equal(r.restarted, undefined);
        assert.equal(r.copied.events, 0);
      }
      assert.equal(Number((sharedRaw.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n), 3);
    } finally {
      sharedRaw.close();
      spotRaw.close();
      perpsRaw.close();
    }
  });
});
