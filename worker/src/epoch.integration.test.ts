/**
 * An epoch boundary must not republish the bankroll as profit.
 *
 * The epoch mechanism exists to quarantine rows written before the accounting
 * was fixed. But equity is an ABSOLUTE balance reading while flows are
 * EPOCH-SCOPED, so bumping the epoch without carrying the capital over stops
 * the two terms living in the same frame: the new epoch's contributions start
 * at nothing while equity still holds every dollar deposited before the
 * boundary.
 *
 * The COUNT(*) guard hides that only while there are ZERO flows. The first
 * top-up in the new epoch makes contributions equal to just that top-up, and
 * `equity − contributions` publishes the entire bankroll as profit — which is
 * the precise bug the epoch boundary was built to end, reintroduced by the
 * boundary itself.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-epoch-"));
process.env.MERRYMEN_HOME = HOME;

const {
  initStore,
  ACCOUNTING_FIXED_AT,
  addEquity,
  addFlow,
  addTrade,
  ensureAgent,
  getAgentEpoch,
  getNetContributionsUsdg,
  hasEpochOneHistory,
  lastKnownEquityUsdg,
  openNextEpoch,
} = await import("./store");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");

await initStore();
const db = new DatabaseSync(homePaths.db());
after(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* Windows keeps the sqlite handle a moment longer; the temp dir is disposable */
  }
});

const grant = (account: string) =>
  ({
    smartAccount: account,
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_000_000,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    chainId: 4663,
  }) as never;

/** Write an equity row directly at a chosen timestamp — the pre/post-fix distinction is a DATE. */
const equityAt = (agent: string, at: number, usdg: number, epoch: number) =>
  db
    .prepare(
      "INSERT INTO equity (agent_id, cash_usdg, vault_usdg, positions_usdg, equity_usdg, eth_wei, at, epoch) VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(agent, usdg, 0, 0, usdg, "0", at, epoch);

describe("the epoch boundary", () => {
  it("carries capital across, so a later deposit is not profit", async () => {
    const acct = "0x00000000000000000000000000000000000000e1";
    const id = await ensureAgent(grant(acct));

    // A pre-fix run: 1000 USDG of the owner's money, no flow records at all —
    // which is exactly what makes epoch 1 unauditable.
    equityAt(id, ACCOUNTING_FIXED_AT - 5_000, 1000, 1);
    assert.equal(await hasEpochOneHistory(id), true, "old rows are present, so a boundary is needed");

    const carried = await lastKnownEquityUsdg(id);
    assert.equal(carried, 1000);
    const opened = await openNextEpoch(id, carried ?? undefined);
    assert.equal(opened, 2);
    assert.equal(await getAgentEpoch(id), 2);

    // The opening balance must land in the NEW epoch, not the closed one.
    assert.equal(
      await getNetContributionsUsdg(id),
      1000,
      "capital present at the boundary is contributed capital, not performance",
    );

    // NOW the case that used to lie: one small top-up in the new epoch.
    await addFlow({ agentId: id, direction: "in", amountUsdg: 1, source: "transfer-intent" });
    await addEquity(id, { mode: "live", ethWei: 0n, cashUsdg: 1001, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 1001 });

    const contributed = await getNetContributionsUsdg(id);
    assert.equal(contributed, 1001);
    const pnl = 1001 - (contributed ?? 0);
    assert.equal(pnl, 0, "a deposit is not a gain — without the opening balance this read +1000");
  });

  it("a brand-new agent on today's code is NOT bumped out of its own epoch", async () => {
    // THE REGRESSION THIS DATE CHECK EXISTS FOR. hasEpochOneHistory used to fire
    // on the bare presence of epoch-1 rows, so an agent running today's code
    // wrote its own correct flows/trades/equity into epoch 1 on run one, and was
    // bumped to epoch 2 on its very next restart — orphaning its real deposit
    // records behind a boundary meant for someone else's bad data.
    const acct = "0x00000000000000000000000000000000000000e2";
    const id = await ensureAgent(grant(acct));

    await addFlow({ agentId: id, direction: "in", amountUsdg: 500, source: "chain-log" });
    await addEquity(id, { mode: "live", ethWei: 0n, cashUsdg: 500, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 500 });
    await addTrade({
      agent_id: id,
      kind: "swap",
      target: "0x00000000000000000000000000000000000000a1",
      amount_usdg: 10,
      status: "landed",
    });

    assert.equal(
      await hasEpochOneHistory(id),
      false,
      "rows written after the accounting was fixed are auditable — there is nothing to quarantine",
    );
    assert.equal(await getAgentEpoch(id), 1, "and the agent stays where its own records are");
    assert.equal(await getNetContributionsUsdg(id), 500, "its deposit is still on the books");
  });

  it("an agent with BOTH old and new rows is still bumped — the old rows are what matter", async () => {
    const acct = "0x00000000000000000000000000000000000000e3";
    const id = await ensureAgent(grant(acct));
    equityAt(id, ACCOUNTING_FIXED_AT - 1, 42, 1); // one second before the fix
    await addEquity(id, { mode: "live", ethWei: 0n, cashUsdg: 42, vaultUsdg: 0, positionsUsdg: 0, equityUsdg: 42 });
    assert.equal(await hasEpochOneHistory(id), true);
  });

  it("a boundary with nothing to carry opens clean rather than inventing a balance", async () => {
    const acct = "0x00000000000000000000000000000000000000e4";
    const id = await ensureAgent(grant(acct));
    equityAt(id, ACCOUNTING_FIXED_AT - 5_000, 0, 1);
    const carried = await lastKnownEquityUsdg(id);
    assert.equal(carried, 0);
    await openNextEpoch(id, carried ?? undefined);
    assert.equal(
      await getNetContributionsUsdg(id),
      null,
      "no contributions on record is NULL, never a zero — an unfunded boundary must not fabricate one",
    );
  });
});
