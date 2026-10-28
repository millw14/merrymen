/**
 * One provider's reading of an owner withdrawal made outside Merrymen (the
 * owner's own key: solana-recover, another wallet), for OWNER WITHDRAWALS MADE
 * OUTSIDE MERRYMEN in solana-trading-store.ts. Read-only; the caller asks two
 * providers and books only what both derive identically (readSolanaQuorum).
 *
 * Accepted: a finalized, successful transaction, without address lookup
 * tables, whose top-level instructions to the vault program are only the
 * owner's own (withdraw, withdraw_sol, revoke_all, set_breaker), whose every
 * token withdraw is for this vault and owner (a signer of the transaction) from
 * the vault's own token account of USDG or wrapped SOL, and which no inner
 * instruction reaches the vault program from. What it books per mint is the
 * vault token account's net decrease in it (pre minus post token balance):
 * exactly the withdrawn USDG; for wrapped SOL at most the withdrawn amount (a
 * permissionless SyncNative in the same transaction may wrap native SOL first,
 * which never was in the book). A token account the vault program did not
 * withdraw from must not change. Anything else is refused: nothing to book.
 * With each amount it returns the account's balance just before the
 * transaction (`preRaw`, finalized): what the vault held then, booked or not.
 */
import { getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { buildRevokeSolanaSessionsInstruction, buildSetSolanaBreakerInstruction, buildWithdrawSolanaNativeInstruction, buildWithdrawSolanaVaultInstruction,
  deriveSolanaAta, SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_SYSTEM_PROGRAM, SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import type { SolanaLiveRead } from "./solana-live-rpc";

export class SolanaExternalWithdrawalError extends Error {
  constructor(message: string) { super(message); this.name = "SolanaExternalWithdrawalError"; }
}
function refuse(message: string): never { throw new SolanaExternalWithdrawalError(message); }
const NOT_A_WITHDRAWAL = "That transaction is not a withdrawal from your vault that Merrymen can record. Nothing was recorded.";

// Each owner instruction's 8-byte discriminator, from the same builders the app signs with.
const any = SOLANA_SYSTEM_PROGRAM;
const discriminator = (data: ArrayLike<number> | undefined) => Buffer.from(Uint8Array.from(data ?? [])).subarray(0, 8).toString("hex");
const WITHDRAW = discriminator(buildWithdrawSolanaVaultInstruction({ programAddress: any, vault: any, owner: any, mint: any, vaultToken: any, ownerToken: any, tokenProgram: any, amount: 1n }).data);
const OWNER_ONLY = new Set([
  discriminator(buildWithdrawSolanaNativeInstruction({ programAddress: any, vault: any, owner: any, amount: 1n }).data),
  discriminator(buildRevokeSolanaSessionsInstruction({ programAddress: any, vault: any, owner: any }).data),
  discriminator(buildSetSolanaBreakerInstruction({ programAddress: any, vault: any, authority: any, paused: true }).data),
]);
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

export interface SolanaExternalWithdrawal { slot: number; withdrawals: Array<{ mint: string; amountRaw: string; preRaw: string }> }

export async function readSolanaExternalWithdrawal(read: SolanaLiveRead, signature: string, expected: { programId: string; vault: string; owner: string }): Promise<SolanaExternalWithdrawal> {
  const tx = await read("getTransaction", [signature, { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 }]);
  if (tx === null) refuse("That transaction is not finalized on Solana, or a provider has no record of it yet. Nothing was recorded. Try again shortly.");
  if (!object(tx) || !object(tx.meta) || !Array.isArray(tx.transaction) || tx.transaction[1] !== "base64" || typeof tx.transaction[0] !== "string"
    || typeof tx.slot !== "number" || !Number.isSafeInteger(tx.slot) || tx.slot < 1) refuse(NOT_A_WITHDRAWAL);
  if (tx.meta.err !== null) refuse("That transaction failed on Solana, so it moved nothing. Nothing was recorded.");
  let decoded: ReturnType<ReturnType<typeof getTransactionDecoder>["decode"]>, message: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    const bytes = Buffer.from(tx.transaction[0], "base64");
    if (bytes.toString("base64") !== tx.transaction[0]) refuse(NOT_A_WITHDRAWAL);
    decoded = getTransactionDecoder().decode(bytes);
    message = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes);
  } catch (error) { if (error instanceof SolanaExternalWithdrawalError) throw error; return refuse(NOT_A_WITHDRAWAL); }
  // The transaction is the one named: its first signature is the one asked about.
  const first = Object.values(decoded.signatures)[0];
  if (!first || getBase58Decoder().decode(first) !== signature) refuse(NOT_A_WITHDRAWAL);
  if ("addressTableLookups" in message && Array.isArray(message.addressTableLookups) && message.addressTableLookups.length) refuse(NOT_A_WITHDRAWAL);
  const keys = message.staticAccounts.map(String);
  const ownerIndex = keys.indexOf(expected.owner);
  if (ownerIndex < 0 || ownerIndex >= message.header.numSignerAccounts) refuse(NOT_A_WITHDRAWAL);
  const atas: Record<string, string> = {
    [SOLANA_USDG_MINT]: await deriveSolanaAta(expected.vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM),
    [SOLANA_WRAPPED_SOL_MINT]: await deriveSolanaAta(expected.vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM),
  };
  const withdrawn: Record<string, bigint> = { [SOLANA_USDG_MINT]: 0n, [SOLANA_WRAPPED_SOL_MINT]: 0n };
  for (const instruction of message.instructions) {
    if (keys[instruction.programAddressIndex] !== expected.programId) continue;
    const data = Buffer.from(instruction.data ?? []), accounts = (instruction.accountIndices ?? []).map(index => keys[index]);
    if (accounts[0] !== expected.vault || accounts[1] !== expected.owner) refuse(NOT_A_WITHDRAWAL);
    const kind = discriminator(data);
    if (kind === WITHDRAW) {
      const mint = accounts[2];
      if (data.length !== 16 || !mint || !Object.hasOwn(atas, mint) || accounts[3] !== atas[mint]) refuse(NOT_A_WITHDRAWAL);
      withdrawn[mint]! += data.readBigUInt64LE(8);
    } else if (!OWNER_ONLY.has(kind)) refuse("That transaction did more than withdraw from your vault. Nothing was recorded.");
  }
  // Nothing may reach the vault program from inside another program.
  const inner = tx.meta.innerInstructions;
  if (inner !== undefined && inner !== null) {
    if (!Array.isArray(inner)) refuse(NOT_A_WITHDRAWAL);
    for (const set of inner) {
      if (!object(set) || !Array.isArray(set.instructions)) refuse(NOT_A_WITHDRAWAL);
      if (set.instructions.some(item => !object(item) || typeof item.programIdIndex !== "number" || keys[item.programIdIndex] === expected.programId)) refuse(NOT_A_WITHDRAWAL);
    }
  }
  const balance = (list: unknown, mint: string): bigint | null => {
    if (!Array.isArray(list)) return refuse(NOT_A_WITHDRAWAL);
    const index = keys.indexOf(atas[mint]!);
    const entry = list.find(item => object(item) && item.accountIndex === index);
    if (index < 0 || entry === undefined) return null;
    if (!object(entry) || entry.mint !== mint || !object(entry.uiTokenAmount) || typeof entry.uiTokenAmount.amount !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(entry.uiTokenAmount.amount)) return refuse(NOT_A_WITHDRAWAL);
    return BigInt(entry.uiTokenAmount.amount);
  };
  const withdrawals: SolanaExternalWithdrawal["withdrawals"] = [];
  for (const mint of [SOLANA_USDG_MINT, SOLANA_WRAPPED_SOL_MINT]) {
    const pre = balance(tx.meta.preTokenBalances, mint), post = balance(tx.meta.postTokenBalances, mint), taken = withdrawn[mint]!;
    if (taken === 0n) { if (pre !== post) refuse(NOT_A_WITHDRAWAL); continue; }
    if (pre === null || post === null) refuse(NOT_A_WITHDRAWAL);
    const decrease = pre - post;
    if (mint === SOLANA_USDG_MINT ? decrease !== taken : decrease > taken || decrease < 0n) refuse(NOT_A_WITHDRAWAL);
    if (decrease > 0n) withdrawals.push({ mint, amountRaw: decrease.toString(), preRaw: pre!.toString() });
  }
  return { slot: tx.slot, withdrawals };
}
