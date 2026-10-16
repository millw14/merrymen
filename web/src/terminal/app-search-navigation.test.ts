import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, before, beforeEach, it, mock } from "node:test";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { JSDOM } from "jsdom";
import type { Screen } from "./live";
import { idleChat } from "./test-chat";
import { goTo } from "./navigate";

const noop = () => {};
let testDom: typeof import("./test-dom").testDom;
let App: typeof import("./App").App;
let ui: ReturnType<typeof testDom>;

before(async () => {
  const boot = new JSDOM("<!doctype html><p></p>", { pretendToBeVisual: true });
  const previous = ["window", "document"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: boot.window });
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: boot.window.document });
  try {
    ({ testDom } = await import("./test-dom"));
    const appPath = fileURLToPath(new URL("./App.tsx", import.meta.url));
    const loader = Module as unknown as { _load: (id: string, parent: { filename?: string }, isMain: boolean) => unknown };
    const load = loader._load;
    const inert = new Proxy({ __esModule: true }, { get: (_target, name) => name === "__esModule" ? true : noop });
    // Mount App's real navigation state and the real SearchDialog. Market,
    // wallet and polling boundaries are unrelated and must do no network I/O.
    const keep = new Set(["react", "@merrymen/core", "./agent-status", "./account-read", "./account-session", "./recovery-view", "./worker-stale", "./chat-store", "./chat-payload", "./chat-thread", "./nav", "./live", "./navigate", "./SearchDialog"]);
    const intercepted = mock.method(loader, "_load", function (this: typeof loader, id: string, parent: { filename?: string }, isMain: boolean) {
      if (parent?.filename !== appPath || keep.has(id)) return load.call(this, id, parent, isMain);
      if (id === "next/navigation") return { usePathname: () => window.location.pathname };
      if (id === "./live-clocks") return { useShellClocks: () => ({ shell: { banner: null, accountBusy: false }, refreshAccount: noop, refreshReads: noop, invalidate: noop }) };
      if (id === "./chat-controller") return { useChatController: () => idleChat };
      if (id === "./live-news") return { useSoundPref: () => [false, noop], useLiveNews: noop };
      if (id === "./desktop-detail") return { useDesktopDetail: () => ({ kind: "tab", tab: "home" }) };
      if (id === "./ticker") return { ticksOf: () => [] };
      if (id === "./screens/Settings" || id === "./screens/Wallet") return noop;
      if (id === "@/components/WiredProvider") return { WiredProvider: ({ children }: { children: React.ReactNode }) => children };
      if (id === "./Desktop") return {
        DesktopSidebar: noop, DesktopPortfolio: noop,
        DesktopHeader: ({ onScreen }: { onScreen: (next: Screen) => void }) => React.createElement("button", {
          type: "button", onClick: () => onScreen({ kind: "search" }),
        }, "Open search"),
      };
      return inert;
    });
    try { App = createRequire(import.meta.url)(appPath).App; }
    finally { intercepted.mock.restore(); }
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
  ui.dom.window.scrollTo = noop;
  ui.dom.window.matchMedia = () => ({ matches: true, addEventListener: noop, removeEventListener: noop }) as unknown as MediaQueryList;
  window.history.replaceState(null, "", "/home");
  const proto = ui.dom.window.HTMLDialogElement.prototype;
  // jsdom has no native top layer. Verify its API and teardown without claiming
  // this fixture proves the browser's modal inertness or rendering.
  proto.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  proto.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
});
afterEach(async () => { await ui.close(); });

const modal = () => ui.container.querySelector<HTMLDialogElement>(".search-dialog-backdrop");
async function openSearch() {
  await ui.render(React.createElement(App));
  const opener = [...ui.container.querySelectorAll("button")].find(button => button.textContent === "Open search")!;
  opener.focus();
  await ui.click("Open search");
  assert.equal(modal()?.open, true);
  assert.equal(document.body.style.overflow, "hidden");
  return opener;
}
async function traverse(direction: "back" | "forward") {
  await act(async () => {
    await new Promise<void>((resolve, reject) => {
      const changed = () => { clearTimeout(timer); setTimeout(resolve, 0); };
      const timer = setTimeout(() => {
        window.removeEventListener("popstate", changed);
        reject(new Error(`No history ${direction} event`));
      }, 2_000);
      window.addEventListener("popstate", changed, { once: true });
      window.history[direction]();
    });
  });
}

it("Back dismisses the real Search overlay and restores page scrolling and focus", async () => {
  window.history.pushState(null, "", "/settings");
  const opener = await openSearch();
  await traverse("back");
  assert.equal(window.location.pathname, "/home");
  assert.equal(modal(), null);
  assert.equal(document.body.style.overflow, "");
  assert.equal(document.activeElement, opener);
  await traverse("forward");
  assert.equal(window.location.pathname, "/settings");
  assert.equal(modal(), null, "history does not resurrect the dismissed overlay");
});

it("same-path query history also dismisses Search", async () => {
  window.history.replaceState(null, "", "/home?view=first");
  window.history.pushState(null, "", "/home?view=second");
  await openSearch();
  await traverse("back");
  assert.equal(window.location.search, "?view=first");
  assert.equal(modal(), null, "pathname-only observation would miss this traversal");
  assert.equal(document.body.style.overflow, "");
});

it("a Next pathname update dismisses Search without requiring a popstate event", async () => {
  await openSearch();
  goTo("/settings");
  // Next's patched pushState supplies a new usePathname value; this boundary
  // mock reads the browser URL on the corresponding App render.
  await ui.render(React.createElement(App));
  assert.equal(modal(), null);
  assert.equal(document.body.style.overflow, "");
});

it("ordinary renders keep Search open but an explicit same-page anchor dismisses it", async () => {
  await openSearch();
  await ui.render(React.createElement(App));
  assert.equal(modal()?.open, true, "live data updates are not navigation");
  await act(async () => { goTo("/home#details"); });
  assert.equal(window.location.hash, "#details");
  assert.equal(modal(), null);
  assert.equal(document.body.style.overflow, "");
});
