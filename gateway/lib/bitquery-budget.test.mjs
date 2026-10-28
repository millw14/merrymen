/**
 * THE GATEWAY'S FLEET-WIDE BITQUERY CAP — one daily allowance across every
 * holder and the public memescope, reserved before each upstream call, in two
 * purses: the memescope's own share, and the holders' rest.
 *
 * Before the worker sent holders' tokens where the gateway reads them, every
 * holder's discovery call was a 401 and spent nothing. Once it was fixed, each
 * holder polling at the default interval costs roughly 720 points a day, and
 * the per-address bucket bounds one holder, never all of them. These pin the
 * cap that bounds all of them. No network: fetch is stubbed throughout.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { bitqueryPointsPerDayFrom, BITQUERY_POINTS_PER_DAY_CEILING, createGateway, DEFAULTS } from "./core.mjs";
import { createStore } from "./store.mjs";

const SECRET = "test-secret-at-least-32-bytes-long-for-hmac!!";
const HOLDER = "0x1111111111111111111111111111111111111111";
const MEME = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Counts upstream calls; answers like Bitquery with one Initialize event. */
function stubUpstream() {
  const seen = { calls: 0 };
  globalThis.fetch = async () => {
    seen.calls++;
    const body = { data: { EVM: { Events: [{ Block: { Time: "2026-10-12T00:00:00Z" }, Transaction: { Hash: "0xbeef" }, Arguments: [{ Value: { address: USDG } }, { Value: { address: MEME } }] }] } } };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  return seen;
}

function gateway(over = {}) {
  return createGateway({
    secret: SECRET,
    upstreamUrl: "https://example.invalid",
    upstreamKey: "x",
    model: "test-model",
    domain: "merrymen.dev",
    minTokens: 10_000n,
    tokenAddress: "0x0000000000000000000000000000000000000000",
    bitqueryKey: "k",
    bitqueryUrl: "https://example.invalid/graphql",
    publicClient: { readContract: async ({ functionName }) => (functionName === "symbol" ? "PEPE" : functionName === "decimals" ? 18 : 10_000n * 10n ** 18n) },
    store: createStore(),
    ...over,
    // No page share unless a test gives one: the holders' tests count the whole day.
    tunables: { BITQUERY_RATE_PER_MIN: 1_000, MEMESCOPE_RATE_PER_MIN: 1_000, MEMESCOPE_TTL_SEC: 0, MEMESCOPE_SHARE: 0, ...(over.tunables ?? {}) },
  });
}

describe("MERRYMEN_GATEWAY_BITQUERY_POINTS_PER_DAY", () => {
  it("defaults to 12,500 a day: the memescope's 10,000 plus the holders' 2,500, under the ceiling", () => {
    assert.equal(DEFAULTS.BITQUERY_POINTS_PER_DAY, 12_500);
    assert.deepEqual(bitqueryPointsPerDayFrom(undefined), { points: 12_500, note: null });
    const scope = Math.floor(DEFAULTS.BITQUERY_POINTS_PER_DAY * DEFAULTS.MEMESCOPE_SHARE);
    const holders = DEFAULTS.BITQUERY_POINTS_PER_DAY - scope;
    assert.deepEqual([scope, holders], [10_000, 2_500]);
    assert.equal(scope + holders, DEFAULTS.BITQUERY_POINTS_PER_DAY, "the two purses are the whole day, no more");
    assert.equal(BITQUERY_POINTS_PER_DAY_CEILING, 30_000);
    assert.ok(DEFAULTS.BITQUERY_POINTS_PER_DAY <= BITQUERY_POINTS_PER_DAY_CEILING, "the default is not clamped");
  });

  it("the memescope keeps its 45 s refresh, and its whole day of refreshes fits its share, so the page never freezes", () => {
    assert.equal(DEFAULTS.MEMESCOPE_TTL_SEC, 45, "the public page is not slowed to fit a budget");
    const share = Math.floor(DEFAULTS.BITQUERY_POINTS_PER_DAY * DEFAULTS.MEMESCOPE_SHARE);
    const refreshes = Math.ceil(86_400 / DEFAULTS.MEMESCOPE_TTL_SEC) + 1;
    assert.equal(refreshes * 5, 9_605);
    assert.ok(refreshes * 5 <= share, `${refreshes} refreshes × 5 points within ${share}`);
    assert.equal(DEFAULTS.BITQUERY_POINTS_PER_DAY - share, 2_500, "the holders' purse");
    assert.ok(DEFAULTS.BITQUERY_POINTS_PER_HOLDER_PER_DAY <= DEFAULTS.BITQUERY_POINTS_PER_DAY - share, "one holder's share is never above the holders' purse");
  });

  it("takes a positive whole number, clamps at the ceiling, and never echoes a bad value", () => {
    assert.deepEqual(bitqueryPointsPerDayFrom(" 2000 "), { points: 2_000, note: null });
    const high = bitqueryPointsPerDayFrom("999999");
    assert.equal(high.points, BITQUERY_POINTS_PER_DAY_CEILING);
    assert.match(high.note, /above the ceiling/);
    for (const bad of ["0", "-5", "1.5", "ory_at_pasted_here"]) {
      const r = bitqueryPointsPerDayFrom(bad);
      assert.equal(r.points, DEFAULTS.BITQUERY_POINTS_PER_DAY, bad);
      assert.match(r.note, new RegExp(`\\(${bad.length} characters\\)`));
      assert.ok(!r.note.includes(bad) || /^\d$/.test(bad), "the value itself is not in the line");
    }
  });
});

describe("one daily allowance, reserved before every upstream call", () => {
  it("holder discovery stops at the cap with a 503 that says so, and the refused call is never sent", async () => {
    const upstream = stubUpstream();
    const gw = gateway({ tunables: { BITQUERY_POINTS_PER_DAY: 10 } });
    const token = gw._tokens.issueToken(HOLDER);
    assert.equal((await gw.bitquery({ token, body: { query: "ping" }, ip: "1.1.1.1" })).status, 200);
    assert.equal((await gw.bitquery({ token, body: { query: "recentPools" }, ip: "1.1.1.1" })).status, 200);
    const third = await gw.bitquery({ token, body: { query: "ping" }, ip: "1.1.1.1" });
    assert.equal(third.status, 503);
    assert.match(third.json.error, /daily discovery allowance is spent/);
    assert.equal(upstream.calls, 2, "a refusal costs nothing upstream");
  });

  it("is fleet-wide: a second holder shares the first one's day", async () => {
    const upstream = stubUpstream();
    const gw = gateway({ tunables: { BITQUERY_POINTS_PER_DAY: 5 } });
    assert.equal((await gw.bitquery({ token: gw._tokens.issueToken(HOLDER), body: { query: "ping" }, ip: "1.1.1.1" })).status, 200);
    const other = await gw.bitquery({ token: gw._tokens.issueToken("0x2222222222222222222222222222222222222222"), body: { query: "ping" }, ip: "2.2.2.2" });
    assert.equal(other.status, 503);
    assert.equal(upstream.calls, 1);
  });

  it("one holder polling flat out stops at its own share, and a second holder's first call still goes through", async () => {
    const upstream = stubUpstream();
    const gw = gateway({ tunables: { MEMESCOPE_SHARE: DEFAULTS.MEMESCOPE_SHARE } });
    const greedy = gw._tokens.issueToken(HOLDER);
    let calls = 0;
    let refused;
    for (; calls < 1_440; calls++) {
      const r = await gw.bitquery({ token: greedy, body: { query: "recentPools" }, ip: "1.1.1.1" });
      if (r.status !== 200) { refused = r; break; }
    }
    assert.equal(calls, DEFAULTS.BITQUERY_POINTS_PER_HOLDER_PER_DAY / 5, "a one-minute poller stops at its own 750 points");
    assert.equal(refused.status, 429);
    assert.match(refused.json.error, /this wallet's own share of today's discovery is spent/);
    assert.equal(upstream.calls, calls, "the refused call was never sent");
    const other = await gw.bitquery({ token: gw._tokens.issueToken("0x2222222222222222222222222222222222222222"), body: { query: "recentPools" }, ip: "2.2.2.2" });
    assert.equal(other.status, 200, "another holder is not starved");
    assert.ok(DEFAULTS.BITQUERY_POINTS_PER_HOLDER_PER_DAY >= 144 * 5, "the default ten-minute interval fits a holder's share all day");
  });

  it("a call refused by a holder's own share hands the purse's points back", async () => {
    const upstream = stubUpstream();
    const gw = gateway({ tunables: { BITQUERY_POINTS_PER_DAY: 20, BITQUERY_POINTS_PER_HOLDER_PER_DAY: 10 } });
    const a = gw._tokens.issueToken(HOLDER);
    const b = gw._tokens.issueToken("0x2222222222222222222222222222222222222222");
    assert.equal((await gw.bitquery({ token: a, body: { query: "ping" }, ip: "1.1.1.1" })).status, 200);
    assert.equal((await gw.bitquery({ token: a, body: { query: "ping" }, ip: "1.1.1.1" })).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await gw.bitquery({ token: a, body: { query: "ping" }, ip: "1.1.1.1" })).status, 429);
    // The purse still has its other 10 for b, not 10 minus what a was refused.
    assert.equal((await gw.bitquery({ token: b, body: { query: "ping" }, ip: "2.2.2.2" })).status, 200);
    assert.equal((await gw.bitquery({ token: b, body: { query: "ping" }, ip: "2.2.2.2" })).status, 200);
    const spent = await gw.bitquery({ token: b, body: { query: "ping" }, ip: "2.2.2.2" });
    assert.equal(spent.status, 503, "then the purse is spent for everyone");
    assert.equal(upstream.calls, 4);
  });

  it("a bad token, a non-holder or an unknown query spends none of it", async () => {
    stubUpstream();
    const gw = gateway({ tunables: { BITQUERY_POINTS_PER_DAY: 5 } });
    const token = gw._tokens.issueToken(HOLDER);
    assert.equal((await gw.bitquery({ token: "mmk_bad.x", body: { query: "ping" }, ip: "1.1.1.1" })).status, 401);
    assert.equal((await gw.bitquery({ token, body: { query: "{ raw }" }, ip: "1.1.1.1" })).status, 400);
    const poor = gateway({ tunables: { BITQUERY_POINTS_PER_DAY: 5 }, publicClient: { readContract: async () => 0n } });
    assert.equal((await poor.bitquery({ token: poor._tokens.issueToken(HOLDER), body: { query: "ping" }, ip: "1.1.1.1" })).status, 403);
    assert.equal((await gw.bitquery({ token, body: { query: "ping" }, ip: "1.1.1.1" })).status, 200, "the whole allowance is still there");
  });

  it("the public memescope spends only its own share: stale rows once it is gone, an honest 503 with none", async () => {
    const upstream = stubUpstream();
    const store = createStore();
    // 20 a day: 10 for the page, 10 for holders.
    const tunables = { BITQUERY_POINTS_PER_DAY: 20, MEMESCOPE_SHARE: 0.5 };
    const gw = gateway({ store, tunables });
    assert.equal((await gw.memescope({ ip: "9.9.9.1" })).status, 200, "first refresh fits");
    assert.equal((await gw.memescope({ ip: "9.9.9.1" })).status, 200, "and the second: the page's 10");
    const stale = await gw.memescope({ ip: "9.9.9.1" });
    assert.equal(stale.status, 200);
    assert.equal(stale.json.stale, true, "the page keeps its rows rather than blanking");
    assert.equal(upstream.calls, 2);
    const empty = gateway({ tunables, store });
    const none = await empty.memescope({ ip: "9.9.9.2" });
    assert.equal(none.status, 503);
    assert.equal(upstream.calls, 2, "no refresh was attempted past its share");
    // The holders' purse was never touched by the page.
    const token = gw._tokens.issueToken(HOLDER);
    assert.equal((await gw.bitquery({ token, body: { query: "ping" }, ip: "1.1.1.1" })).status, 200);
    assert.equal((await gw.bitquery({ token, body: { query: "ping" }, ip: "1.1.1.1" })).status, 200);
    assert.equal((await gw.bitquery({ token, body: { query: "ping" }, ip: "1.1.1.1" })).status, 503, "holders stop at their own 10");
  });

  it("a whole UTC day of one open tab polling every 45 s refreshes on every poll and leaves every holder's share intact", async () => {
    const upstream = stubUpstream();
    const realNow = Date.now;
    const start = Date.parse("2026-10-12T00:00:00Z");
    let now = start;
    Date.now = () => now;
    try {
      const gw = gateway({ tunables: { MEMESCOPE_TTL_SEC: DEFAULTS.MEMESCOPE_TTL_SEC, MEMESCOPE_SHARE: DEFAULTS.MEMESCOPE_SHARE } });
      let stale = 0;
      let polls = 0;
      let fresh = 0;
      // The site's own poll (site/components/MemescopeClient.tsx, POLL_MS).
      for (; now < start + 86_400_000 - 1_000; now += 45_000) {
        const r = await gw.memescope({ ip: "9.9.9.9" });
        polls++;
        assert.equal(r.status, 200);
        if (r.json.stale) stale++;
        if (r.json.cached === false) fresh++;
      }
      assert.equal(stale, 0, "the page refreshed all day: it never ran out of its share");
      assert.equal(fresh, polls, "every 45 s poll got a new refresh: the page is not slowed");
      assert.ok(upstream.calls * 5 <= Math.floor(DEFAULTS.BITQUERY_POINTS_PER_DAY * DEFAULTS.MEMESCOPE_SHARE), `${upstream.calls} refreshes`);
      now = start + 18 * 3_600_000;
      const ping = await gw.bitquery({ token: gw._tokens.issueToken(HOLDER), body: { query: "ping" }, ip: "1.1.1.1" });
      assert.equal(ping.status, 200, "a holder at 18:00 UTC still has discovery");
    } finally {
      Date.now = realNow;
    }
  });

  it("an hour of Bitquery failing while tabs poll every 5 s costs one attempt per TTL, and the page recovers with it", async () => {
    const realNow = Date.now;
    const start = Date.parse("2026-10-12T06:00:00Z");
    let now = start;
    Date.now = () => now;
    const error = console.error;
    console.error = () => {};
    let attempts = 0;
    let down = true;
    globalThis.fetch = async () => {
      attempts++;
      if (down) return { ok: false, status: 502, text: async () => "", json: async () => ({}) };
      const body = { data: { EVM: { Events: [{ Block: { Time: "2026-10-12T00:00:00Z" }, Transaction: { Hash: "0xbeef" }, Arguments: [{ Value: { address: USDG } }, { Value: { address: MEME } }] }] } } };
      return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
    };
    try {
      const store = createStore();
      const gw = gateway({ store, tunables: { MEMESCOPE_TTL_SEC: DEFAULTS.MEMESCOPE_TTL_SEC, MEMESCOPE_SHARE: DEFAULTS.MEMESCOPE_SHARE } });
      // Polls well inside the TTL, as several open tabs make: without the
      // backoff each one would be a paid attempt (720 in the hour).
      let polls = 0;
      for (; now < start + 3_600_000; now += 5_000) {
        const r = await gw.memescope({ ip: "9.9.9.9" });
        polls++;
        assert.equal(r.status, 502, "nothing cached yet: an honest 502");
      }
      const ttl = DEFAULTS.MEMESCOPE_TTL_SEC * 1000;
      assert.equal(polls, 720);
      assert.ok(attempts <= Math.ceil(3_600_000 / ttl) + 1, `${attempts} paid attempts in an hour of failures`);
      assert.ok(attempts >= 3_600_000 / ttl - 1, "and it kept trying, once per TTL");
      // Bitquery comes back: within one TTL the page refreshes, its share far from spent.
      down = false;
      let recovered = null;
      for (const until = now + ttl + 5_000; now <= until && !recovered; now += 5_000) {
        const r = await gw.memescope({ ip: "9.9.9.9" });
        if (r.status === 200 && !r.json.stale) recovered = r;
      }
      assert.ok(recovered, "a fresh refresh once the upstream is back");
      assert.equal(recovered.json.pools.length, 1);
      const share = Math.floor(DEFAULTS.BITQUERY_POINTS_PER_DAY * DEFAULTS.MEMESCOPE_SHARE);
      // Every attempt, failed or not, was exactly one reservation: the rest of the share is still there.
      assert.equal(await store.reservePoints("bq-scope-points:2026-10-12", share - attempts * 5, share, 60), true);
      assert.equal(await store.reservePoints("bq-scope-points:2026-10-12", 1, share, 60), false);
    } finally {
      Date.now = realNow;
      console.error = error;
    }
  });

  it("with rows cached, a failed refresh serves them stale until the next attempt is due", async () => {
    const realNow = Date.now;
    let now = Date.parse("2026-10-12T06:00:00Z");
    Date.now = () => now;
    const error = console.error;
    console.error = () => {};
    try {
      const upstream = stubUpstream();
      const ttl = DEFAULTS.MEMESCOPE_TTL_SEC * 1000;
      const gw = gateway({ tunables: { MEMESCOPE_TTL_SEC: DEFAULTS.MEMESCOPE_TTL_SEC, MEMESCOPE_SHARE: DEFAULTS.MEMESCOPE_SHARE } });
      assert.equal((await gw.memescope({ ip: "9.9.9.9" })).status, 200);
      const ok = globalThis.fetch;
      globalThis.fetch = async () => { upstream.calls++; throw new Error("network"); };
      now += ttl + 1_000;
      const failedAt = now;
      const failed = await gw.memescope({ ip: "9.9.9.9" });
      assert.equal(failed.json.stale, true);
      for (let i = 1; i <= 5; i++) {
        now += 5_000;
        const r = await gw.memescope({ ip: "9.9.9.9" });
        assert.equal(r.status, 200);
        assert.equal(r.json.stale, true);
      }
      assert.ok(now < failedAt + ttl, "those polls were all inside the TTL");
      assert.equal(upstream.calls, 2, "one refresh, one failed attempt, and nothing more inside its TTL");
      globalThis.fetch = ok;
      now = failedAt + ttl;
      const back = await gw.memescope({ ip: "9.9.9.9" });
      assert.equal(back.json.stale, undefined, "the next due attempt refreshes");
      assert.equal(upstream.calls, 3);
    } finally {
      Date.now = realNow;
      console.error = error;
    }
  });

  it("a store that cannot count refuses, rather than spending what it cannot count", async () => {
    const upstream = stubUpstream();
    const base = createStore();
    const broken = { ...base, reservePoints: async () => null };
    const gw = gateway({ store: broken });
    const r = await gw.bitquery({ token: gw._tokens.issueToken(HOLDER), body: { query: "ping" }, ip: "1.1.1.1" });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /cannot count/);
    const old = { ...base };
    delete old.reservePoints;
    const legacy = gateway({ store: old });
    assert.equal((await legacy.bitquery({ token: legacy._tokens.issueToken(HOLDER), body: { query: "ping" }, ip: "1.1.1.1" })).status, 503);
    assert.equal(upstream.calls, 0);
  });

  it("the in-memory counter refuses past the cap without consuming, and keeps days apart", async () => {
    const s = createStore();
    assert.equal(await s.reservePoints("d1", 5, 8, 60), true);
    assert.equal(await s.reservePoints("d1", 5, 8, 60), false);
    assert.equal(await s.reservePoints("d1", 3, 8, 60), true, "the refused 5 were not counted");
    assert.equal(await s.reservePoints("d2", 5, 8, 60), true, "another day is another allowance");
    await s.releasePoints("d2", 5);
    assert.equal(await s.reservePoints("d2", 8, 8, 60), true, "points handed back are free again");
    await s.releasePoints("d3", 5);
    assert.equal(await s.reservePoints("d3", 8, 8, 60), true, "a release never makes room past the cap");
    assert.equal(await s.reservePoints("d3", 1, 8, 60), false);
  });
});
