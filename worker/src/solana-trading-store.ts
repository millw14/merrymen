/** Tenant-bound Solana paper books and live broadcast journal, on SQLite or Postgres. */
import { CHAINS, SOLANA_USDG_MINT, canonicalId } from "../../packages/core/src/ids";
import { SOLANA_LIVE_BELOW_MINIMUM, SOLANA_LIVE_MIN_TRADE_USDG_RAW, SOLANA_REGISTERED_AFTER_REVOKE } from "../../packages/core/src/solana";
import { SOLANA_MAX_OPS_PER_DAY, parseSolanaRawAmount, parseSolanaSwapIntent, requireSolanaLiveSellLimits, solanaPaperAgentId, validateSolanaAccountLimits, validateSolanaQuote,
  type SolanaPaperLimits, type SolanaQuote } from "../../packages/core/src/solana";
import { SOLANA_SYSTEM_PROGRAM, SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import type { Db } from "./db";
import { openSecret, sealSecret } from "./store-crypto";
import { applySolanaPaperCommit, applySolanaPaperWriteOff, solanaPaperIntentFingerprint, type SolanaPaperBook,
  type SolanaPaperCommit, type SolanaPaperReceipt, type SolanaPaperSnapshot, type SolanaPaperWriteOffRecord } from "./solana-paper-store";
import type { SolanaPaperLedger } from "./solana-paper-service";
import { solanaDebitWindowStart, type SolanaLiveJournal, type SolanaLiveRecord, type SolanaLiveSettlement, type SolanaSignedSubmission } from "./solana-executor";
import { SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS, solanaReferenceNotional, solanaReferenceWsolValue, verifySolanaReferenceBound, type SolanaPythGeneration,
  type SolanaReferenceBound } from "./solana-reference-price";

export interface SolanaAccountScope { tenant: string; owner: string }
export class SolanaTradingStoreError extends Error {
  constructor(message: string) { super(message); this.name = "SolanaTradingStoreError"; }
}
export interface SolanaTradingBinding extends SolanaAccountScope {
  requestedMode: "paper" | "live"; limits: SolanaPaperLimits | null; revision: number;
}
export interface SolanaRegisteredSession {
  programId: string; vault: string; session: string; sessionEpoch: string;
  registrationSignature: string; registeredAtMs: number;
  /**
   * The limits the vault holds for this session, raw, as activateLive read and checked them against the signed ones when it
   * registered it. Lets a buy under a session above the platform's live caps be refused before any quote. Absent from a record
   * registered before it was kept: the vault's own limits are then the only check (assessRisk).
   */
  limits?: { perTradeUsdg: string; dailyUsdg: string; perTradeWsol: string; dailyWsol: string };
}
export interface SolanaLiveBook {
  hwmRaw: string; cashRaw: string; wsolRaw: string;
  costBasisUsdgRaw: string; realizedPnlUsdgRaw: string; networkFeesLamports: string;
  unresolvedFeeCount?: number; reservedUnknownFeeLamports?: string;
  slot: number; updatedAtMs: number;
  buyPaused?: boolean;
  /**
   * WSOL that reached the vault outside recorded trades (anyone can send it).
   * Zero cost basis, never traded, and excluded from equity, P&L and the
   * high-water mark. The owner can withdraw it; withdrawals spend it first.
   */
  quarantinedWsolRaw?: string;
  /**
   * The slot of the last finalized balance snapshot the book was set from
   * (inflows booked): every vault change at or before it is in the book. A
   * withdrawal made outside Merrymen is recorded only after it (OWNER
   * WITHDRAWALS MADE OUTSIDE MERRYMEN). Absent: the book's creation is that point.
   */
  balancesSlot?: number;
}
/** The WSOL the session may trade: the recorded position, never quarantined WSOL. */
export function solanaQuarantinedWsol(book: Pick<SolanaLiveBook, "quarantinedWsolRaw">): bigint { return BigInt(book.quarantinedWsolRaw ?? "0"); }
/**
 * Why a submitted owner transaction is recorded as never having run.
 * - blockhash-expired: both providers' finalized banks are past its last valid
 *   height and the vault still shows the state it must have changed.
 * - operator-no-receipt: an operator's recorded decision (npm run solana:resolve
 *   -- owner book), only through finishSetupResolution: two providers on their
 *   own hostnames are past its last valid height and neither, nor any other
 *   consulted, has seen its signature, while the vault state moved for another
 *   reason. `resolution` is that decision's id.
 */
export interface SolanaOwnerExpiryProof {
  reason: "blockhash-expired" | "operator-no-receipt"; blockHeight: string; vaultSequence: string | null; sessionEpoch: string | null; slot: number;
  resolution?: string;
}
export interface SolanaPreparedSetup {
  transactionBase64: string; messageBase64: string; blockhash: string; lastValidBlockHeight: string;
  programId: string; vault: string; session: string; limits: SolanaPaperLimits;
  preparedAtMs: number; expiresAtMs: number; signature?: string; signedTransactionBase64?: string;
  kind?: "session" | "revoke" | "withdraw" | "withdraw-sol" | "resume-buys";
  /** withdraw: the token and amount; withdraw-sol: the lamports taken from the vault account above its rent reserve. */
  mint?: string; amountRaw?: string;
  /**
   * WSOL withdraw only: native lamports that sat unsynced in the vault's WSOL
   * account at prepare time (finalized read). The same transaction runs
   * SyncNative first, so at least this much became WSOL; it is booked as
   * zero-basis quarantine only as far as the withdrawal needs it.
   */
  syncedWsolRaw?: string;
  /**
   * WSOL withdraw only: what the withdrawn amount was worth when prepared. Checked
   * fresh when the unsigned setup is saved; the signed save keeps that copy.
   * Without it, a WSOL withdrawal leaves the high-water mark where it was.
   */
  withdrawValuation?: SolanaWithdrawValuation;
  status?: "pending" | "finalized" | "failed";
  /**
   * Finalized only: the slot of the finalized transaction, as both providers
   * agreed. A permission is activated from a vault read no earlier than this.
   * Absent on setups finalized before it was recorded.
   */
  finalizedSlot?: number;
  expiryProof?: SolanaOwnerExpiryProof;
  priorSequence?: string; priorSessionEpoch?: string; priorVaultExisted?: boolean;
  /**
   * Revoke slot only (REVOKE BESIDE A PENDING OWNER TRANSACTION, below): the
   * signature of the pending main-slot owner transaction this revocation was
   * prepared beside. Never set on a main-slot record.
   */
  beside?: string;
  /**
   * Revoke slot only: the revocations beside the same pending record that landed
   * before this one was prepared, oldest first, kept as history instead of
   * overwritten (REVOKE BESIDE...). Set by the store alone.
   */
  landed?: SolanaPreparedSetup[];
}
/**
 * REVOKE BESIDE A PENDING OWNER TRANSACTION (owner decision 2026-10-20, option A).
 *
 * The main slot (solana_runtime_setups) holds one owner transaction per account:
 * a permission registration, a withdrawal, a native SOL withdrawal, a
 * resume-buys or a revocation. Its record is what its outcome is booked from,
 * so it is never replaced while it may still land. A revocation used to wait
 * for it, so a pending record that never resolved (providers that keep
 * disagreeing, an expiry that cannot be proven) blocked the emergency revoke.
 *
 * Now a revocation can always be prepared and submitted while a NON-revoke
 * main-slot transaction is pending: it goes in its own slot
 * (solana_runtime_owner_revokes), marked `beside` that transaction's
 * signature, and the main record stays exactly as it was. Each record is
 * observed, rebroadcast and finished by its own signature (finishSetup finds
 * it in either slot) and booked once: a revocation books nothing but its
 * status, and a withdrawal's capital out is keyed by its signature.
 *
 * Still refused: a second pending revocation (in either slot), and any other
 * owner transaction while one is pending in either slot. Trades stay refused
 * while either is pending. A main-slot prepare clears a revoke-slot record
 * that is not pending (it belonged beside the record being replaced); a
 * pending one blocks that prepare.
 *
 * A revocation that landed beside the pending record is the partner that
 * record's "never ran" proof counts and what keeps a registration from being
 * activated, so it is kept, never overwritten, until the pending record
 * resolves. Another revocation beside the same record is refused
 * (SOLANA_REVOKE_ALREADY_LANDED) while nothing is left to revoke, and prepared
 * once a session registered on Solana after that landing is live (the pending
 * registration itself, landing after the revocation while the providers keep
 * disagreeing about it, or one made outside Merrymen: solanaLiveAfterRevoke).
 * The landed revocations then go with it as history (`landed`), still counted
 * by the proof (solanaOwnerEpochOffset) and still fencing the registration.
 *
 * Proofs stay independent: a revocation moves only the session epoch, and a
 * withdrawal or resume-buys never does, so neither can wedge the other's
 * expiry proof. A permission registration moves the epoch too: while a
 * revocation prepared beside it at the same prior epoch is finalized, "never
 * ran" for either one means the epoch moved exactly once
 * (solanaOwnerEpochOffset); while the other is unresolved, its move is not
 * counted and the proof waits. A registration with a signed revocation beside
 * it is never activated: the owner's later word was to revoke. Nor is one
 * whose landing did not move the epoch exactly once from what it was prepared
 * at (registerSession): something else moved it, a revocation among them.
 * While a revocation prepared beside it can still be signed, activation waits
 * (SOLANA_REVOKE_PREPARED_BESIDE) rather than delete it from under the owner's
 * wallet; signed and saved, it then fences the registration as above.
 */
/** Refused: a revocation beside a pending owner transaction once one beside it landed (REVOKE BESIDE...). */
export const SOLANA_REVOKE_ALREADY_LANDED = "Your revocation already landed, and no trading permission has registered on Solana since, so nothing is left to revoke. If one registers later, Revoke works again.";
/** Refused: signed bytes of an in-app withdrawal the owner already recorded as made outside Merrymen (OWNER WITHDRAWALS MADE OUTSIDE MERRYMEN). */
export const SOLANA_WITHDRAWAL_RECORDED_OUTSIDE = "This withdrawal is already recorded as made outside Merrymen, so it is not submitted again. Nothing more to do.";
/** The evidence ids a withdrawal made outside Merrymen is booked under, one per vault token. */
function externalEvidence(signature: string): [string, string] { return [`external:${signature}:${SOLANA_USDG_MINT}`, `external:${signature}:${SOLANA_WRAPPED_SOL_MINT}`]; }
/** Refused activation: an unsigned revocation prepared beside this registration can still be signed. */
export const SOLANA_REVOKE_PREPARED_BESIDE = "A revocation of this permission was prepared and can still be signed in your wallet. Sign it to revoke, or let it lapse (about a minute) and finish registration then.";
/** Refused activation: the vault's session epoch moved more than this registration's own landing since it was prepared (core, so the page can read it). */
export { SOLANA_REGISTERED_AFTER_REVOKE };
/** The session epoch a registration prepared at `priorSessionEpoch` leaves when it lands with nothing else moving it; null when unreadable. */
export function solanaRegisteredEpoch(priorSessionEpoch: string | undefined): bigint | null {
  return priorSessionEpoch !== undefined && /^(0|[1-9][0-9]{0,19})$/.test(priorSessionEpoch) ? BigInt(priorSessionEpoch) + 1n : null;
}
/**
 * How many times `partner`, the record in the other slot, moved the session
 * epoch that `setup`'s "never ran" proof starts from: 1 when the two are linked
 * (one was prepared beside the other), both move the epoch (a registration or
 * a revocation), they read the same prior epoch, and the partner is finalized
 * (it ran). Otherwise 0: an unresolved partner's move is never assumed.
 */
export function solanaOwnerEpochOffset(setup: Pick<SolanaPreparedSetup, "kind" | "signature" | "beside" | "priorSessionEpoch">,
  partner: (Pick<SolanaPreparedSetup, "kind" | "signature" | "beside" | "status" | "priorSessionEpoch"> & { landed?: ReadonlyArray<Pick<SolanaPreparedSetup, "kind" | "signature" | "beside" | "status" | "priorSessionEpoch">> }) | null | undefined): number {
  // A revocation kept as history in the partner's slot (`landed`) counts as the partner it was.
  return [partner, ...(partner?.landed ?? [])].some(item => linkedEpochMove(setup, item)) ? 1 : 0;
}
function linkedEpochMove(setup: Pick<SolanaPreparedSetup, "kind" | "signature" | "beside" | "priorSessionEpoch">,
  partner: Pick<SolanaPreparedSetup, "kind" | "signature" | "beside" | "status" | "priorSessionEpoch"> | null | undefined): boolean {
  if (!partner?.signature || partner.status !== "finalized" || setup.priorSessionEpoch === undefined || partner.priorSessionEpoch !== setup.priorSessionEpoch) return false;
  const linked = setup.beside !== undefined ? setup.beside === partner.signature : !!setup.signature && partner.beside === setup.signature;
  const epochKind = (kind: SolanaPreparedSetup["kind"]) => (kind ?? "session") === "session" || kind === "revoke";
  return linked && epochKind(setup.kind) && epochKind(partner.kind);
}
/**
 * The latest revocation that landed beside the pending main record `main`: the revoke slot's own record, or the
 * last kept as history in it, while no revocation beside it is pending. Null otherwise.
 */
export function solanaLandedBeside(main: SolanaPreparedSetup | null | undefined, revoke: SolanaPreparedSetup | null | undefined): SolanaPreparedSetup | null {
  if (!ownerPending(main) || !revoke || revoke.beside !== main!.signature || ownerPending(revoke)) return null;
  return revoke.signature && revoke.status === "finalized" ? revoke : revoke.landed?.at(-1) ?? null;
}
/**
 * Whether a vault read after `landed`, a revocation that landed beside a pending record, shows a session
 * registered on Solana since: one is set (revoke_all clears it to the default key) at an epoch past the one that
 * revocation left. Revoke then works again beside the same record (REVOKE BESIDE...).
 */
export function solanaLiveAfterRevoke(landed: Pick<SolanaPreparedSetup, "priorSessionEpoch">, vault: { session: string | undefined; sessionEpoch: string | bigint | undefined }): boolean {
  const left = solanaRegisteredEpoch(landed.priorSessionEpoch), epoch = typeof vault.sessionEpoch === "bigint" ? vault.sessionEpoch
    : vault.sessionEpoch !== undefined && /^(0|[1-9][0-9]{0,19})$/.test(vault.sessionEpoch) ? BigInt(vault.sessionEpoch) : null;
  return left !== null && epoch !== null && epoch > left && !!vault.session && vault.session !== SOLANA_SYSTEM_PROGRAM;
}
/**
 * RESUME-BUYS BESIDE A REVOCATION. revoke_all pauses buying on chain and set_breaker(false) unpauses it, each
 * with its own blockhash, so a revocation prepared beside a pending resume-buys that lands FIRST leaves the
 * resume-buys landing after it unpausing the vault: the reverse of the owner's later word. True while such a
 * revocation may be that word: signed and not known to have failed, or still signable. A resume-buys that
 * finalizes meanwhile then leaves the off-chain breaker paused (finishSetup), whichever landed first, and
 * status says so; a new resume-buys clears it as usual. A revocation that turns out never to have run only
 * leaves buying paused, the conservative direction.
 */
export function solanaRevokedBesideResume(resume: Pick<SolanaPreparedSetup, "kind" | "signature">,
  revoke: Pick<SolanaPreparedSetup, "kind" | "beside" | "signature" | "status" | "expiresAtMs"> | null | undefined, nowMs: number): boolean {
  return resume.kind === "resume-buys" && !!resume.signature && revoke?.kind === "revoke" && revoke.beside === resume.signature
    && revoke.status !== "failed" && (!!revoke.signature || nowMs < revoke.expiresAtMs);
}
/** The status warning while a finalized resume-buys left buying paused for a revocation beside it (RESUME-BUYS BESIDE A REVOCATION). */
export const SOLANA_RESUMED_AFTER_REVOKE = "Buying stays paused: you revoked beside a resume of buying, and the revocation is your later word, even if Solana shows buying resumed because the revocation landed first. Resume buying again under Owner controls when you want buys to restart.";
/** A signed owner transaction whose outcome is not yet recorded. */
function ownerPending(setup: SolanaPreparedSetup | null | undefined): boolean {
  return !!setup?.signature && setup.status !== "finalized" && setup.status !== "failed";
}
/**
 * An executable WSOL→USDG exit quote for the withdrawal amount and the
 * independent Pyth bound for the same amount, both read when it was prepared.
 */
export interface SolanaWithdrawValuation { quote: SolanaQuote; reference: SolanaReferenceBound }
/**
 * The lower of the two: neither Jupiter nor the reference can raise it alone, so
 * the high-water mark never drops by more than the withdrawn WSOL was worth.
 * Null when either is missing, malformed, stale or for another amount, or the
 * reference is not from `generation` (default: SOLANA_PYTH_DEFAULT_GENERATION).
 */
export function solanaWithdrawValueUsdg(valuation: SolanaWithdrawValuation | undefined, amountRaw: string | undefined, nowMs: number,
  generation?: () => SolanaPythGeneration): bigint | null {
  if (!valuation || typeof valuation !== "object") return null;
  try {
    const intent = parseSolanaSwapIntent({ kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "withdraw-valuation",
      inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw, slippageBps: valuation.quote?.slippageBps });
    validateSolanaQuote(valuation.quote, intent, nowMs);
    const bound = verifySolanaReferenceBound(valuation.reference, intent, nowMs, generation?.());
    const quoted = parseSolanaRawAmount(valuation.quote.minOutAmount), reference = parseSolanaRawAmount(bound.referenceOut);
    return quoted < reference ? quoted : reference;
  } catch { return null; }
}
/** A valuation saveSetup already checked; one that cannot be read never blocks booking the withdrawal. */
function storedWithdrawValue(valuation: SolanaWithdrawValuation | undefined): bigint | null {
  if (!valuation) return null;
  try {
    const quoted = parseSolanaRawAmount(valuation.quote.minOutAmount), reference = parseSolanaRawAmount(valuation.reference.referenceOut);
    return quoted < reference ? quoted : reference;
  } catch { return null; }
}
const DAY = 86_400_000;
/**
 * Whether finalized vault state after a blockhash expired proves this owner
 * transaction never ran. Each kind is judged only by state it must change:
 * - revoke always increments the session epoch;
 * - session (with any vault initialization in the same transaction) always
 *   increments the epoch, and the epoch of a vault that does not exist is 0;
 * - withdraw and withdraw-sol increment the sequence, and admission refuses
 *   session trades while one is prepared or pending, so nothing else can advance it;
 * - resume-buys changes neither; a wrong "failed" only leaves the off-chain
 *   breaker paused, which is the conservative direction.
 * `epochOffset`: the epoch moves the linked record in the other slot is known
 * to have made (solanaOwnerEpochOffset), 0 or 1; only epoch kinds use it.
 */
export function solanaOwnerExpiryProven(setup: Pick<SolanaPreparedSetup, "kind" | "priorVaultExisted" | "priorSequence" | "priorSessionEpoch">,
  vaultSequence: string | null, sessionEpoch: string | null, epochOffset = 0): boolean {
  if (setup.priorVaultExisted === undefined || setup.priorSequence === undefined || setup.priorSessionEpoch === undefined) return false;
  if (setup.priorVaultExisted && (vaultSequence === null || sessionEpoch === null)) return false;
  if ((vaultSequence === null) !== (sessionEpoch === null)) return false;
  if (epochOffset !== 0 && epochOffset !== 1) return false;
  let expectedEpoch = setup.priorSessionEpoch;
  if (epochOffset) { try { expectedEpoch = (BigInt(setup.priorSessionEpoch) + 1n).toString(); } catch { return false; } }
  switch (setup.kind ?? "session") {
    case "revoke": return setup.priorVaultExisted && sessionEpoch === expectedEpoch;
    case "session": return (sessionEpoch ?? "0") === expectedEpoch;
    case "withdraw": case "withdraw-sol": return setup.priorVaultExisted && vaultSequence === setup.priorSequence;
    case "resume-buys": return setup.priorVaultExisted;
    default: return false;
  }
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS solana_runtime_worker_heartbeat (
 worker TEXT PRIMARY KEY, last_seen_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS solana_runtime_live_rollout_seen (
 service TEXT PRIMARY KEY CHECK(service IN ('web','worker')), fingerprint TEXT NOT NULL, seen_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS solana_runtime_paper_books (
 tenant TEXT NOT NULL, owner TEXT NOT NULL, book_json TEXT NOT NULL, PRIMARY KEY(tenant,owner)
);
CREATE TABLE IF NOT EXISTS solana_runtime_paper_trades (
 tenant TEXT NOT NULL, owner TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 created_at_ms BIGINT NOT NULL, notional_raw TEXT NOT NULL, receipt_json TEXT NOT NULL,
 PRIMARY KEY(tenant,owner,request_id)
);
CREATE INDEX IF NOT EXISTS solana_runtime_paper_window ON solana_runtime_paper_trades(tenant,owner,created_at_ms);
CREATE TABLE IF NOT EXISTS solana_runtime_sessions (
 tenant TEXT NOT NULL, owner TEXT NOT NULL, record_json TEXT NOT NULL, sealed_seed TEXT NOT NULL,
 PRIMARY KEY(tenant,owner)
);
CREATE TABLE IF NOT EXISTS solana_runtime_setups (
 tenant TEXT NOT NULL, owner TEXT NOT NULL, setup_json TEXT NOT NULL, PRIMARY KEY(tenant,owner)
);
CREATE TABLE IF NOT EXISTS solana_runtime_owner_revokes (
 tenant TEXT NOT NULL, owner TEXT NOT NULL, setup_json TEXT NOT NULL, PRIMARY KEY(tenant,owner)
);
CREATE TABLE IF NOT EXISTS solana_runtime_live_books (
 tenant TEXT NOT NULL, owner TEXT NOT NULL, book_json TEXT NOT NULL, PRIMARY KEY(tenant,owner)
);
CREATE TABLE IF NOT EXISTS solana_runtime_cashflows (
 evidence_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, owner TEXT NOT NULL, kind TEXT NOT NULL,
 mint TEXT NOT NULL, amount_raw TEXT NOT NULL, created_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS solana_runtime_submissions (
 tenant TEXT NOT NULL, owner TEXT NOT NULL, request_id TEXT NOT NULL, vault TEXT NOT NULL,
 sequence TEXT NOT NULL, signature TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('pending','finalized','failed','expired')),
 created_at_ms BIGINT NOT NULL, notional_raw TEXT NOT NULL, submission_json TEXT NOT NULL, settlement_json TEXT,
 PRIMARY KEY(tenant,owner,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS solana_runtime_live_sequence ON solana_runtime_submissions(vault,sequence) WHERE status IN ('pending','finalized');
CREATE UNIQUE INDEX IF NOT EXISTS solana_runtime_live_pending ON solana_runtime_submissions(vault) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS solana_runtime_live_window ON solana_runtime_submissions(tenant,owner,created_at_ms);
CREATE TABLE IF NOT EXISTS solana_runtime_autonomous_attempts (
 tenant TEXT NOT NULL, owner TEXT NOT NULL, request_id TEXT NOT NULL, attempted_at_ms BIGINT NOT NULL,
 PRIMARY KEY(tenant,owner,request_id)
);
CREATE INDEX IF NOT EXISTS solana_runtime_autonomous_window ON solana_runtime_autonomous_attempts(tenant,owner,attempted_at_ms);
CREATE TABLE IF NOT EXISTS solana_operator_holds (
 scope TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at_ms BIGINT NOT NULL
);
`;
/** An operator hold stops every new Solana trade for a tenant, or for everyone ('*'). Owner actions stay open. */
export const SOLANA_OPERATOR_HOLD_ALL = "*";
export async function solanaOperatorHeld(db: Db, tenant: string): Promise<boolean> {
  return !!await db.prepare("SELECT 1 FROM solana_operator_holds WHERE scope IN (?,?)").get(tenant, SOLANA_OPERATOR_HOLD_ALL);
}
function refuse(message: string): never { throw new SolanaTradingStoreError(message); }
/** Request IDs the autonomous strategy owns: rebalance-<settings revision>-<attempt>. Manual trades may not use them. */
export const SOLANA_AUTONOMOUS_REQUEST_PREFIX = "rebalance-";
export interface SolanaAutonomousSchedule {
  /** Autonomous attempts admitted so far, proven-expired ones included: the next attempt's index, never reused. */
  attempt: number;
  /** When the next attempt may be admitted: one interval after the last that was not proven expired (0 if none). */
  dueAtMs: number;
}
/**
 * The autonomous strategy's durable schedule for one account. intervalSeconds is
 * a minimum spacing between admitted attempts, whatever process admitted them. A
 * proven-expired attempt never landed, so a fresh one may follow it at once.
 */
export async function solanaAutonomousSchedule(db: Db, scope: SolanaAccountScope, intervalSeconds: number): Promise<SolanaAutonomousSchedule> {
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) refuse("Invalid autonomous Solana strategy interval.");
  const row = await db.prepare(`SELECT COUNT(*) AS attempts,
      MAX(CASE WHEN s.status IS NULL OR s.status <> 'expired' THEN a.attempted_at_ms END) AS last_at
    FROM solana_runtime_autonomous_attempts a
    LEFT JOIN solana_runtime_submissions s ON s.tenant=a.tenant AND s.owner=a.owner AND s.request_id=a.request_id
    WHERE a.tenant=? AND a.owner=?`).get(scope.tenant, scope.owner) as { attempts: number | string; last_at: number | string | null } | undefined;
  const attempt = Number(row?.attempts ?? 0), last = row?.last_at === null || row?.last_at === undefined ? null : Number(row.last_at);
  if (!Number.isSafeInteger(attempt) || attempt < 0 || (last !== null && !Number.isSafeInteger(last))) refuse("Invalid stored Solana data.");
  return { attempt, dueAtMs: last === null ? 0 : last + intervalSeconds * 1000 };
}
export const OPERATOR_HOLD = "An operator hold stops Solana trading for this account. Owner withdrawals and revocation still work.";
/**
 * EXPIRED-ATTEMPT ALLOWANCE (owner decision, audit G2-3).
 *
 * A live trade whose blockhash expired before it landed is proven never to have
 * run (both providers agree, see reconcileSolanaSubmission): it moved no tokens,
 * paid no fee, and the vault program never counted it. Off-chain it still was a
 * transaction the session key signed. This setting says how many such proven-
 * expired attempts per rolling 24 hours do NOT count toward the owner's
 * maxOpsPerDay; every one beyond it counts like any signed transaction.
 *
 * - 0 (the default): every signed transaction counts, so the session key signs
 *   at most maxOpsPerDay a day, exactly the number the owner set. A burst of
 *   dropped packets can use up the day's operations and pause trading and
 *   automated exits until they leave the window; the owner's own withdrawals
 *   and revoke never count and stay available.
 * - N > 0: up to N dropped attempts a day are retried without using up the
 *   owner's operations, so at most maxOpsPerDay + N signed a day, and at most
 *   maxOpsPerDay of them can land. N is one setting for every account.
 *
 * The old rule gave each account a separate budget of expired attempts the
 * size of its own maxOpsPerDay: about 2 x maxOpsPerDay signed a day. No single
 * N reproduces that for every account. N equal to one account's maxOpsPerDay
 * approximates it for that account only, and is looser for accounts with
 * fewer operations. N = 96 (the program's daily maximum) is the MOST
 * permissive setting, not the old behaviour: with maxOpsPerDay 10 it lets
 * over 100 transactions be signed a day, against about 20 under the old rule.
 *
 * Set with MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: a whole number from 0 to 96.
 */
export const SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE = 0;
/** Names no setting, like the other configuration refusals an owner may see. */
export const SOLANA_EXPIRED_ATTEMPT_ALLOWANCE_MISCONFIGURED = "The Solana expired-attempt allowance setting is misconfigured: it must be a whole number from 0 to 96. Live trading and exits stay refused until an operator fixes it.";
/** The configured allowance, or the default when it is unset. Anything else is refused (fail closed). */
export function solanaExpiredAttemptAllowance(env: Readonly<Record<string, string | undefined>>): number {
  const value = env.MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE;
  if (value === undefined) return SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE;
  if (!/^(0|[1-9][0-9]?)$/.test(value) || Number(value) > SOLANA_MAX_OPS_PER_DAY) refuse(SOLANA_EXPIRED_ATTEMPT_ALLOWANCE_MISCONFIGURED);
  return Number(value);
}
/** An owner withdrawal larger than the recorded vault balance is never saved: it could not be booked once it landed. */
export const SOLANA_WITHDRAWAL_ABOVE_BOOK = "The withdrawal exceeds the recorded vault balance, which changed since it was prepared. Prepare it again.";
/** recordSigned's refusal when proven-expired attempts beyond the allowance have used up the owner's daily operations. */
export const SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED = "Too many Solana transactions expired without landing in the last 24 hours: they count toward the daily operation limit. Trading resumes as they leave the window.";
/**
 * THE ROLLING 24-HOUR USDG AND SOL LIMITS, AS ADMISSION COUNTS THEM (recordSigned, the exit reserve and status share these).
 * Submissions created inside the window count until canonical failure or expiry evidence releases them, buys and sales alike:
 * the vault program charges a sale's USDG proceeds to the same per-trade and daily USDG limits as a buy's spend, and its SOL to
 * the SOL sold limits. So buys must leave room for the position's exit (EXITS KEEP ROOM IN THE ROLLING LIMITS, below).
 */
function countedInWindow<T extends { status: string }>(rows: T[]): T[] { return rows.filter(r => !["failed", "expired"].includes(r.status)); }
/** The USDG notional of submissions that count, buys and sales alike. */
function windowNotional(counted: ReadonlyArray<{ notional_raw: string }>): bigint { return counted.reduce((n, r) => n + BigInt(r.notional_raw), 0n); }
/** The SOL their sales sold. */
function windowSold(counted: ReadonlyArray<{ submission_json: string }>): bigint {
  return counted.reduce((n, r) => {
    const prior = (JSON.parse(r.submission_json) as SolanaSignedSubmission).intent;
    return prior.inputMint === SOLANA_WRAPPED_SOL_MINT ? n + raw(prior.amountRaw, false) : n;
  }, 0n);
}
/**
 * What one account's live trades used of its rolling 24-hour USDG and SOL sold limits at `nowMs`, by the same window and
 * arithmetic recordSigned admits by. For status blockers and warnings; admission never reads it, and counts the same rows
 * itself under its lock.
 */
export async function solanaRollingLimitUse(db: Db, scope: SolanaAccountScope, nowMs: number): Promise<{ notionalRaw: bigint; soldWsolRaw: bigint }> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) refuse("Invalid Solana rolling limit query.");
  const rows = await db.prepare("SELECT notional_raw,status,submission_json FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND created_at_ms>?")
    .all(scope.tenant, scope.owner, nowMs - DAY) as Array<{ notional_raw: string; status: string; submission_json: string }>;
  const counted = countedInWindow(rows);
  return { notionalRaw: windowNotional(counted), soldWsolRaw: windowSold(counted) };
}
/**
 * Whether a live buy that still counts (failure or expiry evidence has not released it) was made inside the rolling window at
 * `nowMs`, by the window and rule recordSigned counts by: whether a fill may have grown the position since the window began, which
 * status then prices (THE POSITION ABOVE ITS EXIT ROOM, in the app runtime).
 */
export async function solanaBoughtInWindow(db: Db, scope: SolanaAccountScope, nowMs: number): Promise<boolean> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) refuse("Invalid Solana rolling limit query.");
  const rows = await db.prepare("SELECT status,submission_json FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND created_at_ms>?")
    .all(scope.tenant, scope.owner, nowMs - DAY) as Array<{ status: string; submission_json: string }>;
  return countedInWindow(rows).some(r => (JSON.parse(r.submission_json) as SolanaSignedSubmission).intent.inputMint === SOLANA_USDG_MINT);
}
/**
 * EXITS KEEP ROOM IN THE ROLLING LIMITS: BUYS ARE REFUSED FIRST. Sales count
 * against the same limits as buys (above), and the platform's live caps bound
 * those limits, so a day of buys could otherwise leave no room to sell. A live
 * buy is therefore admitted only while, after it, the account's whole recorded
 * SOL position could still be sold inside the same 24-hour window at the
 * independent SOL price: what the window already used, the buy, and the
 * position's value plus the reference tolerance (a sale is charged at the
 * higher of its quote and its reference value) fit the USDG per 24 hours limit,
 * and the position fits what sales left of the SOL sold per 24 hours limit.
 * What the buy brings is counted at the larger of its quoted and its
 * reference-implied output plus THE FILL MARGIN (below), since neither bounds
 * what an ExactIn swap delivers.
 * Checked before anything is signed (the app runtime's assessRisk, at the
 * highest price any provider serves) and again at admission (recordSigned, at
 * the buy's own reference). It only ever refuses buys: a sale never reads it,
 * and no limit is widened. So a day's buys stop at about half the USDG limit,
 * and a position never grows beyond what one day's limits can sell at the
 * price it was bought at (a fill beyond the margin, or a later rise in the SOL
 * price, can still outgrow it: status then holds buys and says so, and partial
 * sales and Withdraw remain).
 */
export const SOLANA_LIVE_EXIT_RESERVE = "This buy was refused: it would leave too little of your 24-hour live limits to sell your whole SOL position back to USDG, "
  + "and sales count against the same limits as buys. A smaller buy may fit; exits, revoke and withdraw still work.";
/**
 * THE FILL MARGIN. A live buy is an ExactIn swap: the vault program enforces only the signed minimum output, the quote's
 * outAmount and the reference-implied amount are estimates, and settlement books whatever the swap delivered at or above the
 * minimum. So EXITS KEEP ROOM... counts what a buy brings at the larger of the two plus this margin, rounded up: a fill up to
 * this far above both still leaves the whole position sellable inside the window. 300 bps, the default reference tolerance
 * (SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS), whatever tolerance is configured. A fill beyond it is booked as it landed (the book
 * never caps what the vault holds); the position may then be more than one day's limits can sell, and status holds further buys,
 * which this check refuses anyway, and says the excess is sold as earlier trades leave the window, or over more than one window
 * (the app runtime's SOLANA_STATUS_POSITION_ABOVE_EXIT_ROOM). The same margin is used before anything is signed (assessRisk), at admission
 * (recordSigned) and by the strategy's buy sizing (solanaExitReserveBuyRoom).
 */
export const SOLANA_EXIT_RESERVE_FILL_MARGIN_BPS = 300;
/** The most SOL a buy is counted as bringing (THE FILL MARGIN): the larger of its quoted and reference-implied output, plus the margin, rounded up. */
export function solanaBuyFillBound(quotedOutRaw: bigint, referenceOutRaw: bigint): bigint {
  if (quotedOutRaw < 0n || referenceOutRaw < 0n) refuse("Invalid Solana exit reserve.");
  const brought = quotedOutRaw > referenceOutRaw ? quotedOutRaw : referenceOutRaw;
  return (brought * BigInt(10_000 + SOLANA_EXIT_RESERVE_FILL_MARGIN_BPS) + 9_999n) / 10_000n;
}
/** The USDG a whole-position exit worth `valueUsdgRaw` at the reference must find left of the daily limit: its value plus the tolerance, rounded up. */
export function solanaExitReserveUsdg(valueUsdgRaw: bigint, toleranceBps: number): bigint {
  if (valueUsdgRaw < 0n || !Number.isSafeInteger(toleranceBps) || toleranceBps < 0 || toleranceBps > 10_000) refuse("Invalid Solana exit reserve.");
  return (valueUsdgRaw * BigInt(10_000 + toleranceBps) + 9_999n) / 10_000n;
}
/**
 * Whether a buy leaves the whole position after it sellable inside the window (EXITS KEEP ROOM...): `usedUsdgRaw` and
 * `soldWsolRaw` are the window's use (solanaRollingLimitUse, or admission's own count), `positionAfterWsolRaw` the recorded
 * position plus what the buy may bring (solanaBuyFillBound), and `positionAfterValueUsdgRaw` its value at the reference. With no
 * buy (`buyUsdgRaw` 0, the position as booked), whether the position itself can still be sold inside the window.
 */
export function solanaBuyKeepsExitRoom(input: { usedUsdgRaw: bigint; soldWsolRaw: bigint; buyUsdgRaw: bigint; positionAfterWsolRaw: bigint;
  positionAfterValueUsdgRaw: bigint; dailyUsdgRaw: bigint; dailyWsolRaw: bigint; toleranceBps: number }): boolean {
  return input.usedUsdgRaw + input.buyUsdgRaw + solanaExitReserveUsdg(input.positionAfterValueUsdgRaw, input.toleranceBps) <= input.dailyUsdgRaw
    && input.soldWsolRaw + input.positionAfterWsolRaw <= input.dailyWsolRaw;
}
/**
 * The daily limits EXITS KEEP ROOM... keeps room within: for each, the lower of the saved limits and those of the permission
 * registered on the vault, when known (`registered`: the session record's kept limits, or what a provider shows the vault
 * holding). The vault charges a sale to its own limits, whatever was saved since: saved limits above them (the caps raised and
 * the limits saved again, under the same permission) must not let a buy use room the vault will not give the exit.
 */
export function solanaExitReserveLimits(saved: { dailyUsdg: bigint; dailyWsol: bigint },
  registered: { dailyUsdg: string | bigint; dailyWsol: string | bigint } | undefined): { dailyUsdg: bigint; dailyWsol: bigint } {
  if (!registered) return saved;
  const lower = (a: bigint, b: string | bigint) => BigInt(b) < a ? BigInt(b) : a;
  return { dailyUsdg: lower(saved.dailyUsdg, registered.dailyUsdg), dailyWsol: lower(saved.dailyWsol, registered.dailyWsol) };
}
/**
 * For planning only (the autonomous strategy sizes its buys by it, so it does not build a route admission would refuse): the
 * largest buy, in USDG, that keeps the USDG room EXITS KEEP ROOM... asks for, with the position held worth `positionValueUsdgRaw`
 * and what the buy brings valued at up to the tolerance above what it costs, plus THE FILL MARGIN, as the check counts it. Zero
 * when none does. The SOL sold room is left to the check itself, which refuses such a buy before anything is signed.
 */
export function solanaExitReserveBuyRoom(input: { usedUsdgRaw: bigint; dailyUsdgRaw: bigint; positionValueUsdgRaw: bigint; toleranceBps: number }): bigint {
  // Four base units below what is left, for the reserve's rounding up (of the position and the buy together, and of the margin).
  const left = input.dailyUsdgRaw - input.usedUsdgRaw - solanaExitReserveUsdg(input.positionValueUsdgRaw, input.toleranceBps) - 4n;
  if (left <= 0n) return 0n;
  // b + b × (1 + t)² × (1 + m) ≤ left, with t the tolerance and m the fill margin: what the buy brings is valued at up to the
  // tolerance above its cost, counted with the margin, and reserved at that value plus the tolerance.
  const scale = 10_000n, grown = BigInt(10_000 + input.toleranceBps), margin = BigInt(10_000 + SOLANA_EXIT_RESERVE_FILL_MARGIN_BPS);
  return left * scale * scale * scale / (scale * scale * scale + grown * grown * margin);
}
/**
 * How proven-expired attempts use one account's daily operations at `nowMs`, by
 * the same rolling 24-hour window and arithmetic recordSigned admits by:
 * `counted` of the `expired` attempts count toward maxOpsPerDay (those beyond
 * the allowance), next to `operations` that landed, failed or are pending.
 * For status blockers and operator alerts; admission never reads it, and counts
 * the same rows itself under its lock.
 */
export async function solanaExpiredAttemptUse(db: Db, scope: SolanaAccountScope, nowMs: number, allowance: number): Promise<{ expired: number; counted: number; operations: number }> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(allowance) || allowance < 0) refuse("Invalid Solana expired-attempt query.");
  const rows = await db.prepare("SELECT status FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND created_at_ms>?").all(scope.tenant, scope.owner, nowMs - DAY) as Array<{ status: string }>;
  const expired = rows.filter(r => r.status === "expired").length;
  return { expired, counted: Math.max(0, expired - allowance), operations: rows.length - expired };
}
/** The debit window a sequence-consumed proof must name for this submission; null when its signed bytes cannot be read. */
function solanaDebitWindowStartOf(submission: SolanaSignedSubmission): string | null {
  try { return solanaDebitWindowStart(submission).toString(); } catch { return null; }
}
/**
 * What writing off a vault shortfall does to `book`, given finalized balances
 * two providers agree on (SolanaTradingStore.writeOffShortfall, the only caller
 * that persists it; the operator tool shows it first). A shortfall is a LOSS,
 * never capital out: cash falls to the USDG the vault holds and realized P&L by
 * the same amount; WSOL leaves quarantine first (zero basis, no P&L), then the
 * position at its prorated cost basis, which leaves realized P&L too. The
 * high-water mark stays where it was, so the drawdown breaker sees the loss,
 * and buying is paused when cash or the position fell. An asset above its book
 * in the same reading is booked as status books an inflow: USDG as a deposit
 * raising the high-water mark, WSOL as zero-basis quarantine. Throws when
 * nothing is short.
 */
export function solanaShortfallWriteOff(bookInput: SolanaLiveBook, chain: { cashUsdg: string; wsolRaw: string }) {
  const book = structuredClone(bookInput), cash = raw(chain.cashUsdg), wsol = raw(chain.wsolRaw);
  const bookCash = raw(book.cashRaw), held = raw(book.wsolRaw), aside = solanaQuarantinedWsol(book);
  if (cash >= bookCash && wsol >= held + aside) refuse("Nothing is short: the vault holds at least its recorded balances.");
  const lost = { usdgRaw: 0n, quarantinedWsolRaw: 0n, wsolRaw: 0n, costBasisUsdgRaw: 0n }, inflow = { usdgRaw: 0n, quarantinedWsolRaw: 0n };
  if (cash < bookCash) {
    lost.usdgRaw = bookCash - cash;
    book.cashRaw = cash.toString(); book.realizedPnlUsdgRaw = (BigInt(book.realizedPnlUsdgRaw) - lost.usdgRaw).toString();
  } else if (cash > bookCash) {
    inflow.usdgRaw = cash - bookCash;
    book.cashRaw = cash.toString(); book.hwmRaw = (raw(book.hwmRaw) + inflow.usdgRaw).toString(); raw(book.hwmRaw);
  }
  if (wsol < held + aside) {
    const gone = held + aside - wsol;
    lost.quarantinedWsolRaw = gone < aside ? gone : aside; lost.wsolRaw = gone - lost.quarantinedWsolRaw;
    if (aside > 0n) book.quarantinedWsolRaw = (aside - lost.quarantinedWsolRaw).toString();
    if (lost.wsolRaw > 0n) {
      lost.costBasisUsdgRaw = lost.wsolRaw === held ? BigInt(book.costBasisUsdgRaw) : BigInt(book.costBasisUsdgRaw) * lost.wsolRaw / held;
      book.wsolRaw = (held - lost.wsolRaw).toString(); book.costBasisUsdgRaw = (BigInt(book.costBasisUsdgRaw) - lost.costBasisUsdgRaw).toString();
      book.realizedPnlUsdgRaw = (BigInt(book.realizedPnlUsdgRaw) - lost.costBasisUsdgRaw).toString();
    }
  } else if (wsol > held + aside) {
    inflow.quarantinedWsolRaw = wsol - held - aside;
    book.quarantinedWsolRaw = (aside + inflow.quarantinedWsolRaw).toString(); raw(book.quarantinedWsolRaw);
  }
  // Tokens the book traded on are gone and nobody has said why: buying waits for the owner's review (resume-buys).
  if (lost.usdgRaw > 0n || lost.wsolRaw > 0n) book.buyPaused = true;
  return { book, lost, inflow };
}
function clock(now: () => number): number { const n = now(); if (!Number.isSafeInteger(n) || n < 0) refuse("Invalid Solana runtime clock."); return n; }
function key(value: string): void { if (canonicalId(CHAINS.solana, "account", value) !== value) refuse("Invalid Solana account key."); }
function raw(value: string, zero = true): bigint { return parseSolanaRawAmount(value, zero); }
function rowJson<T>(row: unknown, column: string): T | null {
  if (!row) return null;
  const data = (row as Record<string, unknown>)[column];
  if (typeof data !== "string") refuse("Invalid stored Solana data.");
  return JSON.parse(data) as T;
}
function record(row: unknown): SolanaLiveRecord | null {
  if (!row) return null;
  const r = row as { submission_json: string; status: SolanaLiveRecord["status"]; settlement_json: string | null };
  return { submission: JSON.parse(r.submission_json), status: r.status, ...(r.settlement_json ? { settlement: JSON.parse(r.settlement_json) } : {}) };
}
const ready = new WeakMap<Db, Promise<void>>();
export async function ensureSolanaTradingSchema(db: Db, postgres = false): Promise<void> {
  let promise = ready.get(db);
  if (!promise) {
    promise = (postgres ? db.tx(async tx => { await tx.prepare("SELECT pg_advisory_xact_lock(?)").get(1_297_691_984); await tx.exec(SCHEMA); }) : db.exec(SCHEMA))
      .catch(error => { ready.delete(db); throw error; });
    ready.set(db, promise);
  }
  return promise;
}

/** A submitted owner transaction awaiting its outcome, in either slot (solanaPendingOwnerTransactions). */
export interface SolanaPendingOwnerTransaction extends SolanaAccountScope {
  /** `signature`: null only on a malformed record, still listed so recovery reads it as it always did. */
  slot: "main" | "revoke"; signature: string | null; kind: NonNullable<SolanaPreparedSetup["kind"]>;
  /** When it was prepared; null when the stored record does not say. */
  preparedAtMs: number | null;
  /** The vault sequence it was prepared at, when recorded. */
  priorSequence: string | null;
}
/**
 * Every submitted owner transaction awaiting its outcome, in both slots: the main record, and a revocation saved
 * beside it (REVOKE BESIDE A PENDING OWNER TRANSACTION), which often outlives the record it was prepared beside.
 * Main slot first. Read from the database alone, nothing secret (no signed bytes). Receipt recovery reads it
 * through solanaPendingOwnerScopes; the operator's stuck-pending alert and list must count the revoke slot too.
 */
export async function solanaPendingOwnerTransactions(db: Db): Promise<SolanaPendingOwnerTransaction[]> {
  const pending: SolanaPendingOwnerTransaction[] = [];
  for (const [slot, table] of [["main", "solana_runtime_setups"], ["revoke", "solana_runtime_owner_revokes"]] as const) {
    for (const row of await db.prepare(`SELECT tenant,owner,setup_json FROM ${table}`).all() as Array<SolanaAccountScope & { setup_json: string }>) {
      let setup: SolanaPreparedSetup | null = null;
      try { setup = JSON.parse(row.setup_json) as SolanaPreparedSetup; } catch { continue; }
      // Saved signed bytes are "pending" until finished (exactly what the worker recovered before the revoke slot).
      if (setup?.status !== "pending") continue;
      pending.push({ tenant: row.tenant, owner: row.owner, slot, signature: typeof setup.signature === "string" ? setup.signature : null, kind: setup.kind ?? "session",
        preparedAtMs: Number.isSafeInteger(setup.preparedAtMs) ? setup.preparedAtMs : null, priorSequence: typeof setup.priorSequence === "string" ? setup.priorSequence : null });
    }
  }
  return pending;
}
/**
 * Every account with a submitted owner transaction awaiting its outcome, in either slot (solanaPendingOwnerTransactions).
 * Receipt recovery (the worker's tick) reads status for each, which rebroadcasts the saved bytes while they can land
 * and settles both slots, with the page closed. Each account once, main slot first.
 */
export async function solanaPendingOwnerScopes(db: Db): Promise<SolanaAccountScope[]> {
  const scopes = new Map<string, SolanaAccountScope>();
  for (const item of await solanaPendingOwnerTransactions(db)) scopes.set(JSON.stringify([item.tenant, item.owner]), { tenant: item.tenant, owner: item.owner });
  return [...scopes.values()];
}
/** The scope comes from an authenticated wallet binding, never request owner fields. */
export class SolanaTradingStore implements SolanaLiveJournal {
  constructor(readonly db: Db, readonly scope: SolanaAccountScope, private readonly now: () => number = Date.now,
    private readonly admission?: { autonomousRevision: number; signal?: AbortSignal },
    /** The Pyth generation stored reference bounds must come from: the app runtime's MERRYMEN_SOLANA_PYTH_GENERATION, read at each check. Default: SOLANA_PYTH_DEFAULT_GENERATION. */
    private readonly pythGeneration?: () => SolanaPythGeneration) {
    if (!/^0x[0-9a-f]{40}$/.test(scope.tenant)) refuse("Invalid authenticated Solana tenant.");
    solanaPaperAgentId(scope.owner);
  }
  private checkAdmissionSignal(): void {
    if (this.admission?.signal?.aborted) refuse("Solana trading admission stopped during shutdown.");
  }
  private async autonomousIn(db: Db, binding: SolanaTradingBinding): Promise<bigint | null> {
    this.checkAdmissionSignal();
    if (!this.admission) return null;
    if (!Number.isSafeInteger(this.admission.autonomousRevision) || this.admission.autonomousRevision < 0 ||
        binding.revision !== this.admission.autonomousRevision) refuse("The autonomous Solana strategy changed before admission.");
    const row = await db.prepare("SELECT strategy_json FROM solana_wallet_bindings WHERE tenant=? AND owner=? AND chain=?")
      .get(this.scope.tenant, this.scope.owner, CHAINS.solana) as { strategy_json: string | null } | undefined;
    const strategy = row?.strategy_json ? JSON.parse(row.strategy_json) : null;
    if (strategy?.enabled !== true) refuse("The autonomous Solana strategy is no longer enabled.");
    // The interval is a durable minimum spacing, checked under the same lock that admits.
    const { dueAtMs } = await solanaAutonomousSchedule(db, this.scope, strategy.intervalSeconds);
    if (clock(this.now) < dueAtMs) refuse("The autonomous Solana strategy is not due yet: its interval has not passed since the last attempt.");
    return raw(strategy.tradeUsdgRaw, false);
  }
  /** Manual trades never take the strategy's request IDs, so its next attempt can never collide with one. */
  private checkRequestOwner(requestId: string): void {
    if (!this.admission && requestId.startsWith(SOLANA_AUTONOMOUS_REQUEST_PREFIX)) refuse("Request IDs starting with rebalance- belong to the autonomous strategy.");
  }
  /** An admitted autonomous trade records its attempt in the same transaction. */
  private async recordAttemptIn(db: Db, requestId: string, now: number): Promise<void> {
    if (this.admission) await db.prepare("INSERT INTO solana_runtime_autonomous_attempts(tenant,owner,request_id,attempted_at_ms) VALUES(?,?,?,?)")
      .run(this.scope.tenant, this.scope.owner, requestId, now);
  }
  private owner(owner: string): void { if (owner !== this.scope.owner) refuse("Solana owner does not match the authenticated account."); }
  private async bindingIn(db: Db, lock: boolean): Promise<SolanaTradingBinding> {
    const { tenant, owner } = this.scope;
    // A first statement write acquires both SQLite's writer lock and Postgres's
    // row lock. Settings changes take this same row lock, fencing admission.
    if (lock) {
      const locked = await db.prepare("UPDATE solana_wallet_bindings SET revision=revision WHERE tenant=? AND owner=? AND chain=?")
        .run(tenant, owner, CHAINS.solana);
      if (locked.changes !== 1) refuse("The authenticated Solana wallet binding is missing.");
    }
    const row = await db.prepare("SELECT requested_mode,limits_json,revision FROM solana_wallet_bindings WHERE tenant=? AND owner=? AND chain=?")
      .get(tenant, owner, CHAINS.solana) as { requested_mode: "paper" | "live"; limits_json: string | null; revision: number | string } | undefined;
    if (!row || !["paper", "live"].includes(row.requested_mode)) refuse("The authenticated Solana wallet binding is missing.");
    return { tenant, owner, requestedMode: row.requested_mode, limits: row.limits_json ? JSON.parse(row.limits_json) : null, revision: Number(row.revision) };
  }
  binding(): Promise<SolanaTradingBinding> { return this.bindingIn(this.db, false); }
  async createPaper(initialCashRaw: string, limits: SolanaPaperLimits): Promise<SolanaPaperSnapshot> {
    raw(initialCashRaw, false);
    return this.db.tx(async tx => {
      const binding = await this.bindingIn(tx, true);
      if (binding.requestedMode !== "paper") refuse("Paper trading is not the selected Solana mode.");
      const now = clock(this.now), policy = validateSolanaAccountLimits(limits, now);
      if (!binding.limits || JSON.stringify(validateSolanaAccountLimits(binding.limits, now)) !== JSON.stringify(policy)) {
        refuse("The Solana trading limits changed before paper book creation. Refresh and try again.");
      }
      const { tenant, owner } = this.scope;
      const existing = await tx.prepare("SELECT book_json FROM solana_runtime_paper_books WHERE tenant=? AND owner=?").get(tenant, owner);
      if (existing) refuse("This Solana paper book already exists and cannot be refilled or reset.");
      const book: SolanaPaperBook = { owner, agentId: solanaPaperAgentId(owner), chain: CHAINS.solana, mode: "paper", version: 0,
        initialCashRaw, cashRaw: initialCashRaw, hwmRaw: initialCashRaw, realizedPnlRaw: "0", limits: policy,
        positions: [], createdAtMs: now, updatedAtMs: now };
      await tx.prepare("INSERT INTO solana_runtime_paper_books(tenant,owner,book_json) VALUES(?,?,?)").run(tenant, owner, JSON.stringify(book));
      return { ...book, trades: [] };
    });
  }
  /** The tenant's paper book with its latest trades, read in one statement on `db` (a transaction's, to read its own write). */
  private async paperSnapshotIn(db: Db, binding: SolanaTradingBinding): Promise<SolanaPaperSnapshot | null> {
    const rows = await db.prepare(`SELECT b.book_json,t.receipt_json FROM solana_runtime_paper_books b
      LEFT JOIN solana_runtime_paper_trades t ON t.tenant=b.tenant AND t.owner=b.owner
      WHERE b.tenant=? AND b.owner=? ORDER BY t.created_at_ms DESC,t.request_id DESC LIMIT 100`).all(this.scope.tenant, this.scope.owner) as Array<{ book_json: string; receipt_json: string | null }>;
    if (!rows.length) return null;
    return { ...JSON.parse(rows[0]!.book_json), ...(binding.limits ? { limits: binding.limits } : {}), trades: rows.filter(r => r.receipt_json !== null).map(r => JSON.parse(r.receipt_json!)) } as SolanaPaperSnapshot;
  }
  paper(): SolanaPaperLedger {
    const { tenant, owner } = this.scope;
    return {
      get: async requested => {
        this.owner(requested);
        return this.paperSnapshotIn(this.db, await this.binding());
      },
      findTrade: async (requested, id) => {
        this.owner(requested); await this.binding();
        return rowJson<SolanaPaperReceipt>(await this.db.prepare("SELECT receipt_json FROM solana_runtime_paper_trades WHERE tenant=? AND owner=? AND request_id=?").get(tenant, owner, id), "receipt_json");
      },
      commit: async input => {
        this.owner(input.owner);
        const fingerprint = solanaPaperIntentFingerprint(input.intent);
        return this.db.tx(async tx => {
          const binding = await this.bindingIn(tx, true);
          const prior = await tx.prepare("SELECT fingerprint,receipt_json FROM solana_runtime_paper_trades WHERE tenant=? AND owner=? AND request_id=?").get(tenant, owner, input.intent.requestId) as { fingerprint: string; receipt_json: string } | undefined;
          if (prior) { if (prior.fingerprint !== fingerprint) refuse("The Solana request ID belongs to another intent."); return JSON.parse(prior.receipt_json) as SolanaPaperReceipt; }
          if (await solanaOperatorHeld(tx, tenant)) refuse(OPERATOR_HOLD);
          this.checkRequestOwner(input.intent.requestId);
          const strategyCap = await this.autonomousIn(tx, binding);
          if (binding.requestedMode !== "paper") refuse("Paper trading is not the selected Solana mode.");
          const now = clock(this.now);
          const book = rowJson<SolanaPaperBook>(await tx.prepare("SELECT book_json FROM solana_runtime_paper_books WHERE tenant=? AND owner=?").get(tenant, owner), "book_json");
          if (!book) refuse("Create a Solana paper book first.");
          if (!binding.limits) refuse("Save the current Solana trading limits first.");
          book.limits = validateSolanaAccountLimits(binding.limits, now);
          const recent = await tx.prepare("SELECT notional_raw FROM solana_runtime_paper_trades WHERE tenant=? AND owner=? AND created_at_ms>?").all(tenant, owner, now - DAY) as Array<{ notional_raw: string }>;
          const result = applySolanaPaperCommit(book, input, recent.map(r => r.notional_raw), now);
          if (strategyCap !== null && raw(result.receipt.notionalUsdgRaw, false) > strategyCap) refuse("The autonomous Solana strategy trade limit would be exceeded.");
          this.checkAdmissionSignal();
          await tx.prepare("INSERT INTO solana_runtime_paper_trades(tenant,owner,request_id,fingerprint,created_at_ms,notional_raw,receipt_json) VALUES(?,?,?,?,?,?,?)")
            .run(tenant, owner, input.intent.requestId, fingerprint, now, result.receipt.notionalUsdgRaw, JSON.stringify(result.receipt));
          await this.recordAttemptIn(tx, input.intent.requestId, now);
          await tx.prepare("UPDATE solana_runtime_paper_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify(result.book), tenant, owner);
          return result.receipt;
        });
      },
      /**
       * The owner's write-off of one dust lot in the tenant's book, under the
       * same transaction and binding row lock as commit, with a post-lock clock.
       * applySolanaPaperWriteOff checks the owner, the expected version, the
       * whole lot and the market's zero-output evidence (fresh at this clock);
       * the update is compare-and-set on the book row read under the lock. A
       * retry after it committed finds a new version (or no lot) and is
       * refused, so a write-off never applies twice. Owner-only: a store
       * admitting for the autonomous strategy refuses before it locks. An
       * operator hold does not stop it: it is no trade, and moves no cash.
       */
      writeOff: async input => {
        this.owner(input.owner);
        if (this.admission) refuse("The autonomous Solana strategy cannot write off paper positions.");
        return this.db.tx(async tx => {
          const binding = await this.bindingIn(tx, true);
          if (binding.requestedMode !== "paper") refuse("Paper trading is not the selected Solana mode.");
          const now = clock(this.now);
          const row = await tx.prepare("SELECT book_json FROM solana_runtime_paper_books WHERE tenant=? AND owner=?").get(tenant, owner) as { book_json: string } | undefined;
          const book = rowJson<SolanaPaperBook>(row, "book_json");
          if (!row || !book) refuse("Create a Solana paper book first.");
          const result: { book: SolanaPaperBook; record: SolanaPaperWriteOffRecord } = applySolanaPaperWriteOff(book, input, now);
          const updated = await tx.prepare("UPDATE solana_runtime_paper_books SET book_json=? WHERE tenant=? AND owner=? AND book_json=?")
            .run(JSON.stringify(result.book), tenant, owner, row.book_json);
          if (updated.changes !== 1) refuse("The Solana paper book changed during the write-off. Refresh and try again.");
          const snapshot = await this.paperSnapshotIn(tx, binding);
          if (!snapshot) refuse("Create a Solana paper book first.");
          return { ...snapshot, writtenOff: result.record };
        });
      },
    };
  }
  async operatorHeld(): Promise<boolean> { return solanaOperatorHeld(this.db, this.scope.tenant); }
  async liveBook(): Promise<SolanaLiveBook | null> {
    await this.binding();
    return rowJson(await this.db.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?").get(this.scope.tenant, this.scope.owner), "book_json");
  }
  /**
   * A VAULT SHORTFALL NO OWNER WITHDRAWAL EXPLAINS, WRITTEN OFF BY AN OPERATOR
   * (npm run solana:resolve -- shortfall, solana-resolve-shortfall.ts).
   *
   * A vault below its book holds every trade and automated exit (status's
   * SOLANA_STATUS_BELOW_BOOK; admission refuses a shortfall too). A withdrawal
   * the owner made outside Merrymen is recorded by the owner from its own
   * transaction, as capital out. Anything else (an issuer's action on a token
   * account, a booking error) stays held until an operator who found what moved
   * the tokens books it here as a loss (solanaShortfallWriteOff): never capital
   * out, so the high-water mark stays and the drawdown breaker sees it, and
   * buying is paused for the owner's review.
   *
   * `snapshot`: finalized balances two providers on their own hostnames agree
   * on, at the lowest slot either answered at, read at or after the book's slot.
   * `decisionId`: the operator's decision, recorded first with that same
   * snapshot in solana_operator_shortfalls and still open; it is marked booked
   * in this transaction (no mark, no booking). Afterwards the book matches the
   * vault at `snapshot.slot`, recorded as its balancesSlot: every vault change at
   * or before it is in the book, so none can be recorded again later. Refused
   * while a trade or a signed owner transaction is pending or a withdrawal is
   * prepared, when nothing is short, and when the book moved since the snapshot.
   */
  async writeOffShortfall(snapshot: { cashUsdg: string; wsolRaw: string; slot: number; observedAtMs: number; commitment: "finalized" }, decisionId: string) {
    return this.db.tx(async tx => {
      await this.bindingIn(tx, true);
      const { tenant, owner } = this.scope, now = clock(this.now);
      if (snapshot.commitment !== "finalized" || !Number.isSafeInteger(snapshot.slot) || snapshot.slot < 1 || !Number.isSafeInteger(snapshot.observedAtMs)
        || snapshot.observedAtMs > now || now - snapshot.observedAtMs >= 60_000) refuse("A fresh finalized Solana balance snapshot is required.");
      raw(snapshot.cashUsdg); raw(snapshot.wsolRaw);
      if (await tx.prepare("SELECT 1 FROM solana_runtime_submissions WHERE vault IN (SELECT vault FROM solana_runtime_submissions WHERE tenant=? AND owner=?) AND status='pending'").get(tenant, owner)) {
        refuse("Resolve the pending Solana trade before writing off a shortfall.");
      }
      const setup = rowJson<SolanaPreparedSetup>(await tx.prepare("SELECT setup_json FROM solana_runtime_setups WHERE tenant=? AND owner=?").get(tenant, owner), "setup_json");
      if (setup?.signature && setup.status !== "finalized" && setup.status !== "failed") refuse("Resolve the pending owner transaction before writing off a shortfall.");
      // A prepared withdrawal sized against the old book could land after this and exceed the new one.
      if ((setup?.kind === "withdraw" || setup?.kind === "withdraw-sol") && !setup.signature && now < setup.expiresAtMs) refuse("Let the prepared owner withdrawal lapse before writing off a shortfall.");
      const before = rowJson<SolanaLiveBook>(await tx.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?").get(tenant, owner), "book_json");
      if (!before) refuse("There is no live trading record to write off against.");
      if (snapshot.slot < before.slot || now < before.updatedAtMs) refuse("The recorded book moved after these balances were read. Read them again.");
      const { book, lost, inflow } = solanaShortfallWriteOff(before, snapshot);
      const flow = async (evidenceId: string, kind: "write-off" | "deposit" | "quarantine", mint: string, amount: bigint) => {
        if (amount === 0n) return;
        const inserted = await tx.prepare("INSERT INTO solana_runtime_cashflows(evidence_id,tenant,owner,kind,mint,amount_raw,created_at_ms) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
          .run(evidenceId, tenant, owner, kind, mint, amount.toString(), now);
        if (inserted.changes !== 1) refuse("This shortfall evidence was already used.");
      };
      await flow(`write-off:${owner}:${snapshot.slot}:${SOLANA_USDG_MINT}:${snapshot.cashUsdg}`, "write-off", SOLANA_USDG_MINT, lost.usdgRaw);
      await flow(`write-off:${owner}:${snapshot.slot}:${SOLANA_WRAPPED_SOL_MINT}:${snapshot.wsolRaw}`, "write-off", SOLANA_WRAPPED_SOL_MINT, lost.wsolRaw + lost.quarantinedWsolRaw);
      // The same evidence ids status books an inflow with at this slot: never booked twice.
      await flow(`deposit:${owner}:${snapshot.slot}:${snapshot.cashUsdg}`, "deposit", SOLANA_USDG_MINT, inflow.usdgRaw);
      await flow(`quarantine:${owner}:${snapshot.slot}:${snapshot.wsolRaw}`, "quarantine", SOLANA_WRAPPED_SOL_MINT, inflow.quarantinedWsolRaw);
      const written: SolanaLiveBook & { balancesSlot?: number } = { ...book, slot: snapshot.slot, updatedAtMs: now };
      written.balancesSlot = snapshot.slot;
      await tx.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify(written), tenant, owner);
      // Who wrote it off, and on what reading, is part of the booking: no mark, no booking (the transaction rolls back).
      const marked = await tx.prepare(`UPDATE solana_operator_shortfalls SET booked_at_ms=? WHERE id=? AND tenant=? AND owner=? AND slot=? AND cash_usdg=? AND wsol_raw=?
        AND booked_at_ms IS NULL AND refusal IS NULL`).run(now, decisionId, tenant, owner, snapshot.slot, snapshot.cashUsdg, snapshot.wsolRaw);
      if (marked.changes !== 1) refuse("The operator decision to write off this shortfall is not open.");
      return { book: written as SolanaLiveBook, lost: { usdgRaw: lost.usdgRaw.toString(), wsolRaw: lost.wsolRaw.toString(), quarantinedWsolRaw: lost.quarantinedWsolRaw.toString(),
        costBasisUsdgRaw: lost.costBasisUsdgRaw.toString() }, inflow: { usdgRaw: inflow.usdgRaw.toString(), quarantinedWsolRaw: inflow.quarantinedWsolRaw.toString() } };
    });
  }
  /**
   * Book inflows that arrived outside recorded trades, from a fresh finalized
   * snapshot: USDG as owner capital (raising the high-water mark), WSOL as
   * zero-basis quarantine. A balance below the book is never reconciled here.
   * Caller obtains this snapshot from finalized RPC; never accept request JSON here.
   */
  async reconcileExternalInflows(snapshot: { cashUsdg: string; wsolRaw: string; slot: number; observedAtMs: number; commitment: "finalized" }): Promise<void> {
    await this.db.tx(async tx => {
      await this.bindingIn(tx, true);
      const { tenant, owner } = this.scope, now = clock(this.now);
      if (snapshot.commitment !== "finalized" || !Number.isSafeInteger(snapshot.slot) || snapshot.slot < 1 ||
          !Number.isSafeInteger(snapshot.observedAtMs) || snapshot.observedAtMs > now || now - snapshot.observedAtMs >= 30_000) refuse("A fresh finalized Solana balance snapshot is required.");
      const cash = raw(snapshot.cashUsdg), wsol = raw(snapshot.wsolRaw);
      if (await tx.prepare("SELECT 1 FROM solana_runtime_submissions WHERE vault IN (SELECT vault FROM solana_runtime_submissions WHERE tenant=? AND owner=?) AND status='pending'").get(tenant, owner)) refuse("Resolve pending Solana trades before reconciling deposits.");
      const setup = rowJson<SolanaPreparedSetup>(await tx.prepare("SELECT setup_json FROM solana_runtime_setups WHERE tenant=? AND owner=?").get(tenant, owner), "setup_json");
      if (setup?.signature && setup.status !== "finalized" && setup.status !== "failed") refuse("Resolve the pending owner transaction before reconciling deposits.");
      const book = rowJson<SolanaLiveBook>(await tx.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?").get(tenant, owner), "book_json");
      if (!book) return;
      const recordedWsol = raw(book.wsolRaw) + solanaQuarantinedWsol(book);
      if (snapshot.slot < book.slot || now < book.updatedAtMs || cash < raw(book.cashRaw) || wsol < recordedWsol) refuse("Only finalized inflows can be reconciled automatically; a vault balance is below the recorded book.");
      const deposit = cash - raw(book.cashRaw), donated = wsol - recordedWsol;
      if (deposit === 0n && donated === 0n) return;
      const flow = async (evidenceId: string, kind: "deposit" | "quarantine", mint: string, amount: bigint) => {
        const inserted = await tx.prepare("INSERT INTO solana_runtime_cashflows(evidence_id,tenant,owner,kind,mint,amount_raw,created_at_ms) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
          .run(evidenceId, tenant, owner, kind, mint, amount.toString(), now);
        if (inserted.changes !== 1) refuse("Inflow evidence was already used with different accounting state.");
      };
      if (deposit > 0n) {
        const hwm = raw(book.hwmRaw) + deposit; raw(hwm.toString());
        await flow(`deposit:${owner}:${snapshot.slot}:${snapshot.cashUsdg}`, "deposit", SOLANA_USDG_MINT, deposit);
        book.cashRaw = cash.toString(); book.hwmRaw = hwm.toString();
      }
      // Unsolicited WSOL is held aside at zero basis: never traded, valued or added to the high-water mark.
      if (donated > 0n) {
        await flow(`quarantine:${owner}:${snapshot.slot}:${snapshot.wsolRaw}`, "quarantine", SOLANA_WRAPPED_SOL_MINT, donated);
        book.quarantinedWsolRaw = (solanaQuarantinedWsol(book) + donated).toString(); raw(book.quarantinedWsolRaw);
      }
      book.slot = snapshot.slot; book.updatedAtMs = now; book.balancesSlot = snapshot.slot;
      await tx.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify(book), tenant, owner);
    });
  }
  /**
   * OWNER WITHDRAWALS MADE OUTSIDE MERRYMEN (solana-recover, another wallet).
   *
   * The documented emergency path withdraws with the owner's own key, outside
   * the app, so the book kept the old balances: a vault below its book holds
   * every trade, exit and in-app withdrawal of that asset. This books such
   * withdrawals as capital out, each from a finalized, successful transaction
   * the runtime read on both providers (recordExternalWithdrawals): a top-level
   * withdraw by the vault program, signed by this owner, for this vault, and the
   * vault token account's own net decrease in it (`amountRaw`).
   *
   * What keeps it from hiding a loss: every withdrawal booked is an owner-signed
   * one, never a shortfall, and only one the book cannot already reflect: its
   * slot is after the book's last absolute balance (balancesSlot, or the book's
   * creation), so it is still in the vault's balances and not in the book. The
   * one balance difference it books is a sweep's unbooked inflow (below), and
   * only as status books inflows. Each is booked once (evidence external:<signature>:<mint>, and never a
   * signature the app already booked as its own withdrawal). An in-app prepared
   * withdrawal whose wallet broadcast it and that the owner recorded here first
   * is never saved as the app's own afterwards, nor booked again by it
   * (SOLANA_WITHDRAWAL_RECORDED_OUTSIDE). A shortfall any other way (a trade
   * off the books) stays held: nothing here books it.
   *
   * USDG out lowers cash and the high-water mark by the amount (floor 0). WSOL
   * out leaves quarantine first, then the position at its prorated basis; the
   * high-water mark drops by the lower of what the position part is worth now
   * (`valuation`, checked fresh here) and that prorated cost basis, or not at
   * all without a valuation. It is recorded when the owner records it, possibly
   * days after it happened: had SOL risen since, its value now would lower the
   * mark by more than the capital that left (understating later drawdown), so
   * the capital the owner put into that SOL bounds it. An in-app withdrawal is
   * valued when prepared, about a minute before it lands, and is not bounded
   * this way. No realized P&L. Refused while a trade or an owner transaction is pending.
   *
   * A withdrawal of more than the book records (solana-recover sweeps the whole
   * balance) also took an inflow no status read booked yet: a deposit, or
   * anyone's WSOL, that arrived after the last read. Its own transaction shows
   * the vault held at least the amount just before it (`preRaw`, the token
   * account's pre-transaction balance, read on both providers), so the part
   * beyond the book is booked first as that inflow, at its slot and exactly as
   * status books one (USDG as a deposit raising the high-water mark, WSOL as
   * zero-basis quarantine; evidence external-in:<signature>:<mint>), and then
   * the withdrawal. Only what the withdrawal needs: any rest still in the vault
   * waits for status's own inflow read. Without a pre-transaction balance at or
   * above the amount it stays refused. An asset short any other way stays held.
   *
   * INFLOWS ARE BOOKED FROM BALANCES (owner decision, recorded 2026-10-20). A
   * deposit is a plain token transfer with no vault instruction to attribute it,
   * so every inflow is booked as a balance above the book: status's finalized
   * read, a withdrawal prepare's, and this sweep's pre-transaction balance. An
   * off-book loss (a leaked session's trade, say) and a deposit that both fall
   * between two such reads therefore net: book 100 USDG, 40 lost off the books,
   * 50 deposited, then any of those reads books a deposit of 10, and the loss
   * leaves the drawdown baseline. The sweep is no different from a status read
   * just before it (it books what that read would have, then the withdrawal),
   * and the in-app path gives the same high-water mark (solana-trading-store
   * test "inflows are booked from balances"). Refusing only the sweep would
   * change the outcome by whether a page happened to read status in between,
   * and leave the owner held. The fence that would close it for every path is a
   * vault-sequence anchor: the sequence the book has accounted for, kept by
   * trade settlement, owner withdrawals and recorded external ones (native SOL
   * included), so that a balance is booked as an inflow only when no sequence
   * the book does not know of moved since. That spans the trade and owner paths
   * and is not built here; until then a loss off the books shows as a vault
   * below its book only while no deposit has covered it.
   */
  async reconcileExternalWithdrawals(input: { withdrawals: ReadonlyArray<{ signature: string; slot: number; mint: string; amountRaw: string; preRaw?: string; valuation?: SolanaWithdrawValuation }> }):
    Promise<{ booked: Array<{ signature: string; mint: string; amountRaw: string }>; book: SolanaLiveBook }> {
    return this.db.tx(async tx => {
      await this.bindingIn(tx, true);
      const { tenant, owner } = this.scope, now = clock(this.now);
      const withdrawals = input?.withdrawals;
      if (!Array.isArray(withdrawals) || withdrawals.length < 1 || withdrawals.length > 16) refuse("Give between one and sixteen finalized withdrawals.");
      if (await tx.prepare("SELECT 1 FROM solana_runtime_submissions WHERE vault IN (SELECT vault FROM solana_runtime_submissions WHERE tenant=? AND owner=?) AND status='pending'").get(tenant, owner)) refuse("Resolve pending Solana trades before recording withdrawals made outside Merrymen.");
      const main = rowJson<SolanaPreparedSetup>(await tx.prepare("SELECT setup_json FROM solana_runtime_setups WHERE tenant=? AND owner=?").get(tenant, owner), "setup_json");
      if (ownerPending(main) || ownerPending(await this.revokeIn(tx))) refuse("Resolve the pending owner transaction before recording withdrawals made outside Merrymen.");
      const book = rowJson<SolanaLiveBook>(await tx.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?").get(tenant, owner), "book_json");
      if (!book) refuse("There is no live trading record to reconcile yet.");
      if (now < book.updatedAtMs) refuse("Solana portfolio evidence moved backwards.");
      // Every vault change at or before this slot is already in the book.
      let since = book.balancesSlot;
      if (since === undefined) {
        const first = await tx.prepare("SELECT submission_json FROM solana_runtime_submissions WHERE tenant=? AND owner=? ORDER BY created_at_ms,request_id LIMIT 1").get(tenant, owner) as { submission_json: string } | undefined;
        const created = first ? (JSON.parse(first.submission_json) as { risk?: { slot?: unknown } }).risk?.slot : undefined;
        since = typeof created === "number" && Number.isSafeInteger(created) ? created : book.slot;
      }
      const booked: Array<{ signature: string; mint: string; amountRaw: string }> = [];
      let latest = book.slot;
      for (const item of [...withdrawals].sort((a, b) => a.slot - b.slot)) {
        if (!item || typeof item.signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(item.signature) || !Number.isSafeInteger(item.slot) || item.slot < 1
          || (item.mint !== SOLANA_USDG_MINT && item.mint !== SOLANA_WRAPPED_SOL_MINT)) refuse("Invalid finalized withdrawal evidence.");
        const amount = raw(item.amountRaw, false), evidence = `external:${item.signature}:${item.mint}`;
        if (await tx.prepare("SELECT 1 FROM solana_runtime_cashflows WHERE evidence_id IN (?,?)").get(item.signature, evidence)) refuse("That withdrawal is already recorded. Nothing was recorded.");
        if (item.slot <= since) refuse("That withdrawal is already reflected in the recorded balances. Nothing was recorded.");
        const usdg = item.mint === SOLANA_USDG_MINT, recorded = usdg ? raw(book.cashRaw) : raw(book.wsolRaw) + solanaQuarantinedWsol(book);
        if (amount > recorded) {
          // The unbooked inflow it took, shown by the vault's own balance just before it.
          let pre: bigint | null = null;
          try { pre = typeof item.preRaw === "string" ? raw(item.preRaw) : null; } catch { refuse("Invalid finalized withdrawal evidence."); }
          if (pre === null || pre < amount) refuse(usdg ? "That withdrawal is more than the recorded USDG. Nothing was recorded." : "That withdrawal is more than the recorded wrapped SOL. Nothing was recorded.");
          const unbooked = amount - recorded;
          const inflow = await tx.prepare("INSERT INTO solana_runtime_cashflows(evidence_id,tenant,owner,kind,mint,amount_raw,created_at_ms) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
            .run(`external-in:${item.signature}:${item.mint}`, tenant, owner, usdg ? "deposit" : "quarantine", item.mint, unbooked.toString(), now);
          if (inflow.changes !== 1) refuse("That withdrawal is already recorded. Nothing was recorded.");
          if (usdg) { book.cashRaw = (raw(book.cashRaw) + unbooked).toString(); book.hwmRaw = (raw(book.hwmRaw) + unbooked).toString(); raw(book.cashRaw); raw(book.hwmRaw); }
          else { book.quarantinedWsolRaw = (solanaQuarantinedWsol(book) + unbooked).toString(); raw(book.quarantinedWsolRaw); }
        }
        if (item.mint === SOLANA_USDG_MINT) {
          if (amount > raw(book.cashRaw)) refuse("That withdrawal is more than the recorded USDG. Nothing was recorded.");
          book.cashRaw = (raw(book.cashRaw) - amount).toString();
          const peak = raw(book.hwmRaw); book.hwmRaw = (peak > amount ? peak - amount : 0n).toString();
        } else {
          const held = raw(book.wsolRaw), aside = solanaQuarantinedWsol(book);
          if (amount > held + aside) refuse("That withdrawal is more than the recorded wrapped SOL. Nothing was recorded.");
          // Quarantined WSOL leaves first: zero basis, no effect on the position or the high-water mark.
          const fromAside = amount < aside ? amount : aside, fromPosition = amount - fromAside;
          if (aside > 0n) book.quarantinedWsolRaw = (aside - fromAside).toString();
          if (fromPosition > 0n) {
            const basis = fromPosition === held ? BigInt(book.costBasisUsdgRaw) : BigInt(book.costBasisUsdgRaw) * fromPosition / held;
            book.wsolRaw = (held - fromPosition).toString(); book.costBasisUsdgRaw = (BigInt(book.costBasisUsdgRaw) - basis).toString();
            const value = solanaWithdrawValueUsdg(item.valuation, item.amountRaw, now, this.pythGeneration);
            if (value !== null) {
              const worth = value * fromPosition / amount, out = worth < basis ? worth : basis < 0n ? 0n : basis, peak = raw(book.hwmRaw);
              book.hwmRaw = (peak > out ? peak - out : 0n).toString();
            }
          }
        }
        const inserted = await tx.prepare("INSERT INTO solana_runtime_cashflows(evidence_id,tenant,owner,kind,mint,amount_raw,created_at_ms) VALUES(?,?,?,'withdraw-external',?,?,?) ON CONFLICT DO NOTHING")
          .run(evidence, tenant, owner, item.mint, amount.toString(), now);
        if (inserted.changes !== 1) refuse("That withdrawal is already recorded. Nothing was recorded.");
        booked.push({ signature: item.signature, mint: item.mint, amountRaw: amount.toString() });
        latest = Math.max(latest, item.slot);
      }
      book.slot = latest; book.updatedAtMs = now;
      await tx.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify(book), tenant, owner);
      return { booked, book };
    });
  }
  async session(): Promise<SolanaRegisteredSession | null> {
    await this.binding();
    return rowJson(await this.db.prepare("SELECT record_json FROM solana_runtime_sessions WHERE tenant=? AND owner=?").get(this.scope.tenant, this.scope.owner), "record_json");
  }
  async sessionSeed(dek: Buffer): Promise<string | null> {
    const session = await this.session(); if (!session) return null;
    const row = await this.db.prepare("SELECT sealed_seed FROM solana_runtime_sessions WHERE tenant=? AND owner=?").get(this.scope.tenant, this.scope.owner) as { sealed_seed: string };
    const prefix = this.seedPrefix(session);
    const plain = openSecret(row.sealed_seed, dek);
    if (!plain.startsWith(prefix)) refuse("The encrypted session does not match this Solana account.");
    return plain.slice(prefix.length);
  }
  private seedPrefix(session: SolanaRegisteredSession): string {
    return `solana-session/v1 ${this.scope.tenant} ${this.scope.owner} ${session.programId} ${session.vault} ${session.session} ${session.sessionEpoch}\n`;
  }
  async registerSession(session: SolanaRegisteredSession, seed: string, dek: Buffer): Promise<void> {
    for (const value of [session.programId, session.vault, session.session]) key(value);
    return this.db.tx(async tx => {
      await this.bindingIn(tx, true);
      const setup = rowJson<SolanaPreparedSetup>(await tx.prepare("SELECT setup_json FROM solana_runtime_setups WHERE tenant=? AND owner=?")
        .get(this.scope.tenant, this.scope.owner), "setup_json");
      if (!setup || (setup.kind ?? "session") !== "session" || setup.status !== "finalized" ||
          setup.signature !== session.registrationSignature || setup.programId !== session.programId ||
          setup.vault !== session.vault || setup.session !== session.session) refuse("Register only the exact finalized owner-approved session.");
      if (await tx.prepare("SELECT 1 FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND status='pending'").get(this.scope.tenant, this.scope.owner)) refuse("Resolve the pending Solana trade before replacing its session.");
      // A registration moves the epoch once: any other move since it was prepared (a revocation, say) was not the owner's word for this session.
      if (setup.priorSessionEpoch !== undefined && session.sessionEpoch !== solanaRegisteredEpoch(setup.priorSessionEpoch)?.toString()) refuse(SOLANA_REGISTERED_AFTER_REVOKE);
      // A revocation the owner signed beside this registration, landed or not yet resolved, was the later word.
      const revoke = await this.revokeIn(tx);
      if (revoke?.beside === setup.signature && ((revoke.signature && revoke.status !== "failed") || revoke.landed?.length)) refuse("A revocation was signed after this permission. Prepare a new permission.");
      // One prepared beside it and still signable may be open in the owner's wallet: never deleted from under it.
      if (revoke && !revoke.signature && revoke.beside === setup.signature && clock(this.now) < revoke.expiresAtMs) refuse(SOLANA_REVOKE_PREPARED_BESIDE);
      await tx.prepare("DELETE FROM solana_runtime_owner_revokes WHERE tenant=? AND owner=?").run(this.scope.tenant, this.scope.owner);
      await tx.prepare(`INSERT INTO solana_runtime_sessions(tenant,owner,record_json,sealed_seed) VALUES(?,?,?,?)
        ON CONFLICT(tenant,owner) DO UPDATE SET record_json=excluded.record_json,sealed_seed=excluded.sealed_seed`)
        .run(this.scope.tenant, this.scope.owner, JSON.stringify(session), sealSecret(this.seedPrefix(session) + seed, dek));
      await tx.prepare("DELETE FROM solana_runtime_setups WHERE tenant=? AND owner=?")
        .run(this.scope.tenant, this.scope.owner);
    });
  }
  async pending(): Promise<SolanaLiveRecord[]> {
    await this.binding();
    const rows = await this.db.prepare("SELECT * FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND status='pending' ORDER BY created_at_ms").all(this.scope.tenant, this.scope.owner);
    return rows.map(r => record(r)!);
  }
  async history(): Promise<SolanaLiveRecord[]> {
    await this.binding();
    return (await this.db.prepare("SELECT * FROM solana_runtime_submissions WHERE tenant=? AND owner=? ORDER BY created_at_ms DESC,request_id DESC LIMIT 100")
      .all(this.scope.tenant, this.scope.owner)).map(r => record(r)!);
  }
  async get(owner: string, requestId: string): Promise<SolanaLiveRecord | null> {
    this.owner(owner); await this.binding();
    return record(await this.db.prepare("SELECT * FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND request_id=?").get(this.scope.tenant, owner, requestId));
  }
  /**
   * `admission.expiredAttemptAllowance`: see SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE (the default when omitted).
   * `admission.referenceToleranceBps`: the tolerance the persisted price bound must carry, the app runtime's
   * MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS (SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS when omitted); any other is refused.
   */
  async recordSigned(s: SolanaSignedSubmission, admission: { expiredAttemptAllowance?: number; referenceToleranceBps?: number } = {}): Promise<boolean> {
    this.owner(s.intent.owner);
    const allowance = admission.expiredAttemptAllowance ?? SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE;
    const toleranceBps = admission.referenceToleranceBps ?? SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS;
    if (!Number.isSafeInteger(allowance) || allowance < 0 || allowance > SOLANA_MAX_OPS_PER_DAY) refuse(SOLANA_EXPIRED_ATTEMPT_ALLOWANCE_MISCONFIGURED);
    let drawdownRefused = false;
    const accepted = await this.db.tx(async tx => {
      const binding = await this.bindingIn(tx, true);
      const { tenant, owner } = this.scope;
      if (await tx.prepare("SELECT 1 FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND request_id=?").get(tenant, owner, s.intent.requestId)) return false;
      if (await solanaOperatorHeld(tx, tenant)) refuse(OPERATOR_HOLD);
      this.checkRequestOwner(s.intent.requestId);
      const strategyCap = await this.autonomousIn(tx, binding);
      if (binding.requestedMode !== "live" || !binding.limits) refuse("Live Solana trading has not been enabled for this account.");
      const ownerSetup = rowJson<SolanaPreparedSetup>(await tx.prepare("SELECT setup_json FROM solana_runtime_setups WHERE tenant=? AND owner=?").get(tenant, owner), "setup_json");
      if (ownerPending(ownerSetup) || ownerPending(await this.revokeIn(tx))) refuse("Resolve the pending owner transaction before trading.");
      const now = clock(this.now), limits = validateSolanaAccountLimits(binding.limits, now);
      // A prepared withdrawal's expiry is proven by an unchanged sequence, so no
      // trade may advance it between preparing and signing either.
      if ((ownerSetup?.kind === "withdraw" || ownerSetup?.kind === "withdraw-sol") && !ownerSetup.signature && now < ownerSetup.expiresAtMs) refuse("Finish or let lapse the prepared owner withdrawal before trading.");
      const session = rowJson<SolanaRegisteredSession>(await tx.prepare("SELECT record_json FROM solana_runtime_sessions WHERE tenant=? AND owner=?").get(tenant, owner), "record_json");
      if (!session || s.programId !== session.programId || s.intent.vault !== session.vault || s.session !== session.session || s.sessionEpoch !== session.sessionEpoch) refuse("The Solana session changed before submission.");
      if (await tx.prepare("SELECT 1 FROM solana_runtime_submissions WHERE vault=? AND status='pending'").get(session.vault)) return false;
      if (s.intent.mode !== "live" || s.intent.chain !== CHAINS.solana || s.intent.kind !== "spl-swap") refuse("Invalid live Solana intent.");
      const { owner: _owner, vault: _vault, ...paperIntent } = s.intent;
      validateSolanaQuote(s.quote, { ...paperIntent, mode: "paper" }, now);
      if (![s.preparedAtMs, s.risk.observedAtMs, s.safetyObservedAtMs].every(t => Number.isSafeInteger(t) && t <= now && now - t < 30_000)) refuse("Solana risk evidence expired before durable admission.");
      if (![s.risk.slot, s.minContextSlot].every(t => Number.isSafeInteger(t) && t > 0) || s.risk.slot < s.minContextSlot) refuse("Solana risk evidence is not from the current account read.");
      const buying = s.intent.inputMint === SOLANA_USDG_MINT;
      if ((buying ? s.intent.outputMint : s.intent.inputMint) !== SOLANA_WRAPPED_SOL_MINT) refuse("This live vault supports USDG and wrapped SOL only.");
      // Re-check the independent price bound from the persisted evidence: the
      // signed minimum may not be below its floor, and a sell is charged at least
      // its reference value however low it was quoted.
      let reference: SolanaReferenceBound;
      try { reference = verifySolanaReferenceBound(s.risk.reference, s.intent, now, this.pythGeneration?.(), toleranceBps); } catch { refuse("The independent SOL price evidence is missing, stale or altered."); }
      if (reference.reference.slot < s.minContextSlot || s.minOutAmount !== s.quote.minOutAmount ||
          raw(s.minOutAmount, false) < raw(reference.minOutFloor, false)) refuse("The guaranteed output is below the independent SOL price floor.");
      const notional = solanaReferenceNotional(s.intent, s.quote.outAmount, reference);
      if (strategyCap !== null && notional > strategyCap) refuse("The autonomous Solana strategy trade limit would be exceeded.");
      let sellLimits: ReturnType<typeof requireSolanaLiveSellLimits>;
      try { sellLimits = requireSolanaLiveSellLimits(limits); } catch { refuse("Save per-trade and daily SOL sell limits before live trading."); }
      const sold = buying ? 0n : raw(s.intent.amountRaw, false);
      if (sold > sellLimits.perTradeWsol) refuse("The Solana per-trade SOL sell limit would be exceeded.");
      if (raw(s.risk.notionalUsdg, false) !== notional || notional > raw(limits.perTradeUsdg, false)) refuse("The Solana per-trade limit would be exceeded.");
      if (raw(s.feeLamports) + raw(s.rentLamports) > raw(s.maxFeeLamports, false)) refuse("The Solana fee and rent budget would be exceeded.");
      const recent = await tx.prepare("SELECT notional_raw,status,submission_json FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND created_at_ms>?").all(tenant, owner, now - DAY) as Array<{ notional_raw: string; status: string; submission_json: string }>;
      // Failed transactions landed, spent network fees and consume an operation;
      // a pending one counts until finalized evidence proves what it did. Token
      // notional is released only after canonical failure or expiry evidence.
      const operations = recent.filter(r => r.status !== "expired"), dropped = recent.length - operations.length;
      const counted = countedInWindow(recent);
      if (operations.length >= limits.maxOpsPerDay || windowNotional(counted) + notional > raw(limits.dailyUsdg, false)) refuse("The Solana rolling daily limit would be exceeded.");
      // A proven expiry never landed and the program never counted it, but the
      // session key signed it: only the configured allowance of them leaves the
      // owner's operation count (by default none), so at most maxOpsPerDay plus
      // the allowance are ever signed in 24 hours.
      if (operations.length + Math.max(0, dropped - allowance) >= limits.maxOpsPerDay) {
        refuse(SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED);
      }
      const soldToday = windowSold(counted);
      if (sold > 0n && soldToday + sold > sellLimits.dailyWsol) refuse("The Solana rolling daily SOL sell limit would be exceeded.");
      let book = rowJson<SolanaLiveBook>(await tx.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?").get(tenant, owner), "book_json");
      const equity = raw(s.risk.equityUsdg), peak = raw(s.risk.peakEquityUsdg), cash = raw(s.risk.cashUsdg), wsol = raw(s.risk.wsolRaw);
      // Only a shortfall against the book stops trading. Anyone can send tokens to
      // a vault, so an excess is never traded or valued: it waits to be booked as
      // a deposit or quarantine, and admission sizes against the book alone.
      if (book && (cash < raw(book.cashRaw) || wsol < raw(book.wsolRaw) + solanaQuarantinedWsol(book))) refuse("Vault balances are below the recorded book. Reconcile owner transfers before trading again.");
      if (book && (now < book.updatedAtMs || s.risk.slot < book.slot)) refuse("Solana portfolio evidence moved backwards.");
      const hwm = [book ? raw(book.hwmRaw) : 0n, peak, equity].reduce((a, b) => a > b ? a : b);
      const tradable = buying ? (book ? raw(book.cashRaw) : cash) : (book ? raw(book.wsolRaw) : 0n);
      if (tradable < raw(s.intent.amountRaw, false)) refuse(buying ? "Insufficient real Solana vault balance." : "The sale exceeds the recorded SOL position; quarantined SOL is not traded.");
      // The shared fee payer pays every live swap: no dust trades at its expense, except a whole-position exit.
      if (notional < SOLANA_LIVE_MIN_TRADE_USDG_RAW && (buying || raw(s.intent.amountRaw, false) !== tradable)) refuse(SOLANA_LIVE_BELOW_MINIMUM);
      // A first book on a vault that already holds WSOL starts with it quarantined: its cost basis is unknown.
      if (!book) book = { hwmRaw: hwm.toString(), cashRaw: cash.toString(), wsolRaw: "0", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: s.risk.slot, updatedAtMs: now,
        ...(wsol > 0n ? { quarantinedWsolRaw: wsol.toString() } : {}) };
      else book.hwmRaw = hwm.toString();
      if (buying && (book.buyPaused || hwm === 0n || (hwm - equity) * 10_000n >= hwm * BigInt(limits.maxDrawdownBps))) {
        // This refusal must commit the breaker. Throwing inside this transaction
        // would roll the pause back and silently re-arm the next price rebound.
        book.buyPaused = true; book.updatedAtMs = now;
        await tx.prepare(`INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)
          ON CONFLICT(tenant,owner) DO UPDATE SET book_json=excluded.book_json`).run(tenant, owner, JSON.stringify(book));
        drawdownRefused = true; return false;
      }
      // EXITS KEEP ROOM IN THE ROLLING LIMITS: a buy that would leave the whole position after it unsellable inside this window,
      // at this buy's own reference price, is refused (after the breaker above, which a buy in drawdown must still commit). What
      // it brings is counted with THE FILL MARGIN: neither the quote nor the reference bounds an ExactIn fill.
      if (buying) {
        const positionAfter = raw(book.wsolRaw) + solanaBuyFillBound(raw(s.quote.outAmount, false), raw(reference.referenceOut, false));
        // Within the registered permission's limits too, kept in the session record, where they are below the saved ones.
        const reserve = solanaExitReserveLimits({ dailyUsdg: raw(limits.dailyUsdg, false), dailyWsol: sellLimits.dailyWsol }, session.limits);
        if (!solanaBuyKeepsExitRoom({ usedUsdgRaw: windowNotional(counted), soldWsolRaw: soldToday, buyUsdgRaw: notional, positionAfterWsolRaw: positionAfter,
          positionAfterValueUsdgRaw: solanaReferenceWsolValue(positionAfter, reference.reference), dailyUsdgRaw: reserve.dailyUsdg,
          dailyWsolRaw: reserve.dailyWsol, toleranceBps })) refuse(SOLANA_LIVE_EXIT_RESERVE);
      }
      this.checkAdmissionSignal();
      const inserted = await tx.prepare(`INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json)
        VALUES(?,?,?,?,?,?,'pending',?,?,?) ON CONFLICT DO NOTHING`).run(tenant, owner, s.intent.requestId, s.intent.vault, s.vaultSequence, s.signature, now, notional.toString(), JSON.stringify(s));
      if (inserted.changes !== 1) return false;
      await this.recordAttemptIn(tx, s.intent.requestId, now);
      await tx.prepare(`INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)
        ON CONFLICT(tenant,owner) DO UPDATE SET book_json=excluded.book_json`).run(tenant, owner, JSON.stringify(book));
      return true;
    });
    if (drawdownRefused) refuse("The persisted Solana drawdown breaker blocks additional buys until owner review.");
    return accepted;
  }
  async settle(owner: string, requestId: string, signature: string, settlement: SolanaLiveSettlement): Promise<void> {
    await this.settleWith(owner, requestId, signature, settlement, null);
  }
  /**
   * settle, for an operator's recorded decision (solana-resolve.ts): the same
   * checks, and in the same transaction that books the trade, the decision
   * `resolutionId` (a row of solana_operator_resolutions, still open) is
   * marked booked. A decision is therefore marked booked if and only if it
   * booked the trade, whatever crashes or lost replies come between. Returns
   * false, marking nothing, when the trade is already booked with the same
   * evidence (by the worker's automatic settlement or another run). A decision
   * that cannot be marked books nothing.
   */
  async settleResolution(owner: string, requestId: string, signature: string, settlement: SolanaLiveSettlement, resolutionId: string): Promise<boolean> {
    if (!resolutionId) refuse("The operator resolution to book this settlement is not open.");
    return this.settleWith(owner, requestId, signature, settlement, resolutionId);
  }
  private async settleWith(owner: string, requestId: string, signature: string, settlement: SolanaLiveSettlement, resolutionId: string | null): Promise<boolean> {
    this.owner(owner);
    return this.db.tx(async tx => {
      await this.bindingIn(tx, true);
      const { tenant } = this.scope;
      const row = await tx.prepare("SELECT * FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND request_id=?").get(tenant, owner, requestId) as { notional_raw: string } | undefined;
      const prior = record(row);
      if (!prior || prior.submission.signature !== signature || settlement.signature !== signature) refuse("Solana settlement does not match the reserved transaction.");
      if (prior.status !== "pending") {
        if (JSON.stringify({ ...prior.settlement, finalizedAtMs: 0 }) !== JSON.stringify({ ...settlement, finalizedAtMs: 0 })) refuse("Solana settlement already exists with different evidence.");
        return false;
      }
      if (!["finalized", "failed", "expired"].includes(settlement.status) || !Number.isSafeInteger(settlement.slot) || settlement.slot < prior.submission.minContextSlot) refuse("Invalid finalized Solana settlement.");
      const book = rowJson<SolanaLiveBook>(await tx.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?").get(tenant, owner), "book_json");
      if (!book) refuse("The Solana live accounting book is missing.");
      const input = raw(settlement.amountIn), output = raw(settlement.amountOut);
      if (settlement.status === "expired") {
        const proof = settlement.expiryProof;
        // A sequence another transaction consumed is proven from the vault's debit log (observeSolanaSubmission),
        // and only an operator's recorded decision books it (solana-resolve.ts): never the worker's own settlement.
        const consumed = proof?.reason === "sequence-consumed";
        if (settlement.feeLamports !== null || input !== 0n || output !== 0n || !proof ||
            (consumed ? resolutionId === null || raw(proof.vaultSequence) <= raw(prior.submission.vaultSequence) ||
              raw(proof.blockHeight) <= raw(prior.submission.lastValidBlockHeight) || proof.debitWindowStart !== solanaDebitWindowStartOf(prior.submission)
              : proof.vaultSequence !== prior.submission.vaultSequence) ||
            raw(proof.sessionEpoch) < raw(prior.submission.sessionEpoch) ||
            !(consumed || proof.reason === "session-revoked" && raw(proof.sessionEpoch) > raw(prior.submission.sessionEpoch) ||
              proof.reason === "blockhash-expired" && raw(proof.blockHeight) > raw(prior.submission.lastValidBlockHeight))) refuse("Invalid Solana expiry evidence.");
        book.unresolvedFeeCount = (book.unresolvedFeeCount ?? 0) + 1;
        book.reservedUnknownFeeLamports = (raw(book.reservedUnknownFeeLamports ?? "0") + raw(prior.submission.feeLamports)).toString();
      } else {
        const fee = raw(settlement.feeLamports);
        if (fee > raw(prior.submission.feeLamports) || fee > raw(prior.submission.maxFeeLamports)) refuse("Finalized Solana fees exceed the reserved budget.");
        book.networkFeesLamports = (raw(book.networkFeesLamports) + fee).toString();
      }
      if (settlement.status === "finalized") {
        if (input === 0n || input > raw(prior.submission.intent.amountRaw) || output < raw(prior.submission.minOutAmount)) refuse("Solana settlement violates the reserved swap bounds.");
        if (prior.submission.intent.inputMint === SOLANA_USDG_MINT) {
          book.cashRaw = (raw(book.cashRaw) - input).toString(); book.wsolRaw = (raw(book.wsolRaw) + output).toString();
          book.costBasisUsdgRaw = (BigInt(book.costBasisUsdgRaw) + input).toString();
        } else {
          const held = raw(book.wsolRaw); if (input > held || held === 0n) refuse("Solana settlement exceeds the recorded position.");
          const basis = input === held ? BigInt(book.costBasisUsdgRaw) : BigInt(book.costBasisUsdgRaw) * input / held;
          book.wsolRaw = (held - input).toString(); book.cashRaw = (raw(book.cashRaw) + output).toString();
          book.costBasisUsdgRaw = (BigInt(book.costBasisUsdgRaw) - basis).toString();
          book.realizedPnlUsdgRaw = (BigInt(book.realizedPnlUsdgRaw) + output - basis).toString();
        }
        raw(book.cashRaw); raw(book.wsolRaw);
        if (raw(book.cashRaw) > raw(book.hwmRaw)) book.hwmRaw = book.cashRaw;
      } else if (input !== 0n || output !== 0n) refuse("A failed Solana transaction cannot book token movements.");
      // THE ROLLING WINDOW COUNTS WHAT THE PROGRAM CHARGED. A sale is charged its actual proceeds (`received` in the program's
      // swap), which can land above the notional admission reserved (the higher of its quote and its reference value): the
      // window then counts those proceeds, in the same transaction that books them. It only ever raises the count, so status,
      // admission and the exit reserve never see more room than the vault has. A buy is charged the USDG it offered, its notional.
      let notional = raw(row!.notional_raw);
      if (settlement.status === "finalized" && prior.submission.intent.inputMint !== SOLANA_USDG_MINT && output > notional) notional = output;
      book.slot = settlement.slot; book.updatedAtMs = clock(this.now);
      await tx.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify(book), tenant, owner);
      await tx.prepare("UPDATE solana_runtime_submissions SET status=?,settlement_json=?,notional_raw=? WHERE tenant=? AND owner=? AND request_id=? AND status='pending'")
        .run(settlement.status, JSON.stringify(settlement), notional.toString(), tenant, owner, requestId);
      if (resolutionId !== null) {
        // Who booked it is part of the booking: no mark, no booking (the transaction rolls back).
        const marked = await tx.prepare(`UPDATE solana_operator_resolutions SET booked_at_ms=? WHERE id=? AND tenant=? AND owner=? AND request_id=? AND signature=?
          AND booked_at_ms IS NULL AND refusal IS NULL`).run(clock(this.now), resolutionId, tenant, owner, requestId, signature);
        if (marked.changes !== 1) refuse("The operator resolution to book this settlement is not open.");
      }
      return true;
    });
  }
  async setup(): Promise<SolanaPreparedSetup | null> {
    await this.binding();
    return rowJson(await this.db.prepare("SELECT setup_json FROM solana_runtime_setups WHERE tenant=? AND owner=?").get(this.scope.tenant, this.scope.owner), "setup_json");
  }
  /** The revoke slot: a revocation prepared beside a pending main-slot owner transaction (REVOKE BESIDE...). */
  async revokeSetup(): Promise<SolanaPreparedSetup | null> {
    await this.binding();
    return this.revokeIn(this.db);
  }
  private async revokeIn(db: Db): Promise<SolanaPreparedSetup | null> {
    return rowJson(await db.prepare("SELECT setup_json FROM solana_runtime_owner_revokes WHERE tenant=? AND owner=?").get(this.scope.tenant, this.scope.owner), "setup_json");
  }
  async saveSetup(setup: SolanaPreparedSetup): Promise<boolean> {
    return this.db.tx(async tx => {
      const binding = await this.bindingIn(tx, true);
      const main = rowJson<SolanaPreparedSetup>(await tx.prepare("SELECT setup_json FROM solana_runtime_setups WHERE tenant=? AND owner=?").get(this.scope.tenant, this.scope.owner), "setup_json");
      const revoke = await this.revokeIn(tx);
      // REVOKE BESIDE A PENDING OWNER TRANSACTION: the revoke slot.
      if (setup.beside !== undefined) {
        if (setup.kind !== "revoke") refuse("Only a revocation can be prepared beside a pending owner transaction.");
        if (setup.signature) {
          if (revoke?.signature) {
            if (revoke.signature === setup.signature && revoke.signedTransactionBase64 === setup.signedTransactionBase64) return false;
            refuse("Resolve the previously submitted Solana setup before creating another.");
          }
          if (!revoke || revoke.messageBase64 !== setup.messageBase64 || revoke.preparedAtMs !== setup.preparedAtMs || revoke.beside !== setup.beside) refuse("The prepared owner transaction changed. Review and sign again.");
          if (clock(this.now) >= revoke.expiresAtMs) refuse("The prepared owner transaction expired before submission.");
          // Identical bytes to one that already landed (a prepare in the same slot reads the same blockhash) can never land again:
          // saved, they would sit pending with that one's receipt and hold every owner action and trade.
          if (revoke.landed?.some(item => item.signature === setup.signature)) refuse("That revocation already landed. Prepare the revocation again.");
          // The history it was prepared with is the store's, whatever the signed copy carries.
          const { landed: _offered, ...signed } = setup;
          setup = { ...signed, ...(revoke.landed?.length ? { landed: revoke.landed } : {}) };
        } else {
          // Only beside the main record it names, while that is a pending non-revoke, and never beside another pending revocation.
          if (!ownerPending(main) || main!.signature !== setup.beside || main!.kind === "revoke") refuse("Prepare the revocation again: the pending owner transaction it was prepared beside changed.");
          if (ownerPending(revoke)) refuse("Resolve the previously submitted Solana setup before creating another.");
          // A landed revocation beside this same record is kept: its proof partner and the registration's fence. Another
          // is prepared beside it only once the vault read for this one shows a session registered since that landing.
          const latest = solanaLandedBeside(main, revoke);
          if (latest && !solanaLiveAfterRevoke(latest, { session: setup.session, sessionEpoch: setup.priorSessionEpoch })) refuse(SOLANA_REVOKE_ALREADY_LANDED);
          // Every revocation that landed beside this record so far goes with it, oldest first.
          const { landed: _offered, ...prepared } = setup;
          const history = revoke?.beside === setup.beside ? [...(revoke.landed ?? []), ...(revoke.signature && revoke.status === "finalized" ? [(({ landed: _kept, ...item }) => item)(revoke)] : [])] : [];
          if (history.length > 8) refuse(SOLANA_REVOKE_ALREADY_LANDED);
          setup = { ...prepared, ...(history.length ? { landed: history } : {}) };
        }
        await tx.prepare(`INSERT INTO solana_runtime_owner_revokes(tenant,owner,setup_json) VALUES(?,?,?)
          ON CONFLICT(tenant,owner) DO UPDATE SET setup_json=excluded.setup_json`).run(this.scope.tenant, this.scope.owner, JSON.stringify(setup));
        return true;
      }
      // A pending revocation in the revoke slot holds every other owner transaction, another revocation included.
      if (!setup.signature && ownerPending(revoke)) refuse("Resolve the previously submitted Solana setup before creating another.");
      const previous = main;
      if (previous?.signature && previous.status !== "finalized" && previous.status !== "failed") {
        if (previous.signature === setup.signature && previous.signedTransactionBase64 === setup.signedTransactionBase64) return false;
        refuse("Resolve the previously submitted Solana setup before creating another.");
      }
      if (setup.signature) {
        if (!previous || previous.messageBase64 !== setup.messageBase64 || previous.preparedAtMs !== setup.preparedAtMs) refuse("The prepared owner transaction changed. Review and sign again.");
        if (clock(this.now) >= previous.expiresAtMs) refuse("The prepared owner transaction expired before submission.");
        // The wallet broadcast these bytes itself and the owner recorded them as made outside Merrymen: booked once, there.
        if (await tx.prepare("SELECT 1 FROM solana_runtime_cashflows WHERE evidence_id IN (?,?)").get(...externalEvidence(setup.signature))) refuse(SOLANA_WITHDRAWAL_RECORDED_OUTSIDE);
        if ((setup.kind ?? "session") === "session" && (binding.requestedMode !== "live" || JSON.stringify(binding.limits) !== JSON.stringify(setup.limits))) refuse("The live permission settings changed. Review and sign again.");
      }
      // A WSOL withdrawal's valuation is checked once, fresh, as prepared; the signed
      // save keeps that checked copy, whatever it is handed. A bad one is dropped,
      // never a reason to block the owner's withdrawal.
      const { withdrawValuation: offered, ...plain } = setup;
      const valuation = setup.kind !== "withdraw" || setup.mint !== SOLANA_WRAPPED_SOL_MINT ? undefined
        : setup.signature ? previous?.withdrawValuation
        : solanaWithdrawValueUsdg(offered, setup.amountRaw, clock(this.now), this.pythGeneration) !== null ? offered : undefined;
      setup = valuation ? { ...plain, withdrawValuation: structuredClone(valuation) } : plain;
      // A session's limits become the on-chain permission: never more operations than
      // the program allows, never a permission longer than Merrymen grants.
      if ((setup.kind ?? "session") === "session") validateSolanaAccountLimits(setup.limits, clock(this.now));
      if (setup.kind !== "revoke" && await tx.prepare("SELECT 1 FROM solana_runtime_submissions WHERE tenant=? AND owner=? AND status='pending'").get(this.scope.tenant, this.scope.owner)) refuse("Resolve the pending Solana trade before an owner transaction.");
      if (setup.kind === "withdraw" || setup.kind === "withdraw-sol") {
        if (setup.priorSequence === undefined) refuse("Prepare the withdrawal again.");
        // Under the lock, at both saves: never more than the book records (plus native SOL this
        // transaction syncs into WSOL), which finishSetup must be able to book once it lands. Recording a
        // withdrawal made outside Merrymen may lower the book while this one is prepared (it may be this
        // very transaction, broadcast by the wallet itself); then its signed save is refused here, so it is
        // never saved pending with an amount its booking would refuse forever.
        if (setup.kind === "withdraw" && setup.mint && setup.amountRaw) {
          const book = rowJson<SolanaLiveBook>(await tx.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?").get(this.scope.tenant, this.scope.owner), "book_json");
          // The signed save is held to what was prepared and measured, whatever copy it is handed.
          const synced = raw((setup.signature ? previous?.syncedWsolRaw : setup.syncedWsolRaw) ?? "0");
          const recorded = !book ? null : setup.mint === SOLANA_USDG_MINT ? raw(book.cashRaw) : raw(book.wsolRaw) + solanaQuarantinedWsol(book) + synced;
          if (recorded !== null && raw(setup.amountRaw, false) > recorded) refuse(SOLANA_WITHDRAWAL_ABOVE_BOOK);
        }
        const trades = await tx.prepare("SELECT sequence,status FROM solana_runtime_submissions WHERE vault=? AND status IN ('pending','finalized')").all(setup.vault) as Array<{ sequence: string; status: string }>;
        // Its sequence was read before this lock; a trade at or after it means the read is stale.
        if (trades.some(t => t.status === "pending" || raw(t.sequence) >= raw(setup.priorSequence!))) refuse("The vault changed while the withdrawal was prepared. Prepare it again.");
      }
      await tx.prepare(`INSERT INTO solana_runtime_setups(tenant,owner,setup_json) VALUES(?,?,?)
        ON CONFLICT(tenant,owner) DO UPDATE SET setup_json=excluded.setup_json`).run(this.scope.tenant, this.scope.owner, JSON.stringify(setup));
      // A new main-slot prepare replaces the record a revoke-slot revocation was prepared beside: one
      // not pending (unsigned or resolved) goes with it, so it can never be signed beside the new one.
      if (!setup.signature && revoke && !ownerPending(revoke)) await tx.prepare("DELETE FROM solana_runtime_owner_revokes WHERE tenant=? AND owner=?").run(this.scope.tenant, this.scope.owner);
      return true;
    });
  }
  async finishSetup(signature: string, status: "finalized" | "failed", finalizedSlot?: number, expiryProof?: SolanaOwnerExpiryProof): Promise<void> {
    await this.finishSetupWith(signature, status, finalizedSlot, expiryProof, null);
  }
  /**
   * finishSetup, for an operator's recorded decision (solana-resolve.ts owner book):
   * the same checks and booking, and in the same transaction the decision
   * `resolutionId` (a row of solana_operator_owner_resolutions, still open) is
   * marked booked. A decision is therefore marked booked if and only if it
   * finished the owner transaction. Returns false, marking nothing, when the
   * transaction is already finished with the same outcome (by the app or another
   * run). Only this path accepts an operator-no-receipt expiry proof.
   */
  async finishSetupResolution(signature: string, status: "finalized" | "failed", finalizedSlot: number, expiryProof: SolanaOwnerExpiryProof | undefined, resolutionId: string): Promise<boolean> {
    if (!resolutionId) refuse("The operator resolution to finish this owner transaction is not open.");
    return this.finishSetupWith(signature, status, finalizedSlot, expiryProof, resolutionId);
  }
  private async finishSetupWith(signature: string, status: "finalized" | "failed", finalizedSlot: number | undefined, expiryProof: SolanaOwnerExpiryProof | undefined,
    resolutionId: string | null): Promise<boolean> {
    return this.db.tx(async tx => {
      await this.bindingIn(tx, true);
      const main = rowJson<SolanaPreparedSetup>(await tx.prepare("SELECT setup_json FROM solana_runtime_setups WHERE tenant=? AND owner=?").get(this.scope.tenant, this.scope.owner), "setup_json");
      const revoke = await this.revokeIn(tx);
      // Each record is finished by its own signature, in whichever slot it is; its partner is the other slot's.
      const inRevokeSlot = !!revoke?.signature && revoke.signature === signature && main?.signature !== signature;
      const setup = inRevokeSlot ? revoke : main, partner = inRevokeSlot ? main : revoke;
      if (!setup || setup.signature !== signature) refuse("Owner confirmation does not match the saved transaction.");
      if (setup.status === "finalized" || setup.status === "failed") {
        if (setup.status !== status) refuse("Finalized owner transaction outcomes cannot be changed.");
        // An operator's decision never changes a recorded outcome: same outcome, nothing to book.
        if (resolutionId !== null) return false;
        if (JSON.stringify(setup.expiryProof ?? null) !== JSON.stringify(expiryProof ?? null)) refuse("Finalized owner expiry evidence cannot be changed.");
        return false;
      }
      if (expiryProof) {
        // An operator's no-receipt decision replaces the vault-state proof, and only with its own record (marked below).
        const operator = expiryProof.reason === "operator-no-receipt";
        if (status !== "failed" || (operator ? resolutionId === null || expiryProof.resolution !== resolutionId : expiryProof.reason !== "blockhash-expired")
            || raw(expiryProof.blockHeight) <= raw(setup.lastValidBlockHeight) || !Number.isSafeInteger(expiryProof.slot) || expiryProof.slot < 1 || finalizedSlot !== expiryProof.slot
            || (!operator && !solanaOwnerExpiryProven(setup, expiryProof.vaultSequence, expiryProof.sessionEpoch, solanaOwnerEpochOffset(setup, partner)))) refuse("Invalid owner transaction expiry evidence.");
        setup.expiryProof = structuredClone(expiryProof);
      }
      if (status === "finalized" && setup.kind === "resume-buys") {
        const book = rowJson<SolanaLiveBook>(await tx.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?")
          .get(this.scope.tenant, this.scope.owner), "book_json");
        if (book) {
          // A revocation beside it may have landed first and been undone by it (RESUME-BUYS BESIDE A REVOCATION): buying stays paused.
          book.buyPaused = solanaRevokedBesideResume(setup, partner, clock(this.now));
          await tx.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?")
            .run(JSON.stringify(book), this.scope.tenant, this.scope.owner);
        }
      }
      if (status === "finalized" && setup.kind === "withdraw") {
        if (!setup.mint || !setup.amountRaw || ![SOLANA_USDG_MINT, SOLANA_WRAPPED_SOL_MINT].includes(setup.mint)) refuse("Invalid finalized withdrawal accounting.");
        const amount = raw(setup.amountRaw, false), { tenant, owner } = this.scope;
        const book = rowJson<SolanaLiveBook>(await tx.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?").get(tenant, owner), "book_json");
        // Already booked from its own transaction as made outside Merrymen: finished, never booked a second time.
        const recordedOutside = await tx.prepare("SELECT 1 FROM solana_runtime_cashflows WHERE evidence_id IN (?,?)").get(...externalEvidence(signature));
        if (book && !recordedOutside) {
          // The book may already be past this withdrawal's slot. While a signed
          // withdrawal is pending nothing moves book.slot (trades and inflow booking
          // refuse), but it can be past it when the bytes are saved: they landed before
          // the server saved them (a wallet that also broadcasts) while a finalized
          // inflow read after them was booked, or one provider answered that read with
          // an inflated slot. Refusing then wedged the setup pending forever, blocking
          // trading and every owner transaction. The withdrawal is real (both
          // providers agreed on its receipt and its vault effect) and its evidence id
          // books it once, so it is booked anyway and book.slot never moves back. If
          // that inflow read already saw it, the book now sits below the chain by the
          // amount, and the next finalized inflow read books that back.
          if (!Number.isSafeInteger(finalizedSlot) || finalizedSlot! < 1) refuse("Finalized withdrawal slot is required for durable accounting.");
          if (setup.mint === SOLANA_USDG_MINT) {
            if (amount > raw(book.cashRaw)) refuse("Finalized withdrawal exceeds the recorded cash balance.");
            book.cashRaw = (raw(book.cashRaw) - amount).toString();
            const peak = raw(book.hwmRaw); book.hwmRaw = (peak > amount ? peak - amount : 0n).toString();
          } else {
            const held = raw(book.wsolRaw);
            let aside = solanaQuarantinedWsol(book);
            // Native lamports this transaction synced into WSOL (SyncNative) join the
            // zero-basis quarantine, only as far as the withdrawal needs them and never
            // past what prepare measured. Any a later read already booked is not added again.
            const synced = raw(setup.syncedWsolRaw ?? "0"), over = amount > held + aside ? amount - held - aside : 0n;
            if (over > synced) refuse("Finalized withdrawal exceeds the recorded SOL position.");
            if (over > 0n) {
              const inserted = await tx.prepare("INSERT INTO solana_runtime_cashflows(evidence_id,tenant,owner,kind,mint,amount_raw,created_at_ms) VALUES(?,?,?,'quarantine',?,?,?) ON CONFLICT DO NOTHING")
                .run(`sync:${signature}`, tenant, owner, SOLANA_WRAPPED_SOL_MINT, over.toString(), clock(this.now));
              if (inserted.changes !== 1) refuse("Withdrawal evidence was already accounted.");
              aside += over;
            }
            // Quarantined WSOL leaves first: zero basis, no effect on the position or the high-water mark.
            const fromAside = amount < aside ? amount : aside, fromPosition = amount - fromAside;
            if (aside > 0n) book.quarantinedWsolRaw = (aside - fromAside).toString();
            if (fromPosition > 0n) {
              const basis = fromPosition === held ? BigInt(book.costBasisUsdgRaw) : BigInt(book.costBasisUsdgRaw) * fromPosition / held;
              book.wsolRaw = (held - fromPosition).toString(); book.costBasisUsdgRaw = (BigInt(book.costBasisUsdgRaw) - basis).toString();
              // Capital out, as for USDG: the high-water mark drops by what the withdrawn
              // position was worth when prepared (its share of the valuation, floor 0).
              // Without a valuation it stays put, the conservative direction.
              const value = storedWithdrawValue(setup.withdrawValuation);
              if (value !== null) {
                const out = value * fromPosition / amount, peak = raw(book.hwmRaw);
                book.hwmRaw = (peak > out ? peak - out : 0n).toString();
              }
            }
            // No fabricated sale proceeds or P&L.
          }
          book.updatedAtMs = clock(this.now); book.slot = Math.max(book.slot, finalizedSlot!);
          const inserted = await tx.prepare("INSERT INTO solana_runtime_cashflows(evidence_id,tenant,owner,kind,mint,amount_raw,created_at_ms) VALUES(?,?,?,'withdraw',?,?,?) ON CONFLICT DO NOTHING")
            .run(signature, tenant, owner, setup.mint, amount.toString(), book.updatedAtMs);
          if (inserted.changes !== 1) refuse("Withdrawal evidence was already accounted.");
          await tx.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify(book), tenant, owner);
        }
      }
      if (status === "finalized" && setup.kind === "withdraw-sol") {
        // Native SOL in the vault account is never part of the book; keep the evidence once.
        if (!setup.amountRaw || setup.mint !== undefined) refuse("Invalid finalized withdrawal accounting.");
        const { tenant, owner } = this.scope;
        const book = rowJson<SolanaLiveBook>(await tx.prepare("SELECT book_json FROM solana_runtime_live_books WHERE tenant=? AND owner=?").get(tenant, owner), "book_json");
        // It moved the vault's sequence, so a live trade must read the vault no earlier than its slot (the
        // executor's snapshot floor). The setup row keeps that slot only until the owner's next prepare replaces
        // it; the book's slot is durable, and never moves back.
        if (book && (!Number.isSafeInteger(finalizedSlot) || finalizedSlot! < 1)) refuse("Finalized withdrawal slot is required for durable accounting.");
        const inserted = await tx.prepare("INSERT INTO solana_runtime_cashflows(evidence_id,tenant,owner,kind,mint,amount_raw,created_at_ms) VALUES(?,?,?,'withdraw-sol',?,?,?) ON CONFLICT DO NOTHING")
          .run(signature, tenant, owner, SOLANA_SYSTEM_PROGRAM, raw(setup.amountRaw, false).toString(), clock(this.now));
        if (inserted.changes !== 1) refuse("Withdrawal evidence was already accounted.");
        if (book && finalizedSlot! > book.slot) {
          book.updatedAtMs = clock(this.now); book.slot = finalizedSlot!;
          await tx.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify(book), tenant, owner);
        }
      }
      setup.status = status;
      if (status === "finalized" && Number.isSafeInteger(finalizedSlot) && finalizedSlot! > 0) setup.finalizedSlot = finalizedSlot;
      await tx.prepare(`UPDATE ${inRevokeSlot ? "solana_runtime_owner_revokes" : "solana_runtime_setups"} SET setup_json=? WHERE tenant=? AND owner=?`).run(JSON.stringify(setup), this.scope.tenant, this.scope.owner);
      if (resolutionId !== null) {
        // Who finished it is part of finishing it: no mark, nothing finished (the transaction rolls back).
        const marked = await tx.prepare(`UPDATE solana_operator_owner_resolutions SET booked_at_ms=? WHERE id=? AND tenant=? AND owner=? AND signature=? AND outcome=?
          AND booked_at_ms IS NULL AND refusal IS NULL`).run(clock(this.now), resolutionId, this.scope.tenant, this.scope.owner, signature, status);
        if (marked.changes !== 1) refuse("The operator resolution to finish this owner transaction is not open.");
      }
      return true;
    });
  }
}
