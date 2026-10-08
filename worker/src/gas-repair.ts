/**
 * COMPLETING THE GAS ON ROWS ALREADY WRITTEN — the core of gas-repair-cli.ts.
 *
 * ── WHY ──────────────────────────────────────────────────────────────────
 *
 * The board withholds an agent's whole P&L for a run while any landed or
 * reverted row of it has no gas on record, or gas in wei with no dollar price
 * (web book-performance.ts gasAt: "Gas accounting unavailable"). Three paths
 * wrote such rows until they were fixed — reverts, the orphan sweep and the
 * stranded-op resolver — and an ETH price refusal on the live path wrote more.
 * Fixing the writers stops new ones; the rows already in Postgres keep every
 * run they sit in withheld. This completes them, from the chain.
 *
 * ── WHAT IT WRITES, AND FROM WHAT ────────────────────────────────────────
 *
 * Only NULL gas columns of rows the board counts as missing, and only from:
 *
 *  - the row's own UserOperationEvent, found in its transaction's receipt by
 *    the row's user-op hash and its account as sender: actualGasCost,
 *    actualGasUsed and the paymaster (zero = the account paid). Its success
 *    must agree with the row's status.
 *  - the Chainlink ETH/USD round in force at that receipt's block
 *    (gas-backfill.ts findRoundAt, priceGasAtRound): the price the live path
 *    would have used. A stale or missing round leaves the cost unpriced.
 *
 * Nothing already recorded is overwritten. A row whose recorded wei disagrees
 * with its receipt, or whose recorded owner cost the receipt says a sponsor
 * paid, is left alone and listed as unresolved for a person to read: correcting
 * who paid is not completing a record, it is changing one.
 *
 * ── HOW IT IS SAFE TO RUN ────────────────────────────────────────────────
 *
 * The preview reads Postgres in one read-only snapshot and the chain, and
 * writes nothing. Apply recomputes the same preview and refuses unless its
 * digest is the one confirmed; then, in ONE SERIALIZABLE transaction, each row
 * is updated only if every gas column is still exactly what the preview read
 * (compare-and-set), with a receipt per row in `gas_repairs`. All or nothing.
 * A revert puts each row back only if it still holds exactly what was written.
 *
 * The ledger mirror never rewrites a settled row's gas (it only inserts, and
 * completes rows still 'submitted'), so a completed row stays complete. A
 * child's own SQLite and its hash-chained journal keep what they recorded; the
 * receipt here, with its backup reference, is the record of the repair.
 */
import { createHash } from "node:crypto";
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import { CASH_FEEDS, CHAINLINK_ABI, ENTRYPOINT } from "../../packages/core/src/index";
import type { RpcCall } from "./chain-capital";
import { BACKUP_REF, BookingRefused, canonical } from "./chain-gap-booking";
import type { Db } from "./db";
import type { EthFeed } from "./eth-feed";
import { findRoundAt, priceGasAtRound, type FeedRound } from "./gas-backfill";

export const PREVIEW_FORMAT = "merrymen.gas-repair.preview.v1";
export const APPLY_FORMAT = "merrymen.gas-repair.apply.v1";
export const REVERT_FORMAT = "merrymen.gas-repair.revert.v1";
export const REPAIRS_TABLE = "gas_repairs";
/** Robinhood Chain mainnet. Receipts from any other chain are not this ledger's. */
export const CHAIN_ID = 4663;
/** Transactions read per run, at most, unless the operator says otherwise. */
export const DEFAULT_MAX_RECEIPTS = 500;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const USEROP_EVENT_TOPIC = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";
const ENTRYPOINT_ABI = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);

/** This tool's own refusal: a code and a sentence that names no secret. */
export class GasRepairRefused extends BookingRefused {}

const digestOf = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
const text = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

// ── the snapshot ─────────────────────────────────────────────────────────────

/** The gas columns of one row, as stored. Strings as the ledger keeps them; null is absent. */
export interface GasColumns { gas_wei: string | null; sponsored_gas_wei: string | null; gas_units: string | null; gas_usdg: number | null }

export interface GasRow extends GasColumns {
  id: number;
  account: string;
  status: "landed" | "reverted";
  userOpHash: string | null;
  txHash: string | null;
}

/**
 * The rows the board counts as missing gas, in the board's own words
 * (book-performance.ts gasAt `missing`, less its "ambiguous" nonce clause,
 * which never holds on the shared ledger: the nonce is not mirrored).
 */
const MISSING_SQL = `t.status IN ('landed', 'reverted') AND t.gas_usdg IS NULL
  AND COALESCE(t.gas_wei, '') <> '0'
  AND NOT ((t.gas_wei IS NULL OR t.gas_wei IN ('', '0'))
    AND t.sponsored_gas_wei IS NOT NULL AND t.sponsored_gas_wei NOT IN ('', '0'))`;

/** One read, in the caller's snapshot. `tenant` narrows to one account. */
export async function readGasSnapshot(db: Db, o: { tenant?: string } = {}): Promise<GasRow[]> {
  const rows = (await db.prepare(`SELECT t.id, t.agent_id, t.status, t.user_op_hash, t.tx_hash, t.gas_wei, t.sponsored_gas_wei, t.gas_units, t.gas_usdg
      FROM trades t WHERE ${MISSING_SQL}${o.tenant ? " AND LOWER(t.agent_id) = ?" : ""} ORDER BY t.id`)
    .all(...(o.tenant ? [o.tenant.toLowerCase()] : []))) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    account: String(r.agent_id).toLowerCase(),
    status: r.status === "reverted" ? "reverted" : "landed",
    userOpHash: text(r.user_op_hash)?.toLowerCase() ?? null,
    txHash: text(r.tx_hash)?.toLowerCase() ?? null,
    gas_wei: text(r.gas_wei),
    sponsored_gas_wei: text(r.sponsored_gas_wei),
    gas_units: text(r.gas_units),
    gas_usdg: r.gas_usdg === null || r.gas_usdg === undefined ? null : Number(r.gas_usdg),
  }));
}

// ── the chain ────────────────────────────────────────────────────────────────

/** What one operation's receipt proves about its gas. */
export interface OpEvidence {
  blockNumber: number;
  blockTime: number;
  success: boolean;
  gasWei: bigint;
  gasUnits: bigint;
  payer: "owner" | "sponsor";
}

/** The Chainlink ETH/USD feed over this tool's RPC: one read per round, remembered for the run. */
export function rpcEthFeed(rpc: RpcCall): EthFeed {
  const feed = (CASH_FEEDS.ETH_USD as string).toLowerCase();
  const call = async (data: Hex): Promise<Hex> => (await rpc("eth_call", [{ to: feed, data }, "latest"])) as Hex;
  let decimals: number | null = null;
  const scale = async () => {
    if (decimals === null) {
      decimals = Number(decodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "decimals", data: await call(encodeFunctionData({ abi: CHAINLINK_ABI, functionName: "decimals" })) }));
    }
    return decimals;
  };
  const rounds = new Map<bigint, FeedRound | null>();
  return {
    async latest() {
      try {
        const d = await scale();
        const r = decodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "latestRoundData",
          data: await call(encodeFunctionData({ abi: CHAINLINK_ABI, functionName: "latestRoundData" })) }) as readonly [bigint, bigint, bigint, bigint, bigint];
        const price8 = d >= 8 ? r[1] / 10n ** BigInt(d - 8) : r[1] * 10n ** BigInt(8 - d);
        return { roundId: r[0], priceUsd: Number(r[1]) / 10 ** d, updatedAt: Number(r[3]), price8 };
      } catch {
        return null;
      }
    },
    async round(roundId) {
      if (rounds.has(roundId)) return rounds.get(roundId)!;
      let out: FeedRound | null = null;
      try {
        const d = await scale();
        const r = decodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "getRoundData",
          data: await call(encodeFunctionData({ abi: CHAINLINK_ABI, functionName: "getRoundData", args: [roundId] })) }) as readonly [bigint, bigint, bigint, bigint, bigint];
        out = { roundId: r[0], priceUsd: Number(r[1]) / 10 ** d, updatedAt: Number(r[3]) };
      } catch {
        out = null; // unread is not unset: not remembered, so a retry may read it
        return out;
      }
      rounds.set(roundId, out);
      return out;
    },
  };
}

const quantity = (v: unknown): number => {
  const n = typeof v === "string" && /^0x[0-9a-f]+$/i.test(v) ? Number(BigInt(v)) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new GasRepairRefused("chain", "a receipt or block answered with a malformed number");
  return n;
};

/**
 * The operation's own UserOperationEvent in its transaction's receipt: emitted
 * by the EntryPoint, naming this row's user-op hash and its account as sender.
 * A row without a user-op hash is matched only when the transaction holds
 * exactly one such event for its account. Null when the receipt does not hold
 * one — which is a finding, not a guess.
 */
export async function readOpEvidence(rpc: RpcCall, row: Pick<GasRow, "account" | "userOpHash" | "txHash">,
  blockTimes: Map<number, number>): Promise<OpEvidence | null> {
  if (!row.txHash || !HASH.test(row.txHash)) return null;
  const receipt = (await rpc("eth_getTransactionReceipt", [row.txHash])) as { blockNumber?: unknown; logs?: unknown } | null;
  if (!receipt || !Array.isArray(receipt.logs)) return null;
  const entry = (ENTRYPOINT.v07 as string).toLowerCase();
  const found: Omit<OpEvidence, "blockNumber" | "blockTime">[] = [];
  for (const log of receipt.logs as { address?: unknown; topics?: unknown; data?: unknown }[]) {
    if (String(log.address).toLowerCase() !== entry || !Array.isArray(log.topics) || String(log.topics[0]).toLowerCase() !== USEROP_EVENT_TOPIC) continue;
    let d;
    try {
      d = decodeEventLog({ abi: ENTRYPOINT_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data as Hex });
    } catch {
      continue;
    }
    if (String(d.args.sender).toLowerCase() !== row.account) continue;
    if (row.userOpHash && String(d.args.userOpHash).toLowerCase() !== row.userOpHash) continue;
    found.push({
      success: Boolean(d.args.success),
      gasWei: d.args.actualGasCost,
      gasUnits: d.args.actualGasUsed,
      payer: /^0x0{40}$/i.test(String(d.args.paymaster)) ? "owner" : "sponsor",
    });
  }
  if (found.length !== 1) return null;
  const blockNumber = quantity(receipt.blockNumber);
  let blockTime = blockTimes.get(blockNumber);
  if (blockTime === undefined) {
    const block = (await rpc("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false])) as { timestamp?: unknown } | null;
    if (!block) return null;
    blockTime = quantity(block.timestamp);
    blockTimes.set(blockNumber, blockTime);
  }
  return { ...found[0]!, blockNumber, blockTime };
}

// ── the plan ─────────────────────────────────────────────────────────────────

export interface RepairPrice { roundId: string; priceUsd: number; lagSec: number }
export interface RowRepair {
  id: number;
  account: string;
  txHash: string;
  userOpHash: string | null;
  blockNumber: number;
  blockTime: number;
  payer: "owner" | "sponsor";
  before: GasColumns;
  after: GasColumns;
  /** The round it was priced at; null when owner-paid and no honest round existed (wei only), or sponsored. */
  priced: RepairPrice | null;
}
export interface Unresolved { id: number; account: string; why: string }

export interface GasRepairPlan {
  format: typeof PREVIEW_FORMAT;
  tenant: string | null;
  /** Which database (gas-repair-cli.ts targetDigest): an apply anywhere else recomputes a different digest. */
  target: string;
  source: Record<string, string>;
  repairs: RowRepair[];
  unresolved: Unresolved[];
  /** Rows the snapshot found but the receipt cap left unread. Read on a later run. */
  deferred: number;
  previewDigest: string;
}

/** One row's repair from its evidence, or why there is none. PURE. */
export function repairOf(row: GasRow, ev: OpEvidence | null, price: { usdg: number; round: RepairPrice } | null):
  { repair: Omit<RowRepair, "id" | "account" | "txHash" | "userOpHash"> } | { why: string } {
  if (!row.txHash) return { why: "no transaction hash on the row, so no receipt to read" };
  if (!ev) return { why: "its receipt holds no single UserOperationEvent for this account and user-op hash" };
  if (ev.success !== (row.status === "landed")) return { why: `the receipt says the operation ${ev.success ? "succeeded" : "reverted"}, the row says ${row.status}` };
  if (row.gas_wei !== null && row.gas_wei !== ev.gasWei.toString()) return { why: "the row's recorded gas in wei differs from its receipt — left for a person" };
  if (row.gas_units !== null && row.gas_units !== ev.gasUnits.toString()) return { why: "the row's recorded gas units differ from its receipt — left for a person" };
  if (ev.payer === "sponsor" && row.gas_wei !== null) {
    return { why: "the row books the cost to the owner, and the receipt says a sponsor paid — correcting who paid is left for a person" };
  }
  // THE SPONSOR COLUMN IS CHECKED AGAINST THE RECEIPT TOO, BOTH WAYS. An
  // owner-paid receipt beside a recorded sponsor cost would leave the row
  // claiming both payers; a sponsor-paid receipt beside a sponsor figure that
  // is not this receipt's — the "0" placeholder included — would overwrite a
  // value, not fill a NULL. Either is a disagreement, and left for a person.
  if (ev.payer === "owner" && row.sponsored_gas_wei !== null && row.sponsored_gas_wei !== "0") {
    return { why: "the row books a sponsor cost, and the receipt says the owner paid — correcting who paid is left for a person" };
  }
  if (ev.payer === "sponsor" && row.sponsored_gas_wei !== null && row.sponsored_gas_wei !== ev.gasWei.toString()) {
    return { why: "the row's recorded sponsor cost differs from its receipt — left for a person" };
  }
  const units = row.gas_units ?? (ev.gasUnits > 0n ? ev.gasUnits.toString() : null);
  const after: GasColumns = ev.payer === "sponsor"
    ? { gas_wei: null, sponsored_gas_wei: ev.gasWei.toString(), gas_units: units, gas_usdg: null }
    : { gas_wei: ev.gasWei.toString(), sponsored_gas_wei: row.sponsored_gas_wei, gas_units: units,
        gas_usdg: ev.gasWei === 0n ? 0 : price ? price.usdg : null };
  const before: GasColumns = { gas_wei: row.gas_wei, sponsored_gas_wei: row.sponsored_gas_wei, gas_units: row.gas_units, gas_usdg: row.gas_usdg };
  if (canonical(after) === canonical(before)) return { why: "the receipt adds nothing the row does not hold, and no round prices it" };
  return {
    repair: {
      blockNumber: ev.blockNumber, blockTime: ev.blockTime, payer: ev.payer, before, after,
      priced: ev.payer === "owner" && ev.gasWei > 0n && price ? price.round : null,
    },
  };
}

/**
 * The preview: the snapshot's rows, each read off its receipt and priced at its
 * block. Deterministic for a given ledger: receipts, block times and past
 * rounds do not change, so an apply recomputes the same digest unless a row did.
 */
export async function planGasRepair(rows: readonly GasRow[], rpc: RpcCall, o: {
  tenant: string | null; target: string; source: Record<string, string>; maxReceipts: number; feed?: EthFeed;
}): Promise<GasRepairPlan> {
  const chainId = Number(BigInt(String(await rpc("eth_chainId", []))));
  if (chainId !== CHAIN_ID) throw new GasRepairRefused("chain", `the RPC serves chain ${chainId}, not Robinhood Chain (${CHAIN_ID})`);
  const feed = o.feed ?? rpcEthFeed(rpc);
  const latest = await feed.latest();
  const blockTimes = new Map<number, number>();
  const repairs: RowRepair[] = [];
  const unresolved: Unresolved[] = [];
  const txs = new Set<string>();
  let deferred = 0;
  for (const row of rows) {
    if (row.txHash && !txs.has(row.txHash) && txs.size >= o.maxReceipts) { deferred++; continue; }
    if (row.txHash) txs.add(row.txHash);
    const ev = row.txHash ? await readOpEvidence(rpc, row, blockTimes) : null;
    let price: { usdg: number; round: RepairPrice } | null = null;
    if (ev && ev.payer === "owner" && ev.gasWei > 0n && latest) {
      const round = await findRoundAt(ev.blockTime, latest, (id) => feed.round(id));
      const p = priceGasAtRound({ gasWei: ev.gasWei, tradeAtSec: ev.blockTime, round });
      if (p.kind === "priced") price = { usdg: p.usdg, round: { roundId: p.roundId.toString(), priceUsd: p.priceUsd, lagSec: p.lagSec } };
    }
    const r = repairOf(row, ev, price);
    if ("why" in r) unresolved.push({ id: row.id, account: row.account, why: r.why });
    else repairs.push({ id: row.id, account: row.account, txHash: row.txHash!, userOpHash: row.userOpHash, ...r.repair });
  }
  const body = { format: PREVIEW_FORMAT, tenant: o.tenant, target: o.target, source: o.source, repairs, unresolved, deferred };
  return { ...body, format: PREVIEW_FORMAT, previewDigest: digestOf(body) };
}

/** What the console says about a plan: counts and public chain data only. */
export function planLines(plan: GasRepairPlan): string[] {
  const priced = plan.repairs.filter((r) => r.after.gas_usdg !== null).length;
  const sponsored = plan.repairs.filter((r) => r.payer === "sponsor").length;
  const lines = [
    `gas repair${plan.tenant ? ` for ${plan.tenant}` : " for every account"}: ${plan.repairs.length} row(s) to complete ` +
      `(${priced} priced, ${sponsored} sponsor-paid, ${plan.repairs.length - priced - sponsored} wei only), ` +
      `${plan.unresolved.length} unresolved, ${plan.deferred} deferred past the receipt cap`,
  ];
  for (const r of plan.repairs) {
    lines.push(`  row ${r.id} ${r.account} tx ${r.txHash} block ${r.blockNumber}: ${r.payer}` +
      (r.payer === "owner" ? ` ${r.after.gas_wei} wei${r.after.gas_usdg === null ? " (no round — stays unpriced)" : ` = $${r.after.gas_usdg.toFixed(6)}` +
        (r.priced ? ` at $${r.priced.priceUsd.toFixed(2)}, round ${r.priced.lagSec}s old` : "")}` : ` ${r.after.sponsored_gas_wei} wei, not the owner's`));
  }
  for (const u of plan.unresolved) lines.push(`  unresolved row ${u.id} ${u.account}: ${u.why}`);
  lines.push(`previewDigest ${plan.previewDigest}`);
  return lines;
}

// ── apply ────────────────────────────────────────────────────────────────────

/** One receipt per completed row: what it held, what was written, under which preview and backup. Kept after a revert. */
export const REPAIRS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS ${REPAIRS_TABLE} (
    repair_id TEXT NOT NULL,
    trade_id INTEGER NOT NULL,
    account TEXT NOT NULL,
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    evidence_json TEXT NOT NULL,
    preview_digest TEXT NOT NULL,
    backup_ref TEXT NOT NULL,
    state TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL,
    reverted_at_ms INTEGER,
    PRIMARY KEY (repair_id, trade_id)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ${REPAIRS_TABLE}_once ON ${REPAIRS_TABLE} (trade_id) WHERE state = 'applied'
`;

export interface ApplyReport {
  format: typeof APPLY_FORMAT;
  repairId: string;
  tenant: string | null;
  target: string;
  previewDigest: string;
  backupRef: string;
  appliedAtMs: number;
  rows: Array<{ id: number; account: string; before: GasColumns; after: GasColumns }>;
  /** Written inside the transaction as "unknown", replaced by "committed" once the COMMIT is answered. */
  commitOutcome?: "unknown" | "committed";
  reportDigest: string;
}

const COLUMNS_EQUAL = "COALESCE(gas_wei, '') = COALESCE(?, '') AND COALESCE(sponsored_gas_wei, '') = COALESCE(?, '') " +
  // Typed, because Postgres cannot infer a bare parameter's type from IS NULL.
  "AND COALESCE(gas_units, '') = COALESCE(?, '') AND ((gas_usdg IS NULL AND CAST(? AS DOUBLE PRECISION) IS NULL) OR gas_usdg = CAST(? AS DOUBLE PRECISION))";
const columnsArgs = (c: GasColumns) => [c.gas_wei, c.sponsored_gas_wei, c.gas_units, c.gas_usdg, c.gas_usdg];

export function stampCommitOutcome(r: ApplyReport, outcome: "unknown" | "committed"): ApplyReport {
  const { reportDigest: _d, commitOutcome: _c, ...body } = r;
  void _d; void _c;
  const next = { ...body, commitOutcome: outcome };
  return { ...next, reportDigest: digestOf(next) };
}

/**
 * Write the confirmed plan in ONE transaction (the caller's db.tx — SERIALIZABLE
 * on Postgres, gas-repair-cli.ts). Every row compare-and-set against what the
 * preview read; one that moved refuses the whole apply, writing nothing.
 */
export async function applyGasRepair(db: Db, plan: GasRepairPlan, o: {
  confirm: string; backupRef: string; repairId: string; nowMs: number; persist?: (r: ApplyReport) => void | Promise<void>;
}): Promise<ApplyReport> {
  if (!DIGEST.test(o.confirm) || o.confirm !== plan.previewDigest) {
    throw new GasRepairRefused("confirm-mismatch", "the confirmed digest is not this preview's: the ledger or the code changed since — preview again");
  }
  if (!BACKUP_REF.test(o.backupRef)) throw new GasRepairRefused("backup-ref", "--backup-ref must name the backup taken before this apply (letters, digits, . _ : -)");
  if (!plan.repairs.length) throw new GasRepairRefused("nothing-to-repair", "the preview proposes no row: nothing to apply (already applied?)");
  return db.tx(async (tx) => {
    for (const statement of REPAIRS_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await tx.exec(statement);
    const rows: ApplyReport["rows"] = [];
    for (const r of plan.repairs) {
      const res = await tx.prepare(`UPDATE trades SET gas_wei = ?, sponsored_gas_wei = ?, gas_units = ?, gas_usdg = ?
          WHERE id = ? AND LOWER(agent_id) = ? AND status IN ('landed', 'reverted') AND ${COLUMNS_EQUAL}`)
        .run(r.after.gas_wei, r.after.sponsored_gas_wei, r.after.gas_units, r.after.gas_usdg, r.id, r.account, ...columnsArgs(r.before));
      if (res.changes !== 1) {
        throw new GasRepairRefused("row-moved", `row ${r.id} no longer holds what the preview read: nothing was written — preview again`);
      }
      await tx.prepare(`INSERT INTO ${REPAIRS_TABLE} (repair_id, trade_id, account, before_json, after_json, evidence_json, preview_digest, backup_ref, state, applied_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'applied', ?)`)
        .run(o.repairId, r.id, r.account, canonical(r.before), canonical(r.after),
          canonical({ txHash: r.txHash, userOpHash: r.userOpHash, blockNumber: r.blockNumber, blockTime: r.blockTime, payer: r.payer, priced: r.priced }),
          plan.previewDigest, o.backupRef, o.nowMs);
      rows.push({ id: r.id, account: r.account, before: r.before, after: r.after });
    }
    const body = { format: APPLY_FORMAT, repairId: o.repairId, tenant: plan.tenant, target: plan.target, previewDigest: plan.previewDigest,
      backupRef: o.backupRef, appliedAtMs: o.nowMs, rows };
    const report: ApplyReport = { ...body, format: APPLY_FORMAT, reportDigest: digestOf(body) };
    await o.persist?.(stampCommitOutcome(report, "unknown"));
    return report;
  });
}

// ── revert ───────────────────────────────────────────────────────────────────

/** An apply report, checked whole against its own digest. One that does not verify reverts nothing. */
export function parseApplyReport(raw: string): ApplyReport {
  let r: ApplyReport;
  try { r = JSON.parse(raw) as ApplyReport; } catch { throw new GasRepairRefused("report", "the apply report is not JSON"); }
  const { reportDigest, ...body } = r ?? ({} as ApplyReport);
  if (r?.format !== APPLY_FORMAT || !DIGEST.test(String(reportDigest)) || digestOf(body) !== reportDigest) {
    throw new GasRepairRefused("report", "the apply report does not verify against its own digest");
  }
  if (typeof r.repairId !== "string" || !r.repairId || !Array.isArray(r.rows) || !r.rows.length
    || r.rows.some((x) => !Number.isSafeInteger(x.id) || !ADDRESS.test(String(x.account)))) {
    throw new GasRepairRefused("report", "the apply report's rows do not verify");
  }
  return r;
}

export interface RevertReport {
  format: typeof REVERT_FORMAT; repairId: string; revertedAtMs: number; outcome: "reverted" | "already-reverted"; rows: number[]; reportDigest: string;
}

/**
 * Put every row back, only if each still holds exactly what the apply wrote and
 * its receipt still says applied. All or nothing. A repair already reverted
 * answers so and changes nothing.
 */
export async function revertGasRepair(db: Db, report: ApplyReport, o: { nowMs: number }): Promise<RevertReport> {
  return db.tx(async (tx) => {
    const receipts = (await tx.prepare(`SELECT trade_id, state FROM ${REPAIRS_TABLE} WHERE repair_id = ?`).all(report.repairId)) as Record<string, unknown>[];
    const done = (outcome: RevertReport["outcome"]): RevertReport => {
      const body = { format: REVERT_FORMAT, repairId: report.repairId, revertedAtMs: o.nowMs, outcome, rows: report.rows.map((r) => r.id) };
      return { ...body, format: REVERT_FORMAT, reportDigest: digestOf(body) };
    };
    if (receipts.length !== report.rows.length) {
      throw new GasRepairRefused("no-receipts", `the database holds ${receipts.length} receipt(s) of repair ${report.repairId}, not ${report.rows.length}: ` +
        "it did not commit there, or this is another database — nothing was changed");
    }
    if (receipts.every((r) => r.state === "reverted")) return done("already-reverted");
    if (!receipts.every((r) => r.state === "applied")) throw new GasRepairRefused("mixed", "the repair's receipts are in more than one state: escalate");
    for (const r of report.rows) {
      const res = await tx.prepare(`UPDATE trades SET gas_wei = ?, sponsored_gas_wei = ?, gas_units = ?, gas_usdg = ?
          WHERE id = ? AND LOWER(agent_id) = ? AND ${COLUMNS_EQUAL}`)
        .run(r.before.gas_wei, r.before.sponsored_gas_wei, r.before.gas_units, r.before.gas_usdg, r.id, r.account, ...columnsArgs(r.after));
      if (res.changes !== 1) throw new GasRepairRefused("row-changed", `row ${r.id} no longer holds what the repair wrote: nothing was reverted`);
    }
    await tx.prepare(`UPDATE ${REPAIRS_TABLE} SET state = 'reverted', reverted_at_ms = ? WHERE repair_id = ? AND state = 'applied'`).run(o.nowMs, report.repairId);
    return done("reverted");
  });
}
