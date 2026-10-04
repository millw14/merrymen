/**
 * NO SURFACE MAY PRINT A BALANCE UNDER A LABEL IT DID NOT CHECK.
 *
 * The incident: an account holding 0.000000 USDG on chain displayed "Available
 * cash $964" while the worker refused every trade with `no-cash`. Both halves
 * were correct. With no real money `canTradeForReal` is false, the agent drops
 * to paper, and the paper book's balance is what the account line then reports.
 * Nothing lied — the screen rendered practice money in the same shape as
 * deposited money, and the reader supplied the only meaning available to them.
 * They waited a day and told the group chat the product was broken.
 *
 * The fix is not a caption. Someone who has already read a large number as
 * their deposit does not go on to read the small print under it, so the LABEL
 * itself has to change, and it has to change everywhere at once. That makes
 * this a property of how the terminal is WRITTEN, not of one render: a new
 * balance added next month with a hardcoded label would reopen the incident
 * while every render test still passed.
 *
 * Source scans protect the verdict's inputs; rendered assertions protect each
 * cash slot when presentation adds a qualified recovery label.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { REAL_LABEL, SIMULATED_LABEL, autonomyOf } from "@merrymen/core";
import type { FleetRecoveryView } from "../../../worker/src/fleet-recovery";
import type { ChatController } from "./chat-controller";
import type { LiveMine } from "./live";
import { DesktopHeader, DesktopPortfolio } from "./Desktop";
import { Agent } from "./screens/Agent";

(globalThis as unknown as { React: typeof React }).React = React;
const noop = () => {};
const held: FleetRecoveryView = { state: "history-only", tradingPaused: true, history: "available",
  memory: "unknown", checkedAt: 1_791_111_100, lastVerifiedHeartbeatAt: null };
const mine: LiveMine = { name: "Example Robin", slug: "example", handle: null, owner: "you", mode: "live",
  equity: 120, chg24: 5, moves: [], thesis: null, statusLabel: "LIVE", glance: { id: "custom", label: "", cashUsd: 95 },
  autonomy: autonomyOf({ mode: "live", liveBlocker: null }) };
const chat = { draft: "", setDraft: noop, proposal: null, setProposal: noop, confirming: false,
  messages: [], sending: false, streaming: "", ceiling: 10 } as unknown as ChatController;
const doc = (node: React.ReactElement) => new JSDOM(renderToStaticMarkup(node)).window.document;

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** Comments stripped — this codebase argues in prose beside the code it argues about. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

/** Every terminal surface that prints the owner's own balance. */
const SURFACES = {
  "Desktop.tsx": strip(read("./Desktop.tsx")),
  "screens/Agent.tsx": strip(read("./screens/Agent.tsx")),
  "App.tsx": strip(read("./App.tsx")),
};

describe("practice money can never wear the label real money wears", () => {
  it("no surface hardcodes the real-money label", () => {
    // `REAL_LABEL` is a promise about where the money is. It may only be made by
    // `autonomyOf`, which has looked at the chain balance and the rail.
    for (const [file, src] of Object.entries(SURFACES)) {
      assert.ok(
        !src.includes(`"${REAL_LABEL}"`) && !src.includes(`>${REAL_LABEL}<`),
        `${file} hardcodes "${REAL_LABEL}" — it must render autonomy.moneyLabel instead`,
      );
    }
  });

  it("each rendered cash amount has the real, practice or recovery label its verdict requires", () => {
    // Each independently selected slot must carry BOTH the cash amount and its
    // meaning. Recovery must qualify saved cash without turning paper cash real.
    const cases = [
      { name: "real", mode: "live" as const, recovery: undefined, label: REAL_LABEL, simulated: false },
      { name: "practice", mode: "paper" as const, recovery: undefined, label: SIMULATED_LABEL, simulated: true },
      { name: "recovering real", mode: "live" as const, recovery: held, label: "Last recorded cash", simulated: false },
      { name: "recovering practice", mode: "paper" as const, recovery: held, label: "Last recorded paper cash", simulated: true },
    ];
    for (const expected of cases) for (const cashUsd of [95, 0, undefined]) {
      const snapshot = { ...mine, recovery: expected.recovery, glance: { ...mine.glance, cashUsd },
        autonomy: autonomyOf({ mode: expected.mode, liveBlocker: null }) };
      const header = doc(React.createElement(DesktopHeader, { mine: snapshot, onScreen: noop, onTab: noop }));
      const panel = doc(React.createElement(DesktopPortfolio, { mine: snapshot, tokens: [], stopped: false,
        perTrade: 10, perDay: 20, onScreen: noop, onTab: noop }));
      const agent = doc(React.createElement(Agent, { mine: snapshot, tokens: [], stopped: false, chat,
        perTrade: 10, perDay: 20, liveBlocker: null, onToken: noop, onDeposit: noop, onWithdraw: noop,
        onLimits: noop, onResign: noop, onSettings: noop }));
      const slots = [
        { name: "desktop header", row: header.querySelector(".desktop-header-account > span"), label: "small" },
        { name: "desktop portfolio", row: panel.querySelector(".desktop-cash"), label: "span" },
        { name: "agent portfolio", row: agent.querySelector(".desk-cash"), label: "span" },
      ];
      for (const slot of slots) {
        const context = `${expected.name}, ${slot.name}, cash ${cashUsd}`;
        assert.ok(slot.row, `${context}: the cash row must be rendered`);
        assert.equal(slot.row.querySelector(slot.label)?.textContent, expected.label, context);
        assert.equal(slot.row.querySelector("strong")?.textContent, cashUsd === undefined ? "—" : `$${cashUsd.toFixed(2)}`, context);
        assert.equal(slot.row.classList.contains("is-simulated"), expected.simulated, context);
      }
    }
  });

  it("simulated balances are marked in the markup, not only in words", () => {
    // Belt and braces: the label carries the meaning, the class carries the
    // visual weight. A number that looks authoritative is read as authoritative
    // however it is captioned.
    for (const file of ["Desktop.tsx", "screens/Agent.tsx"] as const) {
      assert.match(SURFACES[file], /autonomy\.simulated/, `${file} must mark simulated money`);
    }
  });

  it("the verdict is computed once, from the CHAIN balance and not the book", () => {
    // `glance.cashUsd` is the book, and in paper mode the book IS the simulated
    // balance — so deciding "is this real" from it would ask the lie whether it
    // is lying. /api/grants reads balanceOf in a multicall; that is the input.
    const app = SURFACES["App.tsx"];
    assert.match(app, /autonomyOf\(/, "App must compute the verdict");
    // Where it comes from is run, not read: realCashOf (account-read.test.ts)
    // takes the chain read and nothing else, and App passes it straight in.
    assert.ok(
      !/realCashUsd:\s*[^,\n]*glance/.test(app),
      "the verdict must not be decided from the book's own cash figure",
    );
    assert.equal((app.match(/autonomyOf\(/g) ?? []).length, 2, "one live verdict, one empty-shell verdict");
  });
});

describe("an owner who needs to re-sign is told so where the money is", () => {
  it("the renewal is rendered, and only when the owner alone can clear it", () => {
    const desktop = SURFACES["Desktop.tsx"];
    assert.match(desktop, /needsOwnerAction/, "the CTA must be gated on the verdict, not on mode");
    // THE SENTENCE COMES FROM THE VERDICT NOW, and this assertion moved with it.
    //
    // It used to require the literal "free permission renewal" in this file.
    // That pinned the surface to ONE sentence for every owner-clearable rule,
    // which is exactly the defect a tester hit: told to renew a key whose
    // problem was the network, he renewed, nothing changed, and the banner
    // returned. Requiring the hardcoded string here would have kept the fix out.
    assert.match(desktop, /autonomy\.headline/, "the headline takes its words from the verdict");
    assert.ok(
      !/free permission renewal/.test(desktop.replace(/\{\/\*[\s\S]*?\*\/\}/g, "")),
      "no surface may hardcode a remedy — it cannot know which rule it is rendering",
    );
    assert.match(desktop, /autonomy\.action\.label/, "the button takes its words from the verdict");
  });

  it("it routes to the screen where re-signing actually happens", () => {
    // A tester was once told to "head to the wallet screen", spent minutes
    // looking, and reported there was no such thing. The button navigates.
    // ANCHORED TO THE BUTTON, not to the string "/grant".
    //
    // The old assertion matched `onScreen({kind:"grant"})`, which existed once
    // in this file. When the mechanism changed to a URL — `pathForScreen` drops
    // descriptor fields, so the chain intent could not survive — the obvious
    // replacement `/\/grant/` also matched the unrelated sidebar link
    // `<Link href="/grant">`, and would have passed with the CTA deleted
    // entirely. A regex that survives the removal of the thing it is about is
    // not a test.
    assert.match(
      SURFACES["Desktop.tsx"],
      /window\.location\.href = mine\.autonomy\.action\?\.chain/,
      "the CTA itself must navigate to the grant screen",
    );
  });

  it("AND IT CARRIES THE NETWORK IT NAMED", () => {
    // The half that was missing, and the reason a second beta owner re-signed
    // over and over without ever clearing his banner.
    //
    // `wrong-chain` is the one rule whose remedy is a signature on a DIFFERENT
    // network, and its button says so: "Re-sign on Robinhood Chain". It opened
    // `{kind:"grant"}`, which `pathForScreen` flattens to the string "/grant" —
    // so the destination pinned its selector to the testnet grant being
    // replaced, the prominent control read "re-sign this key (free)", and the
    // signature minted another testnet grant.
    const chained = autonomyOf({ mode: "paper", liveBlocker: "wrong-chain" });
    assert.equal(chained.action?.chain, 4663, "the verdict names the target network");
    assert.match(
      SURFACES["Desktop.tsx"],
      /action\.chain/,
      "and the surface must carry it rather than dropping it",
    );

    // ONLY where the network is the problem. Everywhere else the grant screen's
    // selector is already right, and overriding it is how a mainnet owner would
    // silently re-sign onto the sandbox — the same bug, mirrored.
    for (const rule of ["dead-policy", "not-armed", "grant-too-wide"] as const) {
      assert.equal(
        autonomyOf({ mode: "paper", liveBlocker: rule }).action?.chain,
        undefined,
        `${rule} must not move the selector`,
      );
    }
  });

  it("and it never offers a signature for a problem money would fix", () => {
    // Offering a re-sign for no-cash sends an owner to sign something that
    // changes nothing, and leaves the real remedy unnamed.
    for (const rule of ["no-cash", "no-gas"] as const) {
      const a = autonomyOf({ mode: "paper", liveBlocker: rule, realCashUsd: 0 });
      assert.notEqual(a.action?.kind, "renew-grant", rule);
    }
    for (const rule of ["dead-policy", "wrong-chain"] as const) {
      assert.equal(autonomyOf({ mode: "paper", liveBlocker: rule }).action?.kind, "renew-grant", rule);
    }
  });

  it("the two labels are the only two, and the simulated one says so plainly", () => {
    assert.match(SIMULATED_LABEL, /not real money/i);
    assert.notEqual(SIMULATED_LABEL, REAL_LABEL);
  });
});
