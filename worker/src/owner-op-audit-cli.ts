/**
 * THE OWNER'S ENTRY POINT FOR owner-op-audit.ts. READ ONLY. Reviewed operator
 * tool: never imported by the orchestrator or a worker. docs/owner-operations.md
 * is the runbook; this file is only the shell around the core.
 *
 *   node --import tsx worker/src/owner-op-audit-cli.ts --output /abs/new-audit.json [--tenant 0x…] [--max-receipts N]
 *
 * The report file is created first, once (O_EXCL, O_NOFOLLOW, mode 0600), and
 * removed if the run fails. Postgres is read in one REPEATABLE READ READ ONLY
 * snapshot on a connection opened default_transaction_read_only, always
 * rolled back and closed before the chain is read — the chain-gap booking
 * shell's own connection, statement gate and transaction (chain-gap-booking-cli.ts
 * pgClientDb, connectBooking), under its own application_name. The chain is
 * read over an RPC that admits eth_chainId, eth_blockNumber,
 * eth_getTransactionReceipt and eth_getBlockByNumber, and nothing else.
 *
 * WHAT CROSSES THE CONSOLE: counts, public chain data and the digest. Never
 * DATABASE_URL or the RPC URL: anything that is not one of this tool's own
 * codes is printed as a fixed one.
 *
 * Exit codes: 0 nothing found, 2 root-key rows found, 3 coverage incomplete
 * (whatever else was found), 1 the run failed.
 */
import { closeSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RpcCall } from "./chain-capital";
import {
  CliError, connectBooking, createBookingRpc, createReportFile, DEFAULT_RPC, finishReportFile, pgClientDb, targetDigest, type PgClient,
} from "./chain-gap-booking-cli";
import { auditExitCode, auditLines, auditReport, auditRpc, AuditRefused, DEFAULT_MAX_RECEIPTS, readAuditChain, readAuditSnapshot } from "./owner-op-audit";

export const AUDIT_APPLICATION_NAME = "merrymen-owner-op-audit-readonly";
export const HELP = `Owner-operations audit — READ ONLY. docs/owner-operations.md is the runbook.

  node --import tsx worker/src/owner-op-audit-cli.ts --output /absolute/new-audit.json [--tenant 0xTENANT] [--max-receipts N]

Required environment: DATABASE_URL. Optional: MERRYMEN_CHAIN_GAP_RPC (defaults to the public Robinhood Chain mainnet RPC).
Lists every trades row whose operation the owner's own key (the root validator) signed, where each one counts, and the totals.
Reads Postgres in one read-only snapshot, then one receipt per transaction (at most --max-receipts, default ${DEFAULT_MAX_RECEIPTS}).
Writes nothing but its own report, created once with mode 0600. Neither DATABASE_URL nor the RPC URL is printed or saved.
Exit: 0 nothing found, 2 root-key rows found, 3 coverage incomplete, 1 failed.
`;

const TENANT = /^0x[0-9a-fA-F]{40}$/;

export type AuditArgs = { help: true } | { output: string; tenant?: string; maxReceipts: number };

/** Fixed codes only: an argument's text is never echoed back. */
export function parseAuditArgs(args: readonly string[]): AuditArgs {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const seen = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!, value = args[++i];
    if (seen.has(flag) || !["--output", "--tenant", "--max-receipts"].includes(flag) || value === undefined || value.startsWith("--")) throw new CliError("invalid-arguments");
    seen.set(flag, value);
  }
  const output = seen.get("--output");
  if (output === undefined || !path.isAbsolute(output)) throw new CliError("invalid-arguments");
  const tenant = seen.get("--tenant");
  if (tenant !== undefined && !TENANT.test(tenant)) throw new CliError("invalid-arguments");
  const max = seen.get("--max-receipts");
  if (max !== undefined && !/^[1-9][0-9]{0,6}$/.test(max)) throw new CliError("invalid-arguments");
  return { output, ...(tenant ? { tenant: tenant.toLowerCase() } : {}), maxReceipts: max === undefined ? DEFAULT_MAX_RECEIPTS : Number(max) };
}

/** The code that produced a report, by file digest: the report and its digest bind it. */
export function auditSourceFingerprint(here = path.dirname(fileURLToPath(import.meta.url))): Record<string, string> {
  const files = ["owner-op-audit.ts", "owner-op-audit-cli.ts", "owner-operations.ts", "asset-movements.ts", "chain-capital.ts", "custody.ts", "deposit-log.ts",
    "chain-gap-booking-cli.ts", "../../packages/core/src/capital-classify.ts", "../../packages/core/src/grant.ts", "../../packages/core/src/trencher-vault.ts"];
  return Object.fromEntries(files.map((f) => [f, createHash("sha256").update(readFileSync(path.resolve(here, f))).digest("hex")]));
}

export interface AuditDeps {
  connect?: (url: string) => Promise<PgClient>;
  rpc?: RpcCall;
  nowMs?: () => number;
  out?: (line: string) => void;
  source?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
}

export async function main(args: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, deps: AuditDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const options = parseAuditArgs(args);
  if ("help" in options) { out(HELP); return 0; }
  if (!env.DATABASE_URL) throw new CliError("database-url-required");
  const target = targetDigest(env.DATABASE_URL);
  const rpc = auditRpc(deps.rpc ?? createBookingRpc(env.MERRYMEN_CHAIN_GAP_RPC || DEFAULT_RPC));
  const connect = deps.connect ?? ((url: string) => connectBooking(url, true, undefined, AUDIT_APPLICATION_NAME));
  // THE REPORT FIRST, before any read: a run that cannot say where its report goes reads nothing.
  const fd = createReportFile(options.output);
  try {
    const nowSec = Math.floor((deps.nowMs ?? (() => Date.now()))() / 1000);
    const client = await connect(env.DATABASE_URL);
    let snap;
    try {
      snap = await pgClientDb(client, { readOnly: true }).tx((db) => readAuditSnapshot(db, { dialect: "postgres", ...(options.tenant ? { tenant: options.tenant } : {}) }));
    } finally {
      // Closed before the chain is read: no session stays open across the slow public reads.
      await client.end().catch(() => {});
    }
    const ev = await readAuditChain(rpc, snap.trades.flatMap((t) => (t.txHash ? [t.txHash] : [])), { maxReceipts: options.maxReceipts, ...(deps.sleep ? { sleep: deps.sleep } : {}) });
    const report = auditReport(snap, ev, { nowSec, source: deps.source ?? auditSourceFingerprint(), target, maxReceipts: options.maxReceipts,
      ...(options.tenant ? { tenant: options.tenant } : {}) });
    finishReportFile(fd, options.output, { ...report, mode: "audit", writesPerformed: 0 });
    for (const line of auditLines(report)) out(line);
    out(`READ ONLY — 0 database writes. The report is in ${options.output}.`);
    return auditExitCode(report);
  } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    rmSync(options.output, { force: true });
    throw e;
  }
}

/** What the console may say about a failure: one of this tool's fixed codes, never a driver's or a node's text. */
export function failureLine(e: unknown): string {
  if (e instanceof AuditRefused || e instanceof CliError) return `${e.code}. Use --help for invocation.`;
  return "audit-failed: nothing was written. Use --help for invocation.";
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
