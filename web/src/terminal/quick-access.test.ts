/**
 * QUICK ACCESS: the shortcuts on Home, Me and the desktop portfolio.
 *
 * They are links to screens that already exist, never a second copy of a control: the stop, the withdrawal and the
 * limits each keep their own screen and their own confirmation. So these tests render the real components and pin
 * where each shortcut leads, that a visitor with no agent is offered none, and that a copy button copies the whole
 * address behind a shortened label.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { autonomyOf } from "@merrymen/core";
import type { LiveMine } from "./live";
import { shortAddress } from "./CopyButton";

(globalThis as unknown as { React: typeof React }).React = React;
const noop = () => {};
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const owner = (who = "you"): LiveMine => ({
  name: "Shogun", slug: "0123456789abcdef", handle: null, owner: who,
  equity: 100, chg24: null, mode: "trencher", thesis: null, moves: [],
  glance: { id: "custom", label: "", cashUsd: 83 }, positions: [], history: [80, 100],
  autonomy: autonomyOf({ mode: null, liveBlocker: null }),
});
const doc = (node: React.ReactElement) => new JSDOM(renderToStaticMarkup(node)).window.document;
const hrefs = (root: ParentNode, selector: string) => [...root.querySelectorAll(selector)].map((item) => `${item.textContent?.trim()} → ${item.getAttribute("href")}`);

async function home(mine: LiveMine | null) {
  const { Home } = await import("./screens/Home");
  return doc(React.createElement(Home, { mine, agents: [], theses: [], read: "ok", hasAgent: mine !== null, onAgent: noop, onDeposit: noop, onDesk: noop }));
}
async function me(mine: LiveMine | null) {
  const { You } = await import("./screens/You");
  return doc(React.createElement(You, { mine, history: mine?.history ?? [], stopped: false, perTrade: 10, perDay: 50,
    onLimits: noop, onStop: noop, onDesk: noop, onDeposit: noop, onWithdraw: noop }));
}

describe("quick access", () => {
  it("Home gives an owner one press to money out, limits, wallet, settings and the stop", async () => {
    const page = await home(owner());
    const nav = page.querySelector('nav.home-quick[aria-label="Shortcuts"]')!;
    assert.ok(nav, "the shortcuts row");
    assert.deepEqual(hrefs(nav, "a"), ["Withdraw → /withdraw", "Limits → /limits", "Wallet → /grant", "Settings → /settings", "Stop → /grant#permission-security"]);
    // Shortcuts only: every child is a link, and nothing in the row could act by itself.
    assert.equal(nav.children.length, 5); assert.equal(nav.querySelectorAll("button, input, form").length, 0);
  });

  it("a visitor with no agent, or an owner whose numbers have not landed, is offered no shortcuts", async () => {
    assert.equal((await home(null)).querySelector(".home-quick"), null);
    const { Home } = await import("./screens/Home");
    const loading = doc(React.createElement(Home, { mine: null, agents: [], theses: [], read: "ok", hasAgent: true, onAgent: noop, onDeposit: noop, onDesk: noop }));
    assert.equal(loading.querySelector(".home-quick"), null);
  });

  it("Me names the stop, says what Wallet & permissions holds, and copies the whole address behind the short label", async () => {
    const page = await me(owner(ADDRESS));
    const stop = page.querySelector("a.account-control.account-stop")!;
    assert.equal(stop.getAttribute("href"), "/grant#permission-security");
    assert.equal(stop.querySelector("strong")!.textContent, "Stop my merryman");
    const wallet = [...page.querySelectorAll(".account-control")].find((item) => item.querySelector("strong")?.textContent === "Wallet & permissions")!;
    assert.equal(wallet.querySelector("small")!.textContent, "Renew, stop or revoke his permission");
    // The heading is shortened for reading; the button beside it is what carries the address.
    assert.equal(page.querySelector(".account-person h2")!.textContent, "0x1234…5678");
    assert.equal(page.querySelector(".account-person .account-copy")!.textContent, "Copy address");
    // An owner shown by name has no address to copy.
    assert.equal((await me(owner("you"))).querySelector(".account-copy"), null);
  });

  it("the desktop portfolio keeps the wallet and the stop under the limits, as links", async () => {
    const { DesktopPortfolio } = await import("./Desktop");
    const page = doc(React.createElement(DesktopPortfolio, { mine: owner(), tokens: [], stopped: false, perTrade: 10, perDay: 50, onScreen: noop, onTab: noop }));
    assert.deepEqual(hrefs(page, ".desktop-quick-links a"), ["Wallet & permissions → /grant", "Stop Shogun → /grant#permission-security"]);
  });

  it("a shortened address keeps both ends and never stands in for a short one", () => {
    assert.equal(shortAddress(ADDRESS), "0x12…5678");
    assert.equal(shortAddress(ADDRESS, 6, 4), "0x1234…5678");
    assert.equal(shortAddress("So11111111111111111111111111111111111111112"), "So11…1112");
    assert.equal(shortAddress("short"), "short");
  });

  it("the stylesheet is scoped to the terminal and keeps 44px phone targets", () => {
    const css = readFileSync(new URL("./quick-access.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/g)].flatMap((match) => match[2]!.split(",")).map((selector) => selector.trim()).filter(Boolean);
    assert.ok(selectors.length > 10);
    for (const selector of selectors) assert.ok(selector.startsWith(".terminal-host "), `unscoped selector: ${selector}`);
    // Five tiles in one row, each tall enough for a thumb; the small copy buttons carry a larger hit area.
    assert.match(css, /\.terminal-host \.home-quick \{[^}]*grid-template-columns:\s*repeat\(5,/);
    const tile = /\.terminal-host \.home-quick-link \{[^}]*min-height:\s*(\d+)px/.exec(css);
    assert.ok(tile && Number(tile[1]) >= 44, "a tile is at least 44px tall");
    assert.match(css, /\.terminal-host \.account-copy::after,[^{]*\{[^}]*inset:\s*-9px/);
  });
});
