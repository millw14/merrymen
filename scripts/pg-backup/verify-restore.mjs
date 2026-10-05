/**
 * THE RESTORE DRILL: DOES A DISPOSABLE FORK HOLD WHAT THE SOURCE HELD?
 *
 * WHY THIS EXISTS. A backup nobody has restored is a hope, not a backup. The
 * drill (docs/backups.md) restores a point-in-time fork of the shared Postgres
 * into a NEW service, runs this against it, records the JSON and deletes the
 * fork. "The restore finished" is not the evidence: a fork restored to the
 * wrong moment, or without a table, finishes too. This is the evidence.
 *
 *   MERRYMEN_RESTORE_FORK_URL=…  MERRYMEN_RESTORE_SOURCE_URL=… \
 *     node scripts/pg-backup/verify-restore.mjs --restore-point 2026-10-05T02:00:00Z
 *
 * READ ONLY, ON BOTH SIDES. Each database is read inside ONE transaction opened
 * `REPEATABLE READ READ ONLY`, and the transaction's own report of that mode is
 * checked before a table is touched — the proof recovery-replies.ts asks for.
 * Every statement after BEGIN is a SELECT or a SET LOCAL, and the transaction
 * ends in ROLLBACK. No argument makes a write appear. The source is the live
 * database, so the fork is read first: a fork that cannot be opened never
 * costs production a query.
 *
 * NO VALUES LEAVE THIS PROCESS. The output is JSON holding table names (the
 * constants below), row counts and verdicts. The newest stamp of each table
 * and each server's identity are compared in memory and never printed. The
 * connection strings come from the environment, never argv (argv is in `ps`
 * and shell history), and an error is reported by its code alone, because a
 * driver's message can carry a host name. The JSON can go into the runbook
 * evidence as it is.
 *
 * THE COMPARISON, AND WHY IT IS ONE-SIDED. The fork stopped at the restore
 * point; the source kept going. So only rows the source had ALREADY written by
 * then can be compared, and "already" is read from each table's write stamp. A
 * row stamped at or before the cutoff (the restore point less a settle margin,
 * for a commit that lands a moment after its stamp) was in the database at the
 * restore point, so it must be in the fork. The fork may hold MORE such rows —
 * the source can delete a row, or re-stamp it on a later write, after the
 * restore point — but never fewer, and its newest stamp at or before the
 * cutoff can never be older than the source's. Equal on both is `match`. More
 * in the fork is `source-changed`: reported, not a failure. Fewer, or an older
 * newest stamp, is `fork-behind`, and the drill fails.
 *
 * A FORK THAT IS NOT THE FORK. Comparing the source with itself matches
 * perfectly, and that is the most dangerous false pass there is. It is refused
 * three ways: the two URLs name the same database; the fork URL is this
 * process's own DATABASE_URL; the two connections reach the same server and
 * database. Separately, a fork holding rows stamped after the restore point
 * (plus the margin) fails as `fork-after-restore-point`: whatever it is, it is
 * not a copy of that moment.
 *
 * EVERY DOUBT FAILS THE SAME WAY. A margin too small, or a mirror catching up
 * a backlog with old stamps after the restore point, reads as `fork-behind`,
 * never as a pass. Investigate it; never widen the comparison to make it go.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DRILL_FORMAT = "merrymen-restore-drill/v1";

/**
 * THE ALLOWLIST: every table the drill reads, and the stamp it reads it by.
 *
 * A table is here because a restore that lost it would lose money, authority
 * or a guard against doing something twice. Nothing outside this list is
 * read, and neither a table nor a column name can come from input.
 *
 * THE STAMP is an integer epoch written with the row that never moves
 * backwards: an insert time, or the time of the row's last write. Seconds and
 * milliseconds are both in use here, sometimes under the same name
 * (agent_commands.created_at is Date.now()), so each value is normalised to
 * seconds on its own — see MS_FLOOR. A table with no such stamp (energy_days
 * keys on a text day) is not here: it could only be compared whole, which
 * fails every drill taken while the source is still being written.
 *
 * An allowlisted table that the source has not created yet reads `absent` on
 * both sides and passes; it is checked from the first drill after it exists.
 */
export const DRILL_TABLES = Object.freeze([
  // The ledger, mirrored out of every child (ledger-mirror.ts). Insert stamps.
  { table: "trades", stamp: "created_at" },
  { table: "flows", stamp: "at" },
  { table: "flows_quarantine", stamp: "quarantined_at" },
  { table: "equity", stamp: "at" },
  { table: "decisions", stamp: "at" },
  { table: "fee_accruals", stamp: "at" },
  { table: "journal", stamp: "at" },
  { table: "events", stamp: "created_at" },
  { table: "risk_periods", stamp: "started_at" },
  { table: "agent_commands", stamp: "created_at" },
  // Book state, upserted in place: the stamp is the last write.
  { table: "agents", stamp: "created_at" },
  { table: "positions", stamp: "updated_at" },
  { table: "cost_basis", stamp: "updated_at" },
  { table: "position_floors", stamp: "at" },
  { table: "class_positions", stamp: "first_seen" },
  { table: "paper_book", stamp: "updated_at" },
  { table: "paper_checkpoints", stamp: "updated_at" },
  // The mirror's cursors and the original-book imports. A fork without the
  // cursors would copy every child's rows again (CURSOR REWOUND).
  { table: "mirror_state", stamp: "updated_at" },
  { table: "tenant_ledger_import", stamp: "created_at_ms" },
  // Wallet authority and the owner's configuration.
  { table: "grants", stamp: "updated_at" },
  { table: "tenant_settings", stamp: "updated_at" },
  { table: "tenant_telegram", stamp: "updated_at" },
  { table: "telegram_bot_claims", stamp: "claimed_at" },
  { table: "holder_claims", stamp: "claimed_at" },
  { table: "agent_identity", stamp: "created_at" },
  // Recovery state, and the receipts that stop a send or a reply repeating.
  { table: "fleet_recovery_health", stamp: "since_at" },
  { table: "paper_recovery_health", stamp: "updated_at" },
  { table: "recovery_reply_offsets", stamp: "armed_at" },
  { table: "tenant_recovery_reply_state", stamp: "updated_at_ms" },
  { table: "announcements", stamp: "sent_at" },
  { table: "tg_group_notices", stamp: "claimed_at" },
  // Sealed owner memory and group state that the ferries restore into a home.
  { table: "tenant_personal_memory", stamp: "updated_at_ms" },
  { table: "tenant_tg_groups", stamp: "updated_at_ms" },
].map((entry) => Object.freeze(entry)));

// Names are spliced into SQL (quoted), so they are checked when this loads,
// not trusted because a reviewer read the list.
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
for (const { table, stamp } of DRILL_TABLES) {
  if (!IDENTIFIER.test(table) || !IDENTIFIER.test(stamp)) throw new Error("restore drill: an allowlisted name is not a plain identifier");
}
if (new Set(DRILL_TABLES.map((t) => t.table)).size !== DRILL_TABLES.length) throw new Error("restore drill: a table is listed twice");

const INTEGER_TYPES = new Set(["smallint", "integer", "bigint"]);
/** At or above this an epoch is milliseconds: 10^11 seconds is the year 5138, 10^11 ms is 1973. */
const MS_FLOOR = 100_000_000_000;
export const DEFAULT_SETTLE_SEC = 900;
const MAX_SETTLE_SEC = 86_400;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const USAGE = "Usage: node scripts/pg-backup/verify-restore.mjs --restore-point <ISO-8601 time with zone> [--settle-sec N]. "
  + "The URLs are read from MERRYMEN_RESTORE_FORK_URL and MERRYMEN_RESTORE_SOURCE_URL only. See docs/backups.md.";

/** Verdicts that fail the drill. Everything else is reported and passes. */
export const FAILING_VERDICTS = Object.freeze(["missing-in-fork", "missing-in-source", "bad-stamp", "fork-after-restore-point", "fork-behind"]);
/** Refused before anything was compared: exit 64, as for bad usage. */
const REFUSALS = new Set(["usage", "fork-is-source", "fork-is-live"]);

/**
 * A refusal or failure, reported by CODE. `detail` is always a fixed string
 * from this file and `extra` holds only a side, an allowlisted table and a
 * driver code (SQLSTATE or errno) — never anything taken from input.
 */
export class DrillRefusal extends Error {
  constructor(code, detail, extra = {}) {
    super(detail ?? code);
    this.code = code;
    this.detail = detail;
    this.extra = extra;
  }
}

const DRIVER_CODE = /^[A-Za-z0-9_]{1,40}$/;
const causeOf = (e) => (typeof e?.code === "string" && DRIVER_CODE.test(e.code) ? { cause: e.code } : {});

/**
 * WHICH DATABASE A URL NAMES: host, port and database, whatever its user,
 * password or options. Two URLs with the same answer are the same database,
 * so one cannot be the other's fork. Null when it is not a postgres URL.
 */
export function databaseOf(url) {
  if (typeof url !== "string" || url === "") return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
  const host = (u.searchParams.get("host") || u.hostname).toLowerCase();
  if (!host) return null;
  const port = u.searchParams.get("port") || u.port || "5432";
  let database;
  try {
    // libpq's default database is the user's name.
    database = decodeURIComponent(u.pathname.replace(/^\//, "")) || decodeURIComponent(u.username);
  } catch {
    return null;
  }
  return `${host}:${port}/${database}`;
}

/**
 * The arguments and the environment, checked before any connection is made.
 * Throws a DrillRefusal; its detail never repeats what it was given, because
 * what it was given may be a connection string pasted into the wrong place.
 */
export function parseDrillArgs(argv, env, nowMs) {
  let restorePoint, settle;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const value = () => (eq === -1 ? argv[++i] : arg.slice(eq + 1));
    if (flag === "--restore-point" && restorePoint === undefined) restorePoint = value();
    else if (flag === "--settle-sec" && settle === undefined) settle = value();
    else throw new DrillRefusal("usage", USAGE);
  }
  if (typeof restorePoint !== "string" || !ISO_WITH_ZONE.test(restorePoint)) throw new DrillRefusal("usage", USAGE);
  const restoreMs = Date.parse(restorePoint);
  if (!Number.isFinite(restoreMs)) throw new DrillRefusal("usage", USAGE);
  if (restoreMs > nowMs) throw new DrillRefusal("usage", "The restore point is in the future.");
  if (settle !== undefined && (typeof settle !== "string" || !/^\d{1,6}$/.test(settle))) throw new DrillRefusal("usage", USAGE);
  const settleSec = settle === undefined ? DEFAULT_SETTLE_SEC : Number(settle);
  if (settleSec > MAX_SETTLE_SEC) throw new DrillRefusal("usage", "--settle-sec is at most 86400.");

  const forkUrl = env.MERRYMEN_RESTORE_FORK_URL;
  const sourceUrl = env.MERRYMEN_RESTORE_SOURCE_URL;
  const fork = databaseOf(forkUrl);
  const source = databaseOf(sourceUrl);
  if (!fork || !source) throw new DrillRefusal("usage", USAGE);
  if (fork === source) throw new DrillRefusal("fork-is-source", "The fork and source URLs name the same database.");
  if (fork === databaseOf(env.DATABASE_URL)) {
    throw new DrillRefusal("fork-is-live", "The fork URL names this service's DATABASE_URL. The live database is never the fork.");
  }
  const restorePointSec = Math.floor(restoreMs / 1000);
  return {
    restorePointSec,
    settleSec,
    cutoffSec: restorePointSec - settleSec,
    afterSec: restorePointSec + settleSec,
    forkUrl,
    sourceUrl,
  };
}

/**
 * One connection. `pg` is a hosted-only runtime dependency — the Dockerfile
 * installs it and package.json deliberately does not name it — so it is loaded
 * here, on use, from wherever this file sits: /app/node_modules in the image.
 * Nothing but the application name is sent as a startup option, so a pooler
 * in front of either database has nothing to reject. `load` is the test seam.
 *
 * AN 'error' EVENT IS HEARD, AND DOES NOTHING ELSE. pg emits one on the client
 * when the server drops the session mid-read (a restart, a failover,
 * pg_terminate_backend, a network blip). Unheard, it kills the process before
 * a line of JSON is written, with a stack trace in its place. Heard, the read
 * in flight rejects with its own code and the drill reports `query-failed`
 * like any other failed read (the same listener identity-store.ts keeps).
 */
export async function connectPg(url, load = () => createRequire(import.meta.url)("pg")) {
  let pg;
  try {
    pg = load();
  } catch {
    throw new DrillRefusal("no-driver", "The pg driver is not installed here. Run from the hosted image, where the Dockerfile installs it.");
  }
  const client = new pg.Client({ connectionString: url, application_name: "merrymen-restore-drill", connectionTimeoutMillis: 15_000 });
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (e) {
    await client.end().catch(() => {});
    throw e;
  }
  return client;
}

/**
 * One scan per table. The stamp is normalised to seconds row by row (MS_FLOOR),
 * so a table that mixes units still places every row on the right side of the
 * cutoff. A row with no stamp counts as old: it cannot be placed after the
 * restore point, so it must be in the fork too.
 */
function countSql(table, stamp) {
  const s = `"${stamp}"::bigint`;
  return `SELECT count(*) FILTER (WHERE s IS NULL OR s <= $1::bigint) AS rows,
       max(s) FILTER (WHERE s <= $1::bigint) AS newest,
       count(*) FILTER (WHERE s > $2::bigint) AS after,
       count(*) AS total
  FROM (SELECT CASE WHEN ${s} >= ${MS_FLOOR} THEN ${s} / 1000 ELSE ${s} END AS s FROM "${table}") AS stamped`;
}

function integerOf(v, nonNegative) {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isSafeInteger(n) || (nonNegative && n < 0)) throw new DrillRefusal("unreadable", "A count or stamp was not an integer.");
  return n;
}

/**
 * EVERYTHING THE DRILL READS FROM ONE DATABASE, in one read-only snapshot.
 * `admit` sees the server's identity before any table is counted, so the
 * source can be refused for being the fork without a scan of production.
 * The identity and each `newest` stay in memory: compareSides prints neither.
 */
async function readSide(client, bounds, side, admit) {
  let table;
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    // A count that queues behind a migration's lock gives up rather than
    // holding everything that queues behind it in turn.
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const mode = (await client.query(
      "SELECT current_setting('transaction_read_only') AS readonly, current_setting('transaction_isolation') AS isolation",
    )).rows[0];
    if (mode?.readonly !== "on" || mode?.isolation !== "repeatable read") {
      throw new DrillRefusal("not-read-only", "The transaction did not open read-only; nothing was read.", { side });
    }
    // Which postmaster and which database. A fork is a different server
    // process, so its start time differs even when everything else is copied.
    const who = (await client.query("SELECT current_database() AS db, pg_postmaster_start_time()::text AS started")).rows[0];
    const identity = JSON.stringify([who?.db ?? null, who?.started ?? null]);
    admit(identity);
    // From the catalog, not information_schema: information_schema hides a
    // table the role may not read, and a table hidden on both sides would read
    // `absent` and pass. Here it is present, its count is refused, and the
    // drill stops loudly.
    const columns = (await client.query(
      `SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, NULL) AS data_type
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND c.relname = ANY($1::text[])
          AND a.attnum > 0 AND NOT a.attisdropped`,
      [DRILL_TABLES.map((t) => t.table)],
    )).rows;
    const tables = {};
    for (const entry of DRILL_TABLES) {
      table = entry.table;
      const own = columns.filter((c) => c.table_name === entry.table);
      if (own.length === 0) {
        tables[entry.table] = { present: false };
        continue;
      }
      if (!INTEGER_TYPES.has(own.find((c) => c.column_name === entry.stamp)?.data_type)) {
        tables[entry.table] = { present: true, stamped: false };
        continue;
      }
      const r = (await client.query(countSql(entry.table, entry.stamp), [bounds.cutoffSec, bounds.afterSec])).rows[0];
      tables[entry.table] = {
        present: true,
        stamped: true,
        rows: integerOf(r?.rows, true),
        total: integerOf(r?.total, true),
        after: integerOf(r?.after, true),
        newest: r?.newest === null || r?.newest === undefined ? null : integerOf(r.newest, false),
      };
    }
    return { identity, tables };
  } catch (e) {
    if (e instanceof DrillRefusal) throw e;
    throw new DrillRefusal("query-failed", "A read failed and the drill stopped.", { side, ...(table ? { table } : {}), ...causeOf(e) });
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
}

const compareStamp = (a, b) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);

/** One table's verdict. See the header for why the comparison is one-sided. */
export function verdictOf(fork, source) {
  if (!fork.present && !source.present) return "absent";
  if (!fork.present) return "missing-in-fork";
  if (!source.present) return "missing-in-source";
  if (!fork.stamped || !source.stamped) return "bad-stamp";
  if (fork.after > 0) return "fork-after-restore-point";
  const newest = compareStamp(fork.newest, source.newest);
  if (fork.rows < source.rows || newest < 0) return "fork-behind";
  if (fork.rows === source.rows && newest === 0) return "match";
  return "source-changed";
}

/**
 * THE REPORT. Counts and verdicts only: `newest` becomes equal / fork-newer /
 * fork-older and the stamps themselves are dropped here. `ok` is the drill's
 * result; `exact` says every table present matched outright, which is what a
 * drill taken while the source is quiet (the trading hold) should show.
 *
 * A drill that compared nothing — every table absent, or every source row
 * stamped after the cutoff — is not a pass, whatever the verdicts say.
 */
export function compareSides(fork, source) {
  const tables = {};
  const summary = {};
  const failed = [];
  let compared = 0;
  for (const { table } of DRILL_TABLES) {
    const f = fork.tables[table] ?? { present: false };
    const s = source.tables[table] ?? { present: false };
    const verdict = verdictOf(f, s);
    summary[verdict] = (summary[verdict] ?? 0) + 1;
    if (FAILING_VERDICTS.includes(verdict)) failed.push(table);
    const entry = { verdict };
    if (f.present && s.present && f.stamped && s.stamped) {
      const newest = compareStamp(f.newest, s.newest);
      entry.fork = { rows: f.rows, total: f.total, after: f.after };
      entry.source = { rows: s.rows, total: s.total };
      entry.newest = newest === 0 ? (f.newest === null ? "none" : "equal") : newest > 0 ? "fork-newer" : "fork-older";
      compared += s.rows;
    }
    tables[table] = entry;
  }
  const empty = failed.length === 0 && compared === 0;
  const ok = failed.length === 0 && !empty;
  return {
    ok,
    exact: ok && Object.values(tables).every((t) => t.verdict === "match" || t.verdict === "absent"),
    failed,
    summary,
    tables,
    ...(empty ? { error: { code: "nothing-to-compare", detail: "No source row was stamped at or before the cutoff; nothing was compared." } } : {}),
  };
}

function errorOf(e) {
  if (e instanceof DrillRefusal) return { code: e.code, ...(e.detail ? { detail: e.detail } : {}), ...e.extra };
  return { code: "failed", ...causeOf(e) };
}

const isoOf = (sec) => new Date(sec * 1000).toISOString();

async function connected(connect, url, side) {
  try {
    return await connect(url);
  } catch (e) {
    if (e instanceof DrillRefusal) throw e;
    throw new DrillRefusal("connect-failed", "Could not connect.", { side, ...causeOf(e) });
  }
}

/**
 * The whole drill: arguments, the fork, then the source, then the verdicts.
 * Returns the report and an exit code — 0 passed, 1 failed or could not
 * finish, 64 refused before anything was compared. `connect` is the test seam.
 */
export async function runRestoreDrill({ argv = [], env = {}, now = Date.now, connect = connectPg } = {}) {
  const head = { format: DRILL_FORMAT };
  let bounds;
  try {
    bounds = parseDrillArgs(argv, env, now());
  } catch (e) {
    return { exitCode: 64, report: { ...head, ok: false, exact: false, error: errorOf(e) } };
  }
  const window = { restorePoint: isoOf(bounds.restorePointSec), cutoff: isoOf(bounds.cutoffSec), settleSec: bounds.settleSec };
  const sides = {};
  try {
    for (const [side, url] of [["fork", bounds.forkUrl], ["source", bounds.sourceUrl]]) {
      const client = await connected(connect, url, side);
      try {
        sides[side] = await readSide(client, bounds, side, (identity) => {
          if (side === "source" && identity === sides.fork.identity) {
            throw new DrillRefusal("fork-is-source", "Both connections reached the same server and database.");
          }
        });
      } finally {
        await client.end().catch(() => {});
      }
    }
  } catch (e) {
    const refused = e instanceof DrillRefusal && REFUSALS.has(e.code);
    return { exitCode: refused ? 64 : 1, report: { ...head, ...window, ok: false, exact: false, error: errorOf(e) } };
  }
  const result = compareSides(sides.fork, sides.source);
  return { exitCode: result.ok ? 0 : 1, report: { ...head, ...window, ...result } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exitCode, report } = await runRestoreDrill({ argv: process.argv.slice(2), env: process.env });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = exitCode;
}
