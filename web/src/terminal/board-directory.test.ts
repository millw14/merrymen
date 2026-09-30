import assert from "node:assert/strict";
import { test } from "node:test";
import { loadLive } from "./live";

test("the client retains unlinked and paper board entries instead of silently filtering them", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => new Response(JSON.stringify(String(input).includes("/api/leaderboard") ? {
    source: "sqlite", agents: [
      {slug: "paper-agent", name: "Paper", mode: "paper", filledPaper: 4, landed: 0, pnlBps: null, unrankedWhy: "paper"},
      {slug: null, name: "Unlinked", mode: "idle", landed: 0, pnlBps: null, unrankedWhy: "inactive"},
    ],
  } : {tokens: [], theses: [], rows: []}), {status: 200});
  try {
    const live = await loadLive();
    assert.equal(live.agents.length, 2);
    assert.equal(live.agents[0].filledPaper, 4);
    assert.equal(live.agents[0].mode, "paper");
    assert.equal(live.agents[1].profileAvailable, false);
    assert.equal(live.agents[1].name, "Unlinked");
  } finally { globalThis.fetch = original; }
});

/** loadLive against a leaderboard body, with every other read answering empty. */
async function liveWith(board: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) =>
    new Response(JSON.stringify(String(input).includes("/api/leaderboard") ? board : { tokens: [], theses: [], rows: [] }), {
      status: 200,
    });
  try {
    return await loadLive();
  } finally {
    globalThis.fetch = original;
  }
}

test("the board's retired count reaches the screen, and an unknown one stays unknown", async () => {
  // /api/leaderboard folds retired accounts into a count and the client
  // dropped it, so the rows it folded left the board without a word.
  assert.equal((await liveWith({ source: "sqlite", agents: [], retired: 3 })).retired, 3);
  assert.equal((await liveWith({ source: "sqlite", agents: [], retired: 0 })).retired, 0, "a measured zero is a zero");
  assert.equal((await liveWith({ source: "sqlite", agents: [], retired: null })).retired, null, "nobody could tell");
  assert.equal((await liveWith({ source: "sqlite", agents: [] })).retired, null, "an older server that does not say");
  assert.equal((await liveWith({ source: "sqlite", agents: [], retired: "3" })).retired, null, "not a number is not a count");
});

test("the board says how many accounts it folded, and says nothing it was not told", async () => {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { Board } = await import("./screens/Board");
  const html = (retired: number | null) =>
    renderToStaticMarkup(
      React.createElement(Board, {
        agents: [],
        theses: [],
        mine: null,
        read: "ok",
        retired,
        onProfile: () => {},
        onDesk: () => {},
      } as never),
    ).replace(/<[^>]+>/g, " ");
  assert.match(html(4), /Retired accounts \(4\)/);
  assert.doesNotMatch(html(4), /Nobody has traded yet/, "four accounts that ran are not nobody");
  assert.doesNotMatch(html(null), /Retired/, "an unknown count is not printed as one");
  assert.doesNotMatch(html(0), /Retired/, "nothing was folded, so there is nothing to account for");
});
