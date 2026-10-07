/**
 * WHICH TRADES ROWS ARE AN OWNER'S OWN OPERATION? A READ-ONLY FLEET AUDIT.
 *
 * Until this branch the in-flight reconciler wrote every successful operation
 * the ledger lacked as an agent 'swap', whoever signed it (owner-operations.ts
 * says what that cost). It no longer does, but the rows it already wrote are
 * still in Postgres, and still count wherever they count. This audit finds
 * them, and says where each one counts. It changes nothing: no history is
 * rewritten here, and docs/owner-operations.md says what a later, separately
 * reviewed reclassification would need.
 *
 * WHAT IT READS. Postgres in one REPEATABLE READ READ ONLY snapshot, always
 * rolled back (the booking CLI's own read-only connection: three walls, any one
 * of which refuses a write): the grants' account, chain and custody fields only
 * (never the whole grant_json, never sealed_session_key), each account's epoch
 * and mode, every trades row carrying a userOpHash, the flows with a
 * transaction, and the owner records. Then, with that connection closed, one
 * receipt per distinct transaction and its block, over an RPC that admits
 * eth_chainId, eth_blockNumber, eth_getTransactionReceipt and
 * eth_getBlockByNumber and nothing else.
 *
 * WHAT IT DECIDES, per row: the row's operation is found in its own receipt as
 * the account's through EntryPoint v0.7 (asset-movements.ts segmentReceipt),
 * and its nonce names the validator (validatorOfNonce). A ROOT row is one the
 * owner's own key signed. For each, the report gives the tenant, the
 * transaction, its block and time, the row's kind, status, amount, epoch and
 * times, the owner reading of that receipt (owner-operations.ts), each USDG
 * leg and whether a flow holds it, and WHERE IT COUNTS — each flag naming the
 * reader whose predicate it mirrors.
 *
 * WHAT IT CANNOT SEE. The `counted` flags describe readers of the SHARED
 * ledger. A running child seeds its live ops and spend caps from its own
 * SQLite copy, which this audit cannot see and which a Postgres edit never
 * changes. The report says so.
 */
import { createHash } from "node:crypto";
import type { Db } from "./db";
import { CASH, ENTRYPOINT } from "../../packages/core/src/index";
import { segmentReceipt, validatorOfNonce } from "./asset-movements";
import type { RawChainLog, RpcCall } from "./chain-capital";
import { custodyAddressesOf } from "./custody";
import { ownerOperationOf, type OwnerOperationReading } from "./owner-operations";
import { classifyRpcError } from "./rpc-error";

export const AUDIT_FORMAT = "merrymen.owner-op-audit.v1";
/** The only RPC methods the audit may call. No eth_call, no eth_getLogs, nothing that sends. */
export const AUDIT_RPC_METHODS: readonly string[] = Object.freeze(["eth_chainId", "eth_blockNumber", "eth_getTransactionReceipt", "eth_getBlockByNumber"]);
/** At most this many receipts per run unless the operator says otherwise; past it, coverage is incomplete and says by how much. */
export const DEFAULT_MAX_RECEIPTS = 5_000;
/** The trailing day the shared budget seed reads (budget-seed.ts readBudgetSeed). */
const DAY_SEC = 86_400;

export type Dialect = "postgres" | "sqlite";
const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const EP_V07 = String(ENTRYPOINT.v07).toLowerCase();
const USDG = String(CASH.USDG).toLowerCase();
const lower = (v: unknown) => String(v ?? "").toLowerCase();
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Sorted keys at every level, bigints as decimal strings, undefined dropped: the bytes the audit digest is over. */
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
const digestOf = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

// ── the Postgres half ────────────────────────────────────────────────────────

export interface AuditGrant { tenant: string; account: string; chainId: number | null; custody: string[] }
export interface AuditTrade {
  id: number; account: string; agentId: string; kind: string; target: string | null; status: string; amountUsdg: number;
  userOpHash: string; txHash: string | null; epoch: number | null; createdAt: number | null; budgetSettledAt: number | null;
  decisionId: string | null; fillSide: string | null; fillSymbol: string | null; basisSource: string | null; sellToken: string | null; buyToken: string | null;
}
export interface AuditFlow { account: string; txHash: string; logIndex: number | null; direction: string; amountUsdg: number; source: string; epoch: number | null }
export interface AuditOwnerRecord {
  tenant: string | null; account: string; chainId: number | null; userOpHash: string; txHash: string; disposition: string; reviewReason: string | null;
  recordedEpoch: number | null; createdAt: number | null;
}
export interface AuditSnapshot {
  grants: AuditGrant[];
  agents: Array<{ account: string; epoch: number | null; mode: string | null }>;
  trades: AuditTrade[];
  flows: AuditFlow[];
  /** Null when the table is not in this database yet. */
  ownerRecords: AuditOwnerRecord[] | null;
}

/** The catalogue, never a failed statement: the snapshot is one transaction, and a failed read aborts it on Postgres. */
async function tablesOf(db: Db, dialect: Dialect): Promise<Set<string>> {
  const rows = (await db.prepare(dialect === "postgres"
    ? "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()"
    : "SELECT name FROM sqlite_master WHERE type = 'table'").all()) as Array<Record<string, unknown>>;
  return new Set(rows.map((r) => String(r.name)));
}
async function columnsOf(db: Db, dialect: Dialect, table: string): Promise<Set<string>> {
  const rows = (await db.prepare(dialect === "postgres"
    ? "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?"
    : "SELECT name FROM pragma_table_info(?)").all(table)) as Array<Record<string, unknown>>;
  return new Set(rows.map((r) => String(r.name)));
}

/** The grant, field by field: what custody.ts derives a book from, and nothing else of grant_json. */
const GRANTS_SQL: Record<Dialect, string> = {
  postgres: `SELECT LOWER(tenant) AS tenant, grant_json->>'smartAccount' AS smart_account, grant_json->>'chainId' AS chain_id,
      grant_json->'grantFeatures' AS grant_features, grant_json->>'ponsClassVaultAddress' AS pons_class_vault_address,
      grant_json->>'trencherVaultAddress' AS trencher_vault_address, grant_json->>'trencherFactoryAddress' AS trencher_factory_address
    FROM grants`,
  sqlite: `SELECT LOWER(tenant) AS tenant, json_extract(grant_json, '$.smartAccount') AS smart_account, json_extract(grant_json, '$.chainId') AS chain_id,
      json_extract(grant_json, '$.grantFeatures') AS grant_features, json_extract(grant_json, '$.ponsClassVaultAddress') AS pons_class_vault_address,
      json_extract(grant_json, '$.trencherVaultAddress') AS trencher_vault_address, json_extract(grant_json, '$.trencherFactoryAddress') AS trencher_factory_address
    FROM grants`,
};

/**
 * ONE READ OF POSTGRES, for the whole fleet or one tenant. Called inside the
 * caller's read-only transaction; reads only, and asks the catalogue for every
 * table and optional column first.
 */
export async function readAuditSnapshot(db: Db, o: { dialect: Dialect; tenant?: string }): Promise<AuditSnapshot> {
  const tables = await tablesOf(db, o.dialect);
  for (const needed of ["grants", "agents", "trades", "flows"]) {
    if (!tables.has(needed)) throw new AuditRefused(`schema-${needed}-absent`);
  }
  const tenant = o.tenant ? lower(o.tenant) : null;
  const grantRows = (await db.prepare(`${GRANTS_SQL[o.dialect]}${tenant ? " WHERE LOWER(tenant) = ?" : ""} ORDER BY tenant`).all(...(tenant ? [tenant] : []))) as
    Array<Record<string, unknown>>;
  const grants: AuditGrant[] = [];
  for (const g of grantRows) {
    const account = lower(g.smart_account);
    if (!ADDRESS.test(account)) continue;
    const raw = typeof g.grant_features === "string" ? (() => { try { return JSON.parse(g.grant_features as string) as unknown; } catch { return null; } })() : g.grant_features;
    const stored = {
      grantFeatures: Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string") : [],
      ponsClassVaultAddress: strOrNull(g.pons_class_vault_address) ?? undefined,
      trencherVaultAddress: strOrNull(g.trencher_vault_address) ?? undefined,
      trencherFactoryAddress: strOrNull(g.trencher_factory_address) ?? undefined,
    } as Parameters<typeof custodyAddressesOf>[0];
    const chainId = numOrNull(g.chain_id);
    grants.push({ tenant: lower(g.tenant), account, chainId: chainId !== null && Number.isSafeInteger(chainId) ? chainId : null, custody: custodyAddressesOf(stored).map(lower).sort() });
  }
  const scoped = tenant ? grants.map((g) => g.account) : null;
  if (tenant && scoped!.length === 0) throw new AuditRefused("no-grant-for-tenant");
  const only = (column: string) => (scoped ? ` AND LOWER(${column}) IN (${scoped.map(() => "?").join(", ")})` : "");
  const agents = ((await db.prepare(`SELECT smart_account, epoch, mode FROM agents WHERE 1 = 1${only("smart_account")} ORDER BY smart_account`).all(...(scoped ?? []))) as
    Array<Record<string, unknown>>).map((r) => ({ account: lower(r.smart_account), epoch: numOrNull(r.epoch), mode: strOrNull(r.mode) }));
  const tradeCols = await columnsOf(db, o.dialect, "trades");
  const opt = (c: string) => (tradeCols.has(c) ? c : `NULL AS ${c}`);
  const trades = ((await db.prepare(`SELECT id, agent_id, kind, target, status, amount_usdg, user_op_hash, tx_hash, ${opt("epoch")}, created_at, ${opt("budget_settled_at")},
        ${opt("decision_id")}, ${opt("fill_side")}, ${opt("fill_symbol")}, ${opt("basis_source")}, sell_token, buy_token
      FROM trades WHERE user_op_hash IS NOT NULL AND user_op_hash <> ''${only("agent_id")} ORDER BY id`).all(...(scoped ?? []))) as Array<Record<string, unknown>>)
    .map((r) => ({
      id: Number(r.id), account: lower(r.agent_id), agentId: String(r.agent_id), kind: String(r.kind), target: strOrNull(r.target), status: String(r.status),
      amountUsdg: Number(r.amount_usdg ?? 0), userOpHash: lower(r.user_op_hash), txHash: r.tx_hash === null || r.tx_hash === undefined || r.tx_hash === "" ? null : lower(r.tx_hash),
      epoch: numOrNull(r.epoch), createdAt: numOrNull(r.created_at), budgetSettledAt: numOrNull(r.budget_settled_at), decisionId: strOrNull(r.decision_id),
      fillSide: strOrNull(r.fill_side), fillSymbol: strOrNull(r.fill_symbol), basisSource: strOrNull(r.basis_source),
      sellToken: r.sell_token === null || r.sell_token === undefined ? null : lower(r.sell_token), buyToken: r.buy_token === null || r.buy_token === undefined ? null : lower(r.buy_token),
    }));
  const flowCols = await columnsOf(db, o.dialect, "flows");
  const flows = ((await db.prepare(`SELECT agent_id, tx_hash, ${flowCols.has("log_index") ? "log_index" : "NULL AS log_index"}, direction, amount_usdg, source,
        ${flowCols.has("epoch") ? "epoch" : "NULL AS epoch"} FROM flows WHERE tx_hash IS NOT NULL${only("agent_id")} ORDER BY id`).all(...(scoped ?? []))) as Array<Record<string, unknown>>)
    .map((r) => ({ account: lower(r.agent_id), txHash: lower(r.tx_hash), logIndex: numOrNull(r.log_index), direction: String(r.direction), amountUsdg: Number(r.amount_usdg ?? 0),
      source: String(r.source), epoch: numOrNull(r.epoch) }));
  const ownerRecords = tables.has("owner_operations")
    ? ((await db.prepare(`SELECT tenant, agent_id, chain_id, user_op_hash, tx_hash, disposition, review_reason, recorded_epoch, created_at FROM owner_operations
          WHERE 1 = 1${only("agent_id")} ORDER BY id`).all(...(scoped ?? []))) as Array<Record<string, unknown>>)
      .map((r) => ({ tenant: r.tenant === null || r.tenant === undefined ? null : lower(r.tenant), account: lower(r.agent_id), chainId: numOrNull(r.chain_id),
        userOpHash: lower(r.user_op_hash), txHash: lower(r.tx_hash), disposition: String(r.disposition), reviewReason: strOrNull(r.review_reason),
        recordedEpoch: numOrNull(r.recorded_epoch), createdAt: numOrNull(r.created_at) }))
    : null;
  return { grants, agents, trades, flows, ownerRecords };
}

// ── the chain half ───────────────────────────────────────────────────────────

export interface AuditTx {
  receipt: { status: string; blockNumber: string; blockHash: string; logs: RawChainLog[] } | null;
  block: { number: string; hash: string; timestamp: number } | null;
}
export interface AuditChain {
  rpcChainId: number;
  head: string;
  txs: Record<string, AuditTx>;
  /** Transactions not read because the bound was reached. */
  skipped: string[];
}

/** A refusal this audit means: a fixed code an operator acts on. Nothing in it is private. */
export class AuditRefused extends Error {
  constructor(readonly code: string) { super(code); this.name = "AuditRefused"; }
}

/**
 * Wrap a transport so it admits only the audit's four reads, refused before
 * anything leaves the process otherwise.
 */
export function auditRpc(inner: RpcCall): RpcCall {
  return async (method, params) => {
    if (!AUDIT_RPC_METHODS.includes(method)) throw new AuditRefused("rpc-method-outside-audit-allowlist");
    return inner(method, params);
  };
}

/** Ask again while the node says "later": 1s, 2s, 4s, 8s, 16s. Anything else, or the last failure, is the caller's to treat as unread. */
async function patiently<T>(call: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await call(); }
    catch (e) {
      const v = classifyRpcError(e);
      if (!v.retryable || attempt >= 5) throw e;
      await sleep(v.retryAfterMs ?? 1_000 * 2 ** attempt);
    }
  }
}

/** One receipt and its block per transaction, in a fixed order, at most `maxReceipts`. Reads only. */
export async function readAuditChain(rpc: RpcCall, txHashes: readonly string[], o: { maxReceipts: number; sleep?: (ms: number) => Promise<void> }): Promise<AuditChain> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rpcChainId = Number(BigInt(String(await patiently(() => rpc("eth_chainId", []), sleep))));
  const head = BigInt(String(await patiently(() => rpc("eth_blockNumber", []), sleep))).toString();
  const ordered = [...new Set(txHashes.map(lower))].sort(byText);
  const reading = ordered.slice(0, Math.max(0, o.maxReceipts));
  const txs: Record<string, AuditTx> = {};
  for (const tx of reading) {
    let receipt: AuditTx["receipt"] = null, block: AuditTx["block"] = null;
    try {
      const r = (await patiently(() => rpc("eth_getTransactionReceipt", [tx]), sleep)) as Record<string, unknown> | null;
      if (r && Array.isArray(r.logs) && typeof r.blockNumber === "string" && typeof r.blockHash === "string" && typeof r.status === "string") {
        receipt = { status: r.status, blockNumber: r.blockNumber, blockHash: lower(r.blockHash), logs: r.logs as RawChainLog[] };
        const b = (await patiently(() => rpc("eth_getBlockByNumber", [r.blockNumber, false]), sleep)) as Record<string, unknown> | null;
        if (b && typeof b.number === "string" && typeof b.hash === "string" && typeof b.timestamp === "string" && BigInt(b.number) === BigInt(r.blockNumber as string)) {
          block = { number: BigInt(b.number).toString(), hash: lower(b.hash), timestamp: Number(BigInt(b.timestamp)) };
        }
      }
    } catch {
      // Unread is unread: the report counts it, and the run exits incomplete.
    }
    txs[tx] = { receipt, block };
  }
  return { rpcChainId, head, txs, skipped: ordered.slice(reading.length) };
}

// ── the report ───────────────────────────────────────────────────────────────

export type ValidatorClass = "root" | "permission" | "secondary" | "unknown" | "not-in-receipt" | "unread" | "other-chain" | "no-tx";

/** Where one row counts, each flag naming the shared-ledger reader whose predicate it mirrors, at the audit's capture time. */
export interface Counted {
  /** budget-seed.ts readBudgetSeed: status landed|submitted, inside the trailing day (submitted always). The seed a child is given at spawn. */
  budgetSeedTrailingDay: boolean;
  /** One operation in that seed's op count. */
  budgetSeedOps: number;
  /** Its spend in that seed: kind other than vault-withdraw, and not a sell into USDG. */
  budgetSeedSpendUsdg: number;
  /** Its gross in that seed: kind other than vault-withdraw. */
  budgetSeedGrossUsdg: number;
  /** web/src/app/api/scoreboard/route.ts: a landed row of the current epoch. */
  scoreboardLanded: boolean;
  /** ... and its volume: kind other than vault-withdraw. */
  scoreboardVolumeUsdg: number;
  /** web/src/lib/profile-trades.ts: landed|paper, swap|curve-trade, current epoch (the profile and feed tape). */
  tradeTape: boolean;
  /** worker/src/chat-trades.ts: landed|paper, swap|curve-trade|equity-order, in the window the chat asks for. */
  chatTrades: boolean;
  /** web/src/lib/services/portfolio.ts NOT_A_RESTART_COPY: a bare 'swap' at the account, no decision, no fill — which the portfolio's cash check already excludes. */
  restartCopyShape: boolean;
  /** A fill on the row (fill_side set): the reconciler also booked a live cost basis for it. */
  liveBasisBooked: boolean;
  /** The owner record Postgres also holds for this operation, by disposition, or null. */
  ownerRecord: string | null;
}

export interface RootRow {
  tenant: string | null; account: string; tradeId: number; txHash: string; userOpHash: string;
  block: string | null; blockTime: number | null; blockCanonical: boolean;
  kind: string; status: string; amountUsdg: number; epoch: number | null; currentEpoch: number | null; mode: string | null;
  createdAt: number | null; budgetSettledAt: number | null; nonce: string; opSucceeded: boolean;
  /** The owner reading of the receipt (owner-operations.ts), with each USDG leg and whether a flow holds it. Null when unreadable. */
  reading: (Omit<OwnerOperationReading, "usdgLegs"> & { usdgLegs: Array<OwnerOperationReading["usdgLegs"][number] & { flowHeld: boolean }> }) | null;
  counted: Counted;
}

export interface AuditReport {
  format: typeof AUDIT_FORMAT;
  source: unknown; target: string; tenant: string | null;
  capturedAtSec: number; rpcChainId: number; head: string; maxReceipts: number;
  coverage: { complete: boolean; why: string[] };
  rootRows: RootRow[];
  anomalies: Array<{ tradeId: number; account: string; userOpHash: string; txHash: string; what: string }>;
  ownerRecords: { rows: AuditOwnerRecord[] | null; onAnotherChain: AuditOwnerRecord[]; withoutTenant: AuditOwnerRecord[] };
  totals: {
    rowsScanned: number; distinctTxs: number; receiptsRead: number; receiptsUnread: number; receiptsSkippedByBound: number;
    rowsWithoutTxSettled: number; rowsWithoutTxOther: number;
    byValidator: Record<ValidatorClass, number>;
    root: {
      rows: number; tenants: number; amountUsdg: string; byKind: Record<string, number>; withFill: number; withOwnerRecord: number;
      inBudgetSeedTrailingDay: number; budgetSeedSpendUsdg: string; budgetSeedGrossUsdg: string;
      scoreboardLanded: number; scoreboardVolumeUsdg: string; onTradeTape: number; inChatTrades: number;
    };
    capitalLegsWithoutFlow: { in: { count: number; amountRaw: string }; out: { count: number; amountRaw: string };
      legs: Array<{ tenant: string | null; account: string; txHash: string; logIndex: number; direction: "in" | "out"; amountRaw: string }> };
  };
  caveats: string[];
  auditDigest: string;
}

const usdg6 = (raw: bigint) => `${raw / 1_000_000n}.${(raw % 1_000_000n).toString().padStart(6, "0")}`;
const sum6 = (values: number[]) => usdg6(values.reduce((s, v) => s + BigInt(Math.round(v * 1e6)), 0n));

/**
 * THE AUDIT. PURE: the snapshot and the chain in, the report out. Nothing here
 * reads or writes.
 */
export function auditReport(snap: AuditSnapshot, ev: AuditChain, o: { nowSec: number; source: unknown; target: string; tenant?: string; maxReceipts: number }): AuditReport {
  const grantOf = new Map<string, AuditGrant>();
  for (const g of snap.grants) if (!grantOf.has(g.account)) grantOf.set(g.account, g);
  const agentOf = new Map(snap.agents.map((a) => [a.account, a]));
  const flowsHeld = new Set(snap.flows.filter((f) => f.logIndex !== null).map((f) => `${f.account}|${f.txHash}:${f.logIndex}`));
  // By account and hash, as the record's identity is (store.ts): another
  // account's record of the same hash is never shown beside this row.
  const recordOf = new Map<string, AuditOwnerRecord>();
  for (const r of snap.ownerRecords ?? []) recordOf.set(`${r.account}|${r.userOpHash}`, r);
  const byValidator: Record<ValidatorClass, number> = { root: 0, permission: 0, secondary: 0, unknown: 0, "not-in-receipt": 0, unread: 0, "other-chain": 0, "no-tx": 0 };
  const rootRows: RootRow[] = [];
  const anomalies: AuditReport["anomalies"] = [];
  let rowsWithoutTxSettled = 0, rowsWithoutTxOther = 0;
  const legsWithoutFlow: AuditReport["totals"]["capitalLegsWithoutFlow"]["legs"] = [];
  const seenLeg = new Set<string>();

  for (const t of snap.trades) {
    const grant = grantOf.get(t.account) ?? null;
    if (!t.txHash) {
      byValidator["no-tx"] += 1;
      if (t.status === "landed" || t.status === "reverted") rowsWithoutTxSettled += 1; else rowsWithoutTxOther += 1;
      continue;
    }
    if (grant?.chainId !== null && grant?.chainId !== undefined && grant.chainId !== ev.rpcChainId) { byValidator["other-chain"] += 1; continue; }
    const tx = ev.txs[t.txHash];
    if (!tx || !tx.receipt) { byValidator.unread += 1; continue; }
    const { segments } = segmentReceipt(tx.receipt.logs);
    const seg = segments.find((s) => s.op.userOpHash === t.userOpHash && s.op.sender === t.account && s.op.entryPoint === EP_V07);
    if (!seg) {
      byValidator["not-in-receipt"] += 1;
      anomalies.push({ tradeId: t.id, account: t.account, userOpHash: t.userOpHash, txHash: t.txHash, what: "the row's userOpHash is not this account's operation in its own transaction's receipt" });
      continue;
    }
    const validator = validatorOfNonce(seg.op.nonce);
    if (validator !== "root") { byValidator[validator ?? "unknown"] += 1; continue; }
    byValidator.root += 1;
    const agent = agentOf.get(t.account) ?? null;
    const reading = ownerOperationOf({ receiptLogs: tx.receipt.logs, userOpHash: t.userOpHash, txHash: t.txHash, account: t.account, custody: grant?.custody ?? [],
      usdg: USDG, chainId: grant?.chainId ?? ev.rpcChainId });
    const trailing = (t.status === "landed" || t.status === "submitted") && (t.status === "submitted" || (t.budgetSettledAt ?? t.createdAt ?? 0) > o.nowSec - DAY_SEC);
    const notVault = t.kind !== "vault-withdraw";
    const sellIntoCash = (t.kind === "swap" || t.kind === "curve-trade") && t.buyToken === USDG;
    const current = agent?.epoch !== null && agent?.epoch !== undefined && t.epoch === agent.epoch;
    const landed = t.status === "landed";
    const record = recordOf.get(`${t.account}|${t.userOpHash}`) ?? null;
    const counted: Counted = {
      budgetSeedTrailingDay: trailing,
      budgetSeedOps: trailing ? 1 : 0,
      budgetSeedSpendUsdg: trailing && notVault && !sellIntoCash ? t.amountUsdg : 0,
      budgetSeedGrossUsdg: trailing && notVault ? t.amountUsdg : 0,
      scoreboardLanded: landed && current,
      scoreboardVolumeUsdg: landed && current && notVault ? t.amountUsdg : 0,
      tradeTape: (landed || t.status === "paper") && (t.kind === "swap" || t.kind === "curve-trade") && current,
      chatTrades: (landed || t.status === "paper") && ["swap", "curve-trade", "equity-order"].includes(t.kind),
      restartCopyShape: t.kind === "swap" && lower(t.target) === t.account && t.decisionId === null && t.fillSide === null,
      liveBasisBooked: t.fillSide !== null,
      ownerRecord: record ? record.disposition : null,
    };
    const legs = reading
      ? reading.usdgLegs.map((l) => {
        const flowHeld = flowsHeld.has(`${t.account}|${t.txHash}:${l.logIndex}`);
        if (l.answeredBy === "flow" && !flowHeld && !seenLeg.has(`${t.txHash}:${l.logIndex}`)) {
          seenLeg.add(`${t.txHash}:${l.logIndex}`);
          legsWithoutFlow.push({ tenant: grant?.tenant ?? null, account: t.account, txHash: t.txHash!, logIndex: l.logIndex, direction: l.to === t.account ? "in" : "out", amountRaw: l.amountRaw });
        }
        return { ...l, flowHeld };
      })
      : [];
    rootRows.push({
      tenant: grant?.tenant ?? null, account: t.account, tradeId: t.id, txHash: t.txHash, userOpHash: t.userOpHash,
      block: tx.block?.number ?? (tx.receipt ? BigInt(tx.receipt.blockNumber).toString() : null), blockTime: tx.block?.timestamp ?? null,
      blockCanonical: tx.block !== null && tx.block.hash === tx.receipt.blockHash,
      kind: t.kind, status: t.status, amountUsdg: t.amountUsdg, epoch: t.epoch, currentEpoch: agent?.epoch ?? null, mode: agent?.mode ?? null,
      createdAt: t.createdAt, budgetSettledAt: t.budgetSettledAt, nonce: `0x${seg.op.nonce.toString(16)}`, opSucceeded: seg.op.success,
      reading: reading ? { ...reading, usdgLegs: legs } : null,
      counted,
    });
    if (!(tx.block !== null && tx.block.hash === tx.receipt.blockHash)) {
      anomalies.push({ tradeId: t.id, account: t.account, userOpHash: t.userOpHash, txHash: t.txHash, what: "its receipt's block is not the canonical block at that height, or the block could not be read" });
    }
  }

  const distinct = new Set(snap.trades.filter((t) => t.txHash).map((t) => t.txHash!));
  const receiptsRead = Object.values(ev.txs).filter((x) => x.receipt).length;
  const receiptsUnread = Object.values(ev.txs).filter((x) => !x.receipt).length;
  const why: string[] = [];
  if (receiptsUnread) why.push(`${receiptsUnread} receipt(s) could not be read`);
  if (ev.skipped.length) why.push(`${ev.skipped.length} transaction(s) not read: --max-receipts ${o.maxReceipts} was reached (run again with a higher bound, or per --tenant)`);
  if (rowsWithoutTxSettled) why.push(`${rowsWithoutTxSettled} landed or reverted row(s) with a userOpHash carry no tx hash, so their receipt cannot be found without eth_getLogs`);
  if (byValidator["other-chain"]) why.push(`${byValidator["other-chain"]} row(s) belong to a grant on a chain other than the RPC's (${ev.rpcChainId})`);
  const unreadRows = byValidator.unread;
  if (unreadRows && !why.length) why.push(`${unreadRows} row(s) could not be classified`);

  const root = rootRows;
  const byKind: Record<string, number> = {};
  for (const r of root) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  const sumRaw = (dir: "in" | "out") => legsWithoutFlow.filter((l) => l.direction === dir).reduce((s, l) => s + BigInt(l.amountRaw), 0n).toString();
  const records = snap.ownerRecords;
  const totals: AuditReport["totals"] = {
    rowsScanned: snap.trades.length, distinctTxs: distinct.size, receiptsRead, receiptsUnread, receiptsSkippedByBound: ev.skipped.length,
    rowsWithoutTxSettled, rowsWithoutTxOther, byValidator,
    root: {
      rows: root.length, tenants: new Set(root.map((r) => r.tenant ?? r.account)).size, amountUsdg: sum6(root.map((r) => r.amountUsdg)), byKind,
      withFill: root.filter((r) => r.counted.liveBasisBooked).length, withOwnerRecord: root.filter((r) => r.counted.ownerRecord !== null).length,
      inBudgetSeedTrailingDay: root.filter((r) => r.counted.budgetSeedTrailingDay).length,
      budgetSeedSpendUsdg: sum6(root.map((r) => r.counted.budgetSeedSpendUsdg)), budgetSeedGrossUsdg: sum6(root.map((r) => r.counted.budgetSeedGrossUsdg)),
      scoreboardLanded: root.filter((r) => r.counted.scoreboardLanded).length, scoreboardVolumeUsdg: sum6(root.map((r) => r.counted.scoreboardVolumeUsdg)),
      onTradeTape: root.filter((r) => r.counted.tradeTape).length, inChatTrades: root.filter((r) => r.counted.chatTrades).length,
    },
    capitalLegsWithoutFlow: {
      in: { count: legsWithoutFlow.filter((l) => l.direction === "in").length, amountRaw: sumRaw("in") },
      out: { count: legsWithoutFlow.filter((l) => l.direction === "out").length, amountRaw: sumRaw("out") },
      legs: legsWithoutFlow,
    },
  };
  const caveats = [
    "Read only: this audit wrote nothing, and no history is rewritten by it (docs/owner-operations.md says what a reviewed reclassification would need).",
    "The counted flags mirror readers of the SHARED ledger (the budget seed a child is given at spawn, the scoreboard, the profile and feed tapes, chat-trades), " +
      `evaluated at ${new Date(o.nowSec * 1000).toISOString()}. A running child's live ops and spend caps read its own SQLite copy, which this audit cannot see, ` +
      "and which a Postgres edit never changes.",
    "A capital leg without a flow is a USDG deposit or withdrawal the deposit scanner never booked, typically because the trades row's tx hash hid it (deposit-log.ts " +
      "tradeTxHashes). Booking one moves a peak: it is a decision for hwm-repair under review, in the epoch the evidence names.",
  ];
  const ownerRecords: AuditReport["ownerRecords"] = {
    rows: records,
    onAnotherChain: (records ?? []).filter((r) => { const g = grantOf.get(r.account); return g?.chainId !== null && g?.chainId !== undefined && r.chainId !== g.chainId; }),
    withoutTenant: (records ?? []).filter((r) => r.tenant === null),
  };
  const body = {
    format: AUDIT_FORMAT, source: o.source, target: o.target, tenant: o.tenant ? lower(o.tenant) : null,
    capturedAtSec: o.nowSec, rpcChainId: ev.rpcChainId, head: ev.head, maxReceipts: o.maxReceipts,
    coverage: { complete: why.length === 0, why }, rootRows, anomalies, ownerRecords, totals, caveats,
  } satisfies Omit<AuditReport, "auditDigest">;
  // Bound to the code, the database, what Postgres said and what the chain said: a later reviewed tool binds to it.
  const auditDigest = digestOf({ ...body, snapshot: digestOf(snap), evidence: digestOf(ev) });
  return { ...body, auditDigest };
}

/** The exit code: 3 when coverage is incomplete (whatever else was found), 2 when root rows were found, 0 when neither. */
export function auditExitCode(r: AuditReport): 0 | 2 | 3 {
  if (!r.coverage.complete) return 3;
  return r.rootRows.length > 0 ? 2 : 0;
}

/** The report as an operator reads it at the console: counts, public chain data and the digest. */
export function auditLines(r: AuditReport): string[] {
  const t = r.totals;
  const out = [
    `owner-op audit ${r.coverage.complete ? "COMPLETE" : "INCOMPLETE"} — ${t.rowsScanned} trades row(s) with an operation hash, ${t.distinctTxs} transaction(s), ` +
      `${t.receiptsRead} receipt(s) read on chain ${r.rpcChainId}${r.tenant ? `, tenant ${r.tenant}` : ", whole fleet"}`,
    `  by validator: ${Object.entries(t.byValidator).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    `  ROOT (the owner's own key) booked as trades: ${t.root.rows} row(s) across ${t.root.tenants} tenant(s), ${t.root.amountUsdg} USDG; ` +
      `in the trailing-day budget seed ${t.root.inBudgetSeedTrailingDay} (spend ${t.root.budgetSeedSpendUsdg} USDG); scoreboard ${t.root.scoreboardLanded}; ` +
      `trade tape ${t.root.onTradeTape}; chat ${t.root.inChatTrades}; with a fill ${t.root.withFill}`,
    `  capital legs with no flow: in ${t.capitalLegsWithoutFlow.in.count} (${usdg6(BigInt(t.capitalLegsWithoutFlow.in.amountRaw))} USDG), ` +
      `out ${t.capitalLegsWithoutFlow.out.count} (${usdg6(BigInt(t.capitalLegsWithoutFlow.out.amountRaw))} USDG)`,
  ];
  for (const row of r.rootRows) {
    out.push(`  root: ${row.tenant ?? row.account} trade ${row.tradeId} ${row.kind}/${row.status} ${row.amountUsdg} USDG epoch ${row.epoch ?? "?"} — op ${row.userOpHash} ` +
      `tx ${row.txHash}${row.block ? ` block ${row.block}` : ""}${row.reading ? ` (${row.reading.disposition}${row.reading.reasons.length ? `: ${row.reading.reasons.join(",")}` : ""})` : ""}`);
  }
  for (const a of r.anomalies) out.push(`  anomaly: trade ${a.tradeId} ${a.userOpHash} in ${a.txHash}: ${a.what}`);
  for (const w of r.coverage.why) out.push(`  incomplete: ${w}`);
  out.push(`  auditDigest ${r.auditDigest}`);
  return out;
}
