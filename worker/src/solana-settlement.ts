import { address, getTransactionDecoder, getCompiledTransactionMessageDecoder } from "@solana/kit";
import { decodeSolanaSwapEvent, SOLANA_WRAPPED_SOL_MINT, type SolanaSwapExecutedEvent, type SolanaVaultState } from "../../packages/core/src/solana-live";
import { parseSolanaRawAmount } from "../../packages/core/src/solana";
import type { SolanaLiveSettlement, SolanaSignedSubmission } from "./solana-executor";

export class SolanaSettlementError extends Error {
  constructor() { super("Finalized Solana evidence disagrees with the recorded submission."); this.name = "SolanaSettlementError"; }
}
function fail(): never { throw new SolanaSettlementError(); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return fail();
  return value;
}

// Serde representation of Solana SDK TransactionError/InstructionError. Unknown
// future variants stay pending until supported, rather than freeing a sequence.
// https://github.com/anza-xyz/solana-sdk/tree/master/transaction-error
const TRANSACTION_ERRORS = new Set([
  "AccountInUse", "AccountLoadedTwice", "AccountNotFound", "ProgramAccountNotFound", "InsufficientFundsForFee",
  "InvalidAccountForFee", "AlreadyProcessed", "BlockhashNotFound", "CallChainTooDeep", "MissingSignatureForFee",
  "InvalidAccountIndex", "SignatureFailure", "InvalidProgramForExecution", "SanitizeFailure", "ClusterMaintenance",
  "AccountBorrowOutstanding", "WouldExceedMaxBlockCostLimit", "UnsupportedVersion", "InvalidWritableAccount",
  "WouldExceedMaxAccountCostLimit", "WouldExceedAccountDataBlockLimit", "TooManyAccountLocks", "AddressLookupTableNotFound",
  "InvalidAddressLookupTableOwner", "InvalidAddressLookupTableData", "InvalidAddressLookupTableIndex", "InvalidRentPayingAccount",
  "WouldExceedMaxVoteCostLimit", "WouldExceedAccountDataTotalLimit", "MaxLoadedAccountsDataSizeExceeded",
  "InvalidLoadedAccountsDataSizeLimit", "ResanitizationNeeded", "UnbalancedTransaction", "ProgramCacheHitMaxLimit",
  "CommitCancelled", "BailOut",
]);
const INSTRUCTION_ERRORS = new Set([
  "GenericError", "InvalidArgument", "InvalidInstructionData", "InvalidAccountData", "AccountDataTooSmall", "InsufficientFunds",
  "IncorrectProgramId", "MissingRequiredSignature", "AccountAlreadyInitialized", "UninitializedAccount", "UnbalancedInstruction",
  "ModifiedProgramId", "ExternalAccountLamportSpend", "ExternalAccountDataModified", "ReadonlyLamportChange", "ReadonlyDataModified",
  "DuplicateAccountIndex", "ExecutableModified", "RentEpochModified", "NotEnoughAccountKeys", "AccountDataSizeChanged",
  "AccountNotExecutable", "AccountBorrowFailed", "AccountBorrowOutstanding", "DuplicateAccountOutOfSync", "InvalidError",
  "ExecutableDataModified", "ExecutableLamportChange", "ExecutableAccountNotRentExempt", "UnsupportedProgramId", "CallDepth",
  "MissingAccount", "ReentrancyNotAllowed", "MaxSeedLengthExceeded", "InvalidSeeds", "InvalidRealloc", "ComputationalBudgetExceeded",
  "PrivilegeEscalation", "ProgramEnvironmentSetupFailure", "ProgramFailedToComplete", "ProgramFailedToCompile", "Immutable",
  "IncorrectAuthority", "BorshIoError", "AccountNotRentExempt", "InvalidAccountOwner", "ArithmeticOverflow", "UnsupportedSysvar",
  "IllegalOwner", "MaxAccountsDataAllocationsExceeded", "MaxAccountsExceeded", "MaxInstructionTraceLengthExceeded",
  "BuiltinProgramsMustConsumeComputeUnits", "BailOut",
]);
const boundedInteger = (value: unknown, maximum: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
function instructionError(value: unknown): boolean {
  if (typeof value === "string") return INSTRUCTION_ERRORS.has(value);
  if (!object(value) || Object.keys(value).length !== 1) return false;
  return Object.hasOwn(value, "Custom") && boundedInteger(value.Custom, 0xffffffff) ||
    // Older Agave versions included a bounded string in this variant.
    Object.hasOwn(value, "BorshIoError") && typeof value.BorshIoError === "string" && value.BorshIoError.length <= 2048;
}
export function isSolanaTransactionError(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value === "string") return TRANSACTION_ERRORS.has(value);
  if (!object(value) || Object.keys(value).length !== 1) return false;
  if (Object.hasOwn(value, "InstructionError")) return Array.isArray(value.InstructionError) && value.InstructionError.length === 2 &&
    boundedInteger(value.InstructionError[0], 255) && instructionError(value.InstructionError[1]);
  if (Object.hasOwn(value, "DuplicateInstruction")) return boundedInteger(value.DuplicateInstruction, 255);
  for (const key of ["InsufficientFundsForRent", "ProgramExecutionTemporarilyRestricted"] as const) {
    const detail = value[key];
    if (object(detail) && Object.keys(detail).length === 1 && Object.hasOwn(detail, "account_index")) return boundedInteger(detail.account_index, 255);
  }
  return false;
}

/**
 * Agave stops recording a transaction's logs at 10,000 bytes and appends this
 * line. The vault's event is emitted last, after Jupiter's and the token
 * program's logs, so it is the first thing a long route loses.
 */
const LOG_TRUNCATED = "Log truncated";
function parseVaultLogs(raw: unknown, programId: string, allowIncomplete: boolean): { events: SolanaSwapExecutedEvent[]; complete: boolean } {
  // getTransaction returns null logs when the node did not record them.
  if (raw === null || raw === undefined) return allowIncomplete ? { events: [], complete: false } : fail();
  if (!Array.isArray(raw) || raw.length > 2048) return fail();
  const truncated = raw.at(-1) === LOG_TRUNCATED;
  if (truncated && !allowIncomplete) return fail();
  const lines = truncated ? raw.slice(0, -1) : raw;
  const stack: string[] = [], events: SolanaSwapExecutedEvent[] = [];
  for (const line of lines) {
    if (typeof line !== "string" || line.length > 8192 || line === LOG_TRUNCATED) return fail();
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      if (Number(invoke[2]) !== stack.length + 1) return fail();
      stack.push(invoke[1]!); continue;
    }
    const exit = /^Program ([1-9A-HJ-NP-Za-km-z]+) (?:success|failed:.*)$/.exec(line);
    if (exit) { if (stack.pop() !== exit[1]) return fail(); continue; }
    if (line.startsWith("Program data: ") && stack.at(-1) === programId) {
      const encoded = line.slice(14);
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.toString("base64") !== encoded) return fail();
      // This version emits exactly one event kind for execute_swap.
      events.push(decodeSolanaSwapEvent(bytes));
    }
  }
  // A truncated log stops mid-frame; a complete one must close every frame.
  if (!truncated && stack.length) return fail();
  return { events, complete: !truncated };
}
/** Only events emitted while the verified vault program is the active frame count. Complete logs only. */
export function solanaVaultEvents(raw: unknown, programId: string): SolanaSwapExecutedEvent[] {
  return parseVaultLogs(raw, programId, false).events;
}
/** A finalized read of the vault account at or after the receipt's slot. */
export interface SolanaVaultEvidence { address: string; slot: number; state: SolanaVaultState }

/**
 * getTransaction must have been requested at finalized; status is independently finalized.
 *
 * A success is booked from the exact signed bytes (one execute_swap pinned to
 * this sequence, epoch and amounts; transactions are atomic), meta.err === null
 * and the vault token accounts' balance rows, which the runtime never truncates.
 * The vault's own event must also agree whenever the logs are complete. When
 * the logs were truncated at the runtime's cap or not recorded, `vault` is
 * required instead: a finalized read at or after the receipt slot whose
 * sequence has moved past the one these bytes consumed. A failure never needs
 * logs. Missing evidence throws, which keeps the record pending.
 */
export function settleSolanaReceipt(submission: SolanaSignedSubmission, raw: unknown, status: unknown, nowMs: number, vault?: SolanaVaultEvidence): SolanaLiveSettlement {
  if (!object(raw) || !object(raw.meta) || !object(status) || status.confirmationStatus !== "finalized" ||
      !Number.isSafeInteger(nowMs) || nowMs < submission.preparedAtMs ||
      !Array.isArray(raw.transaction) || raw.transaction.length !== 2 || raw.transaction[1] !== "base64" || raw.transaction[0] !== submission.signedTransactionBase64 ||
      raw.version !== 0 || integer(status.slot) !== integer(raw.slot) || !Object.hasOwn(raw.meta, "err") || !Object.hasOwn(status, "err") ||
      !isSolanaTransactionError(raw.meta.err) || !isSolanaTransactionError(status.err) ||
      JSON.stringify(status.err) !== JSON.stringify(raw.meta.err)) return fail();
  const slot = integer(raw.slot), meta = raw.meta;
  if (slot < submission.minContextSlot) return fail();
  const fee = BigInt(integer(meta.fee));
  if (fee > BigInt(submission.feeLamports) || fee > BigInt(submission.maxFeeLamports)) return fail();
  const transaction = getTransactionDecoder().decode(Buffer.from(submission.signedTransactionBase64, "base64"));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== 0 || message.staticAccounts[0] !== submission.feePayer) return fail();
  if (!object(meta.loadedAddresses) || !Array.isArray(meta.loadedAddresses.writable) || !Array.isArray(meta.loadedAddresses.readonly)) return fail();
  for (const field of ["writable", "readonly"] as const) {
    const expectedCount = (message.addressTableLookups ?? []).reduce((n, lookup) => n + lookup[`${field}Indexes`].length, 0);
    const loaded = meta.loadedAddresses[field];
    if (!Array.isArray(loaded) || loaded.length !== expectedCount ||
        JSON.stringify(loaded) !== JSON.stringify(submission.loadedAddresses[field])) return fail();
  }
  const keys: string[] = [...message.staticAccounts];
  for (const key of [...meta.loadedAddresses.writable, ...meta.loadedAddresses.readonly]) {
    try { if (typeof key !== "string" || address(key) !== key) return fail(); } catch { return fail(); }
    keys.push(key as string);
  }
  if (!Array.isArray(meta.preBalances) || !Array.isArray(meta.postBalances) ||
      meta.preBalances.length !== keys.length || meta.postBalances.length !== keys.length) return fail();
  const executes = message.instructions.filter(instruction => keys[instruction.programAddressIndex] === submission.programId);
  if (executes.length !== 1) return fail();
  const tempIndex = executes[0]!.accountIndices?.[8], swapIndex = executes[0]!.accountIndices?.[7];
  if (tempIndex === undefined || swapIndex === undefined || !keys[tempIndex] || !keys[swapIndex]) return fail();
  let refund = 0n;
  if (meta.err === null) {
    // The locally built vault instruction closes its per-sequence input ATA.
    // Preexisting rent/donated lamports are refunded to the fee payer; native
    // WSOL token donations go to the owner's refund ATA instead.
    if (integer(meta.postBalances[tempIndex]) !== 0 || !Array.isArray(meta.preTokenBalances) || !Array.isArray(meta.postTokenBalances) ||
        meta.postTokenBalances.some(row => object(row) && row.accountIndex === tempIndex)) return fail();
    refund = BigInt(integer(meta.preBalances[tempIndex]));
    const tempRows = meta.preTokenBalances.filter(row => object(row) && row.accountIndex === tempIndex);
    if (tempRows.length > 1) return fail();
    if (tempRows.length) {
      const row = tempRows[0];
      if (!object(row) || row.owner !== keys[swapIndex] || row.mint !== submission.intent.inputMint || row.programId !== submission.inputTokenProgram || !object(row.uiTokenAmount)) return fail();
      const donatedTokens = parseSolanaRawAmount(row.uiTokenAmount.amount, true);
      if (submission.intent.inputMint === SOLANA_WRAPPED_SOL_MINT) refund -= donatedTokens;
    } else if (submission.intent.inputMint === SOLANA_WRAPPED_SOL_MINT) {
      // Lamports sent to the System-owned address before the swap opened its native
      // account there: everything above the rent-exempt reserve became WSOL the vault
      // refunded to the owner; only the reserve came back to the fee payer on close.
      const reserve = BigInt(submission.rentLamports);
      if (refund > reserve) refund = reserve;
    }
    if (refund < 0n) return fail();
  }
  if (BigInt(integer(meta.preBalances[0])) - BigInt(integer(meta.postBalances[0])) !== fee - refund) return fail();
  const token = (balances: unknown, account: string, mint: string, tokenProgram: string): bigint => {
    if (!Array.isArray(balances)) return fail();
    const index = keys.indexOf(account);
    if (index < 0) return fail();
    const rows = balances.filter(row => object(row) && row.accountIndex === index);
    if (rows.length !== 1 || !object(rows[0])) return fail();
    const row = rows[0];
    if (row.owner !== submission.intent.vault || row.mint !== mint || row.programId !== tokenProgram || !object(row.uiTokenAmount)) return fail();
    return parseSolanaRawAmount(row.uiTokenAmount.amount, true);
  };
  const inputBefore = token(meta.preTokenBalances, submission.inputTokenAccount, submission.intent.inputMint, submission.inputTokenProgram);
  const inputAfter = token(meta.postTokenBalances, submission.inputTokenAccount, submission.intent.inputMint, submission.inputTokenProgram);
  const outputBefore = token(meta.preTokenBalances, submission.outputTokenAccount, submission.intent.outputMint, submission.outputTokenProgram);
  const outputAfter = token(meta.postTokenBalances, submission.outputTokenAccount, submission.intent.outputMint, submission.outputTokenProgram);
  if (meta.err !== null) {
    // Logs are never needed to book a failure: the bytes did not change the vault.
    if (inputBefore !== inputAfter || outputBefore !== outputAfter) return fail();
    return { status: "failed", signature: submission.signature, slot, feeLamports: fee.toString(),
      amountIn: "0", amountOut: "0", finalizedAtMs: nowMs };
  }
  const amountIn = inputBefore - inputAfter, amountOut = outputAfter - outputBefore;
  if (amountIn <= 0n || amountIn > BigInt(submission.intent.amountRaw) || amountOut < BigInt(submission.minOutAmount)) return fail();
  const logs = parseVaultLogs(meta.logMessages, submission.programId, true);
  if (logs.complete ? logs.events.length !== 1 : logs.events.length > 1) return fail();
  for (const event of logs.events) {
    if (event.vault !== submission.intent.vault || event.owner !== submission.intent.owner || event.session !== submission.session ||
        event.sessionEpoch.toString() !== submission.sessionEpoch || event.seq.toString() !== submission.vaultSequence ||
        event.inputMint !== submission.intent.inputMint || event.outputMint !== submission.intent.outputMint ||
        event.amountIn !== amountIn || event.amountOut !== amountOut || event.timestamp < 0n) return fail();
  }
  if (vault !== undefined || !logs.complete) {
    if (!object(vault) || vault.address !== submission.intent.vault || !Number.isSafeInteger(vault.slot) || vault.slot < slot ||
        !object(vault.state) || vault.state.owner !== submission.intent.owner ||
        vault.state.seq <= BigInt(submission.vaultSequence) || vault.state.sessionEpoch < BigInt(submission.sessionEpoch)) return fail();
  }
  return { status: "finalized", signature: submission.signature, slot, feeLamports: fee.toString(),
    amountIn: amountIn.toString(), amountOut: amountOut.toString(), finalizedAtMs: nowMs };
}
