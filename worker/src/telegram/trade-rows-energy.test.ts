/**
 * AN ENERGY PURCHASE IS CALLED ENERGY — ON /trades, IN THE CHAT, IN THE PING.
 *
 * pickAcquiredLeg refuses the energy reserve on purpose (it must never get a
 * fill or a basis), which left every place that NAMES a trade with nothing to
 * call a $MERRYMEN buy: a restart copy read "a coin I can't name", and a live
 * one would have been announced under a ticker read off the chain like any
 * launchpad coin. It is capacity, not a position, and the owner should read it
 * as that. Executed against an in-memory ledger and a fake chain.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, it } from "node:test";

import { CASH, MERRYMEN_TOKEN } from "../../../packages/core/src/index";
import { pickAcquiredLeg } from "../inflight-reconcile";
import { netTokenDeltas } from "../fills";
import { clearTokenLabelCacheForTest, receiptFacts } from "../token-label";
import { tradeLine } from "./notifier";
import { ENERGY_LABEL, isEnergyRow, loadTradeViews, renderTradeList, tradeViewLine } from "./trade-rows";

const USDG = CASH.USDG.toLowerCase();
const MERRY = MERRYMEN_TOKEN.address.toLowerCase();
const AGENT = "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487";
const PAIR = "0x00000000000000000000000000000000000beef1";

function ledger(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, target TEXT, sell_token TEXT, buy_token TEXT,
      amount_usdg REAL, fill_cash_usdg REAL, fill_side TEXT, realized_pnl_usdg REAL, status TEXT, reject_rule TEXT, tx_hash TEXT,
      decision_id TEXT, created_at INTEGER);
    CREATE TABLE decisions (id TEXT PRIMARY KEY, agent_id TEXT, symbol TEXT, display_name TEXT, at INTEGER);
    CREATE TABLE discovered_pools (address TEXT PRIMARY KEY, symbol TEXT);
    CREATE TABLE positions (agent_id TEXT, symbol TEXT, token TEXT);
  `);
  return db;
}

const pad = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const transfer = (token: string, from: string, to: string, value: bigint) => ({
  address: token,
  topics: [TRANSFER, pad(from), pad(to)],
  data: `0x${value.toString(16)}`,
});
/** USDG → (VIRTUAL, between the pairs) → $MERRYMEN into the account: what the energy route leaves on a receipt. */
const ENERGY_LOGS = [
  transfer(USDG, AGENT, PAIR, 5_000_000n),
  transfer(MERRY, PAIR, AGENT, 10_000n * 10n ** 18n),
];

function fakeChain() {
  return {
    readContract: (async () => {
      throw new Error("an energy row must not need its symbol read");
    }) as never,
    getTransactionReceipt: (async ({ hash }: { hash: string }) => {
      if (hash !== "0xenergy") throw new Error("unknown tx");
      return { blockNumber: 7n, logs: ENERGY_LOGS };
    }) as never,
    getBlock: (async () => ({ timestamp: 1_790_000_000n })) as never,
  };
}

beforeEach(() => clearTokenLabelCacheForTest());

describe("/trades and the chat's lookups", () => {
  it("the worker's energy-buy row is 'energy ($MERRYMEN)', bought", async () => {
    const db = ledger();
    db.prepare(
      "INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, tx_hash, created_at) VALUES (?, 'energy-buy', ?, ?, ?, 5, 'landed', '0xe1', 100)",
    ).run(AGENT, "0x89e5db8b5aa49aa85ac63f691524311aeb649eba", CASH.USDG, MERRYMEN_TOKEN.address);
    const [v] = await loadTradeViews(db, AGENT, { client: fakeChain() });
    assert.equal(v!.label, ENERGY_LABEL);
    assert.equal(v!.side, "buy");
    assert.equal(v!.trusted, true);
    assert.match(tradeViewLine(v!, false), /^✅ bought energy \(\$MERRYMEN\) for \$5\.00 · /);
  });

  it("a leg-less energy-buy row is still named, and still a buy", async () => {
    const db = ledger();
    db.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at) VALUES (?, 'energy-buy', ?, 5, 'submitted', 100)").run(AGENT, AGENT);
    const [v] = await loadTradeViews(db, AGENT, {});
    assert.equal(v!.label, ENERGY_LABEL);
    assert.equal(v!.side, "buy");
    assert.doesNotMatch(tradeViewLine(v!, false), /can't name/);
  });

  it("a refused one says what it was", async () => {
    const db = ledger();
    db.prepare(
      "INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, reject_rule, created_at) VALUES (?, 'energy-buy', ?, ?, ?, 5, 'rejected', 'daily-cap', 100)",
    ).run(AGENT, AGENT, CASH.USDG, MERRYMEN_TOKEN.address);
    const [v] = await loadTradeViews(db, AGENT, {});
    assert.match(tradeViewLine(v!, false), /blocked: buy of energy \(\$MERRYMEN\)/);
  });

  it("a restart copy of an energy buy is named from its receipt, not 'a coin I can't name'", async () => {
    const db = ledger();
    // findOrphanOps' shape: kind swap, the account targeting itself, no legs, no decision.
    db.prepare("INSERT INTO trades (agent_id, kind, target, amount_usdg, status, tx_hash, created_at) VALUES (?, 'swap', ?, 0, 'landed', '0xenergy', 200)").run(AGENT, AGENT);
    const [v] = await loadTradeViews(db, AGENT, { book: [AGENT], client: fakeChain() });
    assert.equal(v!.label, ENERGY_LABEL);
    assert.equal(v!.side, "buy");
    assert.equal(v!.usdg, 5);
    assert.doesNotMatch(renderTradeList([v!]), /can't name/);
  });

  it("asked for $MERRYMEN or energy, the energy rows answer", async () => {
    const db = ledger();
    db.prepare(
      "INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, created_at) VALUES (?, 'energy-buy', ?, ?, ?, 5, 'landed', 100)",
    ).run(AGENT, AGENT, CASH.USDG, MERRYMEN_TOKEN.address);
    for (const token of ["MERRYMEN", "$MERRYMEN", "energy"]) {
      assert.equal((await loadTradeViews(db, AGENT, { token })).length, 1, token);
    }
  });
});

describe("the receipt reads it for a NAME only — never as a fill", () => {
  it("receiptFacts names the energy leg; pickAcquiredLeg still refuses it", async () => {
    const facts = await receiptFacts(fakeChain(), "0xenergy", [AGENT]);
    assert.deepEqual(
      { token: facts?.token, side: facts?.side, cash: facts?.cashUsdg },
      { token: MERRY, side: "buy", cash: 5_000_000n },
    );
    // The accounting invariant this must not weaken (inflight-reconcile.ts).
    assert.equal(pickAcquiredLeg(netTokenDeltas(ENERGY_LOGS as never, AGENT), USDG), null);
  });
});

describe("the trade ping", () => {
  it("names it energy, with or without a coin handed in", () => {
    const row = { id: 1, kind: "energy-buy", amount_usdg: 5, status: "landed", reject_rule: null, tx_hash: null };
    assert.match(tradeLine(row, null, false, { label: ENERGY_LABEL, side: "buy" }), /✅ Bought energy \(\$MERRYMEN\) for \$5\.00/);
    assert.match(tradeLine(row, null), /A top-up of energy \(\$MERRYMEN\) went through — \$5\.00/);
  });

  it("isEnergyRow: the worker's kind, or a reserve-token leg", () => {
    assert.ok(isEnergyRow({ kind: "energy-buy" }));
    assert.ok(isEnergyRow({ kind: "swap", sell_token: CASH.USDG, buy_token: MERRYMEN_TOKEN.address.toUpperCase() }));
    assert.ok(!isEnergyRow({ kind: "swap", sell_token: CASH.USDG, buy_token: "0x0000000000000000000000000000000000000001" }));
  });

  it("the ping names energy before any chain lookup, and no model narrates why it was bought", () => {
    const src = readFileSync(new URL("./notifier.ts", import.meta.url), "utf8");
    const coin = src.slice(src.indexOf("async function coinFor("));
    const body = coin.slice(0, coin.indexOf("\n}\n"));
    assert.ok(body.indexOf("isEnergyRow(t)") < body.indexOf("tokenLabel("), "energy is named before a symbol is read off the chain");
    assert.match(src, /\(t\.status === "landed" \|\| t\.status === "paper"\) && !isEnergyRow\(t\)/);
  });
});

describe("a DROPPED op on /trades", () => {
  it("reads as dropped — never '⏳ bought' — and is among what the owner asks 'refused' for", async () => {
    const db = ledger();
    db.prepare(
      `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, reject_rule, created_at)
       VALUES (?, 'energy-buy', ?, ?, ?, 5, 'dropped', 'dropped: a later op used its nonce (resolved)', ?)`,
    ).run(AGENT, PAIR, USDG, MERRY, Math.floor(Date.now() / 1000));
    const [v] = await loadTradeViews(db, AGENT);
    assert.ok(v);
    const line = tradeViewLine(v!, false);
    assert.match(line, /^↩️ dropped: buy of energy \(\$MERRYMEN\), \$5\.00 — it never reached the chain, and nothing moved · /);
    assert.doesNotMatch(line, /bought|⏳/);
    assert.equal((await loadTradeViews(db, AGENT, { filter: "refused" })).length, 1);
    assert.equal((await loadTradeViews(db, AGENT, { filter: "filled" })).length, 0);
  });
});
