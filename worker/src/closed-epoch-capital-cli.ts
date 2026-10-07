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
 *                                     printed before it opens; the apply report
 *                                     is written and fsynced to --output INSIDE
 *                                     the transaction, before the commit, so a
 *                                     commit is never without its report.
 *   --revert <apply report>           take that repair back, the report checked
 *                                     against the receipts.
 *   --revert-repair <repair id>       the same from the receipts alone (a lost
 *                                     report, a crash after the commit); with
 *                                     --dry-run, only say what the receipts hold.
 *
 * Its pieces are chain-gap-booking-cli.ts's, imported unchanged where they
 * fit: the read-only Postgres wall (pgClientDb), the target digest, the report
 * files (O_EXCL|O_NOFOLLOW, 0600, fsynced) and the failure line (fixed codes,
 * so neither DATABASE_URL nor the RPC URL is ever printed). Its own: a
 * narrower transport (balanceOf at a block number, nothing else through
 * eth_call), a SERIALIZABLE write connection that tells a refused commit
 * from one whose answer never came, and its own connection names.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translateQuery, translateSchema, type Db } from "./db";
import type { RpcCall } from "./chain-capital";
import { BALANCE_OF_CALL, BLOCK_QUANTITY, BookingRefused, canonical } from "./chain-gap-booking";
import { CliError, createBookingRpc, createReportFile, DEFAULT_RPC, failureLine, finishReportFile, pgClientDb, targetDigest, type PgClient } from "./chain-gap-booking-cli";
import {
  applyClosedEpoch, closedEpochLines, parseRepairReport, planClosedEpoch, readClosedEpochChain, readClosedEpochSnapshot, readRepairReceipts, REPAIR_ID, revertClosedEpoch,
  type ClosedEpochPlan, type RepairApplyReport,
} from "./closed-epoch-capital";

export const HELP = `Closed-epoch capital repair — PREVIEW FIRST. docs/closed-epoch-capital.md is the runbook.

  node --import tsx worker/src/closed-epoch-capital-cli.ts --tenant 0xTENANT --epoch 1 --output /absolute/new-preview.json [--dry-run]
  node --import tsx worker/src/closed-epoch-capital-cli.ts --tenant 0xTENANT --epoch 1 --apply --confirm <previewDigest> --backup-ref <backup id> --output /absolute/new-apply-report.json
  node --import tsx worker/src/closed-epoch-capital-cli.ts --revert /absolute/apply-report.json --output /absolute/new-revert-report.json
  node --import tsx worker/src/closed-epoch-capital-cli.ts --revert-repair <repair id> --output /absolute/new-report.json [--dry-run]

Required environment: DATABASE_URL. Optional: MERRYMEN_CHAIN_GAP_RPC (defaults to the public Robinhood Chain mainnet RPC).
Only a held tenant, and only closed epoch 1: the epoch is proved closed from Postgres and the chain before anything is proposed.
The preview reads Postgres read-only and the chain; it writes only its own report, created once with mode 0600.
--apply recomputes the preview and, only when the digest is the one you confirm, files the chain-log rows, quarantines what they supersede and
clears a stale seeded live basis, in one transaction. --revert and --revert-repair take one repair back exactly, if nothing stood on it since.
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
    if (typeof revert !== "string" || !path.isAbsolute(revert) || !only("--revert", "--output")) throw new CliError("invalid-arguments");
    return { mode: "revert", report: revert, output };
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

/** The commit was sent and no answer came: whether it took is for the receipts to say. */
export class CommitOutcomeUnknown extends Error {
  constructor() { super("commit-outcome-unknown"); this.name = "CommitOutcomeUnknown"; }
}

/**
 * The core's Db over ONE node-postgres connection for the apply and the
 * revert: `?` placeholders as db.ts translates them, and every transaction
 * BEGIN ISOLATION LEVEL SERIALIZABLE, proved by asking the server — so the
 * compare-and-set's reads and the writes are one unit (a 40001 rolls back
 * and writes nothing). A COMMIT the server refused (it answers with a
 * SQLSTATE) is a definite rollback and rethrown as itself; a COMMIT whose
 * answer never came (a dropped connection) is CommitOutcomeUnknown, which the
 * shell never reads as "nothing happened".
 */
export function pgWriteDb(client: PgClient): Db {
  const coerce = (ps: unknown[]) => ps.map((p) => (typeof p === "bigint" ? p.toString() : p === undefined ? null : p));
  const scoped = (inTx: boolean): Db => ({
    prepare(sql) {
      const text = translateQuery(sql);
      return {
        async run(...ps) { const r = await client.query(text, coerce(ps)); return { changes: r.rowCount ?? 0, lastInsertRowid: 0 }; },
        async get(...ps) { return (await client.query(text, coerce(ps))).rows[0]; },
        async all(...ps) { return (await client.query(text, coerce(ps))).rows; },
      };
    },
    async exec(sql) {
      if (inTx) throw new Error("DDL runs before the transaction, never inside it");
      await client.query(translateSchema(sql));
    },
    async tx(fn) {
      if (inTx) throw new Error("nested transactions are not supported");
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      let out: Awaited<ReturnType<typeof fn>>;
      try {
        const s = (await client.query("SELECT current_setting('transaction_isolation') AS iso")).rows[0];
        if (s?.iso !== "serializable") throw new CliError("serializable-not-established");
        out = await fn(scoped(true));
      } catch (e) {
        try { await client.query("ROLLBACK"); } catch { /* the original error wins */ }
        throw e;
      }
      try {
        await client.query("COMMIT");
      } catch (e) {
        const code = (e as { code?: unknown } | null)?.code;
        if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) throw e;
        throw new CommitOutcomeUnknown();
      }
      return out;
    },
  });
  return scoped(false);
}

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

/** The code that produced a preview, by file digest: an apply by different code recomputes a different digest and refuses. */
export function closedEpochSourceFingerprint(here = path.dirname(fileURLToPath(import.meta.url))): Record<string, string> {
  const files = ["closed-epoch-capital.ts", "closed-epoch-capital-cli.ts", "chain-gap-booking.ts", "chain-gap-booking-cli.ts", "ledger-resume.ts", "asset-movements.ts",
    "chain-capital.ts", "inflight-reconcile.ts", "rpc-error.ts", "custody.ts", "distinct-flows.ts", "paper-boundary.ts", "accounting-repair.ts", "accounting-reconstruction.ts",
    "accounting-scope.ts", "basis-seed.ts", "held-reset.ts", "../../packages/core/src/capital-classify.ts", "../../packages/core/src/flow-evidence.ts",
    "../../packages/core/src/grant.ts", "../../packages/core/src/trencher-vault.ts", "../../packages/core/src/tokens.ts", "../../packages/core/src/energy.ts",
    "../../packages/core/src/chain.ts"];
  return Object.fromEntries(files.map((f) => [f, createHash("sha256").update(readFileSync(path.resolve(here, f))).digest("hex")]));
}

// ── report files ─────────────────────────────────────────────────────────────

/** The apply report, written and fsynced through the file created before the transaction, which stays open until the commit returns. */
function writeOpenReport(fd: number, value: unknown): void {
  const data = Buffer.from(`${JSON.stringify(JSON.parse(canonical(value)), null, 2)}\n`);
  let n = 0;
  while (n < data.length) n += writeSync(fd, data, n, data.length - n);
  fsyncSync(fd);
}
function closeOpenReport(fd: number, file: string): void {
  closeSync(fd);
  const dir = openSync(path.dirname(file), constants.O_RDONLY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

// ── the run ──────────────────────────────────────────────────────────────────

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
  const options = parseClosedEpochArgs(args);
  if ("help" in options) { out(HELP); return 0; }
  if (!env.DATABASE_URL) throw new CliError("database-url-required");
  targetDigest(env.DATABASE_URL);
  const full = {
    ...deps, connect: deps.connect ?? connectClosedEpoch, nowMs: deps.nowMs ?? (() => Date.now()),
    rpc: deps.rpc ?? createClosedEpochRpc(env.MERRYMEN_CHAIN_GAP_RPC || DEFAULT_RPC),
  };

  if (options.mode === "revert-repair" && options.dryRun) {
    // WHAT THE RECEIPTS HOLD, read only: whether an apply whose outcome was unknown committed, and what a revert would take back.
    const client = await full.connect(env.DATABASE_URL, true);
    let receipts;
    try {
      receipts = await pgClientDb(client, { readOnly: true }).tx((db) => readRepairReceipts(db, "postgres", options.repairId));
    } finally { await client.end().catch(() => {}); }
    const fd = createReportFile(options.output);
    const summary = receipts.map((r) => ({ action: r.action, evidenceKey: r.evidenceKey, table: r.table, state: r.state, epoch: r.epoch, appliedAtMs: r.appliedAtMs,
      revertedAtMs: r.revertedAtMs, previewDigest: r.previewDigest, backupRef: r.backupRef }));
    finishReportFile(fd, options.output, { mode: "receipts", repairId: options.repairId, tenant: receipts[0]?.tenant ?? null, account: receipts[0]?.account ?? null, receipts: summary,
      writesPerformed: 0 });
    const applied = receipts.filter((r) => r.state === "applied").length, reverted = receipts.filter((r) => r.state === "reverted").length;
    out(receipts.length
      ? `repair ${options.repairId}: ${receipts.length} receipt(s) — ${applied} applied, ${reverted} reverted. ${applied ? "It committed; --revert-repair without --dry-run takes it back." : ""} Report ${options.output}.`
      : `repair ${options.repairId}: no receipts — nothing was applied under it. Report ${options.output}.`);
    return 0;
  }

  if (options.mode === "revert" || options.mode === "revert-repair") {
    let report: RepairApplyReport | undefined;
    if (options.mode === "revert") {
      let text: string;
      try { text = readFileSync(options.report, "utf8"); } catch { throw new CliError("report-unreadable"); }
      report = parseRepairReport(text);
    }
    const repairId = report?.repairId ?? (options as { repairId: string }).repairId;
    const fd = createReportFile(options.output);
    const client = await full.connect(env.DATABASE_URL, false);
    try {
      const r = await revertClosedEpoch(pgWriteDb(client), { repairId, ...(report ? { report } : {}), nowMs: full.nowMs(), dialect: "postgres" });
      finishReportFile(fd, options.output, r);
      out(`${r.outcome === "reverted" ? "REVERTED" : "ALREADY REVERTED"} repair ${r.repairId} — tenant ${r.tenant}: ${r.actions.length} action(s); report ${options.output}`);
      return 0;
    } catch (e) {
      try { closeSync(fd); } catch { /* already closed */ }
      rmSync(options.output, { force: true });
      if (e instanceof CommitOutcomeUnknown) {
        out(`outcome unknown: the revert's commit was sent and no answer came back — run --revert-repair ${repairId} --dry-run to see whether its receipts read 'reverted'`);
        throw new CliError("revert-outcome-unknown");
      }
      throw e;
    } finally { await client.end().catch(() => {}); }
  }

  if (options.mode === "preview") {
    const plan = await computePlan(options.tenant, options.epoch, env, full);
    const fd = createReportFile(options.output);
    finishReportFile(fd, options.output, { ...plan, mode: "preview", writesPerformed: 0 });
    for (const line of closedEpochLines(plan)) out(line);
    out(`PREVIEW ONLY — 0 database writes. The plan is in ${options.output}.`);
    return plan.verdict === "blocked" ? 2 : 0;
  }

  // APPLY: the report file first, and the repair id said before the transaction opens.
  const fd = createReportFile(options.output);
  const repairId = full.repairId?.() ?? randomUUID();
  out(`repair ${repairId} — if this process dies, see what was applied with --revert-repair ${repairId} --dry-run`);
  let phase: "before" | "committed" = "before";
  try {
    const plan = await computePlan(options.tenant, options.epoch, env, full);
    for (const line of closedEpochLines(plan)) out(line);
    if (plan.verdict === "nothing-to-do") throw new BookingRefused("nothing-to-do", "the preview finds nothing to file, quarantine or clear for this tenant (already applied?)");
    const client = await full.connect(env.DATABASE_URL, false);
    try {
      const report = await applyClosedEpoch(pgWriteDb(client), plan, {
        confirm: options.confirm, backupRef: options.backupRef, dialect: "postgres", nowMs: full.nowMs(), repairId,
        persist: (r) => writeOpenReport(fd, r),
      });
      phase = "committed";
      closeOpenReport(fd, options.output);
      out(`APPLIED repair ${report.repairId} — ${report.actions.length} action(s) for tenant ${report.tenant}, epoch ${report.epoch}, under backup ${report.backupRef}; ` +
        `the apply report (what --revert takes) is ${options.output}. Preview the tenant again with MERRYMEN_RESUME_PREVIEW before approving it.`);
      return 0;
    } finally { await client.end().catch(() => {}); }
  } catch (e) {
    if (e instanceof CommitOutcomeUnknown) {
      try { closeSync(fd); } catch { /* already closed */ }
      out(`outcome unknown: the commit was sent and no answer came back. ${options.output} holds the report written before the commit — ` +
        `run --revert-repair ${repairId} --dry-run to see whether its receipts exist`);
      throw new CliError("apply-outcome-unknown");
    }
    if (phase === "committed") throw new CliError("applied-but-report-not-closed");
    try { closeSync(fd); } catch { /* already closed */ }
    rmSync(options.output, { force: true });
    throw e;
  }
}

export { failureLine };

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
