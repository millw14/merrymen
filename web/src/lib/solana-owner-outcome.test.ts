/**
 * A RETRY OF SAVED OWNER BYTES IS ANSWERED FROM THE SERVER'S RECORD OF THEM.
 *
 * Through the real runtime and solanaResponse, the way the page sees it:
 * when the server has saved and broadcast an owner transaction, a later
 * failure to use Solana's answer about it, or to book its outcome, is an
 * unknown outcome (503) and never a 4xx the page could read as a refusal of
 * the bytes. A refusal before anything is saved stays a 4xx.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getBase58Decoder, getBase58Encoder,
  getBase64EncodedWireTransaction, getTransactionDecoder, signTransaction } from "@solana/kit";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../../packages/core/src/ids";
import { SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_VAULT_DISCRIMINATOR,
  SOLANA_VAULT_LOCAL_TEST_PROGRAM, SOLANA_WRAPPED_SOL_MINT, deriveSolanaAta, deriveSolanaVaultAddress } from "../../../packages/core/src/solana-live";
import { sealSecret } from "../../../worker/src/store-crypto";
import { SqlSolanaBindingStore } from "./solana-binding-store";
import { wrapSqlite } from "../../../worker/src/db";
import { createSolanaAppRuntime } from "../../../worker/src/solana-app-runtime";
import { PYTH_SOL_USD_ACCOUNT } from "../../../worker/src/solana-reference-price";
import { pythAccount } from "../../../worker/src/solana-reference-price-fixture";
import type { SolanaLiveRead, SolanaLiveRpc } from "../../../worker/src/solana-live-rpc";
import type { SolanaPaperMarket } from "../../../worker/src/solana-paper-service";
import { ensureSolanaTradingSchema, SolanaTradingStore } from "../../../worker/src/solana-trading-store";

const TENANT = "0x1111111111111111111111111111111111111111";
const PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM, LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const key = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
const keyBytes = (value: string) => Buffer.from(getBase58Encoder().encode(value));
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 10, maxDrawdownBps: 2000, expiresAtMs: 4_600_000,
  perTradeWsol: "100000000", dailyWsol: "500000000" };
function account(data: Buffer, owner = PROGRAM, executable = false) {
  return { owner, executable, lamports: 100_000_000, data: [data.toString("base64"), "base64"], space: data.length };
}
async function fixture() {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw), clock = { now: 1_000_000 };
  const ownerKeys = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(21));
  const sessionSeed = Buffer.alloc(32, 22), sessionKeys = await createKeyPairFromPrivateKeyBytes(sessionSeed);
  const owner = await getAddressFromPublicKey(ownerKeys.publicKey), session = await getAddressFromPublicKey(sessionKeys.publicKey);
  const scope = { tenant: TENANT, owner }, vault = await deriveSolanaVaultAddress(PROGRAM, owner);
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => clock.now);
  await bindings.bind(TENANT, "did:privy:owner", owner);
  await bindings.settings(TENANT, owner, 0, "paper", limits);
  const dataAddress = key(41), binary = Buffer.from("runtime-tested-binary"), program = Buffer.alloc(36), programData = Buffer.alloc(45 + binary.length);
  program.writeUInt32LE(2); keyBytes(dataAddress).copy(program, 4); programData.writeUInt32LE(3); binary.copy(programData, 45);
  const controls = { initialized: false, finalized: false, failed: false, malformed: false, sends: 0, signed: "", signature: "", failSend: true, height: 4900, sequence: 0n, epoch: 1n,
    cash: 0n, wsol: 0n, simulatedUnits: null as number | null, priorityFees: null as number[] | null };
  const cashAta = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), wsolAta = await deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  const tokenAccount = (mint: string, amount: bigint) => {
    const b = Buffer.alloc(165); keyBytes(mint).copy(b, 0); keyBytes(vault).copy(b, 32); b.writeBigUInt64LE(amount, 64); b[108] = 1; return b;
  };
  const state = () => {
    const b = Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE); Buffer.from(SOLANA_VAULT_DISCRIMINATOR).copy(b); let p = 8;
    b[p++] = 2; b[p++] = 255;
    for (const value of [owner, session]) { keyBytes(value).copy(b, p); p += 32; }
    for (const value of [controls.epoch, controls.sequence, BigInt(limits.expiresAtMs / 1000), BigInt(limits.perTradeUsdg), BigInt(limits.dailyUsdg),
      BigInt(limits.perTradeWsol), BigInt(limits.dailyWsol)]) { b.writeBigUInt64LE(value, p); p += 8; }
    b.writeUInt16LE(limits.maxOpsPerDay, p); return b;
  };
  const response = (value: unknown) => ({ context: { slot: 1000 }, value });
  const SYSTEM = "11111111111111111111111111111111";
  // What the runtime reads for an owner transaction: the vault and its token
  // accounts, the owner wallet that pays (a plain system account) and any account
  // the transaction opens (missing here, so its rent is counted).
  const accountFor = (k: unknown) => k === vault ? (controls.initialized ? account(state()) : null)
    : k === cashAta ? account(tokenAccount(SOLANA_USDG_MINT, controls.cash), TOKEN_2022_PROGRAM)
    : k === wsolAta ? account(tokenAccount(SOLANA_WRAPPED_SOL_MINT, controls.wsol), SOLANA_CLASSIC_TOKEN_PROGRAM)
    : k === owner ? account(Buffer.alloc(0), SYSTEM)
    // The USDG mint, with no transfer hook: a withdrawal reads it for one.
    : k === SOLANA_USDG_MINT ? account(Buffer.alloc(82), TOKEN_2022_PROGRAM)
    : null;
  const read: SolanaLiveRead = async (method, params = []) => {
    if (method === "getSlot") return 1000;
    // The owner expiry proof reads its finalized slot and height from one bank.
    if (method === "getEpochInfo") return { absoluteSlot: 1000, blockHeight: controls.height, epoch: 2, slotIndex: 1000, slotsInEpoch: 432_000 };
    if (method === "getMinimumBalanceForRentExemption") return (128 + (params[0] as number)) * 6960;
    if (method === "getAccountInfo") {
      if (params[0] === PROGRAM) return response(account(program, LOADER, true));
      if (params[0] === dataAddress) {
        const slice = (params[1] as { dataSlice: { offset: number; length: number } }).dataSlice;
        return response({ ...account(programData.subarray(slice.offset, slice.offset + slice.length), LOADER), space: programData.length });
      }
      // Pyth SOL/USD at $120, which a registration checks the SOL sold per trade against.
      if (params[0] === PYTH_SOL_USD_ACCOUNT) return response(pythAccount({ price: 12_000_000_000n, publishTimeMs: clock.now, postedSlot: 999n }));
      return response(accountFor(params[0]) ?? (params[0] === vault ? null : account(Buffer.alloc(0), SYSTEM)));
    }
    if (method === "getMultipleAccounts") return response((params[0] as string[]).map(accountFor));
    if (method === "getLatestBlockhash") return response({ blockhash: key(42), lastValidBlockHeight: 5000 });
    if (method === "getSignatureStatuses") return response([controls.finalized ? { confirmationStatus: "finalized", slot: 1000, ...(controls.malformed ? {} : { err: controls.failed ? { InstructionError: [0, "InvalidArgument"] } : null }) } : null]);
    if (method === "getTransaction") return controls.finalized ? { version: 0, slot: 1000, transaction: [controls.signed, "base64"], meta: controls.malformed ? {} : { err: controls.failed ? { InstructionError: [0, "InvalidArgument"] } : null } } : null;
    if (method === "simulateTransaction" && controls.simulatedUnits !== null) return response({ err: null, unitsConsumed: controls.simulatedUnits, logs: [], accounts: null });
    if (method === "getRecentPrioritizationFees" && controls.priorityFees) return controls.priorityFees.map((prioritizationFee, i) => ({ slot: 1000 - i, prioritizationFee }));
    throw new Error(`Unexpected test RPC ${method}`);
  };
  // Two independent providers that agree: owner outcomes are booked only on both.
  const rpc: SolanaLiveRpc = { read: fn => fn(read), readEach: async fn => [await fn(read), await fn(read)], send: async wire => {
    controls.sends++;
    const saved = await new SolanaTradingStore(db, scope, () => clock.now).setup();
    assert.equal(saved?.signedTransactionBase64, wire, "exact bytes committed before RPC send");
    controls.signed = wire; controls.signature = saved!.signature!;
    if (controls.failSend) throw new Error("lost send response");
    return controls.signature;
  } };
  const market: SolanaPaperMarket = {
    readMint: async mint => ({ address: mint, program: mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM,
      decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: 1000, observedAtMs: clock.now, buyBlockedReasons: [] }),
    quote: async intent => ({ source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: intent.amountRaw,
      outAmount: intent.amountRaw, minOutAmount: (BigInt(intent.amountRaw) * 995n / 1000n).toString(), slippageBps: intent.slippageBps,
      contextSlot: 1000, quotedAtMs: clock.now, expiresAtMs: clock.now + 30_000 }),
  };
  const env = { MERRYMEN_SOLANA_VAULT_PROGRAM: PROGRAM, MERRYMEN_SOLANA_VAULT_SHA256: createHash("sha256").update(binary).digest("hex"),
    MERRYMEN_STORE_DEK: Buffer.alloc(32, 30).toString("base64"), MERRYMEN_SOLANA_FEE_PAYER_SEED: Buffer.alloc(32, 31).toString("base64"), MERRYMEN_JUPITER_API_KEY: "fixture",
    // On the live list, with daily caps at the fixture's limits (50 USDG and 0.5 SOL; per trade the defaults).
    MERRYMEN_SOLANA_LIVE_TENANTS: TENANT, MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "50", MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: "0.5" };
  const app = createSolanaAppRuntime({ db, rpc, market, env, now: () => clock.now });
  const sign = async (wire: string) => getBase64EncodedWireTransaction(await signTransaction([ownerKeys], getTransactionDecoder().decode(Buffer.from(wire, "base64"))));
  const live = async () => { const binding = (await bindings.get(TENANT))!; await bindings.settings(TENANT, owner, binding.revision, "live", limits); };
  const trade = { kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "runtime-test", inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000", slippageBps: 50 };
  /** A registered session for the initialized vault, as activateLive leaves it. */
  const registered = async () => {
    await ensureSolanaTradingSchema(db);
    const record = { programId: PROGRAM, vault, session, sessionEpoch: controls.epoch.toString(), registrationSignature: key(43), registeredAtMs: clock.now };
    await db.prepare("INSERT INTO solana_runtime_sessions(tenant,owner,record_json,sealed_seed) VALUES(?,?,?,?)").run(TENANT, owner, JSON.stringify(record),
      sealSecret(`solana-session/v1 ${TENANT} ${owner} ${PROGRAM} ${vault} ${session} ${record.sessionEpoch}\n` + sessionSeed.toString("base64"), Buffer.alloc(32, 30)));
  };
  return { raw, db, clock, scope, owner, session, sessionSeed, controls, bindings, app, sign, live, trade, env, rpc, market, registered };
}


import { solanaResponse } from "./solana-api";
import { refusedByServer } from "../terminal/SolanaOwnerActions";
import { OWNER_DEFAULT_UNITS_PER_INSTRUCTION, OWNER_MAX_PRIORITY_FEE_LAMPORTS, permissionMatchesLimits, readPermissionTransaction } from "../terminal/SolanaPermission";
import { RequestError } from "../terminal/request-json";
import { SOLANA_OWNER_MAX_PRIORITY_FEE_LAMPORTS, solanaOwnerComputeUnitLimit } from "../../../worker/src/solana-app-runtime";
import { solanaComputeBudgetInstructions } from "../../../worker/src/solana-executor";
import { address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, decompileTransactionMessage,
  getCompiledTransactionMessageDecoder, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Blockhash, type Instruction } from "@solana/kit";

const flag = process.env.MERRYMEN_SOLANA;
test.before(() => { process.env.MERRYMEN_SOLANA = "1"; });
test.after(() => { if (flag === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = flag; });
/** What the page receives, and whether it would treat it as a refusal of the bytes. */
async function asPage(run: () => Promise<unknown>) {
  const response = await solanaResponse(run);
  const body = await response.json() as { error?: string };
  return { status: response.status, error: body.error, refusal: !response.ok && refusedByServer(new RequestError(body.error ?? "", response.status)) };
}
const UNKNOWN = /could not be confirmed or recorded yet\. Nothing new was sent/;

test("a saved and broadcast permission whose confirmation data is unusable is an unknown outcome on retry", async () => {
  const f = await fixture();
  try {
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    const first = await asPage(() => f.app.submitSetup(f.scope, { signedTransactionBase64 }));
    assert.equal(first.status, 200); assert.equal(f.controls.sends, 1, "saved and broadcast");
    // The page lost that answer and resubmits; the RPC's confirmation is malformed.
    f.controls.finalized = true; f.controls.malformed = true;
    const retry = await asPage(() => f.app.submitSetup(f.scope, { signedTransactionBase64 }));
    assert.equal(retry.status, 503); assert.match(retry.error!, UNKNOWN);
    assert.equal(retry.refusal, false, "never read as a refusal of the bytes");
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.status, "pending", "the server still holds the broadcast transaction");
    assert.equal(f.controls.sends, 1);
  } finally { f.raw.close(); }
});

/** A live account holding 90 USDG on its book and on chain, with a signed 1 USDG withdrawal saved and broadcast. */
async function savedWithdrawal(f: Awaited<ReturnType<typeof fixture>>) {
  await f.live(); f.controls.initialized = true; await f.registered();
  const book = { hwmRaw: "100000000", cashRaw: "90000000", wsolRaw: "0", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0",
    networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
  await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
  f.controls.cash = 90_000_000n;
  const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
  const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
  assert.equal((await asPage(() => f.app.submitOwnerAction(f.scope, { signedTransactionBase64 }))).status, 200);
  // It finalized at slot 1000, and the finalized vault shows its mark (a withdrawal always advances the sequence).
  f.controls.finalized = true; f.controls.sequence = 1n;
  const setBook = (changes: object) => f.db.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify({ ...book, ...changes }), TENANT, f.owner);
  return { book, signedTransactionBase64, setBook };
}

test("a finalized withdrawal the book cannot record yet is an unknown outcome on retry, not a refusal", async () => {
  const f = await fixture();
  try {
    const { signedTransactionBase64, setBook } = await savedWithdrawal(f);
    // The book holds less cash than the finalized withdrawal took: it cannot record it yet.
    await setBook({ cashRaw: "500000" });
    const retry = await asPage(() => f.app.submitOwnerAction(f.scope, { signedTransactionBase64 }));
    assert.equal(retry.status, 503); assert.match(retry.error!, UNKNOWN);
    assert.equal(retry.refusal, false);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.status, "pending", "the server still holds the broadcast withdrawal");
  } finally { f.raw.close(); }
});

test("a finalized receipt whose vault effect is missing or unreadable is an unknown outcome on retry, whatever the worker's message", async () => {
  // The receipt is finalized, but the finalized vault still shows the prior sequence: the receipt is not believed.
  const f = await fixture();
  try {
    const { signedTransactionBase64 } = await savedWithdrawal(f);
    f.controls.sequence = 0n;
    const retry = await asPage(() => f.app.submitOwnerAction(f.scope, { signedTransactionBase64 }));
    assert.equal(retry.status, 503); assert.match(retry.error!, UNKNOWN);
    assert.doesNotMatch(retry.error!, /vault state/, "the worker's own text is not shown");
    assert.equal(retry.refusal, false);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.status, "pending");
  } finally { f.raw.close(); }
  // The finalized vault account cannot be decoded (larger than a vault account).
  const g = await fixture();
  try {
    const { signedTransactionBase64 } = await savedWithdrawal(g);
    const vault = (await new SolanaTradingStore(g.db, g.scope).setup())!.vault;
    const garbled = (read: SolanaLiveRead): SolanaLiveRead => async (method, params = []) => {
      const answer = await read(method, params);
      if (method !== "getAccountInfo" || params[0] !== vault || (params[1] as { commitment?: string }).commitment !== "finalized") return answer;
      return { ...(answer as object), value: { owner: PROGRAM, executable: false, lamports: 1, data: [Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE + 1).toString("base64"), "base64"] } };
    };
    const rpc: SolanaLiveRpc = { ...g.rpc, read: fn => g.rpc.read(read => fn(garbled(read))), readEach: fn => g.rpc.readEach!(read => fn(garbled(read))) };
    const app = createSolanaAppRuntime({ db: g.db, rpc, market: g.market, env: g.env, now: () => g.clock.now });
    const retry = await asPage(() => app.submitOwnerAction(g.scope, { signedTransactionBase64 }));
    assert.equal(retry.status, 503); assert.match(retry.error!, UNKNOWN);
    assert.equal(retry.refusal, false);
    assert.equal((await new SolanaTradingStore(g.db, g.scope).setup())!.status, "pending");
    assert.equal(g.controls.sends, 1, "nothing is sent again");
  } finally { g.raw.close(); }
});

test("a finalized withdrawal is booked on retry even when the book already moved past its slot, never wedged pending", async () => {
  const f = await fixture();
  try {
    const { signedTransactionBase64, setBook } = await savedWithdrawal(f);
    await setBook({ slot: 1001 });
    const retry = await asPage(() => f.app.submitOwnerAction(f.scope, { signedTransactionBase64 }));
    assert.equal(retry.status, 200, retry.error);
    const store = new SolanaTradingStore(f.db, f.scope);
    assert.equal((await store.setup())!.status, "finalized");
    const booked = (await store.liveBook())!;
    assert.equal(booked.cashRaw, "89000000"); assert.equal(booked.hwmRaw, "99000000"); assert.equal(booked.slot, 1001);
    assert.equal(f.controls.sends, 1, "nothing is sent again");
  } finally { f.raw.close(); }
});

test("bytes refused before anything is saved are still a 4xx refusal", async () => {
  const f = await fixture();
  try {
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    f.clock.now += 61_000;
    const first = await asPage(() => f.app.submitSetup(f.scope, { signedTransactionBase64 }));
    assert.equal(first.status, 409); assert.match(first.error!, /expired before submission/);
    assert.equal(first.refusal, true);
    assert.equal(f.controls.sends, 0); assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.signature, undefined);
  } finally { f.raw.close(); }
});

test("the browser signs the real permission with its bounded priority fee, and refuses a larger, partial or extra one", async () => {
  const f = await fixture();
  try {
    await f.live();
    // Without a simulation or a fee estimate the permission carries no priority fee, as before.
    const plain = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const expected = { owner: f.owner, programId: PROGRAM, vault: plain.vault, session: f.session };
    assert.equal(plain.priorityFeeLamports, "0"); assert.equal(readPermissionTransaction(plain.transactionBase64, expected).priorityFeeLamports, "0");
    f.controls.simulatedUnits = 150_000; f.controls.priorityFees = [200_000];
    const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    assert.notEqual(setup.priorityFeeLamports, "0");
    const terms = readPermissionTransaction(setup.transactionBase64, expected);
    assert.equal(terms.priorityFeeLamports, setup.priorityFeeLamports, "the page sees the fee the server set");
    assert.ok(permissionMatchesLimits(terms, limits));
    assert.equal(OWNER_MAX_PRIORITY_FEE_LAMPORTS, SOLANA_OWNER_MAX_PRIORITY_FEE_LAMPORTS, "browser and server share one cap");
    // Rebuild the same permission with a different priority fee.
    const compiled = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(setup.transactionBase64, "base64")).messageBytes);
    const message = decompileTransactionMessage(compiled, { lastValidBlockHeight: BigInt(setup.lastValidBlockHeight) });
    const body = message.instructions.filter(ix => ix.programAddress !== "ComputeBudget111111111111111111111111111111") as Instruction[];
    const [limit] = solanaComputeBudgetInstructions(setup.computeUnitLimit!, 0n);
    // getBase64EncodedWireTransaction already returns base64 wire bytes.
    const rebuilt = (instructions: Instruction[]) => String(getBase64EncodedWireTransaction(compileTransaction(setTransactionMessageLifetimeUsingBlockhash(
      { blockhash: setup.blockhash as Blockhash, lastValidBlockHeight: BigInt(setup.lastValidBlockHeight) },
      setTransactionMessageFeePayer(address(f.owner), appendTransactionMessageInstructions(instructions, createTransactionMessage({ version: 0 })))))));
    // A 150,000-unit simulation, but six instructions get 1,200,000 units with no limit: the server signs no less.
    assert.equal(body.length, 6); assert.equal(setup.computeUnitLimit, 1_200_000);
    assert.equal(BigInt(solanaOwnerComputeUnitLimit(1, 1)), OWNER_DEFAULT_UNITS_PER_INSTRUCTION, "browser and server share one floor");
    const units = BigInt(setup.computeUnitLimit!), atCap = OWNER_MAX_PRIORITY_FEE_LAMPORTS * 1_000_000n / units;
    assert.equal(readPermissionTransaction(rebuilt([...solanaComputeBudgetInstructions(Number(units), atCap), ...body]), expected).priorityFeeLamports,
      ((atCap * units + 999_999n) / 1_000_000n).toString(), "up to the cap is signed");
    const refused = [
      [...solanaComputeBudgetInstructions(Number(units), atCap + 1_000_000n), ...body],
      [...solanaComputeBudgetInstructions(Number(units), 1n).slice(1), ...body],
      [limit!, ...body],
      [...solanaComputeBudgetInstructions(Number(units), 1n), ...solanaComputeBudgetInstructions(Number(units), 1n).slice(1), ...body],
      [{ ...limit!, accounts: [{ address: address(f.owner), role: 1 }] }, ...solanaComputeBudgetInstructions(Number(units), 1n).slice(1), ...body],
      // A limit from an under-reported simulation (1 unit × 1.2 + 40,000 headroom): it could run out of compute on chain.
      [...solanaComputeBudgetInstructions(40_002, 1n), ...body],
      [...solanaComputeBudgetInstructions(1_199_999, 1n), ...body],
    ] as Instruction[][];
    for (const [index, instructions] of refused.entries()) {
      assert.throws(() => readPermissionTransaction(rebuilt(instructions), expected), /does not match what this page shows/, String(index));
    }
  } finally { f.raw.close(); }
});
