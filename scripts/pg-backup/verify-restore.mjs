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
 * READ ONLY, ON BOTH SIDES. Every read is made inside a short transaction
 * opened `REPEATABLE READ READ ONLY`: one for the catalog, then one per table
 * (readSide says why not one for all). Each transaction's own report of that
 * mode is checked before it reads anything — the proof recovery-replies.ts
 * asks for. Every statement inside is a SELECT or a SET LOCAL, and every
 * transaction ends in ROLLBACK. No argument makes a write appear. The source
 * is the live database, so the fork is read first: a fork that cannot be
 * opened never costs production a query.
 *
 * NO VALUES LEAVE THIS PROCESS. The output is JSON holding table names, their
 * kinds and fixed reasons (the constants below), row counts and verdicts. The
 * newest stamp of each table and each server's identity are compared in
 * memory and never printed. The connection strings come from the environment,
 * never argv (argv is in `ps` and shell history), and an error is reported by
 * its code alone, because a driver's message can carry a host name. The JSON
 * can go into the runbook evidence as it is.
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
 * PRESENCE IS NOT CONTENT. Counts and a newest stamp show the fork holds the
 * rows. Whether it holds them as they stood at the restore point depends on
 * how each table is written, so every allowlisted table carries a KIND (see
 * DRILL_KINDS), read from its writers. Where some writer changes a row
 * without moving its stamp, a fork holding an older version of that row
 * counts exactly like one holding the current version: `match` there would be
 * a claim the drill cannot make. Such a table reads `present-content-unverified`
 * instead and is named, with its reason, in the report's `contentUnverified`.
 * That is stated, not failed — the fork may well be right — but no pass ever
 * claims those contents were checked.
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
 * a backlog of inserts with old stamps after the restore point, reads as
 * `fork-behind`, never as a pass. Investigate it; never widen the comparison
 * to make it go. (A backlog of in-place changes is invisible to any count;
 * that is exactly what a presence-only table's reason says.)
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// v2: tables carry their kind, presence-only tables read
// `present-content-unverified`, and the report says `contentsVerified`.
export const DRILL_FORMAT = "merrymen-restore-drill/v2";

/**
 * THE KINDS: WHAT A VERDICT MAY SAY ABOUT A TABLE'S CONTENTS.
 *
 * The comparison proves PRESENCE: the fork holds at least the rows the source
 * had stamped by the cutoff. Whether it holds their CONTENTS as they stood at
 * the restore point depends on how the table is written, and that is read from
 * its writers — every INSERT, UPDATE, DELETE and upsert in worker/src, web/src
 * and scripts that reaches the shared database — never from its name or from
 * what its stamp column is called. One writer is enough to lower a kind:
 *
 *   append         Rows are inserted and never changed after; at most they
 *                  are deleted. The stamp is the insert's. A row the fork holds
 *                  is the row the source holds, so presence IS content, and a
 *                  late insert carrying an old stamp (a mirror backlog, a
 *                  repair) leaves the fork a row short: `fork-behind`.
 *   last-write     Every writer that changes a row also sets the stamp to the
 *                  time of that write, on its own clock (Date.now(),
 *                  unixepoch()). A fork is one moment of the source, so a
 *                  fork whose newest stamp is not behind the source's holds
 *                  every write stamped before it too: every row as the source
 *                  last wrote it by the cutoff. A fork taken earlier lacks the
 *                  newest write and reads `fork-behind`. The residue is the
 *                  margin's blind spot again, smaller: whole seconds cannot
 *                  order two writes in one second, nor a commit that trailed
 *                  its own stamp.
 *   presence-only  Some writer changes a row without moving its stamp, or
 *                  sets the stamp from another clock, or puts an older value
 *                  back. A fork holding an older version of such a row counts
 *                  exactly like one holding the current version, so the
 *                  comparison can prove the rows are there and nothing about
 *                  what they say. Such a table never reads `match`: it reads
 *                  `present-content-unverified`, and the report names it in
 *                  `contentUnverified` with its `why`, a fixed sentence
 *                  printed as written. It does not fail the drill for that —
 *                  every presence verdict (`fork-behind` and the rest) still
 *                  applies to it and still fails.
 *
 * A STAMP COPIED FROM ANOTHER DATABASE IS NOT A LAST-WRITE STAMP HERE. The
 * mirror writes each child row with the child's own stamp, which is the
 * child's clock: a pass that lands after the restore point can change a row
 * here under a stamp from before it. An INSERT carrying such a stamp is still
 * caught by the count, which is why the append tables the mirror fills stay
 * append; an in-place change is not, which is why the snapshot tables it
 * rewrites (positions, cost_basis, position_floors, class_positions) do not.
 *
 * AN OLDER STAMP WRITTEN BACK (an undo restoring the claim it replaced) can
 * only make a good fork read `fork-behind`; it never lets a bad one through
 * the presence check. So it lowers a table's kind and nothing else.
 *
 * TO MOVE A TABLE UP. A presence-only table becomes last-write once it has a
 * stamp that EVERY writer sets to the time of its write — an `updated_at`
 * added by a migration and maintained by each writer — and its entry here is
 * switched to that column. That is deliberately not done in this file: it is
 * a schema change and a change to every writer, each of which is reviewed on
 * its own. A few presence-only tables appear to carry such a column already
 * (agent_identity.updated_at, fleet_recovery_health.checked_at,
 * recovery_reply_offsets.updated_at_ms); switching to one needs the same
 * writer-by-writer reading first, because a single writer that skips it
 * turns a last-write claim back into the false `match` this exists to stop.
 */
export const DRILL_KINDS = Object.freeze(["append", "last-write", "presence-only"]);

// Names are spliced into SQL (quoted), so they are checked when this loads,
// not trusted because a reviewer read the list.
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
/** A presence-only table's reason is printed: one plain line, bounded. */
const REASON = /^[\x20-\x7e]{1,160}$/;
const ENTRY_FIELDS = new Set(["table", "stamp", "kind", "why"]);

/**
 * THE ALLOWLIST'S SHAPE, CHECKED WHEN THIS LOADS — and exported so the test
 * can show each malformed entry is refused rather than read. An entry names a
 * plain table, a plain stamp column and a kind; a presence-only entry also
 * says why, and no other entry may, so a reason can never sit beside a kind
 * that claims content. Returns the list frozen, entry by entry.
 */
export function validateDrillTables(entries) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("restore drill: the allowlist is empty");
  const seen = new Set();
  return Object.freeze(entries.map((entry) => {
    if (entry === null || typeof entry !== "object" || Object.keys(entry).some((k) => !ENTRY_FIELDS.has(k))) {
      throw new Error("restore drill: an allowlisted entry has a field it should not");
    }
    const { table, stamp, kind, why } = entry;
    if (typeof table !== "string" || typeof stamp !== "string" || !IDENTIFIER.test(table) || !IDENTIFIER.test(stamp)) {
      throw new Error("restore drill: an allowlisted name is not a plain identifier");
    }
    if (seen.has(table)) throw new Error("restore drill: a table is listed twice");
    seen.add(table);
    if (!DRILL_KINDS.includes(kind)) throw new Error("restore drill: an allowlisted table has no kind");
    if (kind === "presence-only" ? typeof why !== "string" || !REASON.test(why) : why !== undefined) {
      throw new Error("restore drill: a presence-only table needs its reason, and only it may have one");
    }
    return Object.freeze({ ...entry });
  }));
}

/**
 * THE ALLOWLIST: every table the drill reads, the stamp it reads it by, and
 * the kind its writers make it (above).
 *
 * A table is here because a restore that lost it would lose money, authority
 * or a guard against doing something twice. Nothing outside this list is
 * read, and neither a table nor a column name can come from input.
 *
 * THE STAMP is an integer epoch written with the row: an insert time, or the
 * time of a write. Seconds and milliseconds are both in use here, sometimes
 * under the same name (agent_commands.created_at is Date.now()), so each value
 * is normalised to seconds on its own — see MS_FLOOR. A table with no such
 * stamp (energy_days keys on a text day) is not here: it could only be
 * compared whole, which fails every drill taken while the source is still
 * being written.
 *
 * EACH KIND IS CITED FROM ITS WRITERS, beside the entry. Presence-only cites
 * one writer that changes a row without moving the stamp (there are often
 * more); append and last-write cite every writer found, because one missed
 * writer is the whole question. A new writer of any table here, or a new
 * table, needs its entry read again.
 *
 * An allowlisted table that the source has not created yet reads `absent` on
 * both sides and passes; it is checked from the first drill after it exists.
 */
export const DRILL_TABLES = validateDrillTables([
  // ── The ledger, mirrored out of every child (ledger-mirror.ts) ────────────
  //
  // Resolved in place: the mirror's resolution pass (`UPDATE trades SET
  // tx_hash = COALESCE(…), status = ?, … WHERE … status = 'submitted'`),
  // store.ts addTrade's resolution of an in-flight row, orchestrator.ts's
  // realised-P&L booking against the shared trades, history-fill-repair.ts.
  // None of them touches created_at.
  { table: "trades", stamp: "created_at", kind: "presence-only",
    why: "A submitted trade is resolved in place (status, tx hash, fill, gas) without moving created_at." },
  // Inserted by store.ts insertFlowWithJournal, accounting-repair.ts and the
  // mirror, and deleted only by accounting-repair.ts's quarantine — but
  // store.ts's SQLITE_ALTERS, which applyLedgerSchema runs against the shared
  // database on every orchestrator boot, rewrite tx_hash to lowercase and
  // fill a NULL chain_id in place. `at` stays.
  { table: "flows", stamp: "at", kind: "presence-only",
    why: "Boot-time normalisation lowercases tx_hash and fills chain_id in place without moving at." },
  // accounting-repair.ts's quarantine step only: INSERT … SELECT, stamped
  // with the repair's own now. Never updated or deleted.
  { table: "flows_quarantine", stamp: "quarantined_at", kind: "append" },
  // store.ts (each mark, and writePaperOpening) and the mirror's
  // `INSERT … ON CONFLICT DO NOTHING`. Never updated or deleted.
  { table: "equity", stamp: "at", kind: "append" },
  // store.ts addDecision, and the mirror's `ON CONFLICT (id) DO NOTHING` — a
  // decision reaches here exactly as first written (see the note there).
  { table: "decisions", stamp: "at", kind: "append" },
  // store.ts addFeeAccrual and the mirror. Never updated or deleted.
  { table: "fee_accruals", stamp: "at", kind: "append" },
  // store.ts appendJournalRow only: a hash chain, insert-only by design.
  { table: "journal", stamp: "at", kind: "append" },
  // store.ts, orchestrator.ts, held-reset.ts, risk-period.ts and the mirror,
  // all INSERT. Never updated or deleted.
  { table: "events", stamp: "created_at", kind: "append" },
  // risk-period.ts: mergeRiskPeriod's upsert (which the mirror runs against
  // the shared database), markRiskPeriod and adjustRiskCapital all raise
  // hwm_usdg / withdrawn_usdg in place. started_at is the period's identity.
  { table: "risk_periods", stamp: "started_at", kind: "presence-only",
    why: "The period's high-water mark and withdrawals are raised in place without moving started_at." },
  // orchestrator.ts claims and completes commands in the shared database
  // (claimed_at, done_at, result, receipt), as do store.ts, held-reset.ts and
  // web/src/lib/services/proposals.ts.
  { table: "agent_commands", stamp: "created_at", kind: "presence-only",
    why: "Claim, completion, result and receipt are written in place without moving created_at." },

  // ── Book state ────────────────────────────────────────────────────────────
  //
  // The mirror's agents upsert sets caps, expiry, status, heartbeat, mode,
  // epoch, HWM, fees and accounting quality and never created_at; so do
  // store.ts's epoch / HWM / fee / quality updates, paper-checkpoint.ts's
  // epoch move and accounting-repair.ts. The case the review named.
  { table: "agents", stamp: "created_at", kind: "presence-only",
    why: "Caps, expiry, heartbeat, epoch, HWM, fees and accounting quality are upserted without moving created_at." },
  // Every writer sets updated_at — store.ts's upsert to unixepoch() — but
  // here the mirror deletes each agent's rows and re-inserts them carrying
  // the CHILD's updated_at (see A STAMP COPIED, above).
  { table: "positions", stamp: "updated_at", kind: "presence-only",
    why: "The mirror rewrites each row with the child's own stamp, which can predate the write here." },
  // paper-checkpoint.ts restorePaperCheckpoint renormalises a child's qty_raw
  // without updated_at, and the mirror's upsert carries that unchanged child
  // stamp here with the new quantity.
  { table: "cost_basis", stamp: "updated_at", kind: "presence-only",
    why: "A child's basis is renormalised without moving updated_at, and the mirror copies the child's stamp." },
  // The mirror upserts with the child's own `at`, and basis-seed.ts re-seeds
  // a rebuilt child's floors carrying the `at` it read from here.
  { table: "position_floors", stamp: "at", kind: "presence-only",
    why: "The mirror upserts with the child's own at, and a re-seeded floor carries a historical at." },
  // The mirror's upsert sets state, quantities and proceeds and never
  // first_seen; store.ts moves first_seen BACK to an earlier sighting.
  { table: "class_positions", stamp: "first_seen", kind: "presence-only",
    why: "State, quantities and proceeds are upserted without moving first_seen, which can also move back." },
  // store.ts only, and every statement stamps the write: INSERT OR IGNORE
  // (DEFAULT unixepoch()), resetPaperLedger's upsert and setPaperBook (both
  // `updated_at = unixepoch()`). paper-checkpoint.ts's restore writes the
  // CHILD's book, never this one.
  { table: "paper_book", stamp: "updated_at", kind: "last-write" },
  // paper-checkpoint.ts mirrorPaperCheckpoints: on a newer epoch the upsert
  // takes the child's row whatever its updated_at (older included), and on an
  // equal updated_at (`>=`) it overwrites the contents.
  { table: "paper_checkpoints", stamp: "updated_at", kind: "presence-only",
    why: "A new epoch replaces the row whatever its stamp, and an equal stamp overwrites the contents." },

  // ── The mirror's cursors and the original-book imports ────────────────────
  //
  // A fork without the cursors would copy every child's rows again (CURSOR
  // REWOUND). The mirror's first witness of a cursor sets last_stamp alone
  // (`DO UPDATE SET last_stamp = excluded.last_stamp`).
  { table: "mirror_state", stamp: "updated_at", kind: "presence-only",
    why: "A cursor's first witness sets last_stamp without moving updated_at." },
  // ledger-import.ts consumes or deletes an import, and grant-store.ts
  // deletes them with a grant: state changes and the sealed body is cleared.
  { table: "tenant_ledger_import", stamp: "created_at_ms", kind: "presence-only",
    why: "Consuming or deleting an import rewrites its state and clears its sealed body without moving created_at_ms." },

  // ── Wallet authority and the owner's configuration ────────────────────────
  //
  // grant-store.ts stopForReplacement rewrites grant_json and erases the
  // sealed session key, and leaves updated_at as it was.
  { table: "grants", stamp: "updated_at", kind: "presence-only",
    why: "Stopping a grant for replacement erases its session key without moving updated_at." },
  // settings-store.ts put is the one writer (`updated_at = EXCLUDED.updated_at`,
  // Date.now() at the write); remove deletes.
  { table: "tenant_settings", stamp: "updated_at", kind: "last-write" },
  // telegram-store.ts writes condition alerts, hold notices and poll liveness,
  // and recovery-replies.ts the listener's state, none of them updated_at.
  { table: "tenant_telegram", stamp: "updated_at", kind: "presence-only",
    why: "Alerts, hold notices and poll liveness are written in place without moving updated_at." },
  // telegram-claims.ts undoBotClaim puts the replaced holder back WITH its
  // older claimed_at.
  { table: "telegram_bot_claims", stamp: "claimed_at", kind: "presence-only",
    why: "Undoing a move puts the replaced holder back with its older claimed_at." },
  // settings-store.ts undoTakeHolder, the same way.
  { table: "holder_claims", stamp: "claimed_at", kind: "presence-only",
    why: "Undoing a move puts the replaced holder back with its older claimed_at." },
  // identity-store.ts adds accounts and links a social identity in place,
  // moving updated_at and never created_at (the stamp read here).
  { table: "agent_identity", stamp: "created_at", kind: "presence-only",
    why: "Accounts and the linked social identity are updated in place without moving created_at." },
  // One account, one identity, ever (account-claim.ts): identity-store.ts's
  // three `INSERT … ON CONFLICT (smart_account) DO NOTHING`, and nothing else.
  { table: "agent_account", stamp: "claimed_at", kind: "append" },

  // ── The apps an owner connected over MCP, and the tokens that act for them ─
  //
  // web/src/mcp/oauth/server.ts re-stamps a connection when it is re-approved
  // or revoked, but records each use in last_used_at alone.
  { table: "mcp_connections", stamp: "updated_at", kind: "presence-only",
    why: "Each use is recorded in last_used_at without moving updated_at." },
  // server.ts marks a refresh token used and revokes tokens and families in
  // place. Pruning one (worker/src/mcp/maintenance.ts) reads `source-changed`.
  { table: "mcp_tokens", stamp: "created_at", kind: "presence-only",
    why: "Use and revocation are written in place without moving created_at." },

  // ── Recovery state, and the receipts that stop a send or a reply repeating ─
  //
  // fleet-recovery.ts clears a hold (held = 0) and changes its cause while
  // keeping since_at, the moment it began.
  { table: "fleet_recovery_health", stamp: "since_at", kind: "presence-only",
    why: "Clearing a hold, or changing its cause, keeps since_at." },
  // paper-checkpoint.ts recordPaperRecoveryHealth is the one writer: an
  // upsert setting updated_at to Date.now() at the write.
  { table: "paper_recovery_health", stamp: "updated_at", kind: "last-write" },
  // recovery-reply-store.ts advanceReplyOffset moves offset_id and
  // updated_at_ms; armed_at moves only on a rebind.
  { table: "recovery_reply_offsets", stamp: "armed_at", kind: "presence-only",
    why: "Advancing the reply offset moves updated_at_ms, not armed_at." },
  // recovery-reply-store.ts advanceReplyOffset's upsert is the one writer,
  // stamped with the caller's now() — Date.now(), recovery-replies.ts.
  { table: "tenant_recovery_reply_state", stamp: "updated_at_ms", kind: "last-write" },
  // announce.ts: `INSERT … ON CONFLICT DO NOTHING` once a send succeeded,
  // stamped then. Never updated or deleted.
  { table: "announcements", stamp: "sent_at", kind: "append" },
  // announce.ts moves an attempt's state to sent, aborted or uncertain.
  { table: "announcement_attempts", stamp: "claimed_at", kind: "presence-only",
    why: "An attempt's state (sent, aborted, uncertain) changes in place without moving claimed_at." },
  // tg-group-recovery-notice.ts records the send's status and sent_at.
  { table: "tg_group_notices", stamp: "claimed_at", kind: "presence-only",
    why: "A notice's status and sent_at are written in place without moving claimed_at." },
  // worker/src/mcp/notify.ts (and web/src/mcp/tools/notifications.ts) move a
  // delivery through sending, retry, sent, dead and skipped.
  { table: "notify_deliveries", stamp: "created_at", kind: "presence-only",
    why: "Status, attempts and retry times change in place without moving created_at." },

  // ── An app's order proposals ──────────────────────────────────────────────
  //
  // One per (tenant, idempotency key), carrying the order it became.
  // web/src/lib/services/proposals.ts: the insert, setStatus and
  // cancelAwaitingForConnection each set updated_at to the caller's now.
  { table: "mcp_proposals", stamp: "updated_at", kind: "last-write" },

  // ── Sealed owner memory and group state that the ferries restore into a home
  //
  // personal-memory-ferry.ts's upsert and patch, memory-safeguard.ts's seed
  // (insert only) and recovery-reply-store.ts's erase, each Date.now() at the
  // write. memory-safeguard.ts's backup-stamped insert is into its own
  // in-memory check, not here.
  { table: "tenant_personal_memory", stamp: "updated_at_ms", kind: "last-write" },
  // tg-groups-ferry.ts's upsert and patch and recovery-reply-store.ts's
  // erase, the same way.
  { table: "tenant_tg_groups", stamp: "updated_at_ms", kind: "last-write" },
]);

const INTEGER_TYPES = new Set(["smallint", "integer", "bigint"]);
/** At or above this an epoch is milliseconds: 10^11 seconds is the year 5138, 10^11 ms is 1973. */
const MS_FLOOR = 100_000_000_000;
/**
 * THE SETTLE MARGIN IS ALSO A BLIND SPOT. Rows stamped within it of the restore
 * point are compared by neither side, so a fork restored up to that far before
 * or after the point still passes. Widening it hides the very error the
 * drill is for, so it is capped low: a `fork-behind` that needs more than an
 * hour is answered with a restore point outside the backlog, not a wider
 * margin.
 */
export const DEFAULT_SETTLE_SEC = 900;
const MAX_SETTLE_SEC = 3_600;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const USAGE = "Usage: node scripts/pg-backup/verify-restore.mjs --restore-point <ISO-8601 time with zone> [--settle-sec N]. "
  + "The URLs are read from MERRYMEN_RESTORE_FORK_URL and MERRYMEN_RESTORE_SOURCE_URL only. See docs/backups.md.";

/** Verdicts that fail the drill. Everything else is reported and passes. */
export const FAILING_VERDICTS = Object.freeze(["missing-in-fork", "missing-in-source", "bad-stamp", "fork-after-restore-point", "fork-behind"]);
/**
 * A PRESENCE-ONLY TABLE'S `match`. The fork holds the same rows by count and
 * newest stamp, and nothing more is known (THE KINDS). It passes — stated, not
 * failed — but it is never spelt `match`, so no reading of the report, by a
 * person or a script looking for that word, can take it for a check of what
 * the rows say.
 */
const CONTENT_UNVERIFIED = "present-content-unverified";
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
  if (settleSec > MAX_SETTLE_SEC) throw new DrillRefusal("usage", "--settle-sec is at most 3600.");

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
 * ONE SHORT TRANSACTION, PROVED READ-ONLY BEFORE IT READS. Opened
 * `REPEATABLE READ READ ONLY`, bounded, and checked by its own report of that
 * mode before `read` runs — the proof recovery-replies.ts asks for. It always
 * ends in ROLLBACK, which is also what lets go of the read locks it took.
 */
async function readOnly(client, side, read) {
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
    return await read();
  } finally {
    await client.query("ROLLBACK").catch(() => {});
  }
}

/**
 * EVERYTHING THE DRILL READS FROM ONE DATABASE. The first transaction reads
 * the server's identity and the catalog, and `admit` sees the identity before
 * any table is counted, so the source can be refused for being the fork
 * without a scan of production.
 *
 * ONE TABLE PER TRANSACTION. A table's read lock is held until its
 * transaction ends. One snapshot across every table would hold each lock
 * until the LAST count finished, and an ALTER the app runs on every connect
 * (settings-store.ts adds holder_claims.moved_at, with no lock timeout) would
 * queue behind it, with every read and write of that table queued behind the
 * ALTER. Counted alone, a table is held for one count. Nothing is lost: each
 * table is compared on its own, and the fork, which nothing writes, reads the
 * same either way.
 *
 * The identity and each `newest` stay in memory: compareSides prints neither.
 */
async function readSide(client, bounds, side, admit) {
  let table;
  try {
    const { identity, columns } = await readOnly(client, side, async () => {
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
      return { identity, columns };
    });
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
      const r = await readOnly(client, side, async () => (await client.query(countSql(entry.table, entry.stamp), [bounds.cutoffSec, bounds.afterSec])).rows[0]);
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
  }
}

const compareStamp = (a, b) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);

/**
 * One table's verdict. See the header for why the comparison is one-sided,
 * and THE KINDS for why `kind` decides what an equal comparison may be called.
 * The kind is required: a caller that does not know it cannot be handed a
 * `match`, so a missing one is a mistake to stop on, not a default to guess.
 */
export function verdictOf(fork, source, kind) {
  if (!DRILL_KINDS.includes(kind)) throw new Error("restore drill: a verdict needs the table's kind");
  if (!fork.present && !source.present) return "absent";
  if (!fork.present) return "missing-in-fork";
  if (!source.present) return "missing-in-source";
  if (!fork.stamped || !source.stamped) return "bad-stamp";
  if (fork.after > 0) return "fork-after-restore-point";
  const newest = compareStamp(fork.newest, source.newest);
  if (fork.rows < source.rows || newest < 0) return "fork-behind";
  // Equal on both sides: for append and last-write tables that is the rows
  // and what they say; for a presence-only table it is the rows alone.
  if (fork.rows === source.rows && newest === 0) return kind === "presence-only" ? CONTENT_UNVERIFIED : "match";
  // More in the fork. Never a content claim on any kind, so it keeps its name;
  // a presence-only table that reads it is still listed in contentUnverified.
  return "source-changed";
}

/**
 * THE REPORT. Counts and verdicts only: `newest` becomes equal / fork-newer /
 * fork-older and the stamps themselves are dropped here. Each table carries
 * its kind, so a reader can see what its verdict covers.
 *
 * `ok` is the drill's result. `exact` says every table present held exactly
 * the rows the source held by the cutoff — `match`, or a presence-only
 * table's `present-content-unverified` — which is what a drill taken while the
 * source is quiet (the trading hold) should show. Neither speaks for the
 * contents of a presence-only table: `contentUnverified` names every one the
 * drill compared, with the fixed reason it cannot see their contents, so the
 * gap is written into the evidence beside the pass instead of behind it. It
 * does not fail the drill; a presence-only table that fails on presence is in
 * `failed` like any other.
 *
 * `contentsVerified` is the one-word answer to "did the drill see the
 * contents": true only for a passing drill that compared no presence-only
 * table. `exact` is about rows, and a reader skimming for a green word must
 * not take it for more — so the word that is about contents is its own field,
 * and it reads false whenever `contentUnverified` is not empty.
 *
 * A drill that compared nothing — every table absent, or every source row
 * stamped after the cutoff — is not a pass, whatever the verdicts say.
 */
export function compareSides(fork, source) {
  const tables = {};
  const summary = {};
  const failed = [];
  const contentUnverified = [];
  let compared = 0;
  for (const { table, kind, why } of DRILL_TABLES) {
    const f = fork.tables[table] ?? { present: false };
    const s = source.tables[table] ?? { present: false };
    const verdict = verdictOf(f, s, kind);
    summary[verdict] = (summary[verdict] ?? 0) + 1;
    if (FAILING_VERDICTS.includes(verdict)) failed.push(table);
    const entry = { verdict, kind };
    if (f.present && s.present && f.stamped && s.stamped) {
      const newest = compareStamp(f.newest, s.newest);
      entry.fork = { rows: f.rows, total: f.total, after: f.after };
      entry.source = { rows: s.rows, total: s.total };
      entry.newest = newest === 0 ? (f.newest === null ? "none" : "equal") : newest > 0 ? "fork-newer" : "fork-older";
      compared += s.rows;
      if (kind === "presence-only") contentUnverified.push({ table, why });
    }
    tables[table] = entry;
  }
  const empty = failed.length === 0 && compared === 0;
  const ok = failed.length === 0 && !empty;
  return {
    ok,
    exact: ok && Object.values(tables).every((t) => t.verdict === "match" || t.verdict === CONTENT_UNVERIFIED || t.verdict === "absent"),
    contentsVerified: ok && contentUnverified.length === 0,
    failed,
    summary,
    contentUnverified,
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
    return { exitCode: 64, report: { ...head, ok: false, exact: false, contentsVerified: false, error: errorOf(e) } };
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
    return { exitCode: refused ? 64 : 1, report: { ...head, ...window, ok: false, exact: false, contentsVerified: false, error: errorOf(e) } };
  }
  const result = compareSides(sides.fork, sides.source);
  return { exitCode: result.ok ? 0 : 1, report: { ...head, ...window, ...result } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { exitCode, report } = await runRestoreDrill({ argv: process.argv.slice(2), env: process.env });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = exitCode;
}
