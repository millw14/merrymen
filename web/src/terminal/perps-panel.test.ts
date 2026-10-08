/**
 * THE DESK'S PERPS PANEL: WHAT IT SAYS, AND WHAT IT MUST NEVER SAY.
 *
 * Every line is a claim about somebody's leveraged money (docs/perps.md rule
 * 11, "Surfaces"): an unread report is not "no positions", a venue the worker
 * could not read is not a current mark, an old read is not now, the practice
 * book is always labelled, and a stop nobody saw resting is not a stop. The
 * words are rendered and read; where the panel sits — beside the holdings,
 * with an "At Lighter" row beside "In vaults", and counted in the positions —
 * is pinned in the desk's source.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeskPerpRow, DeskPerps } from "./live";
import { PerpsPanel, perpsDeskCount, perpsMoneyLabel } from "./PerpsPanel";

(globalThis as unknown as { React: typeof React }).React = React;

const NOW = 1_790_697_060_000;

const ROW: DeskPerpRow = {
  market: "BTC-PERP",
  side: "long",
  paper: false,
  size: "0.00030",
  entry: "83218.6",
  mark: "83220.1",
  leverage: 2,
  marginUsd: 12.48,
  liqPrice: "41931.3",
  liqDistancePct: 49.6,
  unrealisedUsd: -0.45,
  stopTrigger: "79057.7",
  fundingUsd: -0.01,
};

function desk(over: Partial<DeskPerps> = {}): DeskPerps {
  return {
    read: "ok",
    mode: "live",
    book: "live",
    paper: false,
    active: true,
    rows: [ROW],
    venueRead: true,
    venueReadAt: NOW - 30_000,
    stale: false,
    atLighterUsd: 19.07,
    minLiqDistancePct: 49.6,
    stopsMissing: 0,
    incident: false,
    blocker: null,
    ...over,
  };
}

const html = (perps: DeskPerps) =>
  renderToStaticMarkup(createElement(PerpsPanel, { perps, nowMs: NOW }))
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

describe("the panel's words", () => {
  it("A POSITION: market, side, size, entry, mark, leverage, margin, P&L, liquidation and distance, stop, funding", () => {
    const t = html(desk());
    for (const part of ["BTC-PERP", "Long", "0.00030", "83,218.60", "mark", "2x", "margin $12.48", "−$0.45", "liq. $41,931.30 (49.6% away)", "stop $79,057.70", "funding −$0.01"]) {
      assert.ok(t.includes(part), `${part} in: ${t}`);
    }
    assert.doesNotMatch(t, /paper/i, "a live position is not called practice");
  });

  it("AN UNREADABLE REPORT says it could not be read — never 'no positions'", () => {
    const t = html(desk({ read: "unreadable", rows: [], active: true, venueRead: false }));
    assert.match(t, /couldn’t be read/);
    assert.match(t, /may have open leveraged positions/);
    assert.doesNotMatch(t, /No open positions/);
  });

  it("A VENUE THE WORKER COULD NOT READ: the last recorded rows, said to be that, with no current mark", () => {
    const t = html(desk({ venueRead: false, atLighterUsd: null, rows: [{ ...ROW, mark: null, unrealisedUsd: null, liqPrice: null, liqDistancePct: null, stopTrigger: null }] }));
    assert.match(t, /Lighter couldn’t be read just now/);
    assert.match(t, /mark —/);
    assert.match(t, /P&L not read/);
    assert.match(t, /no liquidation price read/);
    assert.match(t, /no stop seen/);
    assert.doesNotMatch(t, /No open positions/);
  });

  it("A STALE READ is dated, and a flat one says 'at the last read'", () => {
    const t = html(desk({ stale: true, venueReadAt: NOW - 40 * 60_000, rows: [] }));
    assert.match(t, /Last read 40m ago/);
    assert.match(t, /No open positions at the last read\./);
  });

  it("THE PRACTICE BOOK is labelled on the panel and on every row", () => {
    const t = html(desk({ paper: true, book: "paper", mode: "paper", rows: [{ ...ROW, paper: true }] }));
    assert.match(t, /Paper/);
    assert.match(t, /· paper/);
  });

  it("PRACTICE HELD WHILE PERPS ARE OFF is still practice: the book decides, not the rail", () => {
    const t = html(desk({ mode: "off", book: "paper", paper: true, rows: [{ ...ROW, paper: true }] }));
    assert.match(t, /Paper/);
    assert.match(t, /· paper/);
    assert.equal(perpsMoneyLabel({ paper: true, book: "paper" }), "Paper perps");
  });

  it("A BOOK THE REPORT DOES NOT PLACE is said as not stated — never drawn as real money at Lighter", () => {
    const t = html(desk({ mode: "off", book: null, paper: false }));
    assert.match(t, /Paper or real: not stated/);
    assert.match(t, /doesn’t say whether these are practice \(paper\) or real-money positions/);
    assert.equal(perpsMoneyLabel({ paper: false, book: null }), "Perps · paper or real not stated");
    assert.equal(perpsMoneyLabel({ paper: false, book: "live" }), "At Lighter");
  });

  it("AN UNREAD VENUE WITH NOTHING LISTED is never 'the positions last recorded' over an empty list, and says how many it held", () => {
    const t = html(desk({ venueRead: false, rows: [], stopsMissing: 2, atLighterUsd: null }));
    assert.match(t, /Lighter couldn’t be read just now\. 2 positions were held at the last record and aren’t listed — what is there now is unknown\./);
    assert.doesNotMatch(t, /These are the positions last recorded/);
    assert.doesNotMatch(t, /No open positions/);
    const one = html(desk({ venueRead: false, rows: [{ ...ROW, mark: null }], stopsMissing: 2, atLighterUsd: null }));
    assert.match(one, /These are the positions last recorded, without a current mark; one more position was held at the last record and isn’t listed/);
  });

  it("THE DESK'S COUNT: an unread venue counts what was last held, never fewer, and says it was not read", () => {
    assert.deepEqual(perpsDeskCount(null), { count: 0, suffix: "" });
    assert.deepEqual(perpsDeskCount(desk()), { count: 1, suffix: "" });
    assert.deepEqual(perpsDeskCount(desk({ read: "unreadable", rows: [] })), { count: 0, suffix: " · Lighter unread" });
    assert.deepEqual(perpsDeskCount(desk({ venueRead: false, rows: [], stopsMissing: 2 })), { count: 2, suffix: " · Lighter unread" });
    assert.deepEqual(
      perpsDeskCount(desk({ venueRead: false, paper: true, book: "paper", rows: [], stopsMissing: 3 })),
      { count: 3, suffix: " · practice book unread" },
    );
  });

  it("stops not seen, an incident and a blocker are each said, in core's words", () => {
    const t = html(desk({ stopsMissing: 1, incident: true, blocker: { what: "New perpetual positions are paused. Closes and stops still run.", remedy: "Resume them on the dashboard when you are ready." } }));
    assert.match(t, /One position has no stop seen resting at Lighter/);
    assert.match(t, /activity on the agent's account that the agent did not do/);
    assert.match(t, /New perpetual positions are paused/);
  });
});

describe("where the desk draws it", () => {
  const src = readFileSync(new URL("./screens/Agent.tsx", import.meta.url), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");

  it("the count includes the perps (perpsDeskCount), and says beside it when Lighter was not read", () => {
    assert.match(code, /const perpCount = perpsDeskCount\(perps\);/);
    assert.match(code, /const positionCount = positions\.length \+ perpCount\.count;/);
    assert.match(code, /Positions · \{positionCount\}/);
    assert.match(code, /\{perpCount\.suffix\}/);
  });

  it("'No positions' is only said when the perps panel has nothing to say", () => {
    assert.match(code, /perpsShown \? "No spot positions reported yet\." : "No positions reported yet\."/);
  });

  it("the panel sits in the positions list, and 'At Lighter' follows 'In vaults', unread as 'Not read'", () => {
    const panel = code.indexOf("<PerpsPanel perps={perps}");
    const vaults = code.indexOf("In vaults");
    const lighter = code.indexOf("perpsMoneyLabel(perps)");
    assert.ok(panel > 0 && vaults > panel && lighter > vaults);
    assert.match(code, /perps\.atLighterUsd === null \? "Not read" : money\(perps\.atLighterUsd\)/);
  });
});


describe("perpetual exit controls", () => {
  it("offers Close on each held market and Close all, even when venue reads fail", () => {
    for (const perps of [desk(), desk({ venueRead: false }), desk({ read: "unreadable", rows: [] })]) {
      const t = renderToStaticMarkup(createElement(PerpsPanel, { perps, onClose: () => {}, onFlatten: () => {} }));
      assert.match(t, />Close all<\/button>/);
      if (perps.read === "ok") assert.match(t, />Close BTC-PERP<\/button>/);
    }
  });
});


describe("recorded entry doctrine", () => {
  it("shows the ledger's plan and identifies stale targets as unconfirmed", () => {
    const row = { ...ROW, entryStyle: "scalp-breakout" as const, styleOpenedAtSec: 1_790_600_000, holdDeadlineSec: 1_790_601_800 };
    const current = html(desk({ rows: [row] }));
    assert.match(current, /Scalp breakout · 5m candles/);
    assert.match(current, /Recorded entry plan/);
    assert.match(current, /Time-exit target/);
    assert.match(current, /Requires a fresh market read; this is not a confirmed close/);
    for (const state of [{ stale: true }, { venueRead: false }]) assert.match(html(desk({ ...state, rows: [row] })), /Last recorded entry plan/);
  });
  it("omits legacy entry plans rather than assuming today's selected doctrine", () => {
    const legacy = html(desk());
    assert.doesNotMatch(legacy, /entry plan|Time-exit target|Swing trend|Scalp breakout/);
  });
});
