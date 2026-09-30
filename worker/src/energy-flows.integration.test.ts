/**
 * AN ENERGY PURCHASE IS BOOKED ONCE, WITH BOTH PEAKS, OR NOT AT ALL — proven
 * against a real sqlite file.
 *
 * USDG spent buying the energy reserve leaves the trading book: equity drops by
 * the spend with nothing earned or lost, so the peaks it is measured against
 * have to drop with it, or the next tick reads the purchase as a drawdown and
 * the breaker refuses every buy. That is the same pairing the transfer path
 * makes with `addFlow` then `adjustAgentHwm` — two transactions, and an
 * `addFlow` whose `true` also means "duplicate". Shogun lost 5.000000 of peak
 * twice to exactly that second property.
 *
 * `bookCapitalFlow` closes both holes: one transaction for the row, its journal
 * fact and both peaks (lifetime and the risk period), and the peaks move only
 * when the INSERT inserted. Each case below is one of those claims.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-energy-flows-"));
process.env.MERRYMEN_HOME = HOME;

const { closeStoreForTest, initStore, ensureAgent, adjustAgentHwm, bookCapitalFlow, getAgentFinancials, listFlows } =
  await import("./store");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");

const ACCOUNT = "0x00000000000000000000000000000000000e0e01";
const TX = `0x${"e1".repeat(32)}`;
const RISK_ID = "energy-risk-period";

const GRANT = {
  smartAccount: ACCOUNT,
  owner: "0x00000000000000000000000000000000000000ff",
  sessionKeyAddress: "0x00000000000000000000000000000000000000fe",
  chainId: 4663,
  caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 5, maxOpsPerDay: 48 },
  grantedAt: 1_700_000_000,
  expiresAt: 2_000_000_000,
} as never;

const raw = () => new DatabaseSync(homePaths.db());

function exec(sql: string, ...params: (string | number | null)[]): void {
  const db = raw();
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function one<T>(sql: string, ...params: (string | number | null)[]): T {
  const db = raw();
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
}

const flowJournalRows = () =>
  Number(one<{ n: number }>("SELECT COUNT(*) AS n FROM journal WHERE agent_id = ? AND kind = 'flow'", ACCOUNT).n);
const riskWithdrawn = () =>
  Number(one<{ w: number }>("SELECT withdrawn_usdg AS w FROM risk_periods WHERE id = ?", RISK_ID).w);

const energyFlow = (over: Partial<Parameters<typeof bookCapitalFlow>[0]> = {}) => ({
  agentId: ACCOUNT,
  direction: "out" as const,
  amountUsdg: 42,
  source: "energy-buy" as const,
  txHash: TX,
  blockNumber: 1_234_567,
  logIndex: 3,
  mode: "live" as const,
  chainId: 4663,
  ...over,
});

/** A fresh agent with a 100 USDG lifetime peak and a 100 USDG risk-period peak. */
async function freshAgent(): Promise<void> {
  for (const t of ["agents", "flows", "journal", "risk_periods"]) {
    try {
      exec(`DELETE FROM ${t}`);
    } catch {
      /* table may not exist */
    }
  }
  exec("DROP TRIGGER IF EXISTS energy_boom");
  await ensureAgent(GRANT);
  await adjustAgentHwm(ACCOUNT, 100);
  exec("UPDATE agents SET mode = 'live' WHERE smart_account = ?", ACCOUNT);
  exec(
    `INSERT INTO risk_periods (id, agent_id, started_at, baseline_usdg, hwm_usdg, withdrawn_usdg, reason)
     VALUES (?, ?, ?, 100, 100, 0, 'owner-authorised')`,
    RISK_ID,
    ACCOUNT,
    1_700_000_000,
  );
}

before(async () => {
  await initStore();
});

beforeEach(freshAgent);

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("bookCapitalFlow — the energy purchase", () => {
  it("(a) booked: the withdrawn totals move by exactly the spend, and one journal fact is appended", async () => {
    const before = await getAgentFinancials(ACCOUNT);
    assert.equal(before.hwmUsdg, 100);
    const journalBefore = flowJournalRows();

    const r = await bookCapitalFlow(energyFlow());
    assert.equal(r.kind, "booked");

    const afterF = await getAgentFinancials(ACCOUNT);
    assert.equal(afterF.hwmWithdrawnUsdg - before.hwmWithdrawnUsdg, 42, "lifetime withdrawn moved by the spend");
    assert.equal(afterF.hwmGrossUsdg, before.hwmGrossUsdg, "the gross never moves down");
    assert.equal(afterF.hwmUsdg, 58, "effective peak = 100 − 42");
    assert.equal(riskWithdrawn(), 42, "the risk period's withdrawn moved in the same transaction");
    assert.equal(flowJournalRows() - journalBefore, 1, "exactly one journal 'flow' fact");

    const rows = await listFlows(ACCOUNT);
    const row = rows.find((f) => f.source === "energy-buy");
    assert.ok(row, "the row is on the books");
    assert.equal(row!.direction, "out");
    assert.equal(row!.amount_usdg, 42);
    assert.equal(row!.tx_hash, TX, "stored lowercase, keyed on the receipt");
    const identity = one<{ chain_id: number; log_index: number; block_number: number }>(
      "SELECT chain_id, log_index, block_number FROM flows WHERE agent_id = ? AND source = 'energy-buy'",
      ACCOUNT,
    );
    assert.deepEqual({ ...identity }, { chain_id: 4663, log_index: 3, block_number: 1_234_567 });
  });

  it("(b) the same (chain, agent, tx, logIndex) again is 'already', and the peak moved ONCE", async () => {
    assert.equal((await bookCapitalFlow(energyFlow())).kind, "booked");
    const journal = flowJournalRows();

    // A retry, the stranded resolver after a crash, an upper-cased hash from a
    // different RPC — every one of them is the same log.
    assert.equal((await bookCapitalFlow(energyFlow())).kind, "already");
    assert.equal((await bookCapitalFlow(energyFlow({ txHash: TX.toUpperCase().replace("0X", "0x") }))).kind, "already");

    const f = await getAgentFinancials(ACCOUNT);
    assert.equal(f.hwmWithdrawnUsdg, 42, "not 84 — the Shogun double-lowering cannot happen here");
    assert.equal(riskWithdrawn(), 42);
    assert.equal(flowJournalRows(), journal, "a duplicate appends no journal fact");
    assert.equal((await listFlows(ACCOUNT)).filter((r) => r.source === "energy-buy").length, 1);
  });

  it("a DIFFERENT log index on the same transaction is a different flow", async () => {
    assert.equal((await bookCapitalFlow(energyFlow())).kind, "booked");
    assert.equal((await bookCapitalFlow(energyFlow({ logIndex: 4, amountUsdg: 1 }))).kind, "booked");
    assert.equal((await getAgentFinancials(ACCOUNT)).hwmWithdrawnUsdg, 43);
  });

  it("(c) mode 'paper' is refused by the paper boundary, and nothing moves", async () => {
    const r = await bookCapitalFlow(energyFlow({ mode: "paper" }));
    assert.equal(r.kind, "refused");
    assert.match(r.kind === "refused" ? r.why : "", /paper/);
    assert.equal((await getAgentFinancials(ACCOUNT)).hwmWithdrawnUsdg, 0);
    assert.equal(riskWithdrawn(), 0);
    assert.equal(flowJournalRows(), 0);
    assert.equal((await listFlows(ACCOUNT)).length, 0);
  });

  it("an agent row that says paper refuses too, when the caller does not say", async () => {
    exec("UPDATE agents SET mode = 'paper' WHERE smart_account = ?", ACCOUNT);
    const r = await bookCapitalFlow(energyFlow({ mode: undefined }));
    assert.equal(r.kind, "refused");
    assert.equal((await getAgentFinancials(ACCOUNT)).hwmWithdrawnUsdg, 0);
  });

  it("(d) no chain identity (agents.chain_id NULL, none passed) is refused, and nothing moves", async () => {
    // NULLs are distinct in `flows_chain_identity`, so a row written without a
    // chain could be written twice. Refused rather than booked loosely.
    //
    // The child's own schema declares chain_id NOT NULL; a shared database's
    // older agents rows do not. So this case swaps in a copy of the real table
    // with only that constraint relaxed, and puts the real one back after.
    const db = raw();
    const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get() as { sql: string }).sql;
    const loose = ddl.replace(/chain_id INTEGER NOT NULL/, "chain_id INTEGER").replace(/CREATE TABLE (IF NOT EXISTS )?"?agents"?/, "CREATE TABLE agents");
    assert.notEqual(loose, ddl, "the relaxed copy really relaxes chain_id");
    db.exec(`ALTER TABLE agents RENAME TO agents_strict; ${loose}; INSERT INTO agents SELECT * FROM agents_strict;`);
    db.close();
    try {
      exec("UPDATE agents SET chain_id = NULL WHERE smart_account = ?", ACCOUNT);
      const r = await bookCapitalFlow(energyFlow({ chainId: undefined }));
      assert.equal(r.kind, "refused");
      assert.match(r.kind === "refused" ? r.why : "", /chain identity/);
      assert.equal((await getAgentFinancials(ACCOUNT)).hwmWithdrawnUsdg, 0);
      assert.equal(riskWithdrawn(), 0);
      assert.equal(flowJournalRows(), 0);
      assert.equal((await listFlows(ACCOUNT)).length, 0);
    } finally {
      const back = raw();
      back.exec("DROP TABLE agents; ALTER TABLE agents_strict RENAME TO agents;");
      back.close();
    }
  });

  it("the agent's own chain id is used when the caller passes none", async () => {
    const r = await bookCapitalFlow(energyFlow({ chainId: undefined }));
    assert.equal(r.kind, "booked");
    assert.equal(one<{ c: number }>("SELECT chain_id AS c FROM flows WHERE agent_id = ?", ACCOUNT).c, 4663);
  });

  it("refuses a flow with no receipt identity or a non-positive amount, before touching the database", async () => {
    for (const bad of [
      energyFlow({ txHash: "" }),
      energyFlow({ txHash: "0xabc" }),
      energyFlow({ logIndex: -1 }),
      energyFlow({ logIndex: 1.5 }),
      energyFlow({ blockNumber: Number.NaN }),
      energyFlow({ amountUsdg: 0 }),
      energyFlow({ amountUsdg: -5 }),
      energyFlow({ amountUsdg: Number.NaN }),
    ]) {
      assert.equal((await bookCapitalFlow(bad)).kind, "refused");
    }
    assert.equal((await getAgentFinancials(ACCOUNT)).hwmWithdrawnUsdg, 0);
    assert.equal((await listFlows(ACCOUNT)).length, 0);
  });

  it("an unknown agent is refused, not booked with an invented epoch", async () => {
    const r = await bookCapitalFlow(energyFlow({ agentId: "0x00000000000000000000000000000000000e0e99" }));
    assert.equal(r.kind, "refused");
  });

  it("(e) a peak move that throws rolls the flow row and its journal fact back — never a split", async () => {
    // The row goes in first, then the peaks. Make the peak UPDATE fail the way
    // a real database error would, after the INSERT has already run.
    exec(
      `CREATE TRIGGER energy_boom BEFORE UPDATE OF hwm_withdrawn_usdg ON agents
       BEGIN SELECT RAISE(ABORT, 'simulated peak failure'); END`,
    );
    await assert.rejects(() => bookCapitalFlow(energyFlow()), /simulated peak failure/, "a database error throws");

    assert.equal((await listFlows(ACCOUNT)).length, 0, "the flow row rolled back with the peak");
    assert.equal(flowJournalRows(), 0, "and so did its journal fact");
    assert.equal(riskWithdrawn(), 0, "the risk period moved first in the same transaction, and rolled back too");
    assert.equal((await getAgentFinancials(ACCOUNT)).hwmWithdrawnUsdg, 0);

    // And once the fault clears, the retry books it — nothing was half-written
    // for it to collide with.
    exec("DROP TRIGGER energy_boom");
    assert.equal((await bookCapitalFlow(energyFlow())).kind, "booked");
    assert.equal((await getAgentFinancials(ACCOUNT)).hwmWithdrawnUsdg, 42);
    assert.equal(riskWithdrawn(), 42);
  });

  it("adjustAgentHwm is unchanged: its own transaction, same clamp at the gross", async () => {
    await adjustAgentHwm(ACCOUNT, -250);
    const f = await getAgentFinancials(ACCOUNT);
    assert.equal(f.hwmWithdrawnUsdg, 100, "clamped at the gross, so the effective peak floors at zero");
    assert.equal(f.hwmUsdg, 0);
  });
});
