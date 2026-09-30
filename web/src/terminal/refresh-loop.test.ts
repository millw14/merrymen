/**
 * THE SHELL KEEPS ASKING, AND SAYS SO.
 *
 * App's refresh returned early until the first load had succeeded, so a first
 * load that failed was never retried: the owner sat under a raw "signal timed
 * out" until they found the button. And a later success never cleared the
 * alert, so a healthy screen went on announcing an outage that had ended.
 *
 * Driven with a fake clock, because the property is the schedule itself.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { failureCopy, nextRefreshIn, startRefreshLoop, type LoopState } from "./refresh-loop";

/** A clock that only moves when told to, and records what was scheduled. */
function fakeClock() {
  let now = 1_000_000;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      setTimeout(fn: () => void, ms: number) {
        const id = ++seq;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout(h: unknown) {
        pending.delete(h as number);
      },
      now: () => now,
    },
    /** Milliseconds until the next scheduled timer, or null when none is. */
    nextIn(): number | null {
      const next = [...pending.values()].sort((a, b) => a.at - b.at)[0];
      return next ? next.at - now : null;
    },
    /** Jump to the next timer and fire it. */
    async fire() {
      const [id, next] = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0]!;
      pending.delete(id);
      now = next.at;
      next.fn();
      await settle();
    },
    pendingCount: () => pending.size,
  };
}
/** Let the pass's promise chain run to completion. */
const settle = () => new Promise<void>((r) => setImmediate(r));

function loop(results: Array<boolean | Error | Promise<boolean>>, paused = () => false) {
  const clock = fakeClock();
  const reports: LoopState[] = [];
  let calls = 0;
  const handle = startRefreshLoop({
    pass: async () => {
      const r = results[Math.min(calls++, results.length - 1)]!;
      if (r instanceof Error) throw r;
      return r;
    },
    report: (s) => reports.push(s),
    paused,
    timers: clock.timers,
  });
  return { clock, reports, handle, calls: () => calls };
}

describe("the shell's refresh schedule", () => {
  it("backs off 5s, 15s, 60s after failures and holds at 60s", () => {
    assert.deepEqual([1, 2, 3, 4, 9].map(nextRefreshIn), [5_000, 15_000, 60_000, 60_000, 60_000]);
    assert.equal(nextRefreshIn(0), 60_000, "a healthy shell refreshes once a minute, as before");
  });

  it("retries a FIRST load that failed, on the backoff", async () => {
    const { clock, calls } = loop([false]);
    await settle();
    assert.equal(calls(), 1);
    assert.equal(clock.nextIn(), 5_000, "the retry after a failed first load is 5s away, not never");
    await clock.fire();
    assert.equal(calls(), 2, "and it actually runs");
    assert.equal(clock.nextIn(), 15_000);
    await clock.fire();
    assert.equal(clock.nextIn(), 60_000);
    await clock.fire();
    assert.equal(clock.nextIn(), 60_000);
  });

  it("reports healthy again on the first success, and resets the backoff", async () => {
    const { clock, reports } = loop([false, false, true]);
    await settle();
    await clock.fire();
    await clock.fire();
    const last = reports.at(-1)!;
    assert.equal(last.failuresInARow, 0, "a success clears the failure the screen is showing");
    assert.equal(last.lastOkAt, clock.timers.now());
    assert.equal(clock.nextIn(), 60_000);
    assert.deepEqual(
      reports.map((r) => r.failuresInARow),
      [1, 2, 0],
    );
  });

  it("counts a pass that threw as a failure, and keeps going", async () => {
    const { clock, reports, calls } = loop([new Error("boom"), true]);
    await settle();
    assert.equal(reports[0]!.failuresInARow, 1);
    assert.equal(clock.nextIn(), 5_000);
    await clock.fire();
    assert.equal(calls(), 2);
    assert.equal(reports.at(-1)!.failuresInARow, 0);
  });

  it("never runs two passes at once, however often Retry is pressed", async () => {
    let release!: (v: boolean) => void;
    const slow = new Promise<boolean>((r) => (release = r));
    const { handle, calls, clock } = loop([slow, true]);
    handle.retryNow();
    handle.retryNow();
    assert.equal(calls(), 1, "a retry while a pass is in flight is not a second pass beside it");
    release(false);
    await settle();
    await settle();
    // Queued, not dropped: the pass in flight began before whatever the
    // person is asking about, so its answer cannot be the one they asked for.
    assert.equal(calls(), 2, "it is ONE more pass after the one in flight, however often it was pressed");
    assert.equal(clock.pendingCount(), 1, "one next pass is scheduled, not one per press");
    handle.retryNow();
    await settle();
    assert.equal(calls(), 3, "once the passes have finished, Retry runs one now");
    assert.equal(clock.pendingCount(), 1, "and replaces the scheduled one rather than adding to it");
  });

  it("skips the work while the tab is hidden, without dying", async () => {
    let hidden = false;
    const { clock, calls } = loop([true], () => hidden);
    await settle();
    hidden = true;
    await clock.fire();
    assert.equal(calls(), 1, "no request from a hidden tab");
    assert.equal(clock.nextIn(), 60_000, "but the next tick is still booked");
    hidden = false;
    await clock.fire();
    assert.equal(calls(), 2);
  });

  it("stops for good when the shell unmounts, even mid-pass", async () => {
    let release!: (v: boolean) => void;
    const { handle, clock, reports } = loop([new Promise<boolean>((r) => (release = r))]);
    handle.stop();
    release(false);
    await settle();
    assert.equal(clock.pendingCount(), 0, "nothing is scheduled after stop");
    assert.equal(reports.length, 0, "and a pass that lands afterwards reports to nobody");
  });
});

describe("what the shell says while it retries", () => {
  it("is plain, and counts down", () => {
    const copy = failureCopy({ nextAt: 1_012_000, lastOkAt: null, now: 1_000_000 });
    assert.equal(copy.line, "Can't reach merrymen, retrying in 12s.");
    assert.equal(copy.stale, null, "nothing on screen to call stale before anything loaded");
  });

  it("marks what is still on screen as stale", () => {
    const now = Date.now();
    const copy = failureCopy({ nextAt: now + 5_000, lastOkAt: now - 4 * 60_000, now });
    assert.equal(copy.stale, "Showing what we last read 4m ago.");
  });

  it("says it is retrying once the countdown has run out", () => {
    assert.equal(failureCopy({ nextAt: 1_000_000, lastOkAt: null, now: 1_000_400 }).line, "Can't reach merrymen, retrying now…");
  });
});

describe("a pass already running", () => {
  it("is announced when it starts and when it ends, so Retry does not look dead", async () => {
    let release!: (v: boolean) => void;
    const clock = fakeClock();
    const flights: boolean[] = [];
    let calls = 0;
    const handle = startRefreshLoop({
      pass: async () => (calls++ === 0 ? false : new Promise<boolean>((r) => (release = r))),
      report: () => {},
      onFlight: (f) => flights.push(f),
      timers: clock.timers,
    });
    await settle();
    assert.deepEqual(flights, [true, false], "the first pass");
    handle.retryNow();
    assert.deepEqual(flights, [true, false, true], "a retry is in flight the moment it is pressed");
    release(true);
    await settle();
    assert.deepEqual(flights, [true, false, true, false]);
    handle.stop();
  });

  it("the line says it is retrying now rather than counting down to it", () => {
    assert.equal(
      failureCopy({ nextAt: 1_038_000, lastOkAt: null, now: 1_000_000, inFlight: true, unreachable: true }).line,
      "Can't reach merrymen, retrying now…",
    );
  });
});

describe("what the line may claim about this failure", () => {
  const now = Date.now();
  it("'Can't reach merrymen' only when nothing answered", () => {
    assert.equal(
      failureCopy({ nextAt: now + 12_000, lastOkAt: null, now, unreachable: true, failed: { account: true, market: true } }).line,
      "Can't reach merrymen, retrying in 12s.",
    );
    assert.equal(
      failureCopy({ nextAt: now + 12_000, lastOkAt: null, now, unreachable: false, failed: { account: true, market: true } }).line,
      "Couldn't load your account or market data, retrying in 12s.",
      "a 500 is merrymen answering",
    );
  });

  it("names the half that failed, and dates only that half", () => {
    const account = failureCopy({ nextAt: now + 5_000, lastOkAt: now - 4 * 60_000, now, unreachable: false, failed: { account: true, market: false } });
    assert.equal(account.line, "Couldn't load your account, retrying in 5s.");
    assert.equal(account.stale, "Showing your account as we last read 4m ago.");
    assert.equal(account.lead, "Couldn't load your account");
    const market = failureCopy({ nextAt: now + 5_000, lastOkAt: now - 4 * 60_000, now, unreachable: false, failed: { account: false, market: true } });
    assert.equal(market.line, "Couldn't load market data, retrying in 5s.");
    assert.equal(market.stale, "Showing market data as we last read 4m ago.");
  });
});
