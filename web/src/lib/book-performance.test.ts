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
        pnlBps: 980, pnlAt: 10, publicBook: true, gasComplete: true, held: true });
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
      assert.equal(result.liveRank.unrankedWhy, complete ? null : "quality-unknown");
    } finally { raw.close(); }
  }
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
      pnlBps: null, pnlAt: null, publicBook: true, gasComplete: null, held: false });
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
      return { ...statement, async get(...params) {
        if (sql.includes("LOWER(agent_id)") || sql.includes("LOWER(t.agent_id)")) {
          const rows = raw.prepare("EXPLAIN QUERY PLAN " + sql).all(...params as never[]);
          plans.push({ sql, details: rows.map((row) => String(row.detail)).join("\n"),
            nestedDetails: rows.filter((row) => Number(row.parent) !== 0).map((row) => String(row.detail)).join("\n") });
        }
        return statement.get(...params);
      } };
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
    const trades = plans.find((p) => p.sql.includes("FROM trades"))!;
    assert.match(trades.details, /SEARCH t USING INDEX trades_agent_run_normalized \(<expr>=\? AND epoch=\?(?:\)| AND )/);
    // The outer aggregate scans its already scoped coroutine result, also
    // named t. Only nested accesses can scan the underlying trades table.
    assert.doesNotMatch(trades.nestedDetails, /SCAN t\b/);
  } finally { raw.close(); }
});
