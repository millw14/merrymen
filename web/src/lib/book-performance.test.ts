import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, translateQuery, type Db, type RunResult } from "../../../worker/src/db";
import { applyLedgerSchema } from "../../../worker/src/store";
import { readBookPerformance } from "./book-performance";

const ACCOUNT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CASED = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const FOREIGN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
async function ledger() {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  await db.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps,
    granted_at, expires_at, mode, epoch, contributions_known) VALUES (?, 'Desk', 'PRIVATE-OWNER', 'PRIVATE-KEY', 4663, 'PRIVATE-CAPS', 0, 0, 'live', 2, 1)`).run(ACCOUNT);
  await db.prepare("INSERT INTO flows (agent_id, epoch, direction, amount_usdg, source, at) VALUES (?, 2, 'in', 100, 'chain-log', 1)").run(ACCOUNT);
  return { raw, db };
}
async function mark(db: Db, equity: number, at: number, mode = "live", held = false, account = ACCOUNT, epoch = 2) {
  await db.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, at, mode, flows_held, epoch)
    VALUES (?, 'PRIVATE-ETH', 7, 13, 19, ?, ?, ?, ?, ?)`).run(account, equity, at, mode, held ? 1 : 0, epoch);
}
let next = 0;
async function op(db: Db, at: number, over: { gas?: number | null; wei?: string | null; sponsor?: string | null; hash?: string; status?: string;
  kind?: string; account?: string; epoch?: number; bare?: boolean } = {}) {
  next += 1;
  await db.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, user_op_hash, fill_side,
    gas_usdg, gas_wei, sponsored_gas_wei, created_at, epoch) VALUES (?, ?, 'PRIVATE-TARGET', 5, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(over.account ?? ACCOUNT, over.kind ?? "swap", over.status ?? "landed", over.hash ?? `0xop${next}`,
      over.bare ? null : "buy", over.gas === undefined ? 0 : over.gas, over.wei ?? null, over.sponsor ?? null, at, over.epoch ?? 2);
}
function translated(raw: DatabaseSync): Db {
  const bind = (params: unknown[]) => Object.fromEntries(params.map((p, i) => [`$${i + 1}`, p])) as never;
  const db: Db = { prepare(sql) { const text = translateQuery(sql); return {
    run: async (...p) => raw.prepare(text).run(bind(p)) as RunResult,
    get: async (...p) => raw.prepare(text).get(bind(p)), all: async (...p) => raw.prepare(text).all(bind(p)),
  }; }, exec: async (sql) => raw.exec(sql), tx: async (fn) => fn(db) };
  return db;
}

test("held current equity and measured P&L use separate timestamps with flows and gas cut off together", async () => {
  const { raw, db } = await ledger();
  try {
    await op(db, 5, { gas: 0.2, wei: "200" });
    await mark(db, 110, 10);
    await db.prepare("INSERT INTO flows (agent_id, epoch, direction, amount_usdg, source, at) VALUES (?, 2, 'out', 10, 'transfer-intent', 15)").run(ACCOUNT);
    await op(db, 20, { status: "reverted", gas: 2, wei: "2000", kind: "key-install" });
    await mark(db, 140, 30, "live", true);
    for (const reader of [db, translated(raw)]) {
      const result = await readBookPerformance(reader, CASED, 2, true);
      assert.deepEqual(result.performance, { book: "live", equityUsdg: 140, equityAt: 30, pnlUsdg: 9.8,
        pnlBps: 980, pnlAt: 10, publicBook: true, gasComplete: true, held: true,
        // The key installation is an operation, never a trade, and settles
        // after the measured valuation besides; the deposit is as of it too.
        fills: 1, fillsAtMark: 1, lastFillAt: 5, funded: true, valuation: "current",
        gasOps: { sponsored: 0, priced: 1, unpriced: 0, unrecorded: 0 }, underReview: false });
      assert.equal(result.liveRank.pnlBps, 980);
    }
  } finally { raw.close(); }
});

test("canonical fills cannot double gas, and a late bare copy cannot resurrect a key installation as trading", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, 110, 10);
    await op(db, 3, { gas: 0.2, wei: "200", hash: "0xCOPY" });
    await op(db, 3, { gas: 0.2, wei: "200", hash: "0xcopy", account: CASED });
    await op(db, 30, { gas: null, hash: "0xcOpY", bare: true });
    await op(db, 5, { gas: 0.1, wei: "100", kind: "key-install", hash: "0xINSTALL", bare: true });
    await op(db, 30, { gas: null, hash: "0xinstall", bare: true });
    await op(db, 3, { gas: 50, hash: "0xcopy", account: FOREIGN });
    await op(db, 3, { gas: 50, hash: "0xcopy", epoch: 1 });
    const result = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.ok(Math.abs(result.performance.pnlUsdg! - 9.7) < 1e-12);
    assert.equal(result.liveRank.pnlBps, 970);
    await db.prepare("DELETE FROM trades WHERE kind <> 'key-install' AND user_op_hash <> '0xinstall'").run();
    const onlyInstall = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.equal(onlyInstall.liveRank.unrankedWhy, "never-filled");
    assert.equal(onlyInstall.performance.pnlBps, null);
    assert.equal(onlyInstall.performance.equityUsdg, 110);
  } finally { raw.close(); }
});

test("a complete withdrawal preserves evidenced dollar profit or loss without inventing a percentage", async () => {
  for (const withdrawn of [100, 110]) {
    for (const equity of [10, 0]) {
      const { raw, db } = await ledger();
      try {
        await op(db, 5, { gas: 2, wei: "2000" });
        await db.prepare("INSERT INTO flows (agent_id, epoch, direction, amount_usdg, source, at) VALUES (?, 2, 'out', ?, 'chain-log', 8)").run(ACCOUNT, withdrawn);
        await mark(db, equity, 10);
        // A newer held valuation and later gas/flow cannot change the measured
        // dollar result or supply a denominator for the completed withdrawal.
        await op(db, 20, { gas: 5, wei: "5000" });
        await db.prepare("INSERT INTO flows (agent_id, epoch, direction, amount_usdg, source, at) VALUES (?, 2, 'in', 50, 'chain-log', 20)").run(ACCOUNT);
        await mark(db, 50, 30, "live", true);
        const result = await readBookPerformance(db, ACCOUNT, 2, true);
        assert.equal(result.performance.pnlUsdg, equity - (100 - withdrawn) - 2);
        assert.equal(result.performance.pnlAt, 10);
        assert.equal(result.performance.pnlBps, null);
        assert.equal(result.liveRank.pnlBps, null);
        assert.equal(result.liveRank.unrankedWhy, "no-deposit");
        assert.equal((await readBookPerformance(db, ACCOUNT, 2, false)).performance.pnlUsdg, null);
        await db.prepare("UPDATE agents SET contributions_known = 0").run();
        assert.equal((await readBookPerformance(db, ACCOUNT, 2, true)).performance.pnlUsdg, null);
      } finally { raw.close(); }
    }
  }
});

test("exact live performance and rank refuse unpriced or unrecorded gas, while proved sponsorship is free", async () => {
  for (const [cost, complete] of [
    [{ gas: null, wei: "123" }, false],
    [{ gas: null }, false],
    [{ gas: null, sponsor: "123" }, true],
    [{ gas: null, wei: "0" }, true],
    [{ gas: null, wei: "123", sponsor: "456" }, false],
    [{ gas: 0 }, true],
  ] as const) {
    const { raw, db } = await ledger();
    try {
      await mark(db, 110, 10);
      await op(db, 5, cost);
      const result = await readBookPerformance(db, ACCOUNT, 2, true);
      assert.equal(result.performance.gasComplete, complete, JSON.stringify(cost));
      assert.equal(result.performance.pnlUsdg, complete ? 10 : null);
      assert.equal(result.performance.pnlBps, complete ? 1000 : null);
      assert.equal(result.liveRank.pnlBps, complete ? 1000 : null);
      // Its own reason: the deposits ARE evidenced (contributions_known = 1),
      // so "quality-unknown" would say the opposite of what the profile says.
      assert.equal(result.liveRank.unrankedWhy, complete ? null : "gas-pending");
    } finally { raw.close(); }
  }
});

test("gas-pending is said only where every other gate passed; an earlier refusal keeps its own words", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, 110, 10);
    await op(db, 5, { gas: null, wei: "123" });
    assert.equal((await readBookPerformance(db, ACCOUNT, 2, true)).liveRank.unrankedWhy, "gas-pending");
    await db.prepare("UPDATE agents SET contributions_known = 0").run();
    assert.equal((await readBookPerformance(db, ACCOUNT, 2, true)).liveRank.unrankedWhy, "contributions-unevidenced");
    await db.prepare("UPDATE agents SET contributions_known = 1").run();
    await db.prepare("DELETE FROM flows").run();
    assert.equal((await readBookPerformance(db, ACCOUNT, 2, true)).liveRank.unrankedWhy, "no-deposit");
  } finally { raw.close(); }
});

test("a delayed landed or reverted operation is charged when observed settlement reaches the measured valuation", async () => {
  for (const status of ["landed", "reverted"]) {
    const { raw, db } = await ledger();
    try {
      await op(db, 5);
      await op(db, 7, { status, gas: 2, wei: "2000", hash: "0xDELAYED" });
      await db.prepare("UPDATE trades SET budget_settled_at = 20, user_op_nonce = '123' WHERE user_op_hash = '0xDELAYED'").run();
      await mark(db, 110, 10);
      await mark(db, 120, 30, "live", true);
      const duringHold = await readBookPerformance(db, ACCOUNT, 2, true);
      assert.equal(duringHold.performance.pnlUsdg, 10, status);
      assert.equal(duringHold.performance.pnlAt, 10);
      assert.equal(duringHold.performance.gasComplete, true);
      await mark(db, 120, 40);
      const settled = await readBookPerformance(db, ACCOUNT, 2, true);
      assert.equal(settled.performance.pnlUsdg, 18, status);
      assert.equal(settled.performance.pnlAt, 40);
    } finally { raw.close(); }
  }
});

test("an unread settlement-column probe cannot fall back to a submission-time cost", async () => {
  const { raw, db } = await ledger();
  try {
    await op(db, 5);
    await op(db, 7, { gas: 2, wei: "2000", hash: "0xDELAYED" });
    await db.prepare("UPDATE trades SET budget_settled_at = 20, user_op_nonce = '123' WHERE user_op_hash = '0xDELAYED'").run();
    await mark(db, 110, 10);
    for (const column of ["budget_settled_at", "user_op_nonce"]) {
      const failing: Db = { ...db, prepare(sql) {
        if (sql === `SELECT ${column} FROM trades WHERE 1 = 0`) throw new Error("permission denied");
        return db.prepare(sql);
      } };
      const result = await readBookPerformance(failing, ACCOUNT, 2, true);
      assert.equal(result.performance.pnlBps, null);
      assert.equal(result.performance.pnlUsdg, null);
      assert.equal(result.liveRank.unrankedWhy, "quality-unknown");
    }
  } finally { raw.close(); }
});

test("legacy settlements with unknown time refuse an exact cost horizon unless their owner cost is proved zero", async () => {
 for (const status of ["landed", "reverted"]) {
  for (const hasSettlementColumn of [true, false]) {
  for (const [cost, known] of [
    [{ gas: 2, wei: "2000" }, false],
    [{ gas: null, wei: "2000" }, false],
    [{ gas: 0 }, true],
    [{ gas: null, wei: "0" }, true],
    [{ gas: null, sponsor: "2000" }, true],
  ] as const) {
    const { raw, db } = await ledger();
    try {
      await op(db, 5);
      await op(db, 7, { ...cost, status, hash: "0xOLDREVERT" });
      await db.prepare("UPDATE trades SET user_op_nonce = '123' WHERE user_op_hash = '0xOLDREVERT'").run();
      if (!hasSettlementColumn) await db.exec("ALTER TABLE trades DROP COLUMN budget_settled_at");
      await mark(db, 110, 10);
      await mark(db, 120, 30, "live", true);
      const result = await readBookPerformance(db, ACCOUNT, 2, true);
      assert.equal(result.performance.gasComplete, known, JSON.stringify(cost));
      assert.equal(result.performance.pnlUsdg, known ? 10 : null);
      assert.equal(result.liveRank.pnlBps, known ? 1000 : null);
    } finally { raw.close(); }
  }
  }
 }
});

test("private amount fields are null without losing public small-return precision or timestamps", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, 100.0025, 10);
    await op(db, 5);
    const privateRead = await readBookPerformance(db, ACCOUNT, 2, false);
    const publicRead = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.equal(privateRead.performance.equityUsdg, null);
    assert.equal(privateRead.performance.pnlUsdg, null);
    assert.ok(Math.abs(privateRead.performance.pnlBps! - 0.25) < 1e-9);
    assert.equal(privateRead.performance.pnlBps, publicRead.performance.pnlBps);
    assert.equal(privateRead.performance.equityAt, 10);
    assert.equal(privateRead.performance.pnlAt, 10);
    assert.equal(publicRead.performance.equityUsdg, 100.0025);
    assert.doesNotMatch(JSON.stringify(privateRead), /PRIVATE|0x[a-fA-F]{40}|cash|caps|eth/i);
  } finally { raw.close(); }
});

test("recorded paper book defeats a live heartbeat and keeps the same retained baseline across rails", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, 1000, 2, "paper");
    await mark(db, 1100, 3, "paper");
    await mark(db, 10, 4, "live");
    await mark(db, 1100.025, 5, "paper", false, CASED);
    await mark(db, 999999, 6, "paper", false, FOREIGN);
    await mark(db, 999999, 6, "paper", false, ACCOUNT, 1);
    await op(db, 4, { gas: null, wei: "123" });
    const result = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.equal(result.liveRank.unrankedWhy, "paper");
    assert.equal(result.performance.book, "paper");
    assert.equal(result.performance.equityUsdg, 1100.025);
    assert.ok(Math.abs(result.performance.pnlBps! - 1000.25) < 1e-9);
    assert.ok(Math.abs(result.performance.pnlUsdg! - 100.025) < 1e-9);
    assert.equal(result.performance.gasComplete, true, "paper returns never spend live gas");
  } finally { raw.close(); }
});

test("an explicitly blocked paper recovery exposes no stale equity or fabricated flat P&L", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, 1000, 2, "paper");
    await mark(db, 1000, 3, "paper");
    await db.exec("CREATE TABLE IF NOT EXISTS paper_recovery_health(agent_id TEXT,blocked INTEGER)");
    await db.prepare("INSERT INTO paper_recovery_health(agent_id,blocked) VALUES (?, 1)").run(CASED);
    const result = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.deepEqual(result.performance, { book: "paper", equityUsdg: null, equityAt: null, pnlUsdg: null,
      pnlBps: null, pnlAt: null, publicBook: true, gasComplete: null, held: false,
      // Nor a trade count: a book whose recovery is blocked cannot vouch for
      // its records, so it does not get to say "no trades yet" either.
      fills: null, fillsAtMark: null, lastFillAt: null, funded: null, valuation: null, gasOps: null, underReview: false });
  } finally { raw.close(); }
});

test("an unread present recovery verdict cannot publish stale current paper equity", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, 1000, 1, "paper");
    await mark(db, 1100, 2, "paper");
    await db.exec("CREATE TABLE IF NOT EXISTS paper_recovery_health(agent_id TEXT, blocked INTEGER)");
    await db.prepare("INSERT INTO paper_recovery_health(agent_id, blocked) VALUES (?, 1)").run(ACCOUNT);
    for (const message of ["permission denied for table paper_recovery_health", "database is locked"]) {
      const failing: Db = { ...db, prepare(sql) {
        if (sql.includes("FROM paper_recovery_health")) throw new Error(message);
        return db.prepare(sql);
      } };
      const result = await readBookPerformance(failing, ACCOUNT, 2, true);
      assert.equal(result.performance.book, "paper");
      assert.equal(result.performance.equityUsdg, null);
      assert.equal(result.performance.equityAt, null);
      assert.equal(result.performance.pnlUsdg, null);
      assert.equal(result.performance.pnlBps, null);
    }
  } finally { raw.close(); }
});

test("unknown deposits and assessments remain unavailable, and a missing ledger cannot become zero", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, 110, 10);
    await op(db, 5);
    for (const assessed of [0, null]) {
      await db.prepare("UPDATE agents SET contributions_known = ?").run(assessed);
      const result = await readBookPerformance(db, ACCOUNT, 2, true);
      assert.equal(result.performance.pnlBps, null);
      assert.equal(result.performance.pnlUsdg, null);
      assert.equal(result.performance.equityUsdg, 110);
    }
    await db.prepare("UPDATE agents SET contributions_known = 1").run();
    await db.prepare("DELETE FROM flows").run();
    assert.equal((await readBookPerformance(db, ACCOUNT, 2, true)).liveRank.unrankedWhy, "no-deposit");
    await db.exec("DROP TABLE equity");
    const result = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.equal(result.performance.equityUsdg, null);
    assert.equal(result.performance.pnlBps, null);
    assert.equal(result.performance.equityAt, null);
  } finally { raw.close(); }
});

test("chain log copies across account/hash casing count once before the valuation cutoff", async () => {
  const { raw, db } = await ledger();
  try {
    await db.prepare("UPDATE flows SET chain_id = 4663, tx_hash = '0xDEPOSIT', log_index = 7").run();
    await op(db, 5);
    await mark(db, 110, 10);
    const flow = db.prepare(`INSERT INTO flows (agent_id, epoch, direction, amount_usdg, source, at, chain_id, tx_hash, log_index)
      VALUES (?, ?, 'in', ?, ?, ?, ?, ?, ?)`);
    await flow.run(CASED, 2, 100, "chain-log", 30, 4663, "0xdeposit", 7);
    assert.equal((await readBookPerformance(db, CASED, 2, true)).performance.pnlUsdg, 10, "a later mirrored receipt cannot double capital");
    await flow.run(ACCOUNT, 2, 10, "chain-log", 5, 1, "0xdeposit", 7);
    await flow.run(ACCOUNT, 2, 5, "chain-log", 5, 4663, "0xdeposit", 8);
    await flow.run(ACCOUNT, 2, 7, "epoch-carry", 5, null, null, null);
    await flow.run(ACCOUNT, 2, 3, "chain-log", 5, null, null, null);
    await flow.run(FOREIGN, 2, 500, "chain-log", 5, 4663, "0xdeposit", 7);
    await flow.run(ACCOUNT, 1, 500, "chain-log", 5, 4663, "0xOLD", 7);
    await mark(db, 135, 10);
    for (const reader of [db, translated(raw)]) {
      const result = await readBookPerformance(reader, ACCOUNT, 2, true);
      assert.equal(result.performance.pnlUsdg, 10);
      assert.equal(result.performance.pnlBps, 800, "distinct chains, log indices, carry and unidentified rows stay independent");
    }
    await db.exec("DELETE FROM equity; DELETE FROM flows");
    assert.equal((await readBookPerformance(db, ACCOUNT, 2, true)).liveRank.unrankedWhy, "no-deposit");
    const failing: Db = { ...db, prepare(sql) {
      if (sql.includes("FROM flows")) throw new Error("permission denied");
      return db.prepare(sql);
    } };
    assert.equal((await readBookPerformance(failing, ACCOUNT, 2, true)).liveRank.unrankedWhy, "quality-unknown");
  } finally { raw.close(); }
});

test("an exact copy of a carry counts once, and a different carry in the same run makes the return unavailable", async () => {
  const { raw, db } = await ledger();
  try {
    await db.prepare("DELETE FROM flows").run();
    const flow = db.prepare("INSERT INTO flows (agent_id, epoch, direction, amount_usdg, source, at) VALUES (?, 2, 'in', ?, 'epoch-carry', ?)");
    // The mirror's re-copy of the opening balance: summed, 200 of capital
    // turned a 10% gain into a 45% loss.
    await flow.run(ACCOUNT, 100, 1);
    await flow.run(CASED, 100, 1);
    await op(db, 5);
    await mark(db, 110, 10);
    for (const reader of [db, translated(raw)]) {
      const result = await readBookPerformance(reader, ACCOUNT, 2, true);
      assert.equal(result.performance.pnlBps, 1000);
      assert.equal(result.performance.pnlUsdg, 10);
    }
    // One epoch opens once, with one balance. Two different ones cannot both
    // be true, and neither is picked.
    await flow.run(ACCOUNT, 90, 2);
    for (const reader of [db, translated(raw)]) {
      const result = await readBookPerformance(reader, ACCOUNT, 2, true);
      assert.deepEqual(result.liveRank, { pnlBps: null, unrankedWhy: "quality-unknown" });
      assert.equal(result.performance.pnlBps, null);
      assert.equal(result.performance.pnlUsdg, null);
      assert.equal(result.performance.funded, null, "unread funding is not an unfunded book");
      assert.equal(result.performance.underReview, false);
      assert.equal(result.performance.equityUsdg, 110, "the valuation itself is still the book's value");
    }
  } finally { raw.close(); }
});

test("a transfer booked as both our intent and its chain log puts the return under review, never summed", async () => {
  const { raw, db } = await ledger();
  try {
    await db.prepare("UPDATE flows SET chain_id = 4663, tx_hash = '0xdeposit', log_index = 0").run();
    const flow = db.prepare(`INSERT INTO flows (agent_id, epoch, direction, amount_usdg, source, at, chain_id, tx_hash, log_index)
      VALUES (?, 2, 'out', 10, ?, ?, 4663, '0xhome', ?)`);
    await flow.run(ACCOUNT, "transfer-intent", 5, null);
    await op(db, 5);
    await mark(db, 100, 10);
    assert.equal((await readBookPerformance(db, ACCOUNT, 2, true)).liveRank.pnlBps, 1111, "one withdrawal: 100 over 90");
    // A scan that no longer had the transfer's trade row books it again.
    await flow.run(CASED, "chain-log", 9, 3);
    for (const reader of [db, translated(raw)]) {
      const result = await readBookPerformance(reader, ACCOUNT, 2, true);
      assert.deepEqual(result.liveRank, { pnlBps: null, unrankedWhy: "review-pending" });
      assert.equal(result.performance.underReview, true);
      assert.equal(result.performance.pnlBps, null);
      assert.equal(result.performance.pnlUsdg, null);
      assert.equal(result.performance.funded, null);
      assert.equal(result.performance.equityUsdg, 100);
      assert.equal(result.performance.fills, 1, "what the return means is still said");
    }
    // Before any valuation, the funding is under review too — not "no deposit".
    await db.prepare("DELETE FROM equity").run();
    const before = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.deepEqual(before.liveRank, { pnlBps: null, unrankedWhy: "review-pending" });
    assert.equal(before.performance.funded, null);
  } finally { raw.close(); }
});

test("the resolver's booking of a transfer the executor already booked puts the return under review, whichever came first", async () => {
  for (const [executor, resolver] of [[5, 9], [9, 5]] as const) {
    const { raw, db } = await ledger();
    try {
      await db.prepare("UPDATE flows SET chain_id = 4663, tx_hash = '0xdeposit', log_index = 0").run();
      const flow = db.prepare(`INSERT INTO flows (agent_id, epoch, direction, amount_usdg, source, at, chain_id, tx_hash, log_index)
        VALUES (?, 2, 'out', 10, 'transfer-intent', ?, 4663, '0xhome', ?)`);
      // The executor's intent (no log index), and the resolver's, from the
      // receipt, under the spelling it asked about: summed, the withdrawal
      // counted twice and published 100 over 80 as a 25% gain.
      await flow.run(ACCOUNT, executor, null);
      await flow.run(CASED, resolver, 3);
      await op(db, 5);
      await mark(db, 100, 10);
      for (const reader of [db, translated(raw)]) {
        const result = await readBookPerformance(reader, ACCOUNT, 2, true);
        assert.deepEqual(result.liveRank, { pnlBps: null, unrankedWhy: "review-pending" }, `executor @${executor}`);
        assert.equal(result.performance.underReview, true);
        assert.equal(result.performance.pnlUsdg, null);
      }
    } finally { raw.close(); }
  }
});

test("funding quality uses the same epoch, heartbeat and spelling tie-break as the current account", async () => {
  const { raw, db } = await ledger();
  try {
    await db.prepare("UPDATE agents SET beat_at = 10, created_at = 1").run();
    await db.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps,
      granted_at, expires_at, mode, epoch, beat_at, created_at, contributions_known)
      VALUES (?, 'Alias', 'PRIVATE-OWNER', 'PRIVATE-KEY', 4663, '{}', 0, 0, 'live', 2, 10, 1, 0)`).run(CASED);
    await op(db, 5);
    await mark(db, 110, 10);
    const tied = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.equal(tied.liveRank.unrankedWhy, "contributions-unevidenced", "the canonical upper spelling wins an exact tie");
    assert.equal(tied.performance.pnlUsdg, null);
    await db.prepare("UPDATE agents SET beat_at = 20 WHERE smart_account = ?").run(ACCOUNT);
    assert.equal((await readBookPerformance(db, ACCOUNT, 2, true)).performance.pnlBps, 1000);
    await db.prepare("UPDATE agents SET epoch = 1, beat_at = 30 WHERE smart_account = ?").run(CASED);
    assert.equal((await readBookPerformance(db, CASED, 2, true)).performance.pnlBps, 1000, "a newer old-epoch heartbeat cannot override current-run quality");
  } finally { raw.close(); }
});

test("the actual financial reads use applied account/run indexes rather than scanning the fleet", async () => {
  const { raw, db } = await ledger();
  try {
    await op(db, 5);
    await mark(db, 110, 10);
    const equity = raw.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, equity_usdg, at, epoch, mode)
      VALUES (?, '0', 0, 0, 100, ?, 2, 'live')`);
    const flow = raw.prepare(`INSERT INTO flows (agent_id, epoch, direction, amount_usdg, source, at)
      VALUES (?, 2, 'in', 1, 'chain-log', ?)`);
    const trade = raw.prepare(`INSERT INTO trades (agent_id, kind, target, amount_usdg, status, user_op_hash,
      fill_side, gas_usdg, created_at, epoch) VALUES (?, 'swap', 'x', 1, 'landed', ?, 'buy', 0, ?, 2)`);
    raw.exec("BEGIN");
    for (let agent = 1; agent <= 100; agent++) {
      const account = `0x${agent.toString(16).padStart(40, "0")}`;
      for (let at = 1; at <= 40; at++) equity.run(account, at);
      for (let at = 1; at <= 5; at++) flow.run(account, at);
      for (let at = 1; at <= 20; at++) trade.run(account, `${account}-op-${at}`, at);
    }
    raw.exec("COMMIT; ANALYZE");
    const plans: { sql: string; details: string; nestedDetails: string }[] = [];
    const actual: Db = { ...db, prepare(sql) {
      const statement = db.prepare(sql);
      const explain = (params: unknown[]) => {
        if (sql.includes("LOWER(agent_id)") || sql.includes("LOWER(t.agent_id)")) {
          const rows = raw.prepare("EXPLAIN QUERY PLAN " + sql).all(...params as never[]);
          plans.push({ sql, details: rows.map((row) => String(row.detail)).join("\n"),
            nestedDetails: rows.filter((row) => Number(row.parent) !== 0).map((row) => String(row.detail)).join("\n") });
        }
      };
      // The flows are read as rows (distinct-flows.ts) and collapsed in
      // process; every other financial read is one aggregate row.
      return { ...statement,
        async get(...params) { explain(params); return statement.get(...params); },
        async all(...params) { explain(params); return statement.all(...params); } };
    } };
    assert.equal((await readBookPerformance(actual, CASED, 2, true)).performance.pnlBps, 1000);
    const equities = plans.filter((p) => p.sql.includes("FROM equity"));
    assert.equal(equities.length, 2, "both raw current and measured financial marks are checked");
    for (const plan of equities) {
      // SQLite versions may also push the valuation cutoff into the index
      // search. Both plans must still constrain the normalized account/run.
      assert.match(plan.details, /SEARCH equity USING INDEX equity_agent_run_normalized \(<expr>=\? AND epoch=\?(?:\)| AND )/);
      assert.doesNotMatch(plan.details, /SCAN equity/);
    }
    const flows = plans.find((p) => p.sql.includes("FROM flows"))!;
    assert.match(flows.details, /SEARCH flows USING INDEX flows_agent_run_normalized \(<expr>=\? AND epoch=\?(?:\)| AND )/);
    assert.doesNotMatch(flows.details, /SCAN flows/);
    // Gas, and the fills that say what a flat return means: both trade reads.
    const trades = plans.filter((p) => p.sql.includes("FROM trades"));
    assert.equal(trades.length, 2);
    for (const plan of trades) {
      assert.match(plan.details, /SEARCH t USING INDEX trades_agent_run_normalized \(<expr>=\? AND epoch=\?(?:\)| AND )/);
      // The outer aggregate scans its already scoped coroutine result, also
      // named t. Only nested accesses can scan the underlying trades table.
      assert.doesNotMatch(plan.nestedDetails, /SCAN t\b/);
    }
  } finally { raw.close(); }
});

test("a paper book that has never traded says so; its flat return is the book compared with itself", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, 1000, 2, "paper");
    await mark(db, 1000, 3, "paper");
    // A simulated transfer is an operation, not a trade.
    await op(db, 1, { status: "paper", kind: "transfer", hash: "" });
    const { performance } = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.equal(performance.pnlBps, 0, "the figure itself is unchanged");
    assert.deepEqual([performance.fills, performance.fillsAtMark, performance.lastFillAt, performance.valuation], [0, 0, null, "current"]);
    assert.equal(performance.funded, null, "real deposits are not a paper book's capital");
    assert.equal(performance.gasOps, null);
  } finally { raw.close(); }
});

test("Finley: a paper book whose only valuation predates both its buys is awaiting its first valuation", async () => {
  const { raw, db } = await ledger();
  try {
    // Production's shape: one mark at 15:37:55, then two buys eight seconds
    // later, and no valuation since — so 0.0% was published for trades that
    // had not been valued at all.
    const MARK = Date.UTC(2026, 9, 1, 15, 37, 55) / 1000;
    await mark(db, 1000, MARK, "paper");
    await op(db, MARK + 8, { status: "paper", hash: "" });
    await op(db, MARK + 8, { status: "paper", hash: "", kind: "curve-trade" });
    const { performance } = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.equal(performance.pnlBps, 0);
    assert.deepEqual([performance.fills, performance.fillsAtMark, performance.lastFillAt, performance.valuation], [2, 0, MARK + 8, "awaiting"]);
    // The paper reader answers a failed read with the same null as a book with
    // no measured mark, so a failure must not be told as "awaiting".
    const unread: Db = { ...db, prepare(sql) {
      if (sql.includes("WITH marks AS")) throw new Error("permission denied");
      return db.prepare(sql);
    } };
    const failed = (await readBookPerformance(unread, ACCOUNT, 2, true)).performance;
    assert.deepEqual([failed.book, failed.fills, failed.fillsAtMark, failed.valuation], ["paper", null, null, null]);
  } finally { raw.close(); }
});

test("Ajinde: a fill newer than the measured valuation leaves a real return standing, marked awaiting", async () => {
  const { raw, db } = await ledger();
  try {
    const MARK = Date.UTC(2026, 9, 1, 20, 9, 25) / 1000;
    await mark(db, 1000, MARK - 3_600, "paper");
    await op(db, MARK - 60, { status: "paper", hash: "" });
    await mark(db, 999.958, MARK, "paper");
    await op(db, MARK + 4, { status: "paper", hash: "" });
    const { performance } = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.ok(Math.abs(performance.pnlBps! + 0.42) < 1e-9, "the measured figure is unchanged");
    assert.equal(performance.pnlAt, MARK);
    assert.deepEqual([performance.fills, performance.fillsAtMark, performance.lastFillAt, performance.valuation], [2, 1, MARK + 4, "awaiting"]);
  } finally { raw.close(); }
});

test("a funded live book with no trade is funded with none; a vault deposit alone ranks without being a trade", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, 100, 10);
    const waiting = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.equal(waiting.liveRank.unrankedWhy, "never-filled");
    assert.deepEqual([waiting.performance.fills, waiting.performance.funded, waiting.performance.valuation], [0, true, "current"]);
    assert.deepEqual(waiting.performance.gasOps, { sponsored: 0, priced: 0, unpriced: 0, unrecorded: 0 });
    // An executed vault deposit IS evidence the account ran, so the ranking
    // gate counts it — and it is still not a trade.
    await op(db, 5, { kind: "vault-deposit", bare: true });
    await mark(db, 110, 20);
    const ranked = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.equal(ranked.liveRank.pnlBps, 1000);
    assert.equal(ranked.performance.pnlBps, 1000);
    assert.equal(ranked.performance.fills, 0);
    await db.prepare("DELETE FROM flows").run();
    const unfunded = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.equal(unfunded.liveRank.unrankedWhy, "no-deposit");
    assert.equal(unfunded.performance.funded, false);
  } finally { raw.close(); }
});

test("with no valuation yet a trade of either book counts, and an unread mark or tape says nothing", async () => {
  const { raw, db } = await ledger();
  try {
    const empty = await readBookPerformance(db, ACCOUNT, 2, false);
    assert.deepEqual([empty.performance.book, empty.performance.fills, empty.performance.fillsAtMark, empty.performance.funded],
      [null, 0, 0, true]);
    await op(db, 5, { status: "paper", hash: "" });
    const traded = await readBookPerformance(db, ACCOUNT, 2, false);
    assert.deepEqual([traded.performance.fills, traded.performance.fillsAtMark, traded.performance.lastFillAt, traded.performance.valuation],
      [1, 0, 5, null]);
    const noMarks: Db = { ...db, prepare(sql) {
      if (sql.includes("FROM equity")) throw new Error("permission denied");
      return db.prepare(sql);
    } };
    assert.equal((await readBookPerformance(noMarks, ACCOUNT, 2, false)).performance.fills, null, "an unread mark is not an absent one");
    await mark(db, 110, 10);
    const noTape: Db = { ...db, prepare(sql) {
      if (sql.includes("'swap', 'curve-trade'")) throw new Error("permission denied");
      return db.prepare(sql);
    } };
    const unread = await readBookPerformance(noTape, ACCOUNT, 2, true);
    assert.deepEqual([unread.performance.fills, unread.performance.fillsAtMark, unread.performance.valuation], [null, null, null]);
    assert.equal(unread.performance.equityUsdg, 110, "and nothing else is lost with it");
  } finally { raw.close(); }
});

test("a return under review is withheld on every book, and nothing but the return is", async () => {
  const saved = process.env.MERRYMEN_RETURN_REVIEW;
  const { raw, db } = await ledger();
  try {
    await op(db, 5);
    await mark(db, 110, 10);
    const open = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.equal(open.liveRank.pnlBps, 1000);
    process.env.MERRYMEN_RETURN_REVIEW = `${FOREIGN},${CASED}`;
    const held = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.deepEqual(held.liveRank, { pnlBps: null, unrankedWhy: "review-pending" });
    assert.deepEqual(held.performance, { ...open.performance, pnlUsdg: null, pnlBps: null, underReview: true },
      "the valuation, its time and the counts stay; the return in both units goes");
    // A paper book's return is shown without being ranked, so it is withheld
    // on the figures and in the legacy field too.
    await mark(db, 1000, 20, "paper");
    await mark(db, 1100, 30, "paper");
    const paper = await readBookPerformance(db, ACCOUNT, 2, true);
    assert.equal(paper.performance.book, "paper");
    assert.equal(paper.performance.pnlBps, null);
    assert.equal(paper.performance.pnlUsdg, null);
    assert.equal(paper.paperPnlBps, null);
    assert.equal(paper.performance.equityUsdg, 1100);
    process.env.MERRYMEN_RETURN_REVIEW = FOREIGN;
    assert.equal((await readBookPerformance(db, ACCOUNT, 2, true)).paperPnlBps, 1000, "another account's review is not this one's");
  } finally {
    raw.close();
    if (saved === undefined) delete process.env.MERRYMEN_RETURN_REVIEW;
    else process.env.MERRYMEN_RETURN_REVIEW = saved;
  }
});

test("gas operations are counted by what is on record; the unpriced and unrecorded ones are exactly the incomplete ones", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, 110, 10);
    await op(db, 1, { gas: 0.2, wei: "200" });
    await op(db, 2, { gas: null, wei: "0" });
    await op(db, 3, { gas: null, sponsor: "300" });
    await op(db, 4, { gas: 0, sponsor: "300" });
    await op(db, 5, { gas: null, wei: "123" });
    await op(db, 6, { gas: null });
    await op(db, 7, { gas: 2, wei: "2000", hash: "0xOLD" });
    await db.prepare("UPDATE trades SET user_op_nonce = '1' WHERE user_op_hash = '0xOLD'").run();
    await op(db, 20, { gas: null }); // after the measured valuation
    for (const reader of [db, translated(raw)]) {
      const { performance } = await readBookPerformance(reader, ACCOUNT, 2, false);
      assert.deepEqual(performance.gasOps, { sponsored: 2, priced: 2, unpriced: 1, unrecorded: 2 });
      assert.equal(performance.gasComplete, false);
    }
    await db.prepare(`UPDATE trades SET gas_usdg = 0.1 WHERE gas_usdg IS NULL
      AND COALESCE(sponsored_gas_wei, '') = '' AND COALESCE(gas_wei, '') <> '0'`).run();
    await db.prepare("UPDATE trades SET budget_settled_at = 7 WHERE user_op_hash = '0xOLD'").run();
    const { performance } = await readBookPerformance(db, ACCOUNT, 2, false);
    assert.deepEqual(performance.gasOps, { sponsored: 2, priced: 5, unpriced: 0, unrecorded: 0 });
    assert.equal(performance.gasComplete, true);
  } finally { raw.close(); }
});
