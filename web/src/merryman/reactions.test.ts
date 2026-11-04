/**
 * A TRADE BUBBLE SAYS ITS PIECE AND GOES.
 *
 * Every read hands the hero a new `moves` array. The clear timer used to live
 * in the cleanup of an effect keyed on that array, so a read landing inside
 * the six seconds cancelled it and "Bought PONS!" stayed up for good — over
 * the bubble that says the pass ran out. These pin that the bubble clears on
 * its own clock, that a re-read is not news, and that a warning outranks it.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, it, mock } from "node:test";
import React, { act, createElement } from "react";
import { autonomyOf } from "@merrymen/core";

import { testDom } from "../terminal/test-dom";
import type { Move } from "./mood";

let ui: ReturnType<typeof testDom>;
beforeEach(() => { ui = testDom(); mock.timers.enable({ apis: ["setTimeout"] }); });
afterEach(async () => { mock.timers.reset(); await ui.close(); });

const tape = (...moves: Move[]) => moves.map((m) => ({ ...m }));

it("clears after six seconds even when another read lands in between", async () => {
  const { useReactions } = await import("./MerrymanHero");
  let seen: string | null = "unset";
  function Probe({ moves }: { moves: Move[] }) {
    seen = useReactions(moves).bubble;
    return null;
  }
  const first = tape({ action: "buy", outcome: "landed", symbol: "PONS", at: 100 });
  await ui.render(createElement(Probe, { moves: first }));
  assert.equal(seen, null, "the first reading is not news");
  await ui.render(createElement(Probe, { moves: tape(...first, { action: "buy", outcome: "landed", symbol: "CASHCAT", at: 120 }) }));
  assert.match(String(seen), /Bought CASHCAT/);
  await act(async () => { mock.timers.tick(500); });
  await ui.render(createElement(Probe, { moves: tape(...first, { action: "buy", outcome: "landed", symbol: "CASHCAT", at: 120 }) }));
  assert.match(String(seen), /Bought CASHCAT/, "a re-read is the same news, not new news");
  await act(async () => { mock.timers.tick(6000); });
  assert.equal(seen, null, "and it still goes on time");
});

it("a warning about the agent outranks a trade bubble", async () => {
  const { MerrymanHero } = await import("./MerrymanHero");
  const { moodOf } = await import("./mood");
  const { DEFAULT_OUTFIT } = await import("./outfit");
  const expired = moodOf({ phase: "agent", autonomy: autonomyOf({ mode: "live", liveBlocker: null, expired: true, realCashUsd: 10 }) });
  const before = tape({ action: "sell", outcome: "landed", symbol: "X", at: 1 });
  const after = tape(...before, { action: "sell", outcome: "landed", symbol: "Y", at: 2, realizedVouched: true, realizedPnlUsdg: 4 });
  const hero = (moves: Move[]) => createElement(MerrymanHero, { outfit: DEFAULT_OUTFIT, mood: expired, name: "Robin", moves });
  await ui.render(hero(before));
  await ui.render(hero(after));
  const bubble = ui.container.querySelector('[role="status"]')?.textContent ?? "";
  assert.match(bubble, /pass ran out/);
  assert.doesNotMatch(bubble, /profit/);
});

it("what he says reaches a screen reader, outside the picture", async () => {
  const { Merryman } = await import("./Merryman");
  const { DEFAULT_OUTFIT } = await import("./outfit");
  await ui.render(createElement(Merryman, { outfit: DEFAULT_OUTFIT, bubble: "Couldn't save", label: "Robin" }));
  const status = ui.container.querySelector('[role="status"]')!;
  assert.equal(status.textContent, "Couldn't save");
  assert.equal(status.closest('[role="img"]'), null, "children of role=img are presentational");
  void React;
});
