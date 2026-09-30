/**
 * The durable backtest queue and its runner, on an in-memory sqlite database:
 * idempotent enqueue under a per-owner quota, a claim only one caller can win,
 * fenced writes after a lapsed lease, recovery up to three attempts, cancel
 * and deadline handling, oracle resampling that never interpolates or looks
 * ahead, and a full run whose numbers add up. No test reads a chain: every
 * oracle history is a fake handed in through `readFeed`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, test } from "node:test";
import { wrapSqlite, type Db } from "../db";
import { runBacktest, type Bar } from "../backtest";
import type { FeedHistory, FeedPoint } from "../read-feed-history";
import { CASH, STOCK_TOKENS } from "../../../packages/core/src/tokens";
import { ensureMcpSchema } from "./schema";
import {
  JOB_LIMITS, ORACLE_STALE_AFTER_SEC, boundResult, cancelJob, claimNextJob, downsample, enqueueJob, finishJob, getJobRow, heartbeatJob,
  listJobRows, oracleFeedReader, resampleOracle, resetMcpJobsForTest, runMcpJobsPass, sweepJobs, validateBacktestParams,
  type BacktestJobResult, type BacktestParams, type JobRow,
} from "./jobs";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const T = 1_800_000_000; // hour-aligned
const H = 3600;
const LEASE = 80;
const quiet = () => {};

afterEach(() => resetMcpJobsForTest());

async function freshDb(): Promise<{ db: Db; raw: DatabaseSync }> {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await ensureMcpSchema(db, "sqlite");
  return { db, raw };
}

function params(over: Record<string, unknown> = {}): BacktestParams {
  const v = validateBacktestParams({
    strategy: "steady-basket", symbols: ["NVDA", "SPY"], data: "synthetic", days: 60, initial_usdg: 1000, variants: [{ label: "base" }], ...over,
  });
  assert.ok(v.ok, v.ok ? "" : v.why);
  return v.params;
}

const enqueue = (db: Db, o: { tenant?: string; p?: BacktestParams; key?: string | null; now?: number } = {}) =>
  enqueueJob(db, { tenant: o.tenant ?? A, connectionId: "conn-1", params: o.p ?? params(), idempotencyKey: o.key ?? null, now: o.now ?? T });

const row = async (db: Db, id: string, tenant = A) => (await getJobRow(db, tenant, id))!;
const resultOf = (r: JobRow) => JSON.parse(r.result_json!) as BacktestJobResult;

// ── params ──────────────────────────────────────────────────────────────────

describe("validateBacktestParams", () => {
  test("normalises symbols, money and the seed so equal requests serialise equally", () => {
    const a = params({ symbols: ["nvda", "Spy"], initial_usdg: 1000.004, variants: [{ label: "x", buy_per_tick_usdg: 25.126 }] });
    assert.deepEqual(a.symbols, ["NVDA", "SPY"]);
    assert.equal(a.initial_usdg, 1000);
    assert.equal(a.seed, 42);
    assert.equal(a.variants[0]!.buy_per_tick_usdg, 25.13);
    assert.equal(JSON.stringify(a), JSON.stringify(params({ symbols: ["NVDA", "SPY"], initial_usdg: 1000, seed: 42, variants: [{ label: "x", buy_per_tick_usdg: 25.13 }] })));
    assert.equal(params({ data: "oracle", days: 30 }).seed, null);
  });

  test("refuses what cannot be replayed or is out of bounds", () => {
    const why = (over: Record<string, unknown>) => {
      const v = validateBacktestParams({ strategy: "steady-basket", symbols: ["NVDA"], data: "synthetic", days: 30, initial_usdg: 1000, variants: [{ label: "a" }], ...over });
      assert.equal(v.ok, false, JSON.stringify(over));
      return (v as { why: string }).why;
    };
    assert.match(why({ strategy: "llm-strategist" }), /steady-basket, weekend-gap/);
    assert.match(why({ strategy: "trencher" }), /steady-basket, weekend-gap/);
    assert.match(why({ symbols: ["PEPE"] }), /memecoins/);
    assert.match(why({ symbols: ["BE"], data: "oracle" }), /no Chainlink feed/);
    assert.match(why({ symbols: ["NVDA", "nvda"] }), /twice/);
    assert.match(why({ symbols: [] }), /1 to 8/);
    assert.match(why({ symbols: ["A", "B", "C", "D", "E", "F", "G", "H", "I"] }), /1 to 8/);
    assert.match(why({ data: "oracle", days: 61 }), /1 to 60/);
    assert.match(why({ days: 366 }), /1 to 365/);
    assert.match(why({ days: 1.5 }), /whole number/);
    assert.match(why({ initial_usdg: 99 }), /100 to 1000000/);
    assert.match(why({ initial_usdg: 1_000_001 }), /100 to 1000000/);
    assert.match(why({ data: "oracle", seed: 7 }), /synthetic/);
    assert.match(why({ variants: [] }), /1 to 4/);
    assert.match(why({ variants: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }, { label: "e" }] }), /1 to 4/);
    assert.match(why({ variants: [{ label: "a" }, { label: "A" }] }), /used twice/);
    assert.match(why({ variants: [{ label: "a", execution_cost_bps: 501 }] }), /0 to 500/);
    assert.match(why({ variants: [{ label: "a", per_trade_usdg: 0 }] }), /above 0/);
    assert.match(why({ variants: [{ label: "a", max_drawdown_pct: 0.5 }] }), /1 to 100/);
    assert.match(why({ variants: [{ label: "a", take_profit_bps: 5 }] }), /unknown variant field/);
    assert.match(why({ variants: [{ label: "<script>" }] }), /label/);
    assert.match(why({ extra: 1 }), /unknown field/);
    // BE has no feed but is a stock token: synthetic data is fine.
    assert.equal(validateBacktestParams({ strategy: "weekend-gap", symbols: ["BE"], data: "synthetic", days: 30, initial_usdg: 1000, variants: [{ label: "a" }] }).ok, true);
  });
});

// ── the queue ───────────────────────────────────────────────────────────────

describe("enqueue", () => {
  test("the same idempotency key returns the same job; a different request under it conflicts; keys are per owner", async () => {
    const { db, raw } = await freshDb();
    const first = await enqueue(db, { key: "key-000001" });
    assert.equal(first.created, true);
    assert.match(first.row.id, /^job_[0-9a-f]{32}$/);
    assert.equal(first.row.status, "queued");
    assert.equal(first.row.deadline_at, T + JOB_LIMITS.deadlineSec);
    const again = await enqueue(db, { key: "key-000001", now: T + 5 });
    assert.equal(again.created, false);
    assert.equal(again.row.id, first.row.id);
    await assert.rejects(enqueue(db, { key: "key-000001", p: params({ days: 61 }) }), (e: Error & { code?: string }) => e.code === "conflict");
    const otherOwner = await enqueue(db, { tenant: B, key: "key-000001" });
    assert.equal(otherOwner.created, true);
    assert.notEqual(otherOwner.row.id, first.row.id);
    assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM mcp_jobs").get() as { n: number }).n, 2);
  });

  test("at most two queued or running jobs per owner; a finished one frees a slot", async () => {
    const { db } = await freshDb();
    const one = await enqueue(db);
    const keyed = await enqueue(db, { key: "key-000002" });
    await assert.rejects(enqueue(db), (e: Error & { code?: string }) => e.code === "quota_exceeded");
    // An idempotent replay of an existing job is not a new job, so it is not refused.
    const replay = await enqueue(db, { key: "key-000002" });
    assert.equal(replay.created, false);
    assert.equal(replay.row.id, keyed.row.id);
    // Another owner is not affected.
    assert.equal((await enqueue(db, { tenant: B })).created, true);
    await cancelJob(db, A, one.row.id, T);
    assert.equal((await enqueue(db)).created, true);
  });

  test("on Postgres the quota check and insert run under the owner's advisory lock, taken first in the transaction", async () => {
    // No Postgres here: a recording Db over sqlite answers the lock call and
    // shows where it sits. Two owners get different keys; one owner, one key,
    // whatever the address casing.
    const { db } = await freshDb();
    const trail: string[] = [];
    const record = (inner: Db): Db => ({
      prepare(sql: string) {
        const head = sql.replace(/\s+/g, " ").trim().split(" ").slice(0, 3).join(" ");
        if (/pg_advisory_xact_lock/.test(sql)) {
          return {
            run: async () => ({ changes: 0, lastInsertRowid: 0 }),
            all: async () => [],
            get: async (...p: unknown[]) => { trail.push(`lock ${p.map(String).join(",")}`); return {}; },
          };
        }
        trail.push(head);
        return inner.prepare(sql);
      },
      exec: (sql: string) => inner.exec(sql),
      tx: <R>(fn: (d: Db) => Promise<R>) => { trail.push("BEGIN"); return inner.tx((t) => fn(record(t))); },
    });
    const pg = record(db);
    const go = (tenant: string, key: string | null) =>
      enqueueJob(pg, { tenant, connectionId: null, params: params(), idempotencyKey: key, now: T, dialect: "postgres" });
    await go(A, "key-000009");
    assert.equal(trail[0], "BEGIN");
    assert.match(trail[1]!, /^lock 1297692103,-?\d+$/);
    assert.deepEqual(trail.slice(2, 5).map((s) => s.split(" ")[0]), ["SELECT", "SELECT", "INSERT"], trail.join(" | "));
    const lockA = trail[1];
    trail.length = 0;
    await go(A.toUpperCase().replace("0X", "0x"), null);
    assert.equal(trail[1], lockA, "the same owner in another casing takes the same lock");
    trail.length = 0;
    await go(B, null);
    assert.notEqual(trail[1], lockA, "another owner takes another lock");
    trail.length = 0;
    // The sqlite dialect takes no lock (sqlite serialises writers itself).
    await enqueueJob(pg, { tenant: B, connectionId: null, params: params(), idempotencyKey: null, now: T });
    assert.equal(trail.some((s) => s.startsWith("lock")), false);
  });

  test("an owner's jobs are invisible to everyone else", async () => {
    const { db } = await freshDb();
    const { row: job } = await enqueue(db);
    assert.equal(await getJobRow(db, B, job.id), null);
    assert.deepEqual(await listJobRows(db, B, { limit: 10 }), []);
    await assert.rejects(cancelJob(db, B, job.id, T), (e: Error & { code?: string }) => e.code === "not_found");
    assert.equal((await row(db, job.id)).status, "queued");
  });

  test("listing is newest first, paged, and never carries results", async () => {
    const { db } = await freshDb();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) ids.push((await enqueue(db, { now: T + i })).row.id);
    await db.prepare("UPDATE mcp_jobs SET status = 'succeeded', result_json = '{}'").run();
    ids.push((await enqueue(db, { now: T + 2 })).row.id);
    const page1 = await listJobRows(db, A, { limit: 2 });
    assert.deepEqual(page1.map((r) => r.id), [ids[2], ids[1]]);
    assert.ok(page1.every((r) => r.result_json === null));
    const last = page1[page1.length - 1]!;
    const page2 = await listJobRows(db, A, { limit: 2, before: { created_at: last.created_at, id: last.id } });
    assert.deepEqual(page2.map((r) => r.id), [ids[0]]);
  });
});

describe("claim, lease and recovery", () => {
  test("two simultaneous claims of one job: exactly one wins", async () => {
    const { db } = await freshDb();
    const { row: job } = await enqueue(db);
    const claims = await Promise.all([claimNextJob(db, T, LEASE), claimNextJob(db, T, LEASE)]);
    const won = claims.filter((c) => c !== null);
    assert.equal(won.length, 1);
    assert.equal(won[0]!.id, job.id);
    assert.equal(won[0]!.attempts, 1);
    const r = await row(db, job.id);
    assert.equal(r.status, "running");
    assert.equal(r.started_at, T);
    assert.equal(r.lease_until, T + LEASE);
  });

  test("two jobs, two claimers: each gets a different job, oldest first", async () => {
    const { db } = await freshDb();
    const older = (await enqueue(db, { now: T })).row.id;
    const newer = (await enqueue(db, { tenant: B, now: T + 1 })).row.id;
    const [x, y] = await Promise.all([claimNextJob(db, T + 2, LEASE), claimNextJob(db, T + 2, LEASE)]);
    assert.deepEqual([x!.id, y!.id], [older, newer]);
  });

  test("a crashed worker's job is re-claimed after its lease, attempts counted, and failed after three", async () => {
    const { db } = await freshDb();
    const { row: job } = await enqueue(db);
    const c1 = (await claimNextJob(db, T, LEASE))!;
    // Worker 1 dies. While its lease holds, nobody else may take the job.
    assert.equal(await claimNextJob(db, T + LEASE - 1, LEASE), null);
    const c2 = (await claimNextJob(db, T + LEASE + 1, LEASE))!;
    assert.equal(c2.id, job.id);
    assert.equal(c2.attempts, 2);
    // Worker 1 wakes up: every write it tries is fenced off.
    assert.equal(await heartbeatJob(db, c1, 0.5, T + LEASE + 2, LEASE), false);
    assert.equal(await finishJob(db, c1, T + LEASE + 2, { status: "succeeded", result: { stale: true } }), false);
    assert.equal((await row(db, job.id)).result_json, null);
    // Worker 2 renews its lease by heartbeat, then dies too.
    assert.equal(await heartbeatJob(db, c2, 0.3, T + LEASE + 10, LEASE), true);
    assert.equal(await claimNextJob(db, T + 2 * LEASE + 5, LEASE), null, "a renewed lease is still held");
    const c3 = (await claimNextJob(db, T + 2 * LEASE + 11, LEASE))!;
    assert.equal(c3.attempts, 3);
    // The third attempt dies: no fourth claim, and the sweep calls it lost.
    assert.equal(await claimNextJob(db, T + 3 * LEASE + 12, LEASE), null);
    const swept = await sweepJobs(db, T + 3 * LEASE + 12);
    assert.equal(swept.lost, 1);
    const r = await row(db, job.id);
    assert.equal(r.status, "failed");
    assert.equal(r.error_code, "worker_lost");
    assert.equal(r.attempts, 3);
    assert.equal(r.lease_until, null);
  });

  test("the pass recovers a job whose worker died and finishes it on the next attempt", async () => {
    const { db } = await freshDb();
    const { row: job } = await enqueue(db, { p: params({ days: 20 }) });
    await claimNextJob(db, T, LEASE); // attempt 1 never finishes
    const early = await runMcpJobsPass(db, { now: () => T + 10, log: quiet });
    assert.equal(early.job, null, "the lease is still held");
    const s = await runMcpJobsPass(db, { now: () => T + 10 * 60, log: quiet });
    assert.equal(s.job?.id, job.id);
    assert.equal(s.job?.attempt, 2);
    assert.equal(s.job?.outcome, "succeeded");
    assert.equal((await row(db, job.id)).attempts, 2);
  });
});

describe("cancel and deadlines", () => {
  test("a queued job is cancelled at once and never runs", async () => {
    const { db } = await freshDb();
    const { row: job } = await enqueue(db);
    const c = await cancelJob(db, A, job.id, T + 1);
    assert.equal(c.outcome, "cancelled");
    assert.equal(c.row.status, "cancelled");
    assert.equal(c.row.finished_at, T + 1);
    assert.equal(await claimNextJob(db, T + 2, LEASE), null);
    // Cancelling again changes nothing.
    assert.equal((await cancelJob(db, A, job.id, T + 3)).outcome, "already_finished");
  });

  test("a running job is asked to stop and stops before its next variant", async () => {
    const { db } = await freshDb();
    const p = params({ days: 30, variants: [{ label: "a" }, { label: "b" }, { label: "c" }] });
    const { row: job } = await enqueue(db, { p });
    const seen: string[] = [];
    const s = await runMcpJobsPass(db, {
      now: () => T + 5,
      log: quiet,
      async onProgress(id, progress) {
        if (progress > 0.1 && !seen.length) {
          // After the first variant: the owner cancels while it runs.
          const c = await cancelJob(db, A, id, T + 5);
          seen.push(c.outcome);
          assert.equal(c.row.status, "running");
          assert.equal(c.row.cancel_requested, 1);
        }
      },
    });
    assert.deepEqual(seen, ["requested"]);
    assert.equal(s.job?.outcome, "cancelled");
    const r = await row(db, job.id);
    assert.equal(r.status, "cancelled");
    assert.equal(r.result_json, null);
    assert.ok(r.progress > 0 && r.progress < 1);
  });

  test("a cancel that arrives during the last variant is honoured: no result is stored", async () => {
    const { db } = await freshDb();
    const { row: job } = await enqueue(db, { p: params({ days: 20 }) });
    const outcomes: string[] = [];
    const s = await runMcpJobsPass(db, {
      now: () => T + 5,
      log: quiet,
      async onProgress(id, progress) {
        // The last progress report of a one-variant run: the work is done, the result not yet stored.
        if (progress > 0.9) outcomes.push((await cancelJob(db, A, id, T + 5)).outcome);
      },
    });
    assert.deepEqual(outcomes, ["requested"]);
    assert.equal(s.job?.outcome, "cancelled");
    const r = await row(db, job.id);
    assert.equal(r.status, "cancelled");
    assert.equal(r.result_json, null);
  });

  test("a running job that was cancelled and then lost its worker is settled as cancelled", async () => {
    const { db } = await freshDb();
    const { row: job } = await enqueue(db);
    await claimNextJob(db, T, LEASE);
    assert.equal((await cancelJob(db, A, job.id, T + 1)).outcome, "requested");
    assert.equal(await claimNextJob(db, T + LEASE + 1, LEASE), null, "a cancelled job is never re-claimed");
    assert.equal((await sweepJobs(db, T + LEASE + 1, A)).cancelled, 1);
    assert.equal((await row(db, job.id)).status, "cancelled");
  });

  test("a queued job past its deadline expires and is never claimed", async () => {
    const { db } = await freshDb();
    const { row: job } = await enqueue(db);
    const at = T + JOB_LIMITS.deadlineSec;
    assert.equal(await claimNextJob(db, at, LEASE), null);
    // Scoped to another owner, the sweep does not touch it.
    assert.equal((await sweepJobs(db, at, B)).expired, 0);
    assert.equal((await sweepJobs(db, at, A)).expired, 1);
    const r = await row(db, job.id);
    assert.equal(r.status, "expired");
    assert.equal(r.error_code, "expired");
  });

  test("a job that reaches its deadline while running ends as expired", async () => {
    const { db } = await freshDb();
    const { row: job } = await enqueue(db, { p: params({ variants: [{ label: "a" }, { label: "b" }] }) });
    let clock = T + 10;
    const s = await runMcpJobsPass(db, {
      now: () => clock,
      log: quiet,
      onProgress() { clock = T + JOB_LIMITS.deadlineSec; },
    });
    assert.equal(s.job?.outcome, "expired");
    const r = await row(db, job.id);
    assert.equal(r.status, "expired");
    assert.equal(r.error_code, "expired");
    assert.equal(r.result_json, null);
  });
});

// ── oracle resampling ───────────────────────────────────────────────────────

describe("resampleOracle", () => {
  const E = T; // the last whole hour
  const AAA: FeedPoint[] = [
    { at: E - 30 * H, px: 10 },
    { at: E - 19 * H - H / 2, px: 11 },
    { at: E - 10 * H, px: 12 }, // exactly on a bar
    { at: E + H / 2, px: 99 }, // after the grid ends: must never appear
  ];
  const BBB: FeedPoint[] = [
    { at: E - 24 * H + 1, px: 50 }, // the later first round: the grid starts after it
    { at: E - 5 * H, px: 55 },
  ];
  const r = resampleOracle([{ symbol: "AAA", points: AAA }, { symbol: "BBB", points: BBB }], { endSec: E + 1234, days: 2 });
  const at = (t: number) => r.bars.find((b) => b.tSec === t)!;
  const px = (t: number, s: string) => Number(at(t).prices.get(s)) / 1e8;
  const stale = (t: number, s: string) => at(t).staleSymbols?.has(s) ?? false;

  test("the grid is hourly, ends at the last whole hour and starts where every symbol has a price", () => {
    assert.equal(r.bars[0]!.tSec, E - 23 * H);
    assert.equal(r.bars[r.bars.length - 1]!.tSec, E);
    assert.equal(r.bars.length, 24);
    for (let i = 1; i < r.bars.length; i++) assert.equal(r.bars[i]!.tSec - r.bars[i - 1]!.tSec, H);
    for (const b of r.bars) assert.equal(b.prices.size, 2, "every bar prices every symbol");
  });

  test("forward-fill: each bar carries the last round at or before it — no interpolation, no lookahead", () => {
    assert.equal(px(E - 20 * H, "AAA"), 10, "the 11 round is 30 minutes in this bar's future");
    assert.equal(px(E - 19 * H, "AAA"), 11);
    assert.equal(px(E - 11 * H, "AAA"), 11);
    assert.equal(px(E - 10 * H, "AAA"), 12, "a round exactly at the bar time is seen by it");
    assert.equal(px(E, "AAA"), 12, "the round after the grid end never leaks in");
    const published = new Set([...AAA, ...BBB].map((p) => BigInt(Math.round(p.px * 1e8))));
    for (const b of r.bars) for (const v of b.prices.values()) assert.ok(published.has(v), `bar ${b.tSec} holds ${v}, a price no round published`);
  });

  test("a symbol is stale where its last round is over two hours old, and only there", () => {
    assert.equal(ORACLE_STALE_AFTER_SEC, 2 * H);
    assert.equal(stale(E - 20 * H, "AAA"), true);
    assert.equal(stale(E - 19 * H, "AAA"), false);
    assert.equal(stale(E - 18 * H, "AAA"), false);
    assert.equal(stale(E - 17 * H, "AAA"), true);
    assert.equal(stale(E - 10 * H, "AAA"), false);
    assert.equal(stale(E - 8 * H, "AAA"), false, "exactly two hours is not over two hours");
    assert.equal(stale(E - 7 * H, "AAA"), true);
    assert.equal(stale(E - 22 * H, "BBB"), false);
    assert.equal(stale(E - 21 * H, "BBB"), true);
    assert.equal(stale(E - 5 * H, "BBB"), false);
    assert.equal(stale(E - 2 * H, "BBB"), true);
  });

  test("the stale rule is the live agent's, so a replay decides on the same bars", () => {
    // snapshot.ts marks a feed stale with an inline literal; if it changes, this must too.
    const live = readFileSync(join(import.meta.dirname, "..", "snapshot.ts"), "utf8");
    const m = /const stale = now - Number\(updatedAt\) > (\d+) \* 3600;/.exec(live);
    assert.ok(m, "snapshot.ts no longer has the stale rule this test pins; re-point it");
    assert.equal(ORACLE_STALE_AFTER_SEC, Number(m[1]) * 3600);
  });

  test("coverage counts rounds, gaps and stale share per symbol, and says the window was shortened", () => {
    const c = r.coverage;
    assert.equal(c.source, "oracle");
    assert.equal(c.bar_interval, "1h");
    assert.equal(c.bars, 24);
    assert.equal(c.span.from, new Date((E - 23 * H) * 1000).toISOString());
    assert.equal(c.span.to, new Date(E * 1000).toISOString());
    assert.equal(c.requested_days, 2);
    assert.equal(c.covered_days, 1);
    const a = c.symbols.find((s) => s.symbol === "AAA")!;
    assert.equal(a.points, 2);
    assert.equal(a.gaps_over_6h, 1);
    assert.equal(a.longest_gap_hours, 9.5);
    // Stale at E-23..E-20, E-17..E-11 and E-7..E: 4 + 7 + 8 of 24 bars.
    assert.equal(a.stale_share, Math.round((19 / 24) * 1000) / 1000);
    const b = c.symbols.find((s) => s.symbol === "BBB")!;
    assert.equal(b.points, 1);
    // Stale at E-21..E-6 and E-2..E: 16 + 3 of 24 bars.
    assert.equal(b.stale_share, Math.round((19 / 24) * 1000) / 1000);
    assert.equal(b.longest_gap_hours, null);
    assert.ok(r.warnings.some((w) => /covered 1 of the 2 requested days/.test(w)), r.warnings.join(" | "));
  });

  test("a symbol with no rounds at or before the end yields no bars rather than a zero price", () => {
    const none = resampleOracle([{ symbol: "AAA", points: AAA }, { symbol: "LATE", points: [{ at: E + 60, px: 5 }] }], { endSec: E, days: 2 });
    assert.equal(none.bars.length, 0);
  });
});

// ── full runs ───────────────────────────────────────────────────────────────

/** A 24/5 feed: a round every 30 minutes on weekdays, silent from Friday 21:00 to Sunday 21:00 UTC. */
function fakeFeed(days: number, start: number, drift: number): FeedPoint[] {
  const out: FeedPoint[] = [];
  let px = start;
  for (let t = T - days * 86_400; t <= T; t += 1800) {
    const d = new Date(t * 1000);
    const dow = d.getUTCDay();
    const hour = d.getUTCHours();
    const closed = (dow === 5 && hour >= 21) || dow === 6 || (dow === 0 && hour < 21);
    if (closed) continue;
    px = Math.max(1, px * (1 + drift + 0.002 * Math.sin(t / 7200)));
    out.push({ at: t, px: Math.round(px * 100) / 100 });
  }
  return out;
}

function feedFor(symbol: string): `0x${string}` {
  return STOCK_TOKENS.find((t) => t.symbol === symbol)!.chainlinkFeed!;
}

describe("runMcpJobsPass", () => {
  test("a synthetic backtest succeeds with numbers that add up and says what it is", async () => {
    const { db } = await freshDb();
    const p = params({ days: 120, variants: [{ label: "base" }, { label: "no cost", execution_cost_bps: 0, buy_per_tick_usdg: 50 }] });
    const { row: job } = await enqueue(db, { p });
    const progress: number[] = [];
    const s = await runMcpJobsPass(db, { now: () => T + 30, log: quiet, onProgress: (_id, x) => { progress.push(x); } });
    assert.equal(s.error, null);
    assert.equal(s.job?.outcome, "succeeded");
    assert.ok(progress.length >= 3 && progress.every((x, i) => i === 0 || x > progress[i - 1]!), `progress rises: ${progress}`);
    const r = await row(db, job.id);
    assert.equal(r.status, "succeeded");
    assert.equal(r.progress, 1);
    assert.equal(r.finished_at, T + 30);
    assert.equal(r.lease_until, null);
    assert.ok(Buffer.byteLength(r.result_json!, "utf8") <= JOB_LIMITS.resultMaxBytes);
    const res = resultOf(r);
    assert.equal(res.kind, "backtest");
    assert.equal(res.seed, 42);
    assert.equal(res.variants.length, 2);
    for (const v of res.variants) {
      assert.ok(Math.abs(v.final_equity_usdg - (p.initial_usdg + v.pnl_usdg)) <= 0.011, `${v.label}: equity = initial + pnl`);
      assert.ok(Math.abs(v.return_pct - (v.pnl_usdg / p.initial_usdg) * 100) <= 0.011, `${v.label}: return matches pnl`);
      assert.ok(v.final_equity_usdg > 0);
      assert.ok(v.max_drawdown_bps >= 0 && v.max_drawdown_bps <= 10_000);
      assert.ok(v.swap_fills > 0 && v.turnover_usdg > 0, `${v.label} traded`);
      assert.ok(v.executed_operations >= v.swap_fills);
      assert.ok(v.equity_series.length <= JOB_LIMITS.equityPoints && v.equity_series.length >= 2);
      assert.equal(v.equity_series[0]!.t, res.data_coverage.span.from);
      assert.equal(v.equity_series[v.equity_series.length - 1]!.t, res.data_coverage.span.to);
      assert.equal(v.equity_series[v.equity_series.length - 1]!.equity_usdg, v.final_equity_usdg);
    }
    assert.equal(res.variants[0]!.settings.execution_cost_bps, 30);
    assert.equal(res.variants[0]!.settings.buy_per_tick_usdg, 25, "defaults scale with initial_usdg");
    assert.equal(res.variants[1]!.settings.execution_cost_bps, 0);
    assert.equal(res.variants[1]!.settings.buy_per_tick_usdg, 50);
    assert.equal(res.data_coverage.source, "synthetic");
    assert.equal(res.data_coverage.bars, 120);
    for (const sc of res.data_coverage.symbols) assert.ok(Math.abs(sc.stale_share - 2 / 7) < 0.03, "weekends are stale");
    assert.match(res.disclaimer, /simulated; not a promise of live returns/i);
    assert.match(res.lookahead, /only sees prices up to that bar/i);
    assert.match(res.assumptions.fills, /no depth/i);
    assert.match(res.assumptions.budgets, /calendar day/i);
    assert.match(res.assumptions.budgets, /rolling 24 hours/i);
    assert.equal(res.assumptions.vault_apy_bps, 0);
    assert.ok(res.limitations.some((l) => /memecoin/i.test(l)));
    assert.ok(res.limitations.some((l) => /random walk/i.test(l)));
  });

  test("the same seed gives the same answer; weekend-gap trades the synthetic weekends", async () => {
    const { db } = await freshDb();
    const p = params({ strategy: "weekend-gap", days: 60 });
    const one = (await enqueue(db, { p })).row.id;
    const two = (await enqueue(db, { p, tenant: B })).row.id;
    await runMcpJobsPass(db, { now: () => T + 1, log: quiet });
    await runMcpJobsPass(db, { now: () => T + 2, log: quiet });
    const a = resultOf(await row(db, one));
    const b = resultOf(await row(db, two, B));
    assert.deepEqual(a.variants, b.variants);
    assert.ok(a.variants[0]!.swap_fills > 0, "weekend-gap entered and exited");
  });

  test("an oracle backtest reads each feed once, in order, and covers the window with hourly bars", async () => {
    const { db } = await freshDb();
    const p = params({ data: "oracle", days: 20, symbols: ["NVDA", "SPY"], variants: [{ label: "a" }] });
    const { row: job } = await enqueue(db, { p });
    const calls: string[] = [];
    const histories: Record<string, FeedPoint[]> = { [feedFor("NVDA")]: fakeFeed(30, 180, 0.0004), [feedFor("SPY")]: fakeFeed(30, 600, 0.0001) };
    const s = await runMcpJobsPass(db, {
      now: () => T,
      log: quiet,
      readFeed: async (feed): Promise<FeedHistory> => { calls.push(feed); return { points: histories[feed]!, read: true }; },
    });
    assert.equal(s.job?.outcome, "succeeded", JSON.stringify(await row(db, job.id)));
    assert.deepEqual(calls, [feedFor("NVDA"), feedFor("SPY")]);
    const res = resultOf(await row(db, job.id));
    assert.equal(res.data_coverage.source, "oracle");
    assert.equal(res.data_coverage.bar_interval, "1h");
    assert.equal(res.data_coverage.bars, 20 * 24 + 1);
    assert.equal(res.data_coverage.covered_days, 20);
    for (const sc of res.data_coverage.symbols) {
      assert.ok(sc.points > 500, `${sc.symbol} has its rounds counted`);
      assert.ok(sc.stale_share > 0.1 && sc.stale_share < 0.4, `${sc.symbol} is stale over weekends only: ${sc.stale_share}`);
      assert.ok((sc.gaps_over_6h ?? 0) >= 2, "two weekends of silence");
      assert.ok((sc.longest_gap_hours ?? 0) >= 48);
    }
    assert.ok(res.limitations.some((l) => /oracle is not a market/i.test(l)));
    assert.ok(res.variants[0]!.swap_fills > 0);
  });

  test("oracle history that cannot be read fails the job as unavailable, never as an empty success", async () => {
    for (const readFeed of [
      undefined,
      async (): Promise<FeedHistory> => ({ points: [], read: false }),
      async (): Promise<FeedHistory> => { throw new Error("rpc down with a url https://secret.example/key"); },
      () => new Promise<FeedHistory>(() => {}), // never answers
    ]) {
      resetMcpJobsForTest();
      const { db } = await freshDb();
      const { row: job } = await enqueue(db, { p: params({ data: "oracle", days: 10, symbols: ["NVDA"] }) });
      const s = await runMcpJobsPass(db, { now: () => T, log: quiet, readFeed, maxMs: 300 });
      assert.equal(s.job?.outcome, "failed");
      const r = await row(db, job.id);
      assert.equal(r.status, "failed");
      assert.equal(r.error_code, "upstream_unavailable");
      assert.doesNotMatch(r.error_message ?? "", /secret|https?:/, "no raw provider text is stored");
      assert.equal(r.result_json, null);
    }
  });

  test("a feed that answers with nothing is insufficient data", async () => {
    const { db } = await freshDb();
    const { row: job } = await enqueue(db, { p: params({ data: "oracle", days: 10, symbols: ["NVDA"] }) });
    await runMcpJobsPass(db, { now: () => T, log: quiet, readFeed: async () => ({ points: [], read: true }) });
    assert.equal((await row(db, job.id)).error_code, "insufficient_data");
  });

  test("a job over the pass budget fails as a timeout and is not retried", async () => {
    const { db } = await freshDb();
    const { row: job } = await enqueue(db);
    const s = await runMcpJobsPass(db, { now: () => T, log: quiet, maxMs: 0 });
    assert.equal(s.job?.outcome, "failed");
    const r = await row(db, job.id);
    assert.equal(r.error_code, "timeout");
    assert.equal(r.attempts, 1);
    // Past any lease, inside the deadline: a timeout is an answer, not a crash, so nothing re-claims it.
    assert.equal(await claimNextJob(db, T + 10 * 60, LEASE), null);
  });

  test("params tampered with at rest are re-validated and refused", async () => {
    const { db } = await freshDb();
    const { row: job } = await enqueue(db);
    await db.prepare("UPDATE mcp_jobs SET params_json = ? WHERE id = ?").run(JSON.stringify({ ...params(), strategy: "custom-file" }), job.id);
    await runMcpJobsPass(db, { now: () => T, log: quiet });
    const r = await row(db, job.id);
    assert.equal(r.status, "failed");
    assert.equal(r.error_code, "invalid_params");
  });

  test("a second pass while one runs returns busy; an empty queue is a quiet pass", async () => {
    const { db } = await freshDb();
    await enqueue(db);
    const [x, y] = await Promise.all([runMcpJobsPass(db, { now: () => T, log: quiet }), runMcpJobsPass(db, { now: () => T, log: quiet })]);
    assert.equal(x.skipped, null);
    assert.equal(y.skipped, "busy");
    const idle = await runMcpJobsPass(db, { now: () => T, log: quiet });
    assert.deepEqual(idle, { skipped: null, swept: { expired: 0, cancelled: 0, lost: 0 }, job: null, error: null });
  });

  test("a pass wedged past its lease stops blocking the queue, and cannot clear a newer pass's guard", async () => {
    const { db } = await freshDb();
    const { row: job } = await enqueue(db);
    // A database whose every call waits until released, then fails: a wedged connection.
    const wedged = () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const fail = () => gate.then(() => { throw new Error("socket closed"); });
      const hung = { prepare: () => ({ run: fail, get: fail, all: fail }), exec: fail, tx: fail } as unknown as Db;
      return { hung, release };
    };
    const lease = (Math.ceil(JOB_LIMITS.passBudgetMs / 1000) + JOB_LIMITS.leaseSlackSec) * 1000;
    let wall = 0;
    const at = () => wall;
    const one = wedged();
    const stuck = runMcpJobsPass(one.hung, { now: () => T, log: quiet, clockMs: at });
    wall = lease - 1;
    assert.equal((await runMcpJobsPass(db, { now: () => T, log: quiet, clockMs: at })).skipped, "busy", "still inside its lease");
    // Past the lease: a new pass may start. Make it wedge too, so it is still in flight when the first returns.
    wall = lease + 1;
    const two = wedged();
    const second = runMcpJobsPass(two.hung, { now: () => T, log: quiet, clockMs: at });
    one.release();
    assert.equal((await stuck).error, "Error");
    assert.equal((await runMcpJobsPass(db, { now: () => T, log: quiet, clockMs: at })).skipped, "busy", "the old pass returning must not clear the new pass's guard");
    two.release();
    await second;
    const ran = await runMcpJobsPass(db, { now: () => T, log: quiet, clockMs: at });
    assert.equal(ran.skipped, null);
    assert.equal(ran.job?.id, job.id);
    assert.equal(ran.job?.outcome, "succeeded");
  });

  test("a variant that fills no swap says so", async () => {
    const { db } = await freshDb();
    // 2024-01-01 is a Monday: five weekday bars, no market close, so weekend-gap never enters.
    const { row: job } = await enqueue(db, { p: params({ strategy: "weekend-gap", days: 5 }) });
    await runMcpJobsPass(db, { now: () => T, log: quiet });
    const res = resultOf(await row(db, job.id));
    assert.equal(res.variants[0]!.swap_fills, 0);
    assert.equal(res.variants[0]!.turnover_usdg, 0);
    assert.ok(res.warnings.some((w) => /base filled no swaps/.test(w)), res.warnings.join(" | "));
  });

  test("the orchestrator's oracle reader is inert until the first read", () => {
    // Building it must not import viem, open a client or touch the network.
    assert.equal(typeof oracleFeedReader("http://127.0.0.1:9"), "function");
  });

  test("a database outage is reported by the pass, not thrown", async () => {
    const broken = { prepare() { throw new Error("connection refused 10.0.0.1"); }, exec: async () => {}, tx: async () => { throw new Error("x"); } } as unknown as Db;
    const s = await runMcpJobsPass(broken, { now: () => T, log: quiet });
    assert.equal(s.job, null);
    assert.equal(s.error, "Error");
  });
});

// ── the engine's turnover and the result bound ─────────────────────────────

test("runBacktest counts filled notional as turnover: buy spend plus sell gross", async () => {
  const token = STOCK_TOKENS.find((t) => t.symbol === "NVDA")!.address;
  const router = "0x0000000000000000000000000000000000000001" as const;
  const usdg = CASH.USDG as `0x${string}`;
  let step = 0;
  const bars: Bar[] = [10, 15, 20].map((px, i) => ({ tSec: T + i * 86_400, prices: new Map([["NVDA", BigInt(px * 1e8)]]) }));
  const r = await runBacktest({
    strategy: {
      name: "stub",
      tick(snap) {
        step += 1;
        if (step === 1) return [{ kind: "swap", target: router, sellToken: usdg, buyToken: token, sellAmountRaw: 100_000_000n, notionalUsdg: 100_000_000n }];
        if (step === 3) {
          const held = snap.holdings.get("NVDA")!;
          return [{ kind: "swap", target: router, sellToken: token, buyToken: usdg, sellAmountRaw: held.rawBalance, notionalUsdg: held.valueUsdg }];
        }
        return [];
      },
    },
    legs: new Map([["NVDA", token]]),
    initialCashUsdg: 1_000_000_000n,
    executionCostBps: 30,
    limits: {
      perTradeUsdg: 500_000_000n, dailyUsdg: 500_000_000n, allowedTargets: [router], allowedAssets: [usdg, token],
      maxOpsPerDay: 10, maxDrawdownBps: 10_000, expiresAt: T + 30 * 86_400,
    },
  }, bars);
  // Bought 100 USDG at $10 less 30 bps = 9.97 shares; sold them at $20 = 199.40 gross.
  assert.equal(r.swapFills, 2);
  assert.equal(r.turnoverUsdg, 100_000_000n + 199_400_000n);
  assert.equal(r.executed, 2);
  // The sell happened on the FINAL bar: the result must include it and its
  // cost. Cash 900 + 199.40 less 30 bps = 1098.8018 USDG — not the pre-fill
  // mark of 900 + 9.97 x $20 = 1099.40.
  assert.equal(r.finalEquityUsdg, 1_098_801_800n);
  assert.equal(r.pnlUsdg, 98_801_800n);
  assert.equal(r.equitySeries[r.equitySeries.length - 1]!.equityUsdg, 1_098_801_800n, "the terminal point is the closing value");
  assert.equal(r.equitySeries.length, bars.length, "one point per bar; the last is revalued, not duplicated");
  // The drawdown sees the close: peak 1099.40 (the last pre-fill mark), close 1098.8018.
  assert.ok(r.maxDrawdownBps >= 5, `drawdown ${r.maxDrawdownBps} includes the final bar's cost`);
});

test("a result over the byte bound is thinned, and refused if thinning is not enough", () => {
  const series = Array.from({ length: 2000 }, (_, i) => ({ t: new Date((T + i * H) * 1000).toISOString(), equity_usdg: 1000 + i }));
  const big = {
    kind: "backtest", strategy: "steady-basket", data: "synthetic", symbols: ["NVDA"], initial_usdg: 1000, seed: 42,
    variants: [{ label: "a", equity_series: series }], warnings: [], limitations: [],
  } as unknown as BacktestJobResult;
  const thinned = boundResult(big)!;
  assert.ok(thinned);
  assert.equal(thinned.variants[0]!.equity_series.length, 25);
  assert.ok(thinned.warnings.some((w) => /thinned/.test(w)));
  const hopeless = { ...big, limitations: ["x".repeat(JOB_LIMITS.resultMaxBytes)] } as BacktestJobResult;
  assert.equal(boundResult(hopeless), null);
  assert.deepEqual(downsample([1, 2, 3, 4, 5], 3), [1, 3, 5]);
  assert.deepEqual(downsample([1, 2], 5), [1, 2]);
});
