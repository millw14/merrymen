import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FleetFeedCache, type FeedClock, type FeedResult } from "./fleet-feed-cache";

/**
 * A CLOCK THE TEST DRIVES, because the pace cannot be measured from outside.
 *
 * The guarantee is made where the slot is claimed — an UPDATE that only wins
 * when `next_ms <= now`. A caller can only observe when its own callback runs,
 * which is that moment plus an unbounded event-loop delay, so a wall-clock
 * assertion measures `spacing + (delay2 - delay1)`.
 *
 * That is not a theory. Against the real clock on an IDLE machine, 240 samples
 * of this very scenario gave a median of 108ms for a 100ms pace and a MINIMUM
 * OF 35ms — 0.8% of gaps already under the 85ms the old assertion allowed, on
 * a pace that was working correctly every time. On CI it reddened main three
 * times in one day.
 *
 * `sleep` advances virtual time and yields, so the other pending `get()` calls
 * get to run: the ordering under test is still real concurrency, and only the
 * clock is fake.
 */
function fakeClock(): FeedClock & { readAt: () => number } {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += Math.max(0, ms);
      // Two turns of the microtask queue: one to let whoever was waiting on
      // this sleep resume, one for the SQLite work it does on resuming.
      await Promise.resolve();
      await Promise.resolve();
    },
    readAt: () => t,
  };
}

test("different pages share a request pace across independent worker connections", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "gecko-cache-"));
  const clock = fakeClock();
  // Both connections share the clock, as two processes share a wall clock.
  const a = new FleetFeedCache(home, 100, clock), b = new FleetFeedCache(home, 100, clock);
  try {
    const starts: number[] = [];
    const request = async () => { starts.push(clock.now()); return { failed: false, observedAt: clock.now() }; };
    const unavailable = (failure: string) => ({ failed: true, failure });
    await Promise.all([a.get<FeedResult>("a", request, unavailable), b.get<FeedResult>("b", request, unavailable), a.get<FeedResult>("c", request, unavailable)]);
    assert.equal(starts.length, 3);
    // EXACTLY the spacing, not 'at least most of it'. Three pages across two
    // independent connections take one fleet-wide slot each, in turn.
    assert.equal(starts[1]! - starts[0]!, 100);
    assert.equal(starts[2]! - starts[1]!, 100);
  } finally { a.close(); b.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a queued page stops when another request encounters a provider rate limit", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "gecko-cache-"));
  // THE DRIVEN CLOCK, for the reason fakeClock gives. On the real clock this
  // reddened CI: a process descheduled for over 100ms between `a` taking the
  // slot and `b` reading it let `b` find its turn already due, skip the sleep,
  // and read the cooldown before `a` had written it — the cache was right, the
  // test was racing the scheduler.
  const clock = fakeClock();
  const a = new FleetFeedCache(home, 100, clock), b = new FleetFeedCache(home, 100, clock);
  try {
    let laterCalls = 0;
    const unavailable = (failure: string) => ({ failed: true, failure });
    const results = await Promise.all([
      a.get<FeedResult>("a", async () => ({ failed: true, failure: "http-429" }), unavailable),
      b.get<FeedResult>("b", async () => { laterCalls++; return { failed: false }; }, unavailable),
    ]);
    assert.equal(results[0].failure, "http-429");
    assert.equal(results[1].failure, "provider-cooldown");
    assert.equal(laterCalls, 0);
  } finally { a.close(); b.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("independent fleet connections coalesce a page request and preserve observation time", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "gecko-cache-"));
  const a = new FleetFeedCache(home, 40), b = new FleetFeedCache(home, 40);
  try {
    let calls = 0;
    const observedAt = Date.now() - 1000;
    const fetch = async () => { calls++; await sleep(150); return { failed: false, observedAt, pools: ["pool"] }; };
    const unavailable = (failure: string) => ({ failed: true, failure, observedAt: 0, pools: [] as string[] });
    const results = await Promise.all([a.get<FeedResult>("pools:1", fetch, unavailable), b.get<FeedResult>("pools:1", fetch, unavailable)]);
    assert.equal(calls, 1);
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[1].observedAt, observedAt);
    await b.get<FeedResult>("pools:1", fetch, unavailable);
    assert.equal(calls, 1);
  } finally { a.close(); b.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("429 cooldown is shared across pages while a fresh cached page remains readable", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "gecko-cache-"));
  const a = new FleetFeedCache(home, 40), b = new FleetFeedCache(home, 40);
  try {
    const unavailable = (failure: string) => ({ failed: true, failure });
    await a.get<FeedResult>("fresh", async () => ({ failed: false, observedAt: Date.now() }), unavailable);
    await a.get<FeedResult>("limited", async () => ({ failed: true, failure: "http-429", retryAfterMs: 120_000 }), unavailable);
    let calls = 0;
    const request = async () => { calls++; return { failed: false }; };
    assert.equal((await b.get<FeedResult>("other-page", request, unavailable)).failure, "provider-cooldown");
    assert.equal((await b.get<FeedResult>("fresh", request, unavailable)).failed, false);
    assert.equal(calls, 0);
  } finally { a.close(); b.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("expired observations are fetched again and thrown requests release their lease", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "gecko-cache-"));
  const a = new FleetFeedCache(home, 40);
  try {
    const unavailable = (failure: string) => ({ failed: true, failure });
    await a.get<FeedResult>("old", async () => ({ failed: false, observedAt: Date.now() - 61_000 }), unavailable);
    let calls = 0;
    await a.get<FeedResult>("old", async () => { calls++; return { failed: false, observedAt: Date.now() }; }, unavailable);
    assert.equal(calls, 1);
    await assert.rejects(a.get<FeedResult>("thrown", async () => { throw new Error("offline"); }, unavailable));
    assert.equal((await a.get<FeedResult>("thrown", async () => ({ failed: false }), unavailable)).failed, false);
  } finally { a.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
