import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { FleetFeedCache, LocalFeedCache, credentialFingerprint, endpointFamily, isPlanRefusal, type FeedCache, type FeedCacheOptions, type FeedClock, type FeedResult } from "./fleet-feed-cache";

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

test("429 backoff survives process restart, escalates to 15 minutes, and honors longer Retry-After", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "gecko-backoff-"));
  let now = 1_000_000, cache = new FleetFeedCache(home, 0, { now: () => now, sleep: async ms => { now += ms; } });
  const unavailable = (failure: string) => ({ failed: true, failure });
  let calls = 0;
  const limited = async () => { calls++; return { failed: true, failure: "http-429" }; };
  try {
    for (const [i, delay] of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000].entries()) {
      assert.equal((await cache.get<FeedResult>(`fail:${i}`, limited, unavailable)).failure, "http-429");
      cache.close();
      cache = new FleetFeedCache(home, 0, { now: () => now, sleep: async ms => { now += ms; } });
      now += delay - 1;
      assert.equal((await cache.get<FeedResult>(`blocked:${i}`, limited, unavailable)).failure, "provider-cooldown");
      assert.equal(calls, i + 1);
      now++;
    }
    await cache.get<FeedResult>("healthy", async () => ({ failed: false, observedAt: now }), unavailable);
    await cache.get<FeedResult>("again", limited, unavailable);
    now += 60_000;
    assert.equal((await cache.get<FeedResult>("recovered", async () => ({ failed: false, observedAt: now }), unavailable)).failed, false, "healthy response resets escalation");
    await cache.get<FeedResult>("long", async () => ({ failed: true, failure: "http-429", retryAfterMs: 3_600_000 }), unavailable);
    now += 900_000;
    assert.equal((await cache.get<FeedResult>("honor-header", limited, unavailable)).failure, "provider-cooldown");
  } finally { cache.close(); rmSync(home, { recursive: true, force: true }); }
});

test("a bounded cold-page burst warms early pages without refreshing their observations", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "gecko-pages-"));
  let now = 1_000_000;
  const clock = { now: () => now, sleep: async (ms: number) => { now += ms; } };
  const cache = new FleetFeedCache(home, 6500, clock);
  const starts: number[] = [];
  const unavailable = (failure: string) => ({ failed: true, failure });
  const request = async () => { starts.push(now); return { failed: false, observedAt: now }; };
  try {
    const deadline = now + 30_000;
    const results: FeedResult[] = [];
    // A stable feed order admits common first pages before extra pagination.
    for (let i = 0; i < 8; i++) results.push(await cache.get<FeedResult>(`page:${i}`, request, unavailable, deadline));
    assert.deepEqual(starts, [1_000_000, 1_006_500, 1_013_000, 1_019_500, 1_026_000]);
    assert.ok(results.slice(5).every(r => r.failed));
    assert.equal(now, deadline);
    const hit = await cache.get<FeedResult>("page:0", request, unavailable);
    assert.equal(hit.observedAt, 1_000_000);
    assert.equal(starts.length, 5);
    // The next pass can warm a later page without re-reading the first ones.
    assert.equal((await cache.get<FeedResult>("page:5", request, unavailable)).failed, false);
    now = 1_060_000;
    await cache.get<FeedResult>("page:0", request, unavailable);
    assert.equal(starts.length, 7, "the original page expires instead of renewing on a hit");
  } finally { cache.close(); rmSync(home, { recursive: true, force: true }); }
});

test("self-hosted lanes enforce the same pace, cooldown and shared deadline", async () => {
  const { LocalFeedCache } = await import("./fleet-feed-cache");
  const clock = fakeClock(), cache = new LocalFeedCache(6500, clock);
  const starts: number[] = [];
  const unavailable = (failure: string) => ({ failed: true, failure });
  const healthy = async () => { starts.push(clock.now()); return { failed: false, observedAt: clock.now() }; };
  const first = await cache.get<FeedResult>("first", healthy, unavailable);
  assert.equal((await cache.get<FeedResult>("short", healthy, unavailable, clock.now() + 1000)).failure, "request-budget");
  assert.equal(starts.length, 1);
  await cache.get<FeedResult>("second", healthy, unavailable);
  assert.equal(starts[1]! - starts[0]!, 6500);
  assert.equal((await cache.get<FeedResult>("first", healthy, unavailable)).observedAt, first.observedAt);
  await cache.get<FeedResult>("limited", async () => ({ failed: true, failure: "http-429" }), unavailable);
  assert.equal((await cache.get<FeedResult>("third", healthy, unavailable)).failure, "provider-cooldown");
  assert.equal(starts.length, 2);
});

// ── THE EVIDENCE ROW: priority, not extra quota ─────────────────────────────

/** A clock for strictly sequential calls: sleeping just moves time forward. */
function stepClock(start = 1_000_000) {
  let t = start;
  const clock: FeedClock = { now: () => t, sleep: async (ms: number) => { t += Math.max(0, ms); } };
  return { clock, advance: (ms: number) => { t += ms; } };
}

for (const kind of ["fleet", "local"] as const) {
  const make = (home: string, spacing: number, clock: FeedClock, options?: FeedCacheOptions): FeedCache =>
    kind === "fleet" ? new FleetFeedCache(home, spacing, clock, options) : new LocalFeedCache(spacing, clock, options);

  test(`${kind}: an evidence read skips the default queue and pushes the default row back one slot`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "gecko-lanes-"));
    const { clock } = stepClock();
    const cache = make(home, 1000, clock, { priorityRow: true });
    const starts: Record<string, number> = {};
    const unavailable = (failure: string) => ({ failed: true, failure });
    const req = (name: string) => async () => { starts[name] = clock.now(); return { failed: false, observedAt: clock.now() }; };
    try {
      const t = clock.now();
      await cache.get<FeedResult>("d1", req("d1"), unavailable);
      // The default row's next slot is t+1000. The evidence read does not wait for it.
      await cache.get<FeedResult>("e1", req("e1"), unavailable, undefined, { lane: "evidence" });
      assert.equal(starts.e1, t, "evidence is not queued behind the default row");
      // ...and pays for it: the default row's next slot moved from t+1000 to t+2000.
      await cache.get<FeedResult>("d2", req("d2"), unavailable);
      assert.equal(starts.d2, t + 2000);
      // Evidence reads are paced among themselves at the same spacing.
      await cache.get<FeedResult>("e2", req("e2"), unavailable, undefined, { lane: "evidence" });
      await cache.get<FeedResult>("e3", req("e3"), unavailable, undefined, { lane: "evidence" });
      assert.equal(starts.e3! - starts.e2!, 1000);
    } finally { cache.close(); rmSync(home, { recursive: true, force: true }); }
  });

  test(`${kind}: two rows together never outrun one row's pace by more than a burst`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "gecko-lanes-"));
    const { clock, advance } = stepClock();
    const S = 500;
    const cache = make(home, S, clock, { priorityRow: true });
    const starts: number[] = [];
    const unavailable = (failure: string) => ({ failed: true, failure });
    // A deterministic pseudo-random mix of lanes and idle gaps.
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    try {
      for (let i = 0; i < 300; i++) {
        if (rand() < 0.3) advance(Math.floor(rand() * 2 * S));
        const lane = rand() < 0.5 ? "evidence" as const : "default" as const;
        await cache.get<FeedResult>(`k${i}`, async () => { starts.push(clock.now()); return { failed: false, observedAt: clock.now() }; }, unavailable, undefined, { lane });
      }
      assert.equal(starts.length, 300);
      // One row allows L/S + 1 requests in any window of length L. Two rows
      // with the push allow at most one more — the burst — never a second
      // row's worth of quota.
      for (let i = 0; i < starts.length; i++) {
        for (let j = i; j < starts.length; j++) {
          assert.ok(j - i + 1 <= (starts[j]! - starts[i]!) / S + 2, `window ${i}..${j}`);
        }
      }
    } finally { cache.close(); rmSync(home, { recursive: true, force: true }); }
  });

  test(`${kind}: default reads alone are paced exactly as before`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "gecko-lanes-"));
    const { clock } = stepClock();
    const cache = make(home, 3000, clock);
    const starts: number[] = [];
    const unavailable = (failure: string) => ({ failed: true, failure });
    try {
      for (let i = 0; i < 4; i++) await cache.get<FeedResult>(`p${i}`, async () => { starts.push(clock.now()); return { failed: false, observedAt: clock.now() }; }, unavailable);
      assert.deepEqual(starts.map(s => s - starts[0]!), [0, 3000, 6000, 9000]);
    } finally { cache.close(); rmSync(home, { recursive: true, force: true }); }
  });

  test(`${kind}: one 429 cooldown covers both rows`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "gecko-lanes-"));
    const { clock } = stepClock();
    const cache = make(home, 100, clock, { priorityRow: true });
    const unavailable = (failure: string) => ({ failed: true, failure });
    let calls = 0;
    try {
      await cache.get<FeedResult>("limited", async () => ({ failed: true, failure: "http-429" }), unavailable);
      const r = await cache.get<FeedResult>("evidence", async () => { calls++; return { failed: false }; }, unavailable, undefined, { lane: "evidence" });
      assert.equal(r.failure, "provider-cooldown");
      assert.equal(calls, 0);
    } finally { cache.close(); rmSync(home, { recursive: true, force: true }); }
  });

  /**
   * THE PUBLIC LANE HAS ONE ROW. Its 6.5 s spacing is what keeps a keyless
   * worker under the documented ~10/min; a second row let a Brain evidence
   * leg fire in the same instant as a tape page, eleven requests in a minute,
   * and the eleventh earns a 429 and a cooldown for every public read. Built
   * without `priorityRow`, as cacheFor builds the public lane, `evidence` is
   * just a name: every request is at least one spacing from the last.
   */
  test(`${kind}: without priorityRow (the public lane) evidence reads keep the one row's pace`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "gecko-lanes-"));
    const unavailable = (failure: string) => ({ failed: true, failure });
    const gapsOk = (starts: number[]) => starts.every((s, i) => i === 0 || s - starts[i - 1]! >= 6500);
    // Fired together, the way a tape page and a review's two legs can be.
    const driven = fakeClock();
    const together = make(home, 6500, driven);
    const burst: number[] = [];
    const at = (lane: "default" | "evidence", key: string) => together.get<FeedResult>(key, async () => { burst.push(driven.now()); return { failed: false, observedAt: driven.now() }; }, unavailable, undefined, { lane });
    try {
      await Promise.all([at("default", "tape"), at("evidence", "candles"), at("evidence", "trades")]);
      assert.equal(burst.length, 3);
      assert.deepEqual(burst.map(s => s - burst[0]!), [0, 6500, 13_000]);
    } finally { together.close(); }
    // And a long mixed run with idle gaps, one request at a time.
    const { clock, advance } = stepClock();
    const cache = make(path.join(home, "mixed"), 6500, clock);
    const starts: number[] = [];
    let seed = 11;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    try {
      for (let i = 0; i < 80; i++) {
        if (rand() < 0.3) advance(Math.floor(rand() * 13_000));
        const lane = rand() < 0.5 ? "evidence" as const : "default" as const;
        await cache.get<FeedResult>(`k${i}`, async () => { starts.push(clock.now()); return { failed: false, observedAt: clock.now() }; }, unavailable, undefined, { lane });
      }
      assert.equal(starts.length, 80);
      assert.ok(gapsOk(starts), "two public requests closer than 6.5 s");
    } finally { cache.close(); rmSync(home, { recursive: true, force: true }); }
  });

  // ── THE PLAN-REFUSAL LATCH ────────────────────────────────────────────────

  test(`${kind}: a 401 latches its endpoint family for an hour, said once, and spends no further slots`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "gecko-latch-"));
    const { clock, advance } = stepClock();
    const lines: string[] = [];
    const cache = make(home, 100, clock, { latchRefusals: true, log: line => lines.push(line) });
    const unavailable = (failure: string) => ({ failed: true, failure });
    const addr = (n: string) => `0x${n.repeat(40)}`;
    const trades = (n: string) => ({ route: `/networks/robinhood/pools/${addr(n)}/trades?token=${addr("9")}`, lane: "evidence" as const });
    let calls = 0;
    const refused = async () => { calls++; return { failed: true, failure: "http-401" }; };
    try {
      assert.equal((await cache.get<FeedResult>("a", refused, unavailable, undefined, trades("1"))).failure, "http-401");
      assert.equal(calls, 1);
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /networks\/robinhood\/pools\/\{id\}\/trades/);
      assert.doesNotMatch(lines[0]!, /0x1111|0x9999|token=/, "the log names an endpoint, never an address or query");
      // Another pool of the same endpoint is answered from the latch: no request.
      for (let i = 0; i < 20; i++) {
        advance(5_000);
        assert.equal((await cache.get<FeedResult>(`b${i}`, refused, unavailable, undefined, trades("2"))).failure, "plan-restricted");
      }
      assert.equal(calls, 1, "a latched endpoint spends nothing");
      // A different endpoint family is unaffected.
      let other = 0;
      await cache.get<FeedResult>("c", async () => { other++; return { failed: false, observedAt: clock.now() }; }, unavailable, undefined,
        { route: `/networks/robinhood/pools/${addr("2")}/ohlcv/minute?aggregate=5` });
      assert.equal(other, 1);
      // After the hour it is asked once more; a refusal re-latches and is said once more.
      advance(3_600_000);
      await cache.get<FeedResult>("d", refused, unavailable, undefined, trades("3"));
      assert.equal(calls, 2);
      assert.equal(lines.length, 2);
    } finally { cache.close(); rmSync(home, { recursive: true, force: true }); }
  });

  test(`${kind}: a bare 403 is the five-second failure, never a latch; only CoinGecko's 10005 body latches a 403`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "gecko-latch-"));
    const { clock, advance } = stepClock();
    const lines: string[] = [];
    const cache = make(home, 100, clock, { latchRefusals: true, log: line => lines.push(line) });
    const unavailable = (failure: string) => ({ failed: true, failure });
    const addr = (n: string) => `0x${n.repeat(40)}`;
    const trades = (n: string) => ({ route: `/networks/robinhood/pools/${addr(n)}/trades?token=${addr("9")}`, lane: "evidence" as const });
    let calls = 0;
    try {
      // A firewall's or a shared egress address's moment: refused, then fine.
      assert.equal((await cache.get<FeedResult>("a", async () => { calls++; return { failed: true, failure: "http-403" }; }, unavailable, undefined, trades("1"))).failure, "http-403");
      assert.deepEqual(lines, [], "nothing latched, nothing said");
      // Another pool of the same family is asked at once, not an hour later.
      const other = await cache.get<FeedResult>("b", async () => { calls++; return { failed: false, observedAt: clock.now() }; }, unavailable, undefined, trades("2"));
      assert.equal(other.failed, false);
      // And the refused page itself, once its five seconds are up.
      advance(5_001);
      const again = await cache.get<FeedResult>("a", async () => { calls++; return { failed: false, observedAt: clock.now() }; }, unavailable, undefined, trades("1"));
      assert.equal(again.failed, false);
      assert.equal(calls, 3);
      // A 403 that carries the plan's 10005 body arrives as plan-restricted, and that latches.
      await cache.get<FeedResult>("c", async () => { calls++; return { failed: true, failure: "plan-restricted" }; }, unavailable, undefined, trades("3"));
      assert.equal((await cache.get<FeedResult>("d", async () => { calls++; return { failed: false }; }, unavailable, undefined, trades("4"))).failure, "plan-restricted");
      assert.equal(calls, 4);
      assert.equal(lines.length, 1);
    } finally { cache.close(); rmSync(home, { recursive: true, force: true }); }
  });

  test(`${kind}: 429 and 5xx never latch, and a lane without latching ignores routes`, async () => {
    const home = mkdtempSync(path.join(tmpdir(), "gecko-latch-"));
    const { clock, advance } = stepClock();
    const lines: string[] = [];
    const cache = make(home, 100, clock, { latchRefusals: true, log: line => lines.push(line) });
    const plain = make(path.join(home, "public"), 100, clock, { log: line => lines.push(line) });
    const unavailable = (failure: string) => ({ failed: true, failure });
    const route = { route: "/networks/robinhood/trending_pools?page=1" };
    let calls = 0;
    try {
      await cache.get<FeedResult>("p1", async () => { calls++; return { failed: true, failure: "http-503" }; }, unavailable, undefined, route);
      advance(6_000);
      await cache.get<FeedResult>("p1", async () => { calls++; return { failed: true, failure: "http-429" }; }, unavailable, undefined, route);
      advance(61_000); // past the first cooldown step
      const ok = await cache.get<FeedResult>("p2", async () => { calls++; return { failed: false, observedAt: clock.now() }; }, unavailable, undefined, route);
      assert.equal(ok.failed, false);
      assert.equal(calls, 3);
      // Without latchRefusals (the public lane) a 401 is the old five-second failure.
      await plain.get<FeedResult>("q", async () => { calls++; return { failed: true, failure: "http-401" }; }, unavailable, undefined, route);
      advance(6_000);
      await plain.get<FeedResult>("q", async () => { calls++; return { failed: true, failure: "http-401" }; }, unavailable, undefined, route);
      assert.equal(calls, 5);
      assert.deepEqual(lines, []);
    } finally { cache.close(); plain.close(); rmSync(home, { recursive: true, force: true }); }
  });
}

test("the latch is fleet-wide across connections and said by one of them", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "gecko-latch-fleet-"));
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  // Spacing 0 so both requests are in flight together and both come back refused.
  const a = new FleetFeedCache(home, 0, undefined, { latchRefusals: true, log });
  const b = new FleetFeedCache(home, 0, undefined, { latchRefusals: true, log });
  const unavailable = (failure: string) => ({ failed: true, failure });
  const route = (n: string) => ({ route: `/networks/robinhood/tokens/0x${n.repeat(40)}/info` });
  let calls = 0;
  const refused = async () => { calls++; await sleep(20); return { failed: true, failure: "plan-restricted" }; };
  try {
    await Promise.all([a.get<FeedResult>("x", refused, unavailable, undefined, route("1")), b.get<FeedResult>("y", refused, unavailable, undefined, route("2"))]);
    assert.equal(calls, 2);
    assert.equal(lines.length, 1, "two tenants refused at once: one line");
    // A third connection, opened later, sees the latch without asking.
    const c = new FleetFeedCache(home, 0, undefined, { latchRefusals: true, log });
    try { assert.equal((await c.get<FeedResult>("z", refused, unavailable, undefined, route("3"))).failure, "plan-restricted"); }
    finally { c.close(); }
    assert.equal(calls, 2);
  } finally { a.close(); b.close(); rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

/**
 * A LATCH BELONGS TO THE KEY THAT WAS REFUSED.
 *
 * The fleet's latches live in a file on the persistent data home, so they
 * outlive every restart. Keyed by endpoint family alone, a mistyped key
 * latched each family it touched for an hour, and the operator who fixed the
 * key and restarted got an hour of `plan-restricted` everywhere — no tape, no
 * Brain evidence, no public fallback — where the same fix on main recovered on
 * the next request.
 */
test("a latch set under one key is ignored by a cache built for another key on the same file", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "gecko-latch-key-"));
  const { clock, advance } = stepClock();
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const unavailable = (failure: string) => ({ failed: true, failure });
  const route = { route: "/networks/robinhood/trending_pools?page=1" };
  const mistyped = credentialFingerprint("mistyped-pro-key"), fixed = credentialFingerprint("fixed-pro-key");
  let calls = 0;
  const refused = async () => { calls++; return { failed: true, failure: "http-401" }; };
  const healthy = async () => { calls++; return { failed: false, observedAt: clock.now() }; };
  try {
    const a = new FleetFeedCache(home, 100, clock, { latchRefusals: true, credential: mistyped, log });
    try { assert.equal((await a.get<FeedResult>("p1", refused, unavailable, undefined, route)).failure, "http-401"); } finally { a.close(); }
    assert.equal(lines.length, 1);
    // The operator fixes the key and restarts: same file, ten seconds later.
    advance(10_000);
    const b = new FleetFeedCache(home, 100, clock, { latchRefusals: true, credential: fixed, log });
    try { assert.equal((await b.get<FeedResult>("p2", healthy, unavailable, undefined, route)).failed, false); } finally { b.close(); }
    assert.equal(calls, 2, "the fixed key is asked at once, not an hour later");
    // The refused key, back inside the hour, is still latched and asks nothing.
    const c = new FleetFeedCache(home, 100, clock, { latchRefusals: true, credential: mistyped, log });
    try { assert.equal((await c.get<FeedResult>("p3", refused, unavailable, undefined, route)).failure, "plan-restricted"); } finally { c.close(); }
    assert.equal(calls, 2);
    // What the file holds is a fingerprint, never the key; the log holds neither.
    const db = new DatabaseSync(path.join(home, "gecko-feed-cache.sqlite"));
    try {
      const rows = db.prepare("SELECT family, credential FROM plan_refusal").all() as { family: string; credential: string }[];
      assert.deepEqual(rows.map(r => ({ ...r })), [{ family: "networks/robinhood/trending_pools", credential: mistyped }]);
    } finally { db.close(); }
    assert.doesNotMatch(lines.join("\n"), new RegExp(`mistyped-pro-key|${mistyped}`));
  } finally { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("local: a latch is bound to the credential it was built with", async () => {
  const { clock } = stepClock();
  const unavailable = (failure: string) => ({ failed: true, failure });
  const route = { route: "/networks/robinhood/trending_pools?page=1" };
  const cache = new LocalFeedCache(100, clock, { latchRefusals: true, credential: credentialFingerprint("k"), log: () => {} });
  let calls = 0;
  await cache.get<FeedResult>("a", async () => { calls++; return { failed: true, failure: "http-401" }; }, unavailable, undefined, route);
  assert.equal((await cache.get<FeedResult>("b", async () => { calls++; return { failed: false }; }, unavailable, undefined, route)).failure, "plan-restricted");
  assert.equal(calls, 1);
  cache.close();
});

test("a credential fingerprint is short, stable, distinct per key and not the key", () => {
  const fp = credentialFingerprint("private-pro-key");
  assert.match(fp, /^[0-9a-f]{12}$/);
  assert.equal(credentialFingerprint("private-pro-key"), fp);
  assert.notEqual(credentialFingerprint("private-pro-key-2"), fp);
  assert.ok(!fp.includes("private"));
});

test("endpoint families drop queries and ids, never keep addresses", () => {
  assert.equal(endpointFamily(`/networks/robinhood/pools/0x${"a".repeat(64)}/ohlcv/minute?aggregate=5&token=0x${"b".repeat(40)}`), "networks/robinhood/pools/{id}/ohlcv/minute");
  assert.equal(endpointFamily("/search/pools?query=chump&network=robinhood"), "search/pools");
  assert.equal(endpointFamily("/networks/solana/tokens/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/pools?page=1"), "networks/solana/tokens/{id}/pools");
  assert.equal(endpointFamily("/networks/robinhood/trending_pools?page=2"), "networks/robinhood/trending_pools");
  assert.deepEqual(["http-401", "http-403", "plan-restricted", "http-429", "http-500", "http-404", undefined].map(isPlanRefusal), [true, false, true, false, false, false, false]);
});
