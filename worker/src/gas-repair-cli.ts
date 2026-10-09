/**
 * THE OPERATOR'S ENTRY POINT FOR gas-repair.ts. Reviewed operator tool: never
 * imported by the orchestrator or a worker. Completes the gas of rows the board
 * withholds P&L for ("Gas accounting unavailable"), from each row's receipt and
 * the Chainlink round in force at its block. PREVIEW FIRST.
 *
 *   preview (the default)   one REPEATABLE READ READ ONLY snapshot on a
 *                           connection opened read only, closed before the
 *                           chain is read; the plan to --output (created once,
 *                           0600) and its digest to the console.
 *   --apply                 recompute the same preview, require --confirm <its
 *                           digest> and --backup-ref, then ONE SERIALIZABLE
 *                           transaction: every row compare-and-set, a receipt
 *                           each. The report is written and fsynced INSIDE the
 *                           transaction, before the COMMIT ("unknown"), then
 *                           replaced by the same report saying "committed".
 *   --check <apply report>  read only: did it commit (its receipts, by repair id).
 *   --revert <apply report> put every row back, only if each still holds exactly
 *                           what was written.
 *
 * Shares the chain-gap booking shell's Postgres connection, statement gate,
 * transactions and report files (chain-gap-booking-cli.ts), so every COMMIT's
 * answer is read by one rule. WHAT CROSSES THE CONSOLE: row ids, accounts,
 * transaction hashes, blocks, amounts, the digest. Never DATABASE_URL or the
 * RPC URL: anything that is not this tool's own refusal is a fixed code.
 *
 *   railway ssh --service orchestrator -- sh -c 'cd /app && node --import tsx worker/src/gas-repair-cli.ts --output /tmp/gas-preview.json'
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData } from "viem";
import { CASH_FEEDS, CHAINLINK_ABI } from "../../packages/core/src/index";
import type { RpcCall } from "./chain-capital";
import {
  CliError, CommitOutcomeUnknown, connectBooking, conflictRolledBack, createReportFile, DEFAULT_RPC, finishReportFile, pgClientDb, replaceReportFile,
  targetDigest, type PgClient,
} from "./chain-gap-booking-cli";
import { BookingRefused } from "./chain-gap-booking";
import {
  applyGasRepair, DEFAULT_MAX_RECEIPTS, GasRepairRefused, parseApplyReport, planGasRepair, planLines, readGasSnapshot, REPAIRS_TABLE, revertGasRepair,
  stampCommitOutcome, type ApplyReport, type GasRepairPlan,
} from "./gas-repair";

export const READ_APPLICATION_NAME = "merrymen-gas-repair-readonly";
export const WRITE_APPLICATION_NAME = "merrymen-gas-repair-apply";
const SELF = "node --import tsx worker/src/gas-repair-cli.ts";
export const HELP = `Gas repair — PREVIEW FIRST. Completes the gas of rows the board withholds P&L for, from each row's receipt.

  ${SELF} --output /absolute/new-preview.json [--tenant 0xACCOUNT] [--max-receipts N]
  ${SELF} --apply --confirm <previewDigest> --backup-ref <backup id> --output /absolute/new-apply-report.json [--tenant 0xACCOUNT] [--max-receipts N]
  ${SELF} --check /absolute/apply-report.json --output /absolute/new-check.json
  ${SELF} --revert /absolute/apply-report.json --output /absolute/new-revert-report.json

Required environment: DATABASE_URL. Optional: MERRYMEN_CHAIN_GAP_RPC (defaults to the public Robinhood Chain mainnet RPC).
Only NULL gas columns are written, only from the row's own UserOperationEvent and the Chainlink ETH/USD round in force at its block.
A row whose recorded gas or payer disagrees with its receipt is listed as unresolved and left alone.
--apply recomputes the preview and writes it in one SERIALIZABLE transaction, only when the digest is the one you confirm.
Neither DATABASE_URL nor the RPC URL is printed or saved.
`;

const ACCOUNT = /^0x[0-9a-fA-F]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export type RepairArgs =
  | { help: true }
  | { mode: "preview"; output: string; tenant: string | null; maxReceipts: number }
  | { mode: "apply"; output: string; tenant: string | null; maxReceipts: number; confirm: string; backupRef: string }
  | { mode: "check"; output: string; report: string }
  | { mode: "revert"; output: string; report: string };

/** Fixed codes only: an argument's text is never echoed back. */
export function parseRepairArgs(args: readonly string[]): RepairArgs {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const seen = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) throw new CliError("invalid-arguments");
    if (flag === "--apply") { seen.set(flag, true); continue; }
    const value = args[++i];
    if (!["--output", "--tenant", "--max-receipts", "--confirm", "--backup-ref", "--check", "--revert"].includes(flag) || value === undefined || value.startsWith("--")) {
      throw new CliError("invalid-arguments");
    }
    seen.set(flag, value);
  }
  const output = seen.get("--output");
  if (typeof output !== "string" || !path.isAbsolute(output)) throw new CliError("invalid-arguments");
  for (const mode of ["--check", "--revert"] as const) {
    const report = seen.get(mode);
    if (report === undefined) continue;
    if (typeof report !== "string" || !path.isAbsolute(report) || [...seen.keys()].some((k) => k !== mode && k !== "--output")) throw new CliError("invalid-arguments");
    return mode === "--check" ? { mode: "check", output, report } : { mode: "revert", output, report };
  }
  const tenantRaw = seen.get("--tenant");
  if (tenantRaw !== undefined && (typeof tenantRaw !== "string" || !ACCOUNT.test(tenantRaw))) throw new CliError("invalid-arguments");
  const tenant = typeof tenantRaw === "string" ? tenantRaw.toLowerCase() : null;
  const max = seen.get("--max-receipts");
  if (max !== undefined && (typeof max !== "string" || !/^[1-9][0-9]{0,5}$/.test(max))) throw new CliError("invalid-arguments");
  const maxReceipts = typeof max === "string" ? Number(max) : DEFAULT_MAX_RECEIPTS;
  if (seen.has("--apply")) {
    const confirm = seen.get("--confirm"), backupRef = seen.get("--backup-ref");
    if (typeof confirm !== "string" || !DIGEST.test(confirm) || typeof backupRef !== "string") throw new CliError("invalid-arguments");
    return { mode: "apply", output, tenant, maxReceipts, confirm, backupRef };
  }
  // A confirmation or a backup named without --apply is refused, so nobody reads a preview believing they applied it.
  if (seen.has("--confirm") || seen.has("--backup-ref")) throw new CliError("invalid-arguments");
  return { mode: "preview", output, tenant, maxReceipts };
}

// ── the chain transport ──────────────────────────────────────────────────────

const FEED = (CASH_FEEDS.ETH_USD as string).toLowerCase();
/** The three view calls this tool makes, by selector: decimals(), latestRoundData(), getRoundData(uint80). */
const FEED_SELECTORS = [
  encodeFunctionData({ abi: CHAINLINK_ABI, functionName: "decimals" }),
  encodeFunctionData({ abi: CHAINLINK_ABI, functionName: "latestRoundData" }),
].map((s) => s.toLowerCase());
const GET_ROUND = encodeFunctionData({ abi: CHAINLINK_ABI, functionName: "getRoundData", args: [0n] }).slice(0, 10).toLowerCase();

/**
 * THE ONLY WAY THIS TOOL TALKS TO A NODE: the chain id, receipts, block
 * headers, and three view calls on the ETH/USD feed at "latest" — refused
 * before anything leaves the process otherwise. A node's error text is never
 * printed.
 */
export function createRepairRpc(url: string, fetchImpl: typeof fetch = fetch): RpcCall {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new CliError("unsupported-rpc-url"); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new CliError("unsupported-rpc-url");
  let id = 0;
  return async (method, params) => {
    if (!["eth_chainId", "eth_getTransactionReceipt", "eth_getBlockByNumber", "eth_call"].includes(method)) throw new CliError("rpc-method-outside-read-allowlist");
    if (method === "eth_call") {
      const [call, tag, ...rest] = params as [Record<string, unknown> | undefined, unknown];
      const data = typeof call?.data === "string" ? call.data.toLowerCase() : "";
      const allowed = FEED_SELECTORS.includes(data) || (data.startsWith(GET_ROUND) && /^0x[0-9a-f]{72}$/.test(data));
      if (rest.length || !call || Object.keys(call).sort().join(",") !== "data,to" || String(call.to).toLowerCase() !== FEED || tag !== "latest" || !allowed) {
        throw new CliError("rpc-call-outside-read-allowlist");
      }
    }
    const requestId = ++id;
    const response = await fetchImpl(url, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
    });
    if (!response.ok) throw new CliError("rpc-unavailable");
    const body = (await response.json()) as { jsonrpc?: string; id?: number; result?: unknown; error?: unknown };
    if (body.error || body.jsonrpc !== "2.0" || body.id !== requestId || !Object.hasOwn(body, "result")) throw new CliError("rpc-read-failed");
    return body.result;
  };
}

/** The code that produced a preview, by file digest: an apply by different code recomputes a different digest and refuses. */
export function repairSourceFingerprint(here = path.dirname(fileURLToPath(import.meta.url))): Record<string, string> {
  const files = ["gas-repair.ts", "gas-repair-cli.ts", "gas-backfill.ts", "eth-feed.ts", "chain-gap-booking-cli.ts", "chain-gap-booking.ts", "db.ts"];
  return Object.fromEntries(files.map((f) => [f, createHash("sha256").update(readFileSync(path.resolve(here, f))).digest("hex")]));
}

// ── the run ──────────────────────────────────────────────────────────────────

export interface RepairDeps {
  connect?: (url: string, readOnly: boolean) => Promise<PgClient>;
  rpc?: RpcCall;
  nowMs?: () => number;
  out?: (line: string) => void;
  source?: Record<string, string>;
  repairId?: () => string;
}

async function computePlan(o: { tenant: string | null; maxReceipts: number }, url: string, deps: Required<Pick<RepairDeps, "connect" | "rpc">> & RepairDeps): Promise<GasRepairPlan> {
  const client = await deps.connect(url, true);
  let rows;
  try {
    rows = await pgClientDb(client, { readOnly: true }).tx((db) => readGasSnapshot(db, o.tenant ? { tenant: o.tenant } : {}));
  } finally {
    // Closed before the chain is read: no session stays open across the slow public reads.
    await client.end().catch(() => {});
  }
  return planGasRepair(rows, deps.rpc, { tenant: o.tenant, target: targetDigest(url), source: deps.source ?? repairSourceFingerprint(), maxReceipts: o.maxReceipts });
}

function sameDatabase(report: ApplyReport, url: string): void {
  if (report.target !== targetDigest(url)) {
    throw new GasRepairRefused("target", "the apply report was applied to another database (by host, port and name) than DATABASE_URL names: nothing was read or written");
  }
}

export async function main(args: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env, deps: RepairDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const say = (line: string) => { try { out(line); } catch { /* the CliError thrown next still says it */ } };
  const options = parseRepairArgs(args);
  if ("help" in options) { out(HELP); return 0; }
  const url = env.DATABASE_URL;
  if (!url) throw new CliError("database-url-required");
  targetDigest(url);
  const full = {
    ...deps,
    connect: deps.connect ?? ((u: string, readOnly: boolean) => connectBooking(u, readOnly, undefined, readOnly ? READ_APPLICATION_NAME : WRITE_APPLICATION_NAME)),
    rpc: deps.rpc ?? createRepairRpc(env.MERRYMEN_CHAIN_GAP_RPC || DEFAULT_RPC),
    nowMs: deps.nowMs ?? (() => Date.now()),
  };

  if (options.mode === "check" || options.mode === "revert") {
    let raw: string;
    try { raw = readFileSync(options.report, "utf8"); } catch { throw new CliError("report-unreadable"); }
    // An apply that died before its report was whole never sent its COMMIT:
    // the report is written in full and fsynced inside the transaction, first.
    try { JSON.parse(raw); } catch {
      throw new GasRepairRefused("report-unfinished", "the apply report is empty or cut short. If it is the --output of an apply that died, " +
        "that apply never sent its COMMIT, so nothing was written: preview again");
    }
    const report = parseApplyReport(raw);
    sameDatabase(report, url);
    if (options.mode === "check") {
      const client = await full.connect(url, true);
      let states: string[];
      try {
        states = await pgClientDb(client, { readOnly: true }).tx(async (db) => {
          const present = await db.prepare("SELECT to_regclass(?) AS t").get(REPAIRS_TABLE) as Record<string, unknown> | undefined;
          if (!present?.t) return [];
          return ((await db.prepare(`SELECT state FROM ${REPAIRS_TABLE} WHERE repair_id = ?`).all(report.repairId)) as Record<string, unknown>[]).map((r) => String(r.state));
        });
      } finally { await client.end().catch(() => {}); }
      const verdict = states.length === report.rows.length && states.every((s) => s === "applied") ? "committed"
        : states.length === report.rows.length && states.every((s) => s === "reverted") ? "reverted"
        : states.length === 0 ? "not-visible" : "mixed";
      const fd = createReportFile(options.output);
      finishReportFile(fd, options.output, { repairId: report.repairId, verdict, receipts: states.length, rows: report.rows.length, writesPerformed: 0 });
      out(verdict === "committed" ? `COMMITTED repair ${report.repairId}: ${states.length} receipt(s), its rows stand. Undo with ${SELF} --revert ${options.report} --output /absolute/new-revert-report.json`
        : verdict === "reverted" ? `REVERTED repair ${report.repairId}: nothing of it stands.`
        : verdict === "not-visible" ? `NO RECEIPTS for repair ${report.repairId}. The apply writes them in its one transaction, so it did not commit — unless that transaction is still open; check again in a minute, then preview again.`
        : `repair ${report.repairId}: receipts in more than one state, which no apply or revert leaves — escalate.`);
      return verdict === "mixed" ? 2 : 0;
    }
    const fd = createReportFile(options.output);
    let r;
    try {
      const client = await full.connect(url, false);
      try { r = await revertGasRepair(pgClientDb(client, { readOnly: false }), report, { nowMs: full.nowMs() }); }
      finally { await client.end().catch(() => {}); }
    } catch (e) {
      closeSync(fd); rmSync(options.output, { force: true });
      if (e instanceof CommitOutcomeUnknown) {
        say(`OUTCOME UNKNOWN for the revert of repair ${report.repairId}: run the same --revert again with a new --output; it says ALREADY REVERTED if this one committed.`);
        throw new CliError("revert-outcome-unknown");
      }
      if (conflictRolledBack(e)) throw new GasRepairRefused("conflict", "Postgres rolled the revert back for a conflict with another transaction: nothing was written — run it again");
      throw e;
    }
    // Committed: the revert stands whatever happens to its report or its console line now.
    const said = `${r.outcome === "reverted" ? "REVERTED" : "ALREADY REVERTED"} repair ${r.repairId}: ${r.rows.length} row(s)`;
    try { finishReportFile(fd, options.output, r); }
    catch {
      rmSync(options.output, { force: true });
      say(`${said}, but its report could not be written to ${options.output}: run the same --revert again with a new --output for one (it says ALREADY REVERTED)`);
      throw new CliError("reverted-but-report-not-written");
    }
    try { out(`${said}; report ${options.output}`); } catch { throw new CliError("reverted-but-not-printed"); }
    return 0;
  }

  if (options.mode === "preview") {
    const plan = await computePlan(options, url, full);
    const fd = createReportFile(options.output);
    finishReportFile(fd, options.output, { ...plan, mode: "preview", writesPerformed: 0 });
    for (const line of planLines(plan)) out(line);
    out(`PREVIEW ONLY — 0 database writes. The plan is in ${options.output}.`);
    return 0;
  }

  // APPLY: the report file first, and the repair id said before anything is read or written.
  const fd = createReportFile(options.output);
  let open = true;
  const close = () => { if (open) { open = false; closeSync(fd); } };
  const repairId = full.repairId?.() ?? randomUUID();
  out(`repair ${repairId}: its apply report is written to ${options.output} before the COMMIT is sent. ` +
    `If this process dies, see whether it committed with ${SELF} --check ${options.output} --output /absolute/new-check.json`);
  let report: ApplyReport;
  try {
    const plan = await computePlan(options, url, full);
    for (const line of planLines(plan)) out(line);
    const client = await full.connect(url, false);
    try {
      report = await applyGasRepair(pgClientDb(client, { readOnly: false }), plan, {
        confirm: options.confirm, backupRef: options.backupRef, repairId, nowMs: full.nowMs(),
        persist: (r) => { open = false; finishReportFile(fd, options.output, r); },
      });
    } finally { await client.end().catch(() => {}); }
  } catch (e) {
    if (e instanceof CommitOutcomeUnknown) {
      close();
      say(`OUTCOME UNKNOWN for repair ${repairId}: the COMMIT was sent and no answer proved it rolled back. Keep ${options.output}; ` +
        `${SELF} --check ${options.output} --output /absolute/new-check.json says whether it committed.`);
      throw new CliError("apply-outcome-unknown");
    }
    close();
    rmSync(options.output, { force: true });
    if (conflictRolledBack(e)) throw new GasRepairRefused("conflict", "Postgres rolled the apply back for a conflict with another transaction: nothing was written — run it again");
    throw e;
  }
  let finalized = true;
  try { replaceReportFile(options.output, stampCommitOutcome(report, "committed")); } catch { finalized = false; }
  say(`APPLIED repair ${report.repairId} — ${report.rows.length} row(s) under backup ${report.backupRef}; the apply report (what --revert takes) is ${options.output}.`);
  if (!finalized) {
    say(`  ${options.output} still says commitOutcome "unknown" and could not be marked "committed": the COMMIT was acknowledged and the receipts hold it.`);
    throw new CliError("applied-report-not-marked-committed");
  }
  return 0;
}

/** What the console may say about a failure: this tool's own refusal sentence, or a fixed code. */
export function failureLine(e: unknown): string {
  if (e instanceof BookingRefused) return `refused (${e.code}): ${e.message}`;
  if (e instanceof CliError) return `${e.code}. Use --help for invocation.`;
  return "gas-repair-failed: nothing was applied unless an APPLIED or an OUTCOME UNKNOWN line was printed. Use --help for invocation.";
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
