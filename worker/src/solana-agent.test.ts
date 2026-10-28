import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CHAINS, SOLANA_USDG_MINT } from "../../packages/core/src/ids";
import { SOLANA_WRAPPED_SOL_MINT } from "../../packages/core/src/solana-live";
import { SqlSolanaBindingStore } from "../../web/src/lib/solana-binding-store";
import { stopSolanaForKill } from "./solana-kill";
import { createSolanaAppRuntime, SOLANA_STATUS_BELOW_BOOK } from "./solana-app-runtime";
import { boundSolanaRebalanceSell, createSolanaAgent, planSolanaRebalance } from "./solana-agent";
import { wrapSqlite } from "./db";
import type { SolanaPaperMarket } from "./solana-paper-service";
import { runSolanaHoldCommand } from "./solana-operator-hold";
import { ensureSolanaTradingSchema, SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED, SOLANA_LIVE_EXIT_RESERVE, SolanaTradingStoreError } from "./solana-trading-store";
import { SOLANA_LIVE_BELOW_MINIMUM } from "../../packages/core/src/solana";
import { SOLANA_AGENT_ALERT_REPEAT_MS, SOLANA_AGENT_FEE_PAYER_CHECK_MS, SOLANA_PENDING_STUCK_MS, solanaAccountRef } from "./solana-agent";
import { SolanaMarketError } from "./solana-market";

const NOW = 1_000_000;
const limits = { perTradeUsdg: "10000000", dailyUsdg: "100000000", maxOpsPerDay: 20, maxDrawdownBps: 2000, expiresAtMs: NOW + 1000000 };
const strategy = { enabled: true, targetSolBps: 5000, rebalanceBps: 500, tradeUsdgRaw: "5000000", intervalSeconds: 60 };
const input = { cashRaw: "100000000", wsolRaw: "0", solValueUsdgRaw: "0", limits, strategy, mode: "paper" as const, revision: 3, nowMs: NOW, attempt: 0 };
test("rebalance sizes integer buys to the strictest cap without using floating point", () => {
  const buy = planSolanaRebalance(input)!;
  assert.equal(buy.inputMint, SOLANA_USDG_MINT); assert.equal(buy.amountRaw, "5000000");
  assert.equal(planSolanaRebalance({ ...input, limits: { ...limits, perTradeUsdg: "1000000" } })!.amountRaw, "1000000");
  assert.equal(planSolanaRebalance({ ...input, cashRaw: "18446744073709551615" })!.amountRaw, "5000000");
});
test("rebalance sells proportional real units, respects bands, and does not pretend unquoted SOL is worth zero", () => {
  const sell = planSolanaRebalance({ ...input, cashRaw: "0", wsolRaw: "1000000000", solValueUsdgRaw: "100000000" })!;
  assert.equal(sell.inputMint, SOLANA_WRAPPED_SOL_MINT); assert.equal(sell.amountRaw, "50000000");
  assert.equal(planSolanaRebalance({ ...input, cashRaw: "50000000", wsolRaw: "1000000000", solValueUsdgRaw: "50000000" }), null);
  assert.throws(() => planSolanaRebalance({ ...input, wsolRaw: "1000000000" }), /valuation/);
});
test("a rebalance sell never asks for more WSOL than the signed per-trade SOL limit", () => {
  const capped = { ...limits, perTradeWsol: "20000000", dailyWsol: "100000000" };
  const sell = planSolanaRebalance({ ...input, limits: capped, cashRaw: "0", wsolRaw: "1000000000", solValueUsdgRaw: "100000000" })!;
  assert.equal(sell.inputMint, SOLANA_WRAPPED_SOL_MINT); assert.equal(sell.amountRaw, "20000000");
  // A dust mark makes the whole position look like one cheap trade; the SOL limit still holds.
  const dust = planSolanaRebalance({ ...input, limits: capped, cashRaw: "0", wsolRaw: "1000000000", solValueUsdgRaw: "1" })!;
  assert.equal(dust.amountRaw, "20000000");
  // Buys are bounded by the USDG limits as before.
  assert.equal(planSolanaRebalance({ ...input, limits: capped })!.amountRaw, "5000000");
});
test("a live rebalance buy worth under the 1 USDG live minimum is in band; paper has no minimum, and sells are left to admission", () => {
  const small = { ...input, strategy: { ...strategy, tradeUsdgRaw: "999999" } };
  assert.equal(planSolanaRebalance({ ...small, mode: "live" }), null);
  assert.equal(planSolanaRebalance(small)!.amountRaw, "999999");
  assert.equal(planSolanaRebalance({ ...input, mode: "live", strategy: { ...strategy, tradeUsdgRaw: "1000000" } })!.amountRaw, "1000000");
  // The mark can be a dust quote, so a sale is planned and admission values it at the independent reference.
  const sell = planSolanaRebalance({ ...input, mode: "live", strategy: { ...strategy, tradeUsdgRaw: "500000" }, cashRaw: "0", wsolRaw: "1000000000", solValueUsdgRaw: "100000000" })!;
  assert.equal(sell.inputMint, SOLANA_WRAPPED_SOL_MINT); assert.equal(sell.amountRaw, "5000000");
});
test("a live rebalance buy is sized below the room the exit reserve leaves, and none is planned when that room is under the live minimum; sales ignore it", () => {
  const live = { ...input, mode: "live" as const };
  assert.equal(planSolanaRebalance({ ...live, buyRoomUsdgRaw: "3000000" })!.amountRaw, "3000000");
  assert.equal(planSolanaRebalance({ ...live, buyRoomUsdgRaw: "900000000" })!.amountRaw, "5000000", "the strategy size still bounds it");
  assert.equal(planSolanaRebalance({ ...live, buyRoomUsdgRaw: "999999" }), null);
  assert.equal(planSolanaRebalance({ ...live, buyRoomUsdgRaw: "0" }), null);
  const sell = planSolanaRebalance({ ...live, buyRoomUsdgRaw: "0", cashRaw: "0", wsolRaw: "1000000000", solValueUsdgRaw: "100000000" })!;
  assert.equal(sell.inputMint, SOLANA_WRAPPED_SOL_MINT); assert.equal(sell.amountRaw, "50000000");
});
test("request identity names the settings revision and the attempt, never the clock", () => {
  assert.equal(planSolanaRebalance(input)!.requestId, "rebalance-3-0");
  assert.equal(planSolanaRebalance({ ...input, nowMs: NOW + 999_000 })!.requestId, "rebalance-3-0", "16 one-minute intervals later");
  assert.equal(planSolanaRebalance({ ...input, attempt: 1 })!.requestId, "rebalance-3-1");
  assert.equal(planSolanaRebalance({ ...input, revision: 4, attempt: 7 })!.requestId, "rebalance-4-7");
  for (const attempt of [-1, 0.5, NaN]) assert.throws(() => planSolanaRebalance({ ...input, attempt }), /attempt/);
  assert.equal(planSolanaRebalance({ ...input, strategy: { ...strategy, enabled: false } }), null);
  assert.throws(() => planSolanaRebalance({ ...input, nowMs: limits.expiresAtMs }), /expired/);
});
test("partial sells re-quote below the explicit strategy cap instead of treating a haircut as the unit price", async () => {
  const candidate = planSolanaRebalance({ ...input, strategy: { ...strategy, tradeUsdgRaw: "10000000" },
    cashRaw: "0", wsolRaw: "1000000000", solValueUsdgRaw: "99500000" })!;
  assert.equal(candidate.amountRaw, "100502512");
  let quotes = 0;
  const market: SolanaPaperMarket = { readMint: async () => { throw new Error("unused"); }, quote: async i => {
    quotes++;
    const out = BigInt(i.amountRaw) / 10n;
    return { source: "jupiter", inputMint: i.inputMint, outputMint: i.outputMint, inAmount: i.amountRaw, outAmount: out.toString(),
      minOutAmount: (out * 995n / 1000n).toString(), slippageBps: 50, contextSlot: 1, quotedAtMs: NOW, expiresAtMs: NOW + 30000 };
  } };
  const sized = await boundSolanaRebalanceSell(candidate, 10000000n, market, () => NOW);
  assert.ok(sized); assert.ok(BigInt(sized.amountRaw) / 10n <= 10000000n); assert.equal(quotes, 2);
  assert.equal(sized.requestId, candidate.requestId);
});

test("actual paper agent ticks are durable, opt-in and cannot duplicate a fill after worker restart", async () => {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw);
  const tenant = "0x1111111111111111111111111111111111111111", owner = "So11111111111111111111111111111111111111112";
  const scope = { tenant, owner };
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW);
  const market: SolanaPaperMarket = {
    readMint: async mint => ({ address: mint, program: mint === SOLANA_USDG_MINT ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: 10, observedAtMs: NOW, buyBlockedReasons: [] }),
    quote: async i => ({ source: "jupiter", inputMint: i.inputMint, outputMint: i.outputMint, inAmount: i.amountRaw,
      outAmount: i.amountRaw, minOutAmount: (BigInt(i.amountRaw) * 995n / 1000n).toString(), slippageBps: i.slippageBps,
      contextSlot: 10, quotedAtMs: NOW, expiresAtMs: NOW + 30000 }),
  };
  const rpc = { read: async () => { throw new Error("No live RPC in a paper worker test"); }, send: async () => { throw new Error("Must never send"); } };
  try {
    await bindings.bind(tenant, "did:privy:test", owner);
    await bindings.settings(tenant, owner, 0, "paper", limits);
    const runtime = createSolanaAppRuntime({ db, env: {}, market, rpc, now: () => NOW });
    await runtime.setupPaper(scope, { initialCashRaw: input.cashRaw, limits });
    const agent = createSolanaAgent({ db, runtime, market, now: () => NOW });
    assert.deepEqual(await agent.tick(), []);
    await bindings.strategy(tenant, owner, 1, strategy);
    assert.equal((await agent.tick())[0]!.outcome, "submitted");
    const restarted = createSolanaAgent({ db, runtime: createSolanaAppRuntime({ db, env: {}, market, rpc, now: () => NOW }), market, now: () => NOW });
    await restarted.tick();
    assert.equal((await runtime.status(scope)).paper!.trades.length, 1);
    const binding = (await bindings.get(tenant))!;
    await bindings.strategy(tenant, owner, binding.revision, { ...strategy, enabled: false });
    assert.deepEqual(await restarted.tick(), []);
    assert.equal((await runtime.status(scope)).paper!.trades.length, 1);
  } finally { raw.close(); }
});

test("pending confirmation recovery runs even with no enabled strategies", async () => {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw), seen: string[] = [];
  try {
    const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW);
    await bindings.get("0x0000000000000000000000000000000000000000");
    await ensureSolanaTradingSchema(db);
    await db.prepare("INSERT INTO solana_runtime_setups(tenant,owner,setup_json) VALUES(?,?,?)").run("tenant", "owner", JSON.stringify({ status: "pending" }));
    const actual = createSolanaAppRuntime({ db, env: {} });
    const agent = createSolanaAgent({ db, runtime: { ...actual, status: async scope => { seen.push(scope.owner); throw new Error("provider temporarily unavailable"); } },
      market: { readMint: async () => { throw new Error(); }, quote: async () => { throw new Error(); } } });
    assert.deepEqual(await agent.tick(), []); assert.deepEqual(seen, ["owner"]);
  } finally { raw.close(); }
});

test("receipt recovery reads status for a revocation still pending beside an owner transaction that already resolved, with the page closed", async () => {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw), seen: string[] = [];
  try {
    await new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW).get("0x0000000000000000000000000000000000000000");
    await ensureSolanaTradingSchema(db);
    // The withdrawal resolved; the revocation saved beside it is still pending (its first send was lost).
    await db.prepare("INSERT INTO solana_runtime_setups(tenant,owner,setup_json) VALUES(?,?,?)").run("tenant", "owner", JSON.stringify({ kind: "withdraw", signature: "w", status: "finalized" }));
    await db.prepare("INSERT INTO solana_runtime_owner_revokes(tenant,owner,setup_json) VALUES(?,?,?)").run("tenant", "owner", JSON.stringify({ kind: "revoke", signature: "r", status: "pending", beside: "w" }));
    const actual = createSolanaAppRuntime({ db, env: {} });
    const agent = createSolanaAgent({ db, runtime: { ...actual, status: async scope => { seen.push(scope.owner); throw new Error("provider temporarily unavailable"); } },
      market: { readMint: async () => { throw new Error(); }, quote: async () => { throw new Error(); } } });
    assert.deepEqual(await agent.tick(), []); assert.deepEqual(seen, ["owner"], "status (which rebroadcasts and settles it) was read once for that account");
  } finally { raw.close(); }
});

test("process shutdown during an in-flight status or market read never admits a following trade", async t => {
  for (const stage of ["status", "quote"] as const) await t.test(stage, async () => {
    const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw);
    const tenant = "0x1111111111111111111111111111111111111111", owner = SOLANA_WRAPPED_SOL_MINT;
    const scope = { tenant, owner }, controller = new AbortController();
    let entered!: () => void, release!: () => void;
    const inFlight = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    let armed = false, tradeCalls = 0;
    const pause = async () => { entered(); await resume; };
    const market: SolanaPaperMarket = {
      readMint: async mint => ({ address: mint,
        program: mint === SOLANA_USDG_MINT ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: 10, observedAtMs: NOW, buyBlockedReasons: [] }),
      quote: async intent => {
        if (armed && stage === "quote") await pause();
        return { source: "jupiter", inputMint: intent.inputMint, outputMint: intent.outputMint, inAmount: intent.amountRaw,
          outAmount: intent.amountRaw, minOutAmount: (BigInt(intent.amountRaw) * 995n / 1000n).toString(),
          slippageBps: intent.slippageBps, contextSlot: 10, quotedAtMs: NOW, expiresAtMs: NOW + 30_000 };
      },
    };
    const rpc = { read: async () => { throw new Error("No live RPC in a paper shutdown test"); }, send: async () => { throw new Error("Must never send"); } };
    try {
      const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW);
      await bindings.bind(tenant, "did:privy:shutdown", owner);
      await bindings.settings(tenant, owner, 0, "paper", limits);
      const actual = createSolanaAppRuntime({ db, env: {}, market, rpc, now: () => NOW });
      await actual.setupPaper(scope, { initialCashRaw: input.cashRaw, limits });
      // A real held position forces the worker through its valuation quote.
      if (stage === "quote") await actual.trade(scope, { mode: "paper", intent: {
        kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: "initial-holding",
        inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "5000000", slippageBps: 50,
      } });
      const initialTrades = (await actual.status(scope)).paper!.trades.length;
      await bindings.strategy(tenant, owner, 1, strategy);
      const runtime: Pick<typeof actual, "status" | "trade"> = {
        status: async account => {
          const status = await actual.status(account);
          if (armed && stage === "status") await pause();
          return status;
        },
        trade: async (...args) => { tradeCalls++; return actual.trade(...args); },
      };
      armed = true;
      const tick = createSolanaAgent({ db, runtime, market, now: () => NOW, signal: controller.signal }).tick();
      await inFlight;
      assert.equal(tradeCalls, 0);
      controller.abort(); release();
      assert.deepEqual(await tick, []);
      assert.equal(tradeCalls, 0, "shutdown must stop at the agent boundary, before runtime admission");
      armed = false;
      assert.equal((await actual.status(scope)).paper!.trades.length, initialTrades);
      // The same persisted strategy is actionable when a new process is running.
      const restarted = createSolanaAgent({ db, runtime, market, now: () => NOW, signal: new AbortController().signal });
      assert.equal((await restarted.tick())[0]!.outcome, "submitted");
      assert.equal(tradeCalls, 1);
      assert.equal((await actual.status(scope)).paper!.trades.length, initialTrades + 1);
    } finally { release(); raw.close(); }
  });
});

/** A paper account with an enabled strategy, its runtime and a counting trade wrapper. */
async function killFixture(t: import("node:test").TestContext) {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw); t.after(() => raw.close());
  const tenant = "0x1111111111111111111111111111111111111111" as const, owner = SOLANA_WRAPPED_SOL_MINT, scope = { tenant, owner };
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW);
  const market: SolanaPaperMarket = {
    readMint: async mint => ({ address: mint, program: mint === SOLANA_USDG_MINT ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: 10, observedAtMs: NOW, buyBlockedReasons: [] }),
    quote: async i => ({ source: "jupiter", inputMint: i.inputMint, outputMint: i.outputMint, inAmount: i.amountRaw,
      outAmount: i.amountRaw, minOutAmount: (BigInt(i.amountRaw) * 995n / 1000n).toString(), slippageBps: i.slippageBps,
      contextSlot: 10, quotedAtMs: NOW, expiresAtMs: NOW + 30000 }),
  };
  const rpc = { read: async () => { throw new Error("No live RPC in a paper worker test"); }, send: async () => { throw new Error("Must never send"); } };
  await bindings.bind(tenant, "did:privy:kill", owner);
  await bindings.settings(tenant, owner, 0, "paper", limits);
  const actual = createSolanaAppRuntime({ db, env: {}, market, rpc, now: () => NOW });
  await actual.setupPaper(scope, { initialCashRaw: input.cashRaw, limits });
  await bindings.strategy(tenant, owner, 1, strategy);
  const trades = async () => (await actual.status(scope)).paper!.trades.length;
  return { db, tenant, scope, bindings, market, actual, trades };
}

test("a kill stops the Solana worker: kill, tick, no trade (audit 2026-10-18)", async t => {
  const f = await killFixture(t);
  // Hosted with the shared database: the kill names the tenant.
  const saved = { db: process.env.DATABASE_URL, hosted: process.env.MERRYMEN_HOSTED };
  process.env.DATABASE_URL = "postgres://127.0.0.1:1/never-connected"; process.env.MERRYMEN_HOSTED = "1";
  t.after(() => { for (const [k, v] of [["DATABASE_URL", saved.db], ["MERRYMEN_HOSTED", saved.hosted]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  assert.equal(await stopSolanaForKill(f.tenant, f.bindings), "stopped");
  assert.deepEqual(await createSolanaAgent({ db: f.db, runtime: f.actual, market: f.market, now: () => NOW }).tick(), []);
  assert.equal(await f.trades(), 0);
});

test("a kill that lands mid-tick is fenced at admission by the revision bump", async t => {
  const f = await killFixture(t);
  let tradeCalls = 0;
  const runtime: Pick<typeof f.actual, "status" | "trade"> = {
    // The worker has read the enabled strategy and its revision; the kill lands now.
    status: async scope => { const status = await f.actual.status(scope); await f.bindings.disableForKill(f.tenant); return status; },
    trade: async (...args) => { tradeCalls++; return f.actual.trade(...args); },
  };
  assert.deepEqual((await createSolanaAgent({ db: f.db, runtime, market: f.market, now: () => NOW }).tick()).map(r => r.outcome), ["unavailable"]);
  assert.equal(tradeCalls, 1, "the worker asked to trade with the revision it read");
  assert.equal(await f.trades(), 0, "and admission refused it");
});

test("an operator hold stops the worker and every new trade, for one tenant or all, until released", async t => {
  const f = await killFixture(t);
  await assert.rejects(runSolanaHoldCommand(f.db, ["set", "0xABC", "--reason", "x"], NOW), /tenant address/);
  await assert.rejects(runSolanaHoldCommand(f.db, ["set", f.tenant, "--reason", "two\nlines"], NOW), /one-line reason/);
  await assert.rejects(runSolanaHoldCommand(f.db, ["set", f.tenant], NOW), /Usage/);
  for (const target of [f.tenant, "all"]) {
    assert.match(await runSolanaHoldCommand(f.db, ["set", target, "--reason", "incident 42"], NOW), /held/);
    assert.match(await runSolanaHoldCommand(f.db, ["list"], NOW), /incident 42/);
    assert.deepEqual((await createSolanaAgent({ db: f.db, runtime: f.actual, market: f.market, now: () => NOW }).tick()).map(r => r.outcome), ["held"]);
    // A manual trade is refused too, and the status says why.
    await assert.rejects(f.actual.trade(f.scope, { mode: "paper", intent: { kind: "spl-swap", chain: CHAINS.solana, mode: "paper", requestId: `manual-${target}`,
      inputMint: SOLANA_USDG_MINT, outputMint: SOLANA_WRAPPED_SOL_MINT, amountRaw: "1000000", slippageBps: 50 } }), /operator hold/);
    assert.match((await f.actual.status(f.scope)).live.blockers.join(" "), /operator hold/);
    assert.equal(await f.trades(), 0);
    assert.match(await runSolanaHoldCommand(f.db, ["release", target], NOW), /released/);
  }
  assert.match(await runSolanaHoldCommand(f.db, ["list"], NOW), /No Solana operator holds/);
  assert.deepEqual((await createSolanaAgent({ db: f.db, runtime: f.actual, market: f.market, now: () => NOW }).tick()).map(r => r.outcome), ["submitted"]);
  assert.equal(await f.trades(), 1);
});

const TENANT = "0x1111111111111111111111111111111111111111" as const, OWNER = SOLANA_WRAPPED_SOL_MINT;
/** A paper account on a shared clock, with status, quote and trade calls counted. */
async function paperAccount(t: import("node:test").TestContext, interval = 86_400, targetSolBps = strategy.targetSolBps) {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw); t.after(() => raw.close());
  const clock = { now: NOW }, calls = { status: 0, quote: 0, trade: 0 }, scope = { tenant: TENANT, owner: OWNER };
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => clock.now);
  const market: SolanaPaperMarket = {
    readMint: async mint => ({ address: mint, program: mint === SOLANA_USDG_MINT ? "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      decimals: mint === SOLANA_USDG_MINT ? 6 : 9, slot: 10, observedAtMs: clock.now, buyBlockedReasons: [] }),
    quote: async i => { calls.quote++; return { source: "jupiter", inputMint: i.inputMint, outputMint: i.outputMint, inAmount: i.amountRaw,
      outAmount: i.amountRaw, minOutAmount: (BigInt(i.amountRaw) * 995n / 1000n).toString(), slippageBps: i.slippageBps,
      contextSlot: 10, quotedAtMs: clock.now, expiresAtMs: clock.now + 30000 }; },
  };
  const rpc = { read: async () => { throw new Error("No live RPC in a paper worker test"); }, send: async () => { throw new Error("Must never send"); } };
  const paperLimits = { ...limits, expiresAtMs: NOW + 7 * 86_400_000 - 1 };
  await bindings.bind(TENANT, "did:privy:interval", OWNER);
  await bindings.settings(TENANT, OWNER, 0, "paper", paperLimits);
  const actual = createSolanaAppRuntime({ db, env: {}, market, rpc, now: () => clock.now });
  await actual.setupPaper(scope, { initialCashRaw: input.cashRaw, limits: paperLimits });
  await bindings.strategy(TENANT, OWNER, 1, { ...strategy, intervalSeconds: interval, targetSolBps });
  const runtime: Pick<typeof actual, "status" | "trade"> = {
    status: async (...args) => { calls.status++; return actual.status(...args); },
    trade: async (...args) => { calls.trade++; return actual.trade(...args); },
  };
  const agent = () => createSolanaAgent({ db, runtime, market, now: () => clock.now });
  const trades = async () => (await actual.status(scope)).paper!.trades.map(trade => trade.requestId);
  return { db, clock, calls, scope, bindings, market, actual, runtime, agent, trades };
}

test("the strategy interval is a durable minimum spacing between attempts, not a clock bucket (audit agent-deploy F2)", async t => {
  // The audit's run: a daily strategy traded at boundary-30s and again at the boundary, 30 s apart.
  const f = await paperAccount(t), boundary = Math.ceil(NOW / 86_400_000) * 86_400_000;
  f.clock.now = boundary - 30_000;
  const agent = f.agent();
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["submitted"]);
  f.clock.now = boundary;
  const before = { ...f.calls };
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["waiting"]);
  assert.deepEqual(f.calls, before, "no status read, quote or trade until the interval is due");
  // A restarted worker reads the same durable schedule.
  assert.deepEqual((await f.agent().tick()).map(r => r.outcome), ["waiting"]);
  assert.deepEqual(await f.trades(), ["rebalance-2-0"]);
  // Admission enforces the spacing itself: a fresh request inside the interval is refused under the lock.
  const early = planSolanaRebalance({ ...input, limits: { ...limits, expiresAtMs: f.clock.now + 60_000 }, revision: 2, attempt: 1, nowMs: f.clock.now })!;
  await assert.rejects(f.actual.trade(f.scope, { mode: "paper", intent: early, autonomousRevision: 2 }), /not due/);
  // One full interval after the last attempt the strategy checks, and trades, again.
  f.clock.now = boundary - 30_000 + 86_400_000;
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["submitted"]);
  assert.deepEqual(await f.trades(), ["rebalance-2-1", "rebalance-2-0"]);
  // Manual trades cannot take the strategy's request IDs.
  await assert.rejects(f.actual.trade(f.scope, { mode: "paper", intent: { ...early, requestId: "rebalance-2-2" } }), /belong to the autonomous strategy/);
});

test("a strategy in band is not re-checked, re-read or re-quoted until its interval passes", async t => {
  // An all-USDG account with a 0% SOL target: nothing to do.
  const f = await paperAccount(t, 3_600, 0);
  const agent = f.agent();
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["held"]);
  const after = { ...f.calls };
  f.clock.now += 15_000;
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["waiting"]);
  assert.deepEqual(f.calls, after);
  f.clock.now += 3_600_000;
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["held"]);
  assert.equal(f.calls.status, after.status + 1, "checked again once the interval passed");
});

test("an attempt another worker already admitted is reported as a replay, not a submission (audit agent-deploy F5)", async t => {
  const f = await paperAccount(t);
  // A second worker admits this account's attempt while the first is reading status.
  const racing: Pick<typeof f.actual, "status" | "trade"> = {
    status: async (...args) => {
      const status = await f.actual.status(...args);
      await createSolanaAgent({ db: f.db, runtime: f.actual, market: f.market, now: () => f.clock.now }).tick();
      return status;
    },
    trade: async (...args) => { f.calls.trade++; return f.actual.trade(...args); },
  };
  assert.deepEqual((await createSolanaAgent({ db: f.db, runtime: racing, market: f.market, now: () => f.clock.now }).tick()).map(r => r.outcome), ["replayed"]);
  assert.equal(f.calls.trade, 0, "nothing was sent to admission");
  assert.deepEqual(await f.trades(), ["rebalance-2-0"]);
});

test("a proven-expired live attempt is retried at once under a fresh request ID, never the expired one (audit G2-2)", async t => {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw); t.after(() => raw.close());
  const clock = { now: NOW }, scope = { tenant: TENANT, owner: OWNER }, sent: string[] = [];
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => clock.now);
  await bindings.bind(TENANT, "did:privy:retry", OWNER);
  await bindings.settings(TENANT, OWNER, 0, "live", { ...limits, perTradeWsol: "100000000", dailyWsol: "1000000000" });
  await bindings.strategy(TENANT, OWNER, 1, { ...strategy, intervalSeconds: 86_400 });
  await ensureSolanaTradingSchema(db);
  let pending: unknown[] = [];
  // Admission as the store records it: one pending submission and its attempt, written together.
  const runtime = {
    status: async () => ({ paper: null, live: { balances: {}, tradable: { cashUsdg: "100000000", wsolRaw: "0" }, pending, ready: true, canExit: true, blockers: [] } }),
    trade: async (_scope: unknown, request: { intent: { requestId: string } }) => {
      const id = request.intent.requestId; sent.push(id);
      await db.prepare(`INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json)
        VALUES(?,?,?,?,?,?,'pending',?,?,?)`).run(TENANT, OWNER, id, "vault", String(sent.length), `sig-${id}`, clock.now, "5000000", "{}");
      await db.prepare("INSERT INTO solana_runtime_autonomous_attempts(tenant,owner,request_id,attempted_at_ms) VALUES(?,?,?,?)").run(TENANT, OWNER, id, clock.now);
      return {};
    },
  } as unknown as Parameters<typeof createSolanaAgent>[0]["runtime"];
  const market: SolanaPaperMarket = { readMint: async () => { throw new Error("unused"); }, quote: async () => { throw new Error("a buy needs no quote"); } };
  const agent = createSolanaAgent({ db, runtime, market, now: () => clock.now });
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["submitted"]);
  pending = [{}];
  clock.now += 60_000;
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["waiting"], "a pending attempt keeps the interval");
  // Finalized evidence proves the packet was dropped.
  await db.prepare("UPDATE solana_runtime_submissions SET status='expired' WHERE request_id=?").run("rebalance-2-0"); pending = [];
  clock.now += 60_000;
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["submitted"], "retried within the same daily interval");
  assert.deepEqual(sent, ["rebalance-2-0", "rebalance-2-1"]);
  // A retry that landed (or failed on chain) keeps the interval again.
  await db.prepare("UPDATE solana_runtime_submissions SET status='finalized' WHERE request_id=?").run("rebalance-2-1");
  clock.now += 60_000;
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["waiting"]);
  assert.deepEqual(sent, ["rebalance-2-0", "rebalance-2-1"]);
});

/**
 * A live account whose strategy buys every tick, with `expired` proven-expired attempts and `failed` failed
 * trades in the last 24 hours, and a runtime stub that counts status reads and trades.
 */
async function expiryAccount(t: { after: (fn: () => void) => void }, input: { maxOpsPerDay: number; expired: number; failed?: number }) {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw); t.after(() => raw.close());
  const clock = { now: NOW }, lines: string[] = [];
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => clock.now);
  await bindings.bind(TENANT, "did:privy:expiry", OWNER);
  // Long enough that every tick below stays inside the signed window, so a refusal reaches runtime.trade.
  await bindings.settings(TENANT, OWNER, 0, "live", { ...limits, maxOpsPerDay: input.maxOpsPerDay, perTradeWsol: "100000000", dailyWsol: "1000000000",
    expiresAtMs: NOW + 100 * 3_600_000 });
  await bindings.strategy(TENANT, OWNER, 1, { ...strategy, intervalSeconds: 60 });
  await ensureSolanaTradingSchema(db);
  for (let i = 0; i < input.expired; i++) {
    await db.prepare(`INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json)
      VALUES(?,?,?,?,?,?,'expired',?,?,?)`).run(TENANT, OWNER, `dropped-${i}`, "vault", "0", `sig-dropped-${i}`, clock.now - 1000 - i, "5000000", "{}");
  }
  for (let i = 0; i < (input.failed ?? 0); i++) {
    await db.prepare(`INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json)
      VALUES(?,?,?,?,?,?,'failed',?,?,?)`).run(TENANT, OWNER, `failed-${i}`, "vault", "0", `sig-failed-${i}`, clock.now - 2000 - i, "5000000", "{}");
  }
  const control = { refuse: null as Error | null, trades: 0, statuses: 0 };
  const runtime = {
    status: async () => { control.statuses++; return { paper: null, live: { balances: {}, tradable: { cashUsdg: "100000000", wsolRaw: "0" }, pending: [], ready: true, canExit: true, blockers: [] } }; },
    trade: async () => { control.trades++; if (control.refuse) throw control.refuse; return {}; },
  } as unknown as Parameters<typeof createSolanaAgent>[0]["runtime"];
  const market: SolanaPaperMarket = { readMint: async () => { throw new Error("unused"); }, quote: async () => { throw new Error("a buy needs no quote"); } };
  const agent = (allowance?: number) => createSolanaAgent({ db, runtime, market, now: () => clock.now, log: line => lines.push(line),
    ...(allowance === undefined ? {} : { expiredAttemptAllowance: allowance }) });
  return { db, clock, lines, control, agent };
}
const fieldsOf = (line: string) => JSON.parse(line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1)) as Record<string, unknown>;

test("a strategy whose expired attempts used up the day's operations is held before any status read, quote or trade, and says an [alert] the operator can act on", async t => {
  const f = await expiryAccount(t, { maxOpsPerDay: 4, expired: 4 });
  const agent = f.agent();
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["held"]);
  assert.equal(f.lines.length, 1);
  assert.match(f.lines[0]!, /^\[alert\] Solana autonomous strategy refused: proven-expired attempts used up an account's daily operations/);
  assert.match(f.lines[0]!, /MERRYMEN_SOLANA_EXPIRED_ATTEMPT_ALLOWANCE/);
  assert.deepEqual(fieldsOf(f.lines[0]!), { solana: "alert", kind: "expired-attempts-exhausted", account: solanaAccountRef({ tenant: TENANT, owner: OWNER }),
    expired: 4, counted: 4, allowance: 0, operations: 0, maxOpsPerDay: 4 });
  // No tenant identity or owner key in the line.
  assert.ok(!f.lines[0]!.includes(TENANT) && !f.lines[0]!.includes(OWNER));
  // The worker's 15 s loop, for two minutes: no paid status read, quote, route or signature while it waits for the window.
  for (let i = 0; i < 8; i++) { f.clock.now += 15_000; assert.deepEqual((await agent.tick()).map(r => r.outcome), ["held"]); }
  assert.deepEqual([f.control.statuses, f.control.trades], [0, 0]);
  // Said once per repeat window while it persists, then again.
  assert.equal(f.lines.length, 1);
  f.clock.now += SOLANA_AGENT_ALERT_REPEAT_MS; await agent.tick(); assert.equal(f.lines.length, 2);
  // An allowance that leaves an operation lets the strategy trade again.
  assert.deepEqual((await f.agent(1).tick()).map(r => r.outcome), ["submitted"]);
  assert.deepEqual([f.control.statuses, f.control.trades], [1, 1]);
  // Trades alone at the limit: the owner's own daily limit, held as quietly (no expired attempt [alert]).
  const used = await expiryAccount(t, { maxOpsPerDay: 4, expired: 0, failed: 4 });
  assert.deepEqual((await used.agent().tick()).map(r => r.outcome), ["held"]);
  assert.deepEqual([used.control.statuses, used.control.trades, used.lines], [0, 0, []]);
  // One operation left: the strategy is tried.
  const left = await expiryAccount(t, { maxOpsPerDay: 4, expired: 2, failed: 1 });
  assert.deepEqual((await left.agent().tick()).map(r => r.outcome), ["submitted"]);
});

test("admission's own refusal for expired attempts is said as the [alert] and not tried again until the interval passes; any other refusal reaches runtime.trade", async t => {
  // 3 of 4 counted: the agent's own count leaves one operation, and admission (which counted one more) refuses.
  const f = await expiryAccount(t, { maxOpsPerDay: 4, expired: 3 });
  f.control.refuse = new SolanaTradingStoreError(SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED);
  const agent = f.agent();
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["held"]);
  assert.equal(f.control.trades, 1);
  assert.equal(f.lines.length, 1);
  assert.deepEqual(fieldsOf(f.lines[0]!), { solana: "alert", kind: "expired-attempts-exhausted", account: solanaAccountRef({ tenant: TENANT, owner: OWNER }),
    expired: 3, counted: 3, allowance: 0, operations: 0, maxOpsPerDay: 4 });
  // Ticks 15 s apart inside the 60 s interval: no status read, no paid route.
  for (let i = 0; i < 3; i++) { f.clock.now += 15_000; assert.deepEqual((await agent.tick()).map(r => r.outcome), ["waiting"]); }
  assert.deepEqual([f.control.statuses, f.control.trades], [1, 1]);
  f.clock.now += 15_000; assert.deepEqual((await agent.tick()).map(r => r.outcome), ["held"]);
  assert.deepEqual([f.control.statuses, f.control.trades], [2, 2], "tried once more after one interval");
  assert.equal(f.lines.length, 1, "said once per repeat window");
  // Any other refusal is not this alert, and stays an unavailable outcome that came from runtime.trade.
  f.control.refuse = new SolanaTradingStoreError("The Solana rolling daily limit would be exceeded.");
  f.clock.now += 60_000; assert.deepEqual((await agent.tick()).map(r => r.outcome), ["unavailable"]);
  assert.equal(f.control.trades, 3, "the rolling-limit refusal came from runtime.trade");
  f.control.refuse = new Error(SOLANA_EXPIRED_ATTEMPTS_EXHAUSTED);
  f.clock.now += 15_000; assert.deepEqual((await agent.tick()).map(r => r.outcome), ["unavailable"]);
  assert.equal(f.control.trades, 4, "the untyped refusal came from runtime.trade, and an unavailable tick is not spaced");
  assert.equal(f.lines.length, 1);
});

test("a live rebalance admission refuses as below the 1 USDG minimum is tried at most once per strategy interval, and says a [warn] why", async t => {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw); t.after(() => raw.close());
  const clock = { now: NOW }, lines: string[] = [];
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => clock.now);
  await bindings.bind(TENANT, "did:privy:minimum", OWNER);
  await bindings.settings(TENANT, OWNER, 0, "live", { ...limits, perTradeWsol: "100000000", dailyWsol: "1000000000", expiresAtMs: NOW + 100 * 3_600_000 });
  // A 0.50 USDG strategy trade against a book of 1 SOL and no USDG: every rebalance is a sale worth under the minimum.
  await bindings.strategy(TENANT, OWNER, 1, { ...strategy, tradeUsdgRaw: "500000", intervalSeconds: 30 });
  await ensureSolanaTradingSchema(db);
  const control = { refuse: new SolanaTradingStoreError(SOLANA_LIVE_BELOW_MINIMUM) as Error | null, trades: [] as Array<{ inputMint: string; amountRaw: string }>, statuses: 0, quotes: 0 };
  const runtime = {
    status: async () => { control.statuses++; return { paper: null, live: { balances: {}, tradable: { cashUsdg: "0", wsolRaw: "1000000000" }, pending: [], ready: true, canExit: true, blockers: [] } }; },
    // In production each call is the executor's whole quote, route, simulation and signature before admission refuses.
    trade: async (_scope: unknown, request: { intent: { inputMint: string; amountRaw: string } }) => { control.trades.push(request.intent); if (control.refuse) throw control.refuse; return {}; },
  } as unknown as Parameters<typeof createSolanaAgent>[0]["runtime"];
  // 1 SOL at 100 USDG.
  const market: SolanaPaperMarket = { readMint: async () => { throw new Error("unused"); }, quote: async i => {
    control.quotes++;
    const out = BigInt(i.amountRaw) / 10n;
    return { source: "jupiter", inputMint: i.inputMint, outputMint: i.outputMint, inAmount: i.amountRaw, outAmount: out.toString(),
      minOutAmount: (out * 995n / 1000n).toString(), slippageBps: 50, contextSlot: 1, quotedAtMs: clock.now, expiresAtMs: clock.now + 30000 };
  } };
  const agent = createSolanaAgent({ db, runtime, market, now: () => clock.now, log: line => lines.push(line) });
  // The worker's 15 s loop for two minutes: tried at 0, 30, 60 and 90 s, waiting in between, never unavailable.
  const outcomes: string[] = [];
  for (let i = 0; i < 8; i++) { if (i) clock.now += 15_000; outcomes.push(...(await agent.tick()).map(r => r.outcome)); }
  assert.deepEqual(outcomes, ["held", "waiting", "held", "waiting", "held", "waiting", "held", "waiting"]);
  assert.equal(control.trades.length, 4, "once per 30 s interval, not once per tick");
  // Each try: the mark and the sale's two re-quotes below the strategy cap. Nothing while it waits.
  assert.deepEqual([control.statuses, control.quotes], [4, 12], "no status read or quote while it waits");
  assert.ok(control.trades.every(i => i.inputMint === SOLANA_WRAPPED_SOL_MINT));
  // Said once per repeat window, with no tenant identity.
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\[warn\] Solana autonomous rebalance below the live minimum/);
  assert.deepEqual(fieldsOf(lines[0]!), { solana: "warn", kind: "below-live-minimum", account: solanaAccountRef({ tenant: TENANT, owner: OWNER }),
    side: "sell", minimumUsdgRaw: "1000000", intervalSeconds: 30 });
  assert.ok(!lines[0]!.includes(TENANT) && !lines[0]!.includes(OWNER));
  clock.now += SOLANA_AGENT_ALERT_REPEAT_MS; await agent.tick(); assert.equal(lines.length, 2, "said again after the repeat window");
  // Once the strategy trades, the next refusal is said at once.
  control.refuse = null; clock.now += 30_000;
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["submitted"]);
  control.refuse = new SolanaTradingStoreError(SOLANA_LIVE_BELOW_MINIMUM); clock.now += 30_000;
  await db.prepare("DELETE FROM solana_runtime_autonomous_attempts").run();
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["held"]);
  assert.equal(lines.length, 3);
  // Any other refusal is still unavailable and not spaced.
  control.refuse = new SolanaTradingStoreError("The Solana rolling daily limit would be exceeded."); clock.now += 30_000;
  const before = control.trades.length;
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["unavailable"]);
  clock.now += 15_000; assert.deepEqual((await agent.tick()).map(r => r.outcome), ["unavailable"]);
  assert.equal(control.trades.length, before + 2);
});

test("a live buy refused for the exit reserve (before signing or at admission) is in band: tried again once per strategy interval, never every tick; sizing reads the window", async t => {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw); t.after(() => raw.close());
  const clock = { now: NOW };
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => clock.now);
  await bindings.bind(TENANT, "did:privy:reserve", OWNER);
  await bindings.settings(TENANT, OWNER, 0, "live", { ...limits, perTradeWsol: "100000000", dailyWsol: "1000000000", expiresAtMs: NOW + 100 * 3_600_000 });
  // 5 USDG strategy trades into a book of 100 USDG and no SOL: every rebalance is a buy.
  await bindings.strategy(TENANT, OWNER, 1, { ...strategy, intervalSeconds: 30 });
  await ensureSolanaTradingSchema(db);
  const control = { refuse: new SolanaTradingStoreError(SOLANA_LIVE_EXIT_RESERVE) as Error | null, trades: [] as Array<{ inputMint: string; amountRaw: string }>, statuses: 0 };
  const runtime = {
    status: async () => { control.statuses++; return { paper: null, live: { balances: {}, tradable: { cashUsdg: "100000000", wsolRaw: "0" }, pending: [], ready: true, canExit: true, blockers: [] } }; },
    trade: async (_scope: unknown, request: { intent: { inputMint: string; amountRaw: string } }) => { control.trades.push(request.intent); if (control.refuse) throw control.refuse; return {}; },
  } as unknown as Parameters<typeof createSolanaAgent>[0]["runtime"];
  const market: SolanaPaperMarket = { readMint: async () => { throw new Error("unused"); }, quote: async () => { throw new Error("no SOL held, no mark"); } };
  const agent = createSolanaAgent({ db, runtime, market, now: () => clock.now });
  const outcomes: string[] = [];
  for (let i = 0; i < 4; i++) { if (i) clock.now += 15_000; outcomes.push(...(await agent.tick()).map(r => r.outcome)); }
  assert.deepEqual(outcomes, ["held", "waiting", "held", "waiting"]);
  assert.equal(control.trades.length, 2, "once per 30 s interval");
  assert.ok(control.trades.every(i => i.inputMint === SOLANA_USDG_MINT && i.amountRaw === "5000000"));
  // 98.5 of the 100 USDG used in the window leaves no room for a 1 USDG buy and its exit (1 + 1.03 > 1.5): none is tried at all.
  await db.prepare(`INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(TENANT, OWNER, "used", "vault", "0", "sig-used", "finalized", clock.now - 1000, "98500000",
    JSON.stringify({ intent: { requestId: "used", inputMint: SOLANA_USDG_MINT, amountRaw: "98500000" } }));
  control.refuse = null; clock.now += 30_000;
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["held"]);
  assert.equal(control.trades.length, 2, "no buy planned below the live minimum");
});

test("a live buy is sized within the registered permission's USDG per 24 hours limit where it is below the saved one: the vault sells the exit under its own", async t => {
  const tick = async (registeredDailyUsdg: string | null) => {
    const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw); t.after(() => raw.close());
    const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW);
    await bindings.bind(TENANT, "did:privy:registered", OWNER);
    // Saved at 100 USDG a day; 5 USDG strategy trades into a book of 100 USDG and no SOL: every rebalance is a buy.
    await bindings.settings(TENANT, OWNER, 0, "live", { ...limits, perTradeWsol: "100000000", dailyWsol: "1000000000", expiresAtMs: NOW + 100 * 3_600_000 });
    await bindings.strategy(TENANT, OWNER, 1, { ...strategy, intervalSeconds: 30 });
    await ensureSolanaTradingSchema(db);
    // 8.5 USDG used in the window.
    await db.prepare(`INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(TENANT, OWNER, "used", "vault", "0", "sig-used", "finalized", NOW - 1000, "8500000",
      JSON.stringify({ intent: { requestId: "used", inputMint: SOLANA_USDG_MINT, amountRaw: "8500000" } }));
    // The permission as activateLive keeps it; null: one recorded before limits were kept.
    const record = { programId: "program", vault: "vault", session: "session", sessionEpoch: "1", registrationSignature: "registration", registeredAtMs: NOW,
      ...(registeredDailyUsdg ? { limits: { perTradeUsdg: limits.perTradeUsdg, dailyUsdg: registeredDailyUsdg, perTradeWsol: "100000000", dailyWsol: "1000000000" } } : {}) };
    await db.prepare("INSERT INTO solana_runtime_sessions(tenant,owner,record_json,sealed_seed) VALUES(?,?,?,?)").run(TENANT, OWNER, JSON.stringify(record), "sealed");
    const trades: Array<{ inputMint: string; amountRaw: string }> = [];
    const runtime = {
      status: async () => ({ paper: null, live: { balances: {}, tradable: { cashUsdg: "100000000", wsolRaw: "0" }, pending: [], ready: true, canExit: true, blockers: [] } }),
      trade: async (_scope: unknown, request: { intent: { inputMint: string; amountRaw: string } }) => { trades.push(request.intent); return {}; },
    } as unknown as Parameters<typeof createSolanaAgent>[0]["runtime"];
    const market: SolanaPaperMarket = { readMint: async () => { throw new Error("unused"); }, quote: async () => { throw new Error("no SOL held, no mark"); } };
    const outcomes = (await createSolanaAgent({ db, runtime, market, now: () => NOW }).tick()).map(r => r.outcome);
    return { outcomes, trades };
  };
  // Registered at 10 USDG a day: 1.5 USDG is left, too little for a 1 USDG buy and its exit, so none is planned (in band).
  assert.deepEqual(await tick("10000000"), { outcomes: ["held"], trades: [] });
  // Registered above the saved 100, or before limits were kept: the saved limit sizes it, and the strategy's 5 USDG buy is tried.
  for (const registered of ["500000000", null]) {
    const roomy = await tick(registered);
    assert.deepEqual(roomy.outcomes, ["submitted"], String(registered));
    assert.deepEqual(roomy.trades.map(i => [i.inputMint, i.amountRaw]), [[SOLANA_USDG_MINT, "5000000"]], String(registered));
  }
});

test("expired attempts that count for more than half of the day's operations say a [warn]; within half, or covered by the allowance, nothing", async t => {
  // 3 of 4 operations counted: more than half.
  const high = await expiryAccount(t, { maxOpsPerDay: 4, expired: 3 });
  assert.deepEqual((await high.agent().tick()).map(r => r.outcome), ["submitted"]);
  assert.equal(high.lines.length, 1);
  assert.match(high.lines[0]!, /^\[warn\] Solana proven-expired attempts use more than half of an account's daily operations/);
  assert.deepEqual(fieldsOf(high.lines[0]!), { solana: "warn", kind: "expired-attempts-high", account: solanaAccountRef({ tenant: TENANT, owner: OWNER }),
    expired: 3, counted: 3, allowance: 0, operations: 0, maxOpsPerDay: 4 });
  // Exactly half is not more than half.
  const half = await expiryAccount(t, { maxOpsPerDay: 4, expired: 2 });
  assert.deepEqual((await half.agent().tick()).map(r => r.outcome), ["submitted"]); assert.deepEqual(half.lines, []);
  // An allowance of 2 leaves one of the three counted.
  const allowed = await expiryAccount(t, { maxOpsPerDay: 4, expired: 3 });
  assert.deepEqual((await allowed.agent(2).tick()).map(r => r.outcome), ["submitted"]); assert.deepEqual(allowed.lines, []);
  // Attempts older than the 24 h window count for nothing.
  const old = await expiryAccount(t, { maxOpsPerDay: 4, expired: 3 });
  old.clock.now += 86_400_000;
  await old.db.prepare("UPDATE solana_wallet_bindings SET limits_json=?").run(JSON.stringify({ ...limits, maxOpsPerDay: 4, perTradeWsol: "100000000", dailyWsol: "1000000000", expiresAtMs: old.clock.now + 1_000_000 }));
  assert.deepEqual((await old.agent().tick()).map(r => r.outcome), ["submitted"]); assert.deepEqual(old.lines, []);
});

test("the agent's SOL mark: a zero-output answer is dust planned as no position; any other failure stops the tick before any trade", async t => {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw); t.after(() => raw.close());
  const bindings = new SqlSolanaBindingStore(async () => db, "sqlite", () => NOW);
  await bindings.bind(TENANT, "did:privy:mark", OWNER);
  await bindings.settings(TENANT, OWNER, 0, "live", { ...limits, perTradeWsol: "100000000", dailyWsol: "1000000000", expiresAtMs: NOW + 100 * 3_600_000 });
  await bindings.strategy(TENANT, OWNER, 1, { ...strategy, intervalSeconds: 60 });
  await ensureSolanaTradingSchema(db);
  const trades: Array<{ inputMint: string; amountRaw: string }> = [], dustChecks: string[] = [];
  // The runtime's Pyth dust check (solMarkDust): `dust` says what it shows.
  let dust: boolean | "absent" = true;
  const runtime = {
    status: async () => ({ paper: null, live: { balances: {}, tradable: { cashUsdg: "100000000", wsolRaw: "1000" }, pending: [], ready: true, canExit: true, blockers: [] } }),
    trade: async (_scope: unknown, request: { intent: { inputMint: string; amountRaw: string } }) => { trades.push(request.intent); return {}; },
    get solMarkDust() { return dust === "absent" ? undefined : async (wsolRaw: string) => { dustChecks.push(wsolRaw); return dust; }; },
  } as unknown as Parameters<typeof createSolanaAgent>[0]["runtime"];
  const zero = new SolanaMarketError("zero-output", { source: "jupiter", inputMint: SOLANA_WRAPPED_SOL_MINT, outputMint: SOLANA_USDG_MINT,
    inAmount: "1000", outAmount: "0", minOutAmount: "0", slippageBps: 50, contextSlot: 1, quotedAtMs: NOW });
  let failure: Error = zero;
  const market: SolanaPaperMarket = { readMint: async () => { throw new Error("unused"); }, quote: async () => { throw failure; } };
  const clock = { now: NOW };
  const agent = createSolanaAgent({ db, runtime, market, now: () => clock.now });
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["submitted"]);
  assert.deepEqual(trades.map(i => [i.inputMint, i.amountRaw]), [[SOLANA_USDG_MINT, "5000000"]], "a buy toward the target, as if no SOL were held");
  assert.deepEqual(dustChecks, ["1000"], "dust by the independent price");
  // A zero-output answer for SOL Pyth does not show to be dust, or with no way to check, is a mark failure like any other.
  for (const shown of [false, "absent"] as const) {
    dust = shown; clock.now += 3_600_000;
    assert.deepEqual((await agent.tick()).map(r => r.outcome), ["unavailable"], String(shown));
  }
  dust = true;
  for (const other of [new SolanaMarketError("invalid-quote"), new SolanaMarketError("stale-quote"), new Error("network")]) {
    failure = other; clock.now += 3_600_000;
    assert.deepEqual((await agent.tick()).map(r => r.outcome), ["unavailable"], other.message);
  }
  assert.equal(trades.length, 1, "no trade on any other mark failure");
  assert.equal(dustChecks.length, 2, "only a zero-output answer is checked for dust");
});

test("a live account whose vault holds less than its book is held, and says an [alert] with no tenant identity, once per repeat window", async t => {
  const f = await expiryAccount(t, { maxOpsPerDay: 20, expired: 0 });
  const below = { paper: null, live: { balances: {}, tradable: { cashUsdg: "100000000", wsolRaw: "0" }, pending: [], ready: false, canExit: false, blockers: [SOLANA_STATUS_BELOW_BOOK] } };
  let status: unknown = below;
  const runtime = { status: async () => status, trade: async () => { f.control.trades++; return {}; } } as unknown as Parameters<typeof createSolanaAgent>[0]["runtime"];
  const market: SolanaPaperMarket = { readMint: async () => { throw new Error("unused"); }, quote: async () => { throw new Error("a buy needs no quote"); } };
  const agent = createSolanaAgent({ db: f.db, runtime, market, now: () => f.clock.now, log: line => f.lines.push(line) });
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["held"]);
  assert.equal(f.control.trades, 0);
  assert.equal(f.lines.length, 1);
  assert.match(f.lines[0]!, /^\[alert\] Solana vault below its book: /);
  // It names the remedies: the owner records their own withdrawals; anything else an operator finds and writes off with the
  // shortfall tool, named by the account reference the alert carries (no tenant identity), as the plan of record says.
  const account = solanaAccountRef({ tenant: TENANT, owner: OWNER });
  assert.match(f.lines[0]!, /If the owner withdrew with their own key \(the recovery tool or another wallet\), they record those withdrawals under Owner controls/);
  assert.ok(f.lines[0]!.includes(`npm run solana:resolve -- shortfall show ${account} shows both providers' balances beside the book, and shortfall book writes an explained `
    + `shortfall off as a loss (docs/solana-integration.md, "A vault below its book")`), f.lines[0]);
  assert.deepEqual(fieldsOf(f.lines[0]!), { solana: "alert", kind: "vault-below-book", account: solanaAccountRef({ tenant: TENANT, owner: OWNER }) });
  assert.ok(!f.lines[0]!.includes(TENANT) && !f.lines[0]!.includes(OWNER));
  f.clock.now += 60_000; await agent.tick(); assert.equal(f.lines.length, 1, "said once per repeat window");
  f.clock.now += SOLANA_AGENT_ALERT_REPEAT_MS; await agent.tick(); assert.equal(f.lines.length, 2);
  // Reconciled: trading resumes, and a later shortfall is said at once.
  status = { ...below, live: { ...below.live, ready: true, canExit: true, blockers: [] } };
  f.clock.now += 60_000; assert.deepEqual((await agent.tick()).map(r => r.outcome), ["submitted"]); assert.equal(f.lines.length, 2);
  status = below; f.clock.now += 60_000; await agent.tick(); assert.equal(f.lines.length, 3);
});

test("a below-book blocker beside the account's own trade or owner transaction awaiting final confirmation pages no one", async t => {
  const f = await expiryAccount(t, { maxOpsPerDay: 20, expired: 0 });
  const below = { paper: null, live: { balances: {}, tradable: { cashUsdg: "100000000", wsolRaw: "0" }, pending: [] as unknown[], ready: false, canExit: false,
    blockers: [SOLANA_STATUS_BELOW_BOOK], ownerTransaction: null as null | { status: string } } };
  let status: unknown = { ...below, live: { ...below.live, pending: [{ requestId: "settling", status: "pending" }] } };
  const runtime = { status: async () => status, trade: async () => { f.control.trades++; return {}; } } as unknown as Parameters<typeof createSolanaAgent>[0]["runtime"];
  const market: SolanaPaperMarket = { readMint: async () => { throw new Error("unused"); }, quote: async () => { throw new Error("unused"); } };
  const agent = createSolanaAgent({ db: f.db, runtime, market, now: () => f.clock.now, log: line => f.lines.push(line) });
  // A trade that landed leaves the vault short of its book until it is booked: held for it, and no [alert].
  assert.deepEqual((await agent.tick()).map(r => r.outcome), ["held"]);
  // So does an owner withdrawal that landed and awaits its receipts.
  status = { ...below, live: { ...below.live, ownerTransaction: { status: "pending" } } };
  f.clock.now += 60_000; assert.deepEqual((await agent.tick()).map(r => r.outcome), ["held"]);
  assert.deepEqual(f.lines, []); assert.equal(f.control.trades, 0);
  // Short with nothing of its own settling: said.
  status = below; f.clock.now += 60_000; await agent.tick();
  assert.equal(f.lines.filter(line => /vault-below-book/.test(line)).length, 1);
  // Something settles again: the repeat window is cleared, so a shortfall left once it is booked is said at once.
  status = { ...below, live: { ...below.live, ownerTransaction: { status: "pending" } } }; f.clock.now += 60_000; await agent.tick();
  status = below; f.clock.now += 60_000; await agent.tick();
  assert.equal(f.lines.filter(line => /vault-below-book/.test(line)).length, 2);
});

test("trades and owner transactions still pending three minutes on say one [alert] with counts only, after recovery, until none is", async t => {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw); t.after(() => raw.close());
  const clock = { now: NOW }, lines: string[] = [];
  await new SqlSolanaBindingStore(async () => db, "sqlite", () => clock.now).get(TENANT); await ensureSolanaTradingSchema(db);
  const pending = (id: string, at: number) => db.prepare(`INSERT INTO solana_runtime_submissions(tenant,owner,request_id,vault,sequence,signature,status,created_at_ms,notional_raw,submission_json)
    VALUES(?,?,?,?,?,?,'pending',?,?,?)`).run(TENANT, OWNER, id, `vault-${id}`, "0", `sig-${id}`, at, "5000000", "{}");
  let recovered = 0;
  const runtime = { status: async () => { recovered++; throw new Error("providers disagree"); }, trade: async () => assert.fail("no strategy") } as unknown as Parameters<typeof createSolanaAgent>[0]["runtime"];
  const market: SolanaPaperMarket = { readMint: async () => { throw new Error("unused"); }, quote: async () => { throw new Error("unused"); } };
  const agent = createSolanaAgent({ db, runtime, market, now: () => clock.now, log: line => lines.push(line) });
  // A trade admitted a minute ago is not stuck yet.
  await pending("young", clock.now - 60_000);
  await agent.tick(); assert.equal(lines.length, 0); assert.equal(recovered, 1, "recovery was tried first");
  clock.now += SOLANA_PENDING_STUCK_MS;
  // And a signed owner transaction prepared over three minutes ago (another tenant), with an unsigned one that is not pending.
  await db.prepare("INSERT INTO solana_runtime_setups(tenant,owner,setup_json) VALUES(?,?,?)").run(`0x${"22".repeat(20)}`, OWNER,
    JSON.stringify({ signature: "owner-sig", status: "pending", preparedAtMs: clock.now - SOLANA_PENDING_STUCK_MS - 5_000 }));
  await db.prepare("INSERT INTO solana_runtime_setups(tenant,owner,setup_json) VALUES(?,?,?)").run(`0x${"33".repeat(20)}`, OWNER,
    JSON.stringify({ status: undefined, preparedAtMs: 0 }));
  // And a revocation saved beside a record that already resolved (a third tenant): the revoke slot counts too.
  await db.prepare("INSERT INTO solana_runtime_setups(tenant,owner,setup_json) VALUES(?,?,?)").run(`0x${"44".repeat(20)}`, OWNER,
    JSON.stringify({ kind: "withdraw", signature: "main-sig", status: "failed", preparedAtMs: clock.now - SOLANA_PENDING_STUCK_MS - 9_000 }));
  await db.prepare("INSERT INTO solana_runtime_owner_revokes(tenant,owner,setup_json) VALUES(?,?,?)").run(`0x${"44".repeat(20)}`, OWNER,
    JSON.stringify({ kind: "revoke", signature: "revoke-sig", status: "pending", beside: "main-sig", preparedAtMs: clock.now - SOLANA_PENDING_STUCK_MS - 4_000 }));
  await agent.tick();
  assert.equal(recovered, 4, "recovery read the account whose only pending record is in the revoke slot");
  assert.equal(lines.length, 1); assert.match(lines[0]!, /^\[alert\] Solana transactions stuck pending: /);
  // The line carries counts only; the operator gets the names from the resolve tool's pending listing.
  assert.match(lines[0]!, /npm run solana:resolve -- pending names each one \(tenant, id, age, vault sequence\)/);
  assert.deepEqual(fieldsOf(lines[0]!), { solana: "alert", kind: "pending-stuck", trades: 1, ownerTransactions: 2, oldestAgeMs: SOLANA_PENDING_STUCK_MS + 60_000 });
  for (const secret of [TENANT, OWNER, "sig-young", "owner-sig", "revoke-sig", "vault-young"]) assert.ok(!lines[0]!.includes(secret), secret);
  clock.now += 15_000; await agent.tick(); assert.equal(lines.length, 1, "said once per repeat window");
  clock.now += SOLANA_AGENT_ALERT_REPEAT_MS; await agent.tick(); assert.equal(lines.length, 2);
  // Booked at last: nothing more is said, and a later stuck one is said at once.
  await db.prepare("UPDATE solana_runtime_submissions SET status='expired'").run();
  await db.prepare("DELETE FROM solana_runtime_setups").run(); await db.prepare("DELETE FROM solana_runtime_owner_revokes").run();
  clock.now += 15_000; await agent.tick(); assert.equal(lines.length, 2);
  await pending("later", clock.now - SOLANA_PENDING_STUCK_MS);
  clock.now += 15_000; await agent.tick(); assert.equal(lines.length, 3);
  assert.deepEqual(fieldsOf(lines[2]!), { solana: "alert", kind: "pending-stuck", trades: 1, ownerTransactions: 0, oldestAgeMs: SOLANA_PENDING_STUCK_MS + 15_000 });
});

test("the agent reads the shared fee payer itself every ten minutes while a live permission is registered, and a failed check changes nothing", async t => {
  const raw = new DatabaseSync(":memory:"), db = wrapSqlite(raw); t.after(() => raw.close());
  const clock = { now: NOW }, checks: unknown[] = [];
  await new SqlSolanaBindingStore(async () => db, "sqlite", () => clock.now).get(TENANT); await ensureSolanaTradingSchema(db);
  let fail = false;
  const runtime = { status: async () => assert.fail("no status"), trade: async () => assert.fail("no trade"),
    feePayerCheck: async (input: unknown) => { checks.push(input); if (fail) throw new Error("rpc down"); return "ok"; } } as unknown as Parameters<typeof createSolanaAgent>[0]["runtime"];
  const market: SolanaPaperMarket = { readMint: async () => { throw new Error("unused"); }, quote: async () => { throw new Error("unused"); } };
  const agent = createSolanaAgent({ db, runtime, market, now: () => clock.now });
  // No live permission anywhere: nothing to check, and no provider is asked.
  await agent.tick(); assert.deepEqual(checks, []);
  await db.prepare("INSERT INTO solana_runtime_sessions(tenant,owner,record_json,sealed_seed) VALUES(?,?,?,?)").run(TENANT, OWNER, JSON.stringify({ vault: "vault-of-record" }), "sealed");
  await agent.tick(); assert.deepEqual(checks, [{ vault: "vault-of-record" }]);
  clock.now += 15_000; await agent.tick(); assert.equal(checks.length, 1, "once per interval");
  clock.now += SOLANA_AGENT_FEE_PAYER_CHECK_MS; fail = true;
  assert.deepEqual(await agent.tick(), [], "a failed check changes no outcome");
  assert.equal(checks.length, 2);
  clock.now += 15_000; await agent.tick(); assert.equal(checks.length, 2, "a failed check waits for the interval too");
});
