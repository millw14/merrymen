/**
 * THE SHARED-TABLE HALF OF THE COMMAND CHANNEL.
 *
 * Hosted only, and only the leg between the dashboard and the orchestrator:
 * the web writes here, the orchestrator ferries into each child home as a
 * file, and the child claims by unlinking it (command-files.ts). Children
 * cannot read this table — CHILD_SECRET_STRIP removes DATABASE_URL on purpose.
 *
 * READ THIS BEFORE TRUSTING IT. These tests drive enqueue and claim against ONE
 * store handle with ONE constant key, so they prove the SQL and nothing about
 * the seam the feature crosses. The first version of this channel passed every
 * one of them while being completely non-functional hosted — the row went to
 * Postgres under the tenant wallet, and the child queried its own sqlite for a
 * smart account. Both defects were invisible here by construction.
 *
 * The seam is covered by command-files.ts, with real directories and a real
 * unlink. `claimCommand` below is retained for the self-hosted single-process
 * case and as the orchestrator ferry deliverable-marking primitive.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-cmd-"));
process.env.MERRYMEN_HOME = HOME;

const { closeStoreForTest, initStore, enqueueCommand, claimCommand, finishCommand, latestCommand } = await import("./store");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");

const AGENT = "0xagent0000000000000000000000000000000001";
const OTHER = "0xagent0000000000000000000000000000000002";
/** Its own agent, so the forced-tie rows cannot disturb the ordering tests above. */
const TIED = "0xagent0000000000000000000000000000000003";

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("the agent command queue", () => {
  it("initialises", async () => {
    await initStore();
  });

  it("a queued command can be claimed exactly once", async () => {
    assert.equal(await enqueueCommand(AGENT, "cmd-1", "selftest"), true);
    const first = await claimCommand(AGENT);
    assert.equal(first?.id, "cmd-1");
    // THE WHOLE POINT. A second drain — a restarted worker, an overlapping
    // tick — must get nothing, not the same command again.
    assert.equal(await claimCommand(AGENT), null, "a claimed command must never be handed out twice");
  });

  it("a crash after the claim leaves it claimed, not replayed", async () => {
    // Simulated by never calling finishCommand. The row stays claimed and
    // undone — recoverable by a human looking at it, and crucially NOT
    // re-executed. For an operation that spends gas, at-most-once beats
    // at-least-once every time.
    const st = await latestCommand(AGENT);
    assert.ok(st);
    assert.ok(st.claimedAt !== null, "claimed");
    assert.equal(st.doneAt, null, "and never completed");
    assert.equal(await claimCommand(AGENT), null, "still not replayed");
  });

  it("a duplicate id is refused rather than queued twice", async () => {
    // The primary key does the deduping, so a retried POST cannot become two
    // UserOperations. A check-then-insert could interleave; this cannot.
    assert.equal(await enqueueCommand(AGENT, "cmd-1", "selftest"), false);
  });

  it("commands are scoped to their agent", async () => {
    // One tenant must never drain another's queue. On a shared hosted database
    // this is the difference between a probe and someone else's gas.
    await enqueueCommand(OTHER, "cmd-2", "selftest");
    assert.equal(await claimCommand(AGENT), null, "AGENT has nothing unclaimed left");
    const mine = await claimCommand(OTHER);
    assert.equal(mine?.id, "cmd-2");
  });

  it("oldest first, so a queue is a queue", async () => {
    await enqueueCommand(AGENT, "cmd-3", "selftest");
    await enqueueCommand(AGENT, "cmd-4", "selftest");
    assert.equal((await claimCommand(AGENT))?.id, "cmd-3");
    assert.equal((await claimCommand(AGENT))?.id, "cmd-4");
  });

  it("finishing records the outcome without re-running anything", async () => {
    await finishCommand("cmd-4", "PASSED — a signed UserOperation reached the chain");
    const st = await latestCommand(AGENT);
    assert.equal(st?.id, "cmd-4");
    assert.equal(st?.doneAt !== null, true);
    assert.match(String(st?.result), /PASSED/);
    // And a finished command is not claimable again.
    assert.equal(await claimCommand(AGENT), null);
  });

  it("the result is bounded — reject_rule taught us that lesson already", async () => {
    await enqueueCommand(AGENT, "cmd-5", "selftest");
    await claimCommand(AGENT);
    await finishCommand("cmd-5", "x".repeat(5_000));
    const st = await latestCommand(AGENT);
    assert.ok((st?.result?.length ?? 0) <= 500, "an unbounded string in a status column is how cardinality explodes");
  });

  it("an unknown command kind is recorded, not executed", async () => {
    // The channel is deliberately dumb: it carries a string, and the drain
    // decides what is executable. A kind nobody handles must leave a trace
    // rather than vanishing, or a typo looks identical to a queue that is not
    // being drained at all.
    await enqueueCommand(AGENT, "cmd-6", "launch-the-missiles");
    const c = await claimCommand(AGENT);
    assert.equal(c?.kind, "launch-the-missiles");
    await finishCommand("cmd-6", "unknown command 'launch-the-missiles'");
    assert.match(String((await latestCommand(AGENT))?.result), /unknown command/);
  });
  it("commands landing in the SAME MILLISECOND still have one agreed order", async () => {
    // CI found this on a faster machine than mine: milliseconds fixed the
    // one-second collisions and did not fix ties. Neither backend has a
    // portable insertion-order tiebreak — sqlite's rowid is not in Postgres —
    // so the id breaks it. Arbitrary but CONSISTENT is all a queue needs; what
    // matters is that claimCommand and latestCommand pick the SAME row rather
    // than each choosing its own.
    //
    // The timestamp is written by hand here. My first attempt fired three
    // enqueues through Promise.all and assumed they would collide; they did
    // not — one landed a millisecond earlier and was ordered first, correctly.
    // A test for tie-breaking has to guarantee the tie, not hope for it.
    const raw = new DatabaseSync(homePaths.db());
    const SAME = 1_800_000_000_000;
    try {
      for (const id of ["tie-c", "tie-a", "tie-b"]) {
        raw
          .prepare("INSERT INTO agent_commands (id, agent_id, kind, created_at) VALUES (?, ?, ?, ?)")
          .run(id, TIED, "selftest", SAME);
      }
    } finally {
      // A second handle on the ledger outlives this test unless it is closed, and
      // Windows will not delete a file that anything still holds.
      raw.close();
    }
    const drained: string[] = [];
    for (;;) {
      const c = await claimCommand(TIED);
      if (!c) break;
      drained.push(c.id);
    }
    assert.deepEqual(drained, ["tie-a", "tie-b", "tie-c"], "a total order, not whatever the page returns");
    // And the two queries agree about which one is newest.
    assert.equal((await latestCommand(TIED))?.id, "tie-c");
  });
});
