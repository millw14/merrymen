/**
 * The orchestrator's read of one tenant's history out of the shared ledger,
 * and the merge rule the chat applies to it.
 *
 * The loader runs on a sqlite ledger with the shared schema, holding what the
 * shared tape really holds after a few redeploys: an operation's evidenced
 * original beside bare restart copies of it (hash lowercased, account in
 * another spelling), refusals, another tenant's rows, and rows too old to
 * carry. The SQL is written once for both backends.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { getAddress } from "viem";

import { wrapSqlite } from "./db";
import { HISTORY_REFUSALS_MAX, loadAccountFromShared, loadHistoryFromShared, readHistory, writeHistoryFile, type HistoryTrade } from "./history-files";
import { applyLedgerSchema } from "./store";
import { planHistoryMerge } from "./telegram/history-overlay";

const A = "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487";
const OTHER = "0x0000000000000000000000000000000000000b0b";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const COIN = "0x7a11ce0000000000000000000000000000000001";
const NOW = 1_800_000_000;
const DAY = 86_400;
const H1 = "0xAAAA000000000000000000000000000000000000000000000000000000000001";

async function ledger() {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  const t = (agent: string, p: Record<string, unknown>) => {
    const row = { kind: "swap", target: agent, amount_usdg: 5, status: "landed", ...p, agent_id: agent };
    const cols = Object.keys(row);
    raw.prepare(`INSERT INTO trades (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(row) as never[]));
  };
  return { raw, db, t };
}

describe("loadHistoryFromShared", () => {
  it("one row per operation — the evidenced original, never the restart copies beside it", async () => {
    const { raw, db, t } = await ledger();
    // The executor's row, then two restart copies from later redeploys.
    t(A, { target: "0xvault", sell_token: USDG, buy_token: COIN, user_op_hash: H1, tx_hash: "0xt1", fill_side: "buy", decision_id: "d1", fill_symbol: "MUSE", created_at: NOW - 2 * DAY });
    t(A, { user_op_hash: H1.toLowerCase(), tx_hash: "0xt1", created_at: NOW - DAY });
    t(getAddress(A), { target: getAddress(A), user_op_hash: H1.toLowerCase(), tx_hash: "0xt1", created_at: NOW - 3600 });
    // A copy whose original is older than the window: still collapsed into it, and then left out with it.
    t(A, { target: "0xvault", sell_token: USDG, buy_token: COIN, user_op_hash: "0xold", fill_side: "buy", created_at: NOW - 31 * DAY });
    t(A, { user_op_hash: "0xOLD", created_at: NOW - 29 * DAY });
    // A practice fill, a refusal, and rows that must never come along.
    t(A, { status: "paper", sell_token: USDG, buy_token: COIN, fill_side: "buy", created_at: NOW - 3 * DAY });
    t(A, { status: "rejected", reject_rule: "DAILY_CAP", created_at: NOW - 100 });
    t(A, { status: "landed", user_op_hash: "0xancient", created_at: NOW - 40 * DAY });
    t(OTHER, { status: "landed", user_op_hash: "0xother", created_at: NOW - 10 });
    raw.prepare("INSERT INTO decisions (id, agent_id, source, symbol, action, reason, at) VALUES ('d1', ?, 'brain', 'MUSE', 'buy', 'why', ?)").run(A, NOW - 40 * DAY);
    raw.prepare("INSERT INTO decisions (id, agent_id, source, action, at) VALUES ('d2', ?, 'market-review-private', 'hold', ?)").run(A, NOW - 10);
    raw.prepare("INSERT INTO decisions (id, agent_id, source, action, reason, at) VALUES ('d3', ?, 'brain', 'hold', ?, ?)").run(A, "x".repeat(5000), NOW - 20);
    raw.prepare("INSERT INTO decisions (id, agent_id, source, action, at) VALUES ('d4', ?, 'brain', 'buy', ?)").run(OTHER, NOW - 5);
    raw.prepare("INSERT INTO decisions (id, agent_id, source, action, hold_kind, at) VALUES ('d5', ?, 'brain', 'hold', 'GATE_FORCED_HOLD', ?)").run(A, NOW - 30);

    const h = await loadHistoryFromShared(db, getAddress(A), NOW);
    const ops = h.trades.filter((r) => r.user_op_hash?.toLowerCase() === H1.toLowerCase());
    assert.equal(ops.length, 1, "three rows of one op are one op");
    assert.equal(ops[0]!.fill_side, "buy", "and it is the executor's evidenced row");
    assert.equal(ops[0]!.fill_symbol, "MUSE");
    assert.equal(h.trades.filter((r) => r.user_op_hash?.toLowerCase() === "0xold").length, 0, "a copy never stands alone for want of its original");
    assert.ok(h.trades.some((r) => r.status === "paper"));
    assert.ok(h.trades.some((r) => r.status === "rejected" && r.reject_rule === "DAILY_CAP"));
    assert.ok(!h.trades.some((r) => r.user_op_hash === "0xancient"), "older than the window");
    assert.ok(!h.trades.some((r) => r.user_op_hash === "0xother"), "another tenant's row");
    assert.deepEqual(
      h.trades.map((r) => r.created_at),
      [...h.trades.map((r) => r.created_at)].sort((a, b) => b - a),
      "newest first",
    );
    const ids = h.decisions.map((d) => d.id).sort();
    assert.deepEqual(ids, ["d1", "d3"], "the linked decision even when old, the recent one — never the private review, a forced hold, or another tenant's");
    assert.equal(h.decisions.find((d) => d.id === "d3")!.reason!.length, 600, "a reason is bounded");
    assert.equal(typeof h.trades[0]!.created_at, "number");
    raw.close();
  });

  it("a day of refusals cannot push the fills out", async () => {
    const { raw, db, t } = await ledger();
    t(A, { sell_token: USDG, buy_token: COIN, user_op_hash: "0xfill", fill_side: "buy", created_at: NOW - 5 * DAY });
    for (let i = 0; i < HISTORY_REFUSALS_MAX + 50; i++) t(A, { status: "rejected", reject_rule: "WALL", created_at: NOW - i });
    const h = await loadHistoryFromShared(db, A, NOW);
    assert.ok(h.trades.some((r) => r.user_op_hash === "0xfill"));
    assert.equal(h.trades.filter((r) => r.status === "rejected").length, HISTORY_REFUSALS_MAX);
    raw.close();
  });

  it("the file round-trips, and is only ever read for the agent it was written for", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-histfile-"));
    try {
      const { raw, db, t } = await ledger();
      t(A, { sell_token: USDG, buy_token: COIN, user_op_hash: "0xf", fill_side: "buy", created_at: NOW - DAY });
      const h = await loadHistoryFromShared(db, A, NOW);
      raw.close();
      writeHistoryFile(home, h);
      assert.equal(readHistory(home, getAddress(A))?.trades.length, 1);
      assert.equal(readHistory(home, OTHER), null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function row(p: Partial<HistoryTrade> & Pick<HistoryTrade, "created_at">): HistoryTrade {
  return {
    kind: "swap", target: "0xvault", sell_token: USDG, buy_token: COIN, amount_usdg: 5, user_op_hash: null, tx_hash: null,
    status: "landed", reject_rule: null, decision_id: null, fill_side: "buy", fill_symbol: null, fill_qty_raw: null,
    fill_price_usd: null, realized_pnl_usdg: null, fill_cash_usdg: 5, gas_usdg: null, gas_wei: null, epoch: 1, ...p,
  };
}

describe("planHistoryMerge", () => {
  const copy = (p: Partial<HistoryTrade> & Pick<HistoryTrade, "created_at">) =>
    row({ target: A, sell_token: null, buy_token: null, fill_side: null, ...p });

  const op = (real: boolean, status: string | null = "landed", tx: string | null = null) => ({ real, status, tx });

  it("the ledger's own row wins; a carried original replaces only a restart copy", () => {
    const local = { ops: new Map([["0x1", op(true)], ["0x2", op(false)], ["0x3", op(false)]]), firstAt: NOW - 3600 };
    const plan = planHistoryMerge(
      [
        row({ user_op_hash: "0x1", created_at: NOW - DAY }), // ledger has the executor's row
        row({ user_op_hash: "0X2", created_at: NOW - DAY }), // ledger has only a copy → replace it
        copy({ user_op_hash: "0x3", created_at: NOW - DAY }), // both copies → keep the ledger's
        row({ user_op_hash: "0x4", created_at: NOW - DAY }), // ledger has nothing → carry
        row({ user_op_hash: "0x4", created_at: NOW - DAY }), // the file repeats itself → once
      ],
      A,
      local,
    );
    assert.deepEqual(plan.trades.map((t) => t.user_op_hash), ["0X2", "0x4"]);
    assert.deepEqual(plan.supersede, ["0x2"]);
  });

  it("a carried 'submitted' never overrides how the ledger says the op ended", () => {
    // Sent just before a redeploy: the shared copy never learned the outcome,
    // the new run's restart copy exists because the chain says it landed.
    const plan = planHistoryMerge(
      [row({ user_op_hash: "0x9", status: "submitted", tx_hash: null, decision_id: "d", created_at: NOW - 60 })],
      A,
      { ops: new Map([["0x9", op(false, "landed", "0xtx9")]]), firstAt: NOW - 30 },
    );
    assert.equal(plan.trades[0]!.status, "landed");
    assert.equal(plan.trades[0]!.tx_hash, "0xtx9");
    assert.equal(plan.trades[0]!.decision_id, "d", "the carried row's evidence is still what replaces the copy");
    assert.deepEqual(plan.supersede, ["0x9"]);
    const alone = planHistoryMerge([row({ user_op_hash: "0x8", status: "submitted", created_at: NOW - 60 })], A, { ops: new Map(), firstAt: NOW - 30 });
    assert.equal(alone.trades[0]!.status, "unconfirmed", "no record of how it ended — not 'waiting to confirm' for ever");
  });

  it("a row with no hash is carried only when it is older than everything on the ledger", () => {
    const plan = planHistoryMerge(
      [row({ status: "paper", created_at: NOW - 7200 }), row({ status: "rejected", created_at: NOW - 60 })],
      A,
      { ops: new Map(), firstAt: NOW - 3600 },
    );
    assert.deepEqual(plan.trades.map((t) => t.status), ["paper"]);
    const empty = planHistoryMerge([row({ status: "rejected", created_at: NOW - 60 })], A, { ops: new Map(), firstAt: null });
    assert.equal(empty.trades.length, 1, "an empty ledger holds nothing to overlap");
  });
});

describe("loadAccountFromShared", () => {
  const H = 3600;
  const T0 = NOW - 2 * 86_400 - (NOW % H); // on an hour boundary

  async function account() {
    const { raw, db, t } = await ledger();
    raw
      .prepare("INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, epoch) VALUES (?, 'o', 's', 4663, '{}', 0, 0, 2)")
      .run(getAddress(A));
    const m = (agent: string, at: number, equity: number, cash: number, epoch = 2, mode = "live") =>
      raw
        .prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', ?, 0, ?, ?, ?, ?)")
        .run(agent, cash, equity, at, epoch, mode);
    const f = (agent: string, at: number, dir: string, amount: number, source: string, tx: string | null = null, li: number | null = null, epoch = 2) =>
      raw
        .prepare("INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, log_index, source, at, epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(agent, dir, amount, tx, li, source, at, epoch);
    // Marks a minute apart; the long gaps between runs are restarts, and only
    // those steps are judged (period-pnl.ts).
    m(A, T0 + 0, 100, 60);
    m(A, T0 + 60, 100.5, 60);
    m(A, T0 + 120, 101, 60);
    m(A, T0 + 180, 101, 60);
    // Restart: an opening balance booked again with flat cash (a phantom).
    f(A, T0 + 1100, "in", 100, "inferred");
    m(A, T0 + 1200, 102, 60);
    m(A, T0 + 1260, 102, 60);
    // Within the run: a deposit logged on chain — under BOTH spellings of the account.
    f(A, T0 + 1290, "in", 20, "chain-log", "0xDEP", 3);
    f(getAddress(A), T0 + 1290, "in", 20, "chain-log", "0xdep", 3);
    m(getAddress(A), T0 + 1320, 122, 80);
    // Restart: cash falls with only a RESTART COPY behind it — a copy proves nothing, so unattributed.
    t(A, { user_op_hash: "0xcopy", created_at: T0 + H + 50 });
    m(A, T0 + H + 100, 112, 70);
    m(A, T0 + H + 160, 112, 70);
    // Restart: cash falls with a real trade behind it — trading.
    t(A, { target: "0xvault", sell_token: USDG, buy_token: COIN, user_op_hash: "0xreal", fill_side: "buy", created_at: T0 + 2 * H + 10 });
    m(A, T0 + 2 * H + 100, 110, 60);
    // A deposit after the last mark, before the bound: the tail.
    f(A, T0 + 2 * H + 500, "in", 7, "chain-log", "0xtail", 0);
    // Never carried: another epoch, another tenant, a mark with no mode, at/after the bound.
    m(A, T0 + 50, 999, 999, 1);
    m(OTHER, T0 + 50, 999, 999);
    raw
      .prepare("INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 5, 0, 5, ?, 2, NULL)")
      .run(A, T0 + 30);
    const until = T0 + 3 * H;
    m(A, until, 999, 999);
    const acct = await loadAccountFromShared(db, A, T0 - 86_400, until);
    raw.close();
    return { acct: acct!, until };
  }

  it("carries each book's first and last marks and hourly closes, with the running attribution", async () => {
    const { acct, until } = await account();
    assert.equal(acct.epoch, 2);
    assert.equal(acct.until, until);
    assert.equal(acct.complete, true);
    assert.deepEqual(
      acct.points.map((p) => [p.at - T0, p.equity]),
      [[0, 100], [1320, 122], [H + 160, 112], [2 * H + 100, 110]],
      "the first mark and each hour's close; other epochs, tenants, mode-less marks and marks at the bound never come",
    );
    const last = acct.points[acct.points.length - 1]!;
    // +20 of chain-logged deposit (once, not twice); the phantom +100 dropped;
    // the −10 with only a copy behind it unattributed; the −2 with a trade is trading.
    assert.equal(last.flows, 20);
    assert.equal(last.unattributed, -10);
    assert.deepEqual(acct.tail, [{ book: "live", evidenced: 7, unevidenced: 0 }]);
  });

  it("round-trips through the file, and a malformed account costs only the account", async () => {
    const { acct } = await account();
    const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-histacct-"));
    try {
      const base = { schema: 1 as const, agentId: A, writtenAt: NOW, since: NOW - 30 * 86_400, decisionsFrom: NOW, trades: [], decisions: [] };
      writeHistoryFile(home, { ...base, account: acct });
      assert.deepEqual(readHistory(home, A)?.account, acct);
      const bad = { ...acct, points: [...acct.points, { ...acct.points[0]!, at: acct.until + 5 }] };
      writeHistoryFile(home, { ...base, account: bad, trades: [row({ created_at: NOW - 60 })] });
      const back = readHistory(home, A)!;
      assert.equal(back.account, null, "a point at or after the bound is not ours");
      assert.equal(back.trades.length, 1, "the trades still come");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the child's own ledger is never carried back to it", () => {
  it("nothing at or after `until` comes — trades, refusals or decisions", async () => {
    const { raw, db, t } = await ledger();
    t(A, { sell_token: USDG, buy_token: COIN, user_op_hash: "0xbefore", fill_side: "buy", created_at: NOW - 3600 });
    t(A, { sell_token: USDG, buy_token: COIN, user_op_hash: "0xafter", fill_side: "buy", created_at: NOW - 60 });
    t(A, { status: "rejected", reject_rule: "OLD", created_at: NOW - 3000 });
    t(A, { status: "rejected", reject_rule: "NEW", created_at: NOW - 30 });
    raw.prepare("INSERT INTO decisions (id, agent_id, source, action, at) VALUES ('d-old', ?, 'brain', 'buy', ?)").run(A, NOW - 3600);
    raw.prepare("INSERT INTO decisions (id, agent_id, source, action, at) VALUES ('d-new', ?, 'brain', 'buy', ?)").run(A, NOW - 60);
    const h = await loadHistoryFromShared(db, A, NOW, { until: NOW - 600 });
    raw.close();
    assert.deepEqual(h.trades.map((r) => r.user_op_hash ?? r.reject_rule).sort(), ["0xbefore", "OLD"]);
    assert.deepEqual(h.decisions.map((d) => d.id), ["d-old"]);
    assert.equal(h.writtenAt, NOW);
  });
});
