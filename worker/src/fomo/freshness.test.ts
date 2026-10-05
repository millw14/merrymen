import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  CLOCK_SKEW_TOLERANCE_MS,
  DEFAULT_FAILURE_BACKOFF_MS,
  FORCE_REFRESH_MIN_RETRY_MS,
  FRESHNESS_POLICY,
  SingleFlight,
  buildFreshness,
  decideRead,
  normalizeFreshnessMode,
  policyFor,
  sourceEventRange,
  type CacheEntryState,
  type DecideReadInput,
} from "./freshness";
import type { FreshnessClass } from "./types";

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const S = 1_000;
const M = 60 * S;
const H = 60 * M;

const entry = (over: Partial<CacheEntryState> = {}): CacheEntryState => ({
  retrievedAt: NOW - 10 * S,
  providerAsOf: null,
  lastAttemptAt: NOW - 10 * S,
  lastAttemptOutcome: "ok",
  ...over,
});

const decide = (over: Partial<DecideReadInput> = {}) =>
  decideRead({ entry: entry(), cls: "holdings", mode: "prefer-fresh", now: NOW, budgetAvailable: true, ...over });

describe("FRESHNESS_POLICY", () => {
  it("holds the documented numbers for every class", () => {
    const expected: Record<FreshnessClass, [number, number]> = {
      activity: [60 * S, 30 * M],
      holdings: [5 * M, 6 * H],
      rankings: [15 * M, 24 * H],
      theses: [30 * M, 7 * 24 * H],
      "token-stats": [5 * M, 2 * H],
      profile: [1 * H, 7 * 24 * H],
      boards: [5 * M, 2 * H],
    };
    for (const [cls, [maxAge, staleMax]] of Object.entries(expected) as [FreshnessClass, [number, number]][]) {
      assert.deepEqual({ ...FRESHNESS_POLICY[cls] }, { maxAgeMs: maxAge, staleServeMaxMs: staleMax }, cls);
      assert.ok(FRESHNESS_POLICY[cls].maxAgeMs < FRESHNESS_POLICY[cls].staleServeMaxMs);
    }
    assert.equal(Object.keys(FRESHNESS_POLICY).length, 7);
    assert.ok(Object.isFrozen(FRESHNESS_POLICY) && Object.isFrozen(FRESHNESS_POLICY.activity));
  });

  it("gives an unknown class the strictest policy", () => {
    assert.deepEqual({ ...policyFor("nope" as FreshnessClass) }, { maxAgeMs: 0, staleServeMaxMs: 0 });
    assert.equal(policyFor("toString" as FreshnessClass).maxAgeMs, 0, "prototype keys are not policies");
  });

  it("honours only the three documented modes", () => {
    assert.equal(normalizeFreshnessMode("force-refresh"), "force-refresh");
    assert.equal(normalizeFreshnessMode("cached-ok"), "cached-ok");
    assert.equal(normalizeFreshnessMode("latest"), "prefer-fresh");
    assert.equal(normalizeFreshnessMode(undefined), "prefer-fresh");
  });
});

describe("decideRead", () => {
  it("prefer-fresh serves a copy within maxAge without asking upstream", () => {
    const d = decide({ budgetAvailable: false });
    assert.equal(d.action, "serve-cache");
    assert.equal(d.reason, "fresh");
    assert.equal(d.lastRefreshOutcome, "skipped-fresh");
    assert.equal(d.servedFrom, "cache");
    assert.equal(d.cacheAgeMs, 10 * S);
  });

  it("prefer-fresh fetches once the copy is older than maxAge, falling back to it labelled", () => {
    const d = decide({ entry: entry({ retrievedAt: NOW - 6 * M }) });
    assert.equal(d.action, "fetch");
    assert.equal(d.reason, "expired");
    assert.equal(d.lastRefreshOutcome, null, "the fetch decides the outcome");
    assert.equal(d.servedFrom, null);
    assert.equal(d.onFailure, "serve-stale");
  });

  it("fetches when nothing is held, and nothing is the fallback", () => {
    const d = decide({ entry: null });
    assert.equal(d.action, "fetch");
    assert.equal(d.reason, "no-copy");
    assert.equal(d.onFailure, "nothing");
    assert.equal(d.cacheAgeMs, null);
  });

  it("a budget refusal on an expired copy serves it labelled stale, never as cache", () => {
    const d = decide({ entry: entry({ retrievedAt: NOW - 6 * M }), budgetAvailable: false });
    assert.equal(d.action, "serve-stale");
    assert.equal(d.reason, "budget-refused");
    assert.equal(d.lastRefreshOutcome, "skipped-budget");
    assert.equal(d.servedFrom, "stale-cache");
  });

  it("a copy older than staleServeMax is never shown, even when the budget refuses", () => {
    const d = decide({ entry: entry({ retrievedAt: NOW - 7 * H }), budgetAvailable: false });
    assert.equal(d.action, "nothing");
    assert.equal(d.lastRefreshOutcome, "skipped-budget");
    assert.equal(d.servedFrom, "none");
  });

  it("cached-ok serves anything within staleServeMax without spending budget", () => {
    const d = decide({ mode: "cached-ok", entry: entry({ retrievedAt: NOW - 5 * H }), budgetAvailable: false });
    assert.equal(d.action, "serve-cache");
    assert.equal(d.reason, "accepted-age");
    assert.equal(d.servedFrom, "cache");
    assert.equal(d.cacheAgeMs, 5 * H);
  });

  it("cached-ok fetches when the copy is too old to show", () => {
    const d = decide({ mode: "cached-ok", entry: entry({ retrievedAt: NOW - 7 * H }) });
    assert.equal(d.action, "fetch");
    assert.equal(d.reason, "no-copy");
    assert.equal(d.onFailure, "nothing");
  });

  it("force-refresh attempts upstream even when the copy is seconds old", () => {
    const d = decide({ mode: "force-refresh", entry: entry({ retrievedAt: NOW - 1 * S }) });
    assert.equal(d.action, "fetch");
    assert.equal(d.reason, "force-refresh");
    assert.equal(d.onFailure, "serve-stale");
  });

  it("force-refresh with no budget reports skipped-budget and labels the copy stale, even a fresh one", () => {
    const d = decide({ mode: "force-refresh", entry: entry({ retrievedAt: NOW - 1 * S }), budgetAvailable: false });
    assert.equal(d.action, "serve-stale");
    assert.equal(d.reason, "budget-refused");
    assert.equal(d.lastRefreshOutcome, "skipped-budget");
    assert.equal(d.servedFrom, "stale-cache");

    const f = buildFreshness({
      cls: "holdings",
      mode: "force-refresh",
      now: NOW,
      servedFrom: d.servedFrom ?? "none",
      retrievedAt: NOW - 1 * S,
      providerAsOf: null,
      lastRefreshAttemptAt: NOW - 1 * S,
      lastRefreshOutcome: d.lastRefreshOutcome,
    });
    assert.equal(f.servedFrom, "stale-cache");
    assert.equal(f.lastRefreshOutcome, "skipped-budget");
    assert.equal(f.cacheAgeMs, 1 * S);
  });

  it("force-refresh with no budget and no copy answers nothing, skipped-budget", () => {
    const d = decide({ mode: "force-refresh", entry: null, budgetAvailable: false });
    assert.equal(d.action, "nothing");
    assert.equal(d.lastRefreshOutcome, "skipped-budget");
    assert.equal(d.servedFrom, "none");
  });

  it("a recent failure backs off prefer-fresh and cached-ok, serving the labelled copy", () => {
    const failed = entry({ retrievedAt: NOW - 10 * M, lastAttemptAt: NOW - 5 * S, lastAttemptOutcome: "failed" });
    const d = decide({ entry: failed });
    assert.equal(d.action, "serve-stale");
    assert.equal(d.reason, "failure-backoff");
    assert.equal(d.lastRefreshOutcome, "failed");

    const none = decide({ entry: { ...failed, retrievedAt: null } });
    assert.equal(none.action, "nothing");
    assert.equal(none.lastRefreshOutcome, "failed");

    const later = decide({ entry: { ...failed, lastAttemptAt: NOW - DEFAULT_FAILURE_BACKOFF_MS } });
    assert.equal(later.action, "fetch", "the back-off ends");

    const custom = decide({ entry: failed, recentFailureBackoffMs: 1 * S });
    assert.equal(custom.action, "fetch");
  });

  it("a fresh copy is served during a back-off: the failure does not hide good data", () => {
    const d = decide({ entry: entry({ lastAttemptAt: NOW - 1 * S, lastAttemptOutcome: "failed" }) });
    assert.equal(d.action, "serve-cache");
  });

  it("force-refresh still tries after a failure, except inside the tiny window", () => {
    const outside = decide({ mode: "force-refresh", entry: entry({ lastAttemptAt: NOW - FORCE_REFRESH_MIN_RETRY_MS, lastAttemptOutcome: "failed" }) });
    assert.equal(outside.action, "fetch");
    const inside = decide({ mode: "force-refresh", entry: entry({ lastAttemptAt: NOW - 500, lastAttemptOutcome: "failed" }) });
    assert.equal(inside.action, "serve-stale");
    assert.equal(inside.reason, "failure-backoff");
    assert.equal(inside.lastRefreshOutcome, "failed");
  });

  it("budget-skipped attempts are not failures and cause no back-off", () => {
    const d = decide({ entry: entry({ retrievedAt: NOW - 6 * M, lastAttemptAt: NOW - 1 * S, lastAttemptOutcome: "skipped-budget" }) });
    assert.equal(d.action, "fetch");
  });

  it("reads small replica clock skew as age zero and a large one as an unknown age", () => {
    const small = decide({ entry: entry({ retrievedAt: NOW + CLOCK_SKEW_TOLERANCE_MS }) });
    assert.equal(small.action, "serve-cache");
    assert.equal(small.cacheAgeMs, 0);
    const large = decide({ entry: entry({ retrievedAt: NOW + 10 * M }), budgetAvailable: false });
    assert.equal(large.action, "nothing", "a copy of unknown age cannot be labelled honestly");
    assert.equal(large.cacheAgeMs, null);
  });

  it("an unusable clock decides nothing", () => {
    const d = decide({ now: Number.NaN });
    assert.equal(d.action, "nothing");
    assert.equal(d.reason, "invalid-clock");
  });

  it("an unknown mode from a tool argument is prefer-fresh", () => {
    const d = decide({ mode: "now!!" as never, entry: entry({ retrievedAt: NOW - 1 * S }) });
    assert.equal(d.action, "serve-cache");
  });

  it("uses each class's own policy", () => {
    const old = entry({ retrievedAt: NOW - 2 * M });
    assert.equal(decide({ cls: "activity", entry: old }).action, "fetch");
    assert.equal(decide({ cls: "rankings", entry: old }).action, "serve-cache");
  });
});

describe("buildFreshness", () => {
  it("keeps the five clocks distinct and never fills one from another", () => {
    const f = buildFreshness({
      cls: "activity",
      mode: "prefer-fresh",
      now: NOW,
      servedFrom: "live",
      retrievedAt: NOW - 200,
      providerAsOf: null,
      sourceEventTimes: [NOW - 50 * S, null, NOW - 5 * S, undefined, Number.NaN, NOW - 30 * S],
      lastRefreshAttemptAt: NOW - 900,
      lastRefreshOutcome: "ok",
    });
    assert.deepEqual(f, {
      policy: "activity",
      mode: "prefer-fresh",
      retrievedAt: NOW - 200,
      providerAsOf: null,
      sourceEventAt: { oldest: NOW - 50 * S, newest: NOW - 5 * S },
      lastRefreshAttemptAt: NOW - 900,
      lastRefreshOutcome: "ok",
      cacheAgeMs: 200,
      servedFrom: "live",
    });
  });

  it("does not believe provider or event times far in the future", () => {
    const f = buildFreshness({
      cls: "boards",
      mode: "cached-ok",
      now: NOW,
      servedFrom: "cache",
      retrievedAt: NOW - 1 * M,
      providerAsOf: NOW + 1 * H,
      sourceEventTimes: [NOW + 1 * H, NOW - 2 * M],
      lastRefreshAttemptAt: null,
      lastRefreshOutcome: "skipped-fresh",
    });
    assert.equal(f.providerAsOf, null);
    assert.deepEqual(f.sourceEventAt, { oldest: NOW - 2 * M, newest: NOW - 2 * M });
    assert.equal(f.cacheAgeMs, 1 * M);
  });

  it("keeps a provider capture time older than our retrieval", () => {
    const f = buildFreshness({
      cls: "rankings",
      mode: "prefer-fresh",
      now: NOW,
      servedFrom: "cache",
      retrievedAt: NOW - 1 * M,
      providerAsOf: NOW - 3 * H,
      lastRefreshAttemptAt: NOW - 1 * M,
      lastRefreshOutcome: "skipped-fresh",
    });
    assert.equal(f.providerAsOf, NOW - 3 * H);
    assert.equal(f.retrievedAt, NOW - 1 * M);
  });

  it("servedFrom none describes no copy but keeps what was tried", () => {
    const f = buildFreshness({
      cls: "theses",
      mode: "force-refresh",
      now: NOW,
      servedFrom: "none",
      retrievedAt: NOW - 1 * H,
      providerAsOf: NOW - 2 * H,
      sourceEventTimes: [NOW - 3 * H],
      lastRefreshAttemptAt: NOW - 1 * S,
      lastRefreshOutcome: "failed",
    });
    assert.equal(f.retrievedAt, null);
    assert.equal(f.providerAsOf, null);
    assert.deepEqual(f.sourceEventAt, { oldest: null, newest: null });
    assert.equal(f.cacheAgeMs, null);
    assert.equal(f.lastRefreshAttemptAt, NOW - 1 * S);
    assert.equal(f.lastRefreshOutcome, "failed");
  });

  it("sourceEventRange is null-safe", () => {
    assert.deepEqual(sourceEventRange(undefined), { oldest: null, newest: null });
    assert.deepEqual(sourceEventRange([0, -5, null]), { oldest: null, newest: null });
  });
});

// ── SingleFlight ──────────────────────────────────────────────────────────

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Lets queued microtasks and promise continuations run. */
const flush = () => new Promise<void>((r) => setImmediate(r));

function clock(start = NOW) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe("SingleFlight", () => {
  it("concurrent identical refreshes share one upstream call", async () => {
    const c = clock();
    const sf = new SingleFlight<string>({ now: c.now });
    const gate = deferred<string>();
    let calls = 0;
    const fn = () => { calls++; return gate.promise; };
    const a = sf.runDetailed("k", fn);
    const b = sf.runDetailed("k", fn);
    const d = sf.runDetailed("k", fn, { force: true });
    await flush();
    assert.equal(calls, 1);
    assert.equal(sf.size, 1);
    gate.resolve("v1");
    const [ra, rb, rd] = await Promise.all([a, b, d]);
    assert.deepEqual([ra.value, rb.value, rd.value], ["v1", "v1", "v1"]);
    assert.deepEqual([ra.shared, rb.shared, rd.shared], [false, true, true]);
    assert.equal(ra.startedAt, NOW);
    assert.equal(sf.size, 0, "the slot clears once settled");
  });

  it("different keys do not share", async () => {
    const sf = new SingleFlight<string>();
    let calls = 0;
    const [x, y] = await Promise.all([
      sf.run("a", async () => { calls++; return "a"; }),
      sf.run("b", async () => { calls++; return "b"; }),
    ]);
    assert.deepEqual([x, y, calls], ["a", "b", 2]);
  });

  it("an error reaches every joiner and clears the slot", async () => {
    const sf = new SingleFlight<string>();
    const gate = deferred<string>();
    let calls = 0;
    const fn = () => { calls++; return gate.promise; };
    const a = sf.run("k", fn);
    const b = sf.run("k", fn);
    gate.reject(new Error("http-503"));
    await assert.rejects(a, /http-503/);
    await assert.rejects(b, /http-503/);
    assert.equal(sf.size, 0);
    assert.equal(await sf.run("k", async () => { calls++; return "again"; }), "again");
    assert.equal(calls, 2, "a failure is not cached by the flight");
  });

  it("a synchronous throw becomes a rejection for every joiner", async () => {
    const sf = new SingleFlight<string>();
    const fn = (): Promise<string> => { throw new Error("boom"); };
    const a = sf.run("k", fn);
    const b = sf.run("k", fn);
    await assert.rejects(a, /boom/);
    await assert.rejects(b, /boom/);
    assert.equal(sf.size, 0);
  });

  it("a force-refresh joins a fetch that started inside the join window", async () => {
    const c = clock();
    const sf = new SingleFlight<string>({ now: c.now });
    const gate = deferred<string>();
    let calls = 0;
    const leader = sf.run("k", () => { calls++; return gate.promise; });
    c.advance(1_500);
    const forced = sf.runDetailed("k", async () => { calls++; return "second"; }, { force: true });
    await flush();
    gate.resolve("first");
    assert.equal(await leader, "first");
    const r = await forced;
    assert.equal(r.value, "first");
    assert.equal(r.shared, true);
    assert.equal(calls, 1);
  });

  it("a force-refresh never receives a fetch that started before its window; it waits, then fetches anew", async () => {
    const c = clock();
    const sf = new SingleFlight<string>({ now: c.now, joinWindowMs: 2_000 });
    const old = deferred<string>();
    const fresh = deferred<string>();
    let running = 0;
    let maxRunning = 0;
    const track = (p: Promise<string>) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      return p.finally(() => { running--; });
    };
    const slow = sf.run("k", () => track(old.promise));
    c.advance(5_000);
    let freshCalls = 0;
    const forced = sf.runDetailed("k", () => { freshCalls++; return track(fresh.promise); }, { force: true });
    // A plain request arriving now still joins the old fetch: it asked for no more than that.
    const plain = sf.runDetailed("k", async () => "never");
    await flush();
    assert.equal(freshCalls, 0, "it must not race the old fetch");
    old.resolve("old-result");
    assert.equal(await slow, "old-result");
    assert.equal((await plain).value, "old-result");
    await flush();
    assert.equal(freshCalls, 1);
    fresh.resolve("new-result");
    const r = await forced;
    assert.equal(r.value, "new-result", "no stale substitution");
    assert.equal(r.shared, false);
    assert.equal(r.startedAt, NOW + 5_000);
    assert.equal(maxRunning, 1, "never two fetches for one key at once");
  });

  it("two force requests stuck behind an old fetch share the one new fetch", async () => {
    const c = clock();
    const sf = new SingleFlight<string>({ now: c.now });
    const old = deferred<string>();
    void sf.run("k", () => old.promise);
    c.advance(10_000);
    let calls = 0;
    const fn = async () => { calls++; return `new-${calls}`; };
    const f1 = sf.runDetailed("k", fn, { force: true });
    const f2 = sf.runDetailed("k", fn, { force: true });
    old.resolve("old");
    const [r1, r2] = await Promise.all([f1, f2]);
    assert.equal(calls, 1);
    assert.equal(r1.value, "new-1");
    assert.equal(r2.value, "new-1");
    assert.equal([r1.shared, r2.shared].filter(Boolean).length, 1);
  });

  it("a force request waiting on an old fetch ignores that fetch's failure and gets its own result", async () => {
    const c = clock();
    const sf = new SingleFlight<string>({ now: c.now });
    const old = deferred<string>();
    const slow = sf.run("k", () => old.promise);
    c.advance(3_000);
    const forced = sf.run("k", async () => "mine", { force: true });
    old.reject(new Error("timeout"));
    await assert.rejects(slow, /timeout/);
    assert.equal(await forced, "mine");
  });

  it("requestedAt is honoured: an earlier request may join a fetch started after it", async () => {
    const c = clock();
    const sf = new SingleFlight<string>({ now: c.now });
    const gate = deferred<string>();
    void sf.run("k", () => gate.promise);
    c.advance(4_000);
    let calls = 0;
    const forced = sf.runDetailed("k", async () => { calls++; return "x"; }, { force: true, requestedAt: NOW - 500 });
    gate.resolve("joined");
    assert.equal((await forced).value, "joined");
    assert.equal(calls, 0);
  });

  it("an aborted joiner stops waiting without cancelling the shared fetch", async () => {
    const sf = new SingleFlight<string>();
    const gate = deferred<string>();
    const leader = sf.run("k", () => gate.promise);
    const ac = new AbortController();
    const joiner = sf.run("k", async () => "never", { signal: ac.signal });
    ac.abort(new Error("caller went away"));
    await assert.rejects(joiner, /caller went away/);
    gate.resolve("done");
    assert.equal(await leader, "done");
    const pre = new AbortController();
    pre.abort();
    let calls = 0;
    await assert.rejects(sf.run("k2", async () => { calls++; return "x"; }, { signal: pre.signal }));
    assert.equal(calls, 0, "an already-aborted caller starts nothing");
  });
});

describe("freshness.ts boundary", () => {
  it("reads no environment and calls no network", () => {
    const src = readFileSync(new URL("./freshness.ts", import.meta.url), "utf8");
    assert.ok(!/process\.env/.test(src));
    assert.ok(!/\bfetch\s*\(/.test(src), "no network call");
    assert.ok(!/fomoapi\.io/.test(src));
  });
});
