import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { CHAINS, SOLANA_USDG_MINT, base58Encode, canonicalId } from "../../packages/core/src/ids";
import type { SolanaPaperLimits, SolanaQuote, SolanaSwapIntent } from "../../packages/core/src/solana";
import {
  SOLANA_PAPER_MAX_POSITIONS, SolanaPaperStore, SolanaPaperStoreError,
  solanaPaperIntentFingerprint, type SolanaPaperCommit,
} from "./solana-paper-store";

const NOW = 1_000_000;
const OWNER = base58Encode(new Uint8Array(32).fill(20));
const OTHER = base58Encode(new Uint8Array(32).fill(21));
const TOKEN = "So11111111111111111111111111111111111111112";
const TOKEN2 = base58Encode(new Uint8Array(32).fill(22));
const U64_MAX = "18446744073709551615";
const limits = (overrides: Partial<SolanaPaperLimits> = {}): SolanaPaperLimits => ({
  perTradeUsdg: "1000", dailyUsdg: "10000", maxOpsPerDay: 100,
  maxDrawdownBps: 2000, expiresAtMs: NOW + 7 * 86_400_000, ...overrides,
});
function intent(requestId = "buy", amountRaw = "100", side: "buy" | "sell" = "buy", token = TOKEN): SolanaSwapIntent {
  return {
    kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId,
    inputMint: side === "buy" ? SOLANA_USDG_MINT : token,
    outputMint: side === "buy" ? token : SOLANA_USDG_MINT,
    amountRaw, slippageBps: 100,
  };
}
function quote(order: SolanaSwapIntent, outAmount = "200", nowMs = NOW, minOutAmount = outAmount): SolanaQuote {
  return {
    source: "jupiter", inputMint: order.inputMint, outputMint: order.outputMint,
    inAmount: order.amountRaw, outAmount, minOutAmount, slippageBps: order.slippageBps,
    contextSlot: 10, quotedAtMs: nowMs, expiresAtMs: nowMs + 20_000,
  };
}
function mark(amountRaw = "200", out = "100", nowMs = NOW, token = TOKEN): SolanaQuote {
  return quote(intent("mark", amountRaw, "sell", token), out, nowMs);
}
/** A partial sell's evidence that what it leaves still has a route back to USDG. */
function remainder(amountRaw: string, out = "1", nowMs = NOW, token = TOKEN): SolanaQuote {
  return quote(intent("remainder-check", amountRaw, "sell", token), out, nowMs);
}
function commitArgs(overrides: Partial<SolanaPaperCommit> = {}): SolanaPaperCommit {
  const order = overrides.intent ?? intent();
  const entryQuote = overrides.quote ?? quote(order);
  const exitIntent = intent("entry-exit-check", entryQuote.minOutAmount, "sell", order.outputMint);
  exitIntent.slippageBps = order.slippageBps;
  return {
    owner: OWNER, intent: order, quote: entryQuote, tokenDecimals: 9,
    buyExitQuote: order.inputMint === SOLANA_USDG_MINT ? quote(exitIntent, order.amountRaw, overrides.nowMs ?? NOW) : undefined,
    safetyObservedAtMs: overrides.nowMs ?? NOW,
    marks: [], expectedVersion: 0, nowMs: NOW, ...overrides,
  };
}
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "merrymen-solana-paper-"));
  const file = join(directory, "solana-paper.sqlite");
  const stores: SolanaPaperStore[] = [];
  let nowMs = NOW;
  t.after(() => {
    for (const store of stores) { try { store.close(); } catch { /* explicitly closed in reopen cases */ } }
    rmSync(directory, { recursive: true, force: true });
  });
  const open = () => { const store = new SolanaPaperStore(file, { now: () => nowMs }); stores.push(store); return store; };
  return { file, open, store: open(), setNow: (value: number) => { nowMs = value; } };
}
const errorCode = (code: SolanaPaperStoreError["code"]) => (error: unknown) => {
  assert.ok(error instanceof SolanaPaperStoreError);
  assert.equal(error.code, code);
  return true;
};

test("standalone schema uses WAL and rejects an unrelated ledger without changing its mode", (t) => {
  const { file, store } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  const raw = new DatabaseSync(file);
  assert.equal(raw.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
  assert.deepEqual(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name), ["solana_paper_books", "solana_paper_trades"]);
  raw.close();
  const unrelated = file + ".live";
  const live = new DatabaseSync(unrelated);
  live.exec("CREATE TABLE agents(id TEXT); INSERT INTO agents VALUES ('untouched');");
  assert.throws(() => new SolanaPaperStore(unrelated), errorCode("incompatible_database"));
  assert.equal(live.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete");
  assert.equal(live.prepare("SELECT id FROM agents").get()!.id, "untouched");
  live.close();
});

test("creation fixes paper/mainnet identity, copies policy, and cannot reset an existing book", (t) => {
  const { store } = fixture(t);
  const policy = limits();
  const book = store.create(OWNER, "1000", policy, NOW);
  policy.dailyUsdg = "99999";
  book.cashRaw = "99999";
  const persisted = store.get(OWNER)!;
  assert.equal(persisted.mode, "paper");
  assert.equal(persisted.chain, CHAINS.solana);
  assert.equal(persisted.agentId, `sol:${OWNER}`);
  assert.equal(persisted.cashRaw, "1000");
  assert.equal(persisted.limits.dailyUsdg, "10000");
  assert.equal(store.get(OTHER), null);
  assert.throws(() => store.create(OWNER, "9000", limits(), NOW), errorCode("book_exists"));
});

test("invalid owner, numeric amounts and malformed policy fail before creating a book", (t) => {
  const { store } = fixture(t);
  for (const owner of ["", "0x" + "ab".repeat(20), " " + OWNER, OWNER + " "]) {
    assert.throws(() => store.create(owner, "1000", limits(), NOW), errorCode("invalid_input"));
  }
  for (const raw of ["0", "01", "-1", "1.2", "18446744073709551616", 1000] as string[]) {
    assert.throws(() => store.create(OWNER, raw, limits(), NOW), errorCode("invalid_input"));
  }
  assert.throws(() => store.create(OWNER, "1000", limits({ expiresAtMs: NOW }), NOW), errorCode("invalid_input"));
  assert.equal(store.get(OWNER), null);
});

test("u64 precision stays exact above Number.MAX_SAFE_INTEGER and fills use minimum output", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, U64_MAX, limits({ perTradeUsdg: U64_MAX, dailyUsdg: U64_MAX }), NOW);
  const order = intent("large", "9007199254740993");
  const receipt = store.commit(commitArgs({ intent: order, quote: quote(order, "9007199254741993", NOW, "9007199254740993") }));
  assert.equal(receipt.outputAmountRaw, "9007199254740993");
  assert.equal(receipt.execution, "simulated");
  assert.equal(receipt.excludesNetworkFeesAndRent, true);
  assert.equal("signature" in receipt, false);
  assert.equal("txHash" in receipt, false);
  assert.equal(store.get(OWNER)!.cashRaw, (BigInt(U64_MAX) - 9007199254740993n).toString());
  assert.equal(store.get(OWNER)!.positions[0]!.amountRaw, "9007199254740993");
  assert.equal(store.get(OWNER)!.positions[0]!.costBasisUsdgRaw, "9007199254740993");
});

test("a committed request replays identically after reopen despite stale quote, expired policy, or old version", (t) => {
  const { store, open } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  const args = commitArgs();
  const receipt = store.commit(args);
  store.close();
  const reopened = open();
  const retried = reopened.commit({ ...args, quote: undefined as unknown as SolanaQuote, expectedVersion: -1, nowMs: NOW + 99 * 86_400_000 });
  assert.deepEqual(retried, receipt);
  assert.deepEqual(reopened.findTrade(OWNER, "buy"), receipt);
  assert.equal(reopened.get(OWNER)!.version, 1);
  assert.equal(reopened.get(OWNER)!.cashRaw, "900");
  assert.equal(reopened.get(OWNER)!.trades.length, 1);
});

test("request reuse is bound to every canonical intent field and ignores object property ordering", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  const args = commitArgs();
  store.commit(args);
  for (const changed of [
    { ...args.intent, amountRaw: "101" },
    { ...args.intent, slippageBps: 99 },
    { ...args.intent, outputMint: TOKEN2 },
    intent("buy", "100", "sell"),
  ]) assert.throws(() => store.commit({ ...args, intent: changed }), errorCode("request_conflict"));
  const reversed = Object.fromEntries(Object.entries(args.intent).reverse()) as unknown as SolanaSwapIntent;
  assert.equal(solanaPaperIntentFingerprint(reversed), solanaPaperIntentFingerprint(args.intent));
  assert.equal(store.commit({ ...args, intent: reversed }).version, 1);
});

test("owner scope and case-sensitive public keys cannot share balances or replay records", (t) => {
  const { store } = fixture(t);
  const caseOwner = OWNER.replace(/[A-Z]/, (letter) => letter.toLowerCase());
  assert.notEqual(caseOwner, OWNER);
  assert.equal(canonicalId(CHAINS.solana, "account", caseOwner), caseOwner);
  for (const owner of [OWNER, OTHER, caseOwner]) store.create(owner, "1000", limits(), NOW);
  store.commit(commitArgs());
  assert.equal(store.get(OTHER)!.cashRaw, "1000");
  assert.equal(store.get(caseOwner)!.cashRaw, "1000");
  assert.equal(store.findTrade(OTHER, "buy"), null);
  assert.equal(store.findTrade(caseOwner, "buy"), null);
  store.commit(commitArgs({ owner: OTHER }));
  store.commit(commitArgs({ owner: caseOwner }));
  assert.equal(store.get(OWNER)!.version, 1);
  assert.equal(store.get(OTHER)!.version, 1);
  assert.equal(store.get(caseOwner)!.version, 1);
});

test("separate handles serialize stale versions and recheck caps before accepting a retry", (t) => {
  const { store, open } = fixture(t);
  const otherHandle = open();
  store.create(OWNER, "2000", limits({ perTradeUsdg: "600", dailyUsdg: "1000" }), NOW);
  const first = intent("first", "600");
  store.commit(commitArgs({ intent: first, quote: quote(first, "600") }));
  const second = intent("second", "600");
  const args = commitArgs({ intent: second, quote: quote(second, "600"), marks: [mark("600", "600")] });
  assert.throws(() => otherHandle.commit(args), errorCode("version_conflict"));
  assert.throws(() => otherHandle.commit({ ...args, expectedVersion: 1 }), errorCode("daily_limit"));
  assert.equal(store.get(OWNER)!.cashRaw, "1400");
  assert.equal(otherHandle.findTrade(OWNER, "second"), null);
});

test("simultaneous separate processes cannot both spend one book version", async (t) => {
  const { store, file } = fixture(t);
  store.create(OWNER, "1000", limits({ perTradeUsdg: "600", dailyUsdg: "600" }), NOW);
  const script = `
    import { SolanaPaperStore } from ${JSON.stringify(new URL("./solana-paper-store.ts", import.meta.url).href)};
    const store = new SolanaPaperStore(process.argv[1], { now: () => ${NOW} });
    try { process.stdout.write(JSON.stringify({ receipt: store.commit(JSON.parse(process.argv[2])) })); }
    catch (error) { process.stdout.write(JSON.stringify({ code: error.code })); }
    finally { store.close(); }
  `;
  const run = promisify(execFile);
  const outputs = await Promise.all(["first", "second"].map(async (id) => {
    const order = intent(id, "600");
    const args = commitArgs({ intent: order, quote: quote(order, "600") });
    const { stdout } = await run(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script, file, JSON.stringify(args)],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 10_000 });
    return JSON.parse(stdout);
  }));
  assert.equal(outputs.filter((result) => result.receipt).length, 1);
  assert.equal(outputs.filter((result) => result.code === "version_conflict").length, 1);
  assert.equal(store.get(OWNER)!.cashRaw, "400");
  assert.equal(store.get(OWNER)!.trades.length, 1);
});

test("process death immediately after commit preserves receipt and prevents a duplicate fill", async (t) => {
  const { store, file } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  const script = `
    import { SolanaPaperStore } from ${JSON.stringify(new URL("./solana-paper-store.ts", import.meta.url).href)};
    const store = new SolanaPaperStore(process.argv[1], { now: () => ${NOW} });
    store.commit(JSON.parse(process.argv[2]));
    process.kill(process.pid, "SIGKILL");
  `;
  await assert.rejects(promisify(execFile)(process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script, file, JSON.stringify(commitArgs())],
    { env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 10_000 }),
    (error: unknown) => (error as NodeJS.ErrnoException & { signal: string }).signal === "SIGKILL");
  assert.equal(store.findTrade(OWNER, "buy")!.version, 1);
  assert.equal(store.commit(commitArgs()).version, 1);
  assert.equal(store.get(OWNER)!.cashRaw, "900");
  assert.equal(store.get(OWNER)!.trades.length, 1);
});

test("write-lock contention cannot preserve expired quotes, limits or mint safety observations", async (t) => {
  const { file } = fixture(t);
  const store = new SolanaPaperStore(file);
  t.after(() => store.close());
  for (const [index, kind] of ["entry", "exit", "limits", "safety"].entries()) {
    const owner = [OWNER, OTHER, TOKEN2, TOKEN][index]!;
    const created = Date.now();
    store.create(owner, "1000", limits({ expiresAtMs: created + (kind === "limits" ? 1000 : 60_000) }), created);
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      process.stdout.write('locked');
      setTimeout(() => { db.exec('ROLLBACK'); db.close(); }, 1500);
    `;
    const locker = spawn(process.execPath, ["--input-type=module", "--eval", script, file], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => { if (locker.exitCode === null) locker.kill("SIGKILL"); });
    const finished = new Promise<void>((resolve, reject) => {
      locker.once("error", reject);
      locker.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Lock fixture failed")));
    });
    await new Promise<void>((resolve, reject) => {
      locker.once("error", reject);
      locker.stdout.once("data", () => resolve());
    });
    const prepared = Date.now();
    const args = commitArgs({ owner, nowMs: prepared, quote: quote(intent(), "200", prepared) });
    if (kind === "entry") args.quote.expiresAtMs = prepared + 500;
    if (kind === "exit") args.buyExitQuote!.expiresAtMs = prepared + 500;
    if (kind === "safety") args.safetyObservedAtMs = prepared - 29_500;
    assert.throws(() => store.commit(args), errorCode(kind === "limits" ? "expired" : kind === "safety" ? "stale_safety" : "invalid_quote"));
    await finished;
    assert.equal(store.get(owner)!.version, 0);
    assert.equal(store.findTrade(owner, "buy"), null);
  }
});

test("authoritative commit time controls receipt timestamps and rejects future preparation", (t) => {
  const { store, setNow } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  assert.throws(() => store.commit(commitArgs({ nowMs: NOW + 1 })), errorCode("invalid_input"));
  setNow(NOW + 100);
  assert.equal(store.commit(commitArgs()).createdAtMs, NOW + 100);
  assert.equal(store.get(OWNER)!.updatedAtMs, NOW + 100);
});

test("fresh mint safety evidence is required for new buys and exits, but not durable replay", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  const args = commitArgs();
  for (const safetyObservedAtMs of [undefined, -1, NOW + 1, NOW - 30_000, 0.5] as number[]) {
    assert.throws(() => store.commit({ ...args, safetyObservedAtMs }), errorCode("stale_safety"));
  }
  const receipt = store.commit(args);
  assert.equal(receipt.safetyObservedAtMs, NOW);
  assert.deepEqual(store.commit({ ...args, safetyObservedAtMs: undefined as unknown as number }), receipt);
  const sell = intent("exit", "200", "sell");
  assert.throws(() => store.commit(commitArgs({ intent: sell, quote: quote(sell, "100"), expectedVersion: 1, safetyObservedAtMs: NOW - 30_000 })), errorCode("stale_safety"));
});

test("database failure after receipt insertion rolls back the receipt, balance, position and version together", (t) => {
  const { store, file } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  const before = store.get(OWNER);
  const raw = new DatabaseSync(file);
  raw.exec("CREATE TRIGGER fail_book_update BEFORE UPDATE ON solana_paper_books BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;");
  assert.throws(() => store.commit(commitArgs()), /injected write failure/);
  assert.deepEqual(store.get(OWNER), before);
  assert.equal(store.findTrade(OWNER, "buy"), null);
  raw.exec("DROP TRIGGER fail_book_update");
  raw.close();
  assert.equal(store.commit(commitArgs()).version, 1);
});

test("per-trade, operation and rolling daily caps cover buys and sells", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, "1000", limits({ perTradeUsdg: "100", dailyUsdg: "200", maxOpsPerDay: 2 }), NOW);
  assert.throws(() => store.commit(commitArgs({ intent: intent("over", "101"), quote: quote(intent("over", "101")) })), errorCode("per_trade_limit"));
  store.commit(commitArgs());
  const highSell = intent("high-sell", "200", "sell");
  assert.throws(() => store.commit(commitArgs({ intent: highSell, quote: quote(highSell, "101", NOW, "100"), expectedVersion: 1 })), errorCode("per_trade_limit"));
  const sell = intent("sell", "200", "sell");
  store.commit(commitArgs({ intent: sell, quote: quote(sell, "100", NOW, "99"), expectedVersion: 1 }));
  const third = intent("third", "1");
  assert.throws(() => store.commit(commitArgs({ intent: third, quote: quote(third, "1"), expectedVersion: 2 })), errorCode("operation_limit"));
  assert.equal(store.get(OWNER)!.cashRaw, "999");
  assert.equal(store.get(OWNER)!.trades[0]!.notionalUsdgRaw, "100");
});

test("degraded exits retain daily, operation and expiry limits", (t) => {
  const { store, setNow } = fixture(t);
  const owners = [OWNER, OTHER, TOKEN2];
  const policies = [limits({ dailyUsdg: "1000" }), limits({ maxOpsPerDay: 1 }), limits({ expiresAtMs: NOW + 100 })];
  for (let i = 0; i < owners.length; i++) {
    const owner = owners[i]!;
    store.create(owner, "1000", policies[i]!, NOW);
    store.commit(commitArgs({ owner }));
    const sell = intent("exit", "200", "sell");
    const nowMs = i === 2 ? NOW + 100 : NOW;
    setNow(nowMs);
    const args = commitArgs({ owner, intent: sell, quote: quote(sell, i === 0 ? "901" : "100", nowMs), expectedVersion: 1, nowMs });
    assert.throws(() => store.commit(args), errorCode(["daily_limit", "operation_limit", "expired"][i] as SolanaPaperStoreError["code"]));
    assert.equal(store.get(owner)!.positions[0]!.amountRaw, "200");
    assert.equal(store.findTrade(owner, "exit"), null);
  }
});

test("24-hour caps expire exactly at the rolling boundary without a calendar-day reset", (t) => {
  const { store, setNow } = fixture(t);
  store.create(OWNER, "1000", limits({ perTradeUsdg: "100", dailyUsdg: "100", maxOpsPerDay: 1 }), NOW);
  store.commit(commitArgs());
  const order = intent("next", "10");
  const next = NOW + 86_400_000;
  const args = commitArgs({ intent: order, quote: quote(order, "20", next), marks: [mark("200", "100", next)], expectedVersion: 1, nowMs: next });
  setNow(next - 1);
  assert.throws(() => store.commit(commitArgs({ ...args, quote: quote(order, "20", next - 1), buyExitQuote: mark("20", "10", next - 1), safetyObservedAtMs: next - 1, nowMs: next - 1 })), errorCode("operation_limit"));
  setNow(next);
  assert.equal(store.commit(args).version, 2);
});

test("monotonic time and immutable expiry prevent cap bypass; duplicate requests remain readable", (t) => {
  const { store, setNow } = fixture(t);
  store.create(OWNER, "1000", limits({ expiresAtMs: NOW + 100 }), NOW);
  const order = intent("first");
  setNow(NOW + 1);
  store.commit(commitArgs({ intent: order, quote: quote(order, "200", NOW + 1), nowMs: NOW + 1 }));
  const second = intent("second");
  setNow(NOW);
  assert.throws(() => store.commit(commitArgs({ intent: second, expectedVersion: 1 })), errorCode("clock_rollback"));
  setNow(NOW + 100);
  assert.throws(() => store.commit(commitArgs({ intent: second, expectedVersion: 1, nowMs: NOW + 100 })), errorCode("expired"));
  assert.equal(store.commit(commitArgs({ intent: order, nowMs: NOW + 100 })).version, 1);
});

test("invalid/stale/mismatched quotes never change the book", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  const args = commitArgs();
  for (const bad of [
    { ...args.quote, inputMint: TOKEN2 }, { ...args.quote, inAmount: "101" },
    { ...args.quote, expiresAtMs: NOW }, { ...args.quote, quotedAtMs: NOW + 1 },
    { ...args.quote, minOutAmount: "1" }, { ...args.quote, contextSlot: 0 },
  ]) assert.throws(() => store.commit({ ...args, quote: bad }), errorCode("invalid_quote"));
  assert.equal(store.get(OWNER)!.version, 0);
});

test("new buys require fresh exact-size exit evidence and supported token decimals", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  const args = commitArgs();
  for (const buyExitQuote of [undefined, { ...args.buyExitQuote!, inAmount: "199" }, { ...args.buyExitQuote!, expiresAtMs: NOW }]) {
    assert.throws(() => store.commit({ ...args, buyExitQuote }), errorCode("invalid_quote"));
  }
  assert.throws(() => store.commit({ ...args, tokenDecimals: 19 }), errorCode("invalid_input"));
  assert.deepEqual(store.commit(args).buyExitQuote, args.buyExitQuote);
});

test("buys require exactly one fresh full-position mark for every holding", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  store.commit(commitArgs());
  const next = intent("next");
  const args = commitArgs({ intent: next, quote: quote(next), expectedVersion: 1 });
  for (const marks of [
    [], [mark("199")], [mark("200", "100", NOW - 30_000)],
    [mark("200", "100", NOW, TOKEN2)], [mark(), mark()],
  ]) assert.throws(() => store.commit({ ...args, marks }), errorCode("invalid_marks"));
  assert.equal(store.commit({ ...args, marks: [mark()] }).version, 2);
});

test("an exit with supplied stale or partial marks rejects rather than silently downgrading", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  store.commit(commitArgs());
  const second = intent("second", "100", "buy", TOKEN2);
  store.commit(commitArgs({ intent: second, quote: quote(second), marks: [mark()], expectedVersion: 1 }));
  const sell = intent("exit", "200", "sell");
  const args = commitArgs({ intent: sell, quote: quote(sell, "100"), expectedVersion: 2 });
  assert.throws(() => store.commit({ ...args, marks: [mark()] }), errorCode("invalid_marks"));
  assert.throws(() => store.commit({ ...args, marks: [mark("200", "100", NOW - 30_000), mark("200", "100", NOW, TOKEN2)] }), errorCode("invalid_marks"));
  assert.equal(store.commit(args).version, 3);
  assert.equal(store.get(OWNER)!.positions[0]!.mint, TOKEN2);
});

test("drawdown blocks buys but permits a loss-cutting sell even when unrelated marks are unavailable", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  const buy = intent("buy", "500");
  store.commit(commitArgs({ intent: buy, quote: quote(buy, "1000") }));
  const next = intent("blocked", "100");
  const args = commitArgs({ intent: next, quote: quote(next), marks: [mark("1000", "100")], expectedVersion: 1 });
  assert.throws(() => store.commit(args), errorCode("drawdown_limit"));
  assert.equal(store.get(OWNER)!.hwmRaw, "1000");
  const sell = intent("exit", "1000", "sell");
  const receipt = store.commit(commitArgs({ intent: sell, quote: quote(sell, "100"), expectedVersion: 1, marks: [] }));
  assert.equal(receipt.realizedPnlRaw, "-400");
  assert.equal(store.get(OWNER)!.cashRaw, "600");
  assert.equal(store.get(OWNER)!.hwmRaw, "1000");
  assert.deepEqual(store.get(OWNER)!.positions, []);
});

test("drawdown at the exact configured boundary blocks buys while allowing an exit", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  const buy = intent("buy", "500");
  store.commit(commitArgs({ intent: buy, quote: quote(buy, "1000") }));
  const next = intent("boundary", "1");
  assert.throws(() => store.commit(commitArgs({ intent: next, quote: quote(next, "1"), marks: [mark("1000", "300")], expectedVersion: 1 })), errorCode("drawdown_limit"));
  const sell = intent("exit", "1000", "sell");
  assert.equal(store.commit(commitArgs({ intent: sell, quote: quote(sell, "300"), expectedVersion: 1 })).version, 2);
});

test("partial basis allocation leaves integer dust for the full exit, which clears it exactly", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  const buy = intent("buy", "10");
  store.commit(commitArgs({ intent: buy, quote: quote(buy, "3") }));
  const partial = intent("partial", "1", "sell");
  const first = store.commit(commitArgs({ intent: partial, quote: quote(partial, "4"), remainderQuote: remainder("2"), expectedVersion: 1 }));
  assert.equal(first.realizedPnlRaw, "1");
  assert.deepEqual(store.get(OWNER)!.positions, [{ mint: TOKEN, decimals: 9, amountRaw: "2", costBasisUsdgRaw: "7" }]);
  const exit = intent("exit", "2", "sell");
  const second = store.commit(commitArgs({ intent: exit, quote: quote(exit, "7"), expectedVersion: 2 }));
  assert.equal(second.realizedPnlRaw, "0");
  const book = store.get(OWNER)!;
  assert.deepEqual(book.positions, []);
  assert.equal(book.cashRaw, "1001");
  assert.equal(book.realizedPnlRaw, "1");
  assert.equal(book.hwmRaw, "1001");
});

test("insufficient cash, overselling and changed decimals fail without recording a request", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, "100", limits(), NOW);
  const over = intent("cash", "101");
  assert.throws(() => store.commit(commitArgs({ intent: over, quote: quote(over) })), errorCode("insufficient_balance"));
  store.commit(commitArgs());
  const sell = intent("sell", "201", "sell");
  assert.throws(() => store.commit(commitArgs({ intent: sell, quote: quote(sell, "100"), expectedVersion: 1 })), errorCode("insufficient_balance"));
  const buy = intent("decimals", "1");
  assert.throws(() => store.commit(commitArgs({ intent: buy, quote: quote(buy), expectedVersion: 1, tokenDecimals: 6 })), errorCode("decimals_conflict"));
  assert.equal(store.get(OWNER)!.version, 1);
  assert.equal(store.findTrade(OWNER, "cash"), null);
  assert.equal(store.findTrade(OWNER, "sell"), null);
});

test("cash and token balance overflow reject atomically even when the quote itself fits u64", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, U64_MAX, limits({ perTradeUsdg: U64_MAX, dailyUsdg: U64_MAX }), NOW);
  const buy = intent("buy", "1");
  store.commit(commitArgs({ intent: buy, quote: quote(buy, U64_MAX) }));
  const add = intent("overflow-token", "1");
  assert.throws(() => store.commit(commitArgs({ intent: add, quote: quote(add, "1"), marks: [mark(U64_MAX, "1")], expectedVersion: 1 })), errorCode("balance_overflow"));
  const sell = intent("overflow-cash", "1", "sell");
  assert.throws(() => store.commit(commitArgs({ intent: sell, quote: quote(sell, "2"), remainderQuote: remainder((BigInt(U64_MAX) - 1n).toString()), expectedVersion: 1 })),
    errorCode("balance_overflow"));
  assert.equal(store.get(OWNER)!.version, 1);
  assert.equal(store.get(OWNER)!.positions[0]!.amountRaw, U64_MAX);
});

test("complete marked profits raise high water; a later decline uses that durable peak", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  store.commit(commitArgs());
  const next = intent("next", "100");
  store.commit(commitArgs({ intent: next, quote: quote(next), marks: [mark("200", "1100")], expectedVersion: 1 }));
  assert.equal(store.get(OWNER)!.hwmRaw, "2000");
  const third = intent("third", "1");
  assert.throws(() => store.commit(commitArgs({ intent: third, quote: quote(third), marks: [mark("400", "700")], expectedVersion: 2 })), errorCode("drawdown_limit"));
});

test("open-position bound limits complete valuation cost while still permitting exits", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, "10000", limits(), NOW);
  for (let i = 0; i < SOLANA_PAPER_MAX_POSITIONS; i++) {
    const token = base58Encode(new Uint8Array(32).fill(50 + i));
    const order = intent(`buy-${i}`, "1", "buy", token);
    const book = store.get(OWNER)!;
    store.commit(commitArgs({ intent: order, quote: quote(order, "1"), expectedVersion: book.version,
      marks: book.positions.map((position) => mark(position.amountRaw, "1", NOW, position.mint)) }));
  }
  const extra = intent("extra", "1");
  assert.throws(() => store.commit(commitArgs({ intent: extra, quote: quote(extra, "1"), expectedVersion: SOLANA_PAPER_MAX_POSITIONS })), errorCode("position_limit"));
  const exit = intent("exit", "1", "sell", store.get(OWNER)!.positions[0]!.mint);
  store.commit(commitArgs({ intent: exit, quote: quote(exit, "1"), expectedVersion: SOLANA_PAPER_MAX_POSITIONS }));
  assert.equal(store.get(OWNER)!.positions.length, SOLANA_PAPER_MAX_POSITIONS - 1);
});

test("snapshots bound history to 100 but old receipts remain durable for replay", (t) => {
  const { store, open } = fixture(t);
  store.create(OWNER, "1000", limits({ maxOpsPerDay: 1000 }), NOW);
  for (let i = 0; i < 102; i++) {
    const order = intent(`trade-${i}`, "1", i % 2 === 0 ? "buy" : "sell");
    store.commit(commitArgs({ intent: order, quote: quote(order, "1"), expectedVersion: i }));
  }
  assert.equal(store.get(OWNER)!.trades.length, 100);
  assert.equal(store.get(OWNER)!.trades[0]!.requestId, "trade-101");
  store.close();
  const reopened = open();
  const original = intent("trade-0", "1");
  assert.equal(reopened.findTrade(OWNER, "trade-0")!.version, 1);
  assert.equal(reopened.commit(commitArgs({ intent: original, quote: quote(original, "1") })).version, 1);
  assert.equal(reopened.get(OWNER)!.version, 102);
});

test("an owner renewal revives an expired book without refilling it, resetting it or rewriting its receipts", (t) => {
  const { store, setNow, open } = fixture(t);
  const DAY = 86_400_000;
  store.create(OWNER, "1000", limits({ perTradeUsdg: "500", dailyUsdg: "1000", maxOpsPerDay: 5, expiresAtMs: NOW + DAY }), NOW);
  store.commit(commitArgs());
  // Day one ends: the position can no longer be sold and init is refused.
  setNow(NOW + DAY);
  const sell = intent("exit", "150", "sell");
  const sellArgs = (nowMs: number, expectedVersion: number) =>
    commitArgs({ intent: sell, quote: quote(sell, "90", nowMs), remainderQuote: remainder("50", "30", nowMs), safetyObservedAtMs: nowMs, expectedVersion, nowMs });
  assert.throws(() => store.commit(sellArgs(NOW + DAY, 1)), errorCode("expired"));
  assert.throws(() => store.create(OWNER, "1000", limits({ expiresAtMs: NOW + 9 * DAY }), NOW + DAY), errorCode("book_exists"));
  const before = store.get(OWNER)!;

  const renewed = store.renew(OWNER, { expiresAtMs: NOW + 8 * DAY });
  const { limits: _old, version: _v, updatedAtMs: _u, ...kept } = before;
  const { limits: renewedLimits, version, updatedAtMs, limitsHistory, renewal, ...after } = renewed;
  assert.deepEqual(after, kept, "cash, initial cash, peak, P&L, positions and receipts are untouched");
  assert.deepEqual(renewedLimits, { ...before.limits, expiresAtMs: NOW + 8 * DAY }, "omitted limits keep their values");
  assert.equal(version, before.version + 1);
  assert.equal(updatedAtMs, NOW + DAY);
  assert.deepEqual(limitsHistory, [{ renewedAtMs: NOW + DAY, version: 2, previous: before.limits, limits: renewedLimits, loosened: [] }]);
  assert.deepEqual(renewal, { changes: { expiresAtMs: { from: NOW + DAY, to: NOW + 8 * DAY } }, loosened: [], expiryShortened: false });
  const { renewal: _report, ...snapshot } = renewed;
  assert.deepEqual(open().get(OWNER), snapshot, "the renewal and its history are durable");

  // The stranded position can be sold again, against the renewed version.
  assert.throws(() => store.commit(sellArgs(NOW + DAY, 1)), errorCode("version_conflict"));
  const exit = store.commit(sellArgs(NOW + DAY, 2));
  assert.equal(exit.side, "sell");
  assert.equal(store.get(OWNER)!.trades.length, 2);
  assert.equal(store.get(OWNER)!.initialCashRaw, "1000");
});

test("a renewal changes only the limits it names, validates them, and never resets the rolling caps", (t) => {
  const { store, setNow } = fixture(t);
  store.create(OWNER, "1000", limits({ perTradeUsdg: "500", dailyUsdg: "1000", maxOpsPerDay: 5 }), NOW);
  store.commit(commitArgs());
  const before = store.get(OWNER)!;
  setNow(NOW + 10);
  for (const [renewal, code] of [
    [{ expiresAtMs: NOW + 10 }, null],
    [{ expiresAtMs: NOW + 10_000, perTradeUsdg: "1001" }, null],
    [{ expiresAtMs: NOW + 10_000, maxDrawdownBps: 10_001 }, null],
    [{ expiresAtMs: NOW + 10_000, maxOpsPerDay: 0 }, null],
    [{ expiresAtMs: NOW + 10_000, cashRaw: "999999" }, "invalid_input"],
    [{ expiresAtMs: NOW + 10_000, initialCashRaw: "999999" }, "invalid_input"],
    [{ expiresAtMs: NOW + 10_000, perTradeWsol: "1" }, "invalid_input"],
    [{ expiresAtMs: String(NOW + 10_000) }, "invalid_input"],
    [{ loosen: "yes" }, "invalid_input"],
    [{ expiresAtMs: NOW + 10_000, perTradeUsdg: "501" }, "loosen_required"],
  ] as const) {
    assert.throws(() => store.renew(OWNER, renewal as never), code ? errorCode(code) : /Solana/, JSON.stringify(renewal));
    assert.deepEqual(store.get(OWNER), before, `${JSON.stringify(renewal)} changed the book`);
  }
  assert.throws(() => store.renew(OTHER, { expiresAtMs: NOW + 10_000 }), errorCode("book_missing"));
  assert.throws(() => store.renew(OWNER, { expiresAtMs: NOW + 10_000 }, NOW + 11), errorCode("invalid_input"));
  setNow(NOW - 1);
  assert.throws(() => store.renew(OWNER, { expiresAtMs: NOW + 10_000 }), errorCode("clock_rollback"));
  setNow(NOW + 10);

  const tightened = store.renew(OWNER, { expiresAtMs: NOW + 10_000, maxOpsPerDay: 1, perTradeUsdg: "50" });
  assert.deepEqual(tightened.limits, { ...before.limits, expiresAtMs: NOW + 10_000, maxOpsPerDay: 1, perTradeUsdg: "50" });
  // The trade made before the renewal still counts toward the 24-hour window.
  const next = intent("next", "10");
  const nextArgs = commitArgs({ intent: next, quote: quote(next, "20", NOW + 10), marks: [mark("200", "100", NOW + 10)], safetyObservedAtMs: NOW + 10, expectedVersion: 2, nowMs: NOW + 10 });
  assert.throws(() => store.commit(nextArgs), errorCode("operation_limit"));
  assert.throws(() => store.renew(OWNER, { expiresAtMs: NOW + 10_000, maxOpsPerDay: 2 }), errorCode("loosen_required"));
  assert.equal(store.renew(OWNER, { expiresAtMs: NOW + 10_000, maxOpsPerDay: 2, loosen: true }).version, 3);
  assert.throws(() => store.commit({ ...nextArgs, intent: intent("big", "51"), quote: quote(intent("big", "51"), "20", NOW + 10), expectedVersion: 3 }), errorCode("per_trade_limit"));
  assert.equal(store.commit({ ...nextArgs, expectedVersion: 3 }).version, 4);
});

test("a renewal raises a limit only with loosen, and records every renewal in the book's history", (t) => {
  const { store, setNow, open } = fixture(t);
  const base = limits({ perTradeUsdg: "500", dailyUsdg: "1000", maxOpsPerDay: 5, maxDrawdownBps: 1000, expiresAtMs: NOW + 86_400_000 });
  store.create(OWNER, "1000", base, NOW);
  const before = store.get(OWNER)!;
  setNow(NOW + 10);
  for (const raise of [{ perTradeUsdg: "501" }, { dailyUsdg: "1001" }, { maxOpsPerDay: 6 }, { maxDrawdownBps: 1001 },
    { perTradeUsdg: "1", maxDrawdownBps: 10_000 }] as const) {
    assert.throws(() => store.renew(OWNER, { ...raise }), errorCode("loosen_required"), JSON.stringify(raise));
    assert.throws(() => store.renew(OWNER, { ...raise, loosen: false }), errorCode("loosen_required"));
    assert.deepEqual(store.get(OWNER), before, "a refused loosening changes nothing");
  }
  // Lowering needs nothing more, and a running book keeps its expiry.
  const lowered = store.renew(OWNER, { perTradeUsdg: "100", maxOpsPerDay: 3 });
  assert.deepEqual(lowered.renewal, { changes: { perTradeUsdg: { from: "500", to: "100" }, maxOpsPerDay: { from: 5, to: 3 } },
    loosened: [], expiryShortened: false });
  setNow(NOW + 20);
  const raised = store.renew(OWNER, { perTradeUsdg: "800", dailyUsdg: "900", maxDrawdownBps: 1500, loosen: true });
  assert.deepEqual(raised.renewal.loosened, ["perTradeUsdg", "maxDrawdownBps"], "the daily limit went down, the others up");
  // Changing limits never moves a running book's expiry either.
  assert.deepEqual(raised.limits, { ...lowered.limits, perTradeUsdg: "800", dailyUsdg: "900", maxDrawdownBps: 1500, expiresAtMs: NOW + 86_400_000 });
  // A loosen flag without a raise loosens nothing and is not recorded as one.
  setNow(NOW + 30);
  const unchanged = store.renew(OWNER, { loosen: true, expiresAtMs: raised.limits.expiresAtMs });
  assert.deepEqual([unchanged.renewal.changes, unchanged.renewal.loosened], [{}, []]);
  // The history is durable, oldest first, and keeps the limits each renewal replaced.
  const history = open().get(OWNER)!.limitsHistory!;
  assert.deepEqual(history.map((entry) => [entry.renewedAtMs, entry.version, entry.loosened]),
    [[NOW + 10, 1, []], [NOW + 20, 2, ["perTradeUsdg", "maxDrawdownBps"]], [NOW + 30, 3, []]]);
  assert.deepEqual(history[0]!.previous, before.limits);
  assert.deepEqual(history.map((entry) => entry.limits), [lowered.limits, raised.limits, unchanged.limits]);
  assert.deepEqual(history[1]!.previous, history[0]!.limits);
  // Nothing else in the book moved.
  const { limits: _l, limitsHistory: _h, version: _v, updatedAtMs: _u, ...rest } = open().get(OWNER)!;
  const { limits: _bl, version: _bv, updatedAtMs: _bu, ...beforeRest } = before;
  assert.deepEqual(rest, beforeRest);
});

test("a renewal without an explicit expiry never shortens it; an explicit one may, and says so", (t) => {
  const { store, setNow } = fixture(t);
  const DAY = 86_400_000;
  store.create(OWNER, "1000", limits({ expiresAtMs: NOW + 30 * DAY }), NOW);
  setNow(NOW + DAY);
  // Thirty days left: the 7-day default would cut 22 of them; it keeps them instead.
  const kept = store.renew(OWNER, { maxOpsPerDay: 50 });
  assert.equal(kept.limits.expiresAtMs, NOW + 30 * DAY);
  assert.equal(kept.renewal.changes.expiresAtMs, undefined);
  // An expired book gets the default seven days from now.
  setNow(NOW + 31 * DAY);
  const revived = store.renew(OWNER, {});
  assert.equal(revived.limits.expiresAtMs, NOW + 38 * DAY);
  assert.equal(revived.renewal.expiryShortened, false);
  // The owner may still choose a shorter expiry explicitly: a tighter limit.
  const shortened = store.renew(OWNER, { expiresAtMs: NOW + 32 * DAY });
  assert.equal(shortened.limits.expiresAtMs, NOW + 32 * DAY);
  assert.deepEqual([shortened.renewal.changes.expiresAtMs, shortened.renewal.expiryShortened], [{ from: NOW + 38 * DAY, to: NOW + 32 * DAY }, true]);
});

test("a renewal that only tightens a limit never lengthens a running book's expiry; a bare one extends it", (t) => {
  const { store, setNow } = fixture(t);
  const DAY = 86_400_000;
  store.create(OWNER, "1000", limits({ perTradeUsdg: "500", expiresAtMs: NOW + 2 * DAY }), NOW);
  // One day left. Lowering the per-trade limit keeps that day; it does not also give the book seven.
  setNow(NOW + DAY);
  const tightened = store.renew(OWNER, { perTradeUsdg: "5" });
  assert.equal(tightened.limits.expiresAtMs, NOW + 2 * DAY);
  assert.deepEqual(tightened.renewal.changes, { perTradeUsdg: { from: "500", to: "5" } });
  assert.deepEqual(tightened.limitsHistory!.at(-1)!.limits.expiresAtMs, NOW + 2 * DAY);
  // The same holds with an empty loosen flag beside it, and for every other limit.
  for (const change of [{ maxOpsPerDay: 50, loosen: true }, { dailyUsdg: "9000" }, { maxDrawdownBps: 1000 }] as const) {
    assert.equal(store.renew(OWNER, { ...change }).limits.expiresAtMs, NOW + 2 * DAY, JSON.stringify(change));
  }
  // An explicit expiry alongside a change is the owner's choice.
  assert.equal(store.renew(OWNER, { perTradeUsdg: "4", expiresAtMs: NOW + 10 * DAY }).limits.expiresAtMs, NOW + 10 * DAY);
  // A bare renewal asks for more time: seven days from now, or a later expiry kept.
  assert.equal(store.renew(OWNER, {}).limits.expiresAtMs, NOW + 10 * DAY);
  setNow(NOW + 9 * DAY);
  const extended = store.renew(OWNER, {});
  assert.equal(extended.limits.expiresAtMs, NOW + 16 * DAY);
  assert.deepEqual(extended.renewal.changes, { expiresAtMs: { from: NOW + 10 * DAY, to: NOW + 16 * DAY } });
  // An expired book can only continue with a new expiry: a renewal that names a change revives it for the default seven days.
  setNow(NOW + 16 * DAY);
  const revived = store.renew(OWNER, { perTradeUsdg: "3" });
  assert.equal(revived.limits.expiresAtMs, NOW + 23 * DAY);
  assert.deepEqual(revived.renewal.changes.expiresAtMs, { from: NOW + 16 * DAY, to: NOW + 23 * DAY });
});

test("a held mint valued at zero is checked against the book and can only tighten the drawdown limit", (t) => {
  const { store } = fixture(t);
  // limits(): 20% drawdown. 250 of 1000 cash buys 1000 units of TOKEN.
  store.create(OWNER, "1000", limits(), NOW);
  store.commit(commitArgs({ intent: intent("dust", "250"), quote: quote(intent("dust", "250"), "1000") }));
  const next = intent("next", "10");
  const args = (extra: Partial<SolanaPaperCommit>) => commitArgs({ intent: next, quote: quote(next, "20"), expectedVersion: 1, ...extra });
  for (const extra of [
    { zeroValuedMints: [TOKEN2] }, { zeroValuedMints: [TOKEN, TOKEN] }, { zeroValuedMints: [TOKEN], marks: [mark("1000", "200")] },
    { zeroValuedMints: "TOKEN" as unknown as string[] }, { zeroValuedMints: [] }, { zeroValuedMints: [7 as unknown as string] },
  ] as Partial<SolanaPaperCommit>[]) {
    assert.throws(() => store.commit(args(extra)), errorCode("invalid_marks"), JSON.stringify(extra));
  }
  // Marked at 200, equity is 950 of a 1000 peak; valued at zero it is 750, a
  // 25% drawdown, so the zero valuation blocks a buy that a mark would allow.
  assert.throws(() => store.commit(args({ zeroValuedMints: [TOKEN] })), errorCode("drawdown_limit"));
  assert.equal(store.get(OWNER)!.hwmRaw, "1000");
  assert.equal(store.get(OWNER)!.version, 1);
  const marked = store.commit(args({ marks: [mark("1000", "200")] }));
  assert.equal(marked.zeroValuedMints, undefined);
});

test("dust valued at zero lets a buy proceed and is recorded on the receipt", (t) => {
  const { store } = fixture(t);
  store.create(OWNER, "1000", limits(), NOW);
  store.commit(commitArgs());
  // A partial sell leaves 1 raw unit, which a route still bought back then
  // (its remainder quote) but no longer does: dust from before the remainder
  // rule, or from a market that moved.
  const partial = intent("partial", "199", "sell");
  store.commit(commitArgs({ intent: partial, quote: quote(partial, "99"), remainderQuote: remainder("1"), expectedVersion: 1 }));
  const next = intent("next", "100", "buy", TOKEN2);
  const receipt = store.commit(commitArgs({ intent: next, quote: quote(next, "50"), zeroValuedMints: [TOKEN], expectedVersion: 2 }));
  assert.deepEqual(receipt.zeroValuedMints, [TOKEN]);
  assert.deepEqual(store.findTrade(OWNER, "next")!.zeroValuedMints, [TOKEN]);
  assert.deepEqual(store.get(OWNER)!.positions.map((p) => [p.mint, p.amountRaw]), [[TOKEN, "1"], [TOKEN2, "50"]]);
  assert.equal(store.get(OWNER)!.hwmRaw, "1000", "a zero valuation never raises the peak");
});
