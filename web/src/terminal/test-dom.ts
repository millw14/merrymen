import { JSDOM } from "jsdom";
import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

/** Fresh DOM per test, with no network or browser profile. */
export function testDom() {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://app.example.test", pretendToBeVisual: true });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const values: Record<string, unknown> = { React, IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "localStorage", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
    values[name] = (dom.window as unknown as Record<string, unknown>)[name];
  }
  for (const [name, value] of Object.entries(values)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const container = dom.window.document.getElementById("root")!;
  let root: Root = createRoot(container);
  return {
    dom, container,
    render: async (node: ReactNode) => { await act(async () => { root.render(node); }); },
    click: async (text: string) => {
      const button = Array.from(container.querySelectorAll("button")).find(b => b.textContent?.trim() === text);
      if (!button) throw new Error(`Missing button: ${text}`);
      await act(async () => { button.click(); });
    },
    remount: async (node: ReactNode) => {
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () => root.render(node));
    },
    close: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
