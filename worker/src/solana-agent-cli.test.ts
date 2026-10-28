/**
 * The Solana worker's forced stop against the trading store's crash recovery.
 *
 * A real worker process (this file, run as a child) trades a paper account in
 * a SQLite file with the real store and runtime and the real stop handling,
 * and is forced to exit with process.exit mid-tick: inside the paper fill's
 * database transaction, or right after it committed. A restarted worker on the
 * same file must find either no fill or exactly the one fill, and never fill
 * the same attempt twice. No network: the market and the RPC are fakes.
 *
 * Live: the real executor signs a swap and the real trading store journals it,
 * and the worker is forced out while the send of those bytes is in flight. A
 * restarted worker must rebroadcast exactly the journaled bytes and never sign
 * or submit another transaction, under that request ID or any other.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { deriveSolanaAta, deriveSolanaSwapAuthority, deriveSolanaVaultAddress, SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_VAULT_ACCOUNT_SIZE,
  SOLANA_VAULT_DISCRIMINATOR, SOLANA_VAULT_LOCAL_TEST_PROGRAM, SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { createSolanaAgent } from "./solana-agent";
import { installSolanaWorkerStop, SOLANA_WORKER_REPEAT_MS } from "./solana-agent-cli";
import { createSolanaAppRuntime } from "./solana-app-runtime";
import { wrapSqlite, type Db } from "./db";
import { createSolanaExecutor, reconcileSolanaSubmission } from "./solana-executor";
import { JUPITER_SWAP_PROGRAM, type JupiterCpiRoute } from "./solana-live-market";
import type { SolanaLiveRead, SolanaLiveRpc } from "./solana-live-rpc";
import type { SolanaPaperMarket } from "./solana-paper-service";
import { pythBound } from "./solana-reference-price-fixture";
import { ensureSolanaTradingSchema, SolanaTradingStore, type SolanaAccountScope } from "./solana-trading-store";

const NOW = 1_000_000;
const TENANT = "0x1111111111111111111111111111111111111111", OWNER = "So11111111111111111111111111111111111111112";
const LIMITS = { perTradeUsdg: "10000000", dailyUsdg: "100000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 1_000_000 };
const STRATEGY = { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "5000000", intervalSeconds: 60 };
const INITIAL_CASH = 100_000_000n;
// Settings revision 2 (the limits, then the strategy), first attempt: the request ID the strategy's first fill uses.
const REQUEST = "rebalance-2-0";
const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
type Point = "in-commit" | "after-commit" | "live-send";

const market: SolanaPaperMarket = {
  readMint: async (mint) => ({ address: mint, program: mint === SOLANA_USDG_MINT ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: 10, observedAtMs: NOW, buyBlockedReasons: [] }),
  quote: async (i) => ({ source: "jupiter", inputMint: i.inputMint, outputMint: i.outputMint, inAmount: i.amountRaw,
    outAmount: i.amountRaw, minOutAmount: (BigInt(i.amountRaw) * 995n / 1000n).toString(), slippageBps: i.slippageBps,
    contextSlot: 10, quotedAtMs: NOW, expiresAtMs: NOW + 30_000 }),
};
const rpc = { read: async () => { throw new Error("No live RPC in a paper worker"); }, send: async () => { throw new Error("Must never send"); } };

function open(file: string): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(file);
  // The worker's own settings (solana-runtime-db.ts).
  raw.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
  return { raw, db: wrapSqlite(raw) };
}
const runtimeFor = (db: Db) => createSolanaAppRuntime({ db, env: {}, market, rpc, now: () => NOW });

/** Every statement whose SQL matches `pattern` waits for `pause` first, also inside transactions. */
function hooked(db: Db, pattern: RegExp, pause: () => Promise<void>): Db {
  const wrap = (inner: Db): Db => ({
    prepare(sql) {
      const statement = inner.prepare(sql);
      if (!pattern.test(sql)) return statement;
      return { ...statement, run: async (...params) => { await pause(); return statement.run(...params); } };
    },
    exec: (sql) => inner.exec(sql),
    tx: (fn) => inner.tx((scoped) => fn(wrap(scoped))),
  });
  return wrap(db);
}

// Live: the executor test's fake chain, reduced to what one USDG -> SOL buy and its reconciliation read.
const LIVE_SLOT = 1000, LIVE_CASH = 1_000_000_000n, LIVE_PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM;
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111", SYSTEM = "11111111111111111111111111111111";
const liveKey = (n: number) => getBase58Decoder().decode(new Uint8Array(32).fill(n));
const keyBytes = (value: string) => Buffer.from(getBase58Encoder().encode(value));
const LIVE_OWNER = liveKey(20);
const LIVE_LIMITS = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 3_600_000,
  perTradeWsol: "50000000", dailyWsol: "120000000" };
// The strategy's buy is exactly the route's 1 USDG.
const LIVE_STRATEGY = { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "1000000", intervalSeconds: 60 };
const SESSION_SEED = new Uint8Array(32).fill(11), FEE_PAYER_SEED = new Uint8Array(32).fill(12), DEK = Buffer.alloc(32, 3);
// The deployed binary declares its own program ID (its 32 bytes appear in it), as a real build of the vault does:
// the executor refuses a binary that does not (verifySolanaVaultDeployment's requireDeclaredProgramId).
const BINARY = Buffer.concat([Buffer.from("audited-vault-test-binary"), keyBytes(LIVE_PROGRAM)]);
const digest = (wire: string) => createHash("sha256").update(wire).digest("hex");

function tokenAccount(mint: string, owner: string, amount: bigint): Buffer {
  const bytes = Buffer.alloc(165); keyBytes(mint).copy(bytes, 0); keyBytes(owner).copy(bytes, 32);
  bytes.writeBigUInt64LE(amount, 64); bytes[108] = 1; return bytes;
}
function rpcAccount(data: Buffer, owner: string, executable = false, lamports = 100_000_000) {
  return { owner, executable, lamports, data: [data.toString("base64"), "base64"], space: data.length };
}
function vaultState(owner: string, session: string, seq: bigint): Buffer {
  const bytes = Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE); Buffer.from(SOLANA_VAULT_DISCRIMINATOR).copy(bytes);
  let offset = 8; bytes[offset++] = 2; bytes[offset++] = 255;
  for (const value of [owner, session]) { keyBytes(value).copy(bytes, offset); offset += 32; }
  for (const value of [1n, seq, 10_000n, 100_000_000n, LIVE_CASH, 5_000_000_000n, 50_000_000_000n]) { bytes.writeBigUInt64LE(value, offset); offset += 8; }
  bytes.writeUInt16LE(96, offset); return bytes;
}
async function liveIdentity() {
  const sessionKeyPair = await createKeyPairFromPrivateKeyBytes(SESSION_SEED), feePayerKeyPair = await createKeyPairFromPrivateKeyBytes(FEE_PAYER_SEED);
  const session = await getAddressFromPublicKey(sessionKeyPair.publicKey), vault = await deriveSolanaVaultAddress(LIVE_PROGRAM, LIVE_OWNER);
  return { sessionKeyPair, feePayerKeyPair, session, vault };
}

/**
 * The live worker's runtime: the real executor journaling into the real
 * trading store, as solana-app-runtime.ts wires them (Jupiter's route and the
 * Pyth check are fakes), and a status that reconciles pending trades first.
 * `blockhash` differs per process, so bytes signed again would differ.
 */
async function liveRuntime(db: Db, blockhash: string, send: SolanaLiveRpc["send"], reads: string[] = []) {
  const { sessionKeyPair, feePayerKeyPair, session, vault } = await liveIdentity();
  const input = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
  const output = await deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  const swap = await deriveSolanaSwapAuthority(LIVE_PROGRAM, vault, 0n);
  const temp = await deriveSolanaAta(swap, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM);
  const programDataAddress = liveKey(31);
  const program = Buffer.alloc(36); program.writeUInt32LE(2); keyBytes(programDataAddress).copy(program, 4);
  const programData = Buffer.alloc(45 + BINARY.length); programData.writeUInt32LE(3); BINARY.copy(programData, 45);
  const response = (value: unknown, slot = LIVE_SLOT) => ({ context: { slot }, value });
  const read: SolanaLiveRead = async (method, params = []) => {
    reads.push(method);
    switch (method) {
      case "getSlot": return LIVE_SLOT;
      case "getAccountInfo": {
        const [key, config] = params as [string, { dataSlice?: { offset: number; length: number } }];
        if (key === LIVE_PROGRAM) return response(rpcAccount(program, LOADER, true));
        if (key === programDataAddress) {
          const slice = config.dataSlice!;
          return response({ ...rpcAccount(programData.subarray(slice.offset, slice.offset + slice.length), LOADER), space: programData.length });
        }
        // The expiry proof's finalized vault: its sequence has not moved.
        if (key === vault) return response(rpcAccount(vaultState(LIVE_OWNER, session, 0n), LIVE_PROGRAM), LIVE_SLOT + 2);
        throw new Error("Unexpected live fixture account");
      }
      case "getMultipleAccounts": {
        const keys = params[0] as string[];
        if (keys[0] === vault) return response([rpcAccount(vaultState(LIVE_OWNER, session, 0n), LIVE_PROGRAM),
          rpcAccount(tokenAccount(SOLANA_USDG_MINT, vault, LIVE_CASH), TOKEN_2022_PROGRAM),
          rpcAccount(tokenAccount(SOLANA_WRAPPED_SOL_MINT, vault, 0n), SOLANA_CLASSIC_TOKEN_PROGRAM), rpcAccount(Buffer.alloc(0), SYSTEM)]);
        if (keys.length === 2 && keys[0] === temp) return response([null, null]);
        return response(keys.map(value => value === output ? rpcAccount(tokenAccount(SOLANA_WRAPPED_SOL_MINT, vault, 0n), SOLANA_CLASSIC_TOKEN_PROGRAM) : null));
      }
      case "getMinimumBalanceForRentExemption": return 2_039_280;
      case "getLatestBlockhash": return response({ blockhash, lastValidBlockHeight: 1200 });
      case "getFeeForMessage": return response(10_000);
      case "getRecentPrioritizationFees": return [];
      case "simulateTransaction": return response({ err: null, unitsConsumed: 200_000, accounts: [rpcAccount(vaultState(LIVE_OWNER, session, 1n), LIVE_PROGRAM),
        rpcAccount(tokenAccount(SOLANA_USDG_MINT, vault, LIVE_CASH - 1_000_000n), TOKEN_2022_PROGRAM),
        rpcAccount(tokenAccount(SOLANA_WRAPPED_SOL_MINT, vault, 2_000_000n), SOLANA_CLASSIC_TOKEN_PROGRAM), rpcAccount(Buffer.alloc(0), SYSTEM, false, 99_990_000)] });
      // Neither provider has seen the signature, and its blockhash can still land.
      case "getSignatureStatuses": return response([null]);
      case "getTransaction": return null;
      case "getEpochInfo": return { absoluteSlot: LIVE_SLOT + 2, blockHeight: 1199, epoch: 1, slotIndex: LIVE_SLOT + 2, slotsInEpoch: 432_000 };
      default: throw new Error(`Unexpected live fixture method ${method}`);
    }
  };
  const rpc: SolanaLiveRpc = { read: operation => operation(read), readEach: async operation => [await operation(read), await operation(read)], send };
  const quote = { source: "jupiter" as const, inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT, inAmount: "1000000", outAmount: "2000000",
    minOutAmount: "1990000", slippageBps: 50, contextSlot: LIVE_SLOT, quotedAtMs: NOW, expiresAtMs: NOW + 30_000 };
  const data = Buffer.alloc(36); createHash("sha256").update("global:shared_accounts_route").digest().subarray(0, 8).copy(data);
  data.writeUInt32LE(1, 9); data[14] = 100; data[16] = 1;
  data.writeBigUInt64LE(1_000_000n, 17); data.writeBigUInt64LE(2_000_000n, 25); data.writeUInt16LE(50, 33);
  const route: JupiterCpiRoute = { quote, dataBase64: data.toString("base64"), lookupTableAddresses: [], accounts:
    [SOLANA_CLASSIC_TOKEN_PROGRAM, liveKey(40), swap, temp, liveKey(41), liveKey(42), output, SOLANA_USDG_MINT, SOLANA_WRAPPED_SOL_MINT, JUPITER_SWAP_PROGRAM, TOKEN_2022_PROGRAM]
      .map((address, index) => ({ address, isSigner: index === 2, isWritable: [3, 4, 5, 6].includes(index) })) };
  const store = (scope: SolanaAccountScope, admission?: { autonomousRevision: number; signal?: AbortSignal }) => new SolanaTradingStore(db, scope, () => NOW, admission);
  const runtime = {
    async status(scope: SolanaAccountScope) {
      const s = store(scope);
      for (const pending of await s.pending()) await reconcileSolanaSubmission(rpc, s, scope.owner, pending.submission.intent.requestId, () => NOW);
      const balances = { cashUsdg: LIVE_CASH.toString(), wsolRaw: "0" };
      return { paper: null, live: { balances, tradable: balances, pending: await s.pending(), ready: true, canExit: true } };
    },
    async trade(scope: SolanaAccountScope, request: { mode: "paper" | "live"; intent: unknown; autonomousRevision?: number; signal?: AbortSignal }) {
      const journal = store(scope, request.autonomousRevision === undefined ? undefined : { autonomousRevision: request.autonomousRevision, signal: request.signal });
      const executor = createSolanaExecutor({ programId: LIVE_PROGRAM, programBinarySha256: createHash("sha256").update(BINARY).digest("hex"),
        sessionKeyPair, feePayerKeyPair, rpc, now: () => NOW, maxFeeLamports: "3000000", journal, signal: request.signal,
        market: {
          readMint: async mint => ({ address: mint, program: mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM,
            decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: LIVE_SLOT, observedAtMs: NOW, buyBlockedReasons: [] }),
          build: async () => structuredClone(route),
        },
        assessRisk: async ({ intent }) => ({ observedAtMs: NOW, slot: LIVE_SLOT, notionalUsdg: "1000000", equityUsdg: LIVE_CASH.toString(),
          peakEquityUsdg: LIVE_CASH.toString(), cashUsdg: LIVE_CASH.toString(), wsolRaw: "0", reference: pythBound(intent, NOW, 50_000_000_000n, LIVE_SLOT) }),
      });
      return executor.execute({ ...(request.intent as object), mode: "live", owner: scope.owner, vault });
    },
  };
  return runtime as unknown as Parameters<typeof createSolanaAgent>[0]["runtime"];
}

async function seedLive(file: string): Promise<void> {
  const { raw, db } = open(file);
  try {
    const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW);
    await bindings.bind(TENANT, "did:privy:crash-live", LIVE_OWNER);
    await bindings.settings(TENANT, LIVE_OWNER, 0, "live", LIVE_LIMITS);
    await ensureSolanaTradingSchema(db);
    // An owner-approved, registered session, as activateLive leaves it.
    const { session, vault } = await liveIdentity();
    const store = new SolanaTradingStore(db, { tenant: TENANT, owner: LIVE_OWNER }, () => NOW);
    const prepared = { kind: "session" as const, transactionBase64: "dGVzdA==", messageBase64: "dGVzdA==", blockhash: liveKey(30), lastValidBlockHeight: "1200",
      programId: LIVE_PROGRAM, vault, session, limits: LIVE_LIMITS, preparedAtMs: NOW, expiresAtMs: NOW + 30_000 };
    await store.saveSetup(prepared);
    await store.saveSetup({ ...prepared, signature: "owner-registration", signedTransactionBase64: "c2lnbmVk", status: "pending" } as typeof prepared);
    await store.finishSetup("owner-registration", "finalized");
    await store.registerSession({ programId: LIVE_PROGRAM, vault, session, sessionEpoch: "1", registrationSignature: "owner-registration", registeredAtMs: NOW },
      Buffer.from(SESSION_SEED).toString("base64"), DEK);
    await bindings.strategy(TENANT, LIVE_OWNER, 1, LIVE_STRATEGY);
  } finally { raw.close(); }
}

async function liveJournal(db: Db) {
  const rows = await db.prepare("SELECT request_id,status,submission_json FROM solana_runtime_submissions WHERE tenant=? AND owner=?").all(TENANT, LIVE_OWNER) as
    Array<{ request_id: string; status: string; submission_json: string }>;
  const attempts = await db.prepare("SELECT request_id FROM solana_runtime_autonomous_attempts WHERE tenant=? AND owner=?").all(TENANT, LIVE_OWNER) as Array<{ request_id: string }>;
  return { submissions: rows.map((row) => ({ requestId: row.request_id, status: row.status,
    wire: digest((JSON.parse(row.submission_json) as { signedTransactionBase64: string }).signedTransactionBase64) })), attempts: attempts.map((row) => row.request_id) };
}

/** The worker process: one tick that stops at `point` until a signal ends it. */
async function crashChild(point: Point, file: string): Promise<void> {
  const { db: base } = open(file);
  const pause = (detail = "") => {
    process.stdout.write(`paused ${point}${detail}\n`);
    setInterval(() => {}, 1_000);
    return new Promise<void>(() => {});
  };
  const db = point === "in-commit" ? hooked(base, /^UPDATE solana_runtime_paper_books SET book_json/, pause) : base;
  const actual = runtimeFor(db);
  // live-send: the executor's send of the signed bytes never returns.
  const runtime = point === "live-send" ? await liveRuntime(db, liveKey(50), async (wire) => { await pause(` ${digest(wire)}`); return ""; })
    : point === "after-commit"
    ? { status: actual.status, trade: async (...args: Parameters<typeof actual.trade>) => { const receipt = await actual.trade(...args); await pause(); return receipt; } }
    : actual;
  const controller = new AbortController();
  // The worker's real stop handling, as solana-agent-cli.ts installs it.
  installSolanaWorkerStop(process, { abort: () => controller.abort(), exit: (code) => process.exit(code),
    write: (text) => { process.stderr.write(text); }, setTimer: (callback, ms) => setTimeout(callback, ms) });
  await createSolanaAgent({ db, runtime, market, now: () => NOW, signal: controller.signal }).tick();
  process.stdout.write("tick finished\n");
}

async function seed(file: string): Promise<void> {
  const { raw, db } = open(file);
  try {
    const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW);
    await bindings.bind(TENANT, "did:privy:crash", OWNER);
    await bindings.settings(TENANT, OWNER, 0, "paper", LIMITS);
    await runtimeFor(db).setupPaper({ tenant: TENANT, owner: OWNER }, { initialCashRaw: INITIAL_CASH.toString(), limits: LIMITS });
    await bindings.strategy(TENANT, OWNER, 1, STRATEGY);
  } finally { raw.close(); }
}

async function book(db: Db) {
  const paper = (await runtimeFor(db).status({ tenant: TENANT, owner: OWNER }, { liveReads: false })).paper!;
  const attempts = await db.prepare("SELECT request_id FROM solana_runtime_autonomous_attempts WHERE tenant=? AND owner=?").all(TENANT, OWNER) as Array<{ request_id: string }>;
  return { cash: BigInt(paper.cashRaw), trades: paper.trades.map((trade) => trade.requestId), attempts: attempts.map((row) => row.request_id),
    wsol: paper.positions.map((position) => position.amountRaw) };
}

const childPoint = process.env.MERRYMEN_SOLANA_CRASH_CHILD as Point | undefined;
if (childPoint) {
  await crashChild(childPoint, process.env.MERRYMEN_SOLANA_CRASH_DB!);
} else {
  for (const point of ["in-commit", "after-commit"] as const) {
    test(`a forced stop ${point === "in-commit" ? "inside a paper fill's transaction" : "right after a paper fill committed"} is recovered by a restart without a second fill`,
      { skip: process.platform === "win32", timeout: 90_000 }, async (t) => {
        const directory = mkdtempSync(path.join(tmpdir(), "solana-crash-"));
        t.after(() => rmSync(directory, { recursive: true, force: true }));
        const file = path.join(directory, "solana-accounts.sqlite");
        await seed(file);

        const child = spawn(process.execPath, ["--import", "tsx", THIS_FILE], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, MERRYMEN_SOLANA_CRASH_CHILD: point, MERRYMEN_SOLANA_CRASH_DB: file } });
        t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => { output += chunk; });
        const exited = once(child, "exit");
        for (const deadline = Date.now() + 60_000; !output.includes(`paused ${point}`);) {
          if (Date.now() > deadline || child.exitCode !== null) assert.fail(`the worker never reached ${point}:\n${output}`);
          await delay(50);
        }
        // One Ctrl+C delivered twice (the terminal's copy and a launcher's) asks for a graceful stop, which waits for the tick.
        const sentAt = performance.now();
        child.kill("SIGINT");
        await delay(50);
        child.kill("SIGINT");
        const gap = performance.now() - sentAt;
        await delay(SOLANA_WORKER_REPEAT_MS + 300);
        if (gap < SOLANA_WORKER_REPEAT_MS / 2) {
          assert.equal(child.exitCode, null, `one press must not force a stop mid-tick:\n${output}`);
          assert.match(output, /stopping after the current tick/);
        } else {
          // This process stalled between the copies, so they may have been two
          // presses and forced the stop already: still a forced exit mid-tick.
          t.diagnostic(`the two copies went out ${Math.round(gap)} ms apart: the duplicate check is inconclusive`);
        }
        // The second press forces it: process.exit with the transaction (or the tick) unfinished.
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGINT");
        const [code, signal] = await exited;
        assert.deepEqual([code, signal], [130, null], output);
        assert.match(output, /forced stop without waiting for the current tick/);
        assert.doesNotMatch(output, /tick finished/);

        // Restart: a new worker on the same file.
        const { raw, db } = open(file);
        try {
          const after = await book(db);
          if (point === "in-commit") {
            assert.deepEqual(after, { cash: INITIAL_CASH, trades: [], attempts: [], wsol: [] }, "the cut-short fill left nothing behind");
          } else {
            assert.deepEqual([after.trades, after.attempts], [[REQUEST], [REQUEST]], "the committed fill is durable");
          }
          const agent = createSolanaAgent({ db, runtime: runtimeFor(db), market, now: () => NOW, signal: new AbortController().signal });
          const outcomes = (await agent.tick()).map((result) => result.outcome);
          assert.deepEqual(outcomes, [point === "in-commit" ? "submitted" : "waiting"]);
          assert.deepEqual((await agent.tick()).map((result) => result.outcome), ["waiting"], "nothing more in the same interval");
          const final = await book(db);
          assert.deepEqual([final.trades, final.attempts], [[REQUEST], [REQUEST]], "exactly one fill for the attempt");
          assert.equal(final.cash, INITIAL_CASH - 5_000_000n, "the cash moved once");
          assert.equal(final.wsol.length, 1);
        } finally { raw.close(); }
      });
  }

  test("a forced stop while a live swap's signed bytes are being sent is recovered by rebroadcasting those bytes, never a new transaction",
    { skip: process.platform === "win32", timeout: 90_000 }, async (t) => {
      const directory = mkdtempSync(path.join(tmpdir(), "solana-crash-live-"));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const file = path.join(directory, "solana-accounts.sqlite");
      await seedLive(file);

      const child = spawn(process.execPath, ["--import", "tsx", THIS_FILE], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, MERRYMEN_SOLANA_CRASH_CHILD: "live-send", MERRYMEN_SOLANA_CRASH_DB: file } });
      t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      const exited = once(child, "exit");
      let sending: string | undefined;
      for (const deadline = Date.now() + 60_000; !(sending = /paused live-send ([0-9a-f]{64})/.exec(output)?.[1]);) {
        if (Date.now() > deadline || child.exitCode !== null) assert.fail(`the worker never sent a signed swap:\n${output}`);
        await delay(50);
      }
      // One press waits for the send; a second press forces the exit with the send in flight.
      child.kill("SIGINT");
      await delay(SOLANA_WORKER_REPEAT_MS + 300);
      assert.equal(child.exitCode, null, `one press must not force a stop mid-tick:\n${output}`);
      child.kill("SIGINT");
      const [code, signal] = await exited;
      assert.deepEqual([code, signal], [130, null], output);
      assert.match(output, /forced stop without waiting for the current tick/);
      assert.doesNotMatch(output, /tick finished/);

      const { raw, db } = open(file);
      try {
        // Journaled before the send: the exact bytes that were going out, pending, under the attempt's request ID.
        assert.deepEqual(await liveJournal(db), { submissions: [{ requestId: REQUEST, status: "pending", wire: sending }], attempts: [REQUEST] },
          "the signed bytes were durable before they were sent");
        // Restart: a new worker on the same file, whose chain would hand out a different blockhash.
        const resent: string[] = [], reads: string[] = [];
        const runtime = await liveRuntime(db, liveKey(51), async (wire) => { resent.push(digest(wire)); return ""; }, reads);
        const agent = createSolanaAgent({ db, runtime, market, now: () => NOW, signal: new AbortController().signal });
        for (let tick = 0; tick < 2; tick++) {
          assert.deepEqual((await agent.tick()).map((result) => result.outcome), ["waiting"], "the attempt is spent: nothing new in this interval");
        }
        assert.ok(resent.length >= 1, "the pending swap was rebroadcast");
        assert.deepEqual([...new Set(resent)], [sending], "only the journaled bytes, unchanged, are ever sent again");
        assert.equal(reads.filter((method) => ["getLatestBlockhash", "simulateTransaction", "getFeeForMessage"].includes(method)).length, 0, "nothing was signed again");
        assert.deepEqual(await liveJournal(db), { submissions: [{ requestId: REQUEST, status: "pending", wire: sending }], attempts: [REQUEST] },
          "no second submission under any request ID");
      } finally { raw.close(); }
    });
}

test("the Solana worker starts only with MERRYMEN_SOLANA=1: unset, it refuses before it opens any storage (review finalise)", async (t) => {
  const { solanaWorkerSwitchRefusal } = await import("./solana-agent-cli");
  assert.equal(solanaWorkerSwitchRefusal({ MERRYMEN_SOLANA: "1" }), null);
  assert.equal(solanaWorkerSwitchRefusal({ MERRYMEN_SOLANA: " 1\n" }), null);
  for (const value of [undefined, "", "0", "true", "yes"]) assert.match(solanaWorkerSwitchRefusal({ MERRYMEN_SOLANA: value })!, /MERRYMEN_SOLANA is not 1/, String(value));
  const home = mkdtempSync(path.join(tmpdir(), "solana-worker-off-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, MERRYMEN_HOME: home };
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./solana-agent-cli.ts", import.meta.url))],
    { cwd: fileURLToPath(new URL("../../", import.meta.url)), env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "exit") as [number | null];
  assert.equal(code, 78, stderr);
  assert.match(stderr, /\[solana-worker\] refused: MERRYMEN_SOLANA is not 1/);
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(path.join(home, "solana-accounts.sqlite")), false, "no Solana storage was opened");
});
