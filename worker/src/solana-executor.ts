import type { SolanaQuote } from "../../packages/core/src/solana";
import { createHash } from "node:crypto";
import {
  address, appendTransactionMessageInstructions, compileTransaction, compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage, getAddressFromPublicKey, getBase58Decoder, getBase58Encoder, getBase64EncodedWireTransaction, getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction, getTransactionDecoder, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  signTransaction, type AddressesByLookupTableAddress, type Blockhash, type Instruction,
} from "@solana/kit";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { parseSolanaRawAmount, parseSolanaSwapIntent, parseSolanaTradeFloor, SolanaPaperValidationError, solanaTradeFloorMet, validateSolanaQuote,
  type SolanaMint, type SolanaSwapIntent } from "../../packages/core/src/solana";
import {
  buildExecuteSolanaSwapInstruction, decodeSolanaVaultAccount, deriveSolanaAta,
  deriveSolanaSwapAuthority, deriveSolanaVaultAddress, SOLANA_CLASSIC_TOKEN_PROGRAM,
  SOLANA_WRAPPED_SOL_MINT, type SolanaVaultState,
} from "../../packages/core/src/solana-live";
import { SolanaLiveMarketError, validateJupiterCpi, type JupiterCpiRoute, type SolanaCpiBuildRequest } from "./solana-live-market";
import { readSolanaEachProvider, readSolanaPriorityFee, readSolanaQuorum, type SolanaLiveRead, type SolanaLiveRpc } from "./solana-live-rpc";
import { SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS, solanaReferenceNotional, verifySolanaReferenceBound, type SolanaPythGeneration, type SolanaReferenceBound } from "./solana-reference-price";
import { isSolanaTransactionError, settleSolanaReceipt, type SolanaVaultEvidence } from "./solana-settlement";
import { SolanaRpcError } from "./solana-rpc";

export interface SolanaLiveIntent {
  kind: "spl-swap"; chain: typeof CHAINS.solana; mode: "live";
  requestId: string; owner: string; vault: string;
  inputMint: string; outputMint: string; amountRaw: string; slippageBps: number;
}
/** Supplied only by the trusted portfolio reader, never directly from caller JSON. */
export interface SolanaLiveRiskEvidence {
  observedAtMs: number;
  slot: number;
  notionalUsdg: string;
  equityUsdg: string;
  peakEquityUsdg: string;
  cashUsdg: string;
  wsolRaw: string;
  /** Independent SOL price bound; the signed minimum output may not be below its floor. */
  reference: SolanaReferenceBound;
}
export interface SolanaSignedSubmission {
  version: 1;
  intent: SolanaLiveIntent;
  programId: string;
  session: string;
  feePayer: string;
  sessionEpoch: string;
  vaultSequence: string;
  signature: string;
  signedTransactionBase64: string;
  messageBase64: string;
  /** Resolved from RPC-verified tables before signing, in wire account order. */
  loadedAddresses: { writable: readonly string[]; readonly: readonly string[] };
  recentBlockhash: string;
  lastValidBlockHeight: string;
  minContextSlot: number;
  minOutAmount: string;
  quotedOutAmount: string;
  inputTokenAccount: string;
  outputTokenAccount: string;
  inputTokenProgram: string;
  outputTokenProgram: string;
  inputBalanceBefore: string;
  outputBalanceBefore: string;
  maxFeeLamports: string;
  feeLamports: string;
  rentLamports: string;
  preparedAtMs: number;
  safetyObservedAtMs: number;
  quote: SolanaQuote;
  risk: SolanaLiveRiskEvidence;
}
interface SolanaSettlementFields {
  signature: string;
  slot: number;
  amountIn: string;
  amountOut: string;
  finalizedAtMs: number;
}
export type SolanaLiveSettlement = SolanaSettlementFields & (
  { status: "finalized" | "failed"; feeLamports: string } |
  { status: "expired"; feeLamports: null; expiryProof: {
    vaultSequence: string; sessionEpoch: string; blockHeight: string; reason: "blockhash-expired" | "session-revoked" | "sequence-consumed";
    /**
     * sequence-consumed only: the earliest cluster time (unix seconds) these bytes could have run at
     * (solanaDebitWindowStart). The vault's debit log at the proof held no debit at or after it.
     */
    debitWindowStart?: string;
  } }
);
export interface SolanaLiveRecord {
  submission: SolanaSignedSubmission;
  status: "pending" | "finalized" | "failed" | "expired";
  settlement?: SolanaLiveSettlement;
}
export interface SolanaLiveJournal {
  get(owner: string, requestId: string): Promise<SolanaLiveRecord | null>;
  /** Atomic durable commit + risk admission. False means conflict; caller MUST NOT send. */
  recordSigned(submission: SolanaSignedSubmission): Promise<boolean>;
  /** CAS on owner/requestId/signature; only canonical finalized network evidence. */
  settle(owner: string, requestId: string, signature: string, settlement: SolanaLiveSettlement): Promise<void>;
}

export class SolanaExecutionError extends Error {
  /**
   * price-moved: the fresh route guarantees less than the minimum the owner
   * previewed; nothing was signed or recorded. `freshMinOutAmount` is what that
   * route guarantees, so the owner can see it and choose to trade at it (a new
   * request carrying it as its floor). It is shown, never applied by itself.
   */
  readonly freshMinOutAmount?: string;
  constructor(readonly code: "invalid-intent" | "invalid-state" | "unsafe-program" | "unsafe-route" | "simulation" | "fee-cap" | "risk" | "conflict" | "cancelled" | "owner-refund" | "price-moved",
    detail: { freshMinOutAmount?: string } = {}) {
    super(code === "owner-refund"
      ? "Solana live execution refused: owner-refund. Tokens were sent to this swap's temporary account; the vault returns them to the owner's own token account for that mint, which is closed or unsafe (a delegate or close authority set, or frozen). This swap cannot run until that account is usable; the owner's status says what to fix."
      : `Solana live execution refused: ${code}.`);
    this.name = "SolanaExecutionError";
    if (code === "price-moved" && detail.freshMinOutAmount !== undefined) this.freshMinOutAmount = detail.freshMinOutAmount;
  }
}
function fail(code: SolanaExecutionError["code"] = "invalid-state"): never { throw new SolanaExecutionError(code); }
/**
 * The build quote, checked again once the route is in hand and again before
 * signing. The builder already checked it against the request, so what fails
 * here is a quote that went stale meanwhile (a slow provider or RPC): answered
 * as the builder's 'provider' (preview again shortly), never the owner's 400
 * with the validator's text.
 */
function checkRouteQuote(quote: SolanaQuote, intent: SolanaSwapIntent, nowMs: number): void {
  try { validateSolanaQuote(quote, intent, nowMs); } catch (error) {
    if (error instanceof SolanaPaperValidationError) throw new SolanaLiveMarketError("provider");
    throw error;
  }
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail(); return value;
}
function context(raw: unknown, minimum = 1): { slot: number; value: unknown } {
  if (!object(raw) || !object(raw.context) || integer(raw.context.slot) < minimum || !Object.hasOwn(raw, "value")) return fail();
  return { slot: integer(raw.context.slot), value: raw.value };
}
type Account = { owner: string; executable: boolean; lamports: bigint; data: Buffer };
function account(raw: unknown): Account {
  if (!object(raw) || typeof raw.owner !== "string" || typeof raw.executable !== "boolean" ||
      !Array.isArray(raw.data) || raw.data[1] !== "base64" || typeof raw.data[0] !== "string") return fail();
  try { address(raw.owner); } catch { return fail(); }
  const data = Buffer.from(raw.data[0], "base64");
  if (data.toString("base64") !== raw.data[0]) return fail();
  return { owner: raw.owner, executable: raw.executable, lamports: BigInt(integer(raw.lamports)), data };
}
function tokenBalance(raw: Account, mint: string, authority: string, program: string): bigint {
  const data = raw.data;
  if (raw.owner !== program || raw.executable || data.length < 165 ||
      getBase58Decoder().decode(data.subarray(0, 32)) !== mint ||
      getBase58Decoder().decode(data.subarray(32, 64)) !== authority ||
      data[108] !== 1 || data.readUInt32LE(72) !== 0 || data.readBigUInt64LE(121) !== 0n || data.readUInt32LE(129) !== 0) return fail();
  return data.readBigUInt64LE(64);
}
/**
 * Tokens already in a swap's temporary input ATA. A System-owned prefunded
 * address holds lamports only, but for WSOL they become tokens: the swap's
 * init_if_needed opens the native account over them, and InitializeAccount3
 * sets its amount to the lamports above its rent-exempt reserve
 * (`nativeReserve`), which the vault must then refund to the owner. Anyone can
 * send those lamports, so a sell must see them as the donation they become.
 */
function pendingDonation(raw: Account, mint: string, authority: string, program: string, nativeReserve: bigint | null): bigint {
  if (raw.owner === "11111111111111111111111111111111" && !raw.executable && raw.data.length === 0) {
    if (mint !== SOLANA_WRAPPED_SOL_MINT || raw.lamports === 0n) return 0n;
    if (nativeReserve === null) return fail();
    return raw.lamports > nativeReserve ? raw.lamports - nativeReserve : 0n;
  }
  return tokenBalance(raw, mint, authority, program);
}
/**
 * Why the owner's own token account for a mint cannot take a donation back,
 * which decides what the owner can do about it:
 * - missing: no account (closed or never opened), or an address holding only
 *   lamports, which opening the account takes over. Reopening it fixes it, as
 *   does an owner withdrawal, which opens it (CreateIdempotent).
 * - delegated: a delegate (or delegated amount) or a close authority is set.
 *   Only removing them in the owner's wallet fixes it; a withdrawal does not
 *   (the vault's Withdraw does not check that account) and would leave the
 *   withdrawn tokens where the delegate can move them.
 * - frozen: only the token's freeze authority can thaw it.
 * - invalid: anything else (not this owner's token account for this mint).
 */
export type SolanaOwnerRefundProblem = "missing" | "delegated" | "frozen" | "invalid";
function ownerRefundProblem(raw: unknown, mint: string, owner: string, program: string): SolanaOwnerRefundProblem | null {
  if (raw === null) return "missing";
  let parsed: Account;
  try { parsed = account(raw); } catch { return "invalid"; }
  try { tokenBalance(parsed, mint, owner, program); return null; } catch { /* why it is unusable, below */ }
  const data = parsed.data;
  if (parsed.owner === "11111111111111111111111111111111" && !parsed.executable && data.length === 0) return "missing";
  if (parsed.owner !== program || parsed.executable || data.length < 165 ||
      getBase58Decoder().decode(data.subarray(0, 32)) !== mint || getBase58Decoder().decode(data.subarray(32, 64)) !== owner) return "invalid";
  if (data[108] === 2) return "frozen";
  // Initialized, this owner's, this mint's: tokenBalance refused it only for a delegate, a delegated amount or a close authority.
  return data[108] === 1 ? "delegated" : "invalid";
}
/**
 * Tokens anyone sent to a swap's temporary input account (`temp`, a raw
 * getMultipleAccounts entry, null when absent), and whether the owner's own
 * token account for that mint (`ownerToken`) can take them back, and if not,
 * why (ownerAccountProblem). The vault returns such a donation to that account
 * during the swap, so while it is closed or unsafe (a delegate, a close
 * authority, frozen, another owner or mint) every swap from that mint at this
 * sequence is refused: owner-refund. A temporary account that is neither empty
 * nor this mint's token account of the swap authority is invalid-state.
 * `nativeReserve` is the rent-exempt reserve of a 165-byte token account: for
 * WSOL, lamports above it at a System-owned temporary address are a donation
 * too (pendingDonation). Required when `mint` is WSOL and such lamports wait.
 */
export function solanaPendingRefund(temp: unknown, ownerToken: unknown, mint: string, swapAuthority: string, owner: string, program: string,
  nativeReserve: bigint | null = null): { donation: bigint; ownerAccountUsable: boolean; ownerAccountProblem: SolanaOwnerRefundProblem | null } {
  const donation = temp === null ? 0n : pendingDonation(account(temp), mint, swapAuthority, program, nativeReserve);
  const ownerAccountProblem = ownerRefundProblem(ownerToken, mint, owner, program);
  return { donation, ownerAccountUsable: ownerAccountProblem === null, ownerAccountProblem };
}
/** An input mint whose next swap the executor would refuse with owner-refund, and why the owner's account cannot take the donation back. */
export type SolanaOwnerRefundBlock = { mint: string; problem: SolanaOwnerRefundProblem };
/**
 * The input mints (USDG for buys, WSOL for sells and exits) whose next swap, at
 * vault sequence `seq`, the executor would refuse with owner-refund, each with
 * why. Read at or after `minContextSlot`.
 */
export async function readSolanaOwnerRefundBlocks(rpc: SolanaLiveRpc, programId: string, vault: string, owner: string, seq: bigint, minContextSlot = 1): Promise<SolanaOwnerRefundBlock[]> {
  const swapAuthority = await deriveSolanaSwapAuthority(programId, vault, seq);
  const mints = [[SOLANA_USDG_MINT, TOKEN_2022_PROGRAM], [SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM]] as const;
  const keys: string[] = [];
  for (const [mint, program] of mints) keys.push(await deriveSolanaAta(swapAuthority, mint, program), await deriveSolanaAta(owner, mint, program));
  return rpc.read(async read => {
    const result = context(await read("getMultipleAccounts", [keys, { encoding: "base64", commitment: "finalized", minContextSlot }]), minContextSlot);
    if (!Array.isArray(result.value) || result.value.length !== keys.length) return fail();
    const accounts = result.value as unknown[];
    // Lamports at the WSOL temporary address become a donation once the swap opens it there.
    const wsolTemp = accounts[2] === null ? null : account(accounts[2]);
    const nativeReserve = wsolTemp && wsolTemp.owner === "11111111111111111111111111111111" && wsolTemp.data.length === 0 && wsolTemp.lamports > 0n
      ? BigInt(integer(await read("getMinimumBalanceForRentExemption", [165, { commitment: "finalized" }]))) : null;
    return mints.flatMap(([mint, program], index) => {
      const refund = solanaPendingRefund(accounts[2 * index], accounts[2 * index + 1], mint, swapAuthority, owner, program, nativeReserve);
      return refund.donation > 0n && refund.ownerAccountProblem !== null ? [{ mint, problem: refund.ownerAccountProblem }] : [];
    });
  });
}
function paperIntent(intent: SolanaLiveIntent) {
  return parseSolanaSwapIntent({ kind: intent.kind, chain: intent.chain, mode: "paper", requestId: intent.requestId,
    inputMint: intent.inputMint, outputMint: intent.outputMint, amountRaw: intent.amountRaw, slippageBps: intent.slippageBps });
}
export function parseSolanaLiveIntent(raw: unknown): SolanaLiveIntent {
  const keys = ["kind", "chain", "mode", "requestId", "owner", "vault", "inputMint", "outputMint", "amountRaw", "slippageBps"];
  if (!object(raw) || Object.keys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw, key)) ||
      raw.mode !== "live" || typeof raw.owner !== "string" || typeof raw.vault !== "string") return fail("invalid-intent");
  try {
    address(raw.owner); address(raw.vault);
    const intent = raw as unknown as SolanaLiveIntent;
    paperIntent(intent);
    if (![SOLANA_USDG_MINT, SOLANA_WRAPPED_SOL_MINT].includes(intent.inputMint) ||
        ![SOLANA_USDG_MINT, SOLANA_WRAPPED_SOL_MINT].includes(intent.outputMint)) return fail("invalid-intent");
    return { kind: "spl-swap", chain: CHAINS.solana, mode: "live", requestId: intent.requestId,
      owner: intent.owner, vault: intent.vault, inputMint: intent.inputMint, outputMint: intent.outputMint,
      amountRaw: intent.amountRaw, slippageBps: intent.slippageBps };
  } catch { return fail("invalid-intent"); }
}
export interface SolanaExecutorOptions {
  programId: string;
  /** SHA256 of immutable ProgramData's entire executable region (bytes after metadata offset 45). */
  programBinarySha256: string;
  sessionKeyPair: CryptoKeyPair;
  feePayerKeyPair: CryptoKeyPair;
  rpc: SolanaLiveRpc;
  market: { build(request: SolanaCpiBuildRequest): Promise<JupiterCpiRoute>; readMint(address: string): Promise<SolanaMint> };
  journal: SolanaLiveJournal;
  maxFeeLamports: string;
  /** Lowest compute-unit price (micro-lamports) ever paid. Default 0. */
  computeUnitPriceMicroLamports?: string;
  /**
   * Highest compute-unit price. The price follows recent fees on this swap's
   * writable accounts up to this, and the whole fee plus rent always stays
   * within maxFeeLamports. Default: the larger of
   * SOLANA_DEFAULT_MAX_COMPUTE_UNIT_PRICE and the minimum, so a minimum that
   * used to be the fixed price keeps working alone. An explicit maximum below
   * the minimum is refused (the app runtime refuses it first, as configuration).
   */
  maxComputeUnitPriceMicroLamports?: string;
  assessRisk(input: { intent: SolanaLiveIntent; quote: SolanaQuote; vaultState: SolanaVaultState;
    slot: number; observedAtMs: number }): Promise<SolanaLiveRiskEvidence>;
  now?: () => number;
  signal?: AbortSignal;
  /** The Pyth generation `assessRisk`'s reference must come from: the app runtime's MERRYMEN_SOLANA_PYTH_GENERATION. Default: SOLANA_PYTH_DEFAULT_GENERATION. */
  pythGeneration?: SolanaPythGeneration;
  /** The tolerance `assessRisk`'s bound must carry: the app runtime's MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS. Default: SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS. */
  referenceToleranceBps?: number;
  /**
   * The lowest slot the vault snapshot a swap is signed against may come from:
   * the app runtime passes its book's slot and the slot its latest owner
   * transaction finalized at. A provider whose bank is behind it errors instead
   * of answering with the vault from before them, so nothing is signed against
   * a sequence an owner withdrawal already consumed (audit live-M1, trigger b).
   * The app runtime's assessRisk also refuses unless every provider shows the
   * snapshot's sequence and session epoch at the prepared slot. Default 1.
   */
  minSnapshotSlot?: number;
}
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const LOOKUP_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
const COMPUTE_PROGRAM = "ComputeBudget111111111111111111111111111111";
const U64_MAX = (1n << 64n) - 1n;
/** 1 lamport per compute unit: about 0.00024 SOL on a typical 240k-unit swap. */
export const SOLANA_DEFAULT_MAX_COMPUTE_UNIT_PRICE = 1_000_000n;
/** Base fee for the two signatures (fee payer and session) every swap carries. */
const SIGNATURE_FEES = 10_000n;
async function readRawAccount(rpc: SolanaLiveRead, key: string, slot: number) {
  return account(context(await rpc("getAccountInfo", [key, { encoding: "base64", commitment: "finalized", minContextSlot: slot }]), slot).value);
}
const PROGRAM_DATA_SLICE = 98_304;
/**
 * The immutable deployment's executable bytes hash to `hash`. Returns whether
 * those hashed bytes also hold the program id's 32 bytes: declare_id! embeds
 * them, and a build for any other id fails every instruction with
 * DeclaredProgramIdMismatch. The search carries 31 bytes across slices, so an
 * id split by a slice boundary is still found.
 */
async function verifyDeployment(rpc: SolanaLiveRead, programId: string, hash: string, slot: number): Promise<{ declaresProgramId: boolean }> {
  address(programId);
  const id = Buffer.from(getBase58Encoder().encode(programId));
  if (id.length !== 32) return fail("unsafe-program");
  if (!/^[a-f0-9]{64}$/.test(hash)) return fail("unsafe-program");
  const program = await readRawAccount(rpc, programId, slot);
  if (program.owner !== UPGRADEABLE_LOADER || !program.executable || program.data.length !== 36 || program.data.readUInt32LE(0) !== 2) return fail("unsafe-program");
  const dataAddress = getBase58Decoder().decode(program.data.subarray(4));
  const readSlice = async (offset: number, length: number) => {
    const raw = context(await rpc("getAccountInfo", [dataAddress, { encoding: "base64", commitment: "finalized", minContextSlot: slot,
      dataSlice: { offset, length } }]), slot).value;
    if (!object(raw)) return fail("unsafe-program");
    const parsed = account(raw);
    if (parsed.owner !== UPGRADEABLE_LOADER || parsed.executable) return fail("unsafe-program");
    return { ...parsed, space: integer(raw.space) };
  };
  const header = await readSlice(0, 45);
  if (header.data.length !== 45 || header.data.readUInt32LE(0) !== 3 || header.data[12] !== 0 || header.space <= 45 || header.space > 2_097_152) return fail("unsafe-program");
  const digest = createHash("sha256");
  let carry = Buffer.alloc(0), declaresProgramId = false;
  for (let offset = 45; offset < header.space; offset += PROGRAM_DATA_SLICE) {
    const length = Math.min(PROGRAM_DATA_SLICE, header.space - offset);
    const chunk = await readSlice(offset, length);
    if (chunk.space !== header.space || chunk.data.length !== length) return fail("unsafe-program");
    digest.update(chunk.data);
    const window = Buffer.concat([carry, chunk.data]);
    if (!declaresProgramId && window.indexOf(id) >= 0) declaresProgramId = true;
    carry = window.subarray(Math.max(0, window.length - (id.length - 1)));
  }
  if (digest.digest("hex") !== hash) return fail("unsafe-program");
  return { declaresProgramId };
}
const DEPLOYMENT_CACHE_MS = 10 * 60_000;
const verifiedDeployments = new Map<string, { atMs: number; declaresProgramId: boolean }>();
/**
 * Verifies the vault program on EVERY provider: owned by the upgradeable loader
 * with no upgrade authority, and ProgramData's executable bytes hash to the
 * audited build. One lying provider cannot hide an upgradeable or substituted
 * program. An immutable program can never change or close, so a success is
 * cached per provider pair for ten minutes; failures are never cached.
 *
 * `declaresProgramId`: the hashed bytes embed the program id (declare_id!).
 * With `requireDeclaredProgramId` a binary built for another id is refused as
 * unsafe-program; the executor always asks for it.
 */
export async function verifySolanaVaultDeployment(rpc: SolanaLiveRpc, programId: string, binarySha256: string,
  options: { requireDeclaredProgramId?: boolean } = {}): Promise<{ slot: number; declaresProgramId: boolean }> {
  const cacheKey = rpc.providerKey ? `${rpc.providerKey}\n${programId}\n${binarySha256}` : undefined;
  const cached = cacheKey === undefined ? undefined : verifiedDeployments.get(cacheKey);
  const at = Date.now();
  let result: { slot: number; declaresProgramId: boolean };
  if (cached !== undefined && at >= cached.atMs && at - cached.atMs < DEPLOYMENT_CACHE_MS) {
    const slot = integer(await rpc.read(read => read("getSlot", [{ commitment: "finalized" }])));
    if (slot < 1) return fail();
    result = { slot, declaresProgramId: cached.declaresProgramId };
  } else {
    const views = await readSolanaEachProvider(rpc, async read => {
      const slot = integer(await read("getSlot", [{ commitment: "finalized" }]));
      if (slot < 1) return fail();
      return { slot, ...await verifyDeployment(read, programId, binarySha256, slot) };
    });
    // The bytes are pinned by the hash, so every provider must find the same.
    result = { slot: views[0]!.slot, declaresProgramId: views.every(view => view.declaresProgramId) };
    if (cacheKey !== undefined) verifiedDeployments.set(cacheKey, { atMs: at, declaresProgramId: result.declaresProgramId });
  }
  if (options.requireDeclaredProgramId && !result.declaresProgramId) return fail("unsafe-program");
  return result;
}
/**
 * The vault's finalized state. With `minContextSlot`, only a bank at or after
 * that slot may answer (an RPC behind it errors instead of answering stale).
 */
export async function readSolanaVaultState(rpc: SolanaLiveRpc, programId: string, owner: string, minContextSlot?: number): Promise<{ vault: string; slot: number; state: SolanaVaultState }> {
  const vault = await deriveSolanaVaultAddress(programId, owner);
  if (minContextSlot !== undefined && (!Number.isSafeInteger(minContextSlot) || minContextSlot < 1)) return fail();
  return rpc.read(async read => {
    const raw = context(await read("getAccountInfo", [vault, { encoding: "base64", commitment: "finalized", ...(minContextSlot === undefined ? {} : { minContextSlot }) }]), minContextSlot ?? 1);
    const data = account(raw.value);
    if (data.owner !== programId || data.executable) return fail();
    const state = decodeSolanaVaultAccount(data.data);
    if (state.owner !== owner) return fail();
    return { vault, slot: raw.slot, state };
  });
}
/** One provider's finalized state of `owner`'s vault at or after `minContextSlot`, in its own read session. */
export async function readSolanaVaultStateWith(read: SolanaLiveRead, programId: string, vault: string, owner: string, minContextSlot: number): Promise<SolanaVaultState> {
  const raw = context(await read("getAccountInfo", [vault, { encoding: "base64", commitment: "finalized", minContextSlot }]), minContextSlot);
  const data = account(raw.value);
  if (data.owner !== programId || data.executable) return fail();
  const state = decodeSolanaVaultAccount(data.data);
  if (state.owner !== owner) return fail();
  return state;
}
export async function readSolanaVaultBalances(rpc: SolanaLiveRpc, vault: string, minContextSlot = 1): Promise<{ slot: number; cashUsdg: string; wsolRaw: string }> {
  return rpc.read(read => readSolanaVaultBalancesWith(read, vault, minContextSlot));
}
/** One provider's finalized answer for the vault's USDG and WSOL balances, at or after `minContextSlot`, in one read session. */
export async function readSolanaVaultBalancesWith(read: SolanaLiveRead, vault: string, minContextSlot = 1): Promise<{ slot: number; cashUsdg: string; wsolRaw: string }> {
  const [cash, wsol] = await Promise.all([deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM),
    deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM)]);
  const result = context(await read("getMultipleAccounts", [[cash, wsol], { encoding: "base64", commitment: "finalized", minContextSlot }]), minContextSlot);
  if (!Array.isArray(result.value) || result.value.length !== 2) return fail();
  return { slot: result.slot, cashUsdg: tokenBalance(account(result.value[0]), SOLANA_USDG_MINT, vault, TOKEN_2022_PROGRAM).toString(),
    wsolRaw: tokenBalance(account(result.value[1]), SOLANA_WRAPPED_SOL_MINT, vault, SOLANA_CLASSIC_TOKEN_PROGRAM).toString() };
}
/**
 * How far one provider's context slot may run ahead of another provider's fresh
 * finalized slot: about 30 seconds of honest skew between two providers' banks
 * at 200 ms slots (a minute at the 400 ms slots it was set for). A slot further
 * ahead is one provider's invention.
 */
export const SOLANA_PROVIDER_SLOT_SKEW = 150;
/**
 * The slot a reading of several providers may persist (a book's slot, an expiry
 * proof's slot): the LOWEST context slot any of them answered at, never one
 * provider's own. `views[i].fresh` is provider i's fresh slot at the same
 * commitment, read after its answer in the same session: a provider whose
 * context slot runs more than SOLANA_PROVIDER_SLOT_SKEW ahead of another's
 * fresh slot refuses the whole reading. A persisted slot is a floor every later
 * read and admission must reach (minContextSlot = book.slot; "moved
 * backwards"), so one provider's inflated slot would otherwise refuse every
 * later trade and in-app withdrawal.
 */
export function solanaQuorumSlot(views: readonly { slot: number; fresh?: number }[]): number {
  if (!views.length || views.some(view => !Number.isSafeInteger(view.slot) || view.slot < 1)) return fail();
  const fresh = views.flatMap(view => view.fresh === undefined ? [] : [integer(view.fresh)]);
  const highest = Math.max(...views.map(view => view.slot)), lowestFresh = fresh.length ? Math.min(...fresh) : Number.MAX_SAFE_INTEGER;
  if (highest > lowestFresh + SOLANA_PROVIDER_SLOT_SKEW) return fail();
  return Math.min(...views.map(view => view.slot));
}
/**
 * The vault's balances as EVERY provider sees them (at least two), at or after
 * `minContextSlot`: what booking an inflow may rest on. The providers must
 * report the same balances, or the reading is refused (invalid-state: nothing
 * is booked, ask again later). The slot is solanaQuorumSlot's: the lowest any
 * provider answered at, refused when one runs ahead of another's fresh slot.
 * One provider can therefore neither book a phantom deposit nor persist an
 * inflated book slot.
 */
export async function readSolanaVaultBalancesQuorum(rpc: SolanaLiveRpc, vault: string, minContextSlot = 1): Promise<{ slot: number; cashUsdg: string; wsolRaw: string }> {
  const views = (await readSolanaQuorum(rpc, async read => {
    const balances = await readSolanaVaultBalancesWith(read, vault, minContextSlot);
    return { ...balances, fresh: integer(await read("getSlot", [{ commitment: "finalized" }])) };
  }, view => JSON.stringify([view.cashUsdg, view.wsolRaw])));
  if (!views.agreed) return fail();
  return { slot: solanaQuorumSlot(views.values), cashUsdg: views.value.cashUsdg, wsolRaw: views.value.wsolRaw };
}
/**
 * A read at a minimum context slot another provider chose (the primary's
 * prepared slot, say): a provider a slot or two behind answers it as an RPC
 * error rather than with older state, so it is asked again this many times,
 * this far apart, inside its own read session, before its answer counts as
 * unavailable. Any other error is thrown at once.
 */
export const SOLANA_CATCH_UP_ATTEMPTS = 5, SOLANA_CATCH_UP_MS = 400;
export async function solanaCaughtUp<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); } catch (error) {
      if (attempt >= SOLANA_CATCH_UP_ATTEMPTS || !(error instanceof SolanaRpcError && error.code === "rpc")) throw error;
      await new Promise(resolve => setTimeout(resolve, SOLANA_CATCH_UP_MS));
    }
  }
}
/** execute_swap runs only while the cluster clock is in [deadline - this, deadline): `deadline <= now + 30` (lib.rs). */
export const SOLANA_SWAP_DEADLINE_WINDOW_SECONDS = 30n;
/**
 * The earliest cluster time (unix seconds) at which these signed bytes could
 * have run: execute_swap refuses them unless now >= deadline - 30, so a landed
 * swap's debit carries a timestamp at or after this.
 */
export function solanaDebitWindowStart(submission: SolanaSignedSubmission): bigint {
  return BigInt(Math.floor(signedDeadlineMs(submission) / 1000)) - SOLANA_SWAP_DEADLINE_WINDOW_SECONDS;
}
/** The signed execute_swap's deadline (unix ms). From then on the program refuses these bytes. */
function signedDeadlineMs(submission: SolanaSignedSubmission): number {
  let data: Buffer | undefined;
  try {
    const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(submission.signedTransactionBase64, "base64")).messageBytes);
    const swaps = message.instructions.filter(ix => message.staticAccounts[ix.programAddressIndex] === submission.programId);
    if (swaps.length === 1 && swaps[0]!.data) data = Buffer.from(swaps[0]!.data);
  } catch { return fail(); }
  // discriminator, expected_seq, session_epoch, amount_in, min_out, then deadline (i64).
  if (!data || data.length < 48) return fail();
  const deadline = data.readBigInt64LE(40);
  if (deadline <= 0n || deadline > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000))) return fail();
  return Number(deadline) * 1000;
}
/** A finalized read of this submission's vault at or after `minContextSlot`. */
async function readFinalizedVault(read: SolanaLiveRead, submission: SolanaSignedSubmission, owner: string, minContextSlot: number): Promise<SolanaVaultEvidence> {
  const evidence = context(await read("getAccountInfo", [submission.intent.vault, {
    encoding: "base64", commitment: "finalized", minContextSlot,
  }]), minContextSlot);
  const vault = account(evidence.value);
  if (vault.owner !== submission.programId || vault.executable) return fail();
  const state = decodeSolanaVaultAccount(vault.data);
  if (state.owner !== owner || state.sessionEpoch < BigInt(submission.sessionEpoch)) return fail();
  return { address: submission.intent.vault, slot: evidence.slot, state };
}
/**
 * One provider's view. `seen`: that provider has a status, a receipt or a moved sequence for it.
 * Exported for the operator's resolution tool (solana-resolve.ts), which compares the same views.
 */
export interface SolanaObservation {
  settlement: SolanaLiveSettlement | null; seen: boolean;
  /**
   * Pending views only: no status or receipt, but this provider's finalized vault
   * (at `blockHeight`) shows a sequence other than the signed one, which counts
   * as seen because the move may be these bytes. `reason` says why that is not a
   * proof they never ran (proveSequenceConsumed): "not-asked" (the worker never
   * asks), "behind" (the vault is before the signed sequence), "blockhash-live"
   * (the bank is not past lastValidBlockHeight yet), or "debit-in-window" (the
   * debit log holds a swap at or after `debitWindowStart`, the earliest moment
   * they could have run: they may have). Shown to the operator; never part of
   * what providers must agree on (observationKey).
   */
  sequenceMoved?: { vaultSequence: string; blockHeight: string; reason: "not-asked" | "behind" | "blockhash-live" | "debit-in-window"; debitWindowStart?: string };
}
export interface SolanaObservationOptions {
  /**
   * The operator's resolution tool only (solana-resolve.ts): when the vault's
   * sequence has moved past the signed one for some other reason (an owner
   * withdrawal made outside Merrymen takes no expected sequence), prove from the
   * vault's own debit log that these bytes never ran ("sequence-consumed"). The
   * worker's automatic reconciliation never asks this: it keeps such a trade
   * pending for an operator to review.
   */
  proveSequenceConsumed?: boolean;
}
/**
 * SEQUENCE CONSUMED (audit live-M1). A landed execute_swap does exactly two
 * things this proof reads: it advances the sequence by one, and it appends one
 * Debit stamped with the cluster clock at which it ran, which execute_swap only
 * allows inside [deadline - 30 s, deadline). The program rewrites the debit log
 * only in execute_swap, keeping the debits of the last 24 hours and refusing to
 * run with any debit newer than its own clock, so the newest swap's debit is
 * always in the log. If these bytes had run, the log at any later finalized
 * state therefore holds a debit at or after solanaDebitWindowStart: theirs, or a
 * later swap's. A finalized vault, read at or after a bank past
 * lastValidBlockHeight, whose sequence moved past the signed one (so these bytes
 * can never run from now on) and whose log holds no such debit, proves they
 * never ran. Like any expiry, its unknown fee stays reserved.
 */
function sequenceConsumed(submission: SolanaSignedSubmission, state: SolanaVaultState, blockHeight: number): boolean {
  if (state.seq <= BigInt(submission.vaultSequence) || BigInt(blockHeight) <= BigInt(submission.lastValidBlockHeight)) return false;
  const windowStart = solanaDebitWindowStart(submission);
  return !state.debits.some(debit => debit.timestamp >= windowStart);
}
export async function observeSolanaSubmission(read: SolanaLiveRead, submission: SolanaSignedSubmission, owner: string, nowMs: number,
  options: SolanaObservationOptions = {}): Promise<SolanaObservation> {
  const result = context(await read("getSignatureStatuses", [[submission.signature], { searchTransactionHistory: true }]), submission.minContextSlot);
  if (!Array.isArray(result.value) || result.value.length !== 1) return fail();
  const status = result.value[0];
  // "confirmed" is still a status a provider may report until Agave removes it (since Alpenglow it is the
  // same state as finalized): it counts as seen, like processed, and only "finalized" settles.
  if (status !== null && (!object(status) || !["processed", "confirmed", "finalized"].includes(String(status.confirmationStatus)) ||
    !Object.hasOwn(status, "err") || !isSolanaTransactionError(status.err))) return fail();
  const receipt = await read("getTransaction", [submission.signature, { commitment: "finalized", encoding: "base64", maxSupportedTransactionVersion: 0 }]);
  if (object(status) && status.confirmationStatus === "finalized") {
    if (receipt === null) return { settlement: null, seen: true };
    // A success is cross-checked against the vault's finalized sequence, which
    // is also what books it when the receipt's logs were truncated.
    const vault = object(receipt) && object(receipt.meta) && receipt.meta.err === null
      ? await readFinalizedVault(read, submission, owner, integer(receipt.slot)) : undefined;
    return { settlement: settleSolanaReceipt(submission, receipt, status, nowMs, vault), seen: true };
  }
  if (status !== null || receipt !== null) return { settlement: null, seen: true };
  // A missing receipt alone proves nothing. The finalized slot and block height
  // come from ONE bank (getEpochInfo), and the vault is read at or after that
  // slot. If that bank's height is past lastValidBlockHeight, any block that
  // could hold these bytes is at an earlier slot, so an unchanged sequence there
  // proves they never ran. Separate height and slot reads can be served by
  // different nodes behind one URL and pair a current height with a stale slot.
  const info = await read("getEpochInfo", [{ commitment: "finalized", minContextSlot: submission.minContextSlot }]);
  if (!object(info)) return fail();
  const proofSlot = integer(info.absoluteSlot), blockHeight = integer(info.blockHeight);
  if (proofSlot < submission.minContextSlot) return fail();
  const evidence = await readFinalizedVault(read, submission, owner, proofSlot);
  if (evidence.state.seq !== BigInt(submission.vaultSequence)) {
    // A moved sequence may be these bytes landing; only the debit log can say they did not.
    if (!options.proveSequenceConsumed || !sequenceConsumed(submission, evidence.state, blockHeight)) {
      const moved = { vaultSequence: evidence.state.seq.toString(), blockHeight: blockHeight.toString() };
      return { settlement: null, seen: true, sequenceMoved: !options.proveSequenceConsumed ? { ...moved, reason: "not-asked" }
        : evidence.state.seq < BigInt(submission.vaultSequence) ? { ...moved, reason: "behind" }
        : BigInt(blockHeight) <= BigInt(submission.lastValidBlockHeight) ? { ...moved, reason: "blockhash-live" }
        : { ...moved, reason: "debit-in-window", debitWindowStart: solanaDebitWindowStart(submission).toString() } };
    }
    if (!Number.isSafeInteger(nowMs) || nowMs < submission.preparedAtMs) return fail();
    return { seen: false, settlement: { status: "expired", signature: submission.signature, slot: evidence.slot, feeLamports: null,
      amountIn: "0", amountOut: "0", finalizedAtMs: nowMs, expiryProof: { vaultSequence: evidence.state.seq.toString(),
        sessionEpoch: evidence.state.sessionEpoch.toString(), blockHeight: blockHeight.toString(), reason: "sequence-consumed",
        debitWindowStart: solanaDebitWindowStart(submission).toString() } } };
  }
  const revoked = evidence.state.sessionEpoch > BigInt(submission.sessionEpoch);
  if (!revoked && BigInt(blockHeight) <= BigInt(submission.lastValidBlockHeight)) return { settlement: null, seen: false };
  if (!Number.isSafeInteger(nowMs) || nowMs < submission.preparedAtMs) return fail();
  return { seen: false, settlement: { status: "expired", signature: submission.signature, slot: evidence.slot, feeLamports: null,
    amountIn: "0", amountOut: "0", finalizedAtMs: nowMs, expiryProof: { vaultSequence: evidence.state.seq.toString(),
      sessionEpoch: evidence.state.sessionEpoch.toString(), blockHeight: blockHeight.toString(), reason: revoked ? "session-revoked" : "blockhash-expired" } } };
}
/**
 * The settlement to book from providers that agree on it (observationKey). A
 * fill or failure is identical everywhere, slot included. An expiry's slot is
 * each provider's own finalized read, which the key leaves out and the book
 * keeps as its slot (a floor for every later trade and read): the lowest of
 * them is booked, never one provider's, so a provider answering far ahead
 * cannot wedge the account. Its proof is the first (the primary's) otherwise.
 */
export function solanaAgreedSettlement(settlements: readonly SolanaLiveSettlement[]): SolanaLiveSettlement {
  const [first] = settlements;
  if (!first) return fail();
  if (first.status !== "expired") return first;
  return { ...first, slot: Math.min(...settlements.map(settlement => settlement.slot)) };
}
/** What both providers must agree on. An expiry's height is each provider's own and may differ. */
export function observationKey(observation: SolanaObservation): string {
  const settlement = observation.settlement;
  if (!settlement) return "pending";
  if (settlement.status === "expired") return JSON.stringify([settlement.status, settlement.signature,
    settlement.expiryProof.vaultSequence, settlement.expiryProof.sessionEpoch, settlement.expiryProof.reason]);
  return JSON.stringify(settlement);
}
/**
 * Resolves signed submissions without loading signing keys or requiring live mode.
 *
 * A fill, failure or expiry is booked only when both independent providers
 * derive the same outcome (readSolanaQuorum); any disagreement or provider error
 * leaves the record pending. While neither provider has seen the signature and
 * the signed deadline has not passed, the saved bytes are rebroadcast once per
 * call: never re-signed, so a dropped send survives a restart and still lands
 * at most once.
 */
export async function reconcileSolanaSubmission(
  rpc: SolanaLiveRpc, journal: SolanaLiveJournal, owner: string, requestId: string, now: () => number = Date.now,
): Promise<SolanaLiveRecord | null> {
  const record = await journal.get(owner, requestId);
  if (!record || record.status !== "pending") return record;
  const submission = record.submission;
  if (await deriveSolanaVaultAddress(submission.programId, owner) !== submission.intent.vault) return fail();
  const nowMs = now();
  const quorum = await readSolanaQuorum(rpc, read => observeSolanaSubmission(read, submission, owner, nowMs), observationKey);
  if (quorum.agreed && quorum.value.settlement) {
    const settlement = solanaAgreedSettlement(quorum.values.map(view => view.settlement!));
    await journal.settle(owner, requestId, submission.signature, settlement);
    return { submission, status: settlement.status, settlement };
  }
  if (quorum.values.every(item => !item.seen && !item.settlement) && Number.isSafeInteger(nowMs) && nowMs < signedDeadlineMs(submission)) {
    try { await rpc.send(submission.signedTransactionBase64, submission.minContextSlot, undefined, { untilMs: 0 }); } catch { /* Still pending. */ }
  }
  return record;
}
/** ComputeBudget SetComputeUnitLimit (2, u32) then SetComputeUnitPrice (3, u64 micro-lamports per unit). */
export function solanaComputeBudgetInstructions(units: number, price: bigint): Instruction[] {
  const limit = Buffer.alloc(5); limit[0] = 2; limit.writeUInt32LE(units, 1);
  const fee = Buffer.alloc(9); fee[0] = 3; fee.writeBigUInt64LE(price, 1);
  return [{ programAddress: address(COMPUTE_PROGRAM), accounts: [], data: limit },
    { programAddress: address(COMPUTE_PROGRAM), accounts: [], data: fee }];
}

export function createSolanaExecutor(options: SolanaExecutorOptions) {
  const now = options.now ?? Date.now;
  const cap = parseSolanaRawAmount(options.maxFeeLamports);
  const minPrice = parseSolanaRawAmount(options.computeUnitPriceMicroLamports ?? "0", true);
  const maxPrice = options.maxComputeUnitPriceMicroLamports === undefined
    ? (minPrice > SOLANA_DEFAULT_MAX_COMPUTE_UNIT_PRICE ? minPrice : SOLANA_DEFAULT_MAX_COMPUTE_UNIT_PRICE)
    : parseSolanaRawAmount(options.maxComputeUnitPriceMicroLamports, true);
  if (maxPrice < minPrice) fail("fee-cap");
  const snapshotFloor = options.minSnapshotSlot ?? 1;
  if (!Number.isSafeInteger(snapshotFloor) || snapshotFloor < 1) fail();
  address(options.programId);
  if (!/^[a-f0-9]{64}$/.test(options.programBinarySha256)) fail("unsafe-program");
  const identity = Promise.all([getAddressFromPublicKey(options.sessionKeyPair.publicKey), getAddressFromPublicKey(options.feePayerKeyPair.publicKey)]);
  const timestamp = () => { const value = now(); integer(value); return value; };
  const checkAbort = () => { if (options.signal?.aborted) fail("cancelled"); };
  return {
    /**
     * `minOutAmount`: the owner's floor, the guaranteed output of the quote they
     * previewed. It is not part of the request's identity: a recorded request is
     * returned whatever floor a retry carries; a new one whose fresh route
     * guarantees less is refused (price-moved) before anything is signed or recorded.
     */
    async execute(rawIntent: unknown, admission: { minOutAmount?: string | null } = {}): Promise<SolanaLiveRecord> {
      checkAbort();
      const intent = parseSolanaLiveIntent(rawIntent);
      let floor: string | null = null;
      if (admission.minOutAmount !== undefined && admission.minOutAmount !== null) {
        try { floor = parseSolanaTradeFloor(admission.minOutAmount); } catch { return fail("invalid-intent"); }
      }
      const prior = await options.journal.get(intent.owner, intent.requestId);
      if (prior) {
        if (JSON.stringify(prior.submission.intent) !== JSON.stringify(intent)) return fail("conflict");
        return prior; // Includes failed requests: never re-sign an old request.
      }
      checkAbort();
      const [session, feePayer] = await identity;
      checkAbort();
      if (session === feePayer || [session, feePayer].some(key => key === intent.owner || key === intent.vault) ||
          await deriveSolanaVaultAddress(options.programId, intent.owner) !== intent.vault) return fail();
      const inputProgram = intent.inputMint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM;
      const outputProgram = intent.outputMint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM;
      const [inputTokenAccount, outputTokenAccount, ownerRefund, inputMint, outputMint] = await Promise.all([
        deriveSolanaAta(intent.vault, intent.inputMint, inputProgram), deriveSolanaAta(intent.vault, intent.outputMint, outputProgram),
        deriveSolanaAta(intent.owner, intent.inputMint, inputProgram),
        options.market.readMint(intent.inputMint), options.market.readMint(intent.outputMint),
      ]);
      checkAbort();
      const observedAtMs = timestamp();
      for (const [mint, expected, program] of [[inputMint, intent.inputMint, inputProgram], [outputMint, intent.outputMint, outputProgram]] as const) {
        if (mint.address !== expected || mint.program !== program || mint.observedAtMs > observedAtMs || observedAtMs - mint.observedAtMs >= 30_000 ||
            mint.decimals !== (expected === SOLANA_USDG_MINT ? 6 : 9)) return fail();
      }
      if (intent.inputMint === SOLANA_USDG_MINT && (inputMint.buyBlockedReasons.length || outputMint.buyBlockedReasons.length)) return fail("unsafe-route");
      const safetyObservedAtMs = Math.min(inputMint.observedAtMs, outputMint.observedAtMs);
      // Every provider must agree the program is the immutable audited build, built for this id.
      await verifySolanaVaultDeployment(options.rpc, options.programId, options.programBinarySha256, { requireDeclaredProgramId: true });
      checkAbort();
      const snapshot = await options.rpc.read(async rpc => {
        const fresh = integer(await rpc("getSlot", [{ commitment: "finalized" }]));
        if (fresh < 1) return fail();
        const slot = fresh > snapshotFloor ? fresh : snapshotFloor;
        const result = context(await rpc("getMultipleAccounts", [[intent.vault, inputTokenAccount, outputTokenAccount, feePayer],
          { encoding: "base64", commitment: "finalized", minContextSlot: slot }]), slot);
        if (!Array.isArray(result.value) || result.value.length !== 4) return fail();
        const [vault, input, output, payer] = result.value.map(account) as [Account, Account, Account, Account];
        if (vault.owner !== options.programId || vault.executable || payer.owner !== "11111111111111111111111111111111" || payer.executable || payer.data.length) return fail();
        const state = decodeSolanaVaultAccount(vault.data);
        if (state.owner !== intent.owner || state.session !== session || (state.paused && intent.inputMint === SOLANA_USDG_MINT) || state.expiresAt * 1000n <= BigInt(observedAtMs) ||
            state.seq === U64_MAX || state.maxOps < 1 || state.perTrade <= 0n || state.daily < state.perTrade) return fail();
        const inputBalance = tokenBalance(input, intent.inputMint, intent.vault, inputProgram);
        const outputBalance = tokenBalance(output, intent.outputMint, intent.vault, outputProgram);
        if (inputBalance < BigInt(intent.amountRaw)) return fail();
        // The vault needs the owner's input ATA only to return tokens already in this
        // sequence's temporary ATA. An owner who closed it (unwrapping WSOL, reclaiming
        // rent) must not block exits, so it is passed only when a donation waits, and
        // then it must exist and be safe or the swap is refused before anything is signed.
        const swapAuthority = await deriveSolanaSwapAuthority(options.programId, intent.vault, state.seq);
        const tempInput = await deriveSolanaAta(swapAuthority, intent.inputMint, inputProgram);
        const waiting = context(await rpc("getMultipleAccounts", [[tempInput, ownerRefund],
          { encoding: "base64", commitment: "finalized", minContextSlot: slot }]), slot);
        if (!Array.isArray(waiting.value) || waiting.value.length !== 2) return fail();
        // The temporary account has the vault input account's size, so this is its rent and, for WSOL, its native reserve.
        const rent = BigInt(integer(await rpc("getMinimumBalanceForRentExemption", [input.data.length, { commitment: "finalized" }])));
        const refund = solanaPendingRefund(waiting.value[0], waiting.value[1], intent.inputMint, swapAuthority, intent.owner, inputProgram, rent);
        if (refund.donation > 0n && !refund.ownerAccountUsable) return fail("owner-refund");
        const refundAccount: string | null = refund.donation > 0n ? ownerRefund : null;
        return { slot: result.slot, state, inputBalance, outputBalance, payerBalance: payer.lamports, rent, swapAuthority, tempInput, refundAccount };
      });
      checkAbort();
      // Mirror the vault's owner-signed WSOL input caps before asking for a route.
      if (intent.inputMint === SOLANA_WRAPPED_SOL_MINT) {
        const amount = BigInt(intent.amountRaw), cutoff = BigInt(Math.floor(observedAtMs / 1000)) - 86_400n;
        const used = snapshot.state.debits.filter(d => d.timestamp > cutoff).reduce((sum, d) => sum + d.wsol, 0n);
        if (amount > snapshot.state.perTradeWsol || used + amount > snapshot.state.dailyWsol) return fail("risk");
      }
      const { swapAuthority, tempInput } = snapshot;
      const buildRequest: SolanaCpiBuildRequest = { ...intent, swapAuthority, sourceTokenAccount: tempInput,
        destinationTokenAccount: outputTokenAccount, inputTokenProgram: inputProgram, outputTokenProgram: outputProgram };
      const route = await options.market.build(buildRequest);
      checkAbort();
      checkRouteQuote(route.quote, paperIntent(intent), timestamp());
      // The route's guaranteed output is what gets signed (min_out): below the
      // minimum the owner previewed, the price moved and nothing goes further.
      // The refusal carries that guaranteed output (already validated with the quote) for the owner to review.
      if (!solanaTradeFloorMet(route.quote.minOutAmount, floor)) throw new SolanaExecutionError("price-moved", { freshMinOutAmount: route.quote.minOutAmount });
      validateJupiterCpi({ swapInstruction: { programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", data: route.dataBase64,
        accounts: route.accounts.map(meta => ({ pubkey: meta.address, isSigner: meta.isSigner, isWritable: meta.isWritable })) },
        addressLookupTableAddresses: route.lookupTableAddresses }, buildRequest, route.quote);
      // Provider objects cannot add authority. Inspect all remaining account owners
      // before CPI and reject any path to the vault's other token accounts.
      const prepared = await options.rpc.read(async rpc => {
        const slot = Math.max(snapshot.slot, route.quote.contextSlot);
        if (route.accounts.some(meta => [intent.owner, intent.vault, session, feePayer, inputTokenAccount, ownerRefund].includes(meta.address))) return fail("unsafe-route");
        const keys = [...new Set(route.accounts.map(meta => meta.address))];
        const remaining = context(await rpc("getMultipleAccounts", [keys,
          { encoding: "base64", commitment: "finalized", minContextSlot: slot, dataSlice: { offset: 0, length: 165 } }]), slot);
        if (!Array.isArray(remaining.value) || remaining.value.length !== keys.length) return fail();
        remaining.value.forEach((raw, index) => {
          if (raw === null) return;
          const item = account(raw);
          if ([SOLANA_CLASSIC_TOKEN_PROGRAM, TOKEN_2022_PROGRAM].includes(item.owner) && item.data.length >= 64 &&
              getBase58Decoder().decode(item.data.subarray(32, 64)) === intent.vault && keys[index] !== outputTokenAccount) fail("unsafe-route");
        });
        const alts: AddressesByLookupTableAddress = {};
        for (const key of route.lookupTableAddresses) {
          const alt = await readRawAccount(rpc, key, slot);
          if (alt.owner !== LOOKUP_PROGRAM || alt.executable || alt.data.length < 56 || (alt.data.length - 56) % 32 ||
              alt.data.length > 8248 || alt.data.readUInt32LE(0) !== 1 || alt.data.readBigUInt64LE(4) !== U64_MAX ||
              alt.data.readBigUInt64LE(12) >= BigInt(slot)) return fail("unsafe-route");
          alts[address(key)] = Array.from({ length: (alt.data.length - 56) / 32 }, (_, index) =>
            address(getBase58Decoder().decode(alt.data.subarray(56 + index * 32, 88 + index * 32))));
        }
        const blockhash = context(await rpc("getLatestBlockhash", [{ commitment: "finalized", minContextSlot: slot }]), slot);
        if (!object(blockhash.value) || typeof blockhash.value.blockhash !== "string") return fail();
        // Every provider simulates the signed message at or after the bank its blockhash came from (below).
        const simulationSlot = Math.max(slot, blockhash.slot);
        let recentBlockhash: Blockhash;
        try { recentBlockhash = address(blockhash.value.blockhash) as unknown as Blockhash; } catch { return fail(); }
        const lastValidBlockHeight = BigInt(integer(blockhash.value.lastValidBlockHeight));
        const deadline = BigInt(Math.floor(Math.min(route.quote.expiresAtMs, Number(snapshot.state.expiresAt * 1000n)) / 1000));
        const swap = buildExecuteSolanaSwapInstruction({ programAddress: options.programId, vault: intent.vault,
          sessionSigner: session, feePayer, inputMint: intent.inputMint, outputMint: intent.outputMint,
          vaultInput: inputTokenAccount, vaultOutput: outputTokenAccount, swapAuthority, tempInput, ownerRefund: snapshot.refundAccount,
          inputTokenProgram: inputProgram, outputTokenProgram: outputProgram, expectedSeq: snapshot.state.seq,
          sessionEpoch: snapshot.state.sessionEpoch, amountIn: BigInt(intent.amountRaw), minOut: BigInt(route.quote.minOutAmount),
          deadline, slippageBps: intent.slippageBps, routeData: Buffer.from(route.dataBase64, "base64"),
          routeAccounts: route.accounts.map(meta => ({ address: meta.address, role: meta.isWritable ? 1 : 0 })) });
        const compile = (units: number, unitPrice: bigint) => {
          const msg = setTransactionMessageLifetimeUsingBlockhash({ blockhash: recentBlockhash, lastValidBlockHeight },
            setTransactionMessageFeePayer(feePayer, appendTransactionMessageInstructions([...solanaComputeBudgetInstructions(units, unitPrice), swap], createTransactionMessage({ version: 0 }))));
          const transaction = compileTransaction(compressTransactionMessageUsingAddressLookupTables(msg, alts));
          if (Buffer.from(getBase64EncodedWireTransaction(transaction), "base64").length > 1232) return fail("unsafe-route");
          return transaction;
        };
        // `read`: the provider asked (this session's by default), at or after `at`.
        const simulate = async (transaction: ReturnType<typeof compile>, read: SolanaLiveRead = rpc, at = slot) => {
          const sim = context(await read("simulateTransaction", [getBase64EncodedWireTransaction(transaction), {
            encoding: "base64", commitment: "finalized", minContextSlot: at, sigVerify: false, replaceRecentBlockhash: false,
            accounts: { encoding: "base64", addresses: [intent.vault, inputTokenAccount, outputTokenAccount, feePayer] },
          }]), at);
          if (!object(sim.value) || sim.value.err !== null || !Array.isArray(sim.value.accounts) || sim.value.accounts.length !== 4) return fail("simulation");
          const [vault, input, output, payer] = sim.value.accounts.map(account) as [Account, Account, Account, Account];
          const state = decodeSolanaVaultAccount(vault.data);
          const inputAfter = tokenBalance(input, intent.inputMint, intent.vault, inputProgram);
          const outputAfter = tokenBalance(output, intent.outputMint, intent.vault, outputProgram);
          if (vault.owner !== options.programId || state.owner !== intent.owner || state.session !== session ||
              state.seq !== snapshot.state.seq + 1n || state.sessionEpoch !== snapshot.state.sessionEpoch ||
              snapshot.inputBalance - inputAfter <= 0n || snapshot.inputBalance - inputAfter > BigInt(intent.amountRaw) ||
              outputAfter - snapshot.outputBalance < BigInt(route.quote.minOutAmount) ||
              snapshot.payerBalance - payer.lamports > cap) return fail("simulation");
          const units = integer(sim.value.unitsConsumed);
          if (units < 1 || units > 1_400_000) return fail("simulation");
          return units;
        };
        const units = Math.min(1_400_000, Math.ceil(await simulate(compile(1_400_000, 0n)) * 1.2));
        // A bounded priority fee: recent prices on the accounts this swap writes,
        // between the configured minimum and maximum, and never more than the
        // fee budget left after the temporary account's rent. The budget is also
        // what the shared fee payer holds: a payer that can fund the swap only at
        // a lower price pays that price, never a refusal while status shows exits
        // as available (it gates on rent and signatures alone).
        const funds = snapshot.payerBalance < cap ? snapshot.payerBalance : cap;
        const budget = funds - snapshot.rent - SIGNATURE_FEES;
        const affordable = budget > 0n ? budget * 1_000_000n / BigInt(units) : 0n;
        if (affordable < minPrice) return fail("fee-cap");
        const writable = [intent.vault, inputTokenAccount, outputTokenAccount, snapshot.tempInput, feePayer,
          ...(snapshot.refundAccount ? [snapshot.refundAccount] : []), ...route.accounts.filter(meta => meta.isWritable).map(meta => meta.address)];
        // The estimate is advisory: a provider that cannot answer it must not
        // block an exit, so the swap then pays the configured minimum.
        let recent = minPrice;
        try { recent = await readSolanaPriorityFee(rpc, writable, { minimum: minPrice, maximum: maxPrice }); } catch { /* Minimum price. */ }
        const unitPrice = recent > affordable ? affordable : recent;
        const transaction = compile(units, unitPrice);
        const feeResult = context(await rpc("getFeeForMessage", [Buffer.from(transaction.messageBytes).toString("base64"),
          { commitment: "finalized", minContextSlot: slot }]), slot);
        const quoted = BigInt(integer(feeResult.value));
        // The runtime charges both signatures plus ceil(price * limit / 1e6). Never
        // reserve less, even from a provider that leaves the priority fee out:
        // a receipt above the reservation could never be settled.
        const charged = SIGNATURE_FEES + (unitPrice * BigInt(units) + 999_999n) / 1_000_000n;
        const fee = quoted > charged ? quoted : charged;
        if (quoted < 10_000n || fee + snapshot.rent > cap || snapshot.payerBalance < fee + snapshot.rent) return fail("fee-cap");
        const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
        if (compiled.version !== 0) return fail();
        const loadedAddresses: SolanaSignedSubmission["loadedAddresses"] = { writable: [], readonly: [] };
        for (const field of ["writable", "readonly"] as const) {
          loadedAddresses[field] = (compiled.addressTableLookups ?? []).flatMap(lookup => lookup[`${field}Indexes`].map(index => {
            const value = alts[lookup.lookupTableAddress]?.[index]; if (!value) return fail("unsafe-route"); return value;
          }));
        }
        return { transaction, fee, recentBlockhash, lastValidBlockHeight, slot, loadedAddresses, deadline,
          recheck: (read: SolanaLiveRead) => simulate(transaction, read, simulationSlot) };
      });
      checkAbort();
      // The exact message that will be signed, simulated again on EVERY provider, each in its own session: the
      // sequence it consumes, what leaves the vault's input and reaches its output, and what the fee payer pays
      // must pass the same checks on each, so one provider cannot vouch for a route alone. A provider a slot or
      // two behind the blockhash's bank is asked again briefly (solanaCaughtUp); any refusal refuses the trade.
      await readSolanaEachProvider(options.rpc, read => solanaCaughtUp(() => prepared.recheck(read)));
      checkAbort();
      const risk = await options.assessRisk({ intent, quote: route.quote, vaultState: snapshot.state,
        slot: prepared.slot, observedAtMs });
      checkAbort();
      const preparedAtMs = timestamp();
      checkRouteQuote(route.quote, paperIntent(intent), preparedAtMs);
      if (preparedAtMs - safetyObservedAtMs >= 30_000) return fail("unsafe-route");
      // The guaranteed output must clear the independent price floor; a bad,
      // buggy or manipulated build quote cannot sign a sale for dust.
      let reference: SolanaReferenceBound;
      try { reference = verifySolanaReferenceBound(risk.reference, intent, preparedAtMs, options.pythGeneration, options.referenceToleranceBps ?? SOLANA_REFERENCE_DEFAULT_TOLERANCE_BPS); } catch { return fail("risk"); }
      if (reference.reference.slot < prepared.slot || BigInt(route.quote.minOutAmount) < BigInt(reference.minOutFloor)) return fail("risk");
      if (integer(risk.observedAtMs) > preparedAtMs || preparedAtMs - risk.observedAtMs >= 30_000 ||
          integer(risk.slot) < prepared.slot || risk.cashUsdg !== (intent.inputMint === SOLANA_USDG_MINT ? snapshot.inputBalance : snapshot.outputBalance).toString() ||
          risk.wsolRaw !== (intent.inputMint === SOLANA_WRAPPED_SOL_MINT ? snapshot.inputBalance : snapshot.outputBalance).toString() ||
          parseSolanaRawAmount(risk.notionalUsdg) !== solanaReferenceNotional(intent, route.quote.outAmount, reference) ||
          parseSolanaRawAmount(risk.peakEquityUsdg, true) < parseSolanaRawAmount(risk.equityUsdg, true)) return fail("risk");
      if (BigInt(risk.notionalUsdg) > snapshot.state.perTrade || BigInt(risk.notionalUsdg) > snapshot.state.daily) return fail("risk");
      checkAbort();
      const signed = await signTransaction([options.feePayerKeyPair, options.sessionKeyPair], prepared.transaction);
      checkAbort();
      const signature = getSignatureFromTransaction(signed);
      const submission: SolanaSignedSubmission = { version: 1, intent, programId: options.programId, session, feePayer,
        sessionEpoch: snapshot.state.sessionEpoch.toString(), vaultSequence: snapshot.state.seq.toString(), signature,
        signedTransactionBase64: getBase64EncodedWireTransaction(signed), messageBase64: Buffer.from(signed.messageBytes).toString("base64"),
        loadedAddresses: prepared.loadedAddresses,
        recentBlockhash: prepared.recentBlockhash, lastValidBlockHeight: prepared.lastValidBlockHeight.toString(),
        minContextSlot: prepared.slot, minOutAmount: route.quote.minOutAmount, quotedOutAmount: route.quote.outAmount,
        inputTokenAccount, outputTokenAccount, inputTokenProgram: inputProgram, outputTokenProgram: outputProgram,
        inputBalanceBefore: snapshot.inputBalance.toString(), outputBalanceBefore: snapshot.outputBalance.toString(),
        maxFeeLamports: cap.toString(), feeLamports: prepared.fee.toString(), rentLamports: snapshot.rent.toString(),
        preparedAtMs, safetyObservedAtMs, quote: route.quote, risk };
      checkAbort();
      if (!await options.journal.recordSigned(submission)) {
        const existing = await options.journal.get(intent.owner, intent.requestId);
        if (existing && JSON.stringify(existing.submission.intent) === JSON.stringify(intent)) return existing;
        return fail("conflict");
      }
      // Every send result, including a mismatched signature or lost response, is
      // pending until finalized network evidence proves its outcome. The transport
      // rebroadcasts these exact bytes to both providers until they are seen or
      // the signed deadline passes; nothing is ever re-signed.
      if (!options.signal?.aborted) {
        try { await options.rpc.send(submission.signedTransactionBase64, submission.minContextSlot, options.signal, { untilMs: Number(prepared.deadline) * 1000 }); } catch { /* Durable pending. */ }
      }
      return { submission, status: "pending" };
    },
    async reconcile(owner: string, requestId: string): Promise<SolanaLiveRecord | null> {
      return reconcileSolanaSubmission(options.rpc, options.journal, owner, requestId, now);
    },
  };
}
