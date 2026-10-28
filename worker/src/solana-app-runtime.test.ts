import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getBase58Decoder, getBase58Encoder, getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder, getTransactionDecoder, signTransaction } from "@solana/kit";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { SOLANA_LIVE_PER_TRADE_BELOW_MINIMUM, SolanaPaperValidationError } from "../../packages/core/src/solana";
import { SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_VAULT_DISCRIMINATOR,
  SOLANA_VAULT_LOCAL_TEST_PROGRAM, SOLANA_WRAPPED_SOL_MINT, deriveSolanaAta, deriveSolanaSwapAuthority, deriveSolanaVaultAddress } from "../../packages/core/src/solana-live";
import { sealSecret } from "./store-crypto";
// Aliased: the owner track imports the same constant by its own name.
import { SOLANA_STATUS_BELOW_BOOK as STATUS_BELOW_BOOK } from "./solana-app-runtime";
import { ensureSolanaShortfallSchema } from "./solana-resolve-shortfall";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { wrapSqlite } from "./db";
import { createSolanaAgent } from "./solana-agent";
import { createSolanaAppRuntime, SOLANA_DEPLOYMENT_RECHECK_MS, SolanaAppRuntimeError, solanaOwnerComputeUnitLimit, SOLANA_STATUS_BEHIND_BOOK, SOLANA_STATUS_FEE_PAYER_THRESHOLD_MISCONFIGURED,
  SOLANA_STATUS_NO_FALLBACK } from "./solana-app-runtime";
import { SolanaRpcError, withSolanaReadDeadline } from "./solana-rpc";
import type { SolanaLiveRead, SolanaLiveRpc } from "./solana-live-rpc";
import type { SolanaPaperMarket } from "./solana-paper-service";
import { SolanaMarketError } from "./solana-market";
import { ensureSolanaTradingSchema, SolanaTradingStore } from "./solana-trading-store";
import { PYTH_SOL_USD_ACCOUNT } from "./solana-reference-price";
import { pythAccount } from "./solana-reference-price-fixture";
import { address as kitAddress, getProgramDerivedAddress, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, type Blockhash } from "@solana/kit";
import { buildWithdrawSolanaVaultInstruction, SOLANA_TRANSFER_HOOK_NAMES_OWNER } from "../../packages/core/src/solana-live";
import { SOLANA_LIVE_SELL_CAP_BELOW_MINIMUM, SOLANA_LIVE_SELL_CAP_UNCHECKED, SOLANA_STATUS_BELOW_BOOK, SOLANA_STATUS_REGISTERED_AFTER_REVOKE, SOLANA_STATUS_USDG_MINT_REFUSED, SOLANA_WITHDRAW_BELOW_BOOK } from "./solana-app-runtime";
import { SOLANA_REGISTERED_AFTER_REVOKE, SOLANA_RESUMED_AFTER_REVOKE, SOLANA_REVOKE_ALREADY_LANDED, SOLANA_REVOKE_PREPARED_BESIDE, SOLANA_WITHDRAWAL_ABOVE_BOOK,
  SOLANA_WITHDRAWAL_RECORDED_OUTSIDE, SolanaTradingStoreError } from "./solana-trading-store";
import { SOLANA_LIVE_NOT_OPEN, SOLANA_LIVE_PAUSED, SOLANA_LIVE_PAUSED_NO_PERMISSION, SOLANA_LIVE_ROLLOUT_DIFFERS, SOLANA_LIVE_ROLLOUT_MISCONFIGURED,
  SOLANA_LIVE_ROLLOUT_MISCONFIGURED_NO_PERMISSION } from "./solana-app-runtime";
import { SOLANA_LIVE_CAP_DEFAULTS, solanaLiveCapRefusal, solanaLiveExitLimitsRefusal, solanaLiveSavedAboveCaps, solanaLiveSessionAboveCaps } from "./solana-live-rollout";
import { startSolanaRolloutPublisher } from "../../web/src/lib/solana-rollout-publisher";

const TENANT = "0x1111111111111111111111111111111111111111";
/** A Token-2022 USDG mint carrying the TransferHook extension (type 14): the issuer holds its authority, `hook` names the program or none. */
function usdgMint(hook: string | null): Buffer {
  const b = Buffer.alloc(234); b.writeUInt32LE(0, 0); b.writeBigUInt64LE(1_000_000n, 36); b[44] = 6; b[45] = 1;
  b[165] = 1; b.writeUInt16LE(14, 166); b.writeUInt16LE(64, 168); b.fill(9, 170, 202);
  if (hook) keyBytes(hook).copy(b, 202);
  return b;
}
const key = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
// A production-style program id: the runtimes below run every live deployment check.
const PROGRAM = key(77), LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const keyBytes = (value: string) => Buffer.from(getBase58Encoder().encode(value));
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 10, maxDrawdownBps: 2000, expiresAtMs: 4_600_000,
  perTradeWsol: "100000000", dailyWsol: "500000000" };
function account(data: Buffer, owner = PROGRAM, executable = false, lamports = 100_000_000) {
  return { owner, executable, lamports, data: [data.toString("base64"), "base64"], space: data.length };
}
/** Mainnet's rent-exempt minimum: (128 + size) bytes at 3,480 lamports per byte-year, for two years. */
const rentExempt = (size: number) => (128 + size) * 6960;
const SYSTEM = "11111111111111111111111111111111";
async function fixture(options: { declared?: string } = {}) {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw), clock = { now: 1_000_000 };
  const ownerKeys = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(21));
  const sessionSeed = Buffer.alloc(32, 22), sessionKeys = await createKeyPairFromPrivateKeyBytes(sessionSeed);
  const owner = await getAddressFromPublicKey(ownerKeys.publicKey), session = await getAddressFromPublicKey(sessionKeys.publicKey);
  const scope = { tenant: TENANT, owner }, vault = await deriveSolanaVaultAddress(PROGRAM, owner);
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => clock.now);
  await bindings.bind(TENANT, "did:privy:owner", owner);
  await bindings.settings(TENANT, owner, 0, "paper", limits);
  // The binary declares PROGRAM: declare_id! embeds its 32 bytes.
  const dataAddress = key(41), binary = Buffer.concat([Buffer.from("runtime-tested-binary"), keyBytes(options.declared ?? PROGRAM)]), program = Buffer.alloc(36), programData = Buffer.alloc(45 + binary.length);
  program.writeUInt32LE(2); keyBytes(dataAddress).copy(program, 4); programData.writeUInt32LE(3); binary.copy(programData, 45);
  const controls = { initialized: false, finalized: false, failed: false, malformed: false, sends: 0, signed: "", signature: "", failSend: true, height: 4900, sequence: 0n, epoch: 1n,
    cash: 0n, wsol: 0n, feePayerLamports: 100_000_000, ownerLamports: 100_000_000, ownerAtas: false, vaultNativeLamports: 0, unsyncedWsolLamports: 0,
    // Owner-transaction simulation and recent priority fees; null: the provider cannot answer.
    simulatedUnits: null as number | null, simulationFails: false, priorityFees: null as number[] | null,
    // The USDG mint's TransferHook program: unset, as on mainnet today.
    hookProgram: null as string | null,
    // Pyth SOL/USD (8 decimals) both providers serve, which a registration checks the SOL sold per trade against: $120.
    // null: the account reads as a system account, which every reference read refuses.
    pythPrice: 12_000_000_000n as bigint | null };
  const cashAta = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), wsolAta = await deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  const ownerCashAta = await deriveSolanaAta(owner, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), ownerWsolAta = await deriveSolanaAta(owner, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  const feePayer = await getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(31))).publicKey);
  // USDG accounts are Token-2022 with the ATA program's ImmutableOwner extension (170 bytes); WSOL accounts are native (165).
  const tokenAccount = (mint: string, amount: bigint, holder = vault) => {
    const usdg = mint === SOLANA_USDG_MINT, b = Buffer.alloc(usdg ? 170 : 165); keyBytes(mint).copy(b, 0); keyBytes(holder).copy(b, 32); b.writeBigUInt64LE(amount, 64); b[108] = 1;
    if (usdg) { b[165] = 2; b.writeUInt16LE(7, 166); } else { b.writeUInt32LE(1, 109); b.writeBigUInt64LE(BigInt(rentExempt(165)), 113); }
    return b;
  };
  const state = (epoch = controls.epoch, sequence = controls.sequence) => {
    const b = Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE); Buffer.from(SOLANA_VAULT_DISCRIMINATOR).copy(b); let p = 8;
    b[p++] = 2; b[p++] = 255;
    for (const value of [owner, session]) { keyBytes(value).copy(b, p); p += 32; }
    for (const value of [epoch, sequence, BigInt(limits.expiresAtMs / 1000), BigInt(limits.perTradeUsdg), BigInt(limits.dailyUsdg),
      BigInt(limits.perTradeWsol), BigInt(limits.dailyWsol)]) { b.writeBigUInt64LE(value, p); p += 8; }
    b.writeUInt16LE(limits.maxOpsPerDay, p); return b;
  };
  const response = (value: unknown) => ({ context: { slot: 1000 }, value });
  // Every RPC read, in order: what a status or owner action costs.
  const calls: Array<{ method: string; key: unknown }> = [];
  // Accounts a test places at other addresses (a swap's temporary input account, say).
  const extra = new Map<string, unknown>();
  const accountFor = (k: unknown) => typeof k === "string" && extra.has(k) ? extra.get(k) : k === SOLANA_USDG_MINT ? account(usdgMint(controls.hookProgram), TOKEN_2022_PROGRAM, false, rentExempt(234))
    : k === vault ? (controls.initialized ? account(state(), PROGRAM, false, rentExempt(SOLANA_VAULT_ACCOUNT_SIZE) + controls.vaultNativeLamports) : null)
    : k === cashAta ? account(tokenAccount(SOLANA_USDG_MINT, controls.cash), TOKEN_2022_PROGRAM, false, rentExempt(170))
    : k === wsolAta ? account(tokenAccount(SOLANA_WRAPPED_SOL_MINT, controls.wsol), SOLANA_CLASSIC_TOKEN_PROGRAM, false, rentExempt(165) + Number(controls.wsol) + controls.unsyncedWsolLamports)
    : k === feePayer ? (controls.feePayerLamports ? account(Buffer.alloc(0), SYSTEM, false, controls.feePayerLamports) : null)
    : k === owner ? (controls.ownerLamports ? account(Buffer.alloc(0), SYSTEM, false, controls.ownerLamports) : null)
    : k === ownerCashAta ? (controls.ownerAtas ? account(tokenAccount(SOLANA_USDG_MINT, 0n, owner), TOKEN_2022_PROGRAM, false, rentExempt(170)) : null)
    : k === ownerWsolAta ? (controls.ownerAtas ? account(tokenAccount(SOLANA_WRAPPED_SOL_MINT, 0n, owner), SOLANA_CLASSIC_TOKEN_PROGRAM, false, rentExempt(165)) : null)
    : null;
  const read: SolanaLiveRead = async (method, params = []) => {
    calls.push({ method, key: params[0] });
    if (method === "getSlot") return 1000;
    if (method === "getBlockHeight") return controls.height;
    if (method === "getEpochInfo") return { absoluteSlot: 1000, blockHeight: controls.height, epoch: 2, slotIndex: 1000, slotsInEpoch: 432_000 };
    if (method === "getMinimumBalanceForRentExemption") return rentExempt(params[0] as number);
    if (method === "getAccountInfo") {
      if (params[0] === PROGRAM) return response(account(program, LOADER, true));
      if (params[0] === dataAddress) {
        const slice = (params[1] as { dataSlice: { offset: number; length: number } }).dataSlice;
        return response({ ...account(programData.subarray(slice.offset, slice.offset + slice.length), LOADER), space: programData.length });
      }
      if (params[0] === vault) return response(accountFor(vault));
      if (params[0] === PYTH_SOL_USD_ACCOUNT && controls.pythPrice !== null) return response(pythAccount({ price: controls.pythPrice, publishTimeMs: clock.now, postedSlot: 999n }));
      return response(accountFor(params[0]) ?? account(Buffer.alloc(0), SYSTEM));
    }
    if (method === "getMultipleAccounts") return response((params[0] as string[]).map(accountFor));
    if (method === "getLatestBlockhash") return response({ blockhash: key(42), lastValidBlockHeight: 5000 });
    if (method === "getSignatureStatuses") return response([controls.finalized ? { confirmationStatus: "finalized", slot: 1000, ...(controls.malformed ? {} : { err: controls.failed ? { InstructionError: [0, "InvalidArgument"] } : null }) } : null]);
    if (method === "getTransaction") return controls.finalized ? { version: 0, slot: 1000, transaction: [controls.signed, "base64"], meta: controls.malformed ? {} : { err: controls.failed ? { InstructionError: [0, "InvalidArgument"] } : null } } : null;
    if (method === "simulateTransaction" && controls.simulatedUnits !== null) {
      assert.deepEqual(params[1], { encoding: "base64", commitment: "finalized", sigVerify: false, replaceRecentBlockhash: false });
      return response({ err: controls.simulationFails ? { InstructionError: [0, { Custom: 6000 }] } : null, unitsConsumed: controls.simulatedUnits, logs: [], accounts: null });
    }
    if (method === "getRecentPrioritizationFees" && controls.priorityFees) return controls.priorityFees.map((prioritizationFee, index) => ({ slot: 1000 - index, prioritizationFee }));
    throw new Error(`Unexpected test RPC ${method}`);
  };
  // Two independent providers. Both answer honestly unless a test replaces one.
  const providers: { primary: SolanaLiveRead | null; fallback: SolanaLiveRead | null } = { primary: null, fallback: null };
  const sent: string[] = [];
  const rpc: SolanaLiveRpc = { read: fn => fn(providers.primary ?? read), readEach: async fn => [await fn(providers.primary ?? read), await fn(providers.fallback ?? read)], send: async wire => {
    controls.sends++; sent.push(wire);
    // Either slot: the main owner transaction, or a revocation prepared beside it.
    const ledger = new SolanaTradingStore(db, scope, () => clock.now), revoking = await ledger.revokeSetup();
    const saved = revoking?.signedTransactionBase64 === wire ? revoking : await ledger.setup();
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
  // The tenant is on the live list, and the caps are the fixture's own limits: 10 USDG and 0.1 SOL per trade (the defaults), 50 USDG and 0.5 SOL a day.
  const env = { MERRYMEN_SOLANA_VAULT_PROGRAM: PROGRAM, MERRYMEN_SOLANA_VAULT_SHA256: createHash("sha256").update(binary).digest("hex"),
    MERRYMEN_STORE_DEK: Buffer.alloc(32, 30).toString("base64"), MERRYMEN_SOLANA_FEE_PAYER_SEED: Buffer.alloc(32, 31).toString("base64"), MERRYMEN_JUPITER_API_KEY: "fixture",
    MERRYMEN_SOLANA_LIVE_TENANTS: TENANT, MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "50", MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: "0.5" };
  const runtime = (overrides: Partial<Parameters<typeof createSolanaAppRuntime>[0]> = {}) =>
    createSolanaAppRuntime({ db, rpc, market, env, now: () => clock.now, localTestDeployment: false, ...overrides });
  const app = runtime();
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
  return { raw, db, clock, scope, owner, session, sessionSeed, controls, bindings, app, runtime, sign, live, trade, env, rpc, market, registered, programData, dataAddress, calls, feePayer, vault, cashAta, wsolAta, ownerCashAta, ownerWsolAta,
    read, providers, sent, state, response, extra, tokenAccount };
}

test("authenticated paper execution is durable and never calls transaction submission", async () => {
  const f = await fixture();
  try {
    await f.app.setupPaper(f.scope, { initialCashRaw: "100000000", limits });
    const first = await f.app.trade(f.scope, { mode: "paper", intent: f.trade });
    f.clock.now = limits.expiresAtMs + 1;
    assert.deepEqual(await f.app.trade(f.scope, { mode: "paper", intent: f.trade }), first);
    assert.equal(f.controls.sends, 0);
    await assert.rejects(f.app.trade({ ...f.scope, tenant: "0x2222222222222222222222222222222222222222" }, { mode: "paper", intent: f.trade }), /binding/);
    await assert.rejects(f.app.trade(f.scope, { mode: "paper", intent: { ...f.trade, owner: f.owner } }), /Invalid/);
  } finally { f.raw.close(); }
});

test("a hosted owner writes off a paper dust lot through the runtime: the answer is the book and the record, and only for a canonical mint", async () => {
  const f = await fixture();
  try {
    await f.app.setupPaper(f.scope, { initialCashRaw: "100000000", limits });
    const buy = await f.app.trade(f.scope, { mode: "paper", intent: f.trade }) as { outputAmountRaw: string };
    // Now nothing buys the lot back: the market's zero-output answer for exactly that lot.
    const dust: SolanaPaperMarket = { readMint: f.market.readMint, quote: async intent => {
      if (intent.outputMint !== SOLANA_USDG_MINT) return f.market.quote(intent);
      throw new SolanaMarketError("zero-output", { source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: intent.amountRaw,
        outAmount: "0", minOutAmount: "0", slippageBps: intent.slippageBps, contextSlot: 1000, quotedAtMs: f.clock.now });
    } };
    const app = f.runtime({ market: dust });
    for (const mint of ["", " " + SOLANA_WRAPPED_SOL_MINT, "not-a-mint", 7]) {
      await assert.rejects(app.writeOffPaper(f.scope, { mint } as { mint: string }), (error: unknown) => error instanceof SolanaAppRuntimeError && error.code === "invalid", String(mint));
    }
    await assert.rejects(app.writeOffPaper({ ...f.scope, tenant: "0x2222222222222222222222222222222222222222" }, { mint: SOLANA_WRAPPED_SOL_MINT }), /binding/);
    const result = await app.writeOffPaper(f.scope, { mint: SOLANA_WRAPPED_SOL_MINT });
    assert.deepEqual(Object.keys(result).sort(), ["paper", "writtenOff"]);
    assert.equal(Object.hasOwn(result.paper, "writtenOff"), false);
    assert.equal(result.writtenOff.amountRaw, buy.outputAmountRaw); assert.equal(result.writtenOff.realizedPnlRaw, "-1000000");
    assert.deepEqual(result.paper.positions, []); assert.deepEqual(result.paper.writeOffs, [result.writtenOff]);
    assert.deepEqual(await new SolanaTradingStore(f.db, f.scope).paper().get(f.owner), result.paper);
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("an owner in live mode is refused a paper write-off before any quote is asked for", async () => {
  const f = await fixture();
  try {
    await f.app.setupPaper(f.scope, { initialCashRaw: "100000000", limits });
    await f.app.trade(f.scope, { mode: "paper", intent: f.trade });
    await f.live();
    // Even a lot that qualifies as dust: the store would refuse it too, but only after the paid quote.
    let quotes = 0;
    const counted: SolanaPaperMarket = { readMint: f.market.readMint, quote: async intent => {
      quotes++;
      if (intent.outputMint !== SOLANA_USDG_MINT) return f.market.quote(intent);
      throw new SolanaMarketError("zero-output", { source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: intent.amountRaw,
        outAmount: "0", minOutAmount: "0", slippageBps: intent.slippageBps, contextSlot: 1000, quotedAtMs: f.clock.now });
    } };
    const app = f.runtime({ market: counted });
    const refused = await app.writeOffPaper(f.scope, { mint: SOLANA_WRAPPED_SOL_MINT }).then(() => assert.fail("must refuse"), (error: unknown) => error);
    assert.match(String(refused), /Paper trading is not the selected Solana mode/);
    assert.equal(quotes, 0, "no paid quote for a refused write-off");
    // Answered as the store's own refusal would be: 409 with the same text.
    assert.ok(refused instanceof SolanaAppRuntimeError && refused.code === "permission");
    assert.equal((await new SolanaTradingStore(f.db, f.scope).paper().get(f.owner))!.positions.length, 1, "the old paper book is untouched");
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("live configuration failure never falls back to a paper fill", async () => {
  const f = await fixture();
  try {
    await f.app.setupPaper(f.scope, { initialCashRaw: "100000000", limits });
    await f.live();
    const app = f.runtime({ env: { MERRYMEN_SOLANA_LIVE_TENANTS: TENANT } });
    await assert.rejects(app.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live" } }), /immutable Solana vault/);
    const book = await new SolanaTradingStore(f.db, f.scope).paper().get(f.owner);
    assert.equal(book!.cashRaw, "100000000"); assert.equal(book!.trades.length, 0); assert.equal(f.controls.sends, 0);
    const status = await app.status(f.scope); assert.equal(status.live.ready, false); assert.match(status.live.blockers.join(" "), /immutable/);
  } finally { f.raw.close(); }
});

test("owner setup persists exact signed bytes before send and survives a lost response with no replacement transaction", async () => {
  const f = await fixture();
  try {
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    const first = await f.app.submitSetup(f.scope, { signedTransactionBase64 });
    assert.equal(first.status, "pending"); assert.equal(f.controls.sends, 1);
    const restarted = f.runtime();
    // Unseen by both providers with its blockhash still valid: the same bytes go out again.
    assert.deepEqual(await restarted.submitSetup(f.scope, { signedTransactionBase64 }), first); assert.equal(f.controls.sends, 2);
    assert.deepEqual(new Set(f.sent), new Set([signedTransactionBase64]), "only the owner's saved bytes are ever sent");
    f.controls.initialized = true; f.controls.finalized = true;
    await assert.rejects(restarted.activateLive(f.scope, { signature: first.signature, sessionSecretKey: Buffer.alloc(32, 99).toString("base64") }), /does not match/);
    await restarted.activateLive(f.scope, { signature: first.signature, sessionSecretKey: f.sessionSeed.toString("base64") });
    const stored = await f.db.prepare("SELECT sealed_seed FROM solana_runtime_sessions").get() as { sealed_seed: string };
    assert.ok(!stored.sealed_seed.includes(f.sessionSeed.toString("base64")));
    assert.equal((await new SolanaTradingStore(f.db, f.scope).session())!.session, f.session);
    // With the limits it read from the vault and checked against the signed ones, which a buy is held to before any quote.
    assert.deepEqual((await new SolanaTradingStore(f.db, f.scope).session())!.limits, { perTradeUsdg: limits.perTradeUsdg, dailyUsdg: limits.dailyUsdg,
      perTradeWsol: limits.perTradeWsol, dailyWsol: limits.dailyWsol });
    assert.equal(f.controls.sends, 2, "a finalized transaction is not sent again");
  } finally { f.raw.close(); }
});

test("changed consent fences a prepared owner permission before any send", async () => {
  const f = await fixture();
  try {
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    const current = (await f.bindings.get(TENANT))!;
    await f.bindings.settings(TENANT, f.owner, current.revision, "paper", limits);
    await assert.rejects(f.app.submitSetup(f.scope, { signedTransactionBase64 }), /settings changed/);
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("owner setup refuses unsigned, substituted and expired messages", async () => {
  const f = await fixture();
  try {
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    await assert.rejects(f.app.submitSetup(f.scope, { signedTransactionBase64: setup.transactionBase64 }), /signature/);
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    f.clock.now += 60_001;
    await assert.rejects(f.app.submitSetup(f.scope, { signedTransactionBase64 }), /expired/);
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("malformed owner confirmations remain unresolved and cannot release a pending permission", async () => {
  const f = await fixture();
  try {
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    await f.app.submitSetup(f.scope, { signedTransactionBase64 });
    f.controls.finalized = true; f.controls.malformed = true;
    await assert.rejects(f.app.submitSetup(f.scope, { signedTransactionBase64 }), /confirmation/);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.status, "pending");
    assert.equal(f.controls.sends, 1);
  } finally { f.raw.close(); }
});

test("never-landed owner setup resolves only after finalized expiry and an unchanged vault proof", async () => {
  const f = await fixture();
  try {
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    await f.app.submitSetup(f.scope, { signedTransactionBase64 });
    f.controls.height = 5000;
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64 })).status, "pending");
    assert.equal(f.controls.sends, 2, "rebroadcast while its blockhash can still land");
    f.controls.height = 5001;
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64 })).status, "failed");
    const saved = await new SolanaTradingStore(f.db, f.scope).setup();
    assert.equal(saved!.expiryProof!.blockHeight, "5001"); assert.equal(saved!.expiryProof!.vaultSequence, null);
    assert.equal(f.controls.sends, 2, "never after it expired"); assert.deepEqual(new Set(f.sent), new Set([signedTransactionBase64]));
    await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
  } finally { f.raw.close(); }
});

/** A live trade at `sequence`, pending as when the owner acts during it. */
async function pendingTrade(f: Awaited<ReturnType<typeof fixture>>, sequence: string) {
  await ensureSolanaTradingSchema(f.db);
  await f.db.prepare("INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(f.scope.tenant, f.scope.owner, `trade-${sequence}`, await deriveSolanaVaultAddress(PROGRAM, f.owner), sequence, `tradesig${sequence}`, "pending", f.clock.now, "1000000",
      JSON.stringify({ intent: { requestId: `trade-${sequence}` } }));
}
const landTrade = (f: Awaited<ReturnType<typeof fixture>>, sequence: string) =>
  f.db.prepare("UPDATE solana_runtime_submissions SET status='finalized' WHERE request_id=?").run(`trade-${sequence}`);

test("a revoke dropped while a trade lands resolves on its unchanged epoch and frees the owner controls (audit wedge)", async () => {
  for (const tradeLands of [false, true]) {
    const f = await fixture();
    try {
      await f.live(); f.controls.initialized = true; f.controls.sequence = 5n;
      await pendingTrade(f, "5");
      const prepared = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
      const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
      assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending");
      // The revoke's only send is lost. The trade lands: the sequence advances, the epoch does not.
      if (tradeLands) { f.controls.sequence = 6n; await landTrade(f, "5"); }
      f.controls.height = 5000;
      assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending", "not expired yet");
      f.controls.height = 5001;
      assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "failed", `tradeLands=${tradeLands}`);
      const saved = (await new SolanaTradingStore(f.db, f.scope).setup())!;
      assert.equal(saved.expiryProof!.sessionEpoch, "1"); assert.equal(saved.expiryProof!.vaultSequence, tradeLands ? "6" : "5");
      assert.deepEqual(new Set(f.sent), new Set([signedTransactionBase64]), "resolved without a replacement transaction");
      // The owner can act again.
      await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    } finally { f.raw.close(); }
  }
});

test("a revoke that did run is never booked failed, even with no receipt", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true;
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.height = 5001; f.controls.epoch = 2n; // the epoch moved: it may have landed
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending");
  } finally { f.raw.close(); }
});

test("one pending revocation at a time: while one is pending a new revoke is refused and the saved record is kept", async () => {
  // A revocation goes beside a pending NON-revoke owner transaction (tests below); beside a pending
  // revocation there is nothing to add, and replacing it would lose the record its outcome is booked from.
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true;
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending");
    const before = (await new SolanaTradingStore(f.db, f.scope).setup())!;
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "revoke" }),
      (error: unknown) => error instanceof SolanaAppRuntimeError && error.code === "pending" && error.message === "Refresh the pending owner transaction before preparing another.");
    assert.deepEqual(await new SolanaTradingStore(f.db, f.scope).setup(), before, "the pending record is not replaced");
    assert.deepEqual(f.sent, [signedTransactionBase64]);
  } finally { f.raw.close(); }
});

/**
 * Owner transactions that land by signature on both providers, as a pending
 * main record and a revocation beside it need (the base fixture answers for
 * whatever bytes were sent last). `observe` may throw for a signature once.
 */
function ownerChain(f: Fixture) {
  const landed = new Map<string, string>(), failOnce = new Set<string>();
  const read: SolanaLiveRead = async (method, params = []) => {
    if (method === "getSignatureStatuses") {
      const signature = (params[0] as string[])[0]!;
      if (failOnce.delete(signature)) throw new Error("provider unavailable");
      return f.response([landed.has(signature) ? { confirmationStatus: "finalized", slot: 1000, err: null } : null]);
    }
    if (method === "getTransaction") { const signature = params[0] as string; return landed.has(signature) ? { version: 0, slot: 1000, transaction: [landed.get(signature), "base64"], meta: { err: null } } : null; }
    return f.read(method, params);
  };
  f.providers.primary = read; f.providers.fallback = read;
  return { land: (signature: string, bytes: string) => { landed.set(signature, bytes); }, failOnce: (signature: string) => { failOnce.add(signature); } };
}
/** A live book holding 90 USDG at the vault's current balances. */
async function cashBook(f: Fixture) {
  await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify({ hwmRaw: "90000000", cashRaw: "90000000",
    wsolRaw: "0", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 }));
  f.controls.cash = 90_000_000n;
}
const PENDING_OWNER = (error: unknown) => error instanceof SolanaAppRuntimeError && error.code === "pending" && error.message === "Refresh the pending owner transaction before preparing another.";
const withdrawals = async (f: Fixture) => (await f.db.prepare("SELECT evidence_id FROM solana_runtime_cashflows WHERE kind='withdraw'").all() as Array<{ evidence_id: string }>).map(row => row.evidence_id);

test("a revocation is prepared and submitted while a withdrawal is pending, beside it: each lands and is booked once by its own signature, and nothing else is prepared meanwhile (owner decision option A)", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered(); f.controls.sequence = 3n; await cashBook(f);
    const chain = ownerChain(f), store = new SolanaTradingStore(f.db, f.scope);
    const withdraw = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    const withdrawSigned = await f.sign(withdraw.transactionBase64);
    const pendingWithdraw = await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: withdrawSigned });
    assert.equal(pendingWithdraw.status, "pending");
    const main = (await store.setup()) as NonNullable<Awaited<ReturnType<SolanaTradingStore["setup"]>>> & { signature: string };
    // Another withdrawal, resume-buys or native withdrawal still waits for it.
    f.controls.vaultNativeLamports = 1_000;
    for (const input of [{ action: "resume-buys" }, { action: "withdraw-sol", amountRaw: "1" }, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1" }] as const) {
      await assert.rejects(f.app.prepareOwnerAction(f.scope, input), PENDING_OWNER, input.action);
    }
    // The revocation does not: it goes beside the withdrawal, whose record stays as it was.
    const revoke = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    assert.equal((await store.revokeSetup())!.beside, main.signature);
    const revokeSigned = await f.sign(revoke.transactionBase64);
    const pendingRevoke = await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: revokeSigned });
    assert.equal(pendingRevoke.status, "pending"); assert.notEqual(pendingRevoke.signature, main.signature);
    assert.deepEqual(await store.setup(), main, "the pending withdrawal's record is kept");
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "revoke" }), PENDING_OWNER, "never a second pending revocation");
    const status = await f.app.status(f.scope);
    assert.deepEqual(status.live.ownerTransaction, { signature: main.signature, status: "pending", kind: "withdraw", revoke: { signature: pendingRevoke.signature, status: "pending", kind: "revoke" } });
    assert.ok(status.live.blockers.includes("An owner transaction is awaiting final confirmation."));
    // Both land: the revocation moves the epoch, the withdrawal the sequence and the cash.
    chain.land(pendingRevoke.signature, revokeSigned); f.controls.epoch = 2n;
    chain.land(main.signature, withdrawSigned); f.controls.sequence = 4n; f.controls.cash = 89_000_000n;
    const settled = (await f.app.status(f.scope)).live.ownerTransaction;
    assert.deepEqual(settled, { signature: main.signature, status: "finalized", kind: "withdraw", revoke: { signature: pendingRevoke.signature, status: "finalized", kind: "revoke" } });
    // Retries, here and after a restart, book nothing again.
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: withdrawSigned })).status, "finalized");
    assert.equal((await f.runtime().submitOwnerAction(f.scope, { signedTransactionBase64: revokeSigned })).status, "finalized");
    await f.runtime().status(f.scope);
    assert.equal((await store.liveBook())!.cashRaw, "89000000");
    assert.deepEqual(await withdrawals(f), [main.signature]);
    assert.deepEqual(new Set(f.sent), new Set([withdrawSigned, revokeSigned]), "only the two signed transactions ever went out");
    // The owner can act again.
    await f.app.prepareOwnerAction(f.scope, { action: "resume-buys" });
    assert.equal(await store.revokeSetup(), null, "a new owner transaction clears the resolved revocation");
  } finally { f.raw.close(); }
});

test("the emergency revoke while a dropped withdrawal can never be proven expired (its sequence moved off-server) still lands and is booked, and trades stay held", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered(); f.controls.sequence = 3n; await cashBook(f);
    const chain = ownerChain(f), store = new SolanaTradingStore(f.db, f.scope);
    const withdraw = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    const withdrawSigned = await f.sign(withdraw.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: withdrawSigned });
    // The withdrawal never landed, its blockhash expired, and a leaked session key traded off-server: the sequence moved.
    f.controls.height = 5001; f.controls.sequence = 4n;
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: withdrawSigned })).status, "pending", "its expiry cannot be proven");
    const revoke = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const revokeSigned = await f.sign(revoke.transactionBase64);
    const pendingRevoke = await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: revokeSigned });
    chain.land(pendingRevoke.signature, revokeSigned); f.controls.epoch = 2n;
    const status = await f.app.status(f.scope);
    assert.equal(status.live.ownerTransaction?.revoke?.status, "finalized");
    assert.equal(status.live.ownerTransaction?.status, "pending", "the withdrawal's record is kept for the operator (solana:resolve owner)");
    await assert.rejects(store.recordSigned({ intent: { owner: f.owner, requestId: "after-revoke" } } as never), /pending owner transaction/);
    assert.deepEqual(await withdrawals(f), []);
  } finally { f.raw.close(); }
});

test("nothing is replayed after a crash between steps: a revocation saved beside a pending withdrawal is resent only as its own bytes, and a crash between booking the two books each once", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered(); f.controls.sequence = 3n; await cashBook(f);
    const chain = ownerChain(f), store = new SolanaTradingStore(f.db, f.scope);
    const withdraw = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    const withdrawSigned = await f.sign(withdraw.transactionBase64);
    const main = await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: withdrawSigned });
    const revoke = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const revokeSigned = await f.sign(revoke.transactionBase64);
    // Saved, and its only send was lost (the fixture's send fails): the process stops here.
    const first = await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: revokeSigned });
    const saved = (await store.revokeSetup())!;
    assert.equal(saved.signedTransactionBase64, revokeSigned); assert.equal(saved.status, "pending");
    // A restarted runtime resends the same bytes while they can land, and saves nothing new.
    const restarted = f.runtime();
    assert.deepEqual(await restarted.submitOwnerAction(f.scope, { signedTransactionBase64: revokeSigned }), first);
    assert.deepEqual(await store.revokeSetup(), saved);
    await assert.rejects(restarted.prepareOwnerAction(f.scope, { action: "revoke" }), PENDING_OWNER);
    // Both land; the first read books the withdrawal, then the revocation's read fails (the process "stops" again).
    chain.land(first.signature, revokeSigned); f.controls.epoch = 2n;
    chain.land(main.signature, withdrawSigned); f.controls.sequence = 4n; f.controls.cash = 89_000_000n;
    chain.failOnce(first.signature);
    const partial = await restarted.status(f.scope);
    assert.equal(partial.live.ownerTransaction?.status, "finalized"); assert.equal(partial.live.ownerTransaction?.revoke?.status, "pending");
    assert.ok(partial.live.blockers.includes("Owner transaction confirmation is unavailable."));
    const done = await f.runtime().status(f.scope);
    assert.equal(done.live.ownerTransaction?.revoke?.status, "finalized");
    assert.equal((await store.liveBook())!.cashRaw, "89000000"); assert.deepEqual(await withdrawals(f), [main.signature]);
    assert.deepEqual(new Set(f.sent), new Set([withdrawSigned, revokeSigned]), "never a replacement transaction");
  } finally { f.raw.close(); }
});

test("a dropped withdrawal whose sequence moved off-server stays pending in the app, and the runtime's own observation carries the expiry evidence an operator books from (live-M2)", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered(); f.controls.sequence = 3n; await cashBook(f);
    const withdraw = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: await f.sign(withdraw.transactionBase64) });
    f.controls.height = 5001; f.controls.sequence = 4n;
    assert.equal((await f.app.status(f.scope)).live.ownerTransaction?.status, "pending");
    const setup = (await new SolanaTradingStore(f.db, f.scope).setup())!;
    assert.deepEqual(await f.app.observeOwnerTransaction(f.read, f.owner, setup),
      { outcome: "pending", seen: false, canLand: false, evidence: { blockHeight: "5001", vaultSequence: "4", sessionEpoch: "1", slot: 1000 } });
    // With the sequence unchanged it is the app's own proof, as before.
    f.controls.sequence = 3n;
    assert.deepEqual(await f.app.observeOwnerTransaction(f.read, f.owner, setup),
      { outcome: "expired", proof: { reason: "blockhash-expired", blockHeight: "5001", vaultSequence: "3", sessionEpoch: "1", slot: 1000 }, fresh: 1000 });
  } finally { f.raw.close(); }
});

test("an owner transaction's prior vault state is read no earlier than the slot the app last booked, so a lagging provider cannot make a dropped one unprovable (live-M2)", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered(); await cashBook(f);
    const reads: Array<{ method: string; minContextSlot?: number }> = [];
    f.providers.primary = async (method, params = []) => {
      if (method === "getAccountInfo" && params[0] === f.vault) reads.push({ method, minContextSlot: (params[1] as { minContextSlot?: number }).minContextSlot });
      return f.read(method, params);
    };
    await f.db.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=?").run(JSON.stringify({ ...JSON.parse((await f.db.prepare("SELECT book_json FROM solana_runtime_live_books").get() as { book_json: string }).book_json), slot: 990 }), TENANT);
    await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    assert.deepEqual(reads.at(-1), { method: "getAccountInfo", minContextSlot: 990 });
    // A provider still behind what the app booked is refused, never trusted as the prior state.
    await f.db.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=?").run(JSON.stringify({ ...JSON.parse((await f.db.prepare("SELECT book_json FROM solana_runtime_live_books").get() as { book_json: string }).book_json), slot: 1005 }), TENANT);
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "resume-buys" }));
    await assert.rejects(f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session }), /could not be read/);
    assert.deepEqual(reads.at(-1), { method: "getAccountInfo", minContextSlot: 1005 });
  } finally { f.raw.close(); }
});

/**
 * An owner withdrawal signed outside Merrymen (solana-recover), and both providers' finalized receipt of it with the vault token
 * account's balances. `signed`: these signed bytes instead (a wallet that broadcast an in-app prepared withdrawal itself).
 */
async function outsideWithdrawal(f: Fixture, mint: string, amount: bigint, balance: [bigint, bigint], signed?: string) {
  const program = mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM, vaultToken = mint === SOLANA_USDG_MINT ? f.cashAta : f.wsolAta;
  const instruction = buildWithdrawSolanaVaultInstruction({ programAddress: PROGRAM, vault: f.vault, owner: f.owner, mint, tokenProgram: program, vaultToken,
    ownerToken: await deriveSolanaAta(f.owner, mint, program), amount });
  const unsigned = getBase64EncodedWireTransaction(compileTransaction(setTransactionMessageLifetimeUsingBlockhash({ blockhash: key(43) as unknown as Blockhash, lastValidBlockHeight: 5000n },
    setTransactionMessageFeePayer(kitAddress(f.owner), appendTransactionMessageInstructions([instruction], createTransactionMessage({ version: 0 }))))));
  const wire = signed ?? await f.sign(unsigned), decoded = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
  const signature = getBase58Decoder().decode(Object.values(decoded.signatures)[0]!);
  const index = getCompiledTransactionMessageDecoder().decode(decoded.messageBytes).staticAccounts.map(String).indexOf(vaultToken);
  const entry = (amountRaw: bigint) => [{ accountIndex: index, mint, owner: f.vault, programId: program, uiTokenAmount: { amount: amountRaw.toString(), decimals: 6 } }];
  const receipt = { slot: 1000, version: 0, transaction: [wire, "base64"], meta: { err: null, fee: 5000, preTokenBalances: entry(balance[0]), postTokenBalances: entry(balance[1]), innerInstructions: [] } };
  const read: SolanaLiveRead = async (method, params = []) => method === "getTransaction" && params[0] === signature ? receipt : f.read(method, params);
  f.providers.primary = read; f.providers.fallback = read;
  return signature;
}

test("after solana-recover took the vault's USDG outside Merrymen, status holds with a clear message, a withdrawal of what the vault no longer holds is refused before signing, and recording that withdrawal from its own transaction restores trading and exits", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered(); await cashBook(f);
    // The owner's own key withdrew all 90 USDG; the book still records it.
    f.controls.cash = 0n;
    const held = await f.app.status(f.scope);
    assert.ok(held.live.blockers.includes(SOLANA_STATUS_BELOW_BOOK), held.live.blockers.join(" | ")); assert.equal(held.live.canExit, false);
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" }),
      (error: unknown) => error instanceof SolanaAppRuntimeError && error.message === SOLANA_WITHDRAW_BELOW_BOOK);
    assert.equal(await new SolanaTradingStore(f.db, f.scope).setup(), null, "nothing was prepared");
    const signature = await outsideWithdrawal(f, SOLANA_USDG_MINT, 90_000_000n, [90_000_000n, 0n]);
    // A malformed list is refused before any read.
    for (const signatures of [[], ["short"], [signature, signature], Array(9).fill(signature)]) {
      await assert.rejects(f.app.recordExternalWithdrawals(f.scope, { signatures }), (error: unknown) => error instanceof SolanaAppRuntimeError && error.code === "invalid");
    }
    const recorded = await f.app.recordExternalWithdrawals(f.scope, { signatures: [signature] });
    assert.deepEqual(recorded.booked, [{ signature, mint: SOLANA_USDG_MINT, amountRaw: "90000000" }]);
    assert.equal(recorded.book.cashRaw, "0"); assert.equal(recorded.book.hwmRaw, "0");
    const ready = await f.app.status(f.scope);
    assert.ok(!ready.live.blockers.includes(SOLANA_STATUS_BELOW_BOOK)); assert.equal(ready.live.canExit, true, ready.live.blockers.join(" | "));
    // Recorded once.
    await assert.rejects(f.app.recordExternalWithdrawals(f.scope, { signatures: [signature] }), /already recorded/);
    // A deposit after it is booked from both providers' agreeing read, as before.
    f.controls.cash = 5_000_000n;
    await f.app.status(f.scope);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).liveBook())!.cashRaw, "5000000");
    assert.equal(f.controls.sends, 0, "nothing is ever signed or sent by recording");
  } finally { f.raw.close(); }
});

test("a deposit no status read booked yet, swept with the rest by solana-recover, is booked from the sweep's own transaction: the book matches the vault again and trading resumes", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered(); await cashBook(f);
    // 5 USDG arrived and solana-recover took all 95 before any status read.
    const signature = await outsideWithdrawal(f, SOLANA_USDG_MINT, 95_000_000n, [95_000_000n, 0n]);
    f.controls.cash = 0n;
    assert.ok((await f.app.status(f.scope)).live.blockers.includes(SOLANA_STATUS_BELOW_BOOK));
    const recorded = await f.app.recordExternalWithdrawals(f.scope, { signatures: [signature] });
    assert.deepEqual(recorded.booked, [{ signature, mint: SOLANA_USDG_MINT, amountRaw: "95000000" }]);
    assert.equal(recorded.book.cashRaw, "0"); assert.equal(recorded.book.hwmRaw, "0");
    const ready = await f.app.status(f.scope);
    assert.ok(!ready.live.blockers.includes(SOLANA_STATUS_BELOW_BOOK)); assert.equal(ready.live.canExit, true, ready.live.blockers.join(" | "));
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("an in-app withdrawal the wallet broadcast itself, recorded as made outside Merrymen first, is booked once: the page's resubmit of its bytes is refused as not saved", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered(); f.controls.sequence = 3n; await cashBook(f);
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    const signed = await f.sign(prepared.transactionBase64);
    // The wallet sent it itself and it landed; the page's submit never reached the server.
    const signature = await outsideWithdrawal(f, SOLANA_USDG_MINT, 1_000_000n, [90_000_000n, 89_000_000n], signed);
    f.controls.cash = 89_000_000n; f.controls.sequence = 4n;
    const recorded = await f.app.recordExternalWithdrawals(f.scope, { signatures: [signature] });
    assert.equal(recorded.book.cashRaw, "89000000");
    await assert.rejects(f.app.submitOwnerAction(f.scope, { signedTransactionBase64: signed }),
      (error: unknown) => error instanceof SolanaAppRuntimeError && error.code === "not-saved" && error.message === SOLANA_WITHDRAWAL_RECORDED_OUTSIDE);
    await f.app.status(f.scope);
    const store = new SolanaTradingStore(f.db, f.scope);
    assert.equal((await store.liveBook())!.cashRaw, "89000000"); assert.equal((await store.setup())!.signature, undefined);
    assert.equal(f.controls.sends, 0, "nothing was sent");
  } finally { f.raw.close(); }
});

test("a withdrawal made outside Merrymen recorded while an in-app one is prepared can never wedge the account: the in-app one, now above the book, is refused before it is saved or sent", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered(); f.controls.sequence = 3n; await cashBook(f);
    // The owner prepares a 90 USDG withdrawal: the whole book, and what the vault holds.
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "90000000" });
    // Meanwhile 60 USDG left outside Merrymen and a 60 USDG deposit refilled the vault; the owner records the withdrawal.
    const outside = await outsideWithdrawal(f, SOLANA_USDG_MINT, 60_000_000n, [90_000_000n, 30_000_000n]);
    f.controls.sequence = 4n;
    assert.equal((await f.app.recordExternalWithdrawals(f.scope, { signatures: [outside] })).book.cashRaw, "30000000");
    // The prepared 90 USDG is now above the book: its signed bytes are refused, never saved pending, never sent.
    await assert.rejects(f.app.submitOwnerAction(f.scope, { signedTransactionBase64: await f.sign(prepared.transactionBase64) }),
      (error: unknown) => error instanceof SolanaAppRuntimeError && error.code === "not-saved" && error.message === SOLANA_WITHDRAWAL_ABOVE_BOOK);
    const store = new SolanaTradingStore(f.db, f.scope);
    assert.equal((await store.setup())!.signature, undefined); assert.equal(f.controls.sends, 0);
    // Nothing is held: no owner transaction awaits confirmation, and the owner prepares again.
    f.providers.primary = null; f.providers.fallback = null;
    assert.equal((await f.app.status(f.scope)).live.ownerTransaction ?? null, null);
    assert.ok((await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "30000000" })).transactionBase64);
  } finally { f.raw.close(); }
});

test("one asset above its book and the other below: a withdrawal prepare books no inflow, offers only what the vault holds, and never fails on the store's below-book refusal", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered();
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify({ hwmRaw: "100000000", cashRaw: "90000000",
      wsolRaw: "50000000", costBasisUsdgRaw: "10000000", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 }));
    f.controls.cash = 89_000_000n; f.controls.wsol = 50_000_007n;
    await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "50000000" });
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "90000000" }),
      (error: unknown) => error instanceof SolanaAppRuntimeError && error.message === SOLANA_WITHDRAW_BELOW_BOOK);
    await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "89000000" });
    const book = (await new SolanaTradingStore(f.db, f.scope).liveBook())!;
    assert.equal(book.quarantinedWsolRaw, undefined, "nothing is booked while an asset is short"); assert.equal(book.cashRaw, "90000000");
  } finally { f.raw.close(); }
});

test("a withdrawal prepare never fails on the inflow read: one raw token above the book while a provider is down still prepares what the book covers", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered(); await cashBook(f);
    // Anyone sent the vault one raw USDG; the fallback cannot answer the finalized balance read.
    f.controls.cash = 90_000_001n;
    f.providers.fallback = async (method, params = []) => { if (method === "getMultipleAccounts") throw new SolanaRpcError("network"); return f.read(method, params); };
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    assert.ok(prepared.transactionBase64);
    const store = new SolanaTradingStore(f.db, f.scope);
    assert.equal((await store.liveBook())!.cashRaw, "90000000", "the unagreed excess is not booked");
    // Never more than the book while the excess is unbooked.
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "90000001" }), /exceeds the reconciled vault balance/);
    // Once both providers answer, the inflow is booked and can be withdrawn too.
    f.providers.fallback = null;
    await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "90000001" });
    assert.equal((await store.liveBook())!.cashRaw, "90000001");
  } finally { f.raw.close(); }
});

test("an inflow is booked only when both providers agree on the finalized balances: one provider's phantom deposit never raises the book", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered(); await cashBook(f);
    // The primary reports 5 USDG more than the fallback.
    f.controls.cash = 95_000_000n;
    f.providers.fallback = async (method, params = []) => {
      if (method !== "getMultipleAccounts") return f.read(method, params);
      const saved = f.controls.cash; f.controls.cash = 90_000_000n;
      try { return await f.read(method, params); } finally { f.controls.cash = saved; }
    };
    await f.app.status(f.scope);
    const store = new SolanaTradingStore(f.db, f.scope);
    assert.equal((await store.liveBook())!.cashRaw, "90000000"); assert.equal((await store.liveBook())!.hwmRaw, "90000000");
    // Once both agree, it is a deposit.
    f.providers.fallback = null;
    await f.app.status(f.scope);
    assert.equal((await store.liveBook())!.cashRaw, "95000000"); assert.equal((await store.liveBook())!.hwmRaw, "95000000");
  } finally { f.raw.close(); }
});

test("a revocation beside a pending permission registration: whichever lands, both resolve, and a registration with a landed revocation is never activated", async () => {
  for (const lands of ["revoke", "registration"] as const) {
    const f = await fixture();
    try {
      await f.live(); f.controls.initialized = true;
      const chain = ownerChain(f), store = new SolanaTradingStore(f.db, f.scope);
      const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
      const setupSigned = await f.sign(setup.transactionBase64);
      const registration = await f.app.submitSetup(f.scope, { signedTransactionBase64: setupSigned });
      const revoke = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
      assert.equal((await store.revokeSetup())!.beside, registration.signature);
      const revokeSigned = await f.sign(revoke.transactionBase64);
      const pendingRevoke = await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: revokeSigned });
      // One of them lands (the epoch moves once); both blockhashes then expire.
      if (lands === "revoke") chain.land(pendingRevoke.signature, revokeSigned); else chain.land(registration.signature, setupSigned);
      f.controls.epoch = 2n; f.controls.height = 5001;
      await f.app.status(f.scope); const after = (await f.app.status(f.scope)).live.ownerTransaction;
      assert.deepEqual([after?.status, after?.revoke?.status], lands === "revoke" ? ["failed", "finalized"] : ["finalized", "failed"], lands);
      const activation = f.app.activateLive(f.scope, { signature: registration.signature, sessionSecretKey: f.sessionSeed.toString("base64") });
      if (lands === "revoke") await assert.rejects(activation, /failed/);
      else assert.equal((await activation).registered, true);
    } finally { f.raw.close(); }
  }
});

test("Revoke pressed again after the revocation beside a pending registration landed is refused and the landed record kept: the registration landing later is never activated, and a dropped one still resolves", async () => {
  for (const then of ["registration-lands", "registration-dropped"] as const) {
    const f = await fixture();
    try {
      await f.live(); f.controls.initialized = true;
      const chain = ownerChain(f), store = new SolanaTradingStore(f.db, f.scope);
      const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
      const setupSigned = await f.sign(setup.transactionBase64);
      const registration = await f.app.submitSetup(f.scope, { signedTransactionBase64: setupSigned });
      const revoke = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
      const revokeSigned = await f.sign(revoke.transactionBase64);
      const pendingRevoke = await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: revokeSigned });
      chain.land(pendingRevoke.signature, revokeSigned); f.controls.epoch = 2n;
      const landed = (await f.app.status(f.scope)).live.ownerTransaction;
      assert.deepEqual([landed?.status, landed?.revoke?.status], ["pending", "finalized"]);
      const kept = await store.revokeSetup();
      // The second press is refused before anything is read or saved; the landed revocation's record stays.
      await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "revoke" }),
        (error: unknown) => error instanceof SolanaAppRuntimeError && error.code === "pending" && error.message === SOLANA_REVOKE_ALREADY_LANDED);
      assert.deepEqual(await store.revokeSetup(), kept);
      if (then === "registration-lands") {
        chain.land(registration.signature, setupSigned); f.controls.epoch = 3n;
        assert.equal((await f.app.status(f.scope)).live.ownerTransaction?.status, "finalized");
        await assert.rejects(f.app.activateLive(f.scope, { signature: registration.signature, sessionSecretKey: f.sessionSeed.toString("base64") }),
          (error: unknown) => error instanceof SolanaAppRuntimeError && error.code === "permission" && error.message === SOLANA_REGISTERED_AFTER_REVOKE);
        assert.equal(await store.session(), null, "no session key is stored after the owner's landed revocation");
        // Its session is live on Solana until it expires: the owner is told, and Revoke prepares again, in the main slot.
        const told = await f.app.status(f.scope);
        assert.ok(told.live.blockers.includes(SOLANA_STATUS_REGISTERED_AFTER_REVOKE), told.live.blockers.join(" | "));
        await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
        assert.equal((await store.setup())!.kind, "revoke"); assert.equal(await store.revokeSetup(), null);
        assert.ok(!(await f.app.status(f.scope)).live.blockers.includes(SOLANA_STATUS_REGISTERED_AFTER_REVOKE));
      } else {
        // Dropped: its blockhash expired with the epoch moved once, by the kept revocation.
        f.controls.height = 5001;
        assert.equal((await f.app.status(f.scope)).live.ownerTransaction?.status, "failed");
      }
    } finally { f.raw.close(); }
  }
});

test("a registration that landed after the revocation beside it while the providers keep disagreeing about it is revoked in the app again: status says it is live, Revoke prepares beside it, and the landed revocation is kept", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true;
    const chain = ownerChain(f), store = new SolanaTradingStore(f.db, f.scope);
    const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const setupSigned = await f.sign(setup.transactionBase64);
    const registration = await f.app.submitSetup(f.scope, { signedTransactionBase64: setupSigned });
    const revoke = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const revokeSigned = await f.sign(revoke.transactionBase64);
    const first = await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: revokeSigned });
    chain.land(first.signature, revokeSigned); f.controls.epoch = 2n;
    await f.app.status(f.scope);
    const landed = (await store.revokeSetup())!;
    assert.equal(landed.status, "finalized");
    // The registration lands after it (epoch 3, its session set on the vault), but one provider never sees it: it stays pending.
    chain.land(registration.signature, setupSigned); f.controls.epoch = 3n;
    const both = f.providers.primary!;
    f.providers.fallback = async (method, params = []) => method === "getSignatureStatuses" && (params[0] as string[])[0] === registration.signature ? f.response([null])
      : method === "getTransaction" && params[0] === registration.signature ? null : both(method, params);
    const live = await f.app.status(f.scope);
    assert.equal(live.live.ownerTransaction?.status, "pending");
    assert.deepEqual(live.live.ownerTransaction?.revoke, { signature: first.signature, status: "finalized", kind: "revoke", revokeAgain: true });
    assert.ok(live.live.blockers.includes(SOLANA_STATUS_REGISTERED_AFTER_REVOKE), live.live.blockers.join(" | "));
    // Revoke is prepared beside it again; the landed revocation goes with it as history. (A later slot's blockhash: the
    // same bytes as the landed one are never accepted.)
    const sameBytes = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    await assert.rejects(f.app.submitOwnerAction(f.scope, { signedTransactionBase64: await f.sign(sameBytes.transactionBase64) }),
      (error: unknown) => error instanceof SolanaAppRuntimeError && error.code === "not-saved" && /already landed/.test(error.message));
    f.providers.primary = async (method, params = []) => method === "getLatestBlockhash" ? f.response({ blockhash: key(44), lastValidBlockHeight: 5000 }) : both(method, params);
    const again = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const prepared = (await store.revokeSetup())!;
    assert.equal(prepared.beside, registration.signature); assert.equal(prepared.priorSessionEpoch, "3");
    assert.deepEqual(prepared.landed?.map(item => [item.signature, item.status]), [[first.signature, "finalized"]]);
    const againSigned = await f.sign(again.transactionBase64);
    const second = await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: againSigned });
    assert.notEqual(second.signature, first.signature);
    // It lands: the vault's session is cleared (revoke_all) at epoch 4. Nothing is live, so nothing more to revoke.
    chain.land(second.signature, againSigned);
    const cleared = Buffer.from(f.state(4n)); cleared.fill(0, 42, 74);
    f.extra.set(f.vault, account(cleared, PROGRAM, false, rentExempt(SOLANA_VAULT_ACCOUNT_SIZE)));
    const revoked = await f.app.status(f.scope);
    assert.deepEqual([revoked.live.ownerTransaction?.status, revoked.live.ownerTransaction?.revoke?.status, revoked.live.ownerTransaction?.revoke?.revokeAgain], ["pending", "finalized", undefined]);
    assert.ok(!revoked.live.blockers.includes(SOLANA_STATUS_REGISTERED_AFTER_REVOKE), revoked.live.blockers.join(" | "));
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "revoke" }),
      (error: unknown) => error instanceof SolanaAppRuntimeError && error.code === "pending" && error.message === SOLANA_REVOKE_ALREADY_LANDED);
    assert.deepEqual((await store.revokeSetup())!.landed?.map(item => item.signature), [first.signature], "both landed revocations are on record");
    // The providers finally agree it landed: it is never activated.
    f.providers.fallback = both; f.providers.primary = both;
    assert.equal((await f.app.status(f.scope)).live.ownerTransaction?.status, "finalized");
    await assert.rejects(f.app.activateLive(f.scope, { signature: registration.signature, sessionSecretKey: f.sessionSeed.toString("base64") }),
      (error: unknown) => error instanceof SolanaAppRuntimeError && error.message === SOLANA_REGISTERED_AFTER_REVOKE);
    assert.deepEqual(new Set(f.sent), new Set([setupSigned, revokeSigned, againSigned]), "only the three signed transactions ever went out");
  } finally { f.raw.close(); }
});

test("activating a permission never deletes a revocation the owner is still signing beside it: activation waits, and once that revocation is submitted the permission is never activated", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true;
    const chain = ownerChain(f), store = new SolanaTradingStore(f.db, f.scope);
    const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const setupSigned = await f.sign(setup.transactionBase64);
    const registration = await f.app.submitSetup(f.scope, { signedTransactionBase64: setupSigned });
    // The owner prepares a revocation beside it and opens the wallet; meanwhile the registration lands.
    const revoke = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    chain.land(registration.signature, setupSigned); f.controls.epoch = 2n;
    const activate = () => f.app.activateLive(f.scope, { signature: registration.signature, sessionSecretKey: f.sessionSeed.toString("base64") });
    await assert.rejects(activate(), (error: unknown) => error instanceof SolanaTradingStoreError && error.message === SOLANA_REVOKE_PREPARED_BESIDE);
    assert.equal(await store.session(), null);
    // The owner's signed revocation is still accepted, and from then on the permission is never activated.
    const submitted = await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: await f.sign(revoke.transactionBase64) });
    assert.equal(submitted.status, "pending");
    assert.equal((await store.revokeSetup())!.signature, submitted.signature);
    await assert.rejects(activate(), /revocation was signed after this permission/);
    assert.equal(await store.session(), null);
  } finally { f.raw.close(); }
});

test("a registration that landed after a revocation made outside Merrymen is never activated: the epoch moved twice since it was prepared", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true;
    const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const setupSigned = await f.sign(setup.transactionBase64);
    const registration = await f.app.submitSetup(f.scope, { signedTransactionBase64: setupSigned });
    // revoke_all from another wallet (epoch 1 -> 2), then the registration lands (-> 3), its session buy-paused.
    f.controls.finalized = true; f.controls.epoch = 3n;
    const told = await f.app.status(f.scope);
    assert.equal(told.live.ownerTransaction?.status, "finalized");
    assert.ok(told.live.blockers.includes(SOLANA_STATUS_REGISTERED_AFTER_REVOKE), told.live.blockers.join(" | "));
    await assert.rejects(f.app.activateLive(f.scope, { signature: registration.signature, sessionSecretKey: f.sessionSeed.toString("base64") }),
      (error: unknown) => error instanceof SolanaAppRuntimeError && error.code === "permission" && error.message === SOLANA_REGISTERED_AFTER_REVOKE);
    assert.equal(await new SolanaTradingStore(f.db, f.scope).session(), null);
    // Only its own landing moved the epoch: nothing to tell, and it is activated.
    f.controls.epoch = 2n;
    assert.ok(!(await f.app.status(f.scope)).live.blockers.includes(SOLANA_STATUS_REGISTERED_AFTER_REVOKE));
    assert.equal((await f.app.activateLive(f.scope, { signature: registration.signature, sessionSecretKey: f.sessionSeed.toString("base64") })).registered, true);
  } finally { f.raw.close(); }
});

test("a session registration dropped while a trade advanced the vault resolves on the epoch alone", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true;
    const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    await f.app.submitSetup(f.scope, { signedTransactionBase64 });
    f.controls.height = 5001; f.controls.sequence = 1n;
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64 })).status, "failed");
    assert.equal(f.controls.sends, 1);
    const again = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const resigned = await f.sign(again.transactionBase64);
    await f.app.submitSetup(f.scope, { signedTransactionBase64: resigned });
    f.controls.height = 5002; f.controls.epoch = 2n; // a registration that ran always moves the epoch
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64: resigned })).status, "pending");
  } finally { f.raw.close(); }
});

test("a dropped withdrawal resolves on an unchanged sequence, and no trade can move it in between", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; f.controls.sequence = 3n;
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.priorSequence, "3");
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.height = 5001; f.controls.epoch = 2n; // the epoch is irrelevant to a withdrawal
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "failed");
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.expiryProof!.vaultSequence, "3");
  } finally { f.raw.close(); }
  const g = await fixture();
  try {
    await g.live(); g.controls.initialized = true; g.controls.sequence = 3n;
    const prepared = await g.app.prepareOwnerAction(g.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    const signedTransactionBase64 = await g.sign(prepared.transactionBase64);
    await g.app.submitOwnerAction(g.scope, { signedTransactionBase64 });
    g.controls.height = 5001; g.controls.sequence = 4n; // a moved sequence may be this withdrawal
    assert.equal((await g.app.submitOwnerAction(g.scope, { signedTransactionBase64 })).status, "pending");
  } finally { g.raw.close(); }
});

test("an owner expiry is booked at the lowest provider slot: one provider's inflated slot never becomes the owner read floor that refuses revoke", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.sequence = 2n;
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "resume-buys" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.height = 5001;
    // The primary answers its finalized vault read at an inflated context slot; everything else is honest.
    let inflated = 1_000_000_000;
    f.providers.primary = async (method, params = []) => {
      const answer = await f.read(method, params);
      return method === "getAccountInfo" && params[0] === f.vault && (params[1] as { commitment?: string }).commitment === "finalized"
        ? { ...(answer as object), context: { slot: inflated } } : answer;
    };
    // Far past the other provider's fresh finalized slot: not booked.
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending");
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.status, "pending");
    // Within the skew: booked, at the honest provider's lower slot.
    inflated = 1100;
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "failed");
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.expiryProof!.slot, 1000);
    // With both providers honest again, the emergency revoke still prepares (its read floor is the honest slot).
    f.providers.primary = null;
    assert.ok((await f.app.prepareOwnerAction(f.scope, { action: "revoke" })).transactionBase64);
  } finally { f.raw.close(); }
});

test("a dropped resume-buys resolves after expiry and leaves the off-chain breaker paused", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; f.controls.sequence = 2n;
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "resume-buys" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.height = 5001; f.controls.sequence = 3n;
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "failed");
    await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
  } finally { f.raw.close(); }
});

test("a resume-buys that lands after a revocation prepared beside it never re-arms buying: the breaker stays paused, status says why, and a new resume restarts buys", async () => {
  for (const lands of ["revoke-first", "resume-first"] as const) {
    const f = await fixture();
    try {
      await f.live(); f.controls.initialized = true; await f.registered(); await cashBook(f);
      const store = new SolanaTradingStore(f.db, f.scope), chain = ownerChain(f);
      const book = (await store.liveBook())!; book.buyPaused = true;
      await f.db.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify(book), TENANT, f.owner);
      const resume = await f.app.prepareOwnerAction(f.scope, { action: "resume-buys" });
      const resumeSigned = await f.sign(resume.transactionBase64);
      const pendingResume = await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: resumeSigned });
      const revoke = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
      assert.equal((await store.revokeSetup())!.beside, pendingResume.signature);
      const revokeSigned = await f.sign(revoke.transactionBase64);
      const pendingRevoke = await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: revokeSigned });
      const order = lands === "revoke-first" ? [[pendingRevoke.signature, revokeSigned], [pendingResume.signature, resumeSigned]] : [[pendingResume.signature, resumeSigned], [pendingRevoke.signature, revokeSigned]];
      for (const [signature, bytes] of order) {
        chain.land(signature!, bytes!); if (signature === pendingRevoke.signature) f.controls.epoch = 2n;
        await f.app.status(f.scope);
      }
      const after = await f.app.status(f.scope);
      assert.deepEqual([after.live.ownerTransaction?.status, after.live.ownerTransaction?.revoke?.status], ["finalized", "finalized"], lands);
      assert.equal((await store.liveBook())!.buyPaused, true, `${lands}: the revocation was the owner's later word`);
      assert.ok(after.live.warnings.includes(SOLANA_RESUMED_AFTER_REVOKE), after.live.warnings.join(" | "));
      assert.ok(after.live.blockers.includes("The buying drawdown breaker is paused; exits remain available."));
      // A new resume-buys restarts buys.
      const again = await f.app.prepareOwnerAction(f.scope, { action: "resume-buys" });
      const againSigned = await f.sign(again.transactionBase64);
      const pendingAgain = await f.app.submitOwnerAction(f.scope, { signedTransactionBase64: againSigned });
      chain.land(pendingAgain.signature, againSigned);
      const resumed = await f.app.status(f.scope);
      assert.equal((await store.liveBook())!.buyPaused, false);
      assert.ok(!resumed.live.warnings.includes(SOLANA_RESUMED_AFTER_REVOKE));
    } finally { f.raw.close(); }
  }
});

test("one raw WSOL sent to the vault no longer freezes exits or owner withdrawals (audit dust)", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered();
    const book = { hwmRaw: "100000000", cashRaw: "90000000", wsolRaw: "50000000", costBasisUsdgRaw: "10000000", realizedPnlUsdgRaw: "0",
      networkFeesLamports: "10000", slot: 900, updatedAtMs: 999_000 };
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
    // Anyone can transfer one base unit of WSOL (or SOL then SyncNative) to the vault's token account.
    f.controls.cash = 90_000_000n; f.controls.wsol = 50_000_001n;
    const status = await f.app.status(f.scope);
    assert.equal(status.live.canExit, true, status.live.blockers.join(" | "));
    assert.ok(!status.live.blockers.some(b => /balances/.test(b)));
    assert.deepEqual(status.live.tradable, { cashUsdg: "90000000", wsolRaw: "50000000", quarantinedWsolRaw: "1" });
    const booked = (await new SolanaTradingStore(f.db, f.scope).liveBook())!;
    assert.equal(booked.quarantinedWsolRaw, "1"); assert.equal(booked.wsolRaw, "50000000"); assert.equal(booked.hwmRaw, "100000000");
    // Both in-app withdrawals prepare, and the WSOL one can take the stranger's unit too.
    await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "50000001" });
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "50000002" }), /exceeds/);
    // A balance below the book still blocks: that is never a stranger's gift.
    f.controls.wsol = 49_999_999n;
    const short = await f.app.status(f.scope);
    assert.equal(short.live.canExit, false); assert.ok(short.live.blockers.includes(STATUS_BELOW_BOOK));
  } finally { f.raw.close(); }
});

test("below its book with a stranger's WSOL above it, status says so and books nothing, with no two-provider booking read (audit G3-3, mixed state)", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered();
    const book = { hwmRaw: "100000000", cashRaw: "90000000", wsolRaw: "50000000", costBasisUsdgRaw: "10000000", realizedPnlUsdgRaw: "0",
      networkFeesLamports: "10000", slot: 900, updatedAtMs: 999_000 };
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
    // 20 USDG left with the recovery tool, then one raw WSOL from a stranger (anyone can send it).
    f.controls.cash = 70_000_000n; f.controls.wsol = 50_000_001n;
    // The second provider's finalized balance reads: asked only to book an inflow, which nothing short ever is.
    let bookingReads = 0;
    f.providers.fallback = async (method, params = []) => {
      if (method === "getMultipleAccounts" && (params[0] as string[])[0] === f.cashAta && (params[1] as { commitment?: string }).commitment === "finalized") bookingReads++;
      return f.read(method, params);
    };
    const status = await f.app.status(f.scope);
    assert.ok(status.live.blockers.includes(STATUS_BELOW_BOOK)); assert.equal(status.live.canExit, false);
    assert.deepEqual((await new SolanaTradingStore(f.db, f.scope).liveBook())!, book, "nothing is booked while a balance is short");
    assert.equal(bookingReads, 0, "no two-provider read to book an inflow while a balance is short");
  } finally { f.raw.close(); }
});

test("an in-app withdrawal that landed is not called a vault below its book while it awaits final confirmation, nor is a balance read from before the book", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.sequence = 3n; f.controls.cash = 90_000_000n;
    const book = { hwmRaw: "90000000", cashRaw: "90000000", wsolRaw: "0", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    // It landed (confirmed, not finalized): the vault holds 1 USDG less than the book until both providers' finalized receipts book it.
    f.controls.cash = 89_000_000n;
    const settling = await f.app.status(f.scope);
    assert.ok(settling.live.blockers.includes("An owner transaction is awaiting final confirmation."), settling.live.blockers.join(" | "));
    assert.ok(!settling.live.blockers.includes(STATUS_BELOW_BOOK), "its own landing is not tokens leaving outside Merrymen");
    assert.equal(settling.live.canExit, false, "trading and exits still wait for it");
    // Finalized on both providers: booked, and the vault matches its book.
    f.providers.primary = withholding(f); f.providers.fallback = withholding(f);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized");
    f.providers.primary = null; f.providers.fallback = null; f.controls.sequence = 4n;
    assert.ok(!(await f.app.status(f.scope)).live.blockers.some(item => item === STATUS_BELOW_BOOK || item === SOLANA_STATUS_BEHIND_BOOK));
    // Nothing settling, and the vault really short of its book: said as such.
    f.controls.cash = 88_000_000n;
    assert.ok((await f.app.status(f.scope)).live.blockers.includes(STATUS_BELOW_BOOK));
    // A book recorded at a later slot than the balances read (a lagging provider): no shortfall can be shown, and trading still waits.
    const later = (await new SolanaTradingStore(f.db, f.scope).liveBook())!;
    await f.db.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify({ ...later, slot: 1001 }), TENANT, f.owner);
    const behind = await f.app.status(f.scope);
    assert.ok(behind.live.blockers.includes(SOLANA_STATUS_BEHIND_BOOK)); assert.ok(!behind.live.blockers.includes(STATUS_BELOW_BOOK));
    assert.equal(behind.live.ready, false);
  } finally { f.raw.close(); }
});

test("a shortfall an operator wrote off frees automated exits again, with buying paused for the owner's review (audit G3-3)", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.cash = 70_000_000n; f.controls.wsol = 50_000_000n;
    const book = { hwmRaw: "100000000", cashRaw: "90000000", wsolRaw: "50000000", costBasisUsdgRaw: "10000000", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
    const held = await f.app.status(f.scope);
    assert.ok(held.live.blockers.includes(STATUS_BELOW_BOOK)); assert.equal(held.live.canExit, false);
    // The operator's decision, recorded first by the resolve tool, then the write-off on two providers' reading.
    await ensureSolanaShortfallSchema(f.db, false);
    await f.db.prepare("INSERT INTO solana_operator_shortfalls(id,tenant,owner,slot,cash_usdg,wsol_raw,operator,reason,evidence_json,approved_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("decision-1", TENANT, f.owner, 1000, "70000000", "50000000", "milla", "issuer seized 20 USDG", "{}", f.clock.now);
    await new SolanaTradingStore(f.db, f.scope, () => f.clock.now).writeOffShortfall({ slot: 1000, cashUsdg: "70000000", wsolRaw: "50000000", observedAtMs: f.clock.now, commitment: "finalized" }, "decision-1");
    const freed = await f.app.status(f.scope);
    assert.ok(!freed.live.blockers.includes(STATUS_BELOW_BOOK), freed.live.blockers.join(" | "));
    assert.equal(freed.live.canExit, true, freed.live.blockers.join(" | ")); assert.equal(freed.live.ready, false, "buying waits for the owner");
    assert.ok(freed.live.blockers.includes("The buying drawdown breaker is paused; exits remain available."));
    assert.deepEqual([freed.live.book!.cashRaw, freed.live.book!.hwmRaw, freed.live.book!.realizedPnlUsdgRaw], ["70000000", "100000000", "-20000000"]);
  } finally { f.raw.close(); }
});

/** A provider that answers the vault's two-account balance read (USDG, WSOL) as `change` says, and everything else honestly. */
function balanceRead(f: Fixture, change: (answer: { context: { slot: number }; value: unknown[] }) => unknown): SolanaLiveRead {
  return async (method, params = []) => {
    const answer = await f.read(method, params);
    const keys = params[0] as string[];
    return method === "getMultipleAccounts" && keys.length === 2 && keys[0] === f.cashAta && keys[1] === f.wsolAta
      ? change(answer as { context: { slot: number }; value: unknown[] }) : answer;
  };
}

test("a deposit is booked only from finalized balances both providers report, at the lowest slot either answered at (audit G3-3, live-M3)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    const book = { hwmRaw: "100000000", cashRaw: "90000000", wsolRaw: "50000000", costBasisUsdgRaw: "10000000", realizedPnlUsdgRaw: "0",
      networkFeesLamports: "10000", slot: 900, updatedAtMs: 999_000 };
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
    f.controls.cash = 90_000_000n; f.controls.wsol = 50_000_000n;
    const booked = async () => (await new SolanaTradingStore(f.db, f.scope).liveBook())!;
    // The primary alone shows a 10 USDG deposit (confirmed and finalized): nothing is booked, and trading is not blocked.
    const phantom = (answer: { context: { slot: number }; value: unknown[] }) =>
      ({ ...answer, value: [{ ...(answer.value[0] as object), data: [f.tokenAccount(SOLANA_USDG_MINT, 100_000_000n).toString("base64"), "base64"] }, answer.value[1]] });
    f.providers.primary = balanceRead(f, phantom);
    let status = await f.app.status(f.scope);
    assert.equal(status.live.ready, true, status.live.blockers.join(" | "));
    assert.deepEqual([(await booked()).cashRaw, (await booked()).hwmRaw, (await booked()).slot], ["90000000", "100000000", 900]);
    // A real deposit both providers see is booked.
    f.providers.primary = null; f.controls.cash = 100_000_000n;
    status = await f.app.status(f.scope);
    assert.deepEqual([(await booked()).cashRaw, (await booked()).hwmRaw, (await booked()).slot], ["100000000", "110000000", 1000]);
    // One provider answering far ahead of what the other has finalized (its getSlot): the reading is refused, no slot is
    // persisted, and trading continues. A deposit that came with it waits for an honest reading.
    f.controls.cash = 105_000_000n;
    for (const which of ["primary", "fallback"] as const) {
      f.providers[which] = balanceRead(f, answer => ({ ...answer, context: { slot: answer.context.slot + 1_000_000_000 } }));
      status = await f.app.status(f.scope);
      assert.equal(status.live.ready, true, `${which}: ${status.live.blockers.join(" | ")}`);
      assert.deepEqual([(await booked()).cashRaw, (await booked()).slot], ["100000000", 1000], which);
      f.providers[which] = null;
    }
    // Honest skew between two providers books, at the lower of their slots.
    f.providers.primary = balanceRead(f, answer => ({ ...answer, context: { slot: answer.context.slot + 100 } }));
    status = await f.app.status(f.scope);
    assert.deepEqual([(await booked()).cashRaw, (await booked()).slot], ["105000000", 1000]);
    assert.equal(status.live.ready, true, status.live.blockers.join(" | "));
  } finally { f.raw.close(); }
});

test("a live binding saved before SOL sell limits existed is shown as not ready, not silently refused", async () => {
  const f = await fixture();
  try {
    const { perTradeWsol: _p, dailyWsol: _d, ...unbounded } = limits;
    const binding = (await f.bindings.get(TENANT))!; await f.bindings.settings(TENANT, f.owner, binding.revision, "live", unbounded);
    const status = await f.app.status(f.scope);
    assert.equal(status.live.ready, false); assert.match(status.live.blockers.join(" "), /SOL sell limits/);
    await assert.rejects(f.app.prepareLive(f.scope, { limits: unbounded, sessionPublicKey: f.session }), /SOL sell limits/);
  } finally { f.raw.close(); }
});

test("the local test program id is never accepted for live trading (audit GAP4-3)", async () => {
  const f = await fixture();
  try {
    await f.live();
    const app = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_VAULT_PROGRAM: SOLANA_VAULT_LOCAL_TEST_PROGRAM } });
    const status = await app.status(f.scope);
    assert.equal(status.live.ready, false); assert.match(status.live.blockers.join(" "), /local test id/);
    await assert.rejects(app.prepareLive(f.scope, { limits, sessionPublicKey: f.session }), /local test id/);
    await assert.rejects(app.prepareOwnerAction(f.scope, { action: "revoke" }), /local test id/);
    // Only a harness that asks for the local build accepts its id.
    const harness = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_VAULT_PROGRAM: SOLANA_VAULT_LOCAL_TEST_PROGRAM }, localTestDeployment: true });
    assert.doesNotMatch((await harness.status(f.scope)).live.blockers.join(" "), /local test id/);
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("an audited binary built for another program id is refused before any owner transaction (audit GAP4-3)", async () => {
  // Immutable and hash-matching, but its declare_id is the local test id.
  const f = await fixture({ declared: SOLANA_VAULT_LOCAL_TEST_PROGRAM });
  try {
    await f.live(); f.controls.initialized = true;
    const status = await f.app.status(f.scope);
    assert.equal(status.live.ready, false); assert.match(status.live.blockers.join(" "), /different program id/);
    await assert.rejects(f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session }), /different program id/);
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "revoke" }), /different program id/);
    assert.equal(await new SolanaTradingStore(f.db, f.scope).setup(), null, "nothing was prepared for the owner to sign");
  } finally { f.raw.close(); }
  // The same deployment check passes for the build that declares the configured id.
  const g = await fixture();
  try {
    await g.live();
    assert.doesNotMatch((await g.app.status(g.scope)).live.blockers.join(" "), /program id/);
    await g.app.prepareLive(g.scope, { limits, sessionPublicKey: g.session });
  } finally { g.raw.close(); }
});

/** Reads of the vault program's ProgramData: the expensive part of a deployment check. */
const programDataReads = (f: Awaited<ReturnType<typeof fixture>>) => f.calls.filter(c => c.method === "getAccountInfo" && c.key === f.dataAddress).length;

test("a live status verifies the vault binary once per recheck window, not on every call (audit web-auth F1, agent-deploy F3)", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered();
    await f.app.status(f.scope);
    const first = programDataReads(f);
    assert.ok(first > 0, "the first status checks the deployment");
    for (let i = 0; i < 5; i++) await f.app.status(f.scope);
    assert.equal(programDataReads(f), first, "later status calls reuse the successful check");
    f.clock.now += SOLANA_DEPLOYMENT_RECHECK_MS;
    await f.app.status(f.scope);
    assert.ok(programDataReads(f) > first, "the check runs again once the window passes");
  } finally { f.raw.close(); }
});

test("a deployment check is redone when its configuration changes, and a failure is never reused (audit web-auth F1)", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await f.registered();
    const env: Record<string, string | undefined> = { ...f.env };
    const app = f.runtime({ env });
    assert.doesNotMatch((await app.status(f.scope)).live.blockers.join(" "), /could not be verified/);
    const verifiedReads = programDataReads(f);
    env.MERRYMEN_SOLANA_VAULT_SHA256 = "00".repeat(32);
    for (let i = 0; i < 2; i++) assert.match((await app.status(f.scope)).live.blockers.join(" "), /could not be verified/, "a changed hash is checked, and refused");
    const refusedReads = programDataReads(f);
    assert.ok(refusedReads > verifiedReads);
    env.MERRYMEN_SOLANA_VAULT_SHA256 = f.env.MERRYMEN_SOLANA_VAULT_SHA256;
    assert.doesNotMatch((await app.status(f.scope)).live.blockers.join(" "), /could not be verified/);
    assert.ok(programDataReads(f) > refusedReads, "restoring the hash checks again rather than trusting an old result");
  } finally { f.raw.close(); }
});

test("a paper-only status, and the worker's paper strategy, make no RPC reads at all (audit web-auth F1, agent-deploy F3)", async () => {
  const f = await fixture();
  try {
    await f.app.setupPaper(f.scope, { initialCashRaw: "100000000", limits });
    const status = await f.app.status(f.scope);
    assert.ok(status.paper); assert.equal(status.live.programId, PROGRAM, "the configured program is still shown");
    assert.deepEqual(f.calls, []);
    // A paper strategy on an account that also has a live book: the worker reads only the paper book.
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify({ hwmRaw: "0", cashRaw: "0", wsolRaw: "0",
      costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 }));
    const binding = (await f.bindings.get(TENANT))!;
    await f.bindings.strategy(TENANT, f.owner, binding.revision, { enabled: true, targetSolBps: 5000, rebalanceBps: 100, tradeUsdgRaw: "1000000", intervalSeconds: 60 } as never);
    const agent = createSolanaAgent({ db: f.db, runtime: f.app, market: f.market, now: () => f.clock.now });
    assert.deepEqual((await agent.tick()).map(r => r.outcome), ["submitted"]);
    assert.deepEqual(f.calls, [], "no vault verification or chain read for a paper strategy");
    assert.ok((await f.app.status(f.scope)).live.blockers.length > 0);
  } finally { f.raw.close(); }
});

test("a long worker tick keeps its heartbeat fresh (audit agent-deploy F3)", async () => {
  const f = await fixture();
  try {
    await f.app.setupPaper(f.scope, { initialCashRaw: "100000000", limits });
    const binding = (await f.bindings.get(TENANT))!;
    await f.bindings.strategy(TENANT, f.owner, binding.revision, { enabled: true, targetSolBps: 5000, rebalanceBps: 100, tradeUsdgRaw: "1000000", intervalSeconds: 60 } as never);
    const started = f.clock.now;
    // Each status takes 100 s of wall time, as a slow provider would.
    const slow = { status: async (...args: Parameters<typeof f.app.status>) => { f.clock.now += 100_000; return f.app.status(...args); }, trade: f.app.trade };
    await createSolanaAgent({ db: f.db, runtime: slow, market: f.market, now: () => f.clock.now }).tick();
    const beat = await f.db.prepare("SELECT last_seen_at_ms FROM solana_runtime_worker_heartbeat WHERE worker='solana'").get() as { last_seen_at_ms: number };
    assert.ok(f.clock.now - started >= 100_000);
    assert.ok(f.clock.now - Number(beat.last_seen_at_ms) < 90_000, "the UI would otherwise show the worker offline");
  } finally { f.raw.close(); }
});

/** A live account the worker could trade: registered session, live binding, initialized vault. */
async function readyLive(f: Awaited<ReturnType<typeof fixture>>) { await f.live(); f.controls.initialized = true; await f.registered(); }

test("status says trading and exits are paused while the market refuses the USDG mint the vault refuses, and a mint it cannot read adds nothing", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    const reads: string[] = [];
    const refusing = (error: Error): SolanaPaperMarket => ({ quote: f.market.quote, readMint: async mint => {
      reads.push(mint); if (mint === SOLANA_USDG_MINT) throw error; return f.market.readMint(mint);
    } });
    assert.equal((await f.app.status(f.scope)).live.ready, true);
    // check_mint fails every swap, exits included, on such a mint: a full blocker, not an exit-safe one.
    const refused = await f.runtime({ market: refusing(new SolanaMarketError("invalid-mint")) }).status(f.scope);
    assert.deepEqual(reads, [SOLANA_USDG_MINT]);
    assert.ok(refused.live.blockers.includes(SOLANA_STATUS_USDG_MINT_REFUSED), refused.live.blockers.join(" | "));
    assert.equal(refused.live.ready, false); assert.equal(refused.live.canExit, false);
    // A read that fails for any other reason is not a refusal: the executor reads the mint again before signing.
    for (const error of [new SolanaRpcError("network"), new SolanaMarketError("invalid-address"), new Error("down")]) {
      const unread = await f.runtime({ market: refusing(error) }).status(f.scope);
      assert.equal(unread.live.ready, true, `${error.message}: ${unread.live.blockers.join(" | ")}`);
    }
    // Paper reads take no live mint read.
    reads.length = 0;
    await f.runtime({ market: refusing(new SolanaMarketError("invalid-mint")) }).status(f.scope, { liveReads: false });
    assert.deepEqual(reads, []);
  } finally { f.raw.close(); }
});

test("a shared fee payer below the per-transaction fee cap still lets every tenant trade and exit; operators get one alert (audit G2-4)", async () => {
  const f = await fixture(), lines: string[] = [];
  try {
    await readyLive(f);
    const app = f.runtime({ log: line => lines.push(line) });
    assert.equal((await app.status(f.scope)).live.ready, true);
    assert.equal(lines.length, 0, "nothing to say while the payer is funded");
    // Ordinary fee burn: under the 5,000,000-lamport cap, far above what one swap needs.
    f.controls.feePayerLamports = 3_000_000;
    const status = await app.status(f.scope);
    assert.equal(status.live.ready, true, status.live.blockers.join(" | ")); assert.equal(status.live.canExit, true);
    assert.equal(status.live.feePayer?.level, "low"); assert.equal(status.live.feePayer?.lamports, "3000000");
    assert.equal(status.live.feePayer?.lowLamports, "20000000", "default warning: four times the fee cap");
    assert.match(status.live.warnings.join(" "), /fee payer is low \(0\.003 SOL/);
    assert.equal(lines.length, 1); assert.match(lines[0]!, /^\[alert\] Solana fee payer is low: /);
    const event = JSON.parse(lines[0]!.slice(lines[0]!.indexOf("{")));
    assert.deepEqual({ solana: event.solana, kind: event.kind, feePayer: event.feePayer, lamports: event.lamports }, { solana: "alert", kind: "fee-payer-low", feePayer: f.feePayer, lamports: "3000000" });
    assert.ok(!lines[0]!.includes(f.owner) && !lines[0]!.includes(TENANT), "no tenant identity in operator logs");
    await app.status(f.scope); await app.status(f.scope);
    assert.equal(lines.length, 1, "repeated reads do not repeat the alert");
    f.clock.now += 10 * 60_000;
    await app.status(f.scope);
    assert.equal(lines.length, 2, "an unresolved alert is repeated every ten minutes");
  } finally { f.raw.close(); }
});

test("the fee payer gates buys and exits only on what one swap actually needs (audit G2-4)", async () => {
  const f = await fixture(), lines: string[] = [];
  try {
    await readyLive(f);
    const app = f.runtime({ log: line => lines.push(line) });
    const exitNeeds = rentExempt(165) + 10_000, buyNeeds = rentExempt(170) + 10_000;
    f.controls.feePayerLamports = buyNeeds;
    assert.equal((await app.status(f.scope)).live.ready, true, "exactly a buy's worth still trades");
    f.controls.feePayerLamports = buyNeeds - 1;
    let status = await app.status(f.scope);
    assert.equal(status.live.ready, false); assert.equal(status.live.canExit, true, "exits stay open");
    assert.match(status.live.blockers.join(" "), /enough for exits, not for buys/); assert.equal(status.live.feePayer?.level, "buys-blocked");
    assert.equal(status.live.feePayer?.exitMinimumLamports, String(exitNeeds)); assert.equal(status.live.feePayer?.buyMinimumLamports, String(buyNeeds));
    f.controls.feePayerLamports = exitNeeds - 1;
    status = await app.status(f.scope);
    assert.equal(status.live.canExit, false); assert.match(status.live.blockers.join(" "), /below the 0\.00204928 SOL one exit needs/);
    f.controls.feePayerLamports = 0; // a drained payer account no longer exists
    assert.equal((await app.status(f.scope)).live.feePayer?.level, "exits-blocked");
    f.controls.feePayerLamports = 100_000_000;
    assert.equal((await app.status(f.scope)).live.ready, true);
    assert.deepEqual(lines.map(line => JSON.parse(line.slice(line.indexOf("{"))).kind ?? JSON.parse(line.slice(line.indexOf("{"))).solana),
      ["fee-payer-low", "fee-payer-buys-blocked", "fee-payer-exits-blocked", "fee-payer-ok"], "one line per change of level");
    assert.ok(lines.slice(0, 3).every(line => line.startsWith("[alert] ")) && !lines[3]!.startsWith("[alert]"));
  } finally { f.raw.close(); }
});

test("the worker's own fee payer check judges and says what status judges and says, through the same alert state (audit G2-4)", async () => {
  const f = await fixture(), lines: string[] = [];
  try {
    await readyLive(f);
    const app = f.runtime({ log: line => lines.push(line) });
    assert.equal(await app.feePayerCheck({ vault: f.vault }), "ok"); assert.equal(lines.length, 0);
    f.controls.feePayerLamports = 3_000_000;
    assert.equal(await app.feePayerCheck({ vault: f.vault }), "low");
    assert.equal(lines.length, 1); assert.match(lines[0]!, /^\[alert\] Solana fee payer is low: /);
    // Status finds the same level: nothing more is said within the window.
    assert.equal((await app.status(f.scope)).live.feePayer?.level, "low"); assert.equal(lines.length, 1);
    // Exactly what a buy needs, with the vault's USDG account sizing it as status does; without a vault, the upper bound.
    f.controls.feePayerLamports = rentExempt(170) + 10_000;
    assert.equal(await app.feePayerCheck({ vault: f.vault }), "low"); assert.equal(await app.feePayerCheck(), "buys-blocked");
    f.controls.feePayerLamports = rentExempt(165) + 9_999;
    assert.equal(await app.feePayerCheck({ vault: f.vault }), "exits-blocked");
    assert.match(lines.at(-1)!, /^\[alert\] Solana fee payer cannot fund exits: every tenant's exits are blocked: /);
    assert.ok(lines.every(line => !line.includes(f.owner) && !line.includes(TENANT)), "no tenant identity");
    // An unreadable threshold is evaluated in its own try here too: the fallback level, and its own [alert].
    f.controls.feePayerLamports = 3_000_000;
    const broken = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_FEE_PAYER_LOW_LAMPORTS: "lots" }, log: line => lines.push(line) });
    assert.equal(await broken.feePayerCheck({ vault: f.vault }), "low");
    assert.ok(lines.some(line => line.startsWith("[alert] solana fee-payer-threshold misconfigured")));
    // Live trading not configured: there is nothing to check.
    await assert.rejects(f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_FEE_PAYER_SEED: "" } }).feePayerCheck(), /fee payer/);
  } finally { f.raw.close(); }
});

test("the fee payer warning threshold is explicit configuration (audit G2-4)", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.feePayerLamports = 3_000_000;
    const quiet = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_FEE_PAYER_LOW_LAMPORTS: "2500000" }, log: () => {} });
    const status = await quiet.status(f.scope);
    assert.equal(status.live.feePayer?.level, "ok"); assert.deepEqual(status.live.warnings, []); assert.equal(status.live.feePayer?.lowLamports, "2500000");
    const broken = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_FEE_PAYER_LOW_LAMPORTS: "lots" }, log: () => {} });
    const warned = await broken.status(f.scope);
    assert.deepEqual(warned.live.blockers, []); assert.ok(warned.live.warnings.includes(SOLANA_STATUS_FEE_PAYER_THRESHOLD_MISCONFIGURED));
  } finally { f.raw.close(); }
});

test("a misconfigured fee setting is a status blocker that still shows the vault, balances, fee payer and owner wallet; a bad fee cap refuses a live trade as configuration", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.cash = 8_000_000n; f.controls.feePayerLamports = 3_000_000;
    const good = await f.app.status(f.scope);
    assert.equal(good.live.ready, true, good.live.blockers.join(" | "));
    for (const [setting, value, blocker] of [["MERRYMEN_SOLANA_MAX_FEE_LAMPORTS", "lots", /network fee limit setting is misconfigured/],
      ["MERRYMEN_SOLANA_MAX_FEE_LAMPORTS", "0", /network fee limit setting is misconfigured/]] as const) {
      const app = f.runtime({ env: { ...f.env, [setting]: value }, log: () => {} });
      const status = await app.status(f.scope);
      assert.deepEqual(status.live.blockers.length, 1, status.live.blockers.join(" | "));
      assert.match(status.live.blockers[0]!, blocker, setting);
      assert.equal(status.live.ready, false); assert.equal(status.live.canExit, false);
      // Everything else is still read and shown.
      assert.deepEqual(status.live.balances, good.live.balances, setting); assert.deepEqual(status.live.ownerWallet, good.live.ownerWallet, setting);
      assert.deepEqual(status.live.recoverable, good.live.recoverable, setting); assert.equal(status.live.vault, good.live.vault, setting);
      // Still called low below the default threshold, which stands in for the one that cannot be read.
      assert.deepEqual({ ...status.live.feePayer, lowLamports: null }, { ...good.live.feePayer, lowLamports: null }, setting);
      assert.equal(good.live.feePayer?.level, "low"); assert.equal(status.live.feePayer?.lowLamports, null, "no configured threshold to show");
      assert.deepEqual(status.live.warnings, good.live.warnings, setting);
      await rejectsWith(app.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live", requestId: `fee-cap-${value}` } }), "configuration", blocker, value);
    }
    assert.equal((await new SolanaTradingStore(f.db, f.scope).pending()).length, 0); assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("a misconfigured fee payer warning threshold refuses nothing: trading and exits continue, the owner sees a warning and operators an [alert] (audit live-M6)", async () => {
  const f = await fixture(), lines: string[] = [];
  try {
    await readyLive(f); f.controls.cash = 8_000_000n; f.controls.feePayerLamports = 3_000_000;
    const good = await f.app.status(f.scope);
    for (const [label, more] of [["unreadable", { MERRYMEN_SOLANA_FEE_PAYER_LOW_LAMPORTS: "lots" }], ["zero", { MERRYMEN_SOLANA_FEE_PAYER_LOW_LAMPORTS: "0" }],
      ["unreadable, with an unreadable fee cap", { MERRYMEN_SOLANA_FEE_PAYER_LOW_LAMPORTS: "lots", MERRYMEN_SOLANA_MAX_FEE_LAMPORTS: "lots" }]] as const) {
      lines.length = 0;
      const app = f.runtime({ env: { ...f.env, ...more }, log: line => lines.push(line) });
      const status = await app.status(f.scope);
      const capBroken = "MERRYMEN_SOLANA_MAX_FEE_LAMPORTS" in more;
      // Only the fee cap (which trade() refuses) blocks; the threshold never does.
      assert.deepEqual(status.live.blockers.map(b => /network fee limit/.test(b)), capBroken ? [true] : [], label);
      assert.equal(status.live.ready, !capBroken, label); assert.equal(status.live.canExit, !capBroken, label);
      assert.deepEqual(status.live.warnings, [SOLANA_STATUS_FEE_PAYER_THRESHOLD_MISCONFIGURED, ...good.live.warnings], label);
      // The fee payer, vault, balances and owner wallet are read and shown; called low below four times the (default) fee cap.
      assert.deepEqual(status.live.balances, good.live.balances, label); assert.deepEqual(status.live.ownerWallet, good.live.ownerWallet, label);
      assert.deepEqual({ ...status.live.feePayer, lowLamports: null }, { ...good.live.feePayer, lowLamports: null }, label);
      assert.equal(status.live.feePayer?.level, "low", label); assert.equal(status.live.feePayer?.lowLamports, null, label);
      const alerts = lines.filter(line => line.startsWith("[alert] solana fee-payer-threshold misconfigured"));
      assert.equal(alerts.length, 1, label); assert.ok(!alerts[0]!.includes("lots"), "the value is never echoed");
      // Said at most once per ten minutes per process.
      await app.status(f.scope); assert.equal(lines.filter(line => line.startsWith("[alert] solana fee-payer-threshold")).length, 1, label);
      f.clock.now += 10 * 60_000; await app.status(f.scope);
      assert.equal(lines.filter(line => line.startsWith("[alert] solana fee-payer-threshold")).length, 2, label);
    }
  } finally { f.raw.close(); }
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
/** A provider that kept the owner's signed bytes and reports them finalized, with a vault forged to match. */
const withholding = (f: Fixture): SolanaLiveRead => async (method, params = []) => {
  if (method === "getSignatureStatuses") return f.response([{ confirmationStatus: "finalized", slot: 1000, err: null }]);
  if (method === "getTransaction") return { version: 0, slot: 1000, transaction: [f.controls.signed, "base64"], meta: { err: null } };
  if (method === "getAccountInfo" && params[0] === f.vault) return f.response(account(f.state(f.controls.epoch + 1n, f.controls.sequence + 1n)));
  return f.read(method, params);
};

test("a provider that withholds a revoke and reports it finalized cannot finish it (audit G3-2)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.providers.primary = withholding(f);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending");
    const status = await f.app.status(f.scope);
    assert.equal(status.live.ownerTransaction?.status, "pending"); assert.match(status.live.blockers.join(" "), /owner transaction is awaiting/);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.status, "pending", "the owner is not told the session was revoked");
    // It never landed: once both providers' finalized banks pass its blockhash, the owner can act again.
    f.providers.primary = null; f.controls.height = 5001;
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "failed");
    await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
  } finally { f.raw.close(); }
});

test("a withheld withdrawal reported finalized by one provider books no capital out (audit G3-2)", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.sequence = 3n; f.controls.cash = 90_000_000n;
    const book = { hwmRaw: "90000000", cashRaw: "90000000", wsolRaw: "0", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.providers.primary = withholding(f);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending");
    await f.app.status(f.scope);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).liveBook())!.cashRaw, "90000000", "the book still holds the cash");
    assert.deepEqual(await f.db.prepare("SELECT * FROM solana_runtime_cashflows").all(), []);
    // An honest fallback that sees the same landed withdrawal finishes it.
    f.providers.fallback = withholding(f);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized");
    assert.equal((await new SolanaTradingStore(f.db, f.scope).liveBook())!.cashRaw, "89000000");
  } finally { f.raw.close(); }
});

test("a finalized owner receipt whose vault effect is missing is not believed (audit G3-2)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.finalized = true; // both providers show the receipt, but the epoch never moved
    await assert.rejects(f.app.submitOwnerAction(f.scope, { signedTransactionBase64 }), /vault state/);
    assert.match((await f.app.status(f.scope)).live.blockers.join(" "), /Owner transaction confirmation is unavailable/);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.status, "pending");
    f.controls.epoch = 2n;
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized");
  } finally { f.raw.close(); }
});

test("an owner expiry proof takes its slot and height from one bank, so a stale slot cannot hide a landed revoke (audit execution F1, owner half)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    // Behind each URL: a current node answers heights, a lagging one slots and signatures.
    // The revoke landed at slot 950, so vault snapshots older than that still show epoch 1.
    const loadBalanced: SolanaLiveRead = async (method, params = []) => {
      if (method === "getBlockHeight") return 5001;
      if (method === "getSlot") return 900;
      if (method === "getEpochInfo") return { absoluteSlot: 1000, blockHeight: 5001, epoch: 2, slotIndex: 1000, slotsInEpoch: 432_000 };
      if (method === "getAccountInfo" && params[0] === f.vault) {
        const min = (params[1] as { minContextSlot?: number }).minContextSlot ?? 0;
        return min <= 950 ? { context: { slot: Math.max(900, min) }, value: account(f.state(1n)) } : { context: { slot: 1000 }, value: account(f.state(2n)) };
      }
      return f.read(method, params);
    };
    f.providers.primary = loadBalanced; f.providers.fallback = loadBalanced;
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending", "a revoke that ran is never recorded as failed");
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.status, "pending");
  } finally { f.raw.close(); }
});

test("an unseen owner transaction is sent again, as the same bytes, only while its blockhash can land (audit G2-1, owner half)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    assert.equal(f.controls.sends, 1);
    await f.app.status(f.scope);
    assert.equal(f.controls.sends, 2, "neither provider has it: rebroadcast");
    f.providers.fallback = async (method, params = []) => method === "getSignatureStatuses" ? f.response([{ confirmationStatus: "processed", slot: 1000, err: null }]) : f.read(method, params);
    await f.app.status(f.scope);
    assert.equal(f.controls.sends, 2, "a provider has seen it: nothing to resend");
    f.providers.fallback = null; f.controls.height = 5001;
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "failed");
    assert.equal(f.controls.sends, 2, "an expired blockhash is never resent");
    assert.deepEqual(new Set(f.sent), new Set([signedTransactionBase64]));
  } finally { f.raw.close(); }
});

// An owner transaction's floor: one signature fee plus the wallet's own rent-exempt minimum.
const OWNER_BASE = 5_000 + rentExempt(0);

test("an owner without SOL for the fee is told before signing, and nothing is prepared (audit G1-5)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    f.controls.ownerLamports = 0; // spent on setup rent
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "revoke" }), /owner wallet holds 0 SOL\. This transaction needs at least 0\.00089588 SOL/);
    assert.equal(await new SolanaTradingStore(f.db, f.scope).setup(), null);
    f.controls.ownerLamports = OWNER_BASE - 1;
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "resume-buys" }), /needs at least/);
    f.controls.ownerLamports = OWNER_BASE;
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    assert.equal(prepared.requiredLamports, String(OWNER_BASE)); assert.equal(prepared.ownerLamports, String(OWNER_BASE));
  } finally { f.raw.close(); }
});

test("a withdrawal that opens the owner's token account counts its rent, and setup counts every account it opens (audit G1-5)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    const usdgNeeds = OWNER_BASE + rentExempt(170);
    f.controls.ownerLamports = usdgNeeds - 1;
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1" }), /rent for the token accounts it opens/);
    f.controls.ownerLamports = usdgNeeds;
    assert.equal((await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1" })).requiredLamports, String(usdgNeeds));
  } finally { f.raw.close(); }
  const g = await fixture();
  try {
    await g.live(); g.controls.ownerAtas = true; g.controls.ownerLamports = OWNER_BASE;
    g.controls.initialized = true;
    // With its token accounts open, a withdrawal costs only the fee.
    assert.equal((await g.app.prepareOwnerAction(g.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1" })).requiredLamports, String(OWNER_BASE));
  } finally { g.raw.close(); }
  const h = await fixture();
  try {
    await h.live();
    // A first setup opens the vault and the owner's two token accounts (the fixture's vault token accounts already exist).
    const setupNeeds = OWNER_BASE + rentExempt(SOLANA_VAULT_ACCOUNT_SIZE) + rentExempt(170) + rentExempt(165);
    h.controls.ownerLamports = setupNeeds - 1;
    await assert.rejects(h.app.prepareLive(h.scope, { limits, sessionPublicKey: h.session }), /needs at least/);
    h.controls.ownerLamports = setupNeeds;
    assert.equal((await h.app.prepareLive(h.scope, { limits, sessionPublicKey: h.session })).requiredLamports, String(setupNeeds));
  } finally { h.raw.close(); }
});

test("status shows what the owner wallet needs to revoke and withdraw, and warns when it is short (audit G1-5)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    let status = await f.app.status(f.scope);
    assert.deepEqual(status.live.ownerWallet, { lamports: "100000000", revokeLamports: String(OWNER_BASE), withdrawLamports: String(OWNER_BASE + rentExempt(170)) });
    assert.deepEqual(status.live.warnings, []);
    f.controls.ownerLamports = OWNER_BASE;
    status = await f.app.status(f.scope);
    assert.match(status.live.warnings.join(" "), /enough to revoke, but a withdrawal may need up to 0\.00296996 SOL/);
    assert.equal(status.live.ready, true, "an owner warning never blocks the worker");
    f.controls.ownerLamports = 0;
    assert.match((await f.app.status(f.scope)).live.warnings.join(" "), /too little to revoke or withdraw/);
  } finally { f.raw.close(); }
});

/** The prepared transaction's instructions: program, accounts and data. */
function instructionsOf(transactionBase64: string) {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(transactionBase64, "base64")).messageBytes);
  return message.instructions.map(ix => ({ program: message.staticAccounts[ix.programAddressIndex] as string,
    accounts: (ix.accountIndices ?? []).map(i => message.staticAccounts[i] as string), data: Buffer.from(ix.data ?? []) }));
}
const WITHDRAW_SOL = Buffer.from([145, 131, 74, 136, 65, 137, 42, 38]);
/** SQLite rows as plain objects. */
const rows = async (f: Fixture, sql: string) => (await f.db.prepare(sql).all() as object[]).map(row => ({ ...row }));
/** Both providers see the owner transaction finalized and the vault's sequence moved. */
const landOwner = (f: Fixture) => { f.controls.finalized = true; f.controls.sequence += 1n; };

/** An ExtraAccountMetaList for Execute: `fixed`, then PDA ["merrymen", account 2 (the destination)] of the hook; `signer` marks the second as a signer. */
function hookMetaList(fixed: string, signer = false): Buffer {
  const fixedMeta = Buffer.concat([Buffer.of(0), keyBytes(fixed), Buffer.of(0, 0)]);
  const config = Buffer.alloc(32); config[0] = 1; config[1] = 8; Buffer.from("merrymen").copy(config, 2); config[10] = 3; config[11] = 2;
  const pdaMeta = Buffer.concat([Buffer.of(1), config, Buffer.of(signer ? 1 : 0, 1)]);
  const header = Buffer.alloc(16); Buffer.from([105, 37, 101, 197, 75, 251, 102, 26]).copy(header); header.writeUInt32LE(4 + 70, 8); header.writeUInt32LE(2, 12);
  return Buffer.concat([header, fixedMeta, pdaMeta]);
}

test("once the USDG issuer sets a transfer hook, an owner withdrawal carries the hook's accounts, so USDG never locks in the vault", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.sequence = 2n; f.controls.cash = 90_000_000n;
    const book = { hwmRaw: "90000000", cashRaw: "90000000", wsolRaw: "0", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
    // Today: the extension is there, no program is set, and the withdrawal is the plain six accounts.
    const plain = instructionsOf((await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" })).transactionBase64);
    assert.equal(plain.find(ix => ix.program === PROGRAM)!.accounts.length, 6);
  } finally { f.raw.close(); }
  const g = await fixture();
  try {
    await readyLive(g); g.controls.sequence = 2n; g.controls.cash = 90_000_000n;
    const book = { hwmRaw: "90000000", cashRaw: "90000000", wsolRaw: "0", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
    await g.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, g.owner, JSON.stringify(book));
    const hook = key(88), fixed = key(89);
    const [validation] = await getProgramDerivedAddress({ programAddress: kitAddress(hook), seeds: [new TextEncoder().encode("extra-account-metas"), keyBytes(SOLANA_USDG_MINT)] });
    const [pda] = await getProgramDerivedAddress({ programAddress: kitAddress(hook), seeds: [new TextEncoder().encode("merrymen"), keyBytes(g.ownerCashAta)] });
    g.controls.hookProgram = hook;
    // A hook that asks for a signer is refused before anything is signed: the program refuses it too.
    g.extra.set(validation, account(hookMetaList(fixed, true), hook));
    await assert.rejects(g.app.prepareOwnerAction(g.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" }), /transfer hook cannot be resolved: it asks for a signer/);
    assert.equal(await new SolanaTradingStore(g.db, g.scope).setup(), null);
    // A mint that cannot be read refuses the withdrawal rather than sign one that cannot pass.
    g.extra.set(SOLANA_USDG_MINT, null);
    await assert.rejects(g.app.prepareOwnerAction(g.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" }), /mint could not be read/);
    g.extra.delete(SOLANA_USDG_MINT);
    g.extra.set(validation, account(hookMetaList(fixed), hook));
    const prepared = await g.app.prepareOwnerAction(g.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    const withdraw = instructionsOf(prepared.transactionBase64).find(ix => ix.program === PROGRAM)!;
    assert.deepEqual(withdraw.accounts, [g.vault, g.owner, SOLANA_USDG_MINT, g.cashAta, g.ownerCashAta, TOKEN_2022_PROGRAM, fixed, pda, validation, hook]);
    // The extra accounts never sign: only the owner signs the withdrawal.
    const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(prepared.transactionBase64, "base64")).messageBytes);
    assert.equal(message.header.numSignerAccounts, 1);
  } finally { g.raw.close(); }
});

test("a USDG transfer hook whose list names the owner's wallet, even read-only, refuses the USDG withdrawal with the reason before anything is signed; WSOL still withdraws", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.sequence = 2n; f.controls.cash = 90_000_000n; f.controls.wsol = 100_000_000n;
    const book = { hwmRaw: "102000000", cashRaw: "90000000", wsolRaw: "100000000", costBasisUsdgRaw: "12000000", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
    const hook = key(88);
    const [validation] = await getProgramDerivedAddress({ programAddress: kitAddress(hook), seeds: [new TextEncoder().encode("extra-account-metas"), keyBytes(SOLANA_USDG_MINT)] });
    f.controls.hookProgram = hook;
    // The owner's wallet as a fixed, read-only, non-signer extra account.
    f.extra.set(validation, account(hookMetaList(f.owner), hook));
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" }),
      (error: unknown) => error instanceof SolanaAppRuntimeError && error.code === "invalid" && error.message === `USDG cannot be withdrawn here: ${SOLANA_TRANSFER_HOOK_NAMES_OWNER}`);
    assert.equal(await new SolanaTradingStore(f.db, f.scope).setup(), null, "nothing prepared");
    const wsol = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000" });
    assert.equal(instructionsOf(wsol.transactionBase64).find(ix => ix.program === PROGRAM)!.accounts.length, 6, "a WSOL withdrawal carries no hook accounts");
  } finally { f.raw.close(); }
});

test("the owner can withdraw native SOL held by the vault account itself (audit G1-4)", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.sequence = 4n;
    f.controls.vaultNativeLamports = 100; // sent straight to the vault PDA
    const status = await f.app.status(f.scope);
    assert.deepEqual(status.live.recoverable, { nativeLamports: "100", unsyncedWsolLamports: "0" });
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "101" }), /native SOL above its rent reserve \(0\.0000001 SOL\)/);
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "0" }));
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "100" }), /supported owner action/);
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "100" });
    const [withdraw, ...rest] = instructionsOf(prepared.transactionBase64);
    assert.deepEqual(rest, []); assert.equal(withdraw!.program, PROGRAM);
    assert.deepEqual(withdraw!.data, Buffer.concat([WITHDRAW_SOL, Buffer.from([100, 0, 0, 0, 0, 0, 0, 0])])); assert.deepEqual(withdraw!.accounts, [f.vault, f.owner]);
    const saved = (await new SolanaTradingStore(f.db, f.scope).setup())!;
    assert.equal(saved.kind, "withdraw-sol"); assert.equal(saved.amountRaw, "100"); assert.equal(saved.priorSequence, "4");
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    landOwner(f);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized");
    assert.deepEqual(await rows(f, "SELECT kind,mint,amount_raw FROM solana_runtime_cashflows"), [{ kind: "withdraw-sol", mint: SYSTEM, amount_raw: "100" }]);
  } finally { f.raw.close(); }
});

test("a dropped native SOL withdrawal resolves on an unchanged sequence, and no trade can move it in between (audit G1-4)", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.sequence = 4n; f.controls.vaultNativeLamports = 100;
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "100" });
    // A prepared withdrawal's expiry is proven by its sequence, so admission holds trades meanwhile.
    const store = new SolanaTradingStore(f.db, f.scope, () => f.clock.now);
    await assert.rejects(store.recordSigned({ intent: { owner: f.owner, requestId: "trade-during-withdraw-sol" } } as never), /prepared owner withdrawal/);
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.height = 5001;
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "failed");
    assert.equal((await store.setup())!.expiryProof!.vaultSequence, "4");
    assert.deepEqual(await f.db.prepare("SELECT * FROM solana_runtime_cashflows").all(), []);
    // A trade at or after the read sequence makes a prepared withdrawal stale.
    await pendingTrade(f, "4"); await landTrade(f, "4");
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "100" }), /vault changed/);
  } finally { f.raw.close(); }
});

test("a WSOL withdrawal syncs native SOL sent straight to the vault's WSOL account and can take it (audit G1-4)", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.sequence = 2n; f.controls.cash = 90_000_000n;
    const book = { hwmRaw: "90000000", cashRaw: "90000000", wsolRaw: "0", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
    // Without SyncNative these 13 lamports are not WSOL: the old app could never withdraw them.
    f.controls.unsyncedWsolLamports = 13;
    assert.equal((await f.app.status(f.scope)).live.recoverable?.unsyncedWsolLamports, "13");
    await assert.rejects(f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "14" }), /exceeds/);
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "13" });
    const [sync, create, withdraw] = instructionsOf(prepared.transactionBase64);
    assert.deepEqual(sync, { program: SOLANA_CLASSIC_TOKEN_PROGRAM, accounts: [f.wsolAta], data: Buffer.from([17]) }, "SyncNative runs before the withdrawal");
    assert.equal(create!.program, "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"); assert.equal(withdraw!.program, PROGRAM);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.syncedWsolRaw, "13");
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.unsyncedWsolLamports = 0; landOwner(f);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized");
    const after = (await new SolanaTradingStore(f.db, f.scope).liveBook())!;
    assert.equal(after.wsolRaw, "0"); assert.equal(after.quarantinedWsolRaw, "0"); assert.equal(after.cashRaw, "90000000"); assert.equal(after.hwmRaw, "90000000");
    const flows = await rows(f, "SELECT kind,mint,amount_raw FROM solana_runtime_cashflows ORDER BY kind");
    assert.deepEqual(flows, [{ kind: "quarantine", mint: SOLANA_WRAPPED_SOL_MINT, amount_raw: "13" }, { kind: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amount_raw: "13" }]);
    // Nothing unsynced: no SyncNative instruction.
    f.controls.finalized = false;
    const plain = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1" });
    assert.ok(!instructionsOf(plain.transactionBase64).some(ix => ix.program === SOLANA_CLASSIC_TOKEN_PROGRAM));
  } finally { f.raw.close(); }
});

test("lamports someone else syncs and the app books before the owner signs are not booked twice (audit G1-4)", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.sequence = 2n; f.controls.cash = 90_000_000n;
    const book = { hwmRaw: "90000000", cashRaw: "90000000", wsolRaw: "0", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
    f.controls.unsyncedWsolLamports = 13;
    const prepared = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "13" });
    // Anyone may call SyncNative. A status read then books the 13 as quarantined WSOL.
    f.controls.unsyncedWsolLamports = 0; f.controls.wsol = 13n;
    await f.app.status(f.scope);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).liveBook())!.quarantinedWsolRaw, "13");
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.wsol = 0n; landOwner(f);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized");
    const after = (await new SolanaTradingStore(f.db, f.scope).liveBook())!;
    assert.equal(after.quarantinedWsolRaw, "0", "the book matches the chain: nothing left over, nothing double counted");
    const flows = await rows(f, "SELECT kind,amount_raw FROM solana_runtime_cashflows ORDER BY kind");
    assert.deepEqual(flows, [{ kind: "quarantine", amount_raw: "13" }, { kind: "withdraw", amount_raw: "13" }]);
    f.controls.finalized = false;
    assert.ok(!(await f.app.status(f.scope)).live.blockers.some(b => /below recorded/.test(b)));
  } finally { f.raw.close(); }
});

/** SOL at $120: a WSOL→USDG quote pays 0.12 micro-USDG per lamport, and Pyth reads the same price. */
const USD_PER_SOL = 12_000_000_000n;
function pricedMarket(f: Fixture, failQuotes = false): SolanaPaperMarket {
  return { ...f.market, quote: async intent => {
    if (failQuotes) throw new Error("quote service unavailable");
    const amount = BigInt(intent.amountRaw), out = intent.inputMint === SOLANA_WRAPPED_SOL_MINT ? amount * 12n / 100n : amount * 100n / 12n;
    return { source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: intent.amountRaw, outAmount: out.toString(),
      minOutAmount: (out * BigInt(10_000 - intent.slippageBps) / 10_000n).toString(), slippageBps: intent.slippageBps,
      contextSlot: 1000, quotedAtMs: f.clock.now, expiresAtMs: f.clock.now + 30_000 };
  } };
}
/** Both providers also serve Pyth's SOL/USD account (`fallbackPrice`: what the second one serves instead, when given). */
function servePyth(f: Fixture, fallbackPrice?: bigint) {
  const serving = (price: bigint): SolanaLiveRead => async (method, params = []) => method === "getAccountInfo" && params[0] === PYTH_SOL_USD_ACCOUNT
    ? f.response(pythAccount({ price, publishTimeMs: f.clock.now, postedSlot: 999n })) : f.read(method, params);
  f.providers.primary = serving(USD_PER_SOL); f.providers.fallback = serving(fallbackPrice ?? USD_PER_SOL);
}
/** The audit's account: 8 USDG cash and 0.1 SOL (12 USDG at $120), high-water mark 20 USDG. */
async function wsolCapital(f: Fixture) {
  await readyLive(f); f.controls.sequence = 2n; f.controls.cash = 8_000_000n; f.controls.wsol = 100_000_000n; f.controls.ownerAtas = true;
  const book = { hwmRaw: "20000000", cashRaw: "8000000", wsolRaw: "100000000", costBasisUsdgRaw: "12000000", realizedPnlUsdgRaw: "0",
    networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
  await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
}
/** The persisted breaker's own test (SolanaTradingStore.recordSigned): would the next buy trip it? */
const breakerTrips = (hwm: bigint, equity: bigint) => hwm === 0n || (hwm - equity) * 10_000n >= hwm * BigInt(limits.maxDrawdownBps);

test("withdrawing WSOL capital in the app lowers the high-water mark by its value, so the drawdown breaker stays armed, not tripped (accounting F3)", async () => {
  const f = await fixture();
  try {
    await wsolCapital(f); servePyth(f);
    const app = f.runtime({ market: pricedMarket(f) });
    const prepared = await app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "100000000" });
    const saved = (await new SolanaTradingStore(f.db, f.scope).setup())!;
    // An executable exit quote (50 bps, as the agent exits) and the Pyth bound for the same amount.
    assert.ok(saved.withdrawValuation, "the prepared WSOL withdrawal carries its valuation");
    assert.equal(saved.withdrawValuation.quote.inAmount, "100000000"); assert.equal(saved.withdrawValuation.quote.slippageBps, 50);
    assert.equal(saved.withdrawValuation.quote.minOutAmount, "11940000");
    assert.equal(saved.withdrawValuation.reference.referenceOut, "12000000"); assert.equal(saved.withdrawValuation.reference.reference.slot, 1000);
    const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
    await app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    f.controls.wsol = 0n; landOwner(f);
    assert.equal((await app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized");
    const after = (await new SolanaTradingStore(f.db, f.scope).liveBook())!;
    assert.equal(after.wsolRaw, "0"); assert.equal(after.cashRaw, "8000000"); assert.equal(after.costBasisUsdgRaw, "0");
    // It drops by the lower of the quote's guaranteed output and the reference: never more than the SOL was worth.
    assert.equal(after.hwmRaw, String(20_000_000 - 11_940_000));
    assert.equal(breakerTrips(BigInt(after.hwmRaw), BigInt(after.cashRaw)), false, "withdrawing capital is not a drawdown");
    assert.notEqual(after.buyPaused, true);
    assert.equal(breakerTrips(20_000_000n, 8_000_000n), true, "without the valuation the same withdrawal pauses buying");
  } finally { f.raw.close(); }
});

test("a WSOL withdrawal is valued at the lower of both providers' Pyth bounds: one provider cannot lower the high-water mark by more than the SOL was worth", async () => {
  for (const [label, primary, fallback] of [["fallback low", USD_PER_SOL, 10_000_000_000n], ["primary low", 10_000_000_000n, USD_PER_SOL]] as const) {
    const f = await fixture();
    try {
      await wsolCapital(f); servePyth(f);
      // servePyth serves $120 from both; serve each provider's own price instead.
      const serving = (price: bigint): SolanaLiveRead => async (method, params = []) => method === "getAccountInfo" && params[0] === PYTH_SOL_USD_ACCOUNT
        ? f.response(pythAccount({ price, conf: price / 10_000n, publishTimeMs: f.clock.now, postedSlot: 999n })) : f.read(method, params);
      f.providers.primary = serving(primary); f.providers.fallback = serving(fallback);
      // A quote above both, so the reference is what the store keeps.
      const app = f.runtime({ market: { ...pricedMarket(f), quote: async intent => ({ ...await pricedMarket(f).quote(intent), minOutAmount: "11999999" }) } });
      await app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "100000000" });
      const saved = (await new SolanaTradingStore(f.db, f.scope).setup())!;
      // 0.1 SOL at $100, not at $120: the lower of the two providers' bounds.
      assert.equal(saved.withdrawValuation?.reference.referenceOut, "10000000", label);
      assert.equal(saved.withdrawValuation?.reference.reference.price, "10000000000", label);
    } finally { f.raw.close(); }
  }
});

test("a WSOL withdrawal whose value cannot be read still prepares and lands, and leaves the high-water mark where it was", async () => {
  for (const unreadable of ["no quote", "no reference price", "a misconfigured reference tolerance", "a misconfigured Pyth generation"] as const) {
    const f = await fixture();
    try {
      await wsolCapital(f);
      if (unreadable !== "no reference price") servePyth(f);
      else f.controls.pythPrice = null;
      const app = f.runtime({ market: pricedMarket(f, unreadable === "no quote"),
        ...(unreadable === "a misconfigured reference tolerance" ? { env: { ...f.env, MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS: "nonsense" } } : {}),
        ...(unreadable === "a misconfigured Pyth generation" ? { env: { ...f.env, MERRYMEN_SOLANA_PYTH_GENERATION: "both" } } : {}) });
      const prepared = await app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "40000000" });
      assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.withdrawValuation, undefined, unreadable);
      const signedTransactionBase64 = await f.sign(prepared.transactionBase64);
      await app.submitOwnerAction(f.scope, { signedTransactionBase64 });
      f.controls.wsol = 60_000_000n; landOwner(f);
      assert.equal((await app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized", unreadable);
      const after = (await new SolanaTradingStore(f.db, f.scope).liveBook())!;
      assert.equal(after.wsolRaw, "60000000"); assert.equal(after.hwmRaw, "20000000", unreadable);
    } finally { f.raw.close(); }
  }
});

test("a WSOL withdrawal of quarantine alone asks no one for a price", async () => {
  // No position at all, and a position the withdrawal never reaches: quarantined WSOL leaves first.
  for (const position of ["0", "100000000"]) {
    const f = await fixture();
    try {
      await readyLive(f); f.controls.sequence = 2n; f.controls.cash = 8_000_000n; f.controls.wsol = BigInt(position) + 5_000_000n;
      const book = { hwmRaw: "8000000", cashRaw: "8000000", wsolRaw: position, quarantinedWsolRaw: "5000000", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0",
        networkFeesLamports: "0", slot: 900, updatedAtMs: 999_000 };
      await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, f.owner, JSON.stringify(book));
      let quotes = 0;
      servePyth(f);
      const app = f.runtime({ market: { ...pricedMarket(f), quote: async intent => { quotes++; return pricedMarket(f).quote(intent); } } });
      await app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "5000000" });
      assert.equal(quotes, 0, position); assert.ok(!f.calls.some(call => call.key === PYTH_SOL_USD_ACCOUNT), position);
      assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.withdrawValuation, undefined);
      // One unit more reaches the position: then it is valued.
      if (position !== "0") {
        f.controls.finalized = false;
        await app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "5000001" });
        assert.equal(quotes, 1); assert.ok((await new SolanaTradingStore(f.db, f.scope).setup())!.withdrawValuation);
      }
    } finally { f.raw.close(); }
  }
});

/** The ComputeBudget limit and price an owner transaction carries, or null without them. */
function ownerBudget(transactionBase64: string): { units: number; price: bigint } | null {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(transactionBase64, "base64")).messageBytes);
  const budget = message.instructions.filter(ix => message.staticAccounts[ix.programAddressIndex] === "ComputeBudget111111111111111111111111111111").map(ix => Buffer.from(ix.data!));
  if (!budget.length) return null;
  assert.deepEqual(budget.map(d => d[0]), [2, 3], "one unit limit, then one price");
  return { units: budget[0]!.readUInt32LE(1), price: budget[1]!.readBigUInt64LE(1) };
}

test("owner transactions carry a bounded priority fee the owner can afford, and still prepare without one (audit G2-1, owner half)", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    // Simulated at 20,000 units; recent fees on the accounts it writes put the 75th percentile at 50,000 micro-lamports.
    f.controls.simulatedUnits = 20_000; f.controls.priorityFees = [1_000, 2_000, 50_000, 100_000];
    const revoke = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    // 20,000 × 1.2 + 40,000 is below the 200,000 units a one-instruction revoke gets with no limit: it keeps those.
    assert.deepEqual(ownerBudget(revoke.transactionBase64), { units: 200_000, price: 50_000n });
    assert.equal(revoke.priorityFeeLamports, "10000"); assert.equal(revoke.computeUnitLimit, 200_000);
    assert.equal(revoke.requiredLamports, String(OWNER_BASE + 10_000), "the fee is part of what the owner must hold");
    // The signed bytes are exactly the reviewed message, priority fee included.
    const signedTransactionBase64 = await f.sign(revoke.transactionBase64);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending");
    assert.equal(f.controls.sends, 1); assert.equal(f.sent[0], signedTransactionBase64);
  } finally { f.raw.close(); }
  for (const [ownerLamports, fees, expected] of [
    // Never more than 0.001 SOL in priority fees, however high recent fees are.
    [100_000_000, [1_000_000_000], 1_000_000n],
    // Never more than the owner holds beyond the transaction's own needs: a smaller fee, never a refusal.
    [OWNER_BASE + 640, [1_000_000_000], 640n],
    // Nothing to spare, no estimate, or a failing simulation: no priority fee, exactly as before.
    [OWNER_BASE, [50_000], 0n],
    [100_000_000, null, 0n],
    [100_000_000, "simulation", 0n],
  ] as const) {
    const g = await fixture();
    try {
      await readyLive(g);
      g.controls.ownerLamports = ownerLamports; g.controls.simulatedUnits = 20_000;
      g.controls.priorityFees = Array.isArray(fees) ? [...fees] : null; g.controls.simulationFails = fees === "simulation";
      const prepared = await g.app.prepareOwnerAction(g.scope, { action: "revoke" });
      assert.equal(prepared.priorityFeeLamports, expected.toString(), `${ownerLamports} ${String(fees)}`);
      assert.equal(prepared.requiredLamports, String(OWNER_BASE + Number(expected)));
      const budget = ownerBudget(prepared.transactionBase64);
      if (expected === 0n) assert.equal(budget, null);
      else assert.equal((budget!.price * BigInt(budget!.units) + 999_999n) / 1_000_000n, expected);
    } finally { g.raw.close(); }
  }
  // A withdrawal's fee estimate covers the accounts it writes: the vault, its token account and the owner's.
  const h = await fixture();
  try {
    await readyLive(h); h.controls.cash = 5_000_000n; h.controls.simulatedUnits = 30_000; h.controls.priorityFees = [10_000];
    const prepared = await h.app.prepareOwnerAction(h.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    assert.equal(ownerBudget(prepared.transactionBase64)!.price, 10_000n);
    const estimate = h.calls.filter(call => call.method === "getRecentPrioritizationFees").at(-1)!.key as string[];
    for (const account of [h.owner, h.vault, h.cashAta, h.ownerCashAta]) assert.ok(estimate.includes(account), account);
  } finally { h.raw.close(); }
});

test("one provider's under-reported simulation never signs an owner compute limit below the runtime default", async () => {
  // Unit: the simulation plus headroom, floored at 200,000 per instruction, capped at 1,400,000.
  assert.equal(solanaOwnerComputeUnitLimit(1, 1), 200_000);
  assert.equal(solanaOwnerComputeUnitLimit(1, 2), 400_000);
  assert.equal(solanaOwnerComputeUnitLimit(500_000, 1), 640_000);
  assert.equal(solanaOwnerComputeUnitLimit(1_300_000, 1), 1_400_000);
  assert.equal(solanaOwnerComputeUnitLimit(1, 9), 1_400_000);
  const f = await fixture();
  try {
    await readyLive(f); f.controls.cash = 5_000_000n;
    // A provider answers that the transaction used 1 compute unit.
    f.controls.simulatedUnits = 1; f.controls.priorityFees = [1_000_000_000];
    const revoke = await f.app.prepareOwnerAction(f.scope, { action: "revoke" });
    assert.equal(revoke.computeUnitLimit, 200_000, "one instruction: what a revoke gets with no limit at all");
    assert.equal(ownerBudget(revoke.transactionBase64)!.units, 200_000);
    // The total fee still never exceeds the owner's cap: the price shrinks as the units grow.
    assert.equal(revoke.priorityFeeLamports, "1000000");
    const withdraw = await f.app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" });
    assert.equal(withdraw.computeUnitLimit, 400_000, "open the owner's token account, then withdraw: two instructions");
    const budget = ownerBudget(withdraw.transactionBase64)!;
    assert.equal(budget.units, 400_000);
    assert.ok((budget.price * 400_000n + 999_999n) / 1_000_000n <= 1_000_000n);
    assert.equal(withdraw.priorityFeeLamports, "1000000");
  } finally { f.raw.close(); }
});

test("a slow priority-fee read leaves the owner transaction without a fee instead of failing it (audit G2-1, owner half)", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    f.controls.simulatedUnits = 20_000; f.controls.priorityFees = [50_000];
    // Every read session has a hard deadline, as the live transport does. The
    // simulation never answers: inside the blockhash and cost session it would
    // fail the whole revoke at that deadline.
    let simulations = 0;
    const slow: SolanaLiveRead = (method, params) => {
      if (method === "simulateTransaction") { simulations++; return new Promise(() => undefined); }
      return f.read(method, params);
    };
    const rpc: SolanaLiveRpc = { ...f.rpc, read: fn => withSolanaReadDeadline(() => fn(slow), 2_000),
      readEach: async fn => [await withSolanaReadDeadline(() => fn(slow), 2_000), await withSolanaReadDeadline(() => fn(slow), 2_000)] };
    const app = f.runtime({ rpc, ownerFeeReadMs: 20 });
    const revoke = await app.prepareOwnerAction(f.scope, { action: "revoke" });
    assert.equal(simulations, 1, "the fee was attempted");
    assert.equal(revoke.priorityFeeLamports, "0"); assert.equal(revoke.computeUnitLimit, null);
    assert.equal(ownerBudget(revoke.transactionBase64), null, "no priority fee, exactly as before");
    assert.equal(revoke.requiredLamports, String(OWNER_BASE));
    // The prepared revoke is saved and signs normally.
    const signedTransactionBase64 = await f.sign(revoke.transactionBase64);
    assert.equal((await app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "pending");
    // A provider session that never ends: only the fee reads' own short deadline lets the revoke prepare.
    const e = await fixture();
    try {
      await readyLive(e); e.controls.simulatedUnits = 20_000; e.controls.priorityFees = [50_000];
      const hang: SolanaLiveRead = (method, params) => method === "simulateTransaction" ? new Promise(() => undefined) : e.read(method, params);
      const prepared = await e.runtime({ rpc: { ...e.rpc, read: fn => fn(hang) }, ownerFeeReadMs: 20 }).prepareOwnerAction(e.scope, { action: "revoke" });
      assert.equal(prepared.priorityFeeLamports, "0");
    } finally { e.raw.close(); }
    // A fee read that throws (the provider refuses simulation) is no fee either.
    const g = await fixture();
    try {
      await readyLive(g); g.controls.priorityFees = [50_000];
      const refusing: SolanaLiveRead = (method, params) => method === "simulateTransaction" ? Promise.reject(new Error("refused")) : g.read(method, params);
      const prepared = await g.runtime({ rpc: { ...g.rpc, read: fn => fn(refusing) } }).prepareOwnerAction(g.scope, { action: "revoke" });
      assert.equal(prepared.priorityFeeLamports, "0");
    } finally { g.raw.close(); }
    // A simulation that answers after the deadline: once it passed nothing more is asked, the fee estimate included.
    const h = await fixture();
    try {
      await readyLive(h); h.controls.simulatedUnits = 20_000; h.controls.priorityFees = [50_000];
      let feeReads = 0, answered: () => void = () => undefined;
      const lateAnswer = new Promise<void>(resolve => { answered = resolve; });
      const late: SolanaLiveRead = async (method, params) => {
        if (method === "getRecentPrioritizationFees") feeReads++;
        if (method !== "simulateTransaction") return h.read(method, params);
        await new Promise(resolve => setTimeout(resolve, 80));
        try { return await h.read(method, params); } finally { setTimeout(answered, 0); }
      };
      const prepared = await h.runtime({ rpc: { ...h.rpc, read: fn => fn(late) }, ownerFeeReadMs: 20 }).prepareOwnerAction(h.scope, { action: "revoke" });
      assert.equal(prepared.priorityFeeLamports, "0");
      assert.equal(feeReads, 0, "the deadline passed before the simulation answered");
      await lateAnswer; await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(feeReads, 0, "the late simulation's answer asks the provider nothing more");
    } finally { h.raw.close(); }
  } finally { f.raw.close(); }
});

test("status names the RPC configuration an operator must fix: no independent fallback, or no second provider", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    // The live transport is built from the environment, and it refuses one provider before any request.
    const unpaired = f.runtime({ rpc: undefined, env: { ...f.env, MERRYMEN_SOLANA_RPC_MAINNET: "https://rpc.example" } });
    const missing = await unpaired.status(f.scope);
    assert.equal(missing.live.ready, false); assert.equal(missing.live.canExit, false);
    assert.ok(missing.live.blockers.includes(SOLANA_STATUS_NO_FALLBACK), missing.live.blockers.join(" | "));
    assert.equal(SOLANA_STATUS_NO_FALLBACK, "Live trading needs a second, independent RPC provider; an operator must configure one.");
    // The owner is never shown a deployment variable's name (the RPC error's own text names one).
    assert.match(new SolanaRpcError("invalid-fallback").message, /MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK/);
    assert.doesNotMatch(missing.live.blockers.join(" "), /MERRYMEN_|could not be verified/);
    // A transport that cannot ask two providers cannot verify the deployment.
    const { readEach: _readEach, ...single } = f.rpc;
    const lone = await f.runtime({ rpc: single }).status(f.scope);
    assert.ok(lone.live.blockers.includes(new SolanaRpcError("no-quorum").message), lone.live.blockers.join(" | "));
    assert.doesNotMatch(lone.live.blockers.join(" "), /MERRYMEN_/);
    // Any other provider failure stays generic: its text is never shown.
    const failing = await f.runtime({ rpc: { ...f.rpc, read: async () => { throw new SolanaRpcError("timeout"); } } }).status(f.scope);
    assert.match(failing.live.blockers.join(" "), /could not be verified/);
    assert.ok(!failing.live.blockers.includes(new SolanaRpcError("timeout").message));
  } finally { f.raw.close(); }
});

test("status tells the owner how to fix the token account a waiting donation needs, by why it is unusable, and only then (executor owner-refund)", async () => {
  const REOPEN = /does not exist \(it was closed or never opened\)\. Reopen your (USDG|wrapped SOL) token account in your wallet, or withdraw a little \1 here, which opens it\./;
  const DELEGATED = /is not safe to use: it has a delegate approved to move its tokens, or a close authority\. Revoke the delegate and remove the close authority in your wallet\. Withdrawing here does not fix this/;
  const FROZEN = /is frozen\. That cannot be fixed from here: only the token's issuer can unfreeze it\./;
  const INVALID = /is not a token account the vault can use\. Check that account in your wallet\./;
  type Owner = "missing" | "usable" | "delegate" | "delegated-amount" | "close-authority" | "frozen" | "other-holder" | "lamports-only";
  const cases: Array<{ mint: string | null; owner: Owner; remedy?: RegExp; canExit: boolean }> = [
    { mint: SOLANA_USDG_MINT, owner: "missing", remedy: REOPEN, canExit: true },
    { mint: SOLANA_WRAPPED_SOL_MINT, owner: "missing", remedy: REOPEN, canExit: false },
    // An address that holds only lamports is opened like a missing one.
    { mint: SOLANA_USDG_MINT, owner: "lamports-only", remedy: REOPEN, canExit: true },
    { mint: SOLANA_WRAPPED_SOL_MINT, owner: "delegate", remedy: DELEGATED, canExit: false },
    { mint: SOLANA_USDG_MINT, owner: "delegated-amount", remedy: DELEGATED, canExit: true },
    { mint: SOLANA_USDG_MINT, owner: "close-authority", remedy: DELEGATED, canExit: true },
    { mint: SOLANA_USDG_MINT, owner: "frozen", remedy: FROZEN, canExit: true },
    { mint: SOLANA_WRAPPED_SOL_MINT, owner: "frozen", remedy: FROZEN, canExit: false },
    { mint: SOLANA_WRAPPED_SOL_MINT, owner: "other-holder", remedy: INVALID, canExit: false },
    { mint: SOLANA_USDG_MINT, owner: "usable", canExit: true },
    { mint: null, owner: "missing", canExit: true },
  ];
  for (const item of cases) {
    const f = await fixture();
    try {
      await readyLive(f); f.controls.sequence = 4n; f.controls.ownerAtas = item.owner === "usable";
      if (item.mint) {
        const program = item.mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM;
        const authority = await deriveSolanaSwapAuthority(PROGRAM, f.vault, 4n);
        f.extra.set(await deriveSolanaAta(authority, item.mint, program), account(f.tokenAccount(item.mint, 7n, authority), program));
        // A temporary account at an earlier sequence is stranded, never a blocker.
        const stale = await deriveSolanaSwapAuthority(PROGRAM, f.vault, 3n);
        f.extra.set(await deriveSolanaAta(stale, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), account(f.tokenAccount(SOLANA_USDG_MINT, 9n, stale), TOKEN_2022_PROGRAM));
        const ownerAta = item.mint === SOLANA_USDG_MINT ? f.ownerCashAta : f.ownerWsolAta;
        const data = f.tokenAccount(item.mint, 0n, item.owner === "other-holder" ? f.vault : f.owner);
        if (item.owner === "delegate") data.writeUInt32LE(1, 72);
        if (item.owner === "delegated-amount") data.writeBigUInt64LE(5n, 121);
        if (item.owner === "close-authority") data.writeUInt32LE(1, 129);
        if (item.owner === "frozen") data[108] = 2;
        if (item.owner === "lamports-only") f.extra.set(ownerAta, account(Buffer.alloc(0), SYSTEM, false, 890_880));
        else if (item.owner !== "missing" && item.owner !== "usable") f.extra.set(ownerAta, account(data, program));
      }
      const status = await f.app.status(f.scope), text = status.live.blockers.join(" | ");
      const label = JSON.stringify(item), blocked = !!item.remedy;
      assert.equal(/next swap account/.test(text), blocked, `${label}: ${text}`);
      assert.equal(status.live.ready, !blocked, label); assert.equal(status.live.canExit, item.canExit, label);
      if (item.remedy) {
        assert.match(text, item.remedy, label);
        const token = item.mint === SOLANA_USDG_MINT ? "USDG" : "wrapped SOL";
        assert.match(text, new RegExp(`Someone sent ${token} to your vault's next swap account\\. The vault returns it to your own ${token} token account, which`), label);
        // Withdrawing opens a missing account; into any other it fixes nothing (and with a delegate, hands it the tokens).
        if (item.remedy !== REOPEN) assert.doesNotMatch(text, /withdraw a little|Reopen your/, label);
        assert.match(text, item.mint === SOLANA_USDG_MINT ? /Buying is paused (until then|while it stays frozen); exits remain available\./ : /Selling and automated exits are refused (until then|while it stays frozen)\./, label);
      }
      assert.notEqual(status.live.balances, null, "the vault is still shown");
    } finally { f.raw.close(); }
  }
});

test("misconfigured swap prices block trading and exits but still show the vault, fee payer, owner wallet and recoverable SOL", async () => {
  for (const env of [{ MERRYMEN_SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS: "2000", MERRYMEN_SOLANA_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS: "1000" },
    { MERRYMEN_SOLANA_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS: "lots" }]) {
    const f = await fixture();
    try {
      await readyLive(f); f.controls.cash = 5_000_000n; f.controls.vaultNativeLamports = 1234;
      const status = await f.runtime({ env: { ...f.env, ...env } }).status(f.scope);
      const text = status.live.blockers.join(" | ");
      assert.match(text, /compute-unit price settings are misconfigured/, JSON.stringify(env));
      assert.equal(status.live.ready, false); assert.equal(status.live.canExit, false, "exits are refused too");
      assert.doesNotMatch(text, /could not be verified/);
      assert.equal(status.live.vault, f.vault); assert.equal(status.live.balances?.cashUsdg, "5000000");
      assert.equal(status.live.feePayer?.level, "ok"); assert.notEqual(status.live.ownerWallet, null);
      assert.equal(status.live.recoverable?.nativeLamports, "1234");
    } finally { f.raw.close(); }
  }
});

/** Rejects with a SolanaAppRuntimeError of `code` whose message matches `message`. */
async function rejectsWith(promise: Promise<unknown>, code: SolanaAppRuntimeError["code"], message: RegExp, label = "") {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof SolanaAppRuntimeError, `${label}: ${String(error)}`);
    assert.equal(error.code, code, `${label}: ${error.message}`); assert.match(error.message, message, label);
    return true;
  });
}

test("every read for a live permission, its status and an owner transaction asks for finalized: Alpenglow made confirmed the same state, and Agave will remove it", async () => {
  const f = await fixture();
  try {
    const asked = new Set<string>();
    const recorded: SolanaLiveRead = async (method, params = []) => {
      for (const param of params) {
        if (!param || typeof param !== "object" || Array.isArray(param)) continue;
        for (const [field, value] of Object.entries(param)) if (/commitment/i.test(field)) asked.add(`${method} ${field}=${String(value)}`);
      }
      return f.read(method, params);
    };
    f.providers.primary = recorded; f.providers.fallback = recorded;
    f.controls.simulatedUnits = 20_000; f.controls.priorityFees = [50_000];
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    const first = await f.app.submitSetup(f.scope, { signedTransactionBase64 });
    f.controls.initialized = true; f.controls.finalized = true;
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64 })).status, "finalized");
    assert.deepEqual(await f.app.activateLive(f.scope, { signature: first.signature, sessionSecretKey: f.sessionSeed.toString("base64") }),
      { registered: true, session: f.session, vault: f.vault });
    await f.app.status(f.scope);
    assert.notEqual((await f.app.prepareOwnerAction(f.scope, { action: "revoke" })).priorityFeeLamports, "0", "the fee estimate's simulation ran");
    assert.deepEqual([...asked].sort(), ["getAccountInfo", "getLatestBlockhash", "getMinimumBalanceForRentExemption", "getMultipleAccounts",
      "getSlot", "getTransaction", "simulateTransaction"].map(method => `${method} commitment=finalized`));
  } finally { f.raw.close(); }
});

test("an activation reads the vault no earlier than the slot its permission finalized at, so a lagging RPC cannot refuse a valid permission", async () => {
  const f = await fixture();
  try {
    await f.live(); const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    const first = await f.app.submitSetup(f.scope, { signedTransactionBase64 });
    // It finalizes at slot 1000 (both providers agree), and the server records that slot.
    f.controls.initialized = true; f.controls.finalized = true;
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64 })).status, "finalized");
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.finalizedSlot, 1000);
    // The provider that answers single reads lags at slot 999, where the vault still holds an
    // older permission (another session key). Asked for slot 1000 or later it errors, as a
    // real RPC does ("minimum context slot has not been reached").
    const stale = f.state(); keyBytes(key(5)).copy(stale, 42);
    const floors: unknown[] = [];
    f.providers.primary = async (method, params = []) => {
      if (method === "getAccountInfo" && params[0] === f.vault && (params[1] as { commitment?: string }).commitment === "finalized") {
        const floor = (params[1] as { minContextSlot?: number }).minContextSlot; floors.push(floor);
        if ((floor ?? 0) > 999) throw new SolanaRpcError("rpc");
        return { context: { slot: 999 }, value: account(stale) };
      }
      return f.read(method, params);
    };
    const activate = () => f.app.activateLive(f.scope, { signature: first.signature, sessionSecretKey: f.sessionSeed.toString("base64") });
    await assert.rejects(activate(), (error: unknown) => error instanceof SolanaRpcError, "a retry, never a refusal of the signed limits");
    assert.deepEqual(floors, [1000]);
    assert.equal(await new SolanaTradingStore(f.db, f.scope).session(), null, "nothing registered from a stale read");
    // Caught up: the same activation succeeds.
    f.providers.primary = null;
    assert.deepEqual(await activate(), { registered: true, session: f.session, vault: f.vault });
  } finally { f.raw.close(); }
});

test("owner bytes refused before anything is saved are 'not-saved'; trouble with saved bytes is 'outcome-unknown', never 'invalid'", async () => {
  const f = await fixture();
  try {
    await f.live();
    const store = () => new SolanaTradingStore(f.db, f.scope);
    await rejectsWith(f.app.submitSetup(f.scope, { signedTransactionBase64: "AQ==" }), "not-saved", /Prepare this owner transaction/, "nothing prepared");
    const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    for (const [label, bytes, message] of [
      ["not base64", "%%%", /Invalid encoded Solana transaction/],
      ["not a transaction", Buffer.from([1, 2, 3]).toString("base64"), /Invalid encoded Solana transaction/],
      ["unsigned", setup.transactionBase64, /owner signature or reviewed transaction does not match/],
    ] as const) {
      await rejectsWith(f.app.submitSetup(f.scope, { signedTransactionBase64: bytes }), "not-saved", message, label);
    }
    // A store refusal (the prepared transaction expired) also saves nothing.
    f.clock.now += 61_000;
    await rejectsWith(f.app.submitSetup(f.scope, { signedTransactionBase64 }), "not-saved", /expired before submission/, "expired");
    assert.equal((await store().setup())!.signature, undefined); assert.equal(f.controls.sends, 0);
    f.clock.now -= 61_000;
    // Saved and broadcast; then other bytes are refused, not saved.
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64 })).status, "pending"); assert.equal(f.controls.sends, 1);
    const altered = Buffer.from(signedTransactionBase64, "base64"); altered[1] = altered[1]! ^ 1;
    await rejectsWith(f.app.submitSetup(f.scope, { signedTransactionBase64: altered.toString("base64") }), "not-saved", /does not match/, "a forged signature");
    // The saved bytes' confirmation is malformed: their outcome is unknown.
    f.controls.finalized = true; f.controls.malformed = true;
    await rejectsWith(f.app.submitSetup(f.scope, { signedTransactionBase64 }), "outcome-unknown", /^Invalid owner transaction confirmation\.$|^Owner confirmation does not match the saved transaction\.$/, "malformed");
    assert.equal((await store().setup())!.status, "pending");
    // A receipt whose vault effect is missing is not believed: also an unknown outcome.
    f.controls.malformed = false;
    await rejectsWith(f.app.submitSetup(f.scope, { signedTransactionBase64 }), "outcome-unknown", /^Owner confirmation does not match the vault state\.$/, "no vault effect");
    // And an activation of such a permission is a retry, not a refusal.
    await rejectsWith(f.app.activateLive(f.scope, { signature: getBase58Decoder().decode(Buffer.from(signedTransactionBase64, "base64").subarray(1, 65)), sessionSecretKey: f.sessionSeed.toString("base64") }),
      "outcome-unknown", /does not match the vault state/, "activation");
    assert.equal(f.controls.sends, 1, "nothing is sent again for a finalized-looking receipt");
  } finally { f.raw.close(); }
});

test("not-saved speaks only for this request: bytes an earlier request saved, sent and finalized are refused that way once replaced", async () => {
  const f = await fixture();
  try {
    await readyLive(f); f.controls.vaultNativeLamports = 100;
    const first = await f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "50" });
    const signedTransactionBase64 = await f.sign(first.transactionBase64);
    const { signature } = await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 });
    assert.equal(f.controls.sends, 1);
    landOwner(f);
    assert.equal((await f.app.submitOwnerAction(f.scope, { signedTransactionBase64 })).status, "finalized");
    // A new prepare replaces the setup; the old bytes no longer match it.
    await f.app.prepareOwnerAction(f.scope, { action: "withdraw-sol", amountRaw: "10" });
    await rejectsWith(f.app.submitOwnerAction(f.scope, { signedTransactionBase64 }), "not-saved", /does not match/, "landed earlier");
    // This request saved and sent nothing, but the bytes did land: the server's record still shows it.
    assert.equal(f.controls.sends, 1);
    assert.deepEqual(await rows(f, `SELECT evidence_id,kind FROM solana_runtime_cashflows WHERE kind='withdraw-sol'`), [{ evidence_id: signature, kind: "withdraw-sol" }]);
  } finally { f.raw.close(); }
});

test("a permission whose saved limits expire inside the prepare window is refused as not-saved, and nothing is saved or sent", async () => {
  const f = await fixture();
  try {
    // The limits expire 30 seconds after the permission is prepared; the prepare window is 60 seconds.
    f.clock.now = limits.expiresAtMs - 30_000;
    await f.live();
    const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    f.clock.now = limits.expiresAtMs + 1_000;
    assert.ok(f.clock.now < setup.expiresAtMs, "still inside the prepare window");
    await rejectsWith(f.app.submitSetup(f.scope, { signedTransactionBase64 }), "not-saved", /^The saved trading limits are no longer valid/, "expired limits");
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.signature, undefined, "nothing saved");
    assert.equal(f.controls.sends, 0, "nothing sent");
  } finally { f.raw.close(); }
});

test("a permission is prepared only from limits within the account bounds, paper-shaped ones included, before any chain read", async () => {
  const f = await fixture();
  try {
    await f.live();
    const { perTradeWsol: _perTrade, dailyWsol: _daily, ...paperShaped } = limits;
    for (const wide of [{ ...paperShaped, maxOpsPerDay: 500 }, { ...limits, maxOpsPerDay: 97 }, { ...paperShaped, expiresAtMs: f.clock.now + 169 * 3_600_000 }]) {
      f.calls.length = 0;
      await assert.rejects(f.app.prepareLive(f.scope, { limits: wide, sessionPublicKey: f.session }),
        (error: unknown) => error instanceof SolanaPaperValidationError && /between 1 and 96|168 hours/.test(error.message), JSON.stringify(wide));
      assert.deepEqual(f.calls, [], "refused before any RPC read");
    }
    assert.equal(await new SolanaTradingStore(f.db, f.scope).setup(), null, "nothing prepared");
  } finally { f.raw.close(); }
});

test("a registration whose limits could make only live trades under the 1 USDG minimum is refused before anything is prepared; the SOL sold per trade is valued at the lowest provider's price", async () => {
  const f = await fixture();
  try {
    const save = async (saved: typeof limits) => { const binding = (await f.bindings.get(TENANT))!; await f.bindings.settings(TENANT, f.owner, binding.revision, "live", saved); };
    const refusal = (message: string, code: SolanaAppRuntimeError["code"]) => (error: unknown) => error instanceof SolanaAppRuntimeError && error.code === code && error.message === message;
    // USDG per trade under 1 USDG: refused with no RPC read at all.
    const small = { ...limits, perTradeUsdg: "999999" };
    await save(small); f.calls.length = 0;
    await assert.rejects(f.app.prepareLive(f.scope, { limits: small, sessionPublicKey: f.session }), refusal(SOLANA_LIVE_PER_TRADE_BELOW_MINIMUM, "permission"));
    assert.deepEqual(f.calls, [], "refused before any RPC read");
    // 0.008 SOL per trade is 0.96 USDG at $120: no sale smaller than the whole position could be admitted.
    const capped = { ...limits, perTradeWsol: "8000000" };
    await save(capped);
    await assert.rejects(f.app.prepareLive(f.scope, { limits: capped, sessionPublicKey: f.session }), refusal(SOLANA_LIVE_SELL_CAP_BELOW_MINIMUM, "permission"));
    // 0.0084 SOL is 1.008 USDG at $120, but one provider serving $110 values it at 0.924 USDG: the lower price decides.
    const edge = { ...limits, perTradeWsol: "8400000" };
    await save(edge);
    const serving = (price: bigint): SolanaLiveRead => async (method, params = []) => method === "getAccountInfo" && params[0] === PYTH_SOL_USD_ACCOUNT
      ? f.response(pythAccount({ price, publishTimeMs: f.clock.now, postedSlot: 999n })) : f.read(method, params);
    f.providers.fallback = serving(11_000_000_000n);
    await assert.rejects(f.app.prepareLive(f.scope, { limits: edge, sessionPublicKey: f.session }), refusal(SOLANA_LIVE_SELL_CAP_BELOW_MINIMUM, "permission"));
    // A price that cannot be read refuses (retry later), never assumed.
    f.providers.fallback = null; f.controls.pythPrice = null;
    await assert.rejects(f.app.prepareLive(f.scope, { limits: edge, sessionPublicKey: f.session }), refusal(SOLANA_LIVE_SELL_CAP_UNCHECKED, "pending"));
    await assert.rejects(f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_PYTH_GENERATION: "both" } }).prepareLive(f.scope, { limits: edge, sessionPublicKey: f.session }),
      (error: unknown) => error instanceof SolanaAppRuntimeError && error.code === "configuration");
    assert.equal(await new SolanaTradingStore(f.db, f.scope).setup(), null, "nothing prepared");
    // Both providers at $120: prepared, and the permission signs the cap as saved.
    f.controls.pythPrice = 12_000_000_000n;
    const setup = await f.app.prepareLive(f.scope, { limits: edge, sessionPublicKey: f.session });
    assert.ok(setup.transactionBase64);
    assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.limits.perTradeWsol, "8400000");
  } finally { f.raw.close(); }
});

test("a trade carries the owner's previewed minimum beside its intent: paper is held to it, a retry is not, and a preview takes none", async () => {
  const f = await fixture();
  try {
    await f.app.setupPaper(f.scope, { initialCashRaw: "100000000", limits });
    const paper = () => new SolanaTradingStore(f.db, f.scope).paper().get(f.owner);
    // The fixture market guarantees 995,000 for this 1,000,000 buy.
    await assert.rejects(f.app.trade(f.scope, { mode: "paper", intent: { ...f.trade, minOutAmount: "995001" } }), /below the previewed minimum/);
    assert.equal((await paper())!.trades.length, 0);
    const placed = await f.app.trade(f.scope, { mode: "paper", intent: { ...f.trade, minOutAmount: "995000" } });
    for (const retry of [{ ...f.trade, minOutAmount: "999999999" }, f.trade]) assert.deepEqual(await f.app.trade(f.scope, { mode: "paper", intent: retry }), placed);
    assert.equal((await paper())!.trades.length, 1);
    await assert.rejects(f.app.trade(f.scope, { mode: "paper", intent: { ...f.trade, requestId: "next", minOutAmount: "0" } }), SolanaPaperValidationError);
    // A preview is not a trade: it takes no floor.
    await assert.rejects(f.app.preview(f.scope, { mode: "paper", intent: { ...f.trade, minOutAmount: "1" } }), /unsupported fields/);
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("a retry of a recorded live trade is returned whatever previewed minimum it carries; another trade under its id still conflicts", async () => {
  const f = await fixture();
  try {
    await f.live(); f.controls.initialized = true; await ensureSolanaTradingSchema(f.db);
    const intent = { kind: "spl-swap", chain: CHAINS.solana, mode: "live", requestId: "owner-retry", owner: f.owner, vault: f.vault,
      inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000", slippageBps: 50 };
    const submission = { intent, programId: PROGRAM, signature: "owner-retry-signature", minContextSlot: 1000, preparedAtMs: f.clock.now,
      minOutAmount: "995000", quotedOutAmount: "1000000", vaultSequence: "0", sessionEpoch: "1" };
    await f.db.prepare("INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(f.scope.tenant, f.owner, intent.requestId, f.vault, "0", submission.signature, "pending", f.clock.now, "1000000", JSON.stringify(submission));
    // Both providers have seen the signature (processed), so the record stays pending and nothing is sent again.
    const seen: SolanaLiveRead = async (method, params = []) => method === "getSignatureStatuses" ? f.response([{ confirmationStatus: "processed", slot: 1000, err: null }])
      : method === "getTransaction" ? null : f.read(method, params);
    f.providers.primary = seen; f.providers.fallback = seen;
    const { owner: _owner, vault: _vault, ...asked } = intent;
    const answers = [];
    for (const minOutAmount of ["999999999", "1", undefined]) {
      answers.push(await f.app.trade(f.scope, { mode: "live", intent: minOutAmount === undefined ? asked : { ...asked, minOutAmount } }));
    }
    for (const answer of answers) assert.deepEqual(answer, { mode: "live", requestId: "owner-retry", intent, signature: "owner-retry-signature", status: "pending",
      preparedAtMs: f.clock.now, minOutAmount: "995000", quotedOutAmount: "1000000", settlement: null });
    await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: { ...asked, amountRaw: "2000000", minOutAmount: "1" } }), /different live trade/);
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("a misconfigured reference tolerance pages the operator: one [alert] a minute per process, naming the setting and never the value", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    const quiet: string[] = [];
    assert.equal((await f.runtime({ log: line => quiet.push(line) }).status(f.scope)).live.ready, true);
    assert.deepEqual(quiet.filter(line => line.startsWith("[alert] solana-reference-tolerance")), [], "a good setting says nothing");
    const lines: string[] = [];
    const app = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS: "nonsense-9999" }, log: line => lines.push(line) });
    const said = () => lines.filter(line => line.startsWith("[alert] solana-reference-tolerance"));
    const status = await app.status(f.scope);
    assert.ok(status.live.blockers.includes("The independent SOL price tolerance is misconfigured."));
    assert.equal(status.live.canExit, false);
    assert.deepEqual(said(), ["[alert] solana-reference-tolerance misconfigured: MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS must be a whole number from 50 to 1000 (unset is 300); "
      + "no live Solana trade, exits included, is admitted until it is fixed"]);
    assert.ok(!lines.join("\n").includes("nonsense-9999"), "the value is never echoed");
    // Within the minute: refused again as configuration, not said again.
    f.clock.now += 30_000;
    await rejectsWith(app.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live", requestId: "tolerance-1" } }), "configuration", /tolerance is misconfigured/);
    assert.equal(said().length, 1);
    f.clock.now += 30_000;
    await app.status(f.scope);
    assert.equal(said().length, 2, "said again once a minute has passed");
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("a malformed expired-attempt allowance is a status blocker and refuses a live trade as configuration, before anything is signed", async () => {
  const f = await fixture();
  try {
    await readyLive(f);
    assert.equal((await f.app.status(f.scope)).live.ready, true, "unset: the default applies");
    for (const value of ["97", "-1", "many"]) {
      const app = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: value } });
      const status = await app.status(f.scope);
      assert.equal(status.live.ready, false); assert.equal(status.live.canExit, false);
      assert.ok(status.live.blockers.some(item => /expired-attempt allowance setting is misconfigured/.test(item)), status.live.blockers.join(" | "));
      await rejectsWith(app.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live", requestId: `allowance-${value}` } }), "configuration", /expired-attempt allowance setting is misconfigured/, value);
    }
    assert.equal((await new SolanaTradingStore(f.db, f.scope).pending()).length, 0); assert.equal(f.controls.sends, 0);
    assert.equal((await f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: "96" } }).status(f.scope)).live.ready, true);
  } finally { f.raw.close(); }
});

/** A runtime refusal with exactly this code and owner-facing text. */
const rollout = (message: string, code: SolanaAppRuntimeError["code"]) => (error: unknown) => {
  assert.ok(error instanceof SolanaAppRuntimeError, String(error)); assert.equal(error.message, message); assert.equal(error.code, code); return true;
};
const OTHER_TENANT = `0x${"22".repeat(20)}`;

test("live rollout: a tenant MERRYMEN_SOLANA_LIVE_TENANTS does not name cannot save live mode, prepare, submit or activate a permission, or buy; paper and status still work", async () => {
  const f = await fixture();
  try {
    // Unset, empty, only spaces, or naming another tenant: this tenant may not go live, and status says so without a blocker (nothing to exit).
    for (const value of [undefined, "", "  ", OTHER_TENANT]) {
      const off = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: value } });
      await assert.rejects(off.checkLiveSettings(f.scope, limits), rollout(SOLANA_LIVE_NOT_OPEN, "permission"), String(value));
      const status = await off.status(f.scope);
      assert.deepEqual(status.liveAccess, { onList: false, misconfigured: false, caps: { perTradeUsdg: "10000000", dailyUsdg: "50000000", perTradeWsol: "100000000", dailyWsol: "500000000" } });
      assert.ok(!status.live.blockers.includes(SOLANA_LIVE_PAUSED), status.live.blockers.join(" | "));
    }
    const off = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: OTHER_TENANT } });
    // Paper is open to every tenant.
    await off.setupPaper(f.scope, { initialCashRaw: "100000000", limits });
    assert.equal((await off.trade(f.scope, { mode: "paper", intent: f.trade })).mode, "paper");
    // Live mode saved while it was on the list, with no permission yet: status says it is not open (nothing to exit) ...
    await f.live();
    const liveMode = await off.status(f.scope);
    assert.ok(liveMode.live.blockers.includes(SOLANA_LIVE_NOT_OPEN) && !liveMode.live.blockers.includes(SOLANA_LIVE_PAUSED), liveMode.live.blockers.join(" | "));
    // ... and no new permission, live buy or buy preview, each refused before any chain read.
    f.calls.length = 0;
    await assert.rejects(off.prepareLive(f.scope, { limits, sessionPublicKey: f.session }), rollout(SOLANA_LIVE_NOT_OPEN, "permission"));
    await assert.rejects(off.preview(f.scope, { mode: "live", intent: { ...f.trade, mode: "live" } }), rollout(SOLANA_LIVE_NOT_OPEN, "permission"));
    await assert.rejects(off.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live", requestId: "off-list-buy" } }), rollout(SOLANA_LIVE_NOT_OPEN, "permission"));
    assert.deepEqual(f.calls, [], "refused before any chain read");
    assert.equal(await new SolanaTradingStore(f.db, f.scope).setup(), null, "nothing prepared");
    // A permission prepared while it was on the list is neither saved nor sent once it is off.
    const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    await assert.rejects(off.submitSetup(f.scope, { signedTransactionBase64 }), rollout(SOLANA_LIVE_NOT_OPEN, "not-saved"));
    assert.equal(f.controls.sends, 0); assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.signature, undefined, "not saved");
    // One submitted while it was on the list and landed is not activated once it is off; the owner keeps the session key to finish later.
    const submitted = await f.app.submitSetup(f.scope, { signedTransactionBase64 });
    f.controls.initialized = true; f.controls.finalized = true;
    await assert.rejects(off.activateLive(f.scope, { signature: submitted.signature, sessionSecretKey: f.sessionSeed.toString("base64") }), rollout(SOLANA_LIVE_NOT_OPEN, "permission"));
    assert.equal(await new SolanaTradingStore(f.db, f.scope).session(), null, "not activated");
    // Bytes already saved are still answered: their outcome is the owner's to learn.
    assert.equal((await off.submitSetup(f.scope, { signedTransactionBase64 })).status, "finalized");
    // Back on the list (among others, with spaces), the same permission activates.
    const on = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: ` ${OTHER_TENANT} , ${TENANT} ` } });
    assert.equal((await on.activateLive(f.scope, { signature: submitted.signature, sessionSecretKey: f.sessionSeed.toString("base64") })).registered, true);
    assert.equal((await on.status(f.scope)).liveAccess.onList, true);
  } finally { f.raw.close(); }
});

test("live rollout: a tenant taken off the list after going live is exits-only: status says so plainly, buys and new permissions are refused, and revoke, withdrawals, outside withdrawals and live mode for its exits still work", async () => {
  const f = await fixture();
  try {
    await readyLive(f); await cashBook(f);
    const listed = await f.app.status(f.scope);
    assert.equal(listed.live.ready, true, listed.live.blockers.join(" | ")); assert.equal(listed.liveAccess.onList, true);
    for (const value of [OTHER_TENANT, undefined]) {
      const off = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: value } });
      const status = await off.status(f.scope);
      assert.deepEqual(status.live.blockers, [SOLANA_LIVE_PAUSED], String(value));
      assert.equal(status.live.ready, false); assert.equal(status.live.canExit, true, "exits stay open");
      assert.equal(status.liveAccess.onList, false);
    }
    const off = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: OTHER_TENANT } });
    f.calls.length = 0;
    await assert.rejects(off.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live", requestId: "paused-buy" } }), rollout(SOLANA_LIVE_PAUSED, "permission"));
    await assert.rejects(off.prepareLive(f.scope, { limits, sessionPublicKey: f.session }), rollout(SOLANA_LIVE_PAUSED, "permission"));
    assert.deepEqual(f.calls, [], "refused before any chain read");
    // Live mode may be saved again: it is how its exits are sold (they can never be registered while it is off the list). Within the caps;
    // this session was recorded before its limits were kept, so the caps alone bound them.
    await off.checkLiveSettings(f.scope, limits);
    const ceiling = (dailyUsdg: string) => ({ perTradeUsdg: "10000000", dailyUsdg, perTradeWsol: "100000000", dailyWsol: "500000000" });
    await assert.rejects(off.checkLiveSettings(f.scope, { ...limits, dailyUsdg: "900000000" }),
      rollout(solanaLiveExitLimitsRefusal({ ...limits, dailyUsdg: "900000000" }, ceiling("50000000"))!, "permission"));
    // Up to what the permission it registered allows where that is more (kept when activateLive registered it): its sales are never narrowed.
    const record = JSON.parse((await f.db.prepare("SELECT record_json FROM solana_runtime_sessions").get() as { record_json: string }).record_json);
    await f.db.prepare("UPDATE solana_runtime_sessions SET record_json=?").run(JSON.stringify({ ...record, limits: ceiling("100000000") }));
    await off.checkLiveSettings(f.scope, { ...limits, dailyUsdg: "100000000" });
    await assert.rejects(off.checkLiveSettings(f.scope, { ...limits, dailyUsdg: "100000001" }),
      rollout(solanaLiveExitLimitsRefusal({ ...limits, dailyUsdg: "100000001" }, ceiling("100000000"))!, "permission"));
    // With the caps unreadable, the permission's own limits bound them.
    const unreadable = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "lots" }, log: () => {} });
    await unreadable.checkLiveSettings(f.scope, { ...limits, dailyUsdg: "100000000" });
    await assert.rejects(unreadable.checkLiveSettings(f.scope, { ...limits, dailyWsol: "500000001" }), /permission you registered/);
    // Withdraw USDG, wrapped SOL and native SOL, then revoke: each is prepared; the revocation is signed and sent.
    f.controls.unsyncedWsolLamports = 13; f.controls.vaultNativeLamports = 100;
    for (const action of [{ action: "withdraw" as const, mint: SOLANA_USDG_MINT, amountRaw: "1000000" }, { action: "withdraw" as const, mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "13" },
      { action: "withdraw-sol" as const, amountRaw: "100" }]) {
      assert.ok((await off.prepareOwnerAction(f.scope, action)).transactionBase64, JSON.stringify(action));
    }
    const revoke = await off.prepareOwnerAction(f.scope, { action: "revoke" });
    assert.equal((await off.submitOwnerAction(f.scope, { signedTransactionBase64: await f.sign(revoke.transactionBase64) })).status, "pending");
    assert.equal(f.controls.sends, 1);
  } finally { f.raw.close(); }
});

test("live rollout: a live book without a registered permission also means the account went live: off the list it is paused (not 'not open'), and keeps live mode for its exits", async () => {
  const f = await fixture();
  try {
    // A live book but no session row: as if books were created another way (a resolve tool, say). Off the list.
    await f.live(); f.controls.initialized = true; await ensureSolanaTradingSchema(f.db); await cashBook(f);
    const off = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: OTHER_TENANT } });
    const status = await off.status(f.scope);
    assert.ok(status.live.blockers.includes(SOLANA_LIVE_PAUSED_NO_PERMISSION), status.live.blockers.join(" | "));
    assert.ok(!status.live.blockers.includes(SOLANA_LIVE_NOT_OPEN));
    await assert.rejects(off.prepareLive(f.scope, { limits, sessionPublicKey: f.session }), rollout(SOLANA_LIVE_PAUSED, "permission"));
    await off.checkLiveSettings(f.scope, limits);
    // The same account with no book: never went live, so not open, and it may not save live mode.
    await f.db.prepare("DELETE FROM solana_runtime_live_books").run();
    assert.ok((await off.status(f.scope)).live.blockers.includes(SOLANA_LIVE_NOT_OPEN));
    await assert.rejects(off.prepareLive(f.scope, { limits, sessionPublicKey: f.session }), rollout(SOLANA_LIVE_NOT_OPEN, "permission"));
    await assert.rejects(off.checkLiveSettings(f.scope, limits), rollout(SOLANA_LIVE_NOT_OPEN, "permission"));
  } finally { f.raw.close(); }
});

test("live rollout: off the list, withdrawals made outside Merrymen are still recorded", async () => {
  const f = await fixture();
  try {
    await readyLive(f); await cashBook(f);
    const off = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: "" } });
    f.controls.cash = 0n;
    const signature = await outsideWithdrawal(f, SOLANA_USDG_MINT, 90_000_000n, [90_000_000n, 0n]);
    const recorded = await off.recordExternalWithdrawals(f.scope, { signatures: [signature] });
    assert.deepEqual(recorded.booked, [{ signature, mint: SOLANA_USDG_MINT, amountRaw: "90000000" }]);
    assert.deepEqual((await off.status(f.scope)).live.blockers, [SOLANA_LIVE_PAUSED], "the book matches the vault again; only buying stays paused");
  } finally { f.raw.close(); }
});

test("live rollout caps: live limits above a cap are refused where they are saved and where a permission is prepared, naming the cap; the defaults apply when unset", async () => {
  const f = await fixture();
  try {
    // No cap settings: 10 USDG and 0.1 SOL per trade, 25 USDG and 0.25 SOL a day.
    const defaults = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: undefined, MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: undefined } });
    assert.deepEqual((await defaults.status(f.scope)).liveAccess, { onList: true, misconfigured: false, caps: SOLANA_LIVE_CAP_DEFAULTS });
    const atCaps = { ...limits, dailyUsdg: "25000000", dailyWsol: "250000000" };
    await defaults.checkLiveSettings(f.scope, atCaps);
    for (const over of [{ ...atCaps, perTradeUsdg: "10000001", dailyUsdg: "25000000" }, { ...atCaps, dailyUsdg: "25000001" }, { ...atCaps, perTradeWsol: "100000001" },
      { ...atCaps, dailyWsol: "250000001" }, limits]) {
      await assert.rejects(defaults.checkLiveSettings(f.scope, over), rollout(solanaLiveCapRefusal(over, SOLANA_LIVE_CAP_DEFAULTS, "save")!, "permission"), JSON.stringify(over));
    }
    assert.equal(solanaLiveCapRefusal(limits, SOLANA_LIVE_CAP_DEFAULTS, "save"), "USDG per 24 hours is above this platform's live cap of 25 USDG; SOL sold per 24 hours is above "
      + "this platform's live cap of 0.25 SOL. Live limits here are at most 10 USDG per trade, 25 USDG per 24 hours, 0.1 SOL sold per trade and 0.25 SOL sold per 24 hours. "
      + "Lower them and save again. Nothing was saved.");
    // Limits saved before the caps were lowered: registering them is refused before any chain read, and status warns.
    await f.live(); f.calls.length = 0;
    await assert.rejects(defaults.prepareLive(f.scope, { limits, sessionPublicKey: f.session }), rollout(solanaLiveCapRefusal(limits, SOLANA_LIVE_CAP_DEFAULTS, "register")!, "permission"));
    assert.deepEqual(f.calls, [], "refused before any chain read");
    assert.equal(await new SolanaTradingStore(f.db, f.scope).setup(), null, "nothing prepared");
    assert.ok((await defaults.status(f.scope)).live.warnings.includes(solanaLiveSavedAboveCaps(SOLANA_LIVE_CAP_DEFAULTS)));
    // Within the caps the same account prepares, and the session signed on chain carries those limits.
    const binding = (await f.bindings.get(TENANT))!;
    await f.bindings.settings(TENANT, f.owner, binding.revision, "live", atCaps);
    const prepared = await defaults.prepareLive(f.scope, { limits: atCaps, sessionPublicKey: f.session });
    assert.deepEqual((await new SolanaTradingStore(f.db, f.scope).setup())!.limits, atCaps); assert.ok(prepared.transactionBase64);
    assert.ok(!(await defaults.status(f.scope)).live.warnings.includes(solanaLiveSavedAboveCaps(SOLANA_LIVE_CAP_DEFAULTS)));
  } finally { f.raw.close(); }
});

test("live rollout caps: a permission registered above caps lowered since is told it may not buy, and its exits stay open", async () => {
  const f = await fixture();
  try {
    // The fixture's permission allows 50 USDG and 0.5 SOL a day; the caps are lowered to the defaults.
    await readyLive(f);
    const lowered = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: undefined, MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: undefined } });
    const status = await lowered.status(f.scope);
    assert.deepEqual(status.live.blockers, [solanaLiveSessionAboveCaps(SOLANA_LIVE_CAP_DEFAULTS)]);
    assert.equal(status.live.ready, false); assert.equal(status.live.canExit, true);
    // At the caps the fixture's own: ready.
    assert.equal((await f.app.status(f.scope)).live.ready, true);
  } finally { f.raw.close(); }
});

test("live rollout: a malformed list or cap refuses new permissions and buys as configuration with one [alert] a minute naming the setting, never the value; exits, revoke and withdraw continue", async () => {
  const f = await fixture();
  try {
    await readyLive(f); await cashBook(f);
    for (const [setting, value, said] of [
      ["MERRYMEN_SOLANA_LIVE_TENANTS", `${TENANT},`, "MERRYMEN_SOLANA_LIVE_TENANTS entry 2 is empty"],
      ["MERRYMEN_SOLANA_LIVE_TENANTS", `${TENANT}, 0x9876`, "MERRYMEN_SOLANA_LIVE_TENANTS entry 2 is not a tenant id (0x and 40 hex digits)"],
      ["MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG", "25 USDG", "MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG must be a positive amount in USDG with at most 6 decimal places"],
      ["MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL", "0.1234567891", "MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL must be a positive amount in SOL with at most 9 decimal places"],
      ["MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG", "77", "MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG must not exceed MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG"],
    ] as const) {
      const lines: string[] = [];
      const app = f.runtime({ env: { ...f.env, [setting]: value }, log: line => lines.push(line) });
      const status = await app.status(f.scope);
      assert.deepEqual(status.live.blockers, [SOLANA_LIVE_ROLLOUT_MISCONFIGURED], setting);
      assert.equal(status.live.canExit, true); assert.equal(status.liveAccess.misconfigured, true); assert.equal(status.liveAccess.onList, setting === "MERRYMEN_SOLANA_LIVE_TENANTS" ? false : true);
      await assert.rejects(app.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live", requestId: "misconfigured-buy" } }), rollout(SOLANA_LIVE_ROLLOUT_MISCONFIGURED, "configuration"));
      await assert.rejects(app.prepareLive(f.scope, { limits, sessionPublicKey: f.session }), rollout(SOLANA_LIVE_ROLLOUT_MISCONFIGURED, "configuration"));
      // It went live, so it keeps live mode for its exits; revoke and withdraw prepare.
      await app.checkLiveSettings(f.scope, limits);
      assert.ok((await app.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" })).transactionBase64);
      assert.ok((await app.prepareOwnerAction(f.scope, { action: "revoke" })).transactionBase64);
      const alerts = lines.filter(line => line.startsWith("[alert] solana-live-rollout misconfigured: "));
      assert.equal(alerts.length, 1, "once a minute per process, however often it is read");
      assert.ok(alerts[0]!.includes(said), alerts[0]); assert.ok(alerts[0]!.endsWith("no new live Solana permission or live buy is admitted until it is fixed (exits, revoke and withdraw continue)"));
      assert.ok(!alerts[0]!.includes(value.trim()) && !alerts[0]!.includes(TENANT), "never the value");
      f.clock.now += 60_000; await app.status(f.scope);
      assert.equal(lines.filter(line => line.startsWith("[alert] solana-live-rollout")).length, 2, "said again after a minute");
    }
    // An account that never went live cannot save live mode while the list cannot be read.
    const g = await fixture();
    try {
      await assert.rejects(g.runtime({ env: { ...g.env, MERRYMEN_SOLANA_LIVE_TENANTS: "everyone" }, log: () => {} }).checkLiveSettings(g.scope, limits),
        rollout(SOLANA_LIVE_ROLLOUT_MISCONFIGURED, "configuration"));
    } finally { g.raw.close(); }
  } finally { f.raw.close(); }
});

test("live rollout: a renewal that lands after the tenant left the list is activated, so the account keeps a permission to sell under, while its buys stay refused", async () => {
  // Off the list, or with the list unreadable: either way the account already went live.
  for (const listed of [OTHER_TENANT, `${TENANT},`]) {
    const f = await fixture();
    try {
      await readyLive(f); await cashBook(f);
      const chain = ownerChain(f);
      // While listed, the owner renews: the new permission is prepared and submitted ...
      const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
      const setupSigned = await f.sign(setup.transactionBase64);
      const registration = await f.app.submitSetup(f.scope, { signedTransactionBase64: setupSigned });
      // ... and lands after the tenant was taken off the list, replacing the old permission on Solana (create_session moves the epoch).
      chain.land(registration.signature, setupSigned); f.controls.epoch = 2n;
      const off = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: listed }, log: () => {} });
      const replaced = await off.status(f.scope);
      assert.ok(replaced.live.blockers.includes("Register an owner-approved live trading permission."), replaced.live.blockers.join(" | "));
      assert.equal(replaced.live.canExit, false, "the permission the app holds is no longer the vault's");
      assert.equal((await off.activateLive(f.scope, { signature: registration.signature, sessionSecretKey: f.sessionSeed.toString("base64") })).registered, true, listed);
      assert.equal((await new SolanaTradingStore(f.db, f.scope).session())!.registrationSignature, registration.signature);
      // Exits are open again under the permission the owner signed; buying stays paused.
      const after = await off.status(f.scope);
      assert.deepEqual(after.live.blockers, [listed === OTHER_TENANT ? SOLANA_LIVE_PAUSED : SOLANA_LIVE_ROLLOUT_MISCONFIGURED]);
      assert.equal(after.live.canExit, true); assert.equal(after.live.ready, false);
      await assert.rejects(off.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live", requestId: "renewed-buy" } }),
        rollout(listed === OTHER_TENANT ? SOLANA_LIVE_PAUSED : SOLANA_LIVE_ROLLOUT_MISCONFIGURED, listed === OTHER_TENANT ? "permission" : "configuration"));
    } finally { f.raw.close(); }
  }
});

test("live rollout: off the list, an account whose permission expired or was replaced on Solana is never told exits still work: it cannot sell, and only revoke and withdraw remain", async () => {
  const REGISTER = "Register an owner-approved live trading permission.", EXPIRED = "The on-chain trading permission has expired.";
  for (const [listed, said] of [[OTHER_TENANT, SOLANA_LIVE_PAUSED_NO_PERMISSION], [`${TENANT},`, SOLANA_LIVE_ROLLOUT_MISCONFIGURED_NO_PERMISSION]] as const) {
    const exitsOpen = listed === OTHER_TENANT ? SOLANA_LIVE_PAUSED : SOLANA_LIVE_ROLLOUT_MISCONFIGURED;
    // Expired: the permission the owner signed ran out after the tenant left the list, and no new one can be registered off it.
    const f = await fixture();
    try {
      await readyLive(f); await cashBook(f);
      const off = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: listed }, log: () => {} });
      assert.deepEqual((await off.status(f.scope)).live.blockers, [exitsOpen], "a current permission: exits are open, and said to be");
      f.clock.now = limits.expiresAtMs;
      const expired = await off.status(f.scope);
      assert.ok(expired.live.blockers.includes(EXPIRED) && expired.live.blockers.includes(said), expired.live.blockers.join(" | "));
      assert.ok(!expired.live.blockers.includes(exitsOpen), "never \"exits still work\"");
      assert.equal(expired.live.canExit, false);
      // Revoke and withdraw still prepare.
      assert.ok((await off.prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_USDG_MINT, amountRaw: "1000000" })).transactionBase64);
      assert.ok((await off.prepareOwnerAction(f.scope, { action: "revoke" })).transactionBase64);
    } finally { f.raw.close(); }
    // Replaced: a renewal submitted while listed landed after the tenant left it; until it is activated the app's permission is not the vault's.
    const g = await fixture();
    try {
      await readyLive(g); await cashBook(g);
      const chain = ownerChain(g);
      const setup = await g.app.prepareLive(g.scope, { limits, sessionPublicKey: g.session });
      const signed = await g.sign(setup.transactionBase64);
      const registration = await g.app.submitSetup(g.scope, { signedTransactionBase64: signed });
      chain.land(registration.signature, signed); g.controls.epoch = 2n;
      const replaced = await g.runtime({ env: { ...g.env, MERRYMEN_SOLANA_LIVE_TENANTS: listed }, log: () => {} }).status(g.scope);
      assert.ok(replaced.live.blockers.includes(REGISTER) && replaced.live.blockers.includes(said), replaced.live.blockers.join(" | "));
      assert.ok(!replaced.live.blockers.includes(exitsOpen)); assert.equal(replaced.live.canExit, false);
    } finally { g.raw.close(); }
  }
});

test("live rollout caps: a permission prepared before the caps were lowered is neither saved nor sent once they are, naming the caps; within them it is", async () => {
  const f = await fixture();
  try {
    // Prepared under the fixture's caps (50 USDG and 0.5 SOL a day) ...
    await f.live(); f.controls.initialized = true;
    const setup = await f.app.prepareLive(f.scope, { limits, sessionPublicKey: f.session });
    const signedTransactionBase64 = await f.sign(setup.transactionBase64);
    // ... and submitted after a deploy lowered them to the defaults (25 USDG and 0.25 SOL a day).
    const lowered = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: undefined, MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: undefined } });
    const said = solanaLiveCapRefusal(limits, SOLANA_LIVE_CAP_DEFAULTS, "submit")!;
    assert.match(said, /^USDG per 24 hours is above this platform's live cap of 25 USDG; .* Save live limits within them and register again\. Nothing was sent\.$/);
    await assert.rejects(lowered.submitSetup(f.scope, { signedTransactionBase64 }), rollout(said, "not-saved"));
    assert.equal(f.controls.sends, 0, "nothing sent"); assert.equal((await new SolanaTradingStore(f.db, f.scope).setup())!.signature, undefined, "nothing saved");
    // A cap that cannot be read refuses it as configuration, also unsaved.
    await assert.rejects(f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL: "lots" }, log: () => {} }).submitSetup(f.scope, { signedTransactionBase64 }),
      rollout(SOLANA_LIVE_ROLLOUT_MISCONFIGURED, "not-saved"));
    assert.equal(f.controls.sends, 0);
    // Under the caps it was prepared within, the same bytes are saved and sent.
    assert.equal((await f.app.submitSetup(f.scope, { signedTransactionBase64 })).status, "pending");
    assert.equal(f.controls.sends, 1);
  } finally { f.raw.close(); }
});

test("live rollout caps: a live buy preview is refused before any quote while a cap cannot be read, as the trade would be; a sale preview still quotes", async () => {
  const f = await fixture();
  try {
    await readyLive(f); await cashBook(f);
    let quotes = 0;
    const counted: SolanaPaperMarket = { readMint: f.market.readMint, quote: async intent => { quotes++; return f.market.quote(intent); } };
    const lines: string[] = [];
    const app = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "nope" }, market: counted, log: line => lines.push(line) });
    await assert.rejects(app.preview(f.scope, { mode: "live", intent: { ...f.trade, mode: "live" } }), rollout(SOLANA_LIVE_ROLLOUT_MISCONFIGURED, "configuration"));
    await assert.rejects(app.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live", requestId: "unreadable-caps-buy" } }), rollout(SOLANA_LIVE_ROLLOUT_MISCONFIGURED, "configuration"));
    assert.equal(quotes, 0, "no paid quote for a buy that cannot execute");
    assert.equal(lines.filter(line => line.startsWith("[alert] solana-live-rollout misconfigured: MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG")).length, 1, "the operator is paged");
    const sale = { ...f.trade, mode: "live", inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw: "100000000" };
    assert.ok((await app.preview(f.scope, { mode: "live", intent: sale })).quote);
    assert.equal(quotes, 1);
  } finally { f.raw.close(); }
});

test("live rollout: a list entry in any case names the tenant, whose id is lowercase by construction: a scope spelled otherwise is refused before the list is read", async () => {
  const f = await fixture();
  try {
    // A tenant id with hex letters, bound beside the fixture's own.
    const lettered = `0x${"ab".repeat(20)}`, owner = key(5), scope = { tenant: lettered, owner };
    await f.bindings.bind(lettered as `0x${string}`, "did:privy:lettered", owner);
    for (const listed of [`0x${"AB".repeat(20)}`, `0x${"aB".repeat(20)}`, lettered]) {
      const lines: string[] = [];
      const app = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: listed }, log: line => lines.push(line) });
      await app.checkLiveSettings(scope, limits);
      assert.equal((await app.status(scope)).liveAccess.onList, true, listed);
      // The same tenant spelled in capitals never reaches the list: the store refuses it, so no case can differ from the list's.
      await assert.rejects(app.checkLiveSettings({ tenant: `0x${"AB".repeat(20)}`, owner }, limits), /Invalid authenticated Solana tenant/);
      await assert.rejects(app.status({ tenant: `0x${"AB".repeat(20)}`, owner }), /Invalid authenticated Solana tenant/);
      assert.deepEqual(lines, []);
    }
  } finally { f.raw.close(); }
});

test("live rollout, the runbook's order: deployed to the worker first, a tenant taken off the list buys nowhere: the restarted worker refuses it at once, and the web, still on the old list, holds every live buy until it is deployed too", async () => {
  const f = await fixture();
  try {
    await readyLive(f); await cashBook(f);
    const removed = { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: OTHER_TENANT };
    const buy = (requestId: string) => ({ mode: "live" as const, intent: { ...f.trade, mode: "live", requestId } });
    // Both ran the old list, and the web served a request: its digest is published.
    const web = f.runtime({ env: f.env, log: () => {} });
    await web.status(f.scope);
    // The worker is redeployed first, with this tenant taken off: it runs the new list at once (and holds every other tenant's
    // buys meanwhile, as the web's digest differs from its own).
    f.clock.now += 1;
    const worker = f.runtime({ env: removed, service: "worker", log: () => {} });
    await worker.publishLiveRollout();
    await assert.rejects(worker.trade(f.scope, buy("worker-buy")), rollout(SOLANA_LIVE_PAUSED, "permission"));
    // The web, still on the old list, sees the worker's new digest and holds every live buy, this tenant's included.
    await assert.rejects(web.trade(f.scope, buy("web-buy")), rollout(SOLANA_LIVE_ROLLOUT_DIFFERS, "configuration"));
    assert.deepEqual((await web.status(f.scope)).live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]);
    // Then the web is deployed too: the same settings on both, and the tenant is exits-only on each.
    f.clock.now += 1;
    const redeployed = f.runtime({ env: removed, log: () => {} });
    assert.deepEqual((await redeployed.status(f.scope)).live.blockers, [SOLANA_LIVE_PAUSED]);
    assert.deepEqual((await worker.status(f.scope)).live.blockers, [SOLANA_LIVE_PAUSED]);
    assert.equal(f.controls.sends, 0, "no buy was sent at any point");
  } finally { f.raw.close(); }
});

test("live rollout: the web treats a running Solana worker whose settings digest is missing or stale as differing, holding live buys with the [alert]; a stopped worker is not judged", async () => {
  const f = await fixture();
  try {
    await readyLive(f); await cashBook(f);
    const lines: string[] = [];
    const unseen = () => lines.filter(line => line.startsWith("[alert] solana-live-rollout differs: the Solana worker is running but has not published")).length;
    const web = f.runtime({ env: f.env, log: line => lines.push(line) });
    const beat = (atMs: number) => f.db.prepare(`INSERT INTO solana_runtime_worker_heartbeat(worker,last_seen_at_ms) VALUES('solana',?)
      ON CONFLICT(worker) DO UPDATE SET last_seen_at_ms=excluded.last_seen_at_ms`).run(atMs);
    // A worker heartbeat with no digest at all: a worker deployed from code that publishes none.
    await beat(f.clock.now);
    const held = await web.status(f.scope);
    assert.deepEqual(held.live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]); assert.equal(held.live.canExit, true);
    await assert.rejects(web.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live", requestId: "unseen-buy" } }), rollout(SOLANA_LIVE_ROLLOUT_DIFFERS, "configuration"));
    assert.equal(unseen(), 1);
    // The worker publishes the same settings: nothing differs.
    await f.runtime({ env: f.env, service: "worker", log: () => {} }).publishLiveRollout();
    assert.deepEqual((await web.status(f.scope)).live.blockers, []);
    // Its digest goes stale while its heartbeat stays current (a publish that keeps failing): held again.
    f.clock.now += 91_000; await beat(f.clock.now);
    assert.deepEqual((await web.status(f.scope)).live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]);
    assert.equal(unseen(), 2, "said again after a minute");
    // A worker that stopped altogether (its heartbeat over 90 s old too) is not judged.
    f.clock.now += 91_000;
    assert.deepEqual((await web.status(f.scope)).live.blockers, []);
  } finally { f.raw.close(); }
});

test("live rollout: while the web and the Solana worker run different list or cap settings, each holds live buys and says so, with one [alert] a minute; exits stay open", async () => {
  const f = await fixture();
  try {
    await readyLive(f); await cashBook(f);
    const webLines: string[] = [], workerLines: string[] = [];
    const differs = (lines: string[]) => lines.filter(line => line.startsWith("[alert] solana-live-rollout differs: ")).length;
    // A tenant was added on the web only (this account is on both lists, with the same caps).
    const web = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: `${TENANT},${OTHER_TENANT}` }, log: line => webLines.push(line) });
    const worker = f.runtime({ env: f.env, service: "worker", log: line => workerLines.push(line) });
    // Nothing published by the worker yet: nothing to compare.
    assert.deepEqual((await web.status(f.scope)).live.blockers, []);
    await worker.publishLiveRollout();
    const held = await web.status(f.scope);
    assert.deepEqual(held.live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]); assert.equal(held.live.ready, false); assert.equal(held.live.canExit, true);
    await assert.rejects(web.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live", requestId: "differs-buy" } }), rollout(SOLANA_LIVE_ROLLOUT_DIFFERS, "configuration"));
    await assert.rejects(web.preview(f.scope, { mode: "live", intent: { ...f.trade, mode: "live" } }), rollout(SOLANA_LIVE_ROLLOUT_DIFFERS, "configuration"));
    const sale = { ...f.trade, mode: "live", inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw: "100000000" };
    assert.ok((await web.preview(f.scope, { mode: "live", intent: sale })).quote, "a sale is previewed");
    assert.equal(differs(webLines), 1, "once a minute per process, however often it is read");
    assert.ok(!webLines.some(line => line.includes(TENANT) || line.includes(OTHER_TENANT)), "never a tenant");
    // The worker sees the web's settings, published after it started, and holds its buys too.
    const workerHeld = await worker.status(f.scope);
    assert.deepEqual(workerHeld.live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]); assert.equal(workerHeld.live.canExit, true);
    await assert.rejects(worker.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live", requestId: "worker-differs-buy" } }), rollout(SOLANA_LIVE_ROLLOUT_DIFFERS, "configuration"));
    assert.equal(differs(workerLines), 1);
    f.clock.now += 60_000; await web.status(f.scope); await worker.publishLiveRollout();
    assert.equal(differs(webLines), 2, "said again after a minute");
    // A worker that stopped publishing (offline over 90 s) is not compared.
    f.clock.now += 91_000;
    assert.deepEqual((await web.status(f.scope)).live.blockers, []);
    // A worker started after the web last published still judges that row, whatever its age: the web, which has no heartbeat,
    // may still run what it published then.
    f.clock.now += 1;
    const restarted = f.runtime({ env: f.env, service: "worker", log: () => {} });
    assert.deepEqual((await restarted.status(f.scope)).live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]);
    // The same settings, however spelled, add nothing on either side: once the web publishes them, the worker's buys are let through.
    f.clock.now += 30_000;
    const same = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: ` ${TENANT} , ${TENANT}`, MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG: "10" }, log: () => {} });
    assert.deepEqual((await same.status(f.scope)).live.blockers, []);
    assert.deepEqual((await restarted.status(f.scope)).live.blockers, []);
    // Published as the web from then on, the web's different settings hold the restarted worker's buys.
    f.clock.now += 30_000; await web.status(f.scope);
    assert.deepEqual((await restarted.status(f.scope)).live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]);
  } finally { f.raw.close(); }
});

test("live rollout: a restarted worker judges the web's latest digest whatever its age: a tenant re-added on the worker first buys nothing until the web runs the same list and publishes it; its exits stay open throughout", async () => {
  const f = await fixture();
  try {
    await readyLive(f); await cashBook(f);
    const lines: string[] = [];
    const differs = () => lines.filter(line => line.startsWith("[alert] solana-live-rollout differs: the web last published different")).length;
    const buy = (requestId: string) => ({ mode: "live" as const, intent: { ...f.trade, mode: "live", requestId } });
    const sale = { ...f.trade, mode: "live", inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw: "100000000" };
    // The tenant traded, then was taken off both lists; the web last served a Solana request on that list half an hour ago
    // (any age: the fixture's saved limits bound how far this clock can move).
    await f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: OTHER_TENANT }, log: () => {} }).status(f.scope);
    f.clock.now += 1_800_000;
    // The worker is redeployed first with the tenant back on its list: the web, still on the old list, would refuse this buy.
    const worker = f.runtime({ env: f.env, service: "worker", log: line => lines.push(line) });
    await worker.publishLiveRollout();
    const held = await worker.status(f.scope);
    assert.deepEqual(held.live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]); assert.equal(held.live.ready, false); assert.equal(held.live.canExit, true);
    await assert.rejects(worker.trade(f.scope, buy("re-added-buy")), rollout(SOLANA_LIVE_ROLLOUT_DIFFERS, "configuration"));
    await assert.rejects(worker.preview(f.scope, { mode: "live", intent: { ...f.trade, mode: "live" } }), rollout(SOLANA_LIVE_ROLLOUT_DIFFERS, "configuration"));
    assert.ok((await worker.preview(f.scope, { mode: "live", intent: sale })).quote, "a sale is still previewed");
    assert.equal(differs(), 1, "said once a minute"); assert.ok(!lines.some(line => line.includes(TENANT) || line.includes(OTHER_TENANT)), "never a tenant");
    // Still held later on, however old the web's digest: only an equal one lets the worker buy.
    f.clock.now += 900_000;
    assert.deepEqual((await worker.status(f.scope)).live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]);
    assert.equal(differs(), 2);
    // The web is deployed with the same list and serves a Solana request: its digest now equals the worker's.
    f.clock.now += 1;
    assert.deepEqual((await f.runtime({ env: f.env, log: () => {} }).status(f.scope)).live.blockers, []);
    assert.deepEqual((await worker.status(f.scope)).live.blockers, []);
    assert.equal(f.controls.sends, 0, "no buy was sent while they differed");
  } finally { f.raw.close(); }
});

test("live rollout: a worker restarted with the settings the web last published is not held, however old that digest is", async () => {
  const f = await fixture();
  try {
    await readyLive(f); await cashBook(f);
    const lines: string[] = [];
    await f.runtime({ env: f.env, log: () => {} }).status(f.scope);
    f.clock.now += 3_000_000;
    const restarted = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: ` ${TENANT} ` }, service: "worker", log: line => lines.push(line) });
    await restarted.publishLiveRollout();
    assert.deepEqual((await restarted.status(f.scope)).live.blockers, []);
    assert.deepEqual(lines, []);
  } finally { f.raw.close(); }
});

test("live rollout: on a fresh deployment, before the web has published any digest, the worker holds live buys only, says why once a minute, and lets them through as soon as the web publishes the same settings", async () => {
  const f = await fixture();
  try {
    await readyLive(f); await cashBook(f);
    const lines: string[] = [];
    const unpublished = () => lines.filter(line => line.startsWith("[alert] solana-live-rollout differs: the web has not published")).length;
    const worker = f.runtime({ env: f.env, service: "worker", log: line => lines.push(line) });
    await worker.publishLiveRollout();
    assert.equal(await f.db.prepare("SELECT 1 FROM solana_runtime_live_rollout_seen WHERE service='web'").get(), undefined, "no web digest yet");
    const held = await worker.status(f.scope);
    assert.deepEqual(held.live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]); assert.equal(held.live.ready, false); assert.equal(held.live.canExit, true, "exits stay open");
    await assert.rejects(worker.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live", requestId: "fresh-buy" } }), rollout(SOLANA_LIVE_ROLLOUT_DIFFERS, "configuration"));
    const sale = { ...f.trade, mode: "live", inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw: "100000000" };
    assert.ok((await worker.preview(f.scope, { mode: "live", intent: sale })).quote, "a sale is still previewed");
    assert.equal(unpublished(), 1, "once a minute per process, however often it is read");
    assert.match(lines[0]!, /it does as it starts, every 30 s after, and when it serves a Solana request.*see its \[alert\] solana-live-rollout unpublished/);
    f.clock.now += 60_000; await worker.status(f.scope);
    assert.equal(unpublished(), 2, "said again after a minute");
    // The web serves its first Solana request, on the same settings: the worker's very next check lets buys through.
    f.clock.now += 1;
    assert.deepEqual((await f.runtime({ env: f.env, log: () => {} }).status(f.scope)).live.blockers, []);
    assert.deepEqual((await worker.status(f.scope)).live.blockers, []);
    f.clock.now += 60_000; await worker.status(f.scope);
    assert.equal(unpublished(), 2, "nothing more to say");
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

/** The web server's publisher (web/src/instrumentation.ts) over `web`, with a timer the test runs by hand: `tick()` is 30 s passing. */
function webStarts(web: ReturnType<typeof createSolanaAppRuntime>) {
  let run: (() => void) | undefined;
  const publisher = startSolanaRolloutPublisher({ enabled: () => true, publish: () => web.publishLiveRollout(), log: line => assert.fail(line),
    every: (fn) => { run = fn; return { stop: () => { run = undefined; } }; } })!;
  return { started: publisher.started, stop: publisher.stop, tick: async () => { run!(); await new Promise<void>(resolve => setImmediate(resolve)); } };
}

test("live rollout: a web redeployed with new settings publishes them as it starts, before it serves any Solana request, so a worker redeployed after it under the web's previous settings buys nothing", async () => {
  const f = await fixture();
  try {
    await readyLive(f); await cashBook(f);
    const removed = { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: OTHER_TENANT }, lines: string[] = [];
    // The web served a request on the list naming this tenant: its digest is published.
    await f.runtime({ env: f.env, log: () => {} }).status(f.scope);
    // The tenant is taken off, the worker first, then the web, which starts and serves no Solana request.
    f.clock.now += 1;
    await f.runtime({ env: removed, service: "worker", log: () => {} }).publishLiveRollout();
    f.clock.now += 1;
    const web = webStarts(f.runtime({ env: removed, log: () => {} }));
    await web.started;
    // The worker is redeployed again with the tenant listed (a revert done on the worker alone): the digest the web left
    // before it was redeployed equals the worker's, but the web runs the list without the tenant, so the worker's buys wait.
    f.clock.now += 1;
    const worker = f.runtime({ env: f.env, service: "worker", log: line => lines.push(line) });
    await worker.publishLiveRollout();
    const held = await worker.status(f.scope);
    assert.deepEqual(held.live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]); assert.equal(held.live.canExit, true);
    await assert.rejects(worker.trade(f.scope, { mode: "live", intent: { ...f.trade, mode: "live", requestId: "revert-buy" } }), rollout(SOLANA_LIVE_ROLLOUT_DIFFERS, "configuration"));
    assert.equal(lines.filter(line => line.startsWith("[alert] solana-live-rollout differs: the web last published different")).length, 1);
    // The web is reverted too: it publishes as it starts, and the worker buys again with no request served.
    web.stop(); f.clock.now += 1;
    const reverted = webStarts(f.runtime({ env: f.env, log: () => {} }));
    await reverted.started;
    assert.deepEqual((await worker.status(f.scope)).live.blockers, []);
    reverted.stop();
    assert.equal(f.controls.sends, 0, "no buy was sent while the web ran other settings");
  } finally { f.raw.close(); }
});

test("live rollout: a digest an old web container still draining writes after the new web's is replaced at the new web's next Solana request, at once, and with none at its next periodic publish; the worker's buys wait meanwhile", async () => {
  const f = await fixture();
  try {
    await readyLive(f); await cashBook(f);
    const removed = { ...f.env, MERRYMEN_SOLANA_LIVE_TENANTS: OTHER_TENANT };
    const webRow = async () => (await f.db.prepare("SELECT fingerprint FROM solana_runtime_live_rollout_seen WHERE service='web'").get() as { fingerprint: string }).fingerprint;
    // The old web runs the list without this tenant and served a request; the worker is deployed first with the tenant added.
    const old = f.runtime({ env: removed, log: () => {} });
    await old.status(f.scope);
    const worker = f.runtime({ env: f.env, service: "worker", log: () => {} });
    await worker.publishLiveRollout();
    assert.deepEqual((await worker.status(f.scope)).live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]);
    // The new web starts with the tenant added and publishes: the worker buys.
    f.clock.now += 40_000;
    const fresh = f.runtime({ env: f.env, log: () => {} }), web = webStarts(fresh);
    await web.started;
    const published = await webRow();
    assert.deepEqual((await worker.status(f.scope)).live.blockers, []);
    // The old container, still draining, serves one more request (its own last write over 30 s ago): its digest is written over
    // the new one's, and the worker's buys wait.
    f.clock.now += 1_000;
    await old.status(f.scope);
    assert.notEqual(await webRow(), published);
    assert.deepEqual((await worker.status(f.scope)).live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]);
    // The new web serves a Solana request within 30 s of its own write: the stored digest is not its own, so it is written at once.
    f.clock.now += 1_000;
    assert.deepEqual((await fresh.status(f.scope)).live.blockers, []);
    assert.equal(await webRow(), published);
    assert.deepEqual((await worker.status(f.scope)).live.blockers, []);
    // Once more from the old container, then it stops; the new web serves no request: its next periodic publish replaces it.
    f.clock.now += 1_000;
    await old.status(f.scope);
    assert.deepEqual((await worker.status(f.scope)).live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]);
    f.clock.now += 30_000; await web.tick();
    assert.equal(await webRow(), published);
    assert.deepEqual((await worker.status(f.scope)).live.blockers, []);
    web.stop();
    assert.equal(f.controls.sends, 0);
  } finally { f.raw.close(); }
});

test("live rollout: a worker whose clock runs ahead of the web's is still judged: its digest and heartbeat, stamped in the web's future, count as current, so different settings hold the web's buys", async () => {
  const f = await fixture();
  try {
    await readyLive(f); await cashBook(f);
    const web = f.runtime({ env: f.env, log: () => {} });
    const beat = (atMs: number) => f.db.prepare(`INSERT INTO solana_runtime_worker_heartbeat(worker,last_seen_at_ms) VALUES('solana',?)
      ON CONFLICT(worker) DO UPDATE SET last_seen_at_ms=excluded.last_seen_at_ms`).run(atMs);
    const buy = (requestId: string) => ({ mode: "live" as const, intent: { ...f.trade, mode: "live", requestId } });
    for (const aheadMs of [1, 5_000, 60_000]) {
      // The worker runs different caps, with its clock aheadMs ahead of the web's; it has just beaten and published.
      const worker = f.runtime({ env: { ...f.env, MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "24" }, service: "worker", now: () => f.clock.now + aheadMs, log: () => {} });
      await beat(f.clock.now + aheadMs); await worker.publishLiveRollout();
      assert.deepEqual((await web.status(f.scope)).live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS], String(aheadMs));
      await assert.rejects(web.trade(f.scope, buy(`ahead-${aheadMs}`)), rollout(SOLANA_LIVE_ROLLOUT_DIFFERS, "configuration"));
      // Its heartbeat alone, stamped ahead, with no digest at all: a running worker the web cannot check, held too.
      await f.db.prepare("DELETE FROM solana_runtime_live_rollout_seen WHERE service='worker'").run();
      assert.deepEqual((await web.status(f.scope)).live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS], `${aheadMs}, heartbeat only`);
      // The same settings, stamped ahead: nothing differs.
      await f.runtime({ env: f.env, service: "worker", now: () => f.clock.now + aheadMs, log: () => {} }).publishLiveRollout();
      assert.deepEqual((await web.status(f.scope)).live.blockers, [], `${aheadMs}, same settings`);
      f.clock.now += 91_000 + aheadMs;
    }
    assert.equal(f.controls.sends, 0, "no buy was sent");
  } finally { f.raw.close(); }
});
