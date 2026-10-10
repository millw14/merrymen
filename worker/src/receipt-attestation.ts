/** Amend the evidence of one original inferred deposit. Never create, replace or rebase a book. */
import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CASH } from "../../packages/core/src/index";
import { accountingTenantHeld } from "./accounting-maintenance";
import { fsyncDirSync, writeFileAtomicSync } from "./atomic-write";
import type { RpcCall } from "./chain-capital";
import { wrapSqlite, type Db } from "./db";
import { readUntouchedFundingReceipts } from "./initial-capital";
import type { LedgerImportVolume } from "./ledger-import";
import { assertLedgerSourceContinuity } from "./ledger-safeguard";
import { canonicalJson, JOURNAL_GENESIS, journalHash } from "./store";
import type { TenantLease } from "./tenant-lease";
import { ensureReceiptAttestationSchema, readReceiptAttestation } from "./receipt-attestation-state";

const MARKER = "ledger-source-blocked.json";
const OTHER_MARKERS = ["ledger-import.pending.json", "restore-blocked.json", "energy-unrestored.json"];
const MAX_ROWS = 100_000;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
function refuse(reason: string): never { throw new Error(`Original receipt attestation refused: ${reason}. Preserve the original home and maintenance hold.`); }
type Row = Record<string, unknown>;
const sorted = (rows: readonly unknown[]) => rows.map(canonicalJson).sort();
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function safeInteger(value: unknown): number {
  const n = Number(value);
  if ((typeof value !== "number" && typeof value !== "string") || !Number.isSafeInteger(n) || n < 0) return refuse("invalid integer evidence");
  return n;
}
function present(file: string): boolean {
  try { lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Every financial table is retained and bound. Events/posts can grow independently of finance. */
const PROTECTED = ["agents", "trades", "equity", "fee_accruals", "positions", "cost_basis", "position_floors",
  "class_positions", "trench_positions", "risk_periods", "energy_days", "paper_book", "owner_operations", "agent_commands", "flows_quarantine"] as const;
const MUST_BE_EMPTY = ["fee_accruals", "positions", "cost_basis", "position_floors", "class_positions", "trench_positions",
  "risk_periods", "owner_operations", "flows_quarantine"] as const;

interface Snapshot {
  flow: Row;
  agent: Row;
  protectedDigest: string;
  journal: { digest: string; count: number; head: string; lastSeq: number };
}
interface Receipt {
  txHash: string; blockNumber: number; blockHash: string; logIndex: number; at: number;
  amountUsdg6: string; from: string; to: string; token: string;
}
interface Plan {
  version: 1; tenant: string; account: string; chainId: number;
  // Device numbers are verified against the CURRENT mount, never persisted:
  // the same volume may reattach under a different st.dev on another host.
  file: { inode: string; identity: Row; volumeId: string };
  source: Row; grant: Row; marks: Row[];
  local: Snapshot; shared: Snapshot; receipt: Receipt;
  /** Exact RPC responses used for the original verification; no credentials or keys. */
  evidence: Array<{ method: string; params: unknown[]; result: unknown }>;
}
export interface ReceiptAttestationOptions {
  tenant: string; smartAccount: string; chainId: number; home: string; volume: LedgerImportVolume;
  shared: Db; lease: TenantLease; rpc: RpcCall;
  /** Must be implemented inside the supervisor from its process/restart/retirement maps. */
  assertQuiescent: () => void;
  mode?: "dry-run" | "commit";
  approvedDigest?: string;
  dialect?: "postgres" | "sqlite";
  /** Fault injection only; exceptions leave the durable protocol resumable. */
  checkpoint?: (boundary: "audit" | "marker" | "local" | "shared" | "cleared") => void | Promise<void>;
}
export interface ReceiptAttestationReport {
  state: "preview" | "pending" | "applied";
  approvalDigest: string;
  tenant: string; account: string; amountUsdg: number;
  localFlowId: number; sharedFlowId: number; receipt: Receipt;
}

function authority(o: ReceiptAttestationOptions): void {
  const tenant = o.tenant.toLowerCase();
  if (!ADDRESS.test(tenant) || !ADDRESS.test(o.smartAccount.toLowerCase()) || o.chainId !== 4663) refuse("unsupported scope");
  if (o.lease.tenant.toLowerCase() !== tenant || o.lease.backend !== "postgres" || !o.lease.healthy()) refuse("tenant lease is not held");
  if (!accountingTenantHeld(tenant)) refuse("tenant is not explicitly held by the operator");
  o.assertQuiescent();
}
function fileIdentity(o: ReceiptAttestationOptions): { file: string; inode: string; device: string } {
  const tenant = o.tenant.toLowerCase(), volume = o.volume;
  if (path.resolve(o.home) !== path.join(path.resolve(volume.homeRoot), "children", tenant)
      || !path.isAbsolute(volume.mountPath) || !path.isAbsolute(volume.homeRoot)
      || path.relative(volume.mountPath, volume.homeRoot).startsWith("..")) refuse("home is outside the verified volume");
  for (let dir = path.resolve(o.home); ; dir = path.dirname(dir)) {
    if (!lstatSync(dir).isDirectory()) refuse("home contains a non-directory or symlink");
    if (dir === path.dirname(dir)) break;
  }
  const mount = lstatSync(volume.mountPath, { bigint: true });
  if (String(mount.dev) !== volume.device || String(mount.ino) !== volume.inode) refuse("volume identity changed");
  const file = path.join(o.home, "merrymen.db"), st = lstatSync(file, { bigint: true });
  if (!st.isFile() || String(st.dev) !== volume.device || (st.mode & 0o077n) !== 0n
      || (process.getuid && st.uid !== BigInt(process.getuid()))) refuse("source is not the original private file");
  for (const marker of OTHER_MARKERS) if (present(path.join(o.home, marker))) refuse("another recovery barrier exists");
  return { file, inode: String(st.ino), device: String(st.dev) };
}
async function rows(db: Db, table: string, account: string): Promise<Row[]> {
  const key = table === "agents" ? "smart_account" : "agent_id";
  const result = await db.prepare(`SELECT * FROM ${table} WHERE LOWER(${key}) = ? LIMIT ${MAX_ROWS + 1}`).all(account) as Row[];
  if (result.length > MAX_ROWS) refuse("accounting evidence exceeds the bounded repair");
  return result;
}
function journalState(entries: Row[], contiguous = false): Snapshot["journal"] {
  let head = JOURNAL_GENESIS, lastSeq = 0;
  for (const row of entries.sort((a, b) => safeInteger(a.seq) - safeInteger(b.seq))) {
    const seq = safeInteger(row.seq);
    if (safeInteger(row.epoch) !== 1 || seq <= lastSeq || (contiguous && seq !== lastSeq + 1) || row.prev_hash !== head || typeof row.payload_json !== "string"
        || canonicalJson(JSON.parse(row.payload_json)) !== row.payload_json || journalHash(head, row.payload_json) !== row.hash) refuse("journal hash chain is invalid");
    head = String(row.hash); lastSeq = seq;
  }
  return { digest: hash(sorted(entries)), count: entries.length, head, lastSeq };
}
async function snapshot(db: Db, account: string, chainId: number, local: boolean, correction?: Row): Promise<Snapshot> {
  const values: Record<string, Row[]> = {};
  for (const table of PROTECTED) {
    values[table] = await rows(db, table, account);
    if (local) {
      const key = table === "agents" ? "smart_account" : "agent_id";
      if (await db.prepare(`SELECT 1 FROM ${table} WHERE LOWER(${key}) <> ? OR ${key} IS NULL LIMIT 1`).get(account)) refuse("local book contains a different account");
    }
  }
  const agents = values.agents!;
  if (agents.length !== 1 || safeInteger(agents[0]!.epoch) !== 1 || agents[0]!.mode !== "live"
      || safeInteger(agents[0]!.chain_id) !== chainId || agents[0]!.hwm_withdrawn_usdg === null || Number(agents[0]!.hwm_withdrawn_usdg) !== 0
      || agents[0]!.accrued_fee_usdg === null || Number(agents[0]!.accrued_fee_usdg) !== 0) refuse("account is not an untouched epoch-one live book");
  for (const table of MUST_BE_EMPTY) if (values[table]!.length) refuse(`${table} is not empty`);
  if (values.trades!.some(r => r.status !== "rejected" || r.tx_hash !== null || r.user_op_hash !== null
      || r.fill_qty_raw !== null || r.fill_cash_usdg !== null || r.realized_pnl_usdg !== null)) refuse("trade or settlement evidence exists");
  if (values.agent_commands!.some(r => r.done_at === null)) refuse("an owner command is unfinished");
  const flows = await rows(db, "flows", account);
  if (local && await db.prepare("SELECT 1 FROM flows WHERE LOWER(agent_id) <> ? OR agent_id IS NULL LIMIT 1").get(account)) refuse("local flow book contains another account");
  if (flows.length !== 1) refuse("book does not contain exactly one flow");
  const flow = flows[0]!;
  if (flow.direction !== "in" || safeInteger(flow.epoch) !== 1 || !(Number(flow.amount_usdg) > 0)
      || Number(agents[0]!.hwm_usdg) !== Number(flow.amount_usdg)) refuse("flow and high-water mark disagree");
  if (values.equity!.length === 0 || values.equity!.some(r => safeInteger(r.epoch) !== 1 || r.mode !== "live"
      || Number(r.vault_usdg) !== 0 || Number(r.positions_usdg) !== 0 || Number(r.equity_usdg) !== Number(r.cash_usdg)
      || ![0, Number(flow.amount_usdg)].includes(Number(r.cash_usdg)))) refuse("valuation history is not cash-only");
  const latest = [...values.equity!].sort((a, b) => safeInteger(b.at) - safeInteger(a.at) || safeInteger(b.id) - safeInteger(a.id))[0]!;
  if (Number(latest.cash_usdg) !== Number(flow.amount_usdg)) refuse("latest cash valuation disagrees with the deposit");
  let journal = await rows(db, "journal", account);
  journalState(journal, local);
  if (correction) {
    const matching = journal.filter(r => r.payload_json === canonicalJson(correction));
    if (matching.length !== 1 || matching[0]!.kind !== "mark" || safeInteger(matching[0]!.seq) !== Math.max(...journal.map(r => safeInteger(r.seq)))) refuse("correction journal is missing, duplicated or followed by another writer");
    journal = journal.filter(r => r !== matching[0]);
  }
  if (local) {
    if (await db.prepare("SELECT 1 FROM journal WHERE LOWER(agent_id) <> ? OR agent_id IS NULL LIMIT 1").get(account)) refuse("journal contains another account");
    const benignRejection = (row: Row): boolean => {
      if (row.kind !== "fill") return false;
      const p = JSON.parse(String(row.payload_json)) as Row;
      return p.status === "rejected" && p.txHash == null && p.userOpHash == null && p.fillQtyRaw == null && p.fillCashUsdg == null
        && [p.realizedPnlUsdg, p.gasUsdg, p.gasWei, p.sponsoredGasWei, p.tradeFeeUsdg].every(value => value == null || value === 0 || value === "0");
    };
    const financial = journal.filter(r => r.kind === "flow" || r.kind === "fee" || (r.kind === "fill" && !benignRejection(r)));
    const original = financial.length === 1 && financial[0]!.kind === "flow" ? JSON.parse(String(financial[0]!.payload_json)) as Row : null;
    if (!original || original.source !== "inferred" || original.direction !== "in" || Number(original.amountUsdg) !== Number(flow.amount_usdg)
        || original.txHash != null || original.blockNumber != null || original.logIndex != null
        || (original.agentId != null && String(original.agentId).toLowerCase() !== account)
        || (original.epoch != null && safeInteger(original.epoch) !== 1)
        || (original.chainId != null && safeInteger(original.chainId) !== chainId)) refuse("original flow journal does not prove the sole inferred deposit");
  }
  return { flow, agent: agents[0]!, protectedDigest: hash(Object.fromEntries(Object.entries(values).map(([name, rs]) => [name, sorted(rs)]))), journal: journalState(journal, local) };
}
async function sharedIdentity(db: Db, o: ReceiptAttestationOptions, lock = false): Promise<{ source: Row; grant: Row; marks: Row[] }> {
  const tenant = o.tenant.toLowerCase(), account = o.smartAccount.toLowerCase();
  const pg = (o.dialect ?? "postgres") === "postgres";
  // Same grant -> generation lock order as the source handover and grant deletion.
  const grant = await db.prepare(`SELECT tenant, lower(grant_json->>'smartAccount') AS account,
    lower(grant_json->>'owner') AS owner, grant_json->>'chainId' AS chain,
    ${pg ? "updated_at::text AS updated, xmin::text AS incarnation" : "CAST(updated_at AS TEXT) AS updated, CAST(row_version AS TEXT) AS incarnation"}
    FROM grants WHERE tenant = ?${lock && pg ? " FOR SHARE" : ""}`).get(tenant) as Row | undefined;
  if (!grant || grant.account !== account || Number(grant.chain) !== o.chainId) refuse("grant binding changed");
  const source = await db.prepare(`SELECT * FROM tenant_ledger_import WHERE tenant = ?${lock && pg ? " FOR UPDATE" : ""}`).get(tenant) as Row | undefined;
  if (!source || source.state !== "consumed" || source.target_volume_id !== o.volume.id || source.sealed !== null) refuse("source generation is not consumed on this volume");
  const generation = await db.prepare("SELECT tenant,state FROM tenant_ledger_import_generations WHERE generation = ?").get(source.generation) as Row | undefined;
  if (generation?.tenant !== tenant || generation.state !== "consumed") refuse("source generation receipt is absent");
  const marks = await db.prepare("SELECT * FROM mirror_state WHERE tenant = ? ORDER BY table_name").all(tenant) as Row[];
  if (!marks.some(r => r.table_name === "flows" && safeInteger(r.last_id) > 0)) refuse("flow has no original mirror witness");
  return { source, grant, marks };
}
async function chainEvidence(o: ReceiptAttestationOptions): Promise<{ receipt: Receipt; evidence: Plan["evidence"] }> {
  const evidence: Plan["evidence"] = [];
  let bytes = 0;
  const rpc: RpcCall = async (method, params) => {
    authority(o);
    const result = await o.rpc(method, params);
    const item = { method, params: [...params], result };
    bytes += Buffer.byteLength(canonicalJson(item));
    if (bytes > 2_000_000 || evidence.length >= 1024) refuse("chain proof exceeds the bounded repair");
    evidence.push(item); return result;
  };
  const capital = await readUntouchedFundingReceipts(rpc, { account: o.smartAccount.toLowerCase(), chainId: o.chainId });
  if (capital.deposits.length !== 1) refuse("chain history is not one sole deposit");
  const deposit = capital.deposits[0]!;
  const receipt = evidence.find(x => x.method === "eth_getTransactionReceipt" && String(x.params[0]).toLowerCase() === deposit.txHash.toLowerCase())?.result as { blockHash?: unknown; logs?: Array<{ logIndex: string; topics: string[]; address: string }> } | undefined;
  const log = receipt?.logs?.find(x => Number(BigInt(x.logIndex)) === deposit.logIndex);
  if (!receipt || typeof receipt.blockHash !== "string" || !log || log.address.toLowerCase() !== CASH.USDG.toLowerCase()) refuse("receipt evidence disappeared");
  return { receipt: { txHash: deposit.txHash.toLowerCase(), blockNumber: deposit.blockNumber, blockHash: receipt.blockHash.toLowerCase(),
    logIndex: deposit.logIndex, at: deposit.at, amountUsdg6: String(deposit.amountUsdg6),
    from: `0x${log.topics[1]!.slice(-40)}`.toLowerCase(), to: `0x${log.topics[2]!.slice(-40)}`.toLowerCase(), token: log.address.toLowerCase() }, evidence };
}
function corrected(flow: Row, receipt: Receipt, chainId: number): Row {
  return { ...flow, source: "chain-log", tx_hash: receipt.txHash, block_number: receipt.blockNumber, log_index: receipt.logIndex, chain_id: chainId };
}
function approvalDigest(plan: Plan): string { const { evidence: _evidence, ...stable } = plan; return hash(stable); }
function amendment(plan: Plan): Row {
  return { receiptAttestation: { version: 1, approvalDigest: approvalDigest(plan), sourceGeneration: plan.source.generation,
    originalFlow: plan.local.flow, correctedFlow: corrected(plan.local.flow, plan.receipt, plan.chainId), receipt: plan.receipt,
    originalJournal: plan.local.journal, planHash: hash(plan) } };
}
function markerValue(plan: Plan): string {
  return canonicalJson({ version: 1, state: "pending-receipt-attestation", tenant: plan.tenant,
    approvalDigest: approvalDigest(plan), planHash: hash(plan), sourceGeneration: plan.source.generation });
}
function assertMarker(o: ReceiptAttestationOptions, plan: Plan, required: boolean): void {
  const file = path.join(o.home, MARKER);
  if (!present(file)) { if (required) refuse("repair barrier disappeared"); return; }
  if (!lstatSync(file).isFile() || lstatSync(file).size > 4096 || readFileSync(file, "utf8") !== markerValue(plan)) refuse("another or modified source barrier exists");
}
async function readLocal(o: ReceiptAttestationOptions, plan?: Plan, shared = o.shared): Promise<{ snap: Snapshot; file: Plan["file"]; amended: boolean }> {
  const actual = fileIdentity(o), raw = new DatabaseSync(actual.file, { readOnly: true });
  try {
    const db = wrapSqlite(raw), identities = raw.prepare("SELECT * FROM ledger_source_identity").all() as Row[];
    if (identities.length !== 1 || identities[0]!.tenant !== o.tenant.toLowerCase()
        || String(identities[0]!.smart_account).toLowerCase() !== o.smartAccount.toLowerCase() || safeInteger(identities[0]!.chain_id) !== o.chainId) refuse("local book identity differs");
    const flows = await rows(db, "flows", o.smartAccount.toLowerCase());
    const amended = !!plan && flows.length === 1 && same(flows[0], corrected(plan.local.flow, plan.receipt, plan.chainId));
    const snap = await snapshot(db, o.smartAccount.toLowerCase(), o.chainId, true, amended ? amendment(plan!) : undefined);
    await assertLedgerSourceContinuity(db, shared, o.tenant.toLowerCase());
    return { snap, file: { inode: actual.inode, identity: identities[0]!, volumeId: o.volume.id }, amended };
  } finally { raw.close(); }
}
async function verify(o: ReceiptAttestationOptions, plan: Plan, shared = o.shared): Promise<{ localAmended: boolean; sharedAmended: boolean }> {
  authority(o);
  const identity = await sharedIdentity(shared, o), local = await readLocal(o, plan, shared);
  const common = await snapshot(shared, plan.account, plan.chainId, false);
  if (!same(identity, { source: plan.source, grant: plan.grant, marks: plan.marks }) || !same(local.file, plan.file)) refuse("source, grant or cursor evidence changed");
  const sharedAmended = same(common.flow, corrected(plan.shared.flow, plan.receipt, plan.chainId));
  if (!same({ ...local.snap, flow: plan.local.flow }, plan.local) || !same({ ...common, flow: plan.shared.flow }, plan.shared)
      || (!local.amended && !same(local.snap.flow, plan.local.flow)) || (!sharedAmended && !same(common.flow, plan.shared.flow))) refuse("accounting preimages changed");
  if (sharedAmended && !local.amended) refuse("shared amendment has no original-source amendment");
  authority(o); return { localAmended: local.amended, sharedAmended };
}

/** Default is entirely read-only, including schema/files. Commit requires the reviewed stable digest. */
export async function attestOriginalReceipt(o: ReceiptAttestationOptions): Promise<ReceiptAttestationReport> {
  authority(o);
  const old = await readReceiptAttestation(o.shared, o.tenant);
  let plan: Plan;
  if (old) {
    plan = JSON.parse(String(old.plan_json)) as Plan;
    if (hash(plan) !== old.plan_hash || approvalDigest(plan) !== old.approval_digest || plan.version !== 1
        || plan.tenant !== o.tenant.toLowerCase() || plan.account !== o.smartAccount.toLowerCase() || plan.chainId !== o.chainId) refuse("permanent audit was modified");
    assertMarker(o, plan, false);
    await verify(o, plan);
    const fresh = await chainEvidence(o);
    if (!same(fresh.receipt, plan.receipt)) refuse("chain receipt changed since approval");
  } else {
    if (present(path.join(o.home, MARKER))) refuse("another source barrier exists");
    const identity = await sharedIdentity(o.shared, o), local = await readLocal(o), shared = await snapshot(o.shared, o.smartAccount.toLowerCase(), o.chainId, false);
    const { receipt, evidence } = await chainEvidence(o);
    for (const flow of [local.snap.flow, shared.flow]) {
      if (flow.source !== "inferred" || flow.tx_hash !== null || flow.block_number !== null || flow.log_index !== null
          || (flow.chain_id !== null && safeInteger(flow.chain_id) !== o.chainId)
          || Number(flow.amount_usdg) * 1_000_000 !== Number(receipt.amountUsdg6)) refuse("sole inferred flow does not equal the complete receipt");
    }
    if (!same({ ...local.snap.flow, id: 0, agent_id: o.smartAccount.toLowerCase() }, { ...shared.flow, id: 0, agent_id: o.smartAccount.toLowerCase() })) refuse("original and mirrored flow differ");
    if ([local.snap.agent, shared.agent].some(agent => String(agent.owner_address).toLowerCase() !== identity.grant.owner)) refuse("original owner differs from the stored permission");
    if (identity.source.source_inode !== local.file.inode || identity.source.source_identity !== local.file.identity.book_id) refuse("consumed source receipt differs from local file");
    plan = { version: 1, tenant: o.tenant.toLowerCase(), account: o.smartAccount.toLowerCase(), chainId: o.chainId,
      ...identity, file: local.file, local: local.snap, shared, receipt, evidence };
    await verify(o, plan);
  }
  const digest = approvalDigest(plan);
  const report = (state: ReceiptAttestationReport["state"]): ReceiptAttestationReport => ({ state, approvalDigest: digest,
    tenant: plan.tenant, account: plan.account, amountUsdg: Number(plan.receipt.amountUsdg6) / 1_000_000,
    localFlowId: safeInteger(plan.local.flow.id), sharedFlowId: safeInteger(plan.shared.flow.id), receipt: plan.receipt });
  if (o.mode !== "commit") return report(old?.state === "pending" ? "pending" : old?.state === "applied" ? "applied" : "preview");
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
  if (!present(path.join(o.home, MARKER))) writeFileAtomicSync(path.join(o.home, MARKER), markerValue(plan), 0o600, { durable: true });
  await o.checkpoint?.("marker");
  await o.shared.tx(async db => {
    // Keep the grant/generation locks through BOTH amendments. An owner renewal
    // cannot change this binding between the source commit and shared commit.
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
        const db = wrapSqlite(raw), before = await snapshot(db, plan.account, plan.chainId, true);
        if (!same(before, plan.local)) refuse("local evidence changed before amendment");
        const change = raw.prepare("UPDATE flows SET source='chain-log',tx_hash=?,block_number=?,log_index=?,chain_id=? WHERE id=?")
          .run(plan.receipt.txHash, plan.receipt.blockNumber, plan.receipt.logIndex, plan.chainId, plan.local.flow.id as number);
        if (Number(change.changes) !== 1) refuse("local flow was not amended exactly once");
        const payload = canonicalJson(amendment(plan)), head = plan.local.journal.head;
        raw.prepare("INSERT INTO journal(agent_id,epoch,kind,payload_json,prev_hash,hash) VALUES(?,1,'mark',?,?,?)")
          .run(plan.local.flow.agent_id as string, payload, head, journalHash(head, payload));
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
        .run(plan.receipt.txHash, plan.receipt.blockNumber, plan.receipt.logIndex, plan.chainId, plan.shared.flow.id, plan.account);
      if (change.changes !== 1) refuse("shared flow was not amended exactly once");
    }
    if (audit.state !== "applied") await db.prepare("UPDATE ledger_receipt_attestations SET state='applied',applied_at_ms=? WHERE tenant=? AND state='pending'").run(Date.now(), plan.tenant);
    authority(o); assertMarker(o, plan, true);
  });
  await o.checkpoint?.("shared");
  const final = await verify(o, plan);
  if (!final.localAmended || !final.sharedAmended) refuse("final source agreement failed");
  authority(o); assertMarker(o, plan, true);
  rmSync(path.join(o.home, MARKER)); fsyncDirSync(o.home);
  await o.checkpoint?.("cleared");
  return report("applied");
}
