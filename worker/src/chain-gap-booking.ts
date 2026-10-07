/**
 * BOOKING WHAT THE CHAIN HAS AND POSTGRES LACKS — ONE TENANT, PREVIEW FIRST.
 *
 * THE SITUATION. Attested-gap admission (ledger-resume.ts, "B7") reads the
 * chain for every live tenant before it registers a new book, and refuses a
 * tenant whose account sent an operation, or moved USDG, that Postgres holds
 * no row for: the new book would never learn of it — an operation the rolling
 * caps would not count, a deposit a later mark would read as profit. Three
 * tenants are held on exactly that, and until now no code path in this tree
 * booked the missing movement (docs/fleet-resume.md said so, and escalated).
 * This is that booking, reviewed, for one tenant at a time.
 *
 * ONLY FOR A TENANT THAT IS HELD, PROVED FROM POSTGRES (holdOf). Nothing in
 * Postgres says which tenants a deploy's MERRYMEN_FLEET_ROLLOUT runs, and a
 * tenant still running on its own book can have an operation on chain that
 * its mirror has not copied yet — a wedged mirror under a live worker widens
 * that from seconds to hours. Booking it then would be worse than late: the
 * mirror skips a child trade whose user_op_hash Postgres already holds
 * (ledger-mirror.ts), so the child's evidenced row (its decision, realised
 * P&L, gas in USDG, fees) would never reach the shared tape, and the booked
 * row with its NULLs would stand in for it for good. So the tool books only a
 * tenant whose newest admission decision is a CHAIN REFUSAL — admission
 * drained the old book's tail into Postgres, read the chain, and found these
 * facts missing from both — and only facts that landed BEFORE that refusal.
 * Nothing may have written for the tenant since (its heartbeat and its mirror
 * cursors are no newer than the refusal, and both have been quiet for
 * BOOKING_QUIET_SEC). Anything newer waits for admission to refuse the tenant
 * on it, so no booking ever races a worker for a row.
 *
 * WHAT IT PROPOSES IS WHAT THE EXISTING WRITERS WRITE, and nothing they do not —
 * with one difference, said here rather than hidden:
 *
 *   a session-key trade leg   the in-flight reconciler's row for a landed op
 *                             the book lost (index.ts reconcileInFlightAtArm:
 *                             kind 'swap', target the account, notional the
 *                             USDG leg, status 'landed', basis_source
 *                             'receipt', the legs pickAcquiredLeg names) with
 *                             the fill the live path reads off the same
 *                             receipt over the same book (fills.ts
 *                             netTokenDeltas over custody.ts bookAddresses):
 *                             side, quantity and cash exactly as the Transfer
 *                             logs moved them, and the gas the EntryPoint's
 *                             own event recorded (key-install-accounting.ts
 *                             gasFields' split by payer).
 *                             THE DIFFERENCE: beside that row the reconciler
 *                             also books the fill's cost basis (bookFill),
 *                             because a held position with no basis is one
 *                             both mechanical exits refuse. This tool does
 *                             not write cost_basis or positions — the
 *                             attested book is seeded from them as the lost
 *                             book last mirrored them (planAttestedSeed) —
 *                             so it books a trade only when that snapshot's
 *                             CONTENTS already say what the trade did. Either
 *                             none of the token is in the snapshot, its basis
 *                             or on chain at a block 64 deep (or a basis left
 *                             over it provably cannot reach the new book,
 *                             staleBasisVerdict, and is named); or the
 *                             position's raw balance and its basis quantity
 *                             each equal what the book (the account and its
 *                             custody, as the fill is read) holds there, the
 *                             fills Postgres records since the basis last
 *                             opened and these reproduce that quantity from
 *                             flat, and the basis's cost is exactly what
 *                             those fills give, replayed — a buy and a sell
 *                             that net to nothing are what a quantity cannot
 *                             tell from neither, so a cost that cannot be
 *                             replayed refuses too. When the
 *                             rows were written is checked too, and is never
 *                             enough alone. Otherwise the trade, and so the
 *                             tenant, is unresolved: a reviewed basis
 *                             decision, never a guess (holdingVerdict).
 *   a session-key operation   the reconciler's row for an op with no USDG leg
 *     that moved nothing      (notional 0, no tokens): its hash is known, so
 *                             the op is counted, and nothing is attributed.
 *   a reverted session-key    the row a resolved revert gets: status
 *     operation               'reverted', its gas, notional 0 (the intent's is
 *                             gone with the book), counted toward no cap.
 *   an owner's USDG deposit   the chain-capital reconstruction's row
 *                             (accounting-repair.ts): source 'chain-log', the
 *                             tx#log identity flows_chain_identity keys on,
 *                             the verified block time — decided by the same
 *                             classifier (classifyUsdgMovement) over the
 *                             whole receipt.
 *
 * WHAT IT NEVER DOES: invent a figure it cannot prove. No realised P&L (it
 * needs the cost basis at that moment, which the chain does not hold — NULL is
 * what the live path writes for an unbacked sell), no gas priced in USDG (no
 * historical ETH price is proved here — NULL is "unpriced", as in the worker),
 * no decision, no peak moved, no cost basis or position touched (those are
 * snapshot tables the lost book's last mirror already wrote, and an attested
 * book is seeded from them — which is why a trade whose token the snapshot
 * does not already hold exactly as the chain does is refused, above), no risk
 * period. A fill's price is the ratio of the two amounts the logs moved,
 * scaled by the token's own decimals(); when that cannot be read the price is
 * NULL and the rest of the row stands.
 *
 * AND IT REFUSES WHAT IT CANNOT CLASSIFY. Every operation and transfer the
 * admission's own chain check finds (chainGapCheck, called here exactly as
 * admission calls it, from the same second — resumeGapWindow, which for a
 * tenant held on a chain refusal never starts later than that refused read
 * began, so what it named stays in the window however late this runs) gets one of the
 * classes above or is UNRESOLVED, and one unresolved fact blocks the whole
 * tenant: an owner's own (root-key) operation, which the agent's book has no
 * writer for and booking as the agent's would misattribute; a session key
 * moving USDG with nothing the other way (a transfer home or an energy
 * purchase books a flow beside its row, which is two writers' work, not this
 * one's); several tokens; USDG leaving with no operation of the account; an
 * operation's leg outside its own execution; anything not 64 blocks deep;
 * anything before the current accounting epoch opened, or in an epoch with no
 * row yet to date its opening by; anything after admission's refusal.
 *
 * PREVIEW, THEN APPLY, BOUND BY ONE DIGEST. The preview reads Postgres in one
 * read-only snapshot, then the chain, and states every fact, its class, its
 * evidence and the exact row it would write, with a previewDigest over all of
 * it — the code that produced it, the database it read, the Postgres facts it
 * depends on (counts, maxima, every hash and flow identity Postgres holds for
 * the account) and the proposals. Apply recomputes the whole preview, requires
 * the same digest the owner reviewed (--confirm) and a named backup
 * (--backup-ref), then in ONE transaction: locks the agent row, compares every
 * Postgres fact again (compare-and-set on the evidence: anything that moved
 * refuses), inserts exactly the proposed rows, reads them back, proves the
 * flows still distinct and the admission's chain check now answered, and
 * records a receipt per row. Idempotent by (account, epoch, userOpHash or
 * tx#log): a receipt is unique per key while applied, and a second apply finds
 * nothing missing. Revert takes the apply report, proves each row is still
 * exactly as written and the tenant was not admitted on them, and removes
 * them, keeping the receipt (state 'reverted', the row in full). "Not
 * admitted" is decided by what the database recorded, never by comparing two
 * machines' clocks: each receipt keeps the tenant's approvals, attestations,
 * heartbeat and mirror cursor as they stood at the apply, and a revert refuses
 * when any of them moved since — or when an attested book is in use at all.
 *
 * Reviewed operator tool: never imported by the orchestrator or a worker.
 * docs/chain-gap-booking.md is the runbook.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./db";
import { CASH, ENTRYPOINT, classifyUsdgMovement, energyReserveTokens, grantPonsClassVault, isEnergyReserveToken } from "../../packages/core/src/index";
import { segmentReceipt, validatorOfNonce, type OpSegment } from "./asset-movements";
import { applyFill, ZERO_BASIS, type BasisRow } from "./basis";
import { legsFromReceipt, TRANSFER_TOPIC, type RawChainLog, type RpcCall } from "./chain-capital";
import { custodyAddressesOf } from "./custody";
import { flowDuplicateReport } from "./distinct-flows";
import { netTokenDeltas } from "./fills";
import { pickAcquiredLeg } from "./inflight-reconcile";
import { ownerOperationOf } from "./owner-operations";
import {
  attestedSourceInUse, CHAIN_REFUSAL, chainGapCheck, describeChainFact, knownChainFacts, lastMirrorPassAt, planAttestedSeed, readChainHold, readOpenApproval,
  resumeGapWindow, RESUME_USDG, usdg6, type GapChain, type MissingChainFact,
} from "./ledger-resume";
import { admitCapitalFlow, tradingModeOf } from "./paper-boundary";
import { classifyRpcError } from "./rpc-error";
import { fillSymbolFor } from "./token-label";

export const BOOKING_FORMAT = "merrymen.chain-gap-booking.v1";
export const APPLY_FORMAT = "merrymen.chain-gap-booking.apply.v1";
export const REVERT_FORMAT = "merrymen.chain-gap-booking.revert.v1";
/** Only facts this deep are booked: a reorg could still take back a shallower one, and the row with it. The receipt gas preview's depth. */
export const BOOKING_CONFIRMATIONS = 64n;
/** The receipts table: one row per booked row, kept (as 'reverted') after a revert. */
export const BOOKINGS_TABLE = "chain_gap_bookings";
/** How the reconciler and the key-install resolver name a revert whose message is gone. */
const REVERTED_RULE = "reverted on-chain (resolved)";
/** `decimals()`: one of the two calls this tool makes, and its transport admits — at "latest" only. */
export const DECIMALS_SELECTOR = "0x313ce567";
/**
 * `balanceOf(address)`: the other — how much of a traded token the book held
 * at the pinned block (holdingVerdict), and at a block number only: a balance
 * read at "latest" could include what landed after the facts it is compared
 * with.
 */
export const BALANCE_OF_SELECTOR = "0x70a08231";
/** A balanceOf call's whole data: the selector and one address, zero-padded to a word. Nothing else is admitted. */
export const BALANCE_OF_CALL = /^0x70a08231[0]{24}[0-9a-f]{40}$/;
/** A block number as a JSON-RPC quantity: what a balanceOf is pinned to. Never a tag. */
export const BLOCK_QUANTITY = /^0x(0|[1-9a-f][0-9a-f]{0,15})$/;
/**
 * HOW LONG THE TENANT'S BOOK MUST HAVE BEEN SILENT before it is booked: no
 * heartbeat and no mirrored row for ten minutes. A running worker beats every
 * tick and its mirror runs every few seconds, so this is many times either;
 * it is a floor under the stronger rule (nothing written since admission's
 * refusal), not a substitute for it.
 */
export const BOOKING_QUIET_SEC = 600;
/**
 * A fact must have landed at least this long before admission's chain
 * refusal to be booked on it: block times are the chain's clock and the
 * refusal's is the orchestrator's, and a minute is far more than they differ
 * and far less than a respawned worker takes to send anything.
 */
export const ANCHOR_MARGIN_SEC = 60;
/** Approval states that are still open (ledger-import-schema.ts): an approval in one is being acted on. */
const OPEN_APPROVAL_STATES: ReadonlySet<string> = new Set(["approved", "archiving", "archived", "registered"]);

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const lower = (s: unknown) => String(s ?? "").toLowerCase();
const USDG = lower(CASH.USDG);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Sorted keys at every level, bigints as decimal strings, undefined dropped: the bytes every digest here is over. */
export function canonical(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, norm((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(norm(value));
}
export const digestOf = (value: unknown): string => sha256(canonical(value));

/** A refusal this tool means: a fixed sentence an operator acts on. Nothing in it is private. */
export class BookingRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BookingRefused";
  }
}


// ── the Postgres half ────────────────────────────────────────────────────────

export type Dialect = "postgres" | "sqlite";

/**
 * WHAT POSTGRES SAYS, IN ONE READ, FOR ONE TENANT. Everything the plan needs,
 * and everything apply compares again inside its transaction.
 *
 * The grant is read field by field — the account, owner, chain and the vault
 * addresses custody.ts derives a book from — and never whole: grant_json also
 * holds the serialized permission, and the sealed session key is a column
 * this never selects.
 */
export interface BookingSnapshot {
  tenant: string;
  /**
   * `classVault` is the one custody address whose holdings positions and
   * cost_basis do not cover (core grant.ts grantPonsClassVault): the class
   * book is class_positions. The Trencher vault's are merged into the position.
   *
   * `spelled` is the account exactly as the grant spells it now: the agent_id
   * the attested book's worker would register under (store.ts ensureAgent
   * returns grant.smartAccount, and the grant store hands the child grant_json
   * as it is). Its mirror deletes the tenant's snapshot rows by it in any
   * letter-case (ledger-mirror.ts: `lower(agent_id) = lower(?)`); a mirror
   * built before that matched it exactly (staleBasisVerdict says why both
   * matter).
   */
  grant: { account: string; spelled: string; owner: string | null; chainId: number | null; custody: string[]; classVault: string | null } | null;
  /** Every registration row for the account (more than one is a refusal). */
  agents: Array<{ smartAccount: string; epoch: number; chainId: number | null; mode: string | null; hwmUsdg: number; hwmWithdrawnUsdg: number }>;
  /** Every spelling of agent_id across the financial tables. Admission refuses more than one; so does this. */
  spellings: string[];
  /** The earliest row of the current epoch across trades, flows and equity. A fact before it may be another epoch's. */
  epochOpenedAt: number | null;
  /** Every hosted account, lowercased: a transfer from one is internal, never a deposit. */
  knownAccounts: string[];
  /**
   * What a chain log could be in Postgres for this account (knownChainFacts), sorted. `ownerOps`: the
   * acknowledged root records admission may answer an operation by ("hash|tx"), each only once the
   * chain re-derives it (ledger-resume.ts ownerAnswersFor) — bound here so the digest and the
   * compare-and-set see one change.
   */
  known: { ops: string[]; txs: string[]; flows: string[]; ownerOps: string[] };
  /**
   * Every owner record of the account, whatever its disposition, by hash: shown beside an
   * owner-operation fact as evidence (the tool still never books one), and compared at apply.
   */
  ownerRecords: Array<{ userOpHash: string; txHash: string; chainId: number; disposition: string; reviewReason: string | null; tenant: string | null }>;
  /** Where admission's chain read starts (resumeGapWindow): for a tenant held on a chain refusal, no later than that refused read began. */
  gapFromSec: number;
  /** The account's trades and flows by count and maximum id: the evidence apply compares and sets on. */
  ledger: { trades: { n: number; maxId: number }; flows: { n: number; maxId: number } };
  openApproval: { state: string; evidence: string } | null;
  /** The attested generation the tenant already runs, when it was admitted. */
  admitted: string | null;
  /** Bookings already applied for this account and not reverted. */
  booked: Array<{ bookingId: string; evidenceKey: string; tableName: string; rowId: number }>;
  /**
   * WHERE THE TENANT STANDS WITH ADMISSION: every approval, every attestation,
   * and when its book was last written. What the hold is proved from (holdOf),
   * and what a revert compares against (admittedSince).
   */
  admission: AdmissionState;
  /** What the attested book would be seeded from (planAttestedSeed): the account's positions, and its live cost basis. */
  holdings: Holdings;
  /**
   * Every trade row of the account that names a token or a fill symbol and
   * may have moved one ('landed', or 'submitted' with its outcome unknown),
   * by id: the recorded fills a traded token's holding is walked back through
   * (holdingVerdict).
   */
  fills: RecordedFill[];
}

/** One approval of the tenant, reduced to what the hold and a revert decide on. Never its evidence or its reason's text. */
export interface ApprovalFact {
  approvalId: string; state: string; createdAtMs: number; updatedAtMs: number;
  /** Refused, with a reason that starts as admission's chain refusal does (ledger-resume.ts CHAIN_REFUSAL). */
  chainRefusal: boolean;
  /** Set when the approval reached 'archiving': a generation was minted for it. */
  generation: string | null;
  /** Set when the approval reached 'archived': the home was moved aside for it. */
  archived: boolean;
}
export interface AdmissionState {
  /** Newest first: by updated_at_ms, then created_at_ms, then id. */
  approvals: ApprovalFact[];
  /** Every attested generation recorded for the tenant, sorted. */
  attestations: string[];
  /**
   * When the tenant's book was last written, as far as Postgres can see, in
   * unix seconds: the worker's heartbeat (agents.beat_at, carried by the
   * mirror) and the newest mirror cursor (mirror_state.updated_at, which moves
   * only when rows arrive).
   */
  liveness: { beatAt: number | null; lastMirrorAt: number | null };
}
export interface Holdings {
  positions: Array<{ symbol: string; token: string; rawBalance: string; updatedAt: number | null }>;
  /** `agentId` is the row's own spelling of the account: what decides whether the attested book's first mirror pass deletes it. */
  basis: Array<{ agentId: string; symbol: string; qtyRaw: string; costUsdg: string; updatedAt: number | null }>;
  /**
   * THE LIVE BASIS ADMISSION WOULD SEED THE NEW BOOK WITH, computed by
   * admission's own code on this same read (ledger-resume.ts planAttestedSeed:
   * a live row with a quantity, for a symbol positions shows held, raw_balance
   * <> '0'), never re-derived here. Null when a table it reads is not in the
   * database, so it could not be asked.
   */
  seeded: Array<{ symbol: string; qtyRaw: string; costUsdg: string }> | null;
}
/**
 * One trade row as the fill walk reads it: its legs and its fill, as Postgres
 * holds them. Tokens lowercased. `cashUsdg` is fill_cash_usdg in micro-USDG,
 * exactly as bookFill applied it to the basis, or null (microUsdg).
 */
export interface RecordedFill {
  id: number; status: string; buyToken: string | null; sellToken: string | null;
  side: string | null; qtyRaw: string | null; symbol: string | null; basisSource: string | null; at: number | null; cashUsdg: string | null;
}

const GRANT_SQL: Record<Dialect, string> = {
  postgres: `SELECT grant_json->>'smartAccount' AS smart_account, grant_json->>'owner' AS owner, grant_json->>'chainId' AS chain_id,
      grant_json->'grantFeatures' AS grant_features, grant_json->>'ponsClassVaultAddress' AS pons_class_vault_address,
      grant_json->>'trencherVaultAddress' AS trencher_vault_address, grant_json->>'trencherFactoryAddress' AS trencher_factory_address
    FROM grants WHERE LOWER(tenant) = ?`,
  sqlite: `SELECT json_extract(grant_json, '$.smartAccount') AS smart_account, json_extract(grant_json, '$.owner') AS owner,
      json_extract(grant_json, '$.chainId') AS chain_id, json_extract(grant_json, '$.grantFeatures') AS grant_features,
      json_extract(grant_json, '$.ponsClassVaultAddress') AS pons_class_vault_address,
      json_extract(grant_json, '$.trencherVaultAddress') AS trencher_vault_address,
      json_extract(grant_json, '$.trencherFactoryAddress') AS trencher_factory_address
    FROM grants WHERE LOWER(tenant) = ?`,
};
/** The tables admission reads agent_id spellings across (ledger-resume.ts resumePreconditions). */
const SPELLING_TABLES = ["trades", "flows", "equity", "fee_accruals", "positions", "cost_basis", "position_floors", "class_positions", "paper_checkpoints", "risk_periods",
  "owner_operations"];
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
/** Code-unit order: the same on every machine and in every locale, so a digest over a sorted list is too. */
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/**
 * A stamp in unix seconds, whichever unit it was written in: seconds where
 * this system writes it, but rows carried in from elsewhere have held
 * milliseconds (autonomy-funnel.ts beatSec, ledger-resume.ts's own stamp).
 * Normalised per value, never by a guess across rows.
 */
const unixSec = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
};
const iso = (sec: number | null): string => (sec === null ? "never" : new Date(sec * 1000).toISOString());

/**
 * WHICH TABLES EXIST, asked of the catalogue rather than learned from a
 * failed statement. Inside a Postgres transaction a failed statement aborts
 * the whole transaction (25P02: every later read refuses), so the readers'
 * usual "a missing table is none" catch cannot be used in the snapshot or the
 * apply, which are each one transaction. Found by a real Postgres, not sqlite.
 */
async function existingTables(db: Db, dialect: Dialect): Promise<Set<string>> {
  const rows = (await db.prepare(dialect === "postgres"
    ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()"
    : "SELECT name FROM sqlite_master WHERE type = 'table'").all()) as Array<Record<string, unknown>>;
  return new Set(rows.map((r) => String(r.name)));
}

/** A table's columns, asked of the catalogue for the same reason (existingTables). Only for a table it says exists. */
async function existingColumns(db: Db, dialect: Dialect, table: string): Promise<Set<string>> {
  const rows = (await db.prepare(dialect === "postgres"
    ? "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?"
    : "SELECT name FROM pragma_table_info(?)").all(table)) as Array<Record<string, unknown>>;
  return new Set(rows.map((r) => String(r.name)));
}

/**
 * WHERE THE TENANT STANDS WITH ADMISSION, read in the caller's transaction:
 * the snapshot's, an apply's (inside its compare-and-set), and a revert's.
 * Tables not created yet read as empty — asked of the catalogue, never
 * learned from a failed read (existingTables says why).
 *
 * The approvals are reduced to their states, times and whether they were a
 * chain refusal, minted a generation or archived a home: nothing of their
 * evidence, and no reason's text beyond the prefix test.
 */
async function readAdmissionState(db: Db, tables: ReadonlySet<string>, tenant: string, account: string): Promise<AdmissionState> {
  const approvals: ApprovalFact[] = tables.has("ledger_resume_approvals")
    ? ((await db.prepare(`SELECT approval_id, state, reason, generation, archive_path, created_at_ms, updated_at_ms FROM ledger_resume_approvals
        WHERE tenant = ?`).all(tenant)) as Array<Record<string, unknown>>).map((r) => ({
      approvalId: String(r.approval_id), state: String(r.state), createdAtMs: num(r.created_at_ms), updatedAtMs: num(r.updated_at_ms),
      chainRefusal: String(r.state) === "refused" && String(r.reason ?? "").startsWith(CHAIN_REFUSAL),
      generation: strOrNull(r.generation), archived: r.archive_path !== null && r.archive_path !== undefined && String(r.archive_path) !== "",
    })).sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.createdAtMs - a.createdAtMs || byText(a.approvalId, b.approvalId))
    : [];
  const attestations = tables.has("ledger_resume_attestations")
    ? ((await db.prepare("SELECT generation FROM ledger_resume_attestations WHERE tenant = ?").all(tenant)) as Array<Record<string, unknown>>)
      .map((r) => String(r.generation)).sort(byText)
    : [];
  let beatAt: number | null = null;
  for (const r of (await db.prepare("SELECT beat_at FROM agents WHERE LOWER(smart_account) = ?").all(account)) as Array<Record<string, unknown>>) {
    const s = unixSec(r.beat_at);
    if (s !== null) beatAt = beatAt === null ? s : Math.max(beatAt, s);
  }
  const lastMirrorAt = await lastMirrorPassAt(db, tenant);
  return { approvals, attestations, liveness: { beatAt, lastMirrorAt } };
}

/**
 * The account's positions and live cost basis, as planAttestedSeed reads them
 * (any spelling of the account), in a fixed order — and what planAttestedSeed
 * itself would seed from them, asked of it on this same read. It reads the
 * floors too, so it is asked only when all three tables are there: a
 * statement that fails would abort the snapshot's transaction
 * (existingTables says why).
 */
async function readHoldings(db: Db, tables: ReadonlySet<string>, account: string): Promise<Holdings> {
  const positions: Holdings["positions"] = tables.has("positions")
    ? ((await db.prepare("SELECT symbol, token, raw_balance, updated_at FROM positions WHERE LOWER(agent_id) = ?").all(account)) as Array<Record<string, unknown>>)
      .map((r) => ({ symbol: String(r.symbol ?? ""), token: lower(r.token), rawBalance: String(r.raw_balance ?? "0"), updatedAt: unixSec(r.updated_at) }))
      .sort((a, b) => byText(a.symbol, b.symbol) || byText(a.token, b.token))
    : [];
  const basis: Holdings["basis"] = tables.has("cost_basis")
    ? ((await db.prepare("SELECT agent_id, symbol, qty_raw, cost_usdg, updated_at FROM cost_basis WHERE LOWER(agent_id) = ? AND mode = 'live'").all(account)) as
      Array<Record<string, unknown>>)
      .map((r) => ({ agentId: String(r.agent_id ?? ""), symbol: String(r.symbol ?? ""), qtyRaw: String(r.qty_raw ?? "0"), costUsdg: String(r.cost_usdg ?? "0"),
        updatedAt: unixSec(r.updated_at) }))
      .sort((a, b) => byText(a.symbol, b.symbol) || byText(a.agentId, b.agentId))
    : [];
  const seeded: Holdings["seeded"] = tables.has("positions") && tables.has("cost_basis") && tables.has("position_floors")
    ? (await planAttestedSeed(db, account)).basis.map((r) => ({ symbol: r.symbol, qtyRaw: r.qtyRaw, costUsdg: r.costUsdg }))
      .sort((a, b) => byText(a.symbol, b.symbol))
    : null;
  return { positions, basis, seeded };
}

/**
 * fill_cash_usdg back in micro-USDG, exactly, or null. The column is a REAL
 * (DOUBLE PRECISION on Postgres) holding usdgNum of the cash bookFill applied
 * to the basis (index.ts), so a value of at most six decimals and fifteen
 * significant digits reads back as the decimal that was written. Anything
 * else — absent, negative, more digits than a double keeps — is not that
 * figure, and is never rounded into one.
 */
export function microUsdg(v: unknown): string | null {
  if (v === null || v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v))) return null;
  const m = /^([0-9]+)(?:\.([0-9]{1,6}))?$/.exec(String(v));
  if (!m || `${m[1]}${m[2] ?? ""}`.replace(/^0+/, "").length > 15) return null;
  return (BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"))).toString();
}

/**
 * The account's trade rows that could have moved a token, by id: 'landed', or
 * 'submitted' (its outcome unknown, so whatever it moved is not recorded). A
 * reverted, rejected, dropped or paper row moved nothing on chain.
 */
async function readFills(db: Db, account: string): Promise<RecordedFill[]> {
  const rows = (await db.prepare(`SELECT id, status, buy_token, sell_token, fill_side, fill_qty_raw, fill_cash_usdg, fill_symbol, basis_source, created_at
      FROM trades WHERE LOWER(agent_id) = ? AND status IN ('landed', 'submitted') AND (buy_token IS NOT NULL OR sell_token IS NOT NULL OR fill_symbol IS NOT NULL)`)
    .all(account)) as Array<Record<string, unknown>>;
  const tok = (v: unknown) => (v === null || v === undefined || v === "" ? null : lower(v));
  return rows.map((r) => ({
    id: num(r.id), status: String(r.status), buyToken: tok(r.buy_token), sellToken: tok(r.sell_token), side: strOrNull(r.fill_side),
    qtyRaw: strOrNull(r.fill_qty_raw), symbol: strOrNull(r.fill_symbol), basisSource: strOrNull(r.basis_source), at: unixSec(r.created_at),
    cashUsdg: microUsdg(r.fill_cash_usdg),
  })).sort((a, b) => a.id - b.id);
}

export async function readBookingSnapshot(db: Db, o: { tenant: string; dialect: Dialect; nowSec: number }): Promise<BookingSnapshot> {
  const tenant = lower(o.tenant);
  if (!ADDRESS.test(tenant)) throw new BookingRefused("invalid-tenant", "the tenant is not a full 0x address");
  const tables = await existingTables(db, o.dialect);
  for (const needed of ["grants", "agents", "trades", "flows", "equity", "mirror_state"]) {
    if (!tables.has(needed)) throw new BookingRefused("schema", `the ${needed} table is not in this database: it is not the ledger this tool books into`);
  }
  const grants = (await db.prepare(GRANT_SQL[o.dialect]).all(tenant)) as Array<Record<string, unknown>>;
  if (grants.length > 1) throw new BookingRefused("ambiguous-grant", "more than one grant row names this tenant");
  let grant: BookingSnapshot["grant"] = null;
  if (grants[0] && ADDRESS.test(lower(grants[0].smart_account))) {
    const g = grants[0];
    const raw = typeof g.grant_features === "string" ? (() => { try { return JSON.parse(g.grant_features as string) as unknown; } catch { return null; } })() : g.grant_features;
    const grantFeatures = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string") : [];
    const stored = {
      grantFeatures, ponsClassVaultAddress: strOrNull(g.pons_class_vault_address) ?? undefined,
      trencherVaultAddress: strOrNull(g.trencher_vault_address) ?? undefined, trencherFactoryAddress: strOrNull(g.trencher_factory_address) ?? undefined,
    } as Parameters<typeof custodyAddressesOf>[0];
    const custody = custodyAddressesOf(stored).map(lower).sort();
    const chainId = g.chain_id === null || g.chain_id === undefined ? null : Number(g.chain_id);
    grant = { account: lower(g.smart_account), spelled: String(g.smart_account), owner: ADDRESS.test(lower(g.owner)) ? lower(g.owner) : null,
      chainId: Number.isSafeInteger(chainId) ? chainId : null, custody, classVault: grantPonsClassVault(stored) };
  }
  const account = grant?.account ?? "";
  const agents = ((await db.prepare(`SELECT smart_account, epoch, chain_id, mode, hwm_usdg, hwm_withdrawn_usdg FROM agents WHERE LOWER(smart_account) = ?
      ORDER BY smart_account`).all(account)) as Array<Record<string, unknown>>).map((r) => ({
    smartAccount: String(r.smart_account), epoch: num(r.epoch), chainId: r.chain_id === null || r.chain_id === undefined ? null : Number(r.chain_id),
    mode: strOrNull(r.mode), hwmUsdg: num(r.hwm_usdg), hwmWithdrawnUsdg: num(r.hwm_withdrawn_usdg),
  }));
  const spellings = new Set<string>();
  for (const table of SPELLING_TABLES.filter((t) => tables.has(t))) {
    for (const r of (await db.prepare(`SELECT DISTINCT agent_id FROM ${table} WHERE LOWER(agent_id) = ?`).all(account)) as Array<Record<string, unknown>>) spellings.add(String(r.agent_id));
  }
  const epoch = agents.length === 1 ? agents[0]!.epoch : null;
  let epochOpenedAt: number | null = null;
  if (epoch !== null) {
    const r = (await db.prepare(`SELECT MIN(t) AS at FROM (
        SELECT MIN(created_at) AS t FROM trades WHERE LOWER(agent_id) = ? AND epoch = ?
        UNION ALL SELECT MIN(at) AS t FROM flows WHERE LOWER(agent_id) = ? AND epoch = ?
        UNION ALL SELECT MIN(at) AS t FROM equity WHERE LOWER(agent_id) = ? AND epoch = ?) opened`)
      .get(account, epoch, account, epoch, account, epoch)) as Record<string, unknown> | undefined;
    epochOpenedAt = r?.at === null || r?.at === undefined ? null : Number(r.at);
  }
  const knownAccounts = ((await db.prepare("SELECT DISTINCT LOWER(smart_account) AS a FROM agents ORDER BY a").all()) as Array<Record<string, unknown>>)
    .map((r) => String(r.a)).filter((a) => ADDRESS.test(a));
  // The owner records exactly as admission loads them: this tenant, account and the grant's chain.
  const k = await knownChainFacts(db, account, grant?.chainId === null || grant?.chainId === undefined ? undefined : { tenant, chainId: grant.chainId });
  const ownerRecords: BookingSnapshot["ownerRecords"] = account && tables.has("owner_operations")
    ? ((await db.prepare(`SELECT tenant, user_op_hash, tx_hash, chain_id, disposition, review_reason FROM owner_operations WHERE LOWER(agent_id) = ?`)
      .all(account)) as Array<Record<string, unknown>>).map((r) => ({
      userOpHash: lower(r.user_op_hash), txHash: lower(r.tx_hash), chainId: num(r.chain_id), disposition: String(r.disposition),
      reviewReason: strOrNull(r.review_reason), tenant: r.tenant === null || r.tenant === undefined ? null : lower(r.tenant),
    })).sort((a, b) => byText(a.userOpHash, b.userOpHash) || byText(a.tenant ?? "", b.tenant ?? ""))
    : [];
  // ADMISSION'S OWN WINDOW, from the same hold (ledger-resume.ts
  // resumeGapWindow): for a tenant held on a chain refusal, no later than the
  // refused read began, however long ago — so every fact that refusal named
  // is in what this reads, as it is in what admission will read. The hold is
  // read without a statement that could fail (the snapshot is one
  // transaction): the column's presence is asked of the catalogue, and rows
  // from before it are read as such (their start derived, never later).
  const approvalsTable = tables.has("ledger_resume_approvals");
  const hold = await readChainHold(db, tenant, {
    table: approvalsTable, readFromColumn: approvalsTable && (await existingColumns(db, o.dialect, "ledger_resume_approvals")).has("chain_read_from_sec"),
  });
  const { gapFromSec } = await resumeGapWindow(db, tenant, o.nowSec, hold);
  const count = async (table: "trades" | "flows") => {
    const r = (await db.prepare(`SELECT COUNT(*) AS n, MAX(id) AS max_id FROM ${table} WHERE LOWER(agent_id) = ?`).get(account)) as Record<string, unknown>;
    return { n: num(r.n), maxId: num(r.max_id) };
  };
  const open = tables.has("ledger_resume_approvals") ? await readOpenApproval(db, tenant) : null;
  const booked: BookingSnapshot["booked"] = tables.has(BOOKINGS_TABLE)
    ? ((await db.prepare(`SELECT booking_id, evidence_key, table_name, row_id FROM ${BOOKINGS_TABLE} WHERE account = ? AND state = 'applied'
        ORDER BY evidence_key, booking_id`).all(account)) as Array<Record<string, unknown>>)
      .map((r) => ({ bookingId: String(r.booking_id), evidenceKey: String(r.evidence_key), tableName: String(r.table_name), rowId: num(r.row_id) }))
    : [];
  return {
    tenant, grant, agents, spellings: [...spellings].sort(), epochOpenedAt, knownAccounts,
    known: { ops: [...k.ops].sort(), txs: [...k.txs].sort(), flows: [...k.flows].sort(), ownerOps: [...k.ownerRecords].map(([h, tx]) => `${h}|${tx}`).sort() },
    ownerRecords, gapFromSec,
    ledger: { trades: await count("trades"), flows: await count("flows") },
    openApproval: open ? { state: open.state, evidence: open.evidenceDigest } : null,
    admitted: account && tables.has("tenant_ledger_import") && tables.has("ledger_resume_attestations") ? await attestedSourceInUse(db, tenant, account) : null,
    booked,
    admission: await readAdmissionState(db, tables, tenant, account),
    holdings: await readHoldings(db, tables, account),
    fills: await readFills(db, account),
  };
}

/**
 * The part of a snapshot apply compares inside its transaction: what the
 * proposals were computed from, and what the hold was proved from. A tenant
 * that woke between the preview and the apply — a heartbeat, a mirrored row,
 * a new approval, a mode change — moves one of these, and the apply refuses.
 * The recorded fills by digest: a row's fill repaired in place moves no count
 * or maximum id, and the holding was judged on it. `holdings.seeded` is
 * defence in depth: planAttestedSeed's basis is a pure function of the
 * positions and live cost_basis rows `holdings` already carries, read on the
 * same snapshot.
 */
function casFacts(s: BookingSnapshot) {
  return { grant: s.grant, agents: s.agents.map(({ smartAccount, epoch, chainId, mode }) => ({ smartAccount, epoch, chainId, mode })), spellings: s.spellings,
    epochOpenedAt: s.epochOpenedAt, known: s.known, ownerRecords: s.ownerRecords, ledger: s.ledger, openApproval: s.openApproval, admitted: s.admitted, booked: s.booked,
    admission: s.admission, holdings: s.holdings, fills: digestOf(s.fills) };
}

// ── the hold ─────────────────────────────────────────────────────────────────

/**
 * IS THIS TENANT HELD, AS FAR AS POSTGRES CAN PROVE IT? PURE.
 *
 * The anchor is the tenant's newest admission decision — its newest approval
 * that was not revoked (a revoked approval decided nothing: it was withdrawn
 * before it could admit) — and it must be a CHAIN REFUSAL. That one row says
 * three things at once: admission ran for this tenant (it is a pre-incident
 * tenant whose book is attested, not one running on its own); it drained the
 * old book's tail into Postgres before it read the chain (orchestrator.ts
 * drainContinuousBook, run first in Phase A); and the chain then held
 * operations or transfers that Postgres, and so that book, lacked.
 *
 * Then nothing may have written for the tenant since: its heartbeat and its
 * newest mirror cursor are no later than the refusal (admission ran with no
 * worker for it — owned() refuses one — so a later beat is a worker that
 * started after it), and both have been silent for BOOKING_QUIET_SEC. The
 * rule that decides compares three times from the orchestrator host's own
 * clock with each other; only the quiet floor is measured against the
 * operator's, and a clock there that runs ahead can only weaken that floor,
 * never the rule under it. A worker running under a wedged mirror would show
 * none of this, so the anchor also bounds the facts: only what landed before
 * the refusal is booked (planBooking's `settled`), and that was proved
 * missing from the book the worker would run on.
 *
 * `anchorSec` is null when there is no anchor; the refusals then say why.
 */
export function holdOf(snap: BookingSnapshot, nowSec: number): { anchorSec: number | null; refusals: string[] } {
  const refusals: string[] = [];
  const decided = snap.admission.approvals.find((a) => a.state !== "revoked") ?? null;
  if (!decided) {
    refusals.push(`admission has never refused this tenant on the chain (no approval of it was decided): this tool books only a tenant held on a chain refusal, ` +
      `whose newest approval was refused with "${CHAIN_REFUSAL}" — a tenant running on its own book has its mirror to bring these rows`);
    return { anchorSec: null, refusals };
  }
  if (decided.state !== "refused" || !decided.chainRefusal) {
    // An open approval is refused on its own terms already (planBooking), with the revoke to set.
    if (!OPEN_APPROVAL_STATES.has(decided.state)) {
      // A LATER REFUSAL FOR ANOTHER REASON over an older chain refusal is not
      // booked on (the anchor rule stands), and the way out is said: admission
      // reads the chain for a tenant with a chain refusal no admission has
      // answered, whatever it reads as (ledger-resume.ts ResumeCheck.chainHeld),
      // from no later than the refused read began (resumeGapWindow), so one
      // approval records a fresh chain refusal while Postgres lacks it.
      const superseded = decided.state === "refused"
        && snap.admission.approvals.find((a) => a.chainRefusal || a.state === "registered" || a.state === "applied")?.chainRefusal === true;
      refusals.push(`the tenant's newest admission decision (approval ${decided.approvalId.slice(0, 8)}…, ${decided.state === "refused" ? "refused for another reason" : decided.state}) ` +
        "is not a chain refusal: this tool books only what admission refused a held tenant on" +
        (superseded ? ". An earlier approval was refused on the chain: preview the tenant in admission's preview and approve the digest it prints once, " +
          "with it in the rollout at exits-only, so admission reads the chain again from where that refused read began and, while Postgres lacks what it " +
          "showed, refuses it with a fresh chain refusal; then take it out of the rollout and preview here again" : ""));
    }
    return { anchorSec: null, refusals };
  }
  const anchorSec = Math.floor(decided.updatedAtMs / 1000);
  const { beatAt, lastMirrorAt } = snap.admission.liveness;
  if (beatAt !== null && beatAt > anchorSec) {
    refusals.push(`its worker beat at ${iso(beatAt)}, after admission refused it at ${iso(anchorSec)}: it has run since, so it is not held — ` +
      "keep it out of MERRYMEN_FLEET_ROLLOUT, let admission refuse it again, then preview again");
  }
  if (lastMirrorAt !== null && lastMirrorAt > anchorSec) {
    refusals.push(`rows were mirrored for it at ${iso(lastMirrorAt)}, after admission refused it at ${iso(anchorSec)}: something wrote its book since, so it is not held — ` +
      "keep it out of MERRYMEN_FLEET_ROLLOUT, let admission refuse it again, then preview again");
  }
  const last = Math.max(beatAt ?? 0, lastMirrorAt ?? 0);
  if (last > 0 && nowSec - last < BOOKING_QUIET_SEC) {
    refusals.push(`its book was written ${Math.max(0, nowSec - last)}s ago (heartbeat or mirror): preview again once it has been quiet for ${BOOKING_QUIET_SEC / 60} minutes`);
  }
  return { anchorSec, refusals };
}

// ── the chain half ───────────────────────────────────────────────────────────

/** One transaction as the chain gave it: its receipt and its block, read once. */
export interface TxEvidence {
  receipt: { status: string; blockNumber: string; blockHash: string; from: string | null; to: string | null; logs: RawChainLog[] } | null;
  block: { number: string; hash: string; timestamp: number } | null;
}
export interface ChainEvidence {
  rpcChainId: number;
  /** Admission's own chain check, with the snapshot's Postgres facts. */
  gap: { status: "clean"; fromBlock: string; head: string }
    | { status: "missing"; fromBlock: string; head: string; found: MissingChainFact[] }
    | { status: "unavailable"; why: string };
  txs: Record<string, TxEvidence>;
  /** decimals() of each token a proposed fill names, read at the latest block; null when it could not be read. */
  decimals: Record<string, number | null>;
  /**
   * balanceOf() of each token a proposed fill names, for every address of the
   * book (the account and its custody), read at `balanceBlock`, in base units.
   * `total` is null unless every address answered.
   */
  balances: Record<string, { total: string | null; by: Record<string, string | null> }>;
  /**
   * THE PINNED BLOCK the balances were read at: admission's head less
   * BOOKING_CONFIRMATIONS, so at or after every fact this plan books (each is
   * that deep) and as final as they are. Null when no balance was read. Kept
   * out of the digest, as the head is: it moves on every preview.
   */
  balanceBlock: string | null;
}

/**
 * The admission's chain seam over this tool's transport: the same four
 * reads, nothing else (the receipt only for an operation an owner record
 * would answer). The head, timestamps and receipts wait out a rate limit
 * here; getLogs is left to getLogsAdaptive, which already does, and narrows.
 */
export function gapChainOf(rpc: RpcCall, sleep: (ms: number) => Promise<void> = (ms) => new Promise<void>((r) => setTimeout(r, ms))): GapChain {
  const hex = (n: bigint) => `0x${n.toString(16)}`;
  return {
    async getBlockNumber() { return BigInt(String(await patiently(() => rpc("eth_blockNumber", []), sleep))); },
    async getBlockTimestamp(block) {
      const b = (await patiently(() => rpc("eth_getBlockByNumber", [hex(block), false]), sleep)) as { timestamp?: unknown } | null;
      if (typeof b?.timestamp !== "string") throw new Error("block unreadable");
      return Number(BigInt(b.timestamp));
    },
    async getLogs(a) {
      return (await rpc("eth_getLogs", [{ address: a.address, fromBlock: hex(a.fromBlock), toBlock: hex(a.toBlock), topics: a.topics }])) as never;
    },
    // Only for an operation an owner record would answer: the record is re-derived from it (ownerAnswersFor).
    async getReceiptLogs(txHash) {
      const r = (await patiently(() => rpc("eth_getTransactionReceipt", [txHash]), sleep)) as { logs?: unknown } | null;
      return r && Array.isArray(r.logs) ? (r.logs as RawChainLog[]) : null;
    },
  };
}

/**
 * Ask again while the node says "later": a rate limit or a transient failure
 * (rpc-error.ts's `retryable`), at 1s, 2s, 4s, 8s. Anything else, or the last
 * failure, is the caller's to treat as unread.
 */
async function patiently<T>(call: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await call(); }
    catch (e) {
      const v = classifyRpcError(e);
      if (!v.retryable || attempt >= 4) throw e;
      await sleep(v.retryAfterMs ?? 1_000 * 2 ** attempt);
    }
  }
}

/** This account's own operation in a receipt: its segment, its raw event, and the book's net movement in it. */
interface OpReading {
  seg: OpSegment;
  /** actualGasCost and actualGasUsed, from the event's own data. */
  gasWei: bigint; gasUnits: bigint;
  deltas: Map<string, bigint>;
}
function readOp(receipt: NonNullable<TxEvidence["receipt"]>, userOpHash: string, account: string, book: readonly string[]): OpReading | null {
  const { segments } = segmentReceipt(receipt.logs);
  const seg = segments.find((s) => s.op.userOpHash === userOpHash && s.op.sender === account && s.op.entryPoint === lower(ENTRYPOINT.v07));
  if (!seg) return null;
  const raw = receipt.logs.find((l) => Number(BigInt(l.logIndex)) === seg.op.logIndex);
  const data = lower(raw?.data).replace(/^0x/, "");
  if (data.length !== 256) return null;
  return { seg, gasWei: BigInt(`0x${data.slice(128, 192)}`), gasUnits: BigInt(`0x${data.slice(192, 256)}`), deltas: netTokenDeltas(seg.logs, [...book]) };
}

/**
 * READ THE CHAIN FOR ONE SNAPSHOT: admission's own check from the second
 * admission reads from, then the receipt and block of every transaction it
 * named, then decimals() of every token a fill would name and how much of it
 * each address of the book held at the pinned block (balanceBlock). Reads
 * only; the transport admits nothing else (chain-gap-booking-cli.ts
 * createBookingRpc).
 */
export async function readChainEvidence(rpc: RpcCall, snap: BookingSnapshot, o: {
  log?: (line: string) => void; sleep?: (ms: number) => Promise<void>; maxSpan?: bigint;
} = {}): Promise<ChainEvidence> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rpcChainId = Number(BigInt(String(await patiently(() => rpc("eth_chainId", []), sleep))));
  const empty = { rpcChainId, txs: {}, decimals: {}, balances: {}, balanceBlock: null };
  if (!snap.grant) return { ...empty, gap: { status: "unavailable", why: "no stored grant names the account to read" } };
  const ownerRecords = new Map(snap.known.ownerOps.map((p) => p.split("|") as [string, string]));
  const known = { ops: new Set(snap.known.ops), txs: new Set(snap.known.txs), flows: new Set(snap.known.flows), ownerRecords };
  // As admission reads it: an owner record answers only once re-derived over the grant's own custody and chain.
  const ownerContext = snap.grant.chainId === null ? undefined : { custody: snap.grant.custody, chainId: snap.grant.chainId };
  const gap = await chainGapCheck({ chain: gapChainOf(rpc, sleep), account: snap.grant.account, usdg: RESUME_USDG, sinceSec: snap.gapFromSec, known,
    ...(ownerContext ? { ownerContext } : {}),
    ...(o.maxSpan === undefined ? {} : { maxSpan: o.maxSpan }), ...(o.log ? { log: o.log } : {}) });
  if (gap.status !== "missing") return { ...empty, gap: gap.status === "clean" ? { status: "clean", fromBlock: gap.fromBlock, head: gap.head } : gap };
  const txs: Record<string, TxEvidence> = {};
  for (const tx of [...new Set(gap.found.map((f) => f.txHash))].sort()) {
    let receipt: TxEvidence["receipt"] = null, block: TxEvidence["block"] = null;
    try {
      const r = (await patiently(() => rpc("eth_getTransactionReceipt", [tx]), sleep)) as Record<string, unknown> | null;
      if (r && Array.isArray(r.logs) && typeof r.blockNumber === "string" && typeof r.blockHash === "string" && typeof r.status === "string") {
        receipt = { status: r.status, blockNumber: r.blockNumber, blockHash: lower(r.blockHash), from: strOrNull(r.from)?.toLowerCase() ?? null,
          to: strOrNull(r.to)?.toLowerCase() ?? null, logs: r.logs as RawChainLog[] };
        const b = (await patiently(() => rpc("eth_getBlockByNumber", [r.blockNumber, false]), sleep)) as Record<string, unknown> | null;
        if (b && typeof b.number === "string" && typeof b.hash === "string" && typeof b.timestamp === "string" && BigInt(b.number) === BigInt(r.blockNumber as string)) {
          block = { number: BigInt(b.number).toString(), hash: lower(b.hash), timestamp: Number(BigInt(b.timestamp)) };
        }
      }
    } catch {
      // Unread is unread: the plan says so for every fact in this transaction.
    }
    txs[tx] = { receipt, block };
  }
  const decimals: Record<string, number | null> = {};
  const balances: ChainEvidence["balances"] = {};
  const book = [snap.grant.account, ...snap.grant.custody];
  const word = (v: unknown): bigint | null => (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : null);
  // PINNED, NEVER "latest": the deepest block every booked fact is at or
  // before (each must be BOOKING_CONFIRMATIONS deep under this same head),
  // and as final as they are. A balance read at "latest" could already hold
  // what landed after them — or what a reorg will take back.
  const pinned = BigInt(gap.head) - BOOKING_CONFIRMATIONS;
  const balanceBlock = pinned >= 0n ? pinned : null;
  for (const f of gap.found) {
    const receipt = f.kind === "operation" ? txs[f.txHash]?.receipt : null;
    if (!receipt || f.kind !== "operation") continue;
    const op = readOp(receipt, f.userOpHash, snap.grant.account, book);
    const leg = op ? pickAcquiredLeg(op.deltas, USDG) : null;
    if (!leg || leg.token in decimals) continue;
    try {
      const d = word(await patiently(() => rpc("eth_call", [{ to: leg.token, data: DECIMALS_SELECTOR }, "latest"]), sleep)) ?? -1n;
      decimals[leg.token] = d >= 0n && d <= 36n ? Number(d) : null;
    } catch { decimals[leg.token] = null; }
    // WHAT THE BOOK HELD OF IT AT THE PINNED BLOCK, address by address: what
    // the snapshot's position and basis must equal (holdingVerdict).
    const by: Record<string, string | null> = {};
    for (const holder of book) {
      if (balanceBlock === null) { by[holder] = null; continue; }
      try {
        const v = word(await patiently(() => rpc("eth_call", [{ to: leg.token, data: `${BALANCE_OF_SELECTOR}${holder.slice(2).padStart(64, "0")}` },
          `0x${balanceBlock.toString(16)}`]), sleep));
        by[holder] = v === null ? null : v.toString();
      } catch { by[holder] = null; }
    }
    const read = Object.values(by);
    balances[leg.token] = { total: read.every((v) => v !== null) ? read.reduce((s, v) => s + BigInt(v!), 0n).toString() : null, by };
  }
  return { rpcChainId, gap: { status: "missing", fromBlock: gap.fromBlock, head: gap.head, found: gap.found }, txs, decimals, balances,
    balanceBlock: Object.keys(balances).length && balanceBlock !== null ? balanceBlock.toString() : null };
}

// ── the plan ─────────────────────────────────────────────────────────────────

/** The row the existing writers write, column for column as the mirror carries a trade into Postgres (ledger-mirror.ts). */
export interface TradeProposal {
  agent_id: string; kind: "swap"; target: string; sell_token: string | null; buy_token: string | null; amount_usdg: number;
  user_op_hash: string; tx_hash: string; status: "landed" | "reverted"; reject_rule: string | null; decision_id: null;
  fill_side: "buy" | "sell" | null; fill_symbol: string | null; fill_qty_raw: string | null; fill_price_usd: number | null;
  realized_pnl_usdg: null; basis_source: "receipt" | null; gas_wei: string | null; sponsored_gas_wei: string | null;
  gas_usdg: null; gas_units: string | null; fill_cash_usdg: number | null; epoch: number; created_at: number; budget_settled_at: null;
}
/** The row the chain-capital reconstruction writes (accounting-repair.ts). */
export interface FlowProposal {
  agent_id: string; direction: "in" | "out"; amount_usdg: number; tx_hash: string; block_number: number; log_index: number;
  source: "chain-log"; epoch: number; chain_id: number; at: number;
}
export const TRADE_COLUMNS = ["agent_id", "kind", "target", "sell_token", "buy_token", "amount_usdg", "user_op_hash", "tx_hash", "status", "reject_rule",
  "decision_id", "fill_side", "fill_symbol", "fill_qty_raw", "fill_price_usd", "realized_pnl_usdg", "basis_source", "gas_wei", "sponsored_gas_wei",
  "gas_usdg", "gas_units", "fill_cash_usdg", "epoch", "created_at", "budget_settled_at"] as const;
export const FLOW_COLUMNS = ["agent_id", "direction", "amount_usdg", "tx_hash", "block_number", "log_index", "source", "epoch", "chain_id", "at"] as const;

export type ItemClass =
  /** A session key's swap: USDG one way, one token the other. A trades row with its fill. */
  | "session-trade"
  /** A session key's operation that moved nothing across the book's edge. The reconciler's row. */
  | "session-no-movement"
  /** A session key's operation the EntryPoint recorded as failing. A reverted row with its gas. */
  | "session-reverted"
  /** A USDG transfer inside an operation booked here: that row's transaction covers it. */
  | "operation-leg"
  /** USDG in from outside the system, no operation of the account. A chain-log flow. */
  | "deposit"
  /** The owner's own key signed it. No writer books an owner's operation in the agent's book. Blocks. */
  | "owner-operation"
  /** Anything else. Blocks, and says why. */
  | "unresolved";

export interface BookingItem {
  /** `op:<userOpHash>` or `log:<tx>#<logIndex>`: the identity a booking is idempotent by. */
  key: string;
  fact: MissingChainFact;
  /** The fact as an operator reads it (ledger-resume.ts describeChainFact). */
  said: string;
  class: ItemClass;
  /** The sentence a reviewer reads: why this class, and what it would write. */
  why: string;
  evidence: Record<string, unknown>;
  proposal: { table: "trades"; row: TradeProposal } | { table: "flows"; row: FlowProposal } | null;
  /** For an operation's leg: the key of the operation whose row covers it. */
  coveredBy?: string;
}

export interface BookingPlan {
  format: typeof BOOKING_FORMAT;
  /** Binds the preview to the code and the database that produced it. Supplied by the caller. */
  source: unknown; target: string;
  tenant: string; account: string | null; chainId: number | null; epoch: number | null; agentId: string | null;
  /** "ready": every fact classified and proposed, nothing in the way. "nothing-missing": admission's check is clean. "blocked": see refusals. */
  verdict: "ready" | "nothing-missing" | "blocked";
  refusals: string[];
  found: MissingChainFact[];
  items: BookingItem[];
  /** Facts the proposals would not answer: admission would still refuse on these after an apply. Empty to be ready. */
  remaining: MissingChainFact[];
  cas: ReturnType<typeof casFacts>;
  previewDigest: string;
  /** Not in the digest: when, where on the chain (and the pinned block the balances were read at), and what the reviewer should know. */
  capture: { capturedAtSec: number; fromBlock: string | null; head: string | null; rpcChainId: number; confirmations: number; balanceBlock: string | null };
  warnings: string[];
  observations: { mode: string | null; hwmUsdg: number | null; hwmWithdrawnUsdg: number | null; epochOpenedAt: number | null };
}

const keyOf = (f: MissingChainFact) => (f.kind === "operation" ? `op:${f.userOpHash}` : `log:${f.txHash}#${f.logIndex ?? "?"}`);
const usdgNumber = (raw: bigint) => Number(raw) / 1e6;
const factBlock = (f: MissingChainFact) => (f.block === null ? null : BigInt(f.block));

/** USDG Transfer logs naming the account on either side, by log index. */
function accountUsdgLogs(logs: readonly RawChainLog[], account: string): RawChainLog[] {
  const pad = `0x${account.replace(/^0x/, "").padStart(64, "0")}`;
  return logs.filter((l) => lower(l.address) === USDG && lower(l.topics?.[0]) === TRANSFER_TOPIC && l.topics.length === 3
    && (lower(l.topics[1]) === pad || lower(l.topics[2]) === pad));
}

/** What moved across the book's edge in one operation, in words, for an unresolved reason. */
function saidDeltas(deltas: Map<string, bigint>): string {
  const moved = [...deltas].filter(([, v]) => v !== 0n);
  if (!moved.length) return "nothing";
  return moved.map(([t, v]) => `${t === USDG ? "USDG" : t} ${v > 0n ? "+" : ""}${t === USDG ? usdg6(v.toString()) : v.toString()}`).join(", ");
}

/**
 * Which facts would admission still find after these proposals were written?
 * PURE, and the same rule as chainFactsPostgresLacks, over facts rather than
 * logs: an operation is answered by a trade row with its hash; a transfer by a
 * trade row with its transaction, or a flow with its tx#log, or an operation
 * answered in the same transaction.
 */
export function factsStillMissing(found: readonly MissingChainFact[], held: { ops: ReadonlySet<string>; txs: ReadonlySet<string>; flows: ReadonlySet<string> }): MissingChainFact[] {
  const opTxs = new Set(found.filter((f) => f.kind === "operation" && held.ops.has(f.userOpHash)).map((f) => f.txHash));
  return found.filter((f) => f.kind === "operation" ? !held.ops.has(f.userOpHash)
    : !(held.txs.has(f.txHash) || opTxs.has(f.txHash) || (f.logIndex !== null && held.flows.has(`${f.txHash}:${f.logIndex}`))));
}

/** A decimal count of base units, as positions and cost_basis store one; null for anything else. */
const baseUnits = (v: string | null | undefined): bigint | null => (typeof v === "string" && /^[0-9]{1,78}$/.test(v) ? BigInt(v) : null);
/** A balance read, address by address, in words: which part of the book holds what. */
const saidBy = (b: ChainEvidence["balances"][string]): string => Object.entries(b.by).map(([a, v]) => `${a} ${v ?? "unread"}`).join(", ");

/** One trade this plan would book in a token: what the holding is judged on. `cashUsdg` is its cash leg off the receipt, in micro-USDG. */
export interface ProposedFill { key: string; side: "buy" | "sell"; qtyRaw: string; cashUsdg: string; at: number; symbol: string | null }

/**
 * WALKING THE TOKEN'S FILLS BACK TO WHERE ITS BASIS OPENED. PURE.
 *
 * The weighted-average basis is deleted when a position goes flat and opened
 * again by the next buy (store.ts setBasis), so what the book holds now is
 * the sum of the fills since it was last flat: the basis's anchor. Walking
 * back from the balance the chain gave, newest first, through every fill
 * Postgres records in the token and every fill this plan books, the book held
 * `after − bought` or `after + sold` before each. The walk is done when it has
 * passed every proposed fill and stands at zero: those fills, from flat,
 * reproduce the chain's quantity exactly ("reproduced").
 *
 * "REPRODUCED" PROVES THE QUANTITY, NOT THAT THE BASIS INCLUDES THE FILLS. A
 * buy and a sell of the same amount add nothing to the sum, so a basis that
 * left both out — booked here, or recorded and never applied to it — holds
 * the chain's quantity too, at the wrong cost. What the basis was built from
 * is replayBasis's question, and holdingVerdict's.
 *
 *   below zero    a fill bought more than the book held after it: the fills
 *                 are more than the chain holds, so something moved the
 *                 token that neither Postgres nor this plan records
 *                 ("exceeds"). Refuses.
 *   unreadable    a row in the token that is still in flight, carries no
 *                 fill, or whose quantity is a quote's rather than its
 *                 receipt's; or the records run out with the book still
 *                 holding some (a holding from before fills were recorded,
 *                 or from outside a fill). The walk cannot say ("unproven"),
 *                 so what the book holds cannot be traced to its fills: a
 *                 held token refuses (holdingVerdict), and only a token
 *                 nobody holds — whose seed is nothing — books, with a note.
 *
 * WHEN EACH FILL HAPPENED. A proposed fill is dated by its block. A recorded
 * row is dated by created_at, which is when the row was first written, not
 * when its operation landed: an executor's row at submission (the 'submitted'
 * placeholder, settled in place), seconds before its block; the in-flight
 * reconciler's at the arm that found its operation, which can be many hours
 * after its block. The reconciler writes its row with the legs and no fill
 * (index.ts reconcileInFlightAtArm), and the walk stops at such a row as
 * unproven. But the history repair (history-fill-repair.ts, at the
 * orchestrator's start) later fills in its side, quantity and cash off the
 * receipt and keeps basis_source 'receipt', and the walk then reads that row
 * at the arm's time: out of order, perhaps by hours. The same second orders
 * recorded first. A fill read out of order — that row, or a missed fill that
 * landed in the seconds between a recorded row's submission and its block —
 * can make the walk refuse wrongly or miss an excess it would otherwise find,
 * and make the replayed cost differ from the basis (which refuses). The
 * quantity checks (holdingVerdict) do not depend on the order, and a held
 * token books only on a replayed cost equal to its basis's.
 */
export interface FillWalk {
  verdict: "reproduced" | "exceeds" | "unproven";
  why: string | null;
  /** Where the book was last flat: after this fill, or before every fill Postgres records in the token. Null unless reproduced. */
  anchor: string | null;
  /** Every fill walked, newest first: what it moved (its cash in micro-USDG, null when not recorded exactly), and what the book held before it. */
  walked: Array<{ ref: string; at: number; side: "buy" | "sell"; qtyRaw: string; cashUsdg: string | null; heldBefore: string }>;
}
export function walkFills(o: { token: string; fills: readonly RecordedFill[]; proposed: readonly ProposedFill[]; symbols: ReadonlySet<string>; total: bigint }): FillWalk {
  const { token } = o;
  type Step = { ref: string; at: number; order: number; seq: number; side: "buy" | "sell"; qty: bigint; cash: string | null; illegible: string | null; proposed: boolean };
  // Rows naming the token by either leg, or — with no leg at all — by a name it has gone by.
  const named = o.fills.filter((f) => f.buyToken === token || f.sellToken === token
    || (f.buyToken === null && f.sellToken === null && f.symbol !== null && o.symbols.has(f.symbol)));
  const steps: Step[] = named.map((f) => {
    const base = { ref: `trades#${f.id}`, at: f.at ?? Number.POSITIVE_INFINITY, order: 0, seq: f.id, proposed: false };
    const qty = baseUnits(f.qtyRaw);
    const own = f.side === "buy" ? f.buyToken : f.sellToken;
    const illegible = f.status !== "landed" ? `trade #${f.id} in ${token} is still '${f.status}': what it moved is not recorded`
      : (f.side !== "buy" && f.side !== "sell") || qty === null ? `trade #${f.id} in ${token} records no fill (side and quantity)`
        : f.basisSource !== "receipt" ? `trade #${f.id}'s fill is ${f.basisSource === null ? "unsourced" : `from its ${f.basisSource}`}, not read off its receipt, so its quantity is not what the chain moved`
          : own !== null && own !== token ? `trade #${f.id} names ${token} but its ${f.side} is of ${own}`
            : f.at === null ? `trade #${f.id} in ${token} has no time` : null;
    return { ...base, side: f.side === "sell" ? "sell" : "buy", qty: qty ?? 0n, cash: f.cashUsdg, illegible };
  });
  const proposed = [...o.proposed].sort((a, b) => byText(a.key, b.key));
  steps.push(...proposed.map((p, i) => ({ ref: p.key, at: p.at, order: 1, seq: i, side: p.side, qty: BigInt(p.qtyRaw), cash: p.cashUsdg, illegible: null, proposed: true })));
  steps.sort((a, b) => a.at - b.at || a.order - b.order || a.seq - b.seq);
  const walked: FillWalk["walked"] = [];
  let after = o.total, left = proposed.length;
  for (let i = steps.length - 1; ; i--) {
    if (left === 0 && after === 0n) {
      return { verdict: "reproduced", why: null, anchor: i < 0 ? "before every fill Postgres records in the token" : `after ${steps[i]!.ref}`, walked };
    }
    if (i < 0) {
      return { verdict: "unproven", anchor: null, walked, why: `walked back through every fill Postgres records in ${token}, the book still held ${after} base units ` +
        "before the first of them: what it held from before them, or from outside a fill, is not on the books" };
    }
    const s = steps[i]!;
    if (s.illegible) return { verdict: "unproven", why: s.illegible, anchor: null, walked };
    const before = s.side === "buy" ? after - s.qty : after + s.qty;
    walked.push({ ref: s.ref, at: s.at, side: s.side, qtyRaw: s.qty.toString(), cashUsdg: s.cash, heldBefore: before.toString() });
    if (before < 0n) {
      return { verdict: "exceeds", anchor: null, walked, why: `walking back from the ${o.total} base units of ${token} the book held at the pinned block, ${s.ref} ` +
        `(a ${s.side} of ${s.qty} at ${iso(s.at)}) leaves ${before}: the fills Postgres records and the ones this plan would book are more than the chain holds, ` +
        "so something moved the token that neither records" };
    }
    after = before;
    if (s.proposed) left--;
  }
}

/**
 * THE BASIS THE WALKED FILLS GIVE. PURE.
 *
 * Forward from where a reproduced walk stopped — flat, so nothing — through
 * every fill it walked, oldest first, by the arithmetic the live path books a
 * fill with (basis.ts applyFill: a buy adds its cash, a sell takes cost pro
 * rata, so what a sell was paid never reaches the basis). The quantity is the
 * chain's by construction; the cost is what a basis built from exactly these
 * fills, in this order, holds. Unproven when the walk did not reproduce, or a
 * recorded buy carries no exact cash: a held token then refuses
 * (holdingVerdict), whichever way its trades go.
 */
export interface CostReplay {
  verdict: "replayed" | "unproven";
  why: string | null;
  /** That basis, in base units and micro-USDG. Null unless replayed. */
  basis: { qtyRaw: string; costUsdg: string } | null;
}
export function replayBasis(walk: FillWalk): CostReplay {
  if (walk.verdict !== "reproduced") return { verdict: "unproven", basis: null, why: "the fills were not walked back to where the basis opened" };
  let basis: BasisRow = ZERO_BASIS;
  for (const s of [...walk.walked].reverse()) {
    if (s.side === "buy" && s.cashUsdg === null) {
      return { verdict: "unproven", basis: null, why: `${s.ref} records no exact cash for its buy (fill_cash_usdg), so what it added to the basis's cost is not on the books` };
    }
    // A sell's cash is its proceeds: applyFill reads it for realised P&L only, never for the basis.
    basis = applyFill(basis, { side: s.side, qtyRaw: BigInt(s.qtyRaw), cashUsdg: s.cashUsdg === null ? 0n : BigInt(s.cashUsdg) }).basis;
  }
  return { verdict: "replayed", why: null, basis: { qtyRaw: basis.qtyRaw.toString(), costUsdg: basis.costUsdg.toString() } };
}

/** Which check refused a trade's holding, by name (evidence.holding.refusal). */
export type HoldingRefusal = "positions-ambiguous" | "balance-unread" | "class-vault-held" | "position-unreadable" | "position-differs" | "basis-missing"
  | "basis-unreadable" | "basis-differs" | "position-stale" | "basis-stale" | "held-unrecorded" | "basis-without-position" | "fills-exceed-chain"
  | "fills-unproven" | "basis-cost-differs" | "cost-unproven";
export interface HoldingVerdict {
  /** Null is yes. */
  why: string | null;
  refusal: HoldingRefusal | null;
  evidence: Record<string, unknown>;
  /** What a reviewer should know that does not refuse: for a token nobody holds, a walk the records did not allow, and why it was not needed. */
  notes: string[];
}

/**
 * A LIVE COST BASIS LEFT OVER A TOKEN NOBODY HOLDS. PURE. Null when there is
 * none: no live basis under a name the token has gone by covers a quantity.
 *
 * HOW ONE ARISES, as Shogun's TSLA did: Postgres records a buy with no fill
 * (side and quantity null), the chain holds a buy Postgres never recorded
 * (what this tool books), and Postgres records one sell of both lots
 * together, which took the book flat; yet the live basis still covers one
 * lot, and was written after that sell (holdingVerdict lists ways a basis
 * can lack a recorded fill). Its cost cannot be replayed (a buy carries no
 * fill), and nothing here can say what it should be.
 *
 * IT IS PASSED OVER ONLY WHERE IT PROVABLY CANNOT REACH THE NEW BOOK, and
 * then it is not booked, not changed, and named: its rows in the evidence
 * (so in the previewDigest, and compared again by the apply as part of the
 * holdings), and a note saying why. Every one of these must hold:
 *
 *   the chain holds none   every address of the book was read at the pinned
 *                          block, the class vault's among them when the grant
 *                          names one, and each read 0;
 *   the seed cannot carry  admission seeds the new book's basis only for a
 *     it                   symbol positions shows held — raw_balance <> '0'
 *                          (ledger-resume.ts planAttestedSeed, and the
 *                          ordinary seed, orchestrator.ts seedBasisForChild,
 *                          by the same predicate) — and no positions row is
 *                          held under any name the token has gone by: not for
 *                          this token, and not for another token under the
 *                          same symbol, which the seed would hand this cost.
 *                          And planAttestedSeed itself, asked on the same
 *                          read (Holdings.seeded), carries none of those
 *                          names: the seed's own code, not a copy of it;
 *   it does not outlive    the new book's worker registers under the grant's
 *     admission            spelling of the account as it stands when the
 *                          worker spawns (store.ts ensureAgent), and the first
 *                          mirror pass after it does deletes the account's
 *                          cost_basis in any letter-case (ledger-mirror.ts:
 *                          lower(agent_id) = lower(?)), keeping only the new
 *                          book's own rows. So a grant re-signed under another
 *                          letter-case of the account between the apply and
 *                          that spawn changes nothing: the row is still the
 *                          account's, and still deleted. That pass is not a
 *                          rebuilt one: registration removed the lost book's
 *                          cursors (ledger-import.ts
 *                          registerAttestedGapSource), and only a cursor
 *                          the book no longer matches (its row gone, or
 *                          another there) reads as one. And every row is
 *                          spelled exactly as the grant spells the account
 *                          at the preview and the apply. That is what a
 *                          mirror built before its delete took any
 *                          letter-case needs (it matched the worker's
 *                          spelling exactly), so the verdict does not rest
 *                          on which build the orchestrator runs; only the
 *                          newer build also covers a re-sign in between.
 *
 * Until that pass the row stays what it is today, and nothing that acts on
 * a basis can reach it: both seeds filter by held symbols, and every page
 * that values a holding joins basis to a positions row of the same agent and
 * symbol (desk-positions.ts, read-agent.ts, read-token.ts, portfolio.ts), so
 * it shows only beside a positions row under its name that holds 0 — the
 * note says so when there is one. The one reader that lists a basis with no
 * position is the owner's report export (reports.ts portfolioTable), for the
 * book the agent is not running (newest equity mark of the other mode), as
 * "not valued"; the note says that too. holdingVerdict's walk must still not
 * go below zero (fills-exceed-chain).
 */
export interface StaleBasis {
  /** Null: passed over, and `note` says why. Otherwise the check that refused, in words. */
  why: string | null;
  note: string | null;
  evidence: {
    /** The live basis rows under a name the token has gone by that still cover a quantity: not booked and not changed. */
    rows: Holdings["basis"];
    /** Every name the token has gone by here. */
    names: string[];
    /** Positions rows the seed reads as held (raw_balance <> '0') for the token or under any of those names. None, to pass. */
    heldUnderNames: Holdings["positions"];
    /** What planAttestedSeed carries under any of those names (null: it could not be asked). None, to pass. */
    seededUnderNames: NonNullable<Holdings["seeded"]> | null;
    /** Every positions row under those names: the dashboard shows the basis beside these until the first mirror pass. */
    positionsUnderNames: Holdings["positions"];
    /**
     * The account as the grant spells it, as every row here must be. The
     * attested book's first mirror pass deletes its cost_basis by this account
     * in any letter-case (a mirror built before that, by this spelling exactly).
     */
    deletedAs: string | null;
    note: string | null;
  };
}
export function staleBasisVerdict(o: { token: string; names: ReadonlySet<string>; holdings: Holdings; balance: ChainEvidence["balances"][string];
  classVault: string | null; grantSpelling: string | null }): StaleBasis | null {
  const { token, holdings, balance } = o;
  const rows = holdings.basis.filter((b) => o.names.has(b.symbol) && baseUnits(b.qtyRaw) !== 0n);
  if (!rows.length) return null;
  const names = [...o.names].sort(byText);
  const stale = new Set(rows.map((b) => b.symbol));
  const heldUnderNames = holdings.positions.filter((p) => p.rawBalance !== "0" && (p.token === token || o.names.has(p.symbol)));
  const seededUnderNames = holdings.seeded === null ? null : holdings.seeded.filter((b) => o.names.has(b.symbol));
  const positionsUnderNames = holdings.positions.filter((p) => o.names.has(p.symbol));
  const evidence: StaleBasis["evidence"] = { rows, names, heldUnderNames, seededUnderNames, positionsUnderNames, deletedAs: o.grantSpelling, note: null };
  const opening = `the book held none of ${token} on chain at the pinned block and Postgres holds no position in it, yet its live cost basis under ` +
    rows.map((b) => `${b.symbol} still covers ${b.qtyRaw}`).join(", ");
  const no = (why: string): StaleBasis => ({ why: `${opening}: ${why}`, note: null, evidence });
  if (Object.values(balance.by).some((v) => v !== "0")) {
    return no(`the book's balance at the pinned block is not 0 at every address (${saidBy(balance)}), so the chain holding none is not proved`);
  }
  if (o.classVault !== null && balance.by[o.classVault] !== "0") {
    return no(`the account's Pons class vault ${o.classVault} was not read at the pinned block, so the chain holding none is not proved`);
  }
  if (heldUnderNames.length) {
    return no(`Postgres's positions hold ${heldUnderNames.map((p) => `${p.symbol} (${p.token}) at ${p.rawBalance}`).join(", ")}, under a name ${token} has gone by: ` +
      "admission seeds a basis for every symbol positions shows held (planAttestedSeed), so this basis would be carried into the new book beside a holding it " +
      "does not account for");
  }
  if (seededUnderNames === null) return no("what admission would seed could not be asked here (a table planAttestedSeed reads is not in this database)");
  if (seededUnderNames.length) {
    return no(`admission's own seed, asked on this same read (planAttestedSeed), would carry ${seededUnderNames.map((b) => `${b.symbol} at ${b.qtyRaw}`).join(", ")} ` +
      "into the new book");
  }
  const misspelled = rows.filter((b) => b.agentId !== o.grantSpelling);
  if (o.grantSpelling === null || misspelled.length) {
    return no(`${misspelled.map((b) => `the row under ${b.symbol} is spelled ${b.agentId}`).join(", ")}, not as the grant spells the account ` +
      `(${o.grantSpelling ?? "no grant"}): a ledger mirror from before its snapshot deletes took the account in any letter-case (ledger-mirror.ts) deletes ` +
      "the tenant's cost_basis by the worker's spelling exactly, so whether the row outlives admission would rest on which build the orchestrator runs");
  }
  const cost = (b: Holdings["basis"][number]) => (baseUnits(b.costUsdg) === null ? `"${b.costUsdg}"` : `${usdg6(b.costUsdg)} USDG`);
  const beside = [...new Set(positionsUnderNames.filter((p) => stale.has(p.symbol)).map((p) => p.symbol))];
  const note = `${token}: Postgres's live cost basis under ${rows.map((b) => `${b.symbol} (${b.qtyRaw} base units at ${cost(b)}, written ${iso(b.updatedAt)})`)
    .join(", ")} is left over a token the book does not hold: the chain held none of it at the pinned block at any address of the book, and no position under ` +
    `${names.join(", ")} is held. It is not booked here and not changed. It cannot reach the attested book: admission seeds a basis only for a symbol ` +
    "positions shows held, and its own seed, asked on this read (planAttestedSeed), carries none of it; and the first mirror pass after the new book's worker " +
    `arms deletes every cost_basis row of the account in any letter-case, keeping only the new book's own (registration removed the lost book's cursors, ` +
    `so that pass is not a rebuilt one). This one is spelled ${o.grantSpelling}, as the grant spells the account, so a mirror from before that delete took ` +
    "any letter-case deletes it too, so long as the grant is not re-signed under another letter-case of the account before the worker arms; the delete " +
    "that takes any letter-case covers that as well. Until that pass it is read only as it is today, and acts on nothing: " + (beside.length
    ? `the dashboard shows this cost beside the positions row(s) under ${beside.join(", ")} that hold 0`
    : "no page that values a holding shows it, since each joins basis to a positions row under its name and there is none") +
    "; and the owner's report export lists it, as not valued, only while the agent's newest equity mark is paper";
  return { why: null, note, evidence: { ...evidence, note } };
}

/**
 * DOES THE SNAPSHOT THE ATTESTED BOOK IS SEEDED FROM ALREADY HOLD WHAT THE
 * CHAIN DOES IN THIS TOKEN, ONCE THE MISSING TRADES ARE INCLUDED? PURE. Null
 * `why` is yes.
 *
 * WHY A TRADE ROW ALONE IS NOT ENOUGH. Admission seeds the new book's cost
 * basis from Postgres's cost_basis, for exactly the symbols Postgres's
 * positions show held (ledger-resume.ts planAttestedSeed). Both are the lost
 * book's last mirrored snapshot. If that snapshot leaves out a booked BUY, the
 * new book holds the token with no basis, or with a basis for less than it
 * holds — and both mechanical exits measure from that basis. If it leaves out
 * a booked SELL, the seed restores a basis for more than the account holds,
 * and a later buy averages against it. The in-flight reconciler avoids both
 * by booking the basis beside its row (bookFill); this tool writes no basis,
 * so it proves the snapshot's CONTENTS already reflect the trade instead.
 *
 * WHEN THE SNAPSHOT WAS WRITTEN IS NEVER ENOUGH. A missed buy followed by an
 * ordinary buy rewrites both rows after the missed one, and the basis can
 * still leave the missed fill out. So the quantities are compared with the
 * chain itself, at the pinned block (readChainEvidence: admission's head less
 * BOOKING_CONFIRMATIONS, so every booked fact is in it), across the book as
 * the fill was read (the account and its custody):
 *
 *   held in the snapshot   the position's raw balance AND its live basis's
 *                          quantity each equal the book's balance there; the
 *                          position and basis were written at or after the
 *                          last trade in the token (necessary, never
 *                          sufficient alone); the fills since the basis last
 *                          opened, recorded and proposed, reproduce that
 *                          quantity from flat (walkFills) — fills that cannot
 *                          be walked refuse; and the basis's cost is no other
 *                          than those fills give (replayBasis) — refused when
 *                          it differs, and when it cannot be replayed;
 *   not held               the book holds none of the token there, no live
 *                          basis under any name the token has gone by still
 *                          covers a quantity — or one does, and provably
 *                          cannot reach the new book (staleBasisVerdict: the
 *                          seed cannot carry it and the first mirror pass
 *                          deletes it), and it is named, never booked or
 *                          changed — and the fills are never more than the
 *                          chain holds; so a seed with no position and no
 *                          basis for it is the truth, whatever it cost.
 *
 * WHY A HELD TOKEN NEEDS THE COST, WHICHEVER WAY ITS TRADES GO. The quantity
 * checks show the basis holds what the chain does; they cannot show it was
 * built from every fill. A buy and a sell that net to nothing leave the
 * quantity as it was and the cost wrong — the stop-loss and take-profit would
 * measure from a price the book never paid — and only one of the two need be
 * booked here: the other can be a fill Postgres records that the basis never
 * had. The in-flight reconciler writes its row and skips bookFill for a token
 * it does not watch, and the history repair fills that row in later
 * (history-fill-repair.ts); and the mirrored cost_basis can be stale, left by
 * a delete the mirror skipped while the child read rebuilt (basis-seed.ts).
 * Nothing here can prove the basis is exactly applyFill over the fills
 * recorded since its anchor, so the
 * cost is replayed and must equal the basis's, and a cost that cannot be
 * replayed (a walked buy with no exact cash on record) refuses
 * (cost-unproven). Only a token nobody holds books without it: nothing is
 * seeded for it.
 *
 * THE CLASS VAULT. Positions and cost_basis cover the account and its Trencher
 * vault (the worker merges the vault's balance into the position); a Pons
 * class vault's holding is the class book (class_positions), seeded apart. A
 * class vault holding the token refuses by name: this tool does not judge
 * that seed.
 *
 * A balance that could not be read proves nothing, so it refuses. Anything
 * else is a reviewed basis decision, never this tool's: the trade and its legs
 * stay unresolved, and the tenant stays held.
 */
export function holdingVerdict(o: { token: string; holdings: Holdings; fills: readonly RecordedFill[]; balance: ChainEvidence["balances"][string] | null;
  proposed: readonly ProposedFill[]; classVault: string | null; grantSpelling: string | null }): HoldingVerdict {
  const { token, holdings, balance } = o;
  const lastTradeAt = Math.max(...o.proposed.map((p) => p.at));
  const rows = holdings.positions.filter((p) => p.token === token);
  const position = rows[0] ?? null;
  // Held exactly as the seed reads it: raw_balance <> '0'.
  const held = rows.some((p) => p.rawBalance !== "0");
  const basis = position ? holdings.basis.find((b) => b.symbol === position.symbol) ?? null : null;
  // Every name the token has gone by here: its position's, the proposals', and the recorded fills' that name it by address.
  const symbols = new Set([...rows.map((p) => p.symbol), ...o.proposed.flatMap((p) => (p.symbol ? [p.symbol] : [])),
    ...o.fills.filter((f) => f.buyToken === token || f.sellToken === token).flatMap((f) => (f.symbol ? [f.symbol] : []))]);
  const namedBasis = holdings.basis.filter((b) => symbols.has(b.symbol));
  const total = balance && balance.total !== null ? BigInt(balance.total) : null;
  const fills = total === null ? null : walkFills({ token, fills: o.fills, proposed: o.proposed, symbols, total });
  const cost = fills === null ? null : replayBasis(fills);
  const evidence = { lastTradeAt, position, basis, namedBasis, bookBalance: balance, fills, cost };
  const refuse = (refusal: HoldingRefusal, why: string, extra: Record<string, unknown> = {}): HoldingVerdict =>
    ({ why, refusal, evidence: { ...evidence, ...extra, refusal }, notes: [] });
  const decide = "a reviewed basis decision, or the tenant stays held";

  if (rows.length > 1) return refuse("positions-ambiguous", `Postgres holds ${rows.length} position rows for ${token}, so which one the seed would read is not one answer`);
  if (!balance || total === null) {
    return refuse("balance-unread", `the book's balance of ${token} at the pinned block could not be read${balance ? ` (${saidBy(balance)})` : ""}, so whether ` +
      "Postgres's position and cost basis hold what the chain does once this trade is included cannot be proved — preview again");
  }
  const inClass = o.classVault === null ? null : balance.by[o.classVault] ?? null;
  if (inClass !== null && inClass !== "0") {
    return refuse("class-vault-held", `the account's Pons class vault ${o.classVault} held ${inClass} base units of ${token} at the pinned block: Postgres's positions and ` +
      "cost basis cover the account and its Trencher vault, and a class holding is the class book (class_positions), seeded apart — so whether the seed holds " +
      `what the chain does cannot be judged here — ${decide}`);
  }
  if (!held) {
    if (total !== 0n) {
      return refuse("held-unrecorded", `the book held ${total} base units of ${token} on chain at the pinned block (${saidBy(balance)}), and the snapshot the attested ` +
        `book is seeded from holds none: it would hold a position with no cost basis, which both mechanical exits refuse — ${decide}`);
    }
    // A BASIS LEFT OVER THE FLAT TOKEN is passed over only where it provably
    // cannot reach the new book, and is then named, never booked or changed (staleBasisVerdict).
    const stale = staleBasisVerdict({ token, names: symbols, holdings, balance, classVault: o.classVault, grantSpelling: o.grantSpelling });
    const extra = stale ? { staleBasis: stale.evidence } : {};
    if (stale?.why) return refuse("basis-without-position", `${stale.why} — ${decide}`, extra);
    if (fills!.verdict === "exceeds") return refuse("fills-exceed-chain", `${fills!.why} — ${decide}`, extra);
    // NOTHING IS SEEDED for a token nobody holds, so what its fills cost cannot reach the new book: an unwalkable history is said, not refused.
    return { why: null, refusal: null, evidence: { ...evidence, ...extra, refusal: null }, notes: [
      ...(stale?.note ? [stale.note] : []),
      ...(fills!.verdict === "unproven"
        ? [`${token}: none of it is held, on chain or in the snapshot, so the attested book is seeded with nothing for it; its recorded fills could not be walked back ` +
          `to where its basis opened (${fills!.why})`]
        : []),
    ] };
  }
  const p = position!;
  const raw = baseUnits(p.rawBalance);
  if (raw === null) return refuse("position-unreadable", `Postgres's position in ${p.symbol} (${token}) holds "${p.rawBalance}", not a count of base units`);
  if (raw !== total) {
    return refuse("position-differs", `Postgres's position in ${p.symbol} (${token}) holds ${raw} base units, and the book held ${total} on chain at the pinned block ` +
      `(${saidBy(balance)}): the snapshot the attested book is seeded from is not the chain's once this trade is included — ${decide}`);
  }
  if (!basis) {
    return refuse("basis-missing", `Postgres holds a position in ${p.symbol} (${token}) with no live cost basis: the attested book would hold it with nothing for ` +
      `its stop-loss or take-profit to measure from — ${decide}`);
  }
  const qty = baseUnits(basis.qtyRaw);
  if (qty === null) return refuse("basis-unreadable", `Postgres's live cost basis for ${p.symbol} covers "${basis.qtyRaw}", not a count of base units`);
  if (qty !== total) {
    return refuse("basis-differs", `Postgres's live cost basis for ${p.symbol} covers ${qty} base units, and the book held ${total} on chain at the pinned block ` +
      `(${saidBy(balance)}): the basis does not account for what the chain did — a fill the lost book never booked to it, for one — so the attested book ` +
      `would be seeded with a cost for the wrong quantity — ${decide}`);
  }
  if (p.updatedAt === null || p.updatedAt < lastTradeAt) {
    return refuse("position-stale", `Postgres's position in ${p.symbol} (${token}) was last written ${iso(p.updatedAt)}, before the tenant's last trade in it ` +
      `(${iso(lastTradeAt)}): the attested book is seeded from that snapshot and would not know what the trade did — ${decide}`);
  }
  if (basis.updatedAt === null || basis.updatedAt < lastTradeAt) {
    return refuse("basis-stale", `Postgres's cost basis for ${p.symbol} was last written ${iso(basis.updatedAt)}, before the tenant's last trade in it ` +
      `(${iso(lastTradeAt)}): the attested book would be seeded with a basis that leaves the trade out — ${decide}`);
  }
  if (fills!.verdict === "exceeds") return refuse("fills-exceed-chain", `${fills!.why} — ${decide}`);
  // A HELD TOKEN'S FILLS MUST BE WALKED: the seed carries its basis into the new book, and a quantity no fill history accounts for is not one
  // this tool can say the trade is in.
  if (fills!.verdict !== "reproduced") {
    return refuse("fills-unproven", `the fills Postgres records in ${token} could not be walked back to where its basis opened (${fills!.why}): the position and basis ` +
      "hold the chain's quantity, but that the basis was built from the fills that put it there, this trade's among them, cannot be proved, and the attested book " +
      `would be seeded from it — ${decide}`);
  }
  const costUsdg = baseUnits(basis.costUsdg);
  if (costUsdg === null) return refuse("basis-unreadable", `Postgres's live cost basis for ${p.symbol} costs "${basis.costUsdg}", not a count of micro-USDG`);
  if (cost!.verdict === "replayed" && (cost!.basis!.qtyRaw !== qty.toString() || cost!.basis!.costUsdg !== costUsdg.toString())) {
    return refuse("basis-cost-differs", `Postgres's live cost basis for ${p.symbol} holds ${qty} base units at a cost of ${usdg6(costUsdg.toString())} USDG, and the ` +
      `fills since it last opened (${fills!.anchor}), with the trades booked here, give ${cost!.basis!.qtyRaw} at ${usdg6(cost!.basis!.costUsdg)} USDG: the basis was ` +
      "not built from those fills — a buy and a sell the lost book never booked to it, for one — so the attested book's stop-loss and take-profit would measure " +
      `from a cost it never paid — ${decide}`);
  }
  // A HELD TOKEN'S COST MUST BE REPLAYED, whichever way the trades booked here go: a buy and a sell that net to nothing — one of them booked
  // here, the other a fill Postgres records that the basis never had — leave every quantity above as it was and the cost wrong.
  if (cost!.verdict !== "replayed") {
    return refuse("cost-unproven", `Postgres's live cost basis for ${p.symbol} holds the chain's ${qty} base units at a cost of ${usdg6(costUsdg.toString())} USDG, ` +
      `and what the fills since it last opened (${fills!.anchor}) cost cannot be replayed to check it (${cost!.why}): a basis of the chain's quantity can still ` +
      "leave out a buy and a sell that net to nothing — this trade, and a fill Postgres records that the lost book never booked to the basis, for one — and " +
      `the attested book's stop-loss and take-profit would measure from a cost it never paid — ${decide}`);
  }
  return { why: null, refusal: null, evidence: { ...evidence, refusal: null }, notes: [] };
}

/**
 * CLASSIFY EVERY FACT AND PROPOSE ITS ROW. PURE: the snapshot and the chain
 * evidence in, the plan and its digest out. Nothing here reads or writes.
 */
export function planBooking(snap: BookingSnapshot, ev: ChainEvidence, o: { nowSec: number; source: unknown; target: string }): BookingPlan {
  const refusals: string[] = [];
  const warnings: string[] = [];
  const account = snap.grant?.account ?? null;
  const agent = snap.agents.length === 1 ? snap.agents[0]! : null;
  if (!snap.grant) refusals.push("no stored grant names this tenant's account: there is nothing to read the chain for");
  if (!snap.agents.length) refusals.push("the account has no agent registration, so no epoch to file a row under");
  if (snap.agents.length > 1) refusals.push(`the account is registered under ${snap.agents.length} spellings`);
  if (snap.spellings.length > 1) refusals.push(`agent_id is spelled ${snap.spellings.length} ways across the financial tables (admission refuses this tenant until that is repaired)`);
  const agentId = snap.spellings.length === 1 ? snap.spellings[0]! : snap.spellings.length === 0 && agent ? agent.smartAccount : null;
  const chainId = snap.grant?.chainId ?? null;
  if (snap.grant && agent && agent.chainId !== null && chainId !== null && agent.chainId !== chainId) refusals.push("the grant and the registration name different chains");
  if (chainId !== null && ev.rpcChainId !== chainId) refusals.push(`the RPC serves chain ${ev.rpcChainId}, and the grant is on chain ${chainId}`);
  if (snap.openApproval) {
    refusals.push(`an approval is open (${snap.openApproval.state}, evidence ${snap.openApproval.evidence.slice(0, 12)}…): withdraw it with ` +
      `MERRYMEN_RESUME_REVOKE=${snap.tenant}:${snap.openApproval.evidence} and deploy first — a booking changes the evidence it was approved on`);
  }
  if (snap.admitted) refusals.push(`already admitted (attested generation ${snap.admitted.slice(0, 8)}…): its running book's own reconciler books what it lacks`);
  if (ev.gap.status === "unavailable") refusals.push(`the chain could not be read (${ev.gap.why}); preview again`);
  // HELD, OR NOTHING (holdOf): the newest decision a chain refusal, nothing
  // written for the tenant since, and only facts from before it.
  const hold = holdOf(snap, o.nowSec);
  refusals.push(...hold.refusals);

  const found = ev.gap.status === "missing" ? ev.gap.found : [];
  const head = ev.gap.status === "unavailable" ? null : BigInt(ev.gap.head);
  const book = account ? [account, ...(snap.grant?.custody ?? [])] : [];
  const epoch = agent?.epoch ?? null;
  const items: BookingItem[] = [];
  const unresolved = (base: Omit<BookingItem, "class" | "why" | "proposal">, why: string, cls: ItemClass = "unresolved"): BookingItem =>
    ({ ...base, class: cls, why, proposal: null });

  // Facts that are not deep enough, not canonical, or not in this epoch are
  // refused on the same terms whatever they are.
  const settled = (f: MissingChainFact, tx: TxEvidence | undefined): string | null => {
    if (!tx?.receipt || !tx.block) return `its transaction's receipt or block could not be read`;
    if (tx.receipt.status !== "0x1") return `its transaction did not succeed`;
    if (tx.block.hash !== tx.receipt.blockHash) return `the receipt's block ${tx.receipt.blockHash} is not the canonical block ${tx.block.hash} at that height`;
    const at = BigInt(tx.block.number);
    if (factBlock(f) !== null && factBlock(f) !== at) return `the log says block ${f.block} and the receipt says block ${at}`;
    if (head === null || head - at < BOOKING_CONFIRMATIONS) return `it is not yet ${BOOKING_CONFIRMATIONS} blocks deep; preview again shortly`;
    if (epoch === null) return `the account's epoch cannot be named`;
    // AN EPOCH WITH NO ROW CANNOT BE DATED. The opening is read as the
    // earliest row of the current epoch; with none, a fact of any age would
    // pass as this epoch's — the very guess this tool does not make.
    if (snap.epochOpenedAt === null) {
      return `accounting epoch ${epoch} holds no trade, flow or equity row yet, so when it opened cannot be dated, and which epoch this belongs to is not this tool's to say`;
    }
    if (tx.block.timestamp < snap.epochOpenedAt) {
      return `it landed before accounting epoch ${epoch} opened (${iso(snap.epochOpenedAt)}), so which epoch it belongs to is not this tool's to say`;
    }
    // ONLY WHAT ADMISSION REFUSED THE TENANT ON (holdOf): a fact that landed
    // after the refusal — or within a minute before it, where the chain's
    // clock and the orchestrator's are not compared to the second — was never
    // proved missing from the book a worker would run on.
    if (hold.anchorSec !== null && tx.block.timestamp > hold.anchorSec - ANCHOR_MARGIN_SEC) {
      return `it landed at ${iso(tx.block.timestamp)}, not before admission's chain refusal of this tenant at ${iso(hold.anchorSec)}, so no admission has ` +
        "found it missing from the book a worker would run on: let admission refuse the tenant again (fleet-resume.md), then preview again";
    }
    return null;
  };

  for (const f of found) {
    const tx = ev.txs[f.txHash];
    const base = { key: keyOf(f), fact: f, said: describeChainFact(f), evidence: {
      txHash: f.txHash, block: tx?.block?.number ?? f.block, blockHash: tx?.block?.hash ?? null, blockTime: tx?.block?.timestamp ?? null, logIndex: f.logIndex,
    } as Record<string, unknown> };
    if (!account || !agentId || epoch === null) { items.push(unresolved(base, "the tenant's account, spelling or epoch cannot be named (see the refusals)")); continue; }
    // AN IDENTITY OR NOTHING: a row is booked once by its hash or its tx#log,
    // so a fact without a full 32-byte hash and a log index has none.
    if (!HASH.test(f.txHash) || (f.kind === "operation" ? !HASH.test(f.userOpHash) : f.logIndex === null)) {
      items.push(unresolved(base, "the log does not name it by a full transaction hash and log index, so it could not be booked exactly once"));
      continue;
    }
    const bad = settled(f, tx);
    if (bad) { items.push(unresolved(base, `not booked: ${bad}`)); continue; }
    const receipt = tx!.receipt!, blockTime = tx!.block!.timestamp;
    const legs = accountUsdgLogs(receipt.logs, account);

    if (f.kind === "operation") {
      const op = readOp(receipt, f.userOpHash, account, book);
      if (!op) { items.push(unresolved(base, "the receipt does not carry this as the account's own operation through EntryPoint v0.7")); continue; }
      const validator = validatorOfNonce(op.seg.op.nonce);
      const sponsored = !/^0x0{40}$/.test(op.seg.op.paymaster);
      base.evidence = { ...base.evidence, userOpHash: f.userOpHash, nonce: op.seg.op.nonce.toString(), validator, success: op.seg.op.success,
        paymaster: op.seg.op.paymaster, gasWei: op.gasWei.toString(), gasUnits: op.gasUnits.toString(), bookAddresses: book, moved: saidDeltas(op.deltas) };
      if (validator === "root") {
        // WHAT ADMISSION WOULD MAKE OF IT, AS EVIDENCE ONLY: the owner reading
        // re-derived from this receipt over the grant's custody (the one an
        // owner record answers by, ledger-resume.ts ownerAnswersFor), and the
        // record Postgres holds for it, if any. Neither changes the class or
        // the refusal: this tool never books an owner's operation.
        const reading = ownerOperationOf({ receiptLogs: receipt.logs, userOpHash: f.userOpHash, txHash: f.txHash, account, custody: snap.grant?.custody ?? [],
          usdg: USDG, chainId: chainId ?? 4663 });
        const record = snap.ownerRecords.filter((r) => r.userOpHash === f.userOpHash);
        base.evidence = { ...base.evidence,
          ownerReading: reading && { disposition: reading.disposition, reasons: reading.reasons, covers: reading.covers, usdgLegs: reading.usdgLegs, tokenMoves: reading.tokenMoves },
          ownerRecord: record.length ? record.map(({ disposition, reviewReason, tenant, chainId: c, txHash }) => ({ disposition, reviewReason, tenant, chainId: c, txHash })) : null };
        const recorded = record.length
          ? ` Postgres holds an owner record for it (${record.map((r) => r.disposition + (r.reviewReason ? `: ${r.reviewReason}` : "")).join(", ")}), and admission ` +
            "did not take it as an answer: only an acknowledged record that the receipt re-derives as acknowledged answers an owner's operation."
          : reading
            ? ` No owner record is in Postgres for it; re-derived from the receipt it would be '${reading.disposition}'` +
              `${reading.reasons.length ? ` (${reading.reasons.join(", ")})` : ""} (docs/owner-operations.md).`
            : "";
        items.push(unresolved(base, `the owner's own key (the root validator) signed this operation (it moved ${saidDeltas(op.deltas)}): ` +
          "the agent's book has no writer for an owner's operation, and booking it as the agent's trade would misattribute it — escalate for a reviewed decision." + recorded,
        "owner-operation"));
        continue;
      }
      if (validator !== "permission") {
        items.push(unresolved(base, validator === "secondary" ? "a secondary validator, neither the owner's root key nor a session key, signed this operation"
          : `its nonce key names no validator this tool reads`));
        continue;
      }
      const segIdx = new Set(op.seg.logs.map((l) => Number(BigInt(l.logIndex))));
      const outside = legs.filter((l) => !segIdx.has(Number(BigInt(l.logIndex))));
      if (outside.length) {
        items.push(unresolved(base, `the transaction carries ${outside.length} USDG transfer(s) of the account outside this operation's execution, ` +
          "and a row for this operation would cover them in admission's check without booking them"));
        continue;
      }
      const gas = sponsored ? { gas_wei: null, sponsored_gas_wei: op.gasWei.toString() } : { gas_wei: op.gasWei.toString(), sponsored_gas_wei: null };
      const row: TradeProposal = {
        agent_id: agentId, kind: "swap", target: agentId, sell_token: null, buy_token: null, amount_usdg: 0,
        user_op_hash: f.userOpHash, tx_hash: f.txHash, status: "landed", reject_rule: null, decision_id: null,
        fill_side: null, fill_symbol: null, fill_qty_raw: null, fill_price_usd: null, realized_pnl_usdg: null, basis_source: null,
        ...gas, gas_usdg: null, gas_units: op.gasUnits > 0n ? op.gasUnits.toString() : null, fill_cash_usdg: null,
        epoch, created_at: blockTime, budget_settled_at: null,
      };
      if (!op.seg.op.success) {
        items.push({ ...base, class: "session-reverted", why: "a session key's operation the EntryPoint recorded as failing: it moved nothing and counts toward no cap. " +
          `Booked as a resolved revert is (status 'reverted', '${REVERTED_RULE}', its gas), notional 0 because the intent's is gone with the lost book`,
        proposal: { table: "trades", row: { ...row, status: "reverted", reject_rule: REVERTED_RULE } } });
        continue;
      }
      const moved = [...op.deltas].filter(([, v]) => v !== 0n);
      if (!moved.length) {
        items.push({ ...base, class: "session-no-movement", why: "a session key's operation that moved nothing across the book's edge (an approval, a key install, a probe). " +
          "Booked as the in-flight reconciler books an unattributed orphan: kind 'swap', notional 0, so its hash is known and the operation counted",
        proposal: { table: "trades", row: { ...row, basis_source: "receipt" } } });
        continue;
      }
      const leg = pickAcquiredLeg(op.deltas, USDG);
      if (!leg) {
        const onlyUsdg = moved.every(([t]) => t === USDG);
        const energy = moved.some(([t]) => isEnergyReserveToken(t));
        items.push(unresolved(base, energy
          ? `a session key's energy purchase (${saidDeltas(op.deltas)}): the worker books it as an 'energy-buy' flow that moves both peaks, beside its row — ` +
            "not one row this tool can propose"
          : onlyUsdg
            ? `a session key moved USDG (${saidDeltas(op.deltas)}) with nothing visible the other way: a transfer home or an energy purchase books a flow beside its row, ` +
              "which is not one row this tool can propose"
            : `a session key's operation moved ${saidDeltas(op.deltas)}: not one token against USDG in opposite directions, so no fill can be read without choosing one`));
        continue;
      }
      const decimals = ev.decimals[leg.token] ?? null;
      const price = decimals === null ? null : usdgNumber(leg.cashUsdg) / (Number(leg.qtyRaw) / 10 ** decimals);
      base.evidence = { ...base.evidence, fill: { token: leg.token, side: leg.side, qtyRaw: leg.qtyRaw.toString(), cashRaw: leg.cashUsdg.toString(), decimals,
        decimalsReadAt: "latest" } };
      items.push({ ...base, class: "session-trade", why: `a session key's ${leg.side} of ${leg.token}: ${usdg6(leg.cashUsdg.toString())} USDG ${leg.side === "buy" ? "out" : "in"} ` +
        `for ${leg.qtyRaw} base units, read off the receipt over the book (${book.join(", ")}). Booked as the reconciler books a landed orphan, with the fill the live path ` +
        "reads from the same receipt; realised P&L stays NULL (the cost basis at that moment is not on the chain)",
      proposal: { table: "trades", row: {
        ...row, sell_token: leg.side === "buy" ? USDG : leg.token, buy_token: leg.side === "buy" ? leg.token : USDG, amount_usdg: usdgNumber(leg.cashUsdg),
        fill_side: leg.side, fill_symbol: fillSymbolFor(leg.token, []), fill_qty_raw: leg.qtyRaw.toString(), fill_price_usd: price === null || !Number.isFinite(price) ? null : price,
        basis_source: "receipt", fill_cash_usdg: usdgNumber(leg.cashUsdg),
      } } });
      continue;
    }

    // A USDG TRANSFER. Inside an operation of this account that is itself
    // missing, it is that operation's leg (proved inside its execution above).
    const sameTxOp = found.find((g) => g.kind === "operation" && g.txHash === f.txHash);
    if (sameTxOp) {
      items.push({ ...base, class: "operation-leg", why: `a leg of operation ${(sameTxOp as { userOpHash: string }).userOpHash} in the same transaction: its row's tx hash answers it`,
        proposal: null, coveredBy: keyOf(sameTxOp) });
      continue;
    }
    const { segments } = segmentReceipt(receipt.logs);
    const mine = segments.filter((s) => s.op.sender === account);
    if (mine.length) {
      // THE OPERATION THAT CARRIES THIS LEG IS NOT MISSING, so admission
      // answered it: by a trade row, or by an owner record it re-derived from
      // this receipt (ledger-resume.ts ownerAnswersFor). An owner record
      // answers the operation and only the legs it covers itself; it leaves a
      // capital leg to the deposit scanner's flow. So a capital leg with no
      // flow lands here, and is said as exactly that, never as a trade row's.
      const holder = mine.find((s) => s.logs.some((l) => Number(BigInt(l.logIndex)) === f.logIndex)) ?? null;
      const byOwner = holder !== null && !snap.known.ops.includes(holder.op.userOpHash) && snap.known.ownerOps.includes(`${holder.op.userOpHash}|${f.txHash}`);
      if (holder && byOwner) {
        const reading = ownerOperationOf({ receiptLogs: receipt.logs, userOpHash: holder.op.userOpHash, txHash: f.txHash, account, custody: snap.grant?.custody ?? [],
          usdg: USDG, chainId: chainId ?? 4663 });
        const leg = reading?.usdgLegs.find((l) => l.logIndex === f.logIndex) ?? null;
        base.evidence = { ...base.evidence, ownerOperation: holder.op.userOpHash,
          ownerReading: reading && { disposition: reading.disposition, reasons: reading.reasons, covers: reading.covers, usdgLegs: reading.usdgLegs, tokenMoves: reading.tokenMoves },
          ownerLeg: leg };
        const amount = f.amountRaw === null ? "an unread amount of USDG" : `${usdg6(f.amountRaw)} USDG`;
        if (reading?.disposition === "acknowledged" && leg?.answeredBy === "flow") {
          items.push(unresolved(base, `not booked: the ${leg.kind} leg (${amount} ${f.direction === "in" ? "in" : "out"}) of the owner's own operation ` +
            `${holder.op.userOpHash}, which the root validator signed. Admission answers that operation by its acknowledged owner record, re-derived from this ` +
            "receipt, but the record answers the operation only: it leaves this capital leg to the deposit scanner's flow, as it leaves every capital leg, and " +
            "Postgres holds no flow for it. The scanner never booked it (one that landed outside every window a running worker scanned, during downtime for " +
            "one, is never seen). This tool books no owner's capital leg: a flow for it moves the account's capital and its peaks, a reviewed hwm-repair " +
            "decision (docs/owner-operations.md) — escalate"));
          continue;
        }
        items.push(unresolved(base, `not booked: a USDG leg (${amount}) of the owner's own operation ${holder.op.userOpHash}, which an owner record answers in ` +
          `admission's check; re-derived from this receipt, ${reading ? `the reading is '${reading.disposition}' and ${leg ? `reads this leg as ${leg.kind} (${leg.rule}), ` +
            `answered by ${leg.answeredBy}` : "carries no such leg"}` : "the operation does not read as the owner's"}, and nothing in Postgres answers it — escalate`));
        continue;
      }
      items.push(unresolved(base, "an operation of this account that Postgres already holds is in this transaction, yet this leg is not answered — its row's tx hash differs"));
      continue;
    }
    const log = legs.find((l) => f.logIndex !== null && Number(BigInt(l.logIndex)) === f.logIndex);
    if (!log || f.amountRaw === null || BigInt(log.data || "0x0").toString() !== f.amountRaw) {
      items.push(unresolved(base, "the receipt does not carry this transfer as the log read named it"));
      continue;
    }
    const [usdgLeg] = legsFromReceipt([log]);
    const classification = classifyUsdgMovement({
      account, usdg: usdgLeg!, txLegs: legsFromReceipt(receipt.logs), usdgToken: USDG,
      knownAccounts: snap.knownAccounts.filter((a) => a !== account), custodyAddresses: snap.grant?.custody ?? [],
      reserveTokens: energyReserveTokens(chainId ?? 4663),
    });
    base.evidence = { ...base.evidence, from: lower(usdgLeg!.from), to: lower(usdgLeg!.to), amountRaw: f.amountRaw, txFrom: receipt.from, txTo: receipt.to,
      classification: { kind: classification.kind, rule: classification.evidence.rule, why: classification.why } };
    if (f.direction !== "in") {
      items.push(unresolved(base, f.direction === "out"
        ? "USDG left the account in a transaction that carried no operation of the account (an allowance was spent): not a withdrawal anybody can be said to have chosen"
        : "a self-transfer says nothing about capital"));
      continue;
    }
    if (classification.kind !== "capital-in") {
      items.push(unresolved(base, `the chain-capital classifier reads it as ${classification.kind}: ${classification.why} — no writer books that as a flow`));
      continue;
    }
    if (!admitCapitalFlow({ mode: tradingModeOf(agent?.mode), source: "chain-log", txHash: f.txHash }).admit) {
      items.push(unresolved(base, "the paper boundary refuses this flow"));
      continue;
    }
    items.push({ ...base, class: "deposit", why: `USDG ${usdg6(f.amountRaw)} in from ${lower(usdgLeg!.from)}, outside this system, with no operation of the account and nothing paired: ` +
      "an owner's deposit. Booked as the chain-capital reconstruction books one: source 'chain-log', its tx#log, its block time. The peaks are not moved",
    proposal: { table: "flows", row: { agent_id: agentId, direction: "in", amount_usdg: usdgNumber(BigInt(f.amountRaw)), tx_hash: f.txHash, block_number: Number(BigInt(tx!.block!.number)),
      log_index: f.logIndex!, source: "chain-log", epoch, chain_id: chainId!, at: blockTime } } });
  }

  // A TRADE ONLY WHERE THE SEED ALREADY HOLDS WHAT THE CHAIN DOES
  // (holdingVerdict): its contents against the chain at the pinned block,
  // decided per token over every trade booked in it. Before the legs below,
  // so a trade refused here takes its legs with it.
  const tradesIn = new Map<string, BookingItem[]>();
  for (const it of items) {
    if (it.class !== "session-trade" || it.proposal?.table !== "trades") continue;
    const token = it.proposal.row.fill_side === "buy" ? it.proposal.row.buy_token! : it.proposal.row.sell_token!;
    tradesIn.set(token, [...(tradesIn.get(token) ?? []), it]);
  }
  for (const [token, trades] of tradesIn) {
    const proposed: ProposedFill[] = trades.map((it) => {
      const row = it.proposal!.row as TradeProposal;
      // The cash exactly as the receipt moved it, never the row's rounded USDG figure.
      return { key: it.key, side: row.fill_side!, qtyRaw: row.fill_qty_raw!, cashUsdg: (it.evidence.fill as { cashRaw: string }).cashRaw, at: row.created_at,
        symbol: row.fill_symbol };
    });
    const verdict = holdingVerdict({ token, holdings: snap.holdings, fills: snap.fills, balance: ev.balances[token] ?? null, proposed,
      classVault: snap.grant?.classVault ?? null, grantSpelling: snap.grant?.spelled ?? null });
    for (const it of trades) {
      it.evidence = { ...it.evidence, holding: verdict.evidence };
      // Named at the console too: the refusal's name, then its sentence.
      if (verdict.why) { it.class = "unresolved"; it.why = `not booked (${verdict.refusal}): ${verdict.why}`; it.proposal = null; }
    }
    if (!verdict.why) warnings.push(...verdict.notes);
  }

  // An operation's leg is covered only when its operation was proposed.
  for (const it of items) {
    if (it.class !== "operation-leg") continue;
    const op = items.find((x) => x.key === it.coveredBy);
    if (!op?.proposal) { it.class = "unresolved"; it.why = `a leg of ${it.coveredBy?.slice(3)}, which is not booked: it waits on its operation`; }
  }
  const proposals = items.filter((it) => it.proposal);
  const held = {
    ops: new Set(proposals.flatMap((it) => (it.proposal!.table === "trades" ? [it.proposal!.row.user_op_hash] : []))),
    txs: new Set(proposals.flatMap((it) => (it.proposal!.table === "trades" ? [it.proposal!.row.tx_hash] : []))),
    flows: new Set(proposals.flatMap((it) => (it.proposal!.table === "flows" ? [`${it.proposal!.row.tx_hash}:${it.proposal!.row.log_index}`] : []))),
  };
  const remaining = factsStillMissing(found, held);
  for (const it of proposals) {
    if (it.proposal!.table === "trades" && it.proposal!.row.created_at > o.nowSec - 26 * 3600) {
      warnings.push(`${it.key}: settled at ${new Date(it.proposal!.row.created_at * 1000).toISOString()}, inside the 26 hours admission refuses a tenant for; ` +
        `it stays held until ${new Date((it.proposal!.row.created_at + 26 * 3600) * 1000).toISOString()}`);
    }
  }
  if (proposals.some((it) => it.proposal!.table === "flows")) {
    warnings.push("a flow is booked without moving agents.hwm_usdg, hwm_withdrawn_usdg or a risk period: a peak the lost book already moved would move twice. " +
      "A deposit after the last equity mark reads as drift at the first look, and the worker marks contributions unknown rather than guess");
  }
  for (const it of proposals) {
    const fill = it.class === "session-trade" ? (it.evidence.fill as { token: string; decimals: number | null }) : null;
    if (fill && fill.decimals === null) {
      warnings.push(`${it.key}: decimals() of ${fill.token} could not be read, so its fill_price_usd stays NULL; side, quantity and cash are booked`);
    }
  }
  if (proposals.some((it) => it.class === "session-trade")) {
    warnings.push("a trade is booked without touching cost_basis, positions or position_floors, because what the attested book is seeded with already " +
      `holds what the chain does in its token at block ${ev.balanceBlock} (each trade's evidence.holding says how, and a basis left over a flat token is named ` +
      "in its own note): check its positions, basis and floors on the dashboard at exits-only all the same");
  }
  const blocked = items.some((it) => !it.proposal && it.class !== "operation-leg") || remaining.length > 0;
  const verdict: BookingPlan["verdict"] = refusals.length ? "blocked" : ev.gap.status === "clean" ? "nothing-missing" : blocked || !proposals.length ? "blocked" : "ready";
  const cas = casFacts(snap);
  const bound = { format: BOOKING_FORMAT, source: o.source, target: o.target, tenant: snap.tenant, account, chainId, epoch, agentId, verdict, refusals, found, items, remaining, cas };
  return {
    ...bound, format: BOOKING_FORMAT, previewDigest: digestOf(bound),
    capture: { capturedAtSec: o.nowSec, fromBlock: ev.gap.status === "unavailable" ? null : ev.gap.fromBlock, head: head === null ? null : head.toString(),
      rpcChainId: ev.rpcChainId, confirmations: Number(BOOKING_CONFIRMATIONS), balanceBlock: ev.balanceBlock },
    warnings,
    observations: { mode: agent?.mode ?? null, hwmUsdg: agent?.hwmUsdg ?? null, hwmWithdrawnUsdg: agent?.hwmWithdrawnUsdg ?? null, epochOpenedAt: snap.epochOpenedAt },
  };
}

/** The plan as an operator reads it at the console: one line per fact, the verdict and the digest. Public chain data and counts only. */
export function planLines(p: BookingPlan): string[] {
  const out = [`chain-gap booking ${p.verdict.toUpperCase()} — tenant ${p.tenant}, account ${p.account ?? "unknown"}, epoch ${p.epoch ?? "unknown"}: ` +
    `${p.found.length} fact(s) on chain that Postgres lacks, ${p.items.filter((i) => i.proposal).length} row(s) proposed`];
  for (const r of p.refusals) out.push(`  refused: ${r}`);
  for (const it of p.items) {
    const row = it.proposal ? ` → ${it.proposal.table} row` : it.class === "operation-leg" ? ` → covered by ${it.coveredBy}` : " → NOT BOOKED";
    out.push(`  ${it.class}: ${it.said}${row}`);
    if (!it.proposal && it.class !== "operation-leg") out.push(`    why: ${it.why}`);
  }
  for (const f of p.remaining) out.push(`  still missing after apply: ${describeChainFact(f)}`);
  for (const w of p.warnings) out.push(`  note: ${w}`);
  out.push(`previewDigest ${p.previewDigest}`);
  return out;
}

// ── apply ────────────────────────────────────────────────────────────────────

/**
 * The receipts table. One row per booked row: what was written (in full),
 * from which preview, under which backup, and whether it was reverted.
 * Unique per (account, epoch, evidence key) while applied — the idempotency
 * the booking promises — and kept, never deleted, after a revert.
 *
 * `admission_json` is where the tenant stood with admission at the apply
 * (AdmissionState: its approvals, attestations, heartbeat and mirror cursor),
 * the same on every receipt of a booking. A revert compares the tenant's
 * state now against it — the database's own record, not the report's word
 * and not two machines' clocks (admittedSince).
 */
export const BOOKINGS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${BOOKINGS_TABLE} (
    booking_id TEXT NOT NULL,
    tenant TEXT NOT NULL,
    account TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    chain_id INTEGER NOT NULL,
    evidence_key TEXT NOT NULL,
    table_name TEXT NOT NULL,
    row_id INTEGER NOT NULL,
    row_json TEXT NOT NULL,
    row_digest TEXT NOT NULL,
    preview_digest TEXT NOT NULL,
    backup_ref TEXT NOT NULL,
    admission_json TEXT NOT NULL,
    state TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL,
    reverted_at_ms INTEGER,
    PRIMARY KEY (booking_id, evidence_key)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ${BOOKINGS_TABLE}_once ON ${BOOKINGS_TABLE} (account, epoch, evidence_key) WHERE state = 'applied';
`;
export async function ensureBookingSchema(db: Db): Promise<void> {
  for (const statement of BOOKINGS_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await db.exec(statement);
}

/** A backup's name: the Railway backup id or dump file the operator took. A name, never a URL or a credential. */
export const BACKUP_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;

export interface AppliedRow { table: "trades" | "flows"; id: number; evidenceKey: string; row: Record<string, unknown>; rowDigest: string }
export interface ApplyReport {
  format: typeof APPLY_FORMAT; bookingId: string; tenant: string; account: string; chainId: number; epoch: number;
  previewDigest: string; backupRef: string; appliedAtMs: number;
  /** Where the tenant stood with admission when the rows were written: what a revert compares against (kept in every receipt too). */
  admission: AdmissionState;
  rows: AppliedRow[]; reportDigest: string;
}

/** A row as stored, reduced to the columns that were written, plus its id: what a revert compares against. */
function storedRow(r: Record<string, unknown>, columns: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(["id", ...columns].map((c) => {
    const v = r[c];
    return [c, v === undefined ? null : typeof v === "bigint" ? Number(v) : v];
  }));
}
/**
 * Column for column, as a driver hands values back: a NULL only equals a
 * NULL, a number equals the same number however it came back (node-postgres
 * returns BIGINT as a string unless told otherwise), anything else as text.
 */
function sameRow(a: Record<string, unknown>, b: Record<string, unknown>, columns: readonly string[]): boolean {
  return columns.every((c) => {
    const x = a[c] ?? null, y = b[c] ?? null;
    if (x === null || y === null) return x === null && y === null;
    return typeof x === "number" || typeof y === "number" ? Number(x) === Number(y) : String(x) === String(y);
  });
}

/**
 * WRITE EXACTLY THE PROPOSED ROWS, ONCE, IN ONE TRANSACTION.
 *
 * The plan is the one the caller just recomputed (the CLI never applies a
 * file); `confirm` is the digest the owner reviewed, and the two must agree.
 * Inside the transaction, in this order: the agent row is locked (the no-op
 * UPDATE store.ts bookCapitalFlow takes, so no epoch rollover races it), the
 * snapshot is read again and every Postgres fact the plan was computed from is
 * compared — any change refuses, nothing written — each row is inserted and
 * read back column for column, the flows are proved still distinct
 * (admission's precondition 4), and admission's own chain-fact rule is run
 * over what Postgres now holds: every fact must be answered. Then a receipt
 * per row. Any failure rolls all of it back.
 */
export async function applyBooking(db: Db, plan: BookingPlan, o: {
  confirm: string; backupRef: string; dialect: Dialect; nowMs: number; bookingId?: string;
}): Promise<ApplyReport> {
  if (!DIGEST.test(o.confirm) || o.confirm !== plan.previewDigest) {
    throw new BookingRefused("confirm-mismatch", "the preview recomputed now does not have the digest you confirmed: the books or the chain moved, or the code did — preview again and review that one");
  }
  if (plan.verdict !== "ready") throw new BookingRefused("not-ready", `the preview is ${plan.verdict}, not ready: nothing is applied`);
  if (!BACKUP_REF.test(o.backupRef) || o.backupRef.includes("//")) throw new BookingRefused("backup-ref", "--backup-ref must name the backup taken before this apply (an id or file name, not a URL)");
  const account = plan.account!, epoch = plan.epoch!, chainId = plan.chainId!;
  const agentRow = plan.cas.agents[0]!;
  const bookingId = o.bookingId ?? randomUUID();
  await ensureBookingSchema(db);
  return db.tx(async (tx) => {
    const lock = await tx.prepare("UPDATE agents SET epoch = epoch WHERE smart_account = ?").run(agentRow.smartAccount);
    if (Number(lock.changes) !== 1) throw new BookingRefused("cas", "the agent registration changed since the preview; preview again");
    const now = await readBookingSnapshot(tx, { tenant: plan.tenant, dialect: o.dialect, nowSec: Math.floor(o.nowMs / 1000) });
    const was = plan.cas, is = casFacts(now);
    for (const field of Object.keys(was) as Array<keyof typeof was>) {
      if (canonical(was[field]) !== canonical(is[field])) {
        throw new BookingRefused("cas", `the books changed since the preview (${field}); nothing was written — preview again`);
      }
    }
    const rows: AppliedRow[] = [];
    for (const it of plan.items) {
      if (!it.proposal) continue;
      if (it.proposal.table === "trades") {
        const row = it.proposal.row;
        const holes = TRADE_COLUMNS.map(() => "?").join(", ");
        const got = (await tx.prepare(`INSERT INTO trades (${TRADE_COLUMNS.join(", ")}) VALUES (${holes}) RETURNING id`)
          .get(...TRADE_COLUMNS.map((c) => row[c]))) as Record<string, unknown> | undefined;
        const id = Number(got?.id);
        if (!Number.isSafeInteger(id) || id <= 0) throw new BookingRefused("insert", `${it.key}: the trade row was not inserted`);
        const back = (await tx.prepare(`SELECT id, ${TRADE_COLUMNS.join(", ")} FROM trades WHERE id = ?`).get(id)) as Record<string, unknown> | undefined;
        if (!back || !sameRow(back, row as unknown as Record<string, unknown>, TRADE_COLUMNS)) throw new BookingRefused("verify", `${it.key}: the trade row read back differs from the proposal`);
        const stored = storedRow(back, TRADE_COLUMNS);
        rows.push({ table: "trades", id, evidenceKey: it.key, row: stored, rowDigest: digestOf(stored) });
      } else {
        const row = it.proposal.row;
        const holes = FLOW_COLUMNS.map(() => "?").join(", ");
        const got = (await tx.prepare(`INSERT INTO flows (${FLOW_COLUMNS.join(", ")}) VALUES (${holes}) ON CONFLICT DO NOTHING RETURNING id`)
          .get(...FLOW_COLUMNS.map((c) => row[c]))) as Record<string, unknown> | undefined;
        const id = Number(got?.id);
        if (!Number.isSafeInteger(id) || id <= 0) throw new BookingRefused("insert", `${it.key}: the flow is already on the books under its identity; nothing was written — preview again`);
        const back = (await tx.prepare(`SELECT id, ${FLOW_COLUMNS.join(", ")} FROM flows WHERE id = ?`).get(id)) as Record<string, unknown> | undefined;
        if (!back || !sameRow(back, row as unknown as Record<string, unknown>, FLOW_COLUMNS)) throw new BookingRefused("verify", `${it.key}: the flow read back differs from the proposal`);
        const stored = storedRow(back, FLOW_COLUMNS);
        rows.push({ table: "flows", id, evidenceKey: it.key, row: stored, rowDigest: digestOf(stored) });
      }
    }
    // WHAT ADMISSION WILL ASK, asked now, of what this transaction leaves.
    const duplicates = await flowDuplicateReport(tx, account, epoch);
    if (!duplicates.clean) throw new BookingRefused("flows", "the flows would hold duplicate or conflicting copies (distinct-flows report); nothing was written");
    const after = await readBookingSnapshot(tx, { tenant: plan.tenant, dialect: o.dialect, nowSec: Math.floor(o.nowMs / 1000) });
    if (after.spellings.length !== 1) throw new BookingRefused("spelling", "agent_id would be spelled more than one way; nothing was written");
    const still = factsStillMissing(plan.found, { ops: new Set(after.known.ops), txs: new Set(after.known.txs), flows: new Set(after.known.flows) });
    if (still.length) throw new BookingRefused("coverage", `admission would still find ${still.length} fact(s) Postgres lacks; nothing was written`);
    const appliedAtMs = o.nowMs;
    // WHERE THE TENANT STANDS WITH ADMISSION as these rows are written, read
    // inside this transaction (the compare-and-set above proved it is what the
    // reviewed plan saw). A revert is decided against this record.
    const admission = now.admission;
    for (const r of rows) {
      await tx.prepare(`INSERT INTO ${BOOKINGS_TABLE} (booking_id, tenant, account, epoch, chain_id, evidence_key, table_name, row_id, row_json, row_digest,
          preview_digest, backup_ref, admission_json, state, applied_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?)`)
        .run(bookingId, plan.tenant, account, epoch, chainId, r.evidenceKey, r.table, r.id, canonical(r.row), r.rowDigest, plan.previewDigest, o.backupRef,
          canonical(admission), appliedAtMs);
    }
    const body = { format: APPLY_FORMAT, bookingId, tenant: plan.tenant, account, chainId, epoch, previewDigest: plan.previewDigest, backupRef: o.backupRef, appliedAtMs,
      admission, rows };
    return { ...body, format: APPLY_FORMAT, reportDigest: digestOf(body) };
  });
}

// ── revert ───────────────────────────────────────────────────────────────────

/** An apply report, checked whole: its digest, and every field's shape. A report that does not verify reverts nothing. */
export function parseApplyReport(text: string): ApplyReport {
  let r: ApplyReport;
  try { r = JSON.parse(text) as ApplyReport; } catch { throw new BookingRefused("report", "the apply report is not JSON"); }
  const { reportDigest, ...body } = r ?? ({} as ApplyReport);
  if (r?.format !== APPLY_FORMAT || !DIGEST.test(String(reportDigest)) || digestOf(body) !== reportDigest) {
    throw new BookingRefused("report", "the apply report does not verify against its own digest");
  }
  if (!ADDRESS.test(r.tenant) || !ADDRESS.test(r.account) || !Array.isArray(r.rows) || !r.rows.length
    || r.rows.some((x) => (x.table !== "trades" && x.table !== "flows") || !Number.isSafeInteger(x.id) || digestOf(x.row) !== x.rowDigest)) {
    throw new BookingRefused("report", "the apply report's rows do not verify");
  }
  const a = r.admission as Partial<AdmissionState> | undefined;
  if (!a || !Array.isArray(a.approvals) || !Array.isArray(a.attestations) || !a.liveness || typeof a.liveness !== "object" || !Number.isSafeInteger(r.appliedAtMs)) {
    throw new BookingRefused("report", "the apply report does not say where the tenant stood with admission at the apply (a report from an earlier build of this tool?)");
  }
  return r;
}

export interface RevertReport {
  format: typeof REVERT_FORMAT; bookingId: string; tenant: string; account: string; revertedAtMs: number;
  outcome: "reverted" | "already-reverted"; rows: Array<{ table: string; id: number; evidenceKey: string }>; reportDigest: string;
}

/**
 * HAS ANYTHING STOOD ON THE BOOKED ROWS SINCE THE APPLY? PURE: where the
 * tenant stood with admission then (the receipts' record) and where it stands
 * now, in; the first reason a revert must refuse, or null, out.
 *
 * Decided by what the database recorded, never by time. The guard this
 * replaces asked whether an approval had moved past 'approved' with an
 * updated_at_ms at or after the report's appliedAtMs — the orchestrator's
 * clock against the operator's — and missed two reachable states: an
 * operator clock running ahead, and an approval registered after the apply
 * that then ended 'refused' (the grant-change path), its attestation and
 * consumed import still in place. Here:
 *
 *   an attested book in use        refuses: its attestation counts the rows.
 *   an attestation not there then  refuses, whatever its approval says now.
 *   an approval not there then     refuses while it is only approved (revoke
 *                                  it first: it was given on evidence holding
 *                                  the rows), and for good once it went past
 *                                  that — archiving, archived, registered or
 *                                  applied, or minted a generation or archived
 *                                  a home on its way to refused or revoked.
 *                                  One refused or revoked before any of that
 *                                  stood on nothing.
 *   an approval there then that    refuses: nothing moves a decided approval
 *   moved, or is gone              but admission.
 *   a heartbeat or a mirrored row  refuses: a worker ran on the tenant's book,
 *   since                          and the mirror skips a child trade whose
 *                                  hash Postgres holds — the booked row may be
 *                                  all that stands for the child's own, and
 *                                  taking it would lose the operation.
 */
export function admittedSince(was: AdmissionState, is: AdmissionState & { inUse: string | null }): { code: string; why: string } | null {
  if (is.inUse) return { code: "admitted", why: `the tenant runs an attested book (generation ${is.inUse.slice(0, 8)}…), whose attestation counts these rows` };
  const newAttestation = is.attestations.find((g) => !was.attestations.includes(g));
  if (newAttestation) return { code: "admitted", why: `admission attested a book for the tenant after this booking (generation ${newAttestation.slice(0, 8)}…), counting these rows` };
  for (const a of is.approvals) {
    const before = was.approvals.find((b) => b.approvalId === a.approvalId);
    if (!before) {
      if (a.state === "approved" && a.generation === null && !a.archived) {
        return { code: "open-approval", why: "an approval of the tenant made after this booking is open (approved), given on evidence that holds these rows: " +
          "withdraw it with MERRYMEN_RESUME_REVOKE and deploy first" };
      }
      if (OPEN_APPROVAL_STATES.has(a.state) || a.state === "applied" || a.generation !== null || a.archived) {
        return { code: "admitted", why: `an approval of the tenant made after this booking went past approval (now ${a.state}` +
          `${a.generation !== null ? ", a generation minted" : ""}${a.archived ? ", its home archived" : ""}): admission stood on these rows` };
      }
      continue;
    }
    if (before.state !== a.state || before.updatedAtMs !== a.updatedAtMs) {
      return { code: "admitted", why: `approval ${a.approvalId.slice(0, 8)}… moved since this booking (${before.state} → ${a.state}): only admission moves a decided approval` };
    }
  }
  const gone = was.approvals.find((b) => !is.approvals.some((a) => a.approvalId === b.approvalId));
  if (gone) return { code: "admitted", why: `approval ${gone.approvalId.slice(0, 8)}… that stood at this booking is gone` };
  if (is.liveness.beatAt !== was.liveness.beatAt || is.liveness.lastMirrorAt !== was.liveness.lastMirrorAt) {
    return { code: "moved", why: `the tenant's book has been written since this booking (heartbeat ${iso(was.liveness.beatAt)} → ${iso(is.liveness.beatAt)}, ` +
      `mirror ${iso(was.liveness.lastMirrorAt)} → ${iso(is.liveness.lastMirrorAt)}): a worker may hold rows these stand in for` };
  }
  return null;
}

/**
 * TAKE ONE BOOKING BACK, AS ONE TRANSACTION, ONLY IF NOTHING STOOD ON IT.
 *
 * Refuses unless every receipt of the booking is still 'applied' and matches
 * the report — its rows, its time and its record of where the tenant stood
 * with admission, each as the database holds it — every row is still exactly
 * as written (a row something has since changed is no longer only this
 * booking's), and nothing stood on the rows since (admittedSince): admission
 * binding them into an attested book, an approval given on evidence that
 * holds them, or a worker writing the tenant's book. Then the rows go and the
 * receipts say 'reverted', keeping each row in full. A second revert of the
 * same report is `already-reverted`, changing nothing.
 */
export async function revertBooking(db: Db, report: ApplyReport, o: { nowMs: number; dialect: Dialect }): Promise<RevertReport> {
  const result = (outcome: RevertReport["outcome"]): RevertReport => {
    const body = { format: REVERT_FORMAT, bookingId: report.bookingId, tenant: report.tenant, account: report.account, revertedAtMs: o.nowMs, outcome,
      rows: report.rows.map((r) => ({ table: r.table, id: r.id, evidenceKey: r.evidenceKey })) };
    return { ...body, format: REVERT_FORMAT, reportDigest: digestOf(body) };
  };
  return db.tx(async (tx) => {
    // Asked of the catalogue, never learned from a failed read: one failure
    // aborts a Postgres transaction (existingTables says why).
    const tables = await existingTables(tx, o.dialect);
    if (!tables.has(BOOKINGS_TABLE)) throw new BookingRefused("receipts", "no booking receipts exist in this database");
    // Ordered here, not by the database: a collation may order these keys differently from the report's.
    const receipts = ((await tx.prepare(`SELECT * FROM ${BOOKINGS_TABLE} WHERE booking_id = ?`).all(report.bookingId)) as Array<Record<string, unknown>>)
      .sort((a, b) => byText(String(a.evidence_key), String(b.evidence_key)));
    const want = [...report.rows].sort((a, b) => byText(a.evidenceKey, b.evidenceKey));
    // THE DATABASE'S RECORD, NOT THE REPORT'S WORD: the report verifies only
    // against its own digest, so its time and its admission record must be the
    // ones every receipt holds.
    const matches = receipts.length === want.length && receipts.every((r, i) => String(r.evidence_key) === want[i]!.evidenceKey
      && String(r.table_name) === want[i]!.table && Number(r.row_id) === want[i]!.id && String(r.row_digest) === want[i]!.rowDigest
      && String(r.account) === report.account && String(r.tenant) === report.tenant && String(r.preview_digest) === report.previewDigest
      && Number(r.applied_at_ms) === report.appliedAtMs && String(r.admission_json) === canonical(report.admission));
    if (!matches) throw new BookingRefused("receipts", "the booking's receipts in the database do not match the report");
    if (receipts.every((r) => r.state === "reverted")) return result("already-reverted");
    if (!receipts.every((r) => r.state === "applied")) throw new BookingRefused("receipts", "the booking is partly reverted; nothing changed");
    for (const needed of ["agents", "mirror_state"]) {
      if (!tables.has(needed)) throw new BookingRefused("schema", `the ${needed} table is not in this database; nothing changed`);
    }
    const lockAgent = await tx.prepare("UPDATE agents SET epoch = epoch WHERE LOWER(smart_account) = ?").run(report.account);
    if (Number(lockAgent.changes) < 1) throw new BookingRefused("cas", "the account's registration is gone; nothing changed");
    const now = await readAdmissionState(tx, tables, report.tenant, report.account);
    const inUse = tables.has("tenant_ledger_import") && tables.has("ledger_resume_attestations") ? await attestedSourceInUse(tx, report.tenant, report.account) : null;
    const stood = admittedSince(report.admission, { ...now, inUse });
    if (stood) throw new BookingRefused(stood.code, `${stood.why}; nothing changed`);
    for (const r of report.rows) {
      const columns = r.table === "trades" ? TRADE_COLUMNS : FLOW_COLUMNS;
      const now = (await tx.prepare(`SELECT id, ${columns.join(", ")} FROM ${r.table} WHERE id = ?`).get(r.id)) as Record<string, unknown> | undefined;
      if (!now || !sameRow(now, r.row, ["id", ...columns])) throw new BookingRefused("cas", `${r.evidenceKey}: the row is no longer exactly as booked; nothing changed`);
      const gone = await tx.prepare(`DELETE FROM ${r.table} WHERE id = ?`).run(r.id);
      if (Number(gone.changes) !== 1) throw new BookingRefused("cas", `${r.evidenceKey}: the row could not be removed; nothing changed`);
      const marked = await tx.prepare(`UPDATE ${BOOKINGS_TABLE} SET state = 'reverted', reverted_at_ms = ? WHERE booking_id = ? AND evidence_key = ? AND state = 'applied'`)
        .run(o.nowMs, report.bookingId, r.evidenceKey);
      if (Number(marked.changes) !== 1) throw new BookingRefused("receipts", `${r.evidenceKey}: its receipt moved under the revert; nothing changed`);
    }
    return result("reverted");
  });
}
