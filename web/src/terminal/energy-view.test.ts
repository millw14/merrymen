/**
 * WHAT THE DESK SAYS ABOUT ENERGY, AND WHEN IT SAYS NOTHING.
 *
 * Three failures this is here to stop, each of which would send an owner the
 * wrong way with money:
 *   - a sentence about energy on a deployment where energy limits nothing;
 *   - yesterday's "spent" shown as today's on a desk left open past midnight;
 *   - an unread balance rendered as a number — above all as 0, which is the
 *     number that sends somebody to buy tokens they may already hold.
 * And one about the remedy: the agent's address is offered as somewhere to
 * send $MERRYMEN only when tokens sent there would count.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnergyStatus } from "@merrymen/core";
import { energyRemedies, energyView, meterBar, workerSaysFull } from "./energy-view";

const NOW = 1_790_500_000;

const report = (over: Partial<EnergyStatus> = {}): EnergyStatus => ({
  v: 1,
  gated: true,
  mode: "enforce",
  level: "low",
  agentTokens: 2_000,
  holderTokens: 10_345,
  needTokens: 100_000,
  day: "2026-09-27",
  resetsAt: NOW + 3_600,
  reviews: { used: 2, allowed: 3 },
  entries: { used: 1, allowed: 2 },
  spent: false,
  buy: "ready",
  estimateUsdg: 37,
  at: NOW - 60,
  ...over,
});

describe("energyView says nothing when nothing is true", () => {
  it("NO REPORT — the worker has not said", () => {
    assert.deepEqual(energyView(null, NOW), { kind: "none" });
    assert.deepEqual(energyView(undefined, NOW), { kind: "none" });
  });

  it("NOT GATED — energy limits nothing here, so a sentence would be a false alarm", () => {
    assert.deepEqual(energyView(report({ gated: false, mode: "off" }), NOW), { kind: "none" });
    assert.deepEqual(energyView(report({ gated: false, mode: "observe", spent: true }), NOW), { kind: "none" });
  });

  it("FULL — the ordinary state for a holder", () => {
    assert.deepEqual(energyView(report({ level: "full" }), NOW), { kind: "none" });
  });

  it("AFTER 00:00 UTC — yesterday's spent is not today's", () => {
    const e = report({ spent: true });
    assert.equal(energyView(e, e.resetsAt - 1).kind, "low");
    assert.deepEqual(energyView(e, e.resetsAt), { kind: "none" });
    assert.deepEqual(energyView(e, e.resetsAt + 86_400), { kind: "none" });
  });
});

describe("unread is never a number", () => {
  it("UNREAD CARRIES NO COUNT AT ALL", () => {
    const v = energyView(report({ level: "unread", agentTokens: null, holderTokens: null }), NOW);
    assert.deepEqual(v, { kind: "unread", spent: false });
    assert.ok(!("total" in v) && !("short" in v), "an unread view has no figure to render");
  });

  it("and says whether today's is spent", () => {
    assert.deepEqual(energyView(report({ level: "unread", spent: true }), NOW), { kind: "unread", spent: true });
  });
});

describe("a low agent's counts", () => {
  it("LOW CARRIES THE WORKER'S COUNTS, summed and short", () => {
    const v = energyView(report(), NOW);
    assert.equal(v.kind, "low");
    if (v.kind !== "low") return;
    assert.equal(v.total, 12_345);
    assert.equal(v.short, 87_655);
    assert.deepEqual(v.reviews, { used: 2, allowed: 3 });
    assert.deepEqual(v.entries, { used: 1, allowed: 2 });
    assert.equal(v.spent, false);
  });

  it("TOTAL IS NULL WHEN EITHER COUNT IS — never a smaller number", () => {
    for (const over of [{ agentTokens: null }, { holderTokens: null }, { agentTokens: null, holderTokens: null }]) {
      const v = energyView(report(over), NOW);
      assert.equal(v.kind, "low");
      if (v.kind !== "low") return;
      assert.equal(v.total, null, JSON.stringify(over));
      assert.equal(v.short, null, "no shortfall from a total we do not have");
    }
  });

  it("NO WALLET THAT COUNTS IS A KNOWABLE NOTHING — the account alone is the total, and nothing 'failed'", () => {
    // A login wallet already powering another account leaves the child with no
    // holder at all. That is not an outage, and "couldn't read" would send the
    // owner looking for one; the worker's own notice says "My account holds …".
    const v = energyView(report({ holderCounted: false, holderTokens: null, agentTokens: 5_000 }), NOW);
    if (v.kind !== "low") return assert.fail("expected low");
    assert.equal(v.total, 5_000);
    assert.equal(v.short, 95_000);
    assert.equal(v.noWallet, true);
    assert.equal(v.readFailed, false);
  });

  it("…BUT A COUNTED PART THAT WAS NOT READ IS STILL A FAILED READ", () => {
    const account = energyView(report({ holderCounted: false, holderTokens: null, agentTokens: null }), NOW);
    if (account.kind !== "low") return assert.fail("expected low");
    assert.equal(account.total, null);
    assert.equal(account.readFailed, true, "the account counts and did not answer");
    const wallet = energyView(report({ holderCounted: true, holderTokens: null }), NOW);
    if (wallet.kind !== "low") return assert.fail("expected low");
    assert.equal(wallet.total, null);
    assert.equal(wallet.readFailed, true, "a wallet that counts and did not answer");
    assert.equal(wallet.noWallet, false);
  });

  it("A REPORT FROM BEFORE holderCounted IS READ AS BEFORE — a null wallet may have failed", () => {
    const v = energyView(report({ holderTokens: null }), NOW);
    if (v.kind !== "low") return assert.fail("expected low");
    assert.equal(v.total, null);
    assert.equal(v.readFailed, true);
    assert.equal(v.noWallet, false);
  });

  it("on another network with no wallet counted: no total, and no read failed either", () => {
    const v = energyView(report({ buy: "not-mainnet", holderCounted: false, holderTokens: null, agentTokens: null }), NOW);
    if (v.kind !== "low") return assert.fail("expected low");
    assert.equal(v.total, null);
    assert.equal(v.readFailed, false);
  });

  it("on another network the owner's wallet IS the whole count", () => {
    // The agent's account is not counted there by design, so its null is not
    // a missing read.
    const v = energyView(report({ buy: "not-mainnet", agentTokens: null, holderTokens: 40_000 }), NOW);
    assert.equal(v.kind, "low");
    if (v.kind !== "low") return;
    assert.equal(v.total, 40_000);
    assert.equal(v.short, 60_000);
  });

  it("never short by less than nothing", () => {
    const v = energyView(report({ holderTokens: 99_999, agentTokens: 5 }), NOW);
    if (v.kind !== "low") return assert.fail("expected low");
    assert.equal(v.short, 0);
  });

  it("A METER WITH AN UNREAD ALLOWANCE DRAWS NO BAR", () => {
    assert.equal(meterBar({ used: 1, allowed: null }), null);
    assert.equal(meterBar({ used: null, allowed: 3 }), null);
    assert.equal(meterBar(null), null);
    assert.equal(meterBar({ used: 0, allowed: 0 }), null, "a zero allowance is not a bar either");
    assert.deepEqual(meterBar({ used: 2, allowed: 3 }), { used: 2, allowed: 3 });
    assert.deepEqual(meterBar({ used: 5, allowed: 3 }), { used: 3, allowed: 3 }, "a bar never overflows");
  });
});

describe("workerSaysFull", () => {
  it("ONLY THE WORKER'S OWN 'full'", () => {
    assert.equal(workerSaysFull(report({ level: "full" })), true);
    assert.equal(workerSaysFull(report({ level: "full", gated: false })), true, "the level is the level, gated or not");
    assert.equal(workerSaysFull(report({ level: "low" })), false);
    assert.equal(workerSaysFull(report({ level: "unread" })), false, "unread is not full");
    assert.equal(workerSaysFull(null), false);
    assert.equal(workerSaysFull(undefined), false);
  });
});

describe("energyRemedies — where tokens may be sent", () => {
  it("THE AGENT'S ADDRESS ONLY ON ROBINHOOD CHAIN", () => {
    assert.equal(energyRemedies(report(), 4663).sendToAgent, true);
    assert.equal(energyRemedies(report(), 46630).sendToAgent, false, "the practice chain's account would not count");
    assert.equal(energyRemedies(report(), null).sendToAgent, false, "an unknown chain is not mainnet");
    assert.equal(energyRemedies(report({ buy: "not-mainnet" }), 4663).sendToAgent, false, "the worker's verdict wins");
  });

  it("and the USDG route is the worker's word, or nothing", () => {
    assert.equal(energyRemedies(report({ buy: "paper" }), 4663).usdg, "paper");
    assert.equal(energyRemedies(report({ buy: "resign" }), 4663).usdg, "resign");
    assert.equal(energyRemedies(null, 4663).usdg, null, "not said is not 'ready'");
    assert.equal(energyRemedies(null, 4663).sendToAgent, true, "a mainnet account counts whether or not the worker has reported");
  });
});
