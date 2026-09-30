/**
 * A FIGURE MOVES ON SCREEN WHEN IT MOVED IN THE WORLD, AND ONLY THEN.
 *
 * `Flip` was built and never mounted. It replays its animation whenever its
 * text changes — which includes the first time anything is drawn, so wrapping
 * every price in it as it stood would have flipped the whole market list on
 * every page load and every remount, as if every price had just moved. These
 * pin that it animates a CHANGE, in the direction of the change, and nothing
 * else.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

import { testDom } from "./test-dom";
import { trendOf } from "./motion";

describe("which way a figure moved", () => {
  it("up, down, or not a move at all", () => {
    assert.equal(trendOf(1, 2), "up");
    assert.equal(trendOf(2, 1), "down");
    assert.equal(trendOf(2, 2), null);
  });

  it("a figure appearing for the first time did not move — nor did one that became unknown", () => {
    assert.equal(trendOf(undefined, 5), null);
    assert.equal(trendOf(null, 5), null, "unread, then read, is a first reading");
    assert.equal(trendOf(5, null), null);
    assert.equal(trendOf(Number.NaN, 5), null);
  });
});

describe("a moving figure on screen", () => {
  it("draws still on first render, then flips the way the value went", async () => {
    const t = testDom();
    const { MovingFigure } = await import("./ui");
    const at = (value: number | null) => createElement(MovingFigure, { value, text: value === null ? "—" : `$${value}` });
    const cls = () => t.container.querySelector(".flip-slot > span")!.className;
    const trend = () => t.container.querySelector(".flip-slot")!.getAttribute("data-trend");
    try {
      await t.render(at(10));
      assert.equal(cls(), "flip-still", "nothing moved: this is the first time it was drawn");
      assert.equal(trend(), null);
      await t.render(at(11));
      assert.equal(cls(), "flip");
      assert.equal(trend(), "up");
      await t.render(at(9));
      assert.equal(cls(), "flip rev");
      assert.equal(trend(), "down");
      await t.render(at(null));
      assert.equal(cls(), "flip-still", "a price that became unknown did not fall");
      assert.equal(t.container.textContent, "—");
    } finally {
      await t.close();
    }
  });

  it("A MOVE THE DIGITS DO NOT SHOW IS NOT PLAYED — neither a flip nor a tint", async () => {
    // The quote mid moves in the fourth decimal; the price prints two. Driven
    // by the raw value, the same keyed span switched class and data-trend, the
    // stylesheet started the slide and the colour, and the screen showed a
    // move over digits that had not changed.
    const t = testDom();
    const { MovingFigure } = await import("./ui");
    const at = (value: number, text: string) => createElement(MovingFigure, { value, text });
    const span = () => t.container.querySelector(".flip-slot > span")!;
    const trend = () => t.container.querySelector(".flip-slot")!.getAttribute("data-trend");
    try {
      await t.render(at(250.1212, "$250.12"));
      await t.render(at(250.1234, "$250.12"));
      assert.equal(span().className, "flip-still", "up in the fourth decimal, the same on screen");
      assert.equal(trend(), null);

      await t.render(at(251.004, "$251.00"));
      assert.equal(span().className, "flip", "a move the digits show still plays");
      assert.equal(trend(), "up");
      const drawn = span();
      await t.render(at(250.998, "$251.00"));
      assert.equal(span(), drawn, "the same figure, not a new one");
      assert.equal(span().className, "flip", "a turn below what is printed does not play a fall");
      assert.equal(trend(), "up");

      await t.render(at(250.5, "$250.50"));
      assert.equal(span().className, "flip rev", "and the fall the digits do show is a fall");
      assert.equal(trend(), "down");
    } finally {
      await t.close();
    }
  });

  it("a first reading that prints what was already shown still counts as a reading", async () => {
    // The Token strip prints the chart's last close while the live price is
    // unread, so the first live reading can land on the same text. It is a
    // reading all the same: the next move that reaches the digits flips.
    const t = testDom();
    const { MovingFigure } = await import("./ui");
    const at = (value: number | null, text: string) => createElement(MovingFigure, { value, text });
    const cls = () => t.container.querySelector(".flip-slot > span")!.className;
    try {
      await t.render(at(null, "$5.00"));
      await t.render(at(5.001, "$5.00"));
      assert.equal(cls(), "flip-still");
      await t.render(at(5.1, "$5.10"));
      assert.equal(cls(), "flip");
    } finally {
      await t.close();
    }
  });

  it("the balance flips only when the balance changes", async () => {
    const t = testDom();
    const { BalanceFigure } = await import("./studio");
    const cls = () => t.container.querySelector(".flip-slot > span")?.className;
    try {
      await t.render(createElement(BalanceFigure, { value: 100 }));
      assert.equal(cls(), "flip-still");
      await t.render(createElement(BalanceFigure, { value: 100 }));
      assert.equal(cls(), "flip-still");
      await t.render(createElement(BalanceFigure, { value: 120.5 }));
      assert.equal(cls(), "flip");
      assert.match(t.container.textContent ?? "", /120\.50/);
      assert.ok(t.container.querySelector(".figure-decimals"), "the decimals keep their own face");
    } finally {
      await t.close();
    }
  });
});
