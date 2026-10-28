/** Shared wire ABI for the bounded Solana custody program. No deployment is implied. */
import {
  address,
  getProgramDerivedAddress,
  type AccountMeta,
  type Instruction,
} from "@solana/kit";
import { base58Decode, base58Encode } from "./ids";

/** Local test identity only. Production MUST supply an explicitly verified immutable program. */
export const SOLANA_VAULT_LOCAL_TEST_PROGRAM =
  "EUzYVniKtgNNgFweMtRA9vciTWtE8MDTRfh6ai6VvXoU";
/**
 * Released Merrymen vault programs: the program ID and the SHA-256 of its
 * deployed binary, i.e. the ProgramData account's bytes after its 45-byte
 * header up to the account's full size (it equals the .so file's hash only
 * when deployed without extra --max-len space). The owner recovery tool
 * (merrymen solana-recover) signs by default only for a program listed here,
 * after checking that its immutable binary matches. Empty until a release: a
 * release adds one frozen entry, reviewed, and it must match the deployment's
 * MERRYMEN_SOLANA_VAULT_PROGRAM and MERRYMEN_SOLANA_VAULT_SHA256. Once any entry
 * is listed, the live runtime refuses a configured program or SHA-256 that is
 * not one listed pair (solanaVaultReleaseRefusal), so the app and the recovery
 * tool trust the same program. Never the local test program.
 */
export const SOLANA_VAULT_RELEASES: readonly { readonly programId: string; readonly sha256: string }[] = Object.freeze([]);
/**
 * Why a configured live deployment (program id and binary SHA-256, lowercase
 * hex) is not a released vault, or null when it is listed together with that
 * hash. While `releases` is empty nothing is released yet and every pair
 * passes here: the deployment checks (immutable, hash-matching, built for its
 * id, never the local test id) still apply.
 */
export function solanaVaultReleaseRefusal(
  programId: string,
  sha256: string,
  releases: readonly { readonly programId: string; readonly sha256: string }[] = SOLANA_VAULT_RELEASES,
): string | null {
  if (releases.length === 0) return null;
  const release = releases.find((r) => r.programId === programId);
  if (!release)
    return "The configured Solana vault program is not a released Merrymen vault program.";
  if (release.sha256 !== sha256)
    return "The configured Solana vault binary hash is not the released hash of that program.";
  return null;
}
export const SOLANA_JUPITER_PROGRAM =
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const SOLANA_ASSOCIATED_TOKEN_PROGRAM =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SOLANA_SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const SOLANA_CLASSIC_TOKEN_PROGRAM =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOLANA_WRAPPED_SOL_MINT =
  "So11111111111111111111111111111111111111112";
/**
 * The Token-2022 mint extensions the vault program's check_mint (lib.rs)
 * accepts on the USDG mint, named as Agave's jsonParsed account reads name
 * them. On a USDG mint with any other extension, a transfer fee above 0 bps
 * (older or newer) or a transfer hook program, the program fails every swap,
 * buys and exits alike, with VaultError::Mint (6005). The mainnet mint read on
 * 2026-10-20 carries exactly these eight
 * (contracts/solana/runtime-tests/fixtures/usdg-mainnet-mint.json).
 */
export const SOLANA_VAULT_USDG_MINT_EXTENSIONS: readonly string[] = Object.freeze([
  "transferFeeConfig",
  "transferHook",
  "mintCloseAuthority",
  "confidentialTransferMint",
  "permanentDelegate",
  "confidentialTransferFeeConfig",
  "metadataPointer",
  "tokenMetadata",
]);
/**
 * Why the vault program's check_mint (lib.rs) refuses this USDG mint, or null
 * when it accepts it. `info` is the mint as Agave's jsonParsed account read
 * presents it (getAccountInfo's value.data.parsed.info, a UiMint). It mirrors
 * the USDG branch of check_mint: initialized, 6 decimals, only the extensions
 * in SOLANA_VAULT_USDG_MINT_EXTENSIONS, a transfer fee of 0 bps both older and
 * newer (whatever its maximum or epoch), and no transfer hook program. A field
 * it needs and cannot read is a refusal. The caller checks the mint's address
 * (USDG) and owner (Token-2022). On a mint it refuses, the program fails every
 * swap, buys and exits alike, with VaultError::Mint (6005), so the worker
 * must sign none. The owner's withdraw never checks the mint: once a hook
 * program is set it forwards the hook's accounts (resolveSolanaTransferHookAccounts).
 */
export function solanaVaultUsdgMintRefusal(info: unknown): string | null {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (!record(info) || info.isInitialized !== true) return "not-initialized";
  if (info.decimals !== 6) return "decimals";
  // Agave leaves out an empty extension list.
  const extensions = info.extensions === undefined ? [] : info.extensions;
  if (!Array.isArray(extensions)) return "unreadable";
  const seen = new Set<string>();
  for (const extension of extensions) {
    if (!record(extension) || typeof extension.extension !== "string" || seen.has(extension.extension))
      return "unreadable";
    const name = extension.extension, state = extension.state;
    seen.add(name);
    if (!SOLANA_VAULT_USDG_MINT_EXTENSIONS.includes(name)) return `extension:${name}`;
    if (name === "transferFeeConfig") {
      if (!record(state)) return "unreadable";
      for (const fee of [state.olderTransferFee, state.newerTransferFee]) {
        if (!record(fee) || typeof fee.transferFeeBasisPoints !== "number") return "unreadable";
        if (fee.transferFeeBasisPoints !== 0) return "transfer-fee";
      }
    } else if (name === "transferHook") {
      if (!record(state)) return "unreadable";
      if (state.programId !== null) return "transfer-hook";
    }
  }
  return null;
}
export const SOLANA_JUPITER_SHARED_ROUTE_DISCRIMINATOR = Uint8Array.from([
  193, 32, 155, 51, 65, 214, 156, 129,
]);
export const SOLANA_VAULT_MAX_DAILY_OPS = 96;
/** Account layout version 2 adds the owner-signed WSOL input caps. */
export const SOLANA_VAULT_VERSION = 2;
export const SOLANA_VAULT_ACCOUNT_SIZE = 2441;
export const SOLANA_VAULT_DISCRIMINATOR = Uint8Array.from([
  211, 8, 232, 43, 2, 152, 117, 119,
]);
export const SOLANA_SWAP_EVENT_DISCRIMINATOR = Uint8Array.from([
  150, 166, 26, 225, 28, 89, 38, 79,
]);
const DISCRIMINATORS = {
  initialize: [48, 191, 163, 44, 71, 129, 63, 164],
  session: [242, 193, 143, 179, 150, 25, 122, 227],
  revoke: [147, 196, 234, 31, 86, 199, 8, 234],
  breaker: [119, 127, 52, 124, 188, 82, 139, 186],
  withdraw: [183, 18, 70, 156, 148, 109, 161, 34],
  withdrawSol: [145, 131, 74, 136, 65, 137, 42, 38],
  execute: [56, 182, 124, 215, 155, 140, 157, 102],
} as const;
export class SolanaVaultValidationError extends Error {
  constructor(message = "Invalid Solana vault data") {
    super(message);
    this.name = "SolanaVaultValidationError";
  }
}
function pubkey(value: string): Uint8Array {
  try {
    const bytes = base58Decode(value);
    if (!bytes || bytes.length !== 32 || base58Encode(bytes) !== value)
      throw new Error();
    return bytes;
  } catch {
    throw new SolanaVaultValidationError("Invalid Solana public key");
  }
}
function int(value: bigint, signed = false): Uint8Array {
  if (
    typeof value !== "bigint" ||
    value < (signed ? -(1n << 63n) : 0n) ||
    value > (signed ? (1n << 63n) - 1n : (1n << 64n) - 1n)
  )
    throw new SolanaVaultValidationError("Invalid Solana integer");
  const out = new Uint8Array(8);
  if (signed) new DataView(out.buffer).setBigInt64(0, value, true);
  else new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}
function u16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 65535)
    throw new SolanaVaultValidationError("Invalid Solana integer");
  return Uint8Array.of(value & 255, value >>> 8);
}
function concat(...values: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(values.reduce((n, v) => n + v.length, 0));
  let offset = 0;
  for (const v of values) {
    out.set(v, offset);
    offset += v.length;
  }
  return out;
}
function meta(value: string, role: 0 | 1 | 2 | 3): AccountMeta {
  pubkey(value);
  return { address: address(value), role };
}
function instruction(
  program: string,
  disc: readonly number[],
  accounts: AccountMeta[],
  ...data: Uint8Array[]
): Instruction {
  pubkey(program);
  return {
    programAddress: address(program),
    accounts,
    data: concat(Uint8Array.from(disc), ...data),
  };
}
export async function deriveSolanaVaultAddress(
  program: string,
  owner: string,
): Promise<string> {
  return (
    await getProgramDerivedAddress({
      programAddress: address(program),
      seeds: [new TextEncoder().encode("vault"), pubkey(owner)],
    })
  )[0];
}
export async function deriveSolanaSwapAuthority(
  program: string,
  vault: string,
  seq: bigint,
): Promise<string> {
  return (
    await getProgramDerivedAddress({
      programAddress: address(program),
      seeds: [new TextEncoder().encode("swap"), pubkey(vault), int(seq)],
    })
  )[0];
}
export async function deriveSolanaAta(
  owner: string,
  mint: string,
  tokenProgram: string,
): Promise<string> {
  return (
    await getProgramDerivedAddress({
      programAddress: address(SOLANA_ASSOCIATED_TOKEN_PROGRAM),
      seeds: [pubkey(owner), pubkey(tokenProgram), pubkey(mint)],
    })
  )[0];
}
export interface SolanaVaultState {
  version: number;
  bump: number;
  owner: string;
  session: string;
  sessionEpoch: bigint;
  seq: bigint;
  expiresAt: bigint;
  perTrade: bigint;
  daily: bigint;
  /** Lamports of WSOL a single sell may put in, and over the rolling 24 hours. */
  perTradeWsol: bigint;
  dailyWsol: bigint;
  maxOps: number;
  paused: boolean;
  debits: { timestamp: bigint; notional: bigint; wsol: bigint }[];
}
export interface SolanaSwapExecutedEvent {
  vault: string;
  owner: string;
  session: string;
  sessionEpoch: bigint;
  seq: bigint;
  inputMint: string;
  outputMint: string;
  amountIn: bigint;
  amountOut: bigint;
  timestamp: bigint;
}
class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}
  take(n: number) {
    if (this.offset + n > this.bytes.length)
      throw new SolanaVaultValidationError();
    const b = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return b;
  }
  u8() {
    return this.take(1)[0]!;
  }
  u16() {
    const b = this.take(2);
    return b[0]! + b[1]! * 256;
  }
  u32() {
    const b = this.take(4);
    return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(
      0,
      true,
    );
  }
  u64() {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(
      0,
      true,
    );
  }
  i64() {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(
      0,
      true,
    );
  }
  key() {
    return base58Encode(this.take(32));
  }
  discriminator(expected: Uint8Array) {
    const actual = this.take(8);
    if (actual.some((v, i) => v !== expected[i]))
      throw new SolanaVaultValidationError();
  }
}
export function decodeSolanaVaultAccount(bytes: Uint8Array): SolanaVaultState {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length !== SOLANA_VAULT_ACCOUNT_SIZE
  )
    throw new SolanaVaultValidationError();
  const r = new Reader(bytes);
  r.discriminator(SOLANA_VAULT_DISCRIMINATOR);
  const version = r.u8(),
    bump = r.u8(),
    owner = r.key(),
    session = r.key(),
    sessionEpoch = r.u64(),
    seq = r.u64(),
    expiresAt = r.i64(),
    perTrade = r.u64(),
    daily = r.u64(),
    perTradeWsol = r.u64(),
    dailyWsol = r.u64(),
    maxOps = r.u16(),
    paused = r.u8(),
    count = r.u32();
  if (
    version !== SOLANA_VAULT_VERSION ||
    paused > 1 ||
    maxOps > SOLANA_VAULT_MAX_DAILY_OPS ||
    count > SOLANA_VAULT_MAX_DAILY_OPS
  )
    throw new SolanaVaultValidationError();
  const debits = Array.from({ length: count }, () => ({
    timestamp: r.i64(),
    notional: r.u64(),
    wsol: r.u64(),
  }));
  // Anchor does not clear old Vec capacity on shrink. Ignore unused allocated bytes.
  return {
    version,
    bump,
    owner,
    session,
    sessionEpoch,
    seq,
    expiresAt,
    perTrade,
    daily,
    perTradeWsol,
    dailyWsol,
    maxOps,
    paused: paused === 1,
    debits,
  };
}
export function decodeSolanaSwapEvent(
  bytes: Uint8Array,
): SolanaSwapExecutedEvent {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 208)
    throw new SolanaVaultValidationError();
  const r = new Reader(bytes);
  r.discriminator(SOLANA_SWAP_EVENT_DISCRIMINATOR);
  return {
    vault: r.key(),
    owner: r.key(),
    session: r.key(),
    sessionEpoch: r.u64(),
    seq: r.u64(),
    inputMint: r.key(),
    outputMint: r.key(),
    amountIn: r.u64(),
    amountOut: r.u64(),
    timestamp: r.i64(),
  };
}
export function buildInitializeSolanaVaultInstruction(p: {
  programAddress: string;
  vault: string;
  owner: string;
}): Instruction {
  return instruction(p.programAddress, DISCRIMINATORS.initialize, [
    meta(p.vault, 1),
    meta(p.owner, 3),
    meta(SOLANA_SYSTEM_PROGRAM, 0),
  ]);
}
export function buildCreateSolanaSessionInstruction(p: {
  programAddress: string;
  vault: string;
  owner: string;
  session: string;
  perTrade: bigint;
  daily: bigint;
  perTradeWsol: bigint;
  dailyWsol: bigint;
  maxOps: number;
  expiresAt: bigint;
}): Instruction {
  if (
    p.perTrade <= 0n ||
    p.perTrade > p.daily ||
    typeof p.perTradeWsol !== "bigint" ||
    typeof p.dailyWsol !== "bigint" ||
    p.perTradeWsol <= 0n ||
    p.perTradeWsol > p.dailyWsol ||
    p.maxOps < 1 ||
    p.maxOps > SOLANA_VAULT_MAX_DAILY_OPS ||
    p.session === p.owner ||
    p.session === p.vault
  )
    throw new SolanaVaultValidationError("Invalid Solana session limits");
  return instruction(
    p.programAddress,
    DISCRIMINATORS.session,
    [meta(p.vault, 1), meta(p.owner, 2)],
    pubkey(p.session),
    int(p.perTrade),
    int(p.daily),
    int(p.perTradeWsol),
    int(p.dailyWsol),
    u16(p.maxOps),
    int(p.expiresAt, true),
  );
}
export function buildRevokeSolanaSessionsInstruction(p: {
  programAddress: string;
  vault: string;
  owner: string;
}): Instruction {
  return instruction(p.programAddress, DISCRIMINATORS.revoke, [
    meta(p.vault, 1),
    meta(p.owner, 2),
  ]);
}
export function buildSetSolanaBreakerInstruction(p: {
  programAddress: string;
  vault: string;
  authority: string;
  paused: boolean;
}): Instruction {
  if (typeof p.paused !== "boolean") throw new SolanaVaultValidationError();
  return instruction(
    p.programAddress,
    DISCRIMINATORS.breaker,
    [meta(p.vault, 1), meta(p.authority, 2)],
    Uint8Array.of(Number(p.paused)),
  );
}
export function buildWithdrawSolanaVaultInstruction(p: {
  programAddress: string;
  vault: string;
  owner: string;
  mint: string;
  vaultToken: string;
  ownerToken: string;
  tokenProgram: string;
  amount: bigint;
  /**
   * The mint's transfer-hook accounts (resolveSolanaTransferHookAccounts), appended as
   * the instruction's remaining accounts; empty or absent while the mint names no hook
   * program. None may sign or be the owner: the program refuses a signing extra account.
   */
  hookAccounts?: readonly SolanaTransferHookAccount[];
}): Instruction {
  const hook = p.hookAccounts ?? [];
  if (hook.length > SOLANA_TRANSFER_HOOK_MAX_ACCOUNTS || hook.some((a) => (a.role !== 0 && a.role !== 1) || a.address === p.owner))
    throw new SolanaVaultValidationError("Invalid Solana transfer hook accounts");
  return instruction(
    p.programAddress,
    DISCRIMINATORS.withdraw,
    [
      meta(p.vault, 1),
      meta(p.owner, 2),
      meta(p.mint, 0),
      meta(p.vaultToken, 1),
      meta(p.ownerToken, 1),
      meta(p.tokenProgram, 0),
      ...hook.map((a) => meta(a.address, a.role)),
    ],
    int(p.amount),
  );
}

/** Token-2022's ExtensionType::TransferHook, and spl-transfer-hook-interface's Execute discriminator. */
const TOKEN_2022_TRANSFER_HOOK_EXTENSION = 14;
const TRANSFER_HOOK_EXECUTE = Uint8Array.from([105, 37, 101, 197, 75, 251, 102, 26]);
/** More than a withdrawal transaction could carry next to its own accounts. */
export const SOLANA_TRANSFER_HOOK_MAX_ACCOUNTS = 24;
/** An account a mint's transfer hook needs in a transfer: read-only (0) or writable (1), never a signer. */
export interface SolanaTransferHookAccount {
  address: string;
  role: 0 | 1;
}
/**
 * The transfer-hook program a Token-2022 mint's TransferHook extension names,
 * or null when the mint has no such extension or names no program (USDG
 * today: the extension is there, the issuer holds its authority, the program
 * is unset). Throws on bytes that are not a Token-2022 mint.
 */
export function solanaMintTransferHookProgram(data: Uint8Array): string | null {
  const bad = () => new SolanaVaultValidationError("Invalid Solana mint data");
  if (data.length === 82) return null;
  if (data.length <= 166 || data[165] !== 1) throw bad();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = 166; at + 4 <= data.length; ) {
    const type = view.getUint16(at, true), length = view.getUint16(at + 2, true);
    if (type === 0) break;
    if (at + 4 + length > data.length) throw bad();
    if (type === TOKEN_2022_TRANSFER_HOOK_EXTENSION) {
      if (length !== 64) throw bad();
      const program = data.subarray(at + 4 + 32, at + 4 + 64);
      return program.every((b) => b === 0) ? null : base58Encode(program);
    }
    at += 4 + length;
  }
  return null;
}
/** The hook's ExtraAccountMetaList account for `mint`: PDA ["extra-account-metas", mint] of the hook program. */
export async function deriveSolanaTransferHookValidation(hookProgram: string, mint: string): Promise<string> {
  return (
    await getProgramDerivedAddress({
      programAddress: address(hookProgram),
      seeds: [new TextEncoder().encode("extra-account-metas"), pubkey(mint)],
    })
  )[0];
}
/**
 * The remaining accounts a vault withdrawal of a hooked mint carries, resolved
 * as spl-token's addExtraAccountMetasForExecute and Token-2022's on-chain
 * helper resolve them: every extra account the hook's ExtraAccountMetaList
 * (`validationData`, null when that account does not exist) names for
 * Execute, in order, then the validation account and the hook program. The
 * on-chain helper finds each by address, so the order is only for reading.
 * `accountData` reads an account's data for a seed taken from it. A list this
 * cannot resolve, or one that asks for a signer, throws: the vault's withdraw
 * refuses a signing extra account, so the owner's signature never reaches a hook.
 *
 * Any account it names that is `owner`'s wallet throws too, signer or not
 * (SOLANA_TRANSFER_HOOK_NAMES_OWNER): the owner signs every withdrawal, so the
 * runtime marks the wallet a signer in each instruction that carries it, and
 * the program refuses any signing remaining account (owner decision, before
 * the program is frozen: such a hook holds USDG in the vault until the issuer
 * changes it; WSOL and SOL withdrawals never carry a hook's accounts).
 */
export const SOLANA_TRANSFER_HOOK_NAMES_OWNER =
  "The token's transfer hook needs your wallet's account, which the vault never passes to a hook, so USDG stays in the vault until the issuer changes the hook";
export async function resolveSolanaTransferHookAccounts(p: {
  hookProgram: string;
  mint: string;
  source: string;
  destination: string;
  authority: string;
  /** The vault's owner, who signs the withdrawal: never one of the accounts returned. */
  owner: string;
  amount: bigint;
  validationData: Uint8Array | null;
  accountData: (address: string) => Promise<Uint8Array | null>;
}): Promise<SolanaTransferHookAccount[]> {
  const accounts = await resolveTransferHookAccounts(p);
  if (accounts.some((account) => account.address === p.owner)) throw new SolanaVaultValidationError(SOLANA_TRANSFER_HOOK_NAMES_OWNER);
  return accounts;
}
async function resolveTransferHookAccounts(p: Parameters<typeof resolveSolanaTransferHookAccounts>[0]): Promise<SolanaTransferHookAccount[]> {
  const bad = (why: string) => new SolanaVaultValidationError(`The token's transfer hook cannot be resolved: ${why}`);
  const validation = await deriveSolanaTransferHookValidation(p.hookProgram, p.mint);
  const tail: SolanaTransferHookAccount[] = [{ address: validation, role: 0 }, { address: p.hookProgram, role: 0 }];
  if (p.validationData === null) return [{ address: p.hookProgram, role: 0 }];
  const data = p.validationData, view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let metas: Uint8Array | null = null;
  for (let at = 0; at + 12 <= data.length; ) {
    const type = data.subarray(at, at + 8), length = view.getUint32(at + 8, true);
    if (type.every((b) => b === 0)) break;
    if (at + 12 + length > data.length) throw bad("malformed list");
    if (type.every((b, i) => b === TRANSFER_HOOK_EXECUTE[i])) {
      metas = data.subarray(at + 12, at + 12 + length);
      break;
    }
    at += 12 + length;
  }
  if (metas === null) return tail;
  if (metas.length < 4) throw bad("malformed list");
  const count = new DataView(metas.buffer, metas.byteOffset, metas.byteLength).getUint32(0, true);
  if (count > SOLANA_TRANSFER_HOOK_MAX_ACCOUNTS - 2 || metas.length < 4 + 35 * count) throw bad("too many accounts");
  const ixData = concat(TRANSFER_HOOK_EXECUTE, int(p.amount));
  const keys = [p.source, p.mint, p.destination, p.authority, validation];
  const dataOf = async (index: number): Promise<Uint8Array> => {
    const key = keys[index];
    if (key === undefined) throw bad("unknown account index");
    const found = await p.accountData(key);
    if (!found) throw bad("missing account data");
    return found;
  };
  const resolved: SolanaTransferHookAccount[] = [];
  for (let i = 0; i < count; i++) {
    const entry = metas.subarray(4 + 35 * i, 4 + 35 * (i + 1));
    const discriminator = entry[0]!, config = entry.subarray(1, 33), signer = entry[33]!, writable = entry[34]!;
    if (signer !== 0) throw bad("it asks for a signer");
    if (writable > 1) throw bad("malformed list");
    let key: string;
    if (discriminator === 0) key = base58Encode(config);
    else if (discriminator === 1 || discriminator >= 128) {
      const program = discriminator === 1 ? p.hookProgram : keys[discriminator - 128];
      if (program === undefined) throw bad("unknown program index");
      const seeds: Uint8Array[] = [];
      for (let at = 0; at < 32; ) {
        const kind = config[at]!;
        if (kind === 0) break;
        if (kind === 1) {
          const length = config[at + 1] ?? 0;
          if (at + 2 + length > 32) throw bad("malformed seed");
          seeds.push(config.slice(at + 2, at + 2 + length));
          at += 2 + length;
        } else if (kind === 2) {
          const index = config[at + 1] ?? 0, length = config[at + 2] ?? 0;
          if (at + 3 > 32 || index + length > ixData.length) throw bad("malformed seed");
          seeds.push(ixData.slice(index, index + length));
          at += 3;
        } else if (kind === 3) {
          const key = keys[config[at + 1] ?? 255];
          if (at + 2 > 32 || key === undefined) throw bad("unknown account index");
          seeds.push(pubkey(key));
          at += 2;
        } else if (kind === 4) {
          const index = config[at + 1] ?? 255, start = config[at + 2] ?? 0, length = config[at + 3] ?? 0;
          if (at + 4 > 32) throw bad("malformed seed");
          const from = await dataOf(index);
          if (from.length < start + length) throw bad("account data too small");
          seeds.push(from.slice(start, start + length));
          at += 4;
        } else throw bad("unknown seed");
      }
      try {
        key = (await getProgramDerivedAddress({ programAddress: address(program), seeds }))[0];
      } catch {
        throw bad("unusable seeds");
      }
    } else if (discriminator === 2) {
      if (config[0] === 1) {
        const index = config[1]!;
        if (index + 32 > ixData.length) throw bad("instruction data too small");
        key = base58Encode(ixData.subarray(index, index + 32));
      } else if (config[0] === 2) {
        const from = await dataOf(config[1]!), start = config[2]!;
        if (from.length < start + 32) throw bad("account data too small");
        key = base58Encode(from.subarray(start, start + 32));
      } else throw bad("unknown key data");
    } else throw bad("unknown account kind");
    keys.push(key);
    resolved.push({ address: key, role: writable === 1 ? 1 : 0 });
  }
  return [...resolved, ...tail];
}
export interface ExecuteSolanaSwapParameters {
  programAddress: string;
  vault: string;
  sessionSigner: string;
  feePayer: string;
  inputMint: string;
  outputMint: string;
  vaultInput: string;
  vaultOutput: string;
  swapAuthority: string;
  tempInput: string;
  /**
   * The owner's input-mint ATA, or null to leave it out. The program needs it only to
   * return tokens already sitting in `tempInput` (a donation), and fails closed without it.
   * Null encodes Anchor's absent optional account: the vault program ID, read-only.
   */
  ownerRefund: string | null;
  inputTokenProgram: string;
  outputTokenProgram: string;
  expectedSeq: bigint;
  sessionEpoch: bigint;
  amountIn: bigint;
  minOut: bigint;
  deadline: bigint;
  slippageBps: number;
  routeData: Uint8Array;
  /** Jupiter instruction accounts in their original order. No outer signer is forwarded. */
  routeAccounts: readonly { address: string; role: 0 | 1 | 2 | 3 }[];
}
export function buildExecuteSolanaSwapInstruction(
  p: ExecuteSolanaSwapParameters,
): Instruction {
  if (
    p.amountIn <= 0n ||
    p.minOut <= 0n ||
    p.slippageBps > 100 ||
    // The program reads the route's last 19 bytes after an 8-byte discriminator
    // and refuses anything shorter than 32 bytes.
    p.routeData.length < 32 ||
    p.routeData.length > 2048 ||
    p.routeAccounts.length < 11 ||
    p.routeAccounts.length > 64 ||
    p.ownerRefund === p.programAddress
  )
    throw new SolanaVaultValidationError("Invalid Solana swap");
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, p.routeData.length, true);
  const fixed = [
    meta(p.vault, 1),
    meta(p.sessionSigner, 2),
    meta(p.feePayer, 3),
    meta(p.inputMint, 0),
    meta(p.outputMint, 0),
    meta(p.vaultInput, 1),
    meta(p.vaultOutput, 1),
    meta(p.swapAuthority, 0),
    meta(p.tempInput, 1),
    meta(p.inputTokenProgram, 0),
    meta(p.outputTokenProgram, 0),
    meta(SOLANA_JUPITER_PROGRAM, 0),
    meta(SOLANA_ASSOCIATED_TOKEN_PROGRAM, 0),
    meta(SOLANA_SYSTEM_PROGRAM, 0),
    p.ownerRefund === null ? meta(p.programAddress, 0) : meta(p.ownerRefund, 1),
  ];
  const routes = p.routeAccounts.map((a) =>
    meta(a.address, (a.role & 1) as 0 | 1),
  );
  return instruction(
    p.programAddress,
    DISCRIMINATORS.execute,
    [...fixed, ...routes],
    int(p.expectedSeq),
    int(p.sessionEpoch),
    int(p.amountIn),
    int(p.minOut),
    int(p.deadline, true),
    u16(p.slippageBps),
    length,
    p.routeData,
  );
}

/** Owner-only recovery of native SOL above the custody account's rent reserve. */
export function buildWithdrawSolanaNativeInstruction(p: {
  programAddress: string;
  vault: string;
  owner: string;
  amount: bigint;
}): Instruction {
  if (p.amount <= 0n)
    throw new SolanaVaultValidationError("Invalid Solana withdrawal");
  return instruction(
    p.programAddress,
    DISCRIMINATORS.withdrawSol,
    [meta(p.vault, 1), meta(p.owner, 3)],
    int(p.amount),
  );
}
