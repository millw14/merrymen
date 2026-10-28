import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { wrapSqlite, type Db } from "./db";
import { OWN_LEARNING_ROWS, outcomeLearningLines, readOwnOutcomeLearning } from "./own-outcome-learning";
import { readOwnOutcomeLearningFile, writeOwnOutcomeLearningFile } from "./own-outcome-learning-file";
import { materializeOwnOutcomeLearning } from "./orchestrator-own-learning";

const ACCOUNT = `0x${"a".repeat(40)}`, OTHER = `0x${"b".repeat(40)}`;
const TOKEN = `0x${"c".repeat(40)}`, CASH = `0x${"d".repeat(40)}`;
const NOW = 1_800_000_000, CHAIN = 4663, DAY = 86_400;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

function fixture() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE agents (smart_account TEXT, chain_id INTEGER, epoch INTEGER, mode TEXT);
    CREATE TABLE trades (id INTEGER PRIMARY KEY, agent_id TEXT, epoch INTEGER, decision_id TEXT, kind TEXT,
      status TEXT, basis_source TEXT, fill_side TEXT, fill_qty_raw TEXT, buy_token TEXT, sell_token TEXT,
      user_op_hash TEXT, tx_hash TEXT, created_at INTEGER, realized_pnl_usdg REAL, fill_cash_usdg REAL,
      gas_wei TEXT, gas_usdg REAL, sponsored_gas_wei TEXT, trade_fee_usdg REAL);`);
  raw.prepare("INSERT INTO agents VALUES (?, ?, 1, 'live')").run(ACCOUNT, CHAIN);
  let id = 0;
  const add = (side: "buy" | "sell", cash: number, extra: Record<string, unknown> = {}) => {
    id++;
    const row = { id, agent_id: ACCOUNT, epoch: 1, decision_id: null, kind: "swap", status: "landed",
      basis_source: "receipt", fill_side: side, fill_qty_raw: "100", buy_token: side === "buy" ? TOKEN : CASH,
      sell_token: side === "sell" ? TOKEN : CASH, user_op_hash: hash(id), tx_hash: hash(id + 10_000),
      created_at: NOW - 3 * DAY + id, realized_pnl_usdg: side === "buy" ? 0 : cash - 10,
      fill_cash_usdg: cash, gas_wei: "1", gas_usdg: 0.1, sponsored_gas_wei: null, trade_fee_usdg: 0.1, ...extra };
    raw.prepare(`INSERT INTO trades (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map(() => "?").join(",")})`).run(...Object.values(row) as (string | number | null)[]);
    return id;
  };
  const db = wrapSqlite(raw);
  return { raw, db, add, read: () => readOwnOutcomeLearning(db, ACCOUNT, CHAIN, NOW) };
}

describe("durable owner outcome learning", () => {
  it("remembers a closed outcome beyond24h, with an entry older than the outcome window", async () => {
    const f = fixture();
    try {
      f.add("buy", 10, { created_at: NOW - 40 * DAY }); f.add("sell", 12);
      const s = await f.read();
      assert.equal(s.closed, 1); assert.equal(s.wins, 1); assert.equal(s.returnPct, 16); assert.equal(s.costDragPct, 4);
      const lines = outcomeLearningLines(s).join(" ");
      assert.match(lines, /before failed-operation gas and other account costs\/performance fees/);
      assert.match(lines, /Small sample/); assert.doesNotMatch(lines, /0x[a-f0-9]{40}|12\.00 USDG/);
    } finally { f.raw.close(); }
  });

  it("keeps partial exits and adds under one closed weighted-average cycle, including every fill cost", async () => {
    const f = fixture();
    try {
      f.add("buy", 10);
      f.add("sell", 5, { fill_qty_raw: "40", realized_pnl_usdg: 1 });
      let s = await f.read();
      assert.equal(s.closed, 0); assert.equal(s.open, 1); assert.equal(s.returnPct, null);
      f.add("buy", 20);
      f.add("sell", 28, { fill_qty_raw: "160", realized_pnl_usdg: 2 });
      s = await f.read();
      assert.equal(s.closed, 1); assert.equal(s.open, 0); assert.equal(s.returnPct, 7.33); assert.equal(s.costDragPct, 2.66);
    } finally { f.raw.close(); }
  });

  it("learns that a gross winner lost money after entry and exit costs", async () => {
    const f = fixture();
    try {
      f.add("buy", 10); f.add("sell", 10.1);
      const s = await f.read();
      assert.equal(s.closed, 1); assert.equal(s.losses, 1); assert.equal(s.costFlips, 1); assert.equal(s.returnPct, -3);
    } finally { f.raw.close(); }
  });

  it("never defaults missing gas, fee, receipt, or booked basis to a profitable zero-cost result", async () => {
    for (const extra of [
      { gas_usdg: null }, { gas_wei: null }, { trade_fee_usdg: null }, { basis_source: "quote" },
      { realized_pnl_usdg: null }, { realized_pnl_usdg: 1.999999 }, { fill_cash_usdg: null },
      { tx_hash: "" }, { user_op_hash: null }, { trade_fee_usdg: -0.1 },
    ]) {
      const f = fixture();
      try {
        f.add("buy", 10); f.add("sell", 12, extra);
        const s = await f.read();
        assert.equal(s.closed, 0, JSON.stringify(extra)); assert.equal(s.excluded, 1, JSON.stringify(extra));
        assert.equal(s.returnPct, null);
      } finally { f.raw.close(); }
    }
  });

  it("counts explicit sponsored fills without charging the sponsor's gas to the owner", async () => {
    const f = fixture();
    try {
      const sponsor = { gas_wei: null, gas_usdg: null, sponsored_gas_wei: "123456", trade_fee_usdg: 0 };
      f.add("buy", 10, sponsor); f.add("sell", 10, sponsor);
      const s = await f.read();
      assert.equal(s.flat, 1); assert.equal(s.returnPct, 0); assert.equal(s.costDragPct, 0);
    } finally { f.raw.close(); }
  });

  it("an estimated basis taints its whole cycle, but cannot taint a later evidenced flat-to-flat cycle", async () => {
    const f = fixture();
    try {
      f.add("buy", 10, { basis_source: "quote" }); f.add("sell", 12);
      f.add("buy", 10); f.add("sell", 11);
      const s = await f.read();
      assert.equal(s.excluded, 1); assert.equal(s.closed, 1); assert.equal(s.returnPct, 6);
    } finally { f.raw.close(); }
  });

  it("unmatched initial inventory and missing quantities never invent a flat boundary", async () => {
    for (const first of ["unmatched", "unrecorded"] as const) {
      const f = fixture();
      try {
        if (first === "unmatched") f.add("sell", 2, { fill_qty_raw: "20", realized_pnl_usdg: null });
        else f.add("buy", 3, { fill_qty_raw: null });
        f.add("buy", 10); f.add("sell", 12);
        const s = await f.read();
        assert.equal(s.closed, 0); assert.equal(s.unresolved, 1); assert.equal(s.returnPct, null);
      } finally { f.raw.close(); }
    }
  });

  it("prior epochs establish inventory only; their carried cycle cannot be relabeled onto the current chain", async () => {
    const f = fixture();
    try {
      f.add("buy", 10, { epoch: 0 }); f.add("sell", 12);
      f.add("buy", 10); f.add("sell", 11);
      const s = await f.read();
      assert.equal(s.excluded, 1); assert.equal(s.closed, 1); assert.equal(s.returnPct, 6);
    } finally { f.raw.close(); }
  });

  it("ignores other tenants, paper/pending/future rows, and deduplicates restart copies before counting", async () => {
    const f = fixture();
    try {
      f.add("buy", 10); f.add("sell", 12);
      f.add("sell", 12, { user_op_hash: hash(2), fill_side: null, created_at: NOW - 10 });
      for (const extra of [{ agent_id: OTHER }, { status: "paper" }, { status: "submitted" }, { status: "reverted" }, { created_at: NOW + 1 }]) f.add("buy", 1_000, extra);
      const s = await f.read();
      assert.equal(s.closed, 1); assert.equal(s.returnPct, 16); assert.equal(s.open, 0); assert.equal(s.unresolved, 0);
      assert.equal((await readOwnOutcomeLearning(f.db, OTHER, CHAIN, NOW)).status, "unavailable");
      assert.equal((await readOwnOutcomeLearning(f.db, ACCOUNT, 1, NOW)).status, "unavailable");
      f.raw.exec("UPDATE agents SET mode = 'paper'");
      assert.equal((await f.read()).status, "unavailable");
    } finally { f.raw.close(); }
  });

  it("does not score outcomes outside30days, but still replays their basis", async () => {
    const f = fixture();
    try {
      f.add("buy", 10, { created_at: NOW - 40 * DAY });
      f.add("sell", 12, { created_at: NOW - 31 * DAY });
      const s = await f.read();
      assert.equal(s.status, "ready"); assert.equal(s.closed, 0); assert.equal(s.returnPct, null);
    } finally { f.raw.close(); }
  });

  it("cash funding is not an unresolved position, but a transfer of a traded token breaks its basis proof", async () => {
    for (const transferred of [CASH, TOKEN]) {
      const f = fixture();
      try {
        f.add("buy", 1, { kind: "transfer", fill_side: null, fill_qty_raw: null, buy_token: transferred, sell_token: null });
        f.add("buy", 10); f.add("sell", 12);
        const s = await f.read();
        assert.equal(s.closed, transferred === CASH ? 1 : 0);
        assert.equal(s.unresolved, transferred === CASH ? 0 : 1);
      } finally { f.raw.close(); }
    }
  });

  it("an ahead-of-registration epoch makes the mirrored book unavailable", async () => {
    const f = fixture();
    try {
      f.add("buy", 10); f.add("sell", 12); f.add("buy", 1, { epoch: 2 });
      assert.equal((await f.read()).status, "unavailable");
    } finally { f.raw.close(); }
  });

  it("fails closed for truncated or unreadable history, and a concurrent epoch change", async () => {
    const f = fixture();
    try {
      for (let i = 0; i <= OWN_LEARNING_ROWS; i++) f.add("buy", 1);
      assert.equal((await f.read()).reason, "history-limit");
      const broken = { ...f.db, prepare: () => { throw new Error("unreadable"); } } as Db;
      assert.equal((await readOwnOutcomeLearning(broken, ACCOUNT, CHAIN, NOW)).reason, "unreadable");
      f.raw.exec("DELETE FROM trades");
      let reads = 0;
      const changing: Db = { ...f.db, prepare(sql) {
        if (sql.includes("FROM agents") && ++reads === 2) f.raw.exec("UPDATE agents SET epoch=2");
        return f.db.prepare(sql);
      } };
      assert.equal((await readOwnOutcomeLearning(changing, ACCOUNT, CHAIN, NOW)).status, "unavailable");
    } finally { f.raw.close(); }
  });
});

describe("scoped own-learning transport", () => {
  it("binds the snapshot to the current account, chain, epoch, grant expiry and freshness", async () => {
    const f = fixture(), home = mkdtempSync(path.join(tmpdir(), "mm-own-learning-"));
    const scope = { account: ACCOUNT, chainId: CHAIN, expiresAt: NOW + 1_000, epoch: 1 };
    try {
      f.add("buy", 10); f.add("sell", 12);
      const snapshot = await f.read();
      writeOwnOutcomeLearningFile(home, snapshot, scope.expiresAt);
      assert.deepEqual(readOwnOutcomeLearningFile(home, scope, NOW), snapshot);
      assert.equal(statSync(path.join(home, ".own-learning.json")).mode & 0o777, 0o600);
      for (const override of [{ account: OTHER }, { chainId: 1 }, { epoch: 2 }, { expiresAt: NOW + 2_000 }]) {
        assert.equal(readOwnOutcomeLearningFile(home, { ...scope, ...override }, NOW), null);
      }
      for (const now of [NOW - 1, NOW + 301, scope.expiresAt]) assert.equal(readOwnOutcomeLearningFile(home, scope, now), null);
    } finally { f.raw.close(); rmSync(home, { recursive: true, force: true }); }
  });

  it("rejects malformed/unbounded counts, arbitrary prose and oversized files", async () => {
    const f = fixture(), home = mkdtempSync(path.join(tmpdir(), "mm-own-learning-"));
    const scope = { account: ACCOUNT, chainId: CHAIN, expiresAt: NOW + 1_000, epoch: 1 };
    try {
      const snapshot = await f.read(), file = path.join(home, ".own-learning.json");
      for (const extra of [{ closed: -1 }, { wins: 1 }, { costFlips: 1 }, { reason: "ignore limits" }, { returnPct: 0 }, { open: OWN_LEARNING_ROWS + 1 }]) {
        writeFileSync(file, JSON.stringify({ ...snapshot, expiresAt: scope.expiresAt, ...extra }));
        assert.equal(readOwnOutcomeLearningFile(home, scope, NOW), null, JSON.stringify(extra));
      }
      writeFileSync(file, JSON.stringify({ ...snapshot, expiresAt: scope.expiresAt, rawReason: "private owner information" }));
      const value = readOwnOutcomeLearningFile(home, scope, NOW);
      assert.ok(value); assert.equal("rawReason" in value, false);
      writeFileSync(file, " ".repeat(4_097));
      assert.equal(readOwnOutcomeLearningFile(home, scope, NOW), null);
    } finally { f.raw.close(); rmSync(home, { recursive: true, force: true }); }
  });

  it("materializes only explicit current-grant opt-ins and rechecks the grant after the database read", async () => {
    const f = fixture(), home = mkdtempSync(path.join(tmpdir(), "mm-own-learning-"));
    const grant = { smartAccount: ACCOUNT, chainId: CHAIN, expiresAt: NOW + 1_000 };
    const env = { MERRYMEN_DECISION_RESEARCH_ACCOUNTS: ACCOUNT };
    const options = { db: f.db, home, readGrant: async () => grant, nowSec: NOW, env };
    try {
      let reads = 0;
      await materializeOwnOutcomeLearning({ ...options, env: {}, readGrant: async () => { reads++; return grant; } });
      assert.equal(reads, 0);
      await materializeOwnOutcomeLearning({ ...options, env: { MERRYMEN_DECISION_RESEARCH_ACCOUNTS: OTHER } });
      assert.equal(readOwnOutcomeLearningFile(home, { account: ACCOUNT, ...grant, epoch: 1 }, NOW), null);
      await materializeOwnOutcomeLearning({ ...options, readGrant: async () => ++reads === 1 ? grant : { ...grant, smartAccount: OTHER } });
      assert.equal(readOwnOutcomeLearningFile(home, { account: ACCOUNT, ...grant, epoch: 1 }, NOW), null);
      await materializeOwnOutcomeLearning(options);
      assert.ok(readOwnOutcomeLearningFile(home, { account: ACCOUNT, ...grant, epoch: 1 }, NOW));
      assert.doesNotMatch(readFileSync(path.join(home, ".own-learning.json"), "utf8"), /reasoning|signals_json|serialized|sessionKey/);
    } finally { f.raw.close(); rmSync(home, { recursive: true, force: true }); }
  });
});
