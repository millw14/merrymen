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
 *     MERRYMEN_RESUME_REVOKE (`0x<tenant>:<digest>` or `run:<digest>`, bound
 *     to evidence so a value left set never withdraws a later re-approval)
 *     withdraws an approval not yet registered.
 *   Phase A (in spawnChild, under the lease): drain a continuous old book's
 *     tail into Postgres if there is one, THEN recompute the evidence — any
 *     change refuses — check every precondition, and move the home aside into
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
 *      Transfer touching the account, from the oldest financial cursor of the
 *      last mirror (and at least 26 hours back) to head, is in Postgres; and
 *      again, immediately before registration, from that read's head to the
 *      head then, which is the head the attestation records. An RPC failure
 *      retries. Only a paper tenant that could not arm live — no live
 *      operation, no flow, no live intent in its settings, and no chain
 *      refusal that no admission has answered since — skips it. A refusal
 *      names every operation and transfer it found (chainRefusal), and
 *      chain-gap-booking.ts is the reviewed way to book them.
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
 *  10. Not already admitted: a tenant whose book on the volume is the
 *      attested generation this code registered for the account is run by
 *      the ordinary path, and a second approval would only archive it.
 *
 * AND BEFORE ITS FIRST WORKER, the attested book's seed is completed and
 * proved (completeAttestedSeed): with the lost book's cursors gone, the first
 * mirror pass publishes the new book's basis and floors as Postgres's, so they
 * must be the full seeded set, never whatever a best-effort seed managed.
 *
 * WHAT THIS NEVER DOES: write or change a financial row, import a trade,
 * loosen a cap (the empty 26-hour window means the rolling caps read exactly
 * what Postgres says), start a risk period, or write a key into an archive.
 * Any failure leaves the tenant held and the step resumable.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, type Stats } from "node:fs";
import path from "node:path";
import { createPublicClient, http, type Hex } from "viem";
import { isTransientDbError, type Db } from "./db";
import { fsyncDirSync, writeFileAtomicSync } from "./atomic-write";
import { planBasisSeed, planFloorSeed, type BasisSeedRow, type FloorSeedRow } from "./basis-seed";
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
/**
 * A clean chain read older than this is read again, whole, before the empty
 * book is registered. A fresh one is not taken on trust either: the window
 * from its head to the head at registration is read immediately before the
 * registration, and the clean read is spent by that attempt (orchestrator.ts
 * resumeAdmission).
 */
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

/**
 * WHICH APPROVALS TO WITHDRAW: `0x<tenant>:<evidence digest>` for one, or
 * `run:<preview run digest>` for every approval recorded from that run.
 * Comma separated. Unset: none.
 *
 * BOUND TO EVIDENCE, NEVER TO A BARE TENANT. These variables are read on
 * every boot, and railway.json restarts on failure with the same
 * environment. A bare tenant left set withdrew whatever approval that tenant
 * had open at the NEXT boot too — including the re-approval the same deploy
 * had just recorded, sometimes after its home was already archived — so the
 * documented "revoke and re-approve in one deploy" ended with the tenant held
 * and another preview cycle owed. An approval of different evidence never
 * matches a revoke of the old, so left set this changes nothing more.
 */
export type ResumeRevoke = { kind: "tenant"; tenant: string; digest: string } | { kind: "run"; run: string };
export function parseResumeRevokes(raw: string | undefined): ResumeRevoke[] {
  if (raw === undefined) return [];
  const parts = raw.trim().split(",").map((p) => p.trim());
  if (parts.length > MAX_NAMED) throw refuseEnv(RESUME_REVOKE_ENV, `names more than ${MAX_NAMED} entries`);
  const seen = new Set<string>();
  return parts.map((p, i) => {
    const run = /^run:([0-9a-f]{64})$/.exec(p);
    const one = /^(0x[0-9a-fA-F]{40}):([0-9a-f]{64})$/.exec(p);
    if (!run && !one) throw refuseEnv(RESUME_REVOKE_ENV, `entry ${i + 1} is not 0x<tenant>:<evidence digest> or run:<preview run digest>`);
    const out: ResumeRevoke = run ? { kind: "run", run: run[1]! } : { kind: "tenant", tenant: one![1]!.toLowerCase(), digest: one![2]! };
    const key = out.kind === "run" ? `run:${out.run}` : `${out.tenant}:${out.digest}`;
    if (seen.has(key)) throw refuseEnv(RESUME_REVOKE_ENV, `entry ${i + 1} repeats an earlier entry`);
    seen.add(key);
    return out;
  });
}

// ── evidence ─────────────────────────────────────────────────────────────────

/** Files whose presence in a home is part of its identity: every barrier, hold and owner control the spawn path reads. */
const HOME_MARKERS = [
  "ledger-source-blocked.json", "ledger-import.pending.json", "restore-blocked.json", "energy-unrestored.json",
  "budget-unrestored.json", "paused", "controls-armed.json", "recovery-command-barrier.json", "telegram-held-groups.json",
  RECOVERY_GENERATION_FILE,
] as const;

/**
 * WHAT IS IN A HOME, as the evidence binds it: the home's inode, the main
 * book's inode and size, and which barrier and control files exist.
 *
 * NEVER THE DEVICE NUMBER. st_dev is the kernel's number for the mount on
 * this host, and persistent-home.ts already says it "may change when Railway
 * reattaches the same volume on another host" — which is why that file keeps
 * only the provider volume id and the root inode as durable, and re-reads the
 * device at each boot. An approval always crosses at least one deploy (the
 * preview runs in one, the admission in a later one), so a device number in
 * the digest would refuse every approved tenant the first time the volume
 * moved hosts, for nothing that happened to any book. The volume's identity is
 * proved separately at admission (the verified persistent home, and
 * registerAttestedGapSource's own device check against it); inodes and sizes
 * on the same filesystem do not change with the host. Nor -wal, -shm or any
 * mtime, which change without the book changing.
 */
export interface HomeIdentity {
  exists: boolean;
  ino?: string;
  /** The main book only: -wal and -shm, and every mtime, change without the book changing. */
  db?: { ino: string; size: string } | null;
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
    db = { ino: String(d.ino), size: String(d.size) };
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  const names = readdirSync(home);
  const markers = names.filter((n) => (HOME_MARKERS as readonly string[]).includes(n) || n.startsWith("kill-request-")).sort();
  return { exists: true, ino: String(st.ino), db, markers };
}

/** The home's book as the ordinary path would meet it: none, behind a source barrier, or present and unblocked. */
export function homeBookState(home: HomeIdentity): "absent" | "blocked" | "present" {
  if (!home.exists || !home.db) return "absent";
  return home.markers?.includes("ledger-source-blocked.json") ? "blocked" : "present";
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
  /**
   * `chain` is bound so an owner who funds the account or turns live trading
   * on after the preview refuses the approval: the operator previews again
   * and sees the tenant as chain-read and exits-only, rather than putting a
   * now-live tenant at `trade` from a stale line.
   */
  checks: { anchor: string; riskPeriod: string; controls: string; unresolved: number; chain: "required" | "not-required" };
  home: HomeIdentity;
}
export const evidenceDigest = (e: ResumeEvidence): string => hash(canonical(e));

// ── preconditions ────────────────────────────────────────────────────────────

export interface ResumeCheck {
  refusals: string[];
  /**
   * A paper tenant that could not arm live: no live operation, no flow and no
   * live intent on record, and no chain refusal of it that no admission has
   * answered since (`chainHeld`). No chain read is needed.
   */
  paper: boolean;
  chainRequired: boolean;
  /**
   * AN APPROVAL OF IT WAS REFUSED ON THE CHAIN, AND NO ADMISSION HAS ANSWERED
   * THAT SINCE (unansweredChainRefusal). Then it is never `paper`, whatever
   * Postgres and the owner's settings say now: the chain showed that Postgres
   * incomplete, so the tenant is read on chain again (chain:required) and
   * starts exits-only. So an approval of it never admits it on that book: its
   * chain read refuses again while Postgres still lacks what the chain showed,
   * which records a fresh chain refusal, the newest decision the booking tool
   * books on (chain-gap-booking.ts holdOf).
   */
  chainHeld: boolean;
  holdsPositions: boolean;
  /** decision 6: paper tenants may trade once the canary has; live tenants holding positions start exits-only. */
  suggestedLevel: "trade" | "exits-only";
  anchor: string;
  riskPeriod: string;
  unresolved: number;
  /** From where the chain is read: the oldest financial cursor of the last mirror, and at least 26 hours back. */
  gapFromSec: number;
  /** When the last mirror pass copied anything for the tenant: when the gap began. */
  lastMirrorAt: number | null;
  /**
   * THE REFUSALS AN OUTAGE CAUSED, as opposed to a fact about the tenant:
   * each is in `refusals` too, and asked again it may pass on its own. The
   * owner controls whose read did not complete (`controls.failed`), an
   * accounting anchor that could not be derived (deriveBootstrapAccounting
   * answers `unknown` only for a read that failed), and a risk period whose
   * carried read threw something other than its own "invalid" verdict.
   *
   * WHY IT IS SEPARATE. Every one of these also moves the evidence digest (the
   * controls digest reads `unreadable`, the anchor `unknown`, the risk period
   * `invalid`), so a transient failure in Phase A used to refuse an approval
   * for "evidence changed" — for good, since an approval is unique per
   * evidence and the same evidence, read cleanly again, could then never be
   * approved by anyone — and the automatic lane settled a re-sign as
   * "previewed: it did not pass" on one bad read. Now an admission HOLDS on
   * these (the next pass reads again), and the automatic lane keeps the re-sign
   * owed. A malformed journal, an invalid risk period, or financial rows with
   * no anchor stay refusals: they are true of the tenant, and reading again
   * changes nothing.
   */
  unreadable: string[];
}

const SETTLED_EXCLUDED = ["paper", "rejected", "submitted", "sent", "pending"];
/** The cursors of the tables a chain operation or a USDG transfer lands in. */
const FINANCIAL_CURSORS = ["trades", "flows", "equity"] as const;
/**
 * A TABLE THAT IS NOT THERE YET, AND NOTHING ELSE: Postgres's 42P01
 * (undefined_table) or sqlite's "no such table", which these reads answer as
 * "holds nothing". Never a missing COLUMN: Postgres says 42703 with a message
 * that also reads "column … does not exist", and the older pattern here took
 * it for an absent table — so schema drift in agent_commands, cost_basis,
 * position_floors, trench_positions or class_positions read as "no open
 * command, no live row, no position", and the automatic lane's safe case
 * passed exactly what it was asked to refuse. Drift throws now, and every
 * caller fails closed on a throw (a preview that cannot be read, an admission
 * deferred).
 */
const absentTable = (e: unknown): boolean => {
  const err = e as { code?: unknown; message?: unknown } | null;
  return err?.code === "42P01" || /no such table/.test(String(err?.message ?? ""));
};

/**
 * IS THIS TENANT ALREADY ADMITTED? Its current source (tenant_ledger_import,
 * consumed) is an attested-gap generation this code registered
 * (ledger_resume_attestations) for THIS account, and its home holds that book,
 * present and not behind a barrier. Then the ordinary path already runs it,
 * and a second approval would only archive a live book and register another
 * one over it — the reviewed failure: a re-preview printed an admitted tenant
 * `pass:true`, and a run approval archived its home a second time.
 *
 * Narrow on purpose. A tenant whose attested book is missing or blocked again,
 * or whose attested source was for an account the owner has since replaced,
 * is NOT admitted: it needs exactly this path again, and may take it.
 */
export async function attestedSourceInUse(db: Db, tenant: string, account: string): Promise<string | null> {
  try {
    const row = (await db.prepare(`SELECT i.generation AS generation, a.smart_account AS account FROM tenant_ledger_import i
        JOIN ledger_resume_attestations a ON a.generation = i.generation WHERE i.tenant = ? AND i.state = 'consumed'`)
      .get(tenant.toLowerCase())) as Record<string, unknown> | undefined;
    return row && String(row.account).toLowerCase() === account.toLowerCase() ? String(row.generation) : null;
  } catch (e) {
    if (absentTable(e)) return null;
    throw e;
  }
}

/**
 * EVERY PRECONDITION THAT POSTGRES ALONE CAN ANSWER, for one tenant, now.
 * Read-only. Each refusal is its own sentence, so a preview line says every
 * reason at once and the operator fixes them together.
 *
 * `homeBook` is the home's book as homeBookState reads it (absent when not
 * given). `liveIntent` is the owner's stored settings asking for the live rail
 * (or unreadable settings, which the caller reports as true): a tenant that
 * could arm live is read on chain whatever its last heartbeat said.
 */
export async function resumePreconditions(db: Db, o: {
  tenant: string; account: string; grantAccount: string; nowSec: number;
  /** `failed`: the controls read did not complete (recovery-reply-arm.ts readControlsEvidence), which is an outage, not a fact. */
  controls: { readable: boolean; why: string | null; failed?: boolean };
  homePendingImport: boolean;
  homeBook?: "absent" | "blocked" | "present";
  liveIntent?: boolean;
}): Promise<ResumeCheck> {
  const account = o.account.toLowerCase(), refusals: string[] = [], unreadable: string[] = [];
  /** A refusal; `byOutage` also lists it as one an outage caused (ResumeCheck.unreadable), held on rather than refused. */
  const refuse = (why: string, byOutage: boolean) => { refusals.push(why); if (byOutage) unreadable.push(why); };
  if (o.homeBook === "present") {
    const admitted = await attestedSourceInUse(db, o.tenant, account);
    if (admitted) refusals.push(`already admitted: its book on the volume is attested-gap generation ${admitted.slice(0, 8)}…, which the ordinary path runs — put it in the rollout; no approval is needed`);
  }
  if (!o.controls.readable) refuse(`owner controls cannot be read (${o.controls.why ?? "unreadable"})`, o.controls.failed === true);
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
  // `unknown` is deriveBootstrapAccounting's answer to a read that failed,
  // and only to that (it never throws): an outage.
  if (accounting.kind === "unknown") refuse("the accounting anchor cannot be derived", true);
  if (accounting.kind === "no-prior-accounting" && financialRows > 0) refusals.push(`no accounting anchor, yet ${financialRows} financial row(s) are on record`);
  const anchor = accounting.kind === "established" ? `established:epoch-${accounting.accountingEpoch}` : accounting.kind;
  // THE RISK PERIOD, as the anchor will carry it: by the grant's own spelling.
  let riskPeriod = "none";
  try {
    const any = (await db.prepare("SELECT * FROM risk_periods WHERE LOWER(agent_id) = ? ORDER BY started_at DESC LIMIT 1").get(account)) as Record<string, unknown> | undefined;
    if (any) {
      // readRiskPeriod throws for two reasons: its own verdict on an invalid
      // row (a fact, refused below like any other), or a read that failed (an
      // outage). Only the second holds rather than refuses.
      let carriedFailed = false;
      const carried = await readRiskPeriod(db, o.grantAccount).catch((e: unknown) => {
        carriedFailed = !(e instanceof Error && e.message === "Invalid durable risk period");
        return null;
      });
      if (!validRiskPeriod(any, account) || !carried || carried.id !== any.id) {
        riskPeriod = "invalid";
        refuse("the risk period on record is invalid, or the anchor could not carry it under the grant's spelling", carriedFailed && validRiskPeriod(any, account));
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
  //
  // PAPER MEANS "COULD NOT ARM LIVE", not "the last heartbeat said paper".
  // agents.mode is what the worker reported at the last mirror; the rail a
  // worker arms on is chosen at arm from the owner's settings and the cash it
  // measures (index.ts execMode). So an owner who funded the account, or
  // switched to live, during the hold would otherwise be previewed as paper,
  // admitted with no chain read, and suggested straight to `trade`. Any live
  // operation, ANY flow on record (a deposit is a funded account), or the
  // owner's stored live intent makes the tenant one the chain is read for,
  // and one that starts exits-only.
  //
  // AND SO DOES A CHAIN REFUSAL NO ADMISSION HAS ANSWERED (chainHeld). Every
  // reading above comes from the Postgres that refusal showed incomplete,
  // and the owner's settings may have changed since: an owner who turned
  // live trading off after it reads as paper again, though what Postgres
  // lacks may be a live trade. Read as paper, an approval would admit it with
  // no chain read, on that book, and supersede the refusal the booking tool
  // books on. Read on chain, an approval refuses again until it is booked.
  const liveOps = Number(((await db.prepare(`SELECT COUNT(*) AS n FROM trades WHERE LOWER(agent_id) = ?
      AND ((user_op_hash IS NOT NULL AND user_op_hash <> '') OR status IN ('landed', 'submitted', 'sent', 'pending', 'reverted', 'dropped'))`).get(account)) as Record<string, unknown>).n);
  const chainHeld = await unansweredChainRefusal(db, o.tenant);
  const paper = agent?.mode === "paper" && liveOps === 0 && flowCount === 0 && o.liveIntent !== true && !chainHeld;
  const held = Number(((await db.prepare("SELECT COUNT(*) AS n FROM positions WHERE LOWER(agent_id) = ? AND raw_balance <> '0'").get(account)) as Record<string, unknown>).n);
  let classHeld = 0;
  try { classHeld = Number(((await db.prepare("SELECT COUNT(*) AS n FROM class_positions WHERE LOWER(agent_id) = ? AND COALESCE(state, '') <> 'closed'").get(account)) as Record<string, unknown>).n); }
  catch (e) { if (!absentTable(e)) throw e; }
  const { gapFromSec, lastMirrorAt } = await resumeGapWindow(db, o.tenant, o.nowSec);
  return {
    refusals, paper, chainRequired: !paper, chainHeld, holdsPositions: held + classHeld > 0,
    suggestedLevel: paper ? "trade" : "exits-only", anchor, riskPeriod, unresolved, gapFromSec, lastMirrorAt, unreadable,
  };
}

/**
 * WHERE THE CHAIN READ STARTS, AND WHEN THE GAP BEGAN, for one tenant now.
 *
 * Its own function so the chain-gap booking tool (chain-gap-booking.ts) reads
 * from exactly the second the admission's chain check reads from: a booking
 * that covered a narrower window would leave an operation it never saw for
 * the admission to refuse on, and one that guessed a wider one would propose
 * rows the admission never asked about. One computation, two readers.
 *
 * `gapFromSec` only moves later as `nowSec` advances (it is a minimum with
 * `nowSec - 26h`), so a window read now covers every later admission's.
 */
export async function resumeGapWindow(db: Db, tenant: string, nowSec: number): Promise<{ gapFromSec: number; lastMirrorAt: number | null }> {
  // WHEN THE GAP BEGAN, AND FROM WHERE THE CHAIN IS READ — two different
  // questions. The gap began at the last pass that copied anything (the
  // newest cursor). But a cursor only moves when rows arrive, and the
  // mirror's own history has a trades cursor that stalled while events and
  // snapshots kept moving: an operation that landed after a STALLED financial
  // cursor is neither in Postgres nor after the newest cursor. So the chain
  // read starts at the OLDEST of the financial cursors (trades, flows,
  // equity), still at least 26 hours back. A quiet table's cursor is old too,
  // which only makes the read longer, never less complete.
  const stamp = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const at = Number(v);
    return !Number.isFinite(at) ? null : at > 1e12 ? Math.floor(at / 1000) : at;
  };
  const tenantKey = tenant.toLowerCase();
  const lastMirrorAt = stamp(((await db.prepare("SELECT MAX(updated_at) AS at FROM mirror_state WHERE tenant = ?").get(tenantKey)) as Record<string, unknown> | undefined)?.at);
  const cursorHoles = FINANCIAL_CURSORS.map(() => "?").join(", ");
  const oldestFinancial = stamp(((await db.prepare(`SELECT MIN(updated_at) AS at FROM mirror_state WHERE tenant = ? AND table_name IN (${cursorHoles})`)
    .get(tenantKey, ...FINANCIAL_CURSORS)) as Record<string, unknown> | undefined)?.at);
  const gapFromSec = Math.min(oldestFinancial ?? lastMirrorAt ?? nowSec, lastMirrorAt ?? nowSec, nowSec - GAP_WINDOW_SEC) - 600;
  return { gapFromSec, lastMirrorAt };
}

/** The evidence and the preconditions together, as the preview prints them and Phase A recomputes them. */
export async function readResumeEvidence(db: Db, o: {
  tenant: string; grant: { smartAccount: string; chainId: number; owner: string }; home: string; nowSec: number;
  controls: { readable: boolean; why: string | null; failed?: boolean; digest: string };
  /** The owner's stored settings ask for the live rail, or could not be read. */
  liveIntent?: boolean;
}): Promise<{ evidence: ResumeEvidence; digest: string; check: ResumeCheck }> {
  const tenant = o.tenant.toLowerCase(), account = o.grant.smartAccount.toLowerCase();
  const home = homeIdentity(o.home);
  const check = await resumePreconditions(db, {
    tenant, account, grantAccount: o.grant.smartAccount, nowSec: o.nowSec, controls: o.controls,
    homePendingImport: home.markers?.includes("ledger-import.pending.json") ?? false,
    homeBook: homeBookState(home), liveIntent: o.liveIntent,
  });
  const evidence: ResumeEvidence = {
    version: 1, tenant, account, chainId: o.grant.chainId, owner: o.grant.owner.toLowerCase(),
    pg: await readPgEvidence(db, { tenant, account, nowSec: o.nowSec }),
    checks: { anchor: check.anchor, riskPeriod: check.riskPeriod, controls: o.controls.digest, unresolved: check.unresolved,
      chain: check.chainRequired ? "required" : "not-required" },
    home,
  };
  return { evidence, digest: evidenceDigest(evidence), check };
}

/**
 * One tenant's line in a preview run. Nonsecret: addresses, digests, verdicts.
 *
 * Beside the verdict, what the operator needs to choose a level and to warn an
 * owner: whether Postgres shows the tenant holding positions (a live holder
 * starts exits-only so its stops run and nothing new opens), whether a pause
 * is on record that the worker will start under (the home's own `paused`
 * file, a journalled /pause, a pre-incident pause event restored into a home
 * never armed, or a durable pause stamp), when its grant expires, and the
 * home's book as the ordinary path would meet it (`absent`, `blocked` behind
 * a source barrier, or `present`).
 */
export interface PreviewEntry {
  tenant: string; account: string | null; chainId: number | null; owner: string | null;
  digest: string | null; pass: boolean; refusals: string[];
  chain: "required" | "not-required" | null; suggestedLevel: "trade" | "exits-only" | null;
  anchor: string | null; riskPeriod: string | null; home: "absent" | "present" | null; lastMirrorAt: number | null;
  holdsPositions: boolean | null; startsPaused: boolean | null; grantExpiresAt: number | null; book: "absent" | "blocked" | "present" | null;
  evidence: ResumeEvidence | null;
  /**
   * WHY THE TENANT'S LAST APPROVAL WAS REFUSED, when its newest approval was:
   * the reason as admission recorded it (a chain refusal names each operation
   * and transfer it found, readLastRefusal), the evidence it was for, and when.
   * Information for the operator, never a gate: `pass` is decided by the
   * preconditions alone. Optional so a run recorded before it existed parses.
   */
  lastRefusal?: LastRefusal | null;
  /**
   * A CHAIN REFUSAL OF IT THAT NO ADMISSION HAS ANSWERED (ResumeCheck.
   * chainHeld): it reads chain:required whatever its paper reading, and an
   * approval of it reads the chain again rather than admitting it — never a
   * way to trade until what the chain showed is booked. Unlike `lastRefusal`
   * it is not only the newest decision. Optional so an older run parses.
   */
  chainHeld?: boolean;
}
export interface LastRefusal { evidence: string; reason: string; atMs: number }
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
/**
 * WHO APPROVED: the operator (MERRYMEN_RESUME_APPROVE), or the orchestrator
 * itself for a re-signed paper tenant (MERRYMEN_RESUME_AUTO_PAPER, below). A
 * row from before the column reads as the operator's, which it was.
 */
export type ApprovalSource = "operator" | "auto-paper";
export const AUTO_PAPER_SOURCE = "auto-paper" satisfies ApprovalSource;
export interface ApprovalRow {
  approvalId: string; tenant: string; smartAccount: string; chainId: number; owner: string;
  evidenceDigest: string; evidence: ResumeEvidence; previewRun: string; state: ApprovalState;
  generation: string | null; archivePath: string | null; source: ApprovalSource;
}
const OPEN_STATES = ["approved", "archiving", "archived", "registered"] as const;

function approvalOf(r: Record<string, unknown>): ApprovalRow {
  return {
    approvalId: String(r.approval_id), tenant: String(r.tenant), smartAccount: String(r.smart_account), chainId: Number(r.chain_id),
    owner: String(r.owner), evidenceDigest: String(r.evidence_digest), evidence: JSON.parse(String(r.evidence_json)) as ResumeEvidence,
    previewRun: String(r.preview_run), state: String(r.state) as ApprovalState,
    generation: r.generation === null || r.generation === undefined ? null : String(r.generation),
    archivePath: r.archive_path === null || r.archive_path === undefined ? null : String(r.archive_path),
    source: r.source === AUTO_PAPER_SOURCE ? AUTO_PAPER_SOURCE : "operator",
  };
}

/**
 * THE TENANT'S NEWEST APPROVAL, IF IT WAS REFUSED: why, for which evidence and
 * when — for the preview line (PreviewEntry.lastRefusal).
 *
 * WHY THE PREVIEW SAYS IT. A refusal used to reach the operator once, as an
 * [alert] in one deploy's log, and the preview that the runbook then asks for
 * printed the same tenant `pass: true` with nothing beside it — the chain
 * check is not a Postgres precondition, so the preview cannot see it. The
 * operator approved the new digest, the chain check refused again, and the
 * loop said nothing about what to fix. The reason names it (chainRefusal), so
 * the preview carries the reason.
 *
 * Null when the newest approval is not refused (approved, revoked, applied —
 * anything newer than the refusal supersedes it) and when there is none. A
 * missing table is none: nothing was ever approved.
 */
export async function readLastRefusal(db: Db, tenant: string): Promise<LastRefusal | null> {
  try {
    const row = (await db.prepare(`SELECT state, evidence_digest, reason, updated_at_ms FROM ledger_resume_approvals WHERE tenant = ?
        ORDER BY updated_at_ms DESC, created_at_ms DESC LIMIT 1`).get(tenant.toLowerCase())) as Record<string, unknown> | undefined;
    if (!row || row.state !== "refused") return null;
    return { evidence: `${String(row.evidence_digest).slice(0, 12)}…`, reason: String(row.reason ?? "").slice(0, 500), atMs: Number(row.updated_at_ms) };
  } catch (e) {
    if (absentTable(e)) return null;
    throw e;
  }
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
  type Run = { run: string; at: number; entries: PreviewEntry[] };
  const runOf = (r: Record<string, unknown>): Run => ({ run: String(r.run), at: Number(r.created_at_ms), entries: JSON.parse(String(r.entries_json)) as PreviewEntry[] });
  const runs = ((await db.prepare("SELECT run, created_at_ms, entries_json FROM ledger_resume_preview_runs ORDER BY created_at_ms DESC LIMIT 200").all()) as Array<Record<string, unknown>>)
    .map(runOf);
  // OLDER RUNS ARE STILL RUNS. The newest 200 are read at once, and an entry
  // not among them is looked up in the whole table: by its run digest, or by
  // the evidence digest its entries carry. Once the automatic lane
  // (MERRYMEN_RESUME_AUTO_PAPER) records a run per re-signer, the run an
  // operator approves from — or the one whose `approve it by hand` line they
  // copied — can be older than the newest 200, and refusing it then for "no
  // recorded preview run" was an outage of the operator's own control. Both
  // digests are 64 hex characters (parseResumeApprovals), so the pattern has
  // no wildcard in it. What an entry binds is unchanged: Phase A re-derives
  // the evidence whatever the run's age.
  const runByDigest = async (run: string): Promise<Run | null> => {
    const had = runs.find((r) => r.run === run);
    if (had) return had;
    const row = (await db.prepare("SELECT run, created_at_ms, entries_json FROM ledger_resume_preview_runs WHERE run = ?").get(run)) as Record<string, unknown> | undefined;
    return row ? runOf(row) : null;
  };
  const passing = (list: readonly Run[], tenant: string, digest: string) => list.flatMap((r) => r.entries.map((entry) => ({ entry, run: r.run, at: r.at })))
    .find((x) => x.entry.tenant === tenant && x.entry.digest === digest && x.entry.pass && x.entry.evidence);
  const wanted: Array<{ entry: PreviewEntry; run: string; at: number }> = [];
  for (const a of approvals) {
    if (a.kind === "run") {
      const run = /^[0-9a-f]{64}$/.test(a.run) ? await runByDigest(a.run) : null;
      if (!run) { log(`[alert] resume approval: no recorded preview run ${a.run.slice(0, 12)}… — nothing approved from it; run the preview first`); continue; }
      for (const entry of run.entries) if (entry.pass && entry.digest && entry.evidence) wanted.push({ entry, run: run.run, at: run.at });
      continue;
    }
    let found = passing(runs, a.tenant, a.digest);
    if (!found && /^[0-9a-f]{64}$/.test(a.digest)) {
      const older = ((await db.prepare("SELECT run, created_at_ms, entries_json FROM ledger_resume_preview_runs WHERE entries_json LIKE ? ORDER BY created_at_ms DESC")
        .all(`%${a.digest}%`)) as Array<Record<string, unknown>>).map(runOf);
      found = passing(older, a.tenant, a.digest);
    }
    if (!found) { log(`[alert] resume approval: ${a.tenant} — no recorded preview run shows that digest passing; not approved`); continue; }
    wanted.push(found);
  }
  let added = 0;
  for (const { entry, run, at } of wanted) {
    if ((await recordResumeApproval(db, { entry, run, at, nowMs, source: "operator" }, log)).recorded) added += 1;
  }
  return added;
}

/**
 * RECORD ONE APPROVAL OF ONE PREVIEWED ENTRY, whoever gave it: the operator's
 * variable above, or the orchestrator's own approval of a re-signed paper
 * tenant (MERRYMEN_RESUME_AUTO_PAPER, below). One insert path, so both are
 * held to the same rules — and nothing after the row tells them apart:
 * Phase A, the archive, the registration and its attestation, the seed proof
 * and the first worker are one path for both (orchestrator.ts
 * resumeAdmission), which reads `source` only to refuse more, never less.
 *
 * Only an entry that passed, with its digest and its evidence. Never twice
 * for the same evidence (unique per tenant and digest, whatever its state: an
 * applied, refused or revoked approval is never reopened), never for a
 * tenant admitted since the preview was taken (`at`), and never beside an
 * open approval for other evidence (one open per tenant, which the table
 * enforces as well). A duplicate of the same evidence is silent, as a
 * variable left set across boots must be; every other refusal is said.
 *
 * AN OUTAGE IS NOT A REFUSAL. An insert the store could not take because it
 * could not be reached or gave the statement up (db.ts isTransientDbError: a
 * reset connection, a statement timeout, a serialization or deadlock abort)
 * says nothing about the tenant, and comes back `transient`: the automatic
 * lane keeps the re-sign owed and asks again on a later pass, and an
 * operator's boot is told that the variable, left set, records it on the
 * next. Anything else the insert meets — above all the table's own
 * uniqueness, another approval recorded meanwhile — is the store's answer,
 * and final, as before.
 */
export type RecordedApproval = { recorded: true } | { recorded: false; why: string; transient?: true };
export async function recordResumeApproval(db: Db, o: { entry: PreviewEntry; run: string; at: number; nowMs: number; source: ApprovalSource },
  log: (line: string) => void): Promise<RecordedApproval> {
  const { entry, run, at, nowMs, source } = o;
  if (!entry.pass || !entry.digest || !entry.evidence) return { recorded: false, why: "the entry did not pass, or carries no evidence" };
  const existing = (await db.prepare("SELECT state, source, reason FROM ledger_resume_approvals WHERE tenant = ? AND evidence_digest = ?").get(entry.tenant, entry.digest)) as
    Record<string, unknown> | undefined;
  if (existing) {
    // SILENT FOR A VARIABLE LEFT SET, BUT NOT FOR THIS: the operator approving
    // evidence an automatic approval already ended on. The row is unique per
    // evidence and terminal, so this approval can never be recorded, and an
    // operator who copied the lane's own line would otherwise wait on a
    // tenant nothing will admit. Said, with why it ended; the tenant is
    // approvable again once anything in its evidence changes.
    if (source === "operator" && existing.source === AUTO_PAPER_SOURCE && (existing.state === "refused" || existing.state === "revoked")) {
      log(`[alert] resume approval: ${entry.tenant} — an automatic (auto-paper) approval of this exact evidence ${String(existing.state)}` +
        `${existing.reason ? ` (${String(existing.reason).slice(0, 200)})` : ""}, and one evidence is never approved twice — not approved. ` +
        "Preview it again once its evidence changes, and approve the digest that preview prints");
    }
    return { recorded: false, why: `an approval of this evidence is already on record (${String(existing.state)})` };
  }
  // ADMITTED SINCE THAT PREVIEW WAS TAKEN: the run's evidence is from before
  // the tenant's new book, so it cannot be what is true now, and approving it
  // could only archive a running book. (Phase A would refuse the stale digest
  // anyway; this says so at once and records nothing.)
  const since = (await db.prepare(`SELECT 1 AS x FROM ledger_resume_approvals WHERE tenant = ? AND state IN ('registered', 'applied') AND updated_at_ms >= ? LIMIT 1`)
    .get(entry.tenant, at)) as Record<string, unknown> | undefined;
  if (since) {
    log(`resume approval: ${entry.tenant} was admitted after preview run ${run.slice(0, 12)}… was taken — not approved from it`);
    return { recorded: false, why: "it was admitted after the preview was taken" };
  }
  const open = await readOpenApproval(db, entry.tenant);
  if (open) {
    log(`[alert] resume approval: ${entry.tenant} already has an open approval (${open.state}) for other evidence — revoke it first; not approved`);
    return { recorded: false, why: `an approval is already open for it (${open.state})` };
  }
  const e = entry.evidence;
  try {
    await db.prepare(`INSERT INTO ledger_resume_approvals (approval_id, tenant, smart_account, chain_id, owner, evidence_digest, evidence_json, preview_run,
        state, created_at_ms, updated_at_ms, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?)`)
      .run(randomUUID(), entry.tenant, e.account, e.chainId, e.owner, entry.digest, canonical(e), run, nowMs, nowMs, source);
  } catch (err) {
    if (isTransientDbError(err)) {
      // By its code (a SQLSTATE or a Node errno), or its class: never what it
      // said, which can carry a connection string.
      const code = (err as { code?: unknown }).code, name = (err as Error).name;
      const why = `the store could not be reached or gave up (${typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : /^[A-Za-z]{1,40}$/.test(name) ? name : "Error"})`;
      // The automatic lane says its own line, with its back-off.
      if (source === "operator") {
        log(`[alert] resume approval: ${entry.tenant} could not be recorded — ${why}: an outage, not a refusal — not approved by this boot; ` +
          "left set, the variable records it on the next");
      }
      return { recorded: false, why, transient: true };
    }
    log(`[alert] resume approval: ${entry.tenant} could not be recorded (another approval is open, or the store refused) — not approved`);
    return { recorded: false, why: "the store refused the approval" };
  }
  log(`resume approval: ${entry.tenant} approved ${source === AUTO_PAPER_SOURCE ? "automatically (auto-paper: a re-signed paper tenant) " : ""}` +
    `for evidence ${entry.digest.slice(0, 12)}… (preview run ${run.slice(0, 12)}…)`);
  return { recorded: true };
}

/**
 * Withdraw approvals that have not reached the new book. A registered one is
 * past this point: the rollout scope is what stops it. `archiving` is not
 * withdrawn either: its home is mid-move, and only the approval's own next
 * pass finishes the move it started.
 */
export async function revokeResumeApprovals(db: Db, revokes: readonly ResumeRevoke[], nowMs: number, log: (line: string) => void): Promise<void> {
  if (!revokes.length) return;
  await ensureLedgerResumeSchema(db);
  for (const v of revokes) {
    if (v.kind === "run") {
      const open = (await db.prepare(`SELECT tenant, state FROM ledger_resume_approvals WHERE preview_run = ? AND state IN ('archiving', 'registered')`).all(v.run)) as
        Array<Record<string, unknown>>;
      const r = await db.prepare(`UPDATE ledger_resume_approvals SET state = 'revoked', reason = 'revoked by the operator', updated_at_ms = ?
        WHERE preview_run = ? AND state IN ('approved', 'archived')`).run(nowMs, v.run);
      log(`resume revoke: run ${v.run.slice(0, 12)}… — ${r.changes} approval(s) withdrawn; those tenants stay held`);
      for (const o of open) log(`[alert] resume revoke: ${String(o.tenant)} is ${String(o.state)} — past the point a revoke undoes; narrow MERRYMEN_FLEET_ROLLOUT instead`);
      continue;
    }
    const r = await db.prepare(`UPDATE ledger_resume_approvals SET state = 'revoked', reason = 'revoked by the operator', updated_at_ms = ?
      WHERE tenant = ? AND evidence_digest = ? AND state IN ('approved', 'archived')`).run(nowMs, v.tenant, v.digest);
    if (r.changes) { log(`resume approval: ${v.tenant} revoked (evidence ${v.digest.slice(0, 12)}…) — the tenant stays held`); continue; }
    const row = (await db.prepare("SELECT state FROM ledger_resume_approvals WHERE tenant = ? AND evidence_digest = ?").get(v.tenant, v.digest)) as
      Record<string, unknown> | undefined;
    if (!row) log(`resume revoke: ${v.tenant} has no approval for evidence ${v.digest.slice(0, 12)}…`);
    else if (row.state === "archiving" || row.state === "registered") {
      log(`[alert] resume revoke: ${v.tenant} is ${String(row.state)} — past the point a revoke undoes; narrow MERRYMEN_FLEET_ROLLOUT instead`);
    }
    // Already applied, refused or revoked: nothing to withdraw, and left set
    // across boots this says nothing more.
  }
}

// ── automatic admission of re-signed paper tenants ──────────────────────────

/**
 * MERRYMEN_RESUME_AUTO_PAPER: THE ORCHESTRATOR APPROVES ONE CASE ITSELF.
 *
 * WHY. Sixty-four tenants' grants expired during the hold. When such an owner
 * re-signs, the continuity gate holds the tenant (it has history and no
 * surviving book) until an operator previews it, reads its line and approves
 * its digest (docs/fleet-resume.md, steady state): two deploys per re-signer,
 * for tenants of whom the commonest kind — a paper book that could never have
 * armed live — is proved safe by the preview itself, with no chain to read.
 *
 * WHAT. With the variable `1`, every change to a tenant's grant row (a
 * re-sign: a new expiry and a new server stamp, grantRowKey) is owed ONE
 * automatic preview of that tenant, recorded as any preview run is and
 * printed as one. If the tenant is held by the continuity gate and the
 * preview shows the safe case (autoPaperVerdict), the orchestrator records
 * the approval itself — source `auto-paper`, bound to that preview's evidence
 * digest, through the same insert as the operator's (recordResumeApproval) —
 * and from there it is an approval like any other: Phase A re-derives the
 * evidence and refuses on any change, the home is archived, the book
 * registered and attested, the seed proved, and the first worker starts at
 * whatever level MERRYMEN_FLEET_ROLLOUT gives the tenant.
 *
 * THE SAFE CASE, all of it:
 *   - every precondition passes (the preview's own `pass`, which includes an
 *     unexpired grant, readable owner settings and no accounting hold);
 *   - chain:not-required: a paper book that could not arm live — no live
 *     operation, no flow, no live intent in the owner's settings — so there
 *     is no chain read to need, and none is skipped;
 *   - no positions (no token balance, no open class position), no live book
 *     rows (live cost basis, floors or trench entries), no unresolved trade,
 *     and no owner command with a financial effect left unanswered (an
 *     order, a self-test, a practice reset);
 *   - no approval open for it, and none of it ever revoked by the operator: a
 *     revoke is an operator's decision about that tenant, which no re-sign
 *     overrides;
 *   - no chain refusal of it that an admission has not answered since
 *     (unansweredChainRefusal): the chain showed the Postgres this reads
 *     incomplete, and what it showed is booked by the operator's reviewed
 *     tool, never stepped past by a re-sign;
 *   - and held by the gate: its book on the volume is blocked, or absent with
 *     history on record. A tenant whose book is present, or one with no
 *     history at all, is the ordinary path's, which needs no approval (and an
 *     approval there would only archive a book the ordinary path runs).
 *
 * NEVER a live or chain-required tenant: it is previewed, its line printed,
 * and left to the operator's hand. Never anyone while live-trading consent is
 * stood down (MERRYMEN_LIVE_INTENT_STAND_DOWN=1: a funded account then arms
 * live whatever its settings say, so every tenant reads as able to arm live).
 * Never a tenant the rollout does not admit
 * (its preview stays owed until it does: under an explicit list it must be
 * named; under `all` it trades). Never more than AUTO_PAPER_PER_PASS a pass,
 * and never past the process cap less AUTO_PAPER_HEADROOM. And never a
 * change seen before the variable was first on: the first pass with it
 * baselines the roster as it stands, so turning it on admits nobody by
 * itself.
 *
 * Unset: nothing here runs, nothing is read or written, and every tenant is
 * held exactly as before. Malformed refuses boot, as every resume variable
 * does; read at runtime it fails closed (resumeAutoPaperOn).
 */
export const RESUME_AUTO_PAPER_ENV = "MERRYMEN_RESUME_AUTO_PAPER";
/** `1`: on. Unset: off. Anything else — `0`, `true`, an empty value — refuses boot rather than guess. */
export function parseResumeAutoPaper(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  if (raw === "1") return true;
  throw refuseEnv(RESUME_AUTO_PAPER_ENV, "is not 1 (remove it to turn automatic admission of re-signed paper tenants off)");
}
/** The same, read every pass: a value that cannot be read approves nobody. */
export function resumeAutoPaperOn(env: Record<string, string | undefined> = process.env): boolean {
  try { return parseResumeAutoPaper(env[RESUME_AUTO_PAPER_ENV]); } catch { return false; }
}

/**
 * The most owed re-signers one reconcile pass answers (previews that read,
 * whatever they came to), and so the most it can approve. The rest wait for
 * the next pass.
 */
export const AUTO_PAPER_PER_PASS = 2;
/**
 * And, beside those, the most previews one pass may spend on changes whose
 * preview could not be read. Separate so that a tenant that never reads
 * cannot use a turn an answerable one behind it needed (observeGrantChanges
 * puts the least recently tried first, too), and bounded so a store that
 * fails for everyone costs a pass a few reads, not one per owed tenant.
 */
export const AUTO_PAPER_RETRIES_PER_PASS = 2;
/**
 * Process slots an automatic admission leaves free under the cap: the
 * runbook's own batch bound (48 workers and holds, less room for restarts and
 * holds: 40). An operator may fill them by hand; this never does.
 */
export const AUTO_PAPER_HEADROOM = 8;

/**
 * AN APPROVAL THE STORE COULD NOT TAKE (recordResumeApproval `transient`: an
 * outage, not a refusal). The re-sign stays owed, and its change sits out a
 * growing number of its turns before it is previewed and inserted again:
 * none after its first failure (the next pass asks again), then 1, 3, 7 … up
 * to AUTO_PAPER_RECORD_MAX_WAIT, about ten minutes of fifteen-second passes.
 * So a store that keeps failing costs each such tenant one preview every few
 * minutes, not one a pass, and the turns it sits out go to the changes behind
 * it. From AUTO_PAPER_RECORD_ALERT_AFTER failures in a row, an [alert].
 */
export const AUTO_PAPER_RECORD_ALERT_AFTER = 3;
export const AUTO_PAPER_RECORD_MAX_WAIT = 40;
/** The turns a change sits out after its `failures`-th transient failure in a row (from 1). */
export function autoPaperRecordWait(failures: number): number {
  const n = Math.max(1, Math.min(30, Math.floor(Number.isFinite(failures) ? failures : 1)));
  return Math.min(AUTO_PAPER_RECORD_MAX_WAIT, 2 ** (n - 1) - 1);
}

/**
 * HOW MANY MORE AUTOMATIC ADMISSIONS FIT, under a cap of `cap` processes:
 * what runs now, and every open approval, which takes a slot as soon as its
 * tenant is admitted (a registered book past the cap waits for one, counted
 * or not). None at or past the cap less its headroom.
 */
export function autoPaperRoom(o: { running: number; open: number; cap: number }): number {
  return Math.max(0, o.cap - AUTO_PAPER_HEADROOM - o.running - o.open);
}

/** Approvals not yet applied or ended: each will take a process slot. A missing table is none. */
export async function countOpenApprovals(db: Db): Promise<number> {
  try {
    return Number(((await db.prepare(`SELECT COUNT(*) AS n FROM ledger_resume_approvals WHERE state IN (${OPEN_STATES.map(() => "?").join(", ")})`)
      .get(...OPEN_STATES)) as Record<string, unknown>).n);
  } catch (e) {
    if (absentTable(e)) return 0;
    throw e;
  }
}

/** The watch's baseline row: present once the roster as it stood when the variable was first on has been recorded as nobody's re-sign. */
const WATCH_BASELINE = "*";

/**
 * WHAT A GRANT ROW IS, AS THE WATCH TELLS ONE SIGNATURE FROM THE NEXT: the
 * tenant, its expiry and the record's server-stamped write time, digested.
 * Every put stamps its own write time (grant-store.ts toRecord), and every
 * signature its own expiry, so a re-sign always changes it. Nothing secret
 * goes in, and nothing that changes without a signature: a replacement stop
 * leaves both as they were, and the put that follows it moves them.
 */
export function grantRowKey(r: { tenant: string; expiresAt: number | null; updatedAt?: number | null }): string {
  return hash(canonical({ tenant: r.tenant.toLowerCase(), expiresAt: r.expiresAt ?? null, updatedAt: r.updatedAt ?? null }));
}

export interface OwedGrantChange { tenant: string; key: string }

/**
 * WHICH GRANT ROWS CHANGED, durably, so a re-sign made while the orchestrator
 * was down (a deploy, a crash) is seen at the next start rather than lost.
 *
 * The first call with no baseline records every roster row as it stands, as
 * settled (`baseline`), and owes nothing: turning the variable on admits
 * nobody by itself. From then on a row the watch has never seen (a new grant
 * row: a re-grant after a removal, or a new tenant) or one whose key moved is
 * owed a preview, and stays owed until settleGrantChange settles that exact
 * key — across passes and restarts — so a tenant waiting for the rollout, a
 * slot or the per-pass budget is previewed when its turn comes, and a second
 * re-sign meanwhile is simply the change still owed. A row that leaves the
 * roster keeps its watch row, so a grant signed again later is a change.
 *
 * `owed` comes IN THE ORDER THE TURNS ARE TAKEN: never tried before the
 * least recently tried (noteGrantAttempt: an automatic preview that could
 * not be read), then the longest owed first, then roster order. Roster order
 * alone is stable (Postgres lists grants with no ORDER BY, the file store in
 * readdir order), so two tenants whose previews never read used to take both
 * of a pass's turns on every pass, and every re-signer behind them stayed
 * owed for good. A change whose key moves is a new change: never tried.
 */
export async function observeGrantChanges(db: Db, roster: ReadonlyArray<{ tenant: string; key: string }>, nowMs: number):
  Promise<{ baselined: number | null; owed: OwedGrantChange[] }> {
  const rows = (await db.prepare("SELECT tenant, grant_key, owed, seen_at_ms, attempted_at_ms FROM ledger_resume_grant_watch").all()) as Array<Record<string, unknown>>;
  const stamp = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  const seen = new Map(rows.map((r) => [String(r.tenant),
    { key: String(r.grant_key), owed: Number(r.owed) === 1, seenAt: stamp(r.seen_at_ms) ?? 0, attemptedAt: stamp(r.attempted_at_ms) }]));
  if (!seen.has(WATCH_BASELINE)) {
    await db.tx(async (tx) => {
      for (const r of roster) {
        await tx.prepare(`INSERT INTO ledger_resume_grant_watch (tenant, grant_key, owed, seen_at_ms, settled_at_ms, run, outcome)
          VALUES (?, ?, 0, ?, ?, NULL, 'baseline') ON CONFLICT (tenant) DO NOTHING`).run(r.tenant.toLowerCase(), r.key, nowMs, nowMs);
      }
      await tx.prepare(`INSERT INTO ledger_resume_grant_watch (tenant, grant_key, owed, seen_at_ms, settled_at_ms, run, outcome)
        VALUES (?, '', 0, ?, ?, NULL, 'baseline') ON CONFLICT (tenant) DO NOTHING`).run(WATCH_BASELINE, nowMs, nowMs);
    });
    return { baselined: roster.length, owed: [] };
  }
  const owed: Array<OwedGrantChange & { seenAt: number; attemptedAt: number | null; at: number }> = [];
  for (const r of roster) {
    const tenant = r.tenant.toLowerCase(), had = seen.get(tenant);
    let turn: { seenAt: number; attemptedAt: number | null } = { seenAt: nowMs, attemptedAt: null };
    if (!had) {
      await db.prepare(`INSERT INTO ledger_resume_grant_watch (tenant, grant_key, owed, seen_at_ms, settled_at_ms, run, outcome, attempted_at_ms)
        VALUES (?, ?, 1, ?, NULL, NULL, NULL, NULL) ON CONFLICT (tenant) DO NOTHING`).run(tenant, r.key, nowMs);
    } else if (had.key !== r.key) {
      await db.prepare(`UPDATE ledger_resume_grant_watch SET grant_key = ?, owed = 1, seen_at_ms = ?, settled_at_ms = NULL, run = NULL, outcome = NULL,
        attempted_at_ms = NULL WHERE tenant = ? AND grant_key = ?`).run(r.key, nowMs, tenant, had.key);
    } else if (!had.owed) continue;
    else turn = { seenAt: had.seenAt, attemptedAt: had.attemptedAt };
    owed.push({ tenant, key: r.key, ...turn, at: owed.length });
  }
  owed.sort((x, y) => (x.attemptedAt ?? -1) - (y.attemptedAt ?? -1) || x.seenAt - y.seenAt || x.at - y.at);
  return { baselined: null, owed: owed.map(({ tenant, key }) => ({ tenant, key })) };
}

/**
 * AN AUTOMATIC PREVIEW OF THIS CHANGE WAS TRIED AND COULD NOT BE READ: it
 * stays owed, and goes behind every change not tried since
 * (observeGrantChanges says why). Only for the key that is owed; it never
 * settles anything.
 */
export async function noteGrantAttempt(db: Db, owed: OwedGrantChange, nowMs: number): Promise<void> {
  await db.prepare("UPDATE ledger_resume_grant_watch SET attempted_at_ms = ? WHERE tenant = ? AND grant_key = ? AND owed = 1").run(nowMs, owed.tenant, owed.key);
}

/**
 * The change is answered: by an automatic approval, a preview the operator
 * reads, or the finding that the gate does not hold the tenant. Settled only
 * for the key that was owed, so a re-sign landing meanwhile stays owed.
 * `outcome` is a short fixed word and a reason with no value in it.
 */
export async function settleGrantChange(db: Db, owed: OwedGrantChange, o: { outcome: string; run: string | null }, nowMs: number): Promise<boolean> {
  const r = await db.prepare(`UPDATE ledger_resume_grant_watch SET owed = 0, settled_at_ms = ?, run = ?, outcome = ? WHERE tenant = ? AND grant_key = ? AND owed = 1`)
    .run(nowMs, o.run, o.outcome.slice(0, 500), owed.tenant, owed.key);
  return r.changes === 1;
}

/**
 * OWED CHANGES THE LANE HAS ALREADY ANSWERED WITHOUT HEARING SO: for each
 * tenant whose change is owed, the latest automatic (auto-paper) approval of
 * it recorded since that change was first seen (the watch's seen_at_ms), in
 * whatever state it is in now, with the key it answers and its run.
 *
 * An insert can commit and its connection drop before the reply
 * (recordResumeApproval says `transient`), and the settle after a recorded
 * approval can fail; either way the change is still owed while the approval
 * goes on to Phase A like any other. Previewed again, the tenant could be
 * approved twice: once Phase A has refused the first approval (evidence that
 * changed), it is no longer open, the fresh preview has a new digest, and
 * neither the verdict nor the insert's own checks stop a second — an
 * automatic re-approval after a refusal, which the lane never makes (its
 * owner signs again first: docs/fleet-resume.md, "Evidence that changes").
 * So such an approval is the change's answer, and the change is settled on
 * it with nothing previewed. Read from the store, not from the lane's memory,
 * so a restart in between finds it too.
 *
 * Only the lane writes auto-paper rows, and only for a change it read as
 * owed. An approval binds the book's evidence, not the grant, so one that
 * landed for a key that moved meanwhile (another replica's attempt) answers
 * the newer key as well. Settling on it only ever approves less.
 */
export async function answeredGrantChanges(db: Db): Promise<Map<string, { key: string; state: string; run: string }>> {
  const rows = (await db.prepare(`SELECT w.tenant AS tenant, w.grant_key AS grant_key, a.state AS state, a.preview_run AS run
    FROM ledger_resume_grant_watch w JOIN ledger_resume_approvals a ON a.tenant = w.tenant
    WHERE w.owed = 1 AND a.source = ? AND a.created_at_ms >= w.seen_at_ms ORDER BY a.created_at_ms, a.approval_id`).all(AUTO_PAPER_SOURCE)) as
    Array<Record<string, unknown>>;
  // In the order they were recorded: the latest for a tenant is the one kept.
  return new Map(rows.map((r) => [String(r.tenant), { key: String(r.grant_key), state: String(r.state), run: String(r.run) }]));
}

/**
 * HAS POSTGRES ANY HISTORY FOR THE TENANT, as its evidence says: an agent
 * registration, a lost book's cursor past zero, or a row in any log or
 * snapshot table. Without any, a tenant whose home holds no book is a new
 * account, which the ordinary path admits on its own.
 */
export function evidenceHasHistory(e: ResumeEvidence): boolean {
  if (e.pg.agent) return true;
  if (e.pg.mirrorState.some((c) => Array.isArray(c) && c[1] !== "0" && c[1] !== "null")) return true;
  for (const table of LOG_SUMMARY) {
    const count = (e.pg.tables[table] as { n?: string } | undefined)?.n;
    if (count !== undefined && count !== "0" && count !== "null") return true;
  }
  for (const table of SNAPSHOT_SUMMARY) {
    const t = e.pg.tables[table] as { n: number } | "absent" | undefined;
    if (t !== "absent" && (t?.n ?? 0) > 0) return true;
  }
  return false;
}

/**
 * WHAT IS STILL OPEN FOR THE ACCOUNT beyond what the preconditions ask: live
 * rows a paper book has no business holding (a live cost basis with a
 * quantity, a live floor, a live trench entry), and owner commands with a
 * financial effect nobody has answered (an order, a self-test, a practice
 * reset: agent_commands, `done_at` null). An operator may well admit such a
 * tenant; the orchestrator does not, by itself. A table not there yet holds
 * nothing; a table that is there without a column asked for is drift, and
 * throws (absentTable says why), so the re-sign stays owed rather than read
 * as holding nothing.
 */
async function openRows(db: Db, account: string): Promise<{ live: number; commands: number }> {
  const count = async (sql: string): Promise<number> => {
    try { return Number(((await db.prepare(sql).get(account.toLowerCase())) as Record<string, unknown>).n); }
    catch (e) { if (absentTable(e)) return 0; throw e; }
  };
  let live = 0;
  for (const sql of [
    "SELECT COUNT(*) AS n FROM cost_basis WHERE LOWER(agent_id) = ? AND mode = 'live' AND qty_raw <> '0'",
    "SELECT COUNT(*) AS n FROM position_floors WHERE LOWER(agent_id) = ? AND mode = 'live'",
    "SELECT COUNT(*) AS n FROM trench_positions WHERE LOWER(agent_id) = ? AND mode = 'live'",
  ]) live += await count(sql);
  const commands = await count("SELECT COUNT(*) AS n FROM agent_commands WHERE LOWER(agent_id) = ? AND kind IN ('trade', 'selftest', 'paper-reset') AND done_at IS NULL");
  return { live, commands };
}

/**
 * IS THIS FRESH PREVIEW THE SAFE CASE? `auto`: the orchestrator may approve
 * it itself. `manual`: the gate holds it and only an operator approves it,
 * each reason said. `not-held`: the gate does not hold it; the ordinary path
 * decides, and an approval would be wrong (it would archive a book that path
 * runs). Read-only. Errs towards `manual`: anything it cannot show safe is
 * the operator's, as it is today.
 *
 * `consentEnforced` is the deployment's live-trading consent as the tenant's
 * worker reads it (settings.ts enforceLiveIntent: false only under
 * MERRYMEN_LIVE_INTENT_STAND_DOWN=1). Stood down, a funded account arms live
 * whatever its owner's settings say (exec-mode.ts `consented`), so "could not
 * arm live" cannot be shown from Postgres and the settings at all — a deposit
 * made during the gap is in no table this reads — and nobody is approved
 * here. The orchestrator also reads the owner's live intent as true then
 * (resumeLiveIntent), so the preview already says chain:required; this says
 * the reason in its own words, and holds even if that ever changes.
 *
 * `chainHeld` on a `manual` verdict: a chain refusal of it that no admission
 * has answered (unansweredChainRefusal). The lane's line then says what
 * CHAIN_HELD_NEXT says, never "approve it by hand" with its digest: an
 * approval of it reads the chain again rather than letting it trade.
 */
export type AutoPaperVerdict = { kind: "auto" } | { kind: "manual"; why: string[]; chainHeld?: true } | { kind: "not-held"; why: string };
export async function autoPaperVerdict(db: Db, entry: PreviewEntry, o: { consentEnforced: boolean }): Promise<AutoPaperVerdict> {
  const e = entry.evidence;
  if (!e || !entry.digest) return { kind: "manual", why: [`its evidence could not be read (${entry.refusals.join("; ") || "no evidence"})`] };
  if (entry.book === "present") {
    return { kind: "not-held", why: "its book is on the volume and not behind a barrier: the ordinary path decides, and admits it if the book proves continuous" };
  }
  if (entry.book !== "blocked" && !evidenceHasHistory(e)) return { kind: "not-held", why: "no history on record: the ordinary path admits a new book" };
  const why: string[] = [];
  if (!o.consentEnforced) {
    why.push("live-trading consent is stood down on this deployment (MERRYMEN_LIVE_INTENT_STAND_DOWN=1): a funded account arms live whatever its owner's settings say");
  }
  if (!entry.pass) why.push(`it did not pass: ${entry.refusals.join("; ")}`);
  // Asked of the store as well as the line, so a line that does not carry it
  // (an older build's) is never read as "not held".
  const chainHeld = entry.chainHeld === true || await unansweredChainRefusal(db, entry.tenant);
  if (chainHeld) {
    // It reads chain:required for this (ResumeCheck.chainHeld), which is said
    // here in its own words rather than as "it could arm live".
    why.push("admission refused it on the chain, for operations or USDG transfers Postgres lacks, and nothing has admitted it since: its paper reading " +
      "comes from a Postgres the chain showed incomplete, so it is read on chain (chain:required) and no approval admits it until what the chain " +
      "showed is booked (docs/chain-gap-booking.md)");
  } else if (entry.chain !== "not-required" || e.checks.chain !== "not-required") why.push("it could arm live (chain:required): a live tenant is only ever approved by hand");
  if (entry.holdsPositions !== false) why.push("Postgres shows it holding positions");
  if (e.checks.unresolved !== 0) why.push("it has unresolved trades on record");
  const open = await openRows(db, e.account);
  if (open.live > 0) why.push(`${open.live} live book row(s) (cost basis, floors or trench entries) are on record`);
  if (open.commands > 0) why.push(`${open.commands} owner command(s) (an order, a self-test or a practice reset) are still open`);
  const prior = ((await db.prepare(`SELECT state FROM ledger_resume_approvals WHERE tenant = ? AND state IN ('revoked', ${OPEN_STATES.map(() => "?").join(", ")})`)
    .all(entry.tenant, ...OPEN_STATES)) as Array<Record<string, unknown>>).map((r) => String(r.state));
  if (prior.includes("revoked")) why.push("an operator revoked an earlier approval of it, so only an operator approves it again");
  if (prior.some((s) => s !== "revoked")) why.push("an approval is already open for it");
  if (!why.length) return { kind: "auto" };
  return chainHeld ? { kind: "manual", why, chainHeld: true } : { kind: "manual", why };
}

/**
 * WHAT AN OPERATOR DOES WITH A TENANT HELD ON A CHAIN REFUSAL NO ADMISSION
 * HAS ANSWERED (ResumeCheck.chainHeld), as the automatic lane's line and the
 * preview's summary both say it: never "approve it by hand" as a way to
 * trade. An approval of it reads the chain again, and while Postgres still
 * lacks what the chain showed it is only refused again.
 *
 * The booking tool books only while a chain refusal is the tenant's newest
 * decision (chain-gap-booking.ts holdOf), so a later refusal for another
 * reason — evidence that changed, say — leaves it nothing to book on. One
 * approval, with the tenant in the rollout so admission runs for it, is the
 * way out: admission reads the chain (the tenant reads chain:required) and
 * records a fresh chain refusal, which is its newest decision again.
 */
export const CHAIN_HELD_NEXT = "an approval does not make it trade until what the chain showed is booked: book it first (docs/chain-gap-booking.md). " +
  "If the booking tool refuses because a later refusal superseded the chain refusal, preview it and approve it once, with it in the rollout at " +
  "exits-only, so admission reads the chain again (it refuses it again while Postgres lacks what the chain showed, recording a fresh chain refusal); " +
  "then book it, then preview it again and approve the digest that preview prints";

/**
 * HAS ADMISSION REFUSED THIS TENANT ON THE CHAIN, WITH NOTHING ADMITTED
 * SINCE? Any approval of it refused with the chain refusal's words
 * (CHAIN_REFUSAL: this build's chainRefusal and the shorter reason before
 * it alike), later than every approval of it that reached `registered` or
 * `applied`. A table not there yet holds no refusal; any other read that
 * fails throws, and every caller fails closed on a throw.
 *
 * WHY IT IS ASKED. The chain check used to run only for a tenant that could
 * arm live, and a chain refusal proves Postgres lacks operations or
 * transfers of the account. "Paper and could not arm live" is read from
 * that same Postgres (no live operation, no flow) and the owner's settings:
 * an owner who turns live trading off after the refusal, and re-signs, would
 * read as paper though the operation Postgres lost may be a live trade.
 * Approved — by the automatic lane, or by an operator's hand — it would be
 * admitted on that book with no chain read, and supersede the refusal the
 * booking tool books on (chain-gap-booking.ts holdOf), so what the chain
 * showed would never be booked. So such a tenant is never paper
 * (resumePreconditions: chain:required), and never the automatic lane's
 * (autoPaperVerdict). Not only the newest decision: an approval refused on
 * other grounds since says nothing about the chain. Only an admission
 * answers it.
 */
async function unansweredChainRefusal(db: Db, tenant: string): Promise<boolean> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (await db.prepare("SELECT state, reason, updated_at_ms FROM ledger_resume_approvals WHERE tenant = ? AND state IN ('refused', 'registered', 'applied')")
      .all(tenant.toLowerCase())) as Array<Record<string, unknown>>;
  } catch (e) {
    if (absentTable(e)) return false;
    throw e;
  }
  const admittedAt = Math.max(-Infinity, ...rows.filter((r) => r.state !== "refused").map((r) => Number(r.updated_at_ms)));
  return rows.some((r) => r.state === "refused" && String(r.reason ?? "").startsWith(CHAIN_REFUSAL) && !(Number(r.updated_at_ms) < admittedAt));
}

// ── the chain ────────────────────────────────────────────────────────────────

/** The slice of a chain client the gap check reads. A fake stands in for it in tests. */
export interface GapChain {
  getBlockNumber(): Promise<bigint>;
  getBlockTimestamp(block: bigint): Promise<number>;
  getLogs(args: { address: `0x${string}`; fromBlock: bigint; toBlock: bigint; topics: (Hex | Hex[] | null)[] }): Promise<RawLog[]>;
}
/**
 * ONE THING ON CHAIN THAT POSTGRES LACKS, named by public chain data only: an
 * operation by its userOpHash, transaction and block (and whether the
 * EntryPoint recorded it as succeeding), or a USDG transfer by its
 * transaction, log, block, direction and amount (base units, 6dp).
 *
 * WHY A REFUSAL NAMES THEM. The check used to say "1 operation(s) and 1
 * transfer(s) on chain that Postgres lacks" and stop, and nothing else a
 * deploy prints could say which: three live tenants sat held on that line
 * with the operator unable to tell a lost trade row from an owner's deposit
 * without reading the chain by hand. Every field here is already public on
 * the chain; nothing from the owner's settings, keys or books is in it.
 *
 * Null where the log did not carry it (a block number, a log index, an
 * amount that is not one 32-byte word), never a guess.
 */
export type MissingChainFact =
  | { kind: "operation"; userOpHash: string; txHash: string; block: string | null; logIndex: number | null; success: boolean | null }
  | { kind: "transfer"; txHash: string; block: string | null; logIndex: number | null; direction: "in" | "out" | "self"; amountRaw: string | null; counterparty: string | null };

export type GapResult =
  | { status: "clean"; fromBlock: string; head: string; ops: number; transfers: number }
  | {
    status: "missing"; ops: number; transfers: number;
    /** The window read, as for `clean`, so a refusal can say where it looked. */
    fromBlock: string; head: string;
    /** Every operation and transfer the counts are made of, in chain order. */
    found: MissingChainFact[];
  }
  | { status: "unavailable"; why: string };

const USEROP_TOPIC = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f" as Hex;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
/** This chain runs near ten blocks a second (index.ts BLOCKS_PER_SEC); the estimate is checked against a timestamp before it is trusted. */
const BLOCKS_PER_SEC_GUESS = 12n;

/** A hex quantity a log carried, as a decimal string; null when it carried none or not one. */
function hexQuantity(v: unknown): string | null {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(v)) return null;
  return BigInt(v).toString();
}
/** The address in the low 20 bytes of a 32-byte topic, or null. */
function topicAddress(t: unknown): string | null {
  return typeof t === "string" && /^0x[0-9a-fA-F]{64}$/.test(t) ? `0x${t.slice(-40).toLowerCase()}` : null;
}
const factOrder = (f: MissingChainFact) => [f.block === null ? -1n : BigInt(f.block), BigInt(f.logIndex ?? -1)] as const;

/**
 * WHAT THE CHAIN SHOWS THAT POSTGRES DOES NOT HOLD, from logs already read.
 * PURE: chainGapCheck's decision, and the booking tool's proof that its rows
 * would answer it (chain-gap-booking.ts), are this one function.
 *
 * An operation is held when Postgres has a trade row with its userOpHash. A
 * USDG transfer is held when Postgres has a trade row with its transaction
 * hash, or a flow with its tx#log, or when an operation Postgres holds is in
 * the same transaction (its leg, booked with it even where its row kept no tx
 * hash). One log read as both from and to the account (a self-transfer) is
 * one movement, not two.
 */
export function chainFactsPostgresLacks(o: {
  account: string;
  opLogs: readonly RawLog[]; outLogs: readonly RawLog[]; inLogs: readonly RawLog[];
  known: { ops: ReadonlySet<string>; txs: ReadonlySet<string>; flows: ReadonlySet<string> };
}): MissingChainFact[] {
  const found: MissingChainFact[] = [];
  const bookedTxs = new Set<string>();
  const index = (l: RawLog) => (l.logIndex === undefined ? null : Number(BigInt(l.logIndex)));
  for (const l of o.opLogs) {
    const opHash = String(l.topics[1] ?? "").toLowerCase();
    const tx = String(l.transactionHash).toLowerCase();
    if (o.known.ops.has(opHash)) { bookedTxs.add(tx); continue; }
    // success is the second word of the event's data (nonce, success, cost, used).
    const data = String(l.data ?? "").replace(/^0x/, "");
    const word = /^[0-9a-fA-F]{256}$/.test(data) ? BigInt(`0x${data.slice(64, 128)}`) : null;
    found.push({ kind: "operation", userOpHash: opHash, txHash: tx, block: hexQuantity(l.blockNumber), logIndex: index(l),
      success: word === 1n ? true : word === 0n ? false : null });
  }
  const account = o.account.toLowerCase();
  const seen = new Set<string>();
  for (const l of [...o.outLogs, ...o.inLogs]) {
    const tx = String(l.transactionHash).toLowerCase();
    const i = index(l);
    if (o.known.txs.has(tx) || bookedTxs.has(tx)) continue;
    if (i !== null && o.known.flows.has(`${tx}:${i}`)) continue;
    if (i !== null) {
      if (seen.has(`${tx}:${i}`)) continue;
      seen.add(`${tx}:${i}`);
    }
    const from = topicAddress(l.topics[1]), to = topicAddress(l.topics[2]);
    const direction = from === account && to === account ? "self" : from === account ? "out" : "in";
    found.push({ kind: "transfer", txHash: tx, block: hexQuantity(l.blockNumber), logIndex: i, direction,
      amountRaw: hexQuantity(l.data), counterparty: direction === "out" ? to : direction === "in" ? from : account });
  }
  return found.sort((a, b) => {
    const [ab, ai] = factOrder(a), [bb, bi] = factOrder(b);
    return ab < bb ? -1 : ab > bb ? 1 : ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}

/** USDG base units (6dp) as a decimal figure, exactly: "5.000000". */
export function usdg6(raw: string): string {
  const v = BigInt(raw), sign = v < 0n ? "-" : "", abs = v < 0n ? -v : v;
  return `${sign}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
}

/** One found fact as an operator reads it: every hash in full, so it can be pasted into an explorer. */
export function describeChainFact(f: MissingChainFact): string {
  const at = f.block === null ? "" : ` at block ${f.block}`;
  if (f.kind === "operation") {
    return `operation ${f.userOpHash} in tx ${f.txHash}${at}${f.success === false ? " (reverted)" : f.success === null ? " (outcome unread)" : ""}`;
  }
  const amount = f.amountRaw === null ? "amount unread" : usdg6(f.amountRaw);
  return `USDG ${f.direction} ${amount} in tx ${f.txHash}${f.logIndex === null ? "" : ` log ${f.logIndex}`}${at}`;
}

/**
 * The found facts as ONE LINE OF AT MOST `maxChars` CHARACTERS: as many as
 * fit, then how many more. A refusal's reason is stored in 500 characters
 * (moveApproval cuts there), and a deploy log line is one line; the booking
 * tool's preview lists them all.
 *
 * THE COUNT IS INSIDE THE LIMIT. It used to be appended after the facts that
 * fit, so a reason with many facts ran past 500 and the cut took "and N more"
 * off the end — the one part that says the list is incomplete. Its room is now
 * reserved at its widest (every fact unsaid, so the most digits), and saying
 * one more fact only ever shortens it. A first fact too long for the room is
 * not cut mid-hash: the line says how many there are instead.
 */
export function describeChainFacts(found: readonly MissingChainFact[], maxChars = 1_800): string {
  const said = found.map(describeChainFact);
  const all = said.join("; ");
  if (all.length <= maxChars) return all;
  const more = (n: number) => `and ${n} more (the booking preview lists every one)`;
  const room = maxChars - more(found.length).length - 2;
  const parts: string[] = [];
  let used = 0;
  for (const s of said) {
    const next = used + (parts.length ? 2 : 0) + s.length;
    if (next > room) break;
    parts.push(s);
    used = next;
  }
  const line = parts.length ? `${parts.join("; ")}; ${more(found.length - parts.length)}` : `${found.length} of them (the booking preview lists every one)`;
  return line.slice(0, maxChars);
}

/** The words a chain refusal starts with. The orchestrator's tests, the booking tool and the runbook quote them. */
export const CHAIN_REFUSAL = "the chain holds operations or USDG transfers for the account that Postgres lacks";
/** The longer of the two ways a chain refusal starts (chainRefusal), with the ": " before the facts. */
const LONGEST_REFUSAL_HEAD = `${CHAIN_REFUSAL}, landed after the admission's first chain read: `;
/** Room for the facts, and the count of those that did not fit, inside the 500-character reason after the longest head. */
const REASON_FACT_CHARS = 500 - LONGEST_REFUSAL_HEAD.length;

/**
 * An admission's refusal for chain activity Postgres lacks, naming it. Fits
 * the stored reason, whole: the prefix the runbook quotes, then as many facts
 * as fit (an operation and its USDG leg do, with every hash in full), then how
 * many more — never more than 500 characters, so moveApproval's cut never
 * lands on it.
 */
export function chainRefusal(found: readonly MissingChainFact[], landedAfterFirstRead = false): string {
  const head = landedAfterFirstRead ? `${CHAIN_REFUSAL}, landed after the admission's first chain read` : CHAIN_REFUSAL;
  return found.length ? `${head}: ${describeChainFacts(found, REASON_FACT_CHARS)}` : head;
}

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
 *
 * OR FROM A BLOCK ALREADY REACHED (`fromBlock`): the re-read immediately
 * before registration (orchestrator.ts resumeAdmission), from the head an
 * earlier clean read of the same window ended at, to the head now. A head
 * behind that block is `unavailable`: an endpoint that lags the one read
 * before would otherwise answer "clean" for blocks it never had.
 */
export async function chainGapCheck(o: {
  chain: GapChain; account: string; usdg: string;
  known: { ops: ReadonlySet<string>; txs: ReadonlySet<string>; flows: ReadonlySet<string> };
  maxSpan?: bigint; log?: (line: string) => void;
} & ({ sinceSec: number; fromBlock?: undefined } | { fromBlock: bigint; sinceSec?: undefined })): Promise<GapResult> {
  try {
    const head = await o.chain.getBlockNumber();
    let from: bigint;
    if (o.fromBlock !== undefined) {
      if (o.fromBlock < 0n || head < o.fromBlock) return { status: "unavailable", why: "the chain's head is behind the block already read" };
      from = o.fromBlock;
    } else {
      const sinceSec = o.sinceSec;
      const headAt = await o.chain.getBlockTimestamp(head);
      let back = BigInt(Math.max(0, headAt - sinceSec)) * BLOCKS_PER_SEC_GUESS + 1000n;
      from = head > back ? head - back : 0n;
      for (let i = 0; from > 0n && (await o.chain.getBlockTimestamp(from)) > sinceSec; i++) {
        if (i >= 8) return { status: "unavailable", why: "could not find a block old enough to start from" };
        back *= 2n;
        from = head > back ? head - back : 0n;
      }
    }
    const span = o.maxSpan ?? 50_000n;
    const account = addressTopic(o.account);
    // The adaptive reader's own chain shape; it never asks for a receipt here.
    const reader = { getBlockNumber: () => o.chain.getBlockNumber(), getLogs: (a: Parameters<GapChain["getLogs"]>[0]) => o.chain.getLogs(a), getReceiptLogs: async () => null };
    const ops = await getLogsAdaptive(reader, { address: ENTRYPOINT.v07 as `0x${string}`, topics: [USEROP_TOPIC, null, account] }, from, head, span, o.log);
    const out = await getLogsAdaptive(reader, { address: o.usdg as `0x${string}`, topics: [TRANSFER_TOPIC, account] }, from, head, span, o.log);
    const into = await getLogsAdaptive(reader, { address: o.usdg as `0x${string}`, topics: [TRANSFER_TOPIC, null, account] }, from, head, span, o.log);
    if (!ops.complete || !out.complete || !into.complete) return { status: "unavailable", why: "the log read did not cover the whole window" };
    const found = chainFactsPostgresLacks({ account: o.account, opLogs: ops.logs, outLogs: out.logs, inLogs: into.logs, known: o.known });
    if (found.length) {
      return { status: "missing", ops: found.filter((f) => f.kind === "operation").length, transfers: found.filter((f) => f.kind === "transfer").length,
        fromBlock: String(from), head: String(head), found };
    }
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

/**
 * The production chain client. The RPC is the orchestrator's own variable
 * for the chain, or — as every other chain read in orchestrator.ts does —
 * the chain's public endpoint (packages/core chain.ts). Returning nothing
 * when MERRYMEN_RPC_MAINNET was unset held every live tenant forever behind
 * one repeated alert, on a service that may well rely on the default today.
 * Null only for a chain with no endpoint at all.
 */
export function resumeChainFor(chainId: number, env: NodeJS.ProcessEnv = process.env): GapChain | null {
  const url = (chainId === 46630 ? env.MERRYMEN_RPC_TESTNET : env.MERRYMEN_RPC_MAINNET) || chainForId(chainId).rpcUrls.default.http[0];
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

/**
 * Moved from the old home into the new one, never left in the archive: the
 * owner's Telegram progress and link record. Unless the carry would not take
 * one (archiveTenantHome step 1), which then stays in the archive instead —
 * and a link record it will not take keeps telegram.json there with it.
 */
const CARRY_MOVE = ["telegram.json", "telegram-promoted.json"] as const;
/** Which of telegram.json's links the orchestrator has promoted (orchestrator.ts PROMOTED_LINKS_FILE). */
const LINK_RECORD = "telegram-promoted.json";
/** Copied: the owner's restrictive controls, which stay in the archive as evidence too. */
const CARRY_COPY = ["paused", "controls-armed.json"] as const;
/** Removed before the home is archived: keys and secrets, all rewritten at the next spawn from the stores. */
const SCRUB = ["grant.json", "grants", "settings.json"] as const;
const MANIFEST = ".archive-manifest.json";
/** The most of telegram.json the offset handoff reads (recovery-reply-handoff.ts); a larger one is never the child's. */
const TELEGRAM_MAX_BYTES = 256 * 1024;

const carriedName = (name: string) =>
  (CARRY_MOVE as readonly string[]).includes(name) || (CARRY_COPY as readonly string[]).includes(name) || name.startsWith("kill-request-");

/**
 * THE HOME'S OWN FILE: a regular file of this process's user, with one name.
 * A copy is always that, whatever its source was, so the carry asks it of the
 * source, before the copy hides another owner or a second name.
 */
function homeOwn(st: Stats): boolean {
  return st.isFile() && st.nlink === 1 && st.uid === process.getuid?.();
}

/**
 * AS OUR OWN WRITERS LEFT IT: the home's own, and nobody else can write it.
 * 0600 is every writer since 2026-09-30 (#198, writeFileAtomicSync); 0644 is
 * a plain writeFileSync before that, at the container's umask (022). Group or
 * world write, an exec or a special bit is no writer of ours, and such a file
 * is never vouched for here: its readers judge it as it is.
 */
function ourWritersLeft(st: Stats): boolean {
  return homeOwn(st) && (st.mode & 0o7777 & ~0o644) === 0;
}

/**
 * The keys restoredTelegramFile wrote, and writeTelegramForChild before #202:
 * never an offset, a bot or prior bots. It writes `offset: 0` beside them now,
 * which the handoff reads as it is; what is recognised here is the file a
 * build before that left in a home, which is still in archives and homes.
 */
const RESTORED_LINK_KEYS: readonly string[] = ["linkCode", "ownerId", "linkedAt", "firedAlerts"];

/**
 * THE ORCHESTRATOR'S RESTORED LINK, and nothing else: what
 * writeTelegramForChild wrote before it wrote an offset (restoredTelegramFile:
 * some of the link code, the owner, the link time and the owner's alert
 * stamps) and, before #202, `{ linkCode (perhaps ""), ownerId, linkedAt
 * (perhaps 0) }`. Another key, or one of these of another type, is not it;
 * nor is what it writes now, which has its offset already.
 */
function restoredLink(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>, keys = Object.keys(v), stamps = v.firedAlerts;
  return keys.length > 0 && keys.every((k) => RESTORED_LINK_KEYS.includes(k))
    && (v.linkCode === undefined || typeof v.linkCode === "string")
    && (v.ownerId === undefined || (Number.isSafeInteger(v.ownerId) && v.ownerId !== 0))
    && (v.linkedAt === undefined || (typeof v.linkedAt === "number" && Number.isFinite(v.linkedAt) && v.linkedAt >= 0))
    && (stamps === undefined || (!!stamps && typeof stamps === "object" && !Array.isArray(stamps)
      && Object.values(stamps).every((at) => Number.isSafeInteger(at) && Number(at) > 0)));
}

/**
 * A CARRIED FILE, MADE WHAT ITS READERS ACCEPT FROM US.
 *
 * The offset handoff (recovery-reply-handoff.ts) reads telegram.json
 * strictly: owner-only, one name, a JSON object whose `offset` is a
 * non-negative integer. Two things our own writers left in homes fail that,
 * and the first held six admitted tenants on "recovery reply offset not
 * handed over" for good:
 *
 *  - THE ORCHESTRATOR'S RESTORED LINK (restoredLink), as writeTelegramForChild
 *    wrote it before it wrote `offset: 0`: no `offset` at all
 *    (restoredTelegramFile says why none is restored: the date rule, not a
 *    restored offset, keeps a replayed backlog from running), and the child
 *    reads a missing offset as 0. A pre-incident home whose spawn was refused
 *    after that write (its rebuilt book then failed the continuity proof)
 *    kept it, no worker or hold process ever replaced it, and the archive
 *    carried it into the new home, where the handoff refused it
 *    (HANDOFF_OFFSET) on every pass.
 *  - A FILE FROM BEFORE #198, written at the umask (0644), which the handoff
 *    refuses (HANDOFF_MODE).
 *
 * So a file our own writers left (ourWritersLeft) is set to 0600, and a
 * telegram.json that is exactly the restored link gets `offset: 0`, which is
 * what every reader already takes it to be, rewritten whole and durably
 * (writeFileAtomicSync), never in place.
 *
 * NOTHING ELSE. A symlink, a file with a second name or another owner, one
 * anyone else could have written (0666, 0664, an exec or a special bit), one
 * larger than any the child writes, and a telegram.json that is anything but
 * the restored link (it does not parse, or holds an offset, a bot or prior
 * bots of its own, or a key no writer of ours wrote) are left exactly as they
 * are, and the handoff judges them by name. A numeric `botId` is not a legacy
 * shape: no build ever wrote one (a digit string since #202).
 *
 * Never throws: a file it cannot read or rewrite is left as it was and said
 * so, and its readers judge it. Says what it changed by file and kind, never
 * a value, and writes nothing once `mayWrite` says this process is no longer
 * the writer.
 */
export function normaliseCarriedFile(file: string, mayWrite: () => boolean): string[] {
  const name = path.basename(file), label = name.startsWith("kill-request-") ? "kill-request" : name;
  const changed: string[] = [];
  let fd: number | null = null;
  try {
    const st = lstatSync(file);
    if (!ourWritersLeft(st)) return [];
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const at = fstatSync(fd);
    if (at.ino !== st.ino || at.dev !== st.dev || !ourWritersLeft(at)) return [];
    if (name === "telegram.json" && at.size <= TELEGRAM_MAX_BYTES) {
      let value: unknown = null;
      try { value = JSON.parse(readFileSync(fd, "utf8")); } catch { /* left for the handoff to refuse by name */ }
      if (restoredLink(value)) {
        const now = lstatSync(file);
        if (now.ino !== at.ino || now.dev !== at.dev || now.ctimeMs !== at.ctimeMs || !mayWrite()) return [];
        writeFileAtomicSync(file, JSON.stringify({ offset: 0, ...value }, null, 2), 0o600, { durable: true });
        changed.push(`${label}: offset`);
        if ((at.mode & 0o777) !== 0o600) changed.push(`${label}: mode`);
        return changed;
      }
    }
    if ((at.mode & 0o777) !== 0o600) {
      if (!mayWrite()) return [];
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
      changed.push(`${label}: mode`);
    }
    return changed;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    // No file is nothing to normalise: a home that carried none, and had none restored.
    if (code === "ENOENT" && !changed.length) return [];
    return [...changed, `${label}: left as it was (${typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : "error"})`];
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* opened read-only: nothing to lose */ } }
  }
}

/**
 * AN EARLIER BUILD'S RESTORED LINK, IN ANY HOME, GIVEN THE OFFSET THE RESTORE
 * WRITES NOW, just before the offset handoff reads it. The offset, and nothing
 * else.
 *
 * writeTelegramForChild wrote the restored link (restoredLink) with no offset
 * until it wrote `offset: 0` (orchestrator.ts restoredTelegramFile), and the
 * handoff refuses a telegram.json with none (HANDOFF_OFFSET). Child homes live
 * on the fleet volume (persistent-home.ts), so a link an earlier build
 * restored outlives the deploy that fixed the restore, and the restore never
 * rewrites a file that is there (a running child is the authority on its own
 * link). An ordinary tenant whose bot the recovery listener had answered, and
 * whose spawn the handoff had refused on that file, was refused on every pass
 * after the fix exactly as before it: no worker, and held no hold process, for
 * as long as the listener's row stood. A registered book's home is put right
 * by normaliseRegisteredHome (normaliseCarriedFile); nothing put an ordinary
 * one right. This does, on these terms:
 *
 *  - ONLY THE RESTORED LINK, EXACTLY (restoredLink): the keys writeTelegramForChild
 *    wrote, of the types it wrote, and no other. No child writes that shape:
 *    saveTelegramState (telegram/state.ts) writes the whole state, its offset
 *    with it, and so does the hold process through it. A file of that shape
 *    is the restore's, and no worker or hold process has saved over it.
 *  - ONLY `offset: 0`, which every reader already takes the missing one to be
 *    (telegram/state.ts loadTelegramState, and the hold process through it),
 *    and which the restore itself writes now: the home ends exactly as this
 *    build's restore would have left it, and the child asks from no saved
 *    offset as it did, with the date rule (service.ts) holding a replayed
 *    backlog back. The handoff then raises it to the listener's mark, as it
 *    does any file.
 *  - ONLY AS THE RESTORE HAS WRITTEN IT SINCE #198: this user's, one name,
 *    0600 exactly, no larger than the handoff reads, in a home that is this
 *    user's own plain directory at its real path (what the handoff asks of it,
 *    HANDOFF_HOME). Opened without following a link, asked again of the
 *    descriptor, and again by name (inode, device, size and times, and the
 *    home's own) after the writer is asked the last time and just before the
 *    write; rewritten whole and durably (writeFileAtomicSync), never in place.
 *  - NEVER A MODE. A restored link at the umask (0644, from before #198) is
 *    left as it is, and the handoff refuses it by its mode (HANDOFF_MODE) as
 *    it always has. Vouching for who wrote a file is normaliseCarriedFile's,
 *    and only in a registered book's home, where nobody else can have been.
 *  - ONLY WITH THE HANDOFF'S OWN WRITER PROOF (`mayWrite`: the lease, no late
 *    refusal, so no child running for the tenant, and no source barrier),
 *    asked first and again before the write, in the window where the handoff
 *    writes this same file.
 *
 * Anything else, every other file with no offset among it, is left exactly as
 * it is, and the handoff judges it by name as it always has: HANDOFF_OFFSET
 * is unchanged for every shape but this one. Never throws; says what it
 * changed by kind, never a value, and what it could not, by its errno.
 */
export function offsetRestoredLink(home: string, mayWrite: () => boolean): string[] {
  const label = "telegram.json";
  /** As the restore has left it since #198: the home's own, nobody else can write it, 0600 exactly, no larger than the handoff reads. */
  const asRestored = (s: Stats) => ourWritersLeft(s) && (s.mode & 0o7777) === 0o600 && s.size <= TELEGRAM_MAX_BYTES;
  let fd: number | null = null, writing = false;
  try {
    if (!mayWrite()) return [];
    const dir = path.resolve(home), d = lstatSync(dir);
    if (!d.isDirectory() || d.uid !== process.getuid?.() || realpathSync(dir) !== dir) return [];
    const file = path.join(dir, label), st = lstatSync(file);
    if (!asRestored(st)) return [];
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const at = fstatSync(fd);
    if (at.ino !== st.ino || at.dev !== st.dev || !asRestored(at)) return [];
    let value: unknown = null;
    try { value = JSON.parse(readFileSync(fd, "utf8")); } catch { return []; }
    if (!restoredLink(value)) return [];
    if (!mayWrite()) return [];
    const now = lstatSync(file), still = lstatSync(dir);
    if (now.ino !== at.ino || now.dev !== at.dev || now.size !== at.size || now.mtimeMs !== at.mtimeMs || now.ctimeMs !== at.ctimeMs
      || still.ino !== d.ino || still.dev !== d.dev) return [];
    writing = true;
    writeFileAtomicSync(file, JSON.stringify({ offset: 0, ...value }, null, 2), 0o600, { durable: true });
    return [`${label}: offset`];
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    // No home or no file is nothing to give an offset to: the handoff writes
    // the listener's mark into a file of its own.
    if (code === "ENOENT" && !writing) return [];
    const kind = typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : "error";
    return [writing ? `${label}: offset write failed (${kind})` : `${label}: left as it was (${kind})`];
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* opened read-only: nothing to lose */ } }
  }
}

/** A name at `file`, whatever it is: asked with lstat, so a link is never followed, and anything but ENOENT is one. */
function named(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== "ENOENT"; }
}
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

/**
 * `normalised`: what normaliseCarriedFile changed in the carry, by file and
 * kind. `left`: the moved Telegram files the carry would not take (step 1),
 * or would not take without the other (the pair), which stay in the archive.
 */
export interface ArchiveResult { archivePath: string | null; carried: string[]; normalised: string[]; left: string[] }

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
 *     record. Rebuilt from the home on every attempt until the rename — which
 *     is only safe because, until the rename, the home still holds every
 *     original the stage copies (step 2 removes no carried file).
 *     A copy is this process's, with one name, whatever its source was, and
 *     keeps only the source's mode and bytes. So the Telegram files are
 *     carried only as the home's own (homeOwn): one with another owner or a
 *     second name is not copied, stays in the archive (step 4), and the next
 *     spawn restores the link from the mirror (writeTelegramForChild).
 *     AND THE TWO ARE A PAIR. The link record is what says which of
 *     telegram.json's linkedChats are already in the stored allowlist
 *     (orchestrator.ts publishChildTelegram), and a home without one reads
 *     as none promoted (readPromotedLinks: {}). Carried without it,
 *     telegram.json would have every chat it ever linked promoted again, and
 *     one the owner removed on the dashboard would get back its trade,
 *     transfer and kill authority. So a record the carry will not take keeps
 *     telegram.json in the archive beside it, and the next spawn restores
 *     only the link's safe fields from the mirror (never linkedChats). A home
 *     with no record carries telegram.json as it always has, and one whose
 *     telegram.json the carry will not take still carries its record, which
 *     can only keep a link it names from being promoted again. The
 *     owner's restrictive controls are copied whatever they are: a stop is
 *     never dropped. A copy of a file our own writers left (ourWritersLeft,
 *     asked of the source) is made what its readers accept from us
 *     (normaliseCarriedFile: 0600, and the restored link given offset 0);
 *     any other copy keeps the source's mode and bytes, and its readers
 *     judge it as they would have in the home.
 *  2. Scrub the home of its keys and secrets: grant.json (the session key),
 *     grants/ (archived keys), settings.json (bot token and provider keys).
 *     Each is rewritten by the next spawn from its store, so nothing is lost
 *     and no key ever enters the archive.
 *  3. Rename the home to archive/<tenant>/<generation> (0700) in one step on
 *     the same volume, and sync both parents.
 *  4. Remove the MOVED Telegram files the stage holds from the archive, now
 *     that the staged copy is their only home (and re-apply the scrub, for a
 *     rename a crash interrupted after it). One step 1 would not take is not
 *     in the stage and stays here, and so does a telegram.json whose record
 *     stays (an earlier build's stage may hold one: it goes back). Never
 *     before the rename: a crash between a removal from the home and the
 *     rename used to leave the next attempt rebuilding the stage from a home
 *     that no longer held them, so the owner's link, offsets and chat
 *     settings were lost from both places.
 *  5. Write the archive's manifest (0600): every file's path, type, size and
 *     mode — stats, not contents.
 *  6. Move the staged carry into a fresh 0700 home, never over a file
 *     already there. A carry an earlier build staged moves as it was, but
 *     for the pair (step 4 keeps a telegram.json staged without the record
 *     the archive kept); the spawn path makes a registered book's
 *     telegram.json the same before the handoff reads it (orchestrator.ts
 *     normaliseRegisteredHome).
 *
 * With no home at all there is nothing to archive, and the result says so.
 * The archive is never deleted by any code here.
 */
export function archiveTenantHome(o: { home: string; archiveRoot: string; generation: string; mayWrite: () => boolean }): ArchiveResult {
  const lost = () => new Error("Lost the tenant lease while archiving its home; the next pass resumes the archive.");
  const dest = path.join(o.archiveRoot, o.generation), stage = path.join(o.archiveRoot, `.carry-${o.generation}`);
  if (!o.mayWrite()) throw lost();
  const normalised: string[] = [];
  if (!existsSync(dest)) {
    if (!existsSync(o.home)) return { archivePath: null, carried: [], normalised: [], left: [] };
    if (!lstatSync(o.home).isDirectory()) throw new Error("the tenant home is not a plain directory");
    mkdirSync(o.archiveRoot, { recursive: true, mode: 0o700 });
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { mode: 0o700 });
    const names = readdirSync(o.home).sort();
    // The pair, from one look at the record before either is staged: the
    // same look decides whether the record itself is.
    const record = names.includes(LINK_RECORD) ? lstatSync(path.join(o.home, LINK_RECORD)) : null;
    const recordWithheld = record !== null && !homeOwn(record);
    for (const name of names) {
      const from = path.join(o.home, name), to = path.join(stage, name);
      if (!carriedName(name)) continue;
      const source = name === LINK_RECORD && record ? record : lstatSync(from);
      if (!source.isFile()) continue;
      // The Telegram files only as the home's own, and never one without the
      // record the home holds; the controls whatever they are.
      if ((CARRY_MOVE as readonly string[]).includes(name) && (!homeOwn(source) || recordWithheld)) continue;
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      // Asked of the source, as it was before and after the copy: the copy
      // itself is always this process's, with one name. Written in this
      // attempt's own stage, like the copy, and the lease is asked once the
      // copies are made, as it is for them: the next attempt rebuilds it.
      const after = lstatSync(from);
      if (ourWritersLeft(source) && after.ino === source.ino && after.dev === source.dev && after.ctimeMs === source.ctimeMs) {
        normalised.push(...normaliseCarriedFile(to, () => true));
      }
      syncFile(to);
    }
    syncDir(stage); syncDir(o.archiveRoot);
    if (!o.mayWrite()) throw lost();
    // Keys and secrets only. The carried files stay until the rename, so a
    // stage rebuilt after a crash here still finds every one of them.
    for (const name of SCRUB) rmSync(path.join(o.home, name), { recursive: true, force: true });
    syncDir(o.home);
    if (!o.mayWrite()) throw lost();
    renameSync(o.home, dest);
    chmodSync(dest, 0o700);
    syncDir(o.archiveRoot); syncDir(path.dirname(o.home));
  }
  // From here the old home is the archive. Re-entry lands here. The stage is
  // never rebuilt past this point (dest exists), so it holds the only copy of
  // the moved files from here on, until step 6 puts them in the new home.
  // Only those it holds: one step 1 would not take stays where it is. (With
  // no stage left, step 6 has run, and this removed them before it did.)
  // A stage an earlier build made may hold telegram.json without the record
  // the archive kept (it asked each file alone, or passed over a record that
  // was not a plain file). The pair holds for it too: that copy goes back to
  // the archive, or is dropped while the archive still has the original, and
  // never reaches the new home alone.
  const stagedLink = path.join(stage, "telegram.json");
  if (existsSync(stagedLink) && !named(path.join(stage, LINK_RECORD)) && named(path.join(dest, LINK_RECORD))) {
    if (named(path.join(dest, "telegram.json"))) rmSync(stagedLink);
    else renameSync(stagedLink, path.join(dest, "telegram.json"));
    syncDir(stage);
  }
  for (const name of SCRUB) rmSync(path.join(dest, name), { recursive: true, force: true });
  for (const name of CARRY_MOVE) if (existsSync(path.join(stage, name))) rmSync(path.join(dest, name), { recursive: true, force: true });
  syncDir(dest);
  if (!existsSync(path.join(dest, MANIFEST))) {
    writeFileAtomicSync(path.join(dest, MANIFEST), JSON.stringify({ version: 1, generation: o.generation, files: walk(dest) }, null, 2), 0o600, { durable: true });
  }
  const left = CARRY_MOVE.filter((name) => { try { lstatSync(path.join(dest, name)); return true; } catch { return false; } });
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
  return { archivePath: dest, carried, normalised, left };
}

// ── phase C: the seed the first mirror pass will publish ────────────────────

/**
 * Written into the home once the attested book's seed is proved complete,
 * BEFORE its first worker can start. Its absence is what says no worker has
 * ever run on this book: the only state in which the orchestrator may write a
 * basis or floor into it beside rows already there.
 */
export const ATTESTED_SEED_FILE = "attested-seed.json";

/** The live cost basis and graded floors the attested book must hold before its first worker: exactly what the B4 seeds restore into an empty book. */
export interface AttestedSeedPlan { basis: BasisSeedRow[]; floors: FloorSeedRow[] }

/**
 * WHY THE SEED IS NOT BEST-EFFORT HERE.
 *
 * A rebuilt book has always had its basis and floors seeded from Postgres
 * (orchestrator.ts seedBasisForChild, basis-seed.ts), best-effort: a failed
 * seed logged FAILED and the worker armed anyway. That was survivable before,
 * because the mirror's rebuilt-book guard (ledger-mirror.ts: `restarted`, set
 * when a lost book's cursor points past the new book's ids) skipped the
 * DELETE of cost_basis, position_floors and class_positions, so Postgres kept
 * the only copy and the next spawn seeded from it again.
 *
 * Registration removes the lost book's cursors (it must: the continuity
 * proof would otherwise read them against the new book), and with them that
 * guard. The first mirror pass after admission therefore REPLACES the
 * tenant's snapshot rows in Postgres with what the new book holds. If a seed
 * had failed — one pool blip in the basis SELECT — the new book would hold no
 * cost for a live position, the first pass would delete Postgres's, every
 * later seed would find nothing, and both mechanical exits refuse a position
 * with no cost: an exits-only tenant whose stops do nothing.
 *
 * So for an attested book, before its first worker, the seed is COMPLETED and
 * PROVED: every live basis row the seed would restore (planBasisSeed over an
 * empty book: a held symbol, a positive quantity) and every floor beside one
 * (planFloorSeed) must be in the book, or the spawn is held and asked again
 * on the next pass. That makes "the first mirror pass leaves Postgres holding
 * the seeded set" true by construction rather than by luck. The pre-images
 * are archived either way (ledger_snapshot_archive).
 *
 * Read from Postgres as the seeds read it: the basis by any spelling of the
 * account (single-spelling is a precondition), the floors by the grant's own
 * spelling, which is the one the worker reads them back by.
 */
export async function planAttestedSeed(shared: Db, account: string): Promise<AttestedSeedPlan> {
  const rows = (await shared.prepare("SELECT mode, symbol, qty_raw, cost_usdg FROM cost_basis WHERE lower(agent_id) = lower(?) AND mode = 'live'")
    .all(account)) as Array<Record<string, unknown>>;
  const held = (await shared.prepare("SELECT symbol FROM positions WHERE lower(agent_id) = lower(?) AND raw_balance <> '0'").all(account)) as Array<Record<string, unknown>>;
  const basis = planBasisSeed({
    childRowCount: 0,
    heldSymbols: held.map((r) => String(r.symbol ?? "")),
    shared: rows.map((r) => ({ mode: String(r.mode ?? "live"), symbol: String(r.symbol ?? ""), qtyRaw: String(r.qty_raw ?? "0"), costUsdg: String(r.cost_usdg ?? "0") })),
  }).rows;
  const int = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const x = Number(v);
    return Number.isSafeInteger(x) ? x : null;
  };
  const stamped = ((await shared.prepare("SELECT mode, symbol, stop_bps, rung, why, at FROM position_floors WHERE agent_id = ? AND mode = 'live'").all(account)) as
    Array<Record<string, unknown>>).map((r) => ({
    mode: String(r.mode ?? ""), symbol: String(r.symbol ?? ""), stopBps: int(r.stop_bps) ?? Number.NaN, rung: String(r.rung ?? ""), why: String(r.why ?? ""), at: int(r.at),
  }));
  const floors = planFloorSeed({ childRowCount: 0, restored: basis.map((b) => ({ mode: b.mode, symbol: b.symbol })), shared: stamped }).rows;
  return { basis, floors };
}

/**
 * PUT EVERY PLANNED ROW INTO THE ATTESTED BOOK AND PROVE IT IS THERE, in one
 * transaction on the book. Rows the ordinary seed already wrote are left as
 * they are (ON CONFLICT DO NOTHING, first write wins, as setPositionFloor) and
 * then compared: a row in the book that disagrees with the plan refuses. Asked
 * whether it may still write before the first row and again before the
 * commit; a late refusal rolls the rows back.
 *
 * ONLY FOR A BOOK NO WORKER HAS RUN ON (no ATTESTED_SEED_FILE): there the
 * seeds are its only writers, so a row it lacks is one a seed failed to write,
 * never one a worker closed. A book a worker has run on is its own authority,
 * as planBasisSeed says, and is never touched here.
 */
export async function completeAttestedSeed(o: { book: Db; account: string; plan: AttestedSeedPlan; mayWrite: () => string | null }):
  Promise<{ ok: true; basis: number; floors: number } | { ok: false; why: string }> {
  const refusedFirst = o.mayWrite();
  if (refusedFirst !== null) return { ok: false, why: `nothing written — ${refusedFirst}` };
  try {
    await o.book.tx(async (db) => {
      for (const b of o.plan.basis) {
        await db.prepare(`INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at) VALUES (?, ?, ?, ?, ?, unixepoch())
          ON CONFLICT(agent_id, mode, symbol) DO NOTHING`).run(o.account, b.mode, b.symbol, b.qtyRaw, b.costUsdg);
        const have = (await db.prepare("SELECT qty_raw, cost_usdg FROM cost_basis WHERE agent_id = ? AND mode = ? AND symbol = ?").get(o.account, b.mode, b.symbol)) as
          Record<string, unknown> | undefined;
        if (!have || String(have.qty_raw) !== b.qtyRaw || String(have.cost_usdg) !== b.costUsdg) throw new Error(`the book's ${b.mode} basis for ${b.symbol} disagrees with the shared ledger`);
      }
      for (const f of o.plan.floors) {
        await db.prepare(`INSERT INTO position_floors (agent_id, mode, symbol, stop_bps, rung, why, at) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, unixepoch()))
          ON CONFLICT(agent_id, mode, symbol) DO NOTHING`).run(o.account, f.mode, f.symbol, f.stopBps, f.rung, f.why, f.at);
        const have = (await db.prepare("SELECT stop_bps FROM position_floors WHERE agent_id = ? AND mode = ? AND symbol = ?").get(o.account, f.mode, f.symbol)) as
          Record<string, unknown> | undefined;
        if (!have || Number(have.stop_bps) !== f.stopBps) throw new Error(`the book's ${f.mode} floor for ${f.symbol} disagrees with the shared ledger`);
      }
      const late = o.mayWrite();
      if (late !== null) throw new Error(`refused before commit — ${late}`);
    });
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, basis: o.plan.basis.length, floors: o.plan.floors.length };
}

export function writeAttestedSeedMarker(home: string, r: { generation: string | null; basis: number; floors: number; atSec: number }): void {
  writeFileAtomicSync(path.join(home, ATTESTED_SEED_FILE), JSON.stringify({ version: 1, ...r }, null, 2), 0o600, { durable: true });
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
