/**
 * ATTESTED-GAP ADMISSION: HOW A TENANT WITH HISTORY AND NO SURVIVING BOOK
 * TRADES AGAIN.
 *
 * THE SITUATION. A hosted tenant's SQLite book was never durable: every
 * redeploy rebuilt it, and Postgres (the mirror) was the record. The deploy
 * at 2026-10-04 03:18 UTC rebuilt every home over nothing, and the
 * continuity gate added since (orchestrator.ts ledgerSourceAllowsResume,
 * ledger-import.ts registerLedgerSource) refuses any new book for an account
 * Postgres already holds rows for. That is every tenant from before the
 * incident, so none of them could ever arm again. The last mirror pass had
 * covered all 44 tenants then, and no agent UserOp has landed since 01:36 that
 * day, so what Postgres holds is the whole book that matters.
 *
 * THE ANSWER, IN THREE PHASES, per tenant, only under an operator's approval
 * bound to evidence the operator was shown:
 *
 *   Preview (MERRYMEN_RESUME_PREVIEW): read-only. One JSON line per tenant
 *     with its evidence digest and every precondition, and a run digest over
 *     the whole set (recorded in ledger_resume_preview_runs).
 *   Approve (MERRYMEN_RESUME_APPROVE): `0x<tenant>:<digest>` for one tenant,
 *     or `run:<run digest>` for exactly the tenants that passed in that run.
 *     MERRYMEN_RESUME_REVOKE withdraws an approval not yet registered.
 *   Phase A (in spawnChild, under the lease): recompute the evidence — any
 *     change refuses — check every precondition, drain a continuous old book
 *     into Postgres if there is one, and move the home aside into
 *     archive/<tenant>/<generation> with its secrets scrubbed, carrying the
 *     owner's pause, kill requests and Telegram progress into the new home.
 *   Phase B (ledger-import.ts registerAttestedGapSource): in ONE transaction,
 *     archive and remove the lost book's cursors, archive the snapshot rows,
 *     create the empty book and its receipt, attest.
 *   Phase C: the ordinary spawn path, unchanged — the anchor (same accounting
 *     epoch: lifetime PnL continues from Postgres), the seeds, the owner's
 *     controls (recovery-reply-arm.ts), the privacy gate, the offset handoff,
 *     the source barrier, and the tenant's B1 rollout level.
 *
 * THE PRECONDITIONS, each of which refuses on its own and none of which fails
 * open (resumePreconditions, chainGapCheck):
 *
 *   1. No submitted, sent or pending trade (#258's receipt helper is not in
 *      this tree, so any such row refuses that tenant).
 *   2. Nothing on chain Postgres lacks: every UserOperationEvent and USDG
 *      Transfer touching the account, from the last mirror (and at least 26
 *      hours back) to head, is in Postgres. An RPC failure retries. A paper
 *      tenant with no live operation on record needs no chain read.
 *   3. Nothing settled in the last 26 hours, so the new book's in-flight
 *      reconciler finds nothing to re-record.
 *   4. The flows are free of duplicate copies (distinct-flows.ts).
 *   5. One agent_id spelling across the financial tables.
 *   6. An established accounting anchor, or "no prior accounting" with no
 *      financial rows at all.
 *   7. The risk period, if Postgres holds one, valid and readable under the
 *      grant's own spelling (so the anchor carries it). None at all is the
 *      lifetime-HWM breaker every agent ran on before the incident; the
 *      preview says which, and the approval binds it.
 *   8. The owner controls readable and not malformed.
 *   9. The grant unexpired, and its tenant, account, chain and owner the ones
 *      approved. A re-sign by the same owner on the same account still
 *      admits; a new account refuses.
 *
 * WHAT THIS NEVER DOES: write or change a financial row, import a trade,
 * loosen a cap (the empty 26-hour window means the rolling caps read exactly
 * what Postgres says), start a risk period, or write a key into an archive.
 * Any failure leaves the tenant held and the step resumable.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { createPublicClient, http, type Hex } from "viem";
import type { Db } from "./db";
import { fsyncDirSync, writeFileAtomicSync } from "./atomic-write";
import { deriveBootstrapAccounting } from "./bootstrap-source";
import { flowDuplicateReport } from "./distinct-flows";
import { ensureLedgerResumeSchema } from "./ledger-import";
import { validRiskPeriod, readRiskPeriod } from "./risk-period";
import { getLogsAdaptive, addressTopic, type RawLog } from "./inflight-reconcile";
import { CASH, ENTRYPOINT, chainForId } from "../../packages/core/src/index";

export const RESUME_PREVIEW_ENV = "MERRYMEN_RESUME_PREVIEW";
export const RESUME_APPROVE_ENV = "MERRYMEN_RESUME_APPROVE";
export const RESUME_REVOKE_ENV = "MERRYMEN_RESUME_REVOKE";

/** Written into the new home for the Telegram and Fomo answers: the gap, before trading resumed. */
export const RECOVERY_GENERATION_FILE = "recovery-generation.json";
/** The 26-hour window: the in-flight reconciler's widest claimed reach, and the rolling caps' day plus slack. */
export const GAP_WINDOW_SEC = 26 * 3600;
/** A clean chain read older than this is read again before the empty book is registered. */
export const CHAIN_CHECK_FRESH_MS = 15 * 60_000;
/** The most tenants one variable may name: the rollout's own bound. */
const MAX_NAMED = 512;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort) : typeof v === "bigint" ? String(v) : v !== null && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(value));
}
const refuseEnv = (name: string, why: string) => new Error(`${name} ${why}; refusing to start rather than guess which tenants it means`);

// ── the three operator variables ─────────────────────────────────────────────

export type ResumePreviewScope = { scope: "all" } | { scope: "list"; tenants: ReadonlySet<string> };
/** `all`, or a comma list of tenant addresses. Unset: no preview. Malformed refuses, naming the entry's position, never its text. */
export function parseResumePreview(raw: string | undefined): ResumePreviewScope | null {
  if (raw === undefined) return null;
  const v = raw.trim();
  if (v === "all") return { scope: "all" };
  const parts = v.split(",").map((p) => p.trim());
  if (parts.length > MAX_NAMED) throw refuseEnv(RESUME_PREVIEW_ENV, `names more than ${MAX_NAMED} tenants`);
  const tenants = new Set<string>();
  parts.forEach((p, i) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(p)) throw refuseEnv(RESUME_PREVIEW_ENV, `entry ${i + 1} is not all or a 0x tenant address`);
    tenants.add(p.toLowerCase());
  });
  return { scope: "list", tenants };
}

export type ResumeApproval = { kind: "tenant"; tenant: string; digest: string } | { kind: "run"; run: string };
/** `0x<tenant>:<64 hex>` and/or `run:<64 hex>`, comma separated. Unset: none. */
export function parseResumeApprovals(raw: string | undefined): ResumeApproval[] {
  if (raw === undefined) return [];
  const parts = raw.trim().split(",").map((p) => p.trim());
  if (parts.length > MAX_NAMED) throw refuseEnv(RESUME_APPROVE_ENV, `names more than ${MAX_NAMED} entries`);
  const out: ResumeApproval[] = [];
  const seen = new Set<string>();
  parts.forEach((p, i) => {
    const run = /^run:([0-9a-f]{64})$/.exec(p);
    const one = /^(0x[0-9a-fA-F]{40}):([0-9a-f]{64})$/.exec(p);
    if (!run && !one) throw refuseEnv(RESUME_APPROVE_ENV, `entry ${i + 1} is not 0x<tenant>:<evidence digest> or run:<preview run digest>`);
    const key = run ? `run:${run[1]}` : one![1]!.toLowerCase();
    if (seen.has(key)) throw refuseEnv(RESUME_APPROVE_ENV, `entry ${i + 1} repeats an earlier entry`);
    seen.add(key);
    out.push(run ? { kind: "run", run: run[1]! } : { kind: "tenant", tenant: one![1]!.toLowerCase(), digest: one![2]! });
  });
  return out;
}

/** A comma list of tenant addresses whose open, not yet registered, approval is withdrawn. */
export function parseResumeRevokes(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const parts = raw.trim().split(",").map((p) => p.trim());
  if (parts.length > MAX_NAMED) throw refuseEnv(RESUME_REVOKE_ENV, `names more than ${MAX_NAMED} tenants`);
  return parts.map((p, i) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(p)) throw refuseEnv(RESUME_REVOKE_ENV, `entry ${i + 1} is not a 0x tenant address`);
    return p.toLowerCase();
  });
}

// ── evidence ─────────────────────────────────────────────────────────────────

/** Files whose presence in a home is part of its identity: every barrier, hold and owner control the spawn path reads. */
const HOME_MARKERS = [
  "ledger-source-blocked.json", "ledger-import.pending.json", "restore-blocked.json", "energy-unrestored.json",
  "budget-unrestored.json", "paused", "controls-armed.json", "recovery-command-barrier.json", "telegram-held-groups.json",
  RECOVERY_GENERATION_FILE,
] as const;

export interface HomeIdentity {
  exists: boolean;
  dev?: string; ino?: string;
  /** The main book only: -wal and -shm, and every mtime, change without the book changing. */
  db?: { dev: string; ino: string; size: string } | null;
  markers?: string[];
}

/** What is in a home, as the evidence binds it. Never opens the book. */
export function homeIdentity(home: string): HomeIdentity {
  let st;
  try { st = lstatSync(home, { bigint: true }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { exists: false }; throw e; }
  if (!st.isDirectory()) throw new Error("a tenant home is not a plain directory");
  let db: HomeIdentity["db"] = null;
  try {
    const d = lstatSync(path.join(home, "merrymen.db"), { bigint: true });
    if (!d.isFile()) throw new Error("a tenant book is not a plain file");
    db = { dev: String(d.dev), ino: String(d.ino), size: String(d.size) };
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const names = readdirSync(home);
  const markers = names.filter((n) => (HOME_MARKERS as readonly string[]).includes(n) || n.startsWith("kill-request-")).sort();
  return { exists: true, dev: String(st.dev), ino: String(st.ino), db, markers };
}

const n = (v: unknown): string => (v === null || v === undefined ? "null" : String(Number(v)));
const LOG_SUMMARY = ["trades", "flows", "equity", "fee_accruals"] as const;
const SNAPSHOT_SUMMARY = ["positions", "cost_basis", "position_floors", "trench_positions", "class_positions", "paper_checkpoints", "risk_periods"] as const;
/** The tables whose rows make a book "have history". `trades` counts only rows that are not a refusal. */
const FINANCIAL = ["flows", "equity", "fee_accruals", "positions", "cost_basis", "position_floors", "class_positions", "paper_checkpoints"] as const;

async function snapshotDigest(db: Db, table: string, account: string): Promise<{ n: number; digest: string } | "absent"> {
  try {
    const rows = (await db.prepare(`SELECT * FROM ${table} WHERE LOWER(agent_id) = ?`).all(account) as Array<Record<string, unknown>>)
      .map((r) => canonical(r)).sort();
    return { n: rows.length, digest: hash(rows.join("\n")) };
  } catch (e) {
    if (/no such table|does not exist|42P01/.test(`${(e as { code?: unknown }).code ?? ""} ${(e as Error).message}`)) return "absent";
    throw e;
  }
}

/**
 * THE POSTGRES HALF OF THE EVIDENCE: what the tenant's books say, the lost
 * book's cursors, the staged-import state, and the anchor and risk-period
 * verdicts. Never the grant's incarnation (updated_at, row version): a
 * re-sign by the same owner on the same account keeps the approval. Counts,
 * maxima and digests rather than rows: a settlement that changes a status in
 * place changes `trades.byStatus`, and anything appended changes a maximum.
 */
export async function readPgEvidence(db: Db, o: { tenant: string; account: string; nowSec: number }) {
  const account = o.account.toLowerCase();
  const agent = (await db.prepare("SELECT epoch, hwm_usdg, hwm_withdrawn_usdg, accrued_fee_usdg, mode FROM agents WHERE LOWER(smart_account) = ?").get(account)) as
    Record<string, unknown> | undefined;
  const tables: Record<string, unknown> = {};
  for (const table of LOG_SUMMARY) {
    const row = (await db.prepare(`SELECT COUNT(*) AS n, MAX(id) AS max_id FROM ${table} WHERE LOWER(agent_id) = ?`).get(account)) as Record<string, unknown>;
    tables[table] = { n: n(row.n), maxId: n(row.max_id) };
  }
  tables.tradesByStatus = ((await db.prepare("SELECT status, COUNT(*) AS n FROM trades WHERE LOWER(agent_id) = ? GROUP BY status ORDER BY status").all(account)) as
    Array<Record<string, unknown>>).map((r) => [String(r.status), n(r.n)]);
  const net = (await db.prepare("SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net FROM flows WHERE LOWER(agent_id) = ?").get(account)) as Record<string, unknown>;
  tables.flowsNet = Number(net.net).toFixed(6);
  for (const table of SNAPSHOT_SUMMARY) tables[table] = await snapshotDigest(db, table, account);
  const mirrorState = ((await db.prepare("SELECT table_name, last_id, last_stamp FROM mirror_state WHERE tenant = ? ORDER BY table_name").all(o.tenant.toLowerCase())) as
    Array<Record<string, unknown>>).map((r) => [String(r.table_name), n(r.last_id), n(r.last_stamp)]);
  let ledgerImport: unknown = null;
  try {
    const row = (await db.prepare("SELECT state, generation FROM tenant_ledger_import WHERE tenant = ?").get(o.tenant.toLowerCase())) as Record<string, unknown> | undefined;
    ledgerImport = row ? { state: String(row.state), generation: String(row.generation) } : null;
  } catch (e) {
    if (!/no such table|does not exist|42P01/.test(`${(e as { code?: unknown }).code ?? ""} ${(e as Error).message}`)) throw e;
  }
  return {
    agent: agent ? { epoch: n(agent.epoch), hwm: Number(agent.hwm_usdg ?? 0).toFixed(6), hwmWithdrawn: Number(agent.hwm_withdrawn_usdg ?? 0).toFixed(6),
      accruedFee: Number(agent.accrued_fee_usdg ?? 0).toFixed(6), mode: agent.mode === null || agent.mode === undefined ? null : String(agent.mode) } : null,
    tables, mirrorState, ledgerImport,
  };
}

export interface ResumeEvidence {
  version: 1;
  tenant: string; account: string; chainId: number; owner: string;
  pg: Awaited<ReturnType<typeof readPgEvidence>>;
  checks: { anchor: string; riskPeriod: string; controls: string; unresolved: number };
  home: HomeIdentity;
}
export const evidenceDigest = (e: ResumeEvidence): string => hash(canonical(e));

// ── preconditions ────────────────────────────────────────────────────────────

export interface ResumeCheck {
  refusals: string[];
  /** A paper tenant with no live operation on record: no chain read is needed. */
  paper: boolean;
  chainRequired: boolean;
  holdsPositions: boolean;
  /** decision 6: paper tenants may trade once the canary has; live tenants holding positions start exits-only. */
  suggestedLevel: "trade" | "exits-only";
  anchor: string;
  riskPeriod: string;
  unresolved: number;
  /** From where the chain is read: the last mirror pass, and at least 26 hours back. */
  gapFromSec: number;
  lastMirrorAt: number | null;
}

const SETTLED_EXCLUDED = ["paper", "rejected", "submitted", "sent", "pending"];
/**
 * EVERY PRECONDITION THAT POSTGRES ALONE CAN ANSWER, for one tenant, now.
 * Read-only. Each refusal is its own sentence, so a preview line says every
 * reason at once and the operator fixes them together.
 */
export async function resumePreconditions(db: Db, o: {
  tenant: string; account: string; grantAccount: string; nowSec: number;
  controls: { readable: boolean; why: string | null };
  homePendingImport: boolean;
}): Promise<ResumeCheck> {
  const account = o.account.toLowerCase(), refusals: string[] = [];
  if (!o.controls.readable) refusals.push(`owner controls cannot be read (${o.controls.why ?? "unreadable"})`);
  const unresolved = Number(((await db.prepare("SELECT COUNT(*) AS n FROM trades WHERE LOWER(agent_id) = ? AND status IN ('submitted', 'sent', 'pending')").get(account)) as Record<string, unknown>).n);
  if (unresolved > 0) refusals.push(`${unresolved} submitted/sent/pending trade(s) without a proven terminal receipt`);
  const holes = SETTLED_EXCLUDED.map(() => "?").join(", ");
  const settled = Number(((await db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE LOWER(agent_id) = ? AND status NOT IN (${holes})
      AND COALESCE(budget_settled_at, created_at) > ?`).get(account, ...SETTLED_EXCLUDED, o.nowSec - GAP_WINDOW_SEC)) as Record<string, unknown>).n);
  if (settled > 0) refusals.push(`${settled} operation(s) settled within the last 26h`);
  const agent = (await db.prepare("SELECT mode FROM agents WHERE LOWER(smart_account) = ?").get(account)) as Record<string, unknown> | undefined;
  const flowCount = Number(((await db.prepare("SELECT COUNT(*) AS n FROM flows WHERE LOWER(agent_id) = ?").get(account)) as Record<string, unknown>).n);
  if (agent) {
    const report = await flowDuplicateReport(db, account);
    if (!report.clean) refusals.push("the flows hold duplicate or conflicting copies (distinct-flows report)");
  } else if (flowCount > 0) refusals.push("flows are on record with no agent registration to name their run");
  // ONE SPELLING. Every financial row, and the registration, under one exact string.
  const spellings = new Set<string>();
  for (const table of ["trades", ...FINANCIAL, "risk_periods"]) {
    try {
      for (const r of (await db.prepare(`SELECT DISTINCT agent_id FROM ${table} WHERE LOWER(agent_id) = ?`).all(account)) as Array<Record<string, unknown>>) spellings.add(String(r.agent_id));
    } catch (e) {
      if (!/no such table|does not exist|42P01/.test(`${(e as { code?: unknown }).code ?? ""} ${(e as Error).message}`)) throw e;
    }
  }
  if (spellings.size > 1) refusals.push(`agent_id is spelled ${spellings.size} ways across the financial tables`);
  // THE ANCHOR, as writeBootstrapForChild will derive it.
  const accounting = await deriveBootstrapAccounting(db, account, o.nowSec);
  let financialRows = Number(((await db.prepare("SELECT COUNT(*) AS n FROM trades WHERE LOWER(agent_id) = ? AND status <> 'rejected'").get(account)) as Record<string, unknown>).n);
  for (const table of FINANCIAL) {
    try { financialRows += Number(((await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE LOWER(agent_id) = ?`).get(account)) as Record<string, unknown>).n); }
    catch (e) { if (!/no such table|does not exist|42P01/.test(`${(e as { code?: unknown }).code ?? ""} ${(e as Error).message}`)) throw e; }
  }
  if (accounting.kind === "unknown") refusals.push("the accounting anchor cannot be derived");
  if (accounting.kind === "no-prior-accounting" && financialRows > 0) refusals.push(`no accounting anchor, yet ${financialRows} financial row(s) are on record`);
  const anchor = accounting.kind === "established" ? `established:epoch-${accounting.accountingEpoch}` : accounting.kind;
  // THE RISK PERIOD, as the anchor will carry it: by the grant's own spelling.
  let riskPeriod = "none";
  try {
    const any = (await db.prepare("SELECT * FROM risk_periods WHERE LOWER(agent_id) = ? ORDER BY started_at DESC LIMIT 1").get(account)) as Record<string, unknown> | undefined;
    if (any) {
      const carried = await readRiskPeriod(db, o.grantAccount).catch(() => null);
      if (!validRiskPeriod(any, account) || !carried || carried.id !== any.id) {
        riskPeriod = "invalid";
        refusals.push("the risk period on record is invalid, or the anchor could not carry it under the grant's spelling");
      } else riskPeriod = `valid:${carried.id}`;
    }
  } catch (e) {
    if (!/no such table|does not exist|42P01/.test(`${(e as { code?: unknown }).code ?? ""} ${(e as Error).message}`)) throw e;
  }
  try {
    const staged = (await db.prepare("SELECT state FROM tenant_ledger_import WHERE tenant = ?").get(o.tenant.toLowerCase())) as Record<string, unknown> | undefined;
    if (staged?.state === "available") refusals.push("an original-book import is staged for this tenant");
  } catch (e) {
    if (!/no such table|does not exist|42P01/.test(`${(e as { code?: unknown }).code ?? ""} ${(e as Error).message}`)) throw e;
  }
  if (o.homePendingImport) refusals.push("an original-book import is half-applied in the home");
  // PAPER, LIVE, POSITIONS.
  const liveOps = Number(((await db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE LOWER(agent_id) = ?
      AND ((user_op_hash IS NOT NULL AND user_op_hash <> '') OR status IN ('landed', 'submitted', 'sent', 'pending', 'reverted', 'dropped'))`).get(account)) as Record<string, unknown>).n);
  const paper = agent?.mode === "paper" && liveOps === 0;
  const held = Number(((await db.prepare("SELECT COUNT(*) AS n FROM positions WHERE LOWER(agent_id) = ? AND raw_balance <> '0'").get(account)) as Record<string, unknown>).n);
  let classHeld = 0;
  try { classHeld = Number(((await db.prepare("SELECT COUNT(*) AS n FROM class_positions WHERE LOWER(agent_id) = ? AND COALESCE(state, '') <> 'closed'").get(account)) as Record<string, unknown>).n); }
  catch (e) { if (!/no such table|does not exist|42P01/.test(`${(e as { code?: unknown }).code ?? ""} ${(e as Error).message}`)) throw e; }
  const lastMirror = (await db.prepare("SELECT MAX(updated_at) AS at FROM mirror_state WHERE tenant = ?").get(o.tenant.toLowerCase())) as Record<string, unknown> | undefined;
  let lastMirrorAt = lastMirror?.at === null || lastMirror?.at === undefined ? null : Number(lastMirror.at);
  if (lastMirrorAt !== null && lastMirrorAt > 1e12) lastMirrorAt = Math.floor(lastMirrorAt / 1000);
  const gapFromSec = Math.min(lastMirrorAt ?? o.nowSec, o.nowSec - GAP_WINDOW_SEC) - 600;
  return {
    refusals, paper, chainRequired: !paper, holdsPositions: held + classHeld > 0,
    suggestedLevel: paper ? "trade" : "exits-only", anchor, riskPeriod, unresolved, gapFromSec, lastMirrorAt,
  };
}

/** The evidence and the preconditions together, as the preview prints them and Phase A recomputes them. */
export async function readResumeEvidence(db: Db, o: {
  tenant: string; grant: { smartAccount: string; chainId: number; owner: string }; home: string; nowSec: number;
  controls: { readable: boolean; why: string | null; digest: string };
}): Promise<{ evidence: ResumeEvidence; digest: string; check: ResumeCheck }> {
  const tenant = o.tenant.toLowerCase(), account = o.grant.smartAccount.toLowerCase();
  const home = homeIdentity(o.home);
  const check = await resumePreconditions(db, {
    tenant, account, grantAccount: o.grant.smartAccount, nowSec: o.nowSec, controls: o.controls,
    homePendingImport: home.markers?.includes("ledger-import.pending.json") ?? false,
  });
  const evidence: ResumeEvidence = {
    version: 1, tenant, account, chainId: o.grant.chainId, owner: o.grant.owner.toLowerCase(),
    pg: await readPgEvidence(db, { tenant, account, nowSec: o.nowSec }),
    checks: { anchor: check.anchor, riskPeriod: check.riskPeriod, controls: o.controls.digest, unresolved: check.unresolved },
    home,
  };
  return { evidence, digest: evidenceDigest(evidence), check };
}

/** One tenant's line in a preview run. Nonsecret: addresses, digests, verdicts. */
export interface PreviewEntry {
  tenant: string; account: string | null; chainId: number | null; owner: string | null;
  digest: string | null; pass: boolean; refusals: string[];
  chain: "required" | "not-required" | null; suggestedLevel: "trade" | "exits-only" | null;
  anchor: string | null; riskPeriod: string | null; home: "absent" | "present" | null; lastMirrorAt: number | null;
  evidence: ResumeEvidence | null;
}
/** The run's digest: what an approval of the whole run binds to. */
export const previewRunDigest = (entries: readonly PreviewEntry[]): string =>
  hash(canonical(entries.map((e) => [e.tenant, e.digest, e.pass])));

export async function recordPreviewRun(db: Db, entries: readonly PreviewEntry[], nowMs: number): Promise<string> {
  await ensureLedgerResumeSchema(db);
  const run = previewRunDigest(entries);
  await db.prepare("INSERT INTO ledger_resume_preview_runs (run, created_at_ms, entries_json) VALUES (?, ?, ?) ON CONFLICT (run) DO NOTHING")
    .run(run, nowMs, canonical(entries));
  return run;
}

/** The line the log prints for one entry: everything but the full evidence, which the run row keeps. */
export function previewLine(e: PreviewEntry): string {
  const { evidence: _evidence, ...line } = e;
  return `[resume-preview] ${JSON.stringify(line)}`;
}

// ── approvals ────────────────────────────────────────────────────────────────

export type ApprovalState = "approved" | "archiving" | "archived" | "registered" | "applied" | "refused" | "revoked";
export interface ApprovalRow {
  approvalId: string; tenant: string; smartAccount: string; chainId: number; owner: string;
  evidenceDigest: string; evidence: ResumeEvidence; previewRun: string; state: ApprovalState;
  generation: string | null; archivePath: string | null;
}
const OPEN_STATES = ["approved", "archiving", "archived", "registered"] as const;

function approvalOf(r: Record<string, unknown>): ApprovalRow {
  return {
    approvalId: String(r.approval_id), tenant: String(r.tenant), smartAccount: String(r.smart_account), chainId: Number(r.chain_id),
    owner: String(r.owner), evidenceDigest: String(r.evidence_digest), evidence: JSON.parse(String(r.evidence_json)) as ResumeEvidence,
    previewRun: String(r.preview_run), state: String(r.state) as ApprovalState,
    generation: r.generation === null || r.generation === undefined ? null : String(r.generation),
    archivePath: r.archive_path === null || r.archive_path === undefined ? null : String(r.archive_path),
  };
}

/** The tenant's one open approval, or null. A missing table is none: nothing was ever approved. */
export async function readOpenApproval(db: Db, tenant: string): Promise<ApprovalRow | null> {
  try {
    const row = (await db.prepare(`SELECT * FROM ledger_resume_approvals WHERE tenant = ? AND state IN ('approved', 'archiving', 'archived', 'registered')`)
      .get(tenant.toLowerCase())) as Record<string, unknown> | undefined;
    return row ? approvalOf(row) : null;
  } catch (e) {
    if (/no such table|does not exist|42P01/.test(`${(e as { code?: unknown }).code ?? ""} ${(e as Error).message}`)) return null;
    throw e;
  }
}

/** Tenants whose approval has not reached the new book yet: reconcile admits their blocked homes to spawnChild, and no others. */
export async function readPreRegistrationTenants(db: Db): Promise<Set<string>> {
  try {
    const rows = (await db.prepare("SELECT tenant FROM ledger_resume_approvals WHERE state IN ('approved', 'archiving', 'archived')").all()) as Array<Record<string, unknown>>;
    return new Set(rows.map((r) => String(r.tenant)));
  } catch (e) {
    if (/no such table|does not exist|42P01/.test(`${(e as { code?: unknown }).code ?? ""} ${(e as Error).message}`)) return new Set();
    throw e;
  }
}

/** One state move, conditional on the state it was read in. Returns whether it moved. */
export async function moveApproval(db: Db, approvalId: string, from: ApprovalState, to: ApprovalState,
  fields: { generation?: string; archivePath?: string | null; reason?: string } = {}, nowMs = Date.now()): Promise<boolean> {
  const sets = ["state = ?", "updated_at_ms = ?"], args: unknown[] = [to, nowMs];
  if (fields.generation !== undefined) { sets.push("generation = ?"); args.push(fields.generation); }
  if (fields.archivePath !== undefined) { sets.push("archive_path = ?"); args.push(fields.archivePath); }
  if (fields.reason !== undefined) { sets.push("reason = ?"); args.push(fields.reason.slice(0, 500)); }
  const r = await db.prepare(`UPDATE ledger_resume_approvals SET ${sets.join(", ")} WHERE approval_id = ? AND state = ?`).run(...args, approvalId, from);
  return r.changes === 1;
}

/**
 * RECORD THE OPERATOR'S APPROVALS. Each binds one tenant to one evidence
 * digest the preview printed AND passed: a per-tenant entry must name a digest
 * some recorded run showed passing, and a run entry approves exactly the
 * tenants that passed in that run, no more. Idempotent across boots: an
 * approval is unique per (tenant, digest), so a variable left set never
 * approves the same evidence twice, and never reopens one that was applied,
 * refused or revoked. A tenant with a different approval open is refused here
 * (revoke it first); one per tenant is enforced by the table as well.
 */
export async function applyResumeApprovals(db: Db, approvals: readonly ResumeApproval[], nowMs: number, log: (line: string) => void): Promise<number> {
  if (!approvals.length) return 0;
  await ensureLedgerResumeSchema(db);
  const runs = ((await db.prepare("SELECT run, entries_json FROM ledger_resume_preview_runs ORDER BY created_at_ms DESC LIMIT 200").all()) as Array<Record<string, unknown>>)
    .map((r) => ({ run: String(r.run), entries: JSON.parse(String(r.entries_json)) as PreviewEntry[] }));
  const wanted: Array<{ entry: PreviewEntry; run: string }> = [];
  for (const a of approvals) {
    if (a.kind === "run") {
      const run = runs.find((r) => r.run === a.run);
      if (!run) { log(`[alert] resume approval: no recorded preview run ${a.run.slice(0, 12)}… — nothing approved from it; run the preview first`); continue; }
      for (const entry of run.entries) if (entry.pass && entry.digest && entry.evidence) wanted.push({ entry, run: run.run });
      continue;
    }
    const found = runs.flatMap((r) => r.entries.map((entry) => ({ entry, run: r.run })))
      .find((x) => x.entry.tenant === a.tenant && x.entry.digest === a.digest && x.entry.pass && x.entry.evidence);
    if (!found) { log(`[alert] resume approval: ${a.tenant} — no recorded preview run shows that digest passing; not approved`); continue; }
    wanted.push(found);
  }
  let added = 0;
  for (const { entry, run } of wanted) {
    const existing = (await db.prepare("SELECT state FROM ledger_resume_approvals WHERE tenant = ? AND evidence_digest = ?").get(entry.tenant, entry.digest)) as Record<string, unknown> | undefined;
    if (existing) continue;
    const open = await readOpenApproval(db, entry.tenant);
    if (open) { log(`[alert] resume approval: ${entry.tenant} already has an open approval (${open.state}) for other evidence — revoke it first; not approved`); continue; }
    const e = entry.evidence!;
    try {
      await db.prepare(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run,
          state, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?)`)
        .run(randomUUID(), entry.tenant, e.account, e.chainId, e.owner, entry.digest, canonical(e), run, nowMs, nowMs);
      added += 1;
      log(`resume approval: ${entry.tenant} approved for evidence ${entry.digest!.slice(0, 12)}… (preview run ${run.slice(0, 12)}…)`);
    } catch {
      log(`[alert] resume approval: ${entry.tenant} could not be recorded (another approval is open, or the store refused) — not approved`);
    }
  }
  return added;
}

/** Withdraw an approval that has not reached the new book. A registered one is past this point: the rollout scope is what stops it. */
export async function revokeResumeApprovals(db: Db, tenants: readonly string[], nowMs: number, log: (line: string) => void): Promise<void> {
  if (!tenants.length) return;
  await ensureLedgerResumeSchema(db);
  for (const tenant of tenants) {
    const r = await db.prepare(`UPDATE ledger_resume_approvals SET state = 'revoked', reason = 'revoked by the operator', updated_at_ms = ?
      WHERE tenant = ? AND state IN ('approved', 'archived')`).run(nowMs, tenant);
    if (r.changes) log(`resume approval: ${tenant} revoked — the tenant stays held`);
    else {
      const open = await readOpenApproval(db, tenant);
      log(open ? `[alert] resume revoke: ${tenant} is ${open.state} — past the point a revoke undoes; narrow ${"MERRYMEN_FLEET_ROLLOUT"} instead` : `resume revoke: ${tenant} has no open approval`);
    }
  }
}

// ── the chain ────────────────────────────────────────────────────────────────

/** The slice of a chain client the gap check reads. A fake stands in for it in tests. */
export interface GapChain {
  getBlockNumber(): Promise<bigint>;
  getBlockTimestamp(block: bigint): Promise<number>;
  getLogs(args: { address: `0x${string}`; fromBlock: bigint; toBlock: bigint; topics: (Hex | Hex[] | null)[] }): Promise<RawLog[]>;
}
export type GapResult =
  | { status: "clean"; fromBlock: string; head: string; ops: number; transfers: number }
  | { status: "missing"; ops: number; transfers: number }
  | { status: "unavailable"; why: string };

const USEROP_TOPIC = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f" as Hex;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
/** This chain runs near ten blocks a second (index.ts BLOCKS_PER_SEC); the estimate is checked against a timestamp before it is trusted. */
const BLOCKS_PER_SEC_GUESS = 12n;

/**
 * IS THERE ANYTHING ON CHAIN FOR THIS ACCOUNT THAT POSTGRES DOES NOT HOLD?
 *
 * From `sinceSec` (the last mirror pass, and at least 26 hours back) to head:
 * every EntryPoint UserOperationEvent this account sent must be a trade row
 * Postgres holds (by userOpHash), and every USDG Transfer from or to it must
 * be a flow Postgres holds (tx hash and log index) or a leg of a trade it
 * holds (tx hash). Anything else is activity the new book would never learn
 * of — an operation the rolling caps would not count, or a deposit a later
 * mark would read as profit — and refuses.
 *
 * The starting block is found from the chain's own timestamps, never assumed:
 * an estimate is stepped back until its block is dated at or before
 * `sinceSec`. Any read that cannot complete is `unavailable`, which retries;
 * a window that was not fully read is never "clean".
 */
export async function chainGapCheck(o: {
  chain: GapChain; account: string; usdg: string; sinceSec: number;
  known: { ops: ReadonlySet<string>; txs: ReadonlySet<string>; flows: ReadonlySet<string> };
  maxSpan?: bigint; log?: (line: string) => void;
}): Promise<GapResult> {
  try {
    const head = await o.chain.getBlockNumber();
    const headAt = await o.chain.getBlockTimestamp(head);
    let back = BigInt(Math.max(0, headAt - o.sinceSec)) * BLOCKS_PER_SEC_GUESS + 1000n;
    let from = head > back ? head - back : 0n;
    for (let i = 0; from > 0n && (await o.chain.getBlockTimestamp(from)) > o.sinceSec; i++) {
      if (i >= 8) return { status: "unavailable", why: "could not find a block old enough to start from" };
      back *= 2n;
      from = head > back ? head - back : 0n;
    }
    const span = o.maxSpan ?? 50_000n;
    const account = addressTopic(o.account);
    // The adaptive reader's own chain shape; it never asks for a receipt here.
    const reader = { getBlockNumber: () => o.chain.getBlockNumber(), getLogs: (a: Parameters<GapChain["getLogs"]>[0]) => o.chain.getLogs(a), getReceiptLogs: async () => null };
    const ops = await getLogsAdaptive(reader, { address: ENTRYPOINT.v07 as `0x${string}`, topics: [USEROP_TOPIC, null, account] }, from, head, span, o.log);
    const out = await getLogsAdaptive(reader, { address: o.usdg as `0x${string}`, topics: [TRANSFER_TOPIC, account] }, from, head, span, o.log);
    const into = await getLogsAdaptive(reader, { address: o.usdg as `0x${string}`, topics: [TRANSFER_TOPIC, null, account] }, from, head, span, o.log);
    if (!ops.complete || !out.complete || !into.complete) return { status: "unavailable", why: "the log read did not cover the whole window" };
    let missingOps = 0, missingTransfers = 0;
    // The transactions of operations Postgres holds: a USDG leg inside one is
    // that operation's, booked with it, even where its row kept no tx hash.
    const bookedTxs = new Set<string>();
    for (const l of ops.logs) {
      const opHash = String(l.topics[1] ?? "").toLowerCase();
      if (!o.known.ops.has(opHash)) missingOps += 1;
      else bookedTxs.add(String(l.transactionHash).toLowerCase());
    }
    for (const l of [...out.logs, ...into.logs]) {
      const tx = String(l.transactionHash).toLowerCase();
      const index = l.logIndex === undefined ? null : Number(BigInt(l.logIndex));
      if (o.known.txs.has(tx) || bookedTxs.has(tx)) continue;
      if (index !== null && o.known.flows.has(`${tx}:${index}`)) continue;
      missingTransfers += 1;
    }
    if (missingOps || missingTransfers) return { status: "missing", ops: missingOps, transfers: missingTransfers };
    return { status: "clean", fromBlock: String(from), head: String(head), ops: ops.logs.length, transfers: out.logs.length + into.logs.length };
  } catch (e) {
    const kind = e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "Error";
    return { status: "unavailable", why: `the chain could not be read (${kind})` };
  }
}

/** What Postgres holds for the account that a chain log could be: trade hashes, trade transactions, flow logs. */
export async function knownChainFacts(db: Db, account: string): Promise<{ ops: Set<string>; txs: Set<string>; flows: Set<string> }> {
  const a = account.toLowerCase();
  const trades = (await db.prepare("SELECT user_op_hash, tx_hash FROM trades WHERE LOWER(agent_id) = ? AND (user_op_hash IS NOT NULL OR tx_hash IS NOT NULL)").all(a)) as
    Array<Record<string, unknown>>;
  const flows = (await db.prepare("SELECT tx_hash, log_index FROM flows WHERE LOWER(agent_id) = ? AND tx_hash IS NOT NULL").all(a)) as Array<Record<string, unknown>>;
  const ops = new Set<string>(), txs = new Set<string>(), fl = new Set<string>();
  for (const t of trades) {
    if (typeof t.user_op_hash === "string" && t.user_op_hash) ops.add(t.user_op_hash.toLowerCase());
    if (typeof t.tx_hash === "string" && t.tx_hash) txs.add(t.tx_hash.toLowerCase());
  }
  for (const f of flows) if (typeof f.tx_hash === "string" && f.log_index !== null && f.log_index !== undefined) fl.add(`${f.tx_hash.toLowerCase()}:${Number(f.log_index)}`);
  return { ops, txs, flows: fl };
}

/** The production chain client, or null when this orchestrator has no RPC for the chain (the check then cannot pass). */
export function resumeChainFor(chainId: number, env: NodeJS.ProcessEnv = process.env): GapChain | null {
  const url = chainId === 46630 ? env.MERRYMEN_RPC_TESTNET : env.MERRYMEN_RPC_MAINNET;
  if (!url) return null;
  const client = createPublicClient({ chain: chainForId(chainId), transport: http(url, { timeout: 20_000 }) });
  return {
    getBlockNumber: () => client.getBlockNumber(),
    async getBlockTimestamp(block) { return Number((await client.getBlock({ blockNumber: block })).timestamp); },
    async getLogs(a) {
      return (await client.request({
        method: "eth_getLogs",
        params: [{ address: a.address, fromBlock: `0x${a.fromBlock.toString(16)}`, toBlock: `0x${a.toBlock.toString(16)}`, topics: a.topics }],
      } as never)) as RawLog[];
    },
  };
}
export const RESUME_USDG = String(CASH.USDG);

// ── phase A: the home ────────────────────────────────────────────────────────

/** Moved from the old home into the new one, never left in the archive: the owner's Telegram progress and link record. */
const CARRY_MOVE = ["telegram.json", "telegram-promoted.json"] as const;
/** Copied: the owner's restrictive controls, which stay in the archive as evidence too. */
const CARRY_COPY = ["paused", "controls-armed.json"] as const;
/** Removed before the home is archived: keys and secrets, all rewritten at the next spawn from the stores. */
const SCRUB = ["grant.json", "grants", "settings.json"] as const;
const MANIFEST = ".archive-manifest.json";

function syncDir(dir: string): void { fsyncDirSync(dir); }
function syncFile(file: string): void {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function walk(dir: string, rel = ""): Array<{ path: string; type: "file" | "dir" | "other"; size: string; mode: string }> {
  const out: Array<{ path: string; type: "file" | "dir" | "other"; size: string; mode: string }> = [];
  for (const name of readdirSync(dir).sort()) {
    if (rel === "" && name === MANIFEST) continue;
    const full = path.join(dir, name), st = lstatSync(full, { bigint: true }), p = rel ? `${rel}/${name}` : name;
    const type = st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    out.push({ path: p, type, size: String(st.size), mode: (Number(st.mode) & 0o7777).toString(8) });
    if (type === "dir") out.push(...walk(full, p));
  }
  return out;
}

export interface ArchiveResult { archivePath: string | null; carried: string[] }

/**
 * MOVE A TENANT'S HOME ASIDE, WHOLE, AND LEAVE THE NEXT ONE WHAT IT MUST KEEP.
 *
 * Under the tenant's lease, with no child or hold process for it (spawnChild
 * guarantees both), so nothing is writing here. In order, each step durable
 * before the next, and every step safe to repeat after a crash:
 *
 *  1. Stage the carry beside the archive: copies of the owner's pause and
 *     arm record, every kill-request file (pending and superseded: they name
 *     the grants that were killed), the Telegram state and its promotion
 *     record. Rebuilt from the home on every attempt until the rename.
 *  2. Scrub the home: grant.json (the session key), grants/ (archived keys),
 *     settings.json (bot token and provider keys), and the moved Telegram
 *     files. Each is rewritten by the next spawn from its store, so nothing
 *     is lost and no key ever enters the archive.
 *  3. Rename the home to archive/<tenant>/<generation> (0700) in one step on
 *     the same volume, and sync both parents.
 *  4. Write the archive's manifest (0600): every file's path, type, size and
 *     mode — stats, not contents.
 *  5. Move the staged carry into a fresh 0700 home, never over a file already
 *     there.
 *
 * With no home at all there is nothing to archive, and the result says so.
 * The archive is never deleted by any code here.
 */
export function archiveTenantHome(o: { home: string; archiveRoot: string; generation: string; mayWrite: () => boolean }): ArchiveResult {
  const lost = () => new Error("Lost the tenant lease while archiving its home; the next pass resumes the archive.");
  const dest = path.join(o.archiveRoot, o.generation), stage = path.join(o.archiveRoot, `.carry-${o.generation}`);
  if (!o.mayWrite()) throw lost();
  if (!existsSync(dest)) {
    if (!existsSync(o.home)) return { archivePath: null, carried: [] };
    if (!lstatSync(o.home).isDirectory()) throw new Error("the tenant home is not a plain directory");
    mkdirSync(o.archiveRoot, { recursive: true, mode: 0o700 });
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { mode: 0o700 });
    const names = readdirSync(o.home);
    for (const name of names) {
      const carried = (CARRY_MOVE as readonly string[]).includes(name) || (CARRY_COPY as readonly string[]).includes(name) || name.startsWith("kill-request-");
      if (!carried || !lstatSync(path.join(o.home, name)).isFile()) continue;
      copyFileSync(path.join(o.home, name), path.join(stage, name), constants.COPYFILE_EXCL);
      syncFile(path.join(stage, name));
    }
    syncDir(stage); syncDir(o.archiveRoot);
    if (!o.mayWrite()) throw lost();
    for (const name of [...SCRUB, ...CARRY_MOVE]) rmSync(path.join(o.home, name), { recursive: true, force: true });
    syncDir(o.home);
    if (!o.mayWrite()) throw lost();
    renameSync(o.home, dest);
    chmodSync(dest, 0o700);
    syncDir(o.archiveRoot); syncDir(path.dirname(o.home));
  }
  // From here the old home is the archive. Re-entry lands here.
  for (const name of SCRUB) rmSync(path.join(dest, name), { recursive: true, force: true });
  if (!existsSync(path.join(dest, MANIFEST))) {
    writeFileAtomicSync(path.join(dest, MANIFEST), JSON.stringify({ version: 1, generation: o.generation, files: walk(dest) }, null, 2), 0o600, { durable: true });
  }
  const carried: string[] = [];
  if (existsSync(stage)) {
    if (!o.mayWrite()) throw lost();
    mkdirSync(o.home, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(stage).sort()) {
      const to = path.join(o.home, name);
      if (existsSync(to)) { rmSync(path.join(stage, name), { force: true }); continue; }
      renameSync(path.join(stage, name), to);
      carried.push(name);
    }
    syncDir(o.home);
    rmSync(stage, { recursive: true, force: true });
    syncDir(o.archiveRoot);
  }
  return { archivePath: dest, carried };
}

/** For the Telegram and Fomo answers (plan §4.7): when the gap began and when this book started. */
export function writeRecoveryGeneration(home: string, r: { generation: string; approvalId: string; evidenceDigest: string; gapFromSec: number | null; registeredAtSec: number }): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileAtomicSync(path.join(home, RECOVERY_GENERATION_FILE), JSON.stringify({ version: 1, ...r }, null, 2), 0o600);
}

export function readRecoveryGeneration(home: string): { generation: string } | null {
  try {
    const v = JSON.parse(readFileSync(path.join(home, RECOVERY_GENERATION_FILE), "utf8")) as { generation?: unknown };
    return typeof v.generation === "string" ? { generation: v.generation } : null;
  } catch { return null; }
}

export { ADDRESS as RESUME_ADDRESS, DIGEST as RESUME_DIGEST };
