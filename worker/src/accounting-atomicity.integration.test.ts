import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { reconstruct, verifyChain } from "./audit";
import type { FlowRow } from "./store";

// Neither the test home nor either legacy migration path can contain user data.
const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-accounting-atomicity-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("./store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
const raw = new DatabaseSync(path.join(process.env.MERRYMEN_HOME, "merrymen.db"));

after(() => {
  raw.close();
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

let nextAccount = 1;
async function agent(): Promise<string> {
  const account = `0x${(nextAccount++).toString(16).padStart(40, "0")}`;
  return store.ensureAgent({
    smartAccount: account,
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_000_000,
    expiresAt: 2_000_000_000,
    chainId: 4663,
  } as never);
}

function flow(agentId: string): FlowRow {
  return {
    agentId,
    direction: "in",
    amountUsdg: 100,
    source: "chain-log",
    mode: "live",
    txHash: `0x${"ab".repeat(32)}`,
    blockNumber: 1000,
    logIndex: 2,
  };
}

function flowCount(agentId: string): number {
  return (raw.prepare("SELECT COUNT(*) AS n FROM flows WHERE agent_id = ?").get(agentId) as { n: number }).n;
}

describe("flow and journal atomicity", () => {
  it("keeps duplicate retries successful without duplicating the audit contribution", async () => {
    const id = await agent();
    const deposit = flow(id);
    assert.equal(await store.addFlow(deposit), true);
    assert.equal(await store.addFlow({ ...deposit, txHash: deposit.txHash!.toUpperCase() }), true);
    // Even a changed retry payload must not manufacture a journal-only flow.
    assert.equal(await store.addFlow({ ...deposit, amountUsdg: 999 }), true);
    const journal = await store.readJournal(id, 1);
    assert.equal(flowCount(id), 1);
    assert.equal(journal.length, 1);
    assert.equal(await store.getNetContributionsUsdg(id), 100);
    assert.equal(reconstruct(journal).netContributionsUsdg, 100);
    assert.deepEqual(verifyChain(journal), []);
  });

  it("deduplicates concurrent retries and chains distinct concurrent flows once each", async () => {
    const id = await agent();
    const deposit = flow(id);
    const results = await Promise.all([
      ...Array.from({ length: 8 }, () => store.addFlow(deposit)),
      store.addFlow({ ...deposit, logIndex: 3, amountUsdg: 25 }),
      store.addFlow({ ...deposit, logIndex: 4, direction: "out", amountUsdg: 10 }),
    ]);
    assert.ok(results.every(Boolean));
    const journal = await store.readJournal(id, 1);
    assert.equal(flowCount(id), 3);
    assert.equal(journal.length, 3);
    assert.equal(await store.getNetContributionsUsdg(id), 115);
    assert.equal(reconstruct(journal).netContributionsUsdg, 115);
    assert.deepEqual(verifyChain(journal), []);
  });

  it("preserves separate chain identities for the same transaction hash and log index", async () => {
    const id = await agent();
    const deposit = flow(id);
    await store.addFlow({ ...deposit, chainId: 4663 });
    await store.addFlow({ ...deposit, chainId: 46630 });
    assert.equal(flowCount(id), 2);
    assert.equal((await store.readJournal(id, 1)).length, 2);
  });

  it("rolls back a flow if its journal write fails, then permits a clean retry", async () => {
    const id = await agent();
    raw.exec("CREATE TRIGGER fail_journal BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END");
    try {
      assert.equal(await store.addFlow(flow(id)), false);
      assert.equal(flowCount(id), 0);
      assert.equal((await store.readJournal(id, 1)).length, 0);
    } finally {
      raw.exec("DROP TRIGGER fail_journal");
    }
    assert.equal(await store.addFlow(flow(id)), true);
    assert.equal(flowCount(id), 1);
    assert.equal((await store.readJournal(id, 1)).length, 1);
  });
});

describe("epoch rollover atomicity", () => {
  for (const table of ["flows", "journal"] as const) {
    it(`rolls back the epoch when the ${table} insert fails`, async () => {
      const id = await agent();
      raw.exec(`CREATE TRIGGER fail_carry BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected carry failure'); END`);
      try {
        await assert.rejects(store.openNextEpoch(id, 100), /injected carry failure/);
        assert.equal(await store.getAgentEpoch(id), 1);
        assert.equal(flowCount(id), 0);
        assert.equal((await store.readJournal(id, 2)).length, 0);
      } finally {
        raw.exec("DROP TRIGGER fail_carry");
      }
      assert.equal(await store.openNextEpoch(id, 100), 2);
      assert.equal(await store.getAgentEpoch(id), 2);
      assert.equal(await store.getNetContributionsUsdg(id), 100);
      const journal = await store.readJournal(id, 2);
      assert.equal(journal.length, 1);
      assert.equal(reconstruct(journal).netContributionsUsdg, 100);
      assert.deepEqual(verifyChain(journal), []);
    });
  }

  it("serializes concurrent rollovers instead of writing two carries into one epoch", async () => {
    const id = await agent();
    assert.deepEqual(await Promise.all([
      store.openNextEpoch(id, 100),
      store.openNextEpoch(id, 100),
    ]), [2, 3]);
    assert.equal(await store.getAgentEpoch(id), 3);
    assert.equal(flowCount(id), 2);
    assert.equal((await store.readJournal(id, 2)).length, 1);
    assert.equal((await store.readJournal(id, 3)).length, 1);
  });

  it("books a queued flow in the completed new epoch", async () => {
    const id = await agent();
    const [epoch, inserted] = await Promise.all([
      store.openNextEpoch(id, 100),
      store.addFlow({ ...flow(id), amountUsdg: 25 }),
    ]);
    assert.equal(epoch, 2);
    assert.equal(inserted, true);
    assert.equal((await store.readJournal(id, 1)).length, 0);
    assert.equal(await store.getNetContributionsUsdg(id), 125);
    assert.equal(reconstruct(await store.readJournal(id, 2)).netContributionsUsdg, 125);
  });

  it("advances a paper reset without recording its simulated opening balance as capital", async () => {
    const id = await agent();
    raw.prepare("UPDATE agents SET mode = 'paper' WHERE smart_account = ?").run(id);
    assert.equal(await store.openNextEpoch(id, 1000), 2);
    assert.equal(await store.getAgentEpoch(id), 2);
    assert.equal(flowCount(id), 0);
    assert.equal((await store.readJournal(id, 2)).length, 0);
  });

  it("refuses to publish an epoch for an agent that does not exist", async () => {
    await assert.rejects(store.openNextEpoch("missing", 100), /unknown agent/);
    assert.equal(flowCount("missing"), 0);
  });
});
