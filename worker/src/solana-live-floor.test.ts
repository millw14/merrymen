/**
 * The 2026-10-18 audit's GAP0 scenarios, end to end and with no network: agent
 * tick or manual intent → runtime → executor → recordSigned, against a fake RPC
 * and a stubbed Jupiter. A bad build quote, or a dust mark, must not get a live
 * sale signed, admitted or broadcast. Fair trades still go through.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getBase58Decoder, getBase58Encoder, getCompiledTransactionMessageDecoder,
  getTransactionDecoder } from "@solana/kit";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_JUPITER_SHARED_ROUTE_DISCRIMINATOR, SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_VAULT_DISCRIMINATOR,
  SOLANA_VAULT_LOCAL_TEST_PROGRAM, SOLANA_WRAPPED_SOL_MINT, deriveSolanaAta, deriveSolanaVaultAddress } from "../../packages/core/src/solana-live";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { makePgDb, wrapSqlite, type Db } from "./db";
import { createSolanaAgent, solanaWorkerRuntime } from "./solana-agent";
import { createSolanaAppRuntime, SOLANA_LIVE_PAUSED, SOLANA_LIVE_ROLLOUT_DIFFERS, SOLANA_STATUS_BELOW_BOOK, SOLANA_STATUS_EXIT_OVER_NEXT_WINDOW, SOLANA_STATUS_EXIT_OVER_SEVERAL_WINDOWS, SOLANA_STATUS_POSITION_ABOVE_EXIT_ROOM, SOLANA_STATUS_DAILY_OPERATIONS_USED, SOLANA_STATUS_DAILY_SOL_SOLD_USED, SOLANA_STATUS_DAILY_USDG_USED,
  SOLANA_STATUS_DAILY_USDG_BUYS_USED,
  SolanaAppRuntimeError } from "./solana-app-runtime";
import { SOLANA_LIVE_CAP_DEFAULTS, solanaLiveCapRefusal, solanaLiveExitLimitsRefusal, solanaLiveSessionAboveCaps } from "./solana-live-rollout";
import { createSolanaExecutor, type SolanaSignedSubmission } from "./solana-executor";
import { createSolanaLiveMarket, SolanaLiveMarketError } from "./solana-live-market";
import type { SolanaLiveRead, SolanaLiveRpc } from "./solana-live-rpc";
import { PYTH_SOL_USD_ACCOUNT, SOLANA_PYTH_FEEDS, readSolanaReferencePrice, solanaPythGeneration, solanaReferenceBound, solanaReferenceNotional,
  type SolanaPythGeneration } from "./solana-reference-price";
import { pythAccount, pythReference } from "./solana-reference-price-fixture";
import { SolanaMarketError } from "./solana-market";
import { SOLANA_MAINNET_GENESIS_HASH } from "./solana-rpc";
import { ensureSolanaTradingSchema, SOLANA_EXPIRED_ATTEMPT_ALLOWANCE_MISCONFIGURED, SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED, SOLANA_LIVE_EXIT_RESERVE, SolanaTradingStore,
  SolanaTradingStoreError } from "./solana-trading-store";
import { sealSecret } from "./store-crypto";

const TENANT = "0x1111111111111111111111111111111111111111";
const PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM, LOADER = "BPFLoaderUpgradeab1e11111111111111111111111", SYSTEM = "11111111111111111111111111111111";
const JUP = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", RPC = "https://rpc.fixture.invalid/";
const NOW = 1_000_000, SLOT = 1000;
const key = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
const keyBytes = (v: string) => Buffer.from(getBase58Encoder().encode(v));
// 25 USDG and 0.2 SOL per trade; 100 USDG and 1 SOL a day.
const limits = { perTradeUsdg: "25000000", dailyUsdg: "100000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 3_600_000,
  perTradeWsol: "200000000", dailyWsol: "1000000000" };
// Fair price is $150 per SOL. Pyth agrees: 150.00000000 with an 8-decimal exponent.
const fairOut = (input: string, amount: bigint) => input === SOLANA_WRAPPED_SOL_MINT ? amount * 150n / 1000n : amount * 1000n / 150n;
type Build = { kind: "dust" } | { kind: "fair" } | { kind: "factor"; num: bigint; den: bigint };
const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
function rpcAccount(data: Buffer, owner: string, executable = false, lamports = 100_000_000) {
  return { owner, executable, lamports, data: [data.toString("base64"), "base64"], space: data.length };
}
function token(mint: string, owner: string, amount: bigint) {
  const b = Buffer.alloc(165); keyBytes(mint).copy(b, 0); keyBytes(owner).copy(b, 32); b.writeBigUInt64LE(amount, 64); b[108] = 1; return b;
}
function mintJson(mint: string) {
  const usdg = mint === SOLANA_USDG_MINT;
  return { context: { slot: SLOT }, value: { executable: false, owner: usdg ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM, lamports: 1, space: 82,
    data: { program: usdg ? "spl-token-2022" : "spl-token", space: 82, parsed: { type: "mint", info: { isInitialized: true, decimals: usdg ? 6 : 9,
      supply: "1000000000000", freezeAuthority: null, mintAuthority: null } } } } };
}

/** A schema of its own on MERRYMEN_TEST_PG_URL, searched first and dropped after the test. */
async function pgSchema(t: TestContext): Promise<Db> {
  const url = new URL(process.env.MERRYMEN_TEST_PG_URL!), schema = `solana_floor_${randomUUID().replaceAll("-", "")}`;
  const admin = await makePgDb(url.toString()); await admin.exec(`CREATE SCHEMA ${schema}`);
  url.searchParams.set("options", `-c search_path=${schema}`);
  t.after(async () => { await admin.exec(`DROP SCHEMA ${schema} CASCADE`); });
  return makePgDb(url.toString());
}
/** Skips a PostgreSQL case unless MERRYMEN_TEST_PG_URL names an isolated test database. */
const dialectOptions = (dialect: "sqlite" | "postgres") =>
  dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
async function fixture(t: TestContext, opts: { cash: bigint; wsol: bigint; mark: "fair" | "dust" | "zero" | "down"; build: Build; strategy?: Record<string, unknown>; pythAgeMs?: number;
  env?: Record<string, string>; priorityFees?: number[]; dbFile?: string; dialect?: "sqlite" | "postgres" }) {
  const net = { lastBuild: null as null | { amount: bigint; out: bigint; min: bigint; input: string }, urls: [] as string[] };
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input); net.urls.push(url.split("?")[0]!);
    if (url === RPC) {
      const body = JSON.parse(String(init!.body)) as { id: number; method: string; params: unknown[] };
      const result = body.method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS_HASH : body.method === "getSlot" ? SLOT
        : body.method === "getAccountInfo" ? mintJson(body.params[0] as string) : assert.fail(`unexpected mint RPC ${body.method}`);
      return json({ jsonrpc: "2.0", id: body.id, result });
    }
    if (url.startsWith("https://api.jup.ag/swap/v1/quote?")) {
      const q = new URL(url).searchParams, amount = BigInt(q.get("amount")!), inputMint = q.get("inputMint")!, outputMint = q.get("outputMint")!;
      const slip = Number(q.get("slippageBps")), fair = fairOut(inputMint, amount);
      const out = opts.build.kind === "dust" ? 1n : opts.build.kind === "fair" ? fair : fair * opts.build.num / opts.build.den;
      const min = out * BigInt(10_000 - slip) / 10_000n || 1n;
      net.lastBuild = { amount, out, min, input: inputMint };
      return json({ swapMode: "ExactIn", inputMint, outputMint, inAmount: amount.toString(), outAmount: out.toString(), otherAmountThreshold: min.toString(),
        slippageBps: slip, contextSlot: SLOT, platformFee: null, priceImpactPct: "0.01",
        routePlan: [{ swapInfo: { ammKey: key(70), inputMint, outputMint, inAmount: amount.toString(), outAmount: out.toString() }, percent: 100 }] });
    }
    if (url === "https://api.jup.ag/swap/v1/swap-instructions") {
      const body = JSON.parse(String(init!.body)) as { userPublicKey: string; destinationTokenAccount: string; quoteResponse: Record<string, string | number> };
      const q = body.quoteResponse, inputMint = String(q.inputMint), outputMint = String(q.outputMint);
      const temp = await deriveSolanaAta(body.userPublicKey, inputMint, inputMint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM);
      const data = Buffer.alloc(36); Buffer.from(SOLANA_JUPITER_SHARED_ROUTE_DISCRIMINATOR).copy(data);
      data.writeUInt32LE(1, 9); data[14] = 100; data[16] = 1;
      data.writeBigUInt64LE(BigInt(q.inAmount as string), 17); data.writeBigUInt64LE(BigInt(q.outAmount as string), 25); data.writeUInt16LE(Number(q.slippageBps), 33);
      const accounts = [SOLANA_CLASSIC_TOKEN_PROGRAM, key(40), body.userPublicKey, temp, key(41), key(42), body.destinationTokenAccount, inputMint, outputMint, JUP, TOKEN_2022_PROGRAM]
        .map((pubkey, i) => ({ pubkey, isSigner: i === 2, isWritable: [3, 4, 5, 6].includes(i) }));
      return json({ swapInstruction: { programId: JUP, data: data.toString("base64"), accounts }, addressLookupTableAddresses: [] });
    }
    return assert.fail(`unexpected network call ${url}`);
  });
  // `dbFile`: a database file a test can close and open again (reopen), as a restarted process would.
  let raw = new DatabaseSync(opts.dbFile ?? ":memory:"), db = wrapSqlite(raw);
  const clock = { now: NOW };
  t.after(() => raw.close());
  // `dialect: "postgres"`: the same accounts and chain on PostgreSQL (MERRYMEN_TEST_PG_URL); reopen is SQLite's only.
  const postgres = opts.dialect === "postgres";
  if (postgres) db = await pgSchema(t);
  const sessionSeed = Buffer.alloc(32, 22), sessionKeys = await createKeyPairFromPrivateKeyBytes(sessionSeed);
  const owner = await getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(21))).publicKey);
  const session = await getAddressFromPublicKey(sessionKeys.publicKey);
  const feePayer = await getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(31))).publicKey);
  const scope = { tenant: TENANT, owner }, vault = await deriveSolanaVaultAddress(PROGRAM, owner);
  const cashAta = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), wsolAta = await deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  const ownerUsdg = await deriveSolanaAta(owner, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), ownerWsol = await deriveSolanaAta(owner, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  // The local test build declares its own id: declare_id! embeds its 32 bytes, which the executor requires.
  const dataAddress = key(91), binary = Buffer.concat([Buffer.from("runtime-tested-binary"), keyBytes(PROGRAM)]), program = Buffer.alloc(36), programData = Buffer.alloc(45 + binary.length);
  program.writeUInt32LE(2); keyBytes(dataAddress).copy(program, 4); programData.writeUInt32LE(3); binary.copy(programData, 45);
  const vaultState = (seq: bigint) => {
    const b = Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE); Buffer.from(SOLANA_VAULT_DISCRIMINATOR).copy(b); let p = 8; b[p++] = 2; b[p++] = 255;
    for (const v of [owner, session]) { keyBytes(v).copy(b, p); p += 32; }
    for (const v of [1n, seq, BigInt(Math.floor(limits.expiresAtMs / 1000)), BigInt(limits.perTradeUsdg), BigInt(limits.dailyUsdg),
      BigInt(limits.perTradeWsol), BigInt(limits.dailyWsol)]) { b.writeBigUInt64LE(v, p); p += 8; }
    b.writeUInt16LE(limits.maxOpsPerDay, p); return b;
  };
  // Accounts beyond the vault's own: each Pyth generation's SOL/USD account at $150, owned by its own receiver.
  // A test may serve something else at a Pyth address or add an account; `pythReads` lists each Pyth account read.
  const served = new Map<string, () => unknown>(Object.values(SOLANA_PYTH_FEEDS).map(feed => [feed.account, () =>
    pythAccount({ price: 15_000_000_000n, conf: 1_500_000n, publishTimeMs: clock.now - (opts.pythAgeMs ?? 0), owner: feed.receiverProgram })]));
  const pythAddresses = new Set(Object.values(SOLANA_PYTH_FEEDS).map(feed => feed.account)), pythReads: string[] = [];
  const extra = (k: string): unknown => { if (pythAddresses.has(k)) pythReads.push(k); return served.get(k)?.() ?? null; };
  const accountFor = (k: string): unknown => k === vault ? rpcAccount(vaultState(0n), PROGRAM)
    : k === cashAta ? rpcAccount(token(SOLANA_USDG_MINT, vault, opts.cash), TOKEN_2022_PROGRAM)
    : k === wsolAta ? rpcAccount(token(SOLANA_WRAPPED_SOL_MINT, vault, opts.wsol), SOLANA_CLASSIC_TOKEN_PROGRAM)
    : k === feePayer ? rpcAccount(Buffer.alloc(0), SYSTEM)
    : k === ownerUsdg ? rpcAccount(token(SOLANA_USDG_MINT, owner, 0n), TOKEN_2022_PROGRAM)
    : k === ownerWsol ? rpcAccount(token(SOLANA_WRAPPED_SOL_MINT, owner, 0n), SOLANA_CLASSIC_TOKEN_PROGRAM)
    // The USDG mint, with no transfer hook: a withdrawal reads it for one.
    : k === SOLANA_USDG_MINT ? rpcAccount(Buffer.alloc(82), TOKEN_2022_PROGRAM)
    : extra(k);
  const response = (value: unknown) => ({ context: { slot: SLOT }, value });
  const sends: string[] = [];
  const read: SolanaLiveRead = async (method, params = []) => {
    switch (method) {
      case "getSlot": return SLOT;
      case "getBlockHeight": return 900;
      case "getAccountInfo": {
        const [k, cfg] = params as [string, { dataSlice?: { offset: number; length: number } }];
        if (k === PROGRAM) return response(rpcAccount(program, LOADER, true));
        if (k === dataAddress) { const s = cfg.dataSlice!; return response({ ...rpcAccount(programData.subarray(s.offset, s.offset + s.length), LOADER), space: programData.length }); }
        return response(accountFor(k));
      }
      case "getMultipleAccounts": return response((params[0] as string[]).map(accountFor));
      case "getMinimumBalanceForRentExemption": return 2_039_280;
      case "getLatestBlockhash": return response({ blockhash: key(42), lastValidBlockHeight: 5000 });
      case "getFeeForMessage": return response(10_000);
      case "getRecentPrioritizationFees": return opts.priorityFees ? opts.priorityFees.map((prioritizationFee, i) => ({ slot: SLOT - i, prioritizationFee })) : assert.fail("no fee estimate");
      case "getSignatureStatuses": return response([null]);
      case "getTransaction": return null;
      case "simulateTransaction": {
        // The route delivers exactly the build quote's guaranteed minimum.
        const lb = net.lastBuild!, selling = lb.input === SOLANA_WRAPPED_SOL_MINT;
        const cashAfter = selling ? opts.cash + lb.min : opts.cash - lb.amount, wsolAfter = selling ? opts.wsol - lb.amount : opts.wsol + lb.min;
        const [v, inp, out, payer] = (params[1] as { accounts: { addresses: string[] } }).accounts.addresses;
        const after = (k: string) => k === v ? rpcAccount(vaultState(1n), PROGRAM)
          : k === cashAta ? rpcAccount(token(SOLANA_USDG_MINT, vault, cashAfter), TOKEN_2022_PROGRAM)
          : k === wsolAta ? rpcAccount(token(SOLANA_WRAPPED_SOL_MINT, vault, wsolAfter), SOLANA_CLASSIC_TOKEN_PROGRAM)
          : rpcAccount(Buffer.alloc(0), SYSTEM, false, 100_000_000 - 10_000);
        return response({ err: null, unitsConsumed: 200_000, accounts: [v!, inp!, out!, payer!].map(after) });
      }
      default: return assert.fail(`unexpected live RPC ${method}`);
    }
  };
  // Two agreeing providers, as the live transport always has: deployment checks, bookings and each trade's
  // balance and Pyth reads need both (so a trade reads each Pyth account once per provider).
  const rpc: SolanaLiveRpc = { read: fn => fn(read), readEach: async fn => [await fn(read), await fn(read)], send: async wire => { sends.push(wire); return "sent"; } };
  const quote = async (i: { inputMint: string; outputMint: string; amountRaw: string; slippageBps: number }) => {
    // "zero": no route buys SOL back (Jupiter's zero-output answer); "down": the SOL quote fails otherwise.
    if (opts.mark === "zero" && i.inputMint === SOLANA_WRAPPED_SOL_MINT) throw new SolanaMarketError("zero-output", { source: "jupiter", inputMint: i.inputMint,
      outputMint: i.outputMint, inAmount: i.amountRaw, outAmount: "0", minOutAmount: "0", slippageBps: i.slippageBps, contextSlot: SLOT, quotedAtMs: clock.now });
    if (opts.mark === "down" && i.inputMint === SOLANA_WRAPPED_SOL_MINT) throw new SolanaMarketError("invalid-quote");
    const out = opts.mark === "dust" ? 1n : fairOut(i.inputMint, BigInt(i.amountRaw));
    return { source: "jupiter" as const, inputMint: i.inputMint, outputMint: i.outputMint, inAmount: i.amountRaw, outAmount: out.toString(),
      minOutAmount: ((out * BigInt(10_000 - i.slippageBps) / 10_000n) || 1n).toString(), slippageBps: i.slippageBps, contextSlot: SLOT,
      quotedAtMs: clock.now, expiresAtMs: clock.now + 30_000 };
  };
  const readMint = async (mint: string) => ({ address: mint, program: mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM,
    decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: SLOT, observedAtMs: clock.now, buyBlockedReasons: [] });
  const market = { readMint, quote };
  const env = { MERRYMEN_SOLANA_VAULT_PROGRAM: PROGRAM, MERRYMEN_SOLANA_VAULT_SHA256: createHash("sha256").update(binary).digest("hex"),
    MERRYMEN_STORE_DEK: Buffer.alloc(32, 30).toString("base64"), MERRYMEN_SOLANA_FEE_PAYER_SEED: Buffer.alloc(32, 31).toString("base64"),
    MERRYMEN_JUPITER_API_KEY: "fixture-not-a-key", MERRYMEN_SOLANA_RPC_MAINNET: RPC,
    // On the live list, with caps at the fixture's limits (25 and 100 USDG, 0.2 and 1 SOL).
    MERRYMEN_SOLANA_LIVE_TENANTS: TENANT, MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG: "25", MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "100",
    MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL: "0.2", MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: "1",
    // The runtime builds its PostgreSQL schema as hosted does; the database itself is the one passed in.
    ...(postgres ? { DATABASE_URL: "postgres://already-connected" } : {}), ...opts.env };
  const bindings = new SqlSolanaBindingStore(async () => db, postgres ? "postgres" : "sqlite", () => clock.now);
  await bindings.bind(TENANT, "did:privy:owner", owner);
  await bindings.settings(TENANT, owner, 0, "live", limits);
  await ensureSolanaTradingSchema(db, postgres);
  const record = { programId: PROGRAM, vault, session, sessionEpoch: "1", registrationSignature: key(43), registeredAtMs: NOW - 10_000 };
  await db.prepare("INSERT INTO solana_runtime_sessions(tenant,owner,record_json,sealed_seed) VALUES(?,?,?,?)").run(TENANT, owner, JSON.stringify(record),
    sealSecret(`solana-session/v1 ${TENANT} ${owner} ${PROGRAM} ${vault} ${session} 1\n` + sessionSeed.toString("base64"), Buffer.alloc(32, 30)));
  // Prior settled history: the vault holds opts.wsol bought at the fair price.
  const basis = opts.wsol * 150n / 1000n;
  await db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, owner, JSON.stringify({
    hwmRaw: (opts.cash + basis).toString(), cashRaw: opts.cash.toString(), wsolRaw: opts.wsol.toString(), costBasisUsdgRaw: basis.toString(),
    realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 900, updatedAtMs: NOW - 5000 }));
  if (opts.strategy) { const b = (await bindings.get(TENANT))!; await bindings.strategy(TENANT, owner, b.revision, opts.strategy as never); }
  // `runtime(more, via)`: an app runtime on the same database, chain and clock whose env adds `more`, reading through `via` (default: the chain itself).
  // `log` receives the runtime's operator lines (default: stderr); `service`, which service it is (default: the web).
  const runtime = (more: Record<string, string> = {}, via: SolanaLiveRpc = rpc, log?: (line: string) => void, service?: "web" | "worker") =>
    createSolanaAppRuntime({ db, rpc: via, market, env: { ...env, ...more }, now: () => clock.now, ...(log ? { log } : {}), ...(service ? { service } : {}) }), app = runtime();
  const runtime_ = (service: "web" | "worker") => runtime({}, rpc, undefined, service);
  const submissions = async () => (await db.prepare("SELECT request_id,notional_raw,submission_json FROM solana_runtime_submissions").all() as
    Array<{ request_id: string; notional_raw: string; submission_json: string }>).map(r => ({ ...r, submission: JSON.parse(r.submission_json) as SolanaSignedSubmission }));
  // The agent runs the worker's runtime by default, as runSolanaAgent does: it publishes its settings as the worker's, beside the web's.
  const agent = (runtime: ReturnType<typeof createSolanaAppRuntime> = runtime_("worker"), log?: (line: string) => void) => createSolanaAgent({ db, runtime, market, now: () => clock.now,
    postgres, ...(log ? { log } : {}) });
  // `rpc`, `env`, `clock`, `sessionKeys` and `vault` let a test build an executor of its own on this chain.
  /** Close the database file and open it again: everything held in memory by earlier runtimes is gone. */
  const reopen = () => { if (!opts.dbFile) assert.fail("reopen needs a database file"); raw.close(); raw = new DatabaseSync(opts.dbFile); db = wrapSqlite(raw); return db; };
  return { app, scope, sends, submissions, agent, net, runtime, served, pythReads, get db() { return db; }, rpc, env, clock, sessionKeys, vault, vaultState, read, reopen, feePayer, cashAta, wsolAta,
    market, bindings };
}
/** The compute-unit limit and price a signed swap carries (ComputeBudget instructions 2 and 3). */
function computeBudget(submission: SolanaSignedSubmission): { units: number; price: bigint } {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(submission.signedTransactionBase64, "base64")).messageBytes);
  const budget = message.instructions.filter(ix => message.staticAccounts[ix.programAddressIndex] === "ComputeBudget111111111111111111111111111111").map(ix => Buffer.from(ix.data!));
  return { units: budget.find(d => d[0] === 2)!.readUInt32LE(1), price: budget.find(d => d[0] === 3)!.readBigUInt64LE(1) };
}
const manual = (inputMint: string, amountRaw: string, requestId: string) => ({ kind: "spl-swap", chain: CHAINS.solana, mode: "live", requestId, inputMint,
  outputMint: inputMint === SOLANA_USDG_MINT ? SOLANA_WRAPPED_SOL_MINT : SOLANA_USDG_MINT, amountRaw, slippageBps: 50 });
const rebalance = { enabled: true, rebalanceBps: 100, tradeUsdgRaw: "25000000", intervalSeconds: 60 };

test("A: an agent sell with a fair mark and a dust build quote is never signed, admitted or sent", async t => {
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "dust" }, strategy: { ...rebalance, targetSolBps: 2500 } });
  assert.deepEqual((await f.agent().tick()).map(r => r.outcome), ["unavailable"]);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
  assert.ok(f.net.urls.includes("https://api.jup.ag/swap/v1/swap-instructions"), "the dust route was built and then refused");
});

test("B: a dust mark and a dust build cannot sell the whole position", async t => {
  const f = await fixture(t, { cash: 0n, wsol: 1_000_000_000n, mark: "dust", build: { kind: "dust" }, strategy: { ...rebalance, targetSolBps: 5000 } });
  assert.deepEqual((await f.agent().tick()).map(r => r.outcome), ["unavailable"]);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});

test("B2: with a dust mark but a fair build, the agent's sale is sized by SOL and charged at its reference value", async t => {
  // The dust mark makes the whole 1 SOL look worth 1 micro-USDG. The agent asks for
  // the 0.2 SOL per-trade maximum; that is 30 USDG at $150, over the 25 USDG limit.
  const f = await fixture(t, { cash: 0n, wsol: 1_000_000_000n, mark: "dust", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 5000 } });
  assert.deepEqual((await f.agent().tick()).map(r => r.outcome), ["unavailable"]);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
  assert.equal(f.net.lastBuild?.amount, 200_000_000n);
});

test("C: a manual sell previewed fairly but built at dust is refused", async t => {
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "dust" } });
  const intent = manual(SOLANA_WRAPPED_SOL_MINT, "166000000", "manual-sell-1");
  const preview = await f.app.preview(f.scope, { mode: "live", intent }) as { quote: { minOutAmount: string } };
  assert.equal(preview.quote.minOutAmount, "24775500");
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent }), /refused: risk/);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});

test("C2: a manual sell built 1% below its preview, inside the independent price tolerance, is refused when it carries the previewed minimum", async t => {
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "factor", num: 99n, den: 100n } });
  const intent = manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "owner-floor-sell");
  const preview = await f.app.preview(f.scope, { mode: "live", intent }) as { quote: { minOutAmount: string } };
  assert.equal(preview.quote.minOutAmount, "14925000");
  // The route is built at 14,850,000 with a 14,775,750 minimum: above the Pyth floor, below what the owner saw.
  // The refusal carries the minimum the fresh route guarantees, for the owner to review.
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: { ...intent, minOutAmount: preview.quote.minOutAmount } }),
    (error: unknown) => error instanceof Error && /refused: price-moved/.test(error.message) && (error as { freshMinOutAmount?: string }).freshMinOutAmount === "14775750");
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
  // Nothing was recorded: once the owner accepts that minimum, the same request goes through at it.
  const placed = await f.app.trade(f.scope, { mode: "live", intent: { ...intent, minOutAmount: "14775750" } });
  assert.ok("status" in placed && placed.status === "pending" && placed.minOutAmount === "14775750");
  assert.equal((await f.submissions()).length, 1); assert.equal(f.sends.length, 1);
});

test("C3: the expired-attempt allowance setting reaches live admission, 0 by default; a malformed one refuses before anything is signed", async t => {
  const { SolanaTradingStore: Store } = await import("./solana-trading-store");
  const admissions: unknown[] = [], recordSigned = Store.prototype.recordSigned;
  t.mock.method(Store.prototype, "recordSigned", function (this: InstanceType<typeof Store>, ...args: Parameters<typeof recordSigned>) {
    admissions.push(args[1]); return recordSigned.apply(this, args);
  });
  for (const [env, expected] of [[{}, 0], [{ MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: "7" }, 7]] as const) {
    const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, env });
    const placed = await f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", `allowance-${expected}`) });
    assert.ok("status" in placed && placed.status === "pending");
    assert.deepEqual(admissions.splice(0), [{ expiredAttemptAllowance: expected, referenceToleranceBps: 300 }]);
  }
  const bad = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, env: { MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: "97" } });
  await assert.rejects(bad.app.trade(bad.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "allowance-bad") }), /expired-attempt allowance setting is misconfigured/);
  assert.deepEqual(await bad.submissions(), []); assert.equal(bad.sends.length, 0); assert.deepEqual(admissions, []);
  assert.equal(bad.net.lastBuild, null, "refused before any route was built");
});

test("D: a manual buy built at 1% of fair is refused", async t => {
  const f = await fixture(t, { cash: 100_000_000n, wsol: 0n, mark: "fair", build: { kind: "factor", num: 1n, den: 100n } });
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "manual-buy-1") }), /refused: risk/);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});

test("D2: SOL dust that no route buys back is valued at zero, and a manual buy still goes through", async t => {
  // 1,000 lamports of SOL: Jupiter's zero-output answer, worth 0.00015 USDG at $150.
  const f = await fixture(t, { cash: 100_000_000n, wsol: 1_000n, mark: "zero", build: { kind: "fair" } });
  const placed = await f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "buy-beside-dust") });
  assert.ok("status" in placed && placed.status === "pending");
  const [row] = await f.submissions();
  assert.equal(row!.submission.risk.equityUsdg, "100000000", "the dust adds nothing to equity");
  assert.equal(f.sends.length, 1);
});

test("D3: a SOL mark that fails any other way still refuses a buy; so does a zero-output mark for SOL worth a cent or more, which never trips the breaker", async t => {
  const down = await fixture(t, { cash: 100_000_000n, wsol: 1_000n, mark: "down", build: { kind: "fair" } });
  await assert.rejects(down.app.trade(down.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "buy-mark-down") }), /valid quote/);
  assert.deepEqual(await down.submissions(), []); assert.equal(down.sends.length, 0);
  // 1 SOL bought at $150 beside 100 USDG, and Jupiter answers zero output for it. Valued at zero, equity would be
  // 40% below the high-water mark and the persisted breaker would pause buys until the owner signs a resume.
  // Pyth says it is worth 150 USDG: the answer is unusable, and this buy alone is refused.
  const book = async (f: Awaited<ReturnType<typeof fixture>>) => JSON.parse((await f.db.prepare("SELECT book_json FROM solana_runtime_live_books").get() as { book_json: string }).book_json);
  for (const [wsol, label] of [[1_000_000_000n, "1 SOL"], [66_667n, "66,667 lamports: 1 cent"]] as const) {
    const big = await fixture(t, { cash: 100_000_000n, wsol, mark: "zero", build: { kind: "fair" } });
    await assert.rejects(big.app.trade(big.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "buy-zero-mark") }),
      (error: unknown) => error instanceof SolanaMarketError && error.code === "invalid-quote", label);
    assert.deepEqual(await big.submissions(), [], label); assert.equal(big.sends.length, 0, label);
    assert.equal((await book(big)).buyPaused, undefined, `${label}: the breaker stays as it was`);
  }
  // Just under a cent (66,666 lamports, 9,999 micro-USDG) is dust: valued at zero, and the buy goes through.
  const dust = await fixture(t, { cash: 100_000_000n, wsol: 66_666n, mark: "zero", build: { kind: "fair" } });
  const placed = await dust.app.trade(dust.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "buy-beside-cent") });
  assert.ok("status" in placed && placed.status === "pending");
  assert.equal((await dust.submissions())[0]!.submission.risk.equityUsdg, "100000000");
});

test("D4: the agent plans around SOL dust that no route buys back instead of stopping at it; any other mark failure still stops the tick", async t => {
  const f = await fixture(t, { cash: 100_000_000n, wsol: 1_000n, mark: "zero", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 5000 } });
  // The web served a Solana request on the same settings (published its digest): the worker buys only once it has.
  await f.app.publishLiveRollout();
  assert.deepEqual((await f.agent().tick()).map(r => r.outcome), ["submitted"]);
  const [row] = await f.submissions();
  assert.equal(row!.submission.intent.inputMint, SOLANA_USDG_MINT, "a buy"); assert.equal(row!.submission.intent.amountRaw, "25000000");
  assert.equal(f.sends.length, 1);
  const down = await fixture(t, { cash: 100_000_000n, wsol: 1_000n, mark: "down", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 5000 } });
  assert.deepEqual((await down.agent().tick()).map(r => r.outcome), ["unavailable"]);
  assert.deepEqual(await down.submissions(), []); assert.equal(down.sends.length, 0);
  // A zero-output answer for 1 SOL, worth 150 USDG at Pyth, is not dust: the tick stops before any route is built.
  const big = await fixture(t, { cash: 100_000_000n, wsol: 1_000_000_000n, mark: "zero", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 5000 } });
  assert.deepEqual((await big.agent().tick()).map(r => r.outcome), ["unavailable"]);
  assert.deepEqual(await big.submissions(), []); assert.equal(big.sends.length, 0);
  assert.ok(!big.net.urls.some(url => url.startsWith("https://api.jup.ag/")), "no route was asked for");
  assert.ok(big.pythReads.length > 0, "the dust check read Pyth");
});

/** The reference-price [alert] lines this process said while `run` ran. */
async function referenceAlerts(t: TestContext, run: () => Promise<unknown>): Promise<string[]> {
  const errors = t.mock.method(console, "error"), from = errors.mock.callCount();
  try { await run(); } finally { errors.mock.restore(); }
  return errors.mock.calls.slice(from).map(call => String(call.arguments[0])).filter(line => line.startsWith("[alert] solana-reference-price"));
}

test("a fair manual sell is admitted once, with its reference floor recorded, and a 2%-cheap fill is charged at the reference", async t => {
  const fair = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  let placed: Awaited<ReturnType<typeof fair.app.trade>> | undefined;
  // A fresh reference says nothing to the operator.
  assert.deepEqual(await referenceAlerts(t, async () => {
    placed = await fair.app.trade(fair.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "fair-sell") });
  }), []);
  assert.ok(placed && "status" in placed && placed.status === "pending");
  const [row] = await fair.submissions();
  assert.equal(row!.notional_raw, "15000000");
  assert.equal(row!.submission.risk.reference.minOutFloor, "14550000");
  assert.ok(BigInt(row!.submission.minOutAmount) >= BigInt(row!.submission.risk.reference.minOutFloor));
  assert.equal(fair.sends.length, 1);
  const cheap = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "factor", num: 98n, den: 100n } });
  const cheapPlaced = await cheap.app.trade(cheap.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "cheap-sell") });
  assert.equal("status" in cheapPlaced && cheapPlaced.status, "pending");
  assert.equal((await cheap.submissions())[0]!.notional_raw, "15000000");
});

test("a sell above the signed per-trade SOL limit is refused before any route is built", async t => {
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "200000001", "too-much") }), /refused: risk/);
  assert.ok(!f.net.urls.some(url => url.startsWith("https://api.jup.ag/")));
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});

/** This process's own MERRYMEN_SOLANA_PYTH_GENERATION for one test, restored after it. */
function processGeneration(t: TestContext, value: string | undefined) {
  const had = Object.hasOwn(process.env, "MERRYMEN_SOLANA_PYTH_GENERATION"), saved = process.env.MERRYMEN_SOLANA_PYTH_GENERATION;
  t.after(() => { if (had) process.env.MERRYMEN_SOLANA_PYTH_GENERATION = saved; else delete process.env.MERRYMEN_SOLANA_PYTH_GENERATION; });
  if (value === undefined) delete process.env.MERRYMEN_SOLANA_PYTH_GENERATION; else process.env.MERRYMEN_SOLANA_PYTH_GENERATION = value;
}
/** A good read clears anything an earlier test left refused in this process, so the next refusal is said at once. */
const clearReferenceAlerts = () => readSolanaReferencePrice(async () => ({ context: { slot: SLOT }, value: pythAccount({ publishTimeMs: NOW }) }), SLOT, NOW,
  { generation: "current" });
const CURRENT = SOLANA_PYTH_FEEDS.current, UPGRADED = SOLANA_PYTH_FEEDS.upgraded;
/** What a Pyth generation setting that names no generation says, first time, in full. */
const CONFIG_ALERT = "[alert] solana-reference-price refused: reason=config generation=invalid failingForMs=0 refused=1 suppressed=0 — " +
  "MERRYMEN_SOLANA_PYTH_GENERATION must be current or upgraded (unset is current); no live Solana trade is admitted until the setting is fixed";

test("a Pyth generation setting that names neither generation is a configuration refusal before any quote or read, and says the [alert]", async t => {
  processGeneration(t, undefined);
  for (const value of ["Upgraded", "both", " current", UPGRADED.account]) {
    const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
    await clearReferenceAlerts();
    const said = await referenceAlerts(t, () => assert.rejects(
      f.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: value }).trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "misconfigured") }),
      (error: unknown) => error instanceof Error && error.name === "SolanaAppRuntimeError" && (error as Error & { code: string }).code === "configuration" &&
        /independent SOL price source \(Pyth generation\) is misconfigured/.test(error.message), value));
    // Said once, as the line an operator pages on, with the setting to fix rather than a Pyth outage to chase,
    // and never with the value itself: the whole line is fixed text.
    assert.deepEqual(said, [CONFIG_ALERT], value);
    assert.ok(!said.some(line => line.split(" — ")[0]!.includes(value.trim())), value);
    assert.deepEqual(f.pythReads, [], value); assert.ok(!f.net.urls.some(url => url.startsWith("https://api.jup.ag/")), value);
    assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
  }
});

test("the runtime's own env picks the generation for the read, the executor's check and the store's admission; the process's setting is never read", async t => {
  // A process setting that names no generation would refuse any read or check that consulted it.
  processGeneration(t, "Upgraded");
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  const placed = await f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "runtime-env-sell") });
  assert.equal("status" in placed && placed.status, "pending");
  assert.deepEqual(f.pythReads, [CURRENT.account, CURRENT.account]);
  const [row] = await f.submissions();
  assert.equal(row!.submission.risk.reference.reference.account, CURRENT.account); assert.equal(f.sends.length, 1);
});

test("a WSOL withdrawal is valued from the runtime's generation, and a store keeps that valuation only while it checks the same one", async t => {
  processGeneration(t, "current");
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  f.served.set(f.scope.owner, () => rpcAccount(Buffer.alloc(0), SYSTEM, false, 1_000_000_000)); // the owner pays for its own transaction
  await f.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: "upgraded" }).prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "100000000" });
  assert.deepEqual(f.pythReads, [UPGRADED.account, UPGRADED.account]);
  const saved = (await new SolanaTradingStore(f.db, f.scope).setup())!;
  assert.equal(saved.withdrawValuation?.reference.reference.account, UPGRADED.account);
  assert.equal(saved.withdrawValuation?.reference.referenceOut, "15000000"); // 0.1 SOL at $150
  // Offered again to a store that checks the other generation, or a setting that names none, it is dropped: never a refusal.
  for (const generation of [() => "current" as const, () => { throw new Error("names no generation"); }]) {
    const store = new SolanaTradingStore(f.db, f.scope, () => NOW, undefined, generation);
    assert.equal(await store.saveSetup(saved), true);
    assert.equal((await store.setup())!.withdrawValuation, undefined);
  }
  const same = new SolanaTradingStore(f.db, f.scope, () => NOW, undefined, () => "upgraded");
  assert.equal(await same.saveSetup(saved), true);
  assert.equal((await same.setup())!.withdrawValuation?.reference.reference.account, UPGRADED.account);
});

test("a WSOL withdrawal still prepares while the Pyth generation setting names none: no Pyth read, no valuation, and the [alert] is said", async t => {
  processGeneration(t, undefined);
  // The owner's way out never depends on the setting: the valuation is dropped and the high-water mark
  // stays put (the conservative direction), as for any other unreadable value.
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  f.served.set(f.scope.owner, () => rpcAccount(Buffer.alloc(0), SYSTEM, false, 1_000_000_000)); // the owner pays for its own transaction
  await clearReferenceAlerts();
  let prepared: { transactionBase64: string } | undefined;
  const said = await referenceAlerts(t, async () => {
    prepared = await f.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: "both" }).prepareOwnerAction(f.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "100000000" });
  });
  assert.ok(prepared && prepared.transactionBase64.length > 0);
  assert.deepEqual(f.pythReads, []);
  const saved = (await new SolanaTradingStore(f.db, f.scope).setup())!;
  assert.deepEqual([saved.kind, saved.mint, saved.amountRaw, saved.withdrawValuation], ["withdraw", SOLANA_WRAPPED_SOL_MINT, "100000000", undefined]);
  assert.deepEqual(said, [CONFIG_ALERT]);
  // The same withdrawal with the setting unset is valued, from the default generation.
  const valued = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  valued.served.set(valued.scope.owner, () => rpcAccount(Buffer.alloc(0), SYSTEM, false, 1_000_000_000));
  await valued.runtime().prepareOwnerAction(valued.scope, { action: "withdraw", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "100000000" });
  assert.deepEqual(valued.pythReads, [CURRENT.account, CURRENT.account]);
  assert.equal((await new SolanaTradingStore(valued.db, valued.scope).setup())!.withdrawValuation?.reference.referenceOut, "15000000");
});

test("status names a misconfigured reference setting as a blocker of every trade, and an agent held by it still says the [alert]", async t => {
  processGeneration(t, undefined);
  const SOURCE = "The independent SOL price source (Pyth generation) is misconfigured.", TOLERANCE = "The independent SOL price tolerance is misconfigured.";
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 2500 } });
  const good = await f.app.status(f.scope);
  assert.deepEqual([good.live.ready, good.live.blockers], [true, []]);
  for (const [more, blocker] of [[{ MERRYMEN_SOLANA_PYTH_GENERATION: "both" }, SOURCE], [{ MERRYMEN_SOLANA_PYTH_GENERATION: "Upgraded" }, SOURCE],
    [{ MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS: "49" }, TOLERANCE], [{ MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS: "3e2" }, TOLERANCE]] as const) {
    await clearReferenceAlerts();
    let status: Awaited<ReturnType<typeof f.app.status>> | undefined;
    const said = await referenceAlerts(t, async () => { status = await f.runtime(more).status(f.scope); });
    // Not ready, and no exit either: trade() would refuse a sell as configuration too.
    assert.deepEqual([status!.live.ready, status!.live.canExit, status!.live.blockers], [false, false, [blocker]], JSON.stringify(more));
    assert.deepEqual(said, blocker === SOURCE ? [CONFIG_ALERT] : [], JSON.stringify(more));
  }
  // The agent holds instead of trying, and the operator still hears about the generation, once.
  await clearReferenceAlerts();
  let outcomes: string[] = [];
  const said = await referenceAlerts(t, async () => { outcomes = (await f.agent(f.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: "both" })).tick()).map(r => r.outcome); });
  assert.deepEqual(outcomes, ["held"]);
  assert.deepEqual(said, [CONFIG_ALERT]);
  assert.deepEqual(f.pythReads, []); assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});

test("status blocks trades and exits on a Jupiter key every live route refuses, as on a missing one, and a set but unusable key says the [alert]", async t => {
  const JUPITER = "Configure Jupiter quote access.";
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  const good = await f.app.status(f.scope);
  assert.deepEqual([good.live.ready, good.live.canExit, good.live.blockers], [true, true, []]);
  for (const [apiKey, alerted] of [["bad key", true], ["   ", true], ["x".repeat(1025), true], ["caf\u00e9", true], ["", false]] as const) {
    const lines: string[] = [], app = f.runtime({ MERRYMEN_JUPITER_API_KEY: apiKey }, f.rpc, line => lines.push(line));
    const status = await app.status(f.scope);
    // Not ready, and no exit either: the live route builder refuses a sell's route as configuration too.
    assert.deepEqual([status.live.ready, status.live.canExit, status.live.blockers], [false, false, [JUPITER]], JSON.stringify(apiKey));
    const alerts = lines.filter(line => line.startsWith("[alert] solana-jupiter-key misconfigured"));
    assert.equal(alerts.length, alerted ? 1 : 0, JSON.stringify(apiKey));
    // Once a minute while it persists; the value itself is never logged.
    await app.status(f.scope); assert.equal(lines.filter(line => line.startsWith("[alert] solana-jupiter-key")).length, alerted ? 1 : 0);
    if (apiKey === "bad key") {
      assert.ok(lines.every(line => !line.includes(apiKey)));
      f.clock.now += 60_000; await app.status(f.scope); f.clock.now -= 60_000;
      assert.equal(lines.filter(line => line.startsWith("[alert] solana-jupiter-key")).length, 2);
      // The trade the blocker stands for: refused as configuration before anything is signed or sent.
      await assert.rejects(app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "bad-key-exit") }),
        (error: unknown) => error instanceof SolanaLiveMarketError && error.code === "configuration");
      assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
    }
  }
});

test("status blocks trades and exits once the day's operations are used, by expired attempts beyond the allowance or by trades, as admission refuses them", async t => {
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  // The fixture's limits allow 20 operations a day. Rows inside the last 24 hours, and one just outside it.
  const row = async (requestId: string, status: string, createdAtMs: number) => f.db.prepare(`INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(TENANT, f.scope.owner, requestId, f.vault, "0", `sig-${requestId}`, status, createdAtMs, "0", JSON.stringify({ intent: { requestId }, signature: `sig-${requestId}` }));
  await row("old-expired", "expired", NOW - 86_400_000);
  for (let i = 0; i < 19; i++) await row(`dropped-${i}`, "expired", NOW - 1000 - i);
  const view = async (more: Record<string, string> = {}) => { const s = await f.runtime(more).status(f.scope); return [s.live.ready, s.live.canExit, s.live.blockers]; };
  assert.deepEqual(await view(), [true, true, []], "19 of 20 counted: one operation left");
  await row("dropped-19", "expired", NOW - 1);
  assert.deepEqual(await view(), [false, false, [SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED]], "20 of 20 counted");
  // The blocker says what admission does: the exit is refused with the same words, before anything is sent.
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "exit-exhausted") }),
    (error: unknown) => error instanceof Error && error.message === SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED);
  assert.equal(f.sends.length, 0);
  // An allowance of 1 leaves one operation.
  assert.deepEqual(await view({ MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: "1" }), [true, true, []]);
  // An unreadable allowance is its own configuration blocker, not this one.
  assert.deepEqual((await view({ MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: "97" }))[2], [SOLANA_EXPIRED_ATTEMPT_ALLOWANCE_MISCONFIGURED]);
  // Trades that landed or failed use operations whatever the allowance.
  await f.db.prepare("UPDATE solana_runtime_submissions SET status='failed' WHERE request_id LIKE 'dropped-%'").run();
  assert.deepEqual(await view({ MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: "96" }), [false, false, [SOLANA_STATUS_DAILY_OPERATIONS_USED]]);
  await assert.rejects(f.runtime({ MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: "96" }).trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "exit-used") }),
    /rolling daily limit/);
  assert.equal(f.sends.length, 0);
  // As they leave the window, neither blocker stays (the fixture's on-chain permission has expired by then).
  f.clock.now = NOW - 2 + 86_400_000;
  await f.db.prepare("UPDATE solana_wallet_bindings SET limits_json=?").run(JSON.stringify({ ...limits, expiresAtMs: f.clock.now + 3_600_000 }));
  const later = (await view())[2] as string[];
  assert.ok(!later.includes(SOLANA_STATUS_DAILY_OPERATIONS_USED) && !later.includes(SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED), JSON.stringify(later));
});

test("with MERRYMEN_SOLANA_PYTH_GENERATION=upgraded, live trades are read, checked by the executor and admitted by the store on the upgraded account alone", async t => {
  // The process names the other generation: a read or check that consulted it would refuse these trades.
  processGeneration(t, "current");
  for (const [inputMint, amountRaw, cash, wsol, notional] of [[SOLANA_WRAPPED_SOL_MINT, "100000000", 50_000_000n, 1_000_000_000n, "15000000"],
    [SOLANA_USDG_MINT, "25000000", 100_000_000n, 0n, "25000000"]] as const) {
    const f = await fixture(t, { cash, wsol, mark: "fair", build: { kind: "fair" } });
    const placed = await f.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: "upgraded" }).trade(f.scope, { mode: "live", intent: manual(inputMint, amountRaw, "upgraded-trade") });
    assert.equal("status" in placed && placed.status, "pending", inputMint);
    // The runtime read the upgraded account and never the current one; the executor signed only
    // above that bound's floor, and the store admitted the bound as evidence from it.
    assert.deepEqual(f.pythReads, [UPGRADED.account, UPGRADED.account], inputMint);
    const [row] = await f.submissions();
    assert.equal(row!.submission.risk.reference.reference.account, UPGRADED.account, inputMint);
    assert.ok(BigInt(row!.submission.minOutAmount) >= BigInt(row!.submission.risk.reference.minOutFloor), inputMint);
    assert.equal(row!.notional_raw, notional, inputMint); assert.equal(f.sends.length, 1, inputMint);
  }
});

test("a generation mismatch refuses: the other generation's account at the configured address, or the configured account gone, with no fallback", async t => {
  processGeneration(t, undefined);
  const sell = manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "mismatch-sell");
  // Set to upgraded, and the RPC serves, at the upgraded address, an account the current receiver owns.
  const swapped = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  swapped.served.set(UPGRADED.account, () => pythAccount({ price: 15_000_000_000n, conf: 1_500_000n, publishTimeMs: NOW, owner: CURRENT.receiverProgram }));
  await clearReferenceAlerts();
  let said = await referenceAlerts(t, () => assert.rejects(swapped.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: "upgraded" }).trade(swapped.scope, { mode: "live", intent: sell }),
    /refused: risk/));
  assert.deepEqual(said.map(line => line.split(" — ")[0]), [`[alert] solana-reference-price refused: reason=foreign generation=upgraded account=${UPGRADED.account} ` +
    "failingForMs=0 refused=1 suppressed=0"]);
  assert.deepEqual(swapped.pythReads, [UPGRADED.account]);
  assert.deepEqual(await swapped.submissions(), []); assert.equal(swapped.sends.length, 0);
  // Set to current, whose account is gone while the upgraded one is fresh: refused, and the upgraded account is never read.
  const closed = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  closed.served.set(CURRENT.account, () => null);
  await clearReferenceAlerts();
  said = await referenceAlerts(t, () => assert.rejects(closed.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: "current" }).trade(closed.scope, { mode: "live", intent: sell }),
    /refused: risk/));
  assert.deepEqual(said.map(line => line.split(" — ")[0]), [`[alert] solana-reference-price refused: reason=missing generation=current account=${CURRENT.account} ` +
    "failingForMs=0 refused=1 suppressed=0"]);
  assert.deepEqual(closed.pythReads, [CURRENT.account]);
  assert.deepEqual(await closed.submissions(), []); assert.equal(closed.sends.length, 0);
});

test("a signed trade whose bound came from one generation is refused at admission by a store that checks the other, or whose setting names none", async t => {
  processGeneration(t, undefined);
  // Signed and recorded by a runtime set to upgraded ...
  const signer = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  await signer.runtime({ MERRYMEN_SOLANA_PYTH_GENERATION: "upgraded" }).trade(signer.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "carried") });
  const submission = (await signer.submissions())[0]!.submission;
  assert.equal(submission.risk.reference.reference.account, UPGRADED.account);
  // ... then offered for admission to the same account's journal on a fresh database, checked as each store is set.
  const checks: Array<[string, () => SolanaPythGeneration, boolean]> = [["current", () => "current", false],
    ["a setting that names none", () => solanaPythGeneration({ MERRYMEN_SOLANA_PYTH_GENERATION: "both" }), false], ["upgraded", () => "upgraded", true]];
  for (const [name, generation, admitted] of checks) {
    const other = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
    const journal = new SolanaTradingStore(other.db, other.scope, () => NOW, undefined, generation);
    if (admitted) assert.equal(await journal.recordSigned(structuredClone(submission)), true, name);
    else await assert.rejects(journal.recordSigned(structuredClone(submission)), /independent SOL price evidence is missing, stale or altered/, name);
    assert.equal((await other.submissions()).length, admitted ? 1 : 0, name);
  }
});

test("a retry of an admitted live trade returns it before any reference setting is checked: a bad or switched setting never blocks the replay", async t => {
  processGeneration(t, undefined);
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  // Reconciling a recorded trade asks two agreeing providers (readEach), each for its finalized epoch too.
  const one: SolanaLiveRpc["read"] = fn => f.rpc.read(read => fn(async (method, params) =>
    method === "getEpochInfo" ? { absoluteSlot: SLOT, blockHeight: 900 } : read(method, params)));
  const two: SolanaLiveRpc = { ...f.rpc, read: one, readEach: async fn => [await one(fn), await one(fn)] };
  const input = { mode: "live" as const, intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "admitted-then-retried") };
  const placed = await f.runtime({}, two).trade(f.scope, input);
  assert.ok("status" in placed && placed.status === "pending");
  const [admitted] = await f.submissions();
  assert.equal(admitted!.submission.risk.reference.reference.account, CURRENT.account);
  assert.deepEqual(f.pythReads, [CURRENT.account, CURRENT.account]);
  const jupiter = () => f.net.urls.filter(url => url.startsWith("https://api.jup.ag/")).length, built = jupiter();
  // A setting that names no generation, the other generation, and a tolerance out of range: each would refuse a new trade.
  for (const more of [{ MERRYMEN_SOLANA_PYTH_GENERATION: "both" }, { MERRYMEN_SOLANA_PYTH_GENERATION: "upgraded" },
    { MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS: "49" }] as Array<Record<string, string>>) {
    const label = JSON.stringify(more), sendsBefore = f.sends.length;
    await clearReferenceAlerts();
    let again: Awaited<ReturnType<typeof f.app.trade>> | undefined;
    const said = await referenceAlerts(t, async () => { again = await f.runtime(more, two).trade(f.scope, input); });
    // The prior trade, reconciled and returned: the setting is never consulted, so nothing is said either.
    assert.ok(again && "signature" in again, label);
    assert.deepEqual([again.signature, again.status, again.requestId], [placed.signature, "pending", "admitted-then-retried"], label);
    assert.deepEqual(said, [], label);
    // No Pyth read (of either account), no Jupiter quote or build, no new submission.
    assert.deepEqual(f.pythReads, [CURRENT.account, CURRENT.account], label);
    assert.equal(jupiter(), built, label);
    const rows = await f.submissions();
    assert.deepEqual(rows.map(row => row.submission.signature), [placed.signature], label);
    // Unseen and inside its deadline, the recorded bytes are rebroadcast once, exactly as signed: never re-signed.
    assert.equal(f.sends.length, sendsBefore + 1, label);
    assert.ok(f.sends.every(wire => wire === admitted!.submission.signedTransactionBase64), label);
  }
});

test("the executor checks a fresh bound against its own generation, not the one the bound names: the other generation's is refused before signing", async t => {
  processGeneration(t, undefined);
  // Built directly, with an assessRisk that returns a fresh, valid bound from the generation named second:
  // only the executor's own check stands between that bound and a signature (store admission is not reached).
  const feePayerKeyPair = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(31));
  const signs = t.mock.method(crypto.subtle, "sign");
  const cases: Array<[configured: SolanaPythGeneration | undefined, boundFrom: SolanaPythGeneration, admitted: boolean]> = [
    ["upgraded", "current", false], [undefined, "upgraded", false], ["current", "upgraded", false],
    // The same evidence from the configured generation is signed, recorded and sent: the refusals above are the generation alone.
    ["upgraded", "upgraded", true], [undefined, "current", true]];
  for (const [configured, boundFrom, admitted] of cases) {
    const label = `executor ${configured ?? "default"}, bound from ${boundFrom}`;
    const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
    const recorded: SolanaSignedSubmission[] = [], signedBefore = signs.mock.callCount();
    const executor = createSolanaExecutor({ programId: PROGRAM, programBinarySha256: f.env.MERRYMEN_SOLANA_VAULT_SHA256, ...(configured ? { pythGeneration: configured } : {}),
      sessionKeyPair: f.sessionKeys, feePayerKeyPair, rpc: f.rpc, market: createSolanaLiveMarket({ env: f.env, rpc: f.rpc, now: () => f.clock.now }),
      journal: { get: async () => null, recordSigned: async submission => { recorded.push(submission); return true; }, settle: async () => assert.fail("nothing settles") },
      maxFeeLamports: "5000000", now: () => f.clock.now,
      assessRisk: async ({ intent, quote }) => {
        const reference = solanaReferenceBound(intent, pythReference(f.clock.now, 15_000_000_000n, SLOT, boundFrom), 300);
        return { observedAtMs: f.clock.now, slot: SLOT, notionalUsdg: solanaReferenceNotional(intent, quote.outAmount, reference).toString(),
          equityUsdg: "200000000", peakEquityUsdg: "200000000", cashUsdg: "50000000", wsolRaw: "1000000000", reference };
      } });
    const intent = { ...manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "executor-generation"), owner: f.scope.owner, vault: f.vault };
    if (admitted) {
      assert.equal((await executor.execute(intent)).status, "pending", label);
      assert.ok(signs.mock.callCount() > signedBefore, label);
      assert.deepEqual(recorded.map(s => s.risk.reference.reference.account), [SOLANA_PYTH_FEEDS[boundFrom].account], label);
      assert.equal(f.sends.length, 1, label);
    } else {
      await assert.rejects(executor.execute(intent), /refused: risk/, label);
      // Nothing signed, recorded or sent.
      assert.equal(signs.mock.callCount(), signedBefore, label);
      assert.deepEqual(recorded, [], label); assert.equal(f.sends.length, 0, label);
    }
    assert.deepEqual(f.pythReads, [], label); // the bound came from assessRisk; the executor itself reads no reference
  }
});

test("the configured reference tolerance reaches the executor's check and admission; a bound built at another is refused before signing", async t => {
  // The runtime builds the bound at its own tolerance and hands that same number to the executor and the store.
  const { SolanaTradingStore: Store } = await import("./solana-trading-store");
  const admissions: unknown[] = [], recordSigned = Store.prototype.recordSigned;
  t.mock.method(Store.prototype, "recordSigned", function (this: InstanceType<typeof Store>, ...args: Parameters<typeof recordSigned>) {
    admissions.push(args[1]); return recordSigned.apply(this, args);
  });
  const wide = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, env: { MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS: "500" } });
  const placed = await wide.app.trade(wide.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "tolerance-500") });
  assert.ok("status" in placed && placed.status === "pending");
  assert.equal((await wide.submissions())[0]!.submission.risk.reference.toleranceBps, 500);
  assert.deepEqual(admissions.splice(0), [{ expiredAttemptAllowance: 0, referenceToleranceBps: 500 }]);
  // An executor configured for 3% (or left at the default) refuses a fresh, self-consistent bound built at 10%: nothing is signed, recorded or sent.
  const feePayerKeyPair = await createKeyPairFromPrivateKeyBytes(new Uint8Array(32).fill(31));
  for (const configured of [300, undefined]) {
    const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
    const recorded: SolanaSignedSubmission[] = [];
    const executor = createSolanaExecutor({ programId: PROGRAM, programBinarySha256: f.env.MERRYMEN_SOLANA_VAULT_SHA256, ...(configured ? { referenceToleranceBps: configured } : {}),
      sessionKeyPair: f.sessionKeys, feePayerKeyPair, rpc: f.rpc, market: createSolanaLiveMarket({ env: f.env, rpc: f.rpc, now: () => f.clock.now }),
      journal: { get: async () => null, recordSigned: async submission => { recorded.push(submission); return true; }, settle: async () => assert.fail("nothing settles") },
      maxFeeLamports: "5000000", now: () => f.clock.now,
      assessRisk: async ({ intent, quote }) => {
        const reference = solanaReferenceBound(intent, pythReference(f.clock.now, 15_000_000_000n, SLOT), 1000);
        return { observedAtMs: f.clock.now, slot: SLOT, notionalUsdg: solanaReferenceNotional(intent, quote.outAmount, reference).toString(),
          equityUsdg: "200000000", peakEquityUsdg: "200000000", cashUsdg: "50000000", wsolRaw: "1000000000", reference };
      } });
    await assert.rejects(executor.execute({ ...manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "executor-tolerance"), owner: f.scope.owner, vault: f.vault }), /refused: risk/, String(configured));
    assert.deepEqual(recorded, []); assert.equal(f.sends.length, 0);
  }
});

test("a stale independent price refuses even a fair live trade, and says the [alert] an operator pages on", async t => {
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, pythAgeMs: 180_000 });
  // A good read first clears anything an earlier test left refused in this process, so this refusal is said at once.
  await readSolanaReferencePrice(async () => ({ context: { slot: SLOT }, value: pythAccount({ publishTimeMs: NOW }) }), SLOT, NOW);
  const said = await referenceAlerts(t, () =>
    assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "stale-sell") }), /refused: risk/));
  assert.deepEqual(said.map(line => line.split(" — ")[0]), [`[alert] solana-reference-price refused: reason=stale generation=current ` +
    `account=${PYTH_SOL_USD_ACCOUNT} ageMs=180000 maxAgeMs=120000 contextSlot=${SLOT} failingForMs=0 refused=1 suppressed=0`]);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});

test("a compute-unit price minimum above the default maximum still exits; the maximum is its own setting, refused clearly when below the minimum", async t => {
  // The minimum used to be the fixed price: set alone above 1,000,000 it must not block exits.
  const alone = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" },
    env: { MERRYMEN_SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS: "2000000" } });
  await alone.app.trade(alone.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "exit-at-minimum") });
  assert.equal(alone.sends.length, 1);
  assert.equal(computeBudget((await alone.submissions())[0]!.submission).price, 2_000_000n);
  // The explicit maximum bounds what recent fees would otherwise pay.
  const capped = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, priorityFees: [9_000_000],
    env: { MERRYMEN_SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS: "1000", MERRYMEN_SOLANA_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS: "3000" } });
  await capped.app.trade(capped.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "exit-capped") });
  assert.equal(computeBudget((await capped.submissions())[0]!.submission).price, 3000n);
  // A maximum below the minimum is a configuration refusal, before any quote, signature or send.
  const misconfigured: Record<string, string>[] = [{ MERRYMEN_SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS: "2000", MERRYMEN_SOLANA_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS: "1000" },
    { MERRYMEN_SOLANA_MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS: "lots" }];
  for (const env of misconfigured) {
    const bad = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, env });
    await assert.rejects(bad.app.trade(bad.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "exit-misconfigured") }),
      error => error instanceof Error && error.name === "SolanaAppRuntimeError" && (error as Error & { code: string }).code === "configuration" && /compute-unit price settings are misconfigured/.test(error.message));
    assert.ok(!bad.net.urls.some(url => url.startsWith("https://api.jup.ag/")), JSON.stringify(env));
    assert.equal(bad.sends.length, 0); assert.deepEqual(await bad.submissions(), []);
    const status = await bad.app.status(bad.scope);
    assert.match(status.live.blockers.join(" "), /compute-unit price settings are misconfigured/); assert.equal(status.live.canExit, false);
  }
});

/**
 * A transport over the fixture's chain whose primary and fallback answer through their own wrappers of the honest
 * read: `primary` (default: honest) and `fallback` (default: honest). Each read session gets a fresh wrapped read.
 */
function split(f: Awaited<ReturnType<typeof fixture>>, primary: (read: SolanaLiveRead) => SolanaLiveRead = read => read,
  fallback: (read: SolanaLiveRead) => SolanaLiveRead = read => read): SolanaLiveRpc {
  const via = (wrap: (read: SolanaLiveRead) => SolanaLiveRead) => <T>(fn: (read: SolanaLiveRead) => Promise<T>) => f.rpc.read(read => fn(wrap(read)));
  return { ...f.rpc, read: via(primary), readEach: async fn => [await via(primary)(fn), await via(fallback)(fn)] };
}
/** A provider that serves the current generation's SOL/USD account at `usdPerSol` (8 decimals), published `ageMs` ago. */
const pythAt = (usdPerSol: bigint, ageMs = 0) => (read: SolanaLiveRead): SolanaLiveRead => async (method, params = []) =>
  method === "getAccountInfo" && params[0] === CURRENT.account
    ? { context: { slot: SLOT }, value: pythAccount({ price: usdPerSol, conf: usdPerSol / 10_000n, publishTimeMs: NOW - ageMs, owner: CURRENT.receiverProgram }) }
    : read(method, params);

test("one provider's Pyth price cannot lower a live trade's floor: the stricter of both providers' bounds applies, and either one's refusal refuses", async t => {
  // Fair is $150. A sell built 10% cheap clears the floor only at a price at most about $139; a buy built to
  // deliver 10% less SOL clears it only at a price of about $162 or more. One lying provider serves exactly that.
  const cases = [
    { label: "sell, primary lies low", input: SOLANA_WRAPPED_SOL_MINT, amount: "100000000", primary: pythAt(12_000_000_000n), fallback: undefined },
    { label: "sell, fallback lies low", input: SOLANA_WRAPPED_SOL_MINT, amount: "100000000", primary: undefined, fallback: pythAt(12_000_000_000n) },
    { label: "buy, primary lies high", input: SOLANA_USDG_MINT, amount: "25000000", primary: pythAt(17_000_000_000n), fallback: undefined },
    { label: "buy, fallback lies high", input: SOLANA_USDG_MINT, amount: "25000000", primary: undefined, fallback: pythAt(17_000_000_000n) },
  ];
  for (const c of cases) {
    // A buy needs room left to sell the position it leaves (EXITS KEEP ROOM...): 0.1 SOL held then, rather than 1 SOL (the whole day's SOL sold limit).
    const wsol = c.input === SOLANA_USDG_MINT ? 100_000_000n : 1_000_000_000n;
    const f = await fixture(t, { cash: 100_000_000n, wsol, mark: "fair", build: { kind: "factor", num: 90n, den: 100n } });
    await assert.rejects(f.runtime({}, split(f, c.primary, c.fallback)).trade(f.scope, { mode: "live", intent: manual(c.input, c.amount, "lying-pyth") }), /refused: risk/, c.label);
    assert.deepEqual(await f.submissions(), [], c.label); assert.equal(f.sends.length, 0, c.label);
    // The same 10%-cheap route with that price from both providers would be admitted: the honest provider's bound is what refused it.
    const both = await fixture(t, { cash: 100_000_000n, wsol, mark: "fair", build: { kind: "factor", num: 90n, den: 100n } });
    const lie = (c.primary ?? c.fallback)!;
    const placed = await both.runtime({}, split(both, lie, lie)).trade(both.scope, { mode: "live", intent: manual(c.input, c.amount, "lying-pyth") });
    assert.ok("status" in placed && placed.status === "pending", c.label);
  }
  // A fair sell is admitted beside a provider that prices SOL low, and records (and is charged at) the stricter, honest bound.
  const fair = await fixture(t, { cash: 100_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  const placed = await fair.runtime({}, split(fair, pythAt(12_000_000_000n))).trade(fair.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "beside-a-liar") });
  assert.ok("status" in placed && placed.status === "pending");
  const [row] = await fair.submissions();
  assert.equal(row!.submission.risk.reference.reference.price, "15000000000"); assert.equal(row!.submission.risk.reference.minOutFloor, "14550000");
  // A price either provider refuses (stale on the fallback alone) refuses the trade, whatever the other serves.
  const stale = await fixture(t, { cash: 100_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  await assert.rejects(stale.runtime({}, split(stale, undefined, pythAt(15_000_000_000n, 180_000))).trade(stale.scope, { mode: "live",
    intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "stale-fallback") }), /refused: risk/);
  assert.deepEqual(await stale.submissions(), []); assert.equal(stale.sends.length, 0);
});

test("one provider's Pyth price cannot make real SOL dust: a zero-output mark is dust only at every provider's price", async t => {
  // 1 SOL is worth $150; a provider pricing SOL at a millionth of a cent would call it dust.
  const f = await fixture(t, { cash: 100_000_000n, wsol: 1_000_000_000n, mark: "zero", build: { kind: "fair" } });
  for (const [primary, fallback] of [[pythAt(1n), undefined], [undefined, pythAt(1n)]] as const) {
    assert.equal(await f.runtime({}, split(f, primary, fallback)).solMarkDust("1000000000"), false);
    await assert.rejects(f.runtime({}, split(f, primary, fallback)).trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "buy-beside-fake-dust") }),
      (error: unknown) => error instanceof SolanaMarketError && error.code === "invalid-quote");
  }
  assert.equal(await f.runtime({}, split(f, pythAt(1n), pythAt(1n))).solMarkDust("1000000000"), true);
  assert.equal(await f.app.solMarkDust("66666"), true); assert.equal(await f.app.solMarkDust("66667"), false);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});

test("a first live book's balances and slot come from both providers: a phantom balance is refused, and one provider's slot is never persisted", async t => {
  const book = async (f: Awaited<ReturnType<typeof fixture>>) => JSON.parse((await f.db.prepare("SELECT book_json FROM solana_runtime_live_books").get() as { book_json: string }).book_json);
  const fresh = async () => { const f = await fixture(t, { cash: 100_000_000n, wsol: 0n, mark: "fair", build: { kind: "fair" } });
    await f.db.prepare("DELETE FROM solana_runtime_live_books").run(); return f; };
  // The primary shows 900 USDG more than the chain holds, in the risk read: the first book would start from it.
  const phantom = await fresh();
  const cashAta = await deriveSolanaAta(phantom.vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
  const inflate = (read: SolanaLiveRead): SolanaLiveRead => async (method, params = []) => {
    const answer = await read(method, params) as { context: { slot: number }; value: unknown };
    if (method !== "getMultipleAccounts" || (params[0] as string[]).length !== 2 || (params[0] as string[])[0] !== cashAta) return answer;
    return { ...answer, value: [rpcAccount(token(SOLANA_USDG_MINT, phantom.vault, 1_000_000_000n), TOKEN_2022_PROGRAM), (answer.value as unknown[])[1]] };
  };
  await assert.rejects(phantom.runtime({}, split(phantom, inflate)).trade(phantom.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "phantom-first-book") }),
    /refused: invalid-state/);
  assert.deepEqual(await phantom.submissions(), []); assert.equal(phantom.sends.length, 0);
  assert.equal(await phantom.db.prepare("SELECT book_json FROM solana_runtime_live_books").get(), undefined);
  // One provider answering the balance read at a later slot: the book starts at the lowest slot either answered at.
  const ahead = (by: number) => (read: SolanaLiveRead): SolanaLiveRead => async (method, params = []) => {
    const answer = await read(method, params) as { context: { slot: number }; value: unknown };
    return method === "getMultipleAccounts" && (params[0] as string[]).length === 2 ? { ...answer, context: { slot: answer.context.slot + by } } : answer;
  };
  const skewed = await fresh();
  const placed = await skewed.runtime({}, split(skewed, ahead(100))).trade(skewed.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "skewed-first-book") });
  assert.ok("status" in placed && placed.status === "pending");
  assert.equal((await book(skewed)).slot, SLOT); assert.equal((await skewed.submissions())[0]!.submission.risk.slot, SLOT);
  // A slot far beyond what the other provider has seen is one provider's invention: refused, and nothing is booked.
  for (const [label, primary, fallback] of [["primary", ahead(1_000_000_000), undefined], ["fallback", undefined, ahead(1_000_000_000)]] as const) {
    const inflated = await fresh();
    await assert.rejects(inflated.runtime({}, split(inflated, primary, fallback)).trade(inflated.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "inflated") }),
      /refused: invalid-state/, label);
    assert.deepEqual(await inflated.submissions(), [], label); assert.equal(inflated.sends.length, 0, label);
  }
});

test("a live trade reads the vault no earlier than the book and the latest finalized owner transaction, and every provider must show its sequence, so a lagging provider signs nothing", async t => {
  // The fixture's providers answer at SLOT. A native SOL withdrawal finalized past it, written as finalized directly, so
  // only its setup row carries its slot (the store's finishSetup also raises the book's slot: the next test).
  for (const [finalizedSlot, admitted] of [[SLOT + 500, false], [SLOT - 1, true]] as const) {
    const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
    const vault = f.vault;
    await f.db.prepare("INSERT INTO solana_runtime_setups(tenant,owner,setup_json) VALUES(?,?,?)").run(TENANT, f.scope.owner, JSON.stringify({
      kind: "withdraw-sol", amountRaw: "1000", transactionBase64: "dGVzdA==", messageBase64: "dGVzdA==", blockhash: "11111111111111111111111111111111", lastValidBlockHeight: "800",
      programId: PROGRAM, vault, session: "11111111111111111111111111111111", limits, preparedAtMs: NOW - 60_000, expiresAtMs: NOW - 1, signature: "owner-withdraw-sol",
      signedTransactionBase64: "c2lnbmVk", status: "finalized", finalizedSlot, priorVaultExisted: true, priorSequence: "0", priorSessionEpoch: "1" }));
    const trade = f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "after-withdraw-sol") });
    if (admitted) { const placed = await trade; assert.ok("status" in placed && placed.status === "pending"); assert.equal(f.sends.length, 1); continue; }
    await assert.rejects(trade, /refused: invalid-state/);
    assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
  }
  // The owner then prepares another owner transaction and abandons it: the setup row, the only record of the withdrawal's
  // slot, is replaced. The withdrawal consumed sequence 0, so the vault is at sequence 1; the primary still lags behind it
  // (sequence 0 at SLOT) and the fallback has it. Every provider is asked for the vault's sequence at the prepared slot,
  // so the lagging primary's snapshot signs nothing.
  const replaced = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  const abandoned = { kind: "resume-buys", transactionBase64: "dGVzdA==", messageBase64: "dGVzdA==", blockhash: "11111111111111111111111111111111", lastValidBlockHeight: "800",
    programId: PROGRAM, vault: replaced.vault, session: "11111111111111111111111111111111", limits, preparedAtMs: NOW - 1_000, expiresAtMs: NOW + 59_000,
    priorVaultExisted: true, priorSequence: "1", priorSessionEpoch: "1" };
  await replaced.db.prepare("INSERT INTO solana_runtime_setups(tenant,owner,setup_json) VALUES(?,?,?)").run(TENANT, replaced.scope.owner, JSON.stringify(abandoned));
  const current = (read: SolanaLiveRead): SolanaLiveRead => async (method, params = []) =>
    method === "getAccountInfo" && params[0] === replaced.vault ? { context: { slot: SLOT }, value: rpcAccount(replaced.vaultState(1n), PROGRAM) } : read(method, params);
  await assert.rejects(replaced.runtime({}, split(replaced, undefined, current)).trade(replaced.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "after-abandoned-prepare") }),
    /refused: invalid-state/);
  assert.deepEqual(await replaced.submissions(), []); assert.equal(replaced.sends.length, 0);
  // So does a provider showing the session revoked meanwhile (a later epoch at the same sequence).
  const revokedEpoch = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  const revoked = (read: SolanaLiveRead): SolanaLiveRead => async (method, params = []) => {
    if (method !== "getAccountInfo" || params[0] !== revokedEpoch.vault) return read(method, params);
    const bytes = revokedEpoch.vaultState(0n); bytes.writeBigUInt64LE(2n, 74); // discriminator, version, bump, owner, session: the epoch follows
    return { context: { slot: SLOT }, value: rpcAccount(bytes, PROGRAM) };
  };
  await assert.rejects(revokedEpoch.runtime({}, split(revokedEpoch, undefined, revoked)).trade(revokedEpoch.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "after-revoke") }),
    /refused: invalid-state/);
  assert.deepEqual(await revokedEpoch.submissions(), []); assert.equal(revokedEpoch.sends.length, 0);
  // The book's own slot is a floor too.
  const ahead = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  const row = await ahead.db.prepare("SELECT book_json FROM solana_runtime_live_books").get() as { book_json: string };
  await ahead.db.prepare("UPDATE solana_runtime_live_books SET book_json=?").run(JSON.stringify({ ...JSON.parse(row.book_json), slot: SLOT + 1 }));
  await assert.rejects(ahead.app.trade(ahead.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "behind-the-book") }), /refused: invalid-state/);
  assert.deepEqual(await ahead.submissions(), []); assert.equal(ahead.sends.length, 0);
});

test("a native SOL withdrawal finalized past the providers' slot keeps the trade floor after the owner's next prepare replaces its record: both providers lagging sign nothing", async t => {
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  // Signed and pending, then finished as finalized at SLOT + 500 through the store, as status does once both providers agree.
  await f.db.prepare("INSERT INTO solana_runtime_setups(tenant,owner,setup_json) VALUES(?,?,?)").run(TENANT, f.scope.owner, JSON.stringify({
    kind: "withdraw-sol", amountRaw: "1000", transactionBase64: "dGVzdA==", messageBase64: "dGVzdA==", blockhash: "11111111111111111111111111111111", lastValidBlockHeight: "800",
    programId: PROGRAM, vault: f.vault, session: "11111111111111111111111111111111", limits, preparedAtMs: NOW - 60_000, expiresAtMs: NOW - 1, signature: "owner-withdraw-sol",
    signedTransactionBase64: "c2lnbmVk", status: "pending", priorVaultExisted: true, priorSequence: "0", priorSessionEpoch: "1" }));
  await new SolanaTradingStore(f.db, f.scope, () => f.clock.now).finishSetup("owner-withdraw-sol", "finalized", SLOT + 500);
  // The owner prepares another owner transaction and abandons it: the setup row, with the withdrawal's finalized slot, is replaced.
  await f.db.prepare("UPDATE solana_runtime_setups SET setup_json=? WHERE tenant=? AND owner=?").run(JSON.stringify({ kind: "resume-buys", transactionBase64: "dGVzdA==",
    messageBase64: "dGVzdA==", blockhash: "11111111111111111111111111111111", lastValidBlockHeight: "800", programId: PROGRAM, vault: f.vault,
    session: "11111111111111111111111111111111", limits, preparedAtMs: NOW - 1_000, expiresAtMs: NOW + 59_000, priorVaultExisted: true, priorSequence: "1", priorSessionEpoch: "1" }),
    TENANT, f.scope.owner);
  // Both providers still answer at SLOT, from before the withdrawal (vault sequence 0): they agree, so only the floor can refuse.
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "after-replaced-withdraw-sol") }), /refused: invalid-state/);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});

test("a live trade whose send fails after it is recorded survives a restart: a new runtime rebroadcasts the same bytes, signs nothing, and books the fill once (audit risk 44/49)", async t => {
  const dir = mkdtempSync(path.join(tmpdir(), "solana-live-crash-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, dbFile: path.join(dir, "runtime.sqlite") });
  const signs = t.mock.method(crypto.subtle, "sign");
  // The chain as both providers see it, from the moment the swap is signed.
  const chain = { landed: false, sends: [] as string[], failSends: true };
  const receiptOf = (submission: SolanaSignedSubmission) => {
    const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(Buffer.from(submission.signedTransactionBase64, "base64")).messageBytes);
    const keys = [...message.staticAccounts] as string[];
    const swap = message.instructions.find(ix => keys[ix.programAddressIndex] === PROGRAM)!;
    const temp = swap.accountIndices![8]!, out = BigInt(submission.minOutAmount) + 1n, rent = 2_039_280;
    const balances = keys.map((_, index) => index === 0 ? 100_000_000 : index === temp ? rent : 1_000_000);
    const row = (account: string, mint: string, programId: string, amount: bigint) => ({ accountIndex: keys.indexOf(account), mint, owner: f.vault, programId,
      uiTokenAmount: { amount: amount.toString(), decimals: mint === SOLANA_USDG_MINT ? 6 : 9 } });
    return { version: 0, slot: SLOT + 1, transaction: [submission.signedTransactionBase64, "base64"], meta: { err: null, fee: 10_000, loadedAddresses: { writable: [], readonly: [] },
      // The temporary account's rent goes back to the fee payer; the logs were not recorded, so the vault's finalized sequence books it.
      preBalances: balances, postBalances: balances.map((n, index) => index === 0 ? n - 10_000 + rent : index === temp ? 0 : n),
      preTokenBalances: [row(f.wsolAta, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM, 1_000_000_000n), row(f.cashAta, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, 50_000_000n)],
      postTokenBalances: [row(f.wsolAta, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM, 1_000_000_000n - BigInt(submission.intent.amountRaw)),
        row(f.cashAta, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM, 50_000_000n + out)], logMessages: null } };
  };
  const recorded = async () => (await f.submissions())[0]?.submission;
  const read: SolanaLiveRead = async (method, params = []) => {
    const submission = await recorded();
    if (method === "getEpochInfo") return { absoluteSlot: SLOT + 2, blockHeight: 900 };
    if (method === "getSignatureStatuses") return { context: { slot: SLOT + 2 }, value: [chain.landed ? { confirmationStatus: "finalized", slot: SLOT + 1, err: null } : null] };
    if (method === "getTransaction") return chain.landed ? receiptOf(submission!) : null;
    const [key, config] = params as [string, { commitment?: string }];
    if (method === "getAccountInfo" && key === f.vault && config?.commitment === "finalized") {
      return { context: { slot: SLOT + 2 }, value: rpcAccount(f.vaultState(chain.landed ? 1n : 0n), PROGRAM) };
    }
    return f.read(method, params);
  };
  const transport: SolanaLiveRpc = { read: fn => fn(read), readEach: async fn => [await fn(read), await fn(read)],
    send: async wire => { chain.sends.push(wire); if (chain.failSends) throw new Error("the process died before the send was answered"); return "sent"; } };
  // The first process records and signs the swap, and its send fails.
  const placed = await f.runtime({}, transport).trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "crash-sell") });
  assert.ok("status" in placed && placed.status === "pending");
  const submission = (await recorded())!, signed = signs.mock.callCount();
  assert.equal(signed, 2, "fee payer and session signed once each");
  assert.deepEqual(chain.sends, [submission.signedTransactionBase64]);
  // It restarts: the database file is opened again and a new runtime reads it. Unseen by both providers and inside its
  // signed deadline, the recorded bytes are sent again exactly as signed; nothing is signed or recorded anew.
  f.reopen(); chain.failSends = false;
  const restarted = f.runtime({}, transport);
  const status = await restarted.status(f.scope);
  assert.deepEqual(status.live.pending.map(trade => [trade.requestId, trade.signature, trade.status]), [["crash-sell", submission.signature, "pending"]]);
  assert.deepEqual(chain.sends, [submission.signedTransactionBase64, submission.signedTransactionBase64]);
  assert.equal(signs.mock.callCount(), signed); assert.equal((await f.submissions()).length, 1);
  // A retry of the same request returns the recorded trade: never a second signature.
  const retried = await restarted.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "crash-sell") });
  assert.ok("signature" in retried && retried.signature === submission.signature);
  assert.equal(signs.mock.callCount(), signed);
  // It landed. The worker's next tick (receipt recovery) books it on both providers' agreement, once.
  chain.landed = true;
  const sendsBefore = chain.sends.length;
  await f.agent(restarted).tick();
  const [row] = await f.submissions();
  assert.equal(row!.submission.signature, submission.signature);
  const booked = JSON.parse((await f.db.prepare("SELECT status,settlement_json FROM solana_runtime_submissions").get() as { settlement_json: string }).settlement_json);
  assert.deepEqual([booked.status, booked.amountIn, booked.amountOut, booked.feeLamports, booked.slot], ["finalized", "100000000", (BigInt(submission.minOutAmount) + 1n).toString(), "10000", SLOT + 1]);
  const book = async () => JSON.parse((await f.db.prepare("SELECT book_json FROM solana_runtime_live_books").get() as { book_json: string }).book_json);
  const once = await book();
  assert.deepEqual([once.wsolRaw, once.cashRaw, once.networkFeesLamports, once.slot], ["900000000", (50_000_000n + BigInt(submission.minOutAmount) + 1n).toString(), "10000", SLOT + 1]);
  // Another restart, status read and tick change nothing: the fill is booked once, nothing more is sent or signed.
  f.reopen();
  await f.runtime({}, transport).status(f.scope); await f.agent(f.runtime({}, transport)).tick();
  assert.deepEqual(await book(), once);
  assert.equal(chain.sends.length, sendsBefore); assert.equal(signs.mock.callCount(), signed);
});

test("a provider a slot behind the prepared slot is asked again briefly at a trade's two-provider read before the trade is refused", async t => {
  const { SolanaRpcError } = await import("./solana-rpc");
  // The fallback answers "minimum context slot not reached" (a JSON-RPC error) `behind` times at the trade's balance read.
  const lagging = (behind: number) => { let left = behind; return (read: SolanaLiveRead): SolanaLiveRead => async (method, params = []) => {
    if (method === "getMultipleAccounts" && (params[0] as string[]).length === 2 && left > 0) { left--; throw new SolanaRpcError("rpc"); }
    return read(method, params);
  }; };
  const caught = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  const wrap = lagging(2);
  const placed = await caught.runtime({}, split(caught, undefined, read => wrap(read))).trade(caught.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "caught-up") });
  assert.ok("status" in placed && placed.status === "pending"); assert.equal(caught.sends.length, 1);
  // Still behind after every attempt: refused, nothing signed or sent.
  const behind = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  const stuck = lagging(100);
  await assert.rejects(behind.runtime({}, split(behind, undefined, read => stuck(read))).trade(behind.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "never-caught-up") }),
    (error: unknown) => error instanceof SolanaRpcError && error.code === "rpc");
  assert.deepEqual(await behind.submissions(), []); assert.equal(behind.sends.length, 0);
});

test("a live trade that landed is not called a vault below its book, nor paged as one, while it awaits final confirmation", async t => {
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 7500 } });
  // The chain as both providers see it: once landed, the confirmed vault holds the sale's result; finalized receipts come later.
  const chain = { landed: false, finalized: false };
  const recorded = async () => (await f.submissions())[0]?.submission;
  const read: SolanaLiveRead = async (method, params = []) => {
    const submission = await recorded();
    if (method === "getSignatureStatuses" && chain.landed) return { context: { slot: SLOT + 2 }, value: [{ confirmationStatus: chain.finalized ? "finalized" : "confirmed", slot: SLOT + 1, err: null }] };
    if (method === "getTransaction") return null;
    const keys = params[0] as string[];
    if (chain.landed && method === "getMultipleAccounts" && keys.length === 2 && keys[0] === f.cashAta && keys[1] === f.wsolAta) {
      return { context: { slot: SLOT + 2 }, value: [rpcAccount(token(SOLANA_USDG_MINT, f.vault, 50_000_000n + BigInt(submission!.minOutAmount)), TOKEN_2022_PROGRAM),
        rpcAccount(token(SOLANA_WRAPPED_SOL_MINT, f.vault, 1_000_000_000n - BigInt(submission!.intent.amountRaw)), SOLANA_CLASSIC_TOKEN_PROGRAM)] };
    }
    return f.read(method, params);
  };
  const transport: SolanaLiveRpc = { read: fn => fn(read), readEach: async fn => [await fn(read), await fn(read)], send: async () => "sent" };
  const app = f.runtime({}, transport), lines: string[] = [];
  const placed = await app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "settling-sell") });
  assert.ok("status" in placed && placed.status === "pending");
  // Landed, confirmed but not finalized: the vault holds 0.1 SOL less than the book until both providers' receipts book the sale.
  chain.landed = true;
  const status = await app.status(f.scope);
  assert.ok(status.live.blockers.includes("A live trade is awaiting final confirmation."), status.live.blockers.join(" | "));
  assert.ok(!status.live.blockers.includes(SOLANA_STATUS_BELOW_BOOK), "its own landing is not tokens leaving outside Merrymen");
  assert.equal(status.live.canExit, false, "trading and exits still wait for it");
  // The worker's next tick holds the account for its pending trade and pages no operator to reconcile the book.
  f.clock.now += 31_000;
  await f.agent(app, line => lines.push(line)).tick();
  assert.deepEqual(lines.filter(line => /vault-below-book/.test(line)), []);
  assert.equal((await f.submissions())[0]!.submission.signature, (await recorded())!.signature);
});

/** A runtime refusal with exactly this code and owner-facing text. */
const refusedAs = (message: string, code: SolanaAppRuntimeError["code"]) => (error: unknown) => {
  assert.ok(error instanceof SolanaAppRuntimeError, String(error)); assert.equal(error.message, message); assert.equal(error.code, code); return true;
};
const SWAP_BUILD = "https://api.jup.ag/swap/v1/swap-instructions";

test("live rollout: the autonomous worker places no live buy for a tenant off MERRYMEN_SOLANA_LIVE_TENANTS, nor does a manual buy, before any route is built; on the list the same tick buys", async t => {
  // 0.1 SOL ($15) and 50 USDG; the strategy wants 90% SOL, so it buys (and the position it leaves can still be sold today).
  const f = await fixture(t, { cash: 50_000_000n, wsol: 100_000_000n, mark: "fair", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 9000 },
    env: { MERRYMEN_SOLANA_LIVE_TENANTS: "" } });
  assert.deepEqual((await f.agent().tick()).map(r => r.outcome), ["held"]);
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "10000000", "manual-off-list-buy") }), refusedAs(SOLANA_LIVE_PAUSED, "permission"));
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
  assert.ok(!f.net.urls.includes(SWAP_BUILD), "no route was built, so nothing could be signed");
  // The same account on the list, on both services (the web has served a Solana request with it): the worker's next tick buys.
  f.clock.now += 61_000;
  await f.runtime({ MERRYMEN_SOLANA_LIVE_TENANTS: TENANT }).publishLiveRollout();
  assert.deepEqual((await f.agent(f.runtime({ MERRYMEN_SOLANA_LIVE_TENANTS: TENANT }, undefined, undefined, "worker")).tick()).map(r => r.outcome), ["submitted"]);
  const [row] = await f.submissions();
  assert.equal(row!.submission.intent.inputMint, SOLANA_USDG_MINT, "a buy"); assert.equal(f.sends.length, 1);
});

test("live rollout: a tenant taken off the list mid-session is exits-only: buys stop and status says so, while its sales back to USDG, manual and autonomous, are signed, admitted and sent", async t => {
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 2500 } });
  assert.equal((await f.app.status(f.scope)).live.ready, true, "on the list it trades");
  const off = f.runtime({ MERRYMEN_SOLANA_LIVE_TENANTS: `0x${"22".repeat(20)}` });
  const status = await off.status(f.scope);
  assert.deepEqual(status.live.blockers, [SOLANA_LIVE_PAUSED]); assert.equal(status.live.ready, false); assert.equal(status.live.canExit, true);
  assert.equal(status.liveAccess.onList, false);
  await assert.rejects(off.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "10000000", "paused-buy") }), refusedAs(SOLANA_LIVE_PAUSED, "permission"));
  // The strategy wants 25% SOL: the worker sells, and the sale is admitted and sent.
  assert.deepEqual((await f.agent(off).tick()).map(r => r.outcome), ["submitted"]);
  const [sale] = await f.submissions();
  assert.equal(sale!.submission.intent.inputMint, SOLANA_WRAPPED_SOL_MINT, "a sale back to USDG"); assert.equal(f.sends.length, 1);
  // A manual sale too, in a fresh account off the list.
  const g = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, env: { MERRYMEN_SOLANA_LIVE_TENANTS: "" } });
  const sold = await g.app.trade(g.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "exit-off-list") });
  assert.ok("status" in sold && sold.status === "pending"); assert.equal(g.sends.length, 1);
});

test("live rollout caps: under a permission registered above caps lowered since, buys are refused before anything is signed and the worker holds them; sales carry on", async t => {
  // The registered permission allows 25 and 100 USDG, 0.2 and 1 SOL; the caps are lowered to the defaults (10 and 25 USDG, 0.1 and 0.25 SOL).
  const lowered = { MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG: "", MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "", MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL: "", MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: "" };
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 9000 }, env: lowered });
  const status = await f.app.status(f.scope);
  assert.deepEqual(status.live.blockers, [solanaLiveSessionAboveCaps(SOLANA_LIVE_CAP_DEFAULTS)]); assert.equal(status.live.canExit, true);
  assert.deepEqual(status.liveAccess.caps, SOLANA_LIVE_CAP_DEFAULTS);
  assert.deepEqual((await f.agent().tick()).map(r => r.outcome), ["held"], "the worker buys nothing");
  // A manual buy within every cap is still refused: the session it would be signed under allows more.
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "5000000", "buy-above-caps") }),
    refusedAs(solanaLiveSessionAboveCaps(SOLANA_LIVE_CAP_DEFAULTS), "permission"));
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0, "nothing signed or sent");
  // A sale under the same permission (0.15 SOL, 22.5 USDG: above the 0.1 SOL and 10 USDG caps, within what the owner signed) is admitted and sent.
  const sold = await f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "150000000", "exit-above-caps") });
  assert.ok("status" in sold && sold.status === "pending"); assert.equal(f.sends.length, 1);
});

test("live rollout caps: a permission whose registered limits are above caps lowered since refuses a live buy and its preview before any quote, from the session record; sales still quote and sell", async t => {
  const lowered = { MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG: "", MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "", MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL: "", MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: "" };
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, env: lowered });
  // The record as activateLive now leaves it: with the limits it checked against the vault (25 and 100 USDG, 0.2 and 1 SOL).
  const record = JSON.parse((await f.db.prepare("SELECT record_json FROM solana_runtime_sessions WHERE tenant=?").get(TENANT) as { record_json: string }).record_json);
  await f.db.prepare("UPDATE solana_runtime_sessions SET record_json=? WHERE tenant=?").run(JSON.stringify({ ...record,
    limits: { perTradeUsdg: limits.perTradeUsdg, dailyUsdg: limits.dailyUsdg, perTradeWsol: limits.perTradeWsol, dailyWsol: limits.dailyWsol } }), TENANT);
  let quotes = 0;
  const counted = { readMint: f.market.readMint, quote: async (i: Parameters<typeof f.market.quote>[0]) => { quotes++; return f.market.quote(i); } };
  const app = createSolanaAppRuntime({ db: f.db, rpc: f.rpc, market: counted, env: f.env, now: () => f.clock.now });
  const reads = () => f.net.urls.length;
  const before = reads();
  await assert.rejects(app.preview(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "5000000", "preview-above-caps") }), refusedAs(solanaLiveSessionAboveCaps(SOLANA_LIVE_CAP_DEFAULTS), "permission"));
  await assert.rejects(app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "5000000", "buy-above-caps") }), refusedAs(solanaLiveSessionAboveCaps(SOLANA_LIVE_CAP_DEFAULTS), "permission"));
  assert.equal(quotes, 0, "no quote for the preview"); assert.equal(reads(), before, "no Jupiter quote or route for the trade");
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
  // A sale is previewed and sold under the same permission.
  assert.ok((await app.preview(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "preview-exit") })).quote); assert.equal(quotes, 1);
  const sold = await app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "exit-above-caps") });
  assert.ok("status" in sold && sold.status === "pending"); assert.equal(f.sends.length, 1);
});

test("live rollout caps: one provider showing the session's limits within lowered caps cannot let a buy under a permission above them through; every provider's limits are read before signing", async t => {
  const lowered = { MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG: "", MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "", MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL: "", MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: "" };
  // 0.1 SOL held, so the buy keeps room to sell its position; the session record has no limits (registered before they were kept).
  const f = await fixture(t, { cash: 50_000_000n, wsol: 100_000_000n, mark: "fair", build: { kind: "fair" }, env: lowered });
  // The primary serves the vault with limits at the default caps (10 and 25 USDG, 0.1 and 0.25 SOL); the fallback, honestly, with the signed ones.
  const within = (read: SolanaLiveRead): SolanaLiveRead => async (method, params = []) => {
    const result = await read(method, params) as { value?: unknown } | null;
    const patch = (account: unknown) => {
      const data = (account as { data?: [string, string] } | null)?.data;
      if (!data || Buffer.from(data[0], "base64").length !== SOLANA_VAULT_ACCOUNT_SIZE) return account;
      const b = Buffer.from(data[0], "base64");
      for (const [offset, value] of [[98, 10_000_000n], [106, 25_000_000n], [114, 100_000_000n], [122, 250_000_000n]] as const) b.writeBigUInt64LE(value, offset);
      return { ...(account as object), data: [b.toString("base64"), "base64"] };
    };
    if (method === "getAccountInfo" && params[0] === f.vault && result?.value) return { ...result, value: patch(result.value) };
    if (method === "getMultipleAccounts" && Array.isArray(result?.value)) return { ...result, value: (result!.value as unknown[]).map(patch) };
    return result;
  };
  await assert.rejects(f.runtime({}, split(f, within)).trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "5000000", "buy-under-a-liar") }),
    refusedAs(solanaLiveSessionAboveCaps(SOLANA_LIVE_CAP_DEFAULTS), "permission"));
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
});

test("live rollout: a renewal that landed after the tenant left the list is activated off it, and its sales back to USDG are then admitted and sent", async t => {
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, env: { MERRYMEN_SOLANA_LIVE_TENANTS: "" } });
  // The app still holds the permission the renewal replaced (epoch 0). Solana holds the renewal (epoch 1): same limits, prepared,
  // submitted and finalized while the tenant was listed, and not yet activated when it was taken off.
  const session = await getAddressFromPublicKey(f.sessionKeys.publicKey), sessionSeed = Buffer.alloc(32, 22);
  const replaced = { programId: PROGRAM, vault: f.vault, session, sessionEpoch: "0", registrationSignature: key(43), registeredAtMs: NOW - 20_000 };
  await f.db.prepare("UPDATE solana_runtime_sessions SET record_json=?,sealed_seed=? WHERE tenant=? AND owner=?").run(JSON.stringify(replaced),
    sealSecret(`solana-session/v1 ${TENANT} ${f.scope.owner} ${PROGRAM} ${f.vault} ${session} 0\n` + sessionSeed.toString("base64"), Buffer.alloc(32, 30)), TENANT, f.scope.owner);
  const renewal = { kind: "session", transactionBase64: "AA==", messageBase64: "AA==", blockhash: key(42), lastValidBlockHeight: "5000", programId: PROGRAM, vault: f.vault, session,
    limits, preparedAtMs: NOW - 10_000, expiresAtMs: NOW - 9_000, signature: key(44), signedTransactionBase64: "AA==", status: "finalized",
    priorVaultExisted: true, priorSequence: "0", priorSessionEpoch: "0" };
  await f.db.prepare("INSERT INTO solana_runtime_setups(tenant,owner,setup_json) VALUES(?,?,?)").run(TENANT, f.scope.owner, JSON.stringify(renewal));
  const before = await f.app.status(f.scope);
  assert.ok(before.live.blockers.includes("Register an owner-approved live trading permission."), before.live.blockers.join(" | "));
  assert.equal(before.live.canExit, false);
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "exit-before-activation") }));
  assert.equal(f.sends.length, 0, "nothing sent under the replaced permission");
  // Activated off the list: the owner signed it while listed, and without it nothing could be sold.
  assert.equal((await f.app.activateLive(f.scope, { signature: key(44), sessionSecretKey: sessionSeed.toString("base64") })).registered, true);
  const after = await f.app.status(f.scope);
  assert.deepEqual(after.live.blockers, [SOLANA_LIVE_PAUSED]); assert.equal(after.live.canExit, true);
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "10000000", "renewed-buy") }), refusedAs(SOLANA_LIVE_PAUSED, "permission"));
  const sold = await f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "exit-after-activation") });
  assert.ok("status" in sold && sold.status === "pending"); assert.equal(f.sends.length, 1);
  const [row] = await f.submissions();
  assert.equal(row!.submission.intent.inputMint, SOLANA_WRAPPED_SOL_MINT); assert.equal(row!.submission.sessionEpoch, "1", "signed under the renewal");
});

/** A live trade admitted `agoMs` before NOW, as admission records it, with the USDG notional it was charged and what it sold or spent. */
async function windowRow(f: Awaited<ReturnType<typeof fixture>>, requestId: string, status: string, agoMs: number, inputMint: string, amountRaw: string, notionalRaw: string) {
  await f.db.prepare(`INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(TENANT, f.scope.owner, requestId, f.vault, requestId, `sig-${requestId}`, status, NOW - agoMs, notionalRaw,
    JSON.stringify({ intent: { requestId, inputMint, amountRaw }, signature: `sig-${requestId}` }));
}

test("sales count against the rolling USDG limit as buys do: after a day of buys at it, status says no trade, exits included, is admitted and points to Withdraw, as admission refuses the sale", async t => {
  // The fixture's limits (and caps): 25 USDG per trade, 100 USDG a day. The strategy wants 25% SOL, so it would sell.
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 2500 } });
  for (let i = 0; i < 4; i++) await windowRow(f, `buy-${i}`, "finalized", 3_600_000 - i, SOLANA_USDG_MINT, "25000000", "25000000");
  const status = await f.app.status(f.scope);
  assert.deepEqual(status.live.blockers, [SOLANA_STATUS_DAILY_USDG_USED]); assert.equal(status.live.ready, false); assert.equal(status.live.canExit, false);
  assert.match(SOLANA_STATUS_DAILY_USDG_USED, /Sales back to USDG count against it as buys do.*Withdraw works at any time\.$/);
  // What admission does: the sale is refused before anything is sent, and the worker holds instead of trying it.
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "exit-after-buys") }), /The Solana rolling daily limit would be exceeded\./);
  assert.deepEqual((await f.agent().tick()).map(r => r.outcome), ["held"]);
  assert.equal(f.sends.length, 0);
  // Under 1 USDG left is the same: no trade of at least the live minimum fits.
  await f.db.prepare("UPDATE solana_runtime_submissions SET notional_raw='24000001' WHERE request_id='buy-0'").run();
  assert.deepEqual((await f.app.status(f.scope)).live.blockers, [SOLANA_STATUS_DAILY_USDG_USED]);
  // Once a buy is released (failed) there is room again for exits: the same sale is admitted and sent. Buying still waits: the 1 SOL
  // held ($150) is more than the 25 USDG left can sell today (THE POSITION ABOVE ITS EXIT ROOM), which never stops a sale. With the
  // 3% tolerance it is more than even a whole day's 100 USDG can sell, so the warning says selling it all takes more than one window.
  await f.db.prepare("UPDATE solana_runtime_submissions SET status='failed' WHERE request_id='buy-0'").run();
  const released = await f.app.status(f.scope);
  assert.deepEqual(released.live.blockers, [SOLANA_STATUS_POSITION_ABOVE_EXIT_ROOM]); assert.equal(released.live.canExit, true);
  assert.ok(released.live.warnings.includes(SOLANA_STATUS_EXIT_OVER_SEVERAL_WINDOWS)); assert.ok(!released.live.warnings.includes(SOLANA_STATUS_EXIT_OVER_NEXT_WINDOW));
  const sold = await f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "exit-with-room") });
  assert.ok("status" in sold && sold.status === "pending"); assert.equal(f.sends.length, 1);
});

test("under 1 USDG left of the day's USDG limit stops only buys while a sale of the whole position still fits it: status says so, the page may still sell, the whole position is sold, and the worker waits instead of a partial sale", async t => {
  // 99.50 of the 100 USDG used in the window; the book holds 0.002 SOL ($0.30) and no USDG. The strategy wants 25% SOL, so it would sell part.
  const f = await fixture(t, { cash: 0n, wsol: 2_000_000n, mark: "fair", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 2500, tradeUsdgRaw: "1000000" } });
  for (let i = 0; i < 4; i++) await windowRow(f, `buy-${i}`, "finalized", 3_600_000 - i, SOLANA_USDG_MINT, i ? "25000000" : "24500000", i ? "25000000" : "24500000");
  const status = await f.app.status(f.scope);
  assert.deepEqual(status.live.blockers, [SOLANA_STATUS_DAILY_USDG_BUYS_USED]); assert.equal(status.live.ready, false); assert.equal(status.live.canExit, true);
  assert.equal(f.pythReads.length > 0, true, "the position was priced");
  // The worker plans a partial sale, which admission would refuse after a paid route: it waits instead.
  assert.deepEqual((await f.agent().tick()).map(r => r.outcome), ["held"]);
  assert.ok(!f.net.urls.includes(SWAP_BUILD), "no route was built"); assert.equal(f.sends.length, 0);
  // The owner sells the whole position: admitted and sent.
  const sold = await f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "2000000", "whole-exit") });
  assert.ok("status" in sold && sold.status === "pending"); assert.equal(f.sends.length, 1);
  // Nothing held: only buys are stopped, and no price is read for it.
  const empty = await fixture(t, { cash: 50_000_000n, wsol: 0n, mark: "fair", build: { kind: "fair" } });
  for (let i = 0; i < 4; i++) await windowRow(empty, `buy-${i}`, "finalized", 3_600_000 - i, SOLANA_USDG_MINT, i ? "25000000" : "24500000", i ? "25000000" : "24500000");
  assert.deepEqual((await empty.app.status(empty.scope)).live.blockers, [SOLANA_STATUS_DAILY_USDG_BUYS_USED]);
  // A position worth more than the room left, or one that cannot be priced, is the blocker of exits too: no sale would be admitted.
  const big = await fixture(t, { cash: 50_000_000n, wsol: 10_000_000n, mark: "fair", build: { kind: "fair" } });
  for (let i = 0; i < 4; i++) await windowRow(big, `buy-${i}`, "finalized", 3_600_000 - i, SOLANA_USDG_MINT, i ? "25000000" : "24500000", i ? "25000000" : "24500000");
  const blocked = await big.app.status(big.scope);
  assert.deepEqual(blocked.live.blockers, [SOLANA_STATUS_DAILY_USDG_USED], "0.01 SOL is $1.50, more than the $0.50 left"); assert.equal(blocked.live.canExit, false);
  await assert.rejects(big.app.trade(big.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "10000000", "whole-too-big") }), /rolling daily limit would be exceeded/);
  const unpriced = await fixture(t, { cash: 50_000_000n, wsol: 2_000_000n, mark: "fair", build: { kind: "fair" }, pythAgeMs: 180_000 });
  for (let i = 0; i < 4; i++) await windowRow(unpriced, `buy-${i}`, "finalized", 3_600_000 - i, SOLANA_USDG_MINT, i ? "25000000" : "24500000", i ? "25000000" : "24500000");
  assert.ok((await unpriced.app.status(unpriced.scope)).live.blockers.includes(SOLANA_STATUS_DAILY_USDG_USED), "a stale price: not shown as sellable");
});

test("a day's SOL sold limit used by sales is a status warning pointing to Withdraw, as admission refuses the next sale; the position it leaves unsellable today holds buys, which the exit reserve refuses", async t => {
  // The fixture's limits: 0.2 SOL sold per trade, 1 SOL a day. Five sales of 0.2 SOL in the last 24 hours (charged 1 USDG each here).
  const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" } });
  for (let i = 0; i < 5; i++) await windowRow(f, `sale-${i}`, "finalized", 7_200_000 - i, SOLANA_WRAPPED_SOL_MINT, "200000000", "1000000");
  const status = await f.app.status(f.scope);
  assert.ok(status.live.warnings.includes(SOLANA_STATUS_DAILY_SOL_SOLD_USED), JSON.stringify(status.live.warnings));
  // The 1 SOL held cannot be sold today either: buying waits (no price needed, and no buy in the window to price), exits stay open in status.
  assert.deepEqual(status.live.blockers, [SOLANA_STATUS_POSITION_ABOVE_EXIT_ROOM]); assert.equal(status.live.ready, false); assert.equal(status.live.canExit, true);
  assert.ok(status.live.warnings.includes(SOLANA_STATUS_EXIT_OVER_NEXT_WINDOW)); assert.deepEqual(f.pythReads, []);
  assert.ok(!status.live.warnings.includes(SOLANA_STATUS_EXIT_OVER_SEVERAL_WINDOWS), "1 SOL fits a whole day's 1 SOL sold limit");
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "1000000", "buy-over-sol") }),
    (error: unknown) => error instanceof SolanaTradingStoreError && error.message === SOLANA_LIVE_EXIT_RESERVE);
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "sale-over-sol") }), /rolling daily SOL sell limit would be exceeded/);
  assert.equal(f.sends.length, 0);
  // Failed sales are released: no warning.
  await f.db.prepare("UPDATE solana_runtime_submissions SET status='failed' WHERE request_id='sale-0'").run();
  assert.ok(!(await f.app.status(f.scope)).live.warnings.includes(SOLANA_STATUS_DAILY_SOL_SOLD_USED));
});

test("exits keep room: a live buy that would leave the whole position unsellable inside the rolling window is refused before anything is signed, at the highest price any provider serves; one that fits is sent", async t => {
  // 25 USDG and 0.2 SOL per trade, 100 USDG and 1 SOL a day, $150 a SOL. 52 USDG of buys in the window; 0.15 SOL ($22.50) held.
  const fresh = async () => {
    const f = await fixture(t, { cash: 50_000_000n, wsol: 150_000_000n, mark: "fair", build: { kind: "fair" } });
    for (const [i, usdg] of ["25000000", "25000000", "2000000"].entries()) await windowRow(f, `buy-${i}`, "finalized", 3_600_000 - i, SOLANA_USDG_MINT, usdg, usdg);
    return f;
  };
  const exitReserve = (error: unknown) => error instanceof SolanaTradingStoreError && error.message === SOLANA_LIVE_EXIT_RESERVE;
  const placedAs = async (f: Awaited<ReturnType<typeof fixture>>, id: string) => (await f.submissions()).filter(row => row.request_id === id);
  // 25 USDG more may leave $48.25 of SOL to sell (what it brings counted with the 3% fill margin) after 77 used: 77 + 49.70 > 100.
  const f = await fresh();
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "buy-too-much") }), exitReserve);
  assert.deepEqual(await placedAs(f, "buy-too-much"), []); assert.equal(f.sends.length, 0, "nothing signed or sent");
  // 12 USDG fits at $150 (64 + 35.91), but not where one provider serves $170 (64 + 40.69): the higher value is kept, and
  // refused before anything is signed (admission, at the buy's own $150 reference, would have taken it).
  const g = await fresh();
  await assert.rejects(g.runtime({}, split(g, undefined, pythAt(17_000_000_000n))).trade(g.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "12000000", "buy-high") }), exitReserve);
  assert.deepEqual(await placedAs(g, "buy-high"), []); assert.equal(g.sends.length, 0);
  const placed = await g.app.trade(g.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "12000000", "buy-that-fits") });
  assert.ok("status" in placed && placed.status === "pending"); assert.equal(g.sends.length, 1);
  assert.equal((await placedAs(g, "buy-that-fits")).length, 1);
});

test("exits keep room, counting what a buy brings with the fill margin before anything is signed: a buy that would fit only were its fill no better than its quote is refused by assessRisk and never reaches admission", async t => {
  // As above: 52 USDG of buys in the window, 0.15 SOL ($22.50) held, $150 a SOL. 12.1 USDG brings 0.080667 SOL by its quote:
  // 64.1 + 35.64 would fit, but counted 3% better (0.083087 SOL) it is 64.1 + 36.01 > 100.
  const f = await fixture(t, { cash: 50_000_000n, wsol: 150_000_000n, mark: "fair", build: { kind: "fair" } });
  for (const [i, usdg] of ["25000000", "25000000", "2000000"].entries()) await windowRow(f, `buy-${i}`, "finalized", 3_600_000 - i, SOLANA_USDG_MINT, usdg, usdg);
  const admissions = t.mock.method(SolanaTradingStore.prototype, "recordSigned");
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "12100000", "buy-over-margin") }),
    (error: unknown) => error instanceof SolanaTradingStoreError && error.message === SOLANA_LIVE_EXIT_RESERVE);
  assert.equal(admissions.mock.callCount(), 0, "refused before anything was signed"); assert.equal(f.sends.length, 0);
  // 12 USDG fits with the margin (64 + 35.91), and is sent.
  const placed = await f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "12000000", "buy-within-margin") });
  assert.ok("status" in placed && placed.status === "pending"); assert.equal(admissions.mock.callCount(), 1); assert.equal(f.sends.length, 1);
});

test("the fill margin exceeded: after a buy that filled further above its quote, the booked position is more than the day's limits can sell; status holds buys and warns that the rest exits over the next window, the worker buys nothing, a manual buy is refused before anything is signed, and sales go through", async t => {
  // 25 USDG and 0.2 SOL per trade, 100 USDG and 1 SOL a day, $150 a SOL. A 25 USDG buy in the window filled well above its quote,
  // and was booked as it landed: 0.55 SOL ($82.50) held, and 25 + 84.98 USDG is more than the 100 a day. The strategy wants 90% SOL.
  const f = await fixture(t, { cash: 50_000_000n, wsol: 550_000_000n, mark: "fair", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 9000 } });
  await windowRow(f, "big-fill", "finalized", 3_600_000, SOLANA_USDG_MINT, "25000000", "25000000");
  const status = await f.app.status(f.scope);
  assert.deepEqual(status.live.blockers, [SOLANA_STATUS_POSITION_ABOVE_EXIT_ROOM]); assert.equal(status.live.ready, false); assert.equal(status.live.canExit, true);
  assert.ok(status.live.warnings.includes(SOLANA_STATUS_EXIT_OVER_NEXT_WINDOW), JSON.stringify(status.live.warnings));
  assert.ok(!status.live.warnings.includes(SOLANA_STATUS_EXIT_OVER_SEVERAL_WINDOWS), "$84.98 fits a whole day's 100 USDG");
  assert.ok(f.pythReads.length > 0, "priced after a buy in the window");
  // The worker holds its buy: no route is built.
  assert.deepEqual((await f.agent().tick()).map(r => r.outcome), ["held"]);
  assert.ok(!f.net.urls.includes(SWAP_BUILD)); assert.deepEqual((await f.submissions()).map(row => row.request_id), ["big-fill"]);
  // A manual buy, however small, is refused by the exit reserve before anything is signed.
  const admissions = t.mock.method(SolanaTradingStore.prototype, "recordSigned");
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "1000000", "buy-after-big-fill") }),
    (error: unknown) => error instanceof SolanaTradingStoreError && error.message === SOLANA_LIVE_EXIT_RESERVE);
  assert.equal(admissions.mock.callCount(), 0); assert.equal(f.sends.length, 0);
  // A sale goes through, within the per-trade limits: 0.15 SOL ($22.50).
  const sold = await f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "150000000", "exit-after-big-fill") });
  assert.ok("status" in sold && sold.status === "pending"); assert.equal(admissions.mock.callCount(), 1); assert.equal(f.sends.length, 1);
  // Once the buy leaves the window the position fits a day's limits again (the warning's next window): the hold and the warning go.
  const later = await fixture(t, { cash: 50_000_000n, wsol: 550_000_000n, mark: "fair", build: { kind: "fair" } });
  await windowRow(later, "big-fill", "finalized", 86_400_001, SOLANA_USDG_MINT, "25000000", "25000000");
  const after = await later.app.status(later.scope);
  assert.deepEqual(after.live.blockers, []); assert.ok(!after.live.warnings.includes(SOLANA_STATUS_EXIT_OVER_NEXT_WINDOW));
  assert.deepEqual(later.pythReads, [], "with no buy in the window, status reads no price for it");
});

test("exits keep room: after the most buys the window admits, the worker buys nothing (no route built), a manual buy is refused, and the whole position is sold back to USDG", async t => {
  // 75 USDG of buys in the window and 0.15 SOL ($22.50) held: 75 + 23.18 kept for its exit leaves no room for even a 1 USDG buy.
  const f = await fixture(t, { cash: 50_000_000n, wsol: 150_000_000n, mark: "fair", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 9000 } });
  for (let i = 0; i < 3; i++) await windowRow(f, `buy-${i}`, "finalized", 3_600_000 - i, SOLANA_USDG_MINT, "25000000", "25000000");
  assert.deepEqual((await f.app.status(f.scope)).live.blockers, [], "a sale fits, and only the buy's own check knows what the position is worth");
  assert.deepEqual((await f.agent().tick()).map(r => r.outcome), ["held"], "sized below the live minimum by the room left: in band");
  assert.ok(!f.net.urls.includes(SWAP_BUILD), "no route was built for a buy that could not be admitted");
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "1000000", "one-more") }),
    (error: unknown) => error instanceof SolanaTradingStoreError && error.message === SOLANA_LIVE_EXIT_RESERVE);
  assert.equal(f.sends.length, 0);
  // The whole position, in one sale within the per-trade limits: 75 + 22.50 fits the day's 100 USDG.
  const sold = await f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "150000000", "whole-exit") });
  assert.ok("status" in sold && sold.status === "pending"); assert.equal(f.sends.length, 1);
});

test("live rollout: the worker publishes its settings with its heartbeat; once the web serves different ones (a tenant removed on the web only), its next tick holds the buy, and matching ones let it buy", async t => {
  // 0.1 SOL ($15) and 50 USDG; the strategy wants 90% SOL, so it buys (and the position it leaves can still be sold today).
  const f = await fixture(t, { cash: 50_000_000n, wsol: 100_000_000n, mark: "fair", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 9000 } });
  // The worker's own runtime as runSolanaAgent builds it (solanaWorkerRuntime), on this chain and clock.
  const worker = solanaWorkerRuntime({ db: f.db, rpc: f.rpc, market: f.market, env: f.env, now: () => f.clock.now, log: () => {}, localTestDeployment: true });
  // The web was redeployed without this tenant; the worker was not. The owner's page reads status from the web.
  assert.deepEqual((await f.runtime({ MERRYMEN_SOLANA_LIVE_TENANTS: "" }, undefined, () => {}).status(f.scope)).live.blockers, [SOLANA_LIVE_PAUSED]);
  assert.deepEqual((await f.agent(worker).tick()).map(r => r.outcome), ["held"], "the worker no longer buys under its old list");
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
  assert.ok(!f.net.urls.includes(SWAP_BUILD), "no route was built");
  // The tick published the worker's settings with its heartbeat: a web that lists another tenant as well sees them differ.
  assert.deepEqual((await f.db.prepare("SELECT service FROM solana_runtime_live_rollout_seen ORDER BY service").all() as Array<{ service: string }>).map(r => r.service),
    ["web", "worker"], "the worker's digest under its own name, beside the web's");
  assert.deepEqual((await f.runtime({ MERRYMEN_SOLANA_LIVE_TENANTS: `${TENANT},0x${"22".repeat(20)}` }, undefined, () => {}).status(f.scope)).live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]);
  // Both on the same settings again: the next tick buys.
  f.clock.now += 61_000;
  assert.deepEqual((await f.runtime({}, undefined, () => {}).status(f.scope)).live.blockers, []);
  assert.deepEqual((await f.agent(worker).tick()).map(r => r.outcome), ["submitted"]);
  const [row] = await f.submissions();
  assert.equal(row!.submission.intent.inputMint, SOLANA_USDG_MINT, "a buy"); assert.equal(f.sends.length, 1);
  // A worker with nothing to trade publishes too, with its heartbeat alone: the web judges any worker that is running.
  const idle = await fixture(t, { cash: 50_000_000n, wsol: 0n, mark: "fair", build: { kind: "fair" } });
  assert.deepEqual(await idle.agent(solanaWorkerRuntime({ db: idle.db, rpc: idle.rpc, market: idle.market, env: idle.env, now: () => idle.clock.now, log: () => {},
    localTestDeployment: true })).tick(), []);
  assert.ok(await idle.db.prepare("SELECT 1 FROM solana_runtime_live_rollout_seen WHERE service='worker'").get(), "published with the heartbeat");
  assert.deepEqual((await idle.runtime({ MERRYMEN_SOLANA_LIVE_TENANTS: `${TENANT},0x${"33".repeat(20)}` }, undefined, () => {}).status(idle.scope)).live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]);
});

test("live rollout: on a fresh deployment, before the web has published any digest, the worker's tick builds no route for a buy yet still sells, and buys once the web publishes the same settings", async t => {
  // 0.1 SOL ($15) and 50 USDG; the strategy wants 90% SOL, so it buys. No web digest at all: the web has served no Solana request yet.
  const f = await fixture(t, { cash: 50_000_000n, wsol: 100_000_000n, mark: "fair", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 9000 } });
  const lines: string[] = [];
  const worker = f.runtime({}, undefined, line => lines.push(line), "worker");
  assert.deepEqual((await f.agent(worker).tick()).map(r => r.outcome), ["held"]);
  assert.deepEqual(await f.submissions(), []); assert.equal(f.sends.length, 0);
  assert.ok(!f.net.urls.includes(SWAP_BUILD), "no route was built for a buy the worker holds");
  assert.equal(lines.filter(line => line.startsWith("[alert] solana-live-rollout differs: the web has not published")).length, 1);
  // The web serves its first Solana request on the same settings: the worker's next tick buys.
  assert.deepEqual((await f.app.status(f.scope)).live.blockers, []);
  f.clock.now += 61_000;
  assert.deepEqual((await f.agent(worker).tick()).map(r => r.outcome), ["submitted"]);
  const [row] = await f.submissions();
  assert.equal(row!.submission.intent.inputMint, SOLANA_USDG_MINT, "a buy"); assert.equal(f.sends.length, 1);
  // A sale is never held: 1 SOL held, the strategy wants 25% SOL, and the worker sells with no web digest at all.
  const g = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 2500 } });
  assert.deepEqual((await g.agent(g.runtime({}, undefined, () => {}, "worker")).tick()).map(r => r.outcome), ["submitted"]);
  const [sale] = await g.submissions();
  assert.equal(sale!.submission.intent.inputMint, SOLANA_WRAPPED_SOL_MINT, "a sale back to USDG"); assert.equal(g.sends.length, 1);
  assert.equal(await g.db.prepare("SELECT 1 FROM solana_runtime_live_rollout_seen WHERE service='web'").get(), undefined, "still no web digest");
});

/** A provider that serves the vault with these session limits (raw: USDG per trade and per 24 hours, SOL sold per trade and per 24 hours). */
const vaultLimits = (f: Awaited<ReturnType<typeof fixture>>, held: { perTrade: bigint; daily: bigint; perTradeWsol: bigint; dailyWsol: bigint }) =>
  (read: SolanaLiveRead): SolanaLiveRead => async (method, params = []) => {
    const result = await read(method, params) as { value?: unknown } | null;
    const patch = (account: unknown) => {
      const data = (account as { data?: [string, string] } | null)?.data;
      if (!data || Buffer.from(data[0], "base64").length !== SOLANA_VAULT_ACCOUNT_SIZE) return account;
      const b = Buffer.from(data[0], "base64");
      for (const [offset, value] of [[98, held.perTrade], [106, held.daily], [114, held.perTradeWsol], [122, held.dailyWsol]] as const) b.writeBigUInt64LE(value, offset);
      return { ...(account as object), data: [b.toString("base64"), "base64"] };
    };
    if (method === "getAccountInfo" && params[0] === f.vault && result?.value) return { ...result, value: patch(result.value) };
    if (method === "getMultipleAccounts" && Array.isArray(result?.value)) return { ...result, value: (result!.value as unknown[]).map(patch) };
    return result;
  };

test("exits keep room within the limits the vault enforces: saved live limits above the registered permission (the caps raised and the limits saved again) do not let a buy use room the vault will not give the exit", async t => {
  const exitReserve = (error: unknown) => error instanceof SolanaTradingStoreError && error.message === SOLANA_LIVE_EXIT_RESERVE;
  const placedAs = async (f: Awaited<ReturnType<typeof fixture>>, id: string) => (await f.submissions()).filter(row => row.request_id === id);
  // USDG: the caps raised to 200 USDG a day and the limits saved at it, under the permission registered at 100 a day (the vault's).
  // 20 USDG of buys in the window and 0.2 SOL ($30) held: a 25 USDG buy keeps room for its exit within 200 (20 + 25 + 56.65), not within 100.
  const usdg = async () => {
    const f = await fixture(t, { cash: 50_000_000n, wsol: 200_000_000n, mark: "fair", build: { kind: "fair" }, env: { MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "200" } });
    await windowRow(f, "earlier-buy", "finalized", 3_600_000, SOLANA_USDG_MINT, "20000000", "20000000");
    await f.bindings.settings(TENANT, f.scope.owner, (await f.bindings.get(TENANT))!.revision, "live", { ...limits, dailyUsdg: "200000000" });
    return f;
  };
  const f = await usdg();
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "buy-past-the-vault") }), exitReserve);
  assert.deepEqual(await placedAs(f, "buy-past-the-vault"), []); assert.equal(f.sends.length, 0, "nothing signed or sent");
  // One that keeps room within the vault's 100 (20 + 20 + 51.5) is sent.
  const placed = await f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "20000000", "buy-within-the-vault") });
  assert.ok("status" in placed && placed.status === "pending"); assert.equal(f.sends.length, 1);
  // The same 25 USDG buy where the vault itself allows the saved 200 a day: it fits, and is sent.
  const g = await usdg();
  const roomy = vaultLimits(g, { perTrade: 25_000_000n, daily: 200_000_000n, perTradeWsol: 200_000_000n, dailyWsol: 1_000_000_000n });
  const sent = await g.runtime({}, split(g, roomy, roomy)).trade(g.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "buy-past-the-vault") });
  assert.ok("status" in sent && sent.status === "pending"); assert.equal(g.sends.length, 1);
  // One provider showing the vault's lower limit is enough to refuse it.
  const h = await usdg();
  await assert.rejects(h.runtime({}, split(h, roomy)).trade(h.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "buy-past-one-provider") }), exitReserve);
  assert.equal(h.sends.length, 0);
  // SOL sold: the caps raised to 2 SOL a day and the limits saved at it, under the permission registered at 1 SOL a day (the vault's).
  // 0.9 SOL held: a 25 USDG buy brings 0.1667 SOL, which 2 SOL a day could sell and 1 SOL a day could not.
  const k = await fixture(t, { cash: 50_000_000n, wsol: 900_000_000n, mark: "fair", build: { kind: "fair" },
    env: { MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "1000", MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: "2" } });
  await k.bindings.settings(TENANT, k.scope.owner, (await k.bindings.get(TENANT))!.revision, "live", { ...limits, dailyUsdg: "1000000000", dailyWsol: "2000000000" });
  const soldUnderOne = vaultLimits(k, { perTrade: 25_000_000n, daily: 1_000_000_000n, perTradeWsol: 200_000_000n, dailyWsol: 1_000_000_000n });
  await assert.rejects(k.runtime({}, split(k, soldUnderOne, soldUnderOne)).trade(k.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "buy-past-sol") }), exitReserve);
  assert.deepEqual(await placedAs(k, "buy-past-sol"), []); assert.equal(k.sends.length, 0);
  // Where the vault allows the saved 2 SOL a day too, it is sent.
  const soldUnderTwo = vaultLimits(k, { perTrade: 25_000_000n, daily: 1_000_000_000n, perTradeWsol: 200_000_000n, dailyWsol: 2_000_000_000n });
  const bought = await k.runtime({}, split(k, soldUnderTwo, soldUnderTwo)).trade(k.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "25000000", "buy-within-sol") });
  assert.ok("status" in bought && bought.status === "pending"); assert.equal(k.sends.length, 1);
});

test("the position above its exit room is judged within the registered permission's limits, as the vault holds them and as activateLive kept them, where they are below the saved ones", async t => {
  // The caps raised to 200 USDG a day and the limits saved at it. 20 USDG bought in the window and 0.6 SOL ($90) held: 20 + 92.70 fits 200, not 100.
  const f = await fixture(t, { cash: 50_000_000n, wsol: 600_000_000n, mark: "fair", build: { kind: "fair" }, env: { MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "200" } });
  await windowRow(f, "earlier-buy", "finalized", 3_600_000, SOLANA_USDG_MINT, "20000000", "20000000");
  await f.bindings.settings(TENANT, f.scope.owner, (await f.bindings.get(TENANT))!.revision, "live", { ...limits, dailyUsdg: "200000000" });
  // The vault holds the permission registered at 100 a day (the fixture's): buying waits.
  assert.deepEqual((await f.app.status(f.scope)).live.blockers, [SOLANA_STATUS_POSITION_ABOVE_EXIT_ROOM]);
  // Where the vault allows the saved 200 a day: nothing is held.
  const roomy = vaultLimits(f, { perTrade: 25_000_000n, daily: 200_000_000n, perTradeWsol: 200_000_000n, dailyWsol: 1_000_000_000n });
  assert.deepEqual((await f.runtime({}, split(f, roomy, roomy)).status(f.scope)).live.blockers, []);
  // Unless the limits activateLive kept for that permission say 100 a day.
  const record = JSON.parse((await f.db.prepare("SELECT record_json FROM solana_runtime_sessions WHERE tenant=?").get(TENANT) as { record_json: string }).record_json);
  await f.db.prepare("UPDATE solana_runtime_sessions SET record_json=? WHERE tenant=?").run(JSON.stringify({ ...record,
    limits: { perTradeUsdg: "25000000", dailyUsdg: "100000000", perTradeWsol: "200000000", dailyWsol: "1000000000" } }), TENANT);
  assert.deepEqual((await f.runtime({}, split(f, roomy, roomy)).status(f.scope)).live.blockers, [SOLANA_STATUS_POSITION_ABOVE_EXIT_ROOM]);
});

test("the position above its exit room is priced as the exit reserve prices it: at the highest price any provider serves, plus the configured reference tolerance", async t => {
  // 25 USDG bought in the window, 100 USDG a day. 0.45 SOL held fits at $150 (25 + 67.50 + 3% = 94.53) but not where one
  // provider serves $170 (25 + 76.50 + 3% = 103.80): the higher value holds buys, as assessRisk would refuse them.
  const f = await fixture(t, { cash: 50_000_000n, wsol: 450_000_000n, mark: "fair", build: { kind: "fair" } });
  await windowRow(f, "earlier-buy", "finalized", 3_600_000, SOLANA_USDG_MINT, "25000000", "25000000");
  assert.deepEqual((await f.app.status(f.scope)).live.blockers, [], "fits at $150 from both providers");
  for (const via of [split(f, undefined, pythAt(17_000_000_000n)), split(f, pythAt(17_000_000_000n))]) {
    const status = await f.runtime({}, via).status(f.scope);
    assert.deepEqual(status.live.blockers, [SOLANA_STATUS_POSITION_ABOVE_EXIT_ROOM]); assert.equal(status.live.canExit, true);
  }
  await assert.rejects(f.runtime({}, split(f, undefined, pythAt(17_000_000_000n))).trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "1000000", "buy-at-170") }),
    (error: unknown) => error instanceof SolanaTradingStoreError && error.message === SOLANA_LIVE_EXIT_RESERVE);
  // 0.49 SOL ($73.50) fits only were the tolerance ignored (25 + 73.50 = 98.50; 25 + 75.71 with the default 300 bps is over 100).
  const g = await fixture(t, { cash: 50_000_000n, wsol: 490_000_000n, mark: "fair", build: { kind: "fair" } });
  await windowRow(g, "earlier-buy", "finalized", 3_600_000, SOLANA_USDG_MINT, "25000000", "25000000");
  assert.deepEqual((await g.app.status(g.scope)).live.blockers, [SOLANA_STATUS_POSITION_ABOVE_EXIT_ROOM]);
  // The configured tolerance, not a fixed one: at 200 bps it fits (25 + 74.97).
  assert.deepEqual((await g.runtime({ MERRYMEN_SOLANA_REFERENCE_TOLERANCE_BPS: "200" }).status(g.scope)).live.blockers, []);
});

test("daily limits lowered below the position hold buys with a warning that names lowered limits among the causes and says selling it all takes more than one window; a sale within them goes through", async t => {
  // 0.2 SOL held ($30) and no trade in the window; the owner saves 0.1 SOL sold per trade and per 24 hours (the vault's permission
  // allows 1 SOL). A price rise or a fill cannot be the cause: no buy is in the window, and the SOL sold room needs no price.
  const f = await fixture(t, { cash: 50_000_000n, wsol: 200_000_000n, mark: "fair", build: { kind: "fair" } });
  assert.deepEqual((await f.app.status(f.scope)).live.blockers, []);
  await f.bindings.settings(TENANT, f.scope.owner, (await f.bindings.get(TENANT))!.revision, "live", { ...limits, perTradeWsol: "100000000", dailyWsol: "100000000" });
  const status = await f.app.status(f.scope);
  assert.deepEqual(status.live.blockers, [SOLANA_STATUS_POSITION_ABOVE_EXIT_ROOM]); assert.equal(status.live.canExit, true);
  assert.ok(status.live.warnings.includes(SOLANA_STATUS_EXIT_OVER_SEVERAL_WINDOWS), JSON.stringify(status.live.warnings));
  assert.ok(!status.live.warnings.includes(SOLANA_STATUS_EXIT_OVER_NEXT_WINDOW)); assert.deepEqual(f.pythReads, []);
  for (const warning of [SOLANA_STATUS_EXIT_OVER_SEVERAL_WINDOWS, SOLANA_STATUS_EXIT_OVER_NEXT_WINDOW]) assert.match(warning, /the daily limits are lowered/);
  // A sale within the lowered limits is admitted and sent: 0.1 SOL now, the rest in a later window.
  const sold = await f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "exit-under-lowered") });
  assert.ok("status" in sold && sold.status === "pending"); assert.equal(f.sends.length, 1);
});

test("the position above its exit room is priced only while a buy that still counts is in the window: a failed or expired buy, released, reads no price and holds nothing", async t => {
  // 0.7 SOL held ($105, more than the 100 USDG a day with the 3% tolerance) and the only buys in the window failed or expired.
  const f = await fixture(t, { cash: 50_000_000n, wsol: 700_000_000n, mark: "fair", build: { kind: "fair" } });
  await windowRow(f, "failed-buy", "failed", 3_600_000, SOLANA_USDG_MINT, "25000000", "25000000");
  await windowRow(f, "expired-buy", "expired", 3_500_000, SOLANA_USDG_MINT, "25000000", "25000000");
  const status = await f.app.status(f.scope);
  assert.deepEqual(status.live.blockers, []); assert.deepEqual(f.pythReads, [], "no price was read for it");
  // Had the failed buy landed, it would count: priced, and buys held.
  await f.db.prepare("UPDATE solana_runtime_submissions SET status='finalized' WHERE request_id='failed-buy'").run();
  assert.deepEqual((await f.app.status(f.scope)).live.blockers, [SOLANA_STATUS_POSITION_ABOVE_EXIT_ROOM]); assert.ok(f.pythReads.length > 0);
});

test("live rollout caps: on the list, an account whose permission is registered above caps lowered since may save its live limits up to what it signed, so a re-save never narrows its exits; buys stay refused", async t => {
  // The registered permission allows 25 and 100 USDG, 0.2 and 1 SOL (kept as activateLive keeps it); the caps are lowered to the defaults.
  const lowered = { MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_USDG: "", MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "", MERRYMEN_SOLANA_LIVE_MAX_PER_TRADE_WSOL: "", MERRYMEN_SOLANA_LIVE_MAX_DAILY_WSOL: "" };
  // 0.4 SOL ($60) held: one day of the signed limits can sell it beside the 30 USDG used below.
  const f = await fixture(t, { cash: 50_000_000n, wsol: 400_000_000n, mark: "fair", build: { kind: "fair" }, env: lowered });
  const signed = { perTradeUsdg: limits.perTradeUsdg, dailyUsdg: limits.dailyUsdg, perTradeWsol: limits.perTradeWsol, dailyWsol: limits.dailyWsol };
  const keep = async (kept: Record<string, string>) => {
    const record = JSON.parse((await f.db.prepare("SELECT record_json FROM solana_runtime_sessions WHERE tenant=?").get(TENANT) as { record_json: string }).record_json);
    await f.db.prepare("UPDATE solana_runtime_sessions SET record_json=? WHERE tenant=?").run(JSON.stringify({ ...record, limits: kept }), TENANT);
  };
  await keep(signed);
  const save = async (saved: typeof limits) => {
    await f.app.checkLiveSettings(f.scope, saved);
    await f.bindings.settings(TENANT, f.scope.owner, (await f.bindings.get(TENANT))!.revision, "live", saved);
  };
  // 30 USDG of earlier trades in the window.
  await windowRow(f, "earlier", "finalized", 3_600_000, SOLANA_USDG_MINT, "30000000", "30000000");
  // A re-save at the caps (where the page starts live limits) narrows the exits: 30 of 25 USDG used, no sale is admitted.
  const capped = { ...limits, perTradeUsdg: "10000000", dailyUsdg: "25000000", perTradeWsol: "100000000", dailyWsol: "250000000" };
  await save(capped);
  const narrowed = await f.app.status(f.scope);
  assert.ok(narrowed.live.blockers.includes(SOLANA_STATUS_DAILY_USDG_USED), narrowed.live.blockers.join(" | ")); assert.equal(narrowed.live.canExit, false);
  // The limits it signed may be saved again on the list, as off it: its exits are back.
  await save(limits);
  const restored = await f.app.status(f.scope);
  assert.deepEqual(restored.live.blockers, [solanaLiveSessionAboveCaps(SOLANA_LIVE_CAP_DEFAULTS)]); assert.equal(restored.live.canExit, true);
  const sold = await f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "50000000", "exit-after-resave") });
  assert.ok("status" in sold && sold.status === "pending"); assert.equal(f.sends.length, 1);
  // Never beyond what it signed where that is above the caps, nor beyond the caps where they allow more.
  for (const over of [{ ...limits, dailyUsdg: "100000001" }, { ...limits, dailyWsol: "1000000001" }]) {
    await assert.rejects(f.app.checkLiveSettings(f.scope, over), refusedAs(solanaLiveExitLimitsRefusal(over, signed, "above-caps")!, "permission"), JSON.stringify(over));
  }
  assert.match(solanaLiveExitLimitsRefusal({ ...limits, dailyUsdg: "100000001" }, signed, "above-caps")!, /^Your registered live permission allows more than this platform's live caps, so your live limits may be at most the caps or, where it allows more, that permission: at most 25 USDG per trade, 100 USDG per 24 hours, 0\.2 SOL sold per trade and 1 SOL sold per 24 hours\. Lower them and save again\. Nothing was saved\.$/);
  // Its buys stay refused, before any quote.
  await assert.rejects(f.app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "5000000", "buy-after-resave") }), refusedAs(solanaLiveSessionAboveCaps(SOLANA_LIVE_CAP_DEFAULTS), "permission"));
  // A permission within the caps (a new one registered): the caps alone bound a save again, in their own words.
  await keep({ perTradeUsdg: "10000000", dailyUsdg: "25000000", perTradeWsol: "100000000", dailyWsol: "250000000" });
  await assert.rejects(f.app.checkLiveSettings(f.scope, limits), refusedAs(solanaLiveCapRefusal(limits, SOLANA_LIVE_CAP_DEFAULTS, "save")!, "permission"));
  await f.app.checkLiveSettings(f.scope, capped);
});

/** `db`, refusing every statement on the live rollout digests (SQLite busy past its timeout, a PostgreSQL write error); the schema still runs. */
function refusingDigest(db: Db): Db {
  const fail = async (): Promise<never> => { throw new Error("digest statement refused"); };
  const wrap = (inner: Db): Db => ({
    prepare: sql => sql.includes("solana_runtime_live_rollout_seen") ? { run: fail, get: fail, all: fail } : inner.prepare(sql),
    exec: sql => inner.exec(sql),
    tx: fn => inner.tx(tx => fn(wrap(tx))),
  });
  return wrap(db);
}

for (const dialect of ["sqlite", "postgres"] as const) {
  test(`${dialect}: a rollout digest that cannot be written or read holds only buys: status still resolves, live and paper alike, with exits open, a sale is signed and sent, and the operator is told once a minute`, dialectOptions(dialect), async t => {
    const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, dialect });
    assert.equal((await f.app.status(f.scope)).live.ready, true, "ready while the digests can be read");
    const lines: string[] = [], unchecked = () => lines.filter(line => line.startsWith("[alert] solana-live-rollout unchecked: ")).length;
    const app = createSolanaAppRuntime({ db: refusingDigest(f.db), rpc: f.rpc, market: f.market, env: f.env, now: () => f.clock.now, log: line => lines.push(line) });
    const status = await app.status(f.scope);
    assert.deepEqual(status.live.blockers, [SOLANA_LIVE_ROLLOUT_DIFFERS]); assert.equal(status.live.canExit, true); assert.equal(status.live.ready, false);
    // A buy is refused (the check it needs cannot be made) before any route; a sale back to USDG never asks, and is signed and sent.
    await assert.rejects(app.trade(f.scope, { mode: "live", intent: manual(SOLANA_USDG_MINT, "10000000", "buy-unchecked") }), /digest statement refused/);
    assert.ok(!f.net.urls.includes(SWAP_BUILD), "no route was built for the buy");
    const sold = await app.trade(f.scope, { mode: "live", intent: manual(SOLANA_WRAPPED_SOL_MINT, "100000000", "exit-unchecked") });
    assert.ok("status" in sold && sold.status === "pending"); assert.equal(f.sends.length, 1);
    assert.equal(unchecked(), 1, "said once");
    assert.ok(!lines.some(line => line.includes(TENANT) || line.includes("digest statement refused")), "no tenant, no database text");
    // A paper account's status, which reads no chain, resolves too.
    const paperOwner = key(56), paperTenant = `0x${"44".repeat(20)}`;
    await f.bindings.bind(paperTenant as `0x${string}`, "did:privy:paper", paperOwner);
    const paper = await app.status({ tenant: paperTenant, owner: paperOwner });
    assert.equal(paper.requestedMode, "paper"); assert.ok(!paper.live.blockers.includes(SOLANA_LIVE_ROLLOUT_DIFFERS));
    assert.equal(unchecked(), 1, "once a minute per process");
    f.clock.now += 60_000; await app.status(f.scope);
    assert.equal(unchecked(), 2, "said again after a minute");
  });
}

for (const dialect of ["sqlite", "postgres"] as const) {
  test(`${dialect}: a worker whose rollout digest publish fails keeps beating, recovering receipts and selling: only buys wait, and the operator is told`, dialectOptions(dialect), async t => {
    const worker = (f: Awaited<ReturnType<typeof fixture>>, lines: string[]) => {
      // The worker's runtime on a database that refuses the digest statements; the agent's own reads and heartbeat still work.
      const runtime = createSolanaAppRuntime({ db: refusingDigest(f.db), rpc: f.rpc, market: f.market, env: f.env, now: () => f.clock.now, service: "worker", log: () => {} });
      const calls = { status: 0 };
      const spied = { ...runtime, status: async (...args: Parameters<typeof runtime.status>) => { calls.status++; return runtime.status(...args); } };
      return { agent: f.agent(spied as typeof runtime, line => lines.push(line)), calls };
    };
    const unpublished = (lines: string[]) => lines.filter(line => line.startsWith("[alert] solana-live-rollout unpublished: ")).length;
    // A trade awaiting its receipt: the tick still reaches receipt recovery, which reads it through status.
    const f = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 2500 }, dialect });
    await windowRow(f, "awaiting-receipt", "pending", 10_000, SOLANA_WRAPPED_SOL_MINT, "100000000", "15000000");
    const lines: string[] = [], recovering = worker(f, lines);
    assert.deepEqual((await recovering.agent.tick()).map(r => r.outcome), ["held"], "held by its own pending trade, as before");
    assert.ok(recovering.calls.status >= 1, "receipt recovery ran");
    const beat = await f.db.prepare("SELECT last_seen_at_ms FROM solana_runtime_worker_heartbeat WHERE worker='solana'").get() as { last_seen_at_ms: number | string };
    assert.equal(Number(beat.last_seen_at_ms), NOW, "the heartbeat was written");
    assert.equal(unpublished(lines), 1);
    assert.ok(!lines.some(line => line.includes(TENANT) || line.includes("digest statement refused")), "no tenant, no database text");
    f.clock.now += 61_000; await recovering.agent.tick();
    assert.equal(unpublished(lines), 1, "not repeated within ten minutes");
    // With nothing pending, the strategy's sale back to USDG is signed and sent.
    const g = await fixture(t, { cash: 50_000_000n, wsol: 1_000_000_000n, mark: "fair", build: { kind: "fair" }, strategy: { ...rebalance, targetSolBps: 2500 }, dialect });
    const selling = worker(g, lines);
    assert.deepEqual((await selling.agent.tick()).map(r => r.outcome), ["submitted"]);
    const [sale] = await g.submissions();
    assert.equal(sale!.submission.intent.inputMint, SOLANA_WRAPPED_SOL_MINT, "a sale back to USDG"); assert.equal(g.sends.length, 1);
  });
}
