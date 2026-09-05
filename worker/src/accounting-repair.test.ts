/**
 * IDEMPOTENCY, PROVED AGAINST A REAL DATABASE.
 *
 * The claim being tested is not "the code checks for duplicates" — it is that
 * running the repair twice cannot double an owner's recorded capital, including
 * when the first run died halfway through. An application-side check cannot make
 * that claim (two passes racing, or a second process, slip straight past it), so
 * the guarantee lives in a UNIQUE INDEX and these tests exercise the index by
 * running the real SQL against a real engine rather than a mock.
 *
 * The five cases are the five ways a re-import actually happens:
 *   1. the same transfer imported twice
 *   2. one transaction carrying several relevant logs
 *   3. one transaction touching two different smart accounts
 *   4. a restart midway through a fleet repair
 *   5. a re-run after partial success
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { wrapSqlite, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { repairAccount, runRepair, parseRepairOptions, type RepairOptions } from "./accounting-repair";
import type { AccountPlan, ProposedFlowRow } from "./accounting-reconstruction";

const CHAIN = 4663;
const A = "0x3E34E58e1E1b52A6cbE2Bd7C6e0C1B1e1e1e1e1e";
const B = "0x9999999999999999999999999999999999999999";
const TX = "0xc4e130d3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TX2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function freshDb(): Promise<Db> {
  const db = wrapSqlite(new DatabaseSync(":memory:"));
  await applyLedgerSchema(db);
  return db;
}

async function seedAgent(db: Db, account: string) {
  await db
    .prepare(
      `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at)
       VALUES (?, ?, ?, ?, '{}', 0, 0)`,
    )
    .run(account, account, account, CHAIN);
}

/** A legacy inferred row, exactly as the hosted ledger holds them: no tx, no log. */
async function seedInferred(db: Db, account: string, direction: string, amount: number): Promise<number> {
  await db
    .prepare("INSERT INTO flows (agent_id, direction, amount_usdg, source, epoch, at) VALUES (?, ?, ?, 'inferred', 1, 0)")
    .run(account, direction, amount);
  const row = (await db.prepare("SELECT MAX(id) AS id FROM flows").get()) as { id: number };
  return Number(row.id);
}

const row = (over: Partial<ProposedFlowRow> & { txHash: string; logIndex: number }): ProposedFlowRow => ({
  agentId: A,
  epoch: 1,
  direction: "in",
  amountUsdg: 10,
  amountRaw: "10000000",
  source: "chain-log",
  blockNumber: 100,
  ...over,
});

const plan = (over: Partial<AccountPlan> & { smartAccount: string }): AccountPlan => ({
  ownerAddress: null,
  tenant: null,
  mode: "live",
  isPaper: false,
  epoch: 1,
  onchainCashUsdg: 3.334,
  navUsdg: 3.334,
  chainGrossInUsdg: 10,
  chainGrossOutUsdg: 0,
  chainNetUsdg: 10,
  chainTradeLegs: 4,
  chainAmbiguous: 0,
  chainComplete: true,
  existingInferredRows: 0,
  existingInferredUsdg: 0,
  existingTotalUsdg: 0,
  contributionsKnownBefore: false,
  insert: [],
  quarantine: [],
  contributionsAfterUsdg: 10,
  contributionsKnownAfter: true,
  pnlPublishableAfter: true,
  blocked: null,
  ...over,
});

const COMMIT: RepairOptions = { mode: "commit", runId: "test-run", resume: false, accounts: [] };

const countFlows = async (db: Db, account: string) =>
  Number(((await db.prepare("SELECT COUNT(*) AS n FROM flows WHERE agent_id = ?").get(account)) as { n: number }).n);

const netOf = async (db: Db, account: string) =>
  Number(
    (
      (await db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net
             FROM flows WHERE agent_id = ?`,
        )
        .get(account)) as { net: number }
    ).net,
  );

// ── 1. THE SAME TRANSFER IMPORTED TWICE ────────────────────────────────────

test("the same transfer imported twice leaves one row and one contribution", async () => {
  const db = await freshDb();
  await seedAgent(db, A);
  const p = plan({ smartAccount: A, insert: [row({ txHash: TX, logIndex: 5 })] });

  const first = await repairAccount(db, p, COMMIT, CHAIN);
  assert.equal(first.stage, "recomputed");
  assert.equal(first.inserted, 1);
  assert.equal(await netOf(db, A), 10);

  // The SECOND run is the whole test: a full repeat, not a resume.
  const second = await repairAccount(db, p, { ...COMMIT, runId: "test-run-2" }, CHAIN);
  assert.equal(second.stage, "recomputed");
  assert.equal(second.inserted, 0, "the index refused the duplicate rather than the code noticing it");
  assert.equal(await countFlows(db, A), 1);
  assert.equal(await netOf(db, A), 10, "10 USDG deposited once is still 10 USDG");
});

test("the uniqueness guarantee is the DATABASE's, not the tool's", async () => {
  // Bypass the repair entirely and insert the same log twice by hand. If this
  // does not throw, every guarantee above rests on the tool remembering to check
  // — which is exactly what the requirement rules out.
  const db = await freshDb();
  await seedAgent(db, A);
  const sql = `INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id)
               VALUES (?, 'in', 10, ?, 100, 5, 'chain-log', 1, ?)`;
  await db.prepare(sql).run(A, TX, CHAIN);
  await assert.rejects(() => db.prepare(sql).run(A, TX, CHAIN), /UNIQUE|constraint/i);
});

test("the partial predicate leaves legacy rows with no transaction alone", async () => {
  // The index must NOT collapse the inferred history: those rows all carry a
  // NULL tx_hash, and a plain unique index over the same columns would treat
  // every one of them as the same row and silently delete the evidence this
  // whole repair exists to preserve.
  const db = await freshDb();
  await seedAgent(db, A);
  await seedInferred(db, A, "in", 1000);
  await seedInferred(db, A, "in", 1000);
  await seedInferred(db, A, "out", 500);
  assert.equal(await countFlows(db, A), 3);
});

// ── 2. ONE TRANSACTION, SEVERAL RELEVANT LOGS ──────────────────────────────

test("one transaction carrying several logs keeps every log, and only once", async () => {
  const db = await freshDb();
  await seedAgent(db, A);
  const p = plan({
    smartAccount: A,
    insert: [
      row({ txHash: TX, logIndex: 3, amountUsdg: 10, amountRaw: "10000000" }),
      row({ txHash: TX, logIndex: 7, amountUsdg: 4, amountRaw: "4000000" }),
    ],
    contributionsAfterUsdg: 14,
  });

  const first = await repairAccount(db, p, COMMIT, CHAIN);
  assert.equal(first.inserted, 2, "the log index is part of the identity, so both survive");
  assert.equal(await netOf(db, A), 14);

  const second = await repairAccount(db, p, { ...COMMIT, runId: "r2" }, CHAIN);
  assert.equal(second.inserted, 0);
  assert.equal(await countFlows(db, A), 2);
  assert.equal(await netOf(db, A), 14);
});

// ── 3. ONE TRANSACTION, TWO SMART ACCOUNTS ─────────────────────────────────

test("one transaction touching two accounts books it for both", async () => {
  // A batched transaction can fund two accounts at once. Keying on the tx hash
  // alone would let the first account's row block the second's, and the second
  // owner's deposit would vanish.
  const db = await freshDb();
  await seedAgent(db, A);
  await seedAgent(db, B);
  const pa = plan({ smartAccount: A, insert: [row({ agentId: A, txHash: TX, logIndex: 1 })] });
  const pb = plan({ smartAccount: B, insert: [row({ agentId: B, txHash: TX, logIndex: 2 })] });

  assert.equal((await repairAccount(db, pa, COMMIT, CHAIN)).inserted, 1);
  assert.equal((await repairAccount(db, pb, COMMIT, CHAIN)).inserted, 1);
  assert.equal(await netOf(db, A), 10);
  assert.equal(await netOf(db, B), 10);

  // And the same log index in the same tx for two accounts is still two rows.
  // Each plan carries the total it expects to leave behind, which is now the
  // second deposit ON TOP of the first — the preview has to predict the whole
  // resulting figure, not just its own contribution to it.
  const pb2 = plan({
    smartAccount: B,
    insert: [row({ agentId: B, txHash: TX2, logIndex: 1 })],
    contributionsAfterUsdg: 20,
  });
  const pa2 = plan({
    smartAccount: A,
    insert: [row({ agentId: A, txHash: TX2, logIndex: 1 })],
    contributionsAfterUsdg: 20,
  });
  await repairAccount(db, pb2, { ...COMMIT, runId: "r2" }, CHAIN);
  await repairAccount(db, pa2, { ...COMMIT, runId: "r2" }, CHAIN);
  assert.equal(await countFlows(db, A), 2);
  assert.equal(await countFlows(db, B), 2);
});

// ── 4. A RESTART MIDWAY THROUGH A FLEET REPAIR ─────────────────────────────

test("a restart midway leaves finished accounts done and untouched accounts untouched", async () => {
  const db = await freshDb();
  await seedAgent(db, A);
  await seedAgent(db, B);
  const idA = await seedInferred(db, A, "in", 30);
  const idB = await seedInferred(db, B, "in", 40);

  const pa = plan({
    smartAccount: A,
    insert: [row({ agentId: A, txHash: TX, logIndex: 1 })],
    quarantine: [{ id: idA, direction: "in", amountUsdg: 30, source: "inferred", reason: "superseded" }],
    existingTotalUsdg: 30,
  });
  const pb = plan({
    smartAccount: B,
    insert: [row({ agentId: B, txHash: TX2, logIndex: 1 })],
    quarantine: [{ id: idB, direction: "in", amountUsdg: 40, source: "inferred", reason: "superseded" }],
    existingTotalUsdg: 40,
  });

  // The "restart" is the process ending after A and before B — which is exactly
  // what a Railway redeploy does — so B is simply never called.
  await repairAccount(db, pa, COMMIT, CHAIN);
  assert.equal(await netOf(db, A), 10, "A is repaired");
  assert.equal(await netOf(db, B), 40, "B still holds its untouched legacy row");

  // The new process re-runs the WHOLE fleet with --resume.
  const results = await runRepair(
    db,
    [pa, pb],
    // BOTH NAMED. A commit with no named accounts is refused, so a fleet pass
    // spells out what it is repairing — including on a resume.
    { ...COMMIT, resume: true, runId: "r2", accounts: [A.toLowerCase(), B.toLowerCase()] },
    CHAIN,
  );
  assert.equal(results[0]!.inserted, 0, "A's evidence was already there");
  assert.equal(results[1]!.inserted, 1, "B is picked up where the crash left it");
  assert.equal(await netOf(db, A), 10);
  assert.equal(await netOf(db, B), 10);
  assert.equal(await countFlows(db, A), 1);
  assert.equal(await countFlows(db, B), 1);
});

test("an account whose evidence is all present and whose legacy rows are gone is skipped by --resume", async () => {
  const db = await freshDb();
  await seedAgent(db, A);
  const p = plan({ smartAccount: A, insert: [row({ txHash: TX, logIndex: 1 })] });
  await repairAccount(db, p, COMMIT, CHAIN);

  const again = await repairAccount(db, p, { ...COMMIT, resume: true, runId: "r2" }, CHAIN);
  assert.equal(again.stage, "already-repaired");
  assert.equal(again.inserted, 0);
});

// ── 5. A RE-RUN AFTER PARTIAL SUCCESS ──────────────────────────────────────

test("re-running after a partial success converges instead of accumulating", async () => {
  const db = await freshDb();
  await seedAgent(db, A);
  const id1 = await seedInferred(db, A, "in", 1000);
  const id2 = await seedInferred(db, A, "out", 500);
  const p = plan({
    smartAccount: A,
    insert: [row({ txHash: TX, logIndex: 1 }), row({ txHash: TX2, logIndex: 2, amountUsdg: 5, amountRaw: "5000000" })],
    quarantine: [
      { id: id1, direction: "in", amountUsdg: 1000, source: "inferred", reason: "superseded" },
      { id: id2, direction: "out", amountUsdg: 500, source: "inferred", reason: "superseded" },
    ],
    existingTotalUsdg: 500,
    contributionsAfterUsdg: 15,
  });

  const r1 = await repairAccount(db, p, COMMIT, CHAIN);
  assert.equal(r1.inserted, 2);
  assert.equal(r1.quarantined, 2);
  assert.equal(await netOf(db, A), 15);

  const r2 = await repairAccount(db, p, { ...COMMIT, runId: "r2" }, CHAIN);
  assert.equal(r2.inserted, 0);
  assert.equal(r2.quarantined, 0, "the legacy rows are already in quarantine, not moved a second time");
  assert.equal(await countFlows(db, A), 2);
  assert.equal(await netOf(db, A), 15, "a second pass changes nothing");

  const q = (await db.prepare("SELECT COUNT(*) AS n FROM flows_quarantine").get()) as { n: number };
  assert.equal(Number(q.n), 2, "and nothing is quarantined twice either");
});

// ── THE ORDER, WHICH IS THE POINT OF THE WHOLE TOOL ────────────────────────

test("a failed verification quarantines NOTHING for that account", async () => {
  const db = await freshDb();
  await seedAgent(db, A);
  const id = await seedInferred(db, A, "in", 1000);

  // The plan claims a row the chain says is 10 USDG; the ledger already holds
  // that same log at a DIFFERENT amount, so the insert conflicts, nothing is
  // written, and the read-back disagrees with the proposal.
  await db
    .prepare(
      `INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id)
       VALUES (?, 'in', 7, ?, 100, 1, 'chain-log', 1, ?)`,
    )
    .run(A, TX, CHAIN);

  const r = await repairAccount(
    db,
    plan({
      smartAccount: A,
      insert: [row({ txHash: TX, logIndex: 1 })],
      quarantine: [{ id, direction: "in", amountUsdg: 1000, source: "inferred", reason: "superseded" }],
    }),
    COMMIT,
    CHAIN,
  );

  assert.equal(r.stage, "failed");
  assert.match(r.why, /nothing quarantined/);
  const still = (await db.prepare("SELECT COUNT(*) AS n FROM flows WHERE id = ?").get(id)) as { n: number };
  assert.equal(Number(still.n), 1, "the legacy row is still exactly where it was");
  const q = (await db.prepare("SELECT COUNT(*) AS n FROM flows_quarantine").get()) as { n: number };
  assert.equal(Number(q.n), 0);
});

test("quarantine is reversible — every column needed to put the row back is carried", async () => {
  const db = await freshDb();
  await seedAgent(db, A);
  const id = await seedInferred(db, A, "out", 59_000);
  await repairAccount(
    db,
    plan({
      smartAccount: A,
      insert: [row({ txHash: TX, logIndex: 1 })],
      quarantine: [{ id, direction: "out", amountUsdg: 59_000, source: "inferred", reason: "paper book crossed" }],
      existingTotalUsdg: -59_000,
    }),
    COMMIT,
    CHAIN,
  );

  const q = (await db.prepare("SELECT * FROM flows_quarantine WHERE original_id = ?").get(id)) as Record<
    string,
    unknown
  >;
  assert.equal(Number(q.original_id), id);
  assert.equal(q.agent_id, A);
  assert.equal(q.direction, "out");
  assert.equal(Number(q.amount_usdg), 59_000);
  assert.equal(q.source, "inferred");
  assert.equal(q.run_id, "test-run");
  assert.equal(q.reason, "paper book crossed");
  assert.equal(q.replaced_by, `${TX}#1`, "and what replaced it, so the swap can be read both ways");
  assert.ok(Number(q.quarantined_at) > 0);
});

test("a run that fails partway does not commit its own inserts", async () => {
  // Same-account atomicity: the second proposed row is a duplicate of a row
  // already present at a different amount, so verification fails — and the FIRST
  // row must not survive either, or a partial contribution history is published.
  const db = await freshDb();
  await seedAgent(db, A);
  await db
    .prepare(
      `INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id)
       VALUES (?, 'in', 7, ?, 100, 2, 'chain-log', 1, ?)`,
    )
    .run(A, TX2, CHAIN);

  const r = await repairAccount(
    db,
    plan({
      smartAccount: A,
      insert: [row({ txHash: TX, logIndex: 1 }), row({ txHash: TX2, logIndex: 2 })],
    }),
    COMMIT,
    CHAIN,
  );
  assert.equal(r.stage, "failed");
  const n = (await db
    .prepare("SELECT COUNT(*) AS n FROM flows WHERE tx_hash = ?")
    .get(TX)) as { n: number };
  assert.equal(Number(n.n), 0, "the good row rolled back with the bad one");
});

// ── MODES ──────────────────────────────────────────────────────────────────

test("the default is read-only and mutation must be spelled out", async () => {
  assert.equal(parseRepairOptions({}), null, "absent means the tool does not run at all");
  assert.equal(parseRepairOptions({ MERRYMEN_REPAIR: "dry-run" })!.mode, "dry-run");
  assert.equal(parseRepairOptions({ MERRYMEN_REPAIR: "1" })!.mode, "dry-run", "a truthy value is not consent");
  assert.equal(parseRepairOptions({ MERRYMEN_REPAIR: "true" })!.mode, "dry-run");
  assert.equal(parseRepairOptions({ MERRYMEN_REPAIR: "COMMIT " })!.mode, "commit");
  assert.equal(parseRepairOptions({ MERRYMEN_REPAIR: "verify-only" })!.mode, "verify-only");
  // A LIST, normalised once. Whitespace, case and stray commas are the
  // operator's, not the comparison's — every downstream check reads a
  // lower-cased array and never has to remember to trim.
  assert.deepEqual(
    parseRepairOptions({ MERRYMEN_REPAIR: "dry-run", MERRYMEN_REPAIR_ACCOUNT: " 0xABC " })!.accounts,
    ["0xabc"],
  );
  assert.deepEqual(
    parseRepairOptions({
      MERRYMEN_REPAIR: "commit",
      MERRYMEN_REPAIR_ACCOUNT: "0xAAA, 0xbbb ,,0xCcC,",
    })!.accounts,
    ["0xaaa", "0xbbb", "0xccc"],
  );
  // Anything that is not an address is dropped rather than silently becoming a
  // selector that matches nothing.
  assert.deepEqual(
    parseRepairOptions({ MERRYMEN_REPAIR: "commit", MERRYMEN_REPAIR_ACCOUNT: "all, everything" })!.accounts,
    [],
  );
  assert.equal(parseRepairOptions({ MERRYMEN_REPAIR: "commit", MERRYMEN_REPAIR_RESUME: "1" })!.resume, true);
  assert.equal(parseRepairOptions({ MERRYMEN_REPAIR: "commit" })!.resume, false);
  assert.match(parseRepairOptions({ MERRYMEN_REPAIR: "commit" }, 0)!.runId, /^run-1970-01-01/);
});

test("a dry run writes nothing", async () => {
  const db = await freshDb();
  await seedAgent(db, A);
  const id = await seedInferred(db, A, "in", 1000);
  const r = await repairAccount(
    db,
    plan({
      smartAccount: A,
      insert: [row({ txHash: TX, logIndex: 1 })],
      quarantine: [{ id, direction: "in", amountUsdg: 1000, source: "inferred", reason: "superseded" }],
    }),
    { mode: "dry-run", runId: "r", resume: false, accounts: [] },
    CHAIN,
  );
  assert.match(r.why, /^dry run: would insert 1 and quarantine 1/);
  assert.equal(await countFlows(db, A), 1, "the legacy row, and nothing else");
  assert.equal(await netOf(db, A), 1000);
});

test("--account limits the mutation to one smart account", async () => {
  const db = await freshDb();
  await seedAgent(db, A);
  await seedAgent(db, B);
  const pa = plan({ smartAccount: A, insert: [row({ agentId: A, txHash: TX, logIndex: 1 })] });
  const pb = plan({ smartAccount: B, insert: [row({ agentId: B, txHash: TX2, logIndex: 1 })] });

  const results = await runRepair(db, [pa, pb], { ...COMMIT, accounts: [A.toLowerCase()] }, CHAIN);
  assert.equal(results[0]!.stage, "recomputed");
  assert.equal(results[1]!.stage, "skipped-not-selected");
  assert.equal(await countFlows(db, A), 1);
  assert.equal(await countFlows(db, B), 0, "the rest of the fleet is untouched");
});

test("a blocked account is skipped rather than half-corrected", async () => {
  const db = await freshDb();
  await seedAgent(db, A);
  const id = await seedInferred(db, A, "in", 1000);
  const r = await repairAccount(
    db,
    plan({
      smartAccount: A,
      insert: [row({ txHash: TX, logIndex: 1 })],
      quarantine: [{ id, direction: "in", amountUsdg: 1000, source: "inferred", reason: "superseded" }],
      blocked: "2 movement(s) could not be classified as capital or trade",
    }),
    COMMIT,
    CHAIN,
  );
  assert.equal(r.stage, "skipped-blocked");
  assert.equal(await countFlows(db, A), 1);
  assert.equal(await netOf(db, A), 1000, "an ambiguous account keeps its history until a human decides");
});

test("runRepair stops at the first failure instead of pressing on", async () => {
  const db = await freshDb();
  await seedAgent(db, A);
  await seedAgent(db, B);
  await db
    .prepare(
      `INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id)
       VALUES (?, 'in', 7, ?, 100, 1, 'chain-log', 1, ?)`,
    )
    .run(A, TX, CHAIN);
  const pa = plan({ smartAccount: A, insert: [row({ agentId: A, txHash: TX, logIndex: 1 })] });
  const pb = plan({ smartAccount: B, insert: [row({ agentId: B, txHash: TX2, logIndex: 1 })] });

  const results = await runRepair(db, [pa, pb], COMMIT, CHAIN);
  assert.equal(results.length, 1);
  assert.equal(results[0]!.stage, "failed");
  assert.equal(await countFlows(db, B), 0);
});

// ── THE PREVIEW MUST PREDICT THE MUTATION ──────────────────────────────────

test("a ledger that moved since the preview rolls the repair back", async () => {
  const db = await freshDb();
  await seedAgent(db, A);
  const p = plan({ smartAccount: A, insert: [row({ txHash: TX, logIndex: 1 })], contributionsAfterUsdg: 10 });

  // Something wrote a row between the preview and the commit — a mirror pass, a
  // live tick, a second operator. The operator approved 10, not 60.
  await seedInferred(db, A, "in", 50);

  const r = await repairAccount(db, p, COMMIT, CHAIN);
  assert.equal(r.stage, "failed");
  assert.match(r.why, /the table changed since the plan was built/);
  assert.equal(await countFlows(db, A), 1, "only the row that appeared; the repair backed out");
});

test("quality is recomputed in the same transaction as the rows it describes", async () => {
  const db = await freshDb();
  await seedAgent(db, A);
  const r = await repairAccount(
    db,
    plan({ smartAccount: A, insert: [row({ txHash: TX, logIndex: 1 })] }),
    COMMIT,
    CHAIN,
  );
  assert.equal(r.contributionsKnownAfter, true);
  const a = (await db
    .prepare("SELECT contributions_known, contributions_why, quality_at FROM agents WHERE smart_account = ?")
    .get(A)) as { contributions_known: number; contributions_why: string; quality_at: number };
  assert.equal(Number(a.contributions_known), 1);
  assert.match(a.contributions_why, /test-run/);
  assert.ok(Number(a.quality_at) > 0);
});

test("the run id does not default to the epoch, the way its predecessor did", () => {
  // A sibling of this function took `now = 0` so it could stay pure, and the
  // orchestrator called it without a clock — so every production run was stamped
  // `run-1970-01-01T00-00-00-000Z`, which is the one property a run id exists to
  // provide, absent exactly where it was needed. Its unit tests could not catch
  // it, because they passed `now` explicitly. This one does not.
  const withClock = parseRepairOptions({ MERRYMEN_REPAIR: "dry-run" })!;
  assert.doesNotMatch(withClock.runId, /^run-1970/, "the default reads a real clock");
  assert.match(withClock.runId, /^run-20\d\d-/);
  // …and it is still injectable, so the tests above can pin an exact value.
  assert.match(parseRepairOptions({ MERRYMEN_REPAIR: "dry-run" }, 0)!.runId, /^run-1970-01-01/);
});

test("mode parsing has exactly one owner, and the orchestrator uses it", () => {
  const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
  assert.match(src, /parseRepairOptions\(process\.env\)/, "one owner for mode parsing");
  assert.doesNotMatch(src, /parsePreviewRequest/, "and the read-only-build parser is gone with its build");
});
