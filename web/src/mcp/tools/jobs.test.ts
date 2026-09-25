/**
 * Backtest job tools through runTool on SQLite: the request is validated and
 * queued (never run in the connection), idempotency and the per-owner quota
 * hold, the hourly budget binds, status reads settle abandoned jobs honestly,
 * cancel behaves per state, and another owner can neither see, read nor cancel
 * a job. The background pass is run in-process with no oracle reader, so
 * nothing here touches a chain.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { resetMetricsForTest } from "../observe";
import type { Principal } from "../oauth/server";
import { runTool, type CallToolResult, type ToolDef } from "../tool";
import { OWNER_A, OWNER_B, connectAs, installFixtures, makeDeps, makeTestDb, type TestDb } from "../testing";
import { JOB_LIMITS, claimNextJob, resetMcpJobsForTest, runMcpJobsPass } from "../../../../worker/src/mcp/jobs";
import { JOBS_TOOLS, ORACLE_SYMBOLS } from "./jobs";

const NOW = 1_800_000_000;
const SCOPES = ["jobs:run", "offline_access"];

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; resetMetricsForTest(); resetMcpJobsForTest(); });

const tool = (name: string) => JOBS_TOOLS.find((t) => t.name === name)! as unknown as ToolDef;
const run = (name: string, args: unknown, p: Principal, now = NOW) => runTool(tool(name), args, p, "trace-test", { now: () => now });
const data = (r: CallToolResult) => {
  assert.equal(r.isError, undefined, r.content[0]?.text);
  return r.structuredContent as Record<string, any>;
};
const errorOf = (r: CallToolResult) => {
  assert.equal(r.isError, true, `expected an error result, got ${r.content[0]?.text}`);
  return (r.structuredContent as { error: { code: string; message: string; retry_after_s: number | null } }).error;
};

async function setup(): Promise<{ d: TestDb; a: Principal; b: Principal; deps: ReturnType<typeof makeDeps> }> {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  restore = installFixtures(d);
  const a = await connectAs(deps, OWNER_A, { scopes: SCOPES });
  const b = await connectAs(deps, OWNER_B, { scopes: SCOPES });
  return { d, a: a.principal, b: b.principal, deps };
}

const request = (over: Record<string, unknown> = {}) => ({
  strategy: "steady-basket", symbols: ["nvda", "SPY"], data: "synthetic", days: 30, initial_usdg: 1000, variants: [{ label: "base" }], ...over,
});
const jobCount = (d: TestDb) => (d.raw.prepare("SELECT COUNT(*) AS n FROM mcp_jobs").get() as { n: number }).n;

test("every tool says jobs run in the background worker and survive a disconnect", () => {
  for (const t of JOBS_TOOLS.filter((x) => x.name !== "cancel_job")) assert.match(t.description, /background worker.*disconnect/, t.name);
  assert.equal(JOBS_TOOLS.every((t) => t.capability === "jobs.run"), true);
  assert.ok(ORACLE_SYMBOLS.includes("NVDA") && !ORACLE_SYMBOLS.includes("BE"));
});

test("run_backtest validates, queues and returns at once — nothing runs in the connection", async () => {
  const { d, a } = await setup();
  const r = data(await run("run_backtest", request(), a));
  assert.match(r.job_id, /^job_[0-9a-f]{32}$/);
  assert.equal(r.status, "queued");
  assert.equal(r.created, true);
  assert.equal(r.progress, 0);
  assert.equal(r.terminal, false);
  assert.deepEqual(r.params.symbols, ["NVDA", "SPY"]);
  assert.equal(r.params.seed, 42);
  assert.equal(r.deadline_at, new Date((NOW + JOB_LIMITS.deadlineSec) * 1000).toISOString());
  assert.match(r.next_steps, /get_job/);
  const row = d.raw.prepare("SELECT tenant, connection_id, status, result_json FROM mcp_jobs").get() as Record<string, unknown>;
  assert.equal(row.tenant, OWNER_A);
  assert.equal(row.connection_id, a.connectionId);
  assert.equal(row.status, "queued");
  assert.equal(row.result_json, null);
});

test("run_backtest refuses what it cannot replay, before anything is queued", async () => {
  const { d, a } = await setup();
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [request({ symbols: ["PEPE"] }), /memecoins/],
    [request({ symbols: ["BE"], data: "oracle" }), /no Chainlink feed/],
    [request({ data: "oracle", days: 61 }), /1 to 60/],
    [request({ data: "oracle", seed: 7 }), /synthetic/],
    [request({ strategy: "llm-strategist" }), /strategy/],
    [request({ leverage: 3 }), /leverage|Unrecognized/i],
    [request({ variants: [{ label: "a", take_profit_bps: 100 }] }), /take_profit_bps|Unrecognized/i],
    [request({ variants: [{ label: "a", execution_cost_bps: 900 }] }), /execution_cost_bps/],
    [request({ variants: [{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }, { label: "e" }] }), /variants/],
    [request({ initial_usdg: 50 }), /initial_usdg/],
  ];
  for (const [args, why] of bad) {
    const e = errorOf(await run("run_backtest", args, a));
    assert.equal(e.code, "invalid_input", JSON.stringify(args));
    assert.match(e.message, why, JSON.stringify(args));
  }
  assert.equal(jobCount(d), 0);
});

test("idempotency: the same key returns the same job; a different request under it conflicts", async () => {
  const { d, a, b } = await setup();
  const first = data(await run("run_backtest", request({ idempotency_key: "bt-key-0001" }), a));
  const again = data(await run("run_backtest", request({ idempotency_key: "bt-key-0001" }), a));
  assert.equal(again.job_id, first.job_id);
  assert.equal(again.created, false);
  assert.equal(errorOf(await run("run_backtest", request({ idempotency_key: "bt-key-0001", days: 31 }), a)).code, "conflict");
  // Keys are per owner: B's use of the same key is B's own job.
  const theirs = data(await run("run_backtest", request({ idempotency_key: "bt-key-0001" }), b));
  assert.notEqual(theirs.job_id, first.job_id);
  assert.equal(jobCount(d), 2);
});

test("at most two queued or running jobs per owner; an expired one frees its slot", async () => {
  const { a, b } = await setup();
  const one = data(await run("run_backtest", request(), a));
  data(await run("run_backtest", request(), a));
  const e = errorOf(await run("run_backtest", request(), a));
  assert.equal(e.code, "quota_exceeded");
  assert.ok((e.retry_after_s ?? 0) > 0);
  assert.equal(data(await run("run_backtest", request(), b)).created, true, "another owner's quota is their own");
  data(await run("cancel_job", { job_id: one.job_id }, a));
  assert.equal(data(await run("run_backtest", request(), a)).created, true);
  // Both remaining jobs pass their deadline unrun: the next request sweeps them first.
  assert.equal(data(await run("run_backtest", request(), a, NOW + JOB_LIMITS.deadlineSec)).created, true);
});

test("the hourly budget binds even on idempotent replays", async () => {
  const { a } = await setup();
  for (let i = 0; i < 10; i++) data(await run("run_backtest", request({ idempotency_key: "budget-key-1" }), a));
  const e = errorOf(await run("run_backtest", request({ idempotency_key: "budget-key-1" }), a));
  assert.equal(e.code, "quota_exceeded");
  assert.match(e.message, /hourly/);
});

test("get_job follows a job from queued to a succeeded result produced by the background pass", async () => {
  const { d, a } = await setup();
  const q = data(await run("run_backtest", request({ strategy: "weekend-gap", days: 60, variants: [{ label: "base" }, { label: "cheap", execution_cost_bps: 0 }] }), a));
  const before = data(await run("get_job", { job_id: q.job_id }, a));
  assert.equal(before.status, "queued");
  assert.equal(before.result, null);
  const pass = await runMcpJobsPass(d.db, { now: () => NOW + 20, log: () => {} });
  assert.equal(pass.job?.outcome, "succeeded");
  const after = data(await run("get_job", { job_id: q.job_id }, a, NOW + 30));
  assert.equal(after.status, "succeeded");
  assert.equal(after.terminal, true);
  assert.equal(after.progress, 1);
  assert.equal(after.attempts, 1);
  assert.equal(after.error, null);
  assert.equal(after.started_at, new Date((NOW + 20) * 1000).toISOString());
  const res = after.result;
  assert.equal(res.variants.length, 2);
  assert.deepEqual(res.variants.map((v: { label: string }) => v.label), ["base", "cheap"]);
  for (const v of res.variants) {
    assert.ok(Math.abs(v.final_equity_usdg - (1000 + v.pnl_usdg)) <= 0.011);
    assert.ok(v.equity_series.length <= 100);
    assert.ok(v.swap_fills > 0);
  }
  assert.match(res.disclaimer, /not a promise of live returns/i);
  assert.match(res.lookahead, /only sees prices up to that bar/i);
  assert.equal(res.data_coverage.source, "synthetic");
});

test("get_job reports a failure with its code and this server's own message", async () => {
  const { d, a } = await setup();
  const q = data(await run("run_backtest", request({ data: "oracle", symbols: ["NVDA"], days: 10 }), a));
  // No oracle reader handed to the pass: an honest unavailable, not an empty success.
  await runMcpJobsPass(d.db, { now: () => NOW + 5, log: () => {} });
  const r = data(await run("get_job", { job_id: q.job_id }, a));
  assert.equal(r.status, "failed");
  assert.equal(r.error.code, "upstream_unavailable");
  assert.equal(r.result, null);
});

test("another owner cannot see, read or cancel a job, and cannot tell it exists", async () => {
  const { d, a, b } = await setup();
  const q = data(await run("run_backtest", request(), a));
  const foreign = errorOf(await run("get_job", { job_id: q.job_id }, b));
  const missing = errorOf(await run("get_job", { job_id: `job_${"0".repeat(32)}` }, b));
  assert.equal(foreign.code, "not_found");
  assert.deepEqual({ code: foreign.code, message: foreign.message }, { code: missing.code, message: missing.message });
  assert.equal(errorOf(await run("cancel_job", { job_id: q.job_id }, b)).code, "not_found");
  assert.deepEqual(data(await run("list_jobs", {}, b)).jobs, []);
  const row = d.raw.prepare("SELECT status, cancel_requested FROM mcp_jobs WHERE id = ?").get(q.job_id) as { status: string; cancel_requested: number };
  assert.deepEqual({ ...row }, { status: "queued", cancel_requested: 0 });
});

test("a connection without jobs:run can use none of the tools", async () => {
  const { deps } = await setup();
  const reader = await connectAs(deps, OWNER_A, { scopes: ["market:read", "offline_access"] });
  for (const [name, args] of [["run_backtest", request()], ["get_job", { job_id: `job_${"a".repeat(32)}` }], ["list_jobs", {}], ["cancel_job", { job_id: `job_${"a".repeat(32)}` }]] as const) {
    assert.equal(errorOf(await run(name, args, reader.principal)).code, "insufficient_scope", name);
  }
});

test("cancel_job: queued at once, running on request, finished unchanged", async () => {
  const { d, a } = await setup();
  const queued = data(await run("run_backtest", request(), a));
  const c1 = data(await run("cancel_job", { job_id: queued.job_id }, a));
  assert.equal(c1.outcome, "cancelled");
  assert.equal(c1.status, "cancelled");
  assert.equal(c1.terminal, true);

  const running = data(await run("run_backtest", request(), a));
  const claimed = await claimNextJob(d.db, NOW, 80);
  assert.equal(claimed?.id, running.job_id);
  const c2 = data(await run("cancel_job", { job_id: running.job_id }, a));
  assert.equal(c2.outcome, "requested");
  assert.equal(c2.status, "running");
  assert.equal(c2.cancel_requested, true);
  assert.match(c2.status_explained, /cancel was requested/);
  // Its worker never comes back: the next read settles it as cancelled.
  assert.equal(data(await run("get_job", { job_id: running.job_id }, a, NOW + 81)).status, "cancelled");

  const c3 = data(await run("cancel_job", { job_id: queued.job_id }, a));
  assert.equal(c3.outcome, "already_finished");
  assert.equal(c3.status, "cancelled");
});

test("a running job whose worker stopped is not reported as running in the worker", async () => {
  const { d, a } = await setup();
  const q = data(await run("run_backtest", request(), a));
  await claimNextJob(d.db, NOW, 80); // attempt 1; this worker never comes back
  const live = data(await run("get_job", { job_id: q.job_id }, a, NOW + 79));
  assert.equal(live.status, "running");
  assert.match(live.status_explained, /^Running in Merrymen's background worker/);
  const lapsed = data(await run("get_job", { job_id: q.job_id }, a, NOW + 81));
  assert.equal(lapsed.status, "running");
  assert.match(lapsed.status_explained, /worker stopped.*attempt 1 of 3.*retried/);
  const listed = data(await run("list_jobs", {}, a, NOW + 81)).jobs[0];
  assert.equal(listed.status_explained, lapsed.status_explained);
});

test("a job nobody ran is reported as expired once its deadline passes", async () => {
  const { a } = await setup();
  const q = data(await run("run_backtest", request(), a));
  assert.equal(data(await run("get_job", { job_id: q.job_id }, a, NOW + JOB_LIMITS.deadlineSec - 1)).status, "queued");
  const r = data(await run("get_job", { job_id: q.job_id }, a, NOW + JOB_LIMITS.deadlineSec));
  assert.equal(r.status, "expired");
  assert.equal(r.error.code, "expired");
});

test("list_jobs pages newest first with an owner-bound cursor and carries no results", async () => {
  const { a, b } = await setup();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const q = data(await run("run_backtest", request({ days: 10 + i }), a, NOW + i));
    ids.push(q.job_id);
    data(await run("cancel_job", { job_id: q.job_id }, a, NOW + i));
  }
  const p1 = data(await run("list_jobs", { limit: 2 }, a, NOW + 5));
  assert.deepEqual(p1.jobs.map((j: { job_id: string }) => j.job_id), [ids[2], ids[1]]);
  assert.ok(p1.jobs.every((j: Record<string, unknown>) => !("result" in j)));
  assert.equal(typeof p1.next_cursor, "string");
  const p2 = data(await run("list_jobs", { limit: 2, cursor: p1.next_cursor }, a, NOW + 5));
  assert.deepEqual(p2.jobs.map((j: { job_id: string }) => j.job_id), [ids[0]]);
  assert.equal(p2.next_cursor, null);
  assert.equal(errorOf(await run("list_jobs", { limit: 2, cursor: p1.next_cursor }, b)).code, "invalid_input");
  assert.equal(errorOf(await run("list_jobs", { cursor: "not-a-cursor" }, a)).code, "invalid_input");
});

test("malformed ids are invalid input; a result in an unreadable format is withheld with a note", async () => {
  const { d, a } = await setup();
  assert.equal(errorOf(await run("get_job", { job_id: "job_../../x" }, a)).code, "invalid_input");
  const q = data(await run("run_backtest", request(), a));
  d.raw.prepare("UPDATE mcp_jobs SET status = 'succeeded', progress = 1, finished_at = ?, result_json = ? WHERE id = ?")
    .run(NOW + 1, JSON.stringify({ kind: "backtest", variants: "old" }), q.job_id);
  const r = data(await run("get_job", { job_id: q.job_id }, a, NOW + 2));
  assert.equal(r.status, "succeeded");
  assert.equal(r.result, null);
  assert.match(r.result_note, /Run the backtest again/);
});
