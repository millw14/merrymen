/**
 * WHY A LINKED WALLET IS NOT COUNTING — said per cause, because the remedies
 * are opposite.
 *
 * The screen had one sentence for every linked wallet that was not counting:
 * "it already powers another [account]. Unlink it there." For a proof that
 * nobody claims — linked before claims existed and not yet backfilled, or left
 * by an unlink that failed half-way — there is no other account, and the one
 * thing that fixes it (signing again) was the thing it steered them from.
 * These render the real component for each standing /api/holder PATCH reports.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkedWallet, unlinkedNote, type ProofStanding } from "./HolderLink";

// See wire-ring.test.ts: tsx compiles `.tsx` against a global React.
(globalThis as unknown as { React: typeof React }).React = React;

const W = "0x000000000000000000000000000000000000beef";
const noop = () => {};
const text = (standing: ProofStanding) =>
  renderToStaticMarkup(createElement(LinkedWallet, { address: W, standing, busy: false, onRelink: noop, onUnlink: noop }))
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

describe("LinkedWallet — the linked wallet, and whether it counts", () => {
  it("COUNTING: the tier reads it", () => {
    const t = text("counting");
    assert.match(t, /Your tier reads 0x0+beef/);
    assert.doesNotMatch(t, /link it again/, "nothing to fix");
  });

  it("UNCLAIMED: not counting YET, and signing once more is the fix — never 'another account has it'", () => {
    const t = text("unclaimed");
    assert.match(t, /not counting yet/);
    assert.match(t, /link it again/i);
    assert.doesNotMatch(t, /another/, "there is no other account to go and unlink it from");
  });

  it("CLAIMED ELSEWHERE: another account has it now, and a fresh signature moves it here (once every 24 hours)", () => {
    const t = text("claimed-elsewhere");
    assert.match(t, /powers another merrymen account right now/);
    assert.match(t, /move it here/);
    assert.match(t, /once every 24 hours/, "a rolling 24 hours from the last move, not a calendar day");
    assert.doesNotMatch(t, /once a day|midnight|UTC day/);
    assert.match(t, /can always come back to the account it last left/, "a phished move is not a lock-out for a day");
    assert.match(t, /link it again/);
    assert.doesNotMatch(t, /Unlink it there/, "the wallet's own signature is the remedy now");
  });

  it("UNKNOWN (the claims could not be read): says only what is known", () => {
    const t = text(null);
    assert.match(t, /is linked, proved by a signature/);
    assert.doesNotMatch(t, /Your tier reads|not counting|another/);
  });

  it("every state can still unlink, and none speaks of price", () => {
    for (const s of ["counting", "unclaimed", "claimed-elsewhere", null] as const) {
      assert.match(text(s), /unlink/);
      assert.doesNotMatch(text(s), /price|returns?\b|profit|invest/i);
    }
  });
});

describe("unlinkedNote — what an unlink leaves the tier reading, from the PATCH that follows", () => {
  it("LOGIN: the tier reads the sign-in wallet again", () => {
    assert.equal(unlinkedNote("login"), "Unlinked. Your tier reads the wallet you sign in with again.");
  });

  it("NONE: never 'reads the wallet you sign in with again' — that wallet powers another account, and signing brings it back", () => {
    // The review's contradiction: the note said the login wallet counts again
    // while the hint above said it powers another account, and the tier read
    // no wallet at all.
    const t = unlinkedNote("none");
    assert.doesNotMatch(t, /reads the wallet you sign in with again/);
    assert.match(t, /powers another merrymen account right now/);
    assert.match(t, /reads no wallet/);
    assert.match(t, /link it below with a signature from it/);
    assert.doesNotMatch(t, /once a day|24 hours/, "its own sign-in account is never held to the move limit");
  });

  it("UNKNOWN: claims nothing about which wallet counts", () => {
    assert.equal(unlinkedNote(null), "Unlinked.");
  });

  it("none of them speaks of price", () => {
    for (const r of ["login", "none", "linked", null] as const) assert.doesNotMatch(unlinkedNote(r), /price|returns?\b|profit|invest/i);
  });
});
