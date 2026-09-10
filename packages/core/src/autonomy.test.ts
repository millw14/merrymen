import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REAL_LABEL, SIMULATED_LABEL, autonomyOf, liveBlockerText, type RefuseRule } from "./autonomy";

/**
 * THE INCIDENT THESE PIN.
 *
 * An account holding 0.000000 USDG displayed "$964" and refused every trade with
 * `no-cash`. Both were correct — with no real money the agent drops to paper,
 * and paper's book is what the balance then reports — but the screen rendered
 * practice money in the same shape as deposited money. The tester concluded the
 * product was broken and said so in the group chat.
 *
 * So the property is not "does it compute the right state". It is "can a number
 * on this screen be mistaken for money someone deposited", and it is asserted on
 * the LABEL, because a caption under a large figure is not read by someone who
 * has already decided what the figure means.
 */

const base = { mode: "live" as const, liveBlocker: null };

describe("simulated money never wears the label real money wears", () => {
  it("paper renames the balance rather than annotating it", () => {
    const a = autonomyOf({ mode: "paper", liveBlocker: "no-cash", realCashUsd: 0 });
    assert.equal(a.simulated, true);
    assert.equal(a.moneyLabel, SIMULATED_LABEL);
    assert.notEqual(a.moneyLabel, REAL_LABEL);
    assert.match(a.moneyLabel, /not real money/i);
  });

  it("live keeps the promise that 'available cash' makes", () => {
    const a = autonomyOf(base);
    assert.equal(a.simulated, false);
    assert.equal(a.moneyLabel, REAL_LABEL);
  });

  it("a BLOCKED agent on paper still says its money is simulated", () => {
    // Both facts are true at once and the owner needs both: there is a signature
    // to fix, AND the balance on screen is not theirs.
    const a = autonomyOf({ mode: "paper", liveBlocker: "dead-policy" });
    assert.equal(a.state, "blocked");
    assert.equal(a.simulated, true);
    assert.equal(a.moneyLabel, SIMULATED_LABEL);
  });

  it("there are exactly two money labels, so no surface can invent a third", () => {
    const labels = new Set(
      (["not-armed", "dead-policy", "no-executor", "wrong-chain", "no-gas", "no-cash"] as RefuseRule[]).flatMap(
        (r) =>
          (["paper", "live", "idle", null] as const).map(
            (mode) => autonomyOf({ mode, liveBlocker: r }).moneyLabel,
          ),
      ),
    );
    assert.deepEqual([...labels].sort(), [REAL_LABEL, SIMULATED_LABEL].sort());
  });
});

describe("an owner is told when a free signature is the whole remedy", () => {
  it("dead-policy, wrong-chain and not-armed all raise a renewal", () => {
    // The three the worker cannot fix at any price. Nine agents sat in practice
    // mode on these without the product ever saying a signature would end it.
    for (const rule of ["dead-policy", "wrong-chain", "not-armed"] as RefuseRule[]) {
      const a = autonomyOf({ mode: "paper", liveBlocker: rule });
      assert.equal(a.state, "blocked", rule);
      assert.equal(a.needsOwnerAction, true, rule);
      assert.deepEqual(a.action, { label: "Renew permission", kind: "renew-grant" }, rule);
      assert.equal(a.reason, liveBlockerText(rule), rule);
    }
  });

  it("BLOCKED outranks PAPER, because only one of them has an action", () => {
    // Both render as "not trading for real". Burying a re-sign behind the word
    // "paper" is how the incident happened in the first place.
    assert.equal(autonomyOf({ mode: "paper", liveBlocker: "dead-policy" }).state, "blocked");
    assert.equal(autonomyOf({ mode: "paper", liveBlocker: "no-cash" }).state, "paper");
  });

  it("expiry is named in its own words, not folded into not-armed", () => {
    // Same remedy, different cause. An owner told "your key is not active yet"
    // about a key that WAS active for two weeks will go looking for a setup step
    // that does not exist.
    const a = autonomyOf({ mode: "paper", liveBlocker: null, expired: true });
    assert.equal(a.rule, "expired");
    assert.equal(a.needsOwnerAction, true);
    assert.match(a.reason ?? "", /expired/);
    assert.equal(a.action?.kind, "renew-grant");
  });

  it("expiry wins over any blocker, because it is the earlier failure", () => {
    // An expired agent is retired before the rail is assessed, so whatever
    // blocker is on record predates the expiry and is no longer the story.
    assert.equal(autonomyOf({ mode: "paper", liveBlocker: "no-cash", expired: true }).rule, "expired");
  });

  it("no-cash and no-gas are NOT owner-permission problems", () => {
    // They are fixed by sending money, and offering a re-sign for them would
    // send an owner to sign something that changes nothing.
    for (const rule of ["no-cash", "no-gas"] as RefuseRule[]) {
      const a = autonomyOf({ mode: "paper", liveBlocker: rule, realCashUsd: 0 });
      assert.equal(a.needsOwnerAction, false, rule);
      assert.notEqual(a.action?.kind, "renew-grant");
    }
  });
});

describe("the reason is never silently absent", () => {
  it("every state that cannot trade names why, or has genuinely nothing to name", () => {
    for (const rule of ["not-armed", "dead-policy", "no-executor", "wrong-chain", "no-gas", "no-cash"] as RefuseRule[]) {
      const a = autonomyOf({ mode: "paper", liveBlocker: rule });
      assert.ok(a.reason && a.reason.length > 0, `${rule} rendered without a reason`);
    }
  });

  it("live has no reason because there is nothing stopping it", () => {
    const a = autonomyOf(base);
    assert.equal(a.reason, null);
    assert.equal(a.rule, null);
    assert.equal(a.action, null);
  });

  it("an unrecognised blocker becomes null rather than leaking through", () => {
    // live_blocker is a TEXT column. A value this build does not know would
    // otherwise fall out of every switch as undefined and render the agent as
    // un-blocked — exactly when the worker was trying to say something new.
    const a = autonomyOf({ mode: "paper", liveBlocker: "some-future-rule" });
    assert.equal(a.rule, null);
    assert.equal(a.reason, null);
    assert.equal(a.state, "paper");
  });

  it("unreadable real cash does not become zero", () => {
    // null is "we could not look". Offering "Add funds" on it would be a guess.
    assert.equal(autonomyOf({ mode: "paper", liveBlocker: "no-cash", realCashUsd: null }).action, null);
    assert.equal(autonomyOf({ mode: "paper", liveBlocker: "no-cash", realCashUsd: 0 }).action?.kind, "add-funds");
  });
});
