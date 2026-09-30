/**
 * withAdvisoryLock — one holder at a time. On sqlite the lock is this
 * process's queue alone, and that queue is also what a Postgres pool puts in
 * front of its advisory lock, so the rules a caller in one process meets are
 * all here. The Postgres half (the lock across two pools, on the connection
 * it hands to the holder) is run against a real database in
 * telegram-fix.postgres.test.ts.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { describe, it } from "node:test";
import { advisoryLockWaitersForTest, LockBusyError, withAdvisoryLock, wrapSqlite, type Db } from "./db";

const CLS = 1_297_692_130;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
/** Wait for a state, never for a count of turns: polled each turn, failing only after a real-time bound. */
async function until(what: string, ok: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`never reached: ${what}`);
    await setImmediate();
  }
}
const sqlite = (): Db => wrapSqlite(new DatabaseSync(":memory:"));

describe("withAdvisoryLock", () => {
  it("HOLDERS TAKE TURNS: the second waits until the first is done, and runs on the Db it is handed", async () => {
    const db = sqlite();
    const release = deferred();
    const entered = deferred();
    const log: string[] = [];
    const first = withAdvisoryLock(db, CLS, 7, async (d) => {
      assert.equal(d, db, "on sqlite, the Db itself");
      log.push("first in");
      entered.resolve();
      await release.promise;
      log.push("first out");
      return 1;
    });
    await entered.promise;
    const second = withAdvisoryLock(db, CLS, 7, async () => {
      log.push("second in");
      return 2;
    });
    await until("the second queued behind the first", () => advisoryLockWaitersForTest(db, CLS, 7) === 1);
    assert.deepEqual(log, ["first in"]);
    release.resolve();
    assert.deepEqual(await Promise.all([first, second]), [1, 2]);
    assert.deepEqual(log, ["first in", "first out", "second in"]);
    assert.equal(advisoryLockWaitersForTest(db, CLS, 7), 0);
  });

  it("A HOLDER THAT THROWS LETS GO: the next one runs, and the error is the holder's own", async () => {
    const db = sqlite();
    await assert.rejects(
      withAdvisoryLock(db, CLS, 7, async () => {
        throw new Error("holder failed");
      }),
      /holder failed/,
    );
    assert.equal(await withAdvisoryLock(db, CLS, 7, async () => "next"), "next");
  });

  it("A CALLER THAT GIVES UP GETS LockBusyError, AND THE ONE BEHIND IT STILL WAITS FOR THE HOLDER, not for it", async () => {
    const db = sqlite();
    const release = deferred();
    const entered = deferred();
    let holderDone = false;
    const holder = withAdvisoryLock(db, CLS, 7, async () => {
      entered.resolve();
      await release.promise;
      holderDone = true;
    });
    await entered.promise;
    const quitter = withAdvisoryLock(db, CLS, 7, async () => assert.fail("never runs"), 20);
    let thirdRanAfterHolder: boolean | null = null;
    const third = withAdvisoryLock(db, CLS, 7, async () => {
      thirdRanAfterHolder = holderDone;
    });
    await assert.rejects(quitter, (e: unknown) => e instanceof LockBusyError);
    // The quitter has gone; the third is still waiting on the holder.
    await until("the third alone waiting", () => advisoryLockWaitersForTest(db, CLS, 7) === 1);
    assert.equal(thirdRanAfterHolder, null);
    release.resolve();
    await Promise.all([holder, third]);
    assert.equal(thirdRanAfterHolder, true);
  });

  it("ANOTHER KEY, OR ANOTHER DATABASE, DOES NOT WAIT", async () => {
    const db = sqlite();
    const other = sqlite();
    const release = deferred();
    const entered = deferred();
    const holder = withAdvisoryLock(db, CLS, 7, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    assert.equal(await withAdvisoryLock(db, CLS, 8, async () => "other key"), "other key");
    assert.equal(await withAdvisoryLock(db, CLS + 1, 7, async () => "other class"), "other class");
    assert.equal(await withAdvisoryLock(other, CLS, 7, async () => "other db"), "other db");
    release.resolve();
    await holder;
  });
});
