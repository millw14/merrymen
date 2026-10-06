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
 * WHAT IT PROPOSES IS WHAT THE EXISTING WRITERS WRITE, and nothing they do not:
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
 * book is seeded from them), no risk period. A fill's price is the ratio of
 * the two amounts the logs moved, scaled by the token's own decimals(); when
 * that cannot be read the price is NULL and the rest of the row stands.
 *
 * AND IT REFUSES WHAT IT CANNOT CLASSIFY. Every operation and transfer the
 * admission's own chain check finds (chainGapCheck, called here exactly as
 * admission calls it, from the same second — resumeGapWindow) gets one of the
 * classes above or is UNRESOLVED, and one unresolved fact blocks the whole
 * tenant: an owner's own (root-key) operation, which the agent's book has no
 * writer for and booking as the agent's would misattribute; a session key
 * moving USDG with nothing the other way (a transfer home or an energy
 * purchase books a flow beside its row, which is two writers' work, not this
 * one's); several tokens; USDG leaving with no operation of the account; an
 * operation's leg outside its own execution; anything not 64 blocks deep;
 * anything before the current accounting epoch opened.
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
 * them, keeping the receipt (state 'reverted', the row in full).
 *
 * Reviewed operator tool: never imported by the orchestrator or a worker.
 * docs/chain-gap-booking.md is the runbook.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Db } from "./db";
import { CASH, ENTRYPOINT, classifyUsdgMovement, energyReserveTokens } from "../../packages/core/src/index";
import { segmentReceipt, validatorOfNonce, type OpSegment } from "./asset-movements";
import { legsFromReceipt, TRANSFER_TOPIC, type RawChainLog, type RpcCall } from "./chain-capital";
import { custodyAddressesOf } from "./custody";
import { flowDuplicateReport } from "./distinct-flows";
import { netTokenDeltas } from "./fills";
import { pickAcquiredLeg } from "./inflight-reconcile";
import {
  attestedSourceInUse, chainGapCheck, describeChainFact, knownChainFacts, readOpenApproval, resumeGapWindow, RESUME_USDG, usdg6,
  type GapChain, type MissingChainFact,
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
/** `decimals()`: the one call this tool makes, and the only one its transport admits. */
export const DECIMALS_SELECTOR = "0x313ce567";

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
  grant: { account: string; owner: string | null; chainId: number | null; custody: string[] } | null;
  /** Every registration row for the account (more than one is a refusal). */
  agents: Array<{ smartAccount: string; epoch: number; chainId: number | null; mode: string | null; hwmUsdg: number; hwmWithdrawnUsdg: number }>;
  /** Every spelling of agent_id across the financial tables. Admission refuses more than one; so does this. */
  spellings: string[];
  /** The earliest row of the current epoch across trades, flows and equity. A fact before it may be another epoch's. */
  epochOpenedAt: number | null;
  /** Every hosted account, lowercased: a transfer from one is internal, never a deposit. */
  knownAccounts: string[];
  /** What a chain log could be in Postgres for this account (knownChainFacts), sorted. */
  known: { ops: string[]; txs: string[]; flows: string[] };
  /** Where admission's chain read starts (resumeGapWindow). */
  gapFromSec: number;
  /** The account's trades and flows by count and maximum id: the evidence apply compares and sets on. */
  ledger: { trades: { n: number; maxId: number }; flows: { n: number; maxId: number } };
  openApproval: { state: string; evidence: string } | null;
  /** The attested generation the tenant already runs, when it was admitted. */
  admitted: string | null;
  /** Bookings already applied for this account and not reverted. */
  booked: Array<{ bookingId: string; evidenceKey: string; tableName: string; rowId: number }>;
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
const SPELLING_TABLES = ["trades", "flows", "equity", "fee_accruals", "positions", "cost_basis", "position_floors", "class_positions", "paper_checkpoints", "risk_periods"];
const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

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
    const custody = custodyAddressesOf({
      grantFeatures, ponsClassVaultAddress: strOrNull(g.pons_class_vault_address) ?? undefined,
      trencherVaultAddress: strOrNull(g.trencher_vault_address) ?? undefined, trencherFactoryAddress: strOrNull(g.trencher_factory_address) ?? undefined,
    } as Parameters<typeof custodyAddressesOf>[0]).map(lower).sort();
    const chainId = g.chain_id === null || g.chain_id === undefined ? null : Number(g.chain_id);
    grant = { account: lower(g.smart_account), owner: ADDRESS.test(lower(g.owner)) ? lower(g.owner) : null,
      chainId: Number.isSafeInteger(chainId) ? chainId : null, custody };
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
  const k = await knownChainFacts(db, account);
  const { gapFromSec } = await resumeGapWindow(db, tenant, o.nowSec);
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
    known: { ops: [...k.ops].sort(), txs: [...k.txs].sort(), flows: [...k.flows].sort() }, gapFromSec,
    ledger: { trades: await count("trades"), flows: await count("flows") },
    openApproval: open ? { state: open.state, evidence: open.evidenceDigest } : null,
    admitted: account && tables.has("tenant_ledger_import") && tables.has("ledger_resume_attestations") ? await attestedSourceInUse(db, tenant, account) : null,
    booked,
  };
}

/** The part of a snapshot apply compares inside its transaction: what the proposals were computed from. */
function casFacts(s: BookingSnapshot) {
  return { grant: s.grant, agents: s.agents.map(({ smartAccount, epoch, chainId }) => ({ smartAccount, epoch, chainId })), spellings: s.spellings,
    epochOpenedAt: s.epochOpenedAt, known: s.known, ledger: s.ledger, openApproval: s.openApproval, admitted: s.admitted, booked: s.booked };
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
}

/**
 * The admission's chain seam over this tool's transport: the same three
 * reads, nothing else. The head and timestamps wait out a rate limit here;
 * getLogs is left to getLogsAdaptive, which already does, and narrows.
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
 * named, then decimals() of every token a fill would name. Reads only; the
 * transport admits nothing else (chain-gap-booking-cli.ts createBookingRpc).
 */
export async function readChainEvidence(rpc: RpcCall, snap: BookingSnapshot, o: {
  log?: (line: string) => void; sleep?: (ms: number) => Promise<void>; maxSpan?: bigint;
} = {}): Promise<ChainEvidence> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rpcChainId = Number(BigInt(String(await patiently(() => rpc("eth_chainId", []), sleep))));
  const empty = { rpcChainId, txs: {}, decimals: {} };
  if (!snap.grant) return { ...empty, gap: { status: "unavailable", why: "no stored grant names the account to read" } };
  const known = { ops: new Set(snap.known.ops), txs: new Set(snap.known.txs), flows: new Set(snap.known.flows) };
  const gap = await chainGapCheck({ chain: gapChainOf(rpc, sleep), account: snap.grant.account, usdg: RESUME_USDG, sinceSec: snap.gapFromSec, known,
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
  const book = [snap.grant.account, ...snap.grant.custody];
  for (const f of gap.found) {
    const receipt = f.kind === "operation" ? txs[f.txHash]?.receipt : null;
    if (!receipt || f.kind !== "operation") continue;
    const op = readOp(receipt, f.userOpHash, snap.grant.account, book);
    const leg = op ? pickAcquiredLeg(op.deltas, USDG) : null;
    if (!leg || leg.token in decimals) continue;
    try {
      const out = String(await patiently(() => rpc("eth_call", [{ to: leg.token, data: DECIMALS_SELECTOR }, "latest"]), sleep));
      const d = /^0x[0-9a-fA-F]{1,64}$/.test(out) ? BigInt(out) : -1n;
      decimals[leg.token] = d >= 0n && d <= 36n ? Number(d) : null;
    } catch { decimals[leg.token] = null; }
  }
  return { rpcChainId, gap: { status: "missing", fromBlock: gap.fromBlock, head: gap.head, found: gap.found }, txs, decimals };
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
  /** Not in the digest: when, where on the chain, and what the reviewer should know. */
  capture: { capturedAtSec: number; fromBlock: string | null; head: string | null; rpcChainId: number; confirmations: number };
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
    if (snap.epochOpenedAt !== null && tx.block.timestamp < snap.epochOpenedAt) {
      return `it landed before accounting epoch ${epoch} opened (${new Date(snap.epochOpenedAt * 1000).toISOString()}), so which epoch it belongs to is not this tool's to say`;
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
        items.push(unresolved(base, `the owner's own key (the root validator) signed this operation (it moved ${saidDeltas(op.deltas)}): ` +
          "the agent's book has no writer for an owner's operation, and booking it as the agent's trade would misattribute it — escalate for a reviewed decision",
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
        items.push(unresolved(base, onlyUsdg
          ? `a session key moved USDG (${saidDeltas(op.deltas)}) with nothing visible the other way: a transfer home or an energy purchase books a flow beside its row, ` +
            "which is not one row this tool can propose"
          : `a session key's operation moved ${saidDeltas(op.deltas)}: not one token against USDG in opposite directions, so no fill can be read without choosing one`));
        continue;
      }
      const decimals = ev.decimals[leg.token] ?? null;
      const price = decimals === null ? null : usdgNumber(leg.cashUsdg) / (Number(leg.qtyRaw) / 10 ** decimals);
      if (decimals === null) warnings.push(`${f.userOpHash}: decimals() of ${leg.token} could not be read, so its fill_price_usd stays NULL; side, quantity and cash are booked`);
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
    if (segments.some((s) => s.op.sender === account)) {
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
  if (proposals.some((it) => it.class === "session-trade")) {
    warnings.push("a trade is booked without touching cost_basis, positions or position_floors: those are the lost book's last mirrored snapshot, which the attested book is seeded from");
  }
  const blocked = items.some((it) => !it.proposal && it.class !== "operation-leg") || remaining.length > 0;
  const verdict: BookingPlan["verdict"] = refusals.length ? "blocked" : ev.gap.status === "clean" ? "nothing-missing" : blocked || !proposals.length ? "blocked" : "ready";
  const cas = casFacts(snap);
  const bound = { format: BOOKING_FORMAT, source: o.source, target: o.target, tenant: snap.tenant, account, chainId, epoch, agentId, verdict, refusals, found, items, remaining, cas };
  return {
    ...bound, format: BOOKING_FORMAT, previewDigest: digestOf(bound),
    capture: { capturedAtSec: o.nowSec, fromBlock: ev.gap.status === "unavailable" ? null : ev.gap.fromBlock, head: head === null ? null : head.toString(),
      rpcChainId: ev.rpcChainId, confirmations: Number(BOOKING_CONFIRMATIONS) },
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
  previewDigest: string; backupRef: string; appliedAtMs: number; rows: AppliedRow[]; reportDigest: string;
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
    for (const r of rows) {
      await tx.prepare(`INSERT INTO ${BOOKINGS_TABLE} (booking_id, tenant, account, epoch, chain_id, evidence_key, table_name, row_id, row_json, row_digest,
          preview_digest, backup_ref, state, applied_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?)`)
        .run(bookingId, plan.tenant, account, epoch, chainId, r.evidenceKey, r.table, r.id, canonical(r.row), r.rowDigest, plan.previewDigest, o.backupRef, appliedAtMs);
    }
    const body = { format: APPLY_FORMAT, bookingId, tenant: plan.tenant, account, chainId, epoch, previewDigest: plan.previewDigest, backupRef: o.backupRef, appliedAtMs, rows };
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
  return r;
}

export interface RevertReport {
  format: typeof REVERT_FORMAT; bookingId: string; tenant: string; account: string; revertedAtMs: number;
  outcome: "reverted" | "already-reverted"; rows: Array<{ table: string; id: number; evidenceKey: string }>; reportDigest: string;
}

/**
 * TAKE ONE BOOKING BACK, AS ONE TRANSACTION, ONLY IF NOTHING STOOD ON IT.
 *
 * Refuses unless every receipt of the booking is still 'applied' and matches
 * the report, every row is still exactly as written (a row something has
 * since changed is no longer only this booking's), and no approval of the
 * tenant moved past 'approved' after the apply — admission bound those rows
 * into an attested book, and taking them away would leave that book short of
 * what its attestation counted. Then the rows go and the receipts say
 * 'reverted', keeping each row in full. A second revert of the same report is
 * `already-reverted`, changing nothing.
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
    const receipts = (await tx.prepare(`SELECT * FROM ${BOOKINGS_TABLE} WHERE booking_id = ? ORDER BY evidence_key`).all(report.bookingId)) as Array<Record<string, unknown>>;
    const want = [...report.rows].sort((a, b) => a.evidenceKey.localeCompare(b.evidenceKey));
    const matches = receipts.length === want.length && receipts.every((r, i) => String(r.evidence_key) === want[i]!.evidenceKey
      && String(r.table_name) === want[i]!.table && Number(r.row_id) === want[i]!.id && String(r.row_digest) === want[i]!.rowDigest
      && String(r.account) === report.account && String(r.preview_digest) === report.previewDigest);
    if (!matches) throw new BookingRefused("receipts", "the booking's receipts in the database do not match the report");
    if (receipts.every((r) => r.state === "reverted")) return result("already-reverted");
    if (!receipts.every((r) => r.state === "applied")) throw new BookingRefused("receipts", "the booking is partly reverted; nothing changed");
    const lockAgent = await tx.prepare("UPDATE agents SET epoch = epoch WHERE LOWER(smart_account) = ?").run(report.account);
    if (Number(lockAgent.changes) < 1) throw new BookingRefused("cas", "the account's registration is gone; nothing changed");
    if (tables.has("ledger_resume_approvals")) {
      const admitted = await tx.prepare(`SELECT state FROM ledger_resume_approvals WHERE tenant = ? AND state IN ('archiving', 'archived', 'registered', 'applied')
          AND updated_at_ms >= ? LIMIT 1`).get(report.tenant, report.appliedAtMs);
      if (admitted) throw new BookingRefused("admitted", "the tenant's admission went past approval after this booking: its attested book counts these rows; nothing changed");
    }
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
