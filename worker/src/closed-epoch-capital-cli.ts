/**
 * THE OPERATOR'S ENTRY POINT FOR closed-epoch-capital.ts. Reviewed operator
 * tool: never imported by the orchestrator or a worker.
 * docs/closed-epoch-capital.md is the runbook; this file is only the shell.
 *
 *   preview (the default, --dry-run)  read Postgres in one REPEATABLE READ READ
 *                                     ONLY snapshot on a connection opened read
 *                                     only, close it, read the chain, write the
 *                                     plan to --output (created once, 0600).
 *   --apply                           recompute the same preview, require
 *                                     --confirm <its digest> and --backup-ref,
 *                                     then ONE SERIALIZABLE transaction on a
 *                                     second connection. The repair id is
 *                                     printed before anything is read; the apply
 *                                     report, naming its database (target) and
 *                                     its own transaction (xact), is written and
 *                                     fsynced to --output INSIDE the transaction,
 *                                     before the COMMIT is sent, so a commit is
 *                                     never without its report.
 *   --revert <apply report>           take that repair back, the report checked
 *                                     against the receipts.
 *   --revert <apply report> --dry-run read only: did that apply commit, and does
 *                                     what it wrote stand? Its receipts, against
 *                                     the report, or the server's word on its
 *                                     transaction when there is none.
 *   --revert-repair <repair id>       take it back from the receipts alone (a
 *                                     lost report); with --dry-run, only read
 *                                     them. Without the report nothing names the
 *                                     apply's transaction, so no receipt there is
 *                                     STILL UNKNOWN, never "nothing was applied".
 *
 * A COMMIT WHOSE ANSWER NEVER CAME is not "nothing happened": only an answer
 * that proves a rollback removes the report. Anything else keeps it, says
 * OUTCOME UNKNOWN, and prints the two commands that settle it. No receipt is
 * NOT COMMITTED only when the server says the report's transaction aborted,
 * and STILL UNKNOWN otherwise (still open or committing, committed after the
 * check's snapshot, another server): the booking tool's rule (#297), read by
 * its own helpers (xactStatusOf, commitEvidence, noReceiptRefusal).
 *
 * Its pieces are chain-gap-booking-cli.ts's, imported unchanged where they
 * fit: the read-only Postgres wall and the SERIALIZABLE write connection
 * (pgClientDb), which reads a COMMIT's answer by the booking tool's own rule
 * (only an answer that proves a rollback says nothing was written, anything
 * else is CommitOutcomeUnknown, and a conflict rollback is said as one to run
 * again: conflictRefusal), the target digest, and the report files
 * (O_EXCL|O_NOFOLLOW, 0600, fsynced). Its own: a
 * narrower transport (balanceOf at a block number, nothing else through
 * eth_call), its own connection names, and its own failure line (fixed codes,
 * so neither DATABASE_URL nor the RPC URL is ever printed).
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcCall } from "./chain-capital";
import { BALANCE_OF_CALL, BLOCK_QUANTITY, BookingRefused } from "./chain-gap-booking";
import {
  CliError, CommitOutcomeUnknown, conflictRefusal, conflictRolledBack, createBookingRpc, createReportFile, DEFAULT_RPC, failureLine as bookingFailureLine, finishReportFile,
  pgClientDb, sourceFingerprint, targetDigest, type PgClient,
} from "./chain-gap-booking-cli";
import {
  applyClosedEpoch, closedEpochLines, parseRepairReport, planClosedEpoch, readClosedEpochChain, readClosedEpochSnapshot, readRepairOutcome, REPAIR_ID, revertClosedEpoch,
  type ClosedEpochPlan, type RepairApplyReport, type RepairOutcome, type RepairRevertReport,
} from "./closed-epoch-capital";

export const HELP = `Closed-epoch capital repair — PREVIEW FIRST. docs/closed-epoch-capital.md is the runbook.

  node --import tsx worker/src/closed-epoch-capital-cli.ts --tenant 0xTENANT --epoch 1 --output /absolute/new-preview.json [--dry-run]
  node --import tsx worker/src/closed-epoch-capital-cli.ts --tenant 0xTENANT --epoch 1 --apply --confirm <previewDigest> --backup-ref <backup id> --output /absolute/new-apply-report.json
  node --import tsx worker/src/closed-epoch-capital-cli.ts --revert /absolute/apply-report.json --output /absolute/new-revert-report.json
  node --import tsx worker/src/closed-epoch-capital-cli.ts --revert /absolute/apply-report.json --dry-run --output /absolute/new-receipts-report.json
  node --import tsx worker/src/closed-epoch-capital-cli.ts --revert-repair <repair id> --output /absolute/new-report.json [--dry-run]

Required environment: DATABASE_URL. Optional: MERRYMEN_CHAIN_GAP_RPC (defaults to the public Robinhood Chain mainnet RPC).
Only a held tenant, and only closed epoch 1: the epoch is proved closed from Postgres and the chain before anything is proposed.
The preview reads Postgres read-only and the chain; it writes only its own report, created once with mode 0600.
--apply recomputes the preview and, only when the digest is the one you confirm, files the chain-log rows, quarantines what they supersede and
clears a stale seeded live basis, in one SERIALIZABLE transaction. Its report is written before the COMMIT; if the COMMIT's answer is lost,
the report is kept and the tool says OUTCOME UNKNOWN.
--revert with --dry-run only reads: whether its apply committed (its receipts, or the server's word on its transaction), and whether it stands.
--revert and --revert-repair take one repair back exactly, if nothing stood on it since.
Neither DATABASE_URL nor the RPC URL is printed or saved.
`;

const TENANT = /^0x[0-9a-fA-F]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const EPOCH = /^[1-9][0-9]{0,5}$/;

export type ClosedEpochArgs =
  | { help: true }
  | { mode: "preview"; tenant: string; epoch: number; output: string }
  | { mode: "apply"; tenant: string; epoch: number; output: string; confirm: string; backupRef: string }
  | { mode: "revert"; report: string; output: string }
  | { mode: "receipts"; report: string; output: string }
  | { mode: "revert-repair"; repairId: string; output: string; dryRun: boolean };

/** Fixed codes only: an argument's text is never echoed back. */
export function parseClosedEpochArgs(args: readonly string[]): ClosedEpochArgs {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const seen = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) throw new CliError("invalid-arguments");
    if (flag === "--dry-run" || flag === "--apply") { seen.set(flag, true); continue; }
    const value = args[++i];
    if (!["--tenant", "--epoch", "--output", "--confirm", "--backup-ref", "--revert", "--revert-repair"].includes(flag) || value === undefined || value.startsWith("--")) {
      throw new CliError("invalid-arguments");
    }
    seen.set(flag, value);
  }
  const output = seen.get("--output");
  if (typeof output !== "string" || !path.isAbsolute(output)) throw new CliError("invalid-arguments");
  const only = (...allowed: string[]) => [...seen.keys()].every((k) => allowed.includes(k));
  const revert = seen.get("--revert");
  if (revert !== undefined) {
    if (typeof revert !== "string" || !path.isAbsolute(revert) || !only("--revert", "--output", "--dry-run")) throw new CliError("invalid-arguments");
    // With --dry-run, only read: whether its apply committed, and whether what it wrote stands.
    return seen.has("--dry-run") ? { mode: "receipts", report: revert, output } : { mode: "revert", report: revert, output };
  }
  const repair = seen.get("--revert-repair");
  if (repair !== undefined) {
    if (typeof repair !== "string" || !REPAIR_ID.test(repair) || !only("--revert-repair", "--output", "--dry-run")) throw new CliError("invalid-arguments");
    return { mode: "revert-repair", repairId: repair, output, dryRun: seen.has("--dry-run") };
  }
  const tenant = seen.get("--tenant"), epoch = seen.get("--epoch");
  if (typeof tenant !== "string" || !TENANT.test(tenant) || typeof epoch !== "string" || !EPOCH.test(epoch)) throw new CliError("invalid-arguments");
  if (seen.has("--apply")) {
    const confirm = seen.get("--confirm"), backupRef = seen.get("--backup-ref");
    if (seen.has("--dry-run") || typeof confirm !== "string" || !DIGEST.test(confirm) || typeof backupRef !== "string") throw new CliError("invalid-arguments");
    return { mode: "apply", tenant: tenant.toLowerCase(), epoch: Number(epoch), output, confirm, backupRef };
  }
  // A confirmation or a backup named without --apply is refused, so nobody reads a dry run's output believing they applied something.
  if (seen.has("--confirm") || seen.has("--backup-ref")) throw new CliError("invalid-arguments");
  return { mode: "preview", tenant: tenant.toLowerCase(), epoch: Number(epoch), output };
}

// ── the chain transport ──────────────────────────────────────────────────────

/**
 * THE ONLY WAY THIS TOOL TALKS TO A NODE: the booking tool's read allowlist
 * (createBookingRpc), narrowed. eth_call is admitted for exactly one view:
 * `balanceOf(address)` with one zero-padded address, at a block number and
 * never a tag. This tool never asks decimals(), so that is refused too.
 */
export function createClosedEpochRpc(url: string, fetchImpl: typeof fetch = fetch): RpcCall {
  const inner = createBookingRpc(url, fetchImpl);
  return async (method, params) => {
    if (method === "eth_call") {
      const [call, tag, ...rest] = params as [Record<string, unknown> | undefined, unknown];
      if (rest.length || !call || Object.keys(call).sort().join(",") !== "data,to" || typeof call.data !== "string" || !BALANCE_OF_CALL.test(call.data)
        || typeof tag !== "string" || !BLOCK_QUANTITY.test(tag)) throw new CliError("rpc-call-outside-read-allowlist");
    }
    return inner(method, params);
  };
}

// ── Postgres ─────────────────────────────────────────────────────────────────
//
// The apply and the revert run on the booking tool's own write connection,
// pgClientDb(client, { readOnly: false }): BEGIN ISOLATION LEVEL
// SERIALIZABLE, proved by asking the server before anything runs, and a
// COMMIT's answer read by its rule. A SQLSTATE that proves a rollback is
// rethrown as itself (class 40 but 40003, class 23), ROLLBACK's tag is
// "commit-answered-rollback", and anything else (a dropped connection, a
// terminated backend, a timeout, 40003, another tag) is CommitOutcomeUnknown —
// that module's class, which is the one this shell catches.

/** node-postgres, as the booking tool connects (connectBooking), under this tool's own names in pg_stat_activity. */
export async function connectClosedEpoch(url: string, readOnly: boolean, loadPg: () => Promise<unknown> = () => import(/* webpackIgnore: true */ "pg" as string)): Promise<PgClient> {
  let pg: { Client: new (c: { connectionString: string; options?: string; application_name?: string; connectionTimeoutMillis?: number }) => PgClient & { connect(): Promise<void> };
    types: { setTypeParser(oid: number, fn: (v: string) => unknown): void } };
  try {
    const mod = (await loadPg()) as { default?: unknown };
    pg = (mod.default ?? mod) as typeof pg;
    if (typeof pg?.Client !== "function") throw new Error("no driver");
  } catch { throw new CliError("postgres-driver-unavailable"); }
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  const client = new pg.Client({
    connectionString: url, connectionTimeoutMillis: 10_000, application_name: readOnly ? "merrymen-closed-epoch-preview-readonly" : "merrymen-closed-epoch-apply",
    options: `-c statement_timeout=30000 -c lock_timeout=5000${readOnly ? " -c default_transaction_read_only=on" : ""}`,
  });
  await client.connect();
  return client;
}

/**
 * The code that produced a preview, by file digest: an apply by different code recomputes a different digest and refuses.
 *
 * EVERY FILE THE BOOKING TOOL'S OWN PREVIEW BINDS (chain-gap-booking-cli.ts sourceFingerprint), then this tool's. Its snapshot, hold,
 * admission check and owner reading are this tool's too (readBookingSnapshot, holdOf, chainGapCheck, ownerOperationOf), so whatever
 * decides them there decides them here, among them which owner records admission loads (ledger-mirror.ts, db.ts) and how one is read
 * (owner-operations.ts, deposit-log.ts). Taken from that function, so a file it comes to bind is bound here as well.
 */
export function closedEpochSourceFingerprint(here = path.dirname(fileURLToPath(import.meta.url))): Record<string, string> {
  const files = ["closed-epoch-capital.ts", "closed-epoch-capital-cli.ts", "chain-gap-booking.ts", "chain-gap-booking-cli.ts", "ledger-resume.ts", "asset-movements.ts",
    "chain-capital.ts", "inflight-reconcile.ts", "rpc-error.ts", "custody.ts", "distinct-flows.ts", "paper-boundary.ts", "accounting-repair.ts", "accounting-reconstruction.ts",
    "accounting-scope.ts", "basis-seed.ts", "held-reset.ts", "../../packages/core/src/capital-classify.ts", "../../packages/core/src/flow-evidence.ts",
    "../../packages/core/src/grant.ts", "../../packages/core/src/trencher-vault.ts", "../../packages/core/src/tokens.ts", "../../packages/core/src/energy.ts",
    "../../packages/core/src/chain.ts",
    // The owner reading this tool re-derives itself (planClosedEpoch), with the scanner inputs it classifies by.
    "owner-operations.ts", "deposit-log.ts"];
  return { ...sourceFingerprint(here), ...Object.fromEntries(files.map((f) => [f, createHash("sha256").update(readFileSync(path.resolve(here, f))).digest("hex")])) };
}

// ── the run ──────────────────────────────────────────────────────────────────

const SELF = "node --import tsx worker/src/closed-epoch-capital-cli.ts";
/** How to see whether an apply committed, read only, and how to take it back: what an unanswered COMMIT leaves an operator to run. */
function recoveryLines(report: string): string[] {
  return [
    `  1. Did it commit? Read only: ${SELF} --revert ${report} --dry-run --output /absolute/new-receipts-report.json`,
    "     COMMITTED (receipts 'applied', and what it wrote unmoved): it stands; go on to step 5 of docs/closed-epoch-capital.md, or take it back with 2.",
    "     NOT COMMITTED (no receipt, and the server says its transaction ended without committing): nothing was written; preview the tenant again.",
    "     STILL UNKNOWN (no receipt yet, and no such word from the server): keep the report and run 1 again; it settles once the server ends that transaction.",
    `  2. Take it back: ${SELF} --revert ${report} --output /absolute/new-revert-report.json`,
  ];
}
/**
 * The report names the database it was applied to by its URL (host, port and name: the target the preview digest binds). A revert, or a
 * look at its receipts, anywhere else would find no receipt, so it is refused before it connects. That binds the spelling, not the
 * server; the server is bound by the report's xact (its system identifier), which decides whether no receipt can ever be NOT COMMITTED.
 */
function sameDatabase(report: RepairApplyReport, databaseUrl: string): void {
  if (report.target !== targetDigest(databaseUrl)) {
    throw new BookingRefused("target", "the apply report was applied to another database (by host, port and name) than DATABASE_URL names: nothing was read or " +
      "written — point DATABASE_URL at the database it was applied to");
  }
}
/**
 * A report file that does not parse, given to the receipts check: the apply that writes it has not reached its COMMIT, because the report
 * is written in full and fsynced before the COMMIT is sent.
 */
function unfinishedReport(): BookingRefused {
  return new BookingRefused("report-unfinished", "the apply report is empty or cut short, so the apply that writes it never reached its COMMIT (the report is " +
    "written in full and fsynced before the COMMIT is sent). If that apply has died, nothing was written: preview the tenant again. If it is still " +
    "running, let it finish and run this check again");
}
/** The receipts check, said in one line: its verdict first, the one word a reader acts on. */
function outcomeLine(v: RepairOutcome, report: string | null, output: string): string {
  const who = `repair ${v.repairId}${v.tenant ? ` — tenant ${v.tenant}` : ""}`;
  const n = `${v.receipts.length} receipt(s)`, said = `0 database writes; report ${output}`;
  const back = report ? `${SELF} --revert ${report} --output /absolute/new-revert-report.json` : `${SELF} --revert-repair ${v.repairId} --output /absolute/new-revert-report.json`;
  switch (v.verdict) {
    case "applied": return `COMMITTED ${who}: ${n} 'applied', and the account's flows, quarantine history, live basis and floors exactly as it left them: it ` +
      `stands. Go on to step 5 of docs/closed-epoch-capital.md, or take it back with ${back}. ${said}`;
    case "moved": return `COMMITTED, BUT MOVED SINCE ${who}: ${v.why}. ${said}`;
    case "reverted": return `COMMITTED, THEN REVERTED ${who}: ${n} 'reverted', nothing of it stands. ${said}`;
    case "not-committed": return `NOT COMMITTED ${who}: ${v.why}; preview the tenant again. ${said}`;
    case "unknown": return report
      ? `STILL UNKNOWN ${who}: ${v.why}. Keep ${report}: if it committed, it is what --revert takes. Run this check again in a minute. ${said}`
      : `STILL UNKNOWN ${who}: ${v.why}. Run the check with its apply report, which names its transaction: ${SELF} --revert <apply report> --dry-run ` +
        `--output /absolute/new-receipts-report.json. ${said}`;
    default: return `${who}: ${n} in more than one state, which one revert never leaves: escalate. ${said}`;
  }
}

export interface ClosedEpochCliDeps {
  connect?: (url: string, readOnly: boolean) => Promise<PgClient>;
  rpc?: RpcCall;
  nowMs?: () => number;
  out?: (line: string) => void;
  /** The code fingerprint; tests pass a fixed one. */
  source?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
  repairId?: () => string;
  maxSpan?: bigint;
}

/** The preview, exactly as both modes compute it: one read-only snapshot, the connection closed, then the chain, then the plan. */
async function computePlan(tenant: string, epoch: number, env: NodeJS.ProcessEnv, deps: Required<Pick<ClosedEpochCliDeps, "connect" | "rpc" | "nowMs">> & ClosedEpochCliDeps): Promise<ClosedEpochPlan> {
  const url = env.DATABASE_URL!;
  const nowSec = Math.floor(deps.nowMs() / 1000);
  const client = await deps.connect(url, true);
  let snap;
  try {
    snap = await pgClientDb(client, { readOnly: true }).tx((db) => readClosedEpochSnapshot(db, { tenant, dialect: "postgres", nowSec, epoch }));
  } finally {
    // Closed before the chain is read: no session stays open across the slow public reads.
    await client.end().catch(() => {});
  }
  const chain = await readClosedEpochChain(deps.rpc, snap, { ...(deps.sleep ? { sleep: deps.sleep } : {}), ...(deps.maxSpan ? { maxSpan: deps.maxSpan } : {}) });
  return planClosedEpoch(snap, chain, { nowSec, source: deps.source ?? closedEpochSourceFingerprint(), target: targetDigest(url) });
}

export async function main(args: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, deps: ClosedEpochCliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  /** A line said once the outcome is settled (committed, or unknown): a console that fails cannot replace the error that says which. */
  const say = (line: string) => { try { out(line); } catch { /* the CliError thrown next still says it */ } };
  const options = parseClosedEpochArgs(args);
  if ("help" in options) { out(HELP); return 0; }
  if (!env.DATABASE_URL) throw new CliError("database-url-required");
  targetDigest(env.DATABASE_URL);
  const full = {
    ...deps, connect: deps.connect ?? connectClosedEpoch, nowMs: deps.nowMs ?? (() => Date.now()),
    rpc: deps.rpc ?? createClosedEpochRpc(env.MERRYMEN_CHAIN_GAP_RPC || DEFAULT_RPC),
  };

  if (options.mode === "receipts" || (options.mode === "revert-repair" && options.dryRun)) {
    // DID THAT APPLY COMMIT, AND DOES IT STAND? Its receipts, on a read-only connection in one read-only snapshot, against the report when
    // one is given; with none, the server's word on the transaction the report names. Writes nothing to the database.
    let report: RepairApplyReport | undefined;
    if (options.mode === "receipts") {
      let text: string;
      try { text = readFileSync(options.report, "utf8"); } catch { throw new CliError("report-unreadable"); }
      try { JSON.parse(text); } catch { throw unfinishedReport(); }
      report = parseRepairReport(text);
      sameDatabase(report, env.DATABASE_URL);
    }
    const repairId = report?.repairId ?? (options as { repairId: string }).repairId;
    const client = await full.connect(env.DATABASE_URL, true);
    let view: RepairOutcome;
    try {
      view = await pgClientDb(client, { readOnly: true }).tx((db) => readRepairOutcome(db, { repairId, ...(report ? { report } : {}), dialect: "postgres" }));
    } finally { await client.end().catch(() => {}); }
    const fd = createReportFile(options.output);
    finishReportFile(fd, options.output, view);
    out(outcomeLine(view, options.mode === "receipts" ? options.report : null, options.output));
    // Settled and standing as the receipts say: 0. Still unknown, moved, or partly reverted: 2, so nothing scripted reads it as settled.
    return view.verdict === "applied" || view.verdict === "reverted" || view.verdict === "not-committed" ? 0 : 2;
  }

  if (options.mode === "revert" || options.mode === "revert-repair") {
    let report: RepairApplyReport | undefined;
    if (options.mode === "revert") {
      let text: string;
      try { text = readFileSync(options.report, "utf8"); } catch { throw new CliError("report-unreadable"); }
      report = parseRepairReport(text);
      sameDatabase(report, env.DATABASE_URL);
    }
    const repairId = report?.repairId ?? (options as { repairId: string }).repairId;
    const look = options.mode === "revert" ? `${SELF} --revert ${options.report} --dry-run` : `${SELF} --revert-repair ${repairId} --dry-run`;
    const fd = createReportFile(options.output);
    let r: RepairRevertReport;
    try {
      const client = await full.connect(env.DATABASE_URL, false);
      try {
        r = await revertClosedEpoch(pgClientDb(client, { readOnly: false }), { repairId, ...(report ? { report } : {}), nowMs: full.nowMs(), dialect: "postgres" });
      } finally { await client.end().catch(() => {}); }
    } catch (e) {
      // Nothing committed (the COMMIT was never sent, or its answer proved a rollback), or no answer came: this run's report describes nothing either way.
      try { closeSync(fd); } catch { /* already closed */ }
      rmSync(options.output, { force: true });
      if (e instanceof CommitOutcomeUnknown) {
        // A revert is safe to run again: one that committed answers ALREADY REVERTED and changes nothing.
        say(`OUTCOME UNKNOWN for the revert of repair ${repairId}: its COMMIT was sent and no answer proved it rolled back. Run the same revert again with a new ` +
          `--output: it reverts, or says ALREADY REVERTED if this one committed. To only look: ${look} --output /absolute/new-receipts-report.json`);
        throw new CliError("revert-outcome-unknown");
      }
      if (conflictRolledBack(e)) throw conflictRefusal(e, "revert");
      throw e;
    }
    // COMMITTED: the receipts read 'reverted' whatever happens to this run's report or its console line now, so nothing below removes the report.
    const verb = r.outcome === "reverted" ? "REVERTED" : "ALREADY REVERTED";
    try { finishReportFile(fd, options.output, r); } catch {
      say(`${verb} repair ${r.repairId} — tenant ${r.tenant}: the revert committed and its receipts read 'reverted', but its report could not be written to ${options.output} ` +
        `(what is there may be partial). See the receipts with ${look} --output /absolute/new-receipts-report.json`);
      throw new CliError("reverted-but-report-not-written");
    }
    try { out(`${verb} repair ${r.repairId} — tenant ${r.tenant}: ${r.actions.length} action(s); report ${options.output}`); }
    catch { throw new CliError("reverted-but-not-printed"); }
    return 0;
  }

  if (options.mode === "preview") {
    const plan = await computePlan(options.tenant, options.epoch, env, full);
    const fd = createReportFile(options.output);
    finishReportFile(fd, options.output, { ...plan, mode: "preview", writesPerformed: 0 });
    for (const line of closedEpochLines(plan)) out(line);
    out(`PREVIEW ONLY — 0 database writes. The plan is in ${options.output}.`);
    return plan.verdict === "blocked" ? 2 : 0;
  }

  // APPLY: the report file first, and the repair id said before anything is read or written.
  const fd = createReportFile(options.output);
  let open = true;
  const close = () => { if (open) { open = false; closeSync(fd); } };
  const repairId = full.repairId?.() ?? randomUUID();
  out(`repair ${repairId}: its apply report is written to ${options.output} before the COMMIT is sent. If this process dies, see whether it committed with ` +
    `${SELF} --revert ${options.output} --dry-run --output /absolute/new-receipts-report.json`);
  let report: RepairApplyReport;
  // What persist wrote (assigned inside the transaction, so typed by assertion: the compiler does not follow the callback).
  let persisted = undefined as RepairApplyReport | undefined;
  try {
    const plan = await computePlan(options.tenant, options.epoch, env, full);
    for (const line of closedEpochLines(plan)) out(line);
    if (plan.verdict === "nothing-to-do") throw new BookingRefused("nothing-to-do", "the preview finds nothing to file, quarantine or clear for this tenant (already applied?)");
    const client = await full.connect(env.DATABASE_URL, false);
    try {
      report = await applyClosedEpoch(pgClientDb(client, { readOnly: false }), plan, {
        confirm: options.confirm, backupRef: options.backupRef, dialect: "postgres", nowMs: full.nowMs(), repairId,
        // Inside the transaction, every receipt written, the COMMIT not yet sent: the whole report, naming its database and its own transaction, fsynced.
        persist: (r) => { open = false; persisted = r; finishReportFile(fd, options.output, r); },
      });
    } finally { await client.end().catch(() => {}); }
  } catch (e) {
    if (e instanceof CommitOutcomeUnknown) {
      // The COMMIT may have taken effect: the report stays, and the receipts (or the server's word on its transaction) settle it.
      close();
      const xact = persisted?.xact ? ` Its transaction is ${persisted.xact.id}.` : "";
      say(`OUTCOME UNKNOWN for repair ${repairId}: the COMMIT was sent and no answer proved it rolled back, so it may have committed. ${options.output} holds ` +
        `its apply report, written and fsynced before the COMMIT: keep it, both commands below take it.${xact}`);
      for (const line of recoveryLines(options.output)) say(line);
      throw new CliError("apply-outcome-unknown");
    }
    // Nothing committed: the COMMIT was never sent, or its answer proved a rollback. The report describes nothing.
    close();
    rmSync(options.output, { force: true });
    // Rolled back for a conflict with another transaction: nothing was written, and the same command can simply run again.
    if (conflictRolledBack(e)) throw conflictRefusal(e, "apply");
    throw e;
  }
  // COMMITTED, and the COMMIT acknowledged: the report was whole and synced before it, nothing below removes it, and a console that fails
  // does not unsay it.
  try {
    out(`APPLIED repair ${report.repairId} — ${report.actions.length} action(s) for tenant ${report.tenant}, epoch ${report.epoch}, under backup ${report.backupRef}; ` +
      `the apply report (what --revert takes) is ${options.output}. Preview the tenant again with MERRYMEN_RESUME_PREVIEW before approving it.`);
  } catch { throw new CliError("applied-but-not-printed"); }
  return 0;
}

/**
 * What the console may say about a failure: this tool's own refusal sentence, or a fixed code (the booking tool's forms), and otherwise
 * this tool's own line — never a driver's or a node's message, which can carry DATABASE_URL or the RPC URL.
 */
export function failureLine(e: unknown): string {
  if (e instanceof BookingRefused || e instanceof CliError) return bookingFailureLine(e);
  return "closed-epoch-failed: nothing was applied or reverted unless an APPLIED, a REVERTED or an OUTCOME UNKNOWN line was printed. Use --help for invocation.";
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
