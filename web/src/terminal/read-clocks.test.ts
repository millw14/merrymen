/**
 * EACH READ ON ITS OWN CLOCK, AND ONE HONEST LINE OVER ALL OF THEM.
 *
 * The shell refreshed everything in one 60s pass: quotes, then six reads in a
 * single Promise.all, then the account — and nothing rendered until the
 * slowest had finished. The slowest was /api/discoveries, measured at
 * 10.6-12.4s cold, so a trade that landed waited up to a minute to be asked
 * for and then twelve seconds more to be shown.
 *
 * Driven with a fake clock, because the property is the schedule.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bannerOf,
  nextReadIn,
  startClocks,
  startRefreshLoop,
  type ClockView,
  type LoopState,
} from "./refresh-loop";

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
    /** Move the clock forward, firing every timer that falls due on the way. */
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await settle();
      }
      now = until;
    },
    now: () => now,
  };
}
const settle = () => new Promise<void>((r) => setImmediate(r));

describe("a read's own schedule", () => {
  it("a healthy read waits its own cadence, not the shell's minute", () => {
    assert.equal(nextReadIn(0, 10_000), 10_000);
    assert.equal(nextReadIn(0, 120_000), 120_000);
  });

  it("backs off 5s, 15s, then settles — and never asks faster in an outage than when healthy", () => {
    assert.deepEqual([1, 2, 3, 7].map((n) => nextReadIn(n, 10_000)), [5_000, 15_000, 60_000, 60_000]);
    assert.deepEqual(
      [1, 2, 3, 7].map((n) => nextReadIn(n, 120_000)),
      [5_000, 15_000, 120_000, 120_000],
      "a two-minute read held at a minute would answer a failure with more traffic than success earns",
    );
  });

  it("books its next pass at its own cadence, read afresh each time", async () => {
    const clock = fakeClock();
    let hidden = false;
    let calls = 0;
    const loop = startRefreshLoop({
      pass: async () => {
        calls++;
        return true;
      },
      report: () => {},
      everyMs: () => (hidden ? 60_000 : 10_000),
      timers: clock.timers,
    });
    await settle();
    await clock.advance(10_000);
    assert.equal(calls, 2, "ten seconds after the first pass, not sixty");
    hidden = true;
    await clock.advance(10_000);
    assert.equal(calls, 3, "the pass booked while visible still runs");
    await clock.advance(59_000);
    assert.equal(calls, 3, "and once hidden, the next is a minute away");
    await clock.advance(1_000);
    assert.equal(calls, 4);
    loop.stop();
  });

  it("wake runs a pass only when one is due", async () => {
    const clock = fakeClock();
    let calls = 0;
    const loop = startRefreshLoop({
      pass: async () => {
        calls++;
        return true;
      },
      report: () => {},
      everyMs: 30_000,
      paused: () => true,
      timers: clock.timers,
    });
    await settle();
    assert.equal(calls, 1, "the first pass always runs");
    await clock.advance(5_000);
    loop.wake();
    await settle();
    assert.equal(calls, 1, "a glance away and back five seconds later asks for nothing");
    await clock.advance(40_000);
    assert.equal(calls, 1, "a hidden tab skipped the pass that fell due");
    loop.wake();
    await settle();
    assert.equal(calls, 2, "so the tab coming back runs it at once");
    loop.stop();
  });

  it("a clock slowed while hidden speeds back up when the tab returns, even when no pass is due yet", async () => {
    const clock = fakeClock();
    let hidden = true;
    let calls = 0;
    const loop = startRefreshLoop({
      pass: async () => {
        calls++;
        return true;
      },
      report: () => {},
      everyMs: () => (hidden ? 60_000 : 10_000),
      timers: clock.timers,
    });
    await settle();
    assert.equal(calls, 1, "the first pass books the next a hidden minute away");
    await clock.advance(4_000);
    hidden = false;
    loop.wake();
    await settle();
    assert.equal(calls, 1, "four seconds after a pass, none is due");
    await clock.advance(6_000);
    assert.equal(calls, 2, "but the next runs ten seconds after the last, not sixty");
    loop.stop();
  });

  it("A RETRY ASKED FOR DURING A PASS RUNS ONE MORE PASS AFTER IT — the answer in flight predates what changed", async () => {
    // An order that answered, a sign-in or a new agent asks for the account and
    // the book again. The pass already in flight started before that change and
    // returns the old state, so dropping the ask left the change unseen until
    // the next minute's pass.
    const clock = fakeClock();
    const release: Array<(ok: boolean) => void> = [];
    const loop = startRefreshLoop({
      pass: () => new Promise<boolean>((r) => void release.push(r)),
      report: () => {},
      everyMs: 60_000,
      timers: clock.timers,
    });
    await settle();
    assert.equal(release.length, 1);
    loop.retryNow();
    loop.retryNow();
    loop.retryNow();
    await settle();
    assert.equal(release.length, 1, "still one pass at a time");
    release[0]!(true);
    await settle();
    assert.equal(release.length, 2, "exactly one more pass, however many times it was asked");
    release[1]!(true);
    await settle();
    assert.equal(release.length, 2, "and then nothing until its own cadence");
    await clock.advance(60_000);
    assert.equal(release.length, 3);
    release[2]!(true);
    loop.stop();
  });

  it("a tab coming back mid-pass queues nothing — a glance is not a person asking", async () => {
    const clock = fakeClock();
    const release: Array<(ok: boolean) => void> = [];
    const loop = startRefreshLoop({
      pass: () => new Promise<boolean>((r) => void release.push(r)),
      report: () => {},
      everyMs: 10_000,
      timers: clock.timers,
    });
    await settle();
    loop.wake();
    release[0]!(true);
    await settle();
    assert.equal(release.length, 1);
    loop.stop();
  });

  it("a retry queued behind a pass dies with the loop", async () => {
    const clock = fakeClock();
    const release: Array<(ok: boolean) => void> = [];
    const loop = startRefreshLoop({
      pass: () => new Promise<boolean>((r) => void release.push(r)),
      report: () => {},
      timers: clock.timers,
    });
    await settle();
    loop.retryNow();
    loop.stop();
    release[0]!(true);
    await settle();
    assert.equal(release.length, 1, "a stopped loop asks for nothing more");
  });

  it("says whether a failure was nothing answering, or merrymen answering badly", async () => {
    const reports: LoopState[] = [];
    const results: Array<() => Promise<boolean>> = [
      async () => {
        throw Object.assign(new Error("offline"), { status: 0 });
      },
      async () => {
        throw Object.assign(new Error("no route answered"), { answered: false });
      },
      async () => false,
      async () => {
        throw Object.assign(new Error("500"), { status: 500 });
      },
    ];
    for (const pass of results) {
      const clock = fakeClock();
      const loop = startRefreshLoop({ pass, report: (s) => reports.push(s), timers: clock.timers });
      await settle();
      loop.stop();
    }
    assert.deepEqual(reports.map((r) => r.silent), [true, true, false, false]);
  });
});

describe("several clocks", () => {
  it("A SLOW READ HOLDS NOTHING BUT ITSELF — the feed keeps arriving while discoveries runs", async () => {
    const clock = fakeClock();
    const applied: string[] = [];
    let releaseDiscoveries!: (ok: boolean) => void;
    const clocks = startClocks(
      [
        {
          key: "theses",
          half: "market",
          everyMs: 10_000,
          pass: async () => {
            applied.push(`theses@${clock.now()}`);
            return true;
          },
        },
        {
          key: "discoveries",
          half: "market",
          everyMs: 120_000,
          pass: () =>
            new Promise<boolean>((r) => {
              releaseDiscoveries = r;
            }),
        },
      ],
      () => {},
      clock.timers,
    );
    await settle();
    await clock.advance(30_000);
    assert.deepEqual(
      applied,
      ["theses@1000000", "theses@1010000", "theses@1020000", "theses@1030000"],
      "four feed reads applied while the first discoveries read is still out",
    );
    releaseDiscoveries(true);
    await settle();
    clocks.stop();
  });

  it("reports every clock's view on every change, and retries only the failing ones", async () => {
    const clock = fakeClock();
    const calls = { theses: 0, account: 0 };
    let last: ClockView[] = [];
    const clocks = startClocks(
      [
        { key: "theses", half: "market", everyMs: 10_000, pass: async () => (calls.theses++, false) },
        { key: "account", half: "account", everyMs: 60_000, pass: async () => (calls.account++, true) },
      ],
      (views) => (last = views),
      clock.timers,
    );
    await settle();
    assert.equal(last.find((v) => v.key === "theses")!.state!.failuresInARow, 1);
    assert.equal(last.find((v) => v.key === "account")!.state!.failuresInARow, 0);
    clocks.retryNow();
    await settle();
    assert.deepEqual(calls, { theses: 2, account: 1 }, "Retry asks again for what failed, not for everything");
    clocks.retryNow("account");
    await settle();
    assert.equal(calls.account, 2, "and a named clock can be asked directly");
    clocks.stop();
  });

  it("a named clock asked mid-pass reads again once the pass in flight ends", async () => {
    const clock = fakeClock();
    const release: Array<(ok: boolean) => void> = [];
    let theses = 0;
    const clocks = startClocks(
      [
        { key: "account", half: "account", everyMs: 60_000, pass: () => new Promise<boolean>((r) => void release.push(r)) },
        { key: "theses", half: "market", everyMs: 10_000, pass: async () => (theses++, true) },
      ],
      () => {},
      clock.timers,
    );
    await settle();
    clocks.retryNow("account");
    release[0]!(true);
    await settle();
    assert.equal(release.length, 2, "the account is read again, not left a minute stale");
    assert.equal(theses, 1, "and nothing else was asked");
    release[1]!(true);
    clocks.stop();
  });
});

const view = (key: string, half: "account" | "market", state: Partial<LoopState> | null, inFlight = false): ClockView => ({
  key,
  half,
  inFlight,
  state: state === null ? null : { failuresInARow: 0, nextAt: 0, lastOkAt: null, silent: false, ...state },
});

describe("the one line over every clock", () => {
  it("is absent while every clock is healthy, and before any has reported", () => {
    assert.equal(bannerOf([view("theses", "market", { lastOkAt: 5 }), view("account", "account", null)]), null);
  });

  it("names the half whose read is failing, and counts down to the soonest retry", () => {
    const b = bannerOf([
      view("theses", "market", { failuresInARow: 1, nextAt: 2_000, lastOkAt: 900 }),
      view("board", "market", { failuresInARow: 2, nextAt: 9_000, lastOkAt: 600 }),
      view("account", "account", { lastOkAt: 1_000 }),
    ])!;
    assert.deepEqual(b.failed, { account: false, market: true });
    assert.equal(b.nextAt, 2_000);
    assert.equal(b.lastOkAt, 600, "the oldest figure still on screen is the one to date");
  });

  it("a failing read that never succeeded put nothing on screen, so it dates nothing", () => {
    const b = bannerOf([
      view("discoveries", "market", { failuresInARow: 3, nextAt: 5, lastOkAt: null }),
      view("theses", "market", { lastOkAt: 100 }),
    ])!;
    assert.equal(b.lastOkAt, null);
  });

  it("says a retry is running only when a FAILING clock is in flight", () => {
    const healthyBusy = bannerOf([
      view("theses", "market", { lastOkAt: 1 }, true),
      view("account", "account", { failuresInARow: 1, nextAt: 5, lastOkAt: 1 }),
    ])!;
    assert.equal(healthyBusy.inFlight, false, "the feed's ten-second read is not the retry");
    const retrying = bannerOf([view("account", "account", { failuresInARow: 1, nextAt: 5, lastOkAt: 1 }, true)])!;
    assert.equal(retrying.inFlight, true);
  });

  it("a read that is not on the line — the owner's book — neither raises it nor vouches that merrymen answered", () => {
    const book = (state: Partial<LoopState>) => ({ ...view("feed", "account", state), outageLine: false });
    assert.equal(bannerOf([view("theses", "market", { lastOkAt: 1 }), book({ failuresInARow: 4, nextAt: 5 })]), null);
    const allSilent = [
      view("theses", "market", { failuresInARow: 1, silent: true }),
      view("account", "account", { failuresInARow: 1, silent: true }),
    ];
    assert.equal(bannerOf([...allSilent, book({ lastOkAt: 3 })])!.unreachable, true);
  });

  it("'Can't reach merrymen' only when every clock, in both halves, heard nothing", () => {
    const allSilent = [
      view("theses", "market", { failuresInARow: 1, silent: true }),
      view("account", "account", { failuresInARow: 1, silent: true }),
    ];
    assert.equal(bannerOf(allSilent)!.unreachable, true);
    assert.equal(
      bannerOf([...allSilent, view("board", "market", { failuresInARow: 1, silent: false })])!.unreachable,
      false,
      "a 500 is merrymen answering",
    );
    assert.equal(
      bannerOf([...allSilent, view("market", "market", { lastOkAt: 3 })])!.unreachable,
      false,
      "one read coming back means merrymen is there",
    );
    assert.equal(
      bannerOf([view("theses", "market", { failuresInARow: 1, silent: true })])!.unreachable,
      false,
      "and one half alone cannot say nothing answered",
    );
  });
});
