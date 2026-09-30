/**
 * THE PHONE'S WAY INTO THE GROUP CHAT, pressed.
 *
 * Home's entry to the room is a button that calls back to App, like every other
 * way off that screen — not a next/link. The link version crashed a node test
 * that renders Home (market-flip.test.ts): with no IntersectionObserver a Link
 * falls back to requestIdleCallback on `self`, which only a browser defines. So
 * this renders Home the same way and presses the button, which the source-level
 * check in nav.test.ts cannot do.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act, createElement } from "react";
import { testDom } from "./test-dom";

const noop = () => {};
const props = {
  tokens: [],
  agents: [],
  theses: [],
  mine: null,
  tokenTab: "buys",
  onTokenTab: noop,
  onToken: noop,
  onAgent: noop,
  onDeposit: noop,
  onSearch: noop,
  onDesk: noop,
  hasAgent: false,
  read: "ok",
};

describe("Home's group chat button", () => {
  it("opens the room through the callback App gives it", async () => {
    const t = testDom();
    const { Home } = await import("./screens/Home");
    let opened = 0;
    try {
      await t.render(createElement(Home, { ...props, onGroupChat: () => opened++ } as never));
      const button = t.container.querySelector<HTMLButtonElement>('button[aria-label="Group chat"]');
      assert.ok(button, "the button is there");
      await act(async () => {
        button!.click();
      });
      assert.equal(opened, 1, "and pressing it asks App to open the room, once");
    } finally {
      await t.close();
    }
  });

  it("is not drawn when there is nowhere to go", async () => {
    const t = testDom();
    const { Home } = await import("./screens/Home");
    try {
      await t.render(createElement(Home, props as never));
      assert.equal(t.container.querySelector('button[aria-label="Group chat"]'), null);
    } finally {
      await t.close();
    }
  });
});
