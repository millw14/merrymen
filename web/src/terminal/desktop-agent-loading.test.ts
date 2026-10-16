import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { autonomyOf } from "@merrymen/core";
import { liveOf, seedSources, withRead, type LiveMine, type LiveState } from "./live";
import { testDom } from "./test-dom";
import { DesktopSidebar } from "./Desktop";

(globalThis as unknown as { React: typeof React }).React = React;
const noop = () => {};
const mine: LiveMine = {
  name: "Your agent", slug: null, handle: null, owner: null, equity: null, chg24: null,
  mode: null, thesis: null, moves: [], glance: { id: "custom", label: "" },
  autonomy: autonomyOf({ mode: null, liveBlocker: null }),
};
const failed = { text: JSON.stringify({ source: "none", agents: [] }), answered: true };
const success = { text: JSON.stringify({ source: "sqlite", agents: [
  { slug: "shogun", name: "Shogun", mode: "paper", filledPaper: 4, landed: 0, pnlBps: null, unrankedWhy: "paper" },
] }), answered: true };
const directory = (live: LiveState, section: "agents" | "board", onRetryAgents = noop) => React.createElement(DesktopSidebar, {
  mine, hasAgent: false, tokens: [], agents: live.agents, theses: [], reads: live.reads,
  screen: { kind: "tab", tab: "home" }, section, onSection: noop, onScreen: noop, onTab: noop, onRetryAgents,
});
const panel = (root: ParentNode, section: "agents" | "board") => root.querySelector(`#explore-panel-${section}`)!;

describe("the desktop agent directory's read state", () => {
  for (const section of ["agents", "board"] as const) {
    it(`${section} distinguishes loading, failure and a genuinely empty directory`, () => {
      const cases = [
        { source: seedSources(), expected: "Loading agents…", retry: false },
        { source: withRead(seedSources(), "board", failed, true), expected: "Couldn't load agents.", retry: true },
        { source: withRead(seedSources(), "board", { text: JSON.stringify({ source: "sqlite", agents: [] }), answered: true }, true),
          expected: section === "agents" ? "No other agents are listed yet." : "Nobody has traded yet.", retry: false },
      ];
      for (const item of cases) {
        const dom = new JSDOM(renderToStaticMarkup(directory(liveOf(item.source), section)));
        try {
          const shown = panel(dom.window.document, section);
          assert.ok(shown.textContent?.includes(item.expected), shown.textContent ?? "");
          assert.equal([...shown.querySelectorAll("button")].some(b => b.textContent === "Try again"), item.retry);
          if (item.source.board.read !== "ok") {
            assert.doesNotMatch(shown.textContent ?? "", /No other agents|Nobody has traded/);
            if (section === "agents") {
              const heading = [...shown.querySelectorAll(".desktop-market-heading")].find(h => h.querySelector("h2")?.textContent === "Discover agents");
              assert.equal(heading?.querySelector("span")?.textContent, "—", "unread is not zero agents");
            }
          }
        } finally { dom.window.close(); }
      }
    });

    it(`${section} retries through the shell callback and replaces the error when rows arrive`, async () => {
      const ui = testDom();
      let retries = 0;
      try {
        await ui.render(directory(liveOf(withRead(seedSources(), "board", failed, true)), section, () => { retries++; }));
        const button = [...panel(ui.container, section).querySelectorAll("button")].find(b => b.textContent === "Try again")!;
        await React.act(async () => { button.click(); });
        assert.equal(retries, 1);
        await ui.render(directory(liveOf(withRead(seedSources(), "board", success, true)), section));
        const shown = panel(ui.container, section);
        assert.match(shown.textContent ?? "", /Shogun/);
        assert.equal(shown.querySelector(".desktop-agent-read-state"), null);
      } finally { await ui.close(); }
    });

    it(`${section} retains already loaded agents when a later SQL read fails`, () => {
      const good = withRead(seedSources(), "board", success, true);
      const after = withRead(good, "board", failed, true);
      assert.equal(after, good, "the existing source merger preserves the last good board");
      const dom = new JSDOM(renderToStaticMarkup(directory(liveOf(after), section)));
      try {
        const shown = panel(dom.window.document, section);
        assert.match(shown.textContent ?? "", /Shogun/);
        assert.doesNotMatch(shown.textContent ?? "", /No other agents|Nobody has traded/);
      } finally { dom.window.close(); }
    });
  }
});
