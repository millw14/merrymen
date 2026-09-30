/**
 * WHO GETS INTERRUPTED ABOUT THEIR TRADING PERMISSION, AND WHO NEVER DOES.
 *
 * The owner's instruction was two halves: prompt after an update, and "make
 * sure it's not on new guys that haven't created their agents yet". The second
 * half is the one with teeth. With no grant, the wallet screen falls to its
 * first phase, which defaults to "Restore your funded wallet" and asks for an
 * owner key a new visitor has never had — so a misfire here does not merely
 * annoy somebody, it sends them hunting for a secret that does not exist.
 *
 * Every input below has a third state that is not `false`, and each of those is
 * its own case: a server that has not answered, a grant whose timestamp did not
 * arrive, a dismissal record that could not be read. The repo's rule is that a
 * measured zero is never an absence, and all three of these are absences.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WALL_CHANGED_AT } from "@merrymen/core";
import { resignPromptApplies, resignPromptState } from "./resign-prompt-state";

const OLD = WALL_CHANGED_AT - 86_400;
const NEW = WALL_CHANGED_AT + 86_400;

/** An owner with an agent, a stale grant, a key to sign with, nothing dismissed. */
const owner = (over: Partial<Parameters<typeof resignPromptState>[0]> = {}) =>
  resignPromptState({ exists: true, grantedAt: OLD, canSign: true, acknowledged: false, ...over });

describe("a new visitor is never asked to re-sign", () => {
  it("says nothing to somebody with no agent", () => {
    // THE HALF THE OWNER ASKED FOR BY NAME. There is nothing to re-sign, and
    // /grant would meet them with a form asking for a key they have never had.
    assert.equal(owner({ exists: false }), "hidden");
  });

  it("says nothing while the server has not answered yet", () => {
    // `null` is not `false`. Treating "unread" as "has an agent" flashes the
    // dialog over a first paint; treating it as "no agent" would be fine here
    // but is the same guess in the other direction. We wait.
    assert.equal(owner({ exists: null }), "hidden");
  });

  it("says nothing to a browser that could not sign anyway", () => {
    // Advice that cannot be followed. This codebase already fixed the mirror
    // of this once, when gating on the owner key alone hid the coverage banner
    // from the entire Privy cohort.
    assert.equal(owner({ canSign: false }), "hidden");
  });
});

describe("an owner whose permission predates the update", () => {
  it("is interrupted once", () => {
    assert.equal(owner(), "dialog");
  });

  it("keeps a quiet line after dismissing it", () => {
    // Not gone. The agent still cannot be relied on to trade, and a banner
    // somebody closed is a fact nobody ever acts on.
    assert.equal(owner({ acknowledged: true }), "strip");
  });

  it("shows nothing until the dismissal record has been read", () => {
    // Otherwise a returning owner gets one frame of dialog before it is
    // replaced by the strip, which reads as a bug and trains a reflex.
    assert.equal(owner({ acknowledged: null }), "hidden");
  });
});

describe("an owner who has already re-signed is left alone", () => {
  it("says nothing about a grant signed after the change", () => {
    assert.equal(owner({ grantedAt: NEW }), "hidden");
  });

  it("says nothing about one signed at the exact moment of the change", () => {
    assert.equal(owner({ grantedAt: WALL_CHANGED_AT }), "hidden");
  });

  it("STOPS ASKING THE INSTANT THE GRANT MOVES FORWARD", () => {
    // The specific reported bug this must not reproduce: a tester re-signed
    // repeatedly under a banner that kept asking, and reported the product as
    // broken. He was right to. autonomy.ts grew a whole "checking" arm for it.
    // Here it falls out of the comparison — a fresh signature is a fresh
    // grantedAt, and no dismissal record is needed to make it stop.
    assert.equal(owner({ grantedAt: NEW, acknowledged: false }), "hidden");
    assert.equal(owner({ grantedAt: NEW, acknowledged: true }), "hidden");
  });
});

describe("an unread grant is not an old one", () => {
  it("says nothing when the timestamp never arrived", () => {
    assert.equal(owner({ grantedAt: null }), "hidden");
  });

  it("says nothing for a zero or nonsensical timestamp", () => {
    // 0 is what a missing field coerces to. Read literally it is 1970 — the
    // most stale value possible — so the naive comparison would interrupt
    // every owner whose grant simply did not report one.
    for (const at of [0, -1, Number.NaN]) {
      assert.equal(owner({ grantedAt: at }), "hidden", String(at));
    }
  });
});

describe("the policy half on its own", () => {
  it("is true only for an existing agent, a signable browser and an old grant", () => {
    assert.equal(resignPromptApplies({ exists: true, grantedAt: OLD, canSign: true }), true);
  });

  it("is false if any one of the three fails", () => {
    assert.equal(resignPromptApplies({ exists: false, grantedAt: OLD, canSign: true }), false);
    assert.equal(resignPromptApplies({ exists: true, grantedAt: NEW, canSign: true }), false);
    assert.equal(resignPromptApplies({ exists: true, grantedAt: OLD, canSign: false }), false);
  });

  it("does not depend on the dismissal record", () => {
    // Whether the permission is old is a fact about the grant. Whether we have
    // said so yet is a fact about this browser. Keeping them apart is what lets
    // the strip survive a dismissal without re-deriving the policy.
    assert.equal(resignPromptApplies({ exists: true, grantedAt: OLD, canSign: true }), true);
  });
});
