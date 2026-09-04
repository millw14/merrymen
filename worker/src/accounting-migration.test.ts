/**
 * IS THE MIGRATION SAFE AGAINST THE ROWS THAT ARE ACTUALLY THERE?
 *
 * The repair's whole idempotency guarantee rests on one partial unique index,
 * and that index is created by a DDL statement inside a try/catch that swallows
 * errors — a catch that exists for a good reason (re-running an ALTER must be a
 * no-op) and which means a FAILED index creation is indistinguishable from a
 * successful one at every later call site. So "the index is there" is not
 * something to assume. It is something to test against the data.
 *
 * WHAT IS ACTUALLY THERE. The hosted `flows` table holds 363 rows, every one of
 * them `inferred` with a NULL transaction and a NULL log index. None of them can
 * conflict with the new index, and it is worth being exact about WHY, because an
 * earlier version of this comment got it wrong in a way that would have let a
 * reviewer approve the migration for a reason that does not exist.
 *
 * They cannot conflict because NULLs are DISTINCT in a unique index on both
 * SQLite and Postgres. That is true with or without the predicate — so for these
 * 363 rows `WHERE tx_hash IS NOT NULL AND log_index IS NOT NULL` changes
 * nothing, and the earlier claim that a non-partial index would "collapse them
 * and delete the history" was false. An index does not delete rows; it either
 * builds or fails to build.
 *
 * The predicate is a statement of intent and an index-size saving, not a shield.
 * The tests below check what is actually true: that the index is created, and
 * that every legacy row survives it.
 *
 * The dangerous case is not the 363. It is a PAIR of rows naming the same log in
 * different hash cases, which the normalisation would turn into a genuine
 * duplicate and which would then make the CREATE fail — silently. That case is
 * constructed below, and what the repair does about it is the point of the last
 * test: it refuses to run.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { hasChainIdentityIndex, runRepair } from "./accounting-repair";
import type { AccountPlan } from "./accounting-reconstruction";

const PAPER = "0x00000000000000000000000000000000000000a1";
const CANARY = "0x3E34E58e1E1b52A6cbE2Bd7C6e0C1B1e1e1e1e1e";
const CHAIN = 4663;

/**
 * A database as it stands BEFORE this PR's migration: the schema up to PR 2 —
 * chain_id present and normalised on write — but without the constraint.
 *
 * Built by applying the full schema and then dropping the index, rather than by
 * restating an older DDL by hand. A hand-copied schema drifts from the real one,
 * and a migration test whose "before" state is fictional proves nothing.
 */
async function preMigration(): Promise<{ db: Db; raw: DatabaseSync }> {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  raw.exec("DROP INDEX IF EXISTS flows_chain_identity");
  raw.exec("DELETE FROM flows");
  return { db, raw };
}

async function seedAgents(db: Db) {
  for (const [acct, mode] of [
    [CANARY, "live"],
    [PAPER, "paper"],
  ] as const) {
    await db
      .prepare(
        `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode)
         VALUES (?, ?, ?, ?, '{}', 0, 0, ?)`,
      )
      .run(acct, acct, acct, CHAIN, mode);
  }
}

/** The hosted table's actual composition, at 1/10 scale but the same shapes. */
async function seedPollutedRows(db: Db): Promise<number> {
  let n = 0;
  const inferred = async (agent: string, direction: string, amount: number) => {
    await db
      .prepare(
        "INSERT INTO flows (agent_id, direction, amount_usdg, source, epoch, at) VALUES (?, ?, ?, 'inferred', 1, 0)",
      )
      .run(agent, direction, amount);
    n += 1;
  };
  // The canary's opening balance, booked once per redeploy.
  for (let i = 0; i < 3; i++) await inferred(CANARY, "in", 10);
  // A paper book reset and re-run, and its simulated fills.
  for (const a of [1000, 1000, 500, 500, 58.335, 41.67, 25.005, 8.34]) await inferred(PAPER, "out", a);
  // An epoch bridge: evidenced, but with no transaction — the row shape that
  // would be destroyed by a NON-partial index just as surely as an inferred one.
  await db
    .prepare("INSERT INTO flows (agent_id, direction, amount_usdg, source, epoch, at) VALUES (?, 'in', 9.884, 'epoch-carry', 2, 0)")
    .run(CANARY);
  n += 1;
  return n;
}

describe("the migration, against the rows that are actually there", () => {
  it("creates the index — and the test can tell, which the migration itself cannot", async () => {
    const { db } = await preMigration();
    await seedAgents(db);
    const before = await seedPollutedRows(db);
    assert.equal(await hasChainIdentityIndex(db), false, "the fixture starts without it");

    await applyLedgerSchema(db);

    assert.equal(await hasChainIdentityIndex(db), true, "the index exists after the migration");
    const after = (await db.prepare("SELECT COUNT(*) AS n FROM flows").get()) as { n: number };
    assert.equal(Number(after.n), before, "and not one legacy row was lost to it");
  });

  it("leaves every transaction-less row alone", async () => {
    // All 363 hosted rows are `inferred` with a NULL transaction, and they must
    // still be there after the migration so the repair can quarantine them
    // rather than find them already gone.
    //
    // This test was once called "…which is what makes the predicate
    // load-bearing", and it did not test that: it would pass identically against
    // a NON-partial index, because NULLs are distinct in a unique index on both
    // engines either way. The name is now what the assertions actually check.
    const { db } = await preMigration();
    await seedAgents(db);
    await seedPollutedRows(db);
    await applyLedgerSchema(db);

    const dupes = (await db
      .prepare(
        `SELECT agent_id, direction, amount_usdg, COUNT(*) AS n FROM flows
          WHERE tx_hash IS NULL GROUP BY agent_id, direction, amount_usdg HAVING COUNT(*) > 1`,
      )
      .all()) as { n: number }[];
    assert.ok(dupes.length > 0, "the repeated rows are still repeated, which is the point");
    const canary = (await db
      .prepare("SELECT COUNT(*) AS n FROM flows WHERE agent_id = ? AND source = 'inferred'")
      .get(CANARY)) as { n: number };
    assert.equal(Number(canary.n), 3, "all three phantom bookings survive to be quarantined, not deleted");
  });

  it("normalises a mixed-case hash and backfills a missing chain, in that order", async () => {
    const { db } = await preMigration();
    await seedAgents(db);
    // A row written before the identity existed: hash in the RPC's case, no chain.
    await db
      .prepare(
        `INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, at)
         VALUES (?, 'in', 10, '0xABCDEF', 100, 0, 'chain-log', 1, 0)`,
      )
      .run(CANARY);

    await applyLedgerSchema(db);

    const r = (await db.prepare("SELECT tx_hash, chain_id FROM flows WHERE source = 'chain-log'").get()) as {
      tx_hash: string;
      chain_id: number;
    };
    assert.equal(r.tx_hash, "0xabcdef", "normalised, so the two writers cannot disagree");
    assert.equal(Number(r.chain_id), CHAIN, "and the chain comes from the agent's own grant");
    assert.equal(await hasChainIdentityIndex(db), true);
  });

  it("would survive a NON-partial index too — the predicate is intent, not protection", async () => {
    // Pinning the corrected fact, because the wrong version of it was written
    // down three times and believed. If NULLs ever stop being distinct in a
    // unique index on either engine, this fails and the reasoning above has to
    // be revisited rather than quietly becoming false again.
    const { db, raw } = await preMigration();
    await seedAgents(db);
    const before = await seedPollutedRows(db);
    raw.exec("CREATE UNIQUE INDEX plain_ix ON flows (chain_id, agent_id, tx_hash, log_index)");
    const after = (await db.prepare("SELECT COUNT(*) AS n FROM flows").get()) as { n: number };
    assert.equal(Number(after.n), before, "a non-partial index collapses nothing either");
    // …and it does not constrain them, which is the honest reason the predicate
    // is not what protects these rows.
    await db
      .prepare("INSERT INTO flows (agent_id, direction, amount_usdg, source, epoch, at) VALUES (?, 'in', 10, 'inferred', 1, 0)")
      .run(CANARY);
    const grew = (await db.prepare("SELECT COUNT(*) AS n FROM flows").get()) as { n: number };
    assert.equal(Number(grew.n), before + 1, "a row with no transaction has no identity to be unique on");
  });

  it("is a no-op when re-run, which is how it survives every deploy", async () => {
    const { db } = await preMigration();
    await seedAgents(db);
    const before = await seedPollutedRows(db);
    await applyLedgerSchema(db);
    await applyLedgerSchema(db);
    await applyLedgerSchema(db);
    const after = (await db.prepare("SELECT COUNT(*) AS n FROM flows").get()) as { n: number };
    assert.equal(Number(after.n), before);
    assert.equal(await hasChainIdentityIndex(db), true);
  });

  // ── THE CASE THAT WOULD BREAK IT, AND WHAT HAPPENS THEN ──────────────────

  it("REFUSES TO MUTATE when the index could not be created", async () => {
    // Construct the one shape that defeats the migration: two rows naming the
    // SAME log in different hash cases. Before normalisation they are distinct;
    // after it they are a genuine duplicate, so the CREATE fails — and it fails
    // SILENTLY, because applyLedgerSchema swallows each DDL's error so that
    // re-running an ALTER is a no-op.
    const { db } = await preMigration();
    await seedAgents(db);
    for (const hash of ["0xDEADBEEF", "0xdeadbeef"]) {
      await db
        .prepare(
          `INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at)
           VALUES (?, 'in', 10, ?, 100, 0, 'chain-log', 1, ?, 0)`,
        )
        .run(CANARY, hash, CHAIN);
    }

    await applyLedgerSchema(db);
    assert.equal(await hasChainIdentityIndex(db), false, "the CREATE failed, and nothing said so");

    // THIS is why the tool asks instead of assuming. Without the constraint,
    // `ON CONFLICT DO NOTHING` degrades to a plain INSERT and the repair becomes
    // the duplication it exists to undo.
    const plan: AccountPlan = {
      smartAccount: CANARY,
      ownerAddress: null,
      tenant: "0xa233a3",
      mode: "live",
      isPaper: false,
      epoch: 1,
      onchainCashUsdg: null,
      navUsdg: null,
      chainGrossInUsdg: 10,
      chainGrossOutUsdg: 0,
      chainNetUsdg: 10,
      chainTradeLegs: 4,
      chainAmbiguous: 0,
      chainComplete: true,
      existingInferredRows: 0,
      existingInferredUsdg: 0,
      existingTotalUsdg: 20,
      insert: [
        {
          agentId: CANARY,
          epoch: 1,
          direction: "in",
          amountUsdg: 10,
          amountRaw: "10000000",
          source: "chain-log",
          txHash: "0xfeed",
          blockNumber: 1,
          logIndex: 0,
        },
      ],
      quarantine: [],
      contributionsKnownBefore: false,
      contributionsAfterUsdg: 10,
      contributionsKnownAfter: true,
      pnlPublishableAfter: true,
      blocked: null,
    };

    const results = await runRepair(
      db,
      [plan],
      { mode: "commit", runId: "r", resume: false, account: CANARY },
      CHAIN,
    );
    assert.equal(results[0]!.stage, "failed");
    assert.match(results[0]!.why, /flows_chain_identity unique index is not present/);
    const n = (await db.prepare("SELECT COUNT(*) AS n FROM flows").get()) as { n: number };
    assert.equal(Number(n.n), 2, "and nothing was written");
  });

  it("still allows a DRY RUN without the index, because a dry run writes nothing", async () => {
    const { db } = await preMigration();
    await seedAgents(db);
    const results = await runRepair(db, [], { mode: "dry-run", runId: "r", resume: false }, CHAIN);
    assert.deepEqual(results, []);
  });
});
