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
 * Source scans, in the idiom of app/settings/honesty.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { REAL_LABEL, SIMULATED_LABEL, autonomyOf } from "@merrymen/core";

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

  it("every balance in the terminal is labelled from the autonomy verdict", () => {
    // Count the label slots, not the renders: a balance whose label is a literal
    // is exactly the bug, and it would otherwise be invisible to a render test.
    const desktop = SURFACES["Desktop.tsx"];
    const agent = SURFACES["screens/Agent.tsx"];
    assert.equal(
      (desktop.match(/autonomy\.moneyLabel/g) ?? []).length,
      2,
      "Desktop has two balance surfaces — the header and the portfolio panel",
    );
    assert.equal(
      (agent.match(/autonomy\.moneyLabel/g) ?? []).length,
      1,
      "the agent screen's cash row must take its label from the verdict",
    );
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
    assert.match(app, /balances\.cashUsdg/, "real cash must come from the chain read");
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
    assert.match(desktop, /free permission renewal/i, "the sentence the owner reads must be present");
    assert.match(desktop, /autonomy\.action\.label/, "the button takes its words from the verdict");
  });

  it("it routes to the screen where re-signing actually happens", () => {
    // A tester was once told to "head to the wallet screen", spent minutes
    // looking, and reported there was no such thing. The button navigates.
    assert.match(SURFACES["Desktop.tsx"], /kind:\s*"grant"/, "the CTA must open the grant screen");
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
