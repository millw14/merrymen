import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FleetFeedCache, type FeedResult } from "./fleet-feed-cache";

test("independent fleet connections coalesce a page request and preserve observation time", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "gecko-cache-"));
  const a = new FleetFeedCache(home), b = new FleetFeedCache(home);
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
  } finally { a.close(); b.close(); rmSync(home, { recursive: true, force: true }); }
});

test("429 cooldown is shared across pages while a fresh cached page remains readable", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "gecko-cache-"));
  const a = new FleetFeedCache(home), b = new FleetFeedCache(home);
  try {
    const unavailable = (failure: string) => ({ failed: true, failure });
    await a.get<FeedResult>("fresh", async () => ({ failed: false, observedAt: Date.now() }), unavailable);
    await a.get<FeedResult>("limited", async () => ({ failed: true, failure: "http-429", retryAfterMs: 120_000 }), unavailable);
    let calls = 0;
    const request = async () => { calls++; return { failed: false }; };
    assert.equal((await b.get<FeedResult>("other-page", request, unavailable)).failure, "http-429");
    assert.equal((await b.get<FeedResult>("fresh", request, unavailable)).failed, false);
    assert.equal(calls, 0);
  } finally { a.close(); b.close(); rmSync(home, { recursive: true, force: true }); }
});

test("expired observations are fetched again and thrown requests release their lease", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "gecko-cache-"));
  const a = new FleetFeedCache(home);
  try {
    const unavailable = (failure: string) => ({ failed: true, failure });
    await a.get<FeedResult>("old", async () => ({ failed: false, observedAt: Date.now() - 61_000 }), unavailable);
    let calls = 0;
    await a.get<FeedResult>("old", async () => { calls++; return { failed: false, observedAt: Date.now() }; }, unavailable);
    assert.equal(calls, 1);
    await assert.rejects(a.get<FeedResult>("thrown", async () => { throw new Error("offline"); }, unavailable));
    assert.equal((await a.get<FeedResult>("thrown", async () => ({ failed: false }), unavailable)).failed, false);
  } finally { a.close(); rmSync(home, { recursive: true, force: true }); }
});
