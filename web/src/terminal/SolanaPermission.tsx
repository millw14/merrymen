"use client";
/**
 * WHAT THE OWNER'S WALLET IS ASKED TO SIGN, READ FROM THE BYTES.
 *
 * The server builds the session permission from the SAVED limits, never from
 * the form. The page used to show the form (unsaved edits, and a duration that
 * reset to 24 hours on every load) while the wallet signed something else. Now
 * the live card shows the saved limits with their absolute expiry, and before
 * the wallet opens, the prepared transaction is decoded here and must encode
 * exactly those limits, for this owner, vault, program and session key, with
 * nothing else in it beyond creating the vault and its token accounts and a
 * priority fee the owner pays, at most OWNER_MAX_PRIORITY_FEE_LAMPORTS, on a
 * compute budget no smaller than the runtime's default for it.
 * checkPreparedPermission is that whole check; SolanaServerContract.test.ts
 * runs the server's real prepareLive bytes through it.
 */
import { getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { base58Encode, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../../packages/core/src/ids";
import type { SolanaPaperLimits } from "../../../packages/core/src/solana";
import { displaySolanaAmount, displaySolanaAmountOrNull } from "../lib/solana-amounts";

const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const CLASSIC_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** The token program each token account the permission may open belongs to. */
const TOKEN_PROGRAM_OF: Readonly<Record<string, string>> = { [SOLANA_USDG_MINT]: TOKEN_2022_PROGRAM, [WRAPPED_SOL]: CLASSIC_TOKEN_PROGRAM };
// Anchor discriminators of the vault program (packages/core/src/solana-live.ts).
const INITIALIZE = [48, 191, 163, 44, 71, 129, 63, 164];
const CREATE_SESSION = [242, 193, 143, 179, 150, 25, 122, 227];
const SESSION_DATA_LENGTH = 8 + 32 + 8 * 4 + 2 + 8;
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
/**
 * The most priority fee the server may put on an owner transaction: 0.001 SOL.
 * The same cap as SOLANA_OWNER_MAX_PRIORITY_FEE_LAMPORTS in
 * worker/src/solana-app-runtime.ts (a test keeps the two equal).
 */
export const OWNER_MAX_PRIORITY_FEE_LAMPORTS = 1_000_000n;
/**
 * The least compute-unit limit an owner transaction may carry: what the
 * runtime gives its instructions with no limit at all (200,000 each, other
 * than ComputeBudget, at most 1,400,000). The server never signs less
 * (solanaOwnerComputeUnitLimit in worker/src/solana-app-runtime.ts); a lower
 * one, from an under-reported simulation, could make a permission, a
 * revocation or a withdrawal run out of compute on chain, the owner paying
 * the fee each time.
 */
export const OWNER_DEFAULT_UNITS_PER_INSTRUCTION = 200_000n;
const MAX_COMPUTE_UNITS = 1_400_000n;

export type SignedPermissionTerms = {
  perTradeUsdg: string; dailyUsdg: string; perTradeWsol: string; dailyWsol: string; maxOpsPerDay: number; expiresAtSeconds: string;
  /** The priority fee the owner pays on top of the signature fee, in lamports ("0" without one). */
  priorityFeeLamports: string;
};
const NOT_SIGNED = "The prepared permission does not match what this page shows. Nothing was signed. Refresh and review your saved limits.";
function refuse(): never { throw new Error(NOT_SIGNED); }
function startsWith(data: Uint8Array, prefix: readonly number[]) { return data.length >= prefix.length && prefix.every((byte, index) => data[index] === byte); }

/** One instruction of an owner-paid transaction: its program, data and account addresses. */
export type OwnerPaidInstruction = { program: string; data: Uint8Array; accounts: string[] };
/**
 * AN OWNER-PAID TRANSACTION AS ITS BYTES SAY, OR NULL WHEN THE PAGE CANNOT VOUCH FOR IT.
 *
 * What every owner transaction the page lets the wallet sign shares, a
 * permission registration (readPermissionTransaction) or an owner action
 * (SolanaOwnerActions.checkPreparedOwnerTransaction): a v0 message the owner
 * pays for and alone signs, loading nothing from lookup tables, with at most
 * one SetComputeUnitLimit and one SetComputeUnitPrice (both or neither,
 * touching no account) whose limit is no less than the runtime would give
 * the other instructions without one (OWNER_DEFAULT_UNITS_PER_INSTRUCTION)
 * and whose priority fee is at most OWNER_MAX_PRIORITY_FEE_LAMPORTS. Returns
 * the other instructions in order and that fee, in lamports: what the runtime
 * charges, ceil(price × limit / 1e6).
 */
export function readOwnerPaidTransaction(transactionBase64: string, owner: string): { instructions: OwnerPaidInstruction[]; priorityFeeLamports: bigint } | null {
  let message: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    const transaction = getTransactionDecoder().decode(Uint8Array.from(atob(transactionBase64), (c) => c.charCodeAt(0)));
    message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  } catch { return null; }
  const keys = message.staticAccounts.map(String);
  // The owner pays and is the only signer; nothing is loaded from lookup tables.
  if (message.version !== 0 || message.addressTableLookups?.length || keys[0] !== owner || message.header.numSignerAccounts !== 1) return null;
  const instructions: OwnerPaidInstruction[] = [];
  let unitLimit: bigint | null = null, unitPrice: bigint | null = null;
  for (const instruction of message.instructions) {
    const program = keys[instruction.programAddressIndex];
    const data = Uint8Array.from(instruction.data ?? []);
    const accounts = (instruction.accountIndices ?? []).map((index) => keys[index]);
    if (program === undefined || accounts.some((account) => account === undefined)) return null;
    if (program === COMPUTE_BUDGET_PROGRAM) {
      // A priority fee: one SetComputeUnitLimit and one SetComputeUnitPrice, touching no account.
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (accounts.length === 0 && data.length === 5 && data[0] === 2 && unitLimit === null) { unitLimit = BigInt(view.getUint32(1, true)); continue; }
      if (accounts.length === 0 && data.length === 9 && data[0] === 3 && unitPrice === null) { unitPrice = view.getBigUint64(1, true); continue; }
      return null;
    }
    instructions.push({ program, data, accounts: accounts as string[] });
  }
  if ((unitLimit === null) !== (unitPrice === null)) return null;
  // Never a smaller compute budget than the transaction would have without a priority fee.
  const work = BigInt(instructions.length) * OWNER_DEFAULT_UNITS_PER_INSTRUCTION;
  if (unitLimit !== null && unitLimit < (work < MAX_COMPUTE_UNITS ? work : MAX_COMPUTE_UNITS)) return null;
  const priorityFeeLamports = unitLimit !== null && unitPrice !== null ? (unitPrice * unitLimit + 999_999n) / 1_000_000n : 0n;
  return priorityFeeLamports > OWNER_MAX_PRIORITY_FEE_LAMPORTS ? null : { instructions, priorityFeeLamports };
}

/** Decodes the prepared registration and returns the limits it would sign, or refuses. */
export function readPermissionTransaction(transactionBase64: string, expected: { owner: string; programId: string; vault: string; session: string }): SignedPermissionTerms {
  const decoded = readOwnerPaidTransaction(transactionBase64, expected.owner);
  if (!decoded) return refuse();
  let terms: Omit<SignedPermissionTerms, "priorityFeeLamports"> | null = null;
  for (const { program, data, accounts } of decoded.instructions) {
    // CreateIdempotent for the owner's and the vault's USDG and wrapped SOL
    // accounts, paid by the owner: funder, account, wallet, mint, the system
    // program and that mint's token program, nothing more. The associated
    // token program itself refuses an account not derived from those.
    if (program === ASSOCIATED_TOKEN_PROGRAM && data.length === 1 && data[0] === 1 && accounts.length === 6 && accounts[0] === expected.owner
      && (accounts[2] === expected.owner || accounts[2] === expected.vault) && Object.hasOwn(TOKEN_PROGRAM_OF, accounts[3] ?? "")
      && accounts[4] === SYSTEM_PROGRAM && accounts[5] === TOKEN_PROGRAM_OF[accounts[3]!]) continue;
    if (program === expected.programId && data.length === INITIALIZE.length && startsWith(data, INITIALIZE)
      && accounts.length === 3 && accounts[0] === expected.vault && accounts[1] === expected.owner && accounts[2] === SYSTEM_PROGRAM) continue;
    if (program === expected.programId && !terms && data.length === SESSION_DATA_LENGTH && startsWith(data, CREATE_SESSION)
      && accounts.length === 2 && accounts[0] === expected.vault && accounts[1] === expected.owner) {
      if (base58Encode(data.slice(8, 40)) !== expected.session) refuse();
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      terms = { perTradeUsdg: view.getBigUint64(40, true).toString(), dailyUsdg: view.getBigUint64(48, true).toString(),
        perTradeWsol: view.getBigUint64(56, true).toString(), dailyWsol: view.getBigUint64(64, true).toString(),
        maxOpsPerDay: view.getUint16(72, true), expiresAtSeconds: view.getBigInt64(74, true).toString() };
      continue;
    }
    refuse();
  }
  if (!terms) return refuse();
  return { ...terms, priorityFeeLamports: decoded.priorityFeeLamports.toString() };
}

/** What the setup route's prepare answers for a permission registration. */
export type PreparedPermission = { transactionBase64: string; programId: string; vault: string; session: string; expiresAtMs: number;
  requiredLamports?: string; ownerLamports?: string; priorityFeeLamports?: string };

/**
 * THE PAGE'S WHOLE CHECK OF A PREPARED PERMISSION, BEFORE THE WALLET OPENS.
 *
 * The answer must name the session key this page generated and the vault it
 * derived for this owner and program; the bytes must encode exactly the saved
 * limits shown (readPermissionTransaction, permissionMatchesLimits); and a
 * priority fee the server states must be the one the bytes carry. Returns the
 * decoded terms to show, or throws: nothing reaches the wallet.
 */
export function checkPreparedPermission(setup: PreparedPermission, expected: { owner: string; programId: string; vault: string; session: string }, limits: SolanaPaperLimits): SignedPermissionTerms {
  if (setup.session !== expected.session) throw new Error("The prepared permission names a different session. Nothing was signed.");
  if (setup.programId !== expected.programId || setup.vault !== expected.vault) throw new Error("The prepared permission names a different vault. Nothing was signed.");
  const terms = readPermissionTransaction(setup.transactionBase64, expected);
  if (!permissionMatchesLimits(terms, limits)) throw new Error("The prepared permission does not match the saved limits shown on this page. Nothing was signed. Refresh and review your limits.");
  // The fee shown is the one decoded from the bytes; a server that says otherwise is not believed.
  if (setup.priorityFeeLamports !== undefined && setup.priorityFeeLamports !== terms.priorityFeeLamports) throw new Error("The prepared permission's fee does not match its bytes. Nothing was signed. Refresh and register again.");
  return terms;
}

/** True only when the signed terms are exactly the saved limits the page showed. */
export function permissionMatchesLimits(terms: SignedPermissionTerms, limits: SolanaPaperLimits): boolean {
  return terms.perTradeUsdg === limits.perTradeUsdg && terms.dailyUsdg === limits.dailyUsdg
    && terms.perTradeWsol === limits.perTradeWsol && terms.dailyWsol === limits.dailyWsol
    && terms.maxOpsPerDay === limits.maxOpsPerDay && terms.expiresAtSeconds === String(Math.floor(limits.expiresAtMs / 1000));
}

/** The whole seconds left until `deadline`, never fewer than one, in words: "1 second", never "1 seconds". */
export function secondsUntil(deadline: number): string {
  const seconds = Math.max(1, Math.round((deadline - Date.now()) / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

/** The on-chain expiry is whole seconds; show exactly that instant, in UTC. */
export function permissionExpiry(expiresAtMs: number): string {
  return `${new Date(Math.floor(expiresAtMs / 1000) * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function PermissionTerms({ limits, heading }: { limits: SolanaPaperLimits; heading: string }) {
  const hours = (limits.expiresAtMs - Date.now()) / 3_600_000;
  return <div className="solana-terms"><h3>{heading}</h3><ul>
    <li>{displaySolanaAmount(limits.perTradeUsdg)} USDG per trade and {displaySolanaAmount(limits.dailyUsdg)} USDG per 24 hours</li>
    {limits.perTradeWsol && limits.dailyWsol && <li>{displaySolanaAmount(limits.perTradeWsol, 9)} SOL sold per trade and {displaySolanaAmount(limits.dailyWsol, 9)} SOL sold per 24 hours</li>}
    <li>At most {limits.maxOpsPerDay} trades per 24 hours</li>
    <li>Expires {permissionExpiry(limits.expiresAtMs)}{hours > 0 ? ` (in about ${hours < 1 ? "less than an hour" : `${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}`})` : " (expired)"}</li>
  </ul><p>The {limits.maxDrawdownBps / 100}% maximum drawdown is enforced by the Merrymen trading service, not by the on-chain permission.</p></div>;
}

/**
 * THE PREPARED PERMISSION, AS ITS BYTES SAY, BEFORE THE WALLET OPENS.
 *
 * Shown between prepare and signing: the limits decoded from the bytes (they
 * equal the saved limits, or nothing reaches this point), the priority fee the
 * bytes carry (decoded, never the server's claim) and what the server says the
 * owner wallet must hold to send it, rent for the accounts it opens included.
 */
export function PermissionReview({ limits, terms, requiredLamports, ownerLamports, secondsLeft }: {
  limits: SolanaPaperLimits; terms: SignedPermissionTerms; requiredLamports: string | null; ownerLamports: string | null; secondsLeft: number;
}) {
  const fee = displaySolanaAmountOrNull(terms.priorityFeeLamports, 9), required = displaySolanaAmountOrNull(requiredLamports, 9), held = displaySolanaAmountOrNull(ownerLamports, 9);
  return <div className="solana-review">
    <PermissionTerms heading="Review before your wallet opens: the prepared permission encodes these limits" limits={limits} />
    <p>{terms.priorityFeeLamports === "0" || !fee ? "It carries no priority fee: your owner wallet pays only the network signature fee."
      : `It carries a priority fee of ${fee} SOL (at most ${displaySolanaAmount(OWNER_MAX_PRIORITY_FEE_LAMPORTS.toString(), 9)} SOL), paid by your owner wallet with the signature fee so it lands under congestion.`}</p>
    {required && <p>To send it your owner wallet must hold at least {required} SOL{held ? ` (it holds ${held} SOL)` : ""}, including rent for any vault and token accounts it opens.</p>}
    <p>Nothing has been signed yet. Sign within about {secondsLeft} second{secondsLeft === 1 ? "" : "s"}, or register again to prepare a new one.</p>
  </div>;
}

