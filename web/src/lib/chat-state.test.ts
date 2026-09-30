/**
 * A STATE THAT DOES NOT PARSE IS WORSE THAN NO STATE.
 *
 * The chat is stateless on the server: the browser holds the book and sends it,
 * and the system prompt tells the model to ground every number in it. The blob
 * was clamped with `slice(0, 6000)`, which cuts wherever six thousand
 * characters happens to land — mid-object, mid-string, mid-number.
 *
 * A model handed malformed JSON does not refuse it. It reads what it can and
 * fills the rest, in character, confidently, about somebody's money. A tester's
 * agent reported months-old `no-gas` and `per-trade-cap` refusals as its
 * current state; half of that was a tape with no time window, and this is the
 * half that made the answer unpredictable as well as stale.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fitChatState, STATE_BUDGET } from "./chat-state";

const move = (i: number) => ({
  at: 1_700_000_000 + i,
  action: "buy",
  symbol: "TSLA",
  sizeUsdg: 5,
  outcome: "refused",
  outcomeText: "per-trade-cap",
});

const state = (n: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    name: "Robin",
    equity: 1000,
    strategy: "steady-basket",
    moves: Array.from({ length: n }, (_, i) => move(i)),
    ...extra,
  });

describe("fitChatState", () => {
  it("THE RESULT ALWAYS PARSES — the property that was violated", () => {
    const big = state(400);
    assert.ok(big.length > STATE_BUDGET, "the fixture must actually overflow");
    const out = fitChatState(big);
    assert.ok(out.length > 0, "an oversized but valid state must not be thrown away");
    // Literally the assertion: this is what a blind slice could not promise.
    assert.doesNotThrow(() => JSON.parse(out));
    assert.ok(out.length <= STATE_BUDGET);
  });

  it("says that it dropped things, rather than dropping them silently", () => {
    const out = JSON.parse(fitChatState(state(400))) as { truncated?: boolean; moves: unknown[] };
    assert.equal(out.truncated, true, "the model must know the tape is partial");
    assert.ok(out.moves.length < 400);
  });

  it("drops the OLDEST moves, because a refusal from last month explains nothing", () => {
    const out = JSON.parse(fitChatState(state(400))) as { moves: { at: number }[] };
    assert.ok(out.moves.length > 0);
    const newest = 1_700_000_000 + 399;
    assert.equal(out.moves[out.moves.length - 1]!.at, newest, "the newest move must survive");
  });

  it("keeps every non-tape field whole — half a number is not a smaller number", () => {
    const out = JSON.parse(fitChatState(state(400))) as Record<string, unknown>;
    assert.equal(out.name, "Robin");
    assert.equal(out.equity, 1000);
    assert.equal(out.strategy, "steady-basket");
  });

  it("a state that already fits is passed through untouched", () => {
    const small = state(2);
    assert.equal(fitChatState(small), small, "no rewriting when none is needed");
  });

  it("UNPARSEABLE INPUT YIELDS NOTHING, never a prefix", () => {
    // With no STATE the prompt's own rule applies and the agent says it does
    // not know. With a fragment it answers from wreckage.
    const broken = `{"name":"Robin","moves":[` + "x".repeat(STATE_BUDGET);
    assert.equal(fitChatState(broken), "");
  });

  it("refuses shapes it cannot reason about", () => {
    assert.equal(fitChatState(undefined), "");
    assert.equal(fitChatState(""), "");
    assert.equal(fitChatState(JSON.stringify(Array.from({ length: 4000 }, (_, i) => i))), "");
  });

  it("an oversized state with no tape at all is refused, not cut", () => {
    const noTape = JSON.stringify({ name: "x".repeat(STATE_BUDGET + 100), moves: [] });
    assert.equal(fitChatState(noTape), "");
  });
});

/** A ledger the owner's tape reads, with rows placed around a window. */
async function tapeLedger() {
  const { DatabaseSync } = await import("node:sqlite");
  const { wrapSqlite } = await import("../../../worker/src/db");
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE agents(smart_account TEXT, epoch INTEGER);
    CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, sell_token TEXT, buy_token TEXT,
      amount_usdg REAL, tx_hash TEXT, status TEXT, reject_rule TEXT, sim_quote_out TEXT, sim_min_out TEXT, sim_fee_tier INTEGER,
      sim_gas TEXT, created_at INTEGER, user_op_hash TEXT, decision_id TEXT, fill_side TEXT, fill_symbol TEXT,
      realized_pnl_usdg REAL, epoch INTEGER);
    CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT, reason TEXT);
    INSERT INTO agents VALUES ('a', 2);`);
  return { raw, db: wrapSqlite(raw) };
}

describe("the surfaces that feed it", () => {
  it("THE TAPE HAS A TIME WINDOW, not just a row limit", async () => {
    // `LIMIT 30` alone means an agent that has done nothing lately sends its
    // last thirty refusals, however old — and the model, told to ground itself
    // in the state, reports them in the present tense. Run through the function
    // the route calls, with the clock passed in, so the window's sign and size
    // are what is tested rather than a spelling in the route.
    const { readOwnerTape, TAPE_WINDOW_SEC } = await import("./desk-trades");
    const { raw, db } = await tapeLedger();
    try {
      const now = 10_000_000;
      const since = now - TAPE_WINDOW_SEC;
      const ins = raw.prepare(
        `INSERT INTO trades (agent_id, kind, amount_usdg, status, reject_rule, created_at, epoch) VALUES ('a','swap',1,'rejected','no-gas',?,2)`,
      );
      ins.run(since - 60);
      for (let i = 1; i <= 40; i++) ins.run(since + i);
      const tape = await readOwnerTape(db, "a", 2, now);
      assert.equal(tape.trades?.length, 30, "and the size bound stays — neither substitutes for the other");
      assert.ok(tape.trades!.every((t) => t.created_at > since), "the refusal from before the window is not on the tape");
      assert.equal(TAPE_WINDOW_SEC, 7 * 86_400, "a week back from now");
    } finally {
      raw.close();
    }
  });

  it("the tape and the landed count are this run's, and a ledger without runs reads them all", async () => {
    const { readOwnerTape, readRunEpoch } = await import("./desk-trades");
    const { raw, db } = await tapeLedger();
    try {
      const now = 10_000_000;
      raw.exec(`INSERT INTO trades (agent_id, kind, amount_usdg, status, created_at, user_op_hash, epoch) VALUES
        ('a','swap',1,'landed',${now - 100},'0x01',1),
        ('a','swap',1,'landed',${now - 90},'0x02',2),
        ('a','swap',1,'landed',${now - 80},'0x02',2),
        ('b','swap',1,'landed',${now - 70},'0x03',2);`);
      assert.equal(await readRunEpoch(db, "a"), 2);
      assert.equal(await readRunEpoch(db, "nobody-yet"), 1, "no agents row is a first run");
      const run = await readOwnerTape(db, "a", 2, now);
      assert.equal(run.trades?.length, 1, "run 1's fill and another account's are not on this tape; the copy is one operation");
      assert.equal(run.landed, 1);
      const all = await readOwnerTape(db, "a", null, now);
      assert.equal(all.trades?.length, 2, "no run to scope by: every run's operations");
      assert.equal(all.landed, 2);
      raw.exec("DROP TABLE agents; CREATE TABLE agents(smart_account TEXT);");
      assert.equal(await readRunEpoch(db, "a"), null, "a ledger older than runs leaves the rows unfiltered, not blank");
      raw.exec("DROP TABLE trades;");
      assert.deepEqual(await readOwnerTape(db, "a", null, now), { trades: null, landed: null }, "an unreadable tape says so");
    } finally {
      raw.close();
    }
  });

  it("the client sends a bounded tape, newest first, and says how much it left out", async () => {
    const { chatStateOf, TAPE_SHOWN } = await import("../terminal/chat-payload");
    const moves = Array.from({ length: 30 }, (_, i) => ({
      slug: null,
      name: "Robin",
      handle: null,
      action: "buy" as const,
      symbol: "TSLA",
      sizeUsdg: 5,
      reason: null,
      paper: false,
      head: "swap",
      at: 1_700_000_000 + i,
      outcome: "refused" as const,
      outcomeText: "per-trade-cap",
    }));
    const state = chatStateOf({ mine: book({ moves }), settings: null, liveBlocker: null, perTrade: 10, perDay: 50, stopped: false });
    assert.equal(state.moves.length, TAPE_SHOWN, "the whole tape must not be sent");
    assert.equal(state.movesShown, TAPE_SHOWN, "the agent must be able to say 'the last 8 of 30'");
    assert.equal(state.movesTotal, 30);
    // Each move carries its timestamp, or the model cannot tell old from new —
    // and they are the NEWEST eight, not the stalest.
    assert.equal(state.moves[0]!.at, 1_700_000_029);
    assert.ok(state.moves.every((m) => typeof m.at === "number" && m.at >= 1_700_000_022));
  });

  it("the prompt tells the model the tape is partial and timestamped", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./agent-chat.ts", import.meta.url), "utf8");
    assert.match(src, /THE TAPE IS RECENT AND PARTIAL/);
    assert.match(src, /fitChatState\(body\.state\)/, "the blind slice must be gone");
    assert.ok(!src.includes("body.state.slice(0, 6000)"), "no prefix clamp may return");
  });
});

type Mine = import("../terminal/live").LiveMine;

/** The owner's own agent, as the screen holds it. */
function book(over: Partial<Mine> = {}): Mine {
  return {
    name: "Robin",
    slug: null,
    handle: null,
    owner: "you",
    equity: 1000,
    chg24: null,
    mode: "steady-basket",
    thesis: null,
    moves: [],
    glance: {
      id: "steady-basket",
      label: "Steady basket",
      cashUsd: 900,
      legs: [
        { symbol: "NVDA", weight: 50 },
        { symbol: "QQQ", weight: 50 },
      ],
    },
    autonomy: { mode: "paper" } as never,
    ...over,
  };
}

/** What the feed would hand the screen for these holdings. */
async function fedBook(positions: NonNullable<Parameters<typeof import("../terminal/live").mineOf>[0]>["positions"]) {
  const { mineOf } = await import("../terminal/live");
  const fed = mineOf({ agent: { name: "Robin", strategy: "steady-basket", slug: null }, positions }, [])!;
  return book({ ...fed, glance: book().glance });
}

describe("the agent is told what it holds", () => {
  it("POSITIONS ARE POSITIONS, NOT THE STRATEGY GLANCE", async () => {
    // An owner asked their agent what NVDA and QQQ had cost and when it would
    // sell, and it answered that it held nothing but cash — while the panel
    // beside the chat listed both. It was not hallucinating. `positions` in the
    // payload was `mine.glance`, a strategy descriptor whose `legs` are
    // percentage weights, sent under the one key the system prompt names.
    const { chatStateOf } = await import("../terminal/chat-payload");
    const mine = await fedBook([
      { symbol: "NVDA", value_usdg: 60, price_stale: 0, cost_usdg: 50, cost_from_quote: false },
      { symbol: "QQQ", value_usdg: 40, price_stale: 1, cost_usdg: null },
    ]);
    const state = chatStateOf({ mine, settings: null, liveBlocker: null, perTrade: null, perDay: null, stopped: false });
    assert.deepEqual(
      state.positions.map((p) => [p.symbol, p.valueUsd]),
      [
        ["NVDA", 60],
        ["QQQ", 40],
      ],
      "the holdings and their values, not the glance's weights",
    );
    assert.ok(state.positions.every((p) => !("weight" in p)));
  });

  it("AND WITH WHAT THEY COST, or the sell question cannot be answered", async () => {
    // "Should I take this profit" is unanswerable from a value alone. Cost and
    // unrealised percentage travel on each holding.
    const { chatStateOf } = await import("../terminal/chat-payload");
    const mine = await fedBook([
      { symbol: "NVDA", value_usdg: 60, price_stale: 0, cost_usdg: 50, cost_from_quote: false },
      { symbol: "QQQ", value_usdg: 40, price_stale: 0, cost_usdg: 0 },
    ]);
    const [nvda, qqq] = chatStateOf({ mine, settings: null, liveBlocker: null, perTrade: null, perDay: null, stopped: false }).positions;
    assert.equal(nvda!.costUsd, 50);
    assert.equal(nvda!.unrealisedPct, 20);
    // NULL, never 0. Zero says the position was free, which is the accounting
    // bug this repo is downstream of, handed to a model in a chat reply.
    assert.equal(qqq!.costUsd, null);
    assert.equal(qqq!.unrealisedPct, null);
  });

  it("and the levels that sell without asking it", async () => {
    // "What would make you get out" has a mechanical answer — a stop and a
    // take-profit that fire on a tick, not on a view. NULL means unarmed, which
    // is a different sentence from a level of zero, and the prompt says so.
    const { chatStateOf } = await import("../terminal/chat-payload");
    const armed = chatStateOf({
      mine: book(),
      settings: { values: { strategistStopLossBps: 2500 }, defaults: { takeProfitBps: 4000, strategistStopLossBps: 1000 } },
      liveBlocker: null,
      perTrade: null,
      perDay: null,
      stopped: false,
    });
    assert.equal(armed.stopLossBps, 2500, "the owner's value over the default");
    assert.equal(armed.takeProfitBps, 4000);
    const unread = chatStateOf({ mine: book(), settings: null, liveBlocker: null, perTrade: null, perDay: null, stopped: false });
    assert.equal(unread.stopLossBps, null, "settings nobody read are not a level of zero");
    assert.equal(unread.takeProfitBps, null);
    const { readFileSync } = await import("node:fs");
    const prompt = readFileSync(new URL("./agent-chat.ts", import.meta.url), "utf8");
    assert.match(prompt, /WHEN YOU WOULD GET OUT/);
    assert.match(prompt, /NULL means that rule is not armed at all/);
  });
});
