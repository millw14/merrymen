/**
 * Amend the evidence of ONE inferred deposit in an original book that has
 * traded. Never create, replace or rebase a book, and never move money: only
 * the flow's provenance changes, in both books, exactly as the untouched-book
 * protocol (receipt-attestation.ts) changes it, under the same controls,
 * lease, hold, audit table and source barrier.
 *
 * WHERE THE RECEIPT MUST BE. A traded book's chain history is not one deposit,
 * so the complete-history proof of the untouched protocol cannot apply. The
 * window comes from the book itself instead: the original book's hash-chained
 * journal records the inferred fact between two live cash readings, and each
 * reading records the block its tick read. The deposit landed after the
 * baseline's cash (the last unheld live reading before the fact) and by the
 * booking look's cash (the first live reading after it). Each tick reads its
 * block before its cash and endpoints' heads differ, so the window reaches
 * WINDOW_MARGIN_BLOCKS past both readings.
 *
 * WHAT MUST BE IN IT. The deposit scanner's own reader classifies every USDG
 * movement of the window from its receipt (deposit-log.ts findTransferFlows,
 * with the book's trades, the grant's custody and every flow identity either
 * book already holds). Every capital transfer whose transaction any flow row of
 * either book names is left out. Of the rest, exactly ONE must be the change,
 * by the live booker's own rule (flow-inference.ts RULE 4, matchInferredDelta):
 * inbound and equal to the inferred amount to the micro-USDG. It must also be
 * at least SCAN_LOOKBACK_BLOCKS deep and timed between the readings. Anything
 * else refuses: two transfers that sum to the change cannot be told from one
 * that is it beside one that is not.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Hex } from "viem";
import { CASH } from "../../packages/core/src/index";
import { fsyncDirSync, writeFileAtomicSync } from "./atomic-write";
import { deriveBootstrapAccounting } from "./bootstrap-source";
import type { RpcCall } from "./chain-capital";
import { BOOKING_CONFIRMATIONS } from "./chain-confirmations";
import { wrapSqlite, type Db } from "./db";
import { findTransferFlows, flowKey, TRANSFER_TOPIC, type TransferFlow } from "./deposit-log";
import { matchInferredDelta } from "./flow-inference";
import type { ReceiptLog } from "./fills";
import type { RawLog, ReconcileChain } from "./inflight-reconcile";
import { assertLedgerSourceContinuity } from "./ledger-safeguard";
import { attestOriginalReceipt, authority, corrected, fileIdentity, present, PROTECTED, refuse, rows, safeInteger, sharedIdentity,
  type Receipt, type ReceiptAttestationOptions, type ReceiptAttestationReport } from "./receipt-attestation";
import { attestationCustody } from "./receipt-attestation-owner";
import { ensureReceiptAttestationSchema, readReceiptAttestation } from "./receipt-attestation-state";
import { redactUrls } from "./redact-urls";
import { canonicalJson, JOURNAL_GENESIS, journalHash } from "./store";

const MARKER = "ledger-source-blocked.json";
/**
 * index.ts DEPOSIT_LOOKBACK_BLOCKS. An amended receipt is a chain-log row, and
 * the highest one is the deposit scan's resume mark (store.ts
 * lastChainLogBlock): deeper than this, the scan opens at the head instead of
 * reading back from it.
 */
export const SCAN_LOOKBACK_BLOCKS = 200_000n;
/** Past each reading's block: the cash read after it, and a lagging endpoint, at ~10 blocks a second. */
export const WINDOW_MARGIN_BLOCKS = 3_000n;
/** The widest window: a held look keeps its baseline for up to 26 hours, at ~10 blocks a second. */
export const MAX_WINDOW_BLOCKS = 1_200_000n;
/** Seconds between a reading's journal time, the booking time and block time. */
const SKEW_SEC = 600;
/** A tick books its flow and journals it in one transaction: one second apart at most, give or take. */
const ENTRY_SKEW_SEC = 5;
const KEY_WINDOW = 50_000;
const MAX_ROWS = 5_000_000;
const HASH = /^0x[0-9a-f]{64}$/i;
const HEX = /^0x[0-9a-f]+$/i;
const USDG = CASH.USDG.toLowerCase();
/** Tables an account's history makes long, read in pages; the other protected tables are snapshots. */
const LONG = new Set<string>(["trades", "equity", "fee_accruals", "owner_operations"]);

type Row = Record<string, unknown>;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const digest = (rs: readonly Row[]) => hash(rs.map(canonicalJson).sort());
/** A flow's fact: every column but the book's own row id and spelling of the account. */
const fact = (r: Row) => ({ ...r, id: 0, agent_id: String(r.agent_id).toLowerCase() });
const hex = (n: bigint) => `0x${n.toString(16)}`;
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !HEX.test(value)) refuse("chain evidence is malformed");
  return BigInt(value);
}
/** The stored REAL as exact micro-USDG, or a refusal: a deposit is matched to the micro, never rounded into a match. */
function micro(flow: Row): bigint {
  const amount = Number(flow.amount_usdg), n = Math.round(amount * 1e6);
  if (!(amount > 0) || !Number.isSafeInteger(n) || n / 1e6 !== amount) refuse("the flow's amount is not an exact micro-USDG figure");
  return BigInt(n);
}

interface Reading { seq: number; hash: string; at: number; blockNumber: number }
interface Journal {
  count: number; digest: string;
  /** The last entry of the flow's epoch: the correcting mark extends it. */
  head: { seq: number; hash: string };
  /** The original inferred fact, and the live cash readings either side of it. */
  entry: { seq: number; hash: string; at: number };
  baseline: Reading; booking: Reading;
}
interface Book {
  agent: Row;
  /** The selected flow as stored. */
  flow: Row;
  /** Every flow of the account, the selected one as originally booked. */
  flows: string;
  protected: string;
  /** Original book only; the shared journal is part of `protected`. */
  journal?: Journal;
}
interface Window { fromBlock: number; toBlock: number; baselineBlock: number; bookingBlock: number }
interface Plan {
  version: 2; tenant: string; account: string; chainId: number;
  file: { inode: string; identity: Row; volumeId: string };
  source: Row; grant: Row; marks: Row[];
  local: Book; shared: Book; window: Window; receipt: Receipt;
  /** Exact RPC responses used for the original verification; no credentials or keys. */
  evidence: Array<{ method: string; params: unknown[]; result: unknown }>;
}
export interface TradedReceiptAttestationOptions extends ReceiptAttestationOptions {
  /** The inferred flow's id in the SHARED book (flows.id); the original row is found by its fact. */
  sharedFlowId: number;
}
export interface TradedReceiptAttestationReport {
  state: "preview" | "pending" | "applied";
  protocol: "traded-book";
  approvalDigest: string;
  tenant: string; account: string; amountUsdg: number;
  localFlowId: number; sharedFlowId: number; receipt: Receipt; window: Window;
  /** What the next spawn's anchor reads, micro-USDG: predicted until applied, then as read. Null when it cannot be read. */
  anchor: { contributions: string; evidenced: string; unevidencedRows: number } | null;
}
/** What a re-read expects of the selected flow, from the plan. */
interface Expected { original: Row; corrected: Row; correction?: string }
interface Read {
  book: Book; flows: Row[]; amended: boolean;
  /** Original book only: each trade transaction and its operations, null when a row names none (store.ts tradeOpsInTx). */
  trades: Map<string, Set<string> | null>;
  /** Transactions an earlier repair quarantined or an owner record names. */
  barred: Set<string>;
}

/**
 * Every row of one account, in key order, read in fixed windows of the unique
 * integer key. The shared tables hold the whole fleet and have no index on
 * LOWER(agent_id): a key window is a primary-key range, so one digest is one
 * pass over the table, and memory is bounded by one window.
 */
async function eachRow(db: Db, table: string, key: "id" | "seq", account: string, visit: (row: Row) => void): Promise<void> {
  const top = await db.prepare(`SELECT MAX(${key}) AS top FROM ${table}`).get() as { top?: unknown } | undefined;
  const last = top?.top === null || top?.top === undefined ? 0 : safeInteger(top.top);
  let previous = 0, seen = 0;
  for (let from = 0; from < last; from += KEY_WINDOW) {
    const page = await db.prepare(`SELECT * FROM ${table} WHERE LOWER(agent_id) = ? AND ${key} > ? AND ${key} <= ? ORDER BY ${key}`)
      .all(account, from, Math.min(from + KEY_WINDOW, last)) as Row[];
    for (const row of page) {
      const k = safeInteger(row[key]);
      if (k <= previous) refuse("accounting evidence is out of order");
      if (++seen > MAX_ROWS) refuse("accounting evidence exceeds the bounded repair");
      previous = k; visit(row);
    }
  }
}
async function streamed(db: Db, table: string, key: "id" | "seq", account: string, also?: (row: Row) => void): Promise<string> {
  const sha = createHash("sha256");
  let count = 0;
  await eachRow(db, table, key, account, row => { count++; sha.update(canonicalJson(row)).update("\n"); also?.(row); });
  return `${count}:${sha.digest("hex")}`;
}

function originalFact(p: Row, flow: Row, account: string, epoch: number, chainId: number): boolean {
  return p.source === "inferred" && p.direction === "in" && Number(p.amountUsdg) === Number(flow.amount_usdg)
    && p.txHash == null && p.blockNumber == null && p.logIndex == null
    && (p.agentId == null || String(p.agentId).toLowerCase() === account)
    && (p.epoch == null || safeInteger(p.epoch) === epoch) && (p.chainId == null || safeInteger(p.chainId) === chainId);
}

/**
 * The whole original journal, verified as each (account, epoch) chain the
 * store appends to, contiguous, in one spelling of the account. A matching
 * correcting mark must be its last entry, and is left out of the state.
 */
async function journalOf(db: Db, account: string, flow: Row, epoch: number, chainId: number, correction?: string): Promise<Journal> {
  const spelling = String(flow.agent_id), bookedAt = safeInteger(flow.at), heads = new Map<number, string>(), sha = createHash("sha256");
  let count = 0, lastSeq = 0, corrected = false, entries = 0;
  let head: Journal["head"] | null = null, entry: Journal["entry"] | null = null;
  let baseline: Reading | null = null, booking: Reading | null = null, unheld: Reading | null = null;
  await eachRow(db, "journal", "seq", account, row => {
    if (corrected) refuse("correction journal is missing, duplicated or followed by another writer");
    const seq = safeInteger(row.seq), rowEpoch = safeInteger(row.epoch), prev = heads.get(rowEpoch) ?? JOURNAL_GENESIS;
    let payload: Row;
    try { payload = JSON.parse(String(row.payload_json)) as Row; } catch { return refuse("journal hash chain is invalid"); }
    if (row.agent_id !== spelling || seq !== lastSeq + 1 || typeof row.payload_json !== "string" || row.prev_hash !== prev
        || canonicalJson(payload) !== row.payload_json || journalHash(prev, row.payload_json) !== row.hash) refuse("journal hash chain is invalid");
    heads.set(rowEpoch, String(row.hash)); lastSeq = seq;
    if (correction !== undefined && row.payload_json === correction) {
      if (row.kind !== "mark" || rowEpoch !== epoch) refuse("correction journal is missing, duplicated or followed by another writer");
      corrected = true; return;
    }
    count++; sha.update(canonicalJson(row)).update("\n");
    if (rowEpoch !== epoch) return;
    head = { seq, hash: String(row.hash) };
    const at = safeInteger(row.at);
    if (row.kind === "flow" && originalFact(payload, flow, account, epoch, chainId) && at >= bookedAt && at <= bookedAt + ENTRY_SKEW_SEC) {
      entries++; entry = { seq, hash: String(row.hash), at }; baseline = unheld; booking = null; return;
    }
    if (row.kind !== "mark" || payload.mode !== "live" || typeof payload.blockNumber !== "string" || !/^(0|[1-9][0-9]*)$/.test(payload.blockNumber)) return;
    const reading = { seq, hash: String(row.hash), at, blockNumber: safeInteger(payload.blockNumber) };
    if (entry && !booking) booking = reading;
    if (payload.flowsHeld !== true) unheld = reading;
  });
  if (correction !== undefined && !corrected) refuse("correction journal is missing, duplicated or followed by another writer");
  if (entries !== 1 || !entry || !head) refuse("original flow journal does not hold exactly one entry for this inferred deposit");
  if (!baseline || !booking) refuse("no live cash reading with a block brackets the flow in its journal");
  return { count, digest: sha.digest("hex"), head, entry, baseline, booking };
}

/** One book as the plan binds it. `pick` selects the flow; `expected` recognises its amendment. */
async function readBook(db: Db, o: { account: string; chainId: number }, local: boolean, pick: (flows: Row[]) => Row[], expected?: Expected): Promise<Read> {
  const account = o.account;
  if (local) {
    for (const table of [...PROTECTED, "flows", "journal"]) {
      const key = table === "agents" ? "smart_account" : "agent_id";
      if (await db.prepare(`SELECT 1 FROM ${table} WHERE LOWER(${key}) <> ? OR ${key} IS NULL LIMIT 1`).get(account)) refuse("local book contains a different account");
    }
  }
  const agents = await rows(db, "agents", account);
  if (agents.length !== 1 || agents[0]!.mode !== "live" || safeInteger(agents[0]!.chain_id) !== o.chainId || safeInteger(agents[0]!.epoch) < 1) refuse("account is not one live book on this chain");
  const epoch = safeInteger(agents[0]!.epoch), flows = await rows(db, "flows", account), picked = pick(flows);
  if (picked.length !== 1) refuse("the selected flow is not exactly one row of this account");
  const flow = picked[0]!, amended = !!expected && same(flow, expected.corrected), original = amended ? expected!.original : flow;
  const parts: Record<string, string> = {}, trades = new Map<string, Set<string> | null>(), barred = new Set<string>();
  const bar = (row: Row) => { if (typeof row.tx_hash === "string" && row.tx_hash) barred.add(row.tx_hash.toLowerCase()); };
  for (const table of PROTECTED) {
    if (!LONG.has(table)) {
      const rs = await rows(db, table, account);
      if (table === "flows_quarantine") rs.forEach(bar);
      parts[table] = digest(rs); continue;
    }
    parts[table] = await streamed(db, table, "id", account, row => {
      if (table === "owner_operations") bar(row);
      if (table !== "trades" || !local || typeof row.tx_hash !== "string" || !row.tx_hash) return;
      const tx = row.tx_hash.toLowerCase(), ops = trades.has(tx) ? trades.get(tx)! : new Set<string>();
      trades.set(tx, ops === null || !row.user_op_hash ? null : ops.add(String(row.user_op_hash).toLowerCase()));
    });
  }
  if (!local) parts.journal = await streamed(db, "journal", "seq", account);
  const book: Book = { agent: agents[0]!, flow, flows: digest(flows.map(r => (r === flow ? original : r))), protected: hash(parts),
    ...(local ? { journal: await journalOf(db, account, original, epoch, o.chainId, amended ? expected!.correction : undefined) } : {}) };
  return { book, flows, amended, trades, barred };
}

async function readLocal(o: TradedReceiptAttestationOptions, pick: (flows: Row[]) => Row[], expected?: Expected, shared = o.shared): Promise<Read & { file: Plan["file"] }> {
  const actual = fileIdentity(o), raw = new DatabaseSync(actual.file, { readOnly: true });
  try {
    const db = wrapSqlite(raw), identities = raw.prepare("SELECT * FROM ledger_source_identity").all() as Row[];
    if (identities.length !== 1 || identities[0]!.tenant !== o.tenant.toLowerCase()
        || String(identities[0]!.smart_account).toLowerCase() !== o.smartAccount.toLowerCase() || safeInteger(identities[0]!.chain_id) !== o.chainId) refuse("local book identity differs");
    const read = await readBook(db, { account: o.smartAccount.toLowerCase(), chainId: o.chainId }, true, pick, expected);
    await assertLedgerSourceContinuity(db, shared, o.tenant.toLowerCase());
    return { ...read, file: { inode: actual.inode, identity: identities[0]!, volumeId: o.volume.id } };
  } finally { raw.close(); }
}

const byId = (flow: Row) => (flows: Row[]) => flows.filter(r => safeInteger(r.id) === safeInteger(flow.id));
function approvalDigest(plan: Plan): string { const { evidence: _evidence, ...stable } = plan; return hash(stable); }
function amendment(plan: Plan): Row {
  const { entry, count, digest: journalDigest, head } = plan.local.journal!;
  return { receiptAttestation: { version: 2, approvalDigest: approvalDigest(plan), sourceGeneration: plan.source.generation,
    originalFlow: plan.local.flow, correctedFlow: corrected(plan.local.flow, plan.receipt, plan.chainId), receipt: plan.receipt,
    window: plan.window, originalEntry: entry, originalJournal: { count, digest: journalDigest, head }, planHash: hash(plan) } };
}
const expectedLocal = (plan: Plan): Expected => ({ original: plan.local.flow, corrected: corrected(plan.local.flow, plan.receipt, plan.chainId),
  correction: canonicalJson(amendment(plan)) });
const expectedShared = (plan: Plan): Expected => ({ original: plan.shared.flow, corrected: corrected(plan.shared.flow, plan.receipt, plan.chainId) });
function markerValue(plan: Plan): string {
  return canonicalJson({ version: 2, state: "pending-receipt-attestation", tenant: plan.tenant, approvalDigest: approvalDigest(plan),
    planHash: hash(plan), sourceGeneration: plan.source.generation, sharedFlowId: plan.shared.flow.id });
}
function assertMarker(o: TradedReceiptAttestationOptions, plan: Plan, required: boolean): void {
  const file = path.join(o.home, MARKER);
  if (!present(file)) { if (required) refuse("repair barrier disappeared"); return; }
  if (!lstatSync(file).isFile() || lstatSync(file).size > 4096 || readFileSync(file, "utf8") !== markerValue(plan)) refuse("another or modified source barrier exists");
}

async function verify(o: TradedReceiptAttestationOptions, plan: Plan, shared = o.shared): Promise<{ localAmended: boolean; sharedAmended: boolean; local: Read; common: Read }> {
  authority(o);
  const identity = await sharedIdentity(shared, o), local = await readLocal(o, byId(plan.local.flow), expectedLocal(plan), shared);
  const common = await readBook(shared, { account: plan.account, chainId: plan.chainId }, false, byId(plan.shared.flow), expectedShared(plan));
  if (!same(identity, { source: plan.source, grant: plan.grant, marks: plan.marks }) || !same(local.file, plan.file)) refuse("source, grant or cursor evidence changed");
  if (!same({ ...local.book, flow: plan.local.flow }, plan.local) || !same({ ...common.book, flow: plan.shared.flow }, plan.shared)
      || (!local.amended && !same(local.book.flow, plan.local.flow)) || (!common.amended && !same(common.book.flow, plan.shared.flow))) refuse("accounting preimages changed");
  if (common.amended && !local.amended) refuse("shared amendment has no original-source amendment");
  authority(o); return { localAmended: local.amended, sharedAmended: common.amended, local, common };
}

/** The readings' blocks, widened by the margin. Pure: the same journal always gives the same window. */
function windowOf(journal: Journal): Window {
  const lo = BigInt(journal.baseline.blockNumber), hi = BigInt(journal.booking.blockNumber);
  if (hi <= lo) refuse("the readings around the flow are out of block order");
  const fromBlock = lo + 1n > WINDOW_MARGIN_BLOCKS ? lo + 1n - WINDOW_MARGIN_BLOCKS : 0n, toBlock = hi + WINDOW_MARGIN_BLOCKS;
  if (toBlock - fromBlock + 1n > MAX_WINDOW_BLOCKS) refuse("the readings around the flow are too far apart to read as one window");
  return { fromBlock: Number(fromBlock), toBlock: Number(toBlock), baselineBlock: journal.baseline.blockNumber, bookingBlock: journal.booking.blockNumber };
}

/** What both books already hold, without the selected rows: a resumed repair reads the chain as the first one did. */
function bookedOf(local: Read, common: Read): { identities: Set<string>; txs: Set<string> } {
  const identities = new Set<string>(), txs = new Set<string>();
  for (const [flows, selected] of [[local.flows, local.book.flow], [common.flows, common.book.flow]] as const) {
    for (const r of flows) {
      if (safeInteger(r.id) === safeInteger(selected.id) || typeof r.tx_hash !== "string" || !r.tx_hash) continue;
      txs.add(r.tx_hash.toLowerCase());
      if (r.log_index !== null && r.log_index !== undefined) identities.add(flowKey(r.tx_hash, safeInteger(r.log_index)));
    }
  }
  return { identities, txs };
}

async function chainEvidence(o: TradedReceiptAttestationOptions, local: Read, common: Read): Promise<{ receipt: Receipt; window: Window; evidence: Plan["evidence"] }> {
  const journal = local.book.journal;
  if (!journal) refuse("original journal is unread");
  // Amount and time are what the amendment never changes, so a resumed repair reads them from the amended row alike.
  const account = o.smartAccount.toLowerCase(), window = windowOf(journal), booked = bookedOf(local, common);
  const expectedAmount = micro(local.book.flow), bookedAt = safeInteger(local.book.flow.at);
  // Deliberately project only public custody fields, as the untouched protocol does.
  const publicGrant = await o.shared.prepare(`SELECT grant_json->>'grantFeatures' AS "grantFeatures",
    grant_json->>'ponsClassVaultAddress' AS "ponsClassVaultAddress", grant_json->>'trencherVaultAddress' AS "trencherVaultAddress",
    grant_json->>'trencherFactoryAddress' AS "trencherFactoryAddress" FROM grants WHERE tenant=?`).get(o.tenant.toLowerCase()) as Row | undefined;
  if (!publicGrant) refuse("grant custody is unavailable");
  const custody = attestationCustody(publicGrant);
  const evidence: Plan["evidence"] = [];
  let bytes = 0, refusal: unknown = null;
  /** A refusal inside the scanner's seam survives the scanner's own catch, which would report it as an unread window. */
  const kept = (error: unknown): never => { refusal ??= error; throw error; };
  const inSeam = (reason: string): never => { try { return refuse(reason); } catch (error) { return kept(error); } };
  const rpc: RpcCall = async (method, params) => {
    try { authority(o); } catch (error) { kept(error); }
    const result = await o.rpc(method, params);
    const item = { method, params: [...params], result };
    bytes += Buffer.byteLength(canonicalJson(item));
    if (bytes > 4_000_000 || evidence.length >= 2048) inSeam("chain proof exceeds the bounded repair");
    evidence.push(item); return result;
  };
  const header = async (n: bigint) => {
    const b = await rpc("eth_getBlockByNumber", [hex(n), false]) as { number?: unknown; hash?: unknown; timestamp?: unknown } | null;
    if (!b || quantity(b.number) !== n || typeof b.hash !== "string" || !HASH.test(b.hash)) refuse("block evidence is malformed");
    return { hash: b.hash.toLowerCase(), timestamp: Number(quantity(b.timestamp)) };
  };
  if (quantity(await rpc("eth_chainId", [])) !== BigInt(o.chainId)) refuse("unsupported scope");
  const head = quantity(await rpc("eth_blockNumber", []));
  if (BigInt(window.toBlock) + BOOKING_CONFIRMATIONS > head) refuse("the window is not yet confirmed");
  const end = await header(BigInt(window.toBlock));
  const chain: ReconcileChain = {
    getBlockNumber: async () => quantity(await rpc("eth_blockNumber", [])),
    async getLogs(a) {
      const logs = await rpc("eth_getLogs", [{ address: a.address, fromBlock: hex(a.fromBlock), toBlock: hex(a.toBlock), topics: a.topics }]);
      if (!Array.isArray(logs)) return inSeam("the window's transfer logs are malformed");
      for (const raw of logs) {
        const l = raw as Partial<RawLog> & { address?: unknown; removed?: unknown };
        const block = typeof l.blockNumber === "string" && HEX.test(l.blockNumber) ? BigInt(l.blockNumber) : -1n;
        if (typeof l.address !== "string" || l.address.toLowerCase() !== USDG || !Array.isArray(l.topics) || l.topics.length !== 3
            || l.topics.some(t => typeof t !== "string" || !HASH.test(t)) || String(l.topics[0]).toLowerCase() !== TRANSFER_TOPIC
            || typeof l.data !== "string" || !/^0x[0-9a-f]{64}$/i.test(l.data) || typeof l.transactionHash !== "string" || !HASH.test(l.transactionHash)
            || typeof l.logIndex !== "string" || !HEX.test(l.logIndex) || l.removed === true || block < a.fromBlock || block > a.toBlock) {
          return inSeam("the window's transfer logs are malformed");
        }
      }
      return logs as RawLog[];
    },
    async getReceiptLogs(txHash) {
      const r = await rpc("eth_getTransactionReceipt", [txHash]) as { status?: unknown; transactionHash?: unknown; logs?: unknown } | null;
      if (!r || r.status !== "0x1" || typeof r.transactionHash !== "string" || r.transactionHash.toLowerCase() !== txHash.toLowerCase() || !Array.isArray(r.logs)) {
        return inSeam("a window transaction has no successful receipt");
      }
      return r.logs as ReceiptLog[];
    },
  };
  let flows: TransferFlow[];
  try {
    flows = await findTransferFlows({ chain, smartAccount: account as Hex, usdgToken: USDG as Hex,
      fromBlock: BigInt(window.fromBlock), toBlock: BigInt(window.toBlock), knownKeys: booked.identities,
      tradeTxHashes: new Set(local.trades.keys()), tradeOpsInTx: async tx => local.trades.get(tx.toLowerCase()) ?? new Set<string>(),
      custodyAddresses: custody, chainId: o.chainId });
  } catch (error) {
    if (refusal) throw refusal;
    return refuse(`the window's transfers could not be read or classified (${redactUrls(error instanceof Error ? error.message : String(error))})`);
  }
  // RULE 4's own match (flow-inference.ts matchInferredDelta), as the live
  // booker applies it: of the capital transfers no flow row names, exactly one,
  // signed by direction and equal to the inferred change to the micro-USDG.
  const found = matchInferredDelta(flows.filter(f => !booked.txs.has(f.txHash.toLowerCase())), expectedAmount);
  if ("none" in found) refuse(`${found.none} (blocks ${window.fromBlock}..${window.toBlock})`);
  const only = found.match;
  if (local.barred.has(only.txHash.toLowerCase()) || common.barred.has(only.txHash.toLowerCase())) refuse("an earlier repair or owner record names the receipt's transaction");
  const r = evidence.find(x => x.method === "eth_getTransactionReceipt" && String(x.params[0]).toLowerCase() === only.txHash.toLowerCase())?.result as
    { blockNumber?: unknown; blockHash?: unknown; logs?: Array<{ address?: unknown; topics?: unknown; data?: unknown; logIndex?: unknown }> } | undefined;
  const log = r?.logs?.find(x => typeof x.logIndex === "string" && HEX.test(x.logIndex) && Number(BigInt(x.logIndex)) === only.logIndex);
  const topics = Array.isArray(log?.topics) ? log.topics as string[] : [];
  if (!r || typeof r.blockHash !== "string" || !HASH.test(r.blockHash) || quantity(r.blockNumber) !== BigInt(only.blockNumber)
      || !log || String(log.address).toLowerCase() !== USDG || topics.length !== 3 || topics[0]!.toLowerCase() !== TRANSFER_TOPIC
      || `0x${topics[2]!.slice(-40)}`.toLowerCase() !== account || typeof log.data !== "string" || BigInt(log.data) !== only.amountUsdg6) refuse("receipt evidence disappeared");
  const block = await header(BigInt(only.blockNumber));
  if (block.hash !== r.blockHash.toLowerCase()) refuse("the receipt's block changed");
  if (BigInt(only.blockNumber) + SCAN_LOOKBACK_BLOCKS > head) refuse("the receipt is too recent: amended, it could become the deposit scan's resume mark");
  if (block.timestamp < journal.baseline.at - SKEW_SEC || block.timestamp > bookedAt + SKEW_SEC) refuse("the receipt's block time is outside the readings it would evidence");
  // The same headers again: a reorganization while the window was read refuses.
  if (!same(await header(BigInt(only.blockNumber)), block) || !same(await header(BigInt(window.toBlock)), end)) refuse("the chain reorganized while the window was read");
  return { receipt: { txHash: only.txHash.toLowerCase(), blockNumber: only.blockNumber, blockHash: block.hash, logIndex: only.logIndex, at: block.timestamp,
    amountUsdg6: String(only.amountUsdg6), from: `0x${topics[1]!.slice(-40)}`.toLowerCase(), to: account, token: USDG }, window, evidence };
}

/** Read-only: the anchor the next spawn derives from the shared book (bootstrap-source.ts), with the amendment counted when it is not yet made. */
async function anchorAfter(shared: Db, plan: Plan, sharedAmended: boolean): Promise<TradedReceiptAttestationReport["anchor"]> {
  const a = await deriveBootstrapAccounting(shared, plan.account);
  if (a.kind !== "established" || a.anchoredContributionsUsdg === undefined || a.unanchoredFlowCount === undefined) return null;
  const add = sharedAmended ? 0n : BigInt(plan.receipt.amountUsdg6);
  return { contributions: a.netContributionsUsdg, evidenced: String(BigInt(a.anchoredContributionsUsdg) + add),
    unevidencedRows: a.unanchoredFlowCount - (sharedAmended ? 0 : 1) };
}

/** Default is entirely read-only, including schema/files. Commit requires the reviewed stable digest. */
export async function attestTradedReceipt(o: TradedReceiptAttestationOptions): Promise<TradedReceiptAttestationReport> {
  authority(o);
  if (!Number.isSafeInteger(o.sharedFlowId) || o.sharedFlowId <= 0) refuse("the selected shared flow id is not a positive integer");
  const tenant = o.tenant.toLowerCase(), account = o.smartAccount.toLowerCase();
  const old = await readReceiptAttestation(o.shared, tenant);
  let plan: Plan;
  if (old) {
    try { plan = JSON.parse(String(old.plan_json)) as Plan; } catch { return refuse("permanent audit was modified"); }
    if (hash(plan) !== old.plan_hash || approvalDigest(plan) !== old.approval_digest) refuse("permanent audit was modified");
    if (plan.version !== 2) refuse("this tenant's recorded attestation is not for one flow of a traded book");
    if (plan.tenant !== tenant || plan.account !== account || plan.chainId !== o.chainId) refuse("permanent audit was modified");
    if (safeInteger(plan.shared.flow.id) !== o.sharedFlowId) refuse("this tenant's recorded attestation names another flow; one attestation per tenant is recorded");
    assertMarker(o, plan, false);
    const state = await verify(o, plan);
    const fresh = await chainEvidence(o, state.local, state.common);
    if (!same(fresh.receipt, plan.receipt) || !same(fresh.window, plan.window)) refuse("chain receipt changed since approval");
  } else {
    if (present(path.join(o.home, MARKER))) refuse("another source barrier exists");
    const identity = await sharedIdentity(o.shared, o);
    const common = await readBook(o.shared, { account, chainId: o.chainId }, false, flows => flows.filter(r => safeInteger(r.id) === o.sharedFlowId));
    const epoch = safeInteger(common.book.agent.epoch), mark = identity.marks.find(r => r.table_name === "flows");
    const check = (read: Read) => {
      const flow = read.book.flow;
      if (flow.source !== "inferred" || flow.direction !== "in" || flow.tx_hash !== null || flow.block_number !== null || flow.log_index !== null
          || (flow.chain_id !== null && safeInteger(flow.chain_id) !== o.chainId) || safeInteger(flow.epoch) !== epoch
          || safeInteger(read.book.agent.epoch) !== epoch) refuse("the selected flow is not an unattested inferred deposit of the current epoch");
      micro(flow);
      if (read.flows.filter(r => same(fact(r), fact(flow))).length !== 1) refuse("the selected flow's fact is booked more than once");
      if (String(read.book.agent.owner_address).toLowerCase() !== identity.grant.owner) refuse("original owner differs from the stored permission");
    };
    // The selection first: the original book is searched only for an inferred deposit's copy.
    check(common);
    const local = await readLocal(o, flows => flows.filter(r => same(fact(r), fact(common.book.flow))));
    check(local);
    if (!mark || safeInteger(local.book.flow.id) > safeInteger(mark.last_id)) refuse("the original flow has no shared copy behind the mirror's witness");
    if (identity.source.source_inode !== local.file.inode || identity.source.source_identity !== local.file.identity.book_id) refuse("consumed source receipt differs from local file");
    const { receipt, window, evidence } = await chainEvidence(o, local, common);
    plan = { version: 2, tenant, account, chainId: o.chainId, ...identity, file: local.file, local: local.book, shared: common.book, window, receipt, evidence };
    await verify(o, plan);
  }
  const digest = approvalDigest(plan), marker = path.join(o.home, MARKER), epoch = safeInteger(plan.local.agent.epoch);
  const report = async (state: TradedReceiptAttestationReport["state"], sharedAmended: boolean): Promise<TradedReceiptAttestationReport> => ({
    state, protocol: "traded-book", approvalDigest: digest, tenant: plan.tenant, account: plan.account,
    amountUsdg: Number(plan.receipt.amountUsdg6) / 1_000_000, localFlowId: safeInteger(plan.local.flow.id), sharedFlowId: safeInteger(plan.shared.flow.id),
    receipt: plan.receipt, window: plan.window, anchor: await anchorAfter(o.shared, plan, sharedAmended) });
  if (o.mode !== "commit") {
    return report(old?.state === "pending" ? "pending" : old?.state === "applied" ? "applied" : "preview", old?.state === "applied");
  }
  if (o.approvedDigest !== digest) refuse("approval does not match this exact evidence");
  await ensureReceiptAttestationSchema(o.shared);
  if (!old) {
    await o.shared.tx(async db => {
      await sharedIdentity(db, o, true);
      await verify(o, plan, db);
      await db.prepare("INSERT INTO ledger_receipt_attestations(tenant,approval_digest,plan_hash,plan_json,state,created_at_ms) VALUES(?,?,?,?,'pending',?)")
        .run(plan.tenant, digest, hash(plan), canonicalJson(plan), Date.now());
      authority(o);
    });
    await o.checkpoint?.("audit");
  }
  authority(o); assertMarker(o, plan, false);
  if (!present(marker)) writeFileAtomicSync(marker, markerValue(plan), 0o600, { durable: true });
  await o.checkpoint?.("marker");
  await o.shared.tx(async db => {
    // Keep the grant/generation locks through BOTH amendments, as the untouched protocol does.
    await sharedIdentity(db, o, true);
    const audit = await db.prepare(`SELECT * FROM ledger_receipt_attestations WHERE tenant=?${(o.dialect ?? "postgres") === "postgres" ? " FOR UPDATE" : ""}`).get(plan.tenant) as Row | undefined;
    if (!audit || audit.plan_hash !== hash(plan) || audit.plan_json !== canonicalJson(plan)) refuse("durable audit changed");
    const state = await verify(o, plan, db);
    if (!state.localAmended) {
      authority(o); assertMarker(o, plan, true);
      const file = fileIdentity(o), raw = new DatabaseSync(file.file);
      try {
        if (fileIdentity(o).inode !== plan.file.inode) refuse("source file changed before amendment");
        raw.exec("PRAGMA synchronous = FULL; BEGIN IMMEDIATE");
        try {
          const before = await readBook(wrapSqlite(raw), { account: plan.account, chainId: plan.chainId }, true, byId(plan.local.flow));
          if (!same(before.book, plan.local)) refuse("local evidence changed before amendment");
          const change = raw.prepare("UPDATE flows SET source='chain-log',tx_hash=?,block_number=?,log_index=?,chain_id=? WHERE id=?")
            .run(plan.receipt.txHash, plan.receipt.blockNumber, plan.receipt.logIndex, plan.chainId, safeInteger(plan.local.flow.id));
          if (Number(change.changes) !== 1) refuse("local flow was not amended exactly once");
          // The flow's own epoch chain, in the spelling the worker appends with (store.ts appendJournalRow).
          const payload = canonicalJson(amendment(plan)), head = plan.local.journal!.head.hash;
          raw.prepare("INSERT INTO journal(agent_id,epoch,kind,payload_json,prev_hash,hash) VALUES(?,?,'mark',?,?,?)")
            .run(String(plan.local.flow.agent_id), epoch, payload, head, journalHash(head, payload));
          authority(o); assertMarker(o, plan, true); raw.exec("COMMIT");
        } catch (error) { raw.exec("ROLLBACK"); throw error; }
      } finally { raw.close(); }
      const fd = openSync(file.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } finally { closeSync(fd); }
      fsyncDirSync(o.home);
      await o.checkpoint?.("local");
    }
    const current = await verify(o, plan, db);
    if (!current.localAmended) refuse("original source is not amended");
    if (!current.sharedAmended) {
      const change = await db.prepare("UPDATE flows SET source='chain-log',tx_hash=?,block_number=?,log_index=?,chain_id=? WHERE id=? AND LOWER(agent_id)=?")
        .run(plan.receipt.txHash, plan.receipt.blockNumber, plan.receipt.logIndex, plan.chainId, safeInteger(plan.shared.flow.id), plan.account);
      if (change.changes !== 1) refuse("shared flow was not amended exactly once");
    }
    if (audit.state !== "applied") await db.prepare("UPDATE ledger_receipt_attestations SET state='applied',applied_at_ms=? WHERE tenant=? AND state='pending'").run(Date.now(), plan.tenant);
    authority(o); assertMarker(o, plan, true);
  });
  await o.checkpoint?.("shared");
  const final = await verify(o, plan);
  if (!final.localAmended || !final.sharedAmended) refuse("final source agreement failed");
  authority(o); assertMarker(o, plan, true);
  rmSync(marker); fsyncDirSync(o.home);
  await o.checkpoint?.("cleared");
  return report("applied", true);
}

/**
 * THE ONE OPERATOR ENTRY for both protocols. A selected flow runs this one; no
 * selection runs the untouched-book protocol. A recorded audit of the other
 * protocol refuses by name rather than reading as a modified audit.
 */
export async function attestReceipt(o: ReceiptAttestationOptions & { sharedFlowId?: number }): Promise<ReceiptAttestationReport | TradedReceiptAttestationReport> {
  authority(o);
  const old = await readReceiptAttestation(o.shared, o.tenant);
  let version: unknown;
  try { version = old ? (JSON.parse(String(old.plan_json)) as { version?: unknown }).version : undefined; } catch { refuse("permanent audit was modified"); }
  if (o.sharedFlowId === undefined) {
    if (version === 2) refuse("this tenant's recorded attestation is for one flow of a traded book; set MERRYMEN_RECEIPT_ATTEST_FLOW to that flow's shared id");
    return attestOriginalReceipt(o);
  }
  if (old && version !== 2) refuse("this tenant's recorded attestation is the untouched-book protocol; remove MERRYMEN_RECEIPT_ATTEST_FLOW");
  return attestTradedReceipt({ ...o, sharedFlowId: o.sharedFlowId });
}
