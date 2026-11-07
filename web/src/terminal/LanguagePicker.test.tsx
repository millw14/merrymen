/**
 * THE MENU THAT ESCAPED ITS CARD.
 *
 * Regression test for the PC bug where the language list never appeared: it
 * rendered inside the tour card, positioned absolute, and the card's
 * `overflow-y: auto` clipped it to nothing. The list now portals into
 * `document.body`, pinned to the viewport — so this mounts the picker inside
 * a clipped scroll box and asserts the opened list is NOT in that box, IS
 * clickable, and choosing a language moves the document.
 *
 * React 19: `act` comes from `react`, and the async form flushes the portal.
 * jsdom measures nothing, so the trigger rect is stubbed to a desktop-like
 * header position (near the viewport top — the upward-opening case).
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, default as React } from "react";
import { createRoot, type Root } from "react-dom/client";

import { LanguagePicker } from "./LanguagePicker";

let dom: JSDOM;
let root: Root | null = null;
let container: HTMLDivElement;

const triggerRect = {
  x: 400, y: 120, width: 90, height: 28,
  top: 120, right: 490, bottom: 148, left: 400,
  toJSON: () => ({}),
} as unknown as DOMRect;

function click(el: Element): void {
  el.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
}

beforeEach(() => {
  dom = new JSDOM("", { url: "https://app.example.test" });
  const g = globalThis as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  g.HTMLElement = dom.window.HTMLElement;
  g.MouseEvent = dom.window.MouseEvent;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  // tsx compiles JSX to React.createElement (classic runtime), while the app
  // builds with the automatic runtime — so the component's file has no React
  // import. Hand it the global instead of touching the source.
  g.React = React;
  Object.defineProperty(g, "localStorage", { configurable: true, value: dom.window.localStorage });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("lang-trigger")) return triggerRect;
    return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) } as unknown as DOMRect;
  };
  Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 900 });
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 1440 });
  container = dom.window.document.createElement("div");
  // The bug's container: a scroll box like the tour card.
  container.setAttribute("style", "overflow-y: auto; height: 300px;");
  dom.window.document.body.appendChild(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  const g = globalThis as Record<string, unknown>;
  for (const k of ["window", "document", "navigator", "HTMLElement", "MouseEvent", "IS_REACT_ACT_ENVIRONMENT", "localStorage"]) {
    Reflect.deleteProperty(g, k);
  }
  dom.window.close();
});

async function renderPicker(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(LanguagePicker));
  });
}

describe("the language menu escapes its scroll box", () => {
  it("opens into document.body, not inside the clipped card", async () => {
    await renderPicker();
    const trigger = container.querySelector(".lang-trigger");
    assert.ok(trigger, "the trigger renders");
    await act(async () => { click(trigger); });
    const menu = dom.window.document.querySelector(".lang-menu-floating") as HTMLElement | null;
    assert.ok(menu, "the list opens");
    assert.equal(container.querySelector(".lang-menu-floating"), null, "the list is NOT inside the scroll box");
    // The trigger sits high with 752px free below it, so the list opens
    // downward into the room — pinned 8px under the trigger's bottom edge.
    assert.equal(menu.style.top, "156px", "it opens into the roomier side");
  });

  it("choosing a language moves the document language", async () => {
    await renderPicker();
    await act(async () => { click(container.querySelector(".lang-trigger")!); });
    const menu = dom.window.document.querySelector(".lang-menu-floating")!;
    const spanish = Array.from(menu.querySelectorAll("button")).find((b) => b.getAttribute("lang") === "es");
    assert.ok(spanish, "Español is offered in its own name");
    await act(async () => { click(spanish); });
    assert.equal(dom.window.document.documentElement.lang, "es");
    assert.equal(dom.window.document.querySelector(".lang-menu-floating"), null, "the list closes after choosing");
  });

  it("Escape closes the list without choosing", async () => {
    await renderPicker();
    await act(async () => { click(container.querySelector(".lang-trigger")!); });
    assert.ok(dom.window.document.querySelector(".lang-menu-floating"), "the list opens");
    await act(async () => {
      dom.window.document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    assert.equal(dom.window.document.querySelector(".lang-menu-floating"), null, "Escape closes the list");
  });
});
