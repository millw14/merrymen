"use client";
import { useEffect, useRef, useState } from "react";
import type { Instruction } from "@solana/kit";
import { SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, base58Encode } from "../../../packages/core/src/ids";
import { buildRevokeSolanaSessionsInstruction, buildSetSolanaBreakerInstruction, buildWithdrawSolanaNativeInstruction, buildWithdrawSolanaVaultInstruction,
  deriveSolanaAta, deriveSolanaVaultAddress, SOLANA_ASSOCIATED_TOKEN_PROGRAM, SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_SYSTEM_PROGRAM, SOLANA_TRANSFER_HOOK_MAX_ACCOUNTS,
  SOLANA_WRAPPED_SOL_MINT } from "../../../packages/core/src/solana-live";
import { displaySolanaAmount, displaySolanaAmountOrNull, solanaUnits } from "../lib/solana-amounts";
import { RequestError } from "./request-json";
import type { SolanaApi } from "./SolanaAutomation";
import { OWNER_MAX_PRIORITY_FEE_LAMPORTS, readOwnerPaidTransaction, secondsUntil, type OwnerPaidInstruction } from "./SolanaPermission";

const WSOL = "So11111111111111111111111111111111111111112";
type ActionResult = { signature: string; status: "pending" | "finalized" | "failed" };
type OwnerAction = "revoke" | "withdraw" | "withdraw-sol" | "resume-buys";
const ACTION_NAMES: Record<OwnerAction, string> = { revoke: "revocation", withdraw: "withdrawal", "withdraw-sol": "native SOL withdrawal", "resume-buys": "request to resume buys" };
/** The server's saved owner transaction by its kind; "session" is a trading permission registration. */
const KIND_NAMES: Readonly<Record<string, string>> = { ...ACTION_NAMES, session: "trading permission" };
const kindName = (kind: string | undefined) => kind !== undefined && Object.hasOwn(KIND_NAMES, kind) ? KIND_NAMES[kind]! : "owner transaction";
const sol = (raw: unknown) => displaySolanaAmountOrNull(raw, 9);
/** What the owner wallet holds and must hold to send an owner transaction (status.live.ownerWallet). */
export type OwnerWallet = { lamports: string; revokeLamports: string; withdrawLamports: string };
/** Owner-recoverable SOL outside the book (status.live.recoverable). */
export type RecoverableSol = { nativeLamports: string; unsyncedWsolLamports: string };
/** What the owner route's prepare answers, beyond the bytes to sign. */
export type PreparedOwnerTransaction = { transactionBase64: string; requiredLamports?: string; ownerLamports?: string; priorityFeeLamports?: string };
/** What the owner asked the server to prepare: the owner route's prepare body, without its stage. */
export type OwnerRequest = { action: "revoke" } | { action: "resume-buys" } | { action: "withdraw"; mint: string; amountRaw: string } | { action: "withdraw-sol"; amountRaw: string };
/**
 * How long the page offers a prepared owner transaction for signing, timed
 * from before the prepare request. The server accepts its signature for 60
 * seconds from prepare (prepareOwner), so signed bytes still reach it in time;
 * the same window as a prepared permission's review.
 */
export const OWNER_REVIEW_SIGN_WINDOW_MS = 45_000;
/**
 * A prepared owner transaction the owner reviews before the wallet opens:
 * what it does and its priority fee, both checked against its bytes
 * (checkPreparedOwnerTransaction), and what the server says the owner wallet
 * must hold. Amounts are display strings, or null when unknown.
 */
type OwnerReview = { action: OwnerAction; request: OwnerRequest; transactionBase64: string; fee: string | null; required: string | null; held: string | null; deadline: number };
/** What the reviewed transaction does, in the owner's words: exactly what checkPreparedOwnerTransaction matched the bytes against. */
function reviewedEffect(request: OwnerRequest): string {
  if (request.action === "revoke") return "revokes every trading session of your vault";
  if (request.action === "resume-buys") return "turns your vault's buying back on, with its existing limits";
  if (request.action === "withdraw-sol") return `withdraws ${displaySolanaAmount(request.amountRaw, 9)} SOL from your vault to your owner wallet`;
  return request.mint === SOLANA_USDG_MINT ? `withdraws ${displaySolanaAmount(request.amountRaw, 6)} USDG from your vault to your own USDG token account`
    : `withdraws ${displaySolanaAmount(request.amountRaw, 9)} wrapped SOL from your vault to your own wrapped SOL token account`;
}

function plain(instruction: Instruction): OwnerPaidInstruction {
  return { program: String(instruction.programAddress), data: Uint8Array.from(instruction.data ?? []), accounts: (instruction.accounts ?? []).map((meta) => String(meta.address)) };
}
/**
 * True when `a` is exactly `b`. With `hookTailOwner`, `a` may also carry up to
 * SOLANA_TRANSFER_HOOK_MAX_ACCOUNTS accounts after `b`'s, none of them the
 * owner: a USDG transfer hook's accounts, which the vault forwards to the
 * transfer. They cannot change what moves: the vault transfers exactly the
 * amount from its token account to the owner's, refuses a signing extra
 * account, and the owner is the transaction's only signer.
 */
function sameInstruction(a: OwnerPaidInstruction, b: OwnerPaidInstruction, hookTailOwner: string | null = null): boolean {
  const extra = a.accounts.length - b.accounts.length;
  return a.program === b.program && a.data.length === b.data.length && a.data.every((byte, index) => byte === b.data[index])
    && (extra === 0 || (hookTailOwner !== null && extra > 0 && extra <= SOLANA_TRANSFER_HOOK_MAX_ACCOUNTS
      && a.accounts.slice(b.accounts.length).every((account) => account !== hookTailOwner)))
    && b.accounts.every((account, index) => account === a.accounts[index]);
}
/**
 * The instructions the server builds for `request` (prepareOwnerAction in
 * worker/src/solana-app-runtime.ts), from the same core builders, for this
 * owner's vault of this program: `required` in order, after an optional
 * SyncNative of the vault's wrapped SOL account (a wrapped SOL withdrawal
 * wraps native SOL sent there first).
 */
async function expectedOwnerInstructions(request: OwnerRequest, owner: string, programId: string): Promise<{ required: OwnerPaidInstruction[]; sync: OwnerPaidInstruction | null }> {
  const vault = await deriveSolanaVaultAddress(programId, owner);
  if (request.action === "revoke") return { required: [plain(buildRevokeSolanaSessionsInstruction({ programAddress: programId, vault, owner }))], sync: null };
  if (request.action === "resume-buys") return { required: [plain(buildSetSolanaBreakerInstruction({ programAddress: programId, vault, authority: owner, paused: false }))], sync: null };
  if (request.action === "withdraw-sol") return { required: [plain(buildWithdrawSolanaNativeInstruction({ programAddress: programId, vault, owner, amount: BigInt(request.amountRaw) }))], sync: null };
  const tokenProgram = request.mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : request.mint === SOLANA_WRAPPED_SOL_MINT ? SOLANA_CLASSIC_TOKEN_PROGRAM : null;
  if (!tokenProgram) throw new Error("Only USDG and wrapped SOL can be withdrawn.");
  const vaultToken = await deriveSolanaAta(vault, request.mint, tokenProgram), ownerToken = await deriveSolanaAta(owner, request.mint, tokenProgram);
  return {
    required: [
      // CreateIdempotent of the owner's own token account, paid by the owner.
      { program: SOLANA_ASSOCIATED_TOKEN_PROGRAM, data: Uint8Array.of(1), accounts: [owner, ownerToken, owner, request.mint, SOLANA_SYSTEM_PROGRAM, tokenProgram] },
      plain(buildWithdrawSolanaVaultInstruction({ programAddress: programId, vault, owner, mint: request.mint, tokenProgram, vaultToken, ownerToken, amount: BigInt(request.amountRaw) })),
    ],
    sync: tokenProgram === SOLANA_CLASSIC_TOKEN_PROGRAM ? { program: SOLANA_CLASSIC_TOKEN_PROGRAM, data: Uint8Array.of(17), accounts: [vaultToken] } : null,
  };
}

/**
 * THE PAGE'S CHECK OF A PREPARED OWNER TRANSACTION, BEFORE THE WALLET OPENS.
 *
 * The owner key signs, and pays for, every owner transaction, so the page
 * reads the server's bytes as it reads a permission's: a v0 message the
 * owner alone signs and pays for, a priority fee of at most
 * OWNER_MAX_PRIORITY_FEE_LAMPORTS on a compute budget no smaller than the
 * runtime's default for it (readOwnerPaidTransaction), and nothing but
 * exactly what the owner asked for, for this owner's vault of this program:
 * the revocation; the resume request (breaker off); the native SOL
 * withdrawal of exactly the amount typed; or the token withdrawal of exactly
 * the amount typed to the owner's own token account, with that account's
 * creation and, for wrapped SOL, the SyncNative before it. A priority fee
 * the server states must be the one the bytes carry. Returns that fee in
 * lamports, or throws: nothing reaches the wallet.
 */
export async function checkPreparedOwnerTransaction(prepared: PreparedOwnerTransaction, request: OwnerRequest, expected: { owner: string; programId: string }): Promise<string> {
  const name = ACTION_NAMES[request.action];
  const refuse = (): never => { throw new Error(`The prepared ${name} does not match what you asked for. Nothing was signed. Refresh and try again.`); };
  const decoded = readOwnerPaidTransaction(prepared.transactionBase64, expected.owner) ?? refuse();
  let wanted: Awaited<ReturnType<typeof expectedOwnerInstructions>>;
  try { wanted = await expectedOwnerInstructions(request, expected.owner, expected.programId); } catch { return refuse(); }
  const [first] = decoded.instructions;
  const rest = wanted.sync && first && sameInstruction(first, wanted.sync) ? decoded.instructions.slice(1) : decoded.instructions;
  // Only a USDG withdrawal's last instruction, the vault's withdraw, may carry a transfer hook's accounts.
  const hookTail = request.action === "withdraw" && request.mint === SOLANA_USDG_MINT ? expected.owner : null;
  if (rest.length !== wanted.required.length || !rest.every((instruction, index) =>
    sameInstruction(instruction, wanted.required[index]!, index === wanted.required.length - 1 ? hookTail : null))) refuse();
  const fee = decoded.priorityFeeLamports.toString();
  if (prepared.priorityFeeLamports !== undefined && prepared.priorityFeeLamports !== fee) {
    throw new Error(`The prepared ${name}'s priority fee does not match its bytes. Nothing was signed. Refresh and try again.`);
  }
  return fee;
}

/**
 * A 4XX REFUSES THE REQUEST IT ANSWERS, NOT NECESSARILY THE SIGNED BYTES.
 *
 * Signed owner and permission transactions are kept after an unknown outcome
 * (no answer, or a 5xx) so a retry resubmits the same bytes and never signs a
 * second transaction. A 4xx is an answer: the prepare window passed, the
 * limits changed, a trade is pending, or another owner transaction is saved.
 * Not a refusal: a sign-in or rate-limit answer (401, 403, 408, 429) or Solana
 * being switched off (404) says nothing about the bytes.
 *
 * A refusal of the FIRST submission that says this request saved nothing
 * (notSaved, savedNothing) proves these bytes were never saved, so dropping
 * them can never lose or duplicate a transaction. Any other refusal is
 * decided by the server's record of the bytes (outcomeAfterRefusal), not
 * assumed: a route that refuses without saying so may have saved them. A
 * later submission is a retry of bytes the server may already have saved and
 * broadcast, and the server answers a retry from its record of them
 * (ownerStatus, finishSetup): a 4xx there, notSaved included, can follow a
 * broadcast that later finalizes. So a refused retry never says "not
 * accepted": only the server's record decides.
 */
export function refusedByServer(error: unknown): error is RequestError {
  return error instanceof RequestError && error.status >= 400 && error.status < 500 && ![401, 403, 404, 408, 429].includes(error.status);
}

/**
 * A PACED ANSWER IS A WAIT, NOT A FAILURE.
 *
 * Solana routes answer 429 when an account asks too often (the status route
 * after a burst of reads, say), before anything runs, in words that say how
 * long to wait. The page shows that as a notice (role=status), never as a
 * failure (role=alert), wherever the request was made, and keeps what it holds
 * for the next try. Returns the server's words, or null for anything else.
 */
export function pacedAnswer(error: unknown): string | null {
  return error instanceof RequestError && error.status === 429 ? error.message : null;
}

/** A canonical positive integer of base units, as solanaResponse sends freshMinOutAmount. */
const FRESH_MINIMUM = /^[1-9][0-9]{0,38}$/;
/**
 * A SOLANA ROUTE'S ANSWER, WITH WHAT ITS BODY SAYS BEYOND THE SENTENCE.
 *
 * requestJson keeps only a refusal's sentence and status. solanaResponse
 * (web/src/lib/solana-api.ts) adds two fields the page acts on, kept here
 * only after validation; anything else reads as absent:
 * - notSaved: THIS request saved and sent nothing. It says nothing about an
 *   earlier submission of the same bytes (savedNothing).
 * - freshMinOutAmount: on a price-moved 409, what the fresh quote guarantees,
 *   in the output token's base units: a canonical positive integer.
 * SolanaScreen's solanaRequestJson throws it for every Solana route.
 */
export class SolanaRequestError extends RequestError {
  readonly notSaved: boolean;
  readonly freshMinOutAmount: string | null;
  constructor(message: string, status: number, body?: unknown) {
    super(message, status);
    const fields: { notSaved?: unknown; freshMinOutAmount?: unknown } = body !== null && typeof body === "object" ? body : {};
    this.notSaved = fields.notSaved === true;
    this.freshMinOutAmount = typeof fields.freshMinOutAmount === "string" && FRESH_MINIMUM.test(fields.freshMinOutAmount) ? fields.freshMinOutAmount : null;
  }
}

/**
 * notSaved: THIS refused request saved and sent nothing (solanaResponse).
 * Only for the first submission of signed bytes does that prove the bytes
 * were never saved, so they can be dropped. On a retry it says nothing about
 * the earlier submission, which the server may have saved and broadcast: the
 * server's record still decides (outcomeAfterRefusal), and no message says
 * the bytes were not sent from it. It only words the prompt to prepare again.
 */
export function savedNothing(error: unknown): boolean {
  return refusedByServer(error) && error instanceof SolanaRequestError && error.notSaved;
}

/**
 * The server's saved owner transaction, as the status route reports it, with
 * `revoke`: a revocation the owner signed beside it while it was pending (the
 * server's revoke slot), which has its own signature and outcome. `revokeAgain`:
 * that revocation landed, and a trading permission registered on Solana after it
 * is live, so the server prepares another revocation beside the same record.
 */
export type OwnerRecord = { signature: string; status: string; kind?: string; revoke?: { signature: string; status: string; kind?: string; revokeAgain?: boolean } | null } | null;

/**
 * The status blocker the server adds when it could not read a pending owner
 * transaction's outcome (ownerStatus threw: no provider answer, or no usable
 * one), exactly as worker/src/solana-app-runtime.ts words it; a test pins the
 * two together.
 */
export const OWNER_CONFIRMATION_UNAVAILABLE = "Owner transaction confirmation is unavailable.";
/**
 * How long status reads may keep reporting the same owner transaction pending
 * before the page stops saying it usually resolves within a few minutes: well
 * past its blockhash's lifetime (150 blocks, about a minute) and the
 * finalization that proves its expiry. Measured between this page's own reads,
 * since the server settles a pending record only when its status is read, so
 * it is a lower bound on the record's age.
 */
export const OWNER_PENDING_STUCK_MS = 5 * 60_000;
/** Which out-of-band recovery the page shows next to the owner controls (SolanaRecovery's step 2), if any. */
export type RecoveryOffer = "send" | "plan" | null;

/**
 * The owner's signature on signed wire bytes, which is what the server records
 * them by. Null for bytes the server could never accept: it requires exactly
 * one signature, the owner's (compact-u16 count 1, then 64 bytes).
 */
export function signatureOf(signedTransactionBase64: string): string | null {
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(signedTransactionBase64), (c) => c.charCodeAt(0)); } catch { return null; }
  return bytes.length > 65 && bytes[0] === 1 ? base58Encode(bytes.subarray(1, 65)) : null;
}

/**
 * WHAT HAPPENED TO SIGNED BYTES WHOSE RETRY WAS REFUSED, FROM THE SERVER'S RECORD.
 *
 * "unknown": the record could not be read, so the bytes stay.
 * "unheld": the server's owner transaction is not these bytes. They were
 * never saved (the server saves before it broadcasts, so they never reached
 * Solana), or were resolved and then replaced by a newer one (their outcome
 * stays on Solana). Either way dropping them cannot lose or duplicate one.
 * Otherwise the server holds them, with this outcome.
 */
export async function outcomeAfterRefusal(readRecord: () => Promise<OwnerRecord>, signature: string | null):
  Promise<"unknown" | "unheld" | "pending" | "finalized" | "failed"> {
  let record: OwnerRecord;
  try { record = await readRecord(); } catch { return "unknown"; }
  // These bytes are the main record, or the revocation saved beside it.
  const held = record && signature ? [record, record.revoke].find((item) => item?.signature === signature) : undefined;
  if (!held) return "unheld";
  return held.status === "finalized" || held.status === "failed" ? held.status : "pending";
}

/**
 * ONE SUBMITTED OWNER TRANSACTION AT A TIME, WITH THE REVOCATION ALWAYS AVAILABLE.
 *
 * The server keeps one owner transaction per account, plus a revocation
 * beside it. While one it saved is awaiting final confirmation (status
 * ownerTransaction "pending": a withdrawal, a resume request or a permission
 * registration), prepareOwner refuses another withdrawal, resume request or
 * permission with 409 "Refresh the pending owner transaction before preparing
 * another.", until it is final or provably expired (its blockhash's last valid
 * height passed), usually within a few minutes. Replacing it would lose the
 * record its outcome is booked from. A revocation is never held back by it:
 * the server prepares it beside the pending record (owner decision option A,
 * ownerTransaction.revoke), and each is settled and booked by its own
 * signature. Only a pending revocation, in either place, holds back every
 * owner action, another revocation included. A revocation that already landed
 * beside a still-pending record holds back another beside it (the server keeps
 * that record: the pending one's expiry proof counts it): every session it
 * covered is revoked, and Revoke returns once the pending record resolves. So
 * the page holds back what the server would refuse, says why, and offers a
 * check instead.
 *
 * It does not always resolve within minutes. The server settles a record
 * only on two providers' agreeing outcome, and leaves it pending when they
 * disagree, when its expiry cannot be proven, or when its read fails
 * (OWNER_CONFIRMATION_UNAVAILABLE). When the status says the read failed, or
 * this page's reads have reported the same record pending for
 * OWNER_PENDING_STUCK_MS, the page says plainly that the server cannot settle
 * it yet, and points to the recovery card's step 2 when the page shows one.
 * Without the card (key export is off by default) it names no tool: without
 * an exported owner key there is nothing to sign with outside Merrymen. A
 * stuck withdrawal or resume request never holds back the revocation; an
 * operator settles it from finalized evidence (npm run solana:resolve -- owner).
 *
 * REVIEWED BEFORE THE WALLET OPENS. A press prepares the transaction and the
 * page checks its bytes; nothing is signed until the owner has seen what it
 * does, its priority fee and what the owner wallet must hold, and chosen
 * "Sign with my wallet" within OWNER_REVIEW_SIGN_WINDOW_MS. OWNER DECISION:
 * a revocation is reviewed too, one extra click in an emergency, so its fee
 * is never seen only in the wallet's own window. (The alternative signs a
 * revocation straight after the check, with the fee shown while the wallet
 * is open: drop `revoke` from the review in run().) Pressing another action
 * replaces the review, as its prepare replaces the server's prepared bytes.
 *
 * Signed bytes this page holds with an unknown outcome do not by themselves
 * hold back a revocation: if the server never saved them, a revocation
 * replaces them and they can no longer be sent; if it did, the revocation is
 * prepared beside them (a revocation's own bytes are resubmitted instead).
 */
export function SolanaOwnerActions({ available, owner, programId, api, sign, refresh, readRecord, serverTransaction = null, ownerWallet = null, recoverable = null,
  confirmationUnavailable = false, recovery = null }: {
  available: boolean;
  /** The bound owner wallet and the vault program the status names: what the prepared bytes must be for. */
  owner: string | null; programId: string | null;
  api: SolanaApi; sign: (bytes: Uint8Array) => Promise<Uint8Array>; refresh: () => Promise<void>;
  /** Reads the server's saved owner transaction afresh (and updates the screen). */
  readRecord: () => Promise<OwnerRecord>;
  /** The server's saved owner transaction from the last status read. */
  serverTransaction?: OwnerRecord;
  ownerWallet?: OwnerWallet | null;
  recoverable?: RecoverableSol | null;
  /** The last status read could not read the pending record's outcome (OWNER_CONFIRMATION_UNAVAILABLE). */
  confirmationUnavailable?: boolean;
  /** The recovery card's step 2 on this page: the signing command ("send"), the read-only plan, or no card. */
  recovery?: RecoveryOffer;
}) {
  const [mint, setMint] = useState(SOLANA_USDG_MINT as string), [amount, setAmount] = useState("1"), [solAmount, setSolAmount] = useState("");
  // `sent`: an earlier submission of these bytes reached the server, or may have.
  const [pending, setPending] = useState<{ action: OwnerAction; signedTransactionBase64: string; signature: string | null; sent: boolean } | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  // A paced answer (pacedAnswer): a wait, not a failure.
  const [notice, setNotice] = useState("");
  // Bytes cleared without a known outcome, linked so the owner can check Solana itself.
  const [cleared, setCleared] = useState<{ action: OwnerAction; signature: string } | null>(null);
  const [review, setReview] = useState<OwnerReview | null>(null), [lapsed, setLapsed] = useState<OwnerAction | null>(null);
  // Signatures of withdrawals the owner made outside Merrymen, to record (recordOutside).
  const [outside, setOutside] = useState("");
  const [, setReviewClock] = useState(0);
  // True while the owner's wallet is open on the reviewed bytes (signReview).
  const signingReview = useRef(false);
  const inFlight = useRef(false);
  const serverPending = serverTransaction?.status === "pending" ? serverTransaction : null;
  // A revocation the server saved beside its main record (its revoke slot), pending.
  const serverRevoke = serverTransaction?.revoke?.status === "pending" ? serverTransaction.revoke : null;
  // What the server refuses to prepare now: a revocation only while one is pending (in either place),
  // anything else while any owner transaction is pending.
  // A revocation beside the server's pending record that already landed: the server keeps its record and
  // prepares no other beside it (SOLANA_REVOKE_ALREADY_LANDED) until the pending record resolves, unless a
  // permission registered on Solana after it is live (revokeAgain): then Revoke works again.
  const revokeLanded = !!serverPending && serverPending.kind !== "revoke" && serverTransaction?.revoke?.status === "finalized" && !serverTransaction.revoke.revokeAgain;
  const revokeHeld = serverPending?.kind === "revoke" || !!serverRevoke || revokeLanded, anyServerPending = !!serverPending || !!serverRevoke;
  // When this page's status reads first and last reported the same pending record (each read is a new record object).
  const [seen, setSeen] = useState<{ signature: string; first: number; last: number } | null>(null);
  useEffect(() => {
    if (serverTransaction?.status !== "pending") { setSeen(null); return; }
    const at = Date.now(), signature = serverTransaction.signature;
    setSeen((prior) => prior?.signature === signature ? { ...prior, last: at } : { signature, first: at, last: at });
  }, [serverTransaction]);
  const longPending = !!serverPending && seen?.signature === serverPending.signature && seen.last - seen.first >= OWNER_PENDING_STUCK_MS;
  const stuck = !!serverPending && (confirmationUnavailable || longPending);
  // A review not signed in time is discarded: its bytes would reach the server too late. Not while the
  // wallet is open on it: the owner may be signing, and the server's own window decides those bytes.
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(() => { if (signingReview.current) return; setReview(null); setLapsed(review.action); }, Math.max(0, review.deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [review]);
  // The review says how long is left to sign: re-render it every second while it is open, so it counts down.
  useEffect(() => {
    if (!review) return;
    const timer = setInterval(() => setReviewClock((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, [review]);
  /** Shows why a request did not finish: a paced answer as a wait, anything else as a failure. */
  const fail = (e: unknown, fallback: string) => {
    const paced = pacedAnswer(e);
    if (paced !== null) setNotice(paced); else setError(e instanceof Error ? e.message : fallback);
  };
  const begin = (work: () => Promise<void>) => {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError(""); setNotice(""); setLapsed(null);
    void work().catch((e: unknown) => fail(e, "The owner action did not finish. Retry the existing transaction."))
      .finally(() => { inFlight.current = false; setBusy(false); });
  };
  /** Submits signed bytes (again): the server answers a resubmission from its record of them. */
  const submit = async (saved: NonNullable<typeof pending>) => {
    const name = ACTION_NAMES[saved.action];
    let next: ActionResult, recorded = false;
    try { ({ result: next } = await api<{ result: ActionResult }>("owner", { stage: "submit", signedTransactionBase64: saved.signedTransactionBase64 })); }
    catch (e) {
      if (!refusedByServer(e)) { setPending({ ...saved, sent: true }); throw e; }
      if (!saved.sent && savedNothing(e)) {
        // The first submission of these bytes, and the server says this request saved nothing: they were never saved.
        setPending(null); void refresh().catch(() => undefined);
        throw new Error(`${e.message} This signed ${name} was not accepted and has been discarded. Start it again to review and sign a new one.`);
      }
      // A retry, or a refusal that does not say it saved nothing: the server's record decides.
      const outcome = await outcomeAfterRefusal(readRecord, saved.signature);
      if (outcome === "unknown") {
        setPending({ ...saved, sent: true });
        throw new Error(`${e.message} ${saved.sent ? `An earlier submission of this signed ${name} may already be on Solana` : `The server could not say whether it saved this signed ${name}`}, so it was kept. This does not mean it failed. Check it again shortly.`);
      }
      if (outcome === "pending") {
        setPending({ ...saved, sent: true });
        if (saved.signature) setResult({ signature: saved.signature, status: "pending" });
        throw new Error(`${e.message} The server holds this signed ${name} and still records it as awaiting confirmation, so it was kept. It may already have completed on Solana. Check it again shortly.`);
      }
      if (outcome === "unheld") {
        setPending(null); setResult(null);
        if (!saved.sent) throw new Error(`${e.message} The server holds no record of this signed ${name}, so it has been discarded. Start it again to review and sign a new one.`);
        if (saved.signature) setCleared({ action: saved.action, signature: saved.signature });
        throw new Error(`${e.message} The server holds no record of this signed ${name}, so it was cleared and cannot be resent. If an earlier submission reached Solana, its result shows on Solana and in your vault balances. ${savedNothing(e) ? "Check there before starting it again to review and sign a new one." : "Check before starting another."}`);
      }
      // The server's record settles it: reading it already refreshed the screen.
      next = { signature: saved.signature!, status: outcome }; recorded = true;
    }
    // The server returned its record of these bytes: they were accepted.
    const accepted = { ...saved, signature: next.signature, sent: true };
    setResult(next);
    // Pending or not, the server's record changed: read it, so the page shows
    // what the server will now refuse (see SolanaOwnerActions above).
    if (next.status !== "pending") { setPending(null); if (!recorded) await refresh(); }
    else { setPending(accepted); await refresh().catch(() => undefined); }
  };
  const run = (action: OwnerAction) => begin(async () => {
    // Saved bytes are only ever resubmitted for their own action. Any other
    // action prepares fresh bytes; the server refuses that while the earlier
    // transaction is saved and unresolved, and otherwise the earlier one can
    // no longer be submitted once this one is prepared.
    if (pending?.action === action) return submit(pending);
    // A new prepare replaces whatever the server prepared for an open review.
    setReview(null);
    if (!owner || !programId) throw new Error("Connect the Solana wallet bound to this account and wait for the vault program to be verified.");
    const request: OwnerRequest = action === "withdraw" ? { action, mint, amountRaw: solanaUnits(amount, mint === SOLANA_USDG_MINT ? 6 : 9) }
      // Native lamports held by the vault account above its rent reserve (withdraw_sol).
      : action === "withdraw-sol" ? { action, amountRaw: solanaUnits(solAmount, 9) }
      : { action };
    // Timed on this clock from before the request, so latency only shortens the window to sign.
    const started = Date.now();
    let prepared: PreparedOwnerTransaction;
    try { ({ prepared } = await api<{ prepared: PreparedOwnerTransaction }>("owner", { stage: "prepare", ...request })); }
    catch (e) {
      // Refused before anything was signed (another owner transaction is
      // still pending, say): show the server's record of why.
      if (refusedByServer(e)) await refresh().catch(() => undefined);
      throw e;
    }
    // The wallet only opens for bytes that do exactly what the owner asked; the fee shown is the one they carry.
    const fee = await checkPreparedOwnerTransaction(prepared, request, { owner, programId });
    // Nothing is signed yet: the owner reviews what the bytes do and cost first.
    setReview({ action, request, transactionBase64: prepared.transactionBase64, fee: fee !== "0" ? sol(fee) : null,
      required: sol(prepared.requiredLamports), held: sol(prepared.ownerLamports), deadline: started + OWNER_REVIEW_SIGN_WINDOW_MS });
  });
  /** The owner signs exactly the reviewed bytes, then they are submitted. */
  const signReview = () => begin(async () => {
    const shown = review;
    if (!shown) throw new Error("Start the owner action again to prepare a transaction to review.");
    if (Date.now() >= shown.deadline) {
      setReview(null); setLapsed(shown.action);
      throw new Error(`This prepared ${ACTION_NAMES[shown.action]} was not signed in time, so it was discarded. Nothing was signed. Start it again to prepare a new one.`);
    }
    // While the wallet is open the review timer leaves the review alone. A
    // wallet that refuses or closes leaves the review to sign again, unless
    // its deadline passed meanwhile: then it lapses now. Signed bytes are
    // submitted even if the deadline passed meanwhile: the server's window
    // decides, and its notSaved refusal of a first submission discards them.
    signingReview.current = true;
    let signed: Uint8Array;
    try { signed = await sign(Uint8Array.from(atob(shown.transactionBase64), (c) => c.charCodeAt(0))); }
    catch (e) {
      if (Date.now() >= shown.deadline) { setReview(null); setLapsed(shown.action); }
      throw e;
    } finally { signingReview.current = false; }
    const signedTransactionBase64 = btoa(String.fromCharCode(...signed));
    const saved = { action: shown.action, signedTransactionBase64, signature: signatureOf(signedTransactionBase64), sent: false };
    // Kept before submit: a lost answer resubmits these exact bytes, never signs a second transaction.
    setPending(saved); setResult(null); setCleared(null); setReview(null);
    await submit(saved);
  });
  /**
   * WITHDRAWALS MADE OUTSIDE MERRYMEN. Any wallet or tool holding the owner key
   * (solana-recover, for one) withdraws without this server, which leaves the vault below its
   * recorded balances: trading, exits and withdrawals of that asset are held
   * until the records match. The server records each withdrawal from its own
   * transaction, read on two providers; nothing is signed or sent here.
   */
  const recordOutside = () => begin(async () => {
    const signatures = outside.split(/[\s,]+/).filter(Boolean);
    const { recorded } = await api<{ recorded: { booked: Array<{ signature: string; mint: string; amountRaw: string }> } }>("owner", { stage: "record", action: "external-withdrawals", signatures });
    setOutside("");
    setNotice(`Recorded your withdrawal${recorded.booked.length === 1 ? "" : "s"} made outside Merrymen: ${recorded.booked.map((item) => item.mint === SOLANA_USDG_MINT
      ? `${displaySolanaAmount(item.amountRaw, 6)} USDG` : `${displaySolanaAmount(item.amountRaw, 9)} wrapped SOL`).join(", ")}.`);
    await refresh().catch(() => undefined);
  });
  /** The server's pending record when this page does not hold its bytes (another device, a reload, a permission). */
  const check = () => {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError(""); setNotice("");
    void refresh().catch((e: unknown) => fail(e, "The owner transaction could not be checked. Try again shortly."))
      .finally(() => { inFlight.current = false; setBusy(false); });
  };
  const held = sol(ownerWallet?.lamports), revokeNeeds = sol(ownerWallet?.revokeLamports), withdrawNeeds = sol(ownerWallet?.withdrawLamports);
  const short = !!ownerWallet && !!held && !!revokeNeeds && !!withdrawNeeds && BigInt(ownerWallet.lamports) < BigInt(ownerWallet.revokeLamports);
  const native = sol(recoverable?.nativeLamports), unsynced = sol(recoverable?.unsyncedWsolLamports);
  const pendingIsServers = !!pending && ((!!serverPending && pending.signature === serverPending.signature) || (!!serverRevoke && pending.signature === serverRevoke.signature));
  /** What the server holds back while `kind` is pending, in the owner's words. */
  const holds = (kind: string | undefined) => kind === "revoke" ? "the server prepares no other owner transaction, a revocation included"
    : revokeLanded ? "the server prepares no other owner transaction: your revocation beside it already landed, so every session it covered is revoked, and no permission has registered since"
    : revokeHeld ? "the server prepares no other owner transaction, and the revocation beside it is pending too"
    : "the server prepares no other withdrawal, resume request or permission; revoking stays available and is prepared beside it";
  return <div className="solana-card" aria-busy={busy}><h2>Owner controls</h2>
    <p>Your wallet must sign every revocation and withdrawal. Token withdrawals return to your own token accounts; native SOL returns to your owner wallet.</p>
    {held && revokeNeeds && withdrawNeeds && <p>Your owner wallet holds {held} SOL and pays the network fees of these transactions. To revoke it must hold at least {revokeNeeds} SOL; to withdraw, up to {withdrawNeeds} SOL, since a withdrawal may open your token account. Merrymen adds a priority fee only from SOL beyond that, and this page signs none above {sol(OWNER_MAX_PRIORITY_FEE_LAMPORTS.toString())} SOL.</p>}
    {short && <p role="alert" className="solana-warning">That is too little to revoke. Send SOL to your owner wallet now, so you can revoke or withdraw in an emergency.</p>}
    {error && <p role="alert" className="solana-error">{error}</p>}
    {notice && <p role="status" className="solana-notice">{notice}</p>}
    {serverPending && stuck ? <p role="status">{confirmationUnavailable
      ? `Your ${kindName(serverPending.kind)} is awaiting final confirmation, and the server cannot read its outcome from Solana right now.`
      : `Your ${kindName(serverPending.kind)} has been awaiting final confirmation for over ${OWNER_PENDING_STUCK_MS / 60_000} minutes, well past the minute or so its blockhash lasts: the server has not been able to settle its outcome.`}
      {" "}Until it does, {holds(serverPending.kind)}, and this may not resolve by itself.{" "}
      {recovery === "send" ? "Step 2 of the owner key card below revokes every session and withdraws your vault with your offline owner key, without this server."
        : recovery === "plan" ? "Step 2 of the owner key card below shows your vault and its session without this server."
        : "Check it again later. If it stays this way, Merrymen has to fix how the server reads Solana: nothing on this page can settle it."}
      {" "}<a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(serverPending.signature)}`}>View it on Solana</a></p>
      : serverPending && !(pendingIsServers && pending?.signature === serverPending.signature) && <p role="status">Your {kindName(serverPending.kind)} is awaiting final confirmation on Solana. Until it is final, or its blockhash expires (usually within a few minutes), {holds(serverPending.kind)}. <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(serverPending.signature)}`}>View it on Solana</a></p>}
    {serverRevoke && !(pendingIsServers && pending?.signature === serverRevoke.signature) && <p role="status">Your revocation is awaiting final confirmation on Solana. Until it is final, or its blockhash expires (usually within a few minutes), the server prepares no other owner transaction, a revocation included. <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(serverRevoke.signature)}`}>View it on Solana</a></p>}
    {anyServerPending && !pending && <button disabled={busy || !available} onClick={check}>Check owner transaction</button>}
    <fieldset disabled={busy || !available}><legend>Vault recovery</legend>
      <button disabled={revokeHeld} onClick={() => run("revoke")}>Revoke all Solana sessions</button>
      <button disabled={!!pending || anyServerPending} onClick={() => run("resume-buys")}>Ask wallet to resume buys</button>
      <p>Resuming buys keeps the existing risk limits and portfolio high-water mark. If the drawdown still exceeds your limit, buying pauses again.</p>
      <label>Asset<select value={mint} onChange={(e) => setMint(e.target.value)}><option value={SOLANA_USDG_MINT}>USDG</option><option value={WSOL}>Wrapped SOL</option></select></label>
      <label>Amount to withdraw<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      <button disabled={!!pending || anyServerPending} onClick={() => run("withdraw")}>Withdraw to my wallet</button>
      {unsynced && unsynced !== "0" && <p>{unsynced} SOL was sent to the vault&apos;s wrapped SOL account without being wrapped. A wrapped SOL withdrawal wraps it first and can include it.</p>}
      {native && <p>The vault account holds {native} SOL above its rent reserve. It is never traded or counted in performance; withdraw it to your owner wallet here.</p>}
      <label>Native SOL to withdraw<input inputMode="decimal" value={solAmount} onChange={(e) => setSolAmount(e.target.value)} /></label>
      <button disabled={!!pending || anyServerPending} onClick={() => run("withdraw-sol")}>Withdraw native SOL</button>
    </fieldset>
    <details><summary>Withdrew outside Merrymen?</summary>
      <p>If you withdrew from your vault outside Merrymen, with your owner key in another wallet or tool, Merrymen&apos;s records still count those funds, and trading, exits and withdrawals of that asset stay held while the vault holds less. Paste those transactions&apos; signatures (up to eight) to record them. Each is read on Solana from two providers, and only an owner withdrawal from your own vault is recorded; nothing is signed or sent.</p>
      <label>Withdrawal transaction signatures<textarea value={outside} onChange={(e) => setOutside(e.target.value)} /></label>
      <button disabled={busy || !available || !outside.trim()} onClick={recordOutside}>Record these withdrawals</button>
    </details>
    {review && <div className="solana-review" role="group" aria-label={`Review the prepared ${ACTION_NAMES[review.action]}`}>
      <p>Review before your wallet opens: the prepared {ACTION_NAMES[review.action]} {reviewedEffect(review.request)}, and nothing else.</p>
      <p>{review.fee ? `It carries a priority fee of ${review.fee} SOL (at most ${sol(OWNER_MAX_PRIORITY_FEE_LAMPORTS.toString())} SOL), paid by your owner wallet with the network fee so it lands under congestion.`
        : "It carries no priority fee: your owner wallet pays only the network fee."}</p>
      {review.required && <p>The prepared {ACTION_NAMES[review.action]} needs your owner wallet to hold at least {review.required} SOL{review.held ? ` (it holds ${review.held} SOL)` : ""}: its network fee{review.fee ? `, a priority fee of ${review.fee} SOL so it lands under congestion` : ""}, any token account it opens, and the wallet&apos;s own minimum balance.</p>}
      <p>Nothing has been signed yet. Sign within about {secondsUntil(review.deadline)}, or start it again to prepare a new one.</p>
      <button disabled={busy || !available || (review.action === "revoke" ? revokeHeld : anyServerPending)} onClick={signReview}>Sign with my wallet</button>
      <button className="solana-secondary" disabled={busy} onClick={() => setReview(null)}>Discard</button>
    </div>}
    {!review && lapsed && <p role="status">The prepared {ACTION_NAMES[lapsed]} was not signed in time, so it was discarded. Nothing was signed. Start it again to prepare a new one.</p>}
    {pending && <p role="status">{pendingIsServers
      ? `A signed ${ACTION_NAMES[pending.action]} is awaiting final confirmation on Solana. Until it is final or expired, ${pending.action !== "revoke" && revokeLanded
        ? "no other owner transaction can be prepared: your revocation beside it already landed, so every session it covered is revoked, and no permission has registered since"
        : pending.action === "revoke" || revokeHeld
        ? "no other owner transaction can be prepared, a revocation included" : "no other withdrawal or resume request can be prepared; revoking stays available and is prepared beside it"}.${stuck ? "" : " Check it shortly."}`
      // A pending revocation on the server (another device or tab) holds Revoke back: never promise it here.
      : revokeLanded ? `A signed ${ACTION_NAMES[pending.action]} has no confirmed outcome yet. Check it before signing another withdrawal or resume request. Your revocation beside the server's pending ${kindName(serverPending!.kind)} above already landed; you can revoke again once that resolves.`
      : revokeHeld ? `A signed ${ACTION_NAMES[pending.action]} has no confirmed outcome yet. Check it before signing another withdrawal or resume request. Revoking waits for the server's pending revocation above: it can be prepared once that is final or expired.`
      : serverPending ? `A signed ${ACTION_NAMES[pending.action]} has no confirmed outcome yet. Check it before signing another withdrawal or resume request. Revoking stays available: it is prepared beside the server's pending ${kindName(serverPending.kind)} above.`
      : `A signed ${ACTION_NAMES[pending.action]} has no confirmed outcome yet. Check it before signing another withdrawal or resume request. Revoking stays available: if the server never saved this ${ACTION_NAMES[pending.action]}, a revocation replaces it and it can no longer be sent; if the server saved it, a revocation is prepared beside it.`}</p>}
    {pending && <button disabled={busy || !available} onClick={() => run(pending.action)}>Check existing owner transaction</button>}
    {cleared && !pending && <p role="status"><a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(cleared.signature)}`}>Check this {ACTION_NAMES[cleared.action]} on Solana</a></p>}
    {result && <p role="status">Owner transaction: {result.status}. <a target="_blank" rel="noreferrer" href={`https://solscan.io/tx/${encodeURIComponent(result.signature)}`}>View transaction</a></p>}
  </div>;
}
