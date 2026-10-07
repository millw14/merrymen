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
 *                                     then one transaction on a second
 *                                     connection; the apply report goes to
 *                                     --output, created before the transaction
 *                                     opens so a commit always has a place to be
 *                                     reported.
 *   --revert <apply report>           take that booking back.
 *
 * WHAT CROSSES THE CONSOLE: the plan's lines (tenant, account, hashes, blocks,
 * amounts — public chain data and the classes), the digest and the refusal.
 * Never DATABASE_URL or the RPC URL: driver and network errors can carry
 * either, so anything that is not one of this tool's own refusals is printed
 * as a fixed code.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translateQuery, translateSchema, type Db } from "./db";
import type { RpcCall } from "./chain-capital";
import {
  applyBooking, BALANCE_OF_CALL, BLOCK_QUANTITY, BookingRefused, canonical, DECIMALS_SELECTOR, parseApplyReport, planBooking, planLines, readBookingSnapshot, readChainEvidence,
  revertBooking, type BookingPlan,
} from "./chain-gap-booking";

export const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const HELP = `Chain-gap booking — PREVIEW FIRST. docs/chain-gap-booking.md is the runbook.

  node --import tsx worker/src/chain-gap-booking-cli.ts --tenant 0xTENANT --output /absolute/new-preview.json [--dry-run]
  node --import tsx worker/src/chain-gap-booking-cli.ts --tenant 0xTENANT --apply --confirm <previewDigest> --backup-ref <backup id> --output /absolute/new-apply-report.json
  node --import tsx worker/src/chain-gap-booking-cli.ts --revert /absolute/apply-report.json --output /absolute/new-revert-report.json

Required environment: DATABASE_URL. Optional: MERRYMEN_CHAIN_GAP_RPC (defaults to the public Robinhood Chain mainnet RPC).
Only a held tenant is booked: its newest admission decision a chain refusal, nothing written for it since, and only what landed before it.
The preview reads Postgres read-only and the chain; it writes only its own report, created once with mode 0600.
--apply recomputes the preview and writes exactly its proposed rows in one transaction, only when the digest is the one you confirm.
--revert removes one applied booking's rows, only if each is still exactly as written and nothing stood on them since (no admission, approval or worker).
Neither DATABASE_URL nor the RPC URL is printed or saved.
`;

const TENANT = /^0x[0-9a-fA-F]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export type BookingArgs =
  | { help: true }
  | { mode: "preview"; tenant: string; output: string }
  | { mode: "apply"; tenant: string; output: string; confirm: string; backupRef: string }
  | { mode: "revert"; report: string; output: string };

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
    if (typeof revert !== "string" || !path.isAbsolute(revert) || [...seen.keys()].some((k) => k !== "--revert" && k !== "--output")) throw new CliError("invalid-arguments");
    return { mode: "revert", report: revert, output };
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

/** The slice of a node-postgres Client this tool uses. */
export interface PgClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  end(): Promise<void>;
}
/** Any of these anywhere in a statement refuses it on the read-only connection. */
const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE|CALL|DO|COPY|LOCK|VACUUM|REINDEX|SET|NOTIFY)\b/i;

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
      await client.query("BEGIN");
      try {
        const out = await fn(scoped(true));
        await client.query("COMMIT");
        return out;
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch { /* the original error wins */ }
        throw e;
      }
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

// ── the run ──────────────────────────────────────────────────────────────────

export interface CliDeps {
  connect?: (url: string, readOnly: boolean) => Promise<PgClient>;
  rpc?: RpcCall;
  nowMs?: () => number;
  out?: (line: string) => void;
  /** The code fingerprint; tests pass a fixed one. */
  source?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
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

  if (options.mode === "revert") {
    let text: string;
    try { text = readFileSync(options.report, "utf8"); } catch { throw new CliError("report-unreadable"); }
    const report = parseApplyReport(text);
    const fd = createReportFile(options.output);
    const client = await full.connect(env.DATABASE_URL, false);
    try {
      const r = await revertBooking(pgClientDb(client, { readOnly: false }), report, { nowMs: full.nowMs(), dialect: "postgres" });
      finishReportFile(fd, options.output, r);
      out(`${r.outcome === "reverted" ? "REVERTED" : "ALREADY REVERTED"} booking ${r.bookingId} — tenant ${r.tenant}: ${r.rows.length} row(s); report ${options.output}`);
      return 0;
    } catch (e) {
      closeSync(fd); rmSync(options.output, { force: true });
      throw e;
    } finally { await client.end().catch(() => {}); }
  }

  if (options.mode === "preview") {
    const plan = await computePlan(options.tenant, env, full);
    const fd = createReportFile(options.output);
    finishReportFile(fd, options.output, { ...plan, mode: "preview", writesPerformed: 0 });
    for (const line of planLines(plan)) out(line);
    out(`PREVIEW ONLY — 0 database writes. The plan is in ${options.output}.`);
    return plan.verdict === "blocked" ? 2 : 0;
  }

  // APPLY: the report file first, so a commit always has somewhere to be said.
  const fd = createReportFile(options.output);
  let committed = false;
  try {
    const plan = await computePlan(options.tenant, env, full);
    for (const line of planLines(plan)) out(line);
    if (plan.verdict === "nothing-missing") throw new BookingRefused("nothing-missing", "admission's chain check finds nothing Postgres lacks for this tenant: nothing to book (already applied?)");
    const client = await full.connect(env.DATABASE_URL, false);
    try {
      const report = await applyBooking(pgClientDb(client, { readOnly: false }), plan, {
        confirm: options.confirm, backupRef: options.backupRef, dialect: "postgres", nowMs: full.nowMs(),
      });
      committed = true;
      finishReportFile(fd, options.output, report);
      out(`APPLIED booking ${report.bookingId} — ${report.rows.length} row(s) for tenant ${report.tenant} under backup ${report.backupRef}; ` +
        `the apply report (what --revert takes) is ${options.output}. Preview the tenant again with MERRYMEN_RESUME_PREVIEW before approving it.`);
      return 0;
    } finally { await client.end().catch(() => {}); }
  } catch (e) {
    if (!committed) { try { closeSync(fd); } catch { /* already closed */ } rmSync(options.output, { force: true }); }
    else throw new CliError("applied-but-report-not-written");
    throw e;
  }
}

/** What the console may say about a failure: this tool's own refusal sentence, or a fixed code. */
export function failureLine(e: unknown): string {
  if (e instanceof BookingRefused) return `refused (${e.code}): ${e.message}`;
  if (e instanceof CliError) return `${e.code}. Use --help for invocation.`;
  return "booking-failed: nothing was applied unless an APPLIED line was printed. Use --help for invocation.";
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
