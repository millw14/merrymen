import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act, createElement } from "react";
import { PerpsChart } from "./PerpsChart";
import type { ChartResponse } from "../lib/perps-chart-data";
import { testDom } from "./test-dom";

const now = 1_790_697_060_000;
const data: ChartResponse = {
  state: "ok", market: "BTC-PERP", book: "paper", window: "24h", generatedAtMs: now,
  unknownFills: 0, truncated: false,
  candles: { state: "ok", bars: [{ timeMs: now - 300_000, open: 99, high: 101, low: 98, close: 100 }], gaps: [], stale: false, asOfMs: now },
  entries: [
    { id: "middle", timeMs: now - 43_200_000, price: 100, priceExact: "100.00", size: "1", side: "long", book: "paper", epoch: 1, attribution: "agent", kind: "open" },
    { id: "latest", timeMs: now, price: 100, priceExact: "100.00", size: "1", side: "long", book: "paper", epoch: 1, attribution: "agent", kind: "open" },
  ],
};

describe("scrollable private chart", () => {
  it("keeps markers keyboard accessible and pans to their actual time while honoring reduced motion", async () => {
    const dom = testDom();
    const scrolls: ScrollToOptions[] = [];
    let picked = "";
    let reduced = false;
    Object.defineProperty(dom.dom.window, "matchMedia", { configurable: true, value: () => ({ matches: reduced }) });
    try {
      await dom.render(createElement(PerpsChart, { data, onSelect: (id) => { picked = id; } }));
      const viewport = dom.container.querySelector<HTMLDivElement>(".perps-chart-viewport")!;
      const svg = viewport.querySelector("svg")!;
      Object.defineProperties(viewport, { clientWidth: { value: 320 }, scrollWidth: { value: 760 }, scrollTo: { value: (options: ScrollToOptions) => scrolls.push(options) } });
      svg.getBoundingClientRect = () => ({ width: 760 } as DOMRect);
      assert.equal(viewport.getAttribute("tabindex"), "0");
      const marker = viewport.querySelector<SVGGElement>('[role="button"]')!;
      assert.match(marker.getAttribute("aria-label") ?? "", /Paper long open.*100\.00/);
      await act(async () => { marker.dispatchEvent(new dom.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
      assert.equal(picked, "middle");
      await dom.render(createElement(PerpsChart, { data, selectedId: picked }));
      assert.equal(marker.getAttribute("aria-pressed"), "true");
      assert.ok(Math.abs(scrolls[0]!.left! - 249.23) < 0.1, "the midpoint execution is centered using the rendered SVG scale");
      assert.equal(scrolls[0]?.behavior, "smooth");
      reduced = true;
      await dom.render(createElement(PerpsChart, { data, selectedId: "latest" }));
      assert.deepEqual(scrolls[1], { left: 440, behavior: "auto" }, "the latest execution clamps to the real viewport edge without animation");
      await dom.render(createElement(PerpsChart, { data, selectedId: "missing" }));
      assert.equal(scrolls.length, 2, "an unknown execution never creates a scroll target");
      assert.equal(dom.container.querySelector(".perps-chart-caption")?.parentElement?.className, "perps-chart");
    } finally { await dom.close(); }
  });
});
