/**
 * Owner-run recovery of a Solana custody vault, independent of the Merrymen
 * server: no database, no session, no environment hash, no worker. The owner
 * signs with their own exported key; only signed transactions leave this
 * process, and only to the mainnet RPC the owner names.
 *
 * The procedure is the one the program allows (contracts/solana, lib.rs):
 *   1. revoke_all alone, finalized before anything else. A session still
 *      trading would otherwise race the withdrawal and roll it back.
 *   2. From finalized balances, one transaction per asset, so a blocked asset
 *      (a frozen, memo-required or paused account) stops only its own leg:
 *      the vault account's SOL above its rent reserve first, then all USDG,
 *      then all WSOL (creating the owner's token account if missing and
 *      syncing the vault's native WSOL).
 * Funds can only move vault -> owner. A repeated or overlapping run cannot
 * move more than the vault holds: a stale amount fails that leg.
 * About 0.0165 SOL of vault and vault token account rent stays locked, since
 * the program has no close instruction.
 *
 * The program is trusted only once verified. The owner is the fee payer, so
 * the owner key is a writable signer inside every instruction of the program
 * it signs for: a look-alike program could move the owner's SOL and the
 * tokens in the owner USDG and WSOL accounts that step 2 passes writable.
 * --send therefore signs only for a released program (SOLANA_VAULT_RELEASES,
 * verified by default) or, with --unlisted-program, for one whose immutable
 * binary matches the owner's --program-sha256, after a warning and a pause.
 */
import {
  address, appendTransactionMessageInstructions, compileTransaction, createKeyPairFromBytes,
  createKeyPairFromPrivateKeyBytes, createTransactionMessage, getAddressFromPublicKey,
  getBase64EncodedWireTransaction, getSignatureFromTransaction, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, signTransaction, type Blockhash, type Instruction,
} from "@solana/kit";
import { ed25519 } from "@noble/curves/ed25519";
import { base58Decode, base58Encode, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import {
  buildRevokeSolanaSessionsInstruction, buildWithdrawSolanaNativeInstruction, buildWithdrawSolanaVaultInstruction,
  decodeSolanaVaultAccount, deriveSolanaAta, deriveSolanaVaultAddress, SOLANA_ASSOCIATED_TOKEN_PROGRAM,
  SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_SYSTEM_PROGRAM, SOLANA_VAULT_RELEASES, SOLANA_WRAPPED_SOL_MINT, SolanaVaultValidationError,
  type SolanaTransferHookAccount, type SolanaVaultState,
} from "../../packages/core/src/solana-live";
import { readSolanaWithdrawHookAccounts, SolanaTransferHookReadError } from "./solana-transfer-hook";
import { verifySolanaVaultDeployment } from "./solana-executor";
import type { SolanaLiveRead, SolanaLiveRpc } from "./solana-live-rpc";
import { SolanaRpcError } from "./solana-rpc";

/**
 * Whether a transaction that failed to finish can still land: "no" once it is
 * provably out (failed on chain, or expired), "unknown" once its bytes may have
 * reached the network without a final answer. Unset: nothing was sent.
 */
export type SolanaRecoveryLanding = "no" | "unknown";
/** Fixed messages only: never key material, RPC URLs or provider text. */
export class SolanaRecoverError extends Error {
  constructor(message: string, readonly landing?: SolanaRecoveryLanding) { super(message); this.name = "SolanaRecoverError"; }
}
function fail(message: string, landing?: SolanaRecoveryLanding): never { throw new SolanaRecoverError(message, landing); }

/** Pubkey::default(), which revoke_all writes as the session. */
const NO_SESSION = SOLANA_SYSTEM_PROGRAM;
const SYNC_NATIVE = 17;
const CREATE_IDEMPOTENT = 1;
export const SOLANA_RECOVER_KEY_MAX_BYTES = 4096;

/** A released Merrymen vault program and the SHA-256 of its deployed binary (ProgramData bytes after the 45-byte header). */
export type SolanaVaultRelease = (typeof SOLANA_VAULT_RELEASES)[number];
/**
 * Released vault programs, verified by default: the shared pin in
 * packages/core, so the app and this raw-key tool trust the same program.
 * Empty until the program is released: until then --send needs
 * --program-sha256 and --unlisted-program.
 */
export { SOLANA_VAULT_RELEASES };
/** Pause after the unlisted-program warning, before anything is signed. */
export const SOLANA_RECOVER_UNLISTED_DELAY_MS = 15_000;

export interface SolanaRecoveryProgramTrust { listed: boolean; sha256?: string }
/**
 * Decides, before any RPC call or signature, which binary the program must
 * match. A released program is checked against its released hash. Signing
 * for any other program needs the owner's --program-sha256 and the explicit
 * --unlisted-program; a plan only reads, so it may name any program.
 */
export function solanaRecoveryProgramTrust(options: { programId: string; send: boolean; programSha256?: string;
  allowUnlistedProgram?: boolean; releases?: readonly SolanaVaultRelease[] }): SolanaRecoveryProgramTrust {
  canonical(options.programId, "program ID");
  const releases = options.releases ?? SOLANA_VAULT_RELEASES;
  const release = releases.find((r) => r.programId === options.programId);
  if (release) {
    if (options.programSha256 !== undefined && options.programSha256 !== release.sha256) {
      fail("--program-sha256 differs from the released binary of this program. Nothing was signed or sent.");
    }
    return { listed: true, sha256: release.sha256 };
  }
  if (options.send && (options.programSha256 === undefined || !options.allowUnlistedProgram)) {
    fail(`Program ${options.programId} is not a released Merrymen vault program${releases.length ? "" : " (none is released yet)"}. `
      + "Nothing was signed or sent. The owner key signs every instruction of the program you name, so a look-alike program could take "
      + "the SOL in this wallet and the tokens in its USDG and WSOL accounts. If someone sent you this command, stop: Merrymen never asks for it. "
      + "To recover from a program you deployed or audited yourself, add --program-sha256 with its binary hash and --unlisted-program.");
  }
  return { listed: false, sha256: options.programSha256 };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("The Solana RPC returned malformed data.");
  return value;
}
function canonical(value: string, what: string): string {
  const bytes = base58Decode(value);
  if (!bytes || bytes.length !== 32 || base58Encode(bytes) !== value) fail(`The ${what} must be a canonical Solana public key.`);
  return value;
}

/**
 * True for a canonical base58 Solana address that is a point on the ed25519
 * curve: every wallet that can sign (and so own a vault) has one. Program
 * derived addresses are off the curve, and so are about half of all random
 * 32-byte strings, such as a pasted secret seed.
 */
export function isSolanaWalletAddress(value: string): boolean {
  const bytes = base58Decode(value);
  if (!bytes || bytes.length !== 32 || base58Encode(bytes) !== value) return false;
  // Strict RFC 8032 decoding (no ZIP-215 leniency): the y coordinate must be canonical.
  try { ed25519.Point.fromBytes(bytes, false); return true; } catch { return false; }
}

/**
 * The owner's exported secret key: a base58 64-byte secret key (wallet
 * export), a base58 32-byte seed, or a solana-keygen JSON array. The key is
 * imported as a non-extractable signer and every intermediate copy is zeroed.
 */
export async function readSolanaOwnerKey(text: string): Promise<{ keyPair: CryptoKeyPair; owner: string }> {
  const invalid = () => fail("The key input does not contain a Solana secret key.");
  if (typeof text !== "string" || Buffer.byteLength(text) > SOLANA_RECOVER_KEY_MAX_BYTES) return invalid();
  const trimmed = text.trim();
  let bytes: Uint8Array | null = null;
  try {
    if (trimmed.startsWith("[")) {
      const parsed: unknown = JSON.parse(trimmed);
      if (!Array.isArray(parsed) || parsed.length !== 64 || parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return invalid();
      bytes = Uint8Array.from(parsed as number[]);
      parsed.fill(0);
    } else if (/^[1-9A-HJ-NP-Za-km-z]{43,90}$/.test(trimmed)) {
      bytes = base58Decode(trimmed);
    }
    if (!bytes || (bytes.length !== 64 && bytes.length !== 32)) return invalid();
    // A 64-byte key carries its public half; kit checks it signs for that key.
    const keyPair = bytes.length === 64 ? await createKeyPairFromBytes(bytes) : await createKeyPairFromPrivateKeyBytes(bytes);
    return { keyPair, owner: await getAddressFromPublicKey(keyPair.publicKey) };
  } catch (error) {
    if (error instanceof SolanaRecoverError) throw error;
    return invalid();
  } finally {
    bytes?.fill(0);
  }
}

interface RawAccount { owner: string; executable: boolean; lamports: bigint; data: Buffer }
function rawAccount(value: unknown): RawAccount | null {
  if (value === null) return null;
  if (!object(value) || typeof value.owner !== "string" || typeof value.executable !== "boolean" ||
    !Array.isArray(value.data) || value.data[1] !== "base64" || typeof value.data[0] !== "string") fail("The Solana RPC returned malformed account data.");
  const data = Buffer.from(value.data[0], "base64");
  if (data.toString("base64") !== value.data[0]) fail("The Solana RPC returned malformed account data.");
  return { owner: value.owner, executable: value.executable, lamports: BigInt(integer(value.lamports)), data };
}
/** The SPL token account fields recovery needs, checked against the expected mint and authority. */
function tokenAccount(raw: RawAccount, program: string, mint: string, authority: string) {
  const data = raw.data;
  if (raw.owner !== program || raw.executable || data.length < 165 ||
    base58Encode(data.subarray(0, 32)) !== mint || base58Encode(data.subarray(32, 64)) !== authority) {
    fail("A vault token account does not match its expected mint and owner.");
  }
  const state = data[108];
  if (state !== 1 && state !== 2) fail("A vault token account is not initialized.");
  const nativeTag = data.readUInt32LE(109);
  if (nativeTag > 1) fail("A vault token account is malformed.");
  return { amount: data.readBigUInt64LE(64), frozen: state === 2, nativeReserve: nativeTag === 1 ? data.readBigUInt64LE(113) : null };
}
/**
 * True when the owner's token account exists and is frozen: a transfer into it
 * fails, and would take the whole step 2 transaction down with it. Anything
 * else at the ATA address is left to CreateIdempotent and the program.
 */
function ownerAccountFrozen(raw: RawAccount | null | undefined, program: string): boolean {
  return !!raw && raw.owner === program && !raw.executable && raw.data.length >= 165 && raw.data[108] === 2;
}

export interface SolanaRecoveryState {
  owner: string;
  programId: string;
  vault: string;
  /** The finalized slot every balance below was read at. */
  slot: number;
  vaultState: SolanaVaultState;
  /** True while a session key is set: it can still trade until revoked. */
  sessionActive: boolean;
  usdg: { vaultAccount: string; ownerAccount: string; exists: boolean; frozen: boolean; amountRaw: bigint; ownerAccountExists: boolean; ownerAccountFrozen: boolean;
    /**
     * The accounts a transfer-hook program the issuer set on USDG needs in the withdrawal (none
     * while no program is set), or why they cannot be resolved: then the USDG leg is skipped.
     */
    hookAccounts: SolanaTransferHookAccount[]; hookRefusal: string | null };
  /** WSOL withdrawable after SyncNative: account lamports above its rent-exempt reserve. */
  wsol: { vaultAccount: string; ownerAccount: string; exists: boolean; frozen: boolean; amountRaw: bigint; unsyncedRaw: bigint; ownerAccountExists: boolean;
    ownerAccountFrozen: boolean };
  /** Native SOL in the vault account above the rent reserve withdraw_sol keeps. */
  sol: { lamports: bigint; reserve: bigint; excess: bigint };
  ownerLamports: bigint;
}

/** One consistent finalized read of the vault, its token accounts and the owner's, at a single slot. */
export async function readSolanaRecoveryState(rpc: SolanaLiveRpc, programId: string, owner: string, minContextSlot = 1): Promise<SolanaRecoveryState> {
  canonical(programId, "program ID"); canonical(owner, "owner");
  const vault = await deriveSolanaVaultAddress(programId, owner);
  const [vaultUsdg, vaultWsol, ownerUsdg, ownerWsol] = await Promise.all([
    deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM),
    deriveSolanaAta(owner, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), deriveSolanaAta(owner, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM),
  ]);
  return rpc.read(async (read: SolanaLiveRead) => {
    const slot = integer(await read("getSlot", [{ commitment: "finalized", minContextSlot }]));
    if (slot < minContextSlot) fail("The Solana RPC is behind the last recovery step; try again shortly.");
    const result = await read("getMultipleAccounts", [[vault, vaultUsdg, vaultWsol, owner, ownerUsdg, ownerWsol],
      { encoding: "base64", commitment: "finalized", minContextSlot: slot }]);
    if (!object(result) || !object(result.context) || integer(result.context.slot) < slot || !Array.isArray(result.value) || result.value.length !== 6) {
      fail("The Solana RPC returned malformed account data.");
    }
    const [vaultRaw, usdgRaw, wsolRaw, ownerRaw, ownerUsdgRaw, ownerWsolRaw] = result.value.map(rawAccount);
    if (!vaultRaw) fail(`No Merrymen vault exists for owner ${owner} under program ${programId}. Check the program ID shown next to your vault.`);
    if (vaultRaw.owner !== programId || vaultRaw.executable) fail("The vault address is not an account of the given program.");
    let vaultState: SolanaVaultState;
    try { vaultState = decodeSolanaVaultAccount(new Uint8Array(vaultRaw.data)); }
    catch { return fail("The vault account is not a Merrymen vault this tool understands."); }
    if (vaultState.owner !== owner) fail("The vault belongs to a different owner.");
    const reserve = BigInt(integer(await read("getMinimumBalanceForRentExemption", [vaultRaw.data.length, { commitment: "finalized" }])));
    const usdg = usdgRaw ? tokenAccount(usdgRaw, TOKEN_2022_PROGRAM, SOLANA_USDG_MINT, vault) : null;
    const wsol = wsolRaw ? tokenAccount(wsolRaw, SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_WRAPPED_SOL_MINT, vault) : null;
    if (wsol && wsol.nativeReserve === null) fail("The vault's WSOL account is not a native SOL account.");
    const wsolWithdrawable = wsol && wsolRaw!.lamports > wsol.nativeReserve! ? wsolRaw!.lamports - wsol.nativeReserve! : 0n;
    if (wsol && wsolWithdrawable < wsol.amount) fail("The vault's WSOL account is malformed.");
    // Once the issuer sets a transfer hook on USDG, the withdrawal carries its accounts (the program
    // forwards them), resolved at this same slot for the amount step 2 withdraws.
    let hookAccounts: SolanaTransferHookAccount[] = [], hookRefusal: string | null = null;
    if (usdg && usdg.amount > 0n && !usdg.frozen) {
      try {
        hookAccounts = await readSolanaWithdrawHookAccounts(read, { mint: SOLANA_USDG_MINT, tokenProgram: TOKEN_2022_PROGRAM, vault, owner, vaultToken: vaultUsdg,
          ownerToken: ownerUsdg, amount: usdg.amount, minContextSlot: slot });
      } catch (error) {
        if (error instanceof SolanaVaultValidationError) hookRefusal = error.message;
        else if (error instanceof SolanaTransferHookReadError) fail("The Solana RPC returned malformed account data.");
        else throw error;
      }
    }
    return {
      owner, programId, vault, slot: integer(result.context.slot), vaultState,
      sessionActive: vaultState.session !== NO_SESSION,
      usdg: { vaultAccount: vaultUsdg, ownerAccount: ownerUsdg, exists: !!usdg, frozen: !!usdg?.frozen, amountRaw: usdg?.amount ?? 0n, ownerAccountExists: !!ownerUsdgRaw,
        ownerAccountFrozen: ownerAccountFrozen(ownerUsdgRaw, TOKEN_2022_PROGRAM), hookAccounts, hookRefusal },
      wsol: { vaultAccount: vaultWsol, ownerAccount: ownerWsol, exists: !!wsol, frozen: !!wsol?.frozen, amountRaw: wsolWithdrawable,
        unsyncedRaw: wsol ? wsolWithdrawable - wsol.amount : 0n, ownerAccountExists: !!ownerWsolRaw,
        ownerAccountFrozen: ownerAccountFrozen(ownerWsolRaw, SOLANA_CLASSIC_TOKEN_PROGRAM) },
      sol: { lamports: vaultRaw.lamports, reserve, excess: vaultRaw.lamports > reserve ? vaultRaw.lamports - reserve : 0n },
      ownerLamports: ownerRaw?.lamports ?? 0n,
    };
  });
}

/** Step 1: revoke_all alone, or nothing when no session key is set. */
export function solanaRecoveryRevokeInstructions(state: SolanaRecoveryState): Instruction[] {
  return state.sessionActive ? [buildRevokeSolanaSessionsInstruction({ programAddress: state.programId, vault: state.vault, owner: state.owner })] : [];
}

function createOwnerAta(owner: string, ata: string, mint: string, tokenProgram: string): Instruction {
  return { programAddress: address(SOLANA_ASSOCIATED_TOKEN_PROGRAM), data: Uint8Array.of(CREATE_IDEMPOTENT), accounts: [
    { address: address(owner), role: 3 }, { address: address(ata), role: 1 }, { address: address(owner), role: 0 },
    { address: address(mint), role: 0 }, { address: address(SOLANA_SYSTEM_PROGRAM), role: 0 }, { address: address(tokenProgram), role: 0 },
  ] };
}

export interface SolanaRecoveryWithdrawal { usdgRaw: bigint; wsolRaw: bigint; solLamports: bigint; skipped: string[] }
/** What step 2 withdraws from a state: every unit a withdrawal can move. */
export function solanaRecoveryWithdrawal(state: SolanaRecoveryState): SolanaRecoveryWithdrawal {
  const skipped: string[] = [];
  // A frozen account on either side fails its transfer, and with it every other
  // withdrawal in the same transaction: skip that asset, recover the rest.
  if (state.usdg.frozen) skipped.push("USDG: the vault's USDG account is frozen by the issuer, so it cannot be withdrawn.");
  else if (state.usdg.ownerAccountFrozen && state.usdg.amountRaw > 0n) skipped.push(`USDG: your USDG account ${state.usdg.ownerAccount} is frozen by the issuer, so USDG cannot be withdrawn to it.`);
  else if (state.usdg.hookRefusal !== null && state.usdg.amountRaw > 0n) skipped.push(`USDG: ${state.usdg.hookRefusal}`);
  if (state.wsol.frozen) skipped.push("WSOL: the vault's WSOL account is frozen, so it cannot be withdrawn.");
  else if (state.wsol.ownerAccountFrozen && state.wsol.amountRaw > 0n) skipped.push(`WSOL: your WSOL account ${state.wsol.ownerAccount} is frozen, so WSOL cannot be withdrawn to it.`);
  return {
    usdgRaw: state.usdg.frozen || state.usdg.ownerAccountFrozen || state.usdg.hookRefusal !== null ? 0n : state.usdg.amountRaw,
    wsolRaw: state.wsol.frozen || state.wsol.ownerAccountFrozen ? 0n : state.wsol.amountRaw,
    solLamports: state.sol.excess, skipped,
  };
}

export type SolanaRecoveryAsset = "SOL" | "USDG" | "WSOL";
const DECIMALS: Record<SolanaRecoveryAsset, number> = { SOL: 9, USDG: 6, WSOL: 9 };
/** One step 2 transaction: everything one asset needs, and nothing of another asset. */
export interface SolanaRecoveryLeg { asset: SolanaRecoveryAsset; amountRaw: bigint; instructions: Instruction[] }
/**
 * Step 2 as one transaction per asset, built only from packages/core vault
 * builders plus ATA and SyncNative. Legs are independent: a leg that cannot
 * pass (a frozen, memo-required or paused account the read did not reveal)
 * fails alone, and the other assets still reach the owner. SOL goes first,
 * so the vault's spare SOL is in the owner wallet before the token legs pay
 * for any new owner token account.
 */
export function solanaRecoveryWithdrawLegs(state: SolanaRecoveryState): SolanaRecoveryLeg[] {
  const plan = solanaRecoveryWithdrawal(state);
  const { programId, vault, owner } = state;
  const legs: SolanaRecoveryLeg[] = [];
  if (plan.solLamports > 0n) {
    legs.push({ asset: "SOL", amountRaw: plan.solLamports,
      instructions: [buildWithdrawSolanaNativeInstruction({ programAddress: programId, vault, owner, amount: plan.solLamports })] });
  }
  if (plan.usdgRaw > 0n) {
    legs.push({ asset: "USDG", amountRaw: plan.usdgRaw, instructions: [
      createOwnerAta(owner, state.usdg.ownerAccount, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM),
      buildWithdrawSolanaVaultInstruction({ programAddress: programId, vault, owner, mint: SOLANA_USDG_MINT,
        vaultToken: state.usdg.vaultAccount, ownerToken: state.usdg.ownerAccount, tokenProgram: TOKEN_2022_PROGRAM, amount: plan.usdgRaw,
        hookAccounts: state.usdg.hookAccounts }),
    ] });
  }
  if (plan.wsolRaw > 0n) {
    const instructions: Instruction[] = [createOwnerAta(owner, state.wsol.ownerAccount, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM)];
    // Anyone may sync a native account: lamports sent to it become its token amount.
    if (state.wsol.unsyncedRaw > 0n) {
      instructions.push({ programAddress: address(SOLANA_CLASSIC_TOKEN_PROGRAM), data: Uint8Array.of(SYNC_NATIVE),
        accounts: [{ address: address(state.wsol.vaultAccount), role: 1 }] });
    }
    instructions.push(buildWithdrawSolanaVaultInstruction({ programAddress: programId, vault, owner, mint: SOLANA_WRAPPED_SOL_MINT,
      vaultToken: state.wsol.vaultAccount, ownerToken: state.wsol.ownerAccount, tokenProgram: SOLANA_CLASSIC_TOKEN_PROGRAM, amount: plan.wsolRaw }));
    legs.push({ asset: "WSOL", amountRaw: plan.wsolRaw, instructions });
  }
  return legs;
}

export function formatSolanaUnits(raw: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals), whole = raw / unit, fraction = (raw % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function when(unixSeconds: bigint): string {
  const ms = Number(unixSeconds) * 1000;
  return unixSeconds > 0n && Number.isSafeInteger(ms) && ms <= 8.64e15 ? new Date(ms).toISOString() : `at unix time ${unixSeconds}`;
}

/** A human-readable plan. Public data only: addresses, balances and the steps. */
export function describeSolanaRecovery(state: SolanaRecoveryState, sending: boolean): string[] {
  const plan = solanaRecoveryWithdrawal(state);
  const { vaultState } = state;
  const lines = [
    sending ? "Solana vault recovery: sending (each step waits for finalization)." : "Solana vault recovery: PLAN ONLY. Nothing was signed or sent; add --send to submit.",
    "Network:   mainnet-beta (genesis verified on the RPC you supplied)",
    `Owner:     ${state.owner}`,
    `Program:   ${state.programId}   (compare it with the program shown next to your vault in Merrymen)`,
    `Vault:     ${state.vault}`,
    vaultState.session === NO_SESSION ? "Session:   none (already revoked)"
      : `Session:   ${vaultState.session}, expires ${when(vaultState.expiresAt)}${vaultState.paused ? ", buys paused" : ""}`,
    `Balances (finalized, slot ${state.slot}):`,
    `  USDG       ${formatSolanaUnits(state.usdg.amountRaw, 6)}${state.usdg.exists ? "" : " (no vault USDG account)"}${state.usdg.frozen ? " (frozen)" : ""}`,
    `  WSOL       ${formatSolanaUnits(state.wsol.amountRaw, 9)}${state.wsol.exists ? "" : " (no vault WSOL account)"}${state.wsol.unsyncedRaw > 0n ? ` (includes ${formatSolanaUnits(state.wsol.unsyncedRaw, 9)} unsynced)` : ""}`,
    `  SOL        ${formatSolanaUnits(state.sol.excess, 9)} above the vault account's rent reserve`,
    `  Owner SOL  ${formatSolanaUnits(state.ownerLamports, 9)} (pays the fees)`,
    "Steps:",
    state.sessionActive ? "  1. revoke_all: stops every session key at once. Sent alone and finalized before step 2."
      : "  1. revoke_all: not needed, no session key is set.",
  ];
  const parts = [plan.usdgRaw > 0n && `${formatSolanaUnits(plan.usdgRaw, 6)} USDG`, plan.wsolRaw > 0n && `${formatSolanaUnits(plan.wsolRaw, 9)} WSOL`,
    plan.solLamports > 0n && `${formatSolanaUnits(plan.solLamports, 9)} SOL`].filter(Boolean);
  lines.push(parts.length ? `  2. withdraw ${parts.join(", ")} to the owner${state.sessionActive ? " (re-read from finalized balances after step 1)" : ""}.`
    : "  2. nothing to withdraw.");
  if (parts.length) {
    lines.push("     One transaction per asset (SOL, then USDG, then WSOL): an asset that cannot move does not stop the others.");
    lines.push(`     Destinations: owner ${state.owner}, USDG account ${state.usdg.ownerAccount}, WSOL account ${state.wsol.ownerAccount}.`);
  }
  if (plan.wsolRaw > 0n) lines.push("     WSOL arrives wrapped. Keep the owner WSOL account open if an agent may sell to it again.");
  for (const note of plan.skipped) lines.push(`  Note: ${note}`);
  if (state.ownerLamports < 10_000_000n) lines.push("  Note: the owner wallet holds under 0.01 SOL. Fees and any new token account (about 0.002 SOL each) are paid from it.");
  lines.push("  About 0.0165 SOL of rent stays in the vault accounts: the program has no close instruction.");
  return lines;
}

interface Block { blockhash: Blockhash; lastValidBlockHeight: bigint; slot: number }
async function latestBlock(rpc: SolanaLiveRpc): Promise<Block> {
  return rpc.read(async (read) => {
    const result = await read("getLatestBlockhash", [{ commitment: "finalized" }]);
    if (!object(result) || !object(result.context) || !object(result.value) || typeof result.value.blockhash !== "string") fail("The Solana RPC returned a malformed blockhash.");
    canonical(result.value.blockhash, "blockhash");
    return { blockhash: result.value.blockhash as Blockhash, lastValidBlockHeight: BigInt(integer(result.value.lastValidBlockHeight)), slot: integer(result.context.slot) };
  });
}

export interface SolanaRecoveryIo {
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  /** Total time to wait for one transaction to finalize or provably expire. */
  maxWaitMs?: number;
  pollMs?: number;
}
type Outcome = { signature: string; status: "finalized"; slot: number };

/**
 * Sign one owner transaction once, submit it, and wait until it is finalized
 * or provably expired. Only these signed bytes are ever sent: a rebroadcast of
 * identical bytes can land at most once, and nothing is signed again here.
 *
 * A failure says whether the transaction can still land (SolanaRecoverError's
 * `landing`): "no" only when it failed on chain or provably expired; "unknown"
 * for everything after the first submission began, the RPC errors of the
 * status polls included. A first submission the RPC did not confirm is
 * "unknown" too: the transport cannot tell a refusal from an answer lost after
 * the node received the bytes (a timeout, a dropped connection, and a JSON-RPC
 * error object all reach here as the same SolanaRpcError). Errors before the
 * first submission leave `landing` unset: nothing left this process.
 */
async function sendAndFinalize(rpc: SolanaLiveRpc, keyPair: CryptoKeyPair, owner: string, instructions: Instruction[], label: string, io: SolanaRecoveryIo,
  /** What a failure means for the rest of the run, appended to its message. */
  consequence: string): Promise<Outcome> {
  const block = await latestBlock(rpc);
  const compiled = compileTransaction(setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: block.blockhash, lastValidBlockHeight: block.lastValidBlockHeight },
    setTransactionMessageFeePayer(address(owner), appendTransactionMessageInstructions(instructions, createTransactionMessage({ version: 0 })))));
  const signed = await signTransaction([keyPair], compiled);
  const signature = getSignatureFromTransaction(signed);
  const wire = getBase64EncodedWireTransaction(signed);
  if (Buffer.from(wire, "base64").length > 1232) fail("The recovery transaction is too large.");
  const deadline = Date.now() + (io.maxWaitMs ?? 150_000);
  io.log(`${label}: sending ${signature}`);
  // First a single round with preflight simulation, so a refusal is reported
  // at once instead of after the blockhash's whole lifetime.
  let sent: string;
  try { sent = await rpc.send(wire, block.slot, undefined, { untilMs: 0 }); }
  catch (error) {
    if (!(error instanceof SolanaRpcError)) throw error;
    fail(`${label} was not confirmed as submitted (${signature}): the RPC refused it, for example in its simulation, or its answer `
      + `could not be read. ${consequence}Wait about two minutes, then run the command again: it re-reads the chain before sending anything.`, "unknown");
  }
  if (sent !== signature) fail(`The Solana RPC answered ${label} with a different signature than ${signature}. Check an explorer before running again.`, "unknown");
  // Accepted: rebroadcast the same bytes until the RPC sees them finalized or
  // the blockhash expires, which helps them land under congestion. Whatever
  // this phase reports, the outcome is decided below from the chain alone.
  try { await rpc.send(wire, block.slot, undefined, { untilMs: deadline }); }
  catch (error) { if (!(error instanceof SolanaRpcError)) throw error; }
  try { return await finalizeOrExpire(rpc, signature, block, label, io, consequence, deadline); }
  catch (error) {
    // Sent, so it may still land: an RPC error or an unreadable status while
    // polling is never "not landed". Name the signature the owner can look up.
    if (error instanceof SolanaRecoverError && error.landing !== undefined) throw error;
    if (!(error instanceof SolanaRpcError) && !(error instanceof SolanaRecoverError)) throw error;
    fail(`${label} was sent (${signature}) but its status could not be read. ${consequence}`
      + "Check an explorer, wait about two minutes, then run the command again; it re-reads the chain first.", "unknown");
  }
}

/** Polls a sent transaction until it is finalized, failed or provably expired, or the deadline passes. */
async function finalizeOrExpire(rpc: SolanaLiveRpc, signature: string, block: Block, label: string, io: SolanaRecoveryIo, consequence: string,
  deadline: number): Promise<Outcome> {
  for (;;) {
    type Status = { kind: "failed" } | { kind: "finalized"; slot: number } | { kind: "waiting"; expired: boolean };
    const status = await rpc.read(async (read): Promise<Status> => {
      // Finalized height FIRST: once it is past the lifetime, every block that
      // could hold the transaction is final, so a later empty status proves it
      // never landed.
      const height = BigInt(integer(await read("getBlockHeight", [{ commitment: "finalized" }])));
      const result = await read("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
      if (!object(result) || !Array.isArray(result.value) || result.value.length !== 1) fail("The Solana RPC returned a malformed status.");
      const state = result.value[0];
      if (state !== null && !object(state)) fail("The Solana RPC returned a malformed status.");
      if (state && state.err !== null && state.err !== undefined) return { kind: "failed" };
      if (state && state.confirmationStatus === "finalized") return { kind: "finalized", slot: integer(state.slot) };
      return { kind: "waiting", expired: state === null && height > block.lastValidBlockHeight };
    });
    if (status.kind === "failed") fail(`${label} failed on chain (${signature}). ${consequence}Review the plan and run again.`, "no");
    if (status.kind === "finalized") { io.log(`${label}: finalized in slot ${status.slot}.`); return { signature, status: "finalized", slot: status.slot }; }
    if (status.expired) fail(`${label} expired without landing (${signature}). ${consequence}Run the command again.`, "no");
    if (Date.now() > deadline) fail(`${label} is not finalized yet (${signature}). ${consequence}Check an explorer, then run the command again; it re-reads the chain first.`, "unknown");
    await io.sleep(io.pollMs ?? 2_000);
  }
}

/**
 * The transport program verification reads through. It keeps every transport
 * flag of the owner's transport, above all singleEndpoint: an every-provider
 * check refuses a one-provider transport that does not carry it, so dropping
 * it would make every verified recovery fail with "no-quorum". It drops only
 * providerKey: a transport without one never consults the executor's
 * in-process success cache, so an earlier verification in this process cannot
 * vouch for this run. It reads through the same transport and cannot send.
 */
export function solanaRecoveryVerificationRpc(rpc: SolanaLiveRpc): SolanaLiveRpc {
  const flags: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rpc)) {
    if (name !== "providerKey" && typeof value !== "function") flags[name] = value;
  }
  const methods: SolanaLiveRpc = {
    read: (operation) => rpc.read(operation),
    ...(typeof rpc.readEach === "function" ? { readEach: (operation) => rpc.readEach!(operation) } : {}),
    send: () => fail("Program verification never sends a transaction."),
  };
  return Object.assign(flags, methods) as SolanaLiveRpc;
}

export interface SolanaRecoveryOptions {
  rpc: SolanaLiveRpc;
  programId: string;
  /** Public key for a plan; the key's own address when sending. */
  owner: string;
  keyPair?: CryptoKeyPair;
  send: boolean;
  /** The immutable program binary's SHA-256. A released program is checked against its own hash. */
  programSha256?: string;
  /** Sign for a program that is not a listed release, once its binary matches programSha256. */
  allowUnlistedProgram?: boolean;
  /** Released programs; defaults to SOLANA_VAULT_RELEASES. */
  releases?: readonly SolanaVaultRelease[];
}
export interface SolanaRecoveryResult {
  sent: boolean;
  plan: SolanaRecoveryState;
  revoke?: Outcome;
  /**
   * Step 2, one entry per asset leg sent: its outcome, or the fixed message it
   * failed with. `state` is "withdrawn" (finalized), "not-withdrawn" (nothing
   * was sent, or it failed on chain or provably expired) or "unknown" (it was
   * submitted, or may have been, and can still land).
   */
  withdrawals?: { asset: SolanaRecoveryAsset; amountRaw: bigint; state: "withdrawn" | "not-withdrawn" | "unknown"; outcome?: Outcome; error?: string }[];
  final?: SolanaRecoveryState;
}

export async function runSolanaRecovery(options: SolanaRecoveryOptions, io: SolanaRecoveryIo): Promise<SolanaRecoveryResult> {
  const { rpc, programId, owner } = options;
  canonical(programId, "program ID");
  // Before any RPC call, and never echoed: a value that is not a wallet address may be a pasted secret.
  if (!isSolanaWalletAddress(owner)) fail("The owner must be a Solana wallet address (an ed25519 public key). Nothing was sent.");
  if (options.send && !options.keyPair) fail("Sending needs the owner's key (--key-file).");
  // Before any RPC call: nothing is signed for a program that is not verified.
  const trust = solanaRecoveryProgramTrust(options);
  if (trust.sha256 !== undefined) {
    // Immutable (no upgrade authority) and hash-matched, so it cannot change
    // before the sends. Read fresh on every run (see solanaRecoveryVerificationRpc).
    let deployment: { declaresProgramId: boolean };
    try { deployment = await verifySolanaVaultDeployment(solanaRecoveryVerificationRpc(rpc), programId, trust.sha256); }
    catch (error) {
      if (error instanceof SolanaRpcError) throw error;
      fail(trust.listed ? "The program at that address is not the immutable released binary. Nothing was signed or sent."
        : "The program at that address is not the immutable binary with the given SHA-256. Nothing was signed or sent.");
    }
    // A released program must also be built for its own address, as the app's
    // executor requires (requireDeclaredProgramId): the hashed bytes hold the
    // program id's 32 bytes (declare_id!). A release pinned to a build for
    // another id would fail every instruction. An unlisted program the owner
    // vouches for with --program-sha256 is checked by its hash alone, as before.
    if (trust.listed && !deployment.declaresProgramId) {
      fail("The released binary at that address is not built for this program id (its declare_id differs), so it cannot run any instruction. Nothing was signed or sent.");
    }
    io.log(trust.listed ? "Program binary verified: the released Merrymen vault program, immutable, SHA-256 matches."
      : "Program binary verified against the given SHA-256 (immutable). It is NOT a released Merrymen vault program.");
  } else {
    io.log("Program binary NOT VERIFIED: not a released Merrymen vault program and no --program-sha256 given. This plan only reads; --send refuses it.");
  }
  const plan = await readSolanaRecoveryState(rpc, programId, owner);
  for (const line of describeSolanaRecovery(plan, options.send)) io.log(line);
  if (!options.send) return { sent: false, plan };
  if (plan.ownerLamports === 0n) fail(`The owner wallet has no SOL for fees. Send a little SOL (0.01 is plenty) to ${owner} and run again.`);
  if (!trust.listed) {
    io.log(`WARNING: ${programId} is not a released Merrymen vault program. Your key is about to sign instructions of this program,`);
    io.log("which can take the SOL in this wallet and the tokens in its USDG and WSOL accounts. Merrymen support never asks you to");
    io.log(`use --unlisted-program. Continue only if you deployed or audited this program yourself. Press Ctrl+C now to stop;`);
    io.log(`signing starts in ${SOLANA_RECOVER_UNLISTED_DELAY_MS / 1000} seconds.`);
    await io.sleep(SOLANA_RECOVER_UNLISTED_DELAY_MS);
  }

  const result: SolanaRecoveryResult = { sent: true, plan };
  // Only a finalized signature's slot raises the floor of the reads after it:
  // the plan only shows the owner what step 2 will withdraw, and step 2 reads
  // its amounts again below.
  let minSlot = 1;
  const revoke = solanaRecoveryRevokeInstructions(plan);
  if (revoke.length) {
    result.revoke = await sendAndFinalize(rpc, options.keyPair!, owner, revoke, "Step 1 (revoke_all)", io, "Nothing after it was sent. ");
    minSlot = result.revoke.slot;
  }
  // Amounts come only from finalized state after the revoke: no session can
  // move funds any more, and balances can only grow from here.
  const settled = await readSolanaRecoveryState(rpc, programId, owner, minSlot);
  if (settled.sessionActive) fail("A session key is still set after revoke_all finalized. Nothing was withdrawn; run the command again.");
  const legs = solanaRecoveryWithdrawLegs(settled);
  result.withdrawals = [];
  if (legs.length) {
    const amounts = solanaRecoveryWithdrawal(settled);
    io.log(`Step 2 (withdraw): ${formatSolanaUnits(amounts.usdgRaw, 6)} USDG, ${formatSolanaUnits(amounts.wsolRaw, 9)} WSOL, ${formatSolanaUnits(amounts.solLamports, 9)} SOL, from finalized slot ${settled.slot}, one transaction per asset.`);
  } else io.log("Step 2 (withdraw): nothing left to withdraw.");
  for (const leg of legs) {
    const label = `Step 2 (${leg.asset})`;
    try {
      const outcome = await sendAndFinalize(rpc, options.keyPair!, owner, leg.instructions, label, io, "The other assets are sent separately. ");
      result.withdrawals.push({ asset: leg.asset, amountRaw: leg.amountRaw, state: "withdrawn", outcome });
      minSlot = Math.max(minSlot, outcome.slot);
    } catch (error) {
      // Fixed messages only. A leg that did not finish never blocks the next asset.
      if (!(error instanceof SolanaRecoverError) && !(error instanceof SolanaRpcError)) throw error;
      // "NOT withdrawn" only when it cannot land; a leg that may still land says so.
      const unknown = error instanceof SolanaRecoverError && error.landing === "unknown";
      io.log(unknown ? `${label}: outcome unknown, it may still land. ${error.message}` : `${label}: NOT withdrawn. ${error.message}`);
      result.withdrawals.push({ asset: leg.asset, amountRaw: leg.amountRaw, state: unknown ? "unknown" : "not-withdrawn", error: error.message });
    }
  }
  result.final = await readSolanaRecoveryState(rpc, programId, owner, minSlot);
  const left = solanaRecoveryWithdrawal(result.final);
  io.log(`Done. Left in the vault: ${formatSolanaUnits(left.usdgRaw, 6)} USDG, ${formatSolanaUnits(left.wsolRaw, 9)} WSOL, ${formatSolanaUnits(left.solLamports, 9)} SOL above rent.`);
  const unfinished = result.withdrawals.filter((w) => w.state !== "withdrawn");
  if (unfinished.length) {
    const named = unfinished.map((w) => `${formatSolanaUnits(w.amountRaw, DECIMALS[w.asset])} ${w.asset}`
      + (w.state === "unknown" ? " (outcome unknown: it may still land; look up its signature above)" : ""));
    fail(`Step 2 did not finish for ${named.join(" and ")}; `
      + "every other asset was withdrawn. See the messages above, wait about two minutes, then run the command again: it re-reads the chain and retries only what is left.");
  }
  return result;
}
