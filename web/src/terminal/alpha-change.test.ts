/**
 * THE ALPHA DESK PRINTS A DAY'S CHANGE ONLY FOR A POOL A DAY OLD (TW-7).
 *
 * The desk printed the index's `change24hPct` raw, so "SI / WETH 0.01%" at six
 * hours old read +18,062.8% — its move since launch under a day's name — while
 * Markets wrote "new pool" for the same coin. The rows below are the captured
 * sweep's figures, served as /api/alpha serves them, and read off the real
 * screen.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { act, createElement } from "react";
import type { DiscoveryRow } from "@/lib/read-discoveries";
import { alphaChange, alphaVolumeLabel } from "./alpha-change";
import { Alpha } from "./screens/Alpha";
import { json, testDom } from "./test-dom";

const row = (name: string, change24hPct: number | null, ageDays: number | null, token: string) =>
  ({
    token,
    name,
    venue: "uniswap-v3",
    priceUsd: 0.0012,
    reserveUsd: 40_000,
    fdvUsd: 1_200_000,
    volume24hUsd: 250_000,
    change24hPct,
    buyers24h: 40,
    ageDays,
    graduated: false,
    onCurve: false,
    verdict: null,
    research: null,
  }) as unknown as DiscoveryRow & { research: null };

const WIRE = {
  locked: false,
  tier: null,
  fetchedAt: 1_790_000_000,
  picks: [
    row("SI / WETH 0.01%", 18_062.8, 0.25, "0x" + "1".repeat(40)),
    row("FOOMS / WETH", 1_647.6, 0.18, "0x" + "2".repeat(40)),
    row("QUANTA / WETH", 3_824.3, 1.15, "0x" + "3".repeat(40)),
    row("NOAGE / WETH", 12, null, "0x" + "4".repeat(40)),
  ],
  passed: [row("SLIDE / WETH", -2.5, 3, "0x" + "5".repeat(40))],
  verdictsWhy: null,
  researched: true,
  truncated: false,
  degraded: false,
  indexUnreachable: false,
};

let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  ui = testDom();
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input) === "/api/alpha" ? json(WIRE) : json({ error: "not scripted" }, 404)) as typeof fetch;
});
afterEach(async () => {
  await ui.close();
  globalThis.fetch = originalFetch;
});

/** Each row on the desk as a reader sees it: the change beside the name, its colour, and the volume's label. */
async function desk() {
  await ui.render(createElement(Alpha, { onToken: () => {} }));
  for (let i = 0; i < 20 && !ui.container.querySelector(".alpha-row"); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1));
    });
  }
  const rows = new Map<string, { change: string; tone: string; volume: string }>();
  for (const li of Array.from(ui.container.querySelectorAll(".alpha-row"))) {
    const chg = li.querySelector(".alpha-chg")!;
    const volume = Array.from(li.querySelectorAll(".alpha-figs i")).map((i) => i.textContent ?? "").find((t) => t.startsWith("24h"));
    rows.set(li.querySelector(".alpha-name b")!.textContent ?? "", {
      change: chg.textContent ?? "",
      tone: chg.classList.contains("up") ? "up" : chg.classList.contains("down") ? "down" : "none",
      volume: volume ?? "",
    });
  }
  return rows;
}

describe("the Alpha desk's 24h change", () => {
  it("AN HOURS-OLD POOL SAYS 'new pool', NOT ITS CHANGE SINCE LAUNCH", async () => {
    const rows = await desk();
    assert.deepEqual(rows.get("SI / WETH 0.01%"), { change: "new pool", tone: "none", volume: "24h · pool 6h old" });
    assert.deepEqual(rows.get("FOOMS / WETH"), { change: "new pool", tone: "none", volume: "24h · pool 4h old" });
    assert.doesNotMatch(ui.container.textContent ?? "", /18062|1647/, "the since-launch figures are nowhere on the desk");
  });

  it("a pool at least a day old shows its day, coloured by its direction", async () => {
    const rows = await desk();
    assert.deepEqual(rows.get("QUANTA / WETH"), { change: "+3824.3%", tone: "up", volume: "24h" });
    assert.deepEqual(rows.get("SLIDE / WETH"), { change: "-2.5%", tone: "down", volume: "24h" });
  });

  it("an unknown age is not assumed old enough — and not called new either", async () => {
    const rows = await desk();
    assert.deepEqual(rows.get("NOAGE / WETH"), { change: "—", tone: "none", volume: "24h" });
  });
});

describe("the rule itself, at its edges", () => {
  it("draws the line at exactly one day", () => {
    assert.equal(alphaChange(5, 0.999).text, "new pool");
    assert.deepEqual(alphaChange(5, 1), { text: "+5.0%", up: true });
  });

  it("gives no figure and no colour for a change the index did not give", () => {
    assert.deepEqual(alphaChange(null, 4), { text: "—", up: null });
    assert.deepEqual(alphaChange(Number.NaN, 4), { text: "—", up: null });
    assert.deepEqual(alphaChange(18_062.8, Number.NaN), { text: "—", up: null });
  });

  it("never rounds a pool under a day up to '24h old'", () => {
    assert.equal(alphaVolumeLabel(23.9 / 24), "24h · pool 23h old");
    assert.equal(alphaVolumeLabel(30 / 86_400), "24h · pool 30s old");
    assert.equal(alphaVolumeLabel(0.02), "24h · pool 28m old");
  });
});
