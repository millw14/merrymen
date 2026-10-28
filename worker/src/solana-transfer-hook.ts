/**
 * The transfer-hook accounts an owner's vault withdrawal must carry.
 *
 * The USDG mint carries Token-2022's TransferHook extension with no program
 * set, and its issuer holds the authority to set one. Once a program is set,
 * Token-2022 calls it inside every transfer and the hook needs its program,
 * its validation account and the extra accounts that lists. The vault's
 * withdraw forwards its remaining accounts to the transfer (contracts/solana,
 * lib.rs), so these reads and the core resolver keep the owner's way out open.
 * Swaps refuse a hooked mint; this is for withdrawals only.
 */
import { TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import {
  deriveSolanaTransferHookValidation, resolveSolanaTransferHookAccounts, solanaMintTransferHookProgram,
  type SolanaTransferHookAccount,
} from "../../packages/core/src/solana-live";
import type { SolanaLiveRead } from "./solana-live-rpc";

export class SolanaTransferHookReadError extends Error {
  constructor(message = "The token's transfer hook accounts could not be read.") { super(message); this.name = "SolanaTransferHookReadError"; }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** One account's owner and data from a base64 getMultipleAccounts entry, or null when it does not exist. */
function accountOf(value: unknown): { owner: string; data: Uint8Array } | null {
  if (value === null) return null;
  if (!object(value) || typeof value.owner !== "string" || !Array.isArray(value.data) || value.data[1] !== "base64" || typeof value.data[0] !== "string") {
    throw new SolanaTransferHookReadError();
  }
  const data = Buffer.from(value.data[0], "base64");
  if (data.toString("base64") !== value.data[0]) throw new SolanaTransferHookReadError();
  return { owner: value.owner, data: new Uint8Array(data) };
}

/**
 * The remaining accounts for withdrawing `amount` of `mint` from the vault's
 * token account to the owner's, read finalized no earlier than
 * `minContextSlot`: none for a classic-token mint or a Token-2022 mint that
 * names no hook program, otherwise the resolved hook accounts. Throws when the
 * mint or the hook's list cannot be read or resolved, and when the hook needs
 * the owner's wallet (SOLANA_TRANSFER_HOOK_NAMES_OWNER).
 */
export async function readSolanaWithdrawHookAccounts(read: SolanaLiveRead, p: {
  mint: string; tokenProgram: string; vault: string; owner: string; vaultToken: string; ownerToken: string; amount: bigint;
  minContextSlot?: number;
}): Promise<SolanaTransferHookAccount[]> {
  if (p.tokenProgram !== TOKEN_2022_PROGRAM) return [];
  const accounts = async (keys: string[]) => {
    const found = await read("getMultipleAccounts", [keys, { encoding: "base64", commitment: "finalized", minContextSlot: p.minContextSlot ?? 1 }]);
    if (!object(found) || !Array.isArray(found.value) || found.value.length !== keys.length) throw new SolanaTransferHookReadError();
    return found.value.map(accountOf);
  };
  const [mint] = await accounts([p.mint]);
  if (!mint || mint.owner !== TOKEN_2022_PROGRAM) throw new SolanaTransferHookReadError("The token's mint could not be read.");
  const hookProgram = solanaMintTransferHookProgram(mint.data);
  if (hookProgram === null) return [];
  const validationAddress = await deriveSolanaTransferHookValidation(hookProgram, p.mint);
  const [validation] = await accounts([validationAddress]);
  return resolveSolanaTransferHookAccounts({
    hookProgram, mint: p.mint, source: p.vaultToken, destination: p.ownerToken, authority: p.vault, owner: p.owner, amount: p.amount,
    validationData: validation?.data ?? null,
    accountData: async (key) => (await accounts([key]))[0]?.data ?? null,
  });
}
