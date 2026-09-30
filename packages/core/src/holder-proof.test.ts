/**
 * ONE $MERRYMEN WALLET POWERS ONE AGENT — the rule, as a table.
 *
 * A proof bound a wallet to an account and nothing bound it back: any number
 * of accounts could link the same 100,000-token wallet, and a login wallet
 * could double as somebody else's linked one. effectiveHolder is the one rule
 * the web and the orchestrator both apply, so these rows are what a person is
 * told on screen AND what their agent is throttled on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { effectiveHolder, type HolderClaimOf } from "./holder-proof";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const W = "0x000000000000000000000000000000000000beef";
const proofOf = (address: string, at = 1) => ({ address, at });
const claims = (entries: Record<string, string>): HolderClaimOf => (w) => entries[w];

describe("effectiveHolder", () => {
  it("OWN CLAIM → THE LINKED WALLET", () => {
    assert.deepEqual(effectiveHolder(A, proofOf(W), claims({ [W]: A })), { address: W, source: "linked" });
  });

  it("A PROOF WHOSE CLAIM ANOTHER ACCOUNT HOLDS → THE LOGIN WALLET, never the proof", () => {
    assert.deepEqual(effectiveHolder(A, proofOf(W), claims({ [W]: B })), { address: A, source: "login" });
  });

  it("A PROOF NOBODY HAS CLAIMED YET IS A SIGNATURE, NOT A HOLDING → the login wallet", () => {
    // Before the backfill reaches it, or after its claim was released. Counting
    // it would let two accounts with the same unclaimed proof both count.
    assert.deepEqual(effectiveHolder(A, proofOf(W), claims({})), { address: A, source: "login" });
  });

  it("LOGIN CLAIMED BY ANOTHER ACCOUNT AND NO OWN CLAIM → NOTHING", () => {
    // B linked A's login wallet (only possible with A's own signature): it
    // powers B now, and cannot also count here.
    assert.equal(effectiveHolder(A, null, claims({ [A]: B })), null);
    assert.equal(effectiveHolder(A, proofOf(W), claims({ [A]: B, [W]: B })), null, "…nor through a proof B holds");
  });

  it("but an own claim still counts when the login is someone else's", () => {
    assert.deepEqual(effectiveHolder(A, proofOf(W), claims({ [A]: B, [W]: A })), { address: W, source: "linked" });
  });

  it("NO PROOF → THE LOGIN WALLET", () => {
    assert.deepEqual(effectiveHolder(A, null, claims({})), { address: A, source: "login" });
    assert.deepEqual(effectiveHolder(A, undefined, claims({})), { address: A, source: "login" });
  });

  it("a login this account claimed itself (it linked its own wallet) still counts", () => {
    assert.deepEqual(effectiveHolder(A, proofOf(A), claims({ [A]: A })), { address: A, source: "linked" });
    assert.deepEqual(effectiveHolder(A, null, claims({ [A]: A })), { address: A, source: "login" });
  });

  it("case never decides it: tenant, claim and lookup are compared lower-cased", () => {
    const upperA = A.toUpperCase().replace("0X", "0x");
    const seen: string[] = [];
    const lookup: HolderClaimOf = (w) => {
      seen.push(w);
      return w === W ? upperA : undefined;
    };
    assert.deepEqual(effectiveHolder(upperA, proofOf(W), lookup), { address: W, source: "linked" });
    assert.ok(seen.every((w) => w === w.toLowerCase()), "the lookup is always asked about a lower-cased wallet");
  });

  it("a malformed proof falls through to the login rule, never to balanceOf", () => {
    assert.deepEqual(effectiveHolder(A, { address: "0xnothex", at: 1 }, claims({ "0xnothex": A })), {
      address: A,
      source: "login",
    });
    assert.deepEqual(effectiveHolder(A, { address: W }, claims({ [W]: A })), { address: A, source: "login" });
  });

  it("an empty claim is no claim", () => {
    assert.deepEqual(effectiveHolder(A, null, claims({ [A]: "" })), { address: A, source: "login" });
  });

  it("an account that is not an address gets nothing, never a garbage holderAddress", () => {
    assert.equal(effectiveHolder("not-an-address", null, claims({})), null);
    assert.equal(effectiveHolder("", proofOf(W), claims({ [W]: "" })), null);
  });
});

/**
 * THE RULE'S OWN WORDS MATCH HOW A CLAIM IS MADE. This header is where a
 * reader learns what a claim is, and it said claims were "taken first-come" —
 * the rule before a fresh signature by the wallet could MOVE a claim
 * (settings-store takeHolder). A reader who believed it would think a
 * squatter's claim was permanent, or that the first account wins a dispute.
 * The web's copy of the rule (holder-wallet.ts) says the same.
 */
describe("how a claim is made, as the rule's comment tells it", () => {
  const src = readFileSync(new URL("./holder-proof.ts", import.meta.url), "utf8");
  const web = readFileSync(new URL("../../../web/src/lib/holder-wallet.ts", import.meta.url), "utf8");

  it("NOT FIRST-COME: a fresh signature by the wallet moves it, once in any rolling 24 hours, the wallet's own login exempt", () => {
    for (const text of [src, web]) {
      assert.doesNotMatch(text, /first-come|first come/i);
      assert.match(text, /mov(e|ed) (there )?(from another\s+\*\s+account )?/);
      assert.match(text, /rolling\s+(\*\s+)?24 hours/);
      assert.match(text, /own sign-in account/);
    }
    assert.match(src, /takeHolder/, "names where the move is made");
  });
});
