/**
 * THE MARKET LISTS MOVE WITH THE MARKET READ.
 *
 * The tape, the Token page and the balances flipped when their figure moved,
 * and the three lists a reader actually watches prices on did not: the desktop
 * rail, Home's market table and Home's phone list printed `coinPrice` bare, so
 * a thirty-second market read that moved every price changed digits in place
 * with nothing to say they had moved. Rendered, re-rendered with newer prices,
 * and read back off the DOM — the same way the shell re-renders them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

import { testDom } from "./test-dom";
import type { LiveMine, LiveToken } from "./live";

const token = (symbol: string, priceUsd: number | null): LiveToken => ({
  id: `0x${symbol.toLowerCase().padEnd(40, "0")}`,
  symbol,
  name: symbol,
  logo: "",
  priceUsd,
  change24hPct: 1,
  fdvUsd: null,
  holders: null,
  agents: 0,
  buys: 0,
  kind: "stock",
  marks: [],
  cast: [],
});
const noop = () => {};
const mine = {
  name: "Robin",
  slug: null,
  handle: null,
  owner: null,
  equity: null,
  chg24: null,
  mode: null,
  thesis: null,
  moves: [],
  glance: { id: "custom", label: "", cashUsd: undefined },
  autonomy: { state: "idle", label: "Idle" },
} as unknown as LiveMine;

/** Each price cell's text and the direction its flip was drawn with. */
function prices(root: Element, cell: string): { text: string; trend: string | null }[] {
  return [...root.querySelectorAll(cell)].map((el) => {
    const slot = el.querySelector(".flip-slot");
    return { text: el.textContent ?? "", trend: slot ? slot.getAttribute("data-trend") : "(no flip)" };
  });
}

describe("the market lists' prices", () => {
  it("the desktop rail flips a price that moved, the way it moved, and not one that did not", async () => {
    const t = testDom();
    const { DesktopSidebar } = await import("./Desktop");
    const rail = (tsla: number, nvda: number) =>
      createElement(DesktopSidebar, {
        tokens: [token("TSLA", tsla), token("NVDA", nvda)],
        agents: [],
        theses: [],
        mine,
        screen: { kind: "tab", tab: "home" },
        section: "markets",
        onSection: noop,
        onScreen: noop,
        onTab: noop,
        reads: { market: "ok", board: "ok", theses: "ok", discoveries: "ok", mine: "ok" },
      } as never);
    const cells = () => prices(t.container, ".desktop-market-row > span:last-child > strong");
    try {
      await t.render(rail(350, 120));
      assert.deepEqual(cells().map((c) => c.trend), [null, null], "nothing moved on the first draw");
      await t.render(rail(351, 119));
      // Sorted by symbol: NVDA, then TSLA.
      assert.deepEqual(cells().map((c) => c.trend), ["down", "up"]);
      await t.render(rail(351, 119));
      assert.deepEqual(cells().map((c) => c.trend), ["down", "up"], "a read that moved nothing replays nothing");
    } finally {
      await t.close();
    }
  });

  it("Home's table and its phone list flip too", async () => {
    const t = testDom();
    const { Home } = await import("./screens/Home");
    const home = (tsla: number) =>
      createElement(Home, {
        tokens: [token("TSLA", tsla)],
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
      } as never);
    try {
      await t.render(home(350));
      await t.render(home(348.5));
      const table = prices(t.container, "td").filter((c) => c.text.includes("348"));
      assert.ok(table.length > 0, "the table prints the price");
      assert.equal(table[0]!.trend, "down");
      const phone = prices(t.container, ".home-mobile-market .px");
      assert.equal(phone.length, 1);
      assert.equal(phone[0]!.trend, "down");
      assert.match(phone[0]!.text, /348\.50/);
    } finally {
      await t.close();
    }
  });
});
