import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { JSDOM } from "jsdom";

let dom: JSDOM;

before(() => {
  dom = new JSDOM("<!doctype html><html><body><div id=root></div><button id=outside>behind</button></body></html>", {
    url: "https://app.merrymen.dev/",
    pretendToBeVisual: true,
  });
  const g = globalThis as Record<string, unknown>;
  for (const k of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "KeyboardEvent", "FocusEvent", "localStorage", "getComputedStyle"]) {
    g[k] = (dom.window as unknown as Record<string, unknown>)[k];
  }
  g.IS_REACT_ACT_ENVIRONMENT = true;
});

after(() => dom?.window?.close?.());

/**
 * Keyboard-only verification for the focus trap (the evidence Kaka asked
 * for): a test dialog with two buttons and a link, driven entirely by
 * synthetic Tab/Shift+Tab/Escape key events and focus assertions.
 */
describe("useFocusTrap — keyboard users cannot reach behind the modal", () => {
  async function setup() {
    const React = (await import("react")).default;
    (globalThis as Record<string, unknown>).React = React;
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { useFocusTrap } = await import("./use-focus-trap");
    const { useRef, useState } = React as typeof import("react");
    let dismissed = false;
    function Dialog() {
      const rootRef = useRef<HTMLDivElement | null>(null);
      const [open] = useState(true);
      useFocusTrap(rootRef as never, open, () => {
        dismissed = true;
      });
      return (
        <div ref={rootRef} tabIndex={-1} role="dialog" aria-modal="true">
          <button id="b1">one</button>
          <a id="l1" href="/x">link</a>
          <button id="b2">two</button>
        </div>
      );
    }
    const doc = dom.window.document;
    const container = doc.getElementById("root")!;
    const root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(<Dialog />);
    });
    const press = (keyName: string, shift = false) => {
      dom.window.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: keyName, shiftKey: shift, bubbles: true, cancelable: true }),
      );
    };
    const cleanup = () => root.unmount();
    return { act, doc, press, cleanup, wasDismissed: () => dismissed };
  }

  it("moves focus into the dialog on open", async () => {
    const t = await setup();
    try {
      const dialog = t.doc.querySelector('[role="dialog"]') as HTMLElement;
      assert.ok(dialog.contains(t.doc.activeElement), "focus starts inside the dialog");
    } finally {
      t.cleanup();
    }
  });

  it("cycles Tab forward and backward across buttons AND links", async () => {
    const t = await setup();
    try {
      const ids = () => (t.doc.activeElement as HTMLElement)?.id;
      const seen = new Set<string>();
      for (let i = 0; i < 3; i++) {
        await t.act(async () => {
          t.press("Tab");
        });
        seen.add(ids());
      }
      assert.deepEqual([...seen].sort(), ["b1", "b2", "l1"], "Tab visits every control (links included)");
      await t.act(async () => {
        t.press("Tab", true);
      });
      assert.ok(["b1", "b2", "l1"].includes(ids()), "Shift+Tab stays inside the dialog");
    } finally {
      t.cleanup();
    }
  });

  it("pulls stray focus back and dismisses on Escape", async () => {
    const t = await setup();
    try {
      const dialog = t.doc.querySelector('[role="dialog"]') as HTMLElement;
      const outside = t.doc.getElementById("outside") as HTMLElement;
      await t.act(async () => {
        outside.focus();
        t.doc.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
      });
      assert.ok(dialog.contains(t.doc.activeElement), "stray focus is pulled back inside");
      await t.act(async () => {
        t.press("Escape");
      });
      assert.equal(t.wasDismissed(), true, "Escape dismisses");
    } finally {
      t.cleanup();
    }
  });
});
