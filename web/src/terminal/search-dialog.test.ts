import assert from "node:assert/strict";
import { afterEach, before, beforeEach, it } from "node:test";
import { JSDOM } from "jsdom";
import React, { act, useState } from "react";
import type { LiveToken } from "./live";

let testDom: typeof import("./test-dom").testDom;
let SearchDialog: typeof import("./SearchDialog").SearchDialog;
let ui: ReturnType<typeof testDom>;
let modalOpens: number;
let modalCloses: number;
let dismissals: number;
let selected: string[];

before(async () => {
  // React DOM must discover input-event support with a document present.
  // Importing it before this boot DOM selects its legacy IE input fallback.
  const boot = new JSDOM("<!doctype html><p></p>", { pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const previous = ["window", "document"].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  globals.window = boot.window;
  globals.document = boot.window.document;
  try {
    ({ testDom } = await import("./test-dom"));
    ({ SearchDialog } = await import("./SearchDialog"));
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
  modalCloses = 0;
  dismissals = 0;
  selected = [];
  // jsdom has no modal top layer or native inertness. Assert that production
  // invokes showModal, and exercise our keyboard loop separately. This stub
  // deliberately does not pretend to prove the browser's inertness behavior.
  const proto = ui.dom.window.HTMLDialogElement.prototype;
  proto.showModal = function (this: HTMLDialogElement) {
    modalOpens++;
    this.setAttribute("open", "");
    this.querySelector<HTMLElement>("button")?.focus();
  };
  proto.close = function (this: HTMLDialogElement) {
    modalCloses++;
    this.removeAttribute("open");
  };
});

afterEach(async () => { await ui.close(); });

const token = (symbol: string): LiveToken => ({
  id: `0x${symbol.toLowerCase().padEnd(40, "0")}`,
  symbol, name: symbol, logo: "", priceUsd: 1, change24hPct: null,
  fdvUsd: null, holders: null, agents: 0, buys: 0, kind: "stock", marks: [], cast: [],
});
const tokens = [token("TSLA"), token("NVDA")];

function Harness({ rows = tokens }: { rows?: LiveToken[] }) {
  const [open, setOpen] = useState(false);
  return React.createElement(React.Fragment, null,
    React.createElement("button", { type: "button", id: "opener", onClick: () => setOpen(true) }, "Open search"),
    React.createElement("button", { type: "button", id: "background" }, "Background control"),
    open && React.createElement(SearchDialog, {
      tokens: rows, agents: [],
      onClose: () => { dismissals++; setOpen(false); },
      onToken: id => { selected.push(id); setOpen(false); },
      onProfile: slug => { selected.push(slug); setOpen(false); },
    }),
  );
}

const modal = () => ui.container.querySelector<HTMLDialogElement>("dialog");
const input = () => ui.container.querySelector<HTMLInputElement>("input.search")!;
const closeButton = () => ui.container.querySelector<HTMLButtonElement>(".search-dialog-close")!;
const results = () => [...ui.container.querySelectorAll<HTMLButtonElement>("button.tok")];

async function open(rows = tokens) {
  await ui.render(React.createElement(Harness, { rows }));
  const opener = ui.container.querySelector<HTMLButtonElement>("#opener")!;
  opener.focus();
  await act(async () => { opener.click(); });
  return opener;
}

async function key(name: string, shiftKey = false) {
  const event = new ui.dom.window.KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true });
  await act(async () => { document.activeElement!.dispatchEvent(event); });
  return event;
}

async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(ui.dom.window.HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  });
}

async function pointer(target: Element, type: "pointerdown" | "pointercancel" | "click") {
  await act(async () => {
    target.dispatchEvent(new ui.dom.window.MouseEvent(type, { bubbles: true, cancelable: true }));
  });
}

it("opens a native modal, focuses search, and returns to the real opener when closed", async () => {
  document.body.style.overflow = "scroll";
  const opener = await open();
  assert.equal(modalOpens, 1, "showModal makes the surrounding document inert in a browser");
  assert.equal(modal()?.open, true);
  assert.equal(modal()?.getAttribute("aria-label"), "Search tokens or agents");
  assert.equal(document.activeElement, input());
  assert.equal(document.body.style.overflow, "hidden");
  assert.equal(closeButton().textContent, "Close search");
  assert.equal(closeButton().hidden, false);
  await ui.click("Close search");
  assert.equal(modal(), null);
  assert.equal(dismissals, 1);
  assert.equal(modalCloses, 1);
  assert.equal(document.activeElement, opener, "the autofocus input must never be mistaken for the opener");
  assert.equal(document.body.style.overflow, "scroll");
});

it("cycles Tab and Shift-Tab only through the visible close, input, and result controls", async () => {
  await open();
  const [first, last] = results();
  assert.equal((await key("Tab")).defaultPrevented, true);
  assert.equal(document.activeElement, first);
  await key("Tab");
  assert.equal(document.activeElement, last);
  await key("Tab");
  assert.equal(document.activeElement, closeButton(), "last result wraps without reaching background controls");
  await key("Tab");
  assert.equal(document.activeElement, input());
  await key("Tab", true);
  assert.equal(document.activeElement, closeButton());
  await key("Tab", true);
  assert.equal(document.activeElement, last, "reverse Tab wraps without reaching the hidden full-page Back button");
});

it("keeps an empty search keyboard-accessible and Escape closes and restores focus", async () => {
  const opener = await open();
  await type("no-matching-token");
  assert.match(modal()?.textContent ?? "", /Nothing with that name/);
  assert.equal(results().length, 0);
  await key("ArrowDown");
  await key("ArrowUp");
  assert.equal(document.activeElement, input());
  await key("Tab");
  assert.equal(document.activeElement, closeButton());
  await key("Tab", true);
  assert.equal(document.activeElement, input());
  assert.equal((await key("Escape")).defaultPrevented, true);
  assert.equal(modal(), null);
  assert.equal(dismissals, 1);
  assert.equal(document.activeElement, opener);
});

it("handles the browser's native cancel event through the same close path", async () => {
  const opener = await open([]);
  const cancel = new ui.dom.window.Event("cancel", { cancelable: true });
  await act(async () => { modal()!.dispatchEvent(cancel); });
  assert.equal(cancel.defaultPrevented, true);
  assert.equal(modal(), null);
  assert.equal(dismissals, 1);
  assert.equal(document.activeElement, opener);
});

it("only dismisses a pointer gesture that starts and finishes on the backdrop", async () => {
  const opener = await open();
  const backdrop = modal()!;
  const panel = ui.container.querySelector(".search-dialog")!;
  await pointer(panel, "pointerdown");
  await pointer(backdrop, "click");
  assert.equal(modal(), backdrop, "dragging from the panel does not dismiss the dialog");
  await pointer(backdrop, "pointerdown");
  await pointer(panel, "click");
  assert.equal(modal(), backdrop, "releasing in the panel does not dismiss the dialog");
  await pointer(backdrop, "pointerdown");
  await pointer(backdrop, "pointercancel");
  await pointer(backdrop, "click");
  assert.equal(modal(), backdrop, "a canceled gesture cannot dismiss it later");
  await pointer(backdrop, "pointerdown");
  await pointer(backdrop, "click");
  assert.equal(modal(), null);
  assert.equal(dismissals, 1);
  assert.equal(document.activeElement, opener);
});

it("moves between real results with arrows and selects the same token identity", async () => {
  const opener = await open();
  const [first, last] = results();
  await key("ArrowDown");
  assert.equal(document.activeElement, first);
  await key("ArrowDown");
  assert.equal(document.activeElement, last);
  await key("ArrowUp");
  assert.equal(document.activeElement, first);
  await act(async () => { first!.click(); });
  assert.deepEqual(selected, [tokens[0]!.id]);
  assert.equal(modal(), null);
  assert.equal(document.activeElement, opener);
});

it("does not reopen on live-data updates and keeps closing usable after the results disappear", async () => {
  const opener = await open();
  await ui.render(React.createElement(Harness, { rows: [tokens[0]!] }));
  assert.equal(modalOpens, 1);
  assert.equal(results().length, 1);
  await ui.render(React.createElement(Harness, { rows: [] }));
  assert.equal(modalOpens, 1);
  assert.equal(results().length, 0);
  await key("Tab");
  assert.equal(document.activeElement, closeButton());
  await ui.click("Close search");
  assert.equal(document.activeElement, opener);
  assert.equal(document.body.style.overflow, "");
});
