/**
 * THE RESTORE DRILL'S VERIFIER (scripts/pg-backup/verify-restore.mjs).
 *
 * Most of this runs against a scripted stand-in for a pg client, which is
 * enough to pin the verdicts, the refusals, the order the two databases are
 * read in and the statements each one is sent. The SQL itself is pinned by the
 * opt-in case at the bottom, against real Postgres:
 *
 *   MERRYMEN_TEST_PG_URL=postgres://merrymen@127.0.0.1:55432/postgres \
 *     NODE_PATH=<a directory holding pg@8> npx tsx --test cli/pg-backup-verify.test.mjs
 *
 * It refuses any host but loopback, creates two databases of its own and drops
 * them at the end. With no URL it is skipped, so `npm test` and CI need neither
 * a database nor the `pg` driver, which this repository does not install.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SETTLE_SEC,
  DRILL_TABLES,
  DrillRefusal,
  FAILING_VERDICTS,
  compareSides,
  databaseOf,
  parseDrillArgs,
  runRestoreDrill,
  verdictOf,
} from "../scripts/pg-backup/verify-restore.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/pg-backup/verify-restore.mjs", import.meta.url));

// The restore point, as epoch seconds, and a "now" an hour after it.
const R = 1_790_000_000;
const RESTORE_POINT = new Date(R * 1000).toISOString();
const NOW_MS = (R + 3600) * 1000;
const BEFORE = R - DEFAULT_SETTLE_SEC - 600; // safely before the cutoff
const SETTLING = R - 60; // inside the settle margin: compared by neither side
const LATER = R + 1800; // after the restore point: the source only

const FORK_URL = "postgres://drill:fork-secret@postgres-fork.railway.internal:5432/railway";
const SOURCE_URL = "postgres://drill:source-secret@postgres.railway.internal:5432/railway";
const ENV = { MERRYMEN_RESTORE_FORK_URL: FORK_URL, MERRYMEN_RESTORE_SOURCE_URL: SOURCE_URL };
const ARGV = ["--restore-point", RESTORE_POINT];

const expectRefusal = (fn, code) => assert.throws(fn, (e) => e instanceof DrillRefusal && e.code === code);

// ── a scripted pg client ─────────────────────────────────────────────────────

/**
 * A database as the drill sees it: `tables` maps a name to its stamp column's
 * type and the stamp of each row. Every table the drill allowlists is present
 * unless the spec leaves it out with `null`.
 */
function database({ db = "railway", started = "2026-09-01 00:00:00.000001+00", readonly = "on", tables = {}, fail = {} } = {}) {
  const all = {};
  for (const { table, stamp } of DRILL_TABLES) {
    if (tables[table] === null) continue;
    const spec = tables[table] ?? { stamps: [BEFORE] };
    all[table] = { stamp, type: spec.type ?? "bigint", stamps: spec.stamps };
  }
  return { db, started, readonly, tables: all, fail };
}

const seconds = (v) => (v === null ? null : v >= 100_000_000_000 ? Math.trunc(v / 1000) : v);

function fakeClient(spec, log) {
  const sent = [];
  const client = {
    sent,
    ended: false,
    async query(text, params = []) {
      sent.push(text);
      log?.push(text);
      if (/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/.test(text)) return { rows: [] };
      if (/^SET LOCAL /.test(text) || text === "ROLLBACK") return { rows: [] };
      if (text.includes("current_setting('transaction_read_only')")) return { rows: [{ readonly: spec.readonly, isolation: "repeatable read" }] };
      if (text.includes("pg_postmaster_start_time()")) return { rows: [{ db: spec.db, started: spec.started }] };
      if (text.includes("pg_catalog.pg_attribute")) {
        const rows = [];
        for (const name of params[0]) {
          const t = spec.tables[name];
          if (t) rows.push({ table_name: name, column_name: t.stamp, data_type: t.type }, { table_name: name, column_name: "id", data_type: "bigint" });
        }
        return { rows };
      }
      const counted = /FROM "([a-z_]+)"\) AS stamped$/.exec(text);
      if (counted) {
        const name = counted[1];
        if (spec.fail[name]) throw Object.assign(new Error(`canceling statement on ${SOURCE_URL}`), { code: spec.fail[name] });
        const [cutoff, after] = params;
        const s = spec.tables[name].stamps.map(seconds);
        const old = s.filter((v) => v !== null && v <= cutoff);
        // Counts come back as strings, as int8 does from node-postgres.
        return {
          rows: [{
            rows: String(s.filter((v) => v === null || v <= cutoff).length),
            newest: old.length ? String(Math.max(...old)) : null,
            after: String(s.filter((v) => v !== null && v > after).length),
            total: String(s.length),
          }],
        };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
    async end() {
      client.ended = true;
    },
  };
  return client;
}

/** A connect seam over two scripted databases, keyed by the URL it is handed. */
function connector(fork, source, { failFork } = {}) {
  const log = [];
  const clients = {};
  const order = [];
  const connect = async (url) => {
    const side = url === FORK_URL ? "fork" : url === SOURCE_URL ? "source" : null;
    assert.ok(side, "the drill connected to a URL it was not given");
    order.push(side);
    if (side === "fork" && failFork) throw failFork;
    clients[side] = fakeClient(side === "fork" ? fork : source, log);
    return clients[side];
  };
  return { connect, clients, order, log };
}

const drill = (fork, source, opts = {}) => {
  const seam = connector(fork, source, opts);
  return runRestoreDrill({ argv: opts.argv ?? ARGV, env: opts.env ?? ENV, now: () => NOW_MS, connect: seam.connect }).then((out) => ({ ...out, ...seam }));
};

// ── the allowlist ────────────────────────────────────────────────────────────

test("the allowlist names plain identifiers once each, and covers the ledger, authority and recovery tables", () => {
  assert.equal(new Set(DRILL_TABLES.map((t) => t.table)).size, DRILL_TABLES.length);
  for (const { table, stamp } of DRILL_TABLES) {
    assert.match(table, /^[a-z_][a-z0-9_]*$/);
    assert.match(stamp, /^[a-z_][a-z0-9_]*$/);
    assert.ok(Object.isFrozen(DRILL_TABLES.find((t) => t.table === table)));
  }
  const names = DRILL_TABLES.map((t) => t.table);
  for (const must of ["trades", "flows", "equity", "decisions", "fee_accruals", "risk_periods", "mirror_state", "paper_checkpoints", "grants", "tenant_settings", "fleet_recovery_health", "recovery_reply_offsets", "announcements"]) {
    assert.ok(names.includes(must), `${must} is allowlisted`);
  }
  assert.ok(Object.isFrozen(DRILL_TABLES));
});

// ── arguments and URLs ───────────────────────────────────────────────────────

test("arguments: a zoned restore point, a default settle margin, and the window derived from both", () => {
  const b = parseDrillArgs(ARGV, ENV, NOW_MS);
  assert.deepEqual(
    { restorePointSec: b.restorePointSec, settleSec: b.settleSec, cutoffSec: b.cutoffSec, afterSec: b.afterSec },
    { restorePointSec: R, settleSec: 900, cutoffSec: R - 900, afterSec: R + 900 },
  );
  assert.equal(parseDrillArgs([`--restore-point=${RESTORE_POINT}`, "--settle-sec=0"], ENV, NOW_MS).cutoffSec, R);
  // R's wall clock two hours east, written with its offset, is the same instant.
  const offset = new Date((R + 2 * 3600) * 1000).toISOString().replace("Z", "+02:00");
  assert.equal(parseDrillArgs(["--restore-point", offset], ENV, NOW_MS).restorePointSec, R);
});

test("arguments: refused, by a fixed message that never repeats what it was given", () => {
  const cases = [
    [],
    ["--restore-point"],
    ["--restore-point", "2026-10-05T02:00:00"], // no zone: whose local time?
    ["--restore-point", "yesterday"],
    ["--restore-point", "2026-13-45T02:00:00Z"],
    ["--restore-point", new Date(NOW_MS + 60_000).toISOString()], // the future
    [...ARGV, "--restore-point", RESTORE_POINT],
    [...ARGV, "--settle-sec", "-5"],
    [...ARGV, "--settle-sec", "15m"],
    [...ARGV, "--settle-sec", "86401"],
    [...ARGV, FORK_URL], // a connection string pasted into argv
    [...ARGV, "--fork", FORK_URL],
  ];
  for (const argv of cases) {
    try {
      parseDrillArgs(argv, ENV, NOW_MS);
      assert.fail(`accepted ${JSON.stringify(argv)}`);
    } catch (e) {
      assert.ok(e instanceof DrillRefusal && e.code === "usage", JSON.stringify(argv));
      assert.doesNotMatch(e.message, /secret|railway\.internal|yesterday|15m/);
    }
  }
  expectRefusal(() => parseDrillArgs(ARGV, { MERRYMEN_RESTORE_FORK_URL: FORK_URL }, NOW_MS), "usage");
  expectRefusal(() => parseDrillArgs(ARGV, { ...ENV, MERRYMEN_RESTORE_SOURCE_URL: "https://example.com/db" }, NOW_MS), "usage");
});

test("a URL's database is its host, port and name, whatever its credentials", () => {
  assert.equal(databaseOf("postgres://a:b@Postgres.Railway.Internal/railway"), "postgres.railway.internal:5432/railway");
  assert.equal(databaseOf("postgresql://a@postgres.railway.internal:5432/railway?sslmode=require"), "postgres.railway.internal:5432/railway");
  assert.equal(databaseOf("postgres://merrymen@localhost:55432"), "localhost:55432/merrymen");
  assert.equal(databaseOf("postgres://u@ignored/db?host=/var/run/postgresql&port=5433"), "/var/run/postgresql:5433/db");
  for (const bad of [undefined, "", "not a url", "mysql://h/db", "postgres://h/%zz"]) assert.equal(databaseOf(bad), null);
});

test("the source is never the fork: the same database under other credentials, or this service's own DATABASE_URL", () => {
  const same = { MERRYMEN_RESTORE_FORK_URL: "postgresql://other:pw@POSTGRES.railway.internal/railway", MERRYMEN_RESTORE_SOURCE_URL: SOURCE_URL };
  expectRefusal(() => parseDrillArgs(ARGV, same, NOW_MS), "fork-is-source");
  expectRefusal(() => parseDrillArgs(ARGV, { ...ENV, DATABASE_URL: FORK_URL.replace("fork-secret", "x") }, NOW_MS), "fork-is-live");
  // Another database on the same server is a different database.
  const sibling = { ...ENV, MERRYMEN_RESTORE_FORK_URL: SOURCE_URL.replace("/railway", "/railway_fork") };
  assert.equal(parseDrillArgs(ARGV, sibling, NOW_MS).forkUrl, sibling.MERRYMEN_RESTORE_FORK_URL);
  // The source being DATABASE_URL is the ordinary case.
  assert.equal(parseDrillArgs(ARGV, { ...ENV, DATABASE_URL: SOURCE_URL }, NOW_MS).sourceUrl, SOURCE_URL);
});

// ── verdicts ─────────────────────────────────────────────────────────────────

test("verdicts: the fork may hold more than the source wrote by the cutoff, never less", () => {
  const side = (rows, newest, after = 0) => ({ present: true, stamped: true, rows, total: rows, after, newest });
  const cases = [
    [side(5, 100), side(5, 100), "match"],
    [side(6, 100), side(5, 100), "source-changed"], // deleted from the source since
    [side(5, 120), side(5, 100), "source-changed"], // re-stamped in the source since
    [side(4, 100), side(5, 100), "fork-behind"],
    [side(5, 90), side(5, 100), "fork-behind"], // restored to an earlier moment
    [side(6, 90), side(5, 100), "fork-behind"], // more rows cannot excuse an older newest
    [side(0, null), side(0, null), "match"],
    [side(0, null), side(1, 100), "fork-behind"],
    [side(5, 100, 1), side(5, 100), "fork-after-restore-point"],
    [{ present: false }, { present: false }, "absent"],
    [{ present: false }, side(1, 100), "missing-in-fork"],
    [side(1, 100), { present: false }, "missing-in-source"],
    [{ present: true, stamped: false }, side(1, 100), "bad-stamp"],
    [side(1, 100), { present: true, stamped: false }, "bad-stamp"],
  ];
  for (const [fork, source, verdict] of cases) assert.equal(verdictOf(fork, source), verdict, JSON.stringify({ fork, source }));
  assert.deepEqual([...FAILING_VERDICTS].sort(), ["bad-stamp", "fork-after-restore-point", "fork-behind", "missing-in-fork", "missing-in-source"]);
});

test("the report prints counts and verdicts, never a stamp", () => {
  const tables = (newest) => Object.fromEntries(DRILL_TABLES.map(({ table }) => [table, { present: true, stamped: true, rows: 3, total: 4, after: 0, newest }]));
  const stamp = 1_789_999_123;
  const report = compareSides({ tables: tables(stamp) }, { tables: tables(stamp) });
  assert.equal(report.ok, true);
  assert.equal(report.exact, true);
  assert.deepEqual(report.failed, []);
  assert.deepEqual(report.summary, { match: DRILL_TABLES.length });
  assert.deepEqual(report.tables.trades, { verdict: "match", fork: { rows: 3, total: 4, after: 0 }, source: { rows: 3, total: 4 }, newest: "equal" });
  assert.doesNotMatch(JSON.stringify(report), new RegExp(String(stamp)));

  const older = compareSides({ tables: { ...tables(stamp), flows: { present: true, stamped: true, rows: 3, total: 3, after: 0, newest: stamp - 1 } } }, { tables: tables(stamp) });
  assert.equal(older.ok, false);
  assert.deepEqual(older.failed, ["flows"]);
  assert.equal(older.tables.flows.newest, "fork-older");
  assert.doesNotMatch(JSON.stringify(older), new RegExp(`${stamp - 1}|${stamp}`));
});

test("a drill that compared nothing is not a pass", () => {
  const none = { tables: Object.fromEntries(DRILL_TABLES.map(({ table }) => [table, { present: true, stamped: true, rows: 0, total: 2, after: 0, newest: null }])) };
  const report = compareSides(none, none);
  assert.equal(report.ok, false);
  assert.equal(report.exact, false);
  assert.equal(report.error.code, "nothing-to-compare");
  const absent = compareSides({ tables: {} }, { tables: {} });
  assert.equal(absent.ok, false);
  assert.equal(absent.summary.absent, DRILL_TABLES.length);
});

// ── the whole drill, over scripted databases ─────────────────────────────────

const FORK_SERVER = { started: "2026-10-05 03:10:00.123456+00" };

test("a faithful fork of a source that kept writing: exact, read-only on both sides, and nothing but counts printed", async () => {
  const stamps = [BEFORE - 7200, BEFORE - 3600, BEFORE, SETTLING];
  const ms = stamps.map((s) => s * 1000 + 999); // agent_commands is Date.now()
  const fork = database({ ...FORK_SERVER, tables: { trades: { stamps }, agent_commands: { stamps: ms } } });
  const source = database({ tables: { trades: { stamps: [...stamps, LATER, LATER + 1] }, agent_commands: { stamps: [...ms, LATER * 1000] } } });
  const out = await drill(fork, source);
  assert.equal(out.exitCode, 0, JSON.stringify(out.report.error ?? out.report.failed));
  assert.equal(out.report.ok, true);
  assert.equal(out.report.exact, true);
  assert.equal(out.report.restorePoint, RESTORE_POINT);
  assert.deepEqual(out.report.tables.trades, { verdict: "match", fork: { rows: 3, total: 4, after: 0 }, source: { rows: 3, total: 6 }, newest: "equal" });
  assert.equal(out.report.tables.agent_commands.verdict, "match");
  assert.equal(out.report.tables.agent_commands.source.rows, 3);

  // The fork first, so a broken fork never costs production a query.
  assert.deepEqual(out.order, ["fork", "source"]);
  for (const side of ["fork", "source"]) {
    const sent = out.clients[side].sent;
    assert.equal(sent[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    assert.equal(sent.at(-1), "ROLLBACK");
    for (const sql of sent.slice(1, -1)) assert.match(sql, /^(SELECT |SET LOCAL )/, sql);
    // The mode is proved before a table is counted.
    assert.ok(sent.findIndex((s) => s.includes("transaction_read_only")) < sent.findIndex((s) => s.includes("AS stamped")));
    assert.equal(out.clients[side].ended, true);
  }

  const printed = JSON.stringify(out.report);
  for (const value of [...stamps, ...ms, SETTLING, LATER, "secret", "railway.internal", "railway", FORK_SERVER.started]) {
    assert.ok(!printed.includes(String(value)), `the report must not carry ${value}`);
  }
});

test("rows the source deleted after the restore point read as source-changed, and still pass", async () => {
  const fork = database({ ...FORK_SERVER, tables: { grants: { stamps: [BEFORE, BEFORE - 1] } } });
  const source = database({ tables: { grants: { stamps: [BEFORE] } } });
  const out = await drill(fork, source);
  assert.equal(out.exitCode, 0);
  assert.equal(out.report.ok, true);
  assert.equal(out.report.exact, false);
  assert.equal(out.report.tables.grants.verdict, "source-changed");
  assert.deepEqual(out.report.summary, { match: DRILL_TABLES.length - 1, "source-changed": 1 });
});

test("a fork missing a row, or restored to an earlier moment, fails", async () => {
  const lost = await drill(database({ ...FORK_SERVER, tables: { flows: { stamps: [BEFORE] } } }), database({ tables: { flows: { stamps: [BEFORE, BEFORE - 5] } } }));
  assert.equal(lost.exitCode, 1);
  assert.equal(lost.report.ok, false);
  assert.deepEqual(lost.report.failed, ["flows"]);
  assert.equal(lost.report.tables.flows.verdict, "fork-behind");

  const early = await drill(database({ ...FORK_SERVER, tables: { equity: { stamps: [BEFORE - 7200, BEFORE - 3600] } } }), database({ tables: { equity: { stamps: [BEFORE - 7200, BEFORE] } } }));
  assert.equal(early.exitCode, 1);
  assert.equal(early.report.tables.equity.verdict, "fork-behind");
  assert.equal(early.report.tables.equity.newest, "fork-older");
});

test("a fork holding rows from after the restore point is not that moment's copy", async () => {
  const out = await drill(database({ ...FORK_SERVER, tables: { decisions: { stamps: [BEFORE, LATER] } } }), database({ tables: { decisions: { stamps: [BEFORE, LATER] } } }));
  assert.equal(out.exitCode, 1);
  assert.equal(out.report.tables.decisions.verdict, "fork-after-restore-point");
  assert.equal(out.report.tables.decisions.fork.after, 1);
});

test("a table the fork lacks, or a stamp that is not an integer, fails; one neither side has yet passes", async () => {
  const fork = database({ ...FORK_SERVER, tables: { journal: null, events: { type: "text", stamps: [BEFORE] }, tg_group_notices: null } });
  const source = database({ tables: { tg_group_notices: null } });
  const out = await drill(fork, source);
  assert.equal(out.exitCode, 1);
  assert.equal(out.report.tables.journal.verdict, "missing-in-fork");
  assert.equal(out.report.tables.events.verdict, "bad-stamp");
  assert.equal(out.report.tables.tg_group_notices.verdict, "absent");
  assert.deepEqual(out.report.failed.sort(), ["events", "journal"]);
  // A text stamp is never scanned.
  assert.ok(!out.clients.fork.sent.some((s) => s.includes('FROM "events")')));
});

test("both URLs reaching one server and database is refused before the source is counted", async () => {
  const out = await drill(database(), database());
  assert.equal(out.exitCode, 64);
  assert.equal(out.report.error.code, "fork-is-source");
  assert.equal(out.report.ok, false);
  assert.ok(!out.clients.source.sent.some((s) => s.includes("AS stamped")), "no table of the source was scanned");
  assert.equal(out.clients.source.sent.at(-1), "ROLLBACK");
  assert.equal(out.clients.source.ended, true);
});

test("a fork that cannot be reached stops the drill before the source is touched, and no message is echoed", async () => {
  const refused = Object.assign(new Error(`connect ECONNREFUSED for ${FORK_URL}`), { code: "ECONNREFUSED" });
  const out = await drill(database(FORK_SERVER), database(), { failFork: refused });
  assert.equal(out.exitCode, 1);
  assert.deepEqual(out.order, ["fork"]);
  assert.deepEqual(out.report.error, { code: "connect-failed", detail: "Could not connect.", side: "fork", cause: "ECONNREFUSED" });
  assert.doesNotMatch(JSON.stringify(out.report), /secret|railway\.internal/);
});

test("a transaction that does not report read-only is refused before a table is read", async () => {
  const out = await drill(database({ ...FORK_SERVER, readonly: "off" }), database());
  assert.equal(out.exitCode, 1);
  assert.deepEqual(out.report.error, { code: "not-read-only", detail: "The transaction did not open read-only; nothing was read.", side: "fork" });
  assert.deepEqual(out.order, ["fork"]);
  assert.ok(!out.clients.fork.sent.some((s) => s.includes("pg_catalog") || s.includes("AS stamped")));
  assert.equal(out.clients.fork.sent.at(-1), "ROLLBACK");
});

test("a failed read names the side, the table and the driver code, and still rolls back", async () => {
  const out = await drill(database(FORK_SERVER), database({ fail: { equity: "57014" } }));
  assert.equal(out.exitCode, 1);
  assert.deepEqual(out.report.error, { code: "query-failed", detail: "A read failed and the drill stopped.", side: "source", table: "equity", cause: "57014" });
  assert.equal(out.clients.source.sent.at(-1), "ROLLBACK");
  assert.equal(out.clients.source.ended, true);
  assert.doesNotMatch(JSON.stringify(out.report), /secret|railway\.internal/);
});

test("a millisecond stamp is read as milliseconds, row by row", async () => {
  // Just after the cutoff in ms. Read as seconds it would be a far-future row
  // in both; truncated wrongly it would land before the cutoff in the source.
  const justAfter = (R - DEFAULT_SETTLE_SEC + 1) * 1000;
  const fork = database({ ...FORK_SERVER, tables: { holder_claims: { stamps: [BEFORE * 1000, BEFORE] } } });
  const source = database({ tables: { holder_claims: { stamps: [BEFORE * 1000, BEFORE, justAfter] } } });
  const out = await drill(fork, source);
  assert.equal(out.report.tables.holder_claims.verdict, "match");
  assert.deepEqual(out.report.tables.holder_claims.source, { rows: 2, total: 3 });
});

test("the command line prints the same JSON and exit code, and refuses a URL in argv without repeating it", () => {
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
  const bare = run([]);
  assert.equal(bare.status, 64);
  assert.equal(JSON.parse(bare.stdout).error.code, "usage");
  const pasted = run(["--restore-point", RESTORE_POINT, FORK_URL]);
  assert.equal(pasted.status, 64);
  assert.doesNotMatch(pasted.stdout + pasted.stderr, /secret|railway\.internal/);
});

// ── opt-in: real Postgres ────────────────────────────────────────────────────

const url = process.env.MERRYMEN_TEST_PG_URL ?? process.env.MERRYMEN_TEST_POSTGRES_URL;
// LOADED ONLY WHEN A DATABASE IS NAMED: `pg` is not a dependency of this repo.
const pg = url ? createRequire(import.meta.url)("pg") : null;

test("Postgres: the drill's SQL over two real databases", { skip: !url, timeout: 60_000 }, async (t) => {
  const target = new URL(url);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "only a disposable local Postgres is allowed");
  const suffix = randomBytes(6).toString("hex");
  const names = { source: `mm_restore_source_${suffix}`, fork: `mm_restore_fork_${suffix}` };
  const urlOf = (name) => Object.assign(new URL(target), { pathname: `/${name}` }).toString();
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const clients = {};
  const reader = `mm_restore_reader_${suffix}`;
  // One hook, in this order: a database with a session open cannot be
  // dropped, and a role cannot be dropped while a database grants it anything.
  t.after(async () => {
    for (const c of Object.values(clients)) await c.end().catch(() => {});
    for (const name of Object.values(names)) await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${reader}`).catch(() => {});
    await admin.end();
  });
  for (const name of Object.values(names)) await admin.query(`CREATE DATABASE ${name}`);

  // The production shapes of a few allowlisted tables (testdata/shared-schema-75995697.sql),
  // and holder_claims' millisecond stamp. Every other allowlisted table is absent on both.
  const SCHEMA = `
    CREATE TABLE trades (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, agent_id text NOT NULL, created_at bigint);
    CREATE TABLE flows (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, agent_id text NOT NULL, at bigint DEFAULT (EXTRACT(epoch FROM now()))::bigint NOT NULL);
    CREATE TABLE grants (tenant text PRIMARY KEY, sealed_session_key text NOT NULL, updated_at bigint NOT NULL);
    CREATE TABLE holder_claims (wallet text PRIMARY KEY, tenant text NOT NULL, claimed_at bigint NOT NULL);
    CREATE TABLE tenant_settings (tenant text PRIMARY KEY, sealed text NOT NULL, updated_at integer NOT NULL);`;
  const seed = async (client, extra = "") => {
    await client.query(SCHEMA);
    await client.query(`
      INSERT INTO trades (agent_id, created_at) VALUES ('0xa', ${BEFORE - 100}), ('0xa', ${BEFORE}), ('0xb', NULL), ('0xb', ${SETTLING});
      INSERT INTO flows (agent_id, at) VALUES ('0xa', ${BEFORE - 50}), ('0xa', ${BEFORE - 10});
      INSERT INTO grants VALUES ('0x1', 'sealed-key-1', ${BEFORE - 30}), ('0x2', 'sealed-key-2', ${BEFORE - 20});
      INSERT INTO holder_claims VALUES ('0xw1', '0x1', ${(BEFORE - 40) * 1000}), ('0xw2', '0x2', ${BEFORE * 1000 + 999});
      INSERT INTO tenant_settings VALUES ('0x1', 'sealed-settings', ${BEFORE - 60});
      ${extra}`);
  };
  for (const [side, name] of Object.entries(names)) {
    clients[side] = new pg.Client({ connectionString: urlOf(name) });
    await clients[side].connect();
  }
  await seed(clients.fork);
  // The source kept going after the restore point.
  await seed(clients.source, `INSERT INTO trades (agent_id, created_at) VALUES ('0xa', ${LATER});
    INSERT INTO holder_claims VALUES ('0xw3', '0x3', ${LATER * 1000});
    UPDATE grants SET updated_at = ${LATER} WHERE tenant = '0x2';`);

  const env = { MERRYMEN_RESTORE_FORK_URL: urlOf(names.fork), MERRYMEN_RESTORE_SOURCE_URL: urlOf(names.source) };
  const run = (overrides = {}) => runRestoreDrill({ argv: ARGV, env: { ...env, ...overrides }, now: () => NOW_MS });

  const first = await run();
  assert.equal(first.exitCode, 0, JSON.stringify(first.report));
  assert.equal(first.report.tables.trades.verdict, "match");
  assert.deepEqual(first.report.tables.trades.source, { rows: 3, total: 5 }); // the unstamped row counts as old
  assert.equal(first.report.tables.holder_claims.verdict, "match");
  assert.equal(first.report.tables.tenant_settings.verdict, "match"); // an int4 stamp
  // The re-signed grant left the source's old rows: the fork holds more, and that passes.
  assert.equal(first.report.tables.grants.verdict, "source-changed");
  assert.equal(first.report.exact, false);
  assert.equal(first.report.tables.journal.verdict, "absent");
  const printed = JSON.stringify(first.report);
  for (const value of ["sealed", "0xw", names.fork, names.source, String(BEFORE), String(BEFORE - 10)]) assert.ok(!printed.includes(value), value);

  // Lose a row from the fork: the drill fails on that table.
  await clients.fork.query(`DELETE FROM flows WHERE at = ${BEFORE - 10}`);
  const lost = await run();
  assert.equal(lost.exitCode, 1);
  assert.equal(lost.report.tables.flows.verdict, "fork-behind");
  assert.equal(lost.report.tables.flows.newest, "fork-older");

  // The same database through a second spelling of its host: refused at runtime.
  const alias = new URL(urlOf(names.source));
  alias.hostname = alias.hostname === "localhost" ? "127.0.0.1" : "localhost";
  const same = await run({ MERRYMEN_RESTORE_FORK_URL: alias.toString() });
  assert.equal(same.exitCode, 64);
  assert.equal(same.report.error.code, "fork-is-source");

  // A role that may not read a table still sees it in the catalog, so the
  // drill stops on that table instead of calling it absent on both sides.
  await admin.query(`CREATE ROLE ${reader} LOGIN`);
  for (const c of Object.values(clients)) await c.query(`GRANT SELECT ON trades, flows, holder_claims, tenant_settings TO ${reader}`);
  const as = (name) => Object.assign(new URL(urlOf(name)), { username: reader, password: "" }).toString();
  const unreadable = await run({ MERRYMEN_RESTORE_FORK_URL: as(names.fork), MERRYMEN_RESTORE_SOURCE_URL: as(names.source) });
  assert.equal(unreadable.exitCode, 1);
  assert.deepEqual(unreadable.report.error, { code: "query-failed", detail: "A read failed and the drill stopped.", side: "fork", table: "grants", cause: "42501" });

  // Nothing above wrote: the drill's sessions were read-only and rolled back.
  const { rows } = await clients.source.query("SELECT count(*)::int AS n FROM trades");
  assert.equal(rows[0].n, 5);
});
