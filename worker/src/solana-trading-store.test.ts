import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction, setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash, type Blockhash } from "@solana/kit";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { base58Encode, CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_WRAPPED_SOL_MINT, SOLANA_VAULT_LOCAL_TEST_PROGRAM } from "../../packages/core/src/solana-live";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { makePgDb, wrapSqlite, type Db } from "./db";
import { ensureSolanaTradingSchema, SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE, solanaAutonomousSchedule, solanaExpiredAttemptAllowance, SolanaTradingStore,
  type SolanaPreparedSetup } from "./solana-trading-store";
import { SOLANA_REGISTERED_AFTER_REVOKE, SOLANA_REVOKE_ALREADY_LANDED, SOLANA_REVOKE_PREPARED_BESIDE, SOLANA_WITHDRAWAL_RECORDED_OUTSIDE, solanaOwnerEpochOffset, solanaPendingOwnerScopes,
  solanaPendingOwnerTransactions } from "./solana-trading-store";
import { SOLANA_SYSTEM_PROGRAM } from "../../packages/core/src/solana-live";
import { SOLANA_WITHDRAWAL_ABOVE_BOOK } from "./solana-trading-store";
import type { SolanaLiveSettlement, SolanaSignedSubmission } from "./solana-executor";
import { createSolanaPaperService } from "./solana-paper-service";
import { SolanaMarketError } from "./solana-market";
import { SolanaPaperStoreError, type SolanaPaperWriteOff } from "./solana-paper-store";
import { pythBound } from "./solana-reference-price-fixture";
import { releaseSolanaOperatorHold, setSolanaOperatorHold } from "./solana-operator-hold";
import type { SolanaLiveBook } from "./solana-trading-store";
import { ensureSolanaShortfallSchema } from "./solana-resolve-shortfall";
import { SOLANA_EXIT_RESERVE_FILL_MARGIN_BPS, SOLANA_LIVE_EXIT_RESERVE, solanaBuyFillBound, solanaExitReserveBuyRoom, solanaExitReserveUsdg, solanaRollingLimitUse } from "./solana-trading-store";
import { createSolanaAppRuntime, SOLANA_LIVE_ROLLOUT_DIFFERS } from "./solana-app-runtime";
import { createSolanaAgent, solanaWorkerRuntime } from "./solana-agent";

const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const TENANT = `0x${"11".repeat(20)}` as const, OTHER = `0x${"22".repeat(20)}` as const;
/** Code-unit order, so evidence ids sort the same under every database collation
 * (production Postgres compares text by en_US.UTF-8, which ignores punctuation first). */
const byEvidence = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const OWNER = key(20), VAULT = key(21), SESSION = key(22), PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM;
const NOW = 1_000_000, CASH = 100_000_000n;
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 3_600_000,
  perTradeWsol: "50000000", dailyWsol: "120000000" };
const dek = Buffer.alloc(32, 3), sessionSeed = Buffer.alloc(32, 4).toString("base64");
const strategy = { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "1000000", intervalSeconds: 60 };
function submission(id = "trade-1", seq = "0"): SolanaSignedSubmission {
  const quote = { source: "jupiter" as const, inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT,
    inAmount: "1000000", outAmount: "2000000", minOutAmount: "1980000", slippageBps: 100, contextSlot: 1000, quotedAtMs: NOW, expiresAtMs: NOW + 30000 };
  const intent = { kind: "spl-swap" as const, chain: CHAINS.solana, mode: "live" as const, requestId: id, owner: OWNER, vault: VAULT,
    inputMint: quote.inputMint, outputMint: quote.outputMint, amountRaw: quote.inAmount, slippageBps: 100 };
  return { version: 1, intent, programId: PROGRAM,
    session: SESSION, feePayer: key(23), sessionEpoch: "1", vaultSequence: seq, signature: `test-signature-${id}`,
    signedTransactionBase64: "dGVzdC1zaWduZWQ=", messageBase64: "dGVzdC1tZXNzYWdl", loadedAddresses: { writable: [], readonly: [] },
    recentBlockhash: key(24), lastValidBlockHeight: "1200", minContextSlot: 1000, minOutAmount: quote.minOutAmount,
    quotedOutAmount: quote.outAmount, inputTokenAccount: key(25), outputTokenAccount: key(26), inputTokenProgram: TOKEN_2022_PROGRAM,
    outputTokenProgram: SOLANA_CLASSIC_TOKEN_PROGRAM, inputBalanceBefore: CASH.toString(), outputBalanceBefore: "0", maxFeeLamports: "3000000",
    feeLamports: "10000", rentLamports: "2039280", preparedAtMs: NOW, safetyObservedAtMs: NOW, quote,
    risk: { observedAtMs: NOW, slot: 1000, notionalUsdg: "1000000", equityUsdg: CASH.toString(), peakEquityUsdg: CASH.toString(), cashUsdg: CASH.toString(), wsolRaw: "0",
      reference: pythBound(intent, NOW) } };
}
function settlement(s: SolanaSignedSubmission, status: "finalized" | "failed" = "finalized"): SolanaLiveSettlement {
  return { status, signature: s.signature, slot: 1001, feeLamports: "10000", amountIn: status === "failed" ? "0" : "600000",
    amountOut: status === "failed" ? "0" : "1980000", finalizedAtMs: NOW + 1 };
}
function expired(s: SolanaSignedSubmission): SolanaLiveSettlement {
  return { status: "expired", signature: s.signature, slot: 1001, feeLamports: null, amountIn: "0", amountOut: "0", finalizedAtMs: NOW + 1,
    expiryProof: { vaultSequence: s.vaultSequence, sessionEpoch: s.sessionEpoch, blockHeight: "1201", reason: "blockhash-expired" } };
}
function setup(kind: "session" | "revoke" | "withdraw" | "resume-buys" = "session"): SolanaPreparedSetup {
  return { kind, transactionBase64: "dGVzdA==", messageBase64: "dGVzdA==", blockhash: key(30), lastValidBlockHeight: "1200",
    programId: PROGRAM, vault: VAULT, session: SESSION, limits, preparedAtMs: NOW, expiresAtMs: NOW + 30000 };
}
async function saveSignedSetup(store: SolanaTradingStore, prepared = setup(), signature = "owner-registration") {
  await store.saveSetup(prepared); const signed = { ...prepared, signature, signedTransactionBase64: "c2lnbmVk", status: "pending" as const };
  await store.saveSetup(signed); return signed;
}
async function fixture(t: TestContext, dialect: "sqlite" | "postgres" = "sqlite") {
  const clock = { value: NOW }; let db: Db;
  const root = mkdtempSync(path.join(tmpdir(), "solana-trading-test-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "ledger.sqlite"); let raw: DatabaseSync | undefined;
  if (dialect === "postgres") {
    const url = new URL(process.env.MERRYMEN_TEST_PG_URL!); const schema = `solana_test_${randomUUID().replaceAll("-", "")}`;
    const admin = await makePgDb(url.toString()); await admin.exec(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`); db = await makePgDb(url.toString());
    t.after(async () => { await admin.exec(`DROP SCHEMA ${schema} CASCADE`); });
  } else { raw = new DatabaseSync(filename); raw.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL"); db = wrapSqlite(raw); t.after(() => raw?.close()); }
  const binding = new SqlSolanaBindingStore(async () => db, dialect, () => clock.value);
  await binding.bind(TENANT, "did:privy:test", OWNER); await binding.settings(TENANT, OWNER, 0, "live", limits);
  await ensureSolanaTradingSchema(db, dialect === "postgres");
  const store = new SolanaTradingStore(db, { tenant: TENANT, owner: OWNER }, () => clock.value);
  const registered = { programId: PROGRAM, vault: VAULT, session: SESSION, sessionEpoch: "1", registrationSignature: "owner-registration", registeredAtMs: NOW };
  await saveSignedSetup(store); await store.finishSetup("owner-registration", "finalized");
  await store.registerSession(registered, sessionSeed, dek);
  return { db, store, binding, clock, registered, reopen() {
    raw!.close(); raw = new DatabaseSync(filename); db = wrapSqlite(raw);
    return new SolanaTradingStore(db, { tenant: TENANT, owner: OWNER }, () => clock.value);
  } };
}

for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  test(`${dialect}: concurrent admissions reserve one sequence and remain idempotent across lost response`, options, async t => {
    const f = await fixture(t, dialect), first = submission(), second = submission("other");
    const results = await Promise.all([f.store.recordSigned(first), f.store.recordSigned(second)]);
    assert.equal(results.filter(Boolean).length, 1);
    const pending = await f.store.pending(); assert.equal(pending.length, 1);
    assert.equal(await f.store.recordSigned(pending[0]!.submission), false);
    assert.equal(await f.store.recordSigned(submission("fresh-blockhash", "1")), false);
    assert.equal((await f.store.liveBook())!.cashRaw, CASH.toString());
  });
  test(`${dialect}: finalized actual deltas book once; failure releases sequence only for a new request`, options, async t => {
    const f = await fixture(t, dialect), failed = submission("failed");
    await f.store.recordSigned(failed); await f.store.settle(OWNER, failed.intent.requestId, failed.signature, settlement(failed, "failed"));
    assert.equal(await f.store.recordSigned(failed), false);
    const actual = submission("actual"); actual.risk.slot = 1001; assert.equal(await f.store.recordSigned(actual), true);
    const receipt = settlement(actual); await f.store.settle(OWNER, actual.intent.requestId, actual.signature, receipt);
    await f.store.settle(OWNER, actual.intent.requestId, actual.signature, { ...receipt, finalizedAtMs: NOW + 2 });
    const book = (await f.store.liveBook())!;
    assert.equal(book.cashRaw, "99400000"); assert.equal(book.wsolRaw, "1980000");
    assert.equal(book.costBasisUsdgRaw, "600000"); assert.equal(book.networkFeesLamports, "20000");
    await assert.rejects(f.store.settle(OWNER, actual.intent.requestId, actual.signature, { ...receipt, amountOut: "1980001" }));
    const duplicate = submission("duplicate-sequence"); duplicate.risk.slot = 1001;
    duplicate.risk.cashUsdg = "99400000"; duplicate.risk.wsolRaw = "1980000";
    assert.equal(await f.store.recordSigned(duplicate), false);
  });
  test(`${dialect}: proven expiry releases notional and sequence but records unknown fees once and never reuses the request`, options, async t => {
    const f = await fixture(t, dialect), original = submission();
    await f.store.recordSigned(original);
    const proof = expired(original);
    assert.equal(proof.status, "expired"); if (proof.status !== "expired") assert.fail();
    await assert.rejects(f.store.settle(OWNER, original.intent.requestId, original.signature,
      { ...proof, expiryProof: { ...proof.expiryProof, vaultSequence: "1" } }), /expiry evidence/);
    await assert.rejects(f.store.settle(OWNER, original.intent.requestId, original.signature,
      { ...proof, expiryProof: { ...proof.expiryProof, blockHeight: "1200" } }), /expiry evidence/);
    await f.store.settle(OWNER, original.intent.requestId, original.signature, proof);
    await f.store.settle(OWNER, original.intent.requestId, original.signature, proof);
    const book = (await f.store.liveBook())!;
    assert.equal(book.cashRaw, CASH.toString()); assert.equal(book.wsolRaw, "0");
    assert.equal(book.networkFeesLamports, "0"); assert.equal(book.unresolvedFeeCount, 1); assert.equal(book.reservedUnknownFeeLamports, "10000");
    assert.equal((await f.store.pending()).length, 0); assert.equal(await f.store.recordSigned(original), false);
    // Entire daily token allowance is available again, while the operation remains recorded: 2.1 USDG a day fits the 1 USDG buy and
    // the 1.03 USDG its SOL keeps for its exit (EXITS KEEP ROOM...), and would not with the expired buy's 1 USDG still counted.
    await f.binding.settings(TENANT, OWNER, 1, "live", { ...limits, perTradeUsdg: "1000000", dailyUsdg: "2100000" });
    const next = submission("new-request"); next.risk.slot = 1001;
    assert.equal(await f.store.recordSigned(next), true); assert.equal((await f.store.history()).length, 2);
  });
  test(`${dialect}: current limits and autonomous consent are rechecked under admission lock`, options, async t => {
    const f = await fixture(t, dialect);
    let binding = (await f.binding.get(TENANT))!;
    binding = await f.binding.strategy(TENANT, OWNER, binding.revision, strategy);
    const automatic = new SolanaTradingStore(f.db, f.store.scope, () => f.clock.value, { autonomousRevision: binding.revision });
    await f.binding.strategy(TENANT, OWNER, binding.revision, { ...strategy, enabled: false });
    await assert.rejects(automatic.recordSigned(submission()), /strategy/);
    binding = (await f.binding.get(TENANT))!;
    await f.binding.settings(TENANT, OWNER, binding.revision, "live", { ...limits, perTradeUsdg: "999999" });
    await assert.rejects(f.store.recordSigned(submission()), /per-trade/);
    binding = (await f.binding.get(TENANT))!;
    await f.binding.settings(TENANT, OWNER, binding.revision, "paper", limits);
    await assert.rejects(f.store.recordSigned(submission()), /enabled/);
    assert.equal((await f.store.pending()).length, 0);
  });
  test(`${dialect}: strategy trade cap remains binding below the account limit after a sell quote moves`, options, async t => {
    const f = await fixture(t, dialect), first = submission();
    await f.store.recordSigned(first); await f.store.settle(OWNER, first.intent.requestId, first.signature, settlement(first));
    const binding = await f.binding.strategy(TENANT, OWNER, 1, strategy);
    const automatic = new SolanaTradingStore(f.db, f.store.scope, () => NOW, { autonomousRevision: binding.revision });
    const sell = submission("oversized-exit", "1"); sell.intent.inputMint = SOLANA_WRAPPED_SOL_MINT; sell.intent.outputMint = SOLANA_USDG_MINT;
    sell.quote = { ...sell.quote, inputMint: sell.intent.inputMint, outputMint: sell.intent.outputMint, outAmount: "1005000", minOutAmount: "994950" };
    sell.minOutAmount = sell.quote.minOutAmount; sell.quotedOutAmount = sell.quote.outAmount;
    sell.risk = { ...sell.risk, slot: 1001, cashUsdg: "99400000", wsolRaw: "1980000", notionalUsdg: "1005000", reference: pythBound(sell.intent, NOW) };
    await assert.rejects(automatic.recordSigned(sell), /strategy trade limit/);
    assert.equal((await f.store.pending()).length, 0);
  });
  test(`${dialect}: stale marks, fee cap, tenant/owner confusion and session replacement cannot admit`, options, async t => {
    const f = await fixture(t, dialect);
    for (const alter of [(s: SolanaSignedSubmission) => { s.safetyObservedAtMs -= 30000; },
      (s: SolanaSignedSubmission) => { s.risk.observedAtMs += 1; },
      (s: SolanaSignedSubmission) => { s.rentLamports = "3000000"; },
      (s: SolanaSignedSubmission) => { s.sessionEpoch = "2"; },
      (s: SolanaSignedSubmission) => { s.intent.owner = key(90); }]) {
      const s = submission(); alter(s); await assert.rejects(f.store.recordSigned(s));
    }
    const crossTenant = new SolanaTradingStore(f.db, { tenant: OTHER, owner: OWNER }, () => NOW);
    await assert.rejects(crossTenant.recordSigned(submission())); await assert.rejects(crossTenant.sessionSeed(dek));
    await assert.rejects(f.store.get(key(90), "trade-1"));
    assert.equal(await f.store.sessionSeed(dek), sessionSeed);
    const stored = await f.db.prepare("SELECT sealed_seed FROM solana_runtime_sessions").get() as { sealed_seed: string };
    assert.ok(!stored.sealed_seed.includes(sessionSeed));
  });
}

test("SQLite durable signed bytes and reservation survive close/reopen without a replacement transaction", async t => {
  const f = await fixture(t); const s = submission(); await f.store.recordSigned(s);
  const reopened = f.reopen(); const persisted = await reopened.get(OWNER, s.intent.requestId);
  assert.equal(persisted!.status, "pending"); assert.deepEqual(persisted!.submission, s);
  assert.equal(await reopened.recordSigned(submission("replacement", "1")), false);
});
test("owner revocation stays available during an ambiguous trade; terminal status and session activation cannot be forged", async t => {
  const f = await fixture(t), s = submission(); await f.store.recordSigned(s);
  await assert.rejects(f.store.saveSetup(setup("withdraw")), /pending/);
  const revoke = await saveSignedSetup(f.store, setup("revoke"), "revoke");
  await f.store.finishSetup(revoke.signature, "finalized"); await f.store.finishSetup(revoke.signature, "finalized");
  await assert.rejects(f.store.finishSetup(revoke.signature, "failed"), /cannot be changed/);
  await assert.rejects(f.store.registerSession(f.registered, sessionSeed, dek), /exact finalized/);
  assert.equal((await f.store.pending()).length, 1);
});
test("owner expiry records exact finalized proof atomically and cannot be rebound", async t => {
  const f = await fixture(t);
  await saveSignedSetup(f.store, { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "0", priorSessionEpoch: "1" }, "expired-owner");
  const proof = { reason: "blockhash-expired" as const, blockHeight: "1201", vaultSequence: "0", sessionEpoch: "1", slot: 1002 };
  await assert.rejects(f.store.finishSetup("expired-owner", "failed", 1002, { ...proof, blockHeight: "1200" }), /expiry evidence/);
  await assert.rejects(f.store.finishSetup("expired-owner", "failed", 1002, { ...proof, vaultSequence: "1" }), /expiry evidence/);
  await f.store.finishSetup("expired-owner", "failed", 1002, proof);
  assert.deepEqual((await f.store.setup())!.expiryProof, proof);
  await f.store.finishSetup("expired-owner", "failed", 1002, proof);
  await assert.rejects(f.store.finishSetup("expired-owner", "failed", 1002, { ...proof, blockHeight: "1202" }), /cannot be changed/);
  assert.equal(await f.store.liveBook(), null);
});
test("paper admission also checks the locked strategy cap against a moved sell quote", async t => {
  const f = await fixture(t); await f.binding.settings(TENANT, OWNER, 1, "paper", limits);
  await f.store.createPaper(CASH.toString(), limits);
  const binding = await f.binding.strategy(TENANT, OWNER, 2, strategy);
  const automatic = new SolanaTradingStore(f.db, f.store.scope, () => NOW, { autonomousRevision: binding.revision });
  const market: Parameters<typeof createSolanaPaperService>[1] = {
    async readMint(mint) { return { address: mint, program: mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM,
      decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: 1000, observedAtMs: NOW, buyBlockedReasons: [] }; },
    async quote(intent) { return { source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: intent.amountRaw,
      outAmount: intent.inputMint === SOLANA_USDG_MINT ? "2000000" : "1005000", minOutAmount: intent.inputMint === SOLANA_USDG_MINT ? "1980000" : "994950",
      slippageBps: intent.slippageBps, contextSlot: 1000, quotedAtMs: NOW, expiresAtMs: NOW + 30000 }; },
  };
  const service = createSolanaPaperService(automatic.paper(), market, () => NOW, { owner: OWNER });
  const intent = { kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "initial-buy", inputMint: SOLANA_USDG_MINT,
    outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000", slippageBps: 100 };
  // The owner's own buy; the strategy's first attempt is the exit.
  const buy = await createSolanaPaperService(f.store.paper(), market, () => NOW, { owner: OWNER }).trade(OWNER, intent);
  await assert.rejects(service.trade(OWNER, { ...intent, requestId: "oversized-exit", inputMint: SOLANA_WRAPPED_SOL_MINT,
    outputMint: SOLANA_USDG_MINT, amountRaw: buy.outputAmountRaw }), /strategy trade limit/);
  const snapshot = (await automatic.paper().get(OWNER))!;
  assert.equal(snapshot.version, 1); assert.equal(snapshot.trades.length, 1); assert.equal(snapshot.positions[0]!.amountRaw, buy.outputAmountRaw);
});
test("shutdown while waiting for the database lock prevents new paper and live admission", async t => {
  for (const mode of ["paper", "live"] as const) {
    const f = await fixture(t);
    let revision = 1;
    if (mode === "paper") {
      await f.binding.settings(TENANT, OWNER, revision++, "paper", limits);
      await f.store.createPaper(CASH.toString(), limits);
    }
    const binding = await f.binding.strategy(TENANT, OWNER, revision, strategy);
    const controller = new AbortController();
    const automatic = new SolanaTradingStore(f.db, f.store.scope, () => NOW, { autonomousRevision: binding.revision, signal: controller.signal });
    let unlock!: () => void, entered!: () => void;
    const acquired = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { unlock = resolve; });
    const held = f.db.tx(async () => { entered(); await blocked; }); await acquired;
    const s = submission();
    const { owner: _owner, vault: _vault, ...liveIntent } = s.intent;
    const attempt = mode === "live" ? automatic.recordSigned(s) : automatic.paper().commit({ owner: OWNER,
      intent: { ...liveIntent, mode: "paper" }, quote: s.quote, safetyObservedAtMs: NOW, tokenDecimals: 9, marks: [],
      buyExitQuote: { ...s.quote, inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT,
        inAmount: s.quote.minOutAmount, outAmount: "1000000", minOutAmount: "990000" }, expectedVersion: 0, nowMs: NOW });
    controller.abort(); unlock(); await held;
    await assert.rejects(Promise.resolve(attempt), /shutdown/);
    assert.equal((await f.store.pending()).length, 0);
    if (mode === "paper") assert.equal((await automatic.paper().get(OWNER))!.version, 0);
    else assert.equal(await f.store.liveBook(), null);
  }
});
test("finalized deposits adjust cashflow/HWM once; owner withdrawals remove actual holdings and basis without inventing P&L", async t => {
  const f = await fixture(t), s = submission(); await f.store.recordSigned(s);
  await assert.rejects(f.store.reconcileExternalInflows({ cashUsdg: "110000000", wsolRaw: "0", slot: 1001, observedAtMs: NOW, commitment: "finalized" }), /pending/);
  await f.store.settle(OWNER, s.intent.requestId, s.signature, settlement(s));
  const deposit = { cashUsdg: "109400000", wsolRaw: "1980000", slot: 1002, observedAtMs: NOW, commitment: "finalized" as const };
  await f.store.reconcileExternalInflows(deposit); await f.store.reconcileExternalInflows(deposit);
  assert.equal((await f.store.liveBook())!.hwmRaw, "110000000");
  await assert.rejects(f.store.reconcileExternalInflows({ ...deposit, cashUsdg: "109400001", slot: 1000 }), /finalized inflows/);
  await assert.rejects(f.store.reconcileExternalInflows({ ...deposit, cashUsdg: "109399999" }), /below the recorded book/);
  await assert.rejects(f.store.reconcileExternalInflows({ ...deposit, wsolRaw: "1979999" }), /below the recorded book/);
  // The settled trade ran at sequence 0, so the vault was at 1 when this was prepared.
  await saveSignedSetup(f.store, { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "1", priorSessionEpoch: "1", mint: SOLANA_USDG_MINT, amountRaw: "1000000" }, "withdraw-cash");
  await assert.rejects(f.store.finishSetup("withdraw-cash", "finalized"), /slot/);
  await f.store.finishSetup("withdraw-cash", "finalized", 1003); await f.store.finishSetup("withdraw-cash", "finalized", 1003);
  let book = (await f.store.liveBook())!; assert.equal(book.cashRaw, "108400000"); assert.equal(book.hwmRaw, "109000000");
  await saveSignedSetup(f.store, { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "2", priorSessionEpoch: "1", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "990000" }, "withdraw-sol");
  await f.store.finishSetup("withdraw-sol", "finalized", 1004);
  book = (await f.store.liveBook())!; assert.equal(book.wsolRaw, "990000"); assert.equal(book.costBasisUsdgRaw, "300000");
  assert.equal(book.realizedPnlUsdgRaw, "0"); assert.equal(book.hwmRaw, "109000000");
  const rows = await f.db.prepare("SELECT * FROM solana_runtime_cashflows").all(); assert.equal(rows.length, 3);
});
for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  test(`${dialect}: a finalized withdrawal is booked even when the book already moved past its slot, once, and the book's slot never moves back`, options, async t => {
    const f = await fixture(t, dialect), s = submission(); await f.store.recordSigned(s);
    await f.store.settle(OWNER, s.intent.requestId, s.signature, settlement(s));
    // The withdrawal landed at slot 1003 before its signed bytes were saved; meanwhile a
    // 5 USDG deposit landed and a finalized read at slot 2000 booked the net of both.
    const before = (await f.store.liveBook())!;
    await f.store.reconcileExternalInflows({ cashUsdg: (BigInt(before.cashRaw) + 4_000_000n).toString(), wsolRaw: before.wsolRaw, slot: 2000, observedAtMs: NOW, commitment: "finalized" });
    assert.equal((await f.store.liveBook())!.slot, 2000);
    await saveSignedSetup(f.store, { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "1", priorSessionEpoch: "1", mint: SOLANA_USDG_MINT, amountRaw: "1000000" }, "withdraw-late");
    // Nothing can move the book while it is pending.
    await assert.rejects(f.store.reconcileExternalInflows({ cashUsdg: "200000000", wsolRaw: before.wsolRaw, slot: 2001, observedAtMs: NOW, commitment: "finalized" }), /pending owner transaction/);
    await assert.rejects(f.store.recordSigned(submission("trade-2", "2")), /pending owner transaction/);
    await f.store.finishSetup("withdraw-late", "finalized", 1003);
    let book = (await f.store.liveBook())!;
    assert.equal(book.cashRaw, (BigInt(before.cashRaw) + 3_000_000n).toString(), "the withdrawal is booked");
    assert.equal(book.hwmRaw, (BigInt(before.hwmRaw) + 3_000_000n).toString());
    assert.equal(book.slot, 2000, "the book's slot never moves back");
    assert.equal((await f.store.setup())!.status, "finalized");
    // Booked once: a retry is a no-op, and its evidence row is unique.
    await f.store.finishSetup("withdraw-late", "finalized", 1003);
    assert.deepEqual(await f.store.liveBook(), book);
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM solana_runtime_cashflows WHERE evidence_id='withdraw-late'").get() as { n: number | string }).n.toString(), "1");
    // The read at 2000 had already seen the withdrawal: the chain holds the book plus 1 USDG,
    // which the next finalized read books back, so the book meets the chain again.
    await f.store.reconcileExternalInflows({ cashUsdg: (BigInt(before.cashRaw) + 4_000_000n).toString(), wsolRaw: before.wsolRaw, slot: 2001, observedAtMs: NOW, commitment: "finalized" });
    book = (await f.store.liveBook())!;
    assert.equal(book.cashRaw, (BigInt(before.cashRaw) + 4_000_000n).toString());
    assert.equal(book.hwmRaw, (BigInt(before.hwmRaw) + 4_000_000n).toString(), "deposit 5, withdraw 1: the peak rose by 4");
    // A finalized withdrawal still needs a real slot.
    await saveSignedSetup(f.store, { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "1", priorSessionEpoch: "1", mint: SOLANA_USDG_MINT, amountRaw: "1000000" }, "withdraw-no-slot");
    await assert.rejects(f.store.finishSetup("withdraw-no-slot", "finalized"), /slot/);
    await assert.rejects(f.store.finishSetup("withdraw-no-slot", "finalized", 0), /slot/);
  });
}
for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  test(`${dialect}: a finalized native SOL withdrawal raises the live book's slot (the trade snapshot floor) once the next prepare replaces its record, and never lowers it`, options, async t => {
    const f = await fixture(t, dialect), s = submission(); await f.store.recordSigned(s);
    await f.store.settle(OWNER, s.intent.requestId, s.signature, settlement(s));
    const before = (await f.store.liveBook())!; assert.equal(before.slot, 1001);
    const nativeSol = (priorSequence: string) => ({ ...setup("withdraw"), kind: "withdraw-sol" as const, priorVaultExisted: true, priorSequence, priorSessionEpoch: "1", amountRaw: "1000" });
    await saveSignedSetup(f.store, nativeSol("1"), "native-sol-1");
    // With a live book, the slot is required, as for a token withdrawal: nothing is finished without it.
    await assert.rejects(f.store.finishSetup("native-sol-1", "finalized"), /slot/);
    await assert.rejects(f.store.finishSetup("native-sol-1", "finalized", 0), /slot/);
    assert.equal((await f.store.setup())!.status, "pending");
    await f.store.finishSetup("native-sol-1", "finalized", 1500);
    let book = (await f.store.liveBook())!;
    assert.equal(book.slot, 1500, "the book's slot is now at least the withdrawal's");
    assert.deepEqual({ ...book, slot: before.slot, updatedAtMs: before.updatedAtMs }, before, "no balance, basis or peak moved: native SOL is never part of the book");
    assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM solana_runtime_cashflows WHERE evidence_id='native-sol-1'").get() as { n: number | string }).n.toString(), "1");
    // The owner prepares another owner transaction and abandons it: the setup row, with its finalized slot, is gone; the book keeps it.
    await f.store.saveSetup({ ...setup("resume-buys"), priorVaultExisted: true, priorSequence: "2", priorSessionEpoch: "1" });
    assert.equal((await f.store.setup())!.finalizedSlot, undefined);
    assert.equal((await f.store.liveBook())!.slot, 1500);
    // A later one finalized at an earlier slot (one provider's lower answer) never moves the book's slot back.
    await saveSignedSetup(f.store, nativeSol("2"), "native-sol-2");
    await f.store.finishSetup("native-sol-2", "finalized", 1200);
    book = (await f.store.liveBook())!; assert.equal(book.slot, 1500);
  });
}
/** An executable WSOL→USDG exit quote and the $500 Pyth bound for a withdrawal of `amountRaw`, read at `at`. */
function withdrawValuation(amountRaw: string, at = NOW, outAmount = (BigInt(amountRaw) / 2n).toString(), usdPerSol?: bigint) {
  const intent = { inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw, slippageBps: 50 };
  return { quote: { source: "jupiter" as const, inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: amountRaw, outAmount,
    minOutAmount: (BigInt(outAmount) * 9_950n / 10_000n).toString(), slippageBps: 50, contextSlot: 1000, quotedAtMs: at, expiresAtMs: at + 30_000 },
    reference: pythBound(intent, at, usdPerSol) };
}
/** The audit's book: 8 USDG cash plus 0.022 WSOL (11 USDG at $500), peak 20 USDG. */
async function auditBook(f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, string> = {}) {
  await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, OWNER, JSON.stringify({ hwmRaw: "20000000",
    cashRaw: "8000000", wsolRaw: "22000000", costBasisUsdgRaw: "12000000", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 1001, updatedAtMs: NOW, ...extra }));
}
const wsolWithdraw = (amountRaw: string, valuation?: object) => ({ ...setup("withdraw"), priorVaultExisted: true, priorSequence: "0", priorSessionEpoch: "1",
  mint: SOLANA_WRAPPED_SOL_MINT, amountRaw, ...(valuation ? { withdrawValuation: valuation } : {}) }) as SolanaPreparedSetup;

test("a WSOL withdrawal lowers the high-water mark by what it was worth, so withdrawn capital is not booked as a drawdown (audit accounting F3)", async t => {
  const f = await fixture(t); await auditBook(f);
  // Jupiter's executable minimum (10.945 USDG) is below the reference (11 USDG): the lower one is taken.
  await saveSignedSetup(f.store, wsolWithdraw("22000000", withdrawValuation("22000000")), "withdraw-all-sol");
  await f.store.finishSetup("withdraw-all-sol", "finalized", 1002);
  const book = (await f.store.liveBook())!;
  assert.equal(book.wsolRaw, "0"); assert.equal(book.costBasisUsdgRaw, "0");
  assert.equal(book.cashRaw, "8000000", "no invented sale proceeds"); assert.equal(book.realizedPnlUsdgRaw, "0", "no invented P&L");
  assert.equal(book.hwmRaw, (20_000_000n - 10_945_000n).toString());
  // The next buy sees 8 USDG against a 9.055 USDG peak (11.6%), inside the 20% breaker; before this it saw 8 against 20 (60%).
  const buy = submission("after-withdraw", "1"); buy.risk = { ...buy.risk, slot: 1002, cashUsdg: "8000000", wsolRaw: "0", equityUsdg: "8000000", peakEquityUsdg: book.hwmRaw };
  assert.equal(await f.store.recordSigned(buy), true);
  assert.notEqual((await f.store.liveBook())!.buyPaused, true);
});

test("a WSOL withdrawal valuation that is missing, stale, altered or one-sided never lowers the peak by more than the WSOL was worth", async t => {
  const amount = "22000000";
  const stale = withdrawValuation(amount, NOW - 121_000);
  for (const [label, valuation] of [
    ["no valuation", undefined],
    ["quote for another amount", { ...withdrawValuation(amount), quote: withdrawValuation("21000000").quote }],
    ["reference for another amount", { ...withdrawValuation(amount), reference: withdrawValuation("21000000").reference }],
    ["stale evidence", stale],
    ["edited reference", { ...withdrawValuation(amount), reference: { ...withdrawValuation(amount).reference, referenceOut: "99000000" } }],
    ["no reference", { quote: withdrawValuation(amount).quote }],
  ] as const) {
    const f = await fixture(t); await auditBook(f);
    await saveSignedSetup(f.store, wsolWithdraw(amount, valuation), "withdraw");
    await f.store.finishSetup("withdraw", "finalized", 1002);
    assert.equal((await f.store.liveBook())!.hwmRaw, "20000000", label);
  }
  // A Jupiter quote five times the reference lowers the peak by the reference value only.
  const high = await fixture(t); await auditBook(high);
  await saveSignedSetup(high.store, wsolWithdraw(amount, withdrawValuation(amount, NOW, "55000000")), "withdraw");
  await high.store.finishSetup("withdraw", "finalized", 1002);
  assert.equal((await high.store.liveBook())!.hwmRaw, "9000000");
  // The signed save keeps the valuation checked at prepare time, whatever it is handed.
  const swapped = await fixture(t); await auditBook(swapped);
  const prepared = wsolWithdraw(amount, withdrawValuation(amount));
  await swapped.store.saveSetup(prepared);
  await swapped.store.saveSetup({ ...prepared, withdrawValuation: withdrawValuation(amount, NOW, "55000000", 250_000_000_000n),
    signature: "withdraw", signedTransactionBase64: "c2lnbmVk", status: "pending" });
  assert.deepEqual((await swapped.store.setup())!.withdrawValuation, prepared.withdrawValuation);
  // A stored valuation that cannot be read never blocks booking the withdrawal; the peak stays.
  const corrupt = await fixture(t); await auditBook(corrupt);
  const signed = await saveSignedSetup(corrupt.store, wsolWithdraw(amount, withdrawValuation(amount)), "withdraw");
  await corrupt.db.prepare("UPDATE solana_runtime_setups SET setup_json=? WHERE tenant=?").run(JSON.stringify({ ...signed,
    withdrawValuation: { quote: { minOutAmount: "-1" }, reference: {} } }), TENANT);
  await corrupt.store.finishSetup("withdraw", "finalized", 1002);
  assert.equal((await corrupt.store.liveBook())!.wsolRaw, "0"); assert.equal((await corrupt.store.liveBook())!.hwmRaw, "20000000");
  // Quarantined WSOL leaves first and never counted toward the peak: only the position's share of the value comes off.
  const mixed = await fixture(t); await auditBook(mixed, { quarantinedWsolRaw: "2000000" });
  await saveSignedSetup(mixed.store, wsolWithdraw("13000000", withdrawValuation("13000000")), "withdraw");
  await mixed.store.finishSetup("withdraw", "finalized", 1002);
  const book = (await mixed.store.liveBook())!;
  assert.equal(book.quarantinedWsolRaw, "0"); assert.equal(book.wsolRaw, "11000000");
  assert.equal(book.hwmRaw, (20_000_000n - 6_467_500n * 11n / 13n).toString());
});

test("drawdown refusal commits a sticky buy pause, survives reopening and still permits reducing the position", async t => {
  const f = await fixture(t), first = submission(); await f.store.recordSigned(first);
  await f.store.settle(OWNER, first.intent.requestId, first.signature, settlement(first));
  // A previous portfolio valuation established this historical peak.
  const history = (await f.store.liveBook())!; history.hwmRaw = "200000000";
  await f.db.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify(history), TENANT, OWNER);
  const next = submission("drawdown-buy", "1"); next.risk.slot = 1001; next.risk.cashUsdg = "99400000"; next.risk.wsolRaw = "1980000";
  next.risk.peakEquityUsdg = "200000000";
  await assert.rejects(f.store.recordSigned(next), /persisted.*drawdown/);
  assert.equal((await f.store.liveBook())!.buyPaused, true); assert.equal((await f.store.pending()).length, 0);
  const reopened = f.reopen(); next.risk.equityUsdg = "200000000";
  await assert.rejects(reopened.recordSigned(next), /persisted.*drawdown/);
  const sell = structuredClone(next); sell.intent.requestId = "exit"; sell.signature = "exit-signature";
  sell.intent.inputMint = SOLANA_WRAPPED_SOL_MINT; sell.intent.outputMint = SOLANA_USDG_MINT; sell.intent.amountRaw = "990000";
  sell.quote = { ...sell.quote, inputMint: sell.intent.inputMint, outputMint: sell.intent.outputMint, inAmount: "990000", outAmount: "1000000", minOutAmount: "990000" };
  sell.minOutAmount = sell.quote.minOutAmount; sell.quotedOutAmount = sell.quote.outAmount; sell.risk.reference = pythBound(sell.intent, NOW);
  assert.equal(await reopened.recordSigned(sell), true);
  assert.equal((await reopened.liveBook())!.buyPaused, true);
  await reopened.settle(OWNER, sell.intent.requestId, sell.signature, { ...settlement(sell), amountIn: "990000", amountOut: "1000000" });
  await saveSignedSetup(reopened, setup("resume-buys"), "resume-failed");
  assert.equal((await reopened.liveBook())!.buyPaused, true);
  await reopened.finishSetup("resume-failed", "failed");
  assert.equal((await reopened.liveBook())!.buyPaused, true);
  await saveSignedSetup(reopened, setup("resume-buys"), "resume-owner-approved");
  await reopened.finishSetup("resume-owner-approved", "finalized");
  assert.equal((await reopened.liveBook())!.buyPaused, false);
  assert.equal((await reopened.liveBook())!.hwmRaw, "200000000");
});
test("finalized and failed attempts consume the daily operation cap and successful notional remains conservatively reserved", async t => {
  for (const status of ["pending", "finalized", "failed"] as const) {
    const f = await fixture(t); await f.binding.settings(TENANT, OWNER, 1, "live", { ...limits, dailyUsdg: "10000000", maxOpsPerDay: 1 });
    const first = submission(); await f.store.recordSigned(first);
    if (status !== "pending") await f.store.settle(OWNER, first.intent.requestId, first.signature, settlement(first, status));
    else await f.db.prepare("UPDATE solana_runtime_submissions SET vault=? WHERE request_id=?").run(key(77), first.intent.requestId);
    const next = submission("too-many", status === "finalized" ? "1" : "0"); next.risk.slot = 1001;
    if (status === "finalized") { next.risk.cashUsdg = "99400000"; next.risk.wsolRaw = "1980000"; }
    await assert.rejects(f.store.recordSigned(next), /daily limit/, status);
  }
});

test("by default a proven-expired attempt counts toward maxOpsPerDay like any signed transaction (owner decision, audit G2-3)", async t => {
  const f = await fixture(t), first = tenUsdgBuy(); await f.binding.settings(TENANT, OWNER, 1, "live", { ...limits, maxOpsPerDay: 2 });
  await f.store.recordSigned(first); await f.store.settle(OWNER, first.intent.requestId, first.signature, tenUsdgFill(first));
  const book = TEN_BOOK;
  // One executed operation of two; the first exit is dropped and proven expired: the session key signed two.
  const dropped = sale("exit-1", "1", "10000000", book); assert.equal(await f.store.recordSigned(dropped), true);
  await f.store.settle(OWNER, dropped.intent.requestId, dropped.signature, expired(dropped));
  await assert.rejects(f.store.recordSigned(sale("exit-2", "1", "10000000", book)), /expired without landing in the last 24 hours: they count toward the daily operation limit/);
  assert.equal((await f.store.pending()).length, 0);
  // An explicit allowance of 0 is the same; a malformed one admits nothing.
  await assert.rejects(f.store.recordSigned(sale("exit-2", "1", "10000000", book), { expiredAttemptAllowance: 0 }), /expired without landing/);
  for (const bad of [-1, 97, 1.5, Number.NaN]) {
    await assert.rejects(f.store.recordSigned(sale("exit-2", "1", "10000000", book), { expiredAttemptAllowance: bad }), /allowance setting is misconfigured/, String(bad));
  }
  // Later, the dropped attempt leaves the window and trading resumes.
  f.clock.value = NOW + 86_400_001;
  const later = sale("later", "1", "10000000", book); later.preparedAtMs = later.safetyObservedAtMs = later.risk.observedAtMs = later.quote.quotedAtMs = f.clock.value;
  later.quote.expiresAtMs = f.clock.value + 30_000; later.risk.reference = pythBound(later.intent, f.clock.value);
  await f.binding.settings(TENANT, OWNER, 2, "live", { ...limits, maxOpsPerDay: 2, expiresAtMs: f.clock.value + 3_600_000 });
  assert.equal(await f.store.recordSigned(later), true);
});

test("an expired-attempt allowance lets that many dropped attempts a day leave the operation count, never more (owner decision, audit G2-3)", async t => {
  const f = await fixture(t), first = tenUsdgBuy(), allow = (n: number) => ({ expiredAttemptAllowance: n });
  await f.binding.settings(TENANT, OWNER, 1, "live", { ...limits, maxOpsPerDay: 2 });
  await f.store.recordSigned(first, allow(1)); await f.store.settle(OWNER, first.intent.requestId, first.signature, tenUsdgFill(first));
  const book = TEN_BOOK;
  const dropped = sale("exit-1", "1", "10000000", book); await f.store.recordSigned(dropped, allow(1));
  await f.store.settle(OWNER, dropped.intent.requestId, dropped.signature, expired(dropped));
  // With an allowance of one the retry is admitted: the program never counted the dropped one.
  const retry = sale("exit-2", "1", "10000000", book); assert.equal(await f.store.recordSigned(retry, allow(1)), true);
  await f.store.settle(OWNER, retry.intent.requestId, retry.signature, { ...settlement(retry), slot: 1002, amountIn: "10000000", amountOut: "5000000" });
  // Two executed operations now: the owner's limit is spent, whatever the allowance.
  await assert.rejects(f.store.recordSigned(sale("exit-3", "2", "5000000", { slot: 1002, cash: "99000000", wsol: "9800000" }), allow(96)), /daily limit/);
  // At most maxOpsPerDay + allowance are signed: two operations and an allowance of two admit four dropped attempts, not five.
  const g = await fixture(t); await g.binding.settings(TENANT, OWNER, 1, "live", { ...limits, maxOpsPerDay: 2 });
  for (const id of ["drop-1", "drop-2", "drop-3", "drop-4"]) {
    const s = submission(id); s.risk.slot = 1001; assert.equal(await g.store.recordSigned(s, allow(2)), true, id); await g.store.settle(OWNER, id, s.signature, expired(s));
  }
  const fifth = submission("drop-5"); fifth.risk.slot = 1001;
  await assert.rejects(g.store.recordSigned(fifth, allow(2)), /expired without landing/);
  assert.equal((await g.store.pending()).length, 0);
});

test("the expired-attempt allowance setting defaults to 0 and accepts only a whole number from 0 to 96", () => {
  assert.equal(solanaExpiredAttemptAllowance({}), SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE);
  assert.equal(SOLANA_DEFAULT_EXPIRED_ATTEMPT_ALLOWANCE, 0);
  for (const [value, expected] of [["0", 0], ["1", 1], ["20", 20], ["96", 96]] as const) {
    assert.equal(solanaExpiredAttemptAllowance({ MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: value }), expected);
  }
  for (const value of ["", " 1", "01", "-1", "1.5", "97", "100", "1e1", "many"]) {
    assert.throws(() => solanaExpiredAttemptAllowance({ MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE: value }), /allowance setting is misconfigured/, JSON.stringify(value));
  }
});

/** Signed bytes (unsigned, which is all the store and the deadline decoder read) whose execute_swap carries `deadline` (unix seconds). */
function bytesWithDeadline(deadline: bigint): string {
  const data = Buffer.alloc(48); data.writeBigInt64LE(deadline, 40);
  return getBase64EncodedWireTransaction(compileTransaction(setTransactionMessageLifetimeUsingBlockhash({ blockhash: key(24) as Blockhash, lastValidBlockHeight: 1200n },
    setTransactionMessageFeePayer(address(key(23)), appendTransactionMessageInstructions([{ programAddress: address(PROGRAM), accounts: [], data }], createTransactionMessage({ version: 0 }))))));
}

test("an expiry proven from the vault's debit log (sequence-consumed) is never booked by automatic settlement", async t => {
  const f = await fixture(t), pending = submission("consumed");
  pending.signedTransactionBase64 = bytesWithDeadline(1030n);
  assert.equal(await f.store.recordSigned(pending), true);
  const consumed: SolanaLiveSettlement = { status: "expired", signature: pending.signature, slot: 1001, feeLamports: null, amountIn: "0", amountOut: "0", finalizedAtMs: NOW + 1,
    expiryProof: { vaultSequence: "1", sessionEpoch: "1", blockHeight: "1201", reason: "sequence-consumed", debitWindowStart: "1000" } };
  await assert.rejects(f.store.settle(OWNER, "consumed", pending.signature, consumed), /Invalid Solana expiry evidence/);
  assert.equal((await f.store.get(OWNER, "consumed"))!.status, "pending");
});

/** A WSOL→USDG sell at $500/SOL against the current book, bounded by a fresh reference. */
function sale(id: string, seq: string, amountRaw: string, book: { slot: number; cash: string; wsol: string }, outAmount?: string) {
  const s = submission(id, seq), out = outAmount ?? (BigInt(amountRaw) / 2n).toString();
  s.intent = { ...s.intent, inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, amountRaw };
  s.quote = { ...s.quote, inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, inAmount: amountRaw, outAmount: out,
    minOutAmount: (BigInt(out) * 9_900n / 10_000n).toString() };
  s.minOutAmount = s.quote.minOutAmount; s.quotedOutAmount = out;
  s.risk = { ...s.risk, slot: book.slot, cashUsdg: book.cash, wsolRaw: book.wsol, reference: pythBound(s.intent, NOW) };
  s.risk.notionalUsdg = (BigInt(out) > BigInt(s.risk.reference.valueUsdg) ? out : s.risk.reference.valueUsdg);
  return s;
}
/**
 * A 10 USDG buy at $500/SOL and its fill, which books 94 USDG and 0.0198 SOL: partial sells of that
 * position can be worth the live minimum (1 USDG), which a 1 USDG buy's position never is.
 */
function tenUsdgBuy(id = "trade-1"): SolanaSignedSubmission {
  const s = submission(id);
  s.intent.amountRaw = s.quote.inAmount = "10000000"; s.quote.outAmount = s.quotedOutAmount = "20000000";
  s.quote.minOutAmount = s.minOutAmount = "19800000"; s.risk.notionalUsdg = "10000000"; s.risk.reference = pythBound(s.intent, NOW);
  return s;
}
const tenUsdgFill = (s: SolanaSignedSubmission): SolanaLiveSettlement => ({ ...settlement(s), amountIn: "6000000", amountOut: "19800000" });
const TEN_BOOK = { slot: 1001, cash: "94000000", wsol: "19800000" };

test("admission re-checks the independent price floor and charges a cheap sell at its reference value", async t => {
  const f = await fixture(t), first = tenUsdgBuy(); await f.store.recordSigned(first);
  await f.store.settle(OWNER, first.intent.requestId, first.signature, tenUsdgFill(first));
  const book = TEN_BOOK;
  // An edited floor, a floor from another trade or a stale price is refused before anything is reserved.
  for (const forge of [(s: SolanaSignedSubmission) => { s.risk.reference = { ...s.risk.reference, minOutFloor: "1" }; },
    (s: SolanaSignedSubmission) => { s.risk.reference = pythBound(first.intent, NOW); },
    (s: SolanaSignedSubmission) => { s.risk.reference = pythBound(s.intent, NOW - 121_000); },
    (s: SolanaSignedSubmission) => { delete (s.risk as Partial<typeof s.risk>).reference; }]) {
    const forged = sale("forged", "1", "10000000", book); forge(forged);
    await assert.rejects(f.store.recordSigned(forged), /independent SOL price evidence/);
  }
  // A dust quote cannot sign: its guaranteed output is far below the $500 floor.
  await assert.rejects(f.store.recordSigned(sale("dust", "1", "10000000", book, "100")), /below the independent SOL price floor/);
  // 2% under the reference passes the 3% floor, but is charged at the full reference value.
  const cheap = sale("cheap", "1", "10000000", book, "4900000");
  assert.equal(cheap.risk.notionalUsdg, "5000000");
  assert.equal(await f.store.recordSigned(cheap), true);
  const row = await f.db.prepare("SELECT notional_raw FROM solana_runtime_submissions WHERE request_id='cheap'").get() as { notional_raw: string };
  assert.equal(row.notional_raw, "5000000");
  assert.equal((await f.store.pending()).length, 1);
});

test("admission re-checks the price bound against the configured tolerance, not the one the evidence carries", async t => {
  const f = await fixture(t), first = tenUsdgBuy(); await f.store.recordSigned(first);
  await f.store.settle(OWNER, first.intent.requestId, first.signature, tenUsdgFill(first));
  const book = TEN_BOOK;
  // A sell bounded at 10% instead of 3%: consistent with itself, and its minimum clears its own (lower) floor.
  const wide = (id: string) => { const s = sale(id, "1", "10000000", book, "4800000"); s.risk.reference = pythBound(s.intent, NOW, undefined, undefined, 1000);
    s.risk.notionalUsdg = s.risk.reference.valueUsdg; return s; };
  await assert.rejects(f.store.recordSigned(wide("wide-default")), /independent SOL price evidence/);
  await assert.rejects(f.store.recordSigned(wide("wide-300"), { referenceToleranceBps: 300 }), /independent SOL price evidence/);
  assert.deepEqual(await f.store.pending(), []);
  // The same evidence under a runtime configured for 10% is admitted.
  assert.equal(await f.store.recordSigned(wide("wide-1000"), { referenceToleranceBps: 1000 }), true);
});

for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  /** A live book written straight into the store, and an operator's write-off decision recorded on `snapshot` (as the resolve tool records it first). */
  const shortfallAccount = async (t: TestContext, book: Record<string, unknown>) => {
    const f = await fixture(t, dialect); await ensureSolanaShortfallSchema(f.db, dialect === "postgres");
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, OWNER, JSON.stringify(book));
    const decide = async (snapshot: { slot: number; cashUsdg: string; wsolRaw: string }) => {
      const id = randomUUID();
      await f.db.prepare("INSERT INTO solana_operator_shortfalls(id,tenant,owner,slot,cash_usdg,wsol_raw,operator,reason,evidence_json,approved_at_ms) VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(id, TENANT, OWNER, snapshot.slot, snapshot.cashUsdg, snapshot.wsolRaw, "milla", "issuer seized 20 USDG", "{}", f.clock.value);
      return id;
    };
    const flows = async () => (await f.db.prepare("SELECT evidence_id,kind,mint,amount_raw FROM solana_runtime_cashflows").all() as Array<{ evidence_id: string; kind: string; mint: string; amount_raw: string }>)
      .sort((a, b) => byEvidence(a.evidence_id, b.evidence_id)).map(row => [row.kind, row.mint, row.amount_raw]);
    const booked = async (id: string) => (await f.db.prepare("SELECT booked_at_ms FROM solana_operator_shortfalls WHERE id=?").get(id) as { booked_at_ms: number | string | null }).booked_at_ms;
    return { ...f, decide, flows, booked };
  };
  const base = { hwmRaw: "120000000", cashRaw: "90000000", wsolRaw: "50000000", costBasisUsdgRaw: "10000000", realizedPnlUsdgRaw: "0", networkFeesLamports: "0",
    quarantinedWsolRaw: "5000000", slot: 1000, updatedAtMs: NOW - 1000 };

  test(`${dialect}: an operator's shortfall write-off books a loss once, only under its own recorded decision, keeps the high-water mark and pauses buying`, options, async t => {
    const f = await shortfallAccount(t, base);
    const reading = { slot: 1005, cashUsdg: "70000000", wsolRaw: "40000000" }, snapshot = { ...reading, observedAtMs: NOW, commitment: "finalized" as const };
    // A decision recorded on another reading, or none at all, books nothing.
    for (const id of [await f.decide({ ...reading, cashUsdg: "70000001" }), randomUUID()]) {
      await assert.rejects(f.store.writeOffShortfall(snapshot, id), /decision to write off this shortfall is not open/);
    }
    assert.deepEqual(await f.store.liveBook(), base); assert.deepEqual(await f.flows(), []);
    const id = await f.decide(reading), result = await f.store.writeOffShortfall(snapshot, id);
    // 20 USDG gone; 15 WSOL short: the 5 quarantined (zero basis) first, then 10 of the 50 held, at a fifth of its 10 USDG basis.
    assert.deepEqual(result.lost, { usdgRaw: "20000000", wsolRaw: "10000000", quarantinedWsolRaw: "5000000", costBasisUsdgRaw: "2000000" });
    assert.deepEqual(result.inflow, { usdgRaw: "0", quarantinedWsolRaw: "0" });
    const after = (await f.store.liveBook())! as SolanaLiveBook & { balancesSlot?: number };
    assert.deepEqual([after.cashRaw, after.wsolRaw, after.quarantinedWsolRaw, after.costBasisUsdgRaw, after.realizedPnlUsdgRaw, after.hwmRaw, after.buyPaused, after.slot, after.balancesSlot],
      ["70000000", "40000000", "0", "8000000", "-22000000", "120000000", true, 1005, 1005]);
    assert.deepEqual(await f.flows(), [["write-off", SOLANA_WRAPPED_SOL_MINT, "15000000"], ["write-off", SOLANA_USDG_MINT, "20000000"]].sort((a, b) =>
      `write-off:${OWNER}:1005:${a[1]}`.localeCompare(`write-off:${OWNER}:1005:${b[1]}`)));
    assert.equal(Number(await f.booked(id)), NOW);
    // Once: the same reading finds nothing short, so a second decision on it books nothing.
    const again = await f.decide(reading);
    await assert.rejects(f.store.writeOffShortfall(snapshot, again), /Nothing is short/);
    assert.deepEqual(await f.store.liveBook(), after); assert.equal(await f.booked(again), null);
  });

  test(`${dialect}: a shortfall write-off waits for the account's own pending trade, owner transaction or prepared withdrawal, and never books a stale or older reading`, options, async t => {
    const f = await shortfallAccount(t, { ...base, quarantinedWsolRaw: "0", slot: 999 });
    const reading = { slot: 1005, cashUsdg: "70000000", wsolRaw: "50000000" }, snapshot = { ...reading, observedAtMs: NOW, commitment: "finalized" as const };
    const id = await f.decide(reading);
    // A trade admitted before the shortfall and still pending: its landing may be what the vault lacks.
    await f.db.prepare(`INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json)
      VALUES(?,?,?,?,?,?,'pending',?,?,?)`).run(TENANT, OWNER, "settling", VAULT, "0", "signature-settling", NOW, "1000000", "{}");
    await assert.rejects(f.store.writeOffShortfall(snapshot, id), /pending Solana trade/);
    await f.db.prepare("UPDATE solana_runtime_submissions SET status='failed' WHERE request_id='settling'").run();
    await saveSignedSetup(f.store, setup("revoke"), "owner-revoke");
    await assert.rejects(f.store.writeOffShortfall(snapshot, id), /pending owner transaction/);
    await f.store.finishSetup("owner-revoke", "finalized", 1002);
    await f.store.saveSetup({ ...setup("withdraw"), mint: SOLANA_USDG_MINT, amountRaw: "80000000", priorSequence: "1" });
    await assert.rejects(f.store.writeOffShortfall(snapshot, id), /prepared owner withdrawal/);
    f.clock.value = NOW + 30_000; // the prepared withdrawal lapsed
    // A reading taken before the book's last change, or no longer fresh, is read again.
    const failed = (await f.store.liveBook())!;
    await assert.rejects(f.store.writeOffShortfall({ ...snapshot, slot: failed.slot - 1, observedAtMs: f.clock.value }, id), /moved after these balances were read/);
    await assert.rejects(f.store.writeOffShortfall({ ...snapshot, observedAtMs: f.clock.value - 60_000 }, id), /fresh finalized/);
    assert.deepEqual(await f.store.liveBook(), failed); assert.deepEqual(await f.flows(), []); assert.equal(await f.booked(id), null);
    await f.store.writeOffShortfall({ ...snapshot, observedAtMs: f.clock.value }, id);
    assert.equal((await f.store.liveBook())!.cashRaw, "70000000"); assert.notEqual(await f.booked(id), null);
  });

  test(`${dialect}: an asset above its book in the same reading is booked as status books an inflow; a quarantine-only shortfall pauses nothing`, options, async t => {
    // USDG short, WSOL above: the USDG is a loss, the extra WSOL zero-basis quarantine.
    const f = await shortfallAccount(t, base);
    const mixed = { slot: 1005, cashUsdg: "85000000", wsolRaw: "55000007" };
    const first = await f.store.writeOffShortfall({ ...mixed, observedAtMs: NOW, commitment: "finalized" }, await f.decide(mixed));
    assert.deepEqual([first.lost.usdgRaw, first.inflow.quarantinedWsolRaw, first.book.quarantinedWsolRaw, first.book.wsolRaw, first.book.hwmRaw, first.book.realizedPnlUsdgRaw],
      ["5000000", "7", "5000007", "50000000", "120000000", "-5000000"]);
    // WSOL short only by quarantined SOL, USDG above: a deposit raising the high-water mark, and no pause (no valued asset was lost).
    const g = await shortfallAccount(t, { ...base, buyPaused: false });
    const aside = { slot: 1005, cashUsdg: "91000000", wsolRaw: "52000000" };
    const second = await g.store.writeOffShortfall({ ...aside, observedAtMs: NOW, commitment: "finalized" }, await g.decide(aside));
    assert.deepEqual([second.lost.quarantinedWsolRaw, second.lost.wsolRaw, second.inflow.usdgRaw, second.book.cashRaw, second.book.hwmRaw, second.book.buyPaused, second.book.realizedPnlUsdgRaw],
      ["3000000", "0", "1000000", "91000000", "121000000", false, "0"]);
    assert.deepEqual((await g.flows()).map(row => row[0]).sort(), ["deposit", "write-off"]);
  });
}

test("a live trade worth under 1 USDG is refused at admission, except a sale of the whole recorded SOL position", async t => {
  const f = await fixture(t), first = submission(); await f.store.recordSigned(first);
  await f.store.settle(OWNER, first.intent.requestId, first.signature, settlement(first));
  const book = { slot: 1001, cash: "99400000", wsol: "1980000" };
  // A buy of a few micro-USDG at the shared fee payer's expense.
  const dust = submission("dust-buy", "1"); dust.intent.amountRaw = dust.quote.inAmount = "999999";
  dust.quote.outAmount = dust.quotedOutAmount = "1999998"; dust.quote.minOutAmount = dust.minOutAmount = "1979998";
  dust.risk = { ...dust.risk, slot: 1001, cashUsdg: book.cash, wsolRaw: book.wsol, notionalUsdg: "999999" }; dust.risk.reference = pythBound(dust.intent, NOW);
  await assert.rejects(f.store.recordSigned(dust), /must be worth at least 1 USDG/);
  // Half the position, worth $0.495: refused.
  await assert.rejects(f.store.recordSigned(sale("part", "1", "990000", book)), /must be worth at least 1 USDG/);
  assert.equal((await f.store.pending()).length, 0);
  // The whole position, worth $0.99, can still be exited.
  assert.equal(await f.store.recordSigned(sale("whole", "1", "1980000", book)), true);
});

/** A buy of `usdg` raw USDG at $500/SOL (2 lamports per micro-USDG) against `book`, as the executor would sign it. */
function buyFor(id: string, seq: string, usdg: bigint, book: { slot: number; cash: string; wsol: string }): SolanaSignedSubmission {
  const s = submission(id, seq), out = usdg * 2n;
  s.intent = { ...s.intent, amountRaw: usdg.toString() };
  s.quote = { ...s.quote, inAmount: usdg.toString(), outAmount: out.toString(), minOutAmount: (out * 9_900n / 10_000n).toString() };
  s.minOutAmount = s.quote.minOutAmount; s.quotedOutAmount = s.quote.outAmount;
  s.risk = { ...s.risk, slot: book.slot, cashUsdg: book.cash, wsolRaw: book.wsol, notionalUsdg: usdg.toString(), reference: pythBound(s.intent, NOW) };
  return s;
}
test("exits keep room in the rolling limits: a buy that would leave the whole position unsellable today is refused, smaller ones fit, and after the most buys admitted the whole position is still sold within the day", async t => {
  // 10 USDG and 0.05 SOL per trade, 50 USDG and 0.12 SOL a day; $500 a SOL, 3% tolerance. Each fill books its guaranteed minimum;
  // what each buy brings is counted 3% above its quote (THE FILL MARGIN).
  const f = await fixture(t);
  let book = { slot: 1000, cash: CASH.toString(), wsol: "0" }, seq = 0;
  const filled = async (s: SolanaSignedSubmission) => {
    const selling = s.intent.inputMint === SOLANA_WRAPPED_SOL_MINT, amountIn = s.intent.amountRaw, amountOut = s.minOutAmount;
    await f.store.settle(OWNER, s.intent.requestId, s.signature, { status: "finalized", signature: s.signature, slot: 1001, feeLamports: "10000", amountIn, amountOut, finalizedAtMs: NOW + 1 });
    book = { slot: 1001, cash: (BigInt(book.cash) + (selling ? BigInt(amountOut) : -BigInt(amountIn))).toString(),
      wsol: (BigInt(book.wsol) + (selling ? -BigInt(amountIn) : BigInt(amountOut))).toString() };
    seq++;
  };
  const buy = (id: string, usdg: bigint) => buyFor(id, String(seq), usdg, book);
  // Two 10 USDG buys fit: 10 + 10 + 20.81 USDG kept for selling the 0.0404 SOL they may leave is within 50.
  for (const id of ["buy-1", "buy-2"]) { const s = buy(id, 10_000_000n); assert.equal(await f.store.recordSigned(s), true, id); await filled(s); }
  // A third may leave 0.0602 SOL ($30.10) to sell after 30 USDG used: 30 + 31.00 > 50. Refused, nothing reserved.
  await assert.rejects(f.store.recordSigned(buy("buy-3", 10_000_000n)), (error: unknown) => error instanceof Error && error.message === SOLANA_LIVE_EXIT_RESERVE);
  assert.equal((await f.store.pending()).length, 0);
  // The most that fits now is about 4.66 USDG (4.7 would need 20 + 4.7 + 25.38): 4.6 is admitted, and then not even 1 USDG more.
  await assert.rejects(f.store.recordSigned(buy("buy-4-over", 4_700_000n)), (error: unknown) => error instanceof Error && error.message === SOLANA_LIVE_EXIT_RESERVE);
  const last = buy("buy-4", 4_600_000n); assert.equal(await f.store.recordSigned(last), true); await filled(last);
  await assert.rejects(f.store.recordSigned(buy("buy-5", 1_000_000n)), (error: unknown) => error instanceof Error && error.message === SOLANA_LIVE_EXIT_RESERVE);
  // The whole position, 0.048708 SOL ($24.35), is sold back within the same day, in sales the 10 USDG per-trade limit allows.
  const position = BigInt(book.wsol), piece = position / 3n;
  for (const [i, amount] of [piece, piece, position - 2n * piece].entries()) {
    const s = sale(`exit-${i}`, String(seq), amount.toString(), book);
    assert.equal(await f.store.recordSigned(s), true, `exit ${i}`); await filled(s);
  }
  assert.equal(book.wsol, "0"); assert.equal((await f.store.liveBook())!.wsolRaw, "0", "the whole position was sold inside the window");
  const used = await solanaRollingLimitUse(f.db, f.store.scope, NOW);
  assert.ok(used.notionalRaw <= BigInt(limits.dailyUsdg) && used.soldWsolRaw <= BigInt(limits.dailyWsol));
});
test("the fill margin: an ExactIn buy that fills above its quote, up to the margin, still leaves the whole position sellable within the day; the buy that would not, counted without it, is refused", async t => {
  // 10 USDG per trade, 100 USDG a day; 0.03 SOL sold per trade and per day, the limit that binds here. $500 a SOL: a buy's quote and
  // reference both bring 2 lamports a micro-USDG. Each fill lands 3% above its quote, which the program allows (it bounds only the minimum).
  const f = await fixture(t);
  await f.binding.settings(TENANT, OWNER, (await f.binding.get(TENANT))!.revision, "live", { ...limits, perTradeWsol: "30000000", dailyWsol: "30000000", dailyUsdg: "100000000" });
  assert.equal(SOLANA_EXIT_RESERVE_FILL_MARGIN_BPS, 300, "the default reference tolerance");
  assert.equal(solanaBuyFillBound(20_000_000n, 19_000_000n), 20_600_000n); assert.equal(solanaBuyFillBound(19_000_000n, 20_000_001n), 20_600_002n, "rounded up");
  let book = { slot: 1000, cash: CASH.toString(), wsol: "0" }, seq = 0;
  const filled = async (s: SolanaSignedSubmission, amountOut: string) => {
    const selling = s.intent.inputMint === SOLANA_WRAPPED_SOL_MINT;
    await f.store.settle(OWNER, s.intent.requestId, s.signature, { status: "finalized", signature: s.signature, slot: 1001, feeLamports: "10000",
      amountIn: s.intent.amountRaw, amountOut, finalizedAtMs: NOW + 1 });
    book = { slot: 1001, cash: (BigInt(book.cash) + (selling ? BigInt(amountOut) : -BigInt(s.intent.amountRaw))).toString(),
      wsol: (BigInt(book.wsol) + (selling ? -BigInt(s.intent.amountRaw) : BigInt(amountOut))).toString() };
    seq++;
  };
  const above = (s: SolanaSignedSubmission) => (BigInt(s.quote.outAmount) * 10_300n / 10_000n).toString();
  const exitReserve = (error: unknown) => error instanceof Error && error.message === SOLANA_LIVE_EXIT_RESERVE;
  const first = buyFor("buy-1", String(seq), 10_000_000n, book);
  assert.equal(await f.store.recordSigned(first), true); await filled(first, above(first));
  assert.equal(book.wsol, "20600000");
  // 4.7 USDG brings 0.0094 SOL by its quote: 0.0206 + 0.0094 is exactly the day's 0.03 SOL, so it fits counted without the margin. A 3% better
  // fill would leave 0.030282 SOL, more than one day may sell: counted with the margin (0.009682 SOL), it is refused, nothing reserved.
  await assert.rejects(f.store.recordSigned(buyFor("buy-2", String(seq), 4_700_000n, book)), exitReserve);
  assert.equal((await f.store.pending()).length, 0);
  // 4.5 USDG fits with the margin (0.0206 + 0.00927 <= 0.03), and its 3% better fill is booked as it landed.
  const second = buyFor("buy-3", String(seq), 4_500_000n, book);
  assert.equal(await f.store.recordSigned(second), true); await filled(second, above(second));
  assert.equal((await f.store.liveBook())!.wsolRaw, "29870000");
  // The whole position is sold back the same day: two sales within the 10 USDG per-trade limit, 0.02987 SOL of the day's 0.03.
  for (const [i, amount] of [14_935_000n, 14_935_000n].entries()) {
    const exit = sale(`exit-${i}`, String(seq), amount.toString(), book);
    assert.equal(await f.store.recordSigned(exit), true, `exit ${i}`); await filled(exit, exit.minOutAmount);
  }
  assert.equal((await f.store.liveBook())!.wsolRaw, "0", "the whole position was sold inside the window");
  const used = await solanaRollingLimitUse(f.db, f.store.scope, NOW);
  assert.ok(used.soldWsolRaw <= 30_000_000n && used.notionalRaw <= 100_000_000n);
});
test("the fill margin: a fill beyond it is booked as it landed, leaving more SOL than the day's limits can sell; every further buy is refused, and sales still go through", async t => {
  // As above (0.03 SOL sold a day binds), but the second buy's fill lands 20% above its quote, beyond the margin.
  const f = await fixture(t);
  await f.binding.settings(TENANT, OWNER, (await f.binding.get(TENANT))!.revision, "live", { ...limits, perTradeWsol: "30000000", dailyWsol: "30000000", dailyUsdg: "100000000" });
  const first = buyFor("buy-1", "0", 10_000_000n, { slot: 1000, cash: CASH.toString(), wsol: "0" });
  assert.equal(await f.store.recordSigned(first), true);
  await f.store.settle(OWNER, "buy-1", first.signature, { status: "finalized", signature: first.signature, slot: 1001, feeLamports: "10000", amountIn: "10000000",
    amountOut: "20600000", finalizedAtMs: NOW + 1 });
  const second = buyFor("buy-2", "1", 4_500_000n, { slot: 1001, cash: "90000000", wsol: "20600000" });
  assert.equal(await f.store.recordSigned(second), true);
  await f.store.settle(OWNER, "buy-2", second.signature, { status: "finalized", signature: second.signature, slot: 1002, feeLamports: "10000", amountIn: "4500000",
    amountOut: "10800000", finalizedAtMs: NOW + 1 });
  // Booked as it landed: 0.0314 SOL for 14.5 USDG, more than the 0.03 SOL one day may sell.
  const booked = (await f.store.liveBook())!;
  assert.deepEqual([booked.wsolRaw, booked.cashRaw, booked.costBasisUsdgRaw], ["31400000", "85500000", "14500000"]);
  const book = { slot: 1002, cash: "85500000", wsol: "31400000" };
  const exitReserve = (error: unknown) => error instanceof Error && error.message === SOLANA_LIVE_EXIT_RESERVE;
  // Every further buy is refused by the exit reserve, however small, with nothing reserved.
  for (const usdg of [1_000_000n, 10_000_000n]) await assert.rejects(f.store.recordSigned(buyFor(`more-${usdg}`, "2", usdg, book)), exitReserve, String(usdg));
  assert.equal((await f.store.pending()).length, 0);
  // Sales go through, up to the day's SOL sold limit: the excess waits for the next window.
  const exit = sale("exit-1", "2", "15000000", book);
  assert.equal(await f.store.recordSigned(exit), true);
  await f.store.settle(OWNER, "exit-1", exit.signature, { status: "finalized", signature: exit.signature, slot: 1003, feeLamports: "10000", amountIn: "15000000",
    amountOut: exit.minOutAmount, finalizedAtMs: NOW + 1 });
  const after = { slot: 1003, cash: (85_500_000n + BigInt(exit.minOutAmount)).toString(), wsol: "16400000" };
  assert.equal(await f.store.recordSigned(sale("exit-2", "3", "15000000", after)), true, "a second sale fills the day's 0.03 SOL");
});
test("exits keep room in the SOL sold limit too: a buy whose position after it is more SOL than sales left of the day's SOL sold limit is refused", async t => {
  // 0.03 SOL a day may be sold; a 10 USDG buy brings 0.02 SOL, so the second would leave 0.04 SOL that cannot be sold today.
  const f = await fixture(t);
  await f.binding.settings(TENANT, OWNER, (await f.binding.get(TENANT))!.revision, "live", { ...limits, perTradeWsol: "30000000", dailyWsol: "30000000", dailyUsdg: "100000000" });
  const first = buyFor("buy-1", "0", 10_000_000n, { slot: 1000, cash: CASH.toString(), wsol: "0" });
  assert.equal(await f.store.recordSigned(first), true);
  await f.store.settle(OWNER, "buy-1", first.signature, { status: "finalized", signature: first.signature, slot: 1001, feeLamports: "10000", amountIn: "10000000", amountOut: first.minOutAmount, finalizedAtMs: NOW + 1 });
  const book = { slot: 1001, cash: "90000000", wsol: first.minOutAmount };
  await assert.rejects(f.store.recordSigned(buyFor("buy-2", "1", 10_000_000n, book)), (error: unknown) => error instanceof Error && error.message === SOLANA_LIVE_EXIT_RESERVE);
  // A sale is never refused by it.
  assert.equal(await f.store.recordSigned(sale("exit", "1", first.minOutAmount, book)), true);
});
test("exits keep room within the registered permission's limits, kept in the session record, where they are below the saved ones: the vault sells the exit under its own", async t => {
  // Saved: 50 USDG and 0.12 SOL a day. $500 a SOL, 3% tolerance. One 10 USDG buy is admitted and booked first (0.0198 SOL held).
  const registeredAt = async (registered: { dailyUsdg: string; dailyWsol: string } | null) => {
    const f = await fixture(t);
    if (registered) {
      const record = JSON.parse((await f.db.prepare("SELECT record_json FROM solana_runtime_sessions").get() as { record_json: string }).record_json);
      await f.db.prepare("UPDATE solana_runtime_sessions SET record_json=?").run(JSON.stringify({ ...record,
        limits: { perTradeUsdg: limits.perTradeUsdg, perTradeWsol: limits.perTradeWsol, ...registered } }));
    }
    const first = buyFor("buy-1", "0", 10_000_000n, { slot: 1000, cash: CASH.toString(), wsol: "0" });
    assert.equal(await f.store.recordSigned(first), true);
    await f.store.settle(OWNER, "buy-1", first.signature, { status: "finalized", signature: first.signature, slot: 1001, feeLamports: "10000", amountIn: "10000000",
      amountOut: first.minOutAmount, finalizedAtMs: NOW + 1 });
    return { f, book: { slot: 1001, cash: "90000000", wsol: first.minOutAmount } };
  };
  const exitReserve = (error: unknown) => error instanceof Error && error.message === SOLANA_LIVE_EXIT_RESERVE;
  // Registered at 25 USDG a day: a second 10 USDG buy would leave 0.0398 SOL ($19.90) to sell after 20 used (20 + 20.50 > 25), which the
  // saved 50 would admit. A 2 USDG buy still fits (12 + 12.26).
  const usdg = await registeredAt({ dailyUsdg: "25000000", dailyWsol: limits.dailyWsol });
  await assert.rejects(usdg.f.store.recordSigned(buyFor("buy-2", "1", 10_000_000n, usdg.book)), exitReserve);
  assert.equal((await usdg.f.store.pending()).length, 0, "nothing reserved");
  assert.equal(await usdg.f.store.recordSigned(buyFor("buy-small", "1", 2_000_000n, usdg.book)), true);
  // Registered at 0.03 SOL sold a day: the second buy's 0.0398 SOL could not be sold today, which the saved 0.12 would allow.
  const sol = await registeredAt({ dailyUsdg: limits.dailyUsdg, dailyWsol: "30000000" });
  await assert.rejects(sol.f.store.recordSigned(buyFor("buy-2", "1", 10_000_000n, sol.book)), exitReserve);
  // Registered above the saved limits, or before limits were kept: the saved ones bound it, and the same buy is admitted.
  for (const registered of [{ dailyUsdg: "100000000", dailyWsol: "1000000000" }, null]) {
    const roomy = await registeredAt(registered);
    assert.equal(await roomy.f.store.recordSigned(buyFor("buy-2", "1", 10_000_000n, roomy.book)), true, JSON.stringify(registered));
  }
});
test("the exit reserve's planning room: the largest buy it returns keeps room to sell the whole position, valued at up to the tolerance above its cost and counted with the fill margin", () => {
  // What a buy of `usdg` brings, valued at up to the tolerance above its cost, then counted with the fill margin (both rounded up).
  const counted = (usdg: bigint) => ((usdg * 10_300n + 9_999n) / 10_000n * BigInt(10_000 + SOLANA_EXIT_RESERVE_FILL_MARGIN_BPS) + 9_999n) / 10_000n;
  for (const [used, daily, value] of [[0n, 100_000_000n, 0n], [52_000_000n, 100_000_000n, 22_500_000n], [10_000_000n, 25_000_000n, 3_000_000n]] as const) {
    const room = solanaExitReserveBuyRoom({ usedUsdgRaw: used, dailyUsdgRaw: daily, positionValueUsdgRaw: value, toleranceBps: 300 });
    const brought = counted(room);
    assert.equal(used + room + solanaExitReserveUsdg(value + brought, 300) <= daily, true, `${used}/${daily}/${value}`);
    const more = room + room / 100n + 1n, broughtMore = counted(more);
    assert.equal(used + more + solanaExitReserveUsdg(value + broughtMore, 300) <= daily, false, "within 1% of the most that fits");
  }
  assert.equal(solanaExitReserveBuyRoom({ usedUsdgRaw: 75_000_000n, dailyUsdgRaw: 100_000_000n, positionValueUsdgRaw: 25_000_000n, toleranceBps: 300 }), 0n, "no room: none");
  assert.equal(solanaExitReserveUsdg(1_000_000n, 300), 1_030_000n); assert.equal(solanaExitReserveUsdg(1n, 300), 2n, "rounded up");
});
test("live sells are bounded by the signed per-trade and rolling daily SOL sell limits", async t => {
  const f = await fixture(t), first = tenUsdgBuy(); await f.store.recordSigned(first);
  await f.store.settle(OWNER, first.intent.requestId, first.signature, tenUsdgFill(first));
  const revision = (await f.binding.get(TENANT))!.revision;
  await f.binding.settings(TENANT, OWNER, revision, "live", { ...limits, perTradeWsol: "10000000", dailyWsol: "15000000" });
  await assert.rejects(f.store.recordSigned(sale("too-big", "1", "10000001", TEN_BOOK)), /per-trade SOL sell limit/);
  const one = sale("sell-1", "1", "10000000", TEN_BOOK);
  assert.equal(await f.store.recordSigned(one), true);
  await f.store.settle(OWNER, one.intent.requestId, one.signature, { status: "finalized", signature: one.signature, slot: 1002, feeLamports: "10000",
    amountIn: "10000000", amountOut: "5000000", finalizedAtMs: NOW + 1 });
  const after = { slot: 1002, cash: "99000000", wsol: "9800000" };
  await assert.rejects(f.store.recordSigned(sale("sell-2", "2", "6000000", after)), /daily SOL sell limit/);
  assert.equal(await f.store.recordSigned(sale("sell-3", "2", "5000000", after)), true);
});

test("limits beyond the vault's 96 daily operations or a 168-hour permission are refused at save and never admitted (audit core-abi-3, web-auth F4)", async t => {
  const f = await fixture(t), revision = (await f.binding.get(TENANT))!.revision;
  const century = NOW + 100 * 365 * 86_400_000;
  // The settings route and binding store refuse live-shaped limits with a validation error (400).
  await assert.rejects(f.binding.settings(TENANT, OWNER, revision, "live", { ...limits, maxOpsPerDay: 1000 }), /Invalid Solana account settings/);
  await assert.rejects(f.binding.settings(TENANT, OWNER, revision, "live", { ...limits, expiresAtMs: century }), /Invalid Solana account settings/);
  // Stored limits that got past save anyway admit nothing and register no session.
  for (const stored of [{ ...limits, maxOpsPerDay: 1000 }, { ...limits, expiresAtMs: century }]) {
    await f.db.prepare("UPDATE solana_wallet_bindings SET limits_json=? WHERE tenant=?").run(JSON.stringify(stored), TENANT);
    await assert.rejects(f.store.recordSigned(submission()), /between 1 and 96|168 hours/);
    await assert.rejects(f.store.saveSetup({ ...setup("session"), limits: stored }), /between 1 and 96|168 hours/);
  }
  assert.equal((await f.store.pending()).length, 0);
  // A paper account without SOL sell caps is bounded too: at save, and at book creation and every trade for limits stored before that.
  const g = await fixture(t), paperLimits = { perTradeUsdg: limits.perTradeUsdg, dailyUsdg: limits.dailyUsdg, maxOpsPerDay: 1000, maxDrawdownBps: 2000, expiresAtMs: NOW + 3_600_000 };
  await assert.rejects(g.binding.settings(TENANT, OWNER, 1, "paper", paperLimits), /Invalid Solana account settings/);
  await g.db.prepare("UPDATE solana_wallet_bindings SET requested_mode='paper', limits_json=? WHERE tenant=?").run(JSON.stringify(paperLimits), TENANT);
  await assert.rejects(g.store.createPaper(CASH.toString(), paperLimits), /between 1 and 96/);
});

test("autonomous admission is spaced by the strategy interval under the lock, except after a proven expiry (audit agent-deploy F2, G2-2)", async t => {
  for (const outcome of ["expired", "finalized", "failed"] as const) {
    const f = await fixture(t), binding = await f.binding.strategy(TENANT, OWNER, 1, { ...strategy, intervalSeconds: 3_600 });
    const automatic = new SolanaTradingStore(f.db, f.store.scope, () => f.clock.value, { autonomousRevision: binding.revision });
    const first = submission("rebalance-2-0");
    assert.equal(await automatic.recordSigned(first), true);
    await f.store.settle(OWNER, first.intent.requestId, first.signature, outcome === "expired" ? expired(first) : settlement(first, outcome));
    const retry = submission("rebalance-2-1", outcome === "finalized" ? "1" : "0"); retry.risk.slot = 1001;
    if (outcome === "finalized") { retry.risk.cashUsdg = "99400000"; retry.risk.wsolRaw = "1980000"; }
    if (outcome === "expired") {
      assert.equal(await automatic.recordSigned(retry), true, "a dropped packet is retried at once");
      assert.equal(await automatic.recordSigned(first), false, "the expired request is never re-admitted");
    } else await assert.rejects(automatic.recordSigned(retry), /not due/, outcome);
  }
  // The interval passes: due again.
  const f = await fixture(t), binding = await f.binding.strategy(TENANT, OWNER, 1, { ...strategy, intervalSeconds: 60 });
  const automatic = new SolanaTradingStore(f.db, f.store.scope, () => f.clock.value, { autonomousRevision: binding.revision });
  const first = submission("rebalance-2-0"); await automatic.recordSigned(first);
  await f.store.settle(OWNER, first.intent.requestId, first.signature, settlement(first, "failed"));
  f.clock.value = NOW + 60_000;
  const later = submission("rebalance-2-1"); later.preparedAtMs = later.safetyObservedAtMs = later.risk.observedAtMs = later.quote.quotedAtMs = f.clock.value;
  later.quote.expiresAtMs = f.clock.value + 30_000; later.risk.reference = pythBound(later.intent, f.clock.value); later.risk.slot = 1001;
  assert.equal(await automatic.recordSigned(later), true);
  // A manual live trade may not take a strategy request ID.
  await assert.rejects(f.store.recordSigned(submission("rebalance-9-9")), /belong to the autonomous strategy/);
});

test("a live binding saved without SOL sell limits admits no trade", async t => {
  const f = await fixture(t), revision = (await f.binding.get(TENANT))!.revision;
  const { perTradeWsol: _p, dailyWsol: _d, ...unbounded } = limits;
  await f.binding.settings(TENANT, OWNER, revision, "live", unbounded);
  await assert.rejects(f.store.recordSigned(submission()), /SOL sell limits/);
  assert.equal((await f.store.pending()).length, 0);
});



test("each owner transaction kind is proven expired only by state it must change", async t => {
  const proof = (vaultSequence: string | null, sessionEpoch: string | null) => ({ reason: "blockhash-expired" as const, blockHeight: "1201", vaultSequence, sessionEpoch, slot: 1002 });
  const prior = { priorVaultExisted: true, priorSequence: "5", priorSessionEpoch: "1" };
  for (const [kind, accepted, refused] of [
    // A trade landing advanced the sequence: a revoke is still proven by its epoch.
    ["revoke", proof("6", "1"), proof("5", "2")],
    ["session", proof("6", "1"), proof("5", "2")],
    // A withdrawal moves the sequence; the epoch is irrelevant.
    ["withdraw", proof("5", "2"), proof("6", "1")],
  ] as const) {
    const f = await fixture(t);
    await saveSignedSetup(f.store, { ...setup(kind), ...prior, ...(kind === "withdraw" ? { mint: SOLANA_USDG_MINT, amountRaw: "1" } : {}) }, `${kind}-dropped`);
    await assert.rejects(f.store.finishSetup(`${kind}-dropped`, "failed", 1002, refused), /expiry evidence/, kind);
    await f.store.finishSetup(`${kind}-dropped`, "failed", 1002, accepted);
    assert.equal((await f.store.setup())!.status, "failed");
  }
  // A session that would have created the vault: absent, or created with epoch 0 by something else.
  const f = await fixture(t);
  await saveSignedSetup(f.store, { ...setup("session"), priorVaultExisted: false, priorSequence: "0", priorSessionEpoch: "0" }, "first-session");
  await assert.rejects(f.store.finishSetup("first-session", "failed", 1002, proof("0", "1")), /expiry evidence/);
  await f.store.finishSetup("first-session", "failed", 1002, proof(null, null));
});

// REVOKE BESIDE A PENDING OWNER TRANSACTION (solana-trading-store.ts): the revoke slot, on both dialects.
for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  const prior = { priorVaultExisted: true, priorSequence: "1", priorSessionEpoch: "1" };
  const expiry = (vaultSequence: string, sessionEpoch: string) => ({ reason: "blockhash-expired" as const, blockHeight: "1201", vaultSequence, sessionEpoch, slot: 1002 });
  const revokeBeside = (beside: string) => ({ ...setup("revoke"), ...prior, beside, messageBase64: "cmV2b2tl", transactionBase64: "cmV2b2tl" });
  const signedRevoke = (beside: string, signature = "revoke-beside") => ({ ...revokeBeside(beside), signature, signedTransactionBase64: "c2lnbmVkLXJldm9rZQ==", status: "pending" as const });
  const withdrawals = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.db.prepare("SELECT evidence_id,kind,amount_raw FROM solana_runtime_cashflows WHERE kind='withdraw'").all() as
    Array<{ evidence_id: string; kind: string; amount_raw: string }>).map(row => ({ evidence_id: row.evidence_id, kind: row.kind, amount_raw: row.amount_raw }));
  test(`${dialect}: a revocation is saved beside a pending withdrawal in its own slot, and each is finished once by its own signature`, options, async t => {
    const f = await fixture(t, dialect), s = submission();
    await f.store.recordSigned(s); await f.store.settle(OWNER, s.intent.requestId, s.signature, settlement(s));
    await saveSignedSetup(f.store, { ...setup("withdraw"), ...prior, mint: SOLANA_USDG_MINT, amountRaw: "1000000" }, "withdraw-pending");
    const main = await f.store.setup();
    // Nothing else goes in the main slot, and only a revocation beside the pending record it names.
    await assert.rejects(f.store.saveSetup(setup("resume-buys")), /Resolve the previously submitted/);
    await assert.rejects(f.store.saveSetup({ ...setup("resume-buys"), beside: "withdraw-pending" }), /Only a revocation/);
    await assert.rejects(f.store.saveSetup(revokeBeside("another-transaction")), /prepared beside changed/);
    assert.equal(await f.store.saveSetup(revokeBeside("withdraw-pending")), true);
    await assert.rejects(f.store.saveSetup({ ...signedRevoke("withdraw-pending"), preparedAtMs: NOW + 1 }), /changed/, "only the reviewed revocation is signed");
    assert.equal(await f.store.saveSetup(signedRevoke("withdraw-pending")), true);
    assert.equal(await f.store.saveSetup(signedRevoke("withdraw-pending")), false, "the same signed bytes again are already saved");
    await assert.rejects(f.store.saveSetup({ ...revokeBeside("withdraw-pending"), preparedAtMs: NOW + 1 }), /Resolve the previously submitted/, "never a second pending revocation beside it");
    await assert.rejects(f.store.saveSetup({ ...setup("revoke"), ...prior }), /Resolve the previously submitted/, "nor one in the main slot");
    assert.deepEqual(await f.store.setup(), main, "the pending withdrawal's record is kept as it was");
    // The revocation is finished by its own signature while the withdrawal stays pending: trading stays refused.
    await f.store.finishSetup("revoke-beside", "finalized", 1003); await f.store.finishSetup("revoke-beside", "finalized", 1003);
    await assert.rejects(f.store.finishSetup("revoke-beside", "failed"), /cannot be changed/);
    assert.equal((await f.store.revokeSetup())!.status, "finalized"); assert.deepEqual(await f.store.setup(), main);
    await assert.rejects(f.store.recordSigned(submission("during", "1")), /pending owner transaction/);
    // The withdrawal lands: its capital out is booked once, by its signature, whatever is retried.
    const cash = BigInt((await f.store.liveBook())!.cashRaw);
    await f.store.finishSetup("withdraw-pending", "finalized", 1004); await f.store.finishSetup("withdraw-pending", "finalized", 1004);
    assert.equal((await f.store.liveBook())!.cashRaw, (cash - 1_000_000n).toString());
    assert.deepEqual(await withdrawals(f), [{ evidence_id: "withdraw-pending", kind: "withdraw", amount_raw: "1000000" }]);
    await assert.rejects(f.store.finishSetup("unknown-signature", "finalized", 1004), /does not match/);
    // A new main-slot prepare clears the resolved revocation that belonged beside the old record.
    assert.equal(await f.store.saveSetup(setup("resume-buys")), true);
    assert.equal(await f.store.revokeSetup(), null);
  });
  test(`${dialect}: a pending revocation in its own slot holds trades and every other owner transaction until it is finished`, options, async t => {
    const f = await fixture(t, dialect);
    await saveSignedSetup(f.store, { ...setup("withdraw"), ...prior, mint: SOLANA_USDG_MINT, amountRaw: "1" }, "withdraw-dropped");
    await f.store.saveSetup(revokeBeside("withdraw-dropped")); await f.store.saveSetup(signedRevoke("withdraw-dropped"));
    // The withdrawal provably never ran (its sequence unchanged): the pending revocation still holds everything else.
    await f.store.finishSetup("withdraw-dropped", "failed", 1002, expiry("1", "1"));
    for (const next of [setup("resume-buys"), { ...setup("withdraw"), ...prior, mint: SOLANA_USDG_MINT, amountRaw: "1" }, { ...setup("revoke"), ...prior }]) {
      await assert.rejects(f.store.saveSetup(next), /Resolve the previously submitted/, next.kind);
    }
    await assert.rejects(f.store.recordSigned(submission()), /pending owner transaction/);
    // The revocation is proven by its epoch alone, then the owner may act again.
    await assert.rejects(f.store.finishSetup("revoke-beside", "failed", 1002, expiry("1", "2")), /expiry evidence/);
    await f.store.finishSetup("revoke-beside", "failed", 1002, expiry("2", "1"));
    assert.equal(await f.store.saveSetup(setup("resume-buys")), true);
    assert.equal(await f.store.recordSigned(submission()), true);
  });
  test(`${dialect}: a registration and a revocation beside it each prove "never ran" by counting the other's landing once, and the registration is never activated after it`, options, async t => {
    for (const lands of ["revoke", "session", "neither"] as const) {
      const f = await fixture(t, dialect), registration = "registration-pending";
      await saveSignedSetup(f.store, { ...setup("session"), ...prior }, registration);
      await f.store.saveSetup(revokeBeside(registration)); await f.store.saveSetup(signedRevoke(registration));
      if (lands === "revoke") {
        // Before the revocation is known to have run, the moved epoch proves nothing about the registration.
        await assert.rejects(f.store.finishSetup(registration, "failed", 1002, expiry("1", "2")), /expiry evidence/);
        await f.store.finishSetup("revoke-beside", "finalized", 1003);
        await assert.rejects(f.store.finishSetup(registration, "failed", 1002, expiry("1", "1")), /expiry evidence/, "the epoch moved once: an unchanged one is no proof now");
        await f.store.finishSetup(registration, "failed", 1002, expiry("1", "2"));
      } else if (lands === "session") {
        await f.store.finishSetup(registration, "finalized", 1003);
        await assert.rejects(f.store.finishSetup("revoke-beside", "failed", 1002, expiry("1", "1")), /expiry evidence/);
        await f.store.finishSetup("revoke-beside", "failed", 1002, expiry("1", "2"));
        // The revocation never ran, so the registration may be activated (its landing moved the epoch 1 -> 2).
        await f.store.registerSession({ ...f.registered, registrationSignature: registration, sessionEpoch: "2" }, sessionSeed, dek);
        assert.equal(await f.store.revokeSetup(), null, "activation clears the resolved revocation with the registration");
      } else {
        await f.store.finishSetup(registration, "failed", 1002, expiry("1", "1"));
        await f.store.finishSetup("revoke-beside", "failed", 1002, expiry("1", "1"));
      }
    }
    // Both landed (registration first): the owner's later word was to revoke, so the registration is never activated.
    const f = await fixture(t, dialect);
    await saveSignedSetup(f.store, { ...setup("session"), ...prior }, "registration-landed");
    await f.store.saveSetup(revokeBeside("registration-landed")); await f.store.saveSetup(signedRevoke("registration-landed"));
    await f.store.finishSetup("registration-landed", "finalized", 1003);
    await assert.rejects(f.store.registerSession({ ...f.registered, registrationSignature: "registration-landed", sessionEpoch: "2" }, sessionSeed, dek), /revocation was signed after this permission/);
    await f.store.finishSetup("revoke-beside", "finalized", 1004);
    await assert.rejects(f.store.registerSession({ ...f.registered, registrationSignature: "registration-landed", sessionEpoch: "2" }, sessionSeed, dek), /revocation was signed after this permission/);
  });
  test(`${dialect}: a revocation that landed beside a pending owner transaction is kept: another beside it is refused, a registration landing after it is never activated, and a dropped one is still proven never run`, options, async t => {
    const landedRefusal = (error: unknown) => error instanceof Error && error.message === SOLANA_REVOKE_ALREADY_LANDED;
    for (const after of ["lands", "dropped"] as const) {
      const f = await fixture(t, dialect), registration = `registration-${after}`;
      await saveSignedSetup(f.store, { ...setup("session"), ...prior }, registration);
      await f.store.saveSetup(revokeBeside(registration)); await f.store.saveSetup(signedRevoke(registration));
      await f.store.finishSetup("revoke-beside", "finalized", 1003);
      const landed = await f.store.revokeSetup();
      // The owner presses Revoke again (read after the first landed, so at epoch 2): refused, and the landed record is kept as it was.
      await assert.rejects(f.store.saveSetup({ ...revokeBeside(registration), priorSessionEpoch: "2", messageBase64: "c2Vjb25k", transactionBase64: "c2Vjb25k", preparedAtMs: NOW + 5 }), landedRefusal);
      assert.deepEqual(await f.store.revokeSetup(), landed);
      if (after === "lands") {
        // The registration lands after the revocation (epoch 1 -> 2 -> 3): never activated, by the epoch and by the record.
        await f.store.finishSetup(registration, "finalized", 1004);
        await assert.rejects(f.store.registerSession({ ...f.registered, registrationSignature: registration, sessionEpoch: "3" }, sessionSeed, dek), (error: unknown) => error instanceof Error && error.message === SOLANA_REGISTERED_AFTER_REVOKE);
        await assert.rejects(f.store.registerSession({ ...f.registered, registrationSignature: registration, sessionEpoch: "2" }, sessionSeed, dek), /revocation was signed after this permission/);
        assert.equal(await f.store.session().then(item => item?.registrationSignature), "owner-registration", "the earlier session record is untouched");
      } else {
        // The registration never ran: the epoch moved once, by the kept revocation, which is the proof.
        await f.store.finishSetup(registration, "failed", 1002, expiry("1", "2"));
        assert.equal((await f.store.setup())!.status, "failed");
      }
    }
    // Beside a pending withdrawal too: the landed revocation is kept until the withdrawal resolves, then a revocation is prepared as usual.
    const f = await fixture(t, dialect);
    await saveSignedSetup(f.store, { ...setup("withdraw"), ...prior, mint: SOLANA_USDG_MINT, amountRaw: "1" }, "withdraw-pending");
    await f.store.saveSetup(revokeBeside("withdraw-pending")); await f.store.saveSetup(signedRevoke("withdraw-pending"));
    await f.store.finishSetup("revoke-beside", "finalized", 1003);
    await assert.rejects(f.store.saveSetup({ ...revokeBeside("withdraw-pending"), priorSessionEpoch: "2", preparedAtMs: NOW + 5 }), landedRefusal);
    await f.store.finishSetup("withdraw-pending", "failed", 1002, expiry("1", "2"));
    assert.equal(await f.store.saveSetup({ ...setup("revoke"), ...prior, priorSessionEpoch: "2" }), true);
    assert.equal(await f.store.revokeSetup(), null, "the main-slot revocation clears the resolved one beside the old record");
  });
  test(`${dialect}: once a session registered after the landed revocation is live, Revoke beside the same pending record works again, and every landed one is kept as history that still fences and counts`, options, async t => {
    const landedRefusal = (error: unknown) => error instanceof Error && error.message === SOLANA_REVOKE_ALREADY_LANDED;
    const f = await fixture(t, dialect), registration = "registration-disputed";
    await saveSignedSetup(f.store, { ...setup("session"), ...prior }, registration);
    await f.store.saveSetup(revokeBeside(registration)); await f.store.saveSetup(signedRevoke(registration));
    await f.store.finishSetup("revoke-beside", "finalized", 1003);
    const { landed: _none, ...first } = (await f.store.revokeSetup())!;
    const again = { ...revokeBeside(registration), messageBase64: "c2Vjb25k", transactionBase64: "c2Vjb25k", preparedAtMs: NOW + 5, expiresAtMs: NOW + 35_000 };
    // Nothing registered since it landed (the epoch it left, or a cleared session): refused, the landed record kept.
    for (const read of [{ priorSessionEpoch: "2" }, { priorSessionEpoch: "3", session: SOLANA_SYSTEM_PROGRAM }]) {
      await assert.rejects(f.store.saveSetup({ ...again, ...read }), landedRefusal, JSON.stringify(read));
      assert.deepEqual(await f.store.revokeSetup(), first);
    }
    // The registration landed after it (epoch 3, a session set): prepared beside the same record, the landed one kept as history
    // (whatever history the caller offers), still counted by the registration's "never ran" proof.
    assert.equal(await f.store.saveSetup({ ...again, priorSessionEpoch: "3", landed: [] }), true);
    assert.deepEqual((await f.store.revokeSetup())!.landed, [first]);
    assert.equal(solanaOwnerEpochOffset((await f.store.setup())!, await f.store.revokeSetup()), 1);
    // Bytes identical to the landed one are never saved; the reviewed ones are, with the store's history.
    await assert.rejects(f.store.saveSetup({ ...again, priorSessionEpoch: "3", signature: "revoke-beside", signedTransactionBase64: "c2lnbmVkLWFnYWlu", status: "pending" }), /already landed/);
    assert.equal(await f.store.saveSetup({ ...again, priorSessionEpoch: "3", signature: "revoke-again", signedTransactionBase64: "c2lnbmVkLWFnYWlu", status: "pending", landed: [] }), true);
    assert.deepEqual((await f.store.revokeSetup())!.landed, [first]);
    await f.store.finishSetup("revoke-again", "finalized", 1005);
    // Nothing registered since this one either: refused. A session registered after it (outside Merrymen, epoch 5): prepared, both kept.
    await assert.rejects(f.store.saveSetup({ ...again, priorSessionEpoch: "4", preparedAtMs: NOW + 6 }), landedRefusal);
    assert.equal(await f.store.saveSetup({ ...again, priorSessionEpoch: "5", preparedAtMs: NOW + 6 }), true);
    assert.deepEqual((await f.store.revokeSetup())!.landed!.map(item => [item.signature, item.landed]), [["revoke-beside", undefined], ["revoke-again", undefined]]);
    // The registration is finally agreed to have landed, and that last revocation lapses unsigned: the kept history still
    // fences it, whatever epoch its activation names.
    await f.store.finishSetup(registration, "finalized", 1004);
    f.clock.value = NOW + 35_000;
    await assert.rejects(f.store.registerSession({ ...f.registered, registrationSignature: registration, sessionEpoch: "2" }, sessionSeed, dek), /revocation was signed after this permission/);
    assert.equal((await f.store.session())!.registrationSignature, "owner-registration");
  });
  test(`${dialect}: a revocation prepared beside a registration and still signable is never deleted by activating it: activation waits, and the signed revocation then fences it`, options, async t => {
    for (const owner of ["signs", "lets-it-lapse"] as const) {
      const f = await fixture(t, dialect), registration = `registration-${owner}`;
      await saveSignedSetup(f.store, { ...setup("session"), ...prior }, registration);
      await f.store.saveSetup(revokeBeside(registration));
      await f.store.finishSetup(registration, "finalized", 1003);
      const prepared = await f.store.revokeSetup();
      const activate = () => f.store.registerSession({ ...f.registered, registrationSignature: registration, sessionEpoch: "2" }, sessionSeed, dek);
      await assert.rejects(activate(), (error: unknown) => error instanceof Error && error.message === SOLANA_REVOKE_PREPARED_BESIDE);
      assert.deepEqual(await f.store.revokeSetup(), prepared, "the revocation the owner may be signing is kept");
      if (owner === "signs") {
        // Signed within its window beside the now-finalized registration: saved, and the registration is never activated.
        assert.equal(await f.store.saveSetup(signedRevoke(registration)), true);
        await assert.rejects(activate(), /revocation was signed after this permission/);
      } else {
        // Past its window it can no longer be signed and saved: activation goes ahead and clears it.
        f.clock.value = prepared!.expiresAtMs;
        await activate();
        assert.equal(await f.store.revokeSetup(), null);
        assert.equal((await f.store.session())!.registrationSignature, registration);
      }
    }
  });
  test(`${dialect}: a resume-buys with a revocation beside it never re-arms buying, whichever lands first; only one that never ran or lapsed unsigned leaves it to the resume`, options, async t => {
    for (const revocation of ["landed-first", "landed-after", "pending", "never-ran", "signable", "lapsed"] as const) {
      const f = await fixture(t, dialect), s = submission();
      await f.store.recordSigned(s); await f.store.settle(OWNER, s.intent.requestId, s.signature, settlement(s));
      // revoke_all left the vault paused on chain; the off-chain breaker is not (nothing tripped it).
      await saveSignedSetup(f.store, { ...setup("resume-buys"), ...prior }, "resume-pending");
      await f.store.saveSetup(revokeBeside("resume-pending"));
      if (revocation !== "signable" && revocation !== "lapsed") await f.store.saveSetup(signedRevoke("resume-pending"));
      if (revocation === "landed-first") await f.store.finishSetup("revoke-beside", "finalized", 1003);
      if (revocation === "never-ran") await f.store.finishSetup("revoke-beside", "failed", 1002, expiry("1", "1"));
      if (revocation === "lapsed") f.clock.value = NOW + 30_000;
      await f.store.finishSetup("resume-pending", "finalized", 1004);
      if (revocation === "landed-after") await f.store.finishSetup("revoke-beside", "finalized", 1005);
      const paused = !["never-ran", "lapsed"].includes(revocation);
      assert.equal((await f.store.liveBook())!.buyPaused, paused, revocation);
      if (paused && revocation !== "pending" && revocation !== "signable") {
        const buy = submission("buy-after", "1"); buy.risk.slot = 1001; buy.risk.cashUsdg = "99400000"; buy.risk.wsolRaw = "1980000";
        await assert.rejects(f.store.recordSigned(buy), /drawdown breaker/, `${revocation}: no buy is admitted`);
        // A new resume-buys, with nothing beside it, resumes buying as usual.
        await saveSignedSetup(f.store, { ...setup("resume-buys"), ...prior, preparedAtMs: f.clock.value, expiresAtMs: f.clock.value + 30_000 }, "resume-again");
        assert.equal(await f.store.revokeSetup(), null);
        await f.store.finishSetup("resume-again", "finalized", 1006);
        assert.equal((await f.store.liveBook())!.buyPaused, false, revocation);
      }
    }
  });
  test(`${dialect}: receipt recovery finds every account with a pending owner transaction in either slot, a revocation that outlived the record beside it included`, options, async t => {
    const f = await fixture(t, dialect), scope = { tenant: TENANT, owner: OWNER };
    assert.deepEqual(await solanaPendingOwnerScopes(f.db), [], "the fixture's registration is finished and activated");
    await saveSignedSetup(f.store, { ...setup("withdraw"), ...prior, mint: SOLANA_USDG_MINT, amountRaw: "1" }, "withdraw-pending");
    assert.deepEqual(await solanaPendingOwnerScopes(f.db), [scope]);
    await f.store.saveSetup(revokeBeside("withdraw-pending"));
    assert.deepEqual(await solanaPendingOwnerScopes(f.db), [scope], "an unsigned revocation is nothing to recover, and the account is listed once");
    await f.store.saveSetup(signedRevoke("withdraw-pending"));
    assert.deepEqual(await solanaPendingOwnerScopes(f.db), [scope]);
    assert.deepEqual((await solanaPendingOwnerTransactions(f.db)).map(item => [item.slot, item.signature, item.kind, item.preparedAtMs, item.priorSequence]),
      [["main", "withdraw-pending", "withdraw", NOW, "1"], ["revoke", "revoke-beside", "revoke", NOW, "1"]], "both slots, for the operator's stuck alert and list");
    // The withdrawal resolves; the revocation beside it is still pending: the account is still recovered.
    await f.store.finishSetup("withdraw-pending", "failed", 1002, expiry("1", "1"));
    assert.equal((await f.store.setup())!.status, "failed");
    assert.deepEqual(await solanaPendingOwnerScopes(f.db), [scope]);
    assert.deepEqual((await solanaPendingOwnerTransactions(f.db)).map(item => [item.tenant, item.owner, item.slot, item.signature]), [[TENANT, OWNER, "revoke", "revoke-beside"]]);
    await f.store.finishSetup("revoke-beside", "finalized", 1003);
    assert.deepEqual(await solanaPendingOwnerScopes(f.db), []);
  });
  test(`${dialect}: a registration whose landing did not move the session epoch exactly once is never activated, whatever the records say`, options, async t => {
    const f = await fixture(t, dialect);
    await saveSignedSetup(f.store, { ...setup("session"), ...prior }, "registration-moved");
    await f.store.finishSetup("registration-moved", "finalized", 1003);
    // A revocation outside Merrymen landed first (epoch 1 -> 2), then the registration (-> 3).
    for (const sessionEpoch of ["3", "1", "0"]) {
      await assert.rejects(f.store.registerSession({ ...f.registered, registrationSignature: "registration-moved", sessionEpoch }, sessionSeed, dek),
        (error: unknown) => error instanceof Error && error.message === SOLANA_REGISTERED_AFTER_REVOKE, sessionEpoch);
    }
    await f.store.registerSession({ ...f.registered, registrationSignature: "registration-moved", sessionEpoch: "2" }, sessionSeed, dek);
    assert.equal((await f.store.session())!.registrationSignature, "registration-moved");
  });
  // OWNER WITHDRAWALS MADE OUTSIDE MERRYMEN (solana-trading-store.ts).
  const outsideSignature = (n: number) => base58Encode(new Uint8Array(64).fill(n));
  test(`${dialect}: wrapped SOL withdrawn outside Merrymen lowers the high-water mark by the lower of its value now and its cost basis`, options, async t => {
    for (const [label, cost, usdPerSol] of [["SOL fell since it was bought", 2_000_000n, 500n], ["SOL rose since it was bought", 500_000n, 500n], ["SOL rose after it left", 600_000n, 1_000n]] as const) {
      const f = await fixture(t, dialect);
      // 0.004 SOL held at the given cost; the book's peak 20 USDG.
      await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, OWNER, JSON.stringify({ hwmRaw: "20000000",
        cashRaw: "8000000", wsolRaw: "4000000", costBasisUsdgRaw: cost.toString(), realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 1001, updatedAtMs: NOW }));
      const valuation = withdrawValuation("4000000", NOW, (4_000_000n * usdPerSol / 1_000n).toString(), usdPerSol * 100_000_000n);
      const worth = (() => { const q = BigInt(valuation.quote.minOutAmount), r = BigInt(valuation.reference.referenceOut); return q < r ? q : r; })();
      const { book } = await f.store.reconcileExternalWithdrawals({ withdrawals: [{ signature: outsideSignature(7), slot: 1002, mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "4000000", valuation } as never] });
      const out = worth < cost ? worth : cost;
      assert.equal(book.hwmRaw, (20_000_000n - out).toString(), `${label}: worth ${worth}, cost ${cost}`);
      assert.equal(book.wsolRaw, "0"); assert.equal(book.costBasisUsdgRaw, "0");
    }
  });
  test(`${dialect}: a withdrawal made outside Merrymen is booked once from its own evidence, only after the book's last balances, and never one the app booked`, options, async t => {
    const f = await fixture(t, dialect), s = submission();
    await f.store.recordSigned(s); await f.store.settle(OWNER, s.intent.requestId, s.signature, settlement(s));
    // An in-app withdrawal, booked by its signature.
    await saveSignedSetup(f.store, { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "1", priorSessionEpoch: "1", mint: SOLANA_USDG_MINT, amountRaw: "400000" }, outsideSignature(2));
    await f.store.finishSetup(outsideSignature(2), "finalized", 1002);
    const before = (await f.store.liveBook())!;
    assert.equal(before.cashRaw, "99000000");
    const usdg = (signature: string, slot: number, amountRaw: string) => ({ signature, slot, mint: SOLANA_USDG_MINT, amountRaw });
    // Never what the book already reflects: the app's own withdrawal, or anything at or before the book's creation.
    await assert.rejects(f.store.reconcileExternalWithdrawals({ withdrawals: [usdg(outsideSignature(2), 1003, "400000")] }), /already recorded/);
    await assert.rejects(f.store.reconcileExternalWithdrawals({ withdrawals: [usdg(outsideSignature(3), 1000, "1")] }), /already reflected/);
    await assert.rejects(f.store.reconcileExternalWithdrawals({ withdrawals: [usdg(outsideSignature(3), 1003, "99000001")] }), /more than the recorded USDG/);
    await assert.rejects(f.store.reconcileExternalWithdrawals({ withdrawals: [usdg("not-a-signature", 1003, "1")] }), /Invalid finalized withdrawal evidence/);
    assert.deepEqual(await f.store.liveBook(), before, "a refusal books nothing");
    // solana-recover took all the USDG: capital out, as an in-app withdrawal.
    const { booked, book } = await f.store.reconcileExternalWithdrawals({ withdrawals: [usdg(outsideSignature(3), 1003, "99000000")] });
    assert.deepEqual(booked, [{ signature: outsideSignature(3), mint: SOLANA_USDG_MINT, amountRaw: "99000000" }]);
    assert.equal(book.cashRaw, "0"); assert.equal(book.hwmRaw, (BigInt(before.hwmRaw) - 99_000_000n).toString()); assert.equal(book.slot, 1003);
    assert.deepEqual(await f.store.liveBook(), book);
    await assert.rejects(f.store.reconcileExternalWithdrawals({ withdrawals: [usdg(outsideSignature(3), 1003, "1")] }), /already recorded/);
    // Stranger's WSOL is booked into quarantine by an absolute finalized read, which moves the book's balances point.
    await f.store.reconcileExternalInflows({ cashUsdg: "0", wsolRaw: "1980005", slot: 1004, observedAtMs: NOW, commitment: "finalized" });
    assert.equal((await f.store.liveBook())!.balancesSlot, 1004);
    const wsol = (slot: number, amountRaw: string, valuation?: object) => ({ signature: outsideSignature(4), slot, mint: SOLANA_WRAPPED_SOL_MINT, amountRaw, ...(valuation ? { valuation } : {}) }) as never;
    await assert.rejects(f.store.reconcileExternalWithdrawals({ withdrawals: [wsol(1004, "1980005")] }), /already reflected/);
    // All the WSOL out: quarantine first, then the position at its basis; the mark drops by the lower of what the position
    // part is worth now and its basis. Here SOL is worth more than it cost (0.985 USDG now against 0.6 paid): recorded later
    // than it happened, its value now may exceed what left, so the mark drops by the 0.6 USDG of capital that bought it.
    const valuation = withdrawValuation("1980005");
    const value = (() => { const q = BigInt(valuation.quote.minOutAmount), r = BigInt(valuation.reference.referenceOut); return q < r ? q : r; })();
    const peak = BigInt((await f.store.liveBook())!.hwmRaw), basis = BigInt((await f.store.liveBook())!.costBasisUsdgRaw);
    assert.equal(basis, 600_000n); assert.ok(value * 1_980_000n / 1_980_005n > basis);
    const after = (await f.store.reconcileExternalWithdrawals({ withdrawals: [wsol(1005, "1980005", valuation)] })).book;
    assert.equal(after.wsolRaw, "0"); assert.equal(after.quarantinedWsolRaw, "0"); assert.equal(after.costBasisUsdgRaw, "0"); assert.equal(after.realizedPnlUsdgRaw, book.realizedPnlUsdgRaw);
    assert.equal(after.hwmRaw, (peak > basis ? peak - basis : 0n).toString());
    const flows = (await f.db.prepare("SELECT evidence_id,kind,mint,amount_raw FROM solana_runtime_cashflows WHERE kind='withdraw-external'").all() as Array<Record<string, string>>)
      .sort((a, b) => byEvidence(a.evidence_id!, b.evidence_id!));
    assert.deepEqual(flows.map(r => [r.evidence_id, r.mint, r.amount_raw]), [[`external:${outsideSignature(3)}:${SOLANA_USDG_MINT}`, SOLANA_USDG_MINT, "99000000"],
      [`external:${outsideSignature(4)}:${SOLANA_WRAPPED_SOL_MINT}`, SOLANA_WRAPPED_SOL_MINT, "1980005"]].sort((a, b) => byEvidence(a[0]!, b[0]!)));
  });
}

for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  test(`${dialect}: an in-app withdrawal the wallet broadcast itself and the owner recorded as made outside Merrymen first is booked once: its bytes are refused afterwards, and never booked again`, options, async t => {
    const f = await fixture(t, dialect), s = submission();
    await f.store.recordSigned(s); await f.store.settle(OWNER, s.intent.requestId, s.signature, settlement(s));
    const start = (await f.store.liveBook())!, signature = base58Encode(new Uint8Array(64).fill(9));
    const prepared = { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "1", priorSessionEpoch: "1", mint: SOLANA_USDG_MINT, amountRaw: "1000000" };
    await f.store.saveSetup(prepared);
    // The wallet broadcast the signed bytes itself; the owner records them under "Withdrew outside Merrymen?".
    await f.store.reconcileExternalWithdrawals({ withdrawals: [{ signature, slot: 1003, mint: SOLANA_USDG_MINT, amountRaw: "1000000" }] });
    // The page's resubmit of the same signed bytes, still inside the prepare window: refused before anything is saved.
    await assert.rejects(f.store.saveSetup({ ...prepared, signature, signedTransactionBase64: "c2lnbmVk", status: "pending" }),
      (error: unknown) => error instanceof Error && error.message === SOLANA_WITHDRAWAL_RECORDED_OUTSIDE);
    assert.equal((await f.store.setup())!.signature, undefined);
    await assert.rejects(f.store.finishSetup(signature, "finalized", 1003), /does not match/);
    assert.equal(BigInt(start.cashRaw) - BigInt((await f.store.liveBook())!.cashRaw), 1_000_000n, "one 1 USDG withdrawal moves the book by 1 USDG");
    // Already saved as the app's own when it was recorded outside (an earlier version, or a repaired row): finished without booking again.
    const g = await fixture(t, dialect), gs = submission();
    await g.store.recordSigned(gs); await g.store.settle(OWNER, gs.intent.requestId, gs.signature, settlement(gs));
    const gStart = (await g.store.liveBook())!;
    await saveSignedSetup(g.store, prepared, signature);
    await g.db.prepare("INSERT INTO solana_runtime_cashflows(evidence_id,tenant,owner,kind,mint,amount_raw,created_at_ms) VALUES(?,?,?,'withdraw-external',?,?,?)")
      .run(`external:${signature}:${SOLANA_USDG_MINT}`, TENANT, OWNER, SOLANA_USDG_MINT, "1000000", NOW);
    await g.db.prepare("UPDATE solana_runtime_live_books SET book_json=? WHERE tenant=? AND owner=?").run(JSON.stringify({ ...gStart, cashRaw: (BigInt(gStart.cashRaw) - 1_000_000n).toString() }), TENANT, OWNER);
    await g.store.finishSetup(signature, "finalized", 1003);
    assert.equal((await g.store.setup())!.status, "finalized");
    assert.equal(BigInt(gStart.cashRaw) - BigInt((await g.store.liveBook())!.cashRaw), 1_000_000n);
    assert.equal(await g.db.prepare("SELECT 1 FROM solana_runtime_cashflows WHERE evidence_id=?").get(signature), undefined, "no second evidence row");
  });
  test(`${dialect}: an owner withdrawal larger than the book is never saved, unsigned or signed, so one that lands can always be booked`, options, async t => {
    const f = await fixture(t, dialect);
    await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, OWNER, JSON.stringify({ hwmRaw: "90000000",
      cashRaw: "90000000", wsolRaw: "10", quarantinedWsolRaw: "5", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 1001, updatedAtMs: NOW }));
    const withdraw = (mint: string, amountRaw: string, extra: object = {}) => ({ ...setup("withdraw"), priorVaultExisted: true, priorSequence: "1", priorSessionEpoch: "1", mint, amountRaw, ...extra });
    // At prepare: never more than the book (WSOL: position, quarantine and what this transaction syncs).
    await assert.rejects(f.store.saveSetup(withdraw(SOLANA_USDG_MINT, "90000001")), (error: unknown) => error instanceof Error && error.message === SOLANA_WITHDRAWAL_ABOVE_BOOK);
    await assert.rejects(f.store.saveSetup(withdraw(SOLANA_WRAPPED_SOL_MINT, "21", { syncedWsolRaw: "5" })), (error: unknown) => error instanceof Error && error.message === SOLANA_WITHDRAWAL_ABOVE_BOOK);
    assert.equal(await f.store.saveSetup(withdraw(SOLANA_WRAPPED_SOL_MINT, "20", { syncedWsolRaw: "5" })), true);
    // The book drops under a prepared withdrawal: 60 USDG recorded as withdrawn outside Merrymen meanwhile.
    const prepared = withdraw(SOLANA_USDG_MINT, "90000000");
    assert.equal(await f.store.saveSetup(prepared), true);
    await f.store.reconcileExternalWithdrawals({ withdrawals: [{ signature: base58Encode(new Uint8Array(64).fill(8)), slot: 1003, mint: SOLANA_USDG_MINT, amountRaw: "60000000" }] });
    // Its signed save is refused: saved pending, its landing would exceed the book and hold everything forever.
    await assert.rejects(f.store.saveSetup({ ...prepared, signature: "withdraw-above-book", signedTransactionBase64: "c2lnbmVk", status: "pending" }),
      (error: unknown) => error instanceof Error && error.message === SOLANA_WITHDRAWAL_ABOVE_BOOK);
    assert.equal((await f.store.setup())!.signature, undefined);
    // What the book still covers is saved and signed as before.
    const fits = withdraw(SOLANA_USDG_MINT, "30000000");
    await saveSignedSetup(f.store, fits, "withdraw-fits");
    await f.store.finishSetup("withdraw-fits", "finalized", 1004);
    assert.equal((await f.store.liveBook())!.cashRaw, "0");
  });
}

for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  const signatureOf = (n: number) => base58Encode(new Uint8Array(64).fill(n));
  const flows = async (f: Awaited<ReturnType<typeof fixture>>) => (await f.db.prepare("SELECT evidence_id,kind,mint,amount_raw FROM solana_runtime_cashflows WHERE evidence_id LIKE 'external%'").all() as
    Array<Record<string, string>>).sort((a, b) => byEvidence(a.evidence_id!, b.evidence_id!)).map(row => [row.evidence_id, row.kind, row.amount_raw]);
  test(`${dialect}: inflows are booked from balances: a sweep's unbooked inflow is booked as a status read just before it would, so it leaves the same high-water mark as the in-app path (owner decision)`, options, async t => {
    // Book 100 USDG, peak 100. Off the books 40 USDG left the vault (a leaked session), then the owner deposited 50: the vault holds 110.
    const results: Array<{ path: string; hwmRaw: string; cashRaw: string }> = [];
    for (const path of ["in-app", "outside"] as const) {
      const f = await fixture(t, dialect);
      await f.db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, OWNER, JSON.stringify({ hwmRaw: "100000000",
        cashRaw: "100000000", wsolRaw: "0", costBasisUsdgRaw: "0", realizedPnlUsdgRaw: "0", networkFeesLamports: "0", slot: 1001, updatedAtMs: NOW, balancesSlot: 1001 }));
      if (path === "in-app") {
        // A status read (or the withdrawal prepare's) books the 10 above the book, then the owner withdraws all 110 in the app.
        await f.store.reconcileExternalInflows({ cashUsdg: "110000000", wsolRaw: "0", slot: 1002, observedAtMs: NOW, commitment: "finalized" });
        await saveSignedSetup(f.store, { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "5", priorSessionEpoch: "1", mint: SOLANA_USDG_MINT, amountRaw: "110000000" }, signatureOf(20));
        await f.store.finishSetup(signatureOf(20), "finalized", 1003);
      } else {
        // solana-recover sweeps all 110 before any read: its pre-transaction balance books the same 10, then the withdrawal.
        await f.store.reconcileExternalWithdrawals({ withdrawals: [{ signature: signatureOf(21), slot: 1003, mint: SOLANA_USDG_MINT, amountRaw: "110000000", preRaw: "110000000" }] });
      }
      const book = (await f.store.liveBook())!;
      results.push({ path, hwmRaw: book.hwmRaw, cashRaw: book.cashRaw });
    }
    assert.deepEqual(results, [{ path: "in-app", hwmRaw: "0", cashRaw: "0" }, { path: "outside", hwmRaw: "0", cashRaw: "0" }],
      "both net the 40 lost against the 50 deposited; neither path keeps the loss in the peak");
  });
  test(`${dialect}: a sweep outside Merrymen that also took an inflow no status read booked yet books that inflow first, then the withdrawal, and the book is free again`, options, async t => {
    // USDG: 1 USDG deposited after the last read, then solana-recover took the whole balance.
    {
      const f = await fixture(t, dialect), s = submission();
      await f.store.recordSigned(s); await f.store.settle(OWNER, s.intent.requestId, s.signature, settlement(s));
      const before = (await f.store.liveBook())!, all = BigInt(before.cashRaw) + 1_000_000n, sweep = signatureOf(10);
      const usdg = (preRaw?: string) => ({ signature: sweep, slot: 1003, mint: SOLANA_USDG_MINT, amountRaw: all.toString(), ...(preRaw === undefined ? {} : { preRaw }) });
      // Without the vault's own balance just before it, or one below the amount, it stays refused, and nothing is booked.
      for (const preRaw of [undefined, (all - 1n).toString(), "not-a-number"]) {
        await assert.rejects(f.store.reconcileExternalWithdrawals({ withdrawals: [usdg(preRaw)] }), /more than the recorded USDG|Invalid finalized withdrawal evidence/, String(preRaw));
      }
      assert.deepEqual(await f.store.liveBook(), before); assert.deepEqual(await flows(f), []);
      const { book } = await f.store.reconcileExternalWithdrawals({ withdrawals: [usdg(all.toString())] });
      assert.equal(book.cashRaw, "0"); assert.equal(book.wsolRaw, before.wsolRaw);
      const peak = BigInt(before.hwmRaw) + 1_000_000n - all;
      assert.equal(book.hwmRaw, (peak > 0n ? peak : 0n).toString(), "deposit in, then everything out: as if the recorded USDG was withdrawn");
      assert.deepEqual(await flows(f), [[`external-in:${sweep}:${SOLANA_USDG_MINT}`, "deposit", "1000000"], [`external:${sweep}:${SOLANA_USDG_MINT}`, "withdraw-external", all.toString()]]);
      // The book matches the vault again: a finalized read books nothing and is not below it.
      await f.store.reconcileExternalInflows({ cashUsdg: "0", wsolRaw: before.wsolRaw, slot: 1004, observedAtMs: NOW, commitment: "finalized" });
      assert.equal((await f.store.liveBook())!.cashRaw, "0");
      await assert.rejects(f.store.reconcileExternalWithdrawals({ withdrawals: [usdg(all.toString())] }), /already recorded/);
    }
    // WSOL: 5 raw sent by a stranger after the last read, then the whole balance swept; and a partial sweep leaves the rest for status.
    {
      const f = await fixture(t, dialect), s = submission();
      await f.store.recordSigned(s); await f.store.settle(OWNER, s.intent.requestId, s.signature, settlement(s));
      const before = (await f.store.liveBook())!, held = BigInt(before.wsolRaw), sweep = signatureOf(11);
      const { book } = await f.store.reconcileExternalWithdrawals({ withdrawals: [{ signature: sweep, slot: 1003, mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: (held + 5n).toString(), preRaw: (held + 5n).toString() }] });
      assert.equal(book.wsolRaw, "0"); assert.equal(book.quarantinedWsolRaw, "0"); assert.equal(book.costBasisUsdgRaw, "0");
      assert.equal(book.hwmRaw, before.hwmRaw, "no valuation: the mark stays put"); assert.equal(book.cashRaw, before.cashRaw);
      assert.deepEqual(await flows(f), [[`external-in:${sweep}:${SOLANA_WRAPPED_SOL_MINT}`, "quarantine", "5"], [`external:${sweep}:${SOLANA_WRAPPED_SOL_MINT}`, "withdraw-external", (held + 5n).toString()]]);
      await f.store.reconcileExternalInflows({ cashUsdg: before.cashRaw, wsolRaw: "0", slot: 1004, observedAtMs: NOW, commitment: "finalized" });
      const g = await fixture(t, dialect), gs = submission();
      await g.store.recordSigned(gs); await g.store.settle(OWNER, gs.intent.requestId, gs.signature, settlement(gs));
      // 9 raw arrived; 4 of them went with a withdrawal of the position plus 4: only those 4 are booked now.
      await g.store.reconcileExternalWithdrawals({ withdrawals: [{ signature: signatureOf(12), slot: 1003, mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: (held + 4n).toString(), preRaw: (held + 9n).toString() }] });
      assert.equal((await g.store.liveBook())!.quarantinedWsolRaw, "0"); assert.equal((await g.store.liveBook())!.wsolRaw, "0");
      await g.store.reconcileExternalInflows({ cashUsdg: (await g.store.liveBook())!.cashRaw, wsolRaw: "5", slot: 1004, observedAtMs: NOW, commitment: "finalized" });
      assert.equal((await g.store.liveBook())!.quarantinedWsolRaw, "5", "the rest is booked by the next finalized read");
    }
  });
}

test("withdrawals made outside Merrymen are refused while a trade or an owner transaction is pending, and without a book", async t => {
  const outside = { signature: base58Encode(new Uint8Array(64).fill(5)), slot: 1003, mint: SOLANA_USDG_MINT, amountRaw: "1" };
  const empty = await fixture(t);
  await assert.rejects(empty.store.reconcileExternalWithdrawals({ withdrawals: [outside] }), /no live trading record/);
  const f = await fixture(t), s = submission(); await f.store.recordSigned(s);
  await assert.rejects(f.store.reconcileExternalWithdrawals({ withdrawals: [outside] }), /pending Solana trades/);
  await f.store.settle(OWNER, s.intent.requestId, s.signature, settlement(s));
  await saveSignedSetup(f.store, setup("revoke"), "revoke-pending");
  await assert.rejects(f.store.reconcileExternalWithdrawals({ withdrawals: [outside] }), /pending owner transaction/);
  await assert.rejects(f.store.reconcileExternalWithdrawals({ withdrawals: [] }), /between one and sixteen/);
});



test("an unbooked excess never blocks admission, a shortfall does, and no sale reaches quarantined SOL", async t => {
  const f = await fixture(t), s = tenUsdgBuy(); await f.store.recordSigned(s);
  await f.store.settle(OWNER, s.intent.requestId, s.signature, tenUsdgFill(s));
  // Dust that finality has not booked yet: the sale sizes against the book alone.
  assert.equal(await f.store.recordSigned(sale("with-dust", "1", "10000000", { slot: 1001, cash: "94000001", wsol: "19800001" })), true);
  const g = await fixture(t), first = tenUsdgBuy(); await g.store.recordSigned(first);
  await g.store.settle(OWNER, first.intent.requestId, first.signature, tenUsdgFill(first));
  await assert.rejects(g.store.recordSigned(sale("whole-chain", "1", "19800001", { slot: 1001, cash: "94000000", wsol: "19800001" })), /quarantined SOL is not traded/);
  await assert.rejects(g.store.recordSigned(sale("short", "1", "10000000", { slot: 1001, cash: "94000000", wsol: "19799999" })), /below the recorded book/);
  await assert.rejects(g.store.recordSigned(sale("short-cash", "1", "10000000", { slot: 1001, cash: "93999999", wsol: "19800000" })), /below the recorded book/);
});

test("a first live book on a vault that already holds WSOL starts with it quarantined instead of refusing forever", async t => {
  const f = await fixture(t), s = submission(); s.risk.wsolRaw = "7";
  assert.equal(await f.store.recordSigned(s), true);
  const book = (await f.store.liveBook())!;
  assert.equal(book.wsolRaw, "0"); assert.equal(book.quarantinedWsolRaw, "7"); assert.equal(book.costBasisUsdgRaw, "0");
});

// The new admission and accounting SQL runs on both dialects; CI runs these against PostgreSQL.
for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  test(`${dialect}: an operator hold refuses live admission, manual or automatic, while owner actions continue`, options, async t => {
    const f = await fixture(t, dialect);
    await setSolanaOperatorHold(f.db, TENANT, "incident", NOW);
    await assert.rejects(f.store.recordSigned(submission()), /operator hold/);
    const binding = await f.binding.strategy(TENANT, OWNER, 1, strategy);
    await assert.rejects(new SolanaTradingStore(f.db, f.store.scope, () => NOW, { autonomousRevision: binding.revision }).recordSigned(submission("auto")), /operator hold/);
    assert.equal((await f.store.pending()).length, 0);
    // Revocation (and any owner transaction) is still prepared and saved.
    assert.equal(await f.store.saveSetup(setup("revoke")), true);
    await releaseSolanaOperatorHold(f.db, TENANT);
    await setSolanaOperatorHold(f.db, "*", "fleet-wide", NOW);
    await assert.rejects(f.store.recordSigned(submission("everyone")), /operator hold/);
  });
  test(`${dialect}: a kill fences a live autonomous admission that captured the strategy before it`, options, async t => {
    const f = await fixture(t, dialect), binding = await f.binding.strategy(TENANT, OWNER, 1, strategy);
    const automatic = new SolanaTradingStore(f.db, f.store.scope, () => NOW, { autonomousRevision: binding.revision });
    assert.equal(await f.binding.disableForKill(TENANT), true);
    await assert.rejects(automatic.recordSigned(submission()), /strategy changed/);
    assert.equal((await f.store.pending()).length, 0);
  });
  test(`${dialect}: no trade is admitted while a withdrawal is prepared, and a stale withdrawal cannot be prepared`, options, async t => {
    const f = await fixture(t, dialect);
    const withdraw = { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "0", priorSessionEpoch: "1", mint: SOLANA_USDG_MINT, amountRaw: "1" };
    await f.store.saveSetup(withdraw);
    await assert.rejects(f.store.recordSigned(submission()), /prepared owner withdrawal/);
    // Once its signing window lapses it can no longer be submitted, so trading resumes.
    f.clock.value = withdraw.expiresAtMs;
    const later = submission("later"); later.preparedAtMs = later.safetyObservedAtMs = later.risk.observedAtMs = later.quote.quotedAtMs = f.clock.value;
    later.quote.expiresAtMs = f.clock.value + 30_000; later.risk.reference = pythBound(later.intent, f.clock.value);
    assert.equal(await f.store.recordSigned(later), true);
    await f.store.settle(OWNER, later.intent.requestId, later.signature, { ...settlement(later), finalizedAtMs: f.clock.value + 1 });
    // The trade ran at sequence 0: a withdrawal still claiming sequence 0 read stale state.
    await assert.rejects(f.store.saveSetup({ ...withdraw, preparedAtMs: f.clock.value, expiresAtMs: f.clock.value + 60_000 }), /vault changed/);
    assert.equal(await f.store.saveSetup({ ...withdraw, priorSequence: "1", preparedAtMs: f.clock.value, expiresAtMs: f.clock.value + 60_000 }), true);
  });
  test(`${dialect}: the durable autonomous schedule counts every attempt and spaces all but proven expiries`, options, async t => {
    const f = await fixture(t, dialect), binding = await f.binding.strategy(TENANT, OWNER, 1, { ...strategy, intervalSeconds: 3_600 });
    assert.deepEqual(await solanaAutonomousSchedule(f.db, f.store.scope, 3_600), { attempt: 0, dueAtMs: 0 });
    const automatic = new SolanaTradingStore(f.db, f.store.scope, () => f.clock.value, { autonomousRevision: binding.revision });
    const first = submission("rebalance-2-0"); assert.equal(await automatic.recordSigned(first), true);
    assert.deepEqual(await solanaAutonomousSchedule(f.db, f.store.scope, 3_600), { attempt: 1, dueAtMs: NOW + 3_600_000 });
    await f.store.settle(OWNER, first.intent.requestId, first.signature, expired(first));
    assert.deepEqual(await solanaAutonomousSchedule(f.db, f.store.scope, 3_600), { attempt: 1, dueAtMs: 0 });
    const retry = submission("rebalance-2-1"); retry.risk.slot = 1001; assert.equal(await automatic.recordSigned(retry), true);
    assert.deepEqual(await solanaAutonomousSchedule(f.db, f.store.scope, 3_600), { attempt: 2, dueAtMs: NOW + 3_600_000 });
    // Expired attempts are counted on this dialect too: with the default allowance they use the operation budget (G2-3).
    await f.store.settle(OWNER, retry.intent.requestId, retry.signature, expired(retry));
    const third = submission("rebalance-2-2"); third.risk.slot = 1001; assert.equal(await automatic.recordSigned(third), true);
  });
  test(`${dialect}: one raw WSOL sent to the vault is quarantined at zero basis, outside equity, the HWM and the position (audit dust)`, options, async t => {
    const f = await fixture(t, dialect), s = submission(); await f.store.recordSigned(s);
    await f.store.settle(OWNER, s.intent.requestId, s.signature, settlement(s));
    const before = (await f.store.liveBook())!;
    const dusted = { cashUsdg: "99400000", wsolRaw: "1980001", slot: 1002, observedAtMs: NOW, commitment: "finalized" as const };
    await f.store.reconcileExternalInflows(dusted); await f.store.reconcileExternalInflows(dusted);
    let book = (await f.store.liveBook())!;
    assert.equal(book.quarantinedWsolRaw, "1"); assert.equal(book.wsolRaw, before.wsolRaw);
    assert.equal(book.hwmRaw, before.hwmRaw); assert.equal(book.costBasisUsdgRaw, before.costBasisUsdgRaw); assert.equal(book.realizedPnlUsdgRaw, "0");
    const flows = await f.db.prepare("SELECT kind,mint,amount_raw FROM solana_runtime_cashflows ORDER BY kind").all() as Array<{ kind: string; mint: string; amount_raw: string }>;
    assert.deepEqual(flows.map(r => ({ kind: r.kind, mint: r.mint, amount_raw: r.amount_raw })), [{ kind: "quarantine", mint: SOLANA_WRAPPED_SOL_MINT, amount_raw: "1" }]);
    // A USDG deposit and more dust in one finalized read: capital-in and quarantine, booked once each.
    await f.store.reconcileExternalInflows({ ...dusted, cashUsdg: "109400000", wsolRaw: "1980003", slot: 1003 });
    book = (await f.store.liveBook())!;
    assert.equal(book.quarantinedWsolRaw, "3"); assert.equal(book.cashRaw, "109400000"); assert.equal(book.hwmRaw, (BigInt(before.hwmRaw) + 10_000_000n).toString());
    // The owner can take it out: a WSOL withdrawal spends quarantine first, at zero basis.
    await saveSignedSetup(f.store, { ...setup("withdraw"), priorVaultExisted: true, priorSequence: "1", priorSessionEpoch: "1", mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "5" }, "sweep");
    await f.store.finishSetup("sweep", "finalized", 1004);
    book = (await f.store.liveBook())!;
    assert.equal(book.quarantinedWsolRaw, "0"); assert.equal(book.wsolRaw, "1979998");
    assert.equal(book.costBasisUsdgRaw, (600000n - 600000n * 2n / 1980000n).toString()); assert.equal(book.hwmRaw, (BigInt(before.hwmRaw) + 10_000_000n).toString());
  });
}

/**
 * A paper market at the fixture's clock: a buy fills 2 WSOL per USDG; while `dust.on`, every sale
 * back to USDG is Jupiter's zero-output answer for exactly that amount, answered at `dust.atMs` (default: now).
 */
function dustMarket(clock: { value: number }, dust: { on: boolean; atMs?: number }): Parameters<typeof createSolanaPaperService>[1] {
  return {
    async readMint(mint) { return { address: mint, program: mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM,
      decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: 1000, observedAtMs: clock.value, buyBlockedReasons: [] }; },
    async quote(intent) {
      if (dust.on && intent.outputMint === SOLANA_USDG_MINT) throw new SolanaMarketError("zero-output", { source: "jupiter", inputMint: intent.inputMint,
        outputMint: intent.outputMint, inAmount: intent.amountRaw, outAmount: "0", minOutAmount: "0", slippageBps: intent.slippageBps, contextSlot: 1000, quotedAtMs: dust.atMs ?? clock.value });
      const out = intent.inputMint === SOLANA_USDG_MINT ? BigInt(intent.amountRaw) * 2n : BigInt(intent.amountRaw) / 2n;
      return { source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: intent.amountRaw, outAmount: out.toString(),
        minOutAmount: (out * 99n / 100n).toString(), slippageBps: intent.slippageBps, contextSlot: 1000, quotedAtMs: clock.value, expiresAtMs: clock.value + 30_000 };
    },
  };
}
/** A paper-mode account holding one WSOL lot bought for 1 USDG, and the write-off that lot qualifies for (dust from now on). */
async function dustBook(f: Awaited<ReturnType<typeof fixture>>) {
  await f.binding.settings(TENANT, OWNER, 1, "paper", limits);
  await f.store.createPaper(CASH.toString(), limits);
  const dust = { on: false } as { on: boolean; atMs?: number };
  const service = createSolanaPaperService(f.store.paper(), dustMarket(f.clock, dust), () => f.clock.value, { owner: OWNER });
  const buy = await service.trade(OWNER, { kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "dust-buy", inputMint: SOLANA_USDG_MINT,
    outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000", slippageBps: 100 });
  dust.on = true;
  const before = (await f.store.paper().get(OWNER))!;
  const input: SolanaPaperWriteOff = { owner: OWNER, mint: SOLANA_WRAPPED_SOL_MINT, amountRaw: buy.outputAmountRaw, expectedVersion: before.version,
    zeroOutputQuote: { source: "jupiter", inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT, inAmount: buy.outputAmountRaw, outAmount: "0",
      minOutAmount: "0", slippageBps: 100, contextSlot: 1000, quotedAtMs: f.clock.value } };
  return { service, dust, buy, before, input };
}
/**
 * PostgreSQL only: a transaction holding the tenant's binding row lock and its paper book row.
 * releaseWhenWaiting(n) commits it once n other backends wait on a lock in this test's schema
 * (or directly on it), and fails if they never do.
 */
async function holdBookLocks(db: Db) {
  const schema = String((await db.prepare("SELECT current_schema() AS s").get() as { s: string }).s);
  let started!: (pid: number) => void, release!: () => void;
  const pid = new Promise<number>(resolve => { started = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const held = db.tx(async tx => {
    await tx.prepare("UPDATE solana_wallet_bindings SET revision=revision WHERE tenant=? AND owner=? AND chain=?").run(TENANT, OWNER, CHAINS.solana);
    await tx.prepare("UPDATE solana_runtime_paper_books SET book_json=book_json WHERE tenant=? AND owner=?").run(TENANT, OWNER);
    started(Number((await tx.prepare("SELECT pg_backend_pid() AS pid").get() as { pid: number }).pid));
    await gate;
  });
  const holderPid = await Promise.race([pid, held.then(() => assert.fail("the lock holder finished early"))]);
  const waiting = async () => Number((await db.prepare(`SELECT count(DISTINCT a.pid) AS n FROM pg_stat_activity a
    WHERE a.pid <> pg_backend_pid() AND a.wait_event_type = 'Lock' AND (? = ANY(pg_blocking_pids(a.pid)) OR EXISTS (
      SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE l.pid = a.pid AND NOT l.granted AND n.nspname = ?))`).get(holderPid, schema) as { n: number | string }).n);
  return {
    async releaseWhenWaiting(count: number) {
      try {
        const deadline = Date.now() + 10_000;
        while (await waiting() < count) {
          if (Date.now() > deadline) assert.fail(`fewer than ${count} transactions ever waited on the held locks`);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      } finally { release(); await held; }
    },
  };
}
const bookCode = (code: SolanaPaperStoreError["code"]) => (error: unknown) => error instanceof SolanaPaperStoreError && error.code === code;
for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  test(`${dialect}: a hosted owner writes off a dust lot under the book lock, once; the book keeps the record and another tenant cannot touch it`, options, async t => {
    const f = await fixture(t, dialect), d = await dustBook(f);
    assert.equal(d.before.positions.length, 1); assert.equal(d.before.version, 1);
    f.clock.value += 1_000;
    const result = await d.service.writeOff(OWNER, SOLANA_WRAPPED_SOL_MINT);
    assert.deepEqual(result.writtenOff, { mint: SOLANA_WRAPPED_SOL_MINT, decimals: 9, amountRaw: d.buy.outputAmountRaw, costBasisUsdgRaw: "1000000",
      realizedPnlRaw: "-1000000", zeroOutputObservedAtMs: f.clock.value, zeroOutputQuote: { ...d.input.zeroOutputQuote, quotedAtMs: f.clock.value },
      writtenOffAtMs: f.clock.value, version: 2 });
    assert.deepEqual(result.positions, []); assert.equal(result.version, 2); assert.equal(result.realizedPnlRaw, "-1000000");
    assert.equal(result.cashRaw, d.before.cashRaw, "cash does not move"); assert.equal(result.hwmRaw, d.before.hwmRaw, "nor does the peak");
    assert.equal(result.trades.length, 1, "no trade is added"); assert.deepEqual(result.writeOffs, [result.writtenOff]);
    assert.equal(result.updatedAtMs, f.clock.value);
    // Durable: the book read afterwards is the one returned.
    const { writtenOff: _record, ...snapshot } = result;
    assert.deepEqual(await f.store.paper().get(OWNER), snapshot);
    // Never twice: the lot is gone, and the same input again is a version conflict that changes nothing.
    await assert.rejects(d.service.writeOff(OWNER, SOLANA_WRAPPED_SOL_MINT), bookCode("no_position"));
    await assert.rejects(Promise.resolve(f.store.paper().writeOff!(d.input)), bookCode("version_conflict"));
    assert.deepEqual(await f.store.paper().get(OWNER), snapshot);
    // Tenant isolation: the same owner under another tenant has no binding, so nothing is read or written.
    await assert.rejects(Promise.resolve(new SolanaTradingStore(f.db, { tenant: OTHER, owner: OWNER }, () => f.clock.value).paper().writeOff!({ ...d.input, expectedVersion: 2 })), /binding is missing/);
    await assert.rejects(Promise.resolve(f.store.paper().writeOff!({ ...d.input, owner: key(90) })), /owner does not match/);
    assert.deepEqual(await f.store.paper().get(OWNER), snapshot);
  });
  test(`${dialect}: two write-offs of the same lot at once apply exactly one`, options, async t => {
    const f = await fixture(t, dialect), d = await dustBook(f);
    // SQLite runs one transaction at a time, so there the version check alone decides. On
    // PostgreSQL a third transaction holds the tenant binding row and the book row until both
    // write-offs are waiting on it, so both start before either can finish: under the binding
    // lock the second reads the first's book and is refused by version; without the lock both
    // read the same book, and the compare-and-set (or nothing) decides instead.
    const holder = dialect === "postgres" ? await holdBookLocks(f.db) : null;
    const settled = Promise.allSettled([f.store.paper().writeOff!(d.input), f.store.paper().writeOff!(d.input)].map(p => Promise.resolve(p)));
    if (holder) await holder.releaseWhenWaiting(2);
    const results = await settled;
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    const refused = results.find(r => r.status === "rejected") as PromiseRejectedResult;
    assert.ok(bookCode("version_conflict")(refused.reason), String(refused.reason));
    const after = (await f.store.paper().get(OWNER))!;
    assert.equal(after.version, 2); assert.equal(after.writeOffs!.length, 1); assert.equal(after.realizedPnlRaw, "-1000000");
  });
}
test("a hosted write-off reads its clock after the book lock: evidence that went stale while it waited writes off nothing", async t => {
  const f = await fixture(t), d = await dustBook(f);
  let unlock!: () => void, entered!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { unlock = resolve; });
  const held = f.db.tx(async () => { entered(); await blocked; }); await acquired;
  const attempt = Promise.resolve(f.store.paper().writeOff!(d.input));
  // Fresh when asked; 30 s old by the time the lock is free.
  f.clock.value += 30_000; unlock(); await held;
  await assert.rejects(attempt, bookCode("stale_safety"));
  assert.deepEqual(await f.store.paper().get(OWNER), d.before);
});
test("a hosted write-off is the owner's alone, in paper mode, and only for a whole lot no route buys back", async t => {
  const f = await fixture(t), d = await dustBook(f);
  // The autonomous strategy never writes a lot off.
  const binding = await f.binding.strategy(TENANT, OWNER, 2, strategy);
  const automatic = new SolanaTradingStore(f.db, f.store.scope, () => f.clock.value, { autonomousRevision: binding.revision });
  await assert.rejects(Promise.resolve(automatic.paper().writeOff!(d.input)), /autonomous Solana strategy cannot write off/);
  // Part of the lot, or an answer with real output, is not dust.
  await assert.rejects(Promise.resolve(f.store.paper().writeOff!({ ...d.input, amountRaw: "1" })), bookCode("not_dust"));
  await assert.rejects(Promise.resolve(f.store.paper().writeOff!({ ...d.input, zeroOutputQuote: { ...d.input.zeroOutputQuote, outAmount: "1000" } })), bookCode("not_dust"));
  await assert.rejects(Promise.resolve(f.store.paper().writeOff!({ ...d.input, zeroOutputQuote: { ...d.input.zeroOutputQuote, minOutAmount: "1" as "0" } })), bookCode("invalid_quote"));
  // Live mode: the paper book is not the one in use.
  await f.binding.settings(TENANT, OWNER, 3, "live", limits);
  await assert.rejects(Promise.resolve(f.store.paper().writeOff!(d.input)), /Paper trading is not the selected Solana mode/);
  assert.deepEqual((await f.store.paper().get(OWNER))!.positions, d.before.positions);
  assert.equal((await f.store.paper().get(OWNER))!.version, 1);
  // An operator hold stops trades, not this owner bookkeeping: back in paper mode, the write-off goes through.
  await f.binding.settings(TENANT, OWNER, 4, "paper", limits);
  await setSolanaOperatorHold(f.db, TENANT, "Reviewing this account.", f.clock.value);
  const done = await f.store.paper().writeOff!(d.input);
  assert.deepEqual(done.positions, []);
});

for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  test(`${dialect}: status reads the rolling USDG and SOL sold use as admission counts it: pending and landed trades, buys and sales, inside 24 hours, until failure or expiry releases them`, options, async t => {
    const f = await fixture(t, dialect), scope = { tenant: TENANT, owner: OWNER };
    assert.deepEqual(await solanaRollingLimitUse(f.db, scope, NOW), { notionalRaw: 0n, soldWsolRaw: 0n });
    // A buy admitted by the store itself (pending): 1 USDG.
    assert.equal(await f.store.recordSigned(submission("rolling-buy")), true);
    assert.deepEqual(await solanaRollingLimitUse(f.db, scope, NOW), { notionalRaw: 1_000_000n, soldWsolRaw: 0n });
    // Sales as admission records them: their proceeds count toward the USDG limit too.
    const row = (id: string, status: string, createdAtMs: number, amountRaw: string, notionalRaw: string) => f.db.prepare(`INSERT INTO solana_runtime_submissions
      (tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(TENANT, OWNER, id, VAULT, `s-${id}`, `sig-${id}`, status, createdAtMs, notionalRaw, JSON.stringify({ intent: { requestId: id, inputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw } }));
    await row("sale-landed", "finalized", NOW - 1000, "40000000", "6000000");
    await row("sale-failed", "failed", NOW - 900, "30000000", "4500000");
    await row("sale-expired", "expired", NOW - 800, "20000000", "3000000");
    await row("sale-old", "finalized", NOW - 86_400_000, "10000000", "1500000");
    assert.deepEqual(await solanaRollingLimitUse(f.db, scope, NOW), { notionalRaw: 7_000_000n, soldWsolRaw: 40_000_000n });
    await assert.rejects(solanaRollingLimitUse(f.db, scope, -1), /Invalid Solana rolling limit query/);
  });
  test(`${dialect}: the web and the Solana worker publish their live rollout digests, and a buy preview is held while they differ`, options, async t => {
    const f = await fixture(t, dialect), scope = { tenant: TENANT, owner: OWNER };
    const env = { MERRYMEN_SOLANA_LIVE_TENANTS: TENANT, ...(dialect === "postgres" ? { DATABASE_URL: "postgres://already-connected" } : {}) };
    const runtime = (more: Record<string, string>, service?: "worker") => createSolanaAppRuntime({ db: f.db, env: { ...env, ...more }, now: () => f.clock.value,
      log: () => {}, ...(service ? { service } : {}) });
    const worker = runtime({ MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "24" }, "worker"), web = runtime({});
    await worker.publishLiveRollout(); f.clock.value += 1; await worker.publishLiveRollout();
    const rows = async () => (await f.db.prepare("SELECT service,fingerprint,seen_at_ms FROM solana_runtime_live_rollout_seen ORDER BY service").all() as
      Array<{ service: string; fingerprint: string; seen_at_ms: number | string }>).map(r => [r.service, r.fingerprint.length, Number(r.seen_at_ms)]);
    assert.deepEqual(await rows(), [["worker", 64, NOW + 1]], "one row per service; the worker's written again with every heartbeat");
    const buy = { kind: "spl-swap", chain: CHAINS.solana, mode: "live", requestId: "held-buy", inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT,
      amountRaw: "1000000", slippageBps: 50 };
    await assert.rejects(web.preview(scope, { mode: "live", intent: buy }), (error: unknown) => error instanceof Error && error.message === SOLANA_LIVE_ROLLOUT_DIFFERS);
    f.clock.value += 1;
    await assert.rejects(web.preview(scope, { mode: "live", intent: buy }), (error: unknown) => error instanceof Error && error.message === SOLANA_LIVE_ROLLOUT_DIFFERS);
    assert.deepEqual(await rows(), [["web", 64, NOW + 1], ["worker", 64, NOW + 1]], "the web's written again only after the interval");
    // Read back as numbers on either database: a worker silent for over 90 s is not compared (the preview goes on, to configuration).
    f.clock.value += 91_000;
    await assert.rejects(web.preview(scope, { mode: "live", intent: buy }), (error: unknown) => error instanceof Error && error.message !== SOLANA_LIVE_ROLLOUT_DIFFERS);
    // The worker started before the web published: it judges the web's row, upserted in place.
    f.clock.value += 30_000; await worker.publishLiveRollout();
    await assert.rejects(worker.preview(scope, { mode: "live", intent: buy }), (error: unknown) => error instanceof Error && error.message === SOLANA_LIVE_ROLLOUT_DIFFERS);
    assert.equal((await rows()).length, 2);
    // A worker heartbeat (read back as a number on either database) beside a worker digest over 90 s old: the web holds buys,
    // whatever the digest said; once the heartbeat is old too, nothing is compared.
    const same = runtime({ MERRYMEN_SOLANA_LIVE_MAX_DAILY_USDG: "24" });
    await assert.rejects(same.preview(scope, { mode: "live", intent: buy }), (error: unknown) => error instanceof Error && error.message !== SOLANA_LIVE_ROLLOUT_DIFFERS);
    f.clock.value += 91_000;
    await f.db.prepare("INSERT INTO solana_runtime_worker_heartbeat(worker,last_seen_at_ms) VALUES('solana',?) ON CONFLICT(worker) DO UPDATE SET last_seen_at_ms=excluded.last_seen_at_ms").run(f.clock.value);
    await assert.rejects(same.preview(scope, { mode: "live", intent: buy }), (error: unknown) => error instanceof Error && error.message === SOLANA_LIVE_ROLLOUT_DIFFERS);
    f.clock.value += 91_000;
    await assert.rejects(same.preview(scope, { mode: "live", intent: buy }), (error: unknown) => error instanceof Error && error.message !== SOLANA_LIVE_ROLLOUT_DIFFERS);
  });
}

for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  test(`${dialect}: a sale that lands above its quote counts its actual proceeds in the rolling window, as the program charges them, so the next buy's exit reserve sees them`, options, async t => {
    // 20 USDG per trade and 50 a day, 0.05 and 0.12 SOL; $500 a SOL, 3% tolerance.
    const f = await fixture(t, dialect), scope = { tenant: TENANT, owner: OWNER };
    await f.binding.settings(TENANT, OWNER, (await f.binding.get(TENANT))!.revision, "live", { ...limits, perTradeUsdg: "20000000" });
    const finalized = (s: SolanaSignedSubmission, amountOut: string): SolanaLiveSettlement => ({ status: "finalized", signature: s.signature, slot: 1001, feeLamports: "10000",
      amountIn: s.intent.amountRaw, amountOut, finalizedAtMs: NOW + 1 });
    const notional = async (id: string) => (await f.db.prepare("SELECT notional_raw FROM solana_runtime_submissions WHERE request_id=?").get(id) as { notional_raw: string }).notional_raw;
    // A 10 USDG buy, booked at its guaranteed 0.0198 SOL: charged the 10 USDG it offered, whatever it received.
    const buy = buyFor("buy-1", "0", 10_000_000n, { slot: 1000, cash: CASH.toString(), wsol: "0" });
    assert.equal(await f.store.recordSigned(buy), true);
    await f.store.settle(OWNER, "buy-1", buy.signature, finalized(buy, "21000000"));
    assert.equal(await notional("buy-1"), "10000000");
    // The whole 0.0198 SOL sold, quoted at 9.9 USDG and reserved at it, lands at 12 USDG (positive slippage): the window counts 12.
    const exit = sale("exit-1", "1", "19800000", { slot: 1001, cash: "90000000", wsol: "21000000" });
    assert.equal(exit.risk.notionalUsdg, "9900000");
    assert.equal(await f.store.recordSigned(exit), true);
    assert.deepEqual(await solanaRollingLimitUse(f.db, scope, NOW), { notionalRaw: 19_900_000n, soldWsolRaw: 19_800_000n });
    const receipt = finalized(exit, "12000000");
    await f.store.settle(OWNER, "exit-1", exit.signature, receipt);
    assert.equal(await notional("exit-1"), "12000000");
    assert.deepEqual(await solanaRollingLimitUse(f.db, scope, NOW), { notionalRaw: 22_000_000n, soldWsolRaw: 19_800_000n });
    // The same evidence again changes nothing.
    await f.store.settle(OWNER, "exit-1", exit.signature, { ...receipt, finalizedAtMs: NOW + 2 });
    assert.equal(await notional("exit-1"), "12000000");
    // A 14 USDG buy, which may leave 0.03004 SOL ($15.02, with the fill margin) to sell, would fit what the quote left (19.9 + 14 + 15.47 <= 50),
    // not what the vault was charged (22 + 14 + 15.47 > 50). A 13 USDG one fits either (22 + 13 + 14.41).
    const book = { slot: 1001, cash: "102000000", wsol: "1200000" };
    await assert.rejects(f.store.recordSigned(buyFor("buy-2", "2", 14_000_000n, book)), (error: unknown) => error instanceof Error && error.message === SOLANA_LIVE_EXIT_RESERVE);
    assert.equal(await f.store.recordSigned(buyFor("buy-3", "2", 13_000_000n, book)), true);
    // A sale that lands at or below its reserved notional keeps it; a failed one books nothing and is released as before.
    await f.store.settle(OWNER, "buy-3", "test-signature-buy-3", { status: "failed", signature: "test-signature-buy-3", slot: 1001, feeLamports: "10000", amountIn: "0", amountOut: "0",
      finalizedAtMs: NOW + 1 });
    assert.equal(await notional("buy-3"), "13000000");
    const low = sale("exit-2", "3", "1200000", book, "600000");
    assert.equal(await f.store.recordSigned(low), true);
    await f.store.settle(OWNER, "exit-2", low.signature, finalized(low, "599000"));
    assert.equal(await notional("exit-2"), low.risk.notionalUsdg);
  });
}

for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  const buy = { kind: "spl-swap", chain: CHAINS.solana, mode: "live", requestId: "web-buy", inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT,
    amountRaw: "1000000", slippageBps: 50 };
  test(`${dialect}: the worker's digest is written with every heartbeat, so a worker on the same settings that beats late is never held as one that publishes none`, options, async t => {
    const f = await fixture(t, dialect), scope = { tenant: TENANT, owner: OWNER };
    const env = { MERRYMEN_SOLANA_LIVE_TENANTS: TENANT, ...(dialect === "postgres" ? { DATABASE_URL: "postgres://already-connected" } : {}) };
    const lines: string[] = [];
    // The worker as runSolanaAgent runs it, and the web, on the same settings and database.
    const worker = solanaWorkerRuntime({ db: f.db, env, now: () => f.clock.value, log: () => {} });
    const web = createSolanaAppRuntime({ db: f.db, env, now: () => f.clock.value, log: line => lines.push(line) });
    const market = { readMint: async () => assert.fail("no mint read"), quote: async () => assert.fail("no quote") } as unknown as Parameters<typeof createSolanaAgent>[0]["market"];
    const agent = createSolanaAgent({ db: f.db, runtime: worker, market, now: () => f.clock.value, postgres: dialect === "postgres", log: () => {} });
    // Two ticks 20 s apart: the second beats inside the publish interval.
    assert.deepEqual(await agent.tick(), []); f.clock.value += 20_000; assert.deepEqual(await agent.tick(), []);
    const beat = await f.db.prepare("SELECT last_seen_at_ms FROM solana_runtime_worker_heartbeat WHERE worker='solana'").get() as { last_seen_at_ms: number | string };
    const digest = await f.db.prepare("SELECT seen_at_ms FROM solana_runtime_live_rollout_seen WHERE service='worker'").get() as { seen_at_ms: number | string };
    assert.equal(Number(digest.seen_at_ms), Number(beat.last_seen_at_ms), "the digest is as fresh as the heartbeat beside it");
    // Then a slow status read keeps it from beating for 75 s: still running, and still on the web's settings. A buy preview is not held
    // (it goes on, to configuration), and no [alert] sends the operator after a publish that does not fail.
    f.clock.value += 75_000;
    await assert.rejects(web.preview(scope, { mode: "live", intent: buy }), (error: unknown) => error instanceof Error && error.message !== SOLANA_LIVE_ROLLOUT_DIFFERS);
    assert.deepEqual(lines.filter(line => line.startsWith("[alert] solana-live-rollout differs")), []);
  });
}
