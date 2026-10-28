import assert from "node:assert/strict";
import { afterEach, before, beforeEach, it } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { autonomyOf } from "@merrymen/core";
import type { LiveMine, Thesis } from "./live";
import { idleChat } from "./test-chat";
import { goTo } from "./navigate";

let testDom: typeof import("./test-dom").testDom;
let Agent: typeof import("./screens/Agent").Agent;
let ui: ReturnType<typeof testDom>;
let modalOpens: number;
let requests: string[];
const realFetch = globalThis.fetch;
const globals = globalThis as { ResizeObserver?: unknown; self?: unknown };
const realObserver = globals.ResizeObserver;
const realSelf = globals.self;

before(async () => {
  // Discover browser input support before importing React DOM, just as the
  // search-dialog tests do; jsdom does not implement the legacy IE fallback.
  const boot = new JSDOM("<!doctype html><p></p>", { pretendToBeVisual: true });
  const previous = ["window", "document"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: boot.window });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: boot.window.document });
  try {
    ({ testDom } = await import("./test-dom"));
    ({ Agent } = await import("./screens/Agent"));
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    boot.window.close();
  }
});

beforeEach(() => {
  ui = testDom();
  modalOpens = 0;
  requests = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  globals.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  globals.self = ui.dom.window;
  localStorage.setItem("merrymen:trencher-fast:v2:dismissed", "yes");
  // Assert use of the native modal API, without pretending jsdom proves the
  // browser's top layer or inertness. Focus restoration is deliberately left
  // to Agent; close emits its event synchronously to exercise cleanup races.
  const proto = ui.dom.window.HTMLDialogElement.prototype;
  proto.showModal = function (this: HTMLDialogElement) {
    modalOpens++;
    this.setAttribute("open", "");
    this.querySelector<HTMLElement>('[aria-label="Close portfolio"]')?.focus();
  };
  proto.close = function (this: HTMLDialogElement) {
    if (!this.open) return;
    this.removeAttribute("open");
    this.dispatchEvent(new ui.dom.window.Event("close"));
  };
});

afterEach(async () => {
  await ui.close();
  globalThis.fetch = realFetch;
  globals.ResizeObserver = realObserver;
  globals.self = realSelf;
});

const noop = () => {};
const move = (over: Partial<Thesis>): Thesis => ({
  name: "Shogun", slug: "shogun", handle: null, action: "sell", symbol: "CASHCAT", sizeUsdg: 6.25,
  reason: "take profit", paper: false, head: "swap", at: Math.floor(Date.now() / 1000) - 60,
  outcome: "landed", outcomeText: null, ...over,
});
const mine = (): LiveMine => ({
  name: "Shogun", slug: "shogun", handle: null, owner: "you", equity: 100, chg24: null,
  mode: "trencher", thesis: null, glance: { id: "trencher", label: "", cashUsd: 50 }, positions: [],
  autonomy: autonomyOf({ mode: null, liveBlocker: null }),
  moves: [
    move({ tradeId: 731, fillCashUsdg: 6.25, realizedPnlUsdg: 1.25, realizedVouched: true }),
    move({ tradeId: 732, fillCashUsdg: 6.25, realizedPnlUsdg: 1.25, realizedVouched: false }),
    move({ tradeId: 733, fillCashUsdg: 6.25, realizedPnlUsdg: 1.25, realizedVouched: true, paper: true }),
  ],
});
const screen = (over: Partial<React.ComponentProps<typeof Agent>> = {}) => React.createElement(Agent, {
  mine: mine(), tokens: [], perTrade: 10, perDay: 50, stopped: false, chat: idleChat,
  onToken: noop, onDeposit: noop, onWithdraw: noop, onLimits: noop, onResign: noop, onSettings: noop,
  followTradeLinks: true, routePath: window.location.pathname, ...over,
});
const modal = () => ui.container.querySelector<HTMLDialogElement>(".portfolio-dialog")!;
const summary = () => ui.container.querySelector<HTMLButtonElement>(".portfolio-summary")!;
const selectedView = () => modal().querySelector('[aria-pressed="true"]')?.textContent;
const close = async () => {
  await act(async () => { modal().querySelector<HTMLButtonElement>('[aria-label="Close portfolio"]')!.click(); });
};
const location = (path: string, state: unknown = null) => window.history.replaceState(state, "", path);
const opener = () => {
  const button = document.createElement("button");
  button.textContent = "Trades & P&L";
  document.body.appendChild(button);
  button.focus();
  return button;
};

async function traverse(direction: "back" | "forward") {
  await act(async () => {
    await new Promise<void>((resolve, reject) => {
      const changed = () => {
        clearTimeout(timeout);
        // Let the traversal's matching hashchange finish in the same act.
        setTimeout(resolve, 0);
      };
      const timeout = setTimeout(() => {
        window.removeEventListener("popstate", changed);
        reject(new Error(`History ${direction} did not complete`));
      }, 2_000);
      window.addEventListener("popstate", changed, { once: true });
      window.history[direction]();
    });
  });
}

it("a direct owner Trades link opens the existing native modal with its P&L evidence gates", async () => {
  location("/agent?source=portfolio#trades");
  await ui.render(screen());
  assert.equal(modal().open, true);
  assert.equal(modalOpens, 1);
  assert.equal(selectedView(), "Trades · 3");
  assert.equal(summary().getAttribute("aria-expanded"), "true");
  assert.equal(window.location.search, "?source=portfolio");
  const actions = modal().querySelectorAll(".swap-pnl-image");
  assert.equal(actions.length, 1, "paper and unvouched sells still cannot offer an owner P&L card");
  assert.equal(actions[0]?.getAttribute("aria-label"), "P&L image for CASHCAT");
  assert.equal(requests.some(path => path.startsWith("/api/pnl")), false, "opening the tape does not request an export");
  await close();
  assert.equal(document.activeElement, summary(), "a cold link returns to the visible portfolio control");
});

it("same-screen links open Trades and closing preserves query/history state without reopening on remount", async () => {
  location("/agent?from=you");
  await ui.render(screen());
  const source = opener();
  await act(async () => { goTo("/agent?from=you#trades"); });
  assert.equal(modal().open, true);
  assert.equal(selectedView(), "Trades · 3");
  const historyState = { __NA: true, tree: "retained router state" };
  location(window.location.href, historyState);
  const historyLength = window.history.length;
  await close();
  assert.equal(modal().open, false);
  assert.equal(window.location.pathname + window.location.search + window.location.hash, "/agent?from=you");
  assert.deepEqual(window.history.state, historyState);
  assert.equal(window.history.length, historyLength, "dismissal replaces this entry instead of adding a Back stop");
  assert.equal(document.activeElement, source);
  await ui.remount(screen());
  assert.equal(modal().open, false);
  assert.equal(modalOpens, 1);
});

it("Back and Forward close and reopen only the linked portfolio", async () => {
  location("/agent?from=home");
  await ui.render(screen());
  await act(async () => { goTo("/agent?from=home#trades"); });
  assert.equal(modal().open, true);
  await traverse("back");
  assert.equal(window.location.hash, "");
  assert.equal(modal().open, false);
  await traverse("forward");
  assert.equal(window.location.hash, "#trades");
  assert.equal(modal().open, true);
  assert.equal(selectedView(), "Trades · 3");
  assert.equal(modalOpens, 2);
});

it("the /chat alias follows a pathname update even when React retains the Agent instance", async () => {
  location("/chat?from=chat");
  await ui.render(screen());
  const previousModal = modal();
  await act(async () => { goTo("/agent?from=chat#trades"); });
  assert.equal(modal().open, false, "cross-path pushState has no synthetic hashchange");
  await ui.render(screen());
  assert.equal(modal(), previousModal, "App passes the new routePath without requiring a remount");
  assert.equal(modal().open, true);
  assert.equal(selectedView(), "Trades · 3");
  location("/chat?from=chat#trades");
  await ui.remount(screen());
  assert.equal(modal().open, true, "a direct /chat alias link also opens the owner's tape");
});

it("manual portfolio use keeps its normal view and ignores unrelated anchors", async () => {
  location("/agent?from=chat#details");
  await ui.render(screen());
  summary().focus();
  await act(async () => { summary().click(); });
  assert.equal(modal().open, true);
  assert.equal(selectedView(), "Positions · 0");
  await act(async () => { goTo("/agent?from=chat#another-section"); });
  assert.equal(modal().open, true);
  assert.equal(selectedView(), "Positions · 0");
  await close();
  assert.equal(window.location.search + window.location.hash, "?from=chat#another-section");
  assert.equal(document.activeElement, summary());
});

it("native cancel and native close consume only the Trades hash and restore the actual opener", async () => {
  location("/agent?from=you");
  await ui.render(screen());
  const source = opener();
  await act(async () => { goTo("/agent?from=you#trades"); });
  const cancel = new ui.dom.window.Event("cancel", { cancelable: true });
  await act(async () => { modal().dispatchEvent(cancel); });
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(modal().open, false);
  assert.equal(window.location.hash, "");
  assert.equal(window.location.search, "?from=you");
  assert.equal(document.activeElement, source);
  await act(async () => { goTo("/agent?from=you#trades"); });
  await act(async () => { modal().close(); });
  assert.equal(modal().open, false);
  assert.equal(summary().getAttribute("aria-expanded"), "false");
  assert.equal(window.location.hash, "");
  assert.equal(document.activeElement, source);
});

it("a floating Agent ignores trade links by default and cannot consume the route's hash", async () => {
  location("/agent?from=you#trades");
  await ui.render(screen({ followTradeLinks: undefined }));
  assert.equal(modal().open, false);
  await act(async () => { goTo("/agent?from=you#trades"); });
  assert.equal(modal().open, false);
  summary().focus();
  await act(async () => { summary().click(); });
  assert.equal(selectedView(), "Positions · 0");
  await close();
  assert.equal(window.location.hash, "#trades");
});

it("a route remount closes the old modal without consuming the requested Trades hash", async () => {
  location("/agent?from=you#trades");
  const source = opener();
  await ui.render(screen());
  const oldModal = modal();
  await ui.render(null);
  assert.equal(oldModal.open, false);
  assert.equal(window.location.hash, "#trades", "unmount is not an owner dismissal");
  assert.equal(document.activeElement, source);
  await ui.render(screen());
  assert.equal(modal().open, true);
  assert.equal(modalOpens, 2);
  assert.equal(selectedView(), "Trades · 3");
});
