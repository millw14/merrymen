import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHAINS, SOLANA_USDG_MINT, TOKEN_2022_PROGRAM } from "../packages/core/src/ids.ts";
import { SolanaMarketError } from "../worker/src/solana-market.ts";
import { runSolanaPaperCommand } from "../worker/src/solana-paper-command.ts";
import { createSolanaPaperService } from "../worker/src/solana-paper-service.ts";
import { SolanaPaperStore } from "../worker/src/solana-paper-store.ts";

const BIN = fileURLToPath(new URL("./bin.mjs", import.meta.url));
const OWNER = "So11111111111111111111111111111111111111112";
const OTHER_OWNER = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CHAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "msp-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, "paper-home");
  const networkAttempt = path.join(directory, "network-attempt");
  const guard = path.join(directory, "offline-guard.mjs");
  // The real CLI and its real TS child run, but neither may contact the network.
  // NODE_OPTIONS propagates this guard into the child without inheriting keys,
  // operator Node hooks, or any of the developer's hosted/runtime settings.
  writeFileSync(guard, `
import { appendFileSync } from "node:fs";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
const refuse = () => {
  appendFileSync(${JSON.stringify(networkAttempt)}, "attempt\\n");
  throw new Error("Network is disabled in Solana CLI tests");
};
globalThis.fetch = async () => refuse();
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // tsx uses a local IPC pipe; only Unix/Windows pipe paths are permitted.
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if ((typeof options === "object" && typeof options?.path === "string" && options.port === undefined) ||
      (typeof options === "string" && !/^[0-9]+$/.test(options))) {
    return connect.apply(this, args);
  }
  return refuse();
};
syncBuiltinESMExports();
`);
  const env = {
    MERRYMEN_HOME: home,
    NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
    NO_COLOR: "1",
  };
  // Only OS process-launch settings survive; no app credentials are inherited.
  for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  function run(args, extraEnv = {}) {
    const result = spawnSync(process.execPath, [BIN, "solana-paper", ...args], {
      cwd: directory, env: { ...env, ...extraEnv }, encoding: "utf8", shell: false,
      timeout: 20_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, "the CLI must exit rather than hang or need a signal");
    assert.equal(existsSync(networkAttempt), false, "an offline command attempted a network request");
    return result;
  }
  return { directory, home, run };
}

function successJson(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function refusal(result, message) {
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "", "errors must not be preceded by an EVM welcome or success JSON");
  assert.match(result.stderr, message);
}
function noEvmFiles(home) {
  const files = readdirSync(home);
  assert.ok(files.includes("solana-paper.sqlite"));
  assert.ok(files.every(name => ["solana-paper.sqlite", "solana-paper.sqlite-wal", "solana-paper.sqlite-shm"].includes(name)),
    `unexpected onboarding or unrelated ledger state: ${files.join(", ")}`);
}

test("Solana CLI help works offline without creating data or opening EVM onboarding", t => {
  const { home, run } = fixture(t);
  for (const args of [[], ["--help"], ["help"], ["-h"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.startsWith("Solana paper trading — local simulation;"));
    assert.match(result.stdout, /status --owner PUBLIC_KEY/);
    assert.match(result.stdout, /write-off --owner PUBLIC_KEY --mint MINT/);
    assert.match(result.stdout, /no wallet signing or real funds/);
    assert.doesNotMatch(result.stdout, /the band is mustered|merrymen onboard|stand and deliver/);
    assert.equal(existsSync(home), false, "help must not initialize a paper book or EVM home");
  }
});

test("Solana CLI init and status persist exact amounts across fresh processes without credentials", t => {
  const { home, run } = fixture(t);
  const startedAt = Date.now();
  const created = successJson(run(["init", "--owner", OWNER, "--cash", "123.456789",
    "--per-trade", "10.000001", "--daily", "30.000003", "--max-ops", "7",
    "--drawdown-bps", "500", "--expires-days", "2"]));
  assert.equal(created.owner, OWNER);
  assert.equal(created.agentId, `sol:${OWNER}`);
  assert.equal(created.chain, CHAIN);
  assert.equal(created.mode, "paper");
  assert.equal(created.initialCashRaw, "123456789");
  assert.equal(created.cashRaw, "123456789");
  assert.equal(created.hwmRaw, "123456789");
  assert.equal(created.realizedPnlRaw, "0");
  assert.equal(created.version, 0);
  assert.deepEqual(created.positions, []);
  assert.deepEqual(created.trades, []);
  assert.deepEqual({ ...created.limits, expiresAtMs: 0 }, {
    perTradeUsdg: "10000001", dailyUsdg: "30000003", maxOpsPerDay: 7,
    maxDrawdownBps: 500, expiresAtMs: 0,
  });
  assert.ok(created.createdAtMs >= startedAt && created.createdAtMs <= Date.now());
  assert.ok(created.limits.expiresAtMs >= startedAt + 2 * 86_400_000);
  assert.ok(created.limits.expiresAtMs <= Date.now() + 2 * 86_400_000);
  assert.deepEqual(successJson(run(["status", "--owner", OWNER])), created,
    "status must read the prior process's durable book without changing it");
  noEvmFiles(home);
  if (process.platform !== "win32") {
    assert.equal(statSync(path.join(home, "solana-paper.sqlite")).mode & 0o777, 0o600);
    assert.equal(statSync(home).mode & 0o777, 0o700);
  }
});

test("Solana CLI duplicate init cannot refill a book or replace its limits", t => {
  const { home, run } = fixture(t);
  const created = successJson(run(["init", "--owner", OWNER, "--cash", "100", "--per-trade", "5", "--daily", "10"]));
  refusal(run(["init", "--owner", OWNER, "--cash", "999999", "--per-trade", "500", "--daily", "1000"]),
    /already exists; it cannot be refilled or reset/);
  assert.deepEqual(successJson(run(["status", "--owner", OWNER])), created);
  noEvmFiles(home);
});

test("Solana CLI renew restarts a book's limits without refilling or resetting it", t => {
  const { home, run } = fixture(t);
  const created = successJson(run(["init", "--owner", OWNER, "--cash", "100", "--per-trade", "5", "--daily", "10", "--expires-days", "1"]));
  refusal(run(["renew", "--owner", OWNER, "--cash", "999999"]), /Invalid, duplicate or unsupported Solana paper option/);
  refusal(run(["renew", "--owner", OTHER_OWNER]), /book does not exist/);
  refusal(run(["renew", "--owner", OWNER, "--per-trade", "50"]), /per-trade limit must not exceed the daily limit/);
  assert.deepEqual(successJson(run(["status", "--owner", OWNER])), created, "refused renewals change nothing");
  // Raising a limit needs --loosen; the refusal changes nothing.
  refusal(run(["renew", "--owner", OWNER, "--expires-days", "30", "--daily", "20"]), /needs --loosen; lowering one never does/);
  refusal(run(["renew", "--owner", OWNER, "--loosen", "yes"]), /Invalid, duplicate or unsupported Solana paper option/);
  assert.deepEqual(successJson(run(["status", "--owner", OWNER])), created, "refused renewals change nothing");
  const startedAt = Date.now();
  const renewed = successJson(run(["renew", "--owner", OWNER, "--expires-days", "30", "--loosen", "--daily", "20"]));
  const { renewal, limitsHistory, ...book } = renewed;
  assert.deepEqual({ ...book, limits: null, version: null, updatedAtMs: null }, { ...created, limits: null, version: null, updatedAtMs: null });
  assert.equal(renewed.version, created.version + 1);
  assert.deepEqual({ ...renewed.limits, expiresAtMs: 0 }, { ...created.limits, dailyUsdg: "20000000", expiresAtMs: 0 });
  assert.ok(renewed.limits.expiresAtMs >= startedAt + 30 * 86_400_000 && renewed.limits.expiresAtMs <= Date.now() + 30 * 86_400_000);
  // It prints what changed, and keeps the previous limits in the book.
  assert.deepEqual(renewal.changes.dailyUsdg, { from: "10000000", to: "20000000" });
  assert.deepEqual(renewal.changes.expiresAtMs, { from: created.limits.expiresAtMs, to: renewed.limits.expiresAtMs });
  assert.deepEqual(renewal.loosened, ["dailyUsdg"]);
  assert.deepEqual(limitsHistory.map((entry) => [entry.previous, entry.limits]), [[created.limits, renewed.limits]]);
  assert.deepEqual(successJson(run(["status", "--owner", OWNER])), { ...book, limitsHistory });
  // Without --expires-days a later expiry is kept.
  const again = successJson(run(["renew", "--owner", OWNER, "--per-trade", "4"]));
  assert.equal(again.limits.expiresAtMs, renewed.limits.expiresAtMs);
  assert.deepEqual(again.renewal.changes, { perTradeUsdg: { from: "5000000", to: "4000000" } });
  noEvmFiles(home);
});

test("Solana CLI renew that only tightens a limit keeps a running book's expiry", t => {
  const { run } = fixture(t);
  const created = successJson(run(["init", "--owner", OWNER, "--cash", "100", "--per-trade", "5", "--daily", "10", "--expires-days", "1"]));
  // One day left: lowering the per-trade limit does not also give the book seven days.
  const tightened = successJson(run(["renew", "--owner", OWNER, "--per-trade", "4"]));
  assert.equal(tightened.limits.expiresAtMs, created.limits.expiresAtMs);
  assert.deepEqual(tightened.renewal.changes, { perTradeUsdg: { from: "5000000", to: "4000000" } });
  // A bare renew is a request for more time: seven days from now.
  const startedAt = Date.now();
  const extended = successJson(run(["renew", "--owner", OWNER]));
  assert.ok(extended.limits.expiresAtMs >= startedAt + 7 * 86_400_000 && extended.limits.expiresAtMs <= Date.now() + 7 * 86_400_000);
  assert.deepEqual(Object.keys(extended.renewal.changes), ["expiresAtMs"]);
});

test("Solana CLI owner labels select separate books without case folding or fallback", t => {
  const { run } = fixture(t);
  const created = successJson(run(["init", "--owner", OWNER, "--cash", "50"]));
  refusal(run(["status", "--owner", OTHER_OWNER]), /No Solana paper book exists for this owner/);
  // Lowercasing this particular public key produces a different valid key.
  refusal(run(["status", "--owner", OWNER.toLowerCase()]), /No Solana paper book exists for this owner/);
  assert.deepEqual(successJson(run(["status", "--owner", OWNER])), created);
});

test("Solana CLI refuses live options and shell-shaped owner arguments before writing files", t => {
  const { directory, home, run } = fixture(t);
  const marker = path.join(directory, "injected");
  const injectedOwners = [`$(touch ${marker})`, `\`touch ${marker}\``, `invalid; touch ${marker} #`];
  for (const args of [
    ["init", "--owner", OWNER, "--live", "true"],
    ["init", "--owner", OWNER, "--mode", "live"],
    ["init", "--owner", OWNER, "--owner", OTHER_OWNER],
    ...injectedOwners.map(owner => ["init", "--owner", owner]),
  ]) {
    refusal(run(args), /Invalid, duplicate or unsupported Solana paper option|must be a canonical Solana public key/);
    assert.equal(existsSync(home), false, "invalid input must be rejected before opening a writable book");
    assert.equal(existsSync(marker), false, "owner text must remain a literal argument, never shell code");
  }
});

test("Solana CLI refuses hosted mutation and inspection before creating a book", t => {
  const { home, run } = fixture(t);
  for (const hosted of ["1", "true", " YES "]) {
    for (const command of ["init", "status"]) {
      refusal(run([command, "--owner", OWNER], { MERRYMEN_HOSTED: hosted }),
        /local-only until hosted tenant binding is implemented/);
      assert.equal(existsSync(home), false);
    }
  }
  // Operators may still read help without making an account or a network read.
  assert.equal(run(["--help"], { MERRYMEN_HOSTED: "true" }).status, 0);
  assert.equal(existsSync(home), false);
});

test("Solana CLI write-off refuses a missing --mint, an extra option or a bad mint before opening a book", t => {
  const { home, run } = fixture(t);
  for (const [args, message] of [
    [["write-off", "--owner", OWNER], /The --mint option is required/],
    [["write-off", "--mint", OWNER], /The --owner option is required/],
    [["write-off", "--owner", OWNER, "--mint", OWNER, "--amount-raw", "1"], /Invalid, duplicate or unsupported Solana paper option/],
    [["write-off", "--owner", OWNER, "--mint", OWNER, "--mint", OTHER_OWNER], /Invalid, duplicate or unsupported Solana paper option/],
    [["write-off", "--owner", OWNER, "--mint", "not-a-mint"], /must be a canonical Solana public key/],
  ]) {
    refusal(run(args), message);
    assert.equal(existsSync(home), false, `${args.join(" ")}: refused before a writable book was opened`);
  }
});

test("Solana CLI write-off refuses a missing book or a mint it does not hold, offline and without changing anything", t => {
  const { home, run } = fixture(t);
  refusal(run(["write-off", "--owner", OWNER, "--mint", OTHER_OWNER]), /The Solana paper book does not exist/);
  const created = successJson(run(["init", "--owner", OWNER, "--cash", "50"]));
  // Refused before any quote: the offline guard in run() records any network attempt.
  refusal(run(["write-off", "--owner", OWNER, "--mint", OTHER_OWNER]), /holds no position in that mint/);
  assert.deepEqual(successJson(run(["status", "--owner", OWNER])), created);
  noEvmFiles(home);
});

test("Solana CLI write-off dispatches to the owner write-off: a zero-output lot leaves, a lot a route buys stays", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "msp-write-off-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "solana-paper.sqlite");
  const NOW = 1_790_000_000_000, TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const quotes = [];
  const routed = {
    readMint: async (address) => ({ address, program: address === SOLANA_USDG_MINT ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM,
      decimals: address === SOLANA_USDG_MINT ? 6 : 9, slot: 100, observedAtMs: NOW, buyBlockedReasons: [] }),
    quote: async (intent) => {
      quotes.push(intent);
      const amount = BigInt(intent.amountRaw), out = intent.inputMint === SOLANA_USDG_MINT ? amount * 10n : amount / 10n;
      return { source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: intent.amountRaw, outAmount: out.toString(),
        minOutAmount: (out * 99n / 100n).toString(), slippageBps: intent.slippageBps, contextSlot: 100, quotedAtMs: NOW, expiresAtMs: NOW + 30_000 };
    },
  };
  // Jupiter's zero-output answer, as the real market reports it: the evidence the write-off keeps.
  const zeroAnswer = (intent) => ({ source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: intent.amountRaw,
    outAmount: "0", minOutAmount: "0", slippageBps: intent.slippageBps, contextSlot: 100, quotedAtMs: NOW });
  const noRoute = { readMint: routed.readMint, quote: async (intent) => { quotes.push(intent); throw new SolanaMarketError("zero-output", zeroAnswer(intent)); } };
  const bareZero = { readMint: routed.readMint, quote: async () => { throw new SolanaMarketError("zero-output"); } };
  // A book holding one lot, bought through the real paper service.
  const setup = new SolanaPaperStore(file, { now: () => NOW });
  try {
    setup.create(OWNER, "1000000000", { perTradeUsdg: "25000000", dailyUsdg: "100000000", maxOpsPerDay: 20, maxDrawdownBps: 1000, expiresAtMs: NOW + 86_400_000 }, NOW);
    await createSolanaPaperService(setup, routed, () => NOW).trade(OWNER, { kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "buy-1",
      inputMint: SOLANA_USDG_MINT, outputMint: OTHER_OWNER, amountRaw: "1000000", slippageBps: 100 });
  } finally { setup.close(); }
  const read = () => { const store = new SolanaPaperStore(file, { now: () => NOW }); try { return store.get(OWNER); } finally { store.close(); } };
  const deps = (market) => ({ openStore: () => new SolanaPaperStore(file, { now: () => NOW }), market: () => market, now: () => NOW });
  const before = read();
  const [lot] = before.positions;
  assert.equal(lot.mint, OTHER_OWNER);

  // A route still buys it back: not dust, refused, nothing changes.
  quotes.length = 0;
  await assert.rejects(runSolanaPaperCommand(["write-off", "--owner", OWNER, "--mint", OTHER_OWNER], deps(routed)), /sell it instead/);
  assert.deepEqual(quotes.map((q) => [q.inputMint, q.outputMint, q.amountRaw]), [[OTHER_OWNER, SOLANA_USDG_MINT, lot.amountRaw]], "the whole lot was quoted back to USDG");
  assert.deepEqual(read(), before);

  // A market that says "zero" without its answer gives no evidence: nothing is written off.
  await assert.rejects(runSolanaPaperCommand(["write-off", "--owner", OWNER, "--mint", OTHER_OWNER], deps(bareZero)), /quote is invalid/);
  assert.deepEqual(read(), before);

  // Jupiter quotes no output for the whole lot: it is written off, with that answer kept.
  quotes.length = 0;
  const result = await runSolanaPaperCommand(["write-off", "--owner", OWNER, "--mint", OTHER_OWNER], deps(noRoute));
  assert.deepEqual(quotes.map((q) => [q.inputMint, q.outputMint, q.amountRaw]), [[OTHER_OWNER, SOLANA_USDG_MINT, lot.amountRaw]]);
  assert.equal(result.writtenOff.mint, OTHER_OWNER);
  assert.equal(result.writtenOff.amountRaw, lot.amountRaw);
  assert.equal(result.writtenOff.realizedPnlRaw, (-BigInt(lot.costBasisUsdgRaw)).toString());
  assert.deepEqual(result.writtenOff.zeroOutputQuote, zeroAnswer({ inputMint: OTHER_OWNER, outputMint: SOLANA_USDG_MINT, amountRaw: lot.amountRaw, slippageBps: 100 }));
  assert.deepEqual(result.positions, []);
  assert.equal(result.cashRaw, before.cashRaw, "cash does not move");
  assert.deepEqual(result.trades, before.trades, "nothing is added to the trades");
  assert.equal(result.version, before.version + 1);
  const { writtenOff, ...book } = result;
  assert.deepEqual(read(), book, "the write-off is durable");
  assert.deepEqual(read().writeOffs, [writtenOff]);
  await assert.rejects(runSolanaPaperCommand(["write-off", "--owner", OWNER, "--mint", OTHER_OWNER], deps(noRoute)), /holds no position in that mint/);
});
