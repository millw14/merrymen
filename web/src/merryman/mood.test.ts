/**
 * THE MERRYMAN NEVER ACTS OUT SOMETHING THAT DID NOT HAPPEN.
 *
 * He is a reading of the agent, held to the same honesty rule as every figure
 * on the page: no arrow for a trade that only would-have happened, no cheer
 * for a sale whose profit the tape did not vouch for, no "news" on the first
 * reading of a tape, and a nap only when trading is really off.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autonomyOf } from "@merrymen/core";

import { CLIPS } from "./clips";
import { moodOf, newestReaction, reactionTo, wordOf, type Move } from "./mood";

const ids = new Set(CLIPS.map((c) => c.id));

describe("trade reactions", () => {
  it("only a LANDED trade is a shot fired", () => {
    assert.equal(reactionTo({ action: "buy", outcome: "landed", symbol: "PONS" })?.clip, "shoot");
    assert.equal(reactionTo({ action: "buy", outcome: "pending", symbol: "PONS" }), null, "pending has not happened");
    assert.equal(reactionTo({ action: "buy", outcome: "landed", shadow: true }), null, "a shadow row would-have-bought");
    assert.equal(reactionTo({ action: "buy", outcome: "shadow" }), null);
    assert.equal(reactionTo({ action: "hold", outcome: "view" }), null, "a view is a thought");
  });

  it("a sale is a win or a loss only when the tape vouched for it", () => {
    assert.equal(reactionTo({ action: "sell", outcome: "landed", realizedVouched: true, realizedPnlUsdg: 3 })?.clip, "celebrate");
    assert.equal(reactionTo({ action: "sell", outcome: "landed", realizedVouched: true, realizedPnlUsdg: -2 })?.clip, "facepalm");
    const unvouched = reactionTo({ action: "sell", outcome: "landed", realizedPnlUsdg: 50 });
    assert.equal(unvouched?.clip, "coinToss", "pockets it, no claim");
    assert.doesNotMatch(unvouched!.bubble, /profit|loss/i);
  });

  it("a refusal and a revert say no money moved, without drama", () => {
    assert.equal(reactionTo({ action: "buy", outcome: "refused", symbol: "X" })?.clip, "shrug");
    assert.match(reactionTo({ action: "buy", outcome: "reverted", symbol: "X" })!.bubble, /No money moved/);
  });

  it("practice trades say so", () => {
    assert.match(reactionTo({ action: "buy", outcome: "landed", symbol: "PONS", paper: true })!.bubble, /practice/);
  });

  it("the first reading of a tape is not news", () => {
    const moves: Move[] = [{ action: "buy", outcome: "landed", at: 100 }];
    assert.equal(newestReaction(moves, null), null);
    assert.equal(newestReaction(moves, 100), null, "nothing newer than what was seen");
    assert.equal(newestReaction([...moves, { action: "sell", outcome: "landed", at: 120, realizedVouched: true, realizedPnlUsdg: 1 }], 100)?.reaction.clip, "celebrate");
  });

  it("every reaction names a clip that exists", () => {
    for (const m of [
      { action: "buy", outcome: "landed" }, { action: "sell", outcome: "landed" },
      { action: "sell", outcome: "landed", realizedVouched: true, realizedPnlUsdg: 1 },
      { action: "sell", outcome: "landed", realizedVouched: true, realizedPnlUsdg: -1 },
      { action: "buy", outcome: "refused" }, { action: "buy", outcome: "reverted" },
    ] as Move[]) assert.ok(ids.has(reactionTo(m)!.clip), JSON.stringify(m));
  });
});

describe("moods", () => {
  const live = autonomyOf({ mode: "live", liveBlocker: null, realCashUsd: 100 });
  const paper = autonomyOf({ mode: "paper", liveBlocker: null });

  it("trading live, he scouts; practising, he aims at a target", () => {
    assert.equal(live.state, "live");
    assert.deepEqual([moodOf({ phase: "agent", autonomy: live }).clip, moodOf({ phase: "agent", autonomy: live }).word], ["scout", "Trading"]);
    assert.equal(moodOf({ phase: "agent", autonomy: paper }).clip, "aim");
    assert.match(moodOf({ phase: "agent", autonomy: paper }).bubble!, /pretend money/);
  });

  it("an expired pass is 'Needs you', never a nap", () => {
    const expired = autonomyOf({ mode: "live", liveBlocker: null, expired: true, realCashUsd: 100 });
    const m = moodOf({ phase: "agent", autonomy: expired });
    assert.equal(m.word, "Needs you");
    assert.equal(m.tone, "warn");
    assert.match(m.bubble!, /pass ran out/);
  });

  it("a pass about to run out keeps him working, and says how long is left", () => {
    const soon = autonomyOf({ mode: "live", liveBlocker: null, realCashUsd: 100, expiresSoonDays: 2 });
    const m = moodOf({ phase: "agent", autonomy: soon });
    assert.equal(m.clip, "scout", "still working");
    assert.match(m.bubble!, /2 days/);
  });

  it("a silent worker is described by the verdict alone — no promise that money is safe", () => {
    const silent = autonomyOf({ mode: "live", liveBlocker: null, realCashUsd: 100, workerSilentSince: 1_791_000_000 });
    assert.equal(silent.state, "not-running");
    const m = moodOf({ phase: "agent", autonomy: silent });
    assert.equal(m.clip, "sleep");
    assert.doesNotMatch(m.bubble!, /safe|waking/i);
    assert.match(m.bubble!, /not placing or closing trades/);
    assert.ok(silent.reason && m.bubble!.toLowerCase().includes(silent.reason.slice(1, 20).toLowerCase()), "quotes the verdict's own sentence");
  });

  it("idle offers only the verdict's remedy, never a start button that does not exist", () => {
    const broke = autonomyOf({ mode: "idle", liveBlocker: null, realCashUsd: 0 });
    assert.match(moodOf({ phase: "agent", autonomy: broke }).bubble!, /Add money/);
    assert.doesNotMatch(moodOf({ phase: "agent", autonomy: autonomyOf({ mode: null, liveBlocker: null }) }).bubble!, /Start me/);
  });

  it("a recovery hold outranks the trading state", () => {
    assert.equal(moodOf({ phase: "agent", autonomy: live, recovery: true }).clip, "counting");
    assert.equal(moodOf({ phase: "agent", autonomy: live, recovery: true }).word, "Paused");
  });

  it("chat in flight shows on the screen where you are talking to him", () => {
    assert.equal(moodOf({ phase: "agent", autonomy: live, chat: "thinking" }).clip, "think");
    assert.equal(moodOf({ phase: "agent", autonomy: live, chat: "replying" }).clip, "talk");
  });

  it("every phase and state lands on a real clip and a plain word", () => {
    const states = [live, paper, autonomyOf({ mode: null, liveBlocker: null })];
    for (const phase of ["loading", "failed", "signed-out", "no-agent"] as const) {
      const m = moodOf({ phase });
      assert.ok(ids.has(m.clip), phase);
      assert.doesNotMatch(m.word, /^[A-Z ]{4,}$/, "never an all-caps machine state");
    }
    for (const a of states) assert.ok(ids.has(moodOf({ phase: "agent", autonomy: a }).clip), a.state);
    assert.equal(wordOf("not-running"), "Asleep");
    assert.equal(wordOf("blocked", { needsOwner: true }), "Needs you");
  });
});
