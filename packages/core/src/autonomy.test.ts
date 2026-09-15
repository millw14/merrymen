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
  it("dead-policy, wrong-chain and not-armed all raise an OWNER SIGNATURE", () => {
    // The three the worker cannot fix at any price. Nine agents sat in practice
    // mode on these without the product ever saying a signature would end it.
    //
    // WHAT THIS USED TO ASSERT, and why it changed: it pinned all three to the
    // identical button, `{label: "Renew permission"}`. That was the bug, not the
    // guarantee. `wrong-chain` is fixed only by signing on a DIFFERENT network,
    // and the grant screen syncs its selector to the key being replaced — so a
    // tester pressed "Renew permission" repeatedly and watched the banner come
    // back, which he reported as the product being broken.
    //
    // The property worth keeping is that all three demand a signature and none
    // of them is silently swallowed. The WORDS must differ, because the actions
    // differ, so the shared claim is asserted and the labels are asserted apart.
    for (const rule of ["dead-policy", "wrong-chain", "not-armed"] as RefuseRule[]) {
      const a = autonomyOf({ mode: "paper", liveBlocker: rule });
      assert.equal(a.state, "blocked", rule);
      assert.equal(a.needsOwnerAction, true, rule);
      assert.equal(a.action?.kind, "renew-grant", rule);
      assert.ok(a.action?.label, rule);
      assert.ok(a.headline, `${rule} must carry a headline the banner can render`);
      assert.equal(a.reason, liveBlockerText(rule), rule);
    }
    // And the one whose remedy is NOT a plain renewal says so, in both fields.
    const chain = autonomyOf({ mode: "paper", liveBlocker: "wrong-chain" });
    assert.notEqual(chain.action?.label, "Renew permission");
    assert.match(chain.action!.label, /Robinhood Chain/i);
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

describe("the remedy offered must be able to fix the cause", () => {
  /**
   * A tester reported: "I'm resigning but this banner keeps appearing."
   *
   * His key was signed for another network. The banner said "Your Merryman
   * needs a free permission renewal", the button said "Renew permission", and
   * the grant screen syncs its chain selector to the key being REPLACED — so
   * renewing re-signed the same wrong network, and the banner returned. The
   * loop is unbounded and every step of it looks like progress.
   */
  const blocked = (liveBlocker: string, mode: "paper" | "live" = "paper") =>
    autonomyOf({ mode, liveBlocker, realCashUsd: 0 });

  it("does NOT offer a plain renewal for a key on the wrong network", () => {
    const a = blocked("wrong-chain");
    assert.equal(a.needsOwnerAction, true);
    assert.ok(a.headline, "a blocked owner must get a headline");
    assert.ok(
      !/free permission renewal/i.test(a.headline!),
      "renewing on the same network is a no-op — it must not be the headline",
    );
    assert.match(a.headline!, /different network/i);
    // The button names the network, because the screen opens on the wrong one.
    assert.match(a.action!.label, /Robinhood Chain/i);
  });

  it("does NOT offer a plain renewal for a wall that is too wide", () => {
    // exec-mode.ts: "re-signing the same wall changes nothing, so the owner has
    // to sign a smaller one."
    const a = blocked("grant-too-wide");
    assert.ok(!/free permission renewal/i.test(a.headline!));
    assert.match(a.action!.label, /smaller/i);
  });

  it("DOES offer a renewal for the two rules a renewal actually fixes", () => {
    for (const rule of ["dead-policy", "not-armed"]) {
      const a = blocked(rule);
      assert.match(a.headline!, /free permission renewal/i, `${rule} is fixed by renewing`);
      assert.equal(a.action!.label, "Renew permission");
    }
    const expired = autonomyOf({ mode: "paper", liveBlocker: null, expired: true, realCashUsd: 0 });
    assert.match(expired.headline!, /expired/i);
    assert.equal(expired.action!.label, "Renew permission");
  });

  it("gives every owner-action rule a headline, and nothing else one", () => {
    // The banner renders on `needsOwnerAction && action && headline`. A rule
    // that set the first two and not the third would silently show nothing.
    for (const rule of ["dead-policy", "not-armed", "wrong-chain", "grant-too-wide"]) {
      assert.ok(blocked(rule).headline, `${rule} must carry a headline`);
    }
    for (const rule of ["no-gas", "no-cash", "no-executor"]) {
      const a = blocked(rule);
      assert.equal(a.needsOwnerAction, false, `${rule} is ours to fix, not the owner's`);
      assert.equal(a.headline, null, `${rule} must not render an owner banner`);
    }
    assert.equal(autonomyOf({ mode: "live", liveBlocker: null }).headline, null);
  });

  it("keeps the headline and the button consistent about the same remedy", () => {
    // Two fields, one claim. A headline saying "different network" beside a
    // button saying "Renew permission" is the original bug wearing half a fix.
    const chain = blocked("wrong-chain");
    assert.ok(/network/i.test(chain.headline!) && /Robinhood Chain/i.test(chain.action!.label));
    const wide = blocked("grant-too-wide");
    assert.ok(/too much/i.test(wide.headline!) && /smaller/i.test(wide.action!.label));
  });
});

/**
 * THE BANNER THAT OUTLIVED THE SIGNATURE.
 *
 * A corrected grant takes four hops to reach a screen — the orchestrator's 15s
 * ferry, the child's 240s tick, the 15s mirror, the browser's 60s poll — about
 * five and a half minutes at worst. For all of it the page went on asserting
 * the OLD blocker, so an owner who had just done exactly what the banner asked
 * was told to do it again. One did, repeatedly, and reported the product as
 * broken. He was right to: the remedy offered could not have worked, because it
 * had already been applied.
 *
 * The fix cannot make it faster. It stops the screen claiming to know something
 * it cannot know yet.
 */
describe("a verdict about a replaced key is not repeated back at its owner", () => {
  const stale = (rule: string) =>
    autonomyOf({ mode: "paper", liveBlocker: rule, blockerPredatesGrant: true });

  it("STOPS ASKING FOR THE SIGNATURE IT ALREADY GOT", () => {
    const a = stale("wrong-chain");
    assert.equal(a.state, "checking");
    assert.equal(a.label, "CHECKING");
    assert.equal(a.needsOwnerAction, false, "they have already acted");
    assert.equal(a.action, null, "offering the button again is how it gets pressed three times");
    assert.equal(a.headline, null, "and no banner");
  });

  it("but it never claims the agent is FINE", () => {
    // The difference between this and a suppression. "We have not heard yet" is
    // a fact; "nothing is wrong" would be a guess, and it would be wrong for
    // every owner who re-signed onto the sandbox a second time.
    const a = stale("wrong-chain");
    assert.notEqual(a.state, "live");
    assert.match(a.reason!, /have not heard/i);
    assert.equal(a.rule, "wrong-chain", "the rule is still carried, not erased");
  });

  it("and the money stays labelled by what it IS, not by how fresh the news is", () => {
    assert.equal(stale("wrong-chain").simulated, true);
    assert.equal(
      autonomyOf({ mode: "live", liveBlocker: "wrong-chain", blockerPredatesGrant: true }).simulated,
      false,
    );
  });

  it("only gates the rules a SIGNATURE could have changed", () => {
    // no-cash and no-gas are not about the key, so a fresh one says nothing
    // about them and they must go on reporting normally. Gating them would hide
    // a real, current problem behind an unrelated act.
    for (const rule of ["no-cash", "no-gas"] as const) {
      const a = autonomyOf({ mode: "paper", liveBlocker: rule, blockerPredatesGrant: true, realCashUsd: 0 });
      assert.notEqual(a.state, "checking", `${rule} is not about the key`);
    }
  });

  it("and the window closes on the first beat, whatever the beat says", () => {
    // Bounded by construction: the flag is `grantedAt > workerAliveAt`, so one
    // beat ends it. If the owner re-signed onto the sandbox again, they are told
    // so in full rather than left in a permanent soft state.
    const spoken = autonomyOf({ mode: "paper", liveBlocker: "wrong-chain", blockerPredatesGrant: false });
    assert.equal(spoken.state, "blocked");
    assert.equal(spoken.needsOwnerAction, true);
    assert.ok(spoken.headline);
  });

  it("defaults to reporting, not to silence, when the timestamps are missing", () => {
    // An absent timestamp is not a fresh signature. Defaulting the other way
    // would turn "we don't know" into "nothing to see".
    const a = autonomyOf({ mode: "paper", liveBlocker: "wrong-chain" });
    assert.equal(a.state, "blocked");
  });
});
