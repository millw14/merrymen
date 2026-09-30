/**
 * ONE OPERATION IS ONE ROW, proven against a real sqlite file.
 *
 * The durable pre-broadcast write (executor.ts's onSubmitted hook) puts a
 * 'submitted' row in the ledger the instant the op leaves. The outcome then
 * arrives later and has to land on THAT row: insert instead, and one operation
 * has two rows, the second of which counts against the daily cap a second time.
 *
 * This cannot be a unit test. The resolution is a SQL UPDATE scoped to
 * (agent_id, user_op_hash, status='submitted'), and every way it can be wrong —
 * a clause that doesn't match, a status guard that lets a settled row be
 * rewritten, an epoch that moves — is invisible to anything that doesn't run
 * the statement. That is the same reason budget-rails.integration.test.ts
 * exists: its bug was a SQL status list too.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-inflight-"));
process.env.MERRYMEN_HOME = HOME;

const { closeStoreForTest, initStore, addTrade, energyBuysInFlight, getOpsToday, getSpentTodayUsdg, listOpHashes, listSubmittedOps, opsSignedWithNonce } =
  await import("./store");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");

const AGENT = "0xagent0000000000000000000000000000000001";
const HASH = "0xfeed00000000000000000000000000000000000000000000000000000000beef";
const OTHER = "0xdead00000000000000000000000000000000000000000000000000000000cafe";

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// Opened per call and CLOSED per call: this helper runs eleven times, and a
// handle left behind by each is eleven reasons Windows cannot delete HOME.
const rows = (hash: string) => {
  const raw = new DatabaseSync(homePaths.db());
  try {
    return raw
      .prepare("SELECT status, tx_hash, amount_usdg, epoch FROM trades WHERE agent_id = ? AND user_op_hash = ?")
      .all(AGENT, hash) as { status: string; tx_hash: string | null; amount_usdg: number; epoch: number }[];
  } finally {
    raw.close();
  }
};

const submitted = (hash: string, amount: number) =>
  addTrade({
    agent_id: AGENT,
    kind: "swap",
    target: "0xrouter000000000000000000000000000000001",
    amount_usdg: amount,
    user_op_hash: hash,
    status: "submitted",
  });

describe("the pre-broadcast row and the outcome are the same row", () => {
  it("initialises", async () => {
    await initStore();
  });

  it("a landed outcome RESOLVES the placeholder — it does not sit beside it", async () => {
    assert.equal(await submitted(HASH, 10), true);
    assert.equal(rows(HASH).length, 1, "the placeholder is there before the outcome");
    assert.equal(rows(HASH)[0]!.status, "submitted");

    assert.equal(
      await addTrade({
        agent_id: AGENT,
        kind: "swap",
        target: "0xrouter000000000000000000000000000000001",
        amount_usdg: 10,
        user_op_hash: HASH,
        tx_hash: "0xabc",
        status: "landed",
        fill_side: "buy",
      }),
      true,
    );

    const after1 = rows(HASH);
    assert.equal(after1.length, 1, "ONE operation, ONE row — a second would double-count the cap");
    assert.equal(after1[0]!.status, "landed");
    assert.equal(after1[0]!.tx_hash, "0xabc", "and it carries what the outcome learned");
  });

  it("the cap counts that operation once, not twice", async () => {
    // The reason the row count matters, stated in the units that bite. Both
    // 'landed' and 'submitted' are on the live rail, so a duplicate is a real
    // op and a real $10 the agent never spent.
    assert.equal(await getOpsToday(AGENT, "live"), 1);
    assert.equal(await getSpentTodayUsdg(AGENT, "live"), 10);
  });

  it("a SETTLED row can never be rewritten by a late duplicate", async () => {
    // The status guard, which is the difference between resolving a placeholder
    // and letting anything holding a hash overwrite history. A reconciler
    // arriving late with the same hash must not be able to move a landed row.
    await addTrade({
      agent_id: AGENT,
      kind: "swap",
      target: "0xrouter000000000000000000000000000000001",
      amount_usdg: 999,
      user_op_hash: HASH,
      status: "reverted",
      reject_rule: "a late arrival",
    });
    const all = rows(HASH);
    assert.equal(all.length, 2, "it inserts instead — visible, not silent");
    assert.equal(all[0]!.status, "landed", "and the settled row is untouched");
    assert.equal(all[0]!.amount_usdg, 10);
  });

  it("an outcome with no placeholder just inserts, which is every ordinary row", async () => {
    // Rejections, paper fills and failures BEFORE submission never had an
    // in-flight phase and carry no hash. The UPDATE must not swallow them.
    assert.equal(
      await addTrade({
        agent_id: AGENT,
        kind: "swap",
        target: "0xrouter000000000000000000000000000000001",
        amount_usdg: 5,
        user_op_hash: OTHER,
        status: "reverted",
        reject_rule: "couldn't submit: AA21",
      }),
      true,
    );
    assert.equal(rows(OTHER).length, 1);
    assert.equal(rows(OTHER)[0]!.status, "reverted");
  });

  it("resolving does not move the row's epoch", async () => {
    // The row belongs to the epoch it was SUBMITTED in. Moving it would make the
    // export's boundary disagree with the chain's ordering, and the export is
    // the thing a stranger is meant to be able to verify.
    const landed = rows(HASH).find((r) => r.status === "landed")!;
    const late = rows(HASH).find((r) => r.status === "reverted")!;
    assert.equal(landed.epoch, late.epoch, "same epoch here because no boundary was opened between them");
    assert.ok(Number.isInteger(landed.epoch));
  });
});

/**
 * THE REGRESSION, ASSERTED AGAINST REAL SQL.
 *
 * The pre-broadcast row and the orphan sweep were built a day apart and did not
 * fit: `listOpHashes` selected every non-null user_op_hash regardless of status,
 * and `findOrphanOps` skips any hash in that set. So the row the sweep exists to
 * finish was precisely the one it filtered out.
 *
 * This cannot be a unit test — the bug was a missing WHERE clause, and a clause
 * that is not run is a clause that cannot be wrong.
 */
describe("an in-flight row is not mistaken for a settled one", () => {
  const IN_FLIGHT = "0xaaaa000000000000000000000000000000000000000000000000000000000001";
  const SETTLED = "0xbbbb000000000000000000000000000000000000000000000000000000000002";
  const REFUSED = "0xcccc000000000000000000000000000000000000000000000000000000000003";

  it("sets up one row of each status", async () => {
    await submitted(IN_FLIGHT, 10);
    await submitted(SETTLED, 20);
    await addTrade({
      agent_id: AGENT,
      kind: "swap",
      target: "0xrouter000000000000000000000000000000001",
      amount_usdg: 20,
      user_op_hash: SETTLED,
      tx_hash: "0xdone",
      status: "landed",
    });
    await addTrade({
      agent_id: AGENT,
      kind: "swap",
      target: "0xrouter000000000000000000000000000000001",
      amount_usdg: 30,
      user_op_hash: REFUSED,
      status: "reverted",
      reject_rule: "the chain said no",
    });
    assert.equal(rows(IN_FLIGHT)[0]!.status, "submitted");
    assert.equal(rows(SETTLED)[0]!.status, "landed");
  });

  it("listOpHashes reports the SETTLED ones, so the sweep can skip them", async () => {
    const known = await listOpHashes(AGENT);
    assert.ok(known.has(SETTLED.toLowerCase()), "a landed op is accounted for");
    // The original reasoning, still right and still load-bearing: a hash
    // recorded as reverted must not be re-reconciled as landed.
    assert.ok(known.has(REFUSED.toLowerCase()), "so is a reverted one");
  });

  it("and NOT the in-flight one — this is the whole bug", async () => {
    const known = await listOpHashes(AGENT);
    assert.equal(
      known.has(IN_FLIGHT.toLowerCase()),
      false,
      "a 'submitted' row is a claim that an op left, with no outcome — it is by definition not accounted for",
    );
  });

  it("listSubmittedOps returns it, with what the resolver needs to settle it", async () => {
    const open = await listSubmittedOps(AGENT);
    const mine = open.find((o) => o.userOpHash === IN_FLIGHT.toLowerCase());
    assert.ok(mine, "the ledger row IS the recovery record — nothing else holds this hash");
    assert.equal(mine.kind, "swap");
    assert.equal(mine.amountUsdg, 10);
    assert.ok(Number.isInteger(mine.epoch), "the epoch it was submitted in, for the boundary check");
    assert.ok(mine.createdAt > 0);
    // Settled rows must not appear here, or the resolver would re-ask the chain
    // about ops it already has answers for, every pass, forever.
    assert.equal(open.some((o) => o.userOpHash === SETTLED.toLowerCase()), false);
    assert.equal(open.some((o) => o.userOpHash === REFUSED.toLowerCase()), false);
  });

  it("the two sets are disjoint, which is what lets both sweeps run", async () => {
    const known = await listOpHashes(AGENT);
    const open = (await listSubmittedOps(AGENT)).map((o) => o.userOpHash);
    for (const h of open) {
      assert.equal(known.has(h), false, `${h} cannot be in both, or the sweeps would both act on it`);
    }
  });

  it("resolving one moves it from the open set to the known set", async () => {
    await addTrade({
      agent_id: AGENT,
      kind: "swap",
      target: "0xrouter000000000000000000000000000000001",
      amount_usdg: 10,
      user_op_hash: IN_FLIGHT,
      tx_hash: "0xresolved",
      status: "landed",
    });
    assert.equal(rows(IN_FLIGHT).length, 1, "still one row — resolved in place");
    assert.ok((await listOpHashes(AGENT)).has(IN_FLIGHT.toLowerCase()));
    assert.equal(
      (await listSubmittedOps(AGENT)).some((o) => o.userOpHash === IN_FLIGHT.toLowerCase()),
      false,
      "and it stops being re-asked about",
    );
  });
});

/**
 * A 'dropped' ROW: an op the chain can never execute (another op of ours spent
 * its nonce — inflight-reconcile.ts findDroppedOps). Every reader that counts
 * spend or in-flight work must see it as what it is: nothing moved.
 */
describe("a dropped op is terminal, and nothing counts it", () => {
  const AGENT2 = "0xagent0000000000000000000000000000000002";
  const DROPPED = "0xdddd000000000000000000000000000000000000000000000000000000000004";
  const RIVAL = "0xeeee000000000000000000000000000000000000000000000000000000000005";
  const NONCE = (0x0102n << 240n) | 9n;
  const rowsOf = (hash: string) => {
    const raw = new DatabaseSync(homePaths.db());
    try {
      return raw.prepare("SELECT status FROM trades WHERE agent_id = ? AND user_op_hash = ?").all(AGENT2, hash) as { status: string }[];
    } finally {
      raw.close();
    }
  };
  const row = (status: "submitted" | "landed" | "dropped", hash: string, extra: Record<string, unknown> = {}) =>
    addTrade({
      agent_id: AGENT2,
      kind: "energy-buy",
      target: "0xrouter000000000000000000000000000000001",
      sell_token: "0xusdg",
      buy_token: "0xmerrymen",
      amount_usdg: 10,
      user_op_hash: hash,
      status,
      ...extra,
    } as never);

  it("the pre-broadcast row keeps the nonce it was signed with, through its resolution", async () => {
    assert.equal(await row("submitted", DROPPED, { user_op_nonce: NONCE.toString() }), true);
    assert.equal(await row("submitted", RIVAL, { user_op_nonce: NONCE.toString() }), true);
    assert.equal((await listSubmittedOps(AGENT2)).find((o) => o.userOpHash === DROPPED)!.nonce, NONCE);
    await row("landed", RIVAL, { tx_hash: "0xrival" });
    assert.deepEqual(await opsSignedWithNonce(AGENT2, NONCE, DROPPED), [RIVAL], "the landed rival kept its nonce");
    assert.deepEqual(await opsSignedWithNonce(AGENT2, NONCE, RIVAL), [DROPPED]);
    assert.deepEqual(await opsSignedWithNonce(AGENT2, NONCE + 1n, DROPPED), []);
    assert.equal(await getSpentTodayUsdg(AGENT2, "live"), 20, "both charge the live rail while one is in flight");
    assert.equal(await energyBuysInFlight(AGENT2, 0), true);
  });

  it("written off, it charges no cap, holds nothing in flight, and cannot be rewritten", async () => {
    await row("dropped", DROPPED, { reject_rule: "dropped: a later op used its nonce (resolved)" });
    assert.equal(rowsOf(DROPPED).length, 1, "resolved in place");
    assert.equal(rowsOf(DROPPED)[0]!.status, "dropped");
    assert.equal(await getSpentTodayUsdg(AGENT2, "live"), 10, "only the op that executed is spend");
    assert.equal(await getOpsToday(AGENT2, "live"), 1);
    assert.equal(await energyBuysInFlight(AGENT2, 0), false, "and the next energy ask is not blocked by it");
    assert.deepEqual(await listSubmittedOps(AGENT2), []);
  });

  it("its hash stays OUT of the known set, so the orphan sweep would still count an execution the proof rules out", async () => {
    const known = await listOpHashes(AGENT2);
    assert.equal(known.has(DROPPED), false);
    assert.equal(known.has(RIVAL), true);
    // And what that sweep would write can never rewrite the dropped row — only
    // 'submitted' is ever updated — so it lands BESIDE it, counted, visible.
    await row("landed", DROPPED, { tx_hash: "0xlate" });
    assert.deepEqual(rowsOf(DROPPED).map((r) => r.status), ["dropped", "landed"]);
    assert.equal(await getSpentTodayUsdg(AGENT2, "live"), 20);
  });
});
