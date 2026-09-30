import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db, type Stmt } from "../db";
import {
  boundedDb, makeMcpBackground, mcpBackgroundEnabled, CALL_TIMEOUT_MS, LOCK_TIMEOUT_MS, PASS_LEASE_MS, STATEMENT_TIMEOUT_MS, TX_TIMEOUT_MS, type DbBounds,
} from "./background";
import { MCP_SCHEMA, MCP_SCHEMA_LOCK, MCP_SCHEMA_OBJECTS, SCHEMA_LOCK_TIMEOUT_MS, ensureMcpSchema } from "./schema";
import { resetMaintenanceForTest, retentionStatements, runMcpMaintenancePass } from "./maintenance";

const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const never = <T>() => new Promise<T>(() => {});
const BOUNDS: DbBounds = { callMs: 1_000, txMs: TX_TIMEOUT_MS, statementMs: STATEMENT_TIMEOUT_MS, lockMs: LOCK_TIMEOUT_MS, postgres: true };

/** How `p` stands after `ms`: settled either way, or still pending (a test must never hang on it). */
async function within<T>(p: Promise<T>, ms: number): Promise<{ value: T } | { error: unknown } | "pending"> {
  const pending = settle(ms).then(() => "pending" as const);
  return Promise.race([p.then((value) => ({ value }), (error: unknown) => ({ error })), pending]);
}

/**
 * A Db that records every statement and answers each with `answer(sql)`.
 * `checkout` holds each transaction until it resolves (a pool with no free
 * connection); `delayMs(sql)` holds one statement's answer.
 */
function recordingDb(
  answer: (sql: string) => unknown = () => undefined,
  o: { checkout?: () => Promise<void>; delayMs?: (sql: string) => number } = {},
): { db: Db; seen: string[] } {
  const seen: string[] = [];
  const wait = async (sql: string) => {
    const ms = o.delayMs?.(sql) ?? 0;
    if (ms > 0) await settle(ms);
  };
  const stmt = (sql: string): Stmt => ({
    run: async () => { seen.push(sql); await wait(sql); return { changes: 0, lastInsertRowid: 0 }; },
    get: async () => { seen.push(sql); await wait(sql); return answer(sql); },
    all: async () => { seen.push(sql); await wait(sql); return []; },
  });
  const db: Db = {
    prepare: stmt,
    exec: async (sql) => { seen.push(sql === MCP_SCHEMA ? "<MCP_SCHEMA>" : sql); },
    tx: async (fn) => {
      await o.checkout?.();
      seen.push("BEGIN");
      try {
        const out = await fn(db);
        seen.push("COMMIT");
        return out;
      } catch (e) {
        seen.push("ROLLBACK");
        throw e;
      }
    },
  };
  return { db, seen };
}

test("the background work runs only with shared Postgres and MCP switched on", () => {
  assert.equal(mcpBackgroundEnabled({}), false);
  assert.equal(mcpBackgroundEnabled({ DATABASE_URL: "postgres://x" }), true);
  assert.equal(mcpBackgroundEnabled({ DATABASE_URL: "postgres://x", MERRYMEN_MCP_ENABLED: "0" }), false);
});

test("a tick never throws and never blocks: a database outage is logged, and the next tick retries", async () => {
  const lines: string[] = [];
  let calls = 0;
  const tick = makeMcpBackground({
    shared: async () => { calls += 1; throw new Error("connect ECONNREFUSED"); },
    log: (l) => lines.push(l),
    env: { DATABASE_URL: "postgres://x" },
  });
  const started = Date.now();
  tick();
  assert.ok(Date.now() - started < 50, "the tick returns immediately");
  await settle(20);
  assert.equal(calls, 3, "jobs, notify and retention each tried");
  assert.ok(lines.every((l) => /^mcp: (jobs|notify|maintenance) pass failed/.test(l)), lines.join("\n"));
  tick();
  await settle(20);
  assert.equal(calls, 6, "retried on the next tick");
});

test("a disabled tick does nothing at all", async () => {
  let calls = 0;
  const tick = makeMcpBackground({ shared: async () => { calls += 1; throw new Error("x"); }, log: () => {}, env: {} });
  tick();
  await settle(10);
  assert.equal(calls, 0);
});

test("a hung pass holds its slot only for its lease; then the next tick starts another, and the late one cannot free the newer slot", async () => {
  const lines: string[] = [];
  let clock = 0;
  const waiting: Array<(db: Db) => void> = [];
  const tick = makeMcpBackground({
    // Every pass's first call hangs until the test lets it go.
    shared: () => new Promise<Db>((resolve) => waiting.push(resolve)),
    log: (l) => lines.push(l),
    env: { DATABASE_URL: "postgres://x" },
    clockMs: () => clock,
    leaseMs: 1_000,
    callTimeoutMs: 400, // real time, well past this test's own waits: this test is about the (fake-clock) lease
  });
  tick();
  await settle();
  assert.equal(waiting.length, 3, "jobs, notify and retention started");
  clock = 999;
  tick();
  await settle();
  assert.equal(waiting.length, 3, "inside the lease a busy pass is skipped, not stacked");
  clock = 1_000;
  tick();
  await settle();
  assert.equal(waiting.length, 6, "past the lease each pass is started again beside the hung one");
  assert.ok(lines.some((l) => /^mcp: the jobs pass started 1 s ago has not finished; starting another beside it$/.test(l)), lines.join("\n"));

  // The first three finally answer, with a database that fails at once. Their
  // cleanup must not free the slots the newer passes now hold.
  const { db: failing } = recordingDb(() => { throw new Error("boom"); });
  for (const resolve of waiting.slice(0, 3)) resolve(failing);
  await settle();
  clock = 1_500;
  tick();
  await settle();
  assert.equal(waiting.length, 6, "the newer passes still hold their slots");
});

test("a database call that never answers fails the pass at its bound, and the next tick starts over", async () => {
  const lines: string[] = [];
  let calls = 0;
  const hung: Db = {
    prepare: () => ({ run: never, get: never, all: never }),
    exec: never,
    tx: never,
  };
  const tick = makeMcpBackground({
    shared: async () => { calls += 1; return hung; },
    log: (l) => lines.push(l),
    env: { DATABASE_URL: "postgres://x" },
    callTimeoutMs: 20,
  });
  tick();
  await settle(80);
  assert.equal(calls, 3);
  assert.ok(lines.some((l) => /timed out|did not finish in time/.test(l)), lines.join("\n"));
  tick();
  await settle(10);
  assert.equal(calls, 6, "the slots were freed: the passes run again");
});

test("boundedDb: a transaction starts by bounding its statements and lock waits in Postgres, and a hung call rejects", async () => {
  const pg = recordingDb();
  const bounded = boundedDb(pg.db, BOUNDS);
  await bounded.tx((t) => t.prepare("SELECT 1").get());
  assert.deepEqual(pg.seen, ["BEGIN", `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`, `SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`, "SELECT 1", "COMMIT"]);

  const lite = recordingDb();
  await boundedDb(lite.db, { ...BOUNDS, postgres: false }).tx((t) => t.prepare("SELECT 1").get());
  assert.deepEqual(lite.seen, ["BEGIN", "SELECT 1", "COMMIT"], "SQLite has no such settings");

  const hung: Db = { prepare: () => ({ run: never, get: never, all: never }), exec: never, tx: never };
  await assert.rejects(boundedDb(hung, { ...BOUNDS, callMs: 20 }).prepare("SELECT 1").get(), { name: "DbCallTimeout" });
});

test("boundedDb: a transaction whose connection never comes is given up at its bound; one handed a connection late runs nothing and rolls back", async () => {
  // A pool that never hands out a connection (it has no checkout timeout of its own).
  let ran = false;
  const hung: Db = { prepare: () => ({ run: never, get: never, all: never }), exec: never, tx: never };
  const gaveUp = await within(boundedDb(hung, { ...BOUNDS, txMs: 20 }).tx(async () => { ran = true; }), 500);
  assert.ok(gaveUp !== "pending" && "error" in gaveUp && (gaveUp.error as Error).name === "DbCallTimeout", "the pass stops waiting at txMs");
  assert.equal(ran, false);

  // A pool that hands the connection over only after the pass stopped waiting.
  let free!: () => void;
  const checkout = new Promise<void>((r) => { free = r; });
  const late = recordingDb(() => undefined, { checkout: () => checkout });
  const out = await within(boundedDb(late.db, { ...BOUNDS, txMs: 20 }).tx(async (t) => { ran = true; await t.prepare("INSERT x").run(); }), 500);
  assert.ok(out !== "pending" && "error" in out, "given up while waiting for the pool");
  free();
  await settle(20);
  assert.equal(ran, false, "the abandoned transaction's work never runs");
  assert.deepEqual(late.seen, ["BEGIN", "ROLLBACK"], "it rolls back at once and hands the connection back");
});

test("boundedDb: work that finishes after the transaction's bound rolls back instead of committing, and sends nothing more", async () => {
  const slow = recordingDb(() => ({ n: 1 }), { delayMs: (sql) => (sql === "SELECT slow" ? 60 : 0) });
  const out = await within(boundedDb(slow.db, { ...BOUNDS, txMs: 20 }).tx(async (t) => {
    await t.prepare("SELECT slow").get();
    await t.prepare("INSERT after").run();
  }), 500);
  assert.ok(out !== "pending" && "error" in out && (out.error as Error).name === "DbCallTimeout");
  await settle(80);
  assert.deepEqual(slow.seen, ["BEGIN", `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`, `SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`, "SELECT slow", "ROLLBACK"]);
  assert.ok(TX_TIMEOUT_MS > CALL_TIMEOUT_MS && TX_TIMEOUT_MS < PASS_LEASE_MS, "longer than any one call it holds, inside the pass's lease");
});

test("boundedDb: a transaction whose ONLY statement finishes after the bound rolls back, never commits (the retention DELETE shape)", async () => {
  const slow = recordingDb(() => undefined, { delayMs: (sql) => (sql === "DELETE x" ? 60 : 0) });
  const out = await within(boundedDb(slow.db, { ...BOUNDS, txMs: 20 }).tx((t) => t.prepare("DELETE x").run()), 500);
  assert.ok(out !== "pending" && "error" in out && (out.error as Error).name === "DbCallTimeout");
  await settle(80);
  assert.ok(slow.seen.includes("ROLLBACK"), slow.seen.join(" | "));
  assert.ok(!slow.seen.includes("COMMIT"), "the pass already reported a timeout: nothing it did may commit");
});

test("retention runs each DELETE in its own bounded transaction", async () => {
  const { db, seen } = recordingDb();
  resetMaintenanceForTest();
  await runMcpMaintenancePass(boundedDb(db, BOUNDS), 2_000_000_000, true);
  const deletes = seen.filter((s) => s.startsWith("DELETE"));
  assert.equal(deletes.length, retentionStatements(2_000_000_000).length);
  for (const d of deletes) {
    const i = seen.indexOf(d);
    assert.deepEqual(seen.slice(i - 3, i + 2), ["BEGIN", `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`, `SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`, d, "COMMIT"], d);
  }
});

// ── schema at boot ─────────────────────────────────────────────────────────

test("the boot check covers every table and index the schema creates", () => {
  const creates = MCP_SCHEMA.match(/CREATE (UNIQUE )?(TABLE|INDEX)/g) ?? [];
  assert.equal(MCP_SCHEMA_OBJECTS.length, creates.length);
  assert.equal(new Set(MCP_SCHEMA_OBJECTS).size, MCP_SCHEMA_OBJECTS.length);
  for (const name of ["mcp_clients", "notify_deliveries", "mcp_audit_at", "mcp_rate_window", "notify_deliveries_retention"]) assert.ok(MCP_SCHEMA_OBJECTS.includes(name), name);
});

test("once the schema exists a boot takes no lock and runs no DDL (Postgres)", async () => {
  const { db, seen } = recordingDb((sql) => (/to_regclass/.test(sql) ? { n: 0 } : undefined));
  await ensureMcpSchema(db, "postgres");
  assert.equal(seen.length, 1, seen.join("\n"));
  assert.match(seen[0]!, /to_regclass/);
  assert.ok(!seen.some((s) => /BEGIN|pg_advisory|<MCP_SCHEMA>/.test(s)));
});

test("a boot that has to create the schema gives up on a lock wait instead of queueing, and re-checks under the advisory lock", async () => {
  // Missing on the first look; still missing under the lock: the DDL runs, after the lock timeout is set.
  const missing = recordingDb((sql) => (/to_regclass/.test(sql) ? { n: 3 } : undefined));
  await ensureMcpSchema(missing.db, "postgres");
  const i = (p: RegExp) => missing.seen.findIndex((s) => p.test(s));
  assert.ok(i(/^SET LOCAL lock_timeout = /) > i(/^BEGIN$/), missing.seen.join("\n"));
  assert.ok(i(/^SET LOCAL lock_timeout = /) < i(/pg_advisory_xact_lock/), "the timeout covers the advisory lock and every table lock after it");
  assert.ok(missing.seen.includes(`SET LOCAL lock_timeout = ${SCHEMA_LOCK_TIMEOUT_MS}`));
  assert.ok(i(/pg_advisory_xact_lock/) < i(/^<MCP_SCHEMA>$/));

  // Another replica created it while this one waited for the advisory lock: no DDL.
  let looks = 0;
  const raced = recordingDb((sql) => (/to_regclass/.test(sql) ? { n: looks++ === 0 ? 3 : 0 } : undefined));
  await ensureMcpSchema(raced.db, "postgres");
  assert.ok(raced.seen.some((s) => /pg_advisory_xact_lock/.test(s)));
  assert.ok(!raced.seen.includes("<MCP_SCHEMA>"), raced.seen.join("\n"));
  assert.equal(MCP_SCHEMA_LOCK, 1_297_692_101, "the lock key two replicas agree on");
});

test("SQLite: the second boot finds the schema and runs no DDL", async () => {
  const raw = new DatabaseSync(":memory:");
  const inner = wrapSqlite(raw);
  let execs = 0;
  const counted: Db = { prepare: (s) => inner.prepare(s), exec: (s) => { execs += 1; return inner.exec(s); }, tx: (fn) => inner.tx((t) => fn({ ...t, prepare: (s) => t.prepare(s), exec: (s) => { execs += 1; return t.exec(s); }, tx: (f) => t.tx(f) })) };
  await ensureMcpSchema(counted, "sqlite");
  assert.equal(execs, 1);
  await ensureMcpSchema(counted, "sqlite");
  assert.equal(execs, 1, "nothing missing, nothing run");
  raw.exec("DROP INDEX mcp_audit_at");
  await ensureMcpSchema(counted, "sqlite");
  assert.equal(execs, 2, "a missing index is created on the next boot");
  assert.ok(raw.prepare("SELECT 1 FROM sqlite_master WHERE name = 'mcp_audit_at'").get());
});

test("the orchestrator starts the MCP background after the mirror and never awaits it", () => {
  // The chat-room boundary test forbids naming that room here, so the mirror is the only anchor.
  const src = readFileSync(path.join(process.cwd(), "worker", "src", "orchestrator.ts"), "utf8");
  const mirror = src.indexOf("await mirrorLedgers();");
  const mcp = src.indexOf("(mcpBackground ??= makeMcpBackground(");
  assert.ok(mirror > 0 && mcp > mirror, "called after the mirror");
  assert.doesNotMatch(src, /await\s+\(?mcpBackground/, "never awaited");
});
