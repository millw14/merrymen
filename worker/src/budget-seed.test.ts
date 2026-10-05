/**
 * A REBUILT CHILD'S CAPS READ THE DAY IT ALREADY SPENT — OR NOTHING NEW OPENS.
 *
 * The finding this closes: the daily spend, ops and Telegram transfer caps are
 * summed from the child's own sqlite, and a child whose sqlite is new summed
 * them from nothing while the day it had spent sat in shared Postgres. The
 * arm's reconciler re-records only part of that day, and records a transfer as
 * a bare swap — so a rebuild loosened the transfer allowance outright.
 *
 * Driven here with the real seed (seedBudget, exactly what the orchestrator's
 * seedBudgetForChild runs), the child's REAL store over its own sqlite in its
 * own home (getOpsToday, getSpentTodayUsdg and getTransferredTodayUsdg — the
 * readers refreshBudget and the transfer check call), and sqlite standing in
 * for shared Postgres with the ledger's own schema:
 *
 *   the day before → mirrored → the child's ledger wiped → seeded → every cap
 *   reads what it read before, with or without the reconciler's copies; a
 *   seed that cannot be known or cannot run leaves the marker, which holds the
 *   live day at its caps — where a sale into cash still passes.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { after, describe, it } from "node:test";
import { getAddress } from "viem";

import { CASH } from "../../packages/core/src/index";
import { wrapSqlite, type Db } from "./db";
import {
  BUDGET_UNRESTORED_FILE,
  budgetUnrestored,
  clearBudgetUnrestored,
  readBudgetSeed,
  seedBudget,
} from "./budget-seed";
import { checkPolicy, type AgentLimits, type TradeIntent } from "./policy";
import { transferBudgetRefusal } from "./transfer-budget";

// The child's home, as childEnv sets MERRYMEN_HOME for it. No DATABASE_URL:
// a child never holds one; its store is its own sqlite.
const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-budget-seed-"));
const HOME = path.join(scratch, "child");
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = HOME;
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("./store");
const openStore = async () => {
  try {
    process.chdir(isolatedCwd);
    await store.initStore();
  } finally {
    process.chdir(originalCwd);
  }
};
await openStore();

/** The orchestrator's own handles on the child's ledger, opened the way seedBudgetForChild opens them. */
const handles: DatabaseSync[] = [];
const orchestratorHandle = (): Db => {
  const raw = new DatabaseSync(path.join(HOME, "merrymen.db"));
  raw.exec("PRAGMA busy_timeout = 250");
  handles.push(raw);
  return wrapSqlite(raw);
};
const closeHandles = () => {
  for (const raw of handles.splice(0)) {
    try {
      raw.close();
    } catch {
      /* already closed */
    }
  }
};

/** Shared Postgres, with the ledger's own schema. */
const sharedRaw = new DatabaseSync(":memory:");
const shared = wrapSqlite(sharedRaw);
await store.applyLedgerSchema(shared);

const READONLY_HOME = path.join(scratch, "readonly-home");
after(() => {
  closeHandles();
  sharedRaw.close();
  store.closeStoreForTest();
  try {
    chmodSync(READONLY_HOME, 0o700);
  } catch {
    /* never made */
  }
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const USDG = String(CASH.USDG);
// The account as the grant carries it: EIP-55, the spelling the child keys on.
const AGENT = getAddress("0x9999999999999999999999999999999999990b09");
const TOKEN = "0x5555555555555555555555555555555555555555";
const QUOTE = "0x6666666666666666666666666666666666666666";
const VAULT = "0x7777777777777777777777777777777777777777";
const OWNER = "0x8888888888888888888888888888888888888888";
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const nowSec = () => Math.floor(Date.now() / 1000);
const outage = () => Promise.reject(new Error("Connection terminated unexpectedly"));

const seed = (when: "spawn" | "retry", sharedDb: () => Promise<Db> = async () => shared, agent = AGENT, home = HOME) =>
  seedBudget({ home, agent, cashToken: USDG, nowSec: nowSec(), when, local: orchestratorHandle, shared: sharedDb });

/** Every cap the worker judges against, from the store exactly as refreshBudget and the transfer check read it. */
const caps = async (agent = AGENT) => ({
  ops: await store.getOpsToday(agent, "live"),
  spent: await store.getSpentTodayUsdg(agent, "live", USDG),
  transferred: await store.getTransferredTodayUsdg(agent),
});

/** Age one row in the child's ledger: when it was created, and when its outcome was observed. */
const age = (hash: string, createdAgoSec: number, settledAgoSec: number | null) => {
  const raw = new DatabaseSync(path.join(HOME, "merrymen.db"));
  try {
    raw.prepare("UPDATE trades SET created_at = unixepoch() - ?, budget_settled_at = ? WHERE user_op_hash = ?")
      .run(createdAgoSec, settledAgoSec === null ? null : nowSec() - settledAgoSec, hash);
  } finally {
    raw.close();
  }
};

/** What the mirror carries up: the child's trade rows, as written, into shared. */
const mirror = () => {
  const raw = new DatabaseSync(path.join(HOME, "merrymen.db"));
  try {
    const cols = ["agent_id", "kind", "target", "sell_token", "buy_token", "amount_usdg", "user_op_hash", "status", "reject_rule", "created_at", "budget_settled_at"];
    const rows = raw.prepare(`SELECT ${cols.join(", ")} FROM trades`).all() as Record<string, string | number | null>[];
    const ins = sharedRaw.prepare(`INSERT INTO trades (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    for (const r of rows) ins.run(...cols.map((c) => r[c] ?? null));
  } finally {
    raw.close();
  }
};

/** A redeploy: the child's sqlite is gone, and its worker opens a new one. */
const rebuild = async () => {
  closeHandles();
  store.closeStoreForTest();
  for (const f of ["merrymen.db", "merrymen.db-wal", "merrymen.db-shm"]) rmSync(path.join(HOME, f), { force: true });
  await openStore();
};

const trade = (row: Parameters<typeof store.addTrade>[0]) => store.addTrade(row);

describe("the cap after a rebuild equals the cap before it", () => {
  let before: Awaited<ReturnType<typeof caps>>;
  let grossBefore: number;

  it("the day before: buys, sales into cash and a quote, a transfer, a withdrawal, pending and late-settled ops", async () => {
    await trade({ agent_id: AGENT, kind: "swap", target: TOKEN, sell_token: USDG, buy_token: TOKEN, amount_usdg: 10, status: "landed", user_op_hash: h(1) });
    await trade({ agent_id: AGENT, kind: "swap", target: TOKEN, sell_token: TOKEN, buy_token: USDG, amount_usdg: 6, status: "landed", user_op_hash: h(2) });
    await trade({ agent_id: AGENT, kind: "transfer", target: OWNER, amount_usdg: 20, status: "landed", user_op_hash: h(3) });
    await trade({ agent_id: AGENT, kind: "curve-trade", target: TOKEN, sell_token: TOKEN, buy_token: QUOTE, amount_usdg: 4, status: "landed", user_op_hash: h(4) });
    await trade({ agent_id: AGENT, kind: "vault-withdraw", target: VAULT, amount_usdg: 30, status: "landed", user_op_hash: h(5) });
    // Sent three days ago and never heard back about: it holds its charge whatever its age.
    await trade({ agent_id: AGENT, kind: "swap", target: TOKEN, sell_token: USDG, buy_token: TOKEN, amount_usdg: 7, status: "submitted", user_op_hash: h(6) });
    age(h(6), 3 * 86_400, null);
    // CREATED 27h AGO, SETTLED AN HOUR AGO: the window runs from settlement.
    await trade({ agent_id: AGENT, kind: "swap", target: TOKEN, sell_token: USDG, buy_token: TOKEN, amount_usdg: 9, status: "landed", user_op_hash: h(7) });
    age(h(7), 27 * 3_600, 3_600);
    // Settled 25h ago: out of the day.
    await trade({ agent_id: AGENT, kind: "swap", target: TOKEN, sell_token: USDG, buy_token: TOKEN, amount_usdg: 11, status: "landed", user_op_hash: h(8) });
    age(h(8), 30 * 3_600, 25 * 3_600);
    await trade({ agent_id: AGENT, kind: "swap", target: TOKEN, sell_token: USDG, buy_token: TOKEN, amount_usdg: 50, status: "reverted", user_op_hash: h(9) });
    await trade({ agent_id: AGENT, kind: "transfer", target: OWNER, amount_usdg: 5, status: "submitted", user_op_hash: h(10) });
    await trade({ agent_id: AGENT, kind: "swap", target: TOKEN, amount_usdg: 99, status: "rejected", reject_rule: "ops-cap" });
    await trade({ agent_id: AGENT, kind: "swap", target: TOKEN, amount_usdg: 13, status: "paper" });

    before = await caps();
    grossBefore = await store.getSpentTodayUsdg(AGENT, "live");
    assert.deepEqual(before, { ops: 8, spent: 55, transferred: 25 }, "sanity: the fixture is the day the caps were judged against");
    assert.equal(grossBefore, 61);
    mirror();
  });

  it("A REBUILT LEDGER READS AN EMPTY DAY — the hole this closes", async () => {
    await rebuild();
    assert.deepEqual(await caps(), { ops: 0, spent: 0, transferred: 0 });
  });

  it("SEEDED, EVERY CAP READS WHAT IT READ BEFORE — with no reconciler copy at all (an RPC failure at arm)", async () => {
    const r = await seed("spawn");
    assert.deepEqual(r, { ok: true, restored: 8 });
    assert.equal(budgetUnrestored(HOME), false, "the marker comes out once every row is in");
    assert.deepEqual(await caps(), before);
    assert.equal(await store.getSpentTodayUsdg(AGENT, "live"), grossBefore, "and without the cash token, the same gross sum");
    // THE LIVE RAIL ONLY: a paper fill has no hash to count it once by.
    assert.equal(await store.getOpsToday(AGENT, "paper"), 0);
  });

  it("AND WITH THE RECONCILER'S BARE COPIES BESIDE IT, STILL ONCE EACH — the transfer and the quote sale are not lost", async () => {
    // What reconcileInFlightAtArm writes for each successful op of the last
    // 26h of blocks it finds: a 'swap', sized from the receipt's USDG leg, the
    // legs only where the receipt named them. A transfer has no non-USDG leg;
    // a curve sale into a quote moved no USDG; a withdrawal returned USDG.
    await trade({ agent_id: AGENT, kind: "swap", target: AGENT, sell_token: USDG, buy_token: TOKEN, amount_usdg: 10, status: "landed", user_op_hash: h(1) });
    await trade({ agent_id: AGENT, kind: "swap", target: AGENT, sell_token: TOKEN, buy_token: USDG, amount_usdg: 6, status: "landed", user_op_hash: h(2) });
    await trade({ agent_id: AGENT, kind: "swap", target: AGENT, amount_usdg: 20, status: "landed", user_op_hash: h(3) });
    await trade({ agent_id: AGENT, kind: "swap", target: AGENT, amount_usdg: 0, status: "landed", user_op_hash: h(4) });
    await trade({ agent_id: AGENT, kind: "swap", target: AGENT, sell_token: VAULT, buy_token: USDG, amount_usdg: 30, status: "landed", user_op_hash: h(5) });
    await trade({ agent_id: AGENT, kind: "swap", target: AGENT, sell_token: USDG, buy_token: TOKEN, amount_usdg: 9, status: "landed", user_op_hash: h(7) });
    assert.deepEqual(await caps(), before, "ops, net spend and the transfer allowance all equal the day before");
    // The reconciler books a withdrawal as a sale: gross counts it where the
    // original did not. Over, never under — the direction a cap may err in.
    assert.ok((await store.getSpentTodayUsdg(AGENT, "live")) >= grossBefore);
  });

  it("THE SEED SURVIVES refreshBudget: it is re-read on every refresh, and the child's new rows add to it", async () => {
    for (let i = 0; i < 3; i++) assert.deepEqual(await caps(), before, `refresh ${i + 1}`);
    await trade({ agent_id: AGENT, kind: "swap", target: TOKEN, sell_token: USDG, buy_token: TOKEN, amount_usdg: 3, status: "landed", user_op_hash: h(11) });
    assert.deepEqual(await caps(), { ops: before.ops + 1, spent: before.spent + 3, transferred: before.transferred });
  });

  it("THE CHILD'S OWN ROW IS THE LATER WORD: an op the shared ledger still calls pending, resolved here as reverted, stops counting", async () => {
    await trade({ agent_id: AGENT, kind: "swap", target: TOKEN, sell_token: USDG, buy_token: TOKEN, amount_usdg: 7, status: "reverted", user_op_hash: h(6) });
    assert.deepEqual(await caps(), { ops: before.ops, spent: before.spent + 3 - 7, transferred: before.transferred });
  });

  it("and the seed ages out on the same clock as the child's own rows", async () => {
    const raw = new DatabaseSync(path.join(HOME, "merrymen.db"));
    try {
      raw.prepare("UPDATE budget_seed SET settled_at = unixepoch() - 86401 WHERE op_hash = ?").run(h(10));
      raw.prepare("UPDATE budget_seed SET pending = 0 WHERE op_hash = ?").run(h(10));
    } finally {
      raw.close();
    }
    assert.equal(await store.getTransferredTodayUsdg(AGENT), 20, "only the transfer still inside the day");
  });
});

describe("one operation is one entry", () => {
  const B = getAddress("0x9999999999999999999999999999999999990b0b");

  it("DEDUPED BY HASH: the original and a rebuilt child's copy, each spelt its own way, are one op at the larger figure", async () => {
    const hash = h(0xb1);
    sharedRaw
      .prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status) VALUES (?, 'transfer', ?, 20, ?, 'landed')`)
      .run(B, OWNER, hash.toUpperCase().replace("0X", "0x"));
    sharedRaw
      .prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status) VALUES (?, 'swap', ?, 18, ?, 'landed')`)
      .run(B.toLowerCase(), B, hash);
    const entries = await readBudgetSeed(shared, B, USDG, nowSec());
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.opHash, hash);
    assert.equal(entries[0]!.transferUsdg, 20);
    assert.equal(entries[0]!.spendUsdg, 20);
    assert.equal(entries[0]!.pending, false);

    assert.equal((await seed("spawn", async () => shared, B)).ok, true);
    assert.deepEqual(await caps(B), { ops: 1, spent: 20, transferred: 20 });
  });

  it("an op one row still calls pending stays pending — the conservative reading of two descriptions", async () => {
    const hash = h(0xb2);
    sharedRaw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status) VALUES (?, 'swap', ?, 4, ?, 'submitted')`).run(B, TOKEN, hash);
    sharedRaw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status) VALUES (?, 'swap', ?, 4, ?, 'landed')`).run(B, TOKEN, hash);
    const pending = (await readBudgetSeed(shared, B, USDG, nowSec())).find((e) => e.opHash === hash);
    assert.equal(pending?.pending, true);
  });
});

describe("a row created more than 26h ago but settled within 24h is counted", () => {
  const E = getAddress("0x9999999999999999999999999999999999990e0e");

  it("the window runs from observed settlement, on the shared side exactly as on the child's", async () => {
    const t = nowSec();
    const ins = sharedRaw.prepare(
      `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, created_at, budget_settled_at) VALUES (?, 'swap', ?, ?, ?, ?, ?, ?)`,
    );
    ins.run(E, TOKEN, 9, h(0xe1), "landed", t - 27 * 3_600, t - 3_600); // created 27h ago, settled 1h ago
    ins.run(E, TOKEN, 11, h(0xe2), "landed", t - 30 * 3_600, t - 25 * 3_600); // settled 25h ago
    ins.run(E, TOKEN, 7, h(0xe3), "submitted", t - 72 * 3_600, null); // pending, three days old
    ins.run(E, TOKEN, 5, h(0xe4), "landed", t - 23 * 3_600, null); // no settlement stamp: created 23h ago
    const entries = await readBudgetSeed(shared, E, USDG, t);
    assert.deepEqual(entries.map((e) => e.opHash).sort(), [h(0xe1), h(0xe3), h(0xe4)].sort());
    assert.equal((await seed("spawn", async () => shared, E)).ok, true);
    assert.equal(await store.getOpsToday(E, "live"), 3);
    assert.equal(await store.getSpentTodayUsdg(E, "live", USDG), 21);
  });
});

describe("a live row with no hash makes the seed unknown — and unknown fails closed", () => {
  const C = getAddress("0x9999999999999999999999999999999999990c0c");
  const D = getAddress("0x9999999999999999999999999999999999990d0d");

  it("a NULL-hash row that is not live, or not in the day, is no reason to fail", async () => {
    const t = nowSec();
    const ins = sharedRaw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at) VALUES (?, 'swap', ?, ?, ?, ?)`);
    ins.run(D, TOKEN, 99, "rejected", t);
    ins.run(D, TOKEN, 13, "paper", t);
    ins.run(D, TOKEN, 8, "landed", t - 2 * 86_400);
    assert.deepEqual(await readBudgetSeed(shared, D, USDG, t), []);
  });

  it("A LIVE ONE IN THE DAY: no seed, the marker stands, and the transfer allowance is unreadable", async () => {
    sharedRaw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status) VALUES (?, 'swap', ?, 12, 'landed')`).run(C, TOKEN);
    await assert.rejects(readBudgetSeed(shared, C, USDG, nowSec()), /no operation hash/);
    const r = await seed("spawn", async () => shared, C);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.marked, true, "the child arms held, not on an empty day");
    assert.equal(budgetUnrestored(HOME), true);
    assert.equal(store.budgetDayUnrestored(), true, "the child's own store sees the marker the orchestrator left");
    await assert.rejects(store.getTransferredTodayUsdg(C), /not restored/);
    // EXACTLY how the transfer check reads it: an unreadable allowance never authorizes a send.
    const spent = await store.getTransferredTodayUsdg(C).catch(() => Number.NaN);
    assert.match(transferBudgetRefusal(1n, spent, 50)!, /could not be verified/);
  });

  it("a retry that fails again leaves it standing; one that succeeds clears it", async () => {
    const again = await seed("retry", async () => shared, C);
    assert.equal(again.ok, false);
    assert.equal(budgetUnrestored(HOME), true);
    sharedRaw.prepare("DELETE FROM trades WHERE agent_id = ? AND user_op_hash IS NULL").run(C);
    const r = await seed("retry", async () => shared, C);
    assert.deepEqual(r, { ok: true, restored: 0 });
    assert.equal(budgetUnrestored(HOME), false);
    assert.equal(await store.getTransferredTodayUsdg(C), 0);
  });
});

describe("until a seed exists, entries get no headroom — and exits stay open", () => {
  it("THE MARKER GOES IN BEFORE ANYTHING IS READ, so a seed that dies half way arms held, never on an empty day", async () => {
    let markedAtRead: boolean | null = null;
    const r = await seed("spawn", async () => {
      markedAtRead = budgetUnrestored(HOME);
      throw new Error("process killed mid-seed");
    });
    assert.equal(markedAtRead, true);
    assert.equal(!r.ok && r.marked, true);
    const marker = JSON.parse(readFileSync(path.join(HOME, BUDGET_UNRESTORED_FILE), "utf8")) as { v: number };
    assert.equal(marker.v, 1);
    clearBudgetUnrestored(HOME);
  });

  it("an outage at spawn marks; nothing at all — no marker and no seed — is the one state that is reported unmarked", async (t) => {
    const r = await seed("spawn", outage);
    assert.equal(!r.ok && r.marked, true);
    clearBudgetUnrestored(HOME);
    if (process.getuid?.() === 0) return t.skip("root ignores directory permissions");
    mkdirSync(READONLY_HOME);
    chmodSync(READONLY_HOME, 0o500);
    const unguarded = await seed("spawn", outage, AGENT, READONLY_HOME);
    assert.equal(unguarded.ok, false);
    assert.equal(!unguarded.ok && unguarded.marked, false, "the orchestrator does not start this worker");
    assert.match(!unguarded.ok ? unguarded.why : "", /marker could not be written/);
  });

  it("HELD AT THE CAPS, a buy is refused and a sale into cash still passes — the wall's own exemptions", () => {
    const limits: AgentLimits = {
      perTradeUsdg: 50_000_000n,
      dailyUsdg: 500_000_000n,
      allowedTargets: [TOKEN as `0x${string}`],
      allowedAssets: [USDG as `0x${string}`, TOKEN as `0x${string}`],
      maxDrawdownBps: 1_000,
      expiresAt: nowSec() + 86_400,
      maxOpsPerDay: 48,
      cashToken: USDG,
    };
    // What refreshBudget holds the settled halves at while the marker stands.
    const held = { spentTodayUsdg: limits.dailyUsdg, opsToday: limits.maxOpsPerDay, highWaterMarkUsdg: 0n, equityUsdg: 0n, nowSec: nowSec() };
    const swap = (sellToken: string, buyToken: string): TradeIntent => ({
      kind: "swap",
      target: TOKEN as `0x${string}`,
      sellToken: sellToken as `0x${string}`,
      buyToken: buyToken as `0x${string}`,
      sellAmountRaw: 25_000_000n,
      notionalUsdg: 25_000_000n,
    });
    const buy = checkPolicy(swap(USDG, TOKEN), limits, held);
    assert.equal(buy.ok, false);
    assert.match(!buy.ok ? buy.rule : "", /^(ops-cap|daily-cap)$/);
    assert.deepEqual(checkPolicy(swap(TOKEN, USDG), limits, held), { ok: true }, "the stop-loss and the take-profit run");
  });

  it("refreshBudget reads the marker BEFORE the ledger, and holds only the live rail, at the grant's own caps", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = src.indexOf("const refreshBudget = async (agentId: string): Promise<void> => {");
    assert.ok(start > 0, "sanity: found refreshBudget");
    const body = src.slice(start, src.indexOf("\n  };", start));
    const marker = body.indexOf("budgetDayUnrestored()");
    assert.ok(marker > 0 && marker < body.indexOf("getSpentTodayUsdg(") && marker < body.indexOf("getOpsToday("), "marker first");
    assert.match(body, /const held = rail === "live" && budgetDayUnrestored\(\);/);
    assert.match(body, /settledSpentUsdg = active\.limits\.dailyUsdg;/);
    assert.match(body, /settledOps = active\.limits\.maxOpsPerDay;/);
  });

  it("the orchestrator seeds beside the energy seed before spawn, and retries beside it every pass", () => {
    const src = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
    const from = src.indexOf("async function spawnChild(");
    const spawn = src.slice(from, src.indexOf("\nasync function ", from + 1));
    const energy = spawn.indexOf("await seedEnergyForChild(tenant, smartAccount);");
    const budget = spawn.indexOf("if (!(await seedBudgetForChild(tenant, smartAccount))) return;");
    assert.ok(energy > 0 && budget > energy, "beside the energy seed");
    assert.ok(budget < spawn.indexOf("const late = lateSpawnRefusal(tenant, lease);"), "before the worker starts");
    assert.match(src, /await retryEnergySeed\(tenant as `0x\$\{string\}`\);\s*(\/\/[^\n]*\n\s*)*await retryBudgetSeed\(tenant as `0x\$\{string\}`\);/);
  });
});

describe("the seed costs one seek per operation, never a scan of the agent's history", () => {
  // refreshBudget runs every tick and after every recordTrade, on a
  // synchronous sqlite. Matched on lower(user_op_hash), each seed row
  // range-scanned every hashed row the agent ever wrote, three times over.
  it("EVERY CORRELATED LOOKUP IS AN EQUALITY SEEK on (agent_id, user_op_hash) — the query plan says so", () => {
    const q = store.withBudgetSeed({
      agentId: AGENT,
      rail: "live",
      figure: "amount_usdg",
      where: "status IN ('landed', 'submitted') AND kind = 'transfer'",
      params: [],
      seedFigure: "s.transfer_usdg",
    });
    const raw = new DatabaseSync(path.join(HOME, "merrymen.db"));
    try {
      const plan = (raw.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.params as SQLInputValue[])) as { detail: string }[]).map((r) => r.detail);
      const lookups = plan.flatMap((d, i) => (d.startsWith("CORRELATED SCALAR SUBQUERY") ? [plan[i + 1] ?? ""] : []));
      assert.ok(lookups.length >= 3, `sanity: the per-operation lookups are in the plan\n${plan.join("\n")}`);
      for (const step of lookups) {
        assert.match(step, /^SEARCH trades USING (COVERING )?INDEX trades_agent_userop \(agent_id=\? AND user_op_hash=\?\)$/);
      }
      assert.ok(!plan.some((d) => /^SCAN trades\b/.test(d)), `no full scan of trades\n${plan.join("\n")}`);
    } finally {
      raw.close();
    }
  });

  it("and at a long history the answer is the same: thousands of hashed rows, the seed counted once, aged-out seed rows not at all", async () => {
    const Y = getAddress("0x9999999999999999999999999999999999990f0f");
    const raw = new DatabaseSync(path.join(HOME, "merrymen.db"));
    try {
      raw.exec("BEGIN");
      const ins = raw.prepare(
        "INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, created_at) VALUES (?, 'swap', ?, 1, ?, 'landed', unixepoch() - ?)",
      );
      // 5,000 ops, one every ten minutes: the newest 144 inside the day.
      for (let i = 0; i < 5_000; i++) ins.run(Y, TOKEN, h(0xf_0000 + i), (i + 1) * 600 - 300);
      const seedRow = raw.prepare(
        `INSERT INTO budget_seed (agent_id, op_hash, spend_usdg, gross_usdg, transfer_usdg, cash_token, pending, settled_at, seeded_at)
         VALUES (?, ?, 2, 2, 0, ?, 0, unixepoch() - ?, unixepoch())`,
      );
      // 48 seeded ops the child does not hold: half inside the day, half aged out.
      for (let i = 0; i < 48; i++) seedRow.run(Y, h(0xf_8000 + i), USDG.toLowerCase(), i % 2 ? 3_600 : 3 * 86_400);
      raw.exec("COMMIT");
    } finally {
      raw.close();
    }
    assert.equal(await store.getOpsToday(Y, "live"), 144 + 24);
    assert.equal(await store.getSpentTodayUsdg(Y, "live", USDG), 144 + 2 * 24);
  });
});
