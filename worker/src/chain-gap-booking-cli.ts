/**
 * THE OPERATOR'S ENTRY POINT FOR chain-gap-booking.ts. Reviewed operator tool:
 * never imported by the orchestrator or a worker. docs/chain-gap-booking.md
 * is the runbook; this file is only the shell around the core.
 *
 *   preview (the default, --dry-run)  read Postgres in one REPEATABLE READ READ
 *                                     ONLY snapshot on a connection opened read
 *                                     only, close it, read the chain, write the
 *                                     plan to --output (created once, 0600).
 *   --apply                           recompute the same preview, require
 *                                     --confirm <its digest> and --backup-ref,
 *                                     then ONE SERIALIZABLE transaction on a
 *                                     second connection. --output is created
 *                                     before anything is read, the booking id
 *                                     is printed, and the apply report is
 *                                     written and fsynced to it INSIDE the
 *                                     transaction, before the COMMIT is sent
 *                                     (commitOutcome "unknown"), then replaced
 *                                     whole by the same report saying
 *                                     "committed" once the COMMIT is answered.
 *   --revert <apply report>           take that booking back (SERIALIZABLE too).
 *   --revert <apply report> --dry-run read only: did that apply commit, and does
 *                                     it stand? Its receipts, against the report.
 *
 * A COMMIT WHOSE ANSWER NEVER CAME is not "nothing happened": only a SQLSTATE
 * that proves a rollback (commitRolledBack) removes the report. Anything else
 * — a dropped connection, a terminated backend, a timeout — keeps it, says
 * OUTCOME UNKNOWN, and prints the two commands that settle it. The report
 * names its database (target), and both refuse any other. It also names the
 * apply's own transaction and server (xact), read inside the transaction
 * before the COMMIT: no receipt is NOT COMMITTED only when the server says
 * that transaction aborted, and STILL UNKNOWN otherwise (still open, committed
 * after the check's snapshot, another server), never "nothing happened".
 *
 * WHAT CROSSES THE CONSOLE: the plan's lines (tenant, account, hashes, blocks,
 * amounts — public chain data and the classes), the digest and the refusal.
 * Never DATABASE_URL or the RPC URL: driver and network errors can carry
 * either, so anything that is not one of this tool's own refusals is printed
 * as a fixed code.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translateQuery, translateSchema, type Db } from "./db";
import type { RpcCall } from "./chain-capital";
import {
  applyBooking, BALANCE_OF_CALL, BLOCK_QUANTITY, BookingRefused, canonical, DECIMALS_SELECTOR, parseApplyReport, planBooking, planLines, readBookingReceipts, readBookingSnapshot,
  readChainEvidence, revertBooking, stampCommitOutcome, type ApplyReport, type BookingPlan, type BookingReceipts, type RevertReport,
} from "./chain-gap-booking";

export const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const HELP = `Chain-gap booking — PREVIEW FIRST. docs/chain-gap-booking.md is the runbook.

  node --import tsx worker/src/chain-gap-booking-cli.ts --tenant 0xTENANT --output /absolute/new-preview.json [--dry-run]
  node --import tsx worker/src/chain-gap-booking-cli.ts --tenant 0xTENANT --apply --confirm <previewDigest> --backup-ref <backup id> --output /absolute/new-apply-report.json
  node --import tsx worker/src/chain-gap-booking-cli.ts --revert /absolute/apply-report.json --output /absolute/new-revert-report.json
  node --import tsx worker/src/chain-gap-booking-cli.ts --revert /absolute/apply-report.json --dry-run --output /absolute/new-receipts-report.json

Required environment: DATABASE_URL. Optional: MERRYMEN_CHAIN_GAP_RPC (defaults to the public Robinhood Chain mainnet RPC).
Only a held tenant is booked: its newest admission decision a chain refusal, nothing written for it since, and only what landed before it.
The preview reads Postgres read-only and the chain; it writes only its own report, created once with mode 0600.
--apply recomputes the preview and writes exactly its proposed rows in one SERIALIZABLE transaction, only when the digest is the one you confirm.
Its report is written before the COMMIT; if the COMMIT's answer is lost, the report is kept and the tool says OUTCOME UNKNOWN.
--revert removes one applied booking's rows, only if each is still exactly as written and nothing stood on them since (no admission, approval or worker).
--revert with --dry-run only reads: whether its apply committed (its receipts, or the server's word on its transaction), and whether its rows stand.
Neither DATABASE_URL nor the RPC URL is printed or saved.
`;

const TENANT = /^0x[0-9a-fA-F]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export type BookingArgs =
  | { help: true }
  | { mode: "preview"; tenant: string; output: string }
  | { mode: "apply"; tenant: string; output: string; confirm: string; backupRef: string }
  | { mode: "revert"; report: string; output: string }
  | { mode: "receipts"; report: string; output: string };

/** Fixed codes only: an argument's text is never echoed back. */
export function parseBookingArgs(args: readonly string[]): BookingArgs {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const seen = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) throw new CliError("invalid-arguments");
    if (flag === "--dry-run" || flag === "--apply") { seen.set(flag, true); continue; }
    const value = args[++i];
    if (!["--tenant", "--output", "--confirm", "--backup-ref", "--revert"].includes(flag) || value === undefined || value.startsWith("--")) throw new CliError("invalid-arguments");
    seen.set(flag, value);
  }
  const output = seen.get("--output");
  if (typeof output !== "string" || !path.isAbsolute(output)) throw new CliError("invalid-arguments");
  const revert = seen.get("--revert");
  if (revert !== undefined) {
    if (typeof revert !== "string" || !path.isAbsolute(revert) || [...seen.keys()].some((k) => k !== "--revert" && k !== "--output" && k !== "--dry-run")) {
      throw new CliError("invalid-arguments");
    }
    // With --dry-run, only read the booking's receipts: whether its apply committed, and whether it stands.
    return seen.has("--dry-run") ? { mode: "receipts", report: revert, output } : { mode: "revert", report: revert, output };
  }
  const tenant = seen.get("--tenant");
  if (typeof tenant !== "string" || !TENANT.test(tenant)) throw new CliError("invalid-arguments");
  if (seen.has("--apply")) {
    const confirm = seen.get("--confirm"), backupRef = seen.get("--backup-ref");
    if (seen.has("--dry-run") || typeof confirm !== "string" || !DIGEST.test(confirm) || typeof backupRef !== "string") throw new CliError("invalid-arguments");
    return { mode: "apply", tenant: tenant.toLowerCase(), output, confirm, backupRef };
  }
  // A confirmation or a backup named without --apply is refused, so nobody
  // reads a dry run's output believing they applied something.
  if (seen.has("--confirm") || seen.has("--backup-ref")) throw new CliError("invalid-arguments");
  return { mode: "preview", tenant: tenant.toLowerCase(), output };
}

/** One of this shell's own fixed codes. */
export class CliError extends Error {
  constructor(readonly code: string) { super(code); this.name = "CliError"; }
}

// ── the chain transport ──────────────────────────────────────────────────────

const RPC_METHODS = ["eth_chainId", "eth_blockNumber", "eth_getLogs", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_call"];

/**
 * THE ONLY WAY THIS TOOL TALKS TO A NODE: a fixed list of reads, refused
 * before anything leaves the process otherwise. `eth_call` is admitted for two
 * view calls only, with no `from`, value or gas: `decimals()` with no
 * arguments, at "latest"; and `balanceOf(address)` with exactly one
 * zero-padded address, at a block number and never a tag — the pinned block
 * the holding is judged at (chain-gap-booking.ts readChainEvidence). A node's
 * error text is kept on the error so the adaptive log reader can tell a rate
 * limit from a range it should narrow (rpc-error.ts), and never printed.
 */
export function createBookingRpc(url: string, fetchImpl: typeof fetch = fetch): RpcCall {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new CliError("unsupported-rpc-url"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new CliError("unsupported-rpc-url");
  let id = 0;
  return async (method, params) => {
    if (!RPC_METHODS.includes(method)) throw new CliError("rpc-method-outside-read-allowlist");
    if (method === "eth_call") {
      const [call, tag, ...rest] = params as [Record<string, unknown> | undefined, unknown];
      const decimals = call?.data === DECIMALS_SELECTOR && tag === "latest";
      const balance = typeof call?.data === "string" && BALANCE_OF_CALL.test(call.data) && typeof tag === "string" && BLOCK_QUANTITY.test(tag);
      if (rest.length || !call || Object.keys(call).sort().join(",") !== "data,to" || !(decimals || balance)
        || typeof call.to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(call.to)) throw new CliError("rpc-call-outside-read-allowlist");
    }
    const requestId = ++id;
    const response = await fetchImpl(url, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
    });
    if (response.status === 429) throw Object.assign(new Error("rpc rate limit (429) Too Many Requests"), { status: 429 });
    if (!response.ok) throw Object.assign(new Error(`rpc unavailable (HTTP ${response.status})`), { status: response.status });
    const body = (await response.json()) as { jsonrpc?: string; id?: number; result?: unknown; error?: { message?: unknown; code?: unknown } };
    if (body.error) throw Object.assign(new Error(String(body.error.message ?? "rpc error").slice(0, 300)), { code: body.error.code });
    if (body.jsonrpc !== "2.0" || body.id !== requestId || !Object.hasOwn(body, "result")) throw new Error("rpc-read-failed");
    return body.result;
  };
}

// ── Postgres, one connection at a time ───────────────────────────────────────

/** The slice of a node-postgres Client this tool uses. `command` is the statement's tag as the server answered it (COMMIT's is "ROLLBACK" when it rolled back). */
export interface PgClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null; command?: string }>;
  end(): Promise<void>;
}
/** Any of these anywhere in a statement refuses it on the read-only connection. */
const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO|COPY|LOCK|VACUUM|REINDEX|SET|NOTIFY)\b/i;

/** The COMMIT was sent and no answer proved it rolled back: whether it took effect is for the receipts to say. */
export class CommitOutcomeUnknown extends Error {
  constructor() { super("commit-outcome-unknown"); this.name = "CommitOutcomeUnknown"; }
}

/**
 * THE ERRORS AN ANSWER TO COMMIT CAN CARRY THAT PROVE NOTHING WAS COMMITTED:
 * a SQLSTATE the server raised while committing, before the commit record,
 * having rolled the transaction back.
 *
 *   class 40, transaction rollback: 40001 serialization_failure (what a
 *   SERIALIZABLE commit refuses with), 40P01 deadlock_detected, 40002
 *   transaction_integrity_constraint_violation. NOT 40003
 *   statement_completion_unknown, which says just that it does not know.
 *   class 23, integrity constraint violation: a deferred constraint, checked
 *   at commit.
 *
 * Nothing else proves it. A connection dropped or reset (EPIPE, ECONNRESET,
 * ETIMEDOUT, or no code at all), a backend terminated or a server shutting
 * down or starting (57P01, 57P02, 57P03), a connection exception (class 08,
 * 08007 transaction_resolution_unknown among them), a cancelled or timed-out
 * statement (57014), a resource or internal error (class 53, XX000): each can
 * arrive after the commit record was made durable, and is
 * CommitOutcomeUnknown. Only a code in SQLSTATE's own shape and class counts,
 * so a driver's errno code (EPIPE is five capitals too) never does.
 */
export function commitRolledBack(e: unknown): boolean {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && /^(?:40(?!003)[0-9A-Z]{3}|23[0-9A-Z]{3})$/.test(code);
}

/**
 * Class 40 but 40003, from a statement of the transaction or its COMMIT: the
 * server rolled it back for a conflict with another transaction (a
 * serialization failure, a deadlock). Nothing was written, and the same
 * command can simply run again.
 */
export function conflictRolledBack(e: unknown): boolean {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" && /^40(?!003)[0-9A-Z]{3}$/.test(code);
}
function conflictRefusal(e: unknown, what: "apply" | "revert"): BookingRefused {
  const code = String((e as { code: string }).code);
  const kind = code === "40001" ? ", a serialization failure" : code === "40P01" ? ", a deadlock" : "";
  return new BookingRefused("conflict", `Postgres rolled the ${what} back for a conflict with another transaction (SQLSTATE ${code}${kind}): nothing was written — ` +
    `run the same command again, with a new --output${what === "apply" ? "; if the books moved meanwhile it refuses confirm-mismatch, and you preview again" : ""}`);
}

/**
 * The core's Db over ONE node-postgres connection, in the store's dialect
 * (`?` placeholders, translated as db.ts translates them).
 *
 * READ ONLY is three walls, any one of which refuses a write: the connection
 * is opened with default_transaction_read_only (connectBooking); every
 * statement must be a SELECT or WITH with no write word anywhere in it; and
 * the transaction is REPEATABLE READ READ ONLY, proved by asking the server,
 * and always rolled back. So the snapshot is one consistent read and ends
 * before any chain read starts.
 *
 * THE WRITE TRANSACTION (apply, revert) is BEGIN ISOLATION LEVEL
 * SERIALIZABLE, proved by asking the server before anything else runs. So
 * every compare-and-set read is one snapshot, taken before the agent row is
 * locked, rather than statements that each see whatever committed last; a
 * write to that agent row after the snapshot fails the lock with 40001; and a
 * conflict with another SERIALIZABLE transaction fails it or the COMMIT with
 * 40001. Any of them rolls back, writing nothing (conflictRolledBack). It
 * does not see a READ COMMITTED writer (the orchestrator's) commit between the
 * snapshot and the COMMIT: Postgres tracks only serializable transactions'
 * reads, and the lock on agents that would close that would stall every
 * worker's heartbeat behind an operator's transaction.
 *
 * A COMMIT refused with a SQLSTATE that proves a rollback (commitRolledBack)
 * is rethrown as itself, and one the server answered with ROLLBACK's tag (a
 * transaction that had already failed) is "commit-answered-rollback"; any
 * other failure of the COMMIT is CommitOutcomeUnknown, which the shell never
 * reads as "nothing happened".
 */
export function pgClientDb(client: PgClient, o: { readOnly: boolean }): Db {
  const coerce = (ps: unknown[]) => ps.map((p) => (typeof p === "bigint" ? p.toString() : p === undefined ? null : p));
  const scoped = (inTx: boolean): Db => ({
    prepare(sql) {
      if (o.readOnly && (!/^\s*(SELECT|WITH)\b/i.test(sql) || WRITE_WORDS.test(sql))) throw new CliError("non-read-query-refused");
      const text = translateQuery(sql);
      return {
        async run(...ps) { const r = await client.query(text, coerce(ps)); return { changes: r.rowCount ?? 0, lastInsertRowid: 0 }; },
        async get(...ps) { return (await client.query(text, coerce(ps))).rows[0]; },
        async all(...ps) { return (await client.query(text, coerce(ps))).rows; },
      };
    },
    async exec(sql) {
      if (o.readOnly) throw new CliError("non-read-query-refused");
      await client.query(translateSchema(sql));
    },
    async tx(fn) {
      if (inTx) throw new Error("nested transactions are not supported");
      if (o.readOnly) {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          const s = (await client.query("SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso")).rows[0];
          if (s?.ro !== "on" || s?.iso !== "repeatable read") throw new CliError("read-only-snapshot-not-established");
          return await fn(scoped(true));
        } finally {
          await client.query("ROLLBACK");
        }
      }
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      let out: Awaited<ReturnType<typeof fn>>;
      try {
        const s = (await client.query("SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso")).rows[0];
        if (s?.ro !== "off" || s?.iso !== "serializable") throw new CliError("serializable-not-established");
        out = await fn(scoped(true));
      } catch (e) {
        // The COMMIT was never sent: whatever failed, nothing committed.
        try { await client.query("ROLLBACK"); } catch { /* the original error wins */ }
        throw e;
      }
      let answer: Awaited<ReturnType<PgClient["query"]>>;
      try {
        answer = await client.query("COMMIT");
      } catch (e) {
        if (commitRolledBack(e)) throw e;
        throw new CommitOutcomeUnknown();
      }
      if (answer.command !== undefined && answer.command !== "COMMIT") throw new CliError("commit-answered-rollback");
      return out;
    },
  });
  return scoped(false);
}

/** Which database, without the user, password, query or URL entering the plan: what the confirmed digest binds to. */
export function targetDigest(databaseUrl: string): string {
  let url: URL;
  try { url = new URL(databaseUrl); } catch { throw new CliError("invalid-database-url"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new CliError("invalid-database-url");
  return createHash("sha256").update(canonical({ protocol: url.protocol, hostname: url.hostname, port: url.port || "5432", database: url.pathname })).digest("hex");
}

/** The code that produced a preview, by file digest: an apply by different code recomputes a different digest and refuses. */
export function sourceFingerprint(here = path.dirname(fileURLToPath(import.meta.url))): Record<string, string> {
  const files = ["chain-gap-booking.ts", "chain-gap-booking-cli.ts", "ledger-resume.ts", "asset-movements.ts", "basis.ts", "basis-seed.ts", "chain-capital.ts", "fills.ts",
    "inflight-reconcile.ts", "custody.ts", "distinct-flows.ts", "paper-boundary.ts", "token-label.ts", "../../packages/core/src/capital-classify.ts",
    "../../packages/core/src/grant.ts", "../../packages/core/src/trencher-vault.ts"];
  return Object.fromEntries(files.map((f) => [f, createHash("sha256").update(readFileSync(path.resolve(here, f))).digest("hex")]));
}

/**
 * The default connection: node-postgres, imported at run time (it is a
 * runtime-only dependency here, as for db.ts), BIGINT read as a number as the
 * store reads it, and a statement and lock timeout so a held lock cannot hang
 * an operator's terminal. Read-only connections are opened read-only.
 *
 * `loadPg` is the opt-in Postgres test's seam: it loads the same driver from
 * where that test finds it. Nothing else passes it.
 */
export async function connectBooking(url: string, readOnly: boolean, loadPg: () => Promise<unknown> = () => import(/* webpackIgnore: true */ "pg" as string)): Promise<PgClient> {
  let pg: { Client: new (c: { connectionString: string; options?: string; application_name?: string; connectionTimeoutMillis?: number }) => PgClient & { connect(): Promise<void> };
    types: { setTypeParser(oid: number, fn: (v: string) => unknown): void } };
  try {
    const mod = (await loadPg()) as { default?: unknown };
    pg = (mod.default ?? mod) as typeof pg;
    if (typeof pg?.Client !== "function") throw new Error("no driver");
  } catch { throw new CliError("postgres-driver-unavailable"); }
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  const client = new pg.Client({
    connectionString: url, connectionTimeoutMillis: 10_000, application_name: readOnly ? "merrymen-chain-gap-preview-readonly" : "merrymen-chain-gap-apply",
    options: `-c statement_timeout=30000 -c lock_timeout=5000${readOnly ? " -c default_transaction_read_only=on" : ""}`,
  });
  await client.connect();
  return client;
}

// ── report files ─────────────────────────────────────────────────────────────

/**
 * A report file, CREATED ONCE: an absolute path in an existing, real
 * directory, never an existing file or a link, mode 0600 whatever the umask.
 * Returned open, so apply can hold it across its transaction.
 */
export function createReportFile(file: string): number {
  const dir = path.dirname(file);
  try {
    if (!path.isAbsolute(file) || path.resolve(file) !== file || realpathSync(dir) !== dir || !lstatSync(dir).isDirectory()) throw new Error("unsafe");
  } catch { throw new CliError("report-path-unsafe"); }
  let fd: number;
  try { fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch { throw new CliError("report-exists-or-unsafe"); }
  fchmodSync(fd, 0o600);
  return fd;
}
export function finishReportFile(fd: number, file: string, value: unknown): void {
  try {
    const data = Buffer.from(`${JSON.stringify(JSON.parse(canonical(value)), null, 2)}\n`);
    let n = 0;
    while (n < data.length) n += writeSync(fd, data, n, data.length - n);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  const dir = openSync(path.dirname(file), constants.O_RDONLY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
/**
 * A report this run already wrote, REPLACED WHOLE: the new one written and
 * fsynced to a file beside it (created once, 0600, as any report), renamed
 * over it, the directory fsynced. At every moment the path holds one whole
 * report, the old or the new, never one cut short.
 */
export function replaceReportFile(file: string, value: unknown): void {
  const next = `${file}.committed.tmp`;
  const fd = createReportFile(next);
  try {
    finishReportFile(fd, next, value);
    renameSync(next, file);
  } catch (e) {
    rmSync(next, { force: true });
    throw e;
  }
  const dir = openSync(path.dirname(file), constants.O_RDONLY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

// ── the run ──────────────────────────────────────────────────────────────────

export interface CliDeps {
  connect?: (url: string, readOnly: boolean) => Promise<PgClient>;
  rpc?: RpcCall;
  nowMs?: () => number;
  out?: (line: string) => void;
  /** The code fingerprint; tests pass a fixed one. */
  source?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  /** The apply's booking id; tests pass a fixed one. */
  bookingId?: () => string;
}

const SELF = "node --import tsx worker/src/chain-gap-booking-cli.ts";
/** How to see whether an apply committed, read only, and how to take it back: what an unanswered COMMIT leaves an operator to run. */
function recoveryLines(report: string): string[] {
  return [
    `  1. Did it commit? Read only: ${SELF} --revert ${report} --dry-run --output /absolute/new-receipts-report.json`,
    "     COMMITTED (receipts 'applied', every row as booked): its rows stand; go on to step 5 of docs/chain-gap-booking.md, or take it back with 2.",
    "     NOT COMMITTED (no receipt, and the server says its transaction ended without committing): nothing was written; preview the tenant again.",
    "     STILL UNKNOWN (no receipt yet, and no such word from the server): keep the report and run 1 again; it settles once the server ends that transaction.",
    `  2. Take it back: ${SELF} --revert ${report} --output /absolute/new-revert-report.json`,
  ];
}
/**
 * The report names the database it was applied to by its URL (host, port and name): a look at the receipts or a revert anywhere else
 * would find no receipt, so it is refused before it connects. That binds the spelling, not the server; the server is bound by the
 * report's xact (its system identifier), which decides whether "no receipt" can ever be NOT COMMITTED. A report of an earlier build names
 * neither, and its revert is decided by the receipts alone.
 */
function sameDatabase(report: ApplyReport, databaseUrl: string): void {
  if (report.target !== undefined && report.target !== targetDigest(databaseUrl)) {
    throw new BookingRefused("target", "the apply report was applied to another database (by host, port and name) than DATABASE_URL names: " +
      "nothing was read or written — point DATABASE_URL at the database it was applied to");
  }
}
/** A report file that does not parse, given to the receipts check: an apply that died before its report was whole never sent its COMMIT. */
function unfinishedReport(): BookingRefused {
  return new BookingRefused("report-unfinished", "the apply report is empty or cut short. If it is the --output of an apply that died, that apply never sent its COMMIT " +
    "(the report is written in full and fsynced before the COMMIT is sent), so nothing was written: preview the tenant again");
}
function receiptsLine(v: BookingReceipts, report: string, output: string): string {
  const n = `${v.receipts.length} receipt(s)`, said = `0 database writes; report ${output}`;
  switch (v.verdict) {
    case "applied": return `COMMITTED booking ${v.bookingId} — tenant ${v.tenant}: ${n} 'applied', and each of its ${v.rows.length} row(s) exactly as booked: its rows stand. ` +
      `Go on to step 5 of docs/chain-gap-booking.md, or take it back with ${SELF} --revert ${report} --output /absolute/new-revert-report.json. ${said}`;
    case "diverged": return `COMMITTED, BUT ITS ROWS DIVERGED booking ${v.bookingId} — tenant ${v.tenant}: ${v.why}. They do not stand as booked, and a --revert ` +
      `refuses: escalate. ${said}`;
    case "reverted": return `COMMITTED, THEN REVERTED booking ${v.bookingId} — tenant ${v.tenant}: ${n} 'reverted', nothing of it stands. ${said}`;
    case "not-committed": return `NOT COMMITTED booking ${v.bookingId} — tenant ${v.tenant}: ${v.why}; preview the tenant again. ${said}`;
    case "unknown": return `STILL UNKNOWN booking ${v.bookingId} — tenant ${v.tenant}: ${v.why}. Keep ${report}: if it committed, it is what --revert takes. ` +
      `Run this check again in a minute. ${said}`;
    default: return `booking ${v.bookingId} — tenant ${v.tenant}: ${n} in more than one state, which one revert never leaves: escalate. ${said}`;
  }
}

/** The preview, exactly as both modes compute it: one read-only snapshot, then the chain, then the plan. */
async function computePlan(tenant: string, env: NodeJS.ProcessEnv, deps: Required<Pick<CliDeps, "connect" | "rpc" | "nowMs">> & CliDeps): Promise<BookingPlan> {
  const url = env.DATABASE_URL!;
  const nowSec = Math.floor(deps.nowMs() / 1000);
  const client = await deps.connect(url, true);
  let snap;
  try {
    snap = await pgClientDb(client, { readOnly: true }).tx((db) => readBookingSnapshot(db, { tenant, dialect: "postgres", nowSec }));
  } finally {
    // Closed before the chain is read: no session stays open across the slow public reads.
    await client.end().catch(() => {});
  }
  const ev = await readChainEvidence(deps.rpc, snap, deps.sleep ? { sleep: deps.sleep } : {});
  return planBooking(snap, ev, { nowSec, source: deps.source ?? sourceFingerprint(), target: targetDigest(url) });
}

export async function main(args: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const options = parseBookingArgs(args);
  if ("help" in options) { out(HELP); return 0; }
  if (!env.DATABASE_URL) throw new CliError("database-url-required");
  targetDigest(env.DATABASE_URL);
  const full = {
    ...deps, connect: deps.connect ?? connectBooking, nowMs: deps.nowMs ?? (() => Date.now()),
    rpc: deps.rpc ?? createBookingRpc(env.MERRYMEN_CHAIN_GAP_RPC || DEFAULT_RPC),
  };

  if (options.mode === "receipts") {
    // DID THAT APPLY COMMIT? Its receipts, on a read-only connection in one read-only snapshot, against the report. Writes nothing to the database.
    let text: string;
    try { text = readFileSync(options.report, "utf8"); } catch { throw new CliError("report-unreadable"); }
    try { JSON.parse(text); } catch { throw unfinishedReport(); }
    const report = parseApplyReport(text);
    sameDatabase(report, env.DATABASE_URL);
    const client = await full.connect(env.DATABASE_URL, true);
    let view: BookingReceipts;
    try {
      view = await pgClientDb(client, { readOnly: true }).tx((db) => readBookingReceipts(db, report, { dialect: "postgres" }));
    } finally { await client.end().catch(() => {}); }
    const fd = createReportFile(options.output);
    finishReportFile(fd, options.output, view);
    out(receiptsLine(view, options.report, options.output));
    // Settled and standing as the receipts say: 0. Still unknown, diverged, or partly reverted: 2, so nothing scripted reads it as settled.
    return view.verdict === "applied" || view.verdict === "reverted" || view.verdict === "not-committed" ? 0 : 2;
  }

  if (options.mode === "revert") {
    let text: string;
    try { text = readFileSync(options.report, "utf8"); } catch { throw new CliError("report-unreadable"); }
    const report = parseApplyReport(text);
    sameDatabase(report, env.DATABASE_URL);
    const fd = createReportFile(options.output);
    let r: RevertReport;
    try {
      const client = await full.connect(env.DATABASE_URL, false);
      try {
        r = await revertBooking(pgClientDb(client, { readOnly: false }), report, { nowMs: full.nowMs(), dialect: "postgres" });
      } finally { await client.end().catch(() => {}); }
    } catch (e) {
      closeSync(fd); rmSync(options.output, { force: true });
      if (e instanceof CommitOutcomeUnknown) {
        // A revert is safe to run again: one that committed answers ALREADY REVERTED and changes nothing.
        out(`OUTCOME UNKNOWN for the revert of booking ${report.bookingId}: its COMMIT was sent and no answer proved it rolled back. ` +
          `Run the same --revert again with a new --output: it reverts, or says ALREADY REVERTED if this one committed. To only look: ` +
          `${SELF} --revert ${options.report} --dry-run --output /absolute/new-receipts-report.json`);
        throw new CliError("revert-outcome-unknown");
      }
      if (conflictRolledBack(e)) throw conflictRefusal(e, "revert");
      throw e;
    }
    // Committed: the revert stands whatever happens to its report now.
    try { finishReportFile(fd, options.output, r); }
    catch {
      rmSync(options.output, { force: true });
      out(`${r.outcome === "reverted" ? "REVERTED" : "ALREADY REVERTED"} booking ${r.bookingId}, but its report could not be written to ${options.output}: ` +
        "run the same --revert again for one (it says ALREADY REVERTED)");
      throw new CliError("reverted-but-report-not-written");
    }
    out(`${r.outcome === "reverted" ? "REVERTED" : "ALREADY REVERTED"} booking ${r.bookingId} — tenant ${r.tenant}: ${r.rows.length} row(s); report ${options.output}`);
    return 0;
  }

  if (options.mode === "preview") {
    const plan = await computePlan(options.tenant, env, full);
    const fd = createReportFile(options.output);
    finishReportFile(fd, options.output, { ...plan, mode: "preview", writesPerformed: 0 });
    for (const line of planLines(plan)) out(line);
    out(`PREVIEW ONLY — 0 database writes. The plan is in ${options.output}.`);
    return plan.verdict === "blocked" ? 2 : 0;
  }

  // APPLY: the report file first, and the booking id said before anything is read or written.
  const fd = createReportFile(options.output);
  let open = true;
  const close = () => { if (open) { open = false; closeSync(fd); } };
  const bookingId = full.bookingId?.() ?? randomUUID();
  out(`booking ${bookingId}: its apply report is written to ${options.output} before the COMMIT is sent. ` +
    `If this process dies, see whether it committed with ${SELF} --revert ${options.output} --dry-run --output /absolute/new-receipts-report.json`);
  let report: ApplyReport;
  // What persist wrote (assigned inside the transaction, so typed by assertion: the compiler does not follow the callback).
  let persisted = undefined as ApplyReport | undefined;
  try {
    const plan = await computePlan(options.tenant, env, full);
    for (const line of planLines(plan)) out(line);
    if (plan.verdict === "nothing-missing") throw new BookingRefused("nothing-missing", "admission's chain check finds nothing Postgres lacks for this tenant: nothing to book (already applied?)");
    const client = await full.connect(env.DATABASE_URL, false);
    try {
      report = await applyBooking(pgClientDb(client, { readOnly: false }), plan, {
        confirm: options.confirm, backupRef: options.backupRef, dialect: "postgres", nowMs: full.nowMs(), bookingId,
        // Inside the transaction, every receipt written, the COMMIT not yet sent: the whole report, fsynced, saying its outcome is unknown.
        persist: (r) => { open = false; persisted = r; finishReportFile(fd, options.output, stampCommitOutcome(r, "unknown")); },
      });
    } finally { await client.end().catch(() => {}); }
  } catch (e) {
    if (e instanceof CommitOutcomeUnknown) {
      // The COMMIT may have taken effect: the report stays, saying "unknown", and the receipts (or the server's word on its transaction) settle it.
      close();
      const xact = persisted?.xact ? ` Its transaction is ${persisted.xact.id}.` : "";
      out(`OUTCOME UNKNOWN for booking ${bookingId}: the COMMIT was sent and no answer proved it rolled back, so it may have committed. ` +
        `${options.output} holds its apply report, written and fsynced before the COMMIT, with commitOutcome "unknown": keep it, both commands below take it.${xact}`);
      for (const line of recoveryLines(options.output)) out(line);
      throw new CliError("apply-outcome-unknown");
    }
    // Nothing committed: the COMMIT was never sent, or its answer proved a rollback. The report describes nothing.
    close();
    rmSync(options.output, { force: true });
    if (conflictRolledBack(e)) throw conflictRefusal(e, "apply");
    throw e;
  }
  // COMMITTED, and the COMMIT acknowledged: nothing below removes the report, it only says so.
  let finalized = true;
  try { replaceReportFile(options.output, stampCommitOutcome(report, "committed")); } catch { finalized = false; }
  out(`APPLIED booking ${report.bookingId} — ${report.rows.length} row(s) for tenant ${report.tenant} under backup ${report.backupRef}; ` +
    `the apply report (what --revert takes) is ${options.output}. Preview the tenant again with MERRYMEN_RESUME_PREVIEW before approving it.`);
  if (!finalized) {
    out(`  ${options.output} is still the report written before the COMMIT (commitOutcome "unknown"), and could not be marked "committed": ` +
      "the COMMIT was acknowledged, the receipts hold it, and it is still what --revert takes.");
    throw new CliError("applied-report-not-marked-committed");
  }
  return 0;
}

/** What the console may say about a failure: this tool's own refusal sentence, or a fixed code. */
export function failureLine(e: unknown): string {
  if (e instanceof BookingRefused) return `refused (${e.code}): ${e.message}`;
  if (e instanceof CliError) return `${e.code}. Use --help for invocation.`;
  return "booking-failed: nothing was applied unless an APPLIED or an OUTCOME UNKNOWN line was printed. Use --help for invocation.";
}

function invokedDirectly(): boolean {
  try { return !!process.argv[1] && realpathSync(path.resolve(process.argv[1])) === fileURLToPath(import.meta.url); }
  catch { return false; }
}
if (invokedDirectly()) {
  main().then((code) => { process.exitCode = code; }, (e: unknown) => {
    process.stderr.write(`${failureLine(e)}\n`);
    process.exitCode = 1;
  });
}
