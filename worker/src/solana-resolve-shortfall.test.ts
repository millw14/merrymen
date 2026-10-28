/**
 * The operator's write-off of a vault shortfall (npm run solana:resolve -- shortfall):
 * two providers on their own hostnames must report the same finalized balances,
 * the decision is recorded first and marked booked with the write-off, and it is
 * booked as a loss. Fake providers and a fake network only; nothing is sent.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getBase58Encoder } from "@solana/kit";
import { base58Encode, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../../packages/core/src/ids";
import { SOLANA_CLASSIC_TOKEN_PROGRAM, SOLANA_VAULT_LOCAL_TEST_PROGRAM, SOLANA_WRAPPED_SOL_MINT, deriveSolanaAta, deriveSolanaVaultAddress } from "../../packages/core/src/solana-live";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { makePgDb, wrapSqlite, type Db } from "./db";
import type { SolanaLiveRead } from "./solana-live-rpc";
import { solanaAccountRef } from "./solana-agent";
import { runSolanaResolveCommand, SolanaResolveError, type SolanaResolveProvider } from "./solana-resolve";
import { listSolanaShortfalls, resolveSolanaShortfall } from "./solana-resolve-shortfall";
import { SOLANA_MAINNET_GENESIS_HASH } from "./solana-rpc";
import { ensureSolanaTradingSchema, SolanaTradingStore, type SolanaLiveBook } from "./solana-trading-store";

const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const TENANT = `0x${"11".repeat(20)}` as const, OWNER = key(20), SESSION = key(22), PROGRAM = SOLANA_VAULT_LOCAL_TEST_PROGRAM;
const NOW = 1_000_000;
const limits = { perTradeUsdg: "10000000", dailyUsdg: "50000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 3_600_000,
  perTradeWsol: "50000000", dailyWsol: "120000000" };
const BOOK: SolanaLiveBook = { hwmRaw: "120000000", cashRaw: "90000000", wsolRaw: "50000000", costBasisUsdgRaw: "10000000", realizedPnlUsdgRaw: "0",
  networkFeesLamports: "0", slot: 1000, updatedAtMs: NOW - 1000 };
const env = { MERRYMEN_SOLANA_VAULT_PROGRAM: PROGRAM, MERRYMEN_SOLANA_RPC_MAINNET: "https://primary.example/?api-key=one",
  MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK: "https://fallback.example/key-two" };

function tokenAccount(mint: string, holder: string, amount: bigint) {
  const b = Buffer.alloc(165); Buffer.from(base58Decode(mint)).copy(b, 0); Buffer.from(base58Decode(holder)).copy(b, 32); b.writeBigUInt64LE(amount, 64); b[108] = 1;
  return { owner: mint === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : SOLANA_CLASSIC_TOKEN_PROGRAM, executable: false, lamports: 2_039_280, data: [b.toString("base64"), "base64"], space: 165 };
}
const base58Decode = (value: string) => getBase58Encoder().encode(value);

async function fixture(t: TestContext, dialect: "sqlite" | "postgres" = "sqlite") {
  const clock = { value: NOW }; let db: Db;
  if (dialect === "postgres") {
    const url = new URL(process.env.MERRYMEN_TEST_PG_URL!), schema = `solana_test_${randomUUID().replaceAll("-", "")}`;
    const admin = await makePgDb(url.toString()); await admin.exec(`CREATE SCHEMA ${schema}`);
    url.searchParams.set("options", `-c search_path=${schema}`); db = await makePgDb(url.toString());
    t.after(async () => { await admin.exec(`DROP SCHEMA ${schema} CASCADE`); });
  } else { const raw = new DatabaseSync(":memory:"); db = wrapSqlite(raw); t.after(() => raw.close()); }
  const bindings = new SqlSolanaBindingStore(async () => db, dialect, () => clock.value);
  await bindings.bind(TENANT, "did:privy:test", OWNER); await bindings.settings(TENANT, OWNER, 0, "live", limits);
  await ensureSolanaTradingSchema(db, dialect === "postgres");
  const vault = await deriveSolanaVaultAddress(PROGRAM, OWNER);
  const cashAta = await deriveSolanaAta(vault, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM), wsolAta = await deriveSolanaAta(vault, SOLANA_WRAPPED_SOL_MINT, SOLANA_CLASSIC_TOKEN_PROGRAM);
  await db.prepare("INSERT INTO solana_runtime_sessions(tenant,owner,record_json,sealed_seed) VALUES(?,?,?,?)").run(TENANT, OWNER,
    JSON.stringify({ programId: PROGRAM, vault, session: SESSION, sessionEpoch: "1", registrationSignature: key(43), registeredAtMs: NOW }), "sealed");
  await db.prepare("INSERT INTO solana_runtime_live_books(tenant,owner,book_json) VALUES(?,?,?)").run(TENANT, OWNER, JSON.stringify(BOOK));
  const store = new SolanaTradingStore(db, { tenant: TENANT, owner: OWNER }, () => clock.value);
  /** One provider's chain: the vault's finalized balances at `slot`, and its finalized slot `fresh`. */
  const chain = (cash: bigint, wsol: bigint, slot = 1005, fresh = slot + 2) => ({ cash, wsol, slot, fresh });
  const reader = (state: ReturnType<typeof chain>, asked: string[] = []): SolanaLiveRead => async (method, params = []) => {
    asked.push(method);
    if (method === "getSlot") return state.fresh;
    if (method === "getMultipleAccounts") {
      const [keys, config] = params as [string[], { commitment: string; minContextSlot: number }];
      assert.deepEqual(keys, [cashAta, wsolAta]); assert.equal(config.commitment, "finalized"); assert.ok(config.minContextSlot >= BOOK.slot, "never older than the book");
      return { context: { slot: state.slot }, value: [tokenAccount(SOLANA_USDG_MINT, vault, state.cash), tokenAccount(SOLANA_WRAPPED_SOL_MINT, vault, state.wsol)] };
    }
    throw new Error(`unexpected ${method}`);
  };
  const provider = (label: string, state: ReturnType<typeof chain> | Error, asked: string[] = [], host = `${label.replace(/\W/g, "")}.example`): SolanaResolveProvider =>
    ({ label, host, read: async <T>(operation: (read: SolanaLiveRead) => Promise<T>) => { if (state instanceof Error) throw state; return operation(reader(state, asked)); } });
  const decisions = async () => await db.prepare("SELECT operator,reason,slot,cash_usdg,wsol_raw,evidence_json,booked_at_ms,refusal FROM solana_operator_shortfalls ORDER BY approved_at_ms").all() as
    Array<{ operator: string; reason: string; slot: number | string; cash_usdg: string; wsol_raw: string; evidence_json: string; booked_at_ms: number | string | null; refusal: string | null }>;
  return { db, store, clock, vault, cashAta, wsolAta, chain, provider, decisions, postgres: dialect === "postgres" };
}

for (const dialect of ["sqlite", "postgres"] as const) {
  const options = dialect === "postgres" && !process.env.MERRYMEN_TEST_PG_URL ? { skip: "Set MERRYMEN_TEST_PG_URL to an isolated PostgreSQL test database." } : {};
  test(`${dialect}: show writes nothing; book writes the shortfall off as a loss once, recorded first, on two providers' agreement at the lower slot`, options, async t => {
    const f = await fixture(t, dialect);
    // 20 USDG left the vault: an issuer's action, say. Both providers see it, one a slot later.
    const asked: string[] = [];
    const list = [f.provider("primary", f.chain(70_000_000n, 50_000_000n, 1006), asked), f.provider("fallback", f.chain(70_000_000n, 50_000_000n, 1005), asked)];
    const run = (book?: { operator: string; reason: string }) => resolveSolanaShortfall({ db: f.db, postgres: f.postgres, account: TENANT, providers: list, env, now: () => f.clock.value,
      ...(book ? { book } : {}) });
    const shown = await run();
    assert.equal(shown.booked, false);
    assert.deepEqual(shown.lines, [
      `Account ${solanaAccountRef({ tenant: TENANT, owner: OWNER })} (tenant ${TENANT}), vault ${f.vault}: its book holds 90 USDG and 0.05 wrapped SOL, at slot 1000.`,
      "  primary: finalized at slot 1006: 70 USDG and 0.05 wrapped SOL",
      "  fallback: finalized at slot 1005: 70 USDG and 0.05 wrapped SOL",
      "primary and fallback agree at slot 1005.",
      "Short 20 USDG: cash falls to 70 USDG, and realized P&L by 20 USDG.",
      "A write-off is a loss, never capital out: the high-water mark stays at 120 USDG, and buying pauses until the owner resumes it.",
      "Ask the owner first whether they withdrew outside Merrymen (the recovery tool or their own wallet): that is capital out, which they record under Owner controls, and nothing is written off here.",
      "Nothing was written. To write it off, run shortfall book with --operator and --reason.",
    ]);
    assert.deepEqual(await f.decisions(), []); assert.deepEqual(await f.store.liveBook(), BOOK);
    assert.ok(asked.every(method => method === "getMultipleAccounts" || method === "getSlot"), asked.join(","));
    // Booked: the decision first, then the loss, at the lower of the two slots; the decision is marked booked.
    const booked = await run({ operator: "milla", reason: "issuer seized 20 USDG (case 1234)" });
    assert.equal(booked.booked, true); assert.equal(booked.lines.at(-1), "Written off, recorded as decided by milla.");
    const after = (await f.store.liveBook())! as SolanaLiveBook & { balancesSlot?: number };
    assert.deepEqual([after.cashRaw, after.wsolRaw, after.realizedPnlUsdgRaw, after.hwmRaw, after.buyPaused, after.slot, after.balancesSlot],
      ["70000000", "50000000", "-20000000", "120000000", true, 1005, 1005]);
    const [decision] = await f.decisions();
    assert.deepEqual([decision!.operator, decision!.reason, Number(decision!.slot), decision!.cash_usdg, decision!.wsol_raw, Number(decision!.booked_at_ms), decision!.refusal],
      ["milla", "issuer seized 20 USDG (case 1234)", 1005, "70000000", "50000000", NOW, null]);
    const evidence = JSON.parse(decision!.evidence_json);
    assert.deepEqual(evidence.providers.map((view: { label: string; balances: { slot: number } }) => [view.label, view.balances.slot]), [["primary", 1006], ["fallback", 1005]]);
    assert.ok(!decision!.evidence_json.includes("example"), "hostnames are hashed, never written");
    // Once: run again, nothing is short and nothing is recorded (the command fails such a book run).
    const again = await run({ operator: "milla", reason: "again" });
    assert.equal(again.booked, false); assert.match(again.lines.at(-1)!, /^Nothing is short/);
    assert.equal((await f.decisions()).length, 1);
    assert.deepEqual((await listSolanaShortfalls(f.db, TENANT, f.postgres)).map(row => [row.slot, row.cashUsdg, row.bookedAtMs !== null, row.operator]), [[1005, "70000000", true, "milla"]]);
  });
}

test("nothing is written off unless two providers on their own hostnames agree, every provider not set aside was read, and none answered far ahead", async t => {
  const f = await fixture(t);
  const short = f.chain(70_000_000n, 50_000_000n), book = { operator: "milla", reason: "issuer seized 20 USDG" };
  const run = (providers: SolanaResolveProvider[], exclude?: string) => resolveSolanaShortfall({ db: f.db, account: TENANT, providers, env, now: () => f.clock.value, book,
    ...(exclude ? { exclude } : {}) });
  const refused = async (providers: SolanaResolveProvider[], reason: RegExp, exclude?: string) => {
    const result = await run(providers, exclude);
    assert.equal(result.booked, false); assert.match(result.lines.at(-1)!, reason);
  };
  // Different balances: a provider that lies or lags.
  await refused([f.provider("primary", short), f.provider("fallback", f.chain(90_000_000n, 50_000_000n))], /^Providers report different finalized balances/);
  // One unreadable: its answer may be the other balances.
  await refused([f.provider("primary", short), f.provider("fallback", new Error("down"))], /^A provider could not be read/);
  // One provider alone.
  await refused([f.provider("primary", short)], /^Fewer than two independent providers/);
  // One answering a slot far beyond what the other has finalized.
  await refused([f.provider("primary", f.chain(70_000_000n, 50_000_000n, 1_000_001_005)), f.provider("fallback", short)], /^A provider answered at a slot far ahead/);
  // Two providers on one hostname are refused outright.
  await assert.rejects(run([f.provider("primary", short), f.provider("fallback", short, [], "primary.example")]), /its own hostname/);
  assert.deepEqual(await f.decisions(), []); assert.deepEqual(await f.store.liveBook(), BOOK);
  // The operator sets the dead provider aside, and a third on its own hostname agrees: written off, the excluded view recorded.
  const result = await run([f.provider("primary", short), f.provider("fallback", new Error("down")), f.provider("operator's provider", short)], "fallback");
  assert.equal(result.booked, true);
  assert.match(result.lines.join("\n"), /fallback: could not be used: .*\(excluded by the operator: shown and recorded, not counted\)/);
  const [decision] = await f.decisions();
  assert.deepEqual(JSON.parse(decision!.evidence_json).excluded, "fallback");
});

test("an account is named by tenant or by the alert's account reference, its own pending trade or owner transaction settles first, and its vault must be the one it trades", async t => {
  const f = await fixture(t), short = f.chain(70_000_000n, 50_000_000n), asked: string[] = [];
  const list = () => [f.provider("primary", short, asked), f.provider("fallback", short, asked)];
  const run = (account: string) => resolveSolanaShortfall({ db: f.db, account, providers: list(), env, now: () => f.clock.value });
  const ref = solanaAccountRef({ tenant: TENANT, owner: OWNER });
  assert.match((await run(ref)).lines.join("\n"), /primary and fallback agree at slot 1005\.\nShort 20 USDG/);
  await assert.rejects(run("0123456789abcdef"), /No live account has that account reference/);
  await assert.rejects(run(`0x${"99".repeat(20)}`), /No Solana wallet binding exists/);
  asked.length = 0;
  // A trade still pending: its landing may be the shortfall, so nothing is read.
  await f.db.prepare(`INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json)
    VALUES(?,?,?,?,?,?,'pending',?,?,?)`).run(TENANT, OWNER, "settling", f.vault, "0", "signature-settling", NOW, "1000000", "{}");
  await assert.rejects(run(TENANT), /live trade of this account is still pending/);
  await f.db.prepare("UPDATE solana_runtime_submissions SET status='failed'").run();
  // So does a signed owner transaction.
  await f.db.prepare("INSERT INTO solana_runtime_setups(tenant,owner,setup_json) VALUES(?,?,?)").run(TENANT, OWNER, JSON.stringify({ kind: "withdraw", signature: "owner-sig",
    status: "pending", preparedAtMs: NOW, expiresAtMs: NOW + 60_000 }));
  await assert.rejects(run(TENANT), /owner transaction of this account is still pending/);
  assert.deepEqual(asked, [], "refused before any provider is asked");
  await f.db.prepare("DELETE FROM solana_runtime_setups").run();
  // A program setting that derives another vault than the account's permission and trades name.
  await assert.rejects(resolveSolanaShortfall({ db: f.db, account: TENANT, providers: list(), env: { ...env, MERRYMEN_SOLANA_VAULT_PROGRAM: key(77) }, now: () => f.clock.value }),
    /does not derive the vault this account's permission or trades name/);
  await assert.rejects(resolveSolanaShortfall({ db: f.db, account: TENANT, providers: list(), env: {}, now: () => f.clock.value }), /Set MERRYMEN_SOLANA_VAULT_PROGRAM/);
  assert.deepEqual(asked, []);
});

test("the shortfall command reads through real single-endpoint transports, names no endpoint, and refuses malformed arguments", async t => {
  const f = await fixture(t), asked: string[] = [];
  const fetch = (async (input: unknown, init?: RequestInit) => {
    const host = new URL(String(input)).hostname, body = JSON.parse(String(init!.body)) as { id: number; method: string; params: unknown[] };
    asked.push(`${host} ${body.method}`);
    const result = body.method === "getGenesisHash" ? SOLANA_MAINNET_GENESIS_HASH : body.method === "getSlot" ? 1007
      : body.method === "getMultipleAccounts" ? { context: { slot: 1005 }, value: [tokenAccount(SOLANA_USDG_MINT, f.vault, 70_000_000n), tokenAccount(SOLANA_WRAPPED_SOL_MINT, f.vault, 50_000_000n)] }
      : undefined;
    if (result === undefined) throw new Error(`unexpected ${body.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  const deps = { db: f.db, env, fetch, now: () => f.clock.value };
  const shown = await runSolanaResolveCommand(["shortfall", "show", TENANT], deps);
  assert.match(shown, /primary: finalized at slot 1005: 70 USDG and 0\.05 wrapped SOL\n {2}fallback: finalized at slot 1005: 70 USDG/);
  for (const secret of ["api-key", "key-two", "https:", ".example"]) assert.ok(!shown.includes(secret), secret);
  assert.ok(asked.every(line => /^(primary|fallback)\.example (getGenesisHash|getMultipleAccounts|getSlot)$/.test(line)), asked.join(","));
  assert.equal(await runSolanaResolveCommand(["shortfall", "history", TENANT], deps), "No shortfall write-offs are recorded for that tenant.");
  assert.match(await runSolanaResolveCommand(["shortfall", "book", TENANT, "--operator", "milla", "--reason", "issuer seized 20 USDG"], deps), /Written off, recorded as decided by milla\.$/);
  assert.match(await runSolanaResolveCommand(["shortfall", "history", TENANT], deps), /\tslot 1005\t70 USDG, 0\.05 wrapped SOL\twritten off\tby milla\tissuer seized 20 USDG$/);
  // A book that writes nothing off fails (exit status 1).
  await assert.rejects(runSolanaResolveCommand(["shortfall", "book", TENANT, "--operator", "milla", "--reason", "again"], deps), /Nothing is short/);
  for (const argv of [["shortfall"], ["shortfall", "show"], ["shortfall", "write", TENANT], ["shortfall", "show", TENANT, "extra"], ["shortfall", "book", TENANT, "--operator", "milla"],
    ["shortfall", "show", TENANT, "--operator", "milla"], ["shortfall", "history", TENANT, "--third-rpc"], ["shortfall", "show", TENANT, "--exclude", "everyone"]]) {
    await assert.rejects(runSolanaResolveCommand(argv, deps), (error: unknown) => error instanceof SolanaResolveError && /^Usage: npm run solana:resolve/.test(error.message), argv.join(" "));
  }
  await assert.rejects(runSolanaResolveCommand(["shortfall", "show", TENANT, "https://third.example/secret"], deps), /Do not pass provider URLs/);
});
