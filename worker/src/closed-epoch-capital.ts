/**
 * FILING A CLOSED EPOCH'S CAPITAL FROM THE CHAIN — ONE TENANT, PREVIEW FIRST.
 *
 * THE SITUATION. Attested-gap admission (ledger-resume.ts, "B7") holds a
 * tenant while the chain shows an operation or a USDG transfer Postgres has
 * no row for, and only a row answers it: a trades row by userOpHash, or a
 * flow by tx#log in ANY epoch (knownChainFacts is epoch-blind) — or, for an
 * operation the owner's root key signed, an acknowledged owner record
 * (owner_operations) that the chain re-derives (ledger-resume.ts
 * ownerAnswersFor). A record answers the operation and the custody-internal
 * legs it covers, never a capital leg: that still needs its flow. The booking
 * tool (chain-gap-booking.ts) files what it books into the CURRENT epoch and
 * refuses a fact from before that epoch opened, rightly: which epoch it
 * belongs to is not something it can say. So a tenant held on an owner's
 * deposit that landed, was traded and was withdrawn again all inside an
 * epoch that has since been closed stays held for good. 0x0e1ca0… is that
 * tenant: deposit c8ab…#0 on 2026-09-15, seventeen session trades, the
 * owner's root-key sweep ffd1…#7 back to the funding wallet at 21:09:23Z on
 * 09-16, and epoch 2 opened twelve minutes later.
 *
 * WHAT THIS DOES. For one tenant and the closed epoch 1, it proves from
 * Postgres and the chain that the epoch was still open after its last
 * capital movement and closed before the next epoch's first row, reads the
 * account's whole USDG history from block 0 (in spans the public node
 * accepts), classifies every movement with the shared classifier over its
 * whole receipt, and files the capital movements epoch 1 lacks — IN AND OUT,
 * as the pair the chain shows — as 'chain-log' rows with their exact tx, log,
 * block and block time. In the same transaction, in accounting-repair.ts's
 * order (insert, verify, quarantine), it moves any unevidenced stand-in those
 * rows supersede to flows_quarantine. And it deletes a LIVE cost basis (and
 * its floor) that admission would seed into the attested book for a token
 * the chain shows the book no longer holds (see staleBasisPlan) — only where
 * admission's drain of the tenant's home cannot copy it back before it seeds
 * (retainedHomeVerdict); elsewhere the tenant stays held.
 *
 * WHY A NEW TOOL AND NOT A MODE (docs/closed-epoch-capital.md says more).
 * chain-gap-booking's contract is narrow and reviewed: it answers the facts
 * admission names, in the current epoch, and never quarantines or touches a
 * basis. The pair here is not all admission facts (the sweep's out leg is
 * already answered by a trades row in its transaction), it targets a closed
 * epoch, and it needs insert→verify→quarantine plus a basis clear. A mode
 * would change that tool's digest-bound plan, its compare-and-set and its
 * revert for every tenant it books. accounting-repair is the precedent for
 * the order and for flows_quarantine, but it is environment-driven, has no
 * preview digest, receipt or revert, and is hard-wired to epoch 1 = current.
 * So this borrows chain-gap-booking's safety model by import and
 * accounting-repair's mutation order and quarantine statements.
 *
 * ONLY EPOCH 1 IN THIS RELEASE. A later epoch's lower boundary cannot be
 * proved from rows (a bump may write none), so "epoch P's flows equal the
 * chain's capital movements" is not provable for P > 1. Epoch 1's lower
 * boundary is the account's chain genesis, which the full read covers.
 *
 * WHAT IT NEVER DOES: write trades, agents (beyond the no-op row lock),
 * positions, paper_book, journal, events, fee_accruals or risk_periods; write
 * any row in an epoch other than the one it proved; move a row between
 * epochs; book an operation (an owner's root-key operation is the owner's,
 * and no row here may misattribute it as the agent's); file as capital a
 * movement the owner did not make — USDG out anywhere but inside the owner's
 * root-key operation, or anything in a transaction where a session key
 * acted (capitalProvenance); book an in-kind
 * movement (review only, capital-classify.ts asset-out); move a peak; run
 * for a tenant that is not held on a chain refusal with a quiet book
 * (chain-gap-booking.ts holdOf); print or save a secret.
 *
 * PREVIEW, THEN APPLY, BOUND BY ONE DIGEST, exactly as chain-gap-booking:
 * Postgres in one REPEATABLE READ READ ONLY snapshot, then the chain, then
 * a pure plan whose previewDigest binds the code, the database target, every
 * Postgres fact it relied on and every chain fact it read. Apply recomputes
 * it, requires the confirmed digest and a named backup, and in ONE
 * transaction locks the agent row, compares every fact again, inserts,
 * verifies, quarantines, clears, proves its postconditions and records one
 * receipt per action. Revert is exact: original flow ids, every pre-image,
 * the quarantine rows kept as history.
 *
 * Reviewed operator tool: never imported by the orchestrator or a worker.
 * docs/closed-epoch-capital.md is the runbook.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./db";
import { CASH, ENTRYPOINT, classifyUsdgMovement, energyReserveTokens, type Classification } from "../../packages/core/src/index";
import { decodeUserOperationEvent, segmentReceipt, USER_OPERATION_EVENT_TOPIC, validatorOfNonce } from "./asset-movements";
import { legsFromReceipt, TRANSFER_TOPIC, type RawChainLog, type RpcCall } from "./chain-capital";
import { CapitalFlowsWithheld, collapseFlows, flowDuplicateReport, type FlowRecord } from "./distinct-flows";
import { addressTopic, getLogsAdaptive } from "./inflight-reconcile";
import {
  attestedSourceInUse, chainGapCheck, describeChainFact, homeBookState, planAttestedSeed, RESUME_USDG, usdg6, type AttestedSeedPlan, type HomeIdentity, type MissingChainFact,
} from "./ledger-resume";
import { planBasisSeed, planFloorSeed } from "./basis-seed";
import { admitCapitalFlow, tradingModeOf } from "./paper-boundary";
import { EVIDENCED_FLOW_SOURCES, reconcileEpochCarry } from "./accounting-scope";
import { FLOW_SNAPSHOT_COLUMNS, flowFingerprintOf, type ProposedFlowRow } from "./accounting-reconstruction";
import { hasChainIdentityIndex, inspectChainIdentityIndex, verifyInserted } from "./accounting-repair";
import { heldResetEvent } from "./held-reset";
import { ownerOperationOf, type OwnerOperationReading } from "./owner-operations";
import {
  admittedSince, ANCHOR_MARGIN_SEC, BACKUP_REF, BALANCE_OF_SELECTOR, BOOKING_CONFIRMATIONS, BOOKINGS_TABLE, BookingRefused, canonical, casFacts, digestOf,
  existingColumns, existingTables, factsStillMissing, FLOW_COLUMNS, gapChainOf, holdOf, patiently, readAdmissionState, readBookingSnapshot, sameRow,
  storedRow, unixSec, type AdmissionState, type BookingSnapshot, type ChainEvidence, type Dialect, type FlowProposal, type TxEvidence,
} from "./chain-gap-booking";

export const CLOSED_EPOCH_FORMAT = "merrymen.closed-epoch-capital.v1";
export const CLOSED_EPOCH_APPLY_FORMAT = "merrymen.closed-epoch-capital.apply.v1";
export const CLOSED_EPOCH_REVERT_FORMAT = "merrymen.closed-epoch-capital.revert.v1";
/** The receipts table: one row per action, kept (as 'reverted') after a revert. */
export const REPAIRS_TABLE = "closed_epoch_repairs";
/**
 * The widest eth_getLogs span asked for. The public node refuses a filtered
 * read over more than 10,000,000 blocks ("query spans N blocks … only
 * 10000000 are allowed … narrow the block range", which rpc-error.ts reads
 * as range-too-large); getLogsAdaptive halves on that and never steps over
 * a block, and a read it cannot finish is incomplete, which blocks the plan.
 */
export const CLOSED_EPOCH_LOG_SPAN = 10_000_000n;
/** The only epoch this release files into (see the header). */
export const SUPPORTED_EPOCH = 1;
/**
 * How far a filed fact must sit inside its epoch's bounds: the chain's clock
 * against the stamps the ledger's writers took (chain-gap-booking.ts
 * ANCHOR_MARGIN_SEC gives the argument).
 */
export const BOUNDARY_MARGIN_SEC = ANCHOR_MARGIN_SEC;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
export const REPAIR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const lower = (s: unknown) => String(s ?? "").toLowerCase();
const USDG = lower(CASH.USDG);
const EP = lower(ENTRYPOINT.v07);
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const intOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
};
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const iso = (sec: number | null): string => (sec === null ? "never" : new Date(sec * 1000).toISOString());
/** Money compared as integers: a float equality test on USDG is not a check. */
const micro = (usdg: number): bigint => BigInt(Math.round(usdg * 1e6));
const said = (m: bigint): string => usdg6(m.toString());

/** One refusal, by name and sentence. Nothing in either is private. */
export interface Refusal { code: string; why: string }

// ── the Postgres half ────────────────────────────────────────────────────────

/** One flows row as stored (FLOW_SNAPSHOT_COLUMNS), normalised for comparison; `raw` is what the fingerprint and a revert read. */
export interface FlowRow {
  id: number; agentId: string; direction: string; amountUsdg: number; txHash: string | null; blockNumber: number | null; logIndex: number | null;
  source: string; epoch: number; chainId: number | null; at: number;
}
export interface QuarantineRow {
  originalId: number; agentId: string; epoch: number | null; direction: string | null; amountUsdg: number | null; txHash: string | null; blockNumber: number | null;
  logIndex: number | null; source: string | null; at: number | null; runId: string; quarantinedAt: number; reason: string; replacedBy: string | null;
}
export interface BasisRow { agentId: string; mode: string; symbol: string; qtyRaw: string; costUsdg: string; updatedAt: number | null }
export interface FloorRow { agentId: string; mode: string; symbol: string; stopBps: number | null; rung: string; why: string; at: number | null }
/** The boundary events, reduced to what they say about epochs. Never their text. */
export type EventClass = "held-reset" | "paper-reset" | "opened" | "funded" | "withdrawn";
export interface EpochBound { table: string; epoch: number; n: number; min: number | null; max: number | null }
export interface EquityShape { id: number; epoch: number; at: number; mode: string | null; ethWei: string | null; cashUsdg: number; vaultUsdg: number; positionsUsdg: number; equityUsdg: number; flowsHeld: number | null }

/**
 * WHAT POSTGRES SAYS FOR ONE TENANT, IN ONE READ: the booking tool's whole
 * snapshot (the hold, the grant field by field, the admission state, the
 * known chain facts, positions and live basis) and everything a closed
 * epoch is judged on. Read in one transaction; a table not created yet is
 * asked of the catalogue, never learnt from a failed statement (a failure
 * aborts a Postgres transaction: chain-gap-booking.ts existingTables).
 */
export interface ClosedEpochSnapshot {
  booking: BookingSnapshot;
  /** The epoch asked for. */
  epoch: number;
  /** grant_json's smartAccount exactly as written: the spelling admission seeds floors by (orchestrator.ts planAttestedSeed). */
  rawGrantAccount: string | null;
  /** The registration's financial columns, for the peaks-unchanged postcondition. Null unless exactly one row. */
  agent: { smartAccount: string; epoch: number; mode: string | null; chainId: number | null; hwmUsdg: number; hwmWithdrawnUsdg: number; accruedFeeUsdg: number;
    contributionsKnown: number | null; contributionsWhy: string | null; qualityAt: number | null } | null;
  /** Every flows row of the account, every epoch, and their fingerprint (accounting-reconstruction.ts flowFingerprintOf). */
  flows: { rows: FlowRow[]; fingerprint: string | null };
  quarantine: { rows: QuarantineRow[] };
  /** Per table and epoch: how many rows, and their earliest and latest stamps in seconds. */
  bounds: EpochBound[];
  /** The epoch's own valuations: equity.at is stamped when the row is written, so these date the epoch from below. */
  marks: Array<{ id: number; at: number; mode: string | null; equityUsdg: number }>;
  /** The earliest valuation of any later epoch, with its shape (writePaperOpening's is recognisable). */
  nextEquity: EquityShape | null;
  events: Array<{ id: number; at: number; class: EventClass; epoch: number | null }>;
  commands: Array<{ id: string; createdAt: number | null; claimedAt: number | null; doneAt: number | null }>;
  /** Every trade row of the account carrying a hash: which of them answers an operation, and in which epoch it was filed. */
  trades: Array<{ id: number; kind: string; status: string; amountUsdg: number; epoch: number; createdAt: number | null; userOpHash: string | null; txHash: string | null }>;
  feeAccruals: Array<Record<string, unknown>>;
  riskPeriods: Array<Record<string, unknown>>;
  liveBasis: BasisRow[];
  paperBasis: BasisRow[];
  liveFloors: FloorRow[];
  classPositions: Array<{ token: string; symbol: string | null; state: string | null }>;
  paperBook: number;
  /** Every booking receipt for the account, every epoch and state. */
  gapBookings: Array<{ bookingId: string; epoch: number; evidenceKey: string; tableName: string; rowId: number; state: string }>;
  repairs: Array<{ repairId: string; epoch: number; action: string; evidenceKey: string; tableName: string; state: string }>;
  identityIndex: boolean;
  /** What admission would seed into the attested book now (ledger-resume.ts planAttestedSeed, under the grant's own spelling). */
  seedBefore: AttestedSeedPlan;
  /** What admission saw of the tenant's home at its newest decision (readHomeAtAnchor), or null with no decision. */
  homeAtAnchor: HomeAtAnchor | null;
  /**
   * The current run's flows as admission's duplicate check reads them
   * (distinct-flows.ts flowDuplicateReport): this repair never writes that
   * run, so this is also what the apply's postcondition will read of it.
   * Null with no registration to name the run.
   */
  currentRun: RunDuplicates | null;
}

/** A run's flows as the duplicate check counts them: copies and conflicts only, no amount or hash. */
export interface RunDuplicates { epoch: number | null; clean: boolean; verdict: string; copies: number; conflicts: number }

/**
 * WHAT ADMISSION SAW OF THE TENANT'S HOME when it made its newest decision
 * (the approval holdOf anchors on), and whether that admission archived it.
 * Classes only: never an inode, a size or a path.
 */
export interface HomeAtAnchor {
  approvalId: string; state: string; chainRefusal: boolean;
  /**
   * The approval reached 'archived': admission renamed the home into the
   * archive (ledger-resume.ts archiveTenantHome), and merrymen.db is not
   * among the files it carries back into the fresh home.
   */
  archived: boolean;
  /** The home's book as the approval's evidence bound it (ledger-resume.ts homeBookState), or null when that cannot be proved (`unproved` says why). */
  book: "absent" | "blocked" | "present" | null;
  unproved: string | null;
}

const BOUND_TABLES: ReadonlyArray<readonly [string, string]> = [["trades", "created_at"], ["flows", "at"], ["equity", "at"], ["fee_accruals", "at"], ["paper_checkpoints", "updated_at"]];
/** A stamp normalised to seconds per value, in SQL: rows carried in from elsewhere have held milliseconds (chain-gap-booking.ts unixSec). */
const secondsOf = (column: string) => `CASE WHEN ${column} > 1000000000000 THEN ${column} / 1000 ELSE ${column} END`;

/** runPaperReset's line (index.ts): written by the child AFTER resetPaperLedger commits, so alone it only bounds the bump from above. */
const PAPER_RESET_LINE = /^paper book restarted — cash back to .+ USDG, positions cleared, and earlier paper trades closed into epoch (\d+) \(kept, but no longer counted\)$/;
const HELD_RESET_LINE = /closed into epoch (\d+) /;
const OPENED_LINE = /^opened epoch (\d+) — earlier rows are kept for forensics/;
/** What one boundary event says, from its text, which is then dropped. */
export function classifyEvent(message: string): { class: EventClass; epoch: number | null } | null {
  const held = HELD_RESET_LINE.exec(message);
  // The held reset's own template, exactly (held-reset.ts heldResetEvent): inserted inside the reset's transaction.
  if (held && message === heldResetEvent(Number(held[1]))) return { class: "held-reset", epoch: Number(held[1]) };
  const paper = PAPER_RESET_LINE.exec(message);
  if (paper) return { class: "paper-reset", epoch: Number(paper[1]) };
  const opened = OPENED_LINE.exec(message);
  if (opened) return { class: "opened", epoch: Number(opened[1]) };
  if (/^\S* ?funded \S+ USDG \(/.test(message)) return { class: "funded", epoch: null };
  if (/^\S* ?withdrawn \S+ USDG \(/.test(message)) return { class: "withdrawn", epoch: null };
  return null;
}

const flowRowOf = (r: Record<string, unknown>): FlowRow => ({
  id: num(r.id), agentId: String(r.agent_id ?? ""), direction: String(r.direction ?? ""), amountUsdg: Number(r.amount_usdg), txHash: strOrNull(r.tx_hash),
  blockNumber: intOrNull(r.block_number), logIndex: intOrNull(r.log_index), source: String(r.source ?? ""), epoch: num(r.epoch), chainId: intOrNull(r.chain_id),
  at: num(r.at),
});
const basisRowOf = (r: Record<string, unknown>): BasisRow => ({
  agentId: String(r.agent_id ?? ""), mode: String(r.mode ?? ""), symbol: String(r.symbol ?? ""), qtyRaw: String(r.qty_raw ?? ""), costUsdg: String(r.cost_usdg ?? ""),
  updatedAt: intOrNull(r.updated_at),
});
const floorRowOf = (r: Record<string, unknown>): FloorRow => ({
  agentId: String(r.agent_id ?? ""), mode: String(r.mode ?? ""), symbol: String(r.symbol ?? ""), stopBps: intOrNull(r.stop_bps), rung: String(r.rung ?? ""),
  why: String(r.why ?? ""), at: intOrNull(r.at),
});
const quarantineRowOf = (r: Record<string, unknown>): QuarantineRow => ({
  originalId: num(r.original_id), agentId: String(r.agent_id ?? ""), epoch: intOrNull(r.epoch), direction: strOrNull(r.direction),
  amountUsdg: r.amount_usdg === null || r.amount_usdg === undefined ? null : Number(r.amount_usdg), txHash: strOrNull(r.tx_hash), blockNumber: intOrNull(r.block_number),
  logIndex: intOrNull(r.log_index), source: strOrNull(r.source), at: intOrNull(r.at), runId: String(r.run_id ?? ""), quarantinedAt: num(r.quarantined_at),
  reason: String(r.reason ?? ""), replacedBy: strOrNull(r.replaced_by),
});

/** The rows the fingerprints and a revert read, by themselves: what the apply's before and after are, and what a revert compares with. */
async function readMutableFacts(db: Db, tables: ReadonlySet<string>, account: string): Promise<{ flowsRaw: Array<Record<string, unknown>>; quarantine: QuarantineRow[];
  liveBasis: BasisRow[]; liveFloors: FloorRow[] }> {
  const flowsRaw = ((await db.prepare(`SELECT ${FLOW_SNAPSHOT_COLUMNS} FROM flows WHERE LOWER(agent_id) = ? ORDER BY id`).all(account)) as Array<Record<string, unknown>>)
    .map((r) => ({ ...r }));
  const quarantine = tables.has("flows_quarantine")
    ? ((await db.prepare(`SELECT original_id, agent_id, epoch, direction, amount_usdg, tx_hash, block_number, log_index, source, at, run_id, quarantined_at, reason,
        replaced_by FROM flows_quarantine WHERE LOWER(agent_id) = ? ORDER BY run_id, original_id`).all(account)) as Array<Record<string, unknown>>).map(quarantineRowOf)
    : [];
  const liveBasis = tables.has("cost_basis")
    ? ((await db.prepare("SELECT agent_id, mode, symbol, qty_raw, cost_usdg, updated_at FROM cost_basis WHERE LOWER(agent_id) = ? AND mode = 'live' ORDER BY symbol, agent_id")
      .all(account)) as Array<Record<string, unknown>>).map(basisRowOf)
    : [];
  const liveFloors = tables.has("position_floors")
    ? ((await db.prepare("SELECT agent_id, mode, symbol, stop_bps, rung, why, at FROM position_floors WHERE LOWER(agent_id) = ? AND mode = 'live' ORDER BY symbol, agent_id")
      .all(account)) as Array<Record<string, unknown>>).map(floorRowOf)
    : [];
  return { flowsRaw, quarantine, liveBasis, liveFloors };
}

/**
 * THE HOME'S BOOK, FROM AN APPROVAL'S OWN EVIDENCE. PURE.
 *
 * recordApproval stores the evidence as `canonical(evidence)` and its digest
 * as the sha256 of exactly that text (ledger-resume.ts evidenceDigest), so
 * the text is trusted only when it hashes to the digest on its row; it must
 * name this tenant and account, and bind a home as homeIdentity writes one.
 * Anything else proves nothing, and says why.
 */
export function homeOfEvidence(text: unknown, digest: unknown, o: { tenant: string; account: string | null }): Pick<HomeAtAnchor, "book" | "unproved"> {
  const no = (unproved: string) => ({ book: null, unproved });
  if (typeof text !== "string" || typeof digest !== "string") return no("the approval has no evidence on record");
  if (createHash("sha256").update(text).digest("hex") !== digest) return no("the approval's evidence does not hash to its own digest");
  let e: unknown;
  try { e = JSON.parse(text); } catch { return no("the approval's evidence is not JSON"); }
  if (e === null || typeof e !== "object") return no("the approval's evidence is not an object");
  const ev = e as { tenant?: unknown; account?: unknown; home?: unknown };
  if (lower(ev.tenant) !== o.tenant || o.account === null || lower(ev.account) !== o.account) return no("the approval's evidence names another tenant or account");
  const h = ev.home as Record<string, unknown> | null | undefined;
  if (h === null || typeof h !== "object" || typeof h.exists !== "boolean") return no("the approval's evidence binds no home (recorded before admission bound one)");
  if (h.exists) {
    const d = h.db as Record<string, unknown> | null | undefined;
    const book = d === null || (typeof d === "object" && d !== undefined && typeof d.ino === "string" && typeof d.size === "string");
    if (!book || !Array.isArray(h.markers) || h.markers.some((m) => typeof m !== "string")) return no("the evidence's home is not as admission's homeIdentity writes one");
  }
  return { book: homeBookState(h as unknown as HomeIdentity), unproved: null };
}

/**
 * The anchor's home, read in the snapshot's transaction: the newest approval
 * that was not revoked (holdOf's anchor), its own evidence and whether it
 * archived the home. Read by its id and the tenant, so another tenant's row
 * is never read.
 */
async function readHomeAtAnchor(db: Db, tables: ReadonlySet<string>, booking: BookingSnapshot): Promise<HomeAtAnchor | null> {
  const anchor = booking.admission.approvals.find((a) => a.state !== "revoked") ?? null;
  if (!anchor || !tables.has("ledger_resume_approvals")) return null;
  const r = (await db.prepare("SELECT evidence_digest, evidence_json FROM ledger_resume_approvals WHERE approval_id = ? AND tenant = ?").get(anchor.approvalId, booking.tenant)) as
    Record<string, unknown> | undefined;
  return { approvalId: anchor.approvalId, state: anchor.state, chainRefusal: anchor.chainRefusal, archived: anchor.archived,
    ...homeOfEvidence(r?.evidence_json, r?.evidence_digest, { tenant: booking.tenant, account: booking.grant?.account ?? null }) };
}

/**
 * WILL A CLEARED BASIS STAY CLEARED? PURE.
 *
 * The clear is in Postgres. Before admission reads anything for an approved
 * tenant, it drains the old book in the tenant's home into Postgres
 * (orchestrator.ts drainContinuousBook, the first step of Phase A), and the
 * mirror replaces the account's cost_basis and position_floors with that
 * book's own (ledger-mirror.ts). A continuous old book still holds the live
 * basis this repair would clear (resetPaperLedger deletes only the paper
 * basis), so the drain would put it back: the approval is then refused for
 * changed evidence, the tenant's newest decision is no longer a chain
 * refusal, and a later approval seeds the stale basis anyway. The drain is
 * skipped only for a home with no merrymen.db or one behind a source barrier
 * (`ledger-source-blocked.json`), and a book admission archived is gone from
 * the home. This tool cannot read the volume, so it proves which from what
 * Postgres recorded:
 *
 *  - the anchor ARCHIVED the home: its admission renamed the home into the
 *    archive before its chain refusal (Phase B), and nothing has run for the
 *    tenant since (holdOf: no heartbeat or mirrored row after the anchor, and
 *    a held tenant spawns no worker);
 *  - or the anchor's own evidence, verified against its digest, bound a home
 *    with no book (`absent`) or one behind a source barrier (`blocked`). A
 *    chain refusal is recorded in Phase A only after its drain and after the
 *    evidence recomputed there matched that digest, so this is the home that
 *    admission's drain met, and nothing has written since.
 *
 * Anything else — a book present and unblocked, an evidence that does not
 * verify or binds no home, no anchor — does not prove the clear would hold.
 */
export function retainedHomeVerdict(h: HomeAtAnchor | null): { durable: boolean; code: "home-book-present" | "home-unproved" | null; why: string } {
  if (!h) return { durable: false, code: "home-unproved", why: "admission has made no decision for this tenant, so what its home holds is on no record this tool can read" };
  const which = `approval ${h.approvalId.slice(0, 8)}…`;
  if (h.archived) {
    return { durable: true, code: null, why: `admission archived the tenant's home for its newest decision (${which}) before refusing it: no old book is left in the home for the next admission to drain` };
  }
  if (h.book === "absent") return { durable: true, code: null, why: `admission's evidence for its newest decision (${which}) found no book in the tenant's home: there is nothing for the next admission to drain` };
  if (h.book === "blocked") {
    return { durable: true, code: null, why: `admission's evidence for its newest decision (${which}) found the home's book behind a source barrier, which admission's drain never copies from` };
  }
  if (h.book === "present") {
    return { durable: false, code: "home-book-present", why: `admission's evidence for its newest decision (${which}) found the old book in the tenant's home (merrymen.db, no source barrier), and that admission ` +
      "did not archive it: the next admission drains that book into Postgres before it reads anything (orchestrator.ts drainContinuousBook), and the mirror puts its " +
      "live basis and floors back over what this repair would clear — the approval is then refused for changed evidence and a later one seeds the stale basis. " +
      "Clearing it here would not hold, and filing the flows without it would let admission seed it: a reviewed basis decision, or the tenant stays held" };
  }
  return { durable: false, code: "home-unproved", why: `what the tenant's home held at admission's newest decision (${which}) cannot be proved (${h.unproved ?? "unknown"}), so whether the next ` +
    "admission drains an old book back over this repair's clear (orchestrator.ts drainContinuousBook) cannot be said: a reviewed basis decision, or the tenant stays held" };
}

/** The current run's duplicate check, as admission runs it; a run whose rows do not read is unread, never clean. */
async function readCurrentRun(db: Db, account: string, registered: boolean): Promise<RunDuplicates | null> {
  if (!registered) return null;
  try {
    const r = await flowDuplicateReport(db, account);
    return { epoch: r.epoch, clean: r.clean, verdict: r.verdict, copies: Object.values(r.copies).reduce((s, n) => s + n, 0),
      conflicts: Object.values(r.conflicts).reduce((s, n) => s + n, 0) };
  } catch (e) {
    if (e instanceof CapitalFlowsWithheld) return { epoch: null, clean: false, verdict: "unread", copies: 0, conflicts: 0 };
    throw e;
  }
}

export async function readClosedEpochSnapshot(db: Db, o: { tenant: string; dialect: Dialect; nowSec: number; epoch: number }): Promise<ClosedEpochSnapshot> {
  if (!Number.isSafeInteger(o.epoch) || o.epoch < 1) throw new BookingRefused("invalid-epoch", "the epoch must be a whole number of at least 1");
  const booking = await readBookingSnapshot(db, { tenant: o.tenant, dialect: o.dialect, nowSec: o.nowSec });
  const tables = await existingTables(db, o.dialect);
  const account = booking.grant?.account ?? "";
  const P = o.epoch;
  const raw = (await db.prepare(o.dialect === "postgres" ? "SELECT grant_json->>'smartAccount' AS smart_account FROM grants WHERE LOWER(tenant) = ?"
    : "SELECT json_extract(grant_json, '$.smartAccount') AS smart_account FROM grants WHERE LOWER(tenant) = ?").all(booking.tenant)) as Array<Record<string, unknown>>;
  const rawGrantAccount = raw.length === 1 && typeof raw[0]!.smart_account === "string" ? raw[0]!.smart_account : null;
  const agentColumns = await existingColumns(db, o.dialect, "agents");
  const wanted = ["smart_account", "epoch", "mode", "chain_id", "hwm_usdg", "hwm_withdrawn_usdg", "accrued_fee_usdg", "contributions_known", "contributions_why", "quality_at"]
    .filter((c) => agentColumns.has(c));
  const agentRows = (await db.prepare(`SELECT ${wanted.join(", ")} FROM agents WHERE LOWER(smart_account) = ? ORDER BY smart_account`).all(account)) as Array<Record<string, unknown>>;
  const a = agentRows.length === 1 ? agentRows[0]! : null;
  const agent = a ? {
    smartAccount: String(a.smart_account), epoch: num(a.epoch), mode: strOrNull(a.mode), chainId: intOrNull(a.chain_id), hwmUsdg: num(a.hwm_usdg),
    hwmWithdrawnUsdg: num(a.hwm_withdrawn_usdg), accruedFeeUsdg: num(a.accrued_fee_usdg), contributionsKnown: intOrNull(a.contributions_known),
    contributionsWhy: strOrNull(a.contributions_why), qualityAt: intOrNull(a.quality_at),
  } : null;
  const mutable = await readMutableFacts(db, tables, account);
  const bounds: EpochBound[] = [];
  for (const [table, stamp] of BOUND_TABLES) {
    if (!tables.has(table)) continue;
    for (const r of (await db.prepare(`SELECT epoch, COUNT(*) AS n, MIN(${secondsOf(stamp)}) AS lo, MAX(${secondsOf(stamp)}) AS hi FROM ${table}
        WHERE LOWER(agent_id) = ? GROUP BY epoch ORDER BY epoch`).all(account)) as Array<Record<string, unknown>>) {
      bounds.push({ table, epoch: num(r.epoch), n: num(r.n), min: unixSec(r.lo), max: unixSec(r.hi) });
    }
  }
  const marks = ((await db.prepare(`SELECT id, at, mode, equity_usdg FROM equity WHERE LOWER(agent_id) = ? AND epoch = ? ORDER BY ${secondsOf("at")}, id`).all(account, P)) as
    Array<Record<string, unknown>>).map((r) => ({ id: num(r.id), at: unixSec(r.at) ?? 0, mode: strOrNull(r.mode), equityUsdg: num(r.equity_usdg) }));
  const n = (await db.prepare(`SELECT id, epoch, at, mode, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, flows_held FROM equity
      WHERE LOWER(agent_id) = ? AND epoch > ? ORDER BY ${secondsOf("at")}, id LIMIT 1`).get(account, P)) as Record<string, unknown> | undefined;
  const nextEquity: EquityShape | null = n ? {
    id: num(n.id), epoch: num(n.epoch), at: unixSec(n.at) ?? 0, mode: strOrNull(n.mode), ethWei: strOrNull(n.eth_wei), cashUsdg: num(n.cash_usdg), vaultUsdg: num(n.vault_usdg),
    positionsUsdg: num(n.positions_usdg), equityUsdg: num(n.equity_usdg), flowsHeld: intOrNull(n.flows_held),
  } : null;
  // The event text is classified here and dropped: what reaches the plan, the report and the digest is the class.
  const events: ClosedEpochSnapshot["events"] = [];
  if (tables.has("events")) {
    for (const r of (await db.prepare(`SELECT id, created_at, message FROM events WHERE LOWER(agent_id) = ? AND (message LIKE 'paper book restarted%'
        OR message LIKE 'opened epoch %' OR message LIKE '%funded % USDG (%' OR message LIKE '%withdrawn % USDG (%') ORDER BY id`).all(account)) as Array<Record<string, unknown>>) {
      const c = classifyEvent(String(r.message ?? ""));
      if (c) events.push({ id: num(r.id), at: unixSec(r.created_at) ?? 0, class: c.class, epoch: c.epoch });
    }
  }
  const commands = tables.has("agent_commands")
    ? ((await db.prepare("SELECT id, created_at, claimed_at, done_at FROM agent_commands WHERE LOWER(agent_id) = ? AND kind = 'paper-reset' ORDER BY created_at, id")
      .all(account)) as Array<Record<string, unknown>>).map((r) => ({ id: String(r.id), createdAt: unixSec(r.created_at), claimedAt: unixSec(r.claimed_at), doneAt: unixSec(r.done_at) }))
    : [];
  const trades = ((await db.prepare(`SELECT id, kind, status, amount_usdg, epoch, created_at, user_op_hash, tx_hash FROM trades WHERE LOWER(agent_id) = ?
      AND (user_op_hash IS NOT NULL OR tx_hash IS NOT NULL) ORDER BY id`).all(account)) as Array<Record<string, unknown>>).map((r) => ({
    id: num(r.id), kind: String(r.kind ?? ""), status: String(r.status ?? ""), amountUsdg: num(r.amount_usdg), epoch: num(r.epoch), createdAt: unixSec(r.created_at),
    userOpHash: r.user_op_hash ? lower(r.user_op_hash) : null, txHash: r.tx_hash ? lower(r.tx_hash) : null,
  }));
  const plain = (rows: unknown[]) => (rows as Array<Record<string, unknown>>).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "bigint" ? Number(v) : v])));
  const feeAccruals = tables.has("fee_accruals")
    ? plain(await db.prepare("SELECT id, epoch, at, profit_usdg, fee_usdg, hwm_before_usdg, hwm_after_usdg FROM fee_accruals WHERE LOWER(agent_id) = ? ORDER BY id").all(account))
    : [];
  const riskPeriods = tables.has("risk_periods")
    ? plain(await db.prepare("SELECT id, agent_id, started_at, baseline_usdg, hwm_usdg, withdrawn_usdg, reason FROM risk_periods WHERE LOWER(agent_id) = ? ORDER BY started_at, id")
      .all(account))
    : [];
  const paperBasis = tables.has("cost_basis")
    ? ((await db.prepare("SELECT agent_id, mode, symbol, qty_raw, cost_usdg, updated_at FROM cost_basis WHERE LOWER(agent_id) = ? AND mode = 'paper' ORDER BY symbol, agent_id")
      .all(account)) as Array<Record<string, unknown>>).map(basisRowOf)
    : [];
  const classPositions = tables.has("class_positions")
    ? ((await db.prepare("SELECT token, symbol, state FROM class_positions WHERE LOWER(agent_id) = ? AND COALESCE(state, '') <> 'closed' ORDER BY token").all(account)) as
      Array<Record<string, unknown>>).map((r) => ({ token: lower(r.token), symbol: strOrNull(r.symbol), state: strOrNull(r.state) }))
    : [];
  const paperBook = tables.has("paper_book")
    ? num(((await db.prepare("SELECT COUNT(*) AS n FROM paper_book WHERE LOWER(agent_id) = ?").get(account)) as Record<string, unknown> | undefined)?.n) : 0;
  const gapBookings = tables.has(BOOKINGS_TABLE)
    ? ((await db.prepare(`SELECT booking_id, epoch, evidence_key, table_name, row_id, state FROM ${BOOKINGS_TABLE} WHERE account = ? ORDER BY evidence_key, booking_id`)
      .all(account)) as Array<Record<string, unknown>>).map((r) => ({ bookingId: String(r.booking_id), epoch: num(r.epoch), evidenceKey: String(r.evidence_key),
      tableName: String(r.table_name), rowId: num(r.row_id), state: String(r.state) }))
    : [];
  const repairs = tables.has(REPAIRS_TABLE)
    ? ((await db.prepare(`SELECT repair_id, epoch, action, evidence_key, table_name, state FROM ${REPAIRS_TABLE} WHERE account = ? ORDER BY evidence_key, repair_id`)
      .all(account)) as Array<Record<string, unknown>>).map((r) => ({ repairId: String(r.repair_id), epoch: num(r.epoch), action: String(r.action),
      evidenceKey: String(r.evidence_key), tableName: String(r.table_name), state: String(r.state) }))
    : [];
  const seedBefore = rawGrantAccount ? await planAttestedSeed(db, rawGrantAccount) : { basis: [], floors: [] };
  const homeAtAnchor = await readHomeAtAnchor(db, tables, booking);
  const currentRun = account ? await readCurrentRun(db, account, booking.agents.length > 0) : null;
  // Last: a catalogue read that fails aborts a Postgres transaction, so nothing is read after it.
  let identityIndex = false;
  try { identityIndex = (await inspectChainIdentityIndex(db, o.dialect)).valid; } catch { identityIndex = false; }
  return {
    booking, epoch: P, rawGrantAccount, agent, flows: { rows: mutable.flowsRaw.map(flowRowOf), fingerprint: flowFingerprintOf(mutable.flowsRaw) },
    quarantine: { rows: mutable.quarantine }, bounds, marks, nextEquity, events, commands, trades, feeAccruals, riskPeriods,
    liveBasis: mutable.liveBasis, paperBasis, liveFloors: mutable.liveFloors, classPositions, paperBook, gapBookings, repairs, identityIndex, seedBefore, homeAtAnchor, currentRun,
  };
}

/** The digests the apply records before and after, and a revert compares with. */
export interface Fingerprints { flowsAll: string | null; flowsEpoch: string | null; flowsOther: string | null; quarantine: string; liveBasis: string; liveFloors: string }
function fingerprintsOf(f: { flowsRaw: ReadonlyArray<Record<string, unknown>>; quarantine: readonly QuarantineRow[]; liveBasis: readonly BasisRow[]; liveFloors: readonly FloorRow[] },
  epoch: number): Fingerprints {
  return {
    flowsAll: flowFingerprintOf(f.flowsRaw), flowsEpoch: flowFingerprintOf(f.flowsRaw.filter((r) => num(r.epoch) === epoch)),
    flowsOther: flowFingerprintOf(f.flowsRaw.filter((r) => num(r.epoch) !== epoch)), quarantine: digestOf(f.quarantine), liveBasis: digestOf(f.liveBasis),
    liveFloors: digestOf(f.liveFloors),
  };
}

/**
 * Everything apply compares inside its transaction: the booking tool's own
 * set (the hold, the admission state, the known facts, the ledger's counts,
 * the holdings and fills, and every hosted account, by digest, which the
 * classifier reads a counterparty against) and every fact a closed epoch was
 * judged on, the anchor's home among them (its evidence is not in the
 * admission state). The current run's duplicate check is not here: it is a
 * function of the flows and registrations already compared.
 */
export function closedCasFacts(s: ClosedEpochSnapshot) {
  return {
    booking: casFacts(s.booking), rawGrantAccount: s.rawGrantAccount, agent: s.agent, flows: digestOf(s.flows.rows), flowsFingerprint: s.flows.fingerprint,
    quarantine: digestOf(s.quarantine.rows), bounds: s.bounds, marks: digestOf(s.marks), nextEquity: s.nextEquity, events: digestOf(s.events), commands: digestOf(s.commands),
    trades: digestOf(s.trades), feeAccruals: digestOf(s.feeAccruals), riskPeriods: digestOf(s.riskPeriods), liveBasis: s.liveBasis, paperBasis: digestOf(s.paperBasis),
    liveFloors: s.liveFloors, classPositions: digestOf(s.classPositions), paperBook: s.paperBook, gapBookings: s.gapBookings, repairs: s.repairs,
    identityIndex: s.identityIndex, seedBefore: s.seedBefore, homeAtAnchor: s.homeAtAnchor,
  };
}

// ── the chain half ───────────────────────────────────────────────────────────

export interface LogRead { logs: RawChainLog[]; complete: boolean; scannedTo: string }
export interface ClosedEpochChain {
  rpcChainId: number;
  /** Why nothing else could be read, or null. */
  unavailable: string | null;
  head: string | null;
  /** head less BOOKING_CONFIRMATIONS: every balance is read here, and every log up to here. */
  pinned: string | null;
  /** balanceOf at the pinned block, by token then book address (base units, or null unread); `total` only when every address answered. */
  balances: Record<string, { total: string | null; by: Record<string, string | null> }>;
  /** Why a balance is unread, by `token:holder`: a node with no state at the block says so ("pruned"), anything else is "unread". */
  unread: Record<string, "pruned" | "unread">;
  logs: { accountOut: LogRead; accountIn: LogRead; ops: LogRead; custody: Record<string, { out: LogRead; in: LogRead }> };
  /** Every transaction a log named, and every one admission's check named: its receipt and its block, read once. */
  txs: Record<string, TxEvidence>;
  /**
   * Admission's own chain check (ledger-resume.ts chainGapCheck), exactly as admission runs it (orchestrator.ts resumeChainGate) and the
   * booking tool reads it (chain-gap-booking.ts readChainEvidence): over the trades rows, flows and acknowledged owner records Postgres
   * holds, each record re-derived from its receipt over the grant's custody and chain before it answers anything.
   */
  gap: ChainEvidence["gap"];
  calls: number;
}

const EMPTY_READ: LogRead = { logs: [], complete: false, scannedTo: "-1" };

/** The tokens whose balances decide the stale-basis question: each seeded symbol's positions token. */
function seedTokens(snap: ClosedEpochSnapshot): string[] {
  const symbols = new Set(snap.seedBefore.basis.map((b) => b.symbol));
  return [...new Set(snap.booking.holdings.positions.filter((p) => symbols.has(p.symbol) && p.rawBalance !== "0" && ADDRESS.test(p.token)).map((p) => p.token))].sort(byText);
}

/**
 * READ THE CHAIN FOR ONE SNAPSHOT, reads only, in this order: the chain id
 * and head; then, before any long read, every balance the plan needs at the
 * pinned block (the public node keeps little history, so a balance read
 * after a long log sweep could find its block's state gone); then the USDG
 * logs of the account and of each custody address, and the account's
 * operations, from block 0 to the pinned block; then admission's own check;
 * then one receipt and block per transaction named. The transport admits
 * nothing else (closed-epoch-capital-cli.ts createClosedEpochRpc).
 */
export async function readClosedEpochChain(rpc: RpcCall, snap: ClosedEpochSnapshot, o: {
  sleep?: (ms: number) => Promise<void>; maxSpan?: bigint; log?: (line: string) => void;
} = {}): Promise<ClosedEpochChain> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let calls = 0;
  const counted: RpcCall = async (method, params) => { calls += 1; return rpc(method, params); };
  const rpcChainId = Number(BigInt(String(await patiently(() => counted("eth_chainId", []), sleep))));
  const empty = (unavailable: string, head: string | null = null): ClosedEpochChain => ({
    rpcChainId, unavailable, head, pinned: null, balances: {}, unread: {},
    logs: { accountOut: EMPTY_READ, accountIn: EMPTY_READ, ops: EMPTY_READ, custody: {} }, txs: {}, gap: { status: "unavailable", why: unavailable }, calls,
  });
  const grant = snap.booking.grant;
  if (!grant) return empty("no stored grant names the account to read");
  let head: bigint;
  try { head = BigInt(String(await patiently(() => counted("eth_blockNumber", []), sleep))); }
  catch { return { ...empty("the chain's head could not be read"), calls }; }
  const pinned = head - BOOKING_CONFIRMATIONS;
  if (pinned < 0n) return { ...empty("the chain is shorter than the confirmations every fact needs", head.toString()), calls };
  const book = [grant.account, ...grant.custody];
  const word = (v: unknown): bigint | null => (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : null);
  const balances: ClosedEpochChain["balances"] = {};
  const unread: ClosedEpochChain["unread"] = {};
  for (const token of [USDG, ...seedTokens(snap).filter((t) => t !== USDG)]) {
    const by: Record<string, string | null> = {};
    for (const holder of book) {
      try {
        const v = word(await patiently(() => counted("eth_call", [{ to: token, data: `${BALANCE_OF_SELECTOR}${holder.slice(2).padStart(64, "0")}` }, `0x${pinned.toString(16)}`]), sleep));
        by[holder] = v === null ? null : v.toString();
        if (v === null) unread[`${token}:${holder}`] = "unread";
      } catch (e) {
        by[holder] = null;
        // Only the classification is kept: a node's message is never stored or printed.
        unread[`${token}:${holder}`] = /missing trie node|header not found|state.*(not available|pruned)|historical state/i.test(e instanceof Error ? e.message : "") ? "pruned" : "unread";
      }
    }
    const values = Object.values(by);
    balances[token] = { total: values.every((v) => v !== null) ? values.reduce((s, v) => s + BigInt(v!), 0n).toString() : null, by };
  }
  const chain = gapChainOf(counted, sleep);
  const reader = { getBlockNumber: () => chain.getBlockNumber(), getLogs: (a: Parameters<typeof chain.getLogs>[0]) => chain.getLogs(a), getReceiptLogs: async () => null };
  const span = o.maxSpan ?? CLOSED_EPOCH_LOG_SPAN;
  const read = async (address: string, topics: Array<string | null>): Promise<LogRead> => {
    const r = await getLogsAdaptive(reader, { address: address as `0x${string}`, topics: topics as never }, 0n, pinned, span, o.log);
    return { logs: r.logs as unknown as RawChainLog[], complete: r.complete, scannedTo: r.scannedTo.toString() };
  };
  const accountOut = await read(USDG, [TRANSFER_TOPIC, addressTopic(grant.account)]);
  const accountIn = await read(USDG, [TRANSFER_TOPIC, null, addressTopic(grant.account)]);
  const ops = await read(EP, [USER_OPERATION_EVENT_TOPIC, null, addressTopic(grant.account)]);
  const custody: ClosedEpochChain["logs"]["custody"] = {};
  for (const c of grant.custody) custody[c] = { out: await read(USDG, [TRANSFER_TOPIC, addressTopic(c)]), in: await read(USDG, [TRANSFER_TOPIC, null, addressTopic(c)]) };
  // AS ADMISSION READS IT, owner records included: an operation the owner's root key signed is answered by its acknowledged record, once
  // re-derived from the receipt over the grant's own custody and chain (ledger-resume.ts ownerAnswersFor), exactly as the booking tool
  // passes them (chain-gap-booking.ts readChainEvidence). Without them an operation admission answers would be named here, and refused.
  const known = { ops: new Set(snap.booking.known.ops), txs: new Set(snap.booking.known.txs), flows: new Set(snap.booking.known.flows),
    ownerRecords: new Map(snap.booking.known.ownerOps.map((p) => p.split("|") as [string, string])) };
  const ownerContext = grant.chainId === null ? undefined : { custody: grant.custody, chainId: grant.chainId };
  const g = await chainGapCheck({ chain, account: grant.account, usdg: RESUME_USDG, sinceSec: snap.booking.gapFromSec, known, ...(ownerContext ? { ownerContext } : {}),
    maxSpan: span, ...(o.log ? { log: o.log } : {}) });
  const gap: ChainEvidence["gap"] = g.status === "unavailable" ? g : g.status === "clean" ? { status: "clean", fromBlock: g.fromBlock, head: g.head }
    : { status: "missing", fromBlock: g.fromBlock, head: g.head, found: g.found };
  const named = new Set<string>();
  for (const r of [accountOut, accountIn, ops, ...Object.values(custody).flatMap((c) => [c.out, c.in])]) for (const l of r.logs) named.add(lower(l.transactionHash));
  if (gap.status === "missing") for (const f of gap.found) named.add(lower(f.txHash));
  const txs: Record<string, TxEvidence> = {};
  for (const tx of [...named].sort(byText)) {
    let receipt: TxEvidence["receipt"] = null, block: TxEvidence["block"] = null;
    try {
      const r = (await patiently(() => counted("eth_getTransactionReceipt", [tx]), sleep)) as Record<string, unknown> | null;
      if (r && Array.isArray(r.logs) && typeof r.blockNumber === "string" && typeof r.blockHash === "string" && typeof r.status === "string") {
        receipt = { status: r.status, blockNumber: r.blockNumber, blockHash: lower(r.blockHash), from: strOrNull(r.from)?.toLowerCase() ?? null,
          to: strOrNull(r.to)?.toLowerCase() ?? null, logs: r.logs as RawChainLog[] };
        const b = (await patiently(() => counted("eth_getBlockByNumber", [r.blockNumber, false]), sleep)) as Record<string, unknown> | null;
        if (b && typeof b.number === "string" && typeof b.hash === "string" && typeof b.timestamp === "string" && BigInt(b.number) === BigInt(r.blockNumber as string)) {
          block = { number: BigInt(b.number).toString(), hash: lower(b.hash), timestamp: Number(BigInt(b.timestamp)) };
        }
      }
    } catch {
      // Unread is unread: every movement and operation in this transaction says so.
    }
    txs[tx] = { receipt, block };
  }
  return { rpcChainId, unavailable: null, head: head.toString(), pinned: pinned.toString(), balances, unread, logs: { accountOut, accountIn, ops, custody }, txs, gap, calls };
}

// ── the plan ─────────────────────────────────────────────────────────────────

/** One USDG movement of the account, as the chain shows it and the classifier reads it, and what Postgres holds for it. */
export interface MovementReport {
  key: string; txHash: string; logIndex: number; block: string; blockHash: string | null; at: number | null;
  direction: "in" | "out" | "self"; amountRaw: string; counterparty: string;
  /** Null when its receipt could not be read: then it is unclassified and the plan is blocked. */
  classification: { kind: Classification["kind"]; rule: string; why: string; pairedToken: string | null } | null;
  /** The account's operations in its transaction, from the same receipt (signersOf): who signed each, and whether this log ran inside it. Null when unread. */
  signers: Signer[] | null;
  /** The classifier's own input (another hosted account is internal), and whether it is the grant's owner or the signed-in tenant. */
  counterpartyKnownAccount: boolean; counterpartyIsOwner: boolean;
  /** The epoch its time places it in, against the proved boundary: the epoch asked for, or "later". Null when undated. */
  epochByTime: number | "later" | null;
  /** What already answers it: flows rows by identity (any epoch), trades rows by its transaction, receipts by its key. */
  answeredBy: { flows: Array<{ id: number; epoch: number; source: string }>; trades: number[]; gapBookings: string[]; repairs: string[] };
}
export interface OpReport {
  userOpHash: string; txHash: string; block: string; at: number | null; validator: string | null; paymaster: string | null; success: boolean | null;
  epochByTime: number | "later" | null;
  /** The trade rows carrying its hash: what answers it for admission, and in which epoch and when each was filed (never boundary evidence). */
  answeredBy: Array<{ id: number; kind: string; status: string; amountUsdg: number; epoch: number; createdAt: number | null }>;
  /**
   * The owner records Postgres holds for it (owner_operations, docs/owner-operations.md), whatever their disposition, tenant or chain:
   * what admission answers an operation of the owner's root key by when no trades row does, but only an acknowledged one of this tenant
   * and chain, in the operation's own transaction, that the receipt re-derives as acknowledged. Evidence only: this tool writes none.
   */
  ownerRecords: Array<{ disposition: string; reviewReason: string | null; tenant: string | null; chainId: number; txHash: string }>;
  /**
   * For a root-key operation: the owner reading re-derived from its receipt over the grant's custody and chain (owner-operations.ts
   * ownerOperationOf), the one a record must agree with to answer it. Null for any other operation, or a receipt it cannot read.
   */
  ownerReading: Pick<OwnerOperationReading, "disposition" | "reasons" | "covers" | "usdgLegs" | "tokenMoves"> | null;
  /**
   * What answers it in admission's own check, as this tool ran it: a trades row carrying its hash, an owner record (an acknowledged one
   * the chain re-derived), or nothing ("missing": the check names it). Null when its block is outside the window that check read, or
   * the check could not be run.
   */
  admission: "trades-row" | "owner-record" | "missing" | null;
  /**
   * A root-key operation answered by a 'swap' row: an owner's operation recorded as an agent trade, as the in-flight reconciler booked
   * every operation it found with no row until it recorded the owner's apart (docs/owner-operations.md). Such rows stay where they are.
   */
  ownerOperationRecordedAsTrade: boolean;
  /** For a root-key operation: what else it moved across the book's edge, in kind. Review only, never a booking. */
  inKind: Array<{ token: string; direction: "in" | "out"; amountRaw: string; counterparty: string; logIndex: number }>;
}
export interface BoundaryProof {
  epoch: number; currentEpoch: number | null;
  /** The epoch's close, no later than: the earliest stamp of any later epoch's row, or of an event that closes this one. */
  upperSec: number | null; upperFrom: string | null;
  /** The epoch's own latest valuation. A valuation after upperSec is two epochs overlapping. */
  lastMark: number | null;
  /** The latest capital fact filed or kept in the epoch. */
  maxFact: number | null;
  /** What dates the epoch as still open after maxFact: W1 a valuation, W2 the held reset's own event, W3 resetPaperLedger's opening with runPaperReset's line. */
  witness: { kind: "W1" | "W2" | "W3"; at: number; marginSec: number; said: string } | null;
  events: ClosedEpochSnapshot["events"];
  commands: ClosedEpochSnapshot["commands"];
  nextEquity: EquityShape | null;
  bounds: EpochBound[];
}
export interface InsertProposal { key: string; row: FlowProposal; amountRaw: string; movement: string }
export interface QuarantineProposal { id: number; agentId: string; row: FlowRow; reason: string }
export interface ClearProposal { kind: "clear-live-basis" | "clear-live-floor"; symbol: string; token: string; table: "cost_basis" | "position_floors"; preimage: BasisRow | FloorRow }
export interface DatedFact { fact: MissingChainFact; said: string; at: number | null; validator: string | null }

export interface ClosedEpochPlan {
  format: typeof CLOSED_EPOCH_FORMAT;
  source: unknown; target: string;
  tenant: string; epoch: number; account: string | null; agentId: string | null; chainId: number | null;
  /** "ready": nothing in the way. "nothing-to-do": nothing to file, quarantine or clear, and admission has nothing before the boundary. "blocked": see refusals. */
  verdict: "ready" | "nothing-to-do" | "blocked";
  refusals: Refusal[];
  boundary: BoundaryProof;
  coverage: { complete: boolean; movements: number; inRaw: string; outRaw: string; netRaw: string; balanceRaw: string | null; neverNegative: boolean; matches: boolean };
  custody: Array<{ address: string; complete: boolean; movements: number; netRaw: string; balanceRaw: string | null; outside: string[] }>;
  movements: MovementReport[];
  ops: OpReport[];
  flowsByEpoch: Array<{ epoch: number; rows: FlowRow[]; inMicro: string; outMicro: string; netMicro: string; evidenced: number; unevidenced: number;
    carries: Array<{ id: number; amountUsdg: number; reconciles: boolean | null; why: string }> }>;
  quarantineHistory: QuarantineRow[];
  proposals: { inserts: InsertProposal[]; quarantines: QuarantineProposal[]; clears: ClearProposal[] };
  /** The epoch's net contributions in micro-USDG before and after, and what the apply's postconditions hold it to. */
  predicted: { epochNetBefore: string; epochNetAfter: string; epochReceiptsAfter: string[] };
  admission: { found: DatedFact[]; remaining: DatedFact[]; afterBoundary: DatedFact[] };
  holdings: {
    seedBefore: AttestedSeedPlan; seedAfter: AttestedSeedPlan;
    verdicts: Array<{ symbol: string; token: string | null; total: string | null; by: Record<string, string | null>; verdict: "clear" | "keep" | "refused"; why: string }>;
    inertBasis: BasisRow[]; inertFloors: FloorRow[];
    positions: BookingSnapshot["holdings"]["positions"]; paperBasis: BasisRow[]; classPositions: ClosedEpochSnapshot["classPositions"]; paperBook: number;
    /** Whether a clear would survive admission's drain of the tenant's home (retainedHomeVerdict), and what it was decided from. */
    home: { atAnchor: HomeAtAnchor | null; durable: boolean; why: string };
  };
  /** What admission's duplicate check would read after the repair: epoch P as it would stand, and the current run, which the repair never writes. */
  duplicates: { epochAfter: RunDuplicates; currentRun: RunDuplicates | null };
  agent: ClosedEpochSnapshot["agent"];
  trades: ClosedEpochSnapshot["trades"];
  feeAccruals: Array<Record<string, unknown>>;
  riskPeriods: Array<Record<string, unknown>>;
  receipts: { gapBookings: ClosedEpochSnapshot["gapBookings"]; repairs: ClosedEpochSnapshot["repairs"] };
  balances: ClosedEpochChain["balances"];
  unread: ClosedEpochChain["unread"];
  warnings: string[];
  cas: ReturnType<typeof closedCasFacts>;
  previewDigest: string;
  /** Not in the digest: when, and where on the chain. */
  capture: { capturedAtSec: number; head: string | null; pinned: string | null; rpcChainId: number; confirmations: number; logSpan: string; calls: number;
    gapFromBlock: string | null };
}

/** A transfer log of USDG naming `who` on either side, read: its identity, sides and amount. Null for anything else. */
function usdgMovementOf(l: RawChainLog, who: string): { tx: string; logIndex: number; block: string; from: string; to: string; amount: bigint } | null {
  if (lower(l.address) !== USDG || lower(l.topics?.[0]) !== TRANSFER_TOPIC || l.topics.length !== 3) return null;
  if (typeof l.transactionHash !== "string" || !HASH.test(lower(l.transactionHash))) return null;
  if (typeof l.logIndex !== "string" || typeof l.blockNumber !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(l.data ?? "")) return null;
  const from = `0x${lower(l.topics[1]).slice(-40)}`, to = `0x${lower(l.topics[2]).slice(-40)}`;
  if (from !== who && to !== who) return null;
  return { tx: lower(l.transactionHash), logIndex: Number(BigInt(l.logIndex)), block: BigInt(l.blockNumber).toString(), from, to, amount: BigInt(l.data) };
}

/** One operation of the account in a movement's transaction, as its receipt shows it. */
export interface Signer {
  userOpHash: string; entryPoint: string;
  /** The validator its nonce names (asset-movements.ts validatorOfNonce); null when unread, or at an entry point whose nonce is not read. */
  validator: "root" | "permission" | "secondary" | null;
  success: boolean;
  /** The movement's own USDG log ran inside this operation's execution (segmentReceipt). */
  carriesLog: boolean;
}

/**
 * THE ACCOUNT'S OPERATIONS IN ONE TRANSACTION. PURE. Every UserOperationEvent
 * of the account in the receipt, with the validator its nonce names, whether
 * it succeeded, and whether the USDG log at `logIndex` ran inside its
 * execution (between its BeforeExecution and its own event: segmentReceipt).
 * One at another entry point is listed with no validator: nothing here reads
 * its nonce, so nothing here says the owner signed it.
 */
export function signersOf(logs: readonly RawChainLog[], account: string, logIndex: number): Signer[] {
  const { segments, foreign } = segmentReceipt(logs);
  const carries = (xs: readonly RawChainLog[]) => xs.some((x) => lower(x.address) === USDG && typeof x.logIndex === "string" && Number(BigInt(x.logIndex)) === logIndex);
  return [
    ...segments.filter((s) => s.op.sender === account).map((s): Signer => ({ userOpHash: s.op.userOpHash, entryPoint: s.op.entryPoint, validator: validatorOfNonce(s.op.nonce),
      success: s.op.success, carriesLog: carries(s.logs) })),
    ...foreign.filter((op) => op.sender === account).map((op): Signer => ({ userOpHash: op.userOpHash, entryPoint: op.entryPoint, validator: null, success: op.success, carriesLog: false })),
  ];
}

const saidSigner = (s: Signer) => `${s.userOpHash.slice(0, 10)}… (${s.validator === null ? "validator unread" : `${s.validator} validator`}${s.success ? "" : ", failed"}` +
  `${s.carriesLog ? ", this log inside it" : ""})`;

/**
 * WHO CHOSE A CAPITAL MOVEMENT. PURE. The classifier reads a USDG movement
 * with nothing paired in its transaction as capital whoever caused it; filed
 * into a closed epoch it is the owner's for good. So a movement is filed as
 * capital only where its own receipt says the owner moved it:
 *
 *  - OUT only inside the execution of a successful operation of the account
 *    signed by the owner's root key. USDG that left with no operation of the
 *    account in the transaction was an allowance spent (chain-gap-booking.ts
 *    refuses the same: "not a withdrawal anybody can be said to have
 *    chosen"); USDG that left outside the root-key operation's execution, or
 *    inside a failed one, is no more the owner's. `out-not-owner`.
 *  - IN or OUT never in a transaction carrying an operation of the account
 *    the root key did not sign (a session key's, another validator's, one
 *    whose validator is unread), nor one a trades row names without
 *    answering a root-key operation in it: that is the agent acting, a
 *    trade's leg or its transfer, booked beside its own row — even with its
 *    pair missing from the receipt, it is no owner's capital. A session
 *    key's transfer home is refused too: the chain does not say the owner
 *    chose it. `capital-in-session-op`.
 *
 * A capital-in needs no operation: an owner's deposit is a plain transfer in
 * (0x0e1ca0's c8ab…#0 carries none). A reserve-out is never filed here (only
 * the worker's own 'energy-buy' row is kept), so it is not asked. Every
 * reason that applies is returned; none means the movement may be filed.
 */
export function capitalProvenance(m: Pick<MovementReport, "key" | "txHash" | "direction" | "amountRaw" | "signers">,
  trades: ReadonlyArray<{ id: number; kind: string; userOpHash: string | null; txHash: string | null }>): Refusal[] {
  const what = `${m.key} (USDG ${m.direction} ${usdg6(m.amountRaw)})`;
  if (m.signers === null) return [{ code: "movement-unread", why: `${what}: its receipt could not be read, so who moved it cannot be said` }];
  const out: Refusal[] = [];
  const notRoot = m.signers.filter((s) => s.validator !== "root");
  const rootOps = new Set(m.signers.filter((s) => s.validator === "root").map((s) => s.userOpHash));
  const rows = trades.filter((t) => t.txHash === m.txHash || (t.userOpHash !== null && m.signers!.some((s) => s.userOpHash === t.userOpHash)));
  const agentRows = rows.filter((t) => t.userOpHash === null || !rootOps.has(t.userOpHash));
  if (notRoot.length || agentRows.length) {
    out.push({ code: "capital-in-session-op", why: `${what} is in a transaction where the agent acted, not the owner's root key: ` +
      [...(notRoot.length ? [`the account's operation(s) ${notRoot.map(saidSigner).join(", ")}`] : []),
        ...(agentRows.length ? [`trades row(s) ${agentRows.map((t) => `#${t.id} (kind '${t.kind}')`).join(", ")} naming it and answering no root-key operation in it`] : [])].join("; ") +
      ". A leg of the agent's own trade or transfer is not capital the owner moved, even with its pair missing from the receipt — never filed here, a reviewed decision" });
  }
  if (m.direction === "out" && !m.signers.some((s) => s.validator === "root" && s.success && s.carriesLog)) {
    out.push({ code: "out-not-owner", why: m.signers.length === 0
      ? `${what}: USDG left the account in a transaction that carried no operation of the account (an allowance was spent): not a withdrawal anybody can be said to have chosen ` +
        "(chain-gap-booking.ts refuses the same) — never filed as the owner's capital out"
      : `${what} did not run inside a successful operation the owner's root key signed (the account's operations in its transaction: ${m.signers.map(saidSigner).join(", ")}): ` +
        "only the owner's own key withdraws — never filed as the owner's capital out" });
  }
  return out;
}

/** What filed the row says of who moved it, for the reviewer's line. */
function provenanceSaid(m: MovementReport): string {
  const root = (m.signers ?? []).find((s) => s.validator === "root" && s.success && s.carriesLog);
  if (root) return `inside the owner's root-key operation ${root.userOpHash.slice(0, 10)}…`;
  return m.signers?.length ? `beside the owner's root-key operation(s) ${m.signers.map((s) => `${s.userOpHash.slice(0, 10)}…`).join(", ")}` : "no operation of the account in its transaction";
}

/** The epoch-1 receipt sources: what a chain movement is filed as. epoch-carry is evidence too, but it is no receipt (flow-evidence.ts). */
const RECEIPT_SOURCES: ReadonlySet<string> = new Set(["chain-log", "energy-buy"]);
const EVIDENCED: ReadonlySet<string> = new Set(EVIDENCED_FLOW_SOURCES);

/**
 * THE STALE LIVE BASIS, NARROWED TO WHAT ADMISSION WOULD SEED. PURE.
 *
 * Admission seeds exactly planAttestedSeed's rows into the attested book: a
 * live cost basis for a symbol positions shows held (raw_balance <> '0')
 * with a positive quantity, and the floors beside one. The first mirror pass
 * after admission then replaces Postgres's snapshot rows with what the new
 * book holds (ledger-mirror.ts: registration removes the lost book's cursors,
 * so the rebuilt-book guard is gone), so only the seeded set can outlive
 * admission. A basis outside it is inert and left alone. For each seeded
 * symbol the token is its positions row's own (never guessed from a name),
 * and the chain decides: flat across every book address at the pinned block
 * → the basis and its floor are deleted (the worker's own rule, "a symbol we
 * no longer hold has no basis", index.ts, proved here from balanceOf rather
 * than from positions); held → kept, as admission keeps it today. An unread
 * balance, a class vault holding the token, or a live-rail position that says
 * held where the chain says flat refuses. positions is never touched: on the
 * paper rail it is the paper book's cache (store.ts), and the next worker
 * rewrites it. Whether a clear survives admission's drain of the tenant's
 * home is decided apart (retainedHomeVerdict), since it rests on what admission
 * recorded, not on the chain.
 */
export function staleBasisPlan(o: {
  seedBefore: AttestedSeedPlan; positions: BookingSnapshot["holdings"]["positions"]; liveBasis: readonly BasisRow[]; liveFloors: readonly FloorRow[];
  rawGrantAccount: string | null; balances: ClosedEpochChain["balances"]; classVault: string | null; mode: string | null;
}): { clears: ClearProposal[]; refusals: Refusal[]; warnings: string[]; verdicts: ClosedEpochPlan["holdings"]["verdicts"]; seedAfter: AttestedSeedPlan;
  inertBasis: BasisRow[]; inertFloors: FloorRow[] } {
  const clears: ClearProposal[] = [], refusals: Refusal[] = [], warnings: string[] = [];
  const verdicts: ClosedEpochPlan["holdings"]["verdicts"] = [];
  const flat = new Set<string>();
  for (const b of o.seedBefore.basis) {
    const rows = o.positions.filter((p) => p.symbol === b.symbol && p.rawBalance !== "0");
    if (rows.length !== 1 || !ADDRESS.test(rows[0]!.token)) {
      const why = `${rows.length} held positions rows name ${b.symbol}, so which token the seeded basis is for is not one answer`;
      refusals.push({ code: "positions-ambiguous", why });
      verdicts.push({ symbol: b.symbol, token: null, total: null, by: {}, verdict: "refused", why });
      continue;
    }
    const token = rows[0]!.token;
    const bal = o.balances[token];
    if (!bal || bal.total === null) {
      const why = `the book's balance of ${b.symbol} (${token}) at the pinned block could not be read for every address, so whether the seeded basis is for a token still held cannot be said — preview again`;
      refusals.push({ code: "balance-unread", why });
      verdicts.push({ symbol: b.symbol, token, total: null, by: bal?.by ?? {}, verdict: "refused", why });
      continue;
    }
    const inClass = o.classVault === null ? null : bal.by[o.classVault] ?? null;
    if (inClass !== null && inClass !== "0") {
      const why = `the account's Pons class vault ${o.classVault} held ${inClass} base units of ${b.symbol} (${token}) at the pinned block: a class holding is the class book, seeded apart — a reviewed basis decision`;
      refusals.push({ code: "class-vault-held", why });
      verdicts.push({ symbol: b.symbol, token, total: bal.total, by: bal.by, verdict: "refused", why });
      continue;
    }
    if (bal.total !== "0") {
      const why = `held: ${bal.total} base units across the book at the pinned block; the basis is kept, as admission keeps it today`;
      verdicts.push({ symbol: b.symbol, token, total: bal.total, by: bal.by, verdict: "keep", why });
      if (bal.total !== b.qtyRaw) {
        warnings.push(`${b.symbol}: the live basis covers ${b.qtyRaw} base units and the book held ${bal.total} on chain at the pinned block — a reviewed basis decision; this tool keeps the basis of a held token`);
      }
      continue;
    }
    if (o.mode === "live") {
      const why = `the agent last reported the live rail, and its positions row says ${b.symbol} is held (${rows[0]!.rawBalance}) where the chain says flat: the two disagree about a live book — a reviewed decision`;
      refusals.push({ code: "live-position-disagrees", why });
      verdicts.push({ symbol: b.symbol, token, total: bal.total, by: bal.by, verdict: "refused", why });
      continue;
    }
    flat.add(b.symbol);
    verdicts.push({ symbol: b.symbol, token, total: "0", by: bal.by, verdict: "clear",
      why: `flat across every book address at the pinned block, yet admission would seed a live basis for it: the basis and its live floor are deleted` });
    for (const row of o.liveBasis.filter((r) => r.symbol === b.symbol)) clears.push({ kind: "clear-live-basis", symbol: b.symbol, token, table: "cost_basis", preimage: row });
    for (const row of o.liveFloors.filter((r) => r.symbol === b.symbol)) clears.push({ kind: "clear-live-floor", symbol: b.symbol, token, table: "position_floors", preimage: row });
  }
  // WHAT ADMISSION WOULD SEED AFTER, by the same two functions over the rows that would remain.
  const left = o.liveBasis.filter((r) => !flat.has(r.symbol));
  const basis = planBasisSeed({ childRowCount: 0, heldSymbols: o.positions.filter((p) => p.rawBalance !== "0").map((p) => p.symbol),
    shared: left.map((r) => ({ mode: r.mode, symbol: r.symbol, qtyRaw: r.qtyRaw, costUsdg: r.costUsdg })) }).rows;
  const floors = planFloorSeed({ childRowCount: 0, restored: basis.map((r) => ({ mode: r.mode, symbol: r.symbol })),
    shared: o.liveFloors.filter((r) => !flat.has(r.symbol) && r.agentId === o.rawGrantAccount)
      .map((r) => ({ mode: r.mode, symbol: r.symbol, stopBps: r.stopBps ?? Number.NaN, rung: r.rung, why: r.why, at: r.at })) }).rows;
  const seeded = new Set(o.seedBefore.basis.map((b) => b.symbol));
  return {
    clears, refusals, warnings, verdicts, seedAfter: { basis, floors },
    inertBasis: o.liveBasis.filter((r) => !seeded.has(r.symbol)), inertFloors: o.liveFloors.filter((r) => !seeded.has(r.symbol)),
  };
}

/**
 * PROVE THE EPOCH, CLASSIFY EVERY MOVEMENT, AND PROPOSE. PURE: the snapshot
 * and the chain in, the plan and its digest out. Nothing here reads or writes.
 */
export function planClosedEpoch(snap: ClosedEpochSnapshot, chain: ClosedEpochChain, o: { nowSec: number; source: unknown; target: string }): ClosedEpochPlan {
  const refusals: Refusal[] = [];
  const warnings: string[] = [];
  const refuse = (code: string, why: string) => { if (!refusals.some((r) => r.code === code && r.why === why)) refusals.push({ code, why }); };
  const booking = snap.booking;
  const P = snap.epoch;
  const grant = booking.grant;
  const account = grant?.account ?? null;
  const agentReg = booking.agents.length === 1 ? booking.agents[0]! : null;
  if (P !== SUPPORTED_EPOCH) {
    refuse("epoch-unsupported", `closed-epoch repair files only into epoch ${SUPPORTED_EPOCH} in this release; a later epoch's lower boundary cannot be proved from rows (a bump may write none)`);
  }
  if (!grant) refuse("no-grant", "no stored grant names this tenant's account: there is nothing to read the chain for");
  if (!booking.agents.length) refuse("no-registration", "the account has no agent registration");
  if (booking.agents.length > 1) refuse("registrations", `the account is registered under ${booking.agents.length} spellings`);
  if (booking.spellings.length > 1) refuse("spellings", `agent_id is spelled ${booking.spellings.length} ways across the financial tables (admission refuses this tenant until that is repaired)`);
  const agentId = booking.spellings.length === 1 ? booking.spellings[0]! : booking.spellings.length === 0 && agentReg ? agentReg.smartAccount : null;
  const chainId = grant?.chainId ?? null;
  if (grant && agentReg && agentReg.chainId !== null && chainId !== null && agentReg.chainId !== chainId) refuse("chain", "the grant and the registration name different chains");
  if (chainId === null && grant) refuse("chain", "the grant names no chain");
  if (chainId !== null && chain.rpcChainId !== chainId) refuse("rpc-chain", `the RPC serves chain ${chain.rpcChainId}, and the grant is on chain ${chainId}`);
  if (booking.openApproval) {
    refuse("open-approval", `an approval is open (${booking.openApproval.state}, evidence ${booking.openApproval.evidence.slice(0, 12)}…): withdraw it with ` +
      `MERRYMEN_RESUME_REVOKE=${booking.tenant}:${booking.openApproval.evidence} and deploy first — a repair changes the evidence it was approved on`);
  }
  if (booking.admitted) refuse("admitted", `already admitted (attested generation ${booking.admitted.slice(0, 8)}…): its running book owns its rows`);
  if (!snap.identityIndex) refuse("identity-index", "the flows_chain_identity unique index is not present with its required definition: a second row for one log could not be refused by the database");
  if (chain.unavailable) refuse("chain-unavailable", `the chain could not be read (${chain.unavailable}); preview again`);
  // HELD, OR NOTHING (chain-gap-booking.ts holdOf): the newest decision a chain refusal, nothing written for the tenant since.
  const hold = holdOf(booking, o.nowSec);
  for (const why of hold.refusals) refuse("not-held", why);

  const head = chain.head === null ? null : BigInt(chain.head);
  const txTime = (tx: string): number | null => chain.txs[tx]?.block?.timestamp ?? null;
  // A transaction's evidence, settled: read, succeeded, canonical, deep. Null is yes.
  const unsettled = (tx: string, block: string | null): string | null => {
    const e = chain.txs[tx];
    if (!e?.receipt || !e.block) return "its receipt or block could not be read";
    if (e.receipt.status !== "0x1") return "its transaction did not succeed";
    if (e.block.hash !== e.receipt.blockHash) return `the receipt's block ${e.receipt.blockHash} is not the canonical block ${e.block.hash} at that height`;
    if (block !== null && BigInt(e.block.number) !== BigInt(block)) return `the log says block ${block} and the receipt says block ${e.block.number}`;
    if (head === null || head - BigInt(e.block.number) < BOOKING_CONFIRMATIONS) return `it is not yet ${BOOKING_CONFIRMATIONS} blocks deep`;
    return null;
  };

  // ── the account's whole USDG history ───────────────────────────────────
  const reads = chain.logs;
  const historyComplete = reads.accountIn.complete && reads.accountOut.complete && reads.ops.complete;
  if (!chain.unavailable && !historyComplete) {
    refuse("coverage-incomplete", "the account's USDG and operation logs could not be read from block 0 to the pinned block: a contribution history with holes in it is not one to file");
  }
  const seen = new Map<string, NonNullable<ReturnType<typeof usdgMovementOf>>>();
  let malformed = 0;
  for (const l of [...reads.accountOut.logs, ...reads.accountIn.logs]) {
    const m = account ? usdgMovementOf(l, account) : null;
    if (!m) { malformed += 1; continue; }
    seen.set(`${m.tx}#${m.logIndex}`, m);
  }
  if (malformed) refuse("log-unreadable", `${malformed} log(s) the read returned are not USDG transfers of the account as the filter asked`);
  const knownAccounts = booking.knownAccounts.filter((x) => x !== account);
  const custodyAddresses = grant?.custody ?? [];
  const reserveTokens = energyReserveTokens(chainId ?? 4663);
  const movements: MovementReport[] = [];
  for (const m of [...seen.values()].sort((x, y) => (BigInt(x.block) < BigInt(y.block) ? -1 : BigInt(x.block) > BigInt(y.block) ? 1 : x.logIndex - y.logIndex))) {
    const direction: MovementReport["direction"] = m.from === account && m.to === account ? "self" : m.from === account ? "out" : "in";
    const counterparty = direction === "out" ? m.to : direction === "in" ? m.from : account!;
    const bad = unsettled(m.tx, m.block);
    const e = chain.txs[m.tx];
    const inReceipt = e?.receipt?.logs.find((x) => Number(BigInt(x.logIndex)) === m.logIndex && lower(x.address) === USDG && BigInt(x.data || "0x0") === m.amount
      && lower(x.topics?.[1]) === lower(addressTopic(m.from)) && lower(x.topics?.[2]) === lower(addressTopic(m.to)));
    let classification: MovementReport["classification"] = null;
    let signers: MovementReport["signers"] = null;
    if (!bad && inReceipt) {
      const [leg] = legsFromReceipt([inReceipt]);
      const c = classifyUsdgMovement({ account: account!, usdg: leg!, txLegs: legsFromReceipt(e!.receipt!.logs), usdgToken: USDG, knownAccounts, custodyAddresses, reserveTokens });
      classification = { kind: c.kind, rule: c.evidence.rule, why: c.why, pairedToken: c.pairedToken ?? null };
      signers = signersOf(e!.receipt!.logs, account!, m.logIndex);
    }
    movements.push({
      key: `log:${m.tx}#${m.logIndex}`, txHash: m.tx, logIndex: m.logIndex, block: m.block, blockHash: e?.block?.hash ?? null, at: !bad ? txTime(m.tx) : null,
      direction, amountRaw: m.amount.toString(), counterparty, classification, signers, counterpartyKnownAccount: knownAccounts.includes(counterparty),
      counterpartyIsOwner: counterparty === grant?.owner || counterparty === booking.tenant, epochByTime: null,
      answeredBy: {
        flows: snap.flows.rows.filter((f) => lower(f.txHash) === m.tx && f.logIndex === m.logIndex).map((f) => ({ id: f.id, epoch: f.epoch, source: f.source })),
        trades: snap.trades.filter((t) => t.txHash === m.tx).map((t) => t.id),
        gapBookings: snap.gapBookings.filter((b) => b.evidenceKey === `log:${m.tx}#${m.logIndex}`).map((b) => `${b.bookingId}:${b.state}`),
        repairs: snap.repairs.filter((r) => r.evidenceKey === `log:${m.tx}#${m.logIndex}`).map((r) => `${r.repairId}:${r.state}`),
      },
    });
    if (bad || !inReceipt) refuse("movement-unread", `USDG ${direction} ${usdg6(m.amount.toString())} in tx ${m.tx} log ${m.logIndex}: ${bad ?? "the receipt does not carry the log as the read named it"}`);
  }
  // COVERAGE: every movement since block 0, and nothing the balance does not account for.
  let running = 0n, inRaw = 0n, outRaw = 0n, neverNegative = true;
  for (const m of movements) {
    const v = BigInt(m.amountRaw);
    if (m.direction === "in") { running += v; inRaw += v; } else if (m.direction === "out") { running -= v; outRaw += v; }
    if (running < 0n) neverNegative = false;
  }
  const usdgBal = account ? chain.balances[USDG]?.by[account] ?? null : null;
  const matches = usdgBal !== null && neverNegative && BigInt(usdgBal) === running;
  if (!chain.unavailable && historyComplete && !matches) {
    refuse(usdgBal === null ? "balance-unread" : "coverage-mismatch", usdgBal === null
      ? `the account's USDG balance at the pinned block could not be read${chain.unread[`${USDG}:${account}`] === "pruned" ? " (the node no longer has that block's state)" : ""}, so the history cannot be proved complete — preview again`
      : `the account's USDG logs since block 0 net to ${usdg6(running.toString())}${neverNegative ? "" : " (and run below zero on the way)"}, and balanceOf at the pinned block says ${usdg6(usdgBal)}: something moved USDG that the read does not show`);
  }
  // CUSTODY: capital can cross the book's edge at a vault, and no classifier rule reads it from the vault's side.
  const custody: ClosedEpochPlan["custody"] = [];
  for (const c of custodyAddresses) {
    const r = reads.custody[c];
    const ms = new Map<string, NonNullable<ReturnType<typeof usdgMovementOf>>>();
    for (const l of [...(r?.out.logs ?? []), ...(r?.in.logs ?? [])]) { const m = usdgMovementOf(l, c); if (m) ms.set(`${m.tx}#${m.logIndex}`, m); }
    let net = 0n;
    const outside: string[] = [];
    for (const m of ms.values()) {
      if (m.to === c && m.from !== c) net += m.amount; else if (m.from === c && m.to !== c) net -= m.amount;
      const other = m.from === c ? m.to : m.from;
      if (other !== account && !custodyAddresses.includes(other)) outside.push(`${m.tx}#${m.logIndex}`);
    }
    const bal = chain.balances[USDG]?.by[c] ?? null;
    const complete = !!r && r.out.complete && r.in.complete;
    custody.push({ address: c, complete, movements: ms.size, netRaw: net.toString(), balanceRaw: bal, outside });
    if (chain.unavailable) continue;
    if (!complete) refuse("custody-unread", `the USDG logs of custody address ${c} could not be read from block 0: whether capital crossed the book there is unproved`);
    else if (outside.length) refuse("custody-capital", `custody address ${c} moved USDG with an address outside the book (${outside.join(", ")}): capital crossed the book at a vault, and no classifier rule reads it from the vault's side`);
    else if (bal === null || BigInt(bal) !== net) refuse("custody-coverage", `custody address ${c}'s USDG logs net to ${usdg6(net.toString())} and its balance at the pinned block reads ${bal === null ? "unread" : usdg6(bal)}`);
  }

  // ── the boundary (epoch 1 only: its lower bound is the chain's genesis) ──
  const currentEpoch = agentReg?.epoch ?? null;
  const later = snap.bounds.filter((b) => b.epoch > P);
  const rowsMin = later.reduce<number | null>((m, b) => (b.min === null ? m : m === null ? b.min : Math.min(m, b.min)), null);
  const closing = snap.events.filter((e) => ((e.class === "held-reset" || e.class === "paper-reset") && e.epoch === P) || (e.class === "opened" && e.epoch === P + 1));
  const eventsMin = closing.reduce<number | null>((m, e) => (m === null ? e.at : Math.min(m, e.at)), null);
  const upperSec = rowsMin === null && eventsMin === null ? null : Math.min(rowsMin ?? Number.POSITIVE_INFINITY, eventsMin ?? Number.POSITIVE_INFINITY);
  const upperFrom = upperSec === null ? null : rowsMin === upperSec
    ? `the earliest row of a later epoch (${later.filter((b) => b.min === upperSec).map((b) => `${b.table} epoch ${b.epoch}`).join(", ")})`
    : `a boundary event (${closing.filter((e) => e.at === upperSec).map((e) => `${e.class} ${e.epoch}`).join(", ")})`;
  const lastMark = snap.marks.reduce<number | null>((m, x) => (m === null ? x.at : Math.max(m, x.at)), null);
  if (currentEpoch !== null && currentEpoch <= P) refuse("epoch-not-closed", `the account is in epoch ${currentEpoch}: epoch ${P} is not closed, and the booking tool files into an open epoch`);
  const maxEpoch = snap.bounds.reduce((m, b) => Math.max(m, b.epoch), 0);
  if (currentEpoch !== null && maxEpoch > currentEpoch) {
    refuse("epoch-rows-ahead", `rows are filed under epoch ${maxEpoch}, ahead of the registration's epoch ${currentEpoch}: the mirror copied rows before the agents row (paper-checkpoint.ts), so which epoch is open is not one answer`);
  }
  if (currentEpoch !== null && currentEpoch > P && !later.length) refuse("next-epoch-empty", `no row is filed under any epoch after ${P}, so when epoch ${P} closed cannot be dated`);
  // TWO EPOCHS IN ONE SPAN OF TIME: a valuation of this epoch (stamped as written) after a later epoch's first row, or after an event that
  // closes this one. The mirror copies append-only rows before the agents row (paper-checkpoint.ts), so after a failed pass and a
  // redeploy a child can write this epoch's rows after the next one's began; the window is then no partition.
  if (rowsMin !== null && lastMark !== null && lastMark > rowsMin) {
    refuse("epochs-overlap", `epoch ${P} has a valuation at ${iso(lastMark)}, after a later epoch's first row at ${iso(rowsMin)}: the two epochs overlap in time, so epoch ${P}'s window is not a partition`);
  }
  for (const e of closing) {
    if (lastMark !== null && e.at < lastMark) {
      refuse("boundary-contradicted", `an event closing epoch ${P} (${e.class}, #${e.id}) is stamped ${iso(e.at)}, before epoch ${P}'s own valuation at ${iso(lastMark)}: the epoch's rows and its boundary disagree`);
    }
  }
  for (const m of movements) m.epochByTime = m.at === null || upperSec === null ? null : m.at < upperSec ? P : "later";
  if (upperSec === null) for (const m of movements) m.epochByTime = null;

  // ── the chain's capital set for the epoch (from genesis to its close) ────
  const inWindow = movements.filter((m) => m.at !== null && upperSec !== null && m.at < upperSec);
  const capital = inWindow.filter((m) => m.classification && (m.classification.kind === "capital-in" || m.classification.kind === "capital-out" || m.classification.kind === "reserve-out"));
  for (const m of inWindow) {
    if (m.classification?.kind === "ambiguous") refuse("ambiguous-movement", `USDG ${m.direction} ${usdg6(m.amountRaw)} in tx ${m.txHash} log ${m.logIndex}: the classifier cannot say what it was (${m.classification.why})`);
  }
  const anchor = hold.anchorSec;
  for (const m of capital) {
    if (m.at! + BOUNDARY_MARGIN_SEC > upperSec!) {
      refuse("boundary-upper", `${m.key} landed at ${iso(m.at)}, within ${BOUNDARY_MARGIN_SEC}s of epoch ${P}'s close (${upperFrom} at ${iso(upperSec)}): which epoch it belongs to is not one answer`);
    }
    if (anchor !== null && m.at! > anchor - ANCHOR_MARGIN_SEC) {
      refuse("after-refusal", `${m.key} landed at ${iso(m.at)}, not before admission's chain refusal of this tenant at ${iso(anchor)}`);
    }
  }
  const maxFact = capital.reduce<number | null>((x, m) => (x === null ? m.at : Math.max(x, m.at!)), null);
  // DATED FROM BELOW: something written while the epoch was still open, after its last fact. Only write-time stamps can say that.
  let witness: BoundaryProof["witness"] = null;
  if (maxFact !== null && upperSec !== null) {
    const w1 = snap.marks.filter((x) => x.at >= maxFact + BOUNDARY_MARGIN_SEC && x.at <= upperSec).sort((x, y) => x.at - y.at)[0];
    const w2 = snap.events.filter((e) => e.class === "held-reset" && e.epoch === P && e.at >= maxFact + BOUNDARY_MARGIN_SEC).sort((x, y) => x.at - y.at)[0];
    const opening = snap.nextEquity;
    const openingShaped = opening !== null && opening.epoch === P + 1 && opening.at === rowsMin && opening.mode === "paper" && opening.ethWei === "0" && opening.vaultUsdg === 0
      && opening.positionsUsdg === 0 && micro(opening.cashUsdg) === micro(opening.equityUsdg) && (opening.flowsHeld === null || opening.flowsHeld === 0);
    const w3 = openingShaped && opening.at >= maxFact + BOUNDARY_MARGIN_SEC
      ? snap.events.find((e) => e.class === "paper-reset" && e.epoch === P && e.at >= opening.at && e.at <= opening.at + BOUNDARY_MARGIN_SEC) : undefined;
    if (w1) witness = { kind: "W1", at: w1.at, marginSec: w1.at - maxFact, said: `epoch ${P} valuation #${w1.id} at ${iso(w1.at)}, after its last capital fact (${iso(maxFact)})` };
    else if (w2) witness = { kind: "W2", at: w2.at, marginSec: w2.at - maxFact, said: `the held reset's own event (#${w2.id}, written in the reset's transaction) at ${iso(w2.at)}` };
    else if (w3 && opening) {
      witness = { kind: "W3", at: opening.at, marginSec: opening.at - maxFact,
        said: `epoch ${P + 1}'s first row is resetPaperLedger's paper opening (equity #${opening.id} at ${iso(opening.at)}, written in the bump's transaction) and runPaperReset's line closing epoch ${P} follows it (event #${w3.id} at ${iso(w3.at)})` };
    }
    if (!witness) {
      refuse("boundary-undated", `nothing written while epoch ${P} was still open dates it after its last capital fact (${iso(maxFact)}): no epoch-${P} valuation in ` +
        `[${iso(maxFact + BOUNDARY_MARGIN_SEC)}, ${iso(upperSec)}], no held-reset event closing it after then, and no paper opening paired with runPaperReset's line ` +
        "(a paper-opening row alone is not one: getPaperBook writes the same row with no bump)");
    }
  }

  // ── each capital movement against the flows rows that share its identity ──
  const P_rows = snap.flows.rows.filter((f) => f.epoch === P);
  const inserts: InsertProposal[] = [];
  const kept: Array<{ m: MovementReport; row: FlowRow }> = [];
  const mode = tradingModeOf(agentReg?.mode);
  for (const m of capital) {
    const kind = m.classification!.kind;
    const direction = kind === "capital-in" ? "in" : "out";
    // WHO CHOSE IT, before anything else: a movement the owner did not make is never filed as the owner's capital (capitalProvenance).
    if (kind !== "reserve-out") {
      const notOwners = capitalProvenance(m, snap.trades);
      if (notOwners.length) { for (const r of notOwners) refuse(r.code, r.why); continue; }
    }
    const twins = snap.flows.rows.filter((f) => lower(f.txHash) === m.txHash && f.logIndex === m.logIndex && (f.chainId === chainId || f.chainId === null));
    const quarantined = snap.quarantine.rows.filter((q) => lower(q.txHash) === m.txHash && q.logIndex === m.logIndex);
    const applied = [...snap.gapBookings.filter((b) => b.state === "applied" && b.evidenceKey === m.key).map((b) => `chain_gap_bookings ${b.bookingId}`),
      ...snap.repairs.filter((r) => r.state === "applied" && r.evidenceKey === m.key).map((r) => `${REPAIRS_TABLE} ${r.repairId}`)];
    const otherEpoch = snap.flows.rows.filter((f) => f.epoch !== P && lower(f.txHash) === m.txHash && f.direction === direction);
    if (quarantined.length) refuse("identity-quarantined-before", `${m.key} was quarantined before (run ${quarantined.map((q) => q.runId).join(", ")}): a reviewed decision, not a re-filing`);
    if (otherEpoch.length) {
      refuse(twins.some((t) => t.epoch !== P) ? "fact-in-wrong-epoch" : "twin-in-other-epoch",
        `${m.key} (${direction} ${usdg6(m.amountRaw)}) is already filed outside epoch ${P} as flows ${otherEpoch.map((f) => `#${f.id} (epoch ${f.epoch}, ${f.source}${f.logIndex === null ? ", no log index" : ""})`).join(", ")}: ` +
        "nothing is moved between epochs, and filing it again would count it twice in every reader that sums by time");
      continue;
    }
    if (kind === "reserve-out") {
      const present = twins.length === 1 && twins[0]!.epoch === P && twins[0]!.source === "energy-buy" && twins[0]!.direction === "out"
        && micro(twins[0]!.amountUsdg) === BigInt(m.amountRaw) && twins[0]!.chainId === chainId;
      if (present) kept.push({ m, row: twins[0]! });
      else refuse("out-of-scope-reserve", `${m.key} is an energy purchase (reserve-out) with no identical worker-written 'energy-buy' row in epoch ${P}: filing one into a closed epoch is out of scope`);
      continue;
    }
    if (twins.length > 1) { refuse("identity-conflict", `${m.key} is filed ${twins.length} times (flows ${twins.map((t) => `#${t.id}`).join(", ")})`); continue; }
    const twin = twins[0];
    if (twin) {
      const same = twin.epoch === P && twin.source === "chain-log" && twin.direction === direction && micro(twin.amountUsdg) === BigInt(m.amountRaw)
        && twin.blockNumber === Number(m.block) && twin.chainId === chainId;
      if (same) kept.push({ m, row: twin });
      else refuse("identity-conflict", `${m.key} is filed as flows #${twin.id} (epoch ${twin.epoch}, ${twin.source}, ${twin.direction} ${twin.amountUsdg}, block ${twin.blockNumber}, chain ${twin.chainId}) and the chain says ${direction} ${usdg6(m.amountRaw)} at block ${m.block} on chain ${chainId}`);
      continue;
    }
    if (applied.length) { refuse("receipt-without-row", `${m.key} has an applied receipt (${applied.join(", ")}) and no flows row: a receipt whose row is gone is a reviewed decision`); continue; }
    if (!admitCapitalFlow({ mode, source: "chain-log", txHash: m.txHash }).admit) { refuse("paper-boundary", `the paper boundary refuses ${m.key}`); continue; }
    if (!agentId || chainId === null) continue;
    inserts.push({ key: m.key, amountRaw: m.amountRaw,
      movement: `USDG ${direction} ${usdg6(m.amountRaw)} ${direction === "in" ? "from" : "to"} ${m.counterparty} (${m.classification!.rule}; ${provenanceSaid(m)})`,
      row: { agent_id: agentId, direction, amount_usdg: Number(BigInt(m.amountRaw)) / 1e6, tx_hash: m.txHash, block_number: Number(m.block), log_index: m.logIndex,
        source: "chain-log", epoch: P, chain_id: chainId, at: m.at! } });
  }
  // ── the epoch's rows that are not the chain's ─────────────────────────────
  const capitalKeys = new Set(capital.map((m) => `${m.txHash}#${m.logIndex}`));
  const quarantines: QuarantineProposal[] = [];
  const replacedBy = inserts.map((i) => `${i.row.tx_hash}#${i.row.log_index}`).join(",");
  for (const f of P_rows) {
    if (RECEIPT_SOURCES.has(f.source)) {
      if (f.txHash === null || f.logIndex === null || !capitalKeys.has(`${lower(f.txHash)}#${f.logIndex}`)) {
        refuse("unexplained-receipt", `flows #${f.id} in epoch ${P} is a ${f.source} receipt (${f.txHash ?? "no tx"}#${f.logIndex ?? "?"}) the chain's capital set for the epoch does not hold`);
      }
      continue;
    }
    if (f.source === "epoch-carry") { refuse("carry-in-epoch-1", `flows #${f.id} is an epoch-carry in epoch ${P}: epoch 1 opens with nothing to carry`); continue; }
    const twinOf = f.txHash !== null && f.logIndex === null ? capital.find((m) => m.txHash === lower(f.txHash) && (m.direction === f.direction)) : undefined;
    if (f.txHash === null) {
      quarantines.push({ id: f.id, agentId: f.agentId, row: f, reason: `superseded: an unevidenced '${f.source}' row with no transaction, standing in for the epoch-${P} capital the chain-log rows ${replacedBy || "already filed"} now record` });
    } else if (twinOf) {
      quarantines.push({ id: f.id, agentId: f.agentId, row: f, reason: `superseded: a '${f.source}' row for ${f.txHash} with no log index, the same movement the chain-log row ${twinOf.txHash}#${twinOf.logIndex} records` });
    } else {
      refuse("unexplained-row", `flows #${f.id} in epoch ${P} ('${f.source}', ${f.direction} ${f.amountUsdg}, tx ${f.txHash}${f.logIndex === null ? "" : `#${f.logIndex}`}) answers no capital movement the chain shows for the epoch`);
    }
  }
  const afterIn = [...kept.filter((k) => k.m.direction === "in"), ...inserts.filter((i) => i.row.direction === "in")].length;
  const afterOut = [...kept.filter((k) => k.m.direction === "out"), ...inserts.filter((i) => i.row.direction === "out")].length;
  if (afterOut > 0 && afterIn === 0) {
    refuse("outbound-only", `after the repair epoch ${P} would hold a withdrawal and no capital in: it would file capital out of an epoch the chain shows never received any from outside the system`);
  }
  const signed = (f: { direction: string; amountUsdg: number }) => (f.direction === "in" ? micro(f.amountUsdg) : -micro(f.amountUsdg));
  const netBefore = P_rows.reduce((s, f) => s + signed(f), 0n);
  const netAfter = [...kept.map((k) => k.row), ...inserts.map((i) => ({ direction: i.row.direction, amountUsdg: i.row.amount_usdg }))].reduce((s, f) => s + signed(f), 0n);
  const receiptsAfter = [...kept.map((k) => `${lower(k.row.txHash)}#${k.row.logIndex}`), ...inserts.map((i) => `${i.row.tx_hash}#${i.row.log_index}`)].sort(byText);

  // ── admission's duplicate check, over what the repair would leave ──────────
  // The apply proves both runs clean after its writes (flowDuplicateReport);
  // asked here of the same rules (collapseFlows) over epoch P as it would
  // stand, so a duplicate or a conflict refuses at the preview, not only at
  // the apply. Epoch P before the repair is not the question: a stand-in this
  // repair quarantines may be the copy.
  const quarantinedIds = new Set(quarantines.map((q) => q.id));
  const maxFlowId = snap.flows.rows.reduce((m, f) => Math.max(m, f.id), 0);
  const leftRows: FlowRow[] = [
    ...P_rows.filter((f) => !quarantinedIds.has(f.id)),
    ...inserts.map((i, k) => ({ id: maxFlowId + 1 + k, agentId: i.row.agent_id, direction: i.row.direction, amountUsdg: i.row.amount_usdg, txHash: i.row.tx_hash,
      blockNumber: i.row.block_number, logIndex: i.row.log_index, source: i.row.source, epoch: P, chainId: i.row.chain_id, at: i.row.at })),
  ];
  const registeredChains = [...new Set(booking.agents.map((a) => a.chainId).filter((c): c is number => c !== null))];
  let epochAfter: RunDuplicates;
  if (leftRows.some((f) => (f.direction !== "in" && f.direction !== "out") || !Number.isFinite(f.amountUsdg) || !Number.isFinite(f.at))) {
    epochAfter = { epoch: P, clean: false, verdict: "unread", copies: 0, conflicts: 0 };
  } else {
    const records: FlowRecord[] = leftRows.map((f) => ({ id: f.id, agentId: f.agentId, direction: f.direction as "in" | "out", amountUsdg: f.amountUsdg, txHash: f.txHash,
      blockNumber: f.blockNumber, logIndex: f.logIndex, source: f.source, chainId: f.chainId, at: f.at }));
    const c = collapseFlows(records, registeredChains.length === 1 ? registeredChains[0]! : null);
    const copies = Object.values(c.duplicates.copies).reduce((s, n) => s + n, 0), conflicts = Object.values(c.duplicates.conflicts).reduce((s, n) => s + n, 0);
    epochAfter = { epoch: P, clean: copies === 0 && conflicts === 0, verdict: c.verdict, copies, conflicts };
  }
  if (!epochAfter.clean) {
    refuse("flows-duplicate", `after the repair epoch ${P}'s flows would hold ${epochAfter.copies} copy(ies) and ${epochAfter.conflicts} conflict(s) of one movement ` +
      `(distinct-flows.ts, verdict ${epochAfter.verdict}): admission refuses a tenant whose flows do, and so would the apply`);
  }
  if (snap.currentRun && !snap.currentRun.clean) {
    refuse("flows-duplicate", `the current run (epoch ${snap.currentRun.epoch ?? "unread"}) holds ${snap.currentRun.copies} copy(ies) and ${snap.currentRun.conflicts} conflict(s) ` +
      `of one movement (distinct-flows.ts flowDuplicateReport, verdict ${snap.currentRun.verdict}): admission refuses this tenant until that is repaired, and this repair never writes that run`);
  }

  // ── operations: who signed, and what answers each ─────────────────────────
  const book = account ? [account, ...custodyAddresses] : [];
  /** The owner reading re-derived from a transaction's receipt over the grant's custody and chain: what an owner record must agree with. */
  const readingOf = (tx: string, userOpHash: string): OwnerOperationReading | null => {
    const logs = chain.txs[tx]?.receipt?.logs;
    return logs && account && chainId !== null
      ? ownerOperationOf({ receiptLogs: logs, userOpHash, txHash: tx, account, custody: custodyAddresses, usdg: USDG, chainId }) : null;
  };
  const recordsOf = (userOpHash: string): OpReport["ownerRecords"] => booking.ownerRecords.filter((r) => r.userOpHash === userOpHash)
    .map(({ disposition, reviewReason, tenant, chainId: c, txHash }) => ({ disposition, reviewReason, tenant, chainId: c, txHash }));
  // WHAT ADMISSION'S CHECK ANSWERED EACH BY, from the check this tool ran: the window it read, what it named, what Postgres could answer with.
  const checked = chain.gap.status === "unavailable" ? null : { from: BigInt(chain.gap.fromBlock), to: BigInt(chain.gap.head) };
  const namedOps = new Set(chain.gap.status === "missing" ? chain.gap.found.flatMap((f) => (f.kind === "operation" ? [lower(f.userOpHash)] : [])) : []);
  const tradeOps = new Set(booking.known.ops), ownerOps = new Set(booking.known.ownerOps);
  const ops: OpReport[] = [];
  for (const l of reads.ops.logs) {
    const op = typeof l.address === "string" && typeof l.logIndex === "string" ? decodeUserOperationEvent(l) : null;
    if (!op || op.entryPoint !== EP || op.sender !== account) { refuse("log-unreadable", `an operation log of the account (tx ${lower(l.transactionHash)}) could not be decoded`); continue; }
    const tx = lower(l.transactionHash);
    const at = unsettled(tx, typeof l.blockNumber === "string" ? BigInt(l.blockNumber).toString() : null) === null ? txTime(tx) : null;
    const validator = validatorOfNonce(op.nonce);
    const answeredBy = snap.trades.filter((t) => t.userOpHash === op.userOpHash).map(({ id, kind, status, amountUsdg, epoch, createdAt }) => ({ id, kind, status, amountUsdg, epoch, createdAt }));
    const height = typeof l.blockNumber === "string" ? BigInt(l.blockNumber) : null;
    const admission: OpReport["admission"] = checked === null || height === null || height < checked.from || height > checked.to ? null
      : namedOps.has(op.userOpHash) ? "missing" : tradeOps.has(op.userOpHash) ? "trades-row" : ownerOps.has(`${op.userOpHash}|${tx}`) ? "owner-record" : null;
    const reading = validator === "root" ? readingOf(tx, op.userOpHash) : null;
    const epochByTime = at === null || upperSec === null ? null : at < upperSec ? P : "later";
    const inKind: OpReport["inKind"] = [];
    if (validator === "root") {
      const seg = segmentReceipt(chain.txs[tx]?.receipt?.logs ?? []).segments.find((s) => s.op.userOpHash === op.userOpHash);
      for (const leg of legsFromReceipt(seg?.logs ?? [])) {
        if (lower(leg.token) === USDG || BigInt(leg.amountRaw) === 0n) continue;
        const out = book.includes(lower(leg.from)), into = book.includes(lower(leg.to));
        if (out === into) continue;
        const logIndex = seg!.logs.find((x) => lower(x.address) === lower(leg.token) && `0x${lower(x.topics?.[1]).slice(-40)}` === lower(leg.from)
          && `0x${lower(x.topics?.[2]).slice(-40)}` === lower(leg.to) && BigInt(x.data || "0x0").toString() === leg.amountRaw);
        inKind.push({ token: lower(leg.token), direction: out ? "out" : "in", amountRaw: leg.amountRaw, counterparty: lower(out ? leg.to : leg.from),
          logIndex: logIndex ? Number(BigInt(logIndex.logIndex)) : -1 });
      }
    }
    const ownerOperationRecordedAsTrade = validator === "root" && answeredBy.some((t) => t.kind === "swap");
    ops.push({ userOpHash: op.userOpHash, txHash: tx, block: typeof l.blockNumber === "string" ? BigInt(l.blockNumber).toString() : "?", at, validator,
      paymaster: op.paymaster, success: op.success, epochByTime, answeredBy, ownerRecords: recordsOf(op.userOpHash),
      ownerReading: reading && { disposition: reading.disposition, reasons: reading.reasons, covers: reading.covers, usdgLegs: reading.usdgLegs, tokenMoves: reading.tokenMoves },
      admission, ownerOperationRecordedAsTrade, inKind });
    if (ownerOperationRecordedAsTrade) {
      warnings.push(`operation ${op.userOpHash} (tx ${tx}) was signed by the owner's root key and is answered by trades row(s) ${answeredBy.filter((t) => t.kind === "swap").map((t) => `#${t.id} (kind 'swap', ${t.amountUsdg} USDG, epoch ${t.epoch}, written ${iso(t.createdAt)})`).join(", ")}: ` +
        "an owner operation recorded as an agent trade, as the in-flight reconciler (index.ts reconcileInFlightAtArm) booked every operation it found with no row " +
        "until it recorded the owner's apart in owner_operations (docs/owner-operations.md). Left in place: it is what answers the operation for admission, and the " +
        "read-only owner-operations audit (owner-op-audit-cli.ts) lists it. Removing it while admission's chain read still reaches it re-holds this tenant, unless " +
        "an owner record admission takes answers the operation instead: an acknowledged one, which an operation that also moved another token never is");
    }
    if (inKind.length && epochByTime === P) {
      warnings.push(`operation ${op.userOpHash} (root key) also moved ${inKind.map((k) => `${k.direction} ${k.amountRaw} of ${k.token}`).join(", ")} in kind: review only, never a flow ` +
        `(capital-classify.ts asset-out), so epoch ${P}'s P&L reads that value as a loss rather than a withdrawal`);
    }
  }

  // ── admission, after the repair: its own rule over what Postgres would hold ──
  const date = (f: MissingChainFact): DatedFact => {
    const tx = lower(f.txHash);
    const at = unsettled(tx, f.block) === null ? txTime(tx) : null;
    let validator: string | null = null;
    if (f.kind === "operation") {
      const seg = segmentReceipt(chain.txs[tx]?.receipt?.logs ?? []).segments.find((s) => s.op.userOpHash === lower(f.userOpHash));
      validator = seg ? validatorOfNonce(seg.op.nonce) : null;
    }
    return { fact: f, said: describeChainFact(f), at, validator };
  };
  const found = chain.gap.status === "missing" ? chain.gap.found.map(date) : [];
  if (chain.gap.status === "unavailable" && !chain.unavailable) refuse("admission-unread", `admission's chain check could not be run (${chain.gap.why}); preview again`);
  // An operation an owner record answers is not in `found` (the check took the record), nor is any leg the record covers. Its capital
  // legs are, like any transfer: a flow on record, or one filed here, holds them.
  const held = { ops: new Set(booking.known.ops), txs: new Set(booking.known.txs), flows: new Set([...booking.known.flows, ...inserts.map((i) => `${i.row.tx_hash}:${i.row.log_index}`)]) };
  const still = new Set(factsStillMissing(found.map((d) => d.fact), held));
  const remaining = found.filter((d) => still.has(d.fact));
  /** For an owner's operation still named: the record Postgres holds for it, if any, and why admission did not take it, in words. */
  const ownerSaid = (f: Extract<MissingChainFact, { kind: "operation" }>): string => {
    const tx = lower(f.txHash), hash = lower(f.userOpHash);
    const reading = readingOf(tx, hash);
    const derived = reading
      ? `re-derived from the receipt over the grant's custody it is '${reading.disposition}'${reading.reasons.length ? ` (${reading.reasons.join(", ")})` : ""}`
      : "its receipt does not read as an owner's operation";
    const records = recordsOf(hash);
    if (!records.length) return `. No owner record is in Postgres for it; ${derived} (docs/owner-operations.md)`;
    const recordSaid = (r: OpReport["ownerRecords"][number]) => [`${r.disposition}${r.reviewReason ? `: ${r.reviewReason}` : ""}`,
      ...(r.chainId !== chainId ? [`chain ${r.chainId}`] : []), ...(r.tenant !== booking.tenant ? [`tenant ${r.tenant ?? "not stamped"}`] : []),
      ...(r.txHash !== tx ? [`in tx ${r.txHash}`] : [])].join(", ");
    return `. Postgres holds an owner record for it (${records.map(recordSaid).join("; ")}), and admission did not take it as an answer: only an acknowledged ` +
      `record of this tenant and chain, in the operation's own transaction, that the receipt re-derives as acknowledged answers an owner's operation; ${derived} ` +
      "(docs/owner-operations.md)";
  };
  const afterBoundary: DatedFact[] = [];
  for (const d of remaining) {
    if (d.at === null) { refuse("fact-undated", `admission would still find ${d.said}, and its receipt or block could not be read to date it`); continue; }
    if (upperSec !== null && d.at >= upperSec) { afterBoundary.push(d); continue; }
    if (d.fact.kind === "operation") {
      refuse("operation-unanswered", `admission would still find ${d.said}, from before epoch ${P} closed, signed by ${d.validator === "root" ? "the owner's own key (the root validator): an owner-operation (docs/chain-gap-booking.md), which no row here may record as the agent's"
        : `a ${d.validator ?? "unread"} validator`} — this tool books no operation${d.validator === "root" ? ownerSaid(d.fact) : ""}`);
    } else refuse("transfer-unanswered", `admission would still find ${d.said}, from before epoch ${P} closed, which is not a capital movement this repair files`);
  }
  if (afterBoundary.length) {
    warnings.push(`${afterBoundary.length} fact(s) admission would still find landed after epoch ${P} closed: book them with chain-gap-booking after this repair (${afterBoundary.map((d) => d.said).join("; ")})`);
  }

  // ── the stale live basis admission would seed ─────────────────────────────
  const stale = staleBasisPlan({ seedBefore: snap.seedBefore, positions: booking.holdings.positions, liveBasis: snap.liveBasis, liveFloors: snap.liveFloors,
    rawGrantAccount: snap.rawGrantAccount, balances: chain.balances, classVault: grant?.classVault ?? null, mode: agentReg?.mode ?? null });
  if (!chain.unavailable) for (const r of stale.refusals) refuse(r.code, r.why);
  warnings.push(...stale.warnings);
  const flatTokens = new Set(stale.verdicts.filter((v) => v.verdict === "clear").map((v) => v.symbol));
  if (stale.seedAfter.basis.some((b) => flatTokens.has(b.symbol))) refuse("seed-after", "what admission would seed after the repair still names a token the chain shows flat");
  // A CLEAR ONLY WHERE ADMISSION'S DRAIN CANNOT UNDO IT (retainedHomeVerdict).
  const home = retainedHomeVerdict(snap.homeAtAnchor);
  if (stale.clears.length && !home.durable) refuse(home.code!, home.why);
  if (stale.inertBasis.length || stale.inertFloors.length) {
    warnings.push(`live basis or floor rows outside what admission would seed are left alone (inert: admission never seeds them, and the first mirror pass after admission replaces them): ` +
      `${[...stale.inertBasis.map((b) => `basis ${b.symbol}`), ...stale.inertFloors.map((f) => `floor ${f.symbol}`)].join(", ")}`);
  }
  const stalePositions = booking.holdings.positions.filter((p) => p.rawBalance !== "0" && flatTokens.has(p.symbol));
  if (stalePositions.length) {
    warnings.push(`positions still shows ${stalePositions.map((p) => p.symbol).join(", ")} held, which the chain shows flat: positions is never touched here (on the paper rail it is the paper book's cache), and the next worker rewrites it`);
  }

  // ── flows per epoch, for the reviewer ─────────────────────────────────────
  const epochs = [...new Set(snap.flows.rows.map((f) => f.epoch))].sort((x, y) => x - y);
  const lastMarkEquity = snap.marks.length ? snap.marks[snap.marks.length - 1]!.equityUsdg : null;
  const boundaryCash = upperSec === null ? null : movements.filter((m) => m.at !== null && m.at < upperSec)
    .reduce((s, m) => s + (m.direction === "in" ? BigInt(m.amountRaw) : m.direction === "out" ? -BigInt(m.amountRaw) : 0n), 0n);
  const flowsByEpoch: ClosedEpochPlan["flowsByEpoch"] = epochs.map((e) => {
    const rows = snap.flows.rows.filter((f) => f.epoch === e);
    const inM = rows.filter((f) => f.direction === "in").reduce((s, f) => s + micro(f.amountUsdg), 0n);
    const outM = rows.filter((f) => f.direction === "out").reduce((s, f) => s + micro(f.amountUsdg), 0n);
    const carries = rows.filter((f) => f.source === "epoch-carry").map((f) => {
      const r = e === P + 1 ? reconcileEpochCarry({ openingBalanceUsdg: f.amountUsdg, priorEpochClosingEquityUsdg: lastMarkEquity }) : null;
      return { id: f.id, amountUsdg: f.amountUsdg, reconciles: r ? r.reconciles : null, why: r ? r.why : "not against epoch 1's close" };
    });
    if (e === P + 1 && carries.length) {
      warnings.push(`epoch ${e} opens with an epoch-carry of ${carries.map((c) => c.amountUsdg).join(", ")} USDG (${carries.map((c) => c.why).join("; ")}), against an on-chain USDG balance at epoch ${P}'s close of ` +
        `${boundaryCash === null ? "unknown" : usdg6(boundaryCash.toString())}: a carry taken from a mark before a withdrawal this repair files would count it twice across the boundary — never written here, escalate`);
    }
    return { epoch: e, rows, inMicro: inM.toString(), outMicro: outM.toString(), netMicro: (inM - outM).toString(), evidenced: rows.filter((f) => EVIDENCED.has(f.source)).length,
      unevidenced: rows.filter((f) => !EVIDENCED.has(f.source)).length, carries };
  });

  if (snap.agent) {
    warnings.push(`no peak moves: hwm_usdg ${snap.agent.hwmUsdg} less hwm_withdrawn_usdg ${snap.agent.hwmWithdrawnUsdg} is the effective peak, against ${usdgBal === null ? "an unread" : usdg6(usdgBal)} USDG on chain at the pinned block — run hwm-repair, a separate reviewed decision, before any live re-arm`);
  }
  if (inserts.length || quarantines.length) {
    warnings.push(`epoch ${P}'s rows change (net ${said(netBefore)} → ${said(netAfter)} USDG): web reports that window flows by time rather than epoch will show them; the child's journal is not written (it is not mirrored to Postgres); ` +
      "admission's evidence digest changes (flowsNet covers every epoch), so a fresh approval is needed");
  }

  const nothing = !inserts.length && !quarantines.length && !stale.clears.length;
  const verdict: ClosedEpochPlan["verdict"] = refusals.length ? "blocked" : nothing ? "nothing-to-do" : "ready";
  const cas = closedCasFacts(snap);
  const boundary: BoundaryProof = { epoch: P, currentEpoch, upperSec, upperFrom, lastMark, maxFact, witness, events: snap.events, commands: snap.commands,
    nextEquity: snap.nextEquity, bounds: snap.bounds };
  const bound = {
    format: CLOSED_EPOCH_FORMAT, source: o.source, target: o.target, tenant: booking.tenant, epoch: P, account, agentId, chainId, verdict, refusals, boundary,
    coverage: { complete: historyComplete, movements: movements.length, inRaw: inRaw.toString(), outRaw: outRaw.toString(), netRaw: running.toString(), balanceRaw: usdgBal, neverNegative, matches },
    custody, movements, ops, flowsByEpoch, quarantineHistory: snap.quarantine.rows,
    proposals: { inserts, quarantines, clears: stale.clears },
    predicted: { epochNetBefore: netBefore.toString(), epochNetAfter: netAfter.toString(), epochReceiptsAfter: receiptsAfter },
    admission: { found, remaining, afterBoundary },
    holdings: { seedBefore: snap.seedBefore, seedAfter: stale.seedAfter, verdicts: stale.verdicts, inertBasis: stale.inertBasis, inertFloors: stale.inertFloors,
      positions: booking.holdings.positions, paperBasis: snap.paperBasis, classPositions: snap.classPositions, paperBook: snap.paperBook,
      home: { atAnchor: snap.homeAtAnchor, durable: home.durable, why: home.why } },
    duplicates: { epochAfter, currentRun: snap.currentRun },
    agent: snap.agent, trades: snap.trades, feeAccruals: snap.feeAccruals, riskPeriods: snap.riskPeriods,
    receipts: { gapBookings: snap.gapBookings, repairs: snap.repairs }, balances: chain.balances, unread: chain.unread, warnings, cas,
  };
  return {
    ...bound, format: CLOSED_EPOCH_FORMAT, previewDigest: digestOf(bound),
    capture: { capturedAtSec: o.nowSec, head: chain.head, pinned: chain.pinned, rpcChainId: chain.rpcChainId, confirmations: Number(BOOKING_CONFIRMATIONS),
      logSpan: CLOSED_EPOCH_LOG_SPAN.toString(), calls: chain.calls, gapFromBlock: chain.gap.status === "unavailable" ? null : chain.gap.fromBlock },
  };
}

/** The plan as an operator reads it at the console. Public chain data, counts and classes only. */
export function closedEpochLines(p: ClosedEpochPlan): string[] {
  const out = [`closed-epoch capital ${p.verdict.toUpperCase()} — tenant ${p.tenant}, account ${p.account ?? "unknown"}, epoch ${p.epoch}: ` +
    `${p.proposals.inserts.length} flow(s) to file, ${p.proposals.quarantines.length} to quarantine, ${p.proposals.clears.length} basis/floor row(s) to clear`];
  for (const r of p.refusals) out.push(`  refused (${r.code}): ${r.why}`);
  const b = p.boundary;
  out.push(`  boundary: epoch ${b.epoch} closed no later than ${iso(b.upperSec)} (${b.upperFrom ?? "undated"}); last capital fact ${iso(b.maxFact)}; ` +
    `witness ${b.witness ? `${b.witness.kind} — ${b.witness.said}, margin ${b.witness.marginSec}s` : "none"}`);
  out.push(`  coverage: ${p.coverage.movements} USDG movement(s) since block 0, net ${usdg6(p.coverage.netRaw)} against balanceOf ${p.coverage.balanceRaw === null ? "unread" : usdg6(p.coverage.balanceRaw)} — ${p.coverage.matches ? "complete" : "NOT PROVED"}`);
  for (const c of p.custody) out.push(`  custody ${c.address}: ${c.movements} USDG movement(s), outside the book ${c.outside.length}, ${c.complete ? "read" : "UNREAD"}`);
  for (const i of p.proposals.inserts) out.push(`  file in epoch ${p.epoch}: ${i.movement} — ${i.key}, block ${i.row.block_number}, at ${iso(i.row.at)}`);
  for (const q of p.proposals.quarantines) out.push(`  quarantine flows #${q.id} (${q.row.source}, ${q.row.direction} ${q.row.amountUsdg}): ${q.reason}`);
  for (const c of p.proposals.clears) out.push(`  clear ${c.table} live ${c.symbol} (${c.token}): flat on chain at the pinned block`);
  // When it would not hold, the refusal says so.
  if (p.proposals.clears.length && p.holdings.home.durable) out.push(`  the clear holds: ${p.holdings.home.why}`);
  out.push(`  epoch ${p.epoch} net contributions ${usdg6(p.predicted.epochNetBefore)} → ${usdg6(p.predicted.epochNetAfter)} USDG; other epochs and the peaks unchanged`);
  for (const op of p.ops.filter((x) => x.ownerOperationRecordedAsTrade)) out.push(`  owner operation ${op.userOpHash} answered by an agent 'swap' row (left in place)`);
  for (const op of p.ops.filter((x) => x.admission === "owner-record")) {
    out.push(`  owner operation ${op.userOpHash} answered by its owner record (acknowledged, re-derived from the receipt as admission does): no trades row, and none is written`);
  }
  out.push(`  admission after: ${p.admission.remaining.length - p.admission.afterBoundary.length} fact(s) before the boundary, ${p.admission.afterBoundary.length} after it (for chain-gap-booking)`);
  for (const w of p.warnings) out.push(`  note: ${w}`);
  out.push(`previewDigest ${p.previewDigest}`);
  return out;
}

// ── apply ────────────────────────────────────────────────────────────────────

/**
 * The receipts table: one row per action — a flow filed, a flow quarantined,
 * a basis or floor cleared — with the row in full (as written, or the
 * pre-image removed, chain_id included, which flows_quarantine does not
 * carry), the preview and backup it was applied under, where the tenant
 * stood with admission (admission_json, what a revert is decided against)
 * and the before/after fingerprints. Unique per (account, evidence_key)
 * while applied, across EVERY epoch: one log is filed once wherever it
 * lands. Kept, never deleted, after a revert.
 */
export const REPAIRS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${REPAIRS_TABLE} (
    repair_id TEXT NOT NULL,
    tenant TEXT NOT NULL,
    account TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    chain_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    evidence_key TEXT NOT NULL,
    table_name TEXT NOT NULL,
    row_key TEXT NOT NULL,
    row_json TEXT NOT NULL,
    row_digest TEXT NOT NULL,
    preview_digest TEXT NOT NULL,
    backup_ref TEXT NOT NULL,
    admission_json TEXT NOT NULL,
    fingerprints_json TEXT NOT NULL,
    state TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL,
    reverted_at_ms INTEGER,
    PRIMARY KEY (repair_id, evidence_key)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ${REPAIRS_TABLE}_once ON ${REPAIRS_TABLE} (account, evidence_key) WHERE state = 'applied';
`;
const REPAIR_COLUMNS = ["repair_id", "tenant", "account", "epoch", "chain_id", "action", "evidence_key", "table_name", "row_key", "row_json", "row_digest", "preview_digest",
  "backup_ref", "admission_json", "fingerprints_json", "state", "applied_at_ms", "reverted_at_ms"];
export async function ensureClosedEpochSchema(db: Db): Promise<void> {
  for (const statement of REPAIRS_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await db.exec(statement);
}

export type RepairAction = "insert-flow" | "quarantine-flow" | "clear-live-basis" | "clear-live-floor";
export interface RepairActionRecord { action: RepairAction; table: string; evidenceKey: string; rowKey: string; row: Record<string, unknown>; rowDigest: string }
export interface RepairApplyReport {
  format: typeof CLOSED_EPOCH_APPLY_FORMAT; repairId: string; tenant: string; account: string; chainId: number; epoch: number;
  previewDigest: string; backupRef: string; appliedAtMs: number;
  admission: AdmissionState;
  fingerprints: { before: Fingerprints; after: Fingerprints };
  actions: RepairActionRecord[];
  reportDigest: string;
}

const FLOW_ROW_COLUMNS = FLOW_SNAPSHOT_COLUMNS.split(", ");
/** A flows row exactly as stored, every column, for a receipt and a revert. */
const storedFlow = (r: Record<string, unknown>) => storedRow(r, FLOW_ROW_COLUMNS.filter((c) => c !== "id"));
const basisPreimage = (b: BasisRow) => ({ agent_id: b.agentId, mode: b.mode, symbol: b.symbol, qty_raw: b.qtyRaw, cost_usdg: b.costUsdg, updated_at: b.updatedAt });
const floorPreimage = (f: FloorRow) => ({ agent_id: f.agentId, mode: f.mode, symbol: f.symbol, stop_bps: f.stopBps, rung: f.rung, why: f.why, at: f.at });

/**
 * FILE, VERIFY, QUARANTINE, CLEAR — ONCE, IN ONE TRANSACTION.
 *
 * The plan is the one the caller just recomputed; `confirm` is the digest the
 * owner reviewed. Inside the transaction, in this order: the agent row is
 * locked (the no-op UPDATE bookCapitalFlow, openNextEpoch and
 * resetPaperLedger take, so no booking or bump races it); the identity index
 * is asked again; the snapshot is read again and every fact compared —
 * anything moved refuses and nothing is written; each identity is checked
 * once more across every epoch; the chain-log rows are inserted and read
 * back; the epoch's receipts are VERIFIED to be exactly the chain's capital
 * set before anything is taken away (accounting-repair.ts:1-28); then the
 * stand-ins are quarantined with accounting-repair's own statements; then the
 * stale basis and floors are deleted by exact pre-image; then the
 * postconditions; then one receipt per action. `persist` is handed the
 * report BEFORE the commit (the CLI writes and fsyncs its file there), so a
 * commit is never without its report.
 */
export async function applyClosedEpoch(db: Db, plan: ClosedEpochPlan, o: {
  confirm: string; backupRef: string; dialect: Dialect; nowMs: number; repairId?: string; persist?: (report: RepairApplyReport) => void | Promise<void>;
}): Promise<RepairApplyReport> {
  if (!DIGEST.test(o.confirm) || o.confirm !== plan.previewDigest) {
    throw new BookingRefused("confirm-mismatch", "the preview recomputed now does not have the digest you confirmed: the books, the chain or the code moved — preview again and review that one");
  }
  if (plan.verdict === "nothing-to-do") throw new BookingRefused("nothing-to-do", "the preview finds nothing to file, quarantine or clear (already applied?)");
  if (plan.verdict !== "ready") throw new BookingRefused("not-ready", `the preview is ${plan.verdict}, not ready: nothing is applied`);
  if (!BACKUP_REF.test(o.backupRef) || o.backupRef.includes("//")) throw new BookingRefused("backup-ref", "--backup-ref must name the backup taken before this apply (an id or file name, not a URL)");
  const repairId = o.repairId ?? randomUUID();
  if (!REPAIR_ID.test(repairId)) throw new BookingRefused("repair-id", "the repair id is not a UUID");
  const account = plan.account!, epoch = plan.epoch, chainId = plan.chainId!, agentId = plan.agentId!;
  await ensureClosedEpochSchema(db);
  const columns = await existingColumns(db, o.dialect, REPAIRS_TABLE);
  if (REPAIR_COLUMNS.some((c) => !columns.has(c))) throw new BookingRefused("schema", `${REPAIRS_TABLE} exists without the columns this tool records; nothing was written`);
  if (!(await hasChainIdentityIndex(db))) throw new BookingRefused("identity-index", "the flows_chain_identity unique index is not present with its required definition; nothing was written");
  const nowSec = Math.floor(o.nowMs / 1000);
  return db.tx(async (tx) => {
    const lock = await tx.prepare("UPDATE agents SET epoch = epoch WHERE smart_account = ?").run(plan.cas.booking.agents[0]!.smartAccount);
    if (Number(lock.changes) !== 1) throw new BookingRefused("cas", "the agent registration changed since the preview; nothing was written — preview again");
    if (!(await inspectChainIdentityIndex(tx, o.dialect)).valid) throw new BookingRefused("identity-index", "flows_chain_identity changed before the repair transaction; nothing was written");
    const now = await readClosedEpochSnapshot(tx, { tenant: plan.tenant, dialect: o.dialect, nowSec, epoch });
    const was = plan.cas, is = closedCasFacts(now);
    for (const field of Object.keys(was) as Array<keyof typeof was>) {
      if (canonical(was[field]) !== canonical(is[field])) throw new BookingRefused("cas", `the books changed since the preview (${field}); nothing was written — preview again`);
    }
    const tables = await existingTables(tx, o.dialect);
    const before = fingerprintsOf({ flowsRaw: (await readMutableFacts(tx, tables, account)).flowsRaw, quarantine: now.quarantine.rows, liveBasis: now.liveBasis, liveFloors: now.liveFloors }, epoch);
    const actions: RepairActionRecord[] = [];
    // ONE IDENTITY, FILED ONCE, ACROSS EVERY EPOCH: no row, no applied receipt in either receipts table, no quarantine history.
    const quarantining = new Set(plan.proposals.quarantines.map((q) => q.id));
    for (const i of plan.proposals.inserts) {
      const r = i.row;
      // The log itself in any epoch, or a row with no log index in its transaction that this repair does not quarantine.
      const rows = ((await tx.prepare("SELECT id, log_index FROM flows WHERE LOWER(agent_id) = ? AND LOWER(tx_hash) = ?").all(account, r.tx_hash)) as Array<Record<string, unknown>>)
        .filter((x) => (x.log_index === null || x.log_index === undefined ? !quarantining.has(Number(x.id)) : Number(x.log_index) === r.log_index));
      if (rows.length) throw new BookingRefused("identity", `${i.key}: a flows row already names this movement; nothing was written`);
      const receipts = [
        ...(tables.has(BOOKINGS_TABLE) ? (await tx.prepare(`SELECT booking_id FROM ${BOOKINGS_TABLE} WHERE account = ? AND evidence_key = ? AND state = 'applied'`).all(account, i.key)) as unknown[] : []),
        ...((await tx.prepare(`SELECT repair_id FROM ${REPAIRS_TABLE} WHERE account = ? AND evidence_key = ? AND state = 'applied'`).all(account, i.key)) as unknown[]),
      ];
      if (receipts.length) throw new BookingRefused("identity", `${i.key}: an applied receipt already names this log; nothing was written`);
      if (tables.has("flows_quarantine") && ((await tx.prepare("SELECT run_id FROM flows_quarantine WHERE LOWER(agent_id) = ? AND LOWER(tx_hash) = ? AND log_index = ?")
        .all(account, r.tx_hash, r.log_index)) as unknown[]).length) {
        throw new BookingRefused("identity", `${i.key}: this log was quarantined before; nothing was written`);
      }
    }
    // ── 1. INSERT ──────────────────────────────────────────────────────────
    for (const i of plan.proposals.inserts) {
      const row = i.row as unknown as Record<string, unknown>;
      const got = (await tx.prepare(`INSERT INTO flows (${FLOW_COLUMNS.join(", ")}) VALUES (${FLOW_COLUMNS.map(() => "?").join(", ")}) ON CONFLICT DO NOTHING RETURNING id`)
        .get(...FLOW_COLUMNS.map((c) => row[c]))) as Record<string, unknown> | undefined;
      const id = Number(got?.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw new BookingRefused("insert", `${i.key}: the flow is already on the books under its identity; nothing was written — preview again`);
      const back = (await tx.prepare(`SELECT ${FLOW_SNAPSHOT_COLUMNS} FROM flows WHERE id = ?`).get(id)) as Record<string, unknown> | undefined;
      if (!back || !sameRow(back, row, FLOW_COLUMNS)) throw new BookingRefused("verify", `${i.key}: the flow read back differs from the proposal; nothing was written`);
      const stored = storedFlow(back);
      actions.push({ action: "insert-flow", table: "flows", evidenceKey: i.key, rowKey: canonical({ id }), row: stored, rowDigest: digestOf(stored) });
    }
    // ── 2. VERIFY, before anything is taken away ───────────────────────────
    const keptRows = now.flows.rows.filter((f) => f.epoch === epoch && RECEIPT_SOURCES.has(f.source));
    const expected: ProposedFlowRow[] = [
      ...keptRows.map((f) => ({ agentId: f.agentId, epoch, direction: f.direction as "in" | "out", amountUsdg: f.amountUsdg, amountRaw: micro(f.amountUsdg).toString(),
        source: f.source as "chain-log" | "energy-buy", txHash: f.txHash!, blockNumber: f.blockNumber ?? -1, logIndex: f.logIndex ?? -1, at: f.at })),
      ...plan.proposals.inserts.map((i) => ({ agentId, epoch, direction: i.row.direction, amountUsdg: i.row.amount_usdg, amountRaw: i.amountRaw, source: "chain-log" as const,
        txHash: i.row.tx_hash, blockNumber: i.row.block_number, logIndex: i.row.log_index, at: i.row.at })),
    ];
    for (const e of expected) {
      const v = await verifyInserted(tx, e.agentId, chainId, [e], true);
      if (!v.ok) throw new BookingRefused("verify", `evidence verification failed — nothing quarantined, nothing written: ${v.why}`);
    }
    const receiptsNow = ((await tx.prepare(`SELECT tx_hash, log_index FROM flows WHERE LOWER(agent_id) = ? AND epoch = ? AND source IN ('chain-log', 'energy-buy')`)
      .all(account, epoch)) as Array<Record<string, unknown>>).map((r) => `${lower(r.tx_hash)}#${Number(r.log_index)}`).sort(byText);
    if (canonical(receiptsNow) !== canonical(plan.predicted.epochReceiptsAfter)) {
      throw new BookingRefused("verify", `epoch ${epoch}'s receipts are not exactly the chain's capital set; nothing quarantined, nothing written`);
    }
    // ── 3. QUARANTINE, never delete (accounting-repair.ts's own statements) ──
    const replacedBy = plan.proposals.inserts.map((i) => `${i.row.tx_hash}#${i.row.log_index}`).join(",") || null;
    for (const q of plan.proposals.quarantines) {
      const pre = (await tx.prepare(`SELECT ${FLOW_SNAPSHOT_COLUMNS} FROM flows WHERE id = ? AND agent_id = ? AND epoch = ?`).get(q.id, q.agentId, epoch)) as Record<string, unknown> | undefined;
      if (!pre) throw new BookingRefused("quarantine", `flows #${q.id} is gone; nothing was written`);
      const moved = await tx.prepare(`INSERT INTO flows_quarantine
           (original_id, agent_id, epoch, direction, amount_usdg, tx_hash, block_number, log_index,
            source, at, run_id, quarantined_at, reason, replaced_by)
         SELECT id, agent_id, epoch, direction, amount_usdg, tx_hash, block_number, log_index,
                source, at, ?, ?, ?, ?
           FROM flows WHERE id = ? AND agent_id = ? AND epoch = ?`).run(repairId, nowSec, q.reason, replacedBy, q.id, q.agentId, epoch);
      if (Number(moved.changes) !== 1) throw new BookingRefused("quarantine", `quarantine row ${q.id} changed during the repair; nothing was written`);
      const removed = await tx.prepare("DELETE FROM flows WHERE id = ? AND agent_id = ? AND epoch = ?").run(q.id, q.agentId, epoch);
      if (Number(removed.changes) !== 1) throw new BookingRefused("quarantine", `quarantine row ${q.id} could not be removed; nothing was written`);
      const row = { ...storedFlow(pre), quarantine: { runId: repairId, quarantinedAt: nowSec, reason: q.reason, replacedBy } };
      actions.push({ action: "quarantine-flow", table: "flows_quarantine", evidenceKey: `flow:${q.id}`, rowKey: canonical({ runId: repairId, originalId: q.id }), row, rowDigest: digestOf(row) });
    }
    // ── 4. CLEAR the stale live basis and its floor, by exact pre-image ─────
    for (const c of plan.proposals.clears) {
      if (c.kind === "clear-live-basis") {
        const b = c.preimage as BasisRow;
        const gone = await tx.prepare(`DELETE FROM cost_basis WHERE agent_id = ? AND mode = 'live' AND symbol = ? AND qty_raw = ? AND cost_usdg = ? AND ${b.updatedAt === null ? "updated_at IS NULL" : "updated_at = ?"}`)
          .run(...[b.agentId, b.symbol, b.qtyRaw, b.costUsdg, ...(b.updatedAt === null ? [] : [b.updatedAt])]);
        if (Number(gone.changes) !== 1) throw new BookingRefused("clear", `the live basis for ${c.symbol} is no longer as previewed; nothing was written`);
        const row = basisPreimage(b);
        actions.push({ action: "clear-live-basis", table: "cost_basis", evidenceKey: `basis:live:${c.symbol}:${digestOf(row).slice(0, 16)}`,
          rowKey: canonical({ agent_id: b.agentId, mode: "live", symbol: b.symbol }), row, rowDigest: digestOf(row) });
      } else {
        const f = c.preimage as FloorRow;
        const gone = await tx.prepare(`DELETE FROM position_floors WHERE agent_id = ? AND mode = 'live' AND symbol = ? AND ${f.stopBps === null ? "stop_bps IS NULL" : "stop_bps = ?"} AND rung = ? AND why = ? AND ${f.at === null ? "at IS NULL" : "at = ?"}`)
          .run(...[f.agentId, f.symbol, ...(f.stopBps === null ? [] : [f.stopBps]), f.rung, f.why, ...(f.at === null ? [] : [f.at])]);
        if (Number(gone.changes) !== 1) throw new BookingRefused("clear", `the live floor for ${c.symbol} is no longer as previewed; nothing was written`);
        const row = floorPreimage(f);
        actions.push({ action: "clear-live-floor", table: "position_floors", evidenceKey: `floor:live:${c.symbol}:${digestOf(row).slice(0, 16)}`,
          rowKey: canonical({ agent_id: f.agentId, mode: "live", symbol: f.symbol }), row, rowDigest: digestOf(row) });
      }
    }
    // ── 5. POSTCONDITIONS: any failure rolls back everything ────────────────
    const after = await readClosedEpochSnapshot(tx, { tenant: plan.tenant, dialect: o.dialect, nowSec, epoch });
    const P_after = after.flows.rows.filter((f) => f.epoch === epoch);
    if (P_after.some((f) => !EVIDENCED.has(f.source) || f.source === "epoch-carry")) throw new BookingRefused("postcondition", `epoch ${epoch} would still hold an unevidenced stand-in; nothing was written`);
    const netAfter = P_after.reduce((s, f) => s + (f.direction === "in" ? micro(f.amountUsdg) : -micro(f.amountUsdg)), 0n);
    if (netAfter.toString() !== plan.predicted.epochNetAfter) throw new BookingRefused("postcondition", `epoch ${epoch}'s net would be ${said(netAfter)}, not the ${usdg6(plan.predicted.epochNetAfter)} the preview predicted; nothing was written`);
    const afterMutable = await readMutableFacts(tx, tables, account);
    const afterPrints = fingerprintsOf(afterMutable, epoch);
    if (afterPrints.flowsOther !== before.flowsOther) throw new BookingRefused("postcondition", `a flows row outside epoch ${epoch} would change; nothing was written`);
    if (canonical(after.agent) !== canonical(now.agent) || digestOf(after.feeAccruals) !== digestOf(now.feeAccruals) || digestOf(after.riskPeriods) !== digestOf(now.riskPeriods)) {
      throw new BookingRefused("postcondition", "a peak, a fee accrual or a risk period would move; nothing was written");
    }
    for (const run of [epoch, undefined]) {
      if (!(await flowDuplicateReport(tx, account, run)).clean) throw new BookingRefused("postcondition", `the flows of ${run === undefined ? "the current run" : `epoch ${run}`} would hold duplicate or conflicting copies; nothing was written`);
    }
    const upper = plan.boundary.upperSec;
    // What the preview's check named, now answered by rows. An operation an owner record answered is not among it: the record is the
    // compare-and-set's (booking.known.ownerOps, booking.ownerRecords), compared before any write, and nothing here writes owner_operations.
    const known = { ops: new Set(after.booking.known.ops), txs: new Set(after.booking.known.txs), flows: new Set(after.booking.known.flows) };
    const left = factsStillMissing(plan.admission.found.map((d) => d.fact), known);
    const early = plan.admission.found.filter((d) => left.includes(d.fact) && (upper === null || d.at === null || d.at < upper));
    if (early.length) throw new BookingRefused("postcondition", `admission would still find ${early.length} fact(s) from before epoch ${epoch} closed; nothing was written`);
    const flat = new Set(plan.holdings.verdicts.filter((v) => v.verdict === "clear").map((v) => v.symbol));
    if (after.seedBefore.basis.some((b) => flat.has(b.symbol)) || after.seedBefore.floors.some((f) => flat.has(f.symbol))) {
      throw new BookingRefused("postcondition", "admission would still seed a basis or floor for a token the chain shows flat; nothing was written");
    }
    if (after.booking.spellings.length > 1) throw new BookingRefused("postcondition", "agent_id would be spelled more than one way; nothing was written");
    // ── 6. RECEIPTS ────────────────────────────────────────────────────────
    const appliedAtMs = o.nowMs;
    const admission = now.booking.admission;
    const fingerprints = { before, after: afterPrints };
    for (const a of actions) {
      await tx.prepare(`INSERT INTO ${REPAIRS_TABLE} (repair_id, tenant, account, epoch, chain_id, action, evidence_key, table_name, row_key, row_json, row_digest, preview_digest,
          backup_ref, admission_json, fingerprints_json, state, applied_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?)`)
        .run(repairId, plan.tenant, account, epoch, chainId, a.action, a.evidenceKey, a.table, a.rowKey, canonical(a.row), a.rowDigest, plan.previewDigest, o.backupRef,
          canonical(admission), canonical(fingerprints), appliedAtMs);
    }
    const body = { format: CLOSED_EPOCH_APPLY_FORMAT, repairId, tenant: plan.tenant, account, chainId, epoch, previewDigest: plan.previewDigest, backupRef: o.backupRef,
      appliedAtMs, admission, fingerprints, actions };
    const report: RepairApplyReport = { ...body, format: CLOSED_EPOCH_APPLY_FORMAT, reportDigest: digestOf(body) };
    // THE REPORT BEFORE THE COMMIT: a commit is never without it.
    await o.persist?.(report);
    return report;
  });
}

// ── revert ───────────────────────────────────────────────────────────────────

/** An apply report, checked whole: its digest and every action's. A report that does not verify reverts nothing. */
export function parseRepairReport(text: string): RepairApplyReport {
  let r: RepairApplyReport;
  try { r = JSON.parse(text) as RepairApplyReport; } catch { throw new BookingRefused("report", "the apply report is not JSON"); }
  const { reportDigest, ...body } = r ?? ({} as RepairApplyReport);
  if (r?.format !== CLOSED_EPOCH_APPLY_FORMAT || !DIGEST.test(String(reportDigest)) || digestOf(body) !== reportDigest) {
    throw new BookingRefused("report", "the apply report does not verify against its own digest");
  }
  if (!REPAIR_ID.test(String(r.repairId)) || !ADDRESS.test(r.tenant) || !ADDRESS.test(r.account) || !Array.isArray(r.actions) || !r.actions.length
    || r.actions.some((a) => digestOf(a.row) !== a.rowDigest) || !Number.isSafeInteger(r.appliedAtMs)) {
    throw new BookingRefused("report", "the apply report's actions do not verify");
  }
  return r;
}

export interface RepairReceipt { repairId: string; tenant: string; account: string; epoch: number; chainId: number; action: RepairAction; evidenceKey: string; table: string;
  rowKey: string; row: Record<string, unknown>; rowDigest: string; previewDigest: string; backupRef: string; admissionJson: string; fingerprintsJson: string; state: string;
  appliedAtMs: number; revertedAtMs: number | null }

/** One repair's receipts, in evidence-key order, each verified against its own digest. Read only. */
export async function readRepairReceipts(db: Db, dialect: Dialect, repairId: string): Promise<RepairReceipt[]> {
  if (!REPAIR_ID.test(repairId)) throw new BookingRefused("repair-id", "the repair id is not a UUID");
  const tables = await existingTables(db, dialect);
  if (!tables.has(REPAIRS_TABLE)) return [];
  const rows = ((await db.prepare(`SELECT ${REPAIR_COLUMNS.join(", ")} FROM ${REPAIRS_TABLE} WHERE repair_id = ?`).all(repairId)) as Array<Record<string, unknown>>)
    .sort((a, b) => byText(String(a.evidence_key), String(b.evidence_key)));
  return rows.map((r) => {
    let row: Record<string, unknown>;
    try { row = JSON.parse(String(r.row_json)) as Record<string, unknown>; } catch { throw new BookingRefused("receipts", "a receipt's row is not JSON"); }
    if (digestOf(row) !== String(r.row_digest)) throw new BookingRefused("receipts", `receipt ${String(r.evidence_key)} does not verify against its own digest`);
    return { repairId: String(r.repair_id), tenant: String(r.tenant), account: String(r.account), epoch: num(r.epoch), chainId: num(r.chain_id), action: String(r.action) as RepairAction,
      evidenceKey: String(r.evidence_key), table: String(r.table_name), rowKey: String(r.row_key), row, rowDigest: String(r.row_digest), previewDigest: String(r.preview_digest),
      backupRef: String(r.backup_ref), admissionJson: String(r.admission_json), fingerprintsJson: String(r.fingerprints_json), state: String(r.state),
      appliedAtMs: num(r.applied_at_ms), revertedAtMs: intOrNull(r.reverted_at_ms) };
  });
}

export interface RepairRevertReport {
  format: typeof CLOSED_EPOCH_REVERT_FORMAT; repairId: string; tenant: string; account: string; revertedAtMs: number;
  outcome: "reverted" | "already-reverted"; actions: Array<{ action: string; evidenceKey: string }>; reportDigest: string;
}

/**
 * TAKE ONE REPAIR BACK, EXACTLY, AS ONE TRANSACTION, ONLY IF NOTHING STOOD ON IT.
 *
 * The receipts are the authority (a lost or never-written apply report is
 * no obstacle: --revert-repair <id>); an apply report, when given, must match
 * them field for field. Refuses unless every receipt is 'applied', nothing
 * stood on the rows since (chain-gap-booking.ts admittedSince: an attested
 * book, a new attestation or approval, a heartbeat, a mirrored row), and the
 * account's flows, quarantine history, live basis and floors are exactly as
 * the apply left them — checked BEFORE anything is written, so a change is
 * named, never discovered by a failed postcondition. Then, in reverse: the
 * basis and floors come back from their pre-images, each quarantined flow
 * comes back under its ORIGINAL id with every column (chain_id included) and
 * its quarantine row stays as history (flows_quarantine is append-only:
 * accounting-repair.ts, and the restore drill reads it so), and the filed
 * rows go if still exactly as written. The flows and basis come back to the
 * apply's `before`, byte for byte, or nothing changes.
 */
export async function revertClosedEpoch(db: Db, o: { repairId: string; report?: RepairApplyReport; nowMs: number; dialect: Dialect }): Promise<RepairRevertReport> {
  return db.tx(async (tx) => {
    const receipts = await readRepairReceipts(tx, o.dialect, o.repairId);
    if (!receipts.length) throw new BookingRefused("receipts", "no receipts exist for this repair: nothing was applied under it");
    const first = receipts[0]!;
    const same = receipts.every((r) => r.tenant === first.tenant && r.account === first.account && r.epoch === first.epoch && r.chainId === first.chainId
      && r.previewDigest === first.previewDigest && r.admissionJson === first.admissionJson && r.fingerprintsJson === first.fingerprintsJson && r.appliedAtMs === first.appliedAtMs);
    if (!same) throw new BookingRefused("receipts", "the repair's receipts disagree with each other");
    if (o.report) {
      const want = [...o.report.actions].sort((a, b) => byText(a.evidenceKey, b.evidenceKey));
      const matches = o.report.repairId === o.repairId && want.length === receipts.length && receipts.every((r, i) => r.evidenceKey === want[i]!.evidenceKey
        && r.action === want[i]!.action && r.table === want[i]!.table && r.rowDigest === want[i]!.rowDigest && r.rowKey === want[i]!.rowKey)
        && first.tenant === o.report.tenant && first.account === o.report.account && first.previewDigest === o.report.previewDigest
        && first.appliedAtMs === o.report.appliedAtMs && first.admissionJson === canonical(o.report.admission) && first.fingerprintsJson === canonical(o.report.fingerprints);
      if (!matches) throw new BookingRefused("receipts", "the repair's receipts in the database do not match the report");
    }
    const result = (outcome: RepairRevertReport["outcome"]): RepairRevertReport => {
      const body = { format: CLOSED_EPOCH_REVERT_FORMAT, repairId: o.repairId, tenant: first.tenant, account: first.account, revertedAtMs: o.nowMs, outcome,
        actions: receipts.map((r) => ({ action: r.action, evidenceKey: r.evidenceKey })) };
      return { ...body, format: CLOSED_EPOCH_REVERT_FORMAT, reportDigest: digestOf(body) };
    };
    if (receipts.every((r) => r.state === "reverted")) return result("already-reverted");
    if (!receipts.every((r) => r.state === "applied")) throw new BookingRefused("receipts", "the repair is partly reverted; nothing changed");
    const tables = await existingTables(tx, o.dialect);
    for (const needed of ["agents", "mirror_state", "flows_quarantine"]) if (!tables.has(needed)) throw new BookingRefused("schema", `the ${needed} table is not in this database; nothing changed`);
    const lockAgent = await tx.prepare("UPDATE agents SET epoch = epoch WHERE LOWER(smart_account) = ?").run(first.account);
    if (Number(lockAgent.changes) < 1) throw new BookingRefused("cas", "the account's registration is gone; nothing changed");
    const admission = JSON.parse(first.admissionJson) as AdmissionState;
    const now = await readAdmissionState(tx, tables, first.tenant, first.account);
    const inUse = tables.has("tenant_ledger_import") && tables.has("ledger_resume_attestations") ? await attestedSourceInUse(tx, first.tenant, first.account) : null;
    const stood = admittedSince(admission, { ...now, inUse });
    if (stood) throw new BookingRefused(stood.code, `${stood.why}; nothing changed`);
    const prints = JSON.parse(first.fingerprintsJson) as { before: Fingerprints; after: Fingerprints };
    const current = fingerprintsOf(await readMutableFacts(tx, tables, first.account), first.epoch);
    for (const k of ["flowsAll", "quarantine", "liveBasis", "liveFloors"] as const) {
      if (current[k] !== prints.after[k]) throw new BookingRefused("moved", `the account's ${k} changed since the apply: something wrote them after this repair, so it is no longer only this repair's to take back; nothing changed`);
    }
    const order: Record<RepairAction, number> = { "clear-live-floor": 0, "clear-live-basis": 1, "quarantine-flow": 2, "insert-flow": 3 };
    for (const r of [...receipts].sort((a, b) => order[a.action] - order[b.action] || byText(a.evidenceKey, b.evidenceKey))) {
      if (r.action === "clear-live-basis") {
        const b = r.row as ReturnType<typeof basisPreimage>;
        if ((await tx.prepare("SELECT symbol FROM cost_basis WHERE agent_id = ? AND mode = ? AND symbol = ?").get(b.agent_id, b.mode, b.symbol))) {
          throw new BookingRefused("cas", `${r.evidenceKey}: a basis row is back at its key; nothing changed`);
        }
        await tx.prepare("INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(b.agent_id, b.mode, b.symbol, b.qty_raw, b.cost_usdg, b.updated_at);
        const back = (await tx.prepare("SELECT agent_id, mode, symbol, qty_raw, cost_usdg, updated_at FROM cost_basis WHERE agent_id = ? AND mode = ? AND symbol = ?").get(b.agent_id, b.mode, b.symbol)) as Record<string, unknown> | undefined;
        if (!back || !sameRow(back, b, Object.keys(b))) throw new BookingRefused("verify", `${r.evidenceKey}: the basis read back differs; nothing changed`);
      } else if (r.action === "clear-live-floor") {
        const f = r.row as ReturnType<typeof floorPreimage>;
        if ((await tx.prepare("SELECT symbol FROM position_floors WHERE agent_id = ? AND mode = ? AND symbol = ?").get(f.agent_id, f.mode, f.symbol))) {
          throw new BookingRefused("cas", `${r.evidenceKey}: a floor row is back at its key; nothing changed`);
        }
        await tx.prepare("INSERT INTO position_floors (agent_id, mode, symbol, stop_bps, rung, why, at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(f.agent_id, f.mode, f.symbol, f.stop_bps, f.rung, f.why, f.at);
        const back = (await tx.prepare("SELECT agent_id, mode, symbol, stop_bps, rung, why, at FROM position_floors WHERE agent_id = ? AND mode = ? AND symbol = ?").get(f.agent_id, f.mode, f.symbol)) as Record<string, unknown> | undefined;
        if (!back || !sameRow(back, f, Object.keys(f))) throw new BookingRefused("verify", `${r.evidenceKey}: the floor read back differs; nothing changed`);
      } else if (r.action === "quarantine-flow") {
        const row = r.row as Record<string, unknown> & { quarantine?: { runId?: unknown } };
        const id = Number(row.id);
        if ((await tx.prepare("SELECT id FROM flows WHERE id = ?").get(id))) throw new BookingRefused("cas", `${r.evidenceKey}: a flows row already holds id ${id}; nothing changed`);
        const q = (await tx.prepare(`SELECT original_id, agent_id, epoch, direction, amount_usdg, tx_hash, block_number, log_index, source, at FROM flows_quarantine
            WHERE run_id = ? AND original_id = ?`).get(o.repairId, id)) as Record<string, unknown> | undefined;
        if (!q || !sameRow(q, row, ["agent_id", "epoch", "direction", "amount_usdg", "tx_hash", "block_number", "log_index", "source", "at"])) {
          throw new BookingRefused("cas", `${r.evidenceKey}: its quarantine row is not as the repair wrote it; nothing changed`);
        }
        await tx.prepare(`INSERT INTO flows (${FLOW_SNAPSHOT_COLUMNS}) VALUES (${FLOW_ROW_COLUMNS.map(() => "?").join(", ")})`).run(...FLOW_ROW_COLUMNS.map((c) => row[c] ?? null));
        const back = (await tx.prepare(`SELECT ${FLOW_SNAPSHOT_COLUMNS} FROM flows WHERE id = ?`).get(id)) as Record<string, unknown> | undefined;
        if (!back || !sameRow(back, row, FLOW_ROW_COLUMNS)) throw new BookingRefused("verify", `${r.evidenceKey}: the restored flow read back differs; nothing changed`);
      } else {
        const id = Number(r.row.id);
        const current = (await tx.prepare(`SELECT ${FLOW_SNAPSHOT_COLUMNS} FROM flows WHERE id = ?`).get(id)) as Record<string, unknown> | undefined;
        if (!current || !sameRow(current, r.row, FLOW_ROW_COLUMNS)) throw new BookingRefused("cas", `${r.evidenceKey}: the filed row is no longer exactly as written; nothing changed`);
        const gone = await tx.prepare("DELETE FROM flows WHERE id = ?").run(id);
        if (Number(gone.changes) !== 1) throw new BookingRefused("cas", `${r.evidenceKey}: the filed row could not be removed; nothing changed`);
      }
    }
    const restored = fingerprintsOf(await readMutableFacts(tx, tables, first.account), first.epoch);
    if (restored.flowsAll !== prints.before.flowsAll || restored.liveBasis !== prints.before.liveBasis || restored.liveFloors !== prints.before.liveFloors
      || restored.quarantine !== prints.after.quarantine) {
      throw new BookingRefused("postcondition", "the account's flows, basis or floors would not come back exactly as before the apply; nothing changed");
    }
    for (const r of receipts) {
      const marked = await tx.prepare(`UPDATE ${REPAIRS_TABLE} SET state = 'reverted', reverted_at_ms = ? WHERE repair_id = ? AND evidence_key = ? AND state = 'applied'`)
        .run(o.nowMs, o.repairId, r.evidenceKey);
      if (Number(marked.changes) !== 1) throw new BookingRefused("receipts", `${r.evidenceKey}: its receipt moved under the revert; nothing changed`);
    }
    return result("reverted");
  });
}
