/**
 * THE OWNER'S POSITIONS LIST SHOWS WHAT EACH HOLDING IS WORTH, AND ITS % BESIDE IT.
 *
 * positionsOf began passing through the % that mineOf computed, and both desk
 * renderers printed `p.pnl == null ? p.detail : pctPts(p.pnl)` — so the moment a
 * position had a cost and a fresh mark, its dollar value left the list and a
 * bare "+20.00%" stood where "$12.00" had been. On the agent desk the small line
 * under the symbol prints the coin's name when the token is listed, so the value
 * was gone from that screen too. A % with no amount beside it tells an owner how
 * a position is doing and nothing about how much of their money it is.
 *
 * These render the real components, because a mapping that keeps the value
 * proves nothing if the screen still prints one figure instead of the other.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { autonomyOf } from "@merrymen/core";
import { positionFigures, positionsOf } from "./account";
import { idleChat } from "./test-chat";
import type { LiveMine, LiveToken } from "./live";

// See wire-ring.test.ts: tsx compiles `.tsx` against a global React.
(globalThis as unknown as { React: typeof React }).React = React;

const noop = () => {};

const mine = (positions: NonNullable<LiveMine["positions"]>): LiveMine => ({
  name: "Shogun",
  slug: "0123456789abcdef",
  handle: null,
  owner: "you",
  equity: 100,
  chg24: null,
  mode: "trencher",
  thesis: null,
  moves: [],
  glance: { id: "custom", label: "", cashUsd: 83 },
  autonomy: autonomyOf({ mode: null, liveBlocker: null }),
  positions,
});

const position = (over: Partial<NonNullable<LiveMine["positions"]>[number]>) => ({
  symbol: "CASHCAT",
  valueUsd: 12,
  stale: false,
  costUsd: 10,
  pnlPct: 20,
  costFromQuote: false,
  floorBps: null,
  floorWhy: null,
  ...over,
});

/** A listed token, so the agent desk's small line prints the coin's name rather than the detail. */
const cashcat: LiveToken = {
  id: "0x" + "c".repeat(40),
  symbol: "CASHCAT",
  name: "Cash Cat",
  logo: "",
  priceUsd: 0.01,
  change24hPct: null,
  fdvUsd: null,
  holders: null,
  agents: null,
  buys: null,
  kind: "memecoin",
  marks: [],
  cast: [],
};

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("a position with a known return", () => {
  it("keeps its value in the mapping, with the % as a separate figure", () => {
    const [p] = positionsOf(mine([position({})]));
    const f = positionFigures(p!);
    assert.equal(f.value, "$12.00", "the money figure survives a known %");
    assert.equal(f.pct, "+20.00%");
    assert.equal(f.tone, "up");
  });

  it("a position with no % still prints its value and says why there is none", () => {
    const [p] = positionsOf(mine([position({ costUsd: null, pnlPct: null })]));
    const f = positionFigures(p!);
    assert.match(f.value, /^\$12\.00 · cost unknown$/);
    assert.equal(f.pct, null);
    assert.equal(f.tone, "");
  });

  it("the desktop portfolio prints the value AND the %", async () => {
    const { DesktopPortfolio } = await import("./Desktop");
    const html = renderToStaticMarkup(
      createElement(DesktopPortfolio, {
        mine: mine([position({})]),
        tokens: [cashcat],
        stopped: false,
        perTrade: 10,
        perDay: 50,
        onScreen: noop,
        onTab: noop,
      } as never),
    );
    const row = text(html).split("Positions")[1] ?? "";
    assert.match(row, /CASHCAT \$12\.00/, "the value is on the row");
    assert.match(row, /\+20\.00%/, "and so is the return");
  });

  it("the agent desk prints the value AND the %, with the coin's name on the small line", async () => {
    const { Agent } = await import("./screens/Agent");
    const html = renderToStaticMarkup(
      createElement(Agent, {
        mine: mine([position({})]),
        tokens: [cashcat],
        perTrade: 10,
        perDay: 50,
        stopped: false,
        chat: idleChat,
        onToken: noop,
        onDeposit: noop,
        onWithdraw: noop,
        onLimits: noop,
        onResign: noop,
        onSettings: noop,
      } as never),
    );
    const row = text(html);
    assert.match(row, /CASHCAT Cash Cat/, "the listed coin is named");
    assert.match(row, /\$12\.00/, "the value is on the row even though the small line shows the name");
    assert.match(row, /\+20\.00%/);
  });

  it("an unlisted coin's value is printed once, not on both lines", async () => {
    const { Agent } = await import("./screens/Agent");
    const html = renderToStaticMarkup(
      createElement(Agent, {
        mine: mine([position({ symbol: "CHUMP" })]),
        tokens: [],
        perTrade: 10,
        perDay: 50,
        stopped: false,
        chat: idleChat,
        onToken: noop,
        onDeposit: noop,
        onWithdraw: noop,
        onLimits: noop,
        onResign: noop,
        onSettings: noop,
      } as never),
    );
    const positions = text(html).split("Positions")[1]?.split("Available cash")[0] ?? "";
    assert.equal(positions.match(/\$12\.00/g)?.length, 1, positions);
  });
});
