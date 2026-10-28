import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getBase58Encoder, getBase58Decoder,
  getTransactionDecoder, getCompiledTransactionMessageDecoder, verifySignature } from "@solana/kit";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { deriveSolanaVaultAddress, deriveSolanaSwapAuthority, deriveSolanaAta, SOLANA_VAULT_LOCAL_TEST_PROGRAM,
  SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_VAULT_DISCRIMINATOR, SOLANA_SWAP_EVENT_DISCRIMINATOR,
  SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { createSolanaExecutor, observationKey, observeSolanaSubmission, readSolanaOwnerRefundBlocks, reconcileSolanaSubmission, SOLANA_PROVIDER_SLOT_SKEW, solanaAgreedSettlement,
  solanaDebitWindowStart, SolanaExecutionError, solanaPendingRefund,
  solanaQuorumSlot, verifySolanaVaultDeployment, type SolanaLiveRecord, type SolanaSignedSubmission, type SolanaExecutorOptions } from "./solana-executor";
import { settleSolanaReceipt, solanaVaultEvents } from "./solana-settlement";
import { JUPITER_SWAP_PROGRAM, SolanaLiveMarketError, type JupiterCpiRoute } from "./solana-live-market";
import type { SolanaLiveRead, SolanaLiveRpc, SolanaSendOptions } from "./solana-live-rpc";
import { createSolanaLiveRpc } from "./solana-live-rpc";
import { SOLANA_MAINNET_GENESIS_HASH, SolanaRpcError } from "./solana-rpc";
import { pythBound } from "./solana-reference-price-fixture";

const key = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
const keyBytes = (value: string) => Buffer.from(getBase58Encoder().encode(value));
const PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM;
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";
const SLOT = 1000;
const NOW = 1_000_000;
const CASH = 1_000_000_000n;
function token(mint: string, owner: string, amount: bigint): Buffer {
  const bytes = Buffer.alloc(165); keyBytes(mint).copy(bytes, 0); keyBytes(owner).copy(bytes, 32);
  bytes.writeBigUInt64LE(amount, 64); bytes[108] = 1; return bytes;
}
function rpcAccount(data: Buffer, owner: string, executable = false, lamports = 100_000_000) {
  return { owner, executable, lamports, data: [data.toString("base64"), "base64"], space: data.length };
}
function state(owner: string, session: string, seq = 0n, overrides: { paused?: boolean; expiry?: bigint } = {}): Buffer {
  const bytes = Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE); Buffer.from(SOLANA_VAULT_DISCRIMINATOR).copy(bytes);
  let offset = 8; bytes[offset++] = 2; bytes[offset++] = 255;
  for (const value of [owner, session]) { keyBytes(value).copy(bytes, offset); offset += 32; }
  for (const value of [1n, seq, overrides.expiry ?? 10_000n, 100_000_000n, CASH, 5_000_000_000n, 50_000_000_000n]) { bytes.writeBigUInt64LE(value, offset); offset += 8; }
  bytes.writeUInt16LE(96, offset); offset += 2; bytes[offset] = Number(overrides.paused ?? false); return bytes;
}
function event(submission: SolanaSignedSubmission, amountIn = 1_000_000n, amountOut = 2_000_000n): string {
  const bytes = Buffer.alloc(208); Buffer.from(SOLANA_SWAP_EVENT_DISCRIMINATOR).copy(bytes); let offset = 8;
  for (const value of [submission.intent.vault, submission.intent.owner, submission.session]) { keyBytes(value).copy(bytes, offset); offset += 32; }
  for (const value of [BigInt(submission.sessionEpoch), BigInt(submission.vaultSequence)]) { bytes.writeBigUInt64LE(value, offset); offset += 8; }
  for (const value of [submission.intent.inputMint, submission.intent.outputMint]) { keyBytes(value).copy(bytes, offset); offset += 32; }
  for (const value of [amountIn, amountOut, 1000n]) { bytes.writeBigUInt64LE(value, offset); offset += 8; }
  return bytes.toString("base64");
}
/** The audited test build: declare_id! embeds the program id's 32 bytes in the executable region. */
const DECLARING_BINARY = Buffer.concat([Buffer.from("audited-vault-test-binary"), keyBytes(PROGRAM)]);
async function fixture(fixtureOptions: { binary?: Buffer } = {}) {
  const sessionKeyPair = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(11));
  const feePayerKeyPair = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(12));
  const session = await getAddressFromPublicKey(sessionKeyPair.publicKey), feePayer = await getAddressFromPublicKey(feePayerKeyPair.publicKey);
  const owner = key(20), vault = await deriveSolanaVaultAddress(PROGRAM, owner);
  const input = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
  const output = await deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  const swap = await deriveSolanaSwapAuthority(PROGRAM, vault, 0n);
  const temp = await deriveSolanaAta(swap, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
  const ownerRefund = await deriveSolanaAta(owner, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
  const programDataAddress = key(31), binary = fixtureOptions.binary ?? DECLARING_BINARY;
  const program = Buffer.alloc(36); program.writeUInt32LE(2); keyBytes(programDataAddress).copy(program, 4);
  const programData = Buffer.alloc(45 + binary.length); programData.writeUInt32LE(3); binary.copy(programData, 45);
  const clock = { value: NOW };
  const controls = { upgradeable: false, paused: false, failSend: false, simulationError: false, persistError: false,
    conflict: false, finalized: false, wrongSignature: false, fee: 10_000, riskWrongBalance: false, mintReason: false,
    riskDelay: 0, substituteCpi: false, badLookup: false, goodLookup: false, stateEpochAfter: false, badRefund: false, tempDonation: false,
    // The owner's input ATA closed or delegated, and tokens already sitting in the temporary input ATA.
    refundMissing: false, refundDelegate: false, tempTokens: 0n,
    // Pyth SOL/USD with 8 decimals; the fixture route buys 0.002 SOL per USDG, i.e. $500.
    referencePrice: 50_000_000_000n, referenceAgeMs: 0, forgeFloor: false,
    // Recent prioritization fees (micro-lamports per CU) the RPC reports for the swap's writable accounts.
    priorityFees: [] as number[], priorityError: false,
    // What the shared network fee payer holds.
    payerLamports: 100_000_000,
    // The vault's finalized sequence after the receipt slot, and the second provider's own view.
    vaultSeqAfter: 1n, fallback: null as SolanaLiveRead | null };
  let record: SolanaLiveRecord | null = null;
  const calls: string[] = [], sendOptions: (SolanaSendOptions | undefined)[] = [], priorityReads: unknown[] = [];
  const quote = { source: "jupiter" as const, inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT,
    inAmount: "1000000", outAmount: "2000000", minOutAmount: "1980000", slippageBps: 100,
    contextSlot: SLOT, quotedAtMs: NOW, expiresAtMs: NOW + 30_000 };
  const data = Buffer.alloc(36); createHash("sha256").update("global:shared_accounts_route").digest().subarray(0, 8).copy(data);
  data.writeUInt32LE(1, 9); data[14] = 100; data[16] = 1;
  data.writeBigUInt64LE(1_000_000n, 17); data.writeBigUInt64LE(2_000_000n, 25); data.writeUInt16LE(100, 33);
  const route: JupiterCpiRoute = { quote, dataBase64: data.toString("base64"), lookupTableAddresses: [], accounts:
    [SOLANA_CLASSIC_TOKEN_PROGRAM, key(40), swap, temp, key(41), key(42), output, SOLANA_USDG_MINT, SOLANA_WRAPPED_SOL_MINT, JUPITER_SWAP_PROGRAM, TOKEN_2022_PROGRAM]
      .map((address, index) => ({ address, isSigner: index === 2, isWritable: [3,4,5,6].includes(index) })) };
  const response = (value: unknown) => ({ context: { slot: SLOT }, value });
  const refundAccount = () => {
    if (controls.refundMissing) return null;
    const bytes = token(SOLANA_USDG_MINT, controls.badRefund ? key(90) : owner, 0n);
    if (controls.refundDelegate) { bytes.writeUInt32LE(1, 72); keyBytes(key(91)).copy(bytes, 76); }
    return rpcAccount(bytes, TOKEN_2022_PROGRAM);
  };
  const tempLamports = () => controls.tempDonation || controls.tempTokens > 0n ? 2_039_280 : 0;
  const tempAccount = () => controls.tempTokens > 0n ? rpcAccount(token(SOLANA_USDG_MINT, swap, controls.tempTokens), TOKEN_2022_PROGRAM, false, 2_039_280)
    : controls.tempDonation ? rpcAccount(Buffer.alloc(0), SYSTEM, false, 2_039_280) : null;
  const receipt = (submission: SolanaSignedSubmission, failed = false, amountOut = 2_000_000n) => {
    const tx = getTransactionDecoder().decode(Buffer.from(submission.signedTransactionBase64, "base64"));
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const keys = [...message.staticAccounts, ...submission.loadedAddresses.writable, ...submission.loadedAddresses.readonly];
    const tempIndex = keys.indexOf(temp);
    const balances = Array.from({ length: keys.length }, (_, index) => index === 0 ? 100_000_000 : index === tempIndex ? tempLamports() : 1_000_000);
    const tokenRow = (account: string, mint: string, programId: string, amount: bigint) => ({ accountIndex: keys.indexOf(account),
      mint, owner: vault, programId, uiTokenAmount: { amount: amount.toString(), decimals: mint === SOLANA_USDG_MINT ? 6 : 9 } });
    return { version: 0, slot: SLOT + 1, transaction: [submission.signedTransactionBase64, "base64"], meta: {
      err: failed ? { InstructionError: [2, { Custom: 1 }] } : null, fee: 10_000,
      preBalances: balances, postBalances: balances.map((n, i) => i === 0 ? n - 10_000 + (!failed ? tempLamports() : 0) : i === tempIndex && !failed ? 0 : n), loadedAddresses: structuredClone(submission.loadedAddresses),
      preTokenBalances: [tokenRow(input, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, CASH), tokenRow(output, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM, 0n),
        ...(controls.tempTokens > 0n ? [{ ...tokenRow(temp, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, controls.tempTokens), owner: swap }] : [])],
      postTokenBalances: [tokenRow(input, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, failed ? CASH : CASH - 1_000_000n),
        tokenRow(output, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM, failed ? 0n : amountOut)],
      logMessages: [`Program ${PROGRAM} invoke [1]`, ...(failed ? [] : [`Program data: ${event(submission, 1_000_000n, amountOut)}`]),
        `Program ${PROGRAM} ${failed ? "failed: custom program error: 0x1" : "success"}`] as string[] | null,
    } };
  };
  const read: SolanaLiveRead = async (method, params = []) => {
    calls.push(method);
    switch (method) {
      case "getSlot": return SLOT;
      case "getAccountInfo": {
        const [key, config] = params as [string, { dataSlice?: { offset: number; length: number } }];
        if (key === PROGRAM) return response(rpcAccount(program, LOADER, true));
        if (key === programDataAddress) {
          const bytes = Buffer.from(programData); bytes[12] = Number(controls.upgradeable);
          const slice = config.dataSlice!;
          return response({ ...rpcAccount(bytes.subarray(slice.offset, slice.offset + slice.length), LOADER), space: bytes.length });
        }
        if (key === "AddressLookupTab1e1111111111111111111111111") return response(rpcAccount(Buffer.alloc(56), SYSTEM));
        if (key === vault) {
          // Finalized evidence after the receipt (slot SLOT + 1).
          assert.deepEqual(config, { encoding: "base64", commitment: "finalized", minContextSlot: SLOT + 1 });
          return { context: { slot: SLOT + 2 }, value: rpcAccount(state(owner, session, controls.vaultSeqAfter), PROGRAM) };
        }
        if (key === getBase58Decoder().decode(new Uint8Array(32).fill(61))) {
          const table = Buffer.alloc(56 + 32 * route.accounts.length); table.writeUInt32LE(1);
          table.writeBigUInt64LE((1n << 64n) - 1n, 4); table.writeBigUInt64LE(BigInt(SLOT - 1), 12);
          route.accounts.forEach((a, i) => keyBytes(a.address).copy(table, 56 + i * 32));
          return response(rpcAccount(table, "AddressLookupTab1e1111111111111111111111111"));
        }
        throw new Error("Unexpected fixture account");
      }
      case "getMultipleAccounts": {
        const keys = params[0] as string[];
        if (keys[0] === vault) {
          const accounts = [rpcAccount(state(owner, session, 0n, { paused: controls.paused }), PROGRAM),
            rpcAccount(token(SOLANA_USDG_MINT, vault, CASH), TOKEN_2022_PROGRAM), rpcAccount(token(SOLANA_WRAPPED_SOL_MINT, vault, 0n), SOLANA_CLASSIC_TOKEN_PROGRAM),
            rpcAccount(Buffer.alloc(0), SYSTEM, false, controls.payerLamports)];
          if (keys.length === 5) { assert.equal(keys[4], ownerRefund); accounts.push(refundAccount()!); }
          return response(accounts);
        }
        if (keys.length === 2 && keys[0] === temp) { assert.equal(keys[1], ownerRefund); return response([tempAccount(), refundAccount()]); }
        return response(keys.map(value => value === output ? rpcAccount(token(SOLANA_WRAPPED_SOL_MINT, vault, 0n), SOLANA_CLASSIC_TOKEN_PROGRAM)
          : value === temp ? tempAccount() : null));
      }
      case "getMinimumBalanceForRentExemption": return 2_039_280;
      case "getLatestBlockhash": return response({ blockhash: key(50), lastValidBlockHeight: 1200 });
      case "getFeeForMessage": return response(controls.fee);
      case "getRecentPrioritizationFees":
        priorityReads.push(params[0]);
        if (controls.priorityError) throw new Error("method not found");
        return controls.priorityFees.map((prioritizationFee, index) => ({ slot: SLOT - index, prioritizationFee }));
      case "simulateTransaction": {
        const tx = getTransactionDecoder().decode(Buffer.from(params[0] as string, "base64"));
        assert.equal(Object.keys(tx.signatures).length, 2);
        assert.ok(Object.values(tx.signatures).every(signature => signature === null));
        const vaultAfter = state(owner, session, 1n); if (controls.stateEpochAfter) vaultAfter.writeBigUInt64LE(2n, 74);
        return response({ err: controls.simulationError ? { InstructionError: [2, "Custom"] } : null, unitsConsumed: 200_000,
          accounts: [rpcAccount(vaultAfter, PROGRAM), rpcAccount(token(SOLANA_USDG_MINT, vault, CASH - 1_000_000n), TOKEN_2022_PROGRAM),
            rpcAccount(token(SOLANA_WRAPPED_SOL_MINT, vault, 2_000_000n), SOLANA_CLASSIC_TOKEN_PROGRAM), rpcAccount(Buffer.alloc(0), SYSTEM, false, 99_990_000 + (controls.tempDonation ? 2_039_280 : 0))] });
      }
      case "getSignatureStatuses": return response([controls.finalized ? { confirmationStatus: "finalized", slot: SLOT + 1, err: null } : null]);
      case "getTransaction": assert.ok(record); return receipt(record.submission);
      default: throw new Error(`Unexpected fixture method ${method}`);
    }
  };
  const rpc: SolanaLiveRpc = { read: operation => operation(read),
    readEach: async operation => [await operation(read), await operation(controls.fallback ?? read)],
    async send(wire, _slot, _signal, options) {
    calls.push("send"); sendOptions.push(options); assert.ok(record, "transaction must be durable before broadcast");
    assert.equal(record.submission.signedTransactionBase64, wire);
    if (controls.failSend) throw new Error("lost HTTP response");
    return controls.wrongSignature ? "different" : record.submission.signature;
  } };
  const options: SolanaExecutorOptions = { programId: PROGRAM, programBinarySha256: createHash("sha256").update(binary).digest("hex"),
    sessionKeyPair, feePayerKeyPair, rpc, now: () => clock.value, maxFeeLamports: "3000000",
    market: { async readMint(mint) { return { address: mint, program: mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM,
      decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: SLOT, observedAtMs: NOW, buyBlockedReasons: controls.mintReason ? ["transfer-fee"] : [] }; },
      async build() {
        if (controls.substituteCpi) route.accounts = route.accounts.map((a, i) => i === 6 ? { ...a, address: key(60) } : a);
        if (controls.badLookup) route.lookupTableAddresses = ["AddressLookupTab1e1111111111111111111111111"];
        if (controls.goodLookup) route.lookupTableAddresses = [key(61)];
        return route;
      } },
    journal: { async get() { return record; }, async recordSigned(submission) {
      calls.push("persist"); if (controls.persistError) throw new Error("disk fsync failed"); if (controls.conflict) return false;
      record = { submission, status: "pending" }; return true;
    }, async settle(_owner, _id, signature, settlement) {
      assert.equal(signature, record!.submission.signature); record = { submission: record!.submission, status: settlement.status, settlement };
    } },
    async assessRisk({ intent }) {
      clock.value += controls.riskDelay;
      const reference = pythBound(intent, clock.value - controls.referenceAgeMs, controls.referencePrice, SLOT);
      return { observedAtMs: clock.value, slot: SLOT, notionalUsdg: "1000000", equityUsdg: CASH.toString(), peakEquityUsdg: CASH.toString(),
        cashUsdg: controls.riskWrongBalance ? "1" : CASH.toString(), wsolRaw: "0", reference: controls.forgeFloor ? { ...reference, minOutFloor: "1" } : reference };
    } };
  const intent = { kind: "spl-swap", chain: CHAINS.solana, mode: "live", requestId: "actual-test-1", owner, vault,
    inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000", slippageBps: 100 };
  return { options, intent, controls, calls, clock, receipt, session, feePayer, ownerRefund, route, read, sendOptions, priorityReads,
    temp, input, output, programData, programDataAddress, getRecord: () => record };
}
/** The account the signed execute_swap passes in the owner_refund slot (index 14). */
function refundSlot(submission: SolanaSignedSubmission): string {
  const tx = getTransactionDecoder().decode(Buffer.from(submission.signedTransactionBase64, "base64"));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const keys = [...compiled.staticAccounts, ...submission.loadedAddresses.writable, ...submission.loadedAddresses.readonly];
  const swap = compiled.instructions.find(ix => keys[ix.programAddressIndex] === PROGRAM)!;
  return keys[swap.accountIndices![14]!]!;
}

test("builds real two-signer v0 bytes, verifies them, persists before one send and settles actual finalized deltas", async () => {
  const f = await fixture(); const executor = createSolanaExecutor(f.options);
  const pending = await executor.execute(f.intent);
  assert.equal(pending.status, "pending");
  assert.equal(f.calls.filter(call => call === "send").length, 1);
  // The transport may rebroadcast these bytes until the signed deadline: the quote's expiry, in whole seconds.
  assert.deepEqual(f.sendOptions, [{ untilMs: Math.floor((NOW + 30_000) / 1000) * 1000 }]);
  assert.ok(f.calls.indexOf("persist") < f.calls.indexOf("send"));
  const tx = getTransactionDecoder().decode(Buffer.from(pending.submission.signedTransactionBase64, "base64"));
  assert.ok(await verifySignature(f.options.sessionKeyPair.publicKey, tx.signatures[f.session]!, tx.messageBytes));
  assert.ok(await verifySignature(f.options.feePayerKeyPair.publicKey, tx.signatures[f.feePayer]!, tx.messageBytes));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  assert.equal(compiled.version, 0);
  // No donation waits in the temporary account, so the owner's ATA is left out.
  assert.equal(compiled.staticAccounts[compiled.instructions[2]!.accountIndices![14]!], PROGRAM);
  const count = f.calls.length; assert.deepEqual(await executor.execute(f.intent), pending); assert.equal(f.calls.length, count);
  assert.equal((await executor.reconcile(f.intent.owner, f.intent.requestId))?.status, "pending");
  f.controls.finalized = true;
  const finalized = await executor.reconcile(f.intent.owner, f.intent.requestId);
  assert.equal(finalized?.status, "finalized");
  assert.equal(finalized?.settlement?.amountIn, "1000000"); assert.equal(finalized?.settlement?.amountOut, "2000000");
  assert.equal(finalized?.settlement?.feeLamports, "10000");
});

test("every read of a live trade, from the deployment check to its settlement, asks for finalized: Alpenglow made confirmed the same state, and Agave will remove it", async () => {
  const f = await fixture(), asked = new Set<string>();
  const recorded = (read: SolanaLiveRead): SolanaLiveRead => async (method, params = []) => {
    for (const param of params) {
      if (!param || typeof param !== "object" || Array.isArray(param)) continue;
      for (const [field, value] of Object.entries(param)) if (/commitment/i.test(field)) asked.add(`${method} ${field}=${String(value)}`);
    }
    return read(method, params);
  };
  const inner = f.options.rpc;
  const rpc: SolanaLiveRpc = { read: operation => inner.read(read => operation(recorded(read))),
    readEach: operation => inner.readEach!(read => operation(recorded(read))), send: (...args) => inner.send(...args) };
  const executor = createSolanaExecutor({ ...f.options, rpc });
  assert.equal((await executor.execute(f.intent)).status, "pending");
  f.controls.finalized = true;
  assert.equal((await executor.reconcile(f.intent.owner, f.intent.requestId))?.status, "finalized");
  assert.deepEqual([...asked].sort(), ["getAccountInfo", "getFeeForMessage", "getLatestBlockhash", "getMinimumBalanceForRentExemption",
    "getMultipleAccounts", "getSlot", "getTransaction", "simulateTransaction"].map(method => `${method} commitment=finalized`));
});
test("lost send response and mismatched returned signature stay durable pending, never re-sign or resend", async () => {
  for (const mode of ["failSend", "wrongSignature"] as const) {
    const f = await fixture(); f.controls[mode] = true; const executor = createSolanaExecutor(f.options);
    const first = await executor.execute(f.intent); assert.equal(first.status, "pending");
    assert.deepEqual(await executor.execute(f.intent), first);
    f.clock.value += 120_000;
    assert.equal((await executor.reconcile(f.intent.owner, f.intent.requestId))?.status, "pending");
    assert.equal(f.calls.filter(call => call === "send").length, 1);
    assert.equal(f.calls.filter(call => call === "getLatestBlockhash").length, 1);
  }
});

test("crash recovery releases a sequence only when finalized vault state proves execution impossible; fees stay unknown", async () => {
  const deadline = Math.floor((NOW + 30_000) / 1000) * 1000;
  for (const mode of ["expired", "revoked", "advanced", "not-expired", "not-expired-late", "wrong-owner", "wrong-program", "old-slot", "receipt-present"] as const) {
    const f = await fixture(); f.controls.failSend = true;
    const executor = createSolanaExecutor(f.options); const original = await executor.execute(f.intent);
    const proofReads: string[] = [], resent: string[] = [];
    const read: SolanaLiveRead = async (method, params) => {
      proofReads.push(method);
      if (method === "getSignatureStatuses") return { context: { slot: SLOT }, value: [null] };
      if (method === "getTransaction") return mode === "receipt-present" ? f.receipt(original.submission) : null;
      if (method === "getEpochInfo") {
        // Slot and height from one finalized bank.
        assert.deepEqual(params, [{ commitment: "finalized", minContextSlot: SLOT }]);
        return { absoluteSlot: SLOT + 2, blockHeight: ["revoked", "not-expired", "not-expired-late"].includes(mode) ? 1199 : 1201, epoch: 1, slotIndex: SLOT + 2, slotsInEpoch: 432_000 };
      }
      if (method === "getAccountInfo") {
        assert.deepEqual(params, [f.intent.vault, { encoding: "base64", commitment: "finalized", minContextSlot: SLOT + 2 }]);
        const bytes = state(mode === "wrong-owner" ? key(90) : f.intent.owner, f.session, mode === "advanced" ? 1n : 0n);
        if (mode === "revoked") bytes.writeBigUInt64LE(2n, 74);
        return { context: { slot: mode === "old-slot" ? SLOT : SLOT + 2 }, value: rpcAccount(bytes, mode === "wrong-program" ? key(91) : PROGRAM) };
      }
      return assert.fail(`Unexpected proof read ${method}`);
    };
    const rpc: SolanaLiveRpc = { read: callback => callback(read), readEach: async callback => [await callback(read), await callback(read)],
      send: async (wire, slot, _signal, options) => {
        // Reconciliation may only rebroadcast the saved bytes, one round at a time.
        assert.equal(wire, original.submission.signedTransactionBase64); assert.equal(slot, SLOT); assert.deepEqual(options, { untilMs: 0 });
        resent.push(wire); return original.submission.signature;
      } };
    const now = () => mode === "not-expired-late" ? deadline : NOW + 1;
    if (["wrong-owner", "wrong-program", "old-slot"].includes(mode)) {
      await assert.rejects(reconcileSolanaSubmission(rpc, f.options.journal, f.intent.owner, f.intent.requestId, now));
      assert.equal(f.getRecord()!.status, "pending"); assert.equal(resent.length, 0); continue;
    }
    const result = await reconcileSolanaSubmission(rpc, f.options.journal, f.intent.owner, f.intent.requestId, now);
    assert.ok(!proofReads.includes("getBlockHeight") && !proofReads.includes("getSlot"), mode);
    if (["expired", "revoked"].includes(mode)) {
      assert.equal(result!.status, "expired"); assert.equal(result!.settlement!.feeLamports, null);
      assert.equal(result!.settlement!.amountIn, "0"); assert.equal(result!.settlement!.amountOut, "0");
      assert.equal(result!.settlement!.slot, SLOT + 2);
      assert.equal(result!.settlement!.status === "expired" && result!.settlement!.expiryProof.blockHeight, mode === "expired" ? "1201" : "1199");
      assert.deepEqual(await executor.execute(f.intent), result);
      assert.ok(proofReads.indexOf("getEpochInfo") < proofReads.indexOf("getAccountInfo"));
    } else assert.equal(result!.status, "pending", mode);
    // Only a signature nobody has seen, inside its signed deadline, is rebroadcast.
    assert.equal(resent.length, mode === "not-expired" ? 1 : 0, mode);
    assert.equal(f.calls.filter(call => call === "send").length, 1);
  }
});

/** A vault account whose sequence is `seq` and whose debit log holds one debit per timestamp (cluster unix seconds). */
function vaultWithDebits(owner: string, session: string, seq: bigint, timestamps: bigint[]): Buffer {
  const bytes = state(owner, session, seq);
  // 8 discriminator, version, bump, owner, session, 7 u64 fields, max_ops u16, paused u8: the debit count follows at 133.
  bytes.writeUInt32LE(timestamps.length, 133);
  timestamps.forEach((timestamp, index) => { const at = 137 + index * 24; bytes.writeBigInt64LE(timestamp, at); bytes.writeBigUInt64LE(1_000_000n, at + 8); bytes.writeBigUInt64LE(0n, at + 16); });
  return bytes;
}

test("a sequence another transaction consumed is proven expired only from the vault's debit log, and only when the operator's tool asks (audit live-M1)", async () => {
  // The fixture's swap is signed with a deadline of NOW + 30 s (unix 1030): it could only have run at a cluster time from 1000 to 1029.
  // `unproven`: why a pending view says it cannot prove the bytes never ran (sequenceMoved.reason), for the operator.
  // `signedAt`: the sequence the observed bytes claim to be signed at (default: the fixture's own, 0).
  const cases: Array<{ label: string; seq: bigint; debits: bigint[]; height?: number; ask?: boolean; proven: boolean; unproven?: string; signedAt?: bigint }> = [
    { label: "the provider's vault is before the signed sequence", seq: 1n, debits: [], signedAt: 5n, proven: false, unproven: "behind" },
    { label: "an owner withdrawal moved it and no swap ran", seq: 1n, debits: [], proven: true },
    { label: "only older swaps are in the log", seq: 3n, debits: [100n, 999n], proven: true },
    { label: "a debit at the earliest moment it could have run", seq: 1n, debits: [1000n], proven: false, unproven: "debit-in-window" },
    { label: "a debit inside its window", seq: 1n, debits: [999n, 1029n], proven: false, unproven: "debit-in-window" },
    { label: "a later swap's debit: it may have pruned this one's", seq: 2n, debits: [90_000n], proven: false, unproven: "debit-in-window" },
    { label: "its blockhash could still land", seq: 1n, debits: [], height: 1200, proven: false, unproven: "blockhash-live" },
    { label: "the worker's own reconciliation never asks", seq: 1n, debits: [], ask: false, proven: false, unproven: "not-asked" },
  ];
  for (const c of cases) {
    const f = await fixture(); f.controls.failSend = true;
    const { submission } = await createSolanaExecutor(f.options).execute(f.intent);
    assert.equal(solanaDebitWindowStart(submission), 1000n);
    const read: SolanaLiveRead = async (method, params) => {
      if (method === "getSignatureStatuses") return { context: { slot: SLOT }, value: [null] };
      if (method === "getTransaction") return null;
      if (method === "getEpochInfo") return { absoluteSlot: SLOT + 2, blockHeight: c.height ?? 1201 };
      if (method === "getAccountInfo") {
        assert.deepEqual(params, [f.intent.vault, { encoding: "base64", commitment: "finalized", minContextSlot: SLOT + 2 }]);
        return { context: { slot: SLOT + 2 }, value: rpcAccount(vaultWithDebits(f.intent.owner, f.session, c.seq, c.debits), PROGRAM) };
      }
      return assert.fail(`Unexpected proof read ${method}`);
    };
    const observed = c.signedAt === undefined ? submission : { ...submission, vaultSequence: c.signedAt.toString() };
    const view = await observeSolanaSubmission(read, observed, f.intent.owner, NOW + 1, c.ask === false ? {} : { proveSequenceConsumed: true });
    if (c.proven) {
      assert.equal(view.seen, false, c.label);
      assert.deepEqual(view.settlement, { status: "expired", signature: submission.signature, slot: SLOT + 2, feeLamports: null, amountIn: "0", amountOut: "0",
        finalizedAtMs: NOW + 1, expiryProof: { vaultSequence: c.seq.toString(), sessionEpoch: "1", blockHeight: "1201", reason: "sequence-consumed", debitWindowStart: "1000" } }, c.label);
    } else {
      assert.deepEqual(view, { settlement: null, seen: true, sequenceMoved: { vaultSequence: c.seq.toString(), blockHeight: String(c.height ?? 1201), reason: c.unproven,
        ...(c.unproven === "debit-in-window" ? { debitWindowStart: "1000" } : {}) } }, c.label);
      // What providers must agree on is unchanged: still pending.
      assert.equal(observationKey(view), "pending", c.label);
    }
    // Automatic reconciliation books nothing for a moved sequence, and never rebroadcasts bytes that can no longer run.
    const resent: string[] = [];
    const rpc: SolanaLiveRpc = { read: callback => callback(read), readEach: async callback => [await callback(read), await callback(read)],
      send: async wire => { resent.push(wire); return submission.signature; } };
    assert.equal((await reconcileSolanaSubmission(rpc, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1))!.status, "pending", c.label);
    assert.equal(f.getRecord()!.status, "pending", c.label); assert.deepEqual(resent, [], c.label);
  }
});

test("the vault snapshot a swap is signed against is read no earlier than the caller's floor: a lagging provider signs nothing (audit live-M1)", async () => {
  const f = await fixture();
  const snapshotReads: unknown[] = [];
  const read = f.options.rpc.read;
  const watched: SolanaLiveRpc = { ...f.options.rpc, read: operation => read(rpc => operation(async (method, params) => {
    if (method === "getMultipleAccounts" && (params?.[0] as string[])?.[0] === f.intent.vault) snapshotReads.push((params![1] as { minContextSlot: number }).minContextSlot);
    return rpc(method, params);
  })) };
  // The provider's banks are at SLOT; the book (or the latest owner withdrawal) is past it.
  await assert.rejects(createSolanaExecutor({ ...f.options, rpc: watched, minSnapshotSlot: SLOT + 50 }).execute(f.intent), /refused: invalid-state/);
  assert.deepEqual(snapshotReads, [SLOT + 50]);
  assert.ok(!f.calls.includes("persist") && !f.calls.includes("send"), "nothing recorded or sent");
  assert.equal(f.getRecord(), null);
  // At or behind the provider's slot, its own fresh slot is the floor, as before.
  snapshotReads.length = 0;
  assert.equal((await createSolanaExecutor({ ...f.options, rpc: watched, minSnapshotSlot: SLOT - 50 }).execute(f.intent)).status, "pending");
  assert.deepEqual(snapshotReads, [SLOT]);
  for (const bad of [0, -1, 1.5]) assert.throws(() => createSolanaExecutor({ ...f.options, minSnapshotSlot: bad }), SolanaExecutionError, String(bad));
});

test("an expiry proof never pairs a current block height with a lagging node's slot (audit execution F1)", async () => {
  // One RPC URL load-balances two nodes. The swap landed at SLOT + 1 and the
  // current node has finalized it; the lagging node's finalized bank is SLOT.
  const nodes = { current: { slot: SLOT + 5, height: 1201, seq: 1n }, lagging: { slot: SLOT, height: 1199, seq: 0n } } as const;
  for (const bank of ["current", "lagging"] as const) {
    const f = await fixture(); f.controls.failSend = true;
    await createSolanaExecutor(f.options).execute(f.intent);
    const read: SolanaLiveRead = async (method, params) => {
      const config = (params?.at(-1) ?? {}) as { minContextSlot?: number };
      if (method === "getSignatureStatuses") return { context: { slot: nodes.lagging.slot }, value: [null] };
      if (method === "getTransaction") return null;
      if (method === "getBlockHeight") return nodes.current.height;
      if (method === "getSlot") return nodes.lagging.slot;
      if (method === "getEpochInfo") return { absoluteSlot: nodes[bank].slot, blockHeight: nodes[bank].height, epoch: 1, slotIndex: 0, slotsInEpoch: 432_000 };
      if (method === "getAccountInfo") {
        // The balancer may route to any node whose finalized bank reaches minContextSlot.
        const node = (config.minContextSlot ?? 0) <= nodes.lagging.slot ? nodes.lagging : nodes.current;
        return { context: { slot: node.slot }, value: rpcAccount(state(f.intent.owner, f.session, node.seq), PROGRAM) };
      }
      return assert.fail(`Unexpected read ${method}`);
    };
    const rpc: SolanaLiveRpc = { read: callback => callback(read), readEach: async callback => [await callback(read), await callback(read)],
      send: async wire => wire };
    const result = await reconcileSolanaSubmission(rpc, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1);
    assert.equal(result!.status, "pending", bank); assert.equal(f.getRecord()!.status, "pending", bank);
  }
});

test("RPC-verified lookup tables compile real v0 account indices and are bound to finalized token evidence", async () => {
  const f = await fixture(); f.controls.goodLookup = true;
  const executor = createSolanaExecutor(f.options); const pending = await executor.execute(f.intent);
  assert.ok(pending.submission.loadedAddresses.writable.length > 0);
  assert.ok(pending.submission.loadedAddresses.readonly.length > 0);
  f.controls.finalized = true;
  assert.equal((await executor.reconcile(f.intent.owner, f.intent.requestId))?.status, "finalized");
  const raw = f.receipt(pending.submission);
  raw.meta.loadedAddresses.writable = raw.meta.loadedAddresses.writable.map((value, index) => index === 0 ? key(90) : value);
  assert.throws(() => settleSolanaReceipt(pending.submission, raw, { confirmationStatus: "finalized", slot: SLOT + 1, err: null }, NOW + 1));
});
test("a System-owned prefunded temporary ATA can initialize and its refund is distinct from actual transaction fees", async () => {
  const f = await fixture(); f.controls.tempDonation = true;
  const executor = createSolanaExecutor(f.options); await executor.execute(f.intent); f.controls.finalized = true;
  const settled = await executor.reconcile(f.intent.owner, f.intent.requestId);
  assert.equal(settled!.status, "finalized"); assert.equal(settled!.settlement!.feeLamports, "10000");
  assert.equal(settled!.settlement!.amountIn, "1000000");
});

test("an owner who closed or delegated their input ATA still trades when no donation waits (audit VAULT-2)", async () => {
  for (const mode of ["refundMissing", "refundDelegate", "badRefund"] as const) {
    const f = await fixture(); f.controls[mode] = true; const executor = createSolanaExecutor(f.options);
    const pending = await executor.execute(f.intent);
    assert.equal(pending.status, "pending", mode);
    assert.equal(refundSlot(pending.submission), PROGRAM, mode);
    assert.equal(f.calls.filter(call => call === "send").length, 1);
    f.controls.finalized = true;
    assert.equal((await executor.reconcile(f.intent.owner, f.intent.requestId))?.status, "finalized", mode);
  }
});

test("a donation in the temporary ATA passes the owner's ATA for its refund and never inflates the receipt", async () => {
  const f = await fixture(); f.controls.tempTokens = 7n; const executor = createSolanaExecutor(f.options);
  const pending = await executor.execute(f.intent);
  assert.equal(pending.status, "pending");
  assert.equal(refundSlot(pending.submission), f.ownerRefund);
  f.controls.finalized = true;
  const settled = await executor.reconcile(f.intent.owner, f.intent.requestId);
  assert.equal(settled?.status, "finalized");
  assert.equal(settled?.settlement?.amountIn, "1000000"); assert.equal(settled?.settlement?.feeLamports, "10000");
});

test("a donation with the owner's ATA closed, delegated or foreign fails closed with owner-refund before persistence or send", async () => {
  for (const mode of ["refundMissing", "refundDelegate", "badRefund"] as const) {
    const f = await fixture(); f.controls.tempTokens = 7n; f.controls[mode] = true;
    await assert.rejects(createSolanaExecutor(f.options).execute(f.intent), /refused: owner-refund/, mode);
    assert.ok(!f.calls.includes("persist"), mode); assert.ok(!f.calls.includes("send"), mode);
    assert.ok(!f.calls.includes("simulateTransaction"), mode);
  }
});

test("lamports sent to a sell's System-owned WSOL temporary address are the donation they become: the owner's WSOL account is passed, or the exit is refused as owner-refund and status names it", async () => {
  const RESERVE = 2_039_280n, swap = await deriveSolanaSwapAuthority(PROGRAM, key(70), 0n), owner = key(20);
  const ownerWsol = (problem: "ok" | "missing" | "delegated") => {
    if (problem === "missing") return null;
    const bytes = token(SOLANA_WRAPPED_SOL_MINT, owner, 0n);
    if (problem === "delegated") { bytes.writeUInt32LE(1, 72); keyBytes(key(91)).copy(bytes, 76); }
    return rpcAccount(bytes, SOLANA_CLASSIC_TOKEN_PROGRAM);
  };
  const prefunded = (lamports: bigint) => rpcAccount(Buffer.alloc(0), SYSTEM, false, Number(lamports));
  // rent + 1,234 lamports: the swap's init_if_needed opens a native account holding 1,234 WSOL there.
  const open = solanaPendingRefund(prefunded(RESERVE + 1234n), ownerWsol("ok"), SOLANA_WRAPPED_SOL_MINT, swap, owner, SOLANA_CLASSIC_TOKEN_PROGRAM, RESERVE);
  assert.deepEqual(open, { donation: 1234n, ownerAccountUsable: true, ownerAccountProblem: null });
  const closed = solanaPendingRefund(prefunded(RESERVE + 1234n), ownerWsol("missing"), SOLANA_WRAPPED_SOL_MINT, swap, owner, SOLANA_CLASSIC_TOKEN_PROGRAM, RESERVE);
  assert.deepEqual(closed, { donation: 1234n, ownerAccountUsable: false, ownerAccountProblem: "missing" });
  // Up to the reserve the lamports only pay rent; USDG is never native, so its temporary address holds lamports only.
  assert.equal(solanaPendingRefund(prefunded(RESERVE), ownerWsol("ok"), SOLANA_WRAPPED_SOL_MINT, swap, owner, SOLANA_CLASSIC_TOKEN_PROGRAM, RESERVE).donation, 0n);
  assert.equal(solanaPendingRefund(prefunded(RESERVE + 1234n), null, SOLANA_USDG_MINT, swap, owner, TOKEN_2022_PROGRAM, RESERVE).donation, 0n);
  // A WSOL reading without the reserve cannot decide, so it refuses rather than call it nothing.
  assert.throws(() => solanaPendingRefund(prefunded(RESERVE + 1234n), ownerWsol("ok"), SOLANA_WRAPPED_SOL_MINT, swap, owner, SOLANA_CLASSIC_TOKEN_PROGRAM));

  // Status: the same reading, with the owner's WSOL account closed or delegated, is an owner-refund blocker for exits.
  const vault = key(70);
  for (const [problem, blocks] of [["ok", []], ["missing", [{ mint: SOLANA_WRAPPED_SOL_MINT, problem: "missing" }]],
    ["delegated", [{ mint: SOLANA_WRAPPED_SOL_MINT, problem: "delegated" }]]] as const) {
    const wsolTemp = await deriveSolanaAta(swap, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
    const ownerAta = await deriveSolanaAta(owner, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
    const reads: string[] = [];
    const rpc: SolanaLiveRpc = { read: operation => operation(async (method, params = []) => {
      reads.push(method);
      if (method === "getMinimumBalanceForRentExemption") { assert.equal(params[0], 165); return Number(RESERVE); }
      assert.equal(method, "getMultipleAccounts");
      return { context: { slot: SLOT }, value: (params[0] as string[]).map(k => k === wsolTemp ? prefunded(RESERVE + 1234n) : k === ownerAta ? ownerWsol(problem) : null) };
    }), readEach: async () => { throw new Error("unused"); }, send: async () => { throw new Error("unused"); } };
    assert.deepEqual(await readSolanaOwnerRefundBlocks(rpc, PROGRAM, vault, owner, 0n, SLOT), blocks, problem);
    assert.ok(reads.includes("getMinimumBalanceForRentExemption"), problem);
  }
});

test("a sell that refunded a System-prefunded WSOL temporary address's donation to the owner settles: only the reserve came back to the fee payer", async () => {
  const f = await fixture(); const pending = await createSolanaExecutor(f.options).execute(f.intent);
  const RESERVE = 2_039_280, DONATED = 1234;
  // The buy fixture's bytes, read as the sell they would be: WSOL in from the vault's WSOL account, USDG out.
  const sell: SolanaSignedSubmission = { ...pending.submission, intent: { ...pending.submission.intent, inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT },
    inputTokenAccount: f.output, outputTokenAccount: f.input, inputTokenProgram: SOLANA_CLASSIC_TOKEN_PROGRAM, outputTokenProgram: TOKEN_2022_PROGRAM,
    minOutAmount: "1", rentLamports: String(RESERVE) };
  const raw = f.receipt(pending.submission) as Omit<ReturnType<typeof f.receipt>, "meta"> & { meta: Omit<ReturnType<typeof f.receipt>["meta"], "preBalances" | "postBalances"> & { preBalances: number[]; postBalances: number[] } };
  const tx = getTransactionDecoder().decode(Buffer.from(sell.signedTransactionBase64, "base64"));
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const keys = [...message.staticAccounts, ...sell.loadedAddresses.writable, ...sell.loadedAddresses.readonly];
  const tempIndex = keys.indexOf(f.temp);
  raw.meta.preBalances[tempIndex] = RESERVE + DONATED; raw.meta.postBalances[tempIndex] = 0;
  // The fee payer paid the fee and got the reserve back when the vault closed the temporary account.
  raw.meta.postBalances[0] = raw.meta.preBalances[0]! - 10_000 + RESERVE;
  const row = (account: string, mint: string, programId: string, amount: bigint) => ({ accountIndex: keys.indexOf(account), mint, owner: f.intent.vault, programId,
    uiTokenAmount: { amount: amount.toString(), decimals: mint === SOLANA_USDG_MINT ? 6 : 9 } });
  raw.meta.preTokenBalances = [row(f.output, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM, 2_000_000n), row(f.input, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, CASH)];
  raw.meta.postTokenBalances = [row(f.output, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM, 1_000_000n), row(f.input, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, CASH + 500_000n)];
  raw.meta.logMessages = [`Program ${PROGRAM} invoke [1]`, `Program data: ${event(sell, 1_000_000n, 500_000n)}`, `Program ${PROGRAM} success`];
  const status = { confirmationStatus: "finalized", slot: SLOT + 1, err: null };
  const settled = settleSolanaReceipt(sell, raw, status, NOW + 1);
  assert.equal(settled.status, "finalized"); assert.equal(settled.amountIn, "1000000"); assert.equal(settled.amountOut, "500000"); assert.equal(settled.feeLamports, "10000");
  // Booking the whole pre-balance as refunded to the fee payer would not balance.
  raw.meta.postBalances[0] = raw.meta.preBalances[0]! - 10_000 + RESERVE + DONATED;
  assert.throws(() => settleSolanaReceipt(sell, raw, status, NOW + 1));
});

test("the exact message to be signed is simulated on every provider: one provider's passing simulation cannot vouch for a route alone", async () => {
  const sims = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(call => call === "simulateTransaction").length;
  // The primary's simulation passes; the honest fallback's shows the swap failing, or delivering less than the signed minimum.
  const failing = (f: Awaited<ReturnType<typeof fixture>>) => provider(f, { simulateTransaction: () => ({ context: { slot: SLOT }, value: { err: { InstructionError: [2, { Custom: 6005 }] },
    unitsConsumed: 200_000, accounts: null } }) });
  const short = (f: Awaited<ReturnType<typeof fixture>>) => provider(f, { simulateTransaction: async params => {
    const answer = await f.read("simulateTransaction", params) as { context: unknown; value: { accounts: Array<{ data: [string, string] }> } };
    const data = Buffer.from(answer.value.accounts[2]!.data[0], "base64"); data.writeBigUInt64LE(1_979_999n, 64);
    answer.value.accounts[2] = { ...answer.value.accounts[2]!, data: [data.toString("base64"), "base64"] };
    return answer;
  } });
  for (const [name, fallback] of [["failing", failing], ["below the minimum", short]] as const) {
    const f = await fixture(); f.controls.fallback = fallback(f);
    await assert.rejects(createSolanaExecutor(f.options).execute(f.intent), /refused: simulation/, name);
    assert.ok(!f.calls.includes("persist") && !f.calls.includes("send"), name);
    assert.equal(f.getRecord(), null, name);
  }
  // A fallback a slot behind the blockhash's bank is asked again briefly, at that bank; then the trade goes on, signed once.
  const f = await fixture(); let behind = 2; const asked: unknown[] = [];
  // The blockhash, and both providers' simulations, come from a bank three slots past the prepared slot.
  const ahead = (read: SolanaLiveRead): SolanaLiveRead => async (method, params = []) => {
    const answer = await read(method, params);
    return method === "getLatestBlockhash" || method === "simulateTransaction" ? { ...(answer as object), context: { slot: SLOT + 3 } } : answer;
  };
  const lagging: SolanaLiveRead = async (method, params = []) => {
    if (method === "simulateTransaction") {
      asked.push((params[1] as { minContextSlot: number }).minContextSlot);
      if (behind-- > 0) throw new SolanaRpcError("rpc");
    }
    return ahead(f.read)(method, params);
  };
  f.options.rpc = { ...f.options.rpc, read: operation => operation(ahead(f.read)), readEach: async operation => [await operation(ahead(f.read)), await operation(lagging)] };
  const pending = await createSolanaExecutor(f.options).execute(f.intent);
  assert.equal(pending.status, "pending");
  assert.deepEqual(asked, [SLOT + 3, SLOT + 3, SLOT + 3], "at or after the bank the blockhash came from, and asked again while behind");
  assert.equal(sims(f), 3, "the primary's estimate, its own recheck and the fallback's answer");
  assert.equal(f.calls.filter(call => call === "send").length, 1);
});

test("refuses unsafe authority, mutation, simulation, fees, stale safety and risk evidence before persistence or send", async () => {
  for (const mode of ["upgradeable", "paused", "simulationError", "riskWrongBalance", "mintReason", "substituteCpi", "badLookup", "stateEpochAfter"] as const) {
    const f = await fixture(); f.controls[mode] = true;
    await assert.rejects(createSolanaExecutor(f.options).execute(f.intent));
    assert.ok(!f.calls.includes("persist"), mode); assert.ok(!f.calls.includes("send"), mode);
  }
  for (const change of [(f: Awaited<ReturnType<typeof fixture>>) => { f.controls.fee = 2_000_000; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.controls.riskDelay = 30_000; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.options.programBinarySha256 = "0".repeat(64); },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.options.feePayerKeyPair = f.options.sessionKeyPair; }]) {
    const f = await fixture(); change(f); await assert.rejects(createSolanaExecutor(f.options).execute(f.intent));
    assert.ok(!f.calls.includes("persist")); assert.ok(!f.calls.includes("send"));
  }
});

test("a build quote that went stale before signing is the provider's 'preview again shortly', never the owner's 400 with validator text", async () => {
  // The risk check (RPC, the SOL mark, Pyth) took long enough for the 30 s quote to expire.
  for (const delay of [30_000, 45_000]) {
    const f = await fixture(); f.controls.riskDelay = delay;
    await assert.rejects(createSolanaExecutor(f.options).execute(f.intent), (error: unknown) => error instanceof SolanaLiveMarketError && error.code === "provider", String(delay));
    assert.ok(!f.calls.includes("persist")); assert.ok(!f.calls.includes("send"));
  }
});

test("a build quote below the independent price floor is never signed, persisted or sent", async () => {
  // At $250/SOL, 1 USDG should buy 0.004 SOL; the route guarantees 0.00198, about half.
  for (const change of [(f: Awaited<ReturnType<typeof fixture>>) => { f.controls.referencePrice = 25_000_000_000n; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.controls.forgeFloor = true; },
    (f: Awaited<ReturnType<typeof fixture>>) => { f.controls.referenceAgeMs = 121_000; }]) {
    const f = await fixture(); change(f);
    await assert.rejects(createSolanaExecutor(f.options).execute(f.intent), /refused: risk/);
    assert.ok(!f.calls.includes("persist")); assert.ok(!f.calls.includes("send"));
  }
  // Within the 3% tolerance of a $510 reference the same route is still admitted.
  const f = await fixture(); f.controls.referencePrice = 51_000_000_000n;
  assert.equal((await createSolanaExecutor(f.options).execute(f.intent)).status, "pending");
  // 1 USDG is 0.001960784 SOL at $510; 97% of that is the floor the route clears.
  assert.equal(f.getRecord()!.submission.risk.reference.minOutFloor, "1901960");
});
test("durability failure or atomic sequence conflict prevents submission", async () => {
  for (const mode of ["persistError", "conflict"] as const) {
    const f = await fixture(); f.controls[mode] = true;
    await assert.rejects(createSolanaExecutor(f.options).execute(f.intent));
    assert.ok(!f.calls.includes("send"));
  }
});
test("shutdown before work or during risk prevents admission; shutdown during commit preserves signed bytes without sending", async () => {
  for (const phase of ["before", "risk", "commit", "genesis"] as const) {
    const f = await fixture(), controller = new AbortController(); f.options.signal = controller.signal;
    const network: string[] = [];
    if (phase === "before") controller.abort("private abort reason");
    if (phase === "risk") {
      const assess = f.options.assessRisk;
      f.options.assessRisk = async input => { const result = await assess(input); controller.abort(); return result; };
    }
    if (phase === "commit") {
      const commit = f.options.journal.recordSigned;
      f.options.journal.recordSigned = async submission => { const result = await commit(submission); controller.abort(); return result; };
    }
    if (phase === "genesis") {
      const transport = createSolanaLiveRpc({ env: { MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example/",
        MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: "https://fallback.example/" }, fetch: async (_url, init) => {
        const body = JSON.parse(init!.body as string); network.push(body.method);
        assert.equal(body.method, "getGenesisHash"); controller.abort();
        assert.equal(init!.signal!.aborted, true);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: SOLANA_MAINNET_GENESIS_HASH });
      } });
      f.options.rpc = { ...f.options.rpc, send: transport.send };
    }
    const executor = createSolanaExecutor(f.options);
    if (phase === "before" || phase === "risk") {
      await assert.rejects(executor.execute(f.intent), /cancelled/);
      assert.equal(f.getRecord(), null); assert.ok(!f.calls.includes("persist"));
      if (phase === "before") assert.equal(f.calls.length, 0);
    } else {
      const result = await executor.execute(f.intent);
      assert.equal(result.status, "pending"); assert.equal(f.getRecord()!.submission.signature, result.submission.signature);
      assert.ok(result.submission.signedTransactionBase64.length > 0);
    }
    assert.ok(!f.calls.includes("send")); assert.ok(!network.includes("sendTransaction"));
  }
});

test("same request cannot be rebound to another amount and paper is never accepted by live executor", async () => {
  const f = await fixture(); const executor = createSolanaExecutor(f.options);
  await assert.rejects(executor.execute({ ...f.intent, mode: "paper" }));
  await executor.execute(f.intent);
  await assert.rejects(executor.execute({ ...f.intent, amountRaw: "2" }));
  assert.equal(f.calls.filter(call => call === "send").length, 1);
});

test("settlement refuses forged events, wrong bytes, token deltas and nonfinalized evidence", async () => {
  const f = await fixture(); const pending = await createSolanaExecutor(f.options).execute(f.intent);
  const status = { confirmationStatus: "finalized", slot: SLOT + 1, err: null };
  for (const change of [
    (r: ReturnType<typeof f.receipt>) => { r.transaction[0] = "forged"; },
    (r: ReturnType<typeof f.receipt>) => { r.meta.postTokenBalances[1]!.uiTokenAmount.amount = "1"; },
    (r: ReturnType<typeof f.receipt>) => { r.meta.logMessages![1] = `Program data: ${event(pending.submission, 1n, 2n)}`; },
    (r: ReturnType<typeof f.receipt>) => { r.meta.logMessages = [`Program ${JUPITER_SWAP_PROGRAM} invoke [1]`, `Program data: ${event(pending.submission)}`, `Program ${JUPITER_SWAP_PROGRAM} success`]; },
    (r: ReturnType<typeof f.receipt>) => { r.meta.postBalances[0]!--; },
    (r: ReturnType<typeof f.receipt>) => { r.meta.preTokenBalances[0]!.owner = key(90); },
  ]) {
    const raw = f.receipt(pending.submission); change(raw);
    assert.throws(() => settleSolanaReceipt(pending.submission, raw, status, NOW + 1));
  }
  assert.throws(() => settleSolanaReceipt(pending.submission, f.receipt(pending.submission), { ...status, confirmationStatus: "confirmed" }, NOW + 1));
  const failed = f.receipt(pending.submission, true);
  assert.equal(settleSolanaReceipt(pending.submission, failed, { ...status, err: failed.meta.err }, NOW + 1).status, "failed");
  for (const err of [undefined, false, 0, {}, [], "invented-error", { InstructionError: [256, { Custom: 1 }] },
    { InstructionError: [2, { Custom: -1 }] }, { InstructionError: [2, {}] }, { DuplicateInstruction: "2" },
    { InsufficientFundsForRent: { account_index: 0, extra: true } }]) {
    const malformed = { ...failed, meta: { ...failed.meta, err } };
    assert.throws(() => settleSolanaReceipt(pending.submission, malformed, { ...status, err }, NOW + 1));
  }
  for (const err of ["InsufficientFundsForFee", { InstructionError: [2, "InvalidArgument"] },
    { DuplicateInstruction: 2 }, { InsufficientFundsForRent: { account_index: 0 } }]) {
    const recognized = { ...failed, meta: { ...failed.meta, err } };
    assert.equal(settleSolanaReceipt(pending.submission, recognized, { ...status, err }, NOW + 1).status, "failed");
  }
  assert.throws(() => settleSolanaReceipt(pending.submission, failed, { confirmationStatus: "finalized", slot: SLOT + 1 }, NOW + 1));
  assert.throws(() => solanaVaultEvents([`Program ${PROGRAM} invoke [1]`, "Log truncated"], PROGRAM));
});

/** A second provider's view of the fixture, with selected reads replaced. */
function provider(f: Awaited<ReturnType<typeof fixture>>, overrides: Partial<Record<string, (params: readonly unknown[]) => unknown>>): SolanaLiveRead {
  return async (method, params = []) => overrides[method] ? overrides[method]!(params) : f.read(method, params);
}

test("a fill is booked only when both providers return the same finalized receipt (audit G3-1)", async () => {
  // The primary withholds nothing but forges; the honest fallback has never seen the signature.
  const f = await fixture(); const executor = createSolanaExecutor(f.options);
  const pending = await executor.execute(f.intent); f.controls.finalized = true;
  f.controls.fallback = provider(f, { getSignatureStatuses: () => ({ context: { slot: SLOT }, value: [null] }), getTransaction: () => null,
    getEpochInfo: () => ({ absoluteSlot: SLOT + 2, blockHeight: 1199 }),
    getAccountInfo: () => ({ context: { slot: SLOT + 2 }, value: rpcAccount(state(f.intent.owner, f.session, 0n), PROGRAM) }) });
  assert.equal((await executor.reconcile(f.intent.owner, f.intent.requestId))?.status, "pending");
  assert.equal(f.getRecord()!.status, "pending");
  // Both providers return internally consistent receipts with different fills.
  f.controls.fallback = provider(f, { getTransaction: () => f.receipt(pending.submission, false, 2_500_000n) });
  assert.equal((await executor.reconcile(f.intent.owner, f.intent.requestId))?.status, "pending");
  // A provider that cannot answer leaves it pending too.
  f.controls.fallback = provider(f, { getTransaction: () => { throw new Error("provider down"); } });
  await assert.rejects(executor.reconcile(f.intent.owner, f.intent.requestId));
  assert.equal(f.getRecord()!.status, "pending");
  // A transport with only one provider can never book.
  const single = { ...f.options.rpc }; delete single.readEach;
  await assert.rejects(reconcileSolanaSubmission(single, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1), /two independent RPC providers/);
  assert.equal(f.getRecord()!.status, "pending");
  f.controls.fallback = null;
  const settled = await executor.reconcile(f.intent.owner, f.intent.requestId);
  assert.equal(settled?.status, "finalized"); assert.equal(settled?.settlement?.amountOut, "2000000");
});

test("an expiry is booked only when both providers prove it; their heights may differ (audit G3-1)", async () => {
  const proof = (blockHeight: number) => ({ getSignatureStatuses: () => ({ context: { slot: SLOT }, value: [null] }), getTransaction: () => null,
    getEpochInfo: () => ({ absoluteSlot: SLOT + 2, blockHeight }) });
  for (const [primary, fallback, expected] of [[1201, 1199, "pending"], [1201, 1300, "expired"]] as const) {
    const f = await fixture(); f.controls.failSend = true; const executor = createSolanaExecutor(f.options);
    await executor.execute(f.intent);
    const view = (height: number, seq = 0n) => provider(f, { ...proof(height),
      getAccountInfo: () => ({ context: { slot: SLOT + 2 }, value: rpcAccount(state(f.intent.owner, f.session, seq), PROGRAM) }) });
    const rpc: SolanaLiveRpc = { read: callback => callback(view(primary)), readEach: async callback => [await callback(view(primary)), await callback(view(fallback))],
      send: async wire => wire };
    const result = await reconcileSolanaSubmission(rpc, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1);
    assert.equal(result!.status, expected);
    if (result!.settlement?.status === "expired") assert.equal(result!.settlement.expiryProof.blockHeight, "1201");
  }
  // The fallback saw the sequence move: the swap may have landed.
  const f = await fixture(); f.controls.failSend = true; const executor = createSolanaExecutor(f.options);
  await executor.execute(f.intent);
  const view = (seq: bigint) => provider(f, { ...proof(1201),
    getAccountInfo: () => ({ context: { slot: SLOT + 2 }, value: rpcAccount(state(f.intent.owner, f.session, seq), PROGRAM) }) });
  const rpc: SolanaLiveRpc = { read: callback => callback(view(0n)), readEach: async callback => [await callback(view(0n)), await callback(view(1n))], send: async wire => wire };
  assert.equal((await reconcileSolanaSubmission(rpc, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1))!.status, "pending");
});

test("an expiry both providers prove books the lower of their finalized slots, never one provider's own (audit live-M3)", async () => {
  for (const [primarySlot, fallbackSlot] of [[SLOT + 1_000_000_000, SLOT + 2], [SLOT + 2, SLOT + 1_000_000_000]] as const) {
    const f = await fixture(); f.controls.failSend = true; const executor = createSolanaExecutor(f.options);
    await executor.execute(f.intent);
    const view = (slot: number) => provider(f, { getSignatureStatuses: () => ({ context: { slot: SLOT }, value: [null] }), getTransaction: () => null,
      getEpochInfo: () => ({ absoluteSlot: SLOT + 2, blockHeight: 1201 }),
      getAccountInfo: () => ({ context: { slot }, value: rpcAccount(state(f.intent.owner, f.session, 0n), PROGRAM) }) });
    const rpc: SolanaLiveRpc = { read: callback => callback(view(primarySlot)), readEach: async callback => [await callback(view(primarySlot)), await callback(view(fallbackSlot))],
      send: async wire => wire };
    const result = await reconcileSolanaSubmission(rpc, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1);
    assert.equal(result!.status, "expired"); assert.equal(result!.settlement!.slot, SLOT + 2);
    assert.equal(f.getRecord()!.settlement!.slot, SLOT + 2);
  }
  // A fill or failure is booked only when every field, its slot included, agrees.
  assert.throws(() => solanaAgreedSettlement([]));
});

test("the lowest-slot rule for readings of several providers: honest skew books the lower slot; a slot far past another provider's fresh one is refused", () => {
  assert.equal(solanaQuorumSlot([{ slot: 1000, fresh: 1000 }, { slot: 1000 + SOLANA_PROVIDER_SLOT_SKEW, fresh: 1000 + SOLANA_PROVIDER_SLOT_SKEW }]), 1000);
  assert.equal(solanaQuorumSlot([{ slot: 1100, fresh: 1100 }, { slot: 1000, fresh: 1000 }]), 1000);
  assert.throws(() => solanaQuorumSlot([{ slot: 1000, fresh: 1000 }, { slot: 1001 + SOLANA_PROVIDER_SLOT_SKEW, fresh: 1001 + SOLANA_PROVIDER_SLOT_SKEW }]), SolanaExecutionError);
  // A provider whose own fresh slot is far below its answer refuses too: it answered from a bank it says it has not reached.
  assert.throws(() => solanaQuorumSlot([{ slot: 1_000_000, fresh: 1000 }, { slot: 1000, fresh: 1000 }]), SolanaExecutionError);
  for (const bad of [[], [{ slot: 0 }], [{ slot: 1.5 }], [{ slot: 1000, fresh: -1 }]]) assert.throws(() => solanaQuorumSlot(bad), SolanaExecutionError, JSON.stringify(bad));
});

test("the vault program must verify as immutable and audited on both providers before anything is signed (audit G3-5)", async () => {
  for (const lie of ["upgradeable", "substituted"] as const) {
    const f = await fixture();
    f.controls.fallback = provider(f, { getAccountInfo: params => {
      const [address, config] = params as [string, { dataSlice: { offset: number; length: number } }];
      if (address !== f.programDataAddress) return f.read("getAccountInfo", params);
      const bytes = Buffer.from(f.programData); if (lie === "upgradeable") bytes[12] = 1; else bytes[bytes.length - 1]! ^= 1;
      return { context: { slot: SLOT }, value: { ...rpcAccount(bytes.subarray(config.dataSlice.offset, config.dataSlice.offset + config.dataSlice.length), LOADER), space: bytes.length } };
    } });
    await assert.rejects(verifySolanaVaultDeployment(f.options.rpc, PROGRAM, f.options.programBinarySha256), /unsafe-program/, lie);
    await assert.rejects(createSolanaExecutor(f.options).execute(f.intent), /unsafe-program/, lie);
    assert.ok(!f.calls.includes("persist") && !f.calls.includes("send"), lie);
  }
});

test("a binary that hashes right but is built for another program id is never signed for (audit GAP4-3, executor half)", async () => {
  // Immutable and hash-matching, but its declare_id is another program's.
  const other = await fixture({ binary: Buffer.concat([Buffer.from("audited-vault-test-binary"), keyBytes(key(99))]) });
  const verdict = await verifySolanaVaultDeployment(other.options.rpc, PROGRAM, other.options.programBinarySha256);
  assert.equal(verdict.declaresProgramId, false, "without the requirement the check only reports it");
  await assert.rejects(verifySolanaVaultDeployment(other.options.rpc, PROGRAM, other.options.programBinarySha256, { requireDeclaredProgramId: true }), /unsafe-program/);
  await assert.rejects(createSolanaExecutor(other.options).execute(other.intent), /unsafe-program/);
  assert.ok(!other.calls.includes("persist") && !other.calls.includes("send"));
  // The id's bytes split across two ProgramData slices (98,304 bytes each) are still found.
  for (const at of [98_304 - 1, 98_304 - 16, 98_304 - 31, 98_304, 2 * 98_304 - 5]) {
    const binary = Buffer.alloc(2 * 98_304 + 64, 7); keyBytes(PROGRAM).copy(binary, at);
    const split = await fixture({ binary });
    assert.equal((await verifySolanaVaultDeployment(split.options.rpc, PROGRAM, split.options.programBinarySha256, { requireDeclaredProgramId: true })).declaresProgramId, true, String(at));
  }
  // Bytes outside the hashed region (the 45-byte ProgramData header) do not count.
  const absent = Buffer.alloc(2 * 98_304 + 64, 7); keyBytes(PROGRAM).subarray(1).copy(absent, 98_304 - 15);
  const near = await fixture({ binary: absent });
  assert.equal((await verifySolanaVaultDeployment(near.options.rpc, PROGRAM, near.options.programBinarySha256)).declaresProgramId, false, "31 of 32 bytes is not the id");
  const good = await fixture();
  assert.equal((await createSolanaExecutor(good.options).execute(good.intent)).status, "pending");
});

test("a verified immutable deployment is cached per provider pair; failures are not", async () => {
  const f = await fixture(); let slices = 0;
  const counting: SolanaLiveRead = async (method, params = []) => {
    if (method === "getAccountInfo" && (params[0] === PROGRAM || params[0] === f.programDataAddress)) slices++;
    return f.read(method, params);
  };
  const rpc: SolanaLiveRpc = { providerKey: `cache-test-${Math.random()}`, read: callback => callback(counting),
    readEach: async callback => [await callback(counting), await callback(counting)], send: async wire => wire };
  await assert.rejects(verifySolanaVaultDeployment(rpc, PROGRAM, "0".repeat(64)), /unsafe-program/);
  const failed = slices;
  await assert.rejects(verifySolanaVaultDeployment(rpc, PROGRAM, "0".repeat(64)), /unsafe-program/);
  assert.equal(slices, failed * 2, "a failure is checked again");
  slices = 0;
  assert.deepEqual(await verifySolanaVaultDeployment(rpc, PROGRAM, f.options.programBinarySha256), { slot: SLOT, declaresProgramId: true });
  const verified = slices; assert.ok(verified >= 4, "both providers read the program and its data");
  assert.deepEqual(await verifySolanaVaultDeployment(rpc, PROGRAM, f.options.programBinarySha256), { slot: SLOT, declaresProgramId: true });
  assert.equal(slices, verified, "the second check is served from the cache");
});

test("a finalized swap whose logs were truncated or not recorded settles from its token deltas and the vault's finalized sequence (audit execution F2)", async () => {
  const truncated = [`Program ${PROGRAM} invoke [1]`, `Program ${TOKEN_2022_PROGRAM} invoke [2]`, `Program ${TOKEN_2022_PROGRAM} success`,
    `Program ${JUPITER_SWAP_PROGRAM} invoke [2]`, "Program log: Instruction: SharedAccountsRoute", "Log truncated"];
  for (const logs of [truncated, null]) {
    const f = await fixture(); const executor = createSolanaExecutor(f.options);
    const pending = await executor.execute(f.intent); f.controls.finalized = true;
    const raw = f.receipt(pending.submission); raw.meta.logMessages = logs;
    const status = { confirmationStatus: "finalized", slot: SLOT + 1, err: null };
    const evidence = { address: f.intent.vault, slot: SLOT + 2, state: (await import("../../packages/core/src/solana-live")).decodeSolanaVaultAccount(state(f.intent.owner, f.session, 1n)) };
    // Without the vault's finalized sequence it stays unsettled, as before.
    assert.throws(() => settleSolanaReceipt(pending.submission, raw, status, NOW + 1));
    for (const bad of [{ ...evidence, slot: SLOT }, { ...evidence, address: key(90) },
      { ...evidence, state: { ...evidence.state, seq: 0n } }, { ...evidence, state: { ...evidence.state, owner: key(90) } }]) {
      assert.throws(() => settleSolanaReceipt(pending.submission, raw, status, NOW + 1, bad));
    }
    const settled = settleSolanaReceipt(pending.submission, raw, status, NOW + 1, evidence);
    assert.equal(settled.status, "finalized"); assert.equal(settled.amountIn, "1000000"); assert.equal(settled.amountOut, "2000000");
    // Token rows still bound the fill.
    const short = structuredClone(raw); short.meta.postTokenBalances[1]!.uiTokenAmount.amount = "1";
    assert.throws(() => settleSolanaReceipt(pending.submission, short, status, NOW + 1, evidence));
    // End to end: both providers serve the truncated receipt and the advanced vault.
    f.controls.fallback = provider(f, { getTransaction: () => raw });
    const through = { ...f.options.rpc, read: f.options.rpc.read, readEach: async <T,>(callback: (read: SolanaLiveRead) => Promise<T>) =>
      [await callback(provider(f, { getTransaction: () => raw })), await callback(f.controls.fallback!)] };
    const booked = await reconcileSolanaSubmission(through, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1);
    assert.equal(booked!.status, "finalized"); assert.equal(booked!.settlement!.amountOut, "2000000");
  }
  // The vault's sequence did not move: never booked.
  const f = await fixture(); const executor = createSolanaExecutor(f.options);
  const pending = await executor.execute(f.intent); f.controls.finalized = true; f.controls.vaultSeqAfter = 0n;
  const raw = f.receipt(pending.submission); raw.meta.logMessages = truncated;
  f.controls.fallback = provider(f, { getTransaction: () => raw });
  const through = { ...f.options.rpc, readEach: async <T,>(callback: (read: SolanaLiveRead) => Promise<T>) =>
    [await callback(f.controls.fallback!), await callback(f.controls.fallback!)] };
  await assert.rejects(reconcileSolanaSubmission(through, f.options.journal, f.intent.owner, f.intent.requestId, () => NOW + 1));
  assert.equal(f.getRecord()!.status, "pending");
});

test("truncated logs keep strict provenance: a failed receipt needs no logs, a visible event must still match", async () => {
  const f = await fixture(); const pending = await createSolanaExecutor(f.options).execute(f.intent);
  const status = { confirmationStatus: "finalized", slot: SLOT + 1, err: null };
  const evidence = { address: f.intent.vault, slot: SLOT + 2, state: (await import("../../packages/core/src/solana-live")).decodeSolanaVaultAccount(state(f.intent.owner, f.session, 1n)) };
  const failed = f.receipt(pending.submission, true);
  for (const logs of [[`Program ${PROGRAM} invoke [1]`, "Log truncated"], null]) {
    failed.meta.logMessages = logs;
    assert.equal(settleSolanaReceipt(pending.submission, failed, { ...status, err: failed.meta.err }, NOW + 1).status, "failed");
  }
  const raw = f.receipt(pending.submission);
  // A forged event before the cut still disagrees with the token rows.
  raw.meta.logMessages = [`Program ${PROGRAM} invoke [1]`, `Program data: ${event(pending.submission, 1_000_000n, 3_000_000n)}`, "Log truncated"];
  assert.throws(() => settleSolanaReceipt(pending.submission, raw, status, NOW + 1, evidence));
  // The marker only ever ends a log.
  raw.meta.logMessages = [`Program ${PROGRAM} invoke [1]`, "Log truncated", `Program ${PROGRAM} success`];
  assert.throws(() => settleSolanaReceipt(pending.submission, raw, status, NOW + 1, evidence));
  // Complete logs still need exactly one matching event, evidence or not.
  raw.meta.logMessages = [`Program ${PROGRAM} invoke [1]`, `Program ${PROGRAM} success`];
  assert.throws(() => settleSolanaReceipt(pending.submission, raw, status, NOW + 1, evidence));
});

/** The compute-unit limit and price the signed swap carries. */
function computeBudget(submission: SolanaSignedSubmission): { units: number; price: bigint } {
  const tx = getTransactionDecoder().decode(Buffer.from(submission.signedTransactionBase64, "base64"));
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const [limit, price] = compiled.instructions.slice(0, 2).map(ix => Buffer.from(ix.data!));
  assert.equal(compiled.staticAccounts[compiled.instructions[0]!.programAddressIndex], "ComputeBudget111111111111111111111111111111");
  assert.equal(limit![0], 2); assert.equal(price![0], 3);
  return { units: limit!.readUInt32LE(1), price: price!.readBigUInt64LE(1) };
}

test("swaps pay a bounded priority fee from recent fees on the accounts they write (audit G2-1)", async () => {
  const cases: Array<{ fees: number[]; min?: string; max?: string; maxFee?: string; error?: boolean; price: bigint }> = [
    { fees: [], price: 0n },
    { fees: [0, 5_000, 100, 200], price: 200n }, // 75th percentile, nearest rank
    { fees: [10 ** 12], price: 1_000_000n }, // the default maximum
    { fees: [10 ** 12], max: "40000", price: 40_000n },
    { fees: [], min: "50", price: 50n },
    { fees: [10], error: true, min: "7", price: 7n }, // an unanswered estimate pays the minimum
    // 2,100,000 lamports leaves 50,720 after rent and signatures: 211,333 per unit at 240,000 units.
    { fees: [10 ** 12], maxFee: "2100000", price: 211_333n },
  ];
  for (const item of cases) {
    const f = await fixture(); f.controls.priorityFees = item.fees; f.controls.priorityError = !!item.error;
    if (item.min) f.options.computeUnitPriceMicroLamports = item.min;
    if (item.max) f.options.maxComputeUnitPriceMicroLamports = item.max;
    if (item.maxFee) f.options.maxFeeLamports = item.maxFee;
    const pending = await createSolanaExecutor(f.options).execute(f.intent);
    const label = `fees=${item.fees} min=${item.min} max=${item.max} maxFee=${item.maxFee} error=${item.error}`;
    assert.deepEqual(computeBudget(pending.submission), { units: 240_000, price: item.price }, label);
    // The fixture's getFeeForMessage reports only the 10,000 signature fee; the
    // reservation still covers what the runtime will charge.
    assert.equal(pending.submission.feeLamports, (10_000n + (item.price * 240_000n + 999_999n) / 1_000_000n).toString(), label);
    assert.ok(BigInt(pending.submission.feeLamports) + BigInt(pending.submission.rentLamports) <= BigInt(pending.submission.maxFeeLamports));
    const accounts = f.priorityReads[0] as string[];
    for (const writable of [f.intent.vault, f.input, f.output, f.temp, f.feePayer, ...f.route.accounts.filter(meta => meta.isWritable).map(meta => meta.address)]) {
      assert.ok(accounts.includes(writable), writable);
    }
  }
  const f = await fixture();
  assert.throws(() => createSolanaExecutor({ ...f.options, computeUnitPriceMicroLamports: "2", maxComputeUnitPriceMicroLamports: "1" }), /fee-cap/);
  // A minimum the fee budget cannot carry is refused before anything is signed.
  const g = await fixture(); g.options.computeUnitPriceMicroLamports = "300000"; g.options.maxFeeLamports = "2100000";
  await assert.rejects(createSolanaExecutor(g.options).execute(g.intent), /fee-cap/);
  assert.ok(!g.calls.includes("persist"));
});

test("a minimum compute-unit price above the default maximum is not a construction refusal; an explicit maximum below it is", async () => {
  const f = await fixture();
  const executor = createSolanaExecutor({ ...f.options, computeUnitPriceMicroLamports: "2000000" });
  assert.equal((await executor.execute(f.intent)).status, "pending");
  assert.throws(() => createSolanaExecutor({ ...f.options, computeUnitPriceMicroLamports: "2000000", maxComputeUnitPriceMicroLamports: "1000000" }), /fee-cap/);
});

test("a fee payer that can fund a swap only at a lower priority price pays that price instead of refusing it (status gates exits on rent and signatures)", async () => {
  // What status() calls one swap's minimum for these fixture rents: the temporary account's rent and both signatures.
  const RENT = 2_039_280n, minimum = RENT + 10_000n;
  // Congestion: recent fees of 1,000,000 micro-lamports per CU would cost 240,000 lamports at 240,000 units.
  const cases: Array<{ payer: bigint; min?: string; price: bigint }> = [
    // 100,000 lamports above the minimum: 416,666 per unit is all it can fund.
    { payer: minimum + 100_000n, price: 416_666n },
    // Exactly the minimum: the swap still goes, with no priority fee.
    { payer: minimum, price: 0n },
    // Plenty: the recent price, as before.
    { payer: 100_000_000n, price: 1_000_000n },
    // A configured minimum the payer can carry: the clamp never goes below it.
    { payer: minimum + 100_000n, min: "400000", price: 416_666n },
  ];
  for (const item of cases) {
    const f = await fixture(); f.controls.priorityFees = [1_000_000]; f.controls.payerLamports = Number(item.payer);
    if (item.min) f.options.computeUnitPriceMicroLamports = item.min;
    const label = `payer=${item.payer} min=${item.min}`;
    const pending = await createSolanaExecutor(f.options).execute(f.intent);
    assert.deepEqual(computeBudget(pending.submission), { units: 240_000, price: item.price }, label);
    const fee = BigInt(pending.submission.feeLamports), rent = BigInt(pending.submission.rentLamports);
    assert.equal(rent, RENT, label);
    assert.ok(fee + rent <= item.payer, `${label}: the payer funds what it signs`);
    assert.ok(fee + rent <= BigInt(pending.submission.maxFeeLamports), label);
  }
  // Below the minimum, or a configured minimum price it cannot fund: refused before anything is signed.
  for (const item of [{ payer: minimum - 1n }, { payer: minimum + 100_000n, min: "500000" }]) {
    const f = await fixture(); f.controls.priorityFees = []; f.controls.payerLamports = Number(item.payer);
    if (item.min) f.options.computeUnitPriceMicroLamports = item.min;
    await assert.rejects(createSolanaExecutor(f.options).execute(f.intent), /fee-cap/, `payer=${item.payer} min=${item.min}`);
    assert.ok(!f.calls.includes("persist"));
  }
});

test("the owner's previewed minimum: a route guaranteeing less is refused before signing, and a recorded request is returned whatever floor a retry carries", async () => {
  // The fixture's route guarantees 1,980,000 (its quote's minOutAmount), which is what min_out signs.
  const f = await fixture(), executor = createSolanaExecutor(f.options);
  const priceMoved = (error: unknown) => error instanceof Error && /refused: price-moved\.$/.test(error.message);
  await assert.rejects(executor.execute(f.intent, { minOutAmount: "1980001" }), priceMoved);
  // The refusal carries what the fresh route guarantees, for the owner to review; its text stays fixed.
  await assert.rejects(executor.execute(f.intent, { minOutAmount: "1980001" }),
    (error: unknown) => error instanceof SolanaExecutionError && error.code === "price-moved" && error.freshMinOutAmount === "1980000");
  assert.equal(new SolanaExecutionError("risk", { freshMinOutAmount: "1" }).freshMinOutAmount, undefined, "only price-moved carries one");
  assert.equal(f.getRecord(), null);
  for (const step of ["simulateTransaction", "persist", "send"]) assert.ok(!f.calls.includes(step), `refused before ${step}`);
  // Nothing was recorded, so the same request id goes through after a new preview at (or below) the route's minimum.
  const placed = await executor.execute(f.intent, { minOutAmount: "1980000" });
  assert.equal(placed.status, "pending"); assert.equal(placed.submission.minOutAmount, "1980000");
  assert.equal(f.calls.filter(call => call === "send").length, 1);
  // The floor is not part of the request's identity: a retry with a higher, lower or no floor returns the recorded
  // trade and signs or sends nothing new, so an idempotent retry after a lost response stays idempotent.
  const count = f.calls.length;
  for (const admission of [{ minOutAmount: "999999999999" }, { minOutAmount: "1" }, { minOutAmount: null }, {}]) {
    assert.deepEqual(await executor.execute(f.intent, admission), placed, JSON.stringify(admission));
  }
  assert.equal(f.calls.length, count);
  // A floor that is not a positive whole number is an invalid request, recorded or not.
  for (const minOutAmount of ["0", "1.5", "-1", "01"]) {
    await assert.rejects(executor.execute(f.intent, { minOutAmount }), /refused: invalid-intent\./, minOutAmount);
    await assert.rejects(createSolanaExecutor((await fixture()).options).execute(f.intent, { minOutAmount }), /refused: invalid-intent\./, minOutAmount);
  }
  // Without a floor (the autonomous strategy) nothing changes.
  const plain = await fixture();
  assert.equal((await createSolanaExecutor(plain.options).execute(plain.intent)).status, "pending");
});
