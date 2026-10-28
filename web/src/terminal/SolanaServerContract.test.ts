/**
 * WHAT THE SOLANA PAGE RELIES ON, RUN AGAINST THE REAL RUNTIME.
 *
 * SolanaScreen.test.ts drives the page against fixture routes. These tests
 * pin the server half of that contract with createSolanaAppRuntime itself,
 * through solanaResponse where the page sees an HTTP answer:
 * - the registration bytes prepareLive really builds (vault initialize or
 *   not, the four token-account creations, a priority fee or none) pass the
 *   page's whole check, checkPreparedPermission, and a changed one does not;
 * - the owner transactions prepareOwnerAction really builds (revoke, resume,
 *   native SOL and token withdrawals, a SyncNative first or not, a priority
 *   fee or none) pass the page's check, checkPreparedOwnerTransaction;
 * - which owner transactions the server prepares while another is pending (a
 *   revocation beside a pending non-revoke one, nothing else), the rule
 *   SolanaOwnerActions shows the owner (and ownerPrepare models in
 *   SolanaScreen.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { address, getProgramDerivedAddress, appendTransactionMessageInstructions, compileTransaction, createKeyPairFromPrivateKeyBytes, createTransactionMessage,
  decompileTransactionMessage, getAddressFromPublicKey, getBase58Decoder, getBase58Encoder, getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder, getTransactionDecoder, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  signTransaction, type Blockhash, type Instruction } from "@solana/kit";
import { SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../../packages/core/src/ids";
import { SOLANA_ASSOCIATED_TOKEN_PROGRAM, SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_SYSTEM_PROGRAM, SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_VAULT_DISCRIMINATOR,
  SOLANA_VAULT_LOCAL_TEST_PROGRAM, SOLANA_WRAPPED_SOL_MINT, deriveSolanaAta, deriveSolanaVaultAddress } from "../../../packages/core/src/solana-live";
import { wrapSqlite } from "../../../worker/src/db";
import { createSolanaAppRuntime } from "../../../worker/src/solana-app-runtime";
import { PYTH_SOL_USD_ACCOUNT } from "../../../worker/src/solana-reference-price";
import { pythAccount } from "../../../worker/src/solana-reference-price-fixture";
import type { SolanaLiveRead, SolanaLiveRpc } from "../../../worker/src/solana-live-rpc";
import type { SolanaPaperMarket } from "../../../worker/src/solana-paper-service";
import { solanaResponse } from "../lib/solana-api";
import { SqlSolanaBindingStore } from "../lib/solana-binding-store";
import { checkPreparedOwnerTransaction, refusedByServer, type OwnerRequest } from "./SolanaOwnerActions";
import { checkPreparedPermission, OWNER_DEFAULT_UNITS_PER_INSTRUCTION, OWNER_MAX_PRIORITY_FEE_LAMPORTS, type PreparedPermission } from "./SolanaPermission";
import { RequestError } from "./request-json";

const TENANT = "0x1111111111111111111111111111111111111111";
const PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM, LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const key = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
const keyBytes = (value: string) => Buffer.from(getBase58Encoder().encode(value));
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 10, maxDrawdownBps: 2000, expiresAtMs: 4_600_000,
  perTradeWsol: "100000000", dailyWsol: "500000000" };
function account(data: Buffer, owner = PROGRAM, executable = false) {
  return { owner, executable, lamports: 100_000_000, data: [data.toString("base64"), "base64"], space: data.length };
}

/** A live-mode runtime on an in-memory database and a two-provider fake chain (built as in solana-owner-outcome.test.ts). */
async function fixture() {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw), clock = { now: 1_000_000 };
  const ownerKeys = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(21));
  const sessionKeys = await createKeyPairFromPrivateKeyBytes(Buffer.alloc(32, 22));
  const owner = await getAddressFromPublicKey(ownerKeys.publicKey), session = await getAddressFromPublicKey(sessionKeys.publicKey);
  const scope = { tenant: TENANT, owner }, vault = await deriveSolanaVaultAddress(PROGRAM, owner);
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => clock.now);
  await bindings.bind(TENANT, "did:privy:owner", owner);
  await bindings.settings(TENANT, owner, 0, "live", limits);
  const dataAddress = key(41), binary = Buffer.from("runtime-tested-binary"), program = Buffer.alloc(36), programData = Buffer.alloc(45 + binary.length);
  program.writeUInt32LE(2); keyBytes(dataAddress).copy(program, 4); programData.writeUInt32LE(3); binary.copy(programData, 45);
  const controls = { initialized: false, sends: 0, height: 4900, simulatedUnits: null as number | null, priorityFees: null as number[] | null, unsyncedWsol: false,
    // A transfer-hook program the USDG issuer set, and its ExtraAccountMetaList; none, as on mainnet today.
    hookProgram: null as string | null, hookList: null as Buffer | null };
  const usdgMint = () => {
    const b = Buffer.alloc(234); b.writeBigUInt64LE(1_000_000n, 36); b[44] = 6; b[45] = 1; b[165] = 1; b.writeUInt16LE(14, 166); b.writeUInt16LE(64, 168);
    if (controls.hookProgram) keyBytes(controls.hookProgram).copy(b, 202);
    return b;
  };
  const hookValidation = async () => controls.hookProgram ? (await getProgramDerivedAddress({ programAddress: address(controls.hookProgram),
    seeds: [new TextEncoder().encode("extra-account-metas"), keyBytes(SOLANA_USDG_MINT)] }))[0] : null;
  // The vault's wrapped SOL account, holding native SOL above its rent reserve and its 0 WSOL when unsyncedWsol is set.
  const vaultWsol = await deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  const wsolAccount = () => {
    const b = Buffer.alloc(165); keyBytes(SOLANA_WRAPPED_SOL_MINT).copy(b, 0); keyBytes(vault).copy(b, 32);
    b[108] = 1; b.writeUInt32LE(1, 109); b.writeBigUInt64LE(2_039_280n, 113); return b;
  };
  const state = () => {
    const b = Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE); Buffer.from(SOLANA_VAULT_DISCRIMINATOR).copy(b); let p = 8;
    b[p++] = 2; b[p++] = 255;
    for (const value of [owner, session]) { keyBytes(value).copy(b, p); p += 32; }
    for (const value of [1n, 0n, BigInt(limits.expiresAtMs / 1000), BigInt(limits.perTradeUsdg), BigInt(limits.dailyUsdg),
      BigInt(limits.perTradeWsol), BigInt(limits.dailyWsol)]) { b.writeBigUInt64LE(value, p); p += 8; }
    b.writeUInt16LE(limits.maxOpsPerDay, p); return b;
  };
  const response = (value: unknown) => ({ context: { slot: 1000 }, value });
  // The vault (once initialized) and the owner wallet, a plain system account; every token account is missing, so its rent is counted.
  const accountFor = (k: unknown) => k === vault ? (controls.initialized ? account(state()) : null) : k === owner ? account(Buffer.alloc(0), SOLANA_SYSTEM_PROGRAM)
    : k === vaultWsol && controls.unsyncedWsol ? account(wsolAccount(), SOLANA_CLASSIC_TOKEN_PROGRAM) : k === SOLANA_USDG_MINT ? account(usdgMint(), TOKEN_2022_PROGRAM)
    : k === validationAddress && controls.hookList ? account(controls.hookList, controls.hookProgram!) : null;
  let validationAddress: string | null = null;
  const read: SolanaLiveRead = async (method, params = []) => {
    validationAddress = await hookValidation();
    if (method === "getSlot") return 1000;
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
      return response(accountFor(params[0]));
    }
    if (method === "getMultipleAccounts") return response((params[0] as string[]).map(accountFor));
    if (method === "getLatestBlockhash") return response({ blockhash: key(42), lastValidBlockHeight: 5000 });
    if (method === "getSignatureStatuses") return response([null]);
    if (method === "getTransaction") return null;
    if (method === "simulateTransaction" && controls.simulatedUnits !== null) return response({ err: null, unitsConsumed: controls.simulatedUnits, logs: [], accounts: null });
    if (method === "getRecentPrioritizationFees" && controls.priorityFees) return controls.priorityFees.map((prioritizationFee, i) => ({ slot: 1000 - i, prioritizationFee }));
    throw new Error(`Unexpected test RPC ${method}`);
  };
  // Two independent providers that agree. A send is counted and its answer lost.
  const rpc: SolanaLiveRpc = { read: fn => fn(read), readEach: async fn => [await fn(read), await fn(read)], send: async () => {
    controls.sends++; throw new Error("lost send response");
  } };
  const market: SolanaPaperMarket = {
    readMint: async mint => ({ address: mint, program: mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM,
      decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: 1000, observedAtMs: clock.now, buyBlockedReasons: [] }),
    quote: async () => { throw new Error("no quotes in these tests"); },
  };
  const env = { MERRYMEN_SOLANA_VAULT_PROGRAM: PROGRAM, MERRYMEN_SOLANA_VAULT_SHA256: createHash("sha256").update(binary).digest("hex"),
    MERRYMEN_STORE_DEK: Buffer.alloc(32, 30).toString("base64"), MERRYMEN_SOLANA_FEE_PAYER_SEED: Buffer.alloc(32, 31).toString("base64"), MERRYMEN_JUPITER_API_KEY: "fixture",
    // On the live list, with daily caps at the fixture's limits (50 USDG and 0.5 SOL; per trade the defaults).
    MERRYMEN_SOLANA_LIVE_TENANTS: TENANT, MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "50", MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: "0.5" };
  const app = createSolanaAppRuntime({ db, rpc, market, env, now: () => clock.now });
  const sign = async (wire: string) => getBase64EncodedWireTransaction(await signTransaction([ownerKeys], getTransactionDecoder().decode(Buffer.from(wire, "base64"))));
  return { raw, db, clock, scope, owner, session, vault, controls, app, sign };
}

const flag = process.env.MERRYMEN_SOLANA;
test.before(() => { process.env.MERRYMEN_SOLANA = "1"; });
test.after(() => { if (flag === undefined) delete process.env.MERRYMEN_SOLANA; else process.env.MERRYMEN_SOLANA = flag; });
/** What the page receives from a route, and whether it would treat it as a refusal (SolanaOwnerActions.refusedByServer). */
async function asPage(run: () => Promise<unknown>) {
  const response = await solanaResponse(run);
  const body = await response.json() as { error?: string };
  return { status: response.status, error: body.error, refusal: !response.ok && refusedByServer(new RequestError(body.error ?? "", response.status)) };
}

/** Compute units a simulation reports in the fee cases: 1,000,000, so 1,240,000 are signed. */
const FULL_SIMULATION = 1_000_000;
/** The SetComputeUnitLimit the bytes carry, or null. */
function unitLimitOf(instructions: Instruction[]): bigint | null {
  const limit = instructions.find(ix => ix.programAddress === COMPUTE_BUDGET && ix.data?.[0] === 2);
  return limit ? BigInt(new DataView(Uint8Array.from(limit.data!).buffer).getUint32(1, true)) : null;
}
/** The least limit the page accepts for these instructions: OWNER_DEFAULT_UNITS_PER_INSTRUCTION each, other than ComputeBudget, at most 1,400,000. */
function floorOf(instructions: Instruction[]): bigint {
  const work = BigInt(instructions.filter(ix => ix.programAddress !== COMPUTE_BUDGET).length) * OWNER_DEFAULT_UNITS_PER_INSTRUCTION;
  return work < 1_400_000n ? work : 1_400_000n;
}
/** The same instructions with another compute-unit limit, at the same price. */
function withUnitLimit(instructions: Instruction[], units: bigint): Instruction[] {
  return instructions.map(ix => {
    if (ix.programAddress !== COMPUTE_BUDGET || ix.data?.[0] !== 2) return ix;
    const data = new Uint8Array(5); data[0] = 2; new DataView(data.buffer).setUint32(1, Number(units), true);
    return { ...ix, data } as Instruction;
  });
}

/** The prepared bytes' instructions, decompiled. */
function instructionsOf(transactionBase64: string): Instruction[] {
  const compiled = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(transactionBase64, "base64")).messageBytes);
  return decompileTransactionMessage(compiled, { lastValidBlockHeight: 5000n }).instructions as Instruction[];
}
/** The same message with other instructions: what a changed server could ask the wallet to sign. */
function rebuilt(owner: string, instructions: Instruction[]): string {
  // getBase64EncodedWireTransaction already returns base64 wire bytes.
  return String(getBase64EncodedWireTransaction(compileTransaction(setTransactionMessageLifetimeUsingBlockhash(
    { blockhash: key(42) as unknown as Blockhash, lastValidBlockHeight: 5000n },
    setTransactionMessageFeePayer(address(owner), appendTransactionMessageInstructions(instructions, createTransactionMessage({ version: 0 })))))));
}
/** Which instruction each one is, by program and the accounts it names. */
function shape(instructions: Instruction[], vault: string, owner: string): string[] {
  return instructions.map(ix => {
    if (ix.programAddress === COMPUTE_BUDGET) return "compute-budget";
    if (ix.programAddress === PROGRAM) return ix.accounts?.length === 3 ? "initialize" : "create-session";
    if (ix.programAddress !== SOLANA_ASSOCIATED_TOKEN_PROGRAM) return String(ix.programAddress);
    const wallet = ix.accounts![2]!.address, mint = ix.accounts![3]!.address;
    return `ata:${wallet === vault ? "vault" : wallet === owner ? "owner" : "other"}:${mint === SOLANA_USDG_MINT ? "usdg" : "wsol"}`;
  });
}

test("the server's real registration bytes pass the page's whole check, with and without vault initialize and a priority fee", async () => {
  const f = await fixture();
  try {
    // The page derives the vault itself, as SolanaScreen.prepareRegistration does.
    const expected = { owner: f.owner, programId: PROGRAM, vault: await deriveSolanaVaultAddress(PROGRAM, f.owner), session: f.session };
    const atas = ["ata:vault:usdg", "ata:vault:wsol", "ata:owner:usdg", "ata:owner:wsol"];
    const cases = [
      { name: "new vault, no fee", initialized: false, fee: false, shape: ["initialize", ...atas, "create-session"] },
      { name: "existing vault, no fee", initialized: true, fee: false, shape: [...atas, "create-session"] },
      { name: "new vault, priority fee", initialized: false, fee: true, shape: ["compute-budget", "compute-budget", "initialize", ...atas, "create-session"] },
      { name: "existing vault, priority fee", initialized: true, fee: true, shape: ["compute-budget", "compute-budget", ...atas, "create-session"] },
    ];
    for (const item of cases) {
      f.controls.initialized = item.initialized;
      // A simulation near the runtime's default budget: the limit signed (×1.2 + headroom) clears the page's floor
      // whether or not the server applies its own (the next tests run an under-reported one).
      f.controls.simulatedUnits = item.fee ? FULL_SIMULATION : null; f.controls.priorityFees = item.fee ? [200_000] : null;
      const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
      assert.deepEqual(shape(instructionsOf(setup.transactionBase64), f.vault, f.owner), item.shape, item.name);
      // Exactly what the page receives from the route, through exactly its check.
      const prepared = JSON.parse(JSON.stringify(setup)) as PreparedPermission;
      const terms = checkPreparedPermission(prepared, expected, limits);
      assert.equal(terms.priorityFeeLamports, setup.priorityFeeLamports, item.name);
      assert.equal(terms.priorityFeeLamports === "0", !item.fee, item.name);
      assert.ok(BigInt(terms.priorityFeeLamports) <= OWNER_MAX_PRIORITY_FEE_LAMPORTS, item.name);
      assert.ok(BigInt(setup.requiredLamports) > BigInt(setup.priorityFeeLamports), item.name);
    }
    assert.equal(f.controls.sends, 0, "preparing sends nothing");
  } finally { f.raw.close(); }
});

test("a registration whose token-account creation or initialize differs from the server's in any account is refused before the wallet opens", async () => {
  const f = await fixture();
  try {
    const expected = { owner: f.owner, programId: PROGRAM, vault: f.vault, session: f.session };
    const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const instructions = instructionsOf(setup.transactionBase64);
    const at = instructions.findIndex(ix => ix.programAddress === SOLANA_ASSOCIATED_TOKEN_PROGRAM && ix.accounts![3]!.address === SOLANA_USDG_MINT);
    const init = instructions.findIndex(ix => ix.programAddress === PROGRAM && ix.accounts?.length === 3);
    const usdgAta = instructions[at]!, initialize = instructions[init]!, stranger = key(77);
    const withAccounts = (ix: Instruction, accounts: Instruction["accounts"]) => ({ ...ix, accounts }) as Instruction;
    const replaced = (ix: Instruction, index: number, value: string) => withAccounts(ix, ix.accounts!.map((meta, i) => i === index ? { ...meta, address: address(value) } : meta));
    const swap = (index: number, ix: Instruction) => instructions.map((item, i) => i === index ? ix : item);
    // The unchanged rebuild passes: what is refused below is the change alone.
    assert.ok(checkPreparedPermission({ ...setup, transactionBase64: rebuilt(f.owner, instructions) }, expected, limits));
    const changed: Array<[string, Instruction[]]> = [
      ["USDG account under the classic token program", swap(at, replaced(usdgAta, 5, SOLANA_CLASSIC_TOKEN_PROGRAM))],
      ["another program in the system program's place", swap(at, replaced(usdgAta, 4, stranger))],
      ["an extra account", swap(at, withAccounts(usdgAta, [...usdgAta.accounts!, { address: address(stranger), role: 1 }]))],
      ["a third party's token account", swap(at, replaced(usdgAta, 2, stranger))],
      ["another mint", swap(at, replaced(usdgAta, 3, stranger))],
      ["an initialize with an extra account", swap(init, withAccounts(initialize, [...initialize.accounts!, { address: address(stranger), role: 1 }]))],
      ["an initialize with another program in the system program's place", swap(init, replaced(initialize, 2, stranger))],
    ];
    for (const [name, list] of changed) {
      assert.throws(() => checkPreparedPermission({ ...setup, transactionBase64: rebuilt(f.owner, list) }, expected, limits), /does not match what this page shows\. Nothing was signed/, name);
    }
    // A server that names another session or vault, or claims another fee, or other limits, is refused too.
    assert.throws(() => checkPreparedPermission({ ...setup, session: stranger }, expected, limits), /different session/);
    assert.throws(() => checkPreparedPermission({ ...setup, vault: stranger }, expected, limits), /different vault/);
    assert.throws(() => checkPreparedPermission({ ...setup, priorityFeeLamports: "5000" }, expected, limits), /fee does not match its bytes/);
    assert.throws(() => checkPreparedPermission(setup, expected, { ...limits, perTradeUsdg: "1000000" }), /does not match the saved limits shown/);
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("the server's real owner transactions pass the page's check, with and without a SyncNative and a priority fee; a changed one does not", async () => {
  const f = await fixture();
  try {
    f.controls.initialized = true;
    const expected = { owner: f.owner, programId: PROGRAM };
    const requests: Array<[OwnerRequest, boolean, string[]]> = [
      [{ action: "revoke" }, false, ["vault"]],
      [{ action: "resume-buys" }, false, ["vault"]],
      [{ action: "withdraw-sol", amountRaw: "1000000" }, false, ["vault"]],
      [{ action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" }, false, ["ata:owner:usdg", "vault"]],
      [{ action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000" }, false, ["ata:owner:wsol", "vault"]],
      [{ action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000" }, true, ["sync-native", "ata:owner:wsol", "vault"]],
    ];
    const shapeOf = (transactionBase64: string) => instructionsOf(transactionBase64).filter(ix => ix.programAddress !== COMPUTE_BUDGET).map(ix =>
      ix.programAddress === PROGRAM ? "vault" : ix.programAddress === SOLANA_CLASSIC_TOKEN_PROGRAM ? "sync-native" : shape([ix], f.vault, f.owner)[0]!);
    for (const fee of [false, true]) {
      f.controls.simulatedUnits = fee ? FULL_SIMULATION : null; f.controls.priorityFees = fee ? [200_000] : null;
      for (const [request, unsynced, instructions] of requests) {
        const name = `${request.action}${"mint" in request ? ` ${request.mint === SOLANA_USDG_MINT ? "usdg" : "wsol"}` : ""}${unsynced ? " after SyncNative" : ""}${fee ? ", priority fee" : ""}`;
        f.controls.unsyncedWsol = unsynced;
        const setup = await f.app.prepareOwnerAction(f.scope, request);
        assert.deepEqual(shapeOf(setup.transactionBase64), instructions, name);
        // Exactly what the page receives from the route, through exactly its check.
        const prepared = JSON.parse(JSON.stringify(setup)) as { transactionBase64: string; priorityFeeLamports?: string };
        const checked = await checkPreparedOwnerTransaction(prepared, request, expected);
        assert.equal(checked, setup.priorityFeeLamports, name);
        assert.equal(checked === "0", !fee, name);
        // The same bytes asked for anything else are refused: another amount, or another action.
        if ("amountRaw" in request) await assert.rejects(checkPreparedOwnerTransaction(prepared, { ...request, amountRaw: "999999" }, expected), /does not match what you asked for/, name);
        await assert.rejects(checkPreparedOwnerTransaction(prepared, request.action === "revoke" ? { action: "resume-buys" } : { action: "revoke" }, expected), /does not match what you asked for/, name);
        // For another owner, or another program.
        await assert.rejects(checkPreparedOwnerTransaction(prepared, request, { ...expected, owner: key(77) }), /does not match what you asked for/, name);
        await assert.rejects(checkPreparedOwnerTransaction(prepared, request, { ...expected, programId: key(77) }), /does not match what you asked for/, name);
      }
    }
    assert.equal(f.controls.sends, 0, "preparing sends nothing");
  } finally { f.raw.close(); }
});

test("once the USDG issuer sets a transfer hook, the server's withdrawal carries the hook's accounts and passes the page's check; the owner among them does not", async () => {
  const f = await fixture();
  try {
    f.controls.initialized = true;
    const expected = { owner: f.owner, programId: PROGRAM }, request: OwnerRequest = { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" };
    const hook = key(88), fixed = key(89);
    f.controls.hookProgram = hook;
    const header = Buffer.alloc(16); Buffer.from(createHash("sha256").update("spl-transfer-hook-interface:execute").digest().subarray(0, 8)).copy(header);
    header.writeUInt32LE(4 + 35, 8); header.writeUInt32LE(1, 12);
    f.controls.hookList = Buffer.concat([header, Buffer.of(0), keyBytes(fixed), Buffer.of(0, 1)]);
    const setup = await f.app.prepareOwnerAction(f.scope, request);
    const instructions = instructionsOf(setup.transactionBase64), at = instructions.findIndex(ix => ix.programAddress === PROGRAM);
    const withdraw = instructions[at]!;
    assert.deepEqual(withdraw.accounts!.slice(6).map(a => String(a.address)), [fixed, (await getProgramDerivedAddress({ programAddress: address(hook),
      seeds: [new TextEncoder().encode("extra-account-metas"), keyBytes(SOLANA_USDG_MINT)] }))[0], hook]);
    const prepared = JSON.parse(JSON.stringify(setup)) as { transactionBase64: string; priorityFeeLamports?: string };
    assert.equal(await checkPreparedOwnerTransaction(prepared, request, expected), setup.priorityFeeLamports);
    // Extra accounts on anything but the USDG withdrawal, or the owner's wallet among them, are refused before the wallet opens.
    const withTail = (tail: string[]) => instructions.map((ix, i) => i === at ? { ...ix, accounts: [...ix.accounts!, ...tail.map(a => ({ address: address(a), role: 0 as const }))] } as Instruction : ix);
    await assert.rejects(checkPreparedOwnerTransaction({ transactionBase64: rebuilt(f.owner, withTail([f.owner])) }, request, expected), /does not match what you asked for/);
    await assert.rejects(checkPreparedOwnerTransaction({ transactionBase64: rebuilt(f.owner, withTail(Array.from({ length: 30 }, (_, i) => key(100 + i)))) }, request, expected), /does not match what you asked for/);
  } finally { f.raw.close(); }
  const g = await fixture();
  try {
    g.controls.initialized = true;
    const expected = { owner: g.owner, programId: PROGRAM }, request: OwnerRequest = { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000" };
    const setup = await g.app.prepareOwnerAction(g.scope, request);
    const instructions = instructionsOf(setup.transactionBase64), at = instructions.findIndex(ix => ix.programAddress === PROGRAM);
    const tailed = instructions.map((ix, i) => i === at ? { ...ix, accounts: [...ix.accounts!, { address: address(key(89)), role: 0 as const }] } as Instruction : ix);
    await assert.rejects(checkPreparedOwnerTransaction({ transactionBase64: rebuilt(g.owner, tailed) }, request, expected), /does not match what you asked for/);
  } finally { g.raw.close(); }
});

test("the server's bytes from an under-reported simulation reach the wallet only with at least the runtime's default compute budget", async () => {
  const f = await fixture();
  try {
    // A provider answering 1 unit: the simulation alone would sign 40,002 units (×1.2 + 40,000 headroom).
    f.controls.simulatedUnits = 1; f.controls.priorityFees = [200_000];
    const permission = { owner: f.owner, programId: PROGRAM, vault: f.vault, session: f.session }, owner = { owner: f.owner, programId: PROGRAM };
    type Prepared = { transactionBase64: string; priorityFeeLamports?: string };
    const checks: Array<[string, () => Promise<Prepared>, (prepared: Prepared) => Promise<unknown>]> = [
      ["new vault permission", async () => { f.controls.initialized = false; return f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session }); },
        async (prepared) => checkPreparedPermission(prepared as PreparedPermission, permission, limits)],
    ];
    for (const request of [{ action: "revoke" }, { action: "withdraw-sol", amountRaw: "1000000" }, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" }] as OwnerRequest[]) {
      checks.push([request.action + ("mint" in request ? " usdg" : ""), async () => { f.controls.initialized = true; return f.app.prepareOwnerAction(f.scope, request); },
        async (prepared) => checkPreparedOwnerTransaction(prepared, request, owner)]);
    }
    for (const [name, prepare, check] of checks) {
      const prepared = JSON.parse(JSON.stringify(await prepare())) as Prepared;
      const instructions = instructionsOf(prepared.transactionBase64), signed = unitLimitOf(instructions), floor = floorOf(instructions);
      assert.ok(signed !== null, `${name}: the server added a priority fee`);
      // The page accepts exactly what clears the floor: everything the server signs once it applies its own
      // (solanaOwnerComputeUnitLimit), and never the bare simulation's limit from a server that does not.
      const accepted = await check(prepared).then(() => true, (error: Error) => { assert.match(error.message, /does not match what (this page shows|you asked for)\. Nothing was signed/, name); return false; });
      assert.equal(accepted, signed >= floor, `${name}: ${signed} units signed, ${floor} the floor`);
      // The same bytes at the floor pass; one unit less is refused before the wallet opens. (No stated fee: the fee follows the limit.)
      const at = (units: bigint): Prepared => ({ ...prepared, transactionBase64: rebuilt(f.owner, withUnitLimit(instructions, units)), priorityFeeLamports: undefined });
      await check(at(floor));
      await assert.rejects(Promise.resolve().then(() => check(at(floor - 1n))), /does not match what (this page shows|you asked for)\. Nothing was signed/, name);
    }
    assert.equal(f.controls.sends, 0, "preparing sends nothing");
  } finally { f.raw.close(); }
});

test("while a submitted owner transaction is unresolved the server prepares only a revocation, beside it, and nothing at all while a revocation is pending; one only prepared is replaced", async () => {
  const f = await fixture();
  try {
    f.controls.initialized = true;
    // Prepared and signed but never submitted: a revocation replaces it, and its bytes can no longer be sent.
    const unsent = await f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "1000000" });
    const unsentSigned = await f.sign(unsent.transactionBase64);
    assert.equal((await asPage(() => f.app.prepareOwnerAction(f.scope, { action: "revoke" }))).status, 200);
    const late = await asPage(() => f.app.submitOwnerAction(f.scope, { signedTransactionBase64: unsentSigned }));
    assert.equal(late.refusal, true, late.error); assert.equal(f.controls.sends, 0, "refused before anything is saved or sent");
    // Submitted (saved and broadcast) and unresolved: nothing else is prepared but a revocation, beside it.
    const withdrawal = await f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "1000000" });
    const signed = await f.sign(withdrawal.transactionBase64);
    const submitted = await asPage(() => f.app.submitOwnerAction(f.scope, { signedTransactionBase64: signed }));
    assert.equal(submitted.status, 200); assert.equal(f.controls.sends, 1);
    const refused = async (inputs: ReadonlyArray<Parameters<typeof f.app.prepareOwnerAction>[1]>) => {
      for (const input of inputs) {
        const answer = await asPage(() => f.app.prepareOwnerAction(f.scope, input));
        assert.equal(answer.status, 409, input.action);
        assert.equal(answer.error, "Refresh the pending owner transaction before preparing another.", input.action);
        assert.equal(answer.refusal, true, input.action);
      }
    };
    await refused([{ action: "resume-buys" }, { action: "withdraw-sol", amountRaw: "1000000" }]);
    const revocation = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const revocationSigned = await f.sign(revocation.transactionBase64);
    const revoked = await asPage(() => f.app.submitOwnerAction(f.scope, { signedTransactionBase64: revocationSigned }));
    assert.equal(revoked.status, 200); assert.equal(f.controls.sends, 2);
    // While that revocation is pending nothing is prepared, another revocation included.
    await refused([{ action: "revoke" }, { action: "resume-buys" }, { action: "withdraw-sol", amountRaw: "1000000" }]);
    // The status names both, which is what the page holds owner actions back on.
    const status = await f.app.status(f.scope);
    assert.equal(status.live.ownerTransaction?.status, "pending"); assert.equal(status.live.ownerTransaction?.kind, "withdraw-sol");
    assert.equal(status.live.ownerTransaction?.revoke?.status, "pending");
    // Their blockhashes provably expired (finalized height past them, vault unchanged): both are failed, and a revocation prepares again.
    f.controls.height = 5100;
    const retry = await asPage(() => f.app.submitOwnerAction(f.scope, { signedTransactionBase64: signed }));
    assert.equal(retry.status, 200);
    const settled = (await f.app.status(f.scope)).live.ownerTransaction;
    assert.equal(settled?.status, "failed"); assert.equal(settled?.revoke?.status, "failed");
    assert.equal((await asPage(() => f.app.prepareOwnerAction(f.scope, { action: "revoke" }))).status, 200);
  } finally { f.raw.close(); }
});

