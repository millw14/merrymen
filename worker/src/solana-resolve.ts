/**
 * OPERATOR-REVIEWED RESOLUTION OF A STUCK LIVE TRADE.
 *
 * reconcileSolanaSubmission books a pending live trade only when both configured
 * providers derive the same outcome. When they keep disagreeing (one lags or
 * withholds, or one returns a receipt this code cannot read), the trade stays
 * pending: its reservation is held and the vault takes no new trade. This tool
 * is the operator's way through, and it adds no authority:
 *
 * - It shows each provider's view, as the executor derives it from finalized
 *   on-chain evidence (observeSolanaSubmission), and can consult a third
 *   provider the operator supplies (--third-rpc, whose URL is read from
 *   MERRYMEN_SOLANA_RESOLVE_THIRD_RPC, never the command line: a URL can carry
 *   an API key, and arguments show in ps listings and shell history). Every
 *   provider must be on its own hostname.
 * - It books only when two of them agree on the same final outcome (a fill, an
 *   on-chain failure, or a proven expiry) and no provider reports a different
 *   final outcome. A provider that cannot answer, or answers with a receipt
 *   that cannot be read, does not count toward that agreement.
 * - An expiry is not booked while any provider has seen the signature, nor
 *   while any provider the operator has not set aside could not be read: an
 *   unreadable answer may be the evidence that it landed (a finalized status
 *   whose receipt cannot be used is refused as unreadable, not as unseen).
 * - A trade whose vault sequence moved for another reason (an owner withdrawal
 *   made outside Merrymen takes no expected sequence) can never run again, but
 *   the move may have been its own. Here alone, each provider is asked to prove
 *   from the vault's own debit log that it never ran (observeSolanaSubmission's
 *   proveSequenceConsumed): a landed swap always leaves a debit inside its
 *   signed deadline window. That expiry ("sequence-consumed") is booked on the
 *   same terms as any other: two providers on their own hostnames agree, none
 *   has seen the signature and none could not be read. The worker's automatic
 *   reconciliation never books it, and the store refuses it from anything but
 *   a recorded operator decision. A provider that cannot prove it says why
 *   (the blockhash had not expired, or its debit log holds a swap inside the
 *   trade's window, which may be this trade's: then nothing is booked however
 *   many others prove it, and the operator looks for its fill).
 * - When one provider keeps reporting a final outcome the others contradict,
 *   or cannot be read at all, the operator can set it aside by name (--exclude
 *   primary|fallback|third). Its view is still read, shown and recorded with
 *   the decision as excluded; two OTHER providers on their own hostnames must
 *   still agree, no other provider may disagree, and an expiry is still
 *   refused while any provider, the excluded one included, has seen the
 *   signature.
 * - Before booking it records the operator, their reason, the outcome and
 *   every provider's view in solana_operator_resolutions, then books through
 *   the trading store's own settle (settleResolution), which re-checks the
 *   evidence against the reservation and marks that decision booked in the
 *   same transaction. A decision is marked booked if and only if it booked
 *   the trade; one that did not (the worker's automatic settlement booked the
 *   same evidence first, or its run stopped before settling) is recorded as
 *   superseded. Nothing is ever booked or released any other way: there is no
 *   override, and the tool never signs or sends a transaction.
 *
 * Output and the durable record carry provider labels and a short hash of each
 * hostname, never an endpoint URL (URLs can carry API keys).
 */
import { createHash, randomUUID } from "node:crypto";
import { CHAINS } from "../../packages/core/src/ids";
import type { Db } from "./db";
import { SOLANA_PENDING_STUCK_MS } from "./solana-agent";
import { observationKey, observeSolanaSubmission, solanaAgreedSettlement, SolanaExecutionError, solanaQuorumSlot, type SolanaLiveRecord, type SolanaLiveSettlement,
  type SolanaObservation } from "./solana-executor";
import { createSolanaLiveRpc, type SolanaLiveRead } from "./solana-live-rpc";
import { readSolanaMainnetRpcConfig, SolanaRpcError } from "./solana-rpc";
import { SolanaSettlementError } from "./solana-settlement";
import { ensureSolanaTradingSchema, SolanaTradingStore, SolanaTradingStoreError } from "./solana-trading-store";
import { solanaOwnerEpochOffset, solanaPendingOwnerTransactions, type SolanaOwnerExpiryProof, type SolanaPreparedSetup } from "./solana-trading-store";

export class SolanaResolveError extends Error {
  constructor(message: string) { super(message); this.name = "SolanaResolveError"; }
}
function refuse(message: string): never { throw new SolanaResolveError(message); }

/** The environment variable holding the third provider's HTTPS URL for --third-rpc. */
export const SOLANA_RESOLVE_THIRD_RPC_ENV = "MERRYMEN_SOLANA_RESOLVE_THIRD_RPC";
/** --exclude names, and the provider label each one sets aside. */
const EXCLUDABLE: Readonly<Record<string, string>> = { primary: "primary", fallback: "fallback", third: "operator's provider" };
export const SOLANA_RESOLVE_USAGE = [
  "Usage: npm run solana:resolve -- show <tenant> <request-id> [--third-rpc] [--exclude primary|fallback|third]",
  "       npm run solana:resolve -- book <tenant> <request-id> --operator NAME --reason \"why\" [--third-rpc] [--exclude primary|fallback|third]",
  "       npm run solana:resolve -- history <tenant> [<request-id>]",
  "       npm run solana:resolve -- owner show <tenant> [<signature>] [--third-rpc] [--exclude primary|fallback|third]",
  "       npm run solana:resolve -- owner book <tenant> <signature> --operator NAME --reason \"why\" [--third-rpc] [--exclude primary|fallback|third]",
  "       npm run solana:resolve -- owner history <tenant>",
  `--third-rpc also asks the provider whose HTTPS URL is in ${SOLANA_RESOLVE_THIRD_RPC_ENV} (set it in .env.solana.local or the environment, never on the command line).`,
  "--exclude sets aside one provider that reports a conflicting final outcome or cannot be read: its view is still shown and recorded, two other providers on their own",
  "hostnames must agree, and an expiry is still refused while any provider has seen the signature.",
  "npm run solana:resolve -- pending lists every live trade and signed owner transaction pending over three minutes (the pending-stuck alert's): tenant, id, age,",
  "vault sequence and the show command for its evidence (owner show for an owner transaction), from the database alone (no RPC).",
  "npm run solana:resolve -- shortfall show <tenant|account> [--third-rpc] [--exclude primary|fallback|third] shows a vault below its book (the vault-below-book alert's",
  "account), and shortfall book <tenant|account> --operator NAME --reason \"why\" [--third-rpc] [--exclude ...] writes off what no owner withdrawal explains, as a loss;",
  "shortfall history <tenant> lists those decisions. A withdrawal the owner made outside Merrymen is not a loss: the owner records it under Owner controls.",
].join("\n");

const SCHEMA = `CREATE TABLE IF NOT EXISTS solana_operator_resolutions (
 id TEXT PRIMARY KEY, tenant TEXT NOT NULL, owner TEXT NOT NULL, request_id TEXT NOT NULL, signature TEXT NOT NULL,
 outcome TEXT NOT NULL, operator TEXT NOT NULL, reason TEXT NOT NULL, settlement_json TEXT NOT NULL, evidence_json TEXT NOT NULL,
 approved_at_ms BIGINT NOT NULL, booked_at_ms BIGINT, refusal TEXT
);
CREATE INDEX IF NOT EXISTS solana_operator_resolutions_request ON solana_operator_resolutions(tenant, owner, request_id);
CREATE TABLE IF NOT EXISTS solana_operator_owner_resolutions (
 id TEXT PRIMARY KEY, tenant TEXT NOT NULL, owner TEXT NOT NULL, signature TEXT NOT NULL, kind TEXT NOT NULL, slot_name TEXT NOT NULL,
 outcome TEXT NOT NULL, basis TEXT NOT NULL, operator TEXT NOT NULL, reason TEXT NOT NULL, proof_json TEXT, evidence_json TEXT NOT NULL,
 approved_at_ms BIGINT NOT NULL, booked_at_ms BIGINT, refusal TEXT
);
CREATE INDEX IF NOT EXISTS solana_operator_owner_resolutions_signature ON solana_operator_owner_resolutions(tenant, owner, signature);`;
const ready = new WeakMap<Db, Promise<void>>();
/** The resolution record's table (and the trading tables it refers to). */
export async function ensureSolanaResolutionSchema(db: Db, postgres: boolean): Promise<void> {
  await ensureSolanaTradingSchema(db, postgres);
  let promise = ready.get(db);
  if (!promise) {
    promise = (postgres ? db.tx(async tx => { await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(1_297_691_985); await tx.exec(SCHEMA); }) : db.exec(SCHEMA))
      .catch(error => { ready.delete(db); throw error; });
    ready.set(db, promise);
  }
  return promise;
}

/** One provider the operator can consult: a label, its hostname, and a read session against it alone. */
export interface SolanaResolveProvider {
  label: string;
  host: string;
  read<T>(operation: (read: SolanaLiveRead) => Promise<T>): Promise<T>;
}
/**
 * A provider's view: the executor's own observation, or why it could not be
 * read (fixed text only). `excluded`: set aside by the operator (--exclude).
 */
export type SolanaResolveView = { label: string; hostId: string; excluded?: true } & ({ observation: SolanaObservation } | { error: string });
export type SolanaResolveDecision =
  | { book: true; settlement: SolanaLiveSettlement; agreed: string[] }
  | { book: false; reason: string };

/** A stable short id for a hostname: enough to tell providers apart in the record, never the URL. */
export function hostId(host: string): string { return createHash("sha256").update(host).digest("hex").slice(0, 16); }
function normalizedHost(url: string): string { return new URL(url).hostname.toLowerCase().replace(/\.$/, ""); }

/**
 * What may be booked from these views. Two providers on different hostnames
 * must derive the same final outcome, and no provider may report a different
 * one. An expiry also needs that no provider has seen the signature and that
 * every provider not excluded could be read. A view the operator excluded
 * neither agrees nor disagrees, but its having seen the signature still
 * refuses an expiry. Anything else books nothing.
 */
export function solanaResolveDecision(views: readonly SolanaResolveView[]): SolanaResolveDecision {
  const settled = views.filter((view): view is SolanaResolveView & { observation: SolanaObservation } => !view.excluded && "observation" in view && view.observation.settlement !== null);
  const outcomes = new Map<string, typeof settled>();
  for (const view of settled) outcomes.set(observationKey(view.observation), [...(outcomes.get(observationKey(view.observation)) ?? []), view]);
  if (outcomes.size > 1) return { book: false, reason: "Providers report different final outcomes for this transaction. Nothing is booked: find out which provider is wrong before going further. "
    + "Once you know, set it aside with --exclude (and --third-rpc for another provider): two other providers must still agree." };
  const [agreeing] = [...outcomes.values()];
  if (!agreeing) return { book: false, reason: "No provider reports a final outcome yet. Nothing is booked; the reservation stays held. Try again later, or consult another provider with --third-rpc." };
  // A vault whose sequence moved and whose debit log holds a swap inside the trade's window: it may have run. No
  // number of providers proving an expiry elsewhere outweighs that (an excluded provider's view included).
  if (agreeing[0]!.observation.settlement!.status === "expired" && views.some(view => "observation" in view && view.observation.sequenceMoved?.reason === "debit-in-window")) {
    return { book: false, reason: "A provider's vault shows its sequence moved and its debit log holds a swap inside this trade's window (shown above): the trade may have run. "
      + "Nothing is booked: look for its fill before going further." };
  }
  if (new Set(agreeing.map(view => view.hostId)).size < 2) {
    return { book: false, reason: "Only one provider reports this final outcome. Two independent providers must agree before anything is booked; consult another provider with --third-rpc." };
  }
  // An expiry's slot is each provider's own read: the lowest of the agreeing views is booked (solanaAgreedSettlement).
  const settlement = solanaAgreedSettlement(agreeing.map(view => view.observation.settlement!));
  if (settlement.status === "expired") {
    // Every view counts here, an excluded one included: a provider that saw the signature may be the one telling the truth.
    const seen = views.filter((view): view is SolanaResolveView & { observation: SolanaObservation } => "observation" in view && view.observation.seen);
    if (seen.some(view => !view.observation.sequenceMoved)) {
      return { book: false, reason: "A provider has seen this signature, so its expiry is not booked: the transaction may have landed. Nothing is booked." };
    }
    // Only moved sequences that cannot be proven yet (shown above with why): the trade has not been seen, but its expiry is not proven everywhere.
    if (seen.length) return { book: false, reason: "A provider's vault cannot prove yet that this trade never ran (shown above), so its expiry is not booked. Nothing is booked; ask again later." };
    // An unreadable answer may be the proof it landed: a finalized status whose
    // receipt cannot be used throws rather than reading as unseen. A transaction
    // that landed and failed leaves the vault sequence unchanged, so the others'
    // expiry proofs cannot rule it out. Only the operator sets a dead provider aside.
    if (views.some(view => !view.excluded && "error" in view)) {
      return { book: false, reason: "A provider could not be read, so this expiry is not booked: its answer may be the evidence that the transaction landed. Nothing is booked. "
        + "If that provider is down, set it aside with --exclude (two other providers must still agree)." };
    }
  }
  return { book: true, settlement, agreed: agreeing.map(view => view.label) };
}

/** Fixed text for a provider that could not answer: never provider content, endpoints or keys. */
function viewError(error: unknown): string {
  if (error instanceof SolanaRpcError || error instanceof SolanaSettlementError || error instanceof SolanaExecutionError) return error.message;
  return "Its answer could not be read.";
}
function describe(view: SolanaResolveView): string {
  const text = describeObservation(view);
  return view.excluded ? `${text} (excluded by the operator: shown and recorded, not counted)` : text;
}
function describeObservation(view: SolanaResolveView): string {
  if ("error" in view) return `could not be used: ${view.error}`;
  const { settlement, seen } = view.observation;
  const moved = view.observation.sequenceMoved;
  if (!settlement && moved) {
    const outside = `pending: not seen, but the vault sequence moved to ${moved.vaultSequence} outside this trade`;
    switch (moved.reason) {
      case "behind": return `pending: not seen, and this provider's finalized vault is at sequence ${moved.vaultSequence}, before the one this trade was signed at`;
      case "blockhash-live": return `${outside}; its blockhash had not expired at finalized height ${moved.blockHeight}, so whether it ran is not settled yet: ask again`;
      case "debit-in-window": {
        const start = Number(moved.debitWindowStart), from = Number.isSafeInteger(start) && start >= 0 ? new Date(start * 1000).toISOString() : "the start of its signed deadline window";
        return `${outside}, and the vault's debit log holds a swap at or after ${from}, inside this trade's window: it may have run. Look for its fill`;
      }
      default: return `${outside}; whether it ran was not checked`;
    }
  }
  if (!settlement) return seen ? "pending: seen, not finalized" : "pending: not seen, and its blockhash may still land";
  if (settlement.status !== "expired") {
    return settlement.status === "finalized" ? `finalized fill at slot ${settlement.slot}: ${settlement.amountIn} in, ${settlement.amountOut} out, fee ${settlement.feeLamports} lamports`
      : `failed on chain at slot ${settlement.slot}, fee ${settlement.feeLamports} lamports, no tokens moved`;
  }
  const proof = settlement.expiryProof;
  if (proof.reason === "sequence-consumed") {
    const start = Number(proof.debitWindowStart), from = Number.isSafeInteger(start) && start >= 0 ? new Date(start * 1000).toISOString() : "the start of its signed deadline window";
    return `never ran: blockhash expired at finalized height ${proof.blockHeight}; the vault sequence moved to ${proof.vaultSequence} outside this trade, `
      + `and the vault's debit log holds no swap at or after ${from}, the earliest it could have run`;
  }
  return proof.reason === "session-revoked" ? `never ran: the session was revoked (epoch ${proof.sessionEpoch}) with vault sequence ${proof.vaultSequence} unchanged`
    : `never ran: blockhash expired at finalized height ${proof.blockHeight} with vault sequence ${proof.vaultSequence} unchanged`;
}

export interface SolanaResolveInput {
  db: Db; postgres?: boolean; tenant: string; requestId: string;
  providers: readonly SolanaResolveProvider[];
  now?: () => number;
  /** Book the agreed outcome, recording who decided and why. Without it nothing is written. */
  book?: { operator: string; reason: string };
  /** The label of one provider the operator sets aside (--exclude): read, shown and recorded, never counted. */
  exclude?: string;
  /** The executor's per-provider observation; injectable for tests only. */
  observe?: typeof observeSolanaSubmission;
}
export interface SolanaResolveResult {
  owner: string; record: SolanaLiveRecord; views: SolanaResolveView[]; decision: SolanaResolveDecision | null;
  /** True only when this run's decision booked the outcome. */
  booked: boolean; lines: string[];
}
/** The refusal recorded on a decision that did not book the trade because something else booked it first. */
export const SOLANA_RESOLUTION_SUPERSEDED = "Already booked by another path when this decision was settled or rerun; this decision did not book it.";

export function tenantOf(value: string | undefined): string {
  if (!value || !/^0x[0-9a-f]{40}$/.test(value)) refuse("Name the tenant as a lowercase 0x address.");
  return value;
}
function requestIdOf(value: string | undefined): string {
  if (!value || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)) refuse("Name the live trade's request id.");
  return value;
}
export function lineOf(value: string | undefined, label: string, max: number): string {
  if (!value || value.trim() !== value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) refuse(`Give ${label} on one line, at most ${max} characters.`);
  return value;
}
export async function ownerOf(db: Db, tenant: string): Promise<string> {
  let row: { owner: string } | undefined;
  try { row = await db.prepare("SELECT owner FROM solana_wallet_bindings WHERE tenant=? AND chain=?").get(tenant, CHAINS.solana) as { owner: string } | undefined; }
  catch { row = undefined; }
  if (!row) refuse("No Solana wallet binding exists for that tenant.");
  return row.owner;
}
function sameSettlement(a: SolanaLiveSettlement | undefined, b: SolanaLiveSettlement): boolean {
  return !!a && JSON.stringify({ ...a, finalizedAtMs: 0 }) === JSON.stringify({ ...b, finalizedAtMs: 0 });
}

/**
 * Shows every provider's view of one pending live trade and what may be booked
 * from them; with `book`, records the decision and books it through the store.
 */
export async function resolveSolanaPendingTrade(input: SolanaResolveInput): Promise<SolanaResolveResult> {
  const now = input.now ?? Date.now, observe = input.observe ?? observeSolanaSubmission, postgres = input.postgres ?? false;
  const tenant = tenantOf(input.tenant), requestId = requestIdOf(input.requestId);
  const book = input.book ? { operator: lineOf(input.book.operator, "the operator's name", 80), reason: lineOf(input.book.reason, "a reason", 200) } : undefined;
  const hosts = input.providers.map(provider => provider.host);
  if (new Set(hosts).size !== hosts.length) refuse("Every provider must be on its own hostname.");
  if (input.exclude !== undefined && !input.providers.some(provider => provider.label === input.exclude)) refuse("The excluded provider is not one of the providers consulted.");
  await ensureSolanaResolutionSchema(input.db, postgres);
  const owner = await ownerOf(input.db, tenant);
  const store = new SolanaTradingStore(input.db, { tenant, owner }, now);
  const record = await store.get(owner, requestId);
  if (!record) refuse("No live trade with that request id exists for that tenant.");
  const submission = record.submission, lines = [
    `Live trade ${requestId} for tenant ${tenant}: ${record.status}.`,
    `  signature ${submission.signature}, vault sequence ${submission.vaultSequence}, last valid block height ${submission.lastValidBlockHeight}, prepared ${new Date(submission.preparedAtMs).toISOString()}`,
  ];
  if (record.status !== "pending") {
    lines.push(`It is already ${record.status}; nothing is booked.`);
    // A decision is marked booked in the same transaction that books the trade
    // (settleResolution), so one still open on a booked trade did not book it:
    // its run stopped before settling, and something else booked the trade.
    // A book run records that; show writes nothing.
    if (book) {
      const superseded = await input.db.prepare("UPDATE solana_operator_resolutions SET refusal=? WHERE tenant=? AND owner=? AND request_id=? AND booked_at_ms IS NULL AND refusal IS NULL")
        .run(SOLANA_RESOLUTION_SUPERSEDED, tenant, owner, requestId);
      if (superseded.changes > 0) lines.push(`${superseded.changes === 1 ? "An open operator decision" : `${superseded.changes} open operator decisions`} for it did not book it and ${superseded.changes === 1 ? "is" : "are"} now recorded as superseded.`);
    }
    const booker = await input.db.prepare("SELECT operator,booked_at_ms FROM solana_operator_resolutions WHERE tenant=? AND owner=? AND request_id=? AND booked_at_ms IS NOT NULL")
      .get(tenant, owner, requestId) as { operator: string; booked_at_ms: number | string } | undefined;
    lines.push(booker ? `It was booked by an operator decision of ${booker.operator} at ${new Date(Number(booker.booked_at_ms)).toISOString()}.` : "No operator decision booked it.");
    return { owner, record, views: [], decision: null, booked: false, lines };
  }
  const nowMs = now();
  const views: SolanaResolveView[] = [];
  for (const provider of input.providers) {
    const base = { label: provider.label, hostId: hostId(provider.host), ...(provider.label === input.exclude ? { excluded: true as const } : {}) };
    try { views.push({ ...base, observation: await provider.read(read => observe(read, submission, owner, nowMs, { proveSequenceConsumed: true })) }); }
    catch (error) { views.push({ ...base, error: viewError(error) }); }
  }
  for (const view of views) lines.push(`  ${view.label}: ${describe(view)}`);
  const decision = solanaResolveDecision(views);
  if (!decision.book) { lines.push(decision.reason); return { owner, record, views, decision, booked: false, lines }; }
  const outcome = decision.settlement.status === "finalized" ? "a finalized fill" : decision.settlement.status === "failed" ? "an on-chain failure" : "a proven expiry";
  lines.push(`${decision.agreed.join(" and ")} agree on ${outcome}.`);
  if (!book) { lines.push("Nothing was written. To book it, run book with --operator and --reason."); return { owner, record, views, decision, booked: false, lines }; }
  // The record comes first: nothing is ever booked without who decided it, why and on what evidence.
  const id = randomUUID();
  // An excluded provider's dissent is part of the evidence: who set it aside, and what it said.
  const evidence = { signature: submission.signature, vaultSequence: submission.vaultSequence, lastValidBlockHeight: submission.lastValidBlockHeight,
    agreed: decision.agreed, ...(input.exclude !== undefined ? { excluded: input.exclude } : {}), providers: views.map(view => ({ label: view.label, hostId: view.hostId,
      ...(view.excluded ? { excluded: true } : {}),
      ...("error" in view ? { error: view.error } : { seen: view.observation.seen, settlement: view.observation.settlement,
        ...(view.observation.sequenceMoved ? { sequenceMoved: view.observation.sequenceMoved } : {}) }) })) };
  await input.db.prepare(`INSERT INTO solana_operator_resolutions(id,tenant,owner,request_id,signature,outcome,operator,reason,settlement_json,evidence_json,approved_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id, tenant, owner, requestId, submission.signature, decision.settlement.status, book.operator, book.reason,
    JSON.stringify(decision.settlement), JSON.stringify(evidence), now());
  let bookedHere: boolean;
  try { bookedHere = await store.settleResolution(owner, requestId, submission.signature, decision.settlement, id); }
  catch (error) {
    // An error after the store committed (a lost reply) must not be recorded as a refusal. The decision is marked
    // booked in the store's own transaction, so its record says whether this run booked; read it and the trade.
    // When that read fails too, the outcome is unknown: nothing is recorded, and the operator is told so.
    let mark: { booked_at_ms: number | string | null } | undefined, after: SolanaLiveRecord | null;
    try {
      mark = await input.db.prepare("SELECT booked_at_ms FROM solana_operator_resolutions WHERE id=?").get(id) as typeof mark;
      after = await store.get(owner, requestId);
    } catch {
      refuse("The settlement's reply was lost and the trade could not be read again, so it may or may not be booked. Run show to see its status, and history to see "
        + "whether this decision booked it: a decision is marked booked if and only if it booked the trade (nothing is ever booked twice).");
    }
    if (mark && mark.booked_at_ms !== null) bookedHere = true;
    else if (after && after.status !== "pending" && sameSettlement(after.settlement, decision.settlement)) bookedHere = false;
    else {
      // The store re-checks the evidence against the reservation; its refusals are fixed text.
      const refusal = error instanceof SolanaTradingStoreError ? error.message : "The settlement could not be written.";
      await input.db.prepare("UPDATE solana_operator_resolutions SET refusal=? WHERE id=? AND booked_at_ms IS NULL").run(refusal, id);
      refuse(`Nothing was booked: ${refusal} The decision is recorded as refused.`);
    }
  }
  if (!bookedHere) {
    // Booked meanwhile with the same evidence by something else (the worker's automatic settlement): not this decision.
    try { await input.db.prepare("UPDATE solana_operator_resolutions SET refusal=? WHERE id=? AND booked_at_ms IS NULL AND refusal IS NULL").run(SOLANA_RESOLUTION_SUPERSEDED, id); }
    catch { /* It stays open, never marked booked; the next book run records it as superseded. */ }
    lines.push(`It was booked meanwhile with the same evidence by another path, so this decision did not book it and is recorded as superseded.`);
    return { owner, record, views, decision, booked: false, lines };
  }
  lines.push(`Booked ${outcome}, recorded as decided by ${book.operator}.`);
  return { owner, record, views, decision, booked: true, lines };
}

/**
 * What the agent's pending-stuck [alert] counts, by name: every live trade
 * admitted, and every signed owner transaction prepared, at least
 * `olderThanMs` before `nowMs` (SOLANA_PENDING_STUCK_MS) and still pending,
 * oldest first. Read from the database alone: no RPC, and nothing secret (no
 * signed bytes, sealed seeds or settings). `id` is a trade's request id (what
 * show and book take) or an owner transaction's signature; `vaultSequence` is
 * the sequence a trade was signed against, or the one an owner transaction was
 * prepared at. The CLI prints beside each the command that shows its evidence:
 * show for a trade, owner show for an owner transaction.
 */
export async function listSolanaStuckPending(db: Db, nowMs: number, postgres = false, olderThanMs = SOLANA_PENDING_STUCK_MS) {
  await ensureSolanaResolutionSchema(db, postgres);
  const cutoff = nowMs - olderThanMs;
  const trades = (await db.prepare("SELECT tenant,request_id,sequence,created_at_ms FROM solana_runtime_submissions WHERE status='pending' AND created_at_ms<=?").all(cutoff) as
    Array<{ tenant: string; request_id: string; sequence: string | number; created_at_ms: number | string }>)
    .map(row => ({ kind: "trade" as const, tenant: row.tenant, id: row.request_id, what: "live trade", atMs: Number(row.created_at_ms), vaultSequence: String(row.sequence) }));
  // Both owner slots: a revocation saved beside a record (REVOKE BESIDE A PENDING OWNER TRANSACTION) can be stuck too.
  const owners = (await solanaPendingOwnerTransactions(db)).flatMap(item => !item.signature || item.preparedAtMs === null || item.preparedAtMs > cutoff ? []
    : [{ kind: "owner" as const, tenant: item.tenant, id: item.signature, what: `owner ${item.kind} transaction${item.slot === "revoke" ? " (beside another)" : ""}`,
      atMs: item.preparedAtMs, vaultSequence: item.priorSequence }]);
  return [...trades, ...owners].sort((a, b) => a.atMs - b.atMs || a.tenant.localeCompare(b.tenant) || a.id.localeCompare(b.id))
    .map(({ atMs, ...item }) => ({ ...item, ageMs: nowMs - atMs }));
}
function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The recorded operator resolutions for a tenant, newest first. */
export async function listSolanaResolutions(db: Db, tenant: string, requestId?: string, postgres = false) {
  await ensureSolanaResolutionSchema(db, postgres);
  const rows = await db.prepare(`SELECT request_id,signature,outcome,operator,reason,approved_at_ms,booked_at_ms,refusal FROM solana_operator_resolutions
    WHERE tenant=?${requestId === undefined ? "" : " AND request_id=?"} ORDER BY approved_at_ms DESC`).all(...(requestId === undefined ? [tenantOf(tenant)] : [tenantOf(tenant), requestIdOf(requestId)])) as
    Array<{ request_id: string; signature: string; outcome: string; operator: string; reason: string; approved_at_ms: number | string; booked_at_ms: number | string | null; refusal: string | null }>;
  return rows.map(row => ({ requestId: row.request_id, signature: row.signature, outcome: row.outcome, operator: row.operator, reason: row.reason,
    approvedAtMs: Number(row.approved_at_ms), bookedAtMs: row.booked_at_ms === null ? null : Number(row.booked_at_ms), refusal: row.refusal }));
}

export interface SolanaResolveDeps {
  db: Db; postgres?: boolean; env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch; now?: () => number; timeoutMs?: number;
  /** owner subcommand: each provider's view of an owner transaction; injectable for tests only. */
  observeOwner?: SolanaOwnerObserve;
}
/**
 * The configured providers (primary, and the fallback when set) plus, with
 * `third`, the operator's from MERRYMEN_SOLANA_RESOLVE_THIRD_RPC, each a
 * single-endpoint read session.
 */
export function solanaResolveProviders(env: Readonly<Record<string, string | undefined>>, third: boolean,
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {}): SolanaResolveProvider[] {
  const config = readSolanaMainnetRpcConfig(env);
  const urls: Array<[string, string]> = [["primary", config.url]];
  if (config.fallbackUrl) urls.push(["fallback", config.fallbackUrl]);
  if (third) {
    const thirdRpc = env[SOLANA_RESOLVE_THIRD_RPC_ENV];
    if (!thirdRpc) refuse(`--third-rpc reads the third provider's HTTPS URL from ${SOLANA_RESOLVE_THIRD_RPC_ENV}. Set it in .env.solana.local or the environment, then run this again.`);
    urls.push([EXCLUDABLE.third!, readSolanaMainnetRpcConfig({ MERRYMEN_SOLANA_RPC_MAINNET: thirdRpc }).url]);
  }
  const providers = urls.map(([label, url]) => {
    const transport = createSolanaLiveRpc({ env: { MERRYMEN_SOLANA_RPC_MAINNET: url }, singleEndpoint: true, fetch: options.fetch, timeoutMs: options.timeoutMs ?? 15_000 });
    return { label, host: normalizedHost(url), read: <T>(operation: (read: SolanaLiveRead) => Promise<T>) => transport.read(operation) };
  });
  if (new Set(providers.map(provider => provider.host)).size !== providers.length) {
    refuse(!third ? "The configured providers share a hostname." : "The third provider must be on a different hostname from the configured providers.");
  }
  return providers;
}

/** The CLI's whole behaviour, so it can be tested without a process. */
export async function runSolanaResolveCommand(argv: readonly string[], deps: SolanaResolveDeps): Promise<string> {
  if (argv[0] === "owner") return runSolanaOwnerResolveCommand(argv.slice(1), deps);
  const [command, ...rest] = argv;
  const positional: string[] = [], flags = new Map<string, string>();
  // A URL is never taken from the command line (it can carry an API key, and
  // arguments show in ps and shell history). It is refused without being echoed.
  if (rest.some(item => /^[a-z][a-z0-9+.-]*:\/\//i.test(item))) {
    refuse(`Do not pass provider URLs on the command line. Put the third provider's HTTPS URL in ${SOLANA_RESOLVE_THIRD_RPC_ENV} and pass --third-rpc alone.`);
  }
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index]!;
    if (!item.startsWith("--")) { positional.push(item); continue; }
    const name = item.slice(2);
    if (name === "third-rpc") { if (flags.has(name)) refuse(SOLANA_RESOLVE_USAGE); flags.set(name, ""); continue; }
    const value = rest[++index];
    if (!["operator", "reason", "exclude"].includes(name) || value === undefined || flags.has(name)) refuse(SOLANA_RESOLVE_USAGE);
    flags.set(name, value);
  }
  const excluded = flags.get("exclude");
  if (excluded !== undefined && !Object.hasOwn(EXCLUDABLE, excluded)) refuse(SOLANA_RESOLVE_USAGE);
  const postgres = deps.postgres ?? false;
  if (command === "history" && (positional.length === 1 || positional.length === 2) && flags.size === 0) {
    const rows = await listSolanaResolutions(deps.db, positional[0]!, positional[1], postgres);
    if (!rows.length) return "No operator resolutions are recorded for that tenant.";
    return rows.map(row => [new Date(row.approvedAtMs).toISOString(), row.requestId, row.outcome, row.bookedAtMs !== null ? "booked" : row.refusal ? `refused: ${row.refusal}` : "not booked",
      `by ${row.operator}`, row.reason].join("\t")).join("\n");
  }
  // An operator's write-off of a vault shortfall no owner withdrawal explains (solana-resolve-shortfall.ts).
  if (command === "shortfall") {
    return (await import("./solana-resolve-shortfall")).runSolanaShortfallCommand(positional, flags, deps, excluded === undefined ? undefined : EXCLUDABLE[excluded]);
  }
  if (command === "pending" && positional.length === 0 && flags.size === 0) {
    const items = await listSolanaStuckPending(deps.db, (deps.now ?? Date.now)(), postgres);
    if (!items.length) return `Nothing has been pending for over ${SOLANA_PENDING_STUCK_MS / 60_000} minutes.`;
    return [`Pending for over ${SOLANA_PENDING_STUCK_MS / 60_000} minutes, oldest first (tenant, what, id, age, vault sequence):`, ...items.map(item => [`  ${item.tenant}`, item.what, item.id,
      `pending ${age(item.ageMs)}`, `vault sequence ${item.vaultSequence ?? "unknown"}`,
      item.kind === "trade" ? `npm run solana:resolve -- show ${item.tenant} ${item.id}` : `npm run solana:resolve -- owner show ${item.tenant} ${item.id}`].join("\t"))].join("\n");
  }
  const booking = command === "book";
  if ((command !== "show" && !booking) || positional.length !== 2 || (booking ? !flags.has("operator") || !flags.has("reason") : flags.has("operator") || flags.has("reason"))) {
    refuse(SOLANA_RESOLVE_USAGE);
  }
  const providers = solanaResolveProviders(deps.env ?? process.env, flags.has("third-rpc"), { fetch: deps.fetch, timeoutMs: deps.timeoutMs });
  const result = await resolveSolanaPendingTrade({ db: deps.db, postgres, tenant: positional[0]!, requestId: positional[1]!, providers, now: deps.now,
    ...(excluded !== undefined ? { exclude: EXCLUDABLE[excluded] } : {}),
    ...(booking ? { book: { operator: flags.get("operator")!, reason: flags.get("reason")! } } : {}) });
  // A book that booked nothing is a failure the operator must see (exit status 1).
  if (booking && !result.booked) refuse(result.lines.join("\n"));
  return result.lines.join("\n");
}

/**
 * OPERATOR-REVIEWED RESOLUTION OF A STUCK OWNER TRANSACTION (live-M2).
 *
 * The app finishes a submitted owner transaction (revoke, withdrawal, native
 * withdrawal, resume-buys, permission registration) only when both providers
 * derive the same outcome: a finalized receipt with its vault effect, or an
 * expiry proven by finalized vault state it must have changed (ownerStatus).
 * When that state moved for another reason (a leaked session traded, an owner
 * transaction made with another wallet), or the providers keep disagreeing, the
 * record stays pending: trading is held and the next withdrawal, resume-buys or
 * permission waits. The revocation never waits (it goes beside it). This is the
 * operator's way through, with the same rules as the trade resolver above:
 *
 * - Each provider's view is derived exactly as the app derives it
 *   (observeOwnerTransaction), from the configured providers and optionally the
 *   operator's third (--third-rpc), each on its own hostname; one may be set
 *   aside by name (--exclude): it is still read, shown and recorded.
 * - A receipt is booked when two providers on their own hostnames agree on it
 *   (outcome, slot, error) and no counted provider reports another final outcome.
 * - "Never ran" is booked only when no provider, an excluded one included, has
 *   seen the signature (no status, no transaction, history searched), every
 *   counted provider could be read and is past the transaction's last valid
 *   block height with the vault read at or after that bank, and two of them on
 *   their own hostnames say so. When the vault still proves it (both derive the
 *   app's own expiry proof) that proof is booked; otherwise an operator-no-receipt
 *   proof, which only this path may book (finishSetupResolution).
 * - Before booking it records the operator, their reason, the decision and every
 *   provider's view in solana_operator_owner_resolutions, then finishes the
 *   record through the trading store, which re-checks everything and marks the
 *   decision booked in the same transaction. It never frees, books or changes
 *   anything any other way, never touches a record already finished, and never
 *   signs or sends a transaction.
 */
type SolanaOwnerObserve = (read: SolanaLiveRead, owner: string, setup: SolanaPreparedSetup, epochOffset: number) => Promise<SolanaOwnerView>;
/** One provider's view of a saved owner transaction, as the app derives it (solana-app-runtime ownerStatus). */
export type SolanaOwnerView =
  | { outcome: "pending"; seen: boolean; canLand: boolean; evidence?: Omit<SolanaOwnerExpiryProof, "reason"> }
  | { outcome: "finalized" | "failed"; slot: number; err: string }
  | { outcome: "expired"; proof: SolanaOwnerExpiryProof; fresh?: number };
export type SolanaOwnerResolveView = { label: string; hostId: string; excluded?: true } & ({ observation: SolanaOwnerView } | { error: string });
export type SolanaOwnerResolveDecision =
  | { book: true; status: "finalized" | "failed"; slot: number; basis: "receipt" | "expiry" | "no-receipt"; proof?: Omit<SolanaOwnerExpiryProof, "resolution">; agreed: string[] }
  | { book: false; reason: string };

function distinctHosts(views: readonly SolanaOwnerResolveView[]): number { return new Set(views.map(view => view.hostId)).size; }
function observed(view: SolanaOwnerResolveView): view is SolanaOwnerResolveView & { observation: SolanaOwnerView } { return "observation" in view; }
function hasSeen(view: SolanaOwnerResolveView): boolean {
  return observed(view) && (view.observation.outcome === "finalized" || view.observation.outcome === "failed" || (view.observation.outcome === "pending" && view.observation.seen));
}

/** What may be booked for one owner transaction from these views (OPERATOR-REVIEWED RESOLUTION OF A STUCK OWNER TRANSACTION). */
export function solanaOwnerResolveDecision(views: readonly SolanaOwnerResolveView[]): SolanaOwnerResolveDecision {
  const counted = views.filter((view): view is SolanaOwnerResolveView & { observation: SolanaOwnerView } => !view.excluded && observed(view));
  const receipts = new Map<string, typeof counted>();
  for (const view of counted) {
    const o = view.observation;
    if (o.outcome === "finalized" || o.outcome === "failed") receipts.set(JSON.stringify([o.outcome, o.slot, o.err]), [...(receipts.get(JSON.stringify([o.outcome, o.slot, o.err])) ?? []), view]);
  }
  const expiredCounted = counted.filter(view => view.observation.outcome === "expired");
  if (receipts.size > 1 || (receipts.size === 1 && expiredCounted.length)) {
    return { book: false, reason: "Providers report different final outcomes for this owner transaction. Nothing is booked: find out which provider is wrong before going further. "
      + "Once you know, set it aside with --exclude (and --third-rpc for another provider): two other providers must still agree." };
  }
  if (receipts.size === 1) {
    const [agreeing] = [...receipts.values()];
    if (distinctHosts(agreeing!) < 2) return { book: false, reason: "Only one provider reports this receipt. Two independent providers must agree before anything is booked; consult another provider with --third-rpc." };
    const o = agreeing![0]!.observation as Extract<SolanaOwnerView, { slot: number }>;
    return { book: true, status: o.outcome, slot: o.slot, basis: "receipt", agreed: agreeing!.map(view => view.label) };
  }
  // No counted receipt. Any provider that has seen the signature, an excluded one included, may be the one telling the truth.
  if (views.some(hasSeen)) return { book: false, reason: "A provider has seen this signature, so it is not booked as never run: it may have landed. Nothing is booked." };
  if (views.some(view => !view.excluded && "error" in view)) {
    return { book: false, reason: "A provider could not be read, so this is not booked as never run: its answer may be the evidence that it landed. Nothing is booked. "
      + "If that provider is down, set it aside with --exclude (two other providers must still agree)." };
  }
  if (counted.some(view => view.observation.outcome === "pending" && view.observation.canLand)) {
    return { book: false, reason: "Its blockhash can still land on a provider's finalized chain. Nothing is booked; the app's own reads keep sending its saved bytes until it cannot." };
  }
  const evidence = counted.map(view => view.observation.outcome === "expired" ? view.observation.proof : view.observation.outcome === "pending" ? view.observation.evidence : undefined);
  if (evidence.some(item => item === undefined) || distinctHosts(counted) < 2) {
    return { book: false, reason: "Two providers on their own hostnames must each show the transaction's last valid block height passed, with the vault read at or after that bank. "
      + "Nothing is booked; consult another provider with --third-rpc." };
  }
  // Every counted provider proves "never ran" the app's way: book the proof read at the lowest slot, as the app
  // does (solanaQuorumSlot), never one provider's own; one whose slot runs far past another's fresh slot books nothing.
  if (expiredCounted.length === counted.length) {
    const proofs = counted.map(view => view.observation as Extract<SolanaOwnerView, { outcome: "expired" }>);
    let lowest: number;
    try { lowest = solanaQuorumSlot(proofs.map(item => ({ slot: item.proof.slot, fresh: item.fresh }))); } catch {
      return { book: false, reason: "One provider's expiry proof was read far past another provider's current finalized slot. Nothing is booked: "
        + "its slot would become the floor of every later owner read. Find out which provider is wrong, or try again shortly." };
    }
    const proof = proofs.find(item => item.proof.slot === lowest)!.proof;
    return { book: true, status: "failed", slot: proof.slot, basis: "expiry", proof, agreed: counted.map(view => view.label) };
  }
  // Otherwise the operator's no-receipt proof, from the earliest bank any counted provider read.
  const earliest = evidence.reduce((a, b) => b!.slot < a!.slot ? b : a)!;
  return { book: true, status: "failed", slot: earliest.slot, basis: "no-receipt", agreed: counted.map(view => view.label),
    proof: { reason: "operator-no-receipt", blockHeight: earliest.blockHeight, vaultSequence: earliest.vaultSequence, sessionEpoch: earliest.sessionEpoch, slot: earliest.slot } };
}

function describeOwnerView(view: SolanaOwnerResolveView): string {
  const text = (() => {
    if ("error" in view) return `could not be used: ${view.error}`;
    const o = view.observation;
    if (o.outcome !== "pending" && o.outcome !== "expired") return o.outcome === "finalized" ? `finalized at slot ${o.slot}, and the vault shows its effect` : `failed on chain at slot ${o.slot}: nothing it would do was done`;
    if (o.outcome === "expired") return `never ran: blockhash expired at finalized height ${o.proof.blockHeight}, vault sequence ${o.proof.vaultSequence} and epoch ${o.proof.sessionEpoch} unchanged`;
    if (o.seen) return "pending: seen, not finalized";
    if (o.canLand) return "pending: not seen, and its blockhash may still land";
    const moved = o.evidence;
    return moved ? `pending: not seen, blockhash expired at finalized height ${moved.blockHeight}, but the vault moved (sequence ${moved.vaultSequence}, epoch ${moved.sessionEpoch} at slot ${moved.slot}), so the app cannot prove it never ran`
      : "pending: not seen, blockhash expired, and the vault could not be read to prove it never ran";
  })();
  return view.excluded ? `${text} (excluded by the operator: shown and recorded, not counted)` : text;
}
function ownerViewError(error: unknown): string {
  if (error instanceof SolanaRpcError) return error.message;
  if (error instanceof Error && error.name === "SolanaAppRuntimeError") return error.message;
  return "Its answer could not be read.";
}
function signatureOf(value: string | undefined): string {
  if (!value || value.length > 100 || !/^[1-9A-HJ-NP-Za-km-z]{32,100}$/.test(value)) refuse("Name the owner transaction's signature.");
  return value;
}
function pendingOwner(setup: SolanaPreparedSetup | null): setup is SolanaPreparedSetup & { signature: string } {
  return !!setup?.signature && setup.status !== "finalized" && setup.status !== "failed";
}
function ownerKindName(setup: SolanaPreparedSetup): string {
  return ({ session: "permission registration", revoke: "revocation", withdraw: "withdrawal", "withdraw-sol": "native SOL withdrawal", "resume-buys": "resume-buys" } as const)[setup.kind ?? "session"] ?? "owner transaction";
}

export interface SolanaOwnerResolveInput {
  db: Db; postgres?: boolean; tenant: string;
  /** The owner transaction to decide on; without it (show only) every pending one is shown. */
  signature?: string;
  providers: readonly SolanaResolveProvider[]; now?: () => number;
  book?: { operator: string; reason: string };
  exclude?: string;
  /** Each provider's view, as the app derives it; injectable for tests only. */
  observe?: SolanaOwnerObserve;
}
export interface SolanaOwnerResolveResult {
  owner: string; records: Array<{ slot: "main" | "revoke"; setup: SolanaPreparedSetup; views: SolanaOwnerResolveView[]; decision: SolanaOwnerResolveDecision }>;
  /** True only when this run's decision finished the named owner transaction. */
  booked: boolean; lines: string[];
}
/** The refusal recorded on an owner decision that did not finish the transaction because the app (or another run) finished it first. */
export const SOLANA_OWNER_RESOLUTION_SUPERSEDED = "Already finished by the app or another run when this decision was booked; this decision did not finish it.";

/**
 * Shows every provider's view of the tenant's pending owner transactions (the
 * main record and a revocation beside it) and what may be booked; with `book`
 * and a signature, records the decision and finishes that one through the store.
 */
export async function resolveSolanaOwnerTransaction(input: SolanaOwnerResolveInput): Promise<SolanaOwnerResolveResult> {
  const now = input.now ?? Date.now, postgres = input.postgres ?? false, tenant = tenantOf(input.tenant);
  const wanted = input.signature === undefined ? undefined : signatureOf(input.signature);
  const book = input.book ? { operator: lineOf(input.book.operator, "the operator's name", 80), reason: lineOf(input.book.reason, "a reason", 200) } : undefined;
  if (book && wanted === undefined) refuse("Name the owner transaction's signature to book it.");
  const hosts = input.providers.map(provider => provider.host);
  if (new Set(hosts).size !== hosts.length) refuse("Every provider must be on its own hostname.");
  if (input.exclude !== undefined && !input.providers.some(provider => provider.label === input.exclude)) refuse("The excluded provider is not one of the providers consulted.");
  await ensureSolanaResolutionSchema(input.db, postgres);
  const owner = await ownerOf(input.db, tenant);
  const store = new SolanaTradingStore(input.db, { tenant, owner }, now);
  const observe: SolanaOwnerObserve = input.observe ?? (await import("./solana-app-runtime")).createSolanaAppRuntime({ db: input.db, env: {}, localTestDeployment: false }).observeOwnerTransaction;
  const main = await store.setup(), revoking = await store.revokeSetup();
  const slots = [["main", main, revoking], ["revoke", revoking, main]] as const;
  const lines: string[] = [], records: SolanaOwnerResolveResult["records"] = [];
  if (wanted !== undefined) {
    const found = slots.find(([, setup]) => setup?.signature === wanted);
    if (!found) refuse("No owner transaction with that signature is saved for that tenant.");
    const setup = found[1]!;
    if (!pendingOwner(setup)) {
      lines.push(`Owner transaction ${wanted} (${ownerKindName(setup)}) for tenant ${tenant} is already ${setup.status ?? "unsigned"}; nothing is booked.`);
      if (book) {
        const superseded = await input.db.prepare("UPDATE solana_operator_owner_resolutions SET refusal=? WHERE tenant=? AND owner=? AND signature=? AND booked_at_ms IS NULL AND refusal IS NULL")
          .run(SOLANA_OWNER_RESOLUTION_SUPERSEDED, tenant, owner, wanted);
        if (superseded.changes > 0) lines.push(`${superseded.changes} open operator decision${superseded.changes === 1 ? "" : "s"} for it did not finish it and ${superseded.changes === 1 ? "is" : "are"} now recorded as superseded.`);
        refuse(lines.join("\n"));
      }
      return { owner, records, booked: false, lines };
    }
  }
  const nowMs = now();
  for (const [slot, setup, partner] of slots) {
    if (!pendingOwner(setup) || (wanted !== undefined && setup.signature !== wanted)) continue;
    const epochOffset = solanaOwnerEpochOffset(setup, partner);
    const views: SolanaOwnerResolveView[] = [];
    for (const provider of input.providers) {
      const base = { label: provider.label, hostId: hostId(provider.host), ...(provider.label === input.exclude ? { excluded: true as const } : {}) };
      try { views.push({ ...base, observation: await provider.read(read => observe(read, owner, setup, epochOffset)) }); }
      catch (error) { views.push({ ...base, error: ownerViewError(error) }); }
    }
    const decision = solanaOwnerResolveDecision(views);
    records.push({ slot, setup, views, decision });
    lines.push(`Pending ${ownerKindName(setup)} ${setup.signature} for tenant ${tenant}${slot === "revoke" ? " (the revocation beside the main record)" : ""}:`,
      `  prepared ${new Date(setup.preparedAtMs).toISOString()}, last valid block height ${setup.lastValidBlockHeight}, prior vault sequence ${setup.priorSequence ?? "unknown"} and epoch ${setup.priorSessionEpoch ?? "unknown"}`);
    for (const view of views) lines.push(`  ${view.label}: ${describeOwnerView(view)}`);
    lines.push(decision.book ? `  ${decision.agreed.join(" and ")} agree: it can be booked as ${decision.status === "finalized" ? "finalized" : decision.basis === "receipt" ? "failed on chain" : "never run"}.` : `  ${decision.reason}`);
  }
  if (!records.length) { lines.push(`No owner transaction is pending for tenant ${tenant}.`); return { owner, records, booked: false, lines }; }
  if (!book) { lines.push("Nothing was written. To book one, run owner book with its signature, --operator and --reason."); return { owner, records, booked: false, lines }; }
  const target = records[0]!, decision = target.decision;
  if (!decision.book) refuse(lines.join("\n"));
  // The record comes first: nothing is ever finished without who decided it, why and on what evidence.
  const id = randomUUID();
  const proof = decision.proof ? { ...decision.proof, ...(decision.proof.reason === "operator-no-receipt" ? { resolution: id } : {}) } : undefined;
  const evidence = { signature: target.setup.signature, kind: target.setup.kind ?? "session", slot: target.slot, lastValidBlockHeight: target.setup.lastValidBlockHeight,
    priorSequence: target.setup.priorSequence ?? null, priorSessionEpoch: target.setup.priorSessionEpoch ?? null, agreed: decision.agreed,
    ...(input.exclude !== undefined ? { excluded: input.exclude } : {}),
    providers: target.views.map(view => ({ label: view.label, hostId: view.hostId, ...(view.excluded ? { excluded: true } : {}), ...("error" in view ? { error: view.error } : { observation: view.observation }) })) };
  await input.db.prepare(`INSERT INTO solana_operator_owner_resolutions(id,tenant,owner,signature,kind,slot_name,outcome,basis,operator,reason,proof_json,evidence_json,approved_at_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, tenant, owner, target.setup.signature!, target.setup.kind ?? "session", target.slot, decision.status, decision.basis,
    book.operator, book.reason, proof ? JSON.stringify(proof) : null, JSON.stringify(evidence), now());
  let finished: boolean;
  try { finished = await store.finishSetupResolution(target.setup.signature!, decision.status, decision.slot, proof, id); }
  catch (error) {
    // An error after the store committed (a lost reply) must not be recorded as a refusal: the mark says whether this run finished it.
    let mark: { booked_at_ms: number | string | null } | undefined, after: SolanaPreparedSetup | null | undefined;
    try {
      mark = await input.db.prepare("SELECT booked_at_ms FROM solana_operator_owner_resolutions WHERE id=?").get(id) as typeof mark;
      after = [await store.setup(), await store.revokeSetup()].find(item => item?.signature === target.setup.signature);
    } catch {
      refuse("The store's reply was lost and the owner transaction could not be read again, so it may or may not be finished. Run owner show to see it, and owner history "
        + "to see whether this decision finished it: a decision is marked booked if and only if it finished the transaction.");
    }
    if (mark && mark.booked_at_ms !== null) finished = true;
    else if (after && after.status === decision.status) finished = false;
    else {
      const refusal = error instanceof SolanaTradingStoreError ? error.message : "The owner transaction could not be finished.";
      await input.db.prepare("UPDATE solana_operator_owner_resolutions SET refusal=? WHERE id=? AND booked_at_ms IS NULL").run(refusal, id);
      refuse(`Nothing was booked: ${refusal} The decision is recorded as refused.`);
    }
  }
  if (!finished) {
    try { await input.db.prepare("UPDATE solana_operator_owner_resolutions SET refusal=? WHERE id=? AND booked_at_ms IS NULL AND refusal IS NULL").run(SOLANA_OWNER_RESOLUTION_SUPERSEDED, id); }
    catch { /* It stays open, never marked booked; the next owner book run records it as superseded. */ }
    lines.push("It was finished meanwhile with the same outcome by the app or another run, so this decision did not finish it and is recorded as superseded.");
    return { owner, records, booked: false, lines };
  }
  lines.push(`Booked the ${ownerKindName(target.setup)} as ${decision.status === "finalized" ? "finalized" : decision.basis === "receipt" ? "failed on chain" : "never run"}, recorded as decided by ${book.operator}.`);
  return { owner, records, booked: true, lines };
}

/** The recorded owner-transaction decisions for a tenant, newest first. */
export async function listSolanaOwnerResolutions(db: Db, tenant: string, postgres = false) {
  await ensureSolanaResolutionSchema(db, postgres);
  const rows = await db.prepare(`SELECT signature,kind,outcome,basis,operator,reason,approved_at_ms,booked_at_ms,refusal FROM solana_operator_owner_resolutions
    WHERE tenant=? ORDER BY approved_at_ms DESC`).all(tenantOf(tenant)) as Array<{ signature: string; kind: string; outcome: string; basis: string; operator: string; reason: string;
      approved_at_ms: number | string; booked_at_ms: number | string | null; refusal: string | null }>;
  return rows.map(row => ({ signature: row.signature, kind: row.kind, outcome: row.outcome, basis: row.basis, operator: row.operator, reason: row.reason,
    approvedAtMs: Number(row.approved_at_ms), bookedAtMs: row.booked_at_ms === null ? null : Number(row.booked_at_ms), refusal: row.refusal }));
}

/** `npm run solana:resolve -- owner ...` */
async function runSolanaOwnerResolveCommand(argv: readonly string[], deps: SolanaResolveDeps): Promise<string> {
  const [command, ...rest] = argv;
  if (rest.some(item => /^[a-z][a-z0-9+.-]*:\/\//i.test(item))) {
    refuse(`Do not pass provider URLs on the command line. Put the third provider's HTTPS URL in ${SOLANA_RESOLVE_THIRD_RPC_ENV} and pass --third-rpc alone.`);
  }
  const positional: string[] = [], flags = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const item = rest[index]!;
    if (!item.startsWith("--")) { positional.push(item); continue; }
    const name = item.slice(2);
    if (name === "third-rpc") { if (flags.has(name)) refuse(SOLANA_RESOLVE_USAGE); flags.set(name, ""); continue; }
    const value = rest[++index];
    if (!["operator", "reason", "exclude"].includes(name) || value === undefined || flags.has(name)) refuse(SOLANA_RESOLVE_USAGE);
    flags.set(name, value);
  }
  const excluded = flags.get("exclude");
  if (excluded !== undefined && !Object.hasOwn(EXCLUDABLE, excluded)) refuse(SOLANA_RESOLVE_USAGE);
  const postgres = deps.postgres ?? false;
  if (command === "history" && positional.length === 1 && flags.size === 0) {
    const rows = await listSolanaOwnerResolutions(deps.db, positional[0]!, postgres);
    if (!rows.length) return "No operator decisions on owner transactions are recorded for that tenant.";
    return rows.map(row => [new Date(row.approvedAtMs).toISOString(), row.signature, row.kind, `${row.outcome} (${row.basis})`,
      row.bookedAtMs !== null ? "booked" : row.refusal ? `refused: ${row.refusal}` : "not booked", `by ${row.operator}`, row.reason].join("\t")).join("\n");
  }
  const booking = command === "book";
  if ((command !== "show" && !booking) || (booking ? positional.length !== 2 || !flags.has("operator") || !flags.has("reason")
    : (positional.length !== 1 && positional.length !== 2) || flags.has("operator") || flags.has("reason"))) refuse(SOLANA_RESOLVE_USAGE);
  const providers = solanaResolveProviders(deps.env ?? process.env, flags.has("third-rpc"), { fetch: deps.fetch, timeoutMs: deps.timeoutMs });
  const result = await resolveSolanaOwnerTransaction({ db: deps.db, postgres, tenant: positional[0]!, ...(positional[1] !== undefined ? { signature: positional[1] } : {}), providers, now: deps.now,
    ...(excluded !== undefined ? { exclude: EXCLUDABLE[excluded] } : {}), ...(deps.observeOwner ? { observe: deps.observeOwner } : {}),
    ...(booking ? { book: { operator: flags.get("operator")!, reason: flags.get("reason")! } } : {}) });
  if (booking && !result.booked) refuse(result.lines.join("\n"));
  return result.lines.join("\n");
}
