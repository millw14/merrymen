import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { base58Decode, base58Encode, CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_VAULT_ACCOUNT_SIZE, SOLANA_VAULT_DISCRIMINATOR, SOLANA_VAULT_LOCAL_TEST_PROGRAM, SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { makePgDb, wrapSqlite, type Db } from "./db";
import type { SolanaSignedSubmission } from "./solana-executor";
import { pythBound } from "./solana-reference-price-fixture";
import { listSolanaOwnerResolutions, resolveSolanaOwnerTransaction, runSolanaResolveCommand, solanaOwnerResolveDecision, SolanaResolveError,
  SOLANA_OWNER_RESOLUTION_SUPERSEDED, type SolanaOwnerResolveView, type SolanaOwnerView, type SolanaResolveProvider } from "./solana-resolve";
import { SOLANA_MAINNET_GENESIS_HASH } from "./solana-rpc";
import { ensureSolanaTradingSchema, SolanaTradingStore, type SolanaPreparedSetup } from "./solana-trading-store";

/** npm run solana:resolve -- owner (OPERATOR-REVIEWED RESOLUTION OF A STUCK OWNER TRANSACTION in solana-resolve.ts). */
const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const TENANT = `0x${"11".repeat(20)}` as const;
const OWNER = key(20), VAULT = key(21), SESSION = key(22), PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM;
const NOW = 1_000_000, CASH = 100_000_000n, WITHDRAWAL = key(40), REVOCATION = key(41);
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 3_600_000,
  perTradeWsol: "50000000", dailyWsol: "120000000" };

function submission(id = "trade-1"): SolanaSignedSubmission {
  const quote = { source: "jupiter" as const, inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT,
    inAmount: "1000000", outAmount: "2000000", minOutAmount: "1980000", slippageBps: 100, contextSlot: 1000, quotedAtMs: NOW, expiresAtMs: NOW + 30000 };
  const intent = { kind: "spl-swap" as const, chain: CHAINS.solana, mode: "live" as const, requestId: id, owner: OWNER, vault: VAULT,
    inputMint: quote.inputMint, outputMint: quote.outputMint, amountRaw: quote.inAmount, slippageBps: 100 };
  return { version: 1, intent, programId: PROGRAM, session: SESSION, feePayer: key(23), sessionEpoch: "1", vaultSequence: "0", signature: `signature-${id}`,
    signedTransactionBase64: "dGVzdC1zaWduZWQ=", messageBase64: "dGVzdC1tZXNzYWdl", loadedAddresses: { writable: [], readonly: [] },
    recentBlockhash: key(24), lastValidBlockHeight: "1200", minContextSlot: 1000, minOutAmount: quote.minOutAmount,
    quotedOutAmount: quote.outAmount, inputTokenAccount: key(25), outputTokenAccount: key(26), inputTokenProgram: TOKEN_2022_PROGRAM,
    outputTokenProgram: SOLANA_CLASSIC_TOKEN_PROGRAM, inputBalanceBefore: CASH.toString(), outputBalanceBefore: "0", maxFeeLamports: "3000000",
    feeLamports: "10000", rentLamports: "2039280", preparedAtMs: NOW, safetyObservedAtMs: NOW, quote,
    risk: { observedAtMs: NOW, slot: 1000, notionalUsdg: "1000000", equityUsdg: CASH.toString(), peakEquityUsdg: CASH.toString(), cashUsdg: CASH.toString(), wsolRaw: "0",
      reference: pythBound(intent, NOW) } };
}
const prior = { priorVaultExisted: true, priorSequence: "1", priorSessionEpoch: "1" };
const base = { transactionBase64: "dGVzdA==", messageBase64: "dGVzdA==", blockhash: key(30), lastValidBlockHeight: "1200", programId: PROGRAM, vault: VAULT, session: SESSION, limits,
  preparedAtMs: NOW, expiresAtMs: NOW + 30_000 };
/** A booked live position, and a signed USDG withdrawal pending in the main slot. */
async function fixture(t: TestContext, dialect: "sqlite" | "postgres" = "sqlite") {
  const clock = { value: NOW }; let db: Db;
  if (dialect === "postgres") {
    const url = new URL(process.env.MERRYMEN_TEST_PG_URL!), schema = `solana_owner_${randomUUID().replaceAll("-", "")}`;
    const admin = await makePgDb(url.toString()); await admin.exec(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`); db = await makePgDb(url.toString());
    t.after(async () => { await admin.exec(`DROP SCHEMA ${schema} CASCADE`); });
  } else { const raw = new DatabaseSync(":memory:"); db = wrapSqlite(raw); t.after(() => raw.close()); }
  const bindings = new SqlSolanaBindingStore(async () => db, dialect, () => clock.value);
  await bindings.bind(TENANT, "did:privy:test", OWNER); await bindings.settings(TENANT, OWNER, 0, "live", limits);
  await ensureSolanaTradingSchema(db, dialect === "postgres");
  const store = new SolanaTradingStore(db, { tenant: TENANT, owner: OWNER }, () => clock.value);
  const registration: SolanaPreparedSetup = { kind: "session", ...base };
  await store.saveSetup(registration); await store.saveSetup({ ...registration, signature: "owner-registration", signedTransactionBase64: "c2lnbmVk", status: "pending" });
  await store.finishSetup("owner-registration", "finalized");
  await store.registerSession({ programId: PROGRAM, vault: VAULT, session: SESSION, sessionEpoch: "1", registrationSignature: "owner-registration", registeredAtMs: NOW },
    Buffer.alloc(32, 4).toString("base64"), Buffer.alloc(32, 3));
  const trade = submission(); await store.recordSigned(trade);
  await store.settle(OWNER, trade.intent.requestId, trade.signature, { status: "finalized", signature: trade.signature, slot: 1001, feeLamports: "10000", amountIn: "1000000", amountOut: "1990000", finalizedAtMs: NOW + 1 });
  const withdrawal: SolanaPreparedSetup = { kind: "withdraw", ...base, ...prior, mint: SOLANA_USDG_MINT, amountRaw: "1000000" };
  await store.saveSetup(withdrawal); await store.saveSetup({ ...withdrawal, signature: WITHDRAWAL, signedTransactionBase64: "d2l0aGRyYXc=", status: "pending" });
  return { db, store, clock, postgres: dialect === "postgres" };
}
/** Providers whose view the test sets per label; an Error is thrown. */
function providers(views: Record<string, SolanaOwnerView | Error>, hosts: Record<string, string> = {}) {
  const calls: Array<{ label: string; signature?: string; epochOffset: number }> = [];
  const list: SolanaResolveProvider[] = Object.keys(views).map(label => ({ label, host: hosts[label] ?? `${label.replace(/\W/g, "")}.example`,
    read: async <T>(operation: (read: never) => Promise<T>) => operation(label as never) }));
  const observe = async (read: unknown, owner: string, setup: SolanaPreparedSetup, epochOffset: number): Promise<SolanaOwnerView> => {
    assert.equal(owner, OWNER); calls.push({ label: read as string, signature: setup.signature, epochOffset });
    const view = views[read as string]!; if (view instanceof Error) throw view; return view;
  };
  return { list, observe: observe as never, calls };
}
/** A provider past the last valid height, nothing seen, whose vault moved (a leaked session traded): the app cannot prove it never ran. */
const moved = (blockHeight = "1201", slot = 1300): SolanaOwnerView => ({ outcome: "pending", seen: false, canLand: false, evidence: { blockHeight, vaultSequence: "2", sessionEpoch: "1", slot } });
const landed: SolanaOwnerView = { outcome: "finalized", slot: 1250, err: "null" };
const decisions = async (db: Db) => (await db.prepare("SELECT * FROM solana_operator_owner_resolutions ORDER BY approved_at_ms").all()) as Array<Record<string, unknown>>;

for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  test(`${dialect}: a dropped withdrawal whose vault moved for another reason is booked never-run only when two providers agree on finalized no-receipt evidence, with the operator, reason and evidence recorded`, options, async t => {
    const f = await fixture(t, dialect), book = (await f.store.liveBook())!;
    const pair = providers({ primary: moved("1201", 1300), fallback: moved("1205", 1290) });
    // Show writes nothing.
    const shown = await resolveSolanaOwnerTransaction({ db: f.db, postgres: f.postgres, tenant: TENANT, providers: pair.list, observe: pair.observe, now: () => f.clock.value });
    assert.equal(shown.booked, false); assert.equal(shown.records.length, 1);
    assert.match(shown.lines.join("\n"), new RegExp(`Pending withdrawal ${WITHDRAWAL} for tenant ${TENANT}:`));
    assert.match(shown.lines.join("\n"), /primary: pending: not seen, blockhash expired at finalized height 1201, but the vault moved \(sequence 2, epoch 1 at slot 1300\), so the app cannot prove it never ran/);
    assert.match(shown.lines.join("\n"), /primary and fallback agree: it can be booked as never run\.\nNothing was written/);
    assert.deepEqual(await decisions(f.db), []); assert.equal((await f.store.setup())!.status, "pending");
    // Booked: recorded first, then finished by the store with the operator's proof, from the earliest bank read.
    f.clock.value = NOW + 60_000;
    const booked = await resolveSolanaOwnerTransaction({ db: f.db, postgres: f.postgres, tenant: TENANT, signature: WITHDRAWAL, providers: pair.list, observe: pair.observe,
      now: () => f.clock.value, book: { operator: "milla", reason: "leaked session traded; both providers have no receipt" } });
    assert.equal(booked.booked, true); assert.match(booked.lines.at(-1)!, /^Booked the withdrawal as never run, recorded as decided by milla\.$/);
    const [row] = await decisions(f.db);
    const setup = (await f.store.setup())!;
    assert.equal(setup.status, "failed");
    assert.deepEqual(setup.expiryProof, { reason: "operator-no-receipt", blockHeight: "1205", vaultSequence: "2", sessionEpoch: "1", slot: 1290, resolution: row!.id });
    assert.equal(row!.operator, "milla"); assert.equal(row!.outcome, "failed"); assert.equal(row!.basis, "no-receipt"); assert.equal(row!.signature, WITHDRAWAL);
    assert.equal(Number(row!.booked_at_ms), NOW + 60_000); assert.equal(row!.refusal, null);
    const evidence = JSON.parse(row!.evidence_json as string);
    assert.deepEqual(evidence.agreed, ["primary", "fallback"]); assert.equal(evidence.kind, "withdraw"); assert.equal(evidence.slot, "main");
    assert.deepEqual(evidence.providers.map((p: { label: string; observation: SolanaOwnerView }) => [p.label, p.observation.outcome]), [["primary", "pending"], ["fallback", "pending"]]);
    assert.ok(!JSON.stringify(row).includes(".example"), "hostnames are recorded only as a hash");
    // Never run: no capital out, the book is untouched, and the owner and trading are free again.
    assert.deepEqual(await f.store.liveBook(), book);
    assert.deepEqual(await f.db.prepare("SELECT evidence_id FROM solana_runtime_cashflows WHERE kind='withdraw'").all(), []);
    assert.equal(await f.store.saveSetup({ kind: "resume-buys", ...base, preparedAtMs: f.clock.value, expiresAtMs: f.clock.value + 30_000 }), true);
    // Run again: already finished, nothing more, and the run fails.
    await assert.rejects(resolveSolanaOwnerTransaction({ db: f.db, postgres: f.postgres, tenant: TENANT, signature: WITHDRAWAL, providers: pair.list, observe: pair.observe,
      now: () => f.clock.value, book: { operator: "milla", reason: "again" } }), /No owner transaction with that signature|already failed/);
    assert.equal((await decisions(f.db)).length, 1);
    assert.deepEqual((await listSolanaOwnerResolutions(f.db, TENANT, f.postgres)).map(r => [r.signature, r.outcome, r.basis, r.operator, r.bookedAtMs]),
      [[WITHDRAWAL, "failed", "no-receipt", "milla", NOW + 60_000]]);
  });
  test(`${dialect}: a receipt two providers agree on finishes the withdrawal and books its capital out once`, options, async t => {
    const f = await fixture(t, dialect), cash = BigInt((await f.store.liveBook())!.cashRaw);
    // The configured pair: the fallback withholds. A third provider agrees with the primary.
    const three = providers({ primary: landed, fallback: { outcome: "pending", seen: false, canLand: false }, "operator's provider": landed });
    const booked = await resolveSolanaOwnerTransaction({ db: f.db, postgres: f.postgres, tenant: TENANT, signature: WITHDRAWAL, providers: three.list, observe: three.observe,
      now: () => f.clock.value, book: { operator: "milla", reason: "fallback withholds it" } });
    assert.equal(booked.booked, true);
    assert.equal((await f.store.setup())!.status, "finalized"); assert.equal((await f.store.setup())!.finalizedSlot, 1250);
    assert.equal((await f.store.liveBook())!.cashRaw, (cash - 1_000_000n).toString());
    assert.deepEqual((await f.db.prepare("SELECT evidence_id FROM solana_runtime_cashflows WHERE kind='withdraw'").all() as Array<{ evidence_id: string }>).map(r => r.evidence_id), [WITHDRAWAL]);
    // The app finishing it again (same receipt) books nothing more.
    await f.store.finishSetup(WITHDRAWAL, "finalized", 1250);
    assert.equal((await f.store.liveBook())!.cashRaw, (cash - 1_000_000n).toString());
  });
}

test("nothing is booked unless two counted providers on their own hostnames agree, none has seen it, every counted one could be read, and its blockhash cannot land", async t => {
  const f = await fixture(t);
  const cases: Array<[string, Record<string, SolanaOwnerView | Error>, RegExp, Record<string, string>?]> = [
    ["one provider", { primary: moved() }, /Two providers on their own hostnames/],
    ["two labels, one hostname", { primary: moved(), fallback: moved() }, /Every provider must be on its own hostname/, { primary: "same.example", fallback: "same.example" }],
    ["a provider saw it", { primary: moved(), fallback: moved(), "operator's provider": { outcome: "pending", seen: true, canLand: false } }, /has seen this signature/],
    ["a provider could not be read", { primary: moved(), fallback: moved(), "operator's provider": new Error("timeout") }, /could not be read/],
    ["it can still land", { primary: moved(), fallback: { outcome: "pending", seen: false, canLand: true } }, /can still land/],
    ["no vault evidence", { primary: moved(), fallback: { outcome: "pending", seen: false, canLand: false } }, /Two providers on their own hostnames/],
    ["a lone receipt", { primary: landed, fallback: moved() }, /Only one provider reports this receipt/],
    ["receipts disagree", { primary: landed, fallback: { ...landed, slot: 1251 } }, /different final outcomes/],
    ["a receipt against a proven expiry", { primary: landed, fallback: { outcome: "expired", proof: { reason: "blockhash-expired", blockHeight: "1201", vaultSequence: "1", sessionEpoch: "1", slot: 1300 } }, "operator's provider": landed }, /different final outcomes/],
  ];
  for (const [name, views, reason, hosts] of cases) {
    const p = providers(views, hosts);
    await assert.rejects(resolveSolanaOwnerTransaction({ db: f.db, tenant: TENANT, signature: WITHDRAWAL, providers: p.list, observe: p.observe, now: () => f.clock.value,
      book: { operator: "milla", reason: "test" } }), (error: unknown) => error instanceof SolanaResolveError && reason.test(error.message), name);
  }
  assert.deepEqual(await decisions(f.db), [], "a refused decision is never recorded as booked: nothing is recorded at all");
  assert.equal((await f.store.setup())!.status, "pending");
  // An excluded provider's sighting still refuses "never ran"; its error does not (it is set aside).
  const excludedSaw = providers({ primary: moved(), fallback: moved(), "operator's provider": { outcome: "pending", seen: true, canLand: false } });
  await assert.rejects(resolveSolanaOwnerTransaction({ db: f.db, tenant: TENANT, signature: WITHDRAWAL, providers: excludedSaw.list, observe: excludedSaw.observe, exclude: "operator's provider",
    now: () => f.clock.value, book: { operator: "milla", reason: "test" } }), /has seen this signature/);
  const excludedDown = providers({ primary: moved(), fallback: new Error("down"), "operator's provider": moved("1210", 1310) });
  const booked = await resolveSolanaOwnerTransaction({ db: f.db, tenant: TENANT, signature: WITHDRAWAL, providers: excludedDown.list, observe: excludedDown.observe, exclude: "fallback",
    now: () => f.clock.value, book: { operator: "milla", reason: "fallback down" } });
  assert.equal(booked.booked, true);
  assert.deepEqual(JSON.parse((await decisions(f.db))[0]!.evidence_json as string).providers.map((p: { label: string; excluded?: boolean; error?: string }) => [p.label, !!p.excluded, p.error ?? null]),
    [["primary", false, null], ["fallback", true, "Its answer could not be read."], ["operator's provider", false, null]]);
});

test("the decision function: in-app expiry proofs are booked as such, mixed evidence as the operator's from the earliest bank", () => {
  const view = (label: string, observation: SolanaOwnerView, excluded = false): SolanaOwnerResolveView => ({ label, hostId: label, observation, ...(excluded ? { excluded: true as const } : {}) });
  const proof = (slot: number) => ({ reason: "blockhash-expired" as const, blockHeight: "1201", vaultSequence: "1", sessionEpoch: "1", slot });
  // Both prove it: the proof read at the lower slot is booked, never the first provider's own (the lowest-slot rule).
  const both = solanaOwnerResolveDecision([view("a", { outcome: "expired", proof: proof(1300) }), view("b", { outcome: "expired", proof: proof(1290) })]);
  assert.deepEqual(both, { book: true, status: "failed", slot: 1290, basis: "expiry", proof: proof(1290), agreed: ["a", "b"] });
  // One provider's proof read far past the other's fresh finalized slot books nothing: its slot would floor every later owner read.
  const inflated = solanaOwnerResolveDecision([view("a", { outcome: "expired", proof: proof(1_000_000_000), fresh: 1300 }),
    view("b", { outcome: "expired", proof: proof(1290), fresh: 1300 })]);
  assert.equal(inflated.book, false);
  assert.match((inflated as { reason: string }).reason, /far past another provider's current finalized slot/);
  const mixed = solanaOwnerResolveDecision([view("a", { outcome: "expired", proof: proof(1300) }), view("b", moved("1203", 1280))]);
  assert.deepEqual(mixed, { book: true, status: "failed", slot: 1280, basis: "no-receipt", agreed: ["a", "b"],
    proof: { reason: "operator-no-receipt", blockHeight: "1203", vaultSequence: "2", sessionEpoch: "1", slot: 1280 } });
  // An excluded provider neither agrees nor disagrees on a receipt.
  assert.deepEqual(solanaOwnerResolveDecision([view("a", landed), view("b", landed), view("c", { ...landed, slot: 9 }, true)]), { book: true, status: "finalized", slot: 1250, basis: "receipt", agreed: ["a", "b"] });
});

test("the store accepts an operator no-receipt proof only through an open operator decision, marked in the same transaction", async t => {
  const f = await fixture(t);
  const proof = { reason: "operator-no-receipt" as const, blockHeight: "1201", vaultSequence: "2", sessionEpoch: "1", slot: 1300, resolution: "decision-1" };
  await assert.rejects(f.store.finishSetup(WITHDRAWAL, "failed", 1300, proof), /expiry evidence/, "never through the app's own path");
  // Through the decision path, but with no open decision row: nothing is finished.
  await runSolanaResolveCommand(["owner", "history", TENANT], { db: f.db });
  await assert.rejects(f.store.finishSetupResolution(WITHDRAWAL, "failed", 1300, proof, "decision-1"), /not open/);
  await assert.rejects(f.store.finishSetupResolution(WITHDRAWAL, "failed", 1300, { ...proof, resolution: "another" }, "decision-1"), /expiry evidence/);
  await assert.rejects(f.store.finishSetupResolution(WITHDRAWAL, "failed", 1300, { ...proof, blockHeight: "1200" }, "decision-1"), /expiry evidence/);
  assert.equal((await f.store.setup())!.status, "pending");
});

test("a revocation pending beside the withdrawal is shown and booked by its own signature, with its epoch offset", async t => {
  const f = await fixture(t);
  const revoke: SolanaPreparedSetup = { kind: "revoke", ...base, ...prior, messageBase64: "cmV2b2tl", transactionBase64: "cmV2b2tl", beside: WITHDRAWAL };
  await f.store.saveSetup(revoke); await f.store.saveSetup({ ...revoke, signature: REVOCATION, signedTransactionBase64: "cmV2b2tlZA==", status: "pending" });
  const p = providers({ primary: moved(), fallback: moved() });
  const shown = await resolveSolanaOwnerTransaction({ db: f.db, tenant: TENANT, providers: p.list, observe: p.observe, now: () => f.clock.value });
  assert.deepEqual(shown.records.map(r => [r.slot, r.setup.signature]), [["main", WITHDRAWAL], ["revoke", REVOCATION]]);
  assert.match(shown.lines.join("\n"), /Pending revocation .* \(the revocation beside the main record\):/);
  const booked = await resolveSolanaOwnerTransaction({ db: f.db, tenant: TENANT, signature: REVOCATION, providers: p.list, observe: p.observe, now: () => f.clock.value,
    book: { operator: "milla", reason: "revocation dropped" } });
  assert.equal(booked.booked, true);
  assert.equal((await f.store.revokeSetup())!.status, "failed"); assert.equal((await f.store.setup())!.status, "pending", "the withdrawal is untouched");
  assert.ok(p.calls.filter(call => call.signature === REVOCATION).every(call => call.epochOffset === 0));
});

test("the owner command validates its input before reading anything, and never takes a URL", async t => {
  const f = await fixture(t);
  const env = { MERRYMEN_SOLANA_RPC_MAINNET: "https://primary.example/key", MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: "https://fallback.example/key" };
  for (const argv of [["owner"], ["owner", "show"], ["owner", "book", TENANT, WITHDRAWAL], ["owner", "book", TENANT, WITHDRAWAL, "--operator", "milla"],
    ["owner", "show", TENANT, "--operator", "milla"], ["owner", "show", TENANT, "--exclude", "nobody"], ["owner", "history", TENANT, "extra"]]) {
    await assert.rejects(runSolanaResolveCommand(argv, { db: f.db, env }), (error: unknown) => error instanceof SolanaResolveError && /Usage:/.test(error.message), argv.join(" "));
  }
  await assert.rejects(runSolanaResolveCommand(["owner", "show", TENANT, "https://secret.example/key"], { db: f.db, env }),
    (error: unknown) => error instanceof SolanaResolveError && !error.message.includes("secret.example"));
  await assert.rejects(runSolanaResolveCommand(["owner", "book", TENANT, "not a signature", "--operator", "milla", "--reason", "x"], { db: f.db, env, fetch: (async () => { throw new Error("no reads"); }) as never }),
    /signature/);
  assert.equal(await runSolanaResolveCommand(["owner", "history", TENANT], { db: f.db }), "No operator decisions on owner transactions are recorded for that tenant.");
  // Through the command with injected views (each provider is a real single-endpoint session): show, then book, then history.
  const hosts: string[] = [];
  const observeOwner = (async () => moved()) as never;
  const fetch = (async (url: string, init: { body: string }) => {
    hosts.push(new URL(url).hostname);
    const { id, method } = JSON.parse(init.body);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS_HASH : null }), { headers: { "content-type": "application/json" } });
  }) as never;
  const shown = await runSolanaResolveCommand(["owner", "show", TENANT], { db: f.db, env, fetch, observeOwner, now: () => f.clock.value });
  assert.match(shown, /primary: pending: not seen/); assert.doesNotMatch(shown, /example\/key|https?:/);
  const booked = await runSolanaResolveCommand(["owner", "book", TENANT, WITHDRAWAL, "--operator", "milla", "--reason", "leaked session"], { db: f.db, env, fetch, observeOwner, now: () => f.clock.value });
  assert.match(booked, /Booked the withdrawal as never run, recorded as decided by milla\./);
  assert.match(await runSolanaResolveCommand(["owner", "history", TENANT], { db: f.db }), new RegExp(`${WITHDRAWAL}\\twithdraw\\tfailed \\(no-receipt\\)\\tbooked\\tby milla\\tleaked session`));
  assert.ok(hosts.includes("primary.example") && hosts.includes("fallback.example"), "each configured provider was read");
});

/** The vault account as getAccountInfo returns it: this owner's vault at `seq` and `epoch`. */
function vaultAccount(seq: bigint, epoch: bigint) {
  const data = Buffer.alloc(SOLANA_VAULT_ACCOUNT_SIZE);
  Buffer.from(SOLANA_VAULT_DISCRIMINATOR).copy(data, 0); data[8] = 2; data[9] = 254;
  Buffer.from(base58Decode(OWNER)!).copy(data, 10); Buffer.from(base58Decode(SESSION)!).copy(data, 42);
  data.writeBigUInt64LE(epoch, 74); data.writeBigUInt64LE(seq, 82); data.writeBigInt64LE(1_900_000_000n, 90);
  data.writeBigUInt64LE(10_000_000n, 98); data.writeBigUInt64LE(50_000_000n, 106); data.writeBigUInt64LE(50_000_000n, 114); data.writeBigUInt64LE(120_000_000n, 122);
  data.writeUInt16LE(20, 130);
  return { owner: PROGRAM, executable: false, lamports: 3_000_000, data: [data.toString("base64"), "base64"], space: data.length };
}
test("the CLI's own observer (no injected view) reads each configured provider as the app does: a no-receipt booking and a receipt booking", async t => {
  const env = { MERRYMEN_SOLANA_RPC_MAINNET: "https://primary.example/key", MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: "https://fallback.example/key" };
  // Two providers answering JSON-RPC: the withdrawal either landed at slot 1250, or was never seen and its blockhash expired
  // (finalized height 1205 past 1200) while the vault's sequence moved for another reason (2, prepared at 1).
  const chain = (landed: boolean) => {
    const asked: Array<{ host: string; method: string }> = [];
    const fetch = (async (url: string, init: { body: string }) => {
      const { id, method, params } = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
      asked.push({ host: new URL(url).hostname, method });
      const result = method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS_HASH
        : method === "getSignatureStatuses" ? { context: { slot: 1300 }, value: [landed ? { confirmationStatus: "finalized", slot: 1250, err: null } : null] }
        : method === "getTransaction" ? (landed ? { version: 0, slot: 1250, meta: { err: null }, transaction: ["d2l0aGRyYXc=", "base64"] } : null)
        : method === "getEpochInfo" ? { absoluteSlot: 1300, blockHeight: 1205, epoch: 2, slotIndex: 1300, slotsInEpoch: 432_000 }
        : method === "getAccountInfo" && params[0] === VAULT ? { context: { slot: 1300 }, value: vaultAccount(2n, 1n) }
        : undefined;
      if (result === undefined) throw new Error(`unexpected ${method}`);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json" } });
    }) as never;
    return { fetch, asked };
  };
  {
    const f = await fixture(t), book = (await f.store.liveBook())!, never = chain(false);
    const booked = await runSolanaResolveCommand(["owner", "book", TENANT, WITHDRAWAL, "--operator", "milla", "--reason", "both providers: no receipt, sequence moved"],
      { db: f.db, env, fetch: never.fetch, now: () => f.clock.value });
    assert.match(booked, /primary: pending: not seen, blockhash expired at finalized height 1205, but the vault moved \(sequence 2, epoch 1 at slot 1300\)/);
    assert.match(booked, /Booked the withdrawal as never run, recorded as decided by milla\./);
    const setup = (await f.store.setup())!;
    assert.equal(setup.status, "failed"); assert.equal(setup.expiryProof?.reason, "operator-no-receipt"); assert.equal(setup.expiryProof?.vaultSequence, "2");
    assert.deepEqual(await f.store.liveBook(), book, "never run: no capital out");
    for (const host of ["primary.example", "fallback.example"]) {
      assert.deepEqual([...new Set(never.asked.filter(item => item.host === host).map(item => item.method))].sort(),
        ["getAccountInfo", "getEpochInfo", "getGenesisHash", "getSignatureStatuses", "getTransaction"], host);
    }
  }
  {
    const f = await fixture(t), cash = BigInt((await f.store.liveBook())!.cashRaw), landed = chain(true);
    const booked = await runSolanaResolveCommand(["owner", "book", TENANT, WITHDRAWAL, "--operator", "milla", "--reason", "both providers: receipt"],
      { db: f.db, env, fetch: landed.fetch, now: () => f.clock.value });
    assert.match(booked, /primary: finalized at slot 1250, and the vault shows its effect/);
    assert.match(booked, /Booked the withdrawal as finalized, recorded as decided by milla\./);
    assert.equal((await f.store.setup())!.status, "finalized"); assert.equal((await f.store.setup())!.finalizedSlot, 1250);
    assert.equal((await f.store.liveBook())!.cashRaw, (cash - 1_000_000n).toString());
  }
});

test("a decision the app beat is recorded as superseded and fails the run, never as the one that finished it", async t => {
  const f = await fixture(t);
  const p = providers({ primary: landed, fallback: landed });
  // The app finishes it with the same receipt between the views and the store call.
  const finish = SolanaTradingStore.prototype.finishSetupResolution;
  t.mock.method(SolanaTradingStore.prototype, "finishSetupResolution", async function (this: SolanaTradingStore, ...args: Parameters<SolanaTradingStore["finishSetupResolution"]>) {
    await this.finishSetup(WITHDRAWAL, "finalized", 1250); return finish.apply(this, args);
  });
  const result = await resolveSolanaOwnerTransaction({ db: f.db, tenant: TENANT, signature: WITHDRAWAL, providers: p.list, observe: p.observe, now: () => f.clock.value,
    book: { operator: "milla", reason: "race" } });
  t.mock.restoreAll();
  assert.equal(result.booked, false); assert.match(result.lines.at(-1)!, /recorded as superseded/);
  const [row] = await decisions(f.db);
  assert.equal(row!.booked_at_ms, null); assert.equal(row!.refusal, SOLANA_OWNER_RESOLUTION_SUPERSEDED);
  assert.deepEqual((await f.db.prepare("SELECT evidence_id FROM solana_runtime_cashflows WHERE kind='withdraw'").all() as Array<{ evidence_id: string }>).map(r => r.evidence_id), [WITHDRAWAL], "booked once, by the app");
  await assert.rejects(runSolanaResolveCommand(["owner", "book", TENANT, WITHDRAWAL, "--operator", "milla", "--reason", "again"], { db: f.db, observeOwner: p.observe,
    env: { MERRYMEN_SOLANA_RPC_MAINNET: "https://primary.example/key", MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: "https://fallback.example/key" } }), /already finalized; nothing is booked/);
});
