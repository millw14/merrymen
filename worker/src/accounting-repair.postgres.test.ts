/** Opt-in repair verification against the production PostgreSQL adapter.
 * MERRYMEN_TEST_PG_URL must name a disposable LOCAL database. No production
 * DATABASE_URL is used, and every case owns and drops a separate schema. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { makePgDb, type Db } from "./db";
import { applyLedgerSchema } from "./store";
import { hasChainIdentityIndex, repairAccount, runRepair, type RepairOptions } from "./accounting-repair";
import { flowFingerprintOf, type AccountPlan, type ProposedFlowRow } from "./accounting-reconstruction";

const url = process.env.MERRYMEN_TEST_PG_URL;
const CHAIN = 4663;
const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const FIRST_TX = `0x${"11".repeat(32)}`;
const SECOND_TX = `0x${"22".repeat(32)}`;
const CAPS = JSON.stringify({ maxDrawdownPct: 5, maxPerTradeUsdg: 10 });
const COMMIT: RepairOptions = { mode: "commit", accounts: [ACCOUNT], runId: "postgres-repair", resume: false };
const FLOW_COLUMNS = "id, agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at";

const flowRows = async (db: Db) => await db.prepare(`SELECT ${FLOW_COLUMNS} FROM flows WHERE agent_id = ? ORDER BY id`)
  .all(ACCOUNT) as Record<string, unknown>[];

async function snapshot(db: Db) {
  return {
    flows: await flowRows(db),
    quarantined: await db.prepare("SELECT * FROM flows_quarantine ORDER BY original_id").all(),
    agent: await db.prepare("SELECT * FROM agents WHERE smart_account = ?").get(ACCOUNT),
  };
}

async function withFixture(run: (db: Db, plan: AccountPlan) => Promise<void>) {
  const target = new URL(url!);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only disposable local PostgreSQL is allowed");
  const schema = `mm_accounting_repair_${randomBytes(8).toString("hex")}`;
  const admin = await makePgDb(target.toString());
  const scoped = new URL(target);
  scoped.searchParams.set("options", `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000`);
  await admin.exec(`CREATE SCHEMA ${schema}`);
  try {
    const db = await makePgDb(scoped.toString());
    await applyLedgerSchema(db);
    await db.prepare(`INSERT INTO agents
      (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at,
       epoch, hwm_usdg, hwm_withdrawn_usdg, contributions_known)
      VALUES (?, ?, ?, ?, ?, 1, 9999999999, 1, 349.365984, 0, 0)`)
      .run(ACCOUNT, ACCOUNT, ACCOUNT, CHAIN, CAPS);
    await db.prepare(`INSERT INTO flows
      (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id, at)
      VALUES (?, 'in', 49.145575, ?, 100, 2, 'chain-log', 1, ?, 1000)`)
      .run(ACCOUNT, FIRST_TX, CHAIN);
    await db.prepare(`INSERT INTO flows
      (agent_id, direction, amount_usdg, source, epoch, at)
      VALUES (?, 'in', 299, 'inferred', 1, 2000)`).run(ACCOUNT);
    const rows = await flowRows(db);
    const inferred = rows.find((row) => row.source === "inferred")!;
    const flow = (txHash: string, amountUsdg: number, blockNumber: number, logIndex: number): ProposedFlowRow => ({
      agentId: ACCOUNT, epoch: 1, direction: "in", amountUsdg,
      amountRaw: String(Math.round(amountUsdg * 1e6)), source: "chain-log", txHash, blockNumber, logIndex,
      at: txHash === FIRST_TX ? 999 : blockNumber * 10,
    });
    const plan: AccountPlan = {
      smartAccount: ACCOUNT, ownerAddress: ACCOUNT, tenant: ACCOUNT, mode: "live", isPaper: false, epoch: 1,
      onchainCashUsdg: 347.206187, navUsdg: 347.209057,
      chainGrossInUsdg: 348.145575, chainGrossOutUsdg: 0, chainReserveUsdg: 0,
      chainNetUsdg: 348.145575, chainTradeLegs: 0, chainAmbiguous: 0, chainComplete: true,
      existingInferredRows: 1, existingInferredUsdg: 299, existingTotalUsdg: 348.145575,
      flowFingerprint: flowFingerprintOf(rows),
      insert: [flow(FIRST_TX, 49.145575, 100, 2), flow(SECOND_TX, 299, 200, 4)],
      quarantine: [{ id: Number(inferred.id), direction: "in", amountUsdg: 299, source: "inferred", reason: "replaced by receipt" }],
      contributionsKnownBefore: false, contributionsAfterUsdg: 348.145575,
      contributionsKnownAfter: true, pnlPublishableAfter: true, blocked: null,
    };
    assert.equal(typeof plan.flowFingerprint, "string", "full PostgreSQL rows produce a commit snapshot");
    await run(db, plan);
  } finally {
    await admin.exec(`DROP SCHEMA ${schema} CASCADE`);
  }
}

test("Postgres: receipt repair preserves capital and refuses stale or unsafe plans", { skip: !url, timeout: 90_000 }, async (t) => {
  await t.test("catalogue verification and a repeat cannot duplicate the existing deposit", async () => withFixture(async (db, plan) => {
    assert.equal(await hasChainIdentityIndex(db), true, "production DDL is recognized through PostgreSQL's catalog");
    const [first] = await runRepair(db, [plan], COMMIT, CHAIN);
    assert.equal(first!.stage, "recomputed", first!.why);
    assert.equal(first!.inserted, 1);
    assert.equal(first!.insertsAlreadyPresent, 1);
    assert.equal(first!.quarantined, 1);
    assert.equal(first!.contributionsAfterUsdg, 348.145575);
    assert.equal(first!.contributionsKnownAfter, true);
    const rows = await flowRows(db);
    assert.equal(rows.length, 2);
    assert.equal(rows.filter((row) => row.tx_hash === FIRST_TX).length, 1);
    assert.equal(rows.filter((row) => row.tx_hash === SECOND_TX).length, 1);
    assert.ok(rows.every((row) => row.source === "chain-log"));
    assert.equal(rows.find((row) => row.tx_hash === FIRST_TX)!.at, 1000, "pre-existing receipt keeps its original timestamp");
    assert.equal(rows.find((row) => row.tx_hash === SECOND_TX)!.at, 2000, "new receipt uses its historical block timestamp, not repair time");
    const agent = await db.prepare("SELECT caps, hwm_usdg, hwm_withdrawn_usdg, epoch, contributions_known FROM agents WHERE smart_account = ?")
      .get(ACCOUNT) as Record<string, unknown>;
    assert.deepEqual(agent, { caps: CAPS, hwm_usdg: 349.365984, hwm_withdrawn_usdg: 0, epoch: 1, contributions_known: 1 });
    const quarantined = await db.prepare("SELECT amount_usdg, source, original_id, run_id FROM flows_quarantine").all();
    assert.deepEqual(quarantined, [{ amount_usdg: 299, source: "inferred", original_id: plan.quarantine[0]!.id, run_id: COMMIT.runId }]);

    const before = await snapshot(db);
    const freshPlan = { ...plan, quarantine: [], existingInferredRows: 0, existingInferredUsdg: 0,
      flowFingerprint: flowFingerprintOf(rows), contributionsKnownBefore: true };
    const [repeat] = await runRepair(db, [freshPlan], { ...COMMIT, runId: "repeat", resume: true }, CHAIN);
    assert.equal(repeat!.stage, "already-repaired", repeat!.why);
    assert.deepEqual(await snapshot(db), before, "retry does not mutate the receipt, quarantine, HWM, caps, or quality");
    await assert.rejects(() => db.prepare(`INSERT INTO flows
      (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, chain_id)
      VALUES (?, 'in', 299, ?, 200, 4, 'chain-log', 1, ?)`).run(ACCOUNT, SECOND_TX, CHAIN), /duplicate key|unique/i);
  }));

  await t.test("a changed accounting epoch refuses without moving any row", async () => withFixture(async (db, plan) => {
    await db.prepare("UPDATE agents SET epoch = 2 WHERE smart_account = ?").run(ACCOUNT);
    const before = await snapshot(db);
    const result = await repairAccount(db, plan, COMMIT, CHAIN);
    assert.equal(result.stage, "failed", result.why);
    assert.match(result.why, /epoch/i);
    assert.deepEqual(await snapshot(db), before);
  }));

  await t.test("a zero-net flow change invalidates the fingerprint, including resume", async () => withFixture(async (db, plan) => {
    for (const direction of ["in", "out"]) {
      await db.prepare("INSERT INTO flows (agent_id, direction, amount_usdg, source, epoch, at) VALUES (?, ?, 7, 'inferred', 1, 3000)")
        .run(ACCOUNT, direction);
    }
    const before = await snapshot(db);
    const result = await repairAccount(db, plan, { ...COMMIT, resume: true }, CHAIN);
    assert.equal(result.stage, "failed", result.why);
    assert.match(result.why, /fingerprint|snapshot|changed/i);
    assert.deepEqual(await snapshot(db), before, "same net capital cannot make changed history acceptable");
  }));

  await t.test("a later PostgreSQL failure rolls back inserts and quarantine together", async () => withFixture(async (db, plan) => {
    await db.exec(`CREATE FUNCTION refuse_quality_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test refuses quality update'; END; $$;
      CREATE TRIGGER refuse_quality_update BEFORE UPDATE OF contributions_known ON agents
      FOR EACH ROW EXECUTE FUNCTION refuse_quality_update()`);
    const before = await snapshot(db);
    const result = await repairAccount(db, plan, COMMIT, CHAIN);
    assert.equal(result.stage, "failed", result.why);
    assert.match(result.why, /test refuses quality update/);
    assert.deepEqual(await snapshot(db), before, "transaction restores the original evidence and quality on a late SQL failure");
  }));

  for (const [name, ddl] of [
    ["non-unique namesake", "CREATE INDEX flows_chain_identity ON flows (chain_id, agent_id, tx_hash, log_index) WHERE tx_hash IS NOT NULL AND log_index IS NOT NULL"],
    ["wrong key columns", "CREATE UNIQUE INDEX flows_chain_identity ON flows (chain_id, agent_id, tx_hash, log_index, source) WHERE tx_hash IS NOT NULL AND log_index IS NOT NULL"],
    ["wrong partial predicate", "CREATE UNIQUE INDEX flows_chain_identity ON flows (chain_id, agent_id, tx_hash, log_index) WHERE tx_hash IS NOT NULL AND log_index IS NOT NULL AND source = 'energy-buy'"],
  ]) {
    await t.test(`a ${name} is not the required identity index`, async () => withFixture(async (db, plan) => {
      await db.exec("DROP INDEX flows_chain_identity");
      await db.exec(ddl!);
      assert.equal(await hasChainIdentityIndex(db), false);
      const before = await snapshot(db);
      const [result] = await runRepair(db, [plan], COMMIT, CHAIN);
      assert.equal(result!.stage, "failed", result!.why);
      assert.match(result!.why, /index|constraint/i);
      assert.deepEqual(await snapshot(db), before);
    }));
  }
});
