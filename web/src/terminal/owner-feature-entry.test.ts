/**
 * The redesigned owner screens must still lead to Telegram and trade results.
 * Render the actual components: the links can exist in source while their
 * enclosing balance section is hidden on Chat/Profile.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { autonomyOf } from "@merrymen/core";
import type { FleetRecoveryView } from "../../../worker/src/fleet-recovery";
import type { LiveMine } from "./live";

// Match the existing component-rendering fixtures in desk-positions.test.ts.
(globalThis as unknown as { React: typeof React }).React = React;
const noop = () => {};
const held: FleetRecoveryView = {
  state: "history-only", tradingPaused: true, history: "available", memory: "unknown",
  checkedAt: 1_791_111_100, lastVerifiedHeartbeatAt: 1_791_110_000,
};
const owner = (recovery: FleetRecoveryView | null = null): LiveMine => ({
  name: "Shogun", slug: "0123456789abcdef", handle: null, owner: "you",
  equity: 100, chg24: null, mode: "trencher", thesis: null, moves: [],
  glance: { id: "custom", label: "", cashUsd: 83 }, positions: [], history: [80, 100],
  autonomy: autonomyOf({ mode: null, liveBlocker: null }), recovery,
});
const doc = (node: React.ReactElement) => new JSDOM(renderToStaticMarkup(node)).window.document;

async function ownerScreen(surface: "home" | "you", mine: LiveMine | null) {
  if (surface === "home") {
    const { Home } = await import("./screens/Home");
    return doc(React.createElement(Home, {
      mine, tokens: [], agents: [], theses: [], tokenTab: "buys", read: "ok", hasAgent: mine !== null,
      onTokenTab: noop, onToken: noop, onAgent: noop, onDeposit: noop, onSearch: noop, onDesk: noop,
    }));
  }
  const { You } = await import("./screens/You");
  return doc(React.createElement(You, {
    mine, history: mine?.history ?? [], stopped: false, perTrade: 10, perDay: 50,
    onLimits: noop, onStop: noop, onDesk: noop, onDeposit: noop, onWithdraw: noop,
  }));
}

function assertTradesLink(root: ParentNode) {
  const links = root.querySelectorAll("a.owner-trades-link");
  assert.equal(links.length, 1, "one clear way into the owner's existing trade results");
  assert.equal(links[0]!.getAttribute("href"), "/agent#trades");
  assert.equal(links[0]!.querySelector("strong")?.textContent, "Trades & P&L");
  return links[0]!;
}

describe("owner feature entry points", () => {
  for (const recovery of [null, held]) {
    it(`desktop keeps Telegram outside the hidden balance section${recovery ? " during recovery" : ""}`, async () => {
      const { DesktopPortfolio } = await import("./Desktop");
      const page = doc(React.createElement(DesktopPortfolio, {
        mine: owner(recovery), tokens: [], stopped: false, perTrade: 10, perDay: 50,
        onScreen: noop, onTab: noop,
      }));
      const portfolio = page.querySelector(".desktop-portfolio")!;
      const hiddenBalance = portfolio.querySelector(":scope > section:first-child")!;
      const connections = portfolio.querySelector(":scope > section.desktop-connections");
      assert.ok(connections, "Connections is a separate, direct section of the desktop rail");
      assert.notEqual(connections, hiddenBalance, "Chat/Profile hide the first section");
      assert.equal(hiddenBalance.querySelector(".agent-strip"), null);
      assert.equal(connections.getAttribute("aria-label"), "Agent connections");
      assert.equal(connections.querySelector("h2")?.textContent, "Connections");
      assert.equal(connections.querySelectorAll(".agent-strip").length, 1, "the real AgentStrip stays mounted here");
      assert.equal(portfolio.querySelectorAll(".agent-strip").length, 1, "no duplicate connection controls");
      assert.match(connections.textContent ?? "", /Telegram/);
      assert.match(connections.textContent ?? "", /Trencher/);
      const trades = assertTradesLink(portfolio);
      assert.equal(trades.closest("section")?.className, "desktop-trades-entry");
      assert.ok(!hiddenBalance.contains(trades), "trade results remain outside the duplicate balance too");
      if (recovery) assert.match(connections.textContent ?? "", /Trading paused for recovery/);
    });
  }

  for (const surface of ["home", "you"] as const) {
    it(`${surface} offers trade results only when the owner's account is present`, async () => {
      assertTradesLink(await ownerScreen(surface, owner()));
      const visitor = await ownerScreen(surface, null);
      assert.equal(visitor.querySelector(".owner-trades-link"), null);
      assert.equal(visitor.querySelector('a[href="/agent#trades"]'), null);
    });

    for (const recovery of [null, held]) {
      it(`${surface} retains balance meaning beside the P&L entry${recovery ? " during recovery" : ""}`, async () => {
        const page = await ownerScreen(surface, owner(recovery));
        const trades = assertTradesLink(page);
        const balance = page.querySelector(surface === "home" ? ".hero" : ".account-balance")!;
        const label = balance.querySelector(surface === "home" ? ".home-balance-label" : ".account-label");
        assert.equal(label?.textContent, recovery
          ? surface === "home" ? "Last recorded portfolio" : "Last recorded portfolio balance"
          : "Portfolio balance");
        assert.ok(!balance.contains(trades), "the results link is separate from the balance figure");
        assert.doesNotMatch(balance.textContent ?? "", /P&L|profit|return/i);
        assert.equal(page.querySelector(".performance-chart .dither-caption > span")?.textContent, "Portfolio balance");
        const plot = page.querySelector(".performance-chart .dither-plot")!;
        assert.equal(plot.getAttribute("aria-valuetext"), "Latest: $100.00", "the chart still shows the balance, not a 25% return");
      });
    }
  }
});
