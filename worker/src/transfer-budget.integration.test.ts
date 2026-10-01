import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { transferBudgetRefusal } from "./transfer-budget";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-transfer-budget-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const store = await import("./store");
const previousCwd = process.cwd();
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(previousCwd);
}
after(() => {
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const OTHER = "0x00000000000000000000000000000000000000a2";
const AGED = "0x00000000000000000000000000000000000000a3";
const TARGET = "0x00000000000000000000000000000000000000b1";
let nextHash = 1;
const hash = () => `0x${(nextHash++).toString(16).padStart(64, "0")}`;
const write = (agent: string, amount: number, status: "landed" | "submitted" | "reverted" | "rejected" | "paper" | "dropped", userOpHash = hash()) =>
  store.addTrade({ agent_id: agent, kind: "transfer", target: TARGET, amount_usdg: amount, status, user_op_hash: userOpHash });

describe("the transfer sub-budget", () => {
  it("reserves a submitted transfer, keeps it through restart, and counts settlement only once", async () => {
    const pending = hash();
    assert.equal(await write(ACCOUNT, 50, "submitted", pending), true);
    assert.equal(await store.getTransferredTodayUsdg(ACCOUNT), 50);
    assert.match(transferBudgetRefusal(50_000_000n, await store.getTransferredTodayUsdg(ACCOUNT), 50)!, /daily transfer limit/);

    store.closeStoreForTest();
    await store.initStore();
    assert.equal(await store.getTransferredTodayUsdg(ACCOUNT), 50, "a worker restart does not forget a locally persisted pending transfer");
    assert.equal(await write(ACCOUNT, 50, "landed", pending), true);
    assert.equal(await store.getTransferredTodayUsdg(ACCOUNT), 50, "settlement resolves the reservation rather than charging twice");
    assert.equal(transferBudgetRefusal(1n, await store.getTransferredTodayUsdg(ACCOUNT), 50) !== null, true);
  });

  it("only releases a pending charge on a terminal no-spend outcome", async () => {
    for (const status of ["reverted", "dropped"] as const) {
      const pending = hash();
      assert.equal(await write(OTHER, 20, "submitted", pending), true);
      assert.equal(await store.getTransferredTodayUsdg(OTHER), 20);
      assert.equal(await write(OTHER, 20, status, pending), true);
      assert.equal(await store.getTransferredTodayUsdg(OTHER), 0);
    }
    await write(OTHER, 100, "rejected");
    await write(OTHER, 100, "paper");
    assert.equal(await store.getTransferredTodayUsdg(OTHER), 0);
    assert.equal(await store.getTransferredTodayUsdg(ACCOUNT), 50, "another account's outcomes cannot release this account's allowance");
  });

  it("keeps old unresolved transfers reserved and charges late settlement for a fresh 24 hours", async () => {
    const pending = hash();
    await write(AGED, 50, "submitted", pending);
    const raw = new DatabaseSync(path.join(scratch, "home", "merrymen.db"));
    try {
      raw.prepare("UPDATE trades SET created_at = unixepoch() - 172800 WHERE user_op_hash = ?").run(pending);
      const created = (raw.prepare("SELECT created_at FROM trades WHERE user_op_hash = ?").get(pending) as { created_at: number }).created_at;
      for (const read of [store.getTransferredTodayUsdg, store.getSpentTodayUsdg]) assert.equal(await read(AGED), 50);
      assert.equal(await store.getOpsToday(AGED), 1);
      await write(AGED, 50, "landed", pending);
      const settled = raw.prepare("SELECT created_at, budget_settled_at FROM trades WHERE user_op_hash = ?").get(pending) as { created_at: number; budget_settled_at: number };
      assert.equal(settled.created_at, created, "submission provenance remains unchanged");
      assert.ok(settled.budget_settled_at >= Math.floor(Date.now() / 1000) - 5);
      for (const read of [store.getTransferredTodayUsdg, store.getSpentTodayUsdg]) assert.equal(await read(AGED), 50);
      assert.equal(await store.getOpsToday(AGED), 1);
      raw.prepare("UPDATE trades SET budget_settled_at = unixepoch() - 86401 WHERE user_op_hash = ?").run(pending);
      for (const read of [store.getTransferredTodayUsdg, store.getSpentTodayUsdg]) assert.equal(await read(AGED), 0);
      assert.equal(await store.getOpsToday(AGED), 0);
    } finally { raw.close(); }
  });

  it("judges the exact micro-unit boundary and refuses unreadable counters", () => {
    assert.equal(transferBudgetRefusal(1n, 49.999999, 50), null);
    assert.match(transferBudgetRefusal(2n, 49.999999, 50)!, /daily transfer limit/);
    for (const unreadable of [NaN, Infinity, -1]) {
      assert.match(transferBudgetRefusal(1n, unreadable, 50)!, /could not be verified/);
      assert.match(transferBudgetRefusal(1n, 0, unreadable)!, /could not be verified/);
    }
  });

  it("checks the allowance inside the existing serialized execution boundary", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function processIntentLocked(");
    const lookup = source.indexOf("await getTransferredTodayUsdg(agentId)");
    const send = source.indexOf("const send = (calls: Call[])", start);
    assert.ok(start >= 0 && lookup > start && lookup < send, "the actual allowance read precedes submission inside the locked intent body");
    const transfer = source.slice(source.indexOf("async function submitChatTransfer("), source.indexOf("async function submitChatTransfer(") + 2500);
    assert.doesNotMatch(transfer, /getTransferredTodayUsdg/, "a caller-side read must not authorize a queued transfer");
    assert.match(transfer, /await processIntentReporting\(/);
    assert.match(transfer, /outcome\?\.rejectRule === "transfer-daily-cap"/);
  });
});
