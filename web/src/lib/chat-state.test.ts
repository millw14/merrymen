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

describe("the surfaces that feed it", () => {
  it("THE TAPE HAS A TIME WINDOW, not just a row limit", async () => {
    // `LIMIT 30` alone means an agent that has done nothing lately sends its
    // last thirty refusals, however old — and the model, told to ground itself
    // in the state, reports them in the present tense.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../app/api/feed/route.ts", import.meta.url), "utf8");
    assert.match(src, /TAPE_WINDOW_SEC/, "the trades read must be bounded in time");
    const trades = src.slice(src.indexOf("FROM trades WHERE agent_id"));
    assert.match(trades.slice(0, 200), /created_at > \?/, "the window must be in the query, not applied after");
    assert.match(trades.slice(0, 200), /LIMIT 30/, "and the size bound stays — neither substitutes for the other");
  });

  it("the client sends a bounded tape and says how much it left out", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../terminal/screens/Agent.tsx", import.meta.url), "utf8");
    assert.match(src, /moves:tapeFor\(mine\.moves\)/, "the whole tape must not be sent");
    assert.match(src, /movesShown/, "the agent must be able to say 'the last 8 of 30'");
    assert.match(src, /movesTotal/);
    // Each move carries its timestamp, or the model cannot tell old from new.
    assert.match(src, /at: m\.at/);
  });

  it("the prompt tells the model the tape is partial and timestamped", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
    assert.match(src, /THE TAPE IS RECENT AND PARTIAL/);
    assert.match(src, /fitChatState\(body\.state\)/, "the blind slice must be gone");
    assert.ok(!src.includes("body.state.slice(0, 6000)"), "no prefix clamp may return");
  });
});
