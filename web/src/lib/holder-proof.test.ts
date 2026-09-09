/**
 * A CLAIM BECOMES AN AUTHORISATION ONLY WHEN IT IS PROVEN.
 *
 * "it can happen that you don't own tokens in your privy based wallet and you
 * have them somewhere else… the app should have the possibility to define the
 * holder address if it's not the 'default' privy wallet address."
 *
 * The reason that could not simply be a text box is the reason this flow
 * exists. `settings.holderAddress` is self-declared — shape-checked and nothing
 * more — so anyone could name a whale's wallet and take their tier; /api/alpha
 * refuses to use it as an authorisation input, in as many words. The
 * orchestrator then began overwriting it with the session-verified tenant,
 * which made the tier earnable and shut out this exact case.
 *
 * So the wallet signs, and the tests that matter are the ones about what the
 * signature is worth: whom it names, where it may be replayed, and who is
 * allowed to write the result.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";

import { holderProofMessage, isHolderProof } from "@merrymen/core";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

const TENANT = "0x1111111111111111111111111111111111111111";
const ORIGIN = "https://app.merrymen.dev";

describe("the signed text binds everything a replay would need to change", () => {
  it("IT NAMES THE ACCOUNT, so the signature is worthless to anyone else", () => {
    // Without the tenant the message says "I control this wallet" and nothing
    // more — captured anywhere, it would link that wallet to ANY account that
    // replayed it. This is the same job the DID does in bindingMessage's privy
    // arm.
    const m = holderProofMessage({ holder: "0xaBc", tenant: TENANT, origin: ORIGIN, nonce: "n1" });
    assert.match(m, /merrymen account: 0x1111111111111111111111111111111111111111/);
  });

  it("and the wallet, the origin and the nonce", () => {
    const m = holderProofMessage({ holder: "0xAAA", tenant: TENANT, origin: ORIGIN, nonce: "n1" });
    assert.match(m, /Holder wallet: 0xaaa/, "addresses are lower-cased before signing");
    assert.match(m, /URI: https:\/\/app\.merrymen\.dev/);
    assert.match(m, /Nonce: n1/);
  });

  it("AND IT PROMISES NOTHING, because a trading app asking for a signature owes that", () => {
    const m = holderProofMessage({ holder: "0xa", tenant: TENANT, origin: ORIGIN, nonce: "n" });
    assert.match(m, /moves no funds/);
    assert.match(m, /grants no trading permission/);
    assert.match(m, /only ever read/);
  });

  it("and two different accounts get two different messages", () => {
    const a = holderProofMessage({ holder: "0xa", tenant: TENANT, origin: ORIGIN, nonce: "n" });
    const b = holderProofMessage({ holder: "0xa", tenant: "0x2222222222222222222222222222222222222222", origin: ORIGIN, nonce: "n" });
    assert.notEqual(a, b);
  });
});

describe("a real signature recovers to the wallet that made it", () => {
  it("ROUND TRIP: sign, recover, match", async () => {
    const account = privateKeyToAccount(`0x${"7".repeat(64)}`);
    const message = holderProofMessage({
      holder: account.address,
      tenant: TENANT,
      origin: ORIGIN,
      nonce: "n1",
    });
    const signature = await account.signMessage({ message });
    const recovered = await recoverMessageAddress({ message, signature });
    assert.equal(recovered.toLowerCase(), account.address.toLowerCase());
  });

  it("AND A SIGNATURE FOR ANOTHER ACCOUNT DOES NOT VERIFY HERE", async () => {
    // The replay this is built to stop: the same wallet, the same nonce, a
    // different merrymen account in the text.
    const account = privateKeyToAccount(`0x${"7".repeat(64)}`);
    const forOther = holderProofMessage({
      holder: account.address,
      tenant: "0x2222222222222222222222222222222222222222",
      origin: ORIGIN,
      nonce: "n1",
    });
    const signature = await account.signMessage({ message: forOther });
    const ours = holderProofMessage({ holder: account.address, tenant: TENANT, origin: ORIGIN, nonce: "n1" });
    const recovered = await recoverMessageAddress({ message: ours, signature });
    assert.notEqual(recovered.toLowerCase(), account.address.toLowerCase());
  });
});

describe("only the verifying route may write a proof", () => {
  it("THE SETTINGS PUT HANDLER HAS NO BRANCH FOR IT", () => {
    // The whole scheme collapses if a tenant can PUT the field they could
    // otherwise only earn. The handler writes named keys explicitly and ignores
    // the rest, so absence IS the guard — and this is what notices the day
    // somebody adds one for convenience.
    const src = read("../app/api/settings/route.ts");
    assert.ok(!src.includes("holderProof"), "settings must never accept a holder proof");
  });

  it("and the route recovers the address rather than believing the body", () => {
    const src = read("../app/api/holder/route.ts");
    assert.match(src, /recoverMessageAddress\(\{ message, signature/);
    assert.match(src, /recovered\.toLowerCase\(\) !== holder\.toLowerCase\(\)/);
  });

  it("AND THE NONCE IS BURNED BEFORE THE SIGNATURE IS EXAMINED", () => {
    // A failed verification must not leave a live nonce for a second attempt
    // with a different address.
    // Scoped to the POST handler: both names also appear in the import list at
    // the top, where their order means nothing.
    const src = read("../app/api/holder/route.ts");
    const post = src.slice(src.indexOf("export async function POST"), src.indexOf("export async function DELETE"));
    const consume = post.indexOf("consumeChallengeNonce(");
    const recover = post.indexOf("recoverMessageAddress(");
    assert.ok(consume > 0 && recover > 0, "both steps must be in the handler");
    assert.ok(consume < recover, "consume the nonce before examining the signature");
  });

  it("and the message is built from the SESSION's tenant, never the body", () => {
    const src = read("../app/api/holder/route.ts");
    assert.match(src, /holderProofMessage\(\{ holder, tenant, origin, nonce \}\)/);
    assert.ok(!/tenant\s*=\s*body\./.test(src), "the account must not come from the caller");
  });
});

describe("the worker trusts the proof and nothing else", () => {
  it("A PROVEN WALLET OUTRANKS THE LOGIN ONE", () => {
    const orch = read("../../../worker/src/orchestrator.ts");
    assert.match(orch, /const proven = isHolderProof\(settings\.holderProof\) \? settings\.holderProof\.address : null;/);
    assert.match(orch, /holderAddress: \(proven \?\? tenant\)/);
  });

  it("AND THE SELF-DECLARED FIELD IS STILL OVERWRITTEN", () => {
    // `holderAddress` remains typed-in and remains untrusted. If this ever
    // stops being overwritten, the tier goes back to being a claim.
    const orch = read("../../../worker/src/orchestrator.ts");
    const line = orch.match(/holderAddress: \([^)]*\)[^,]*,/)?.[0] ?? "";
    assert.ok(!/settings\.holderAddress/.test(line), "the stored address must not be a fallback");
  });

  it("and a malformed proof falls back rather than reaching balanceOf", () => {
    assert.equal(isHolderProof({ address: "0xnothex", at: 1 }), false);
    assert.equal(isHolderProof({ address: `0x${"a".repeat(40)}` }), false);
    assert.equal(isHolderProof(null), false);
    assert.equal(isHolderProof({ address: `0x${"a".repeat(40)}`, at: 1 }), true);
  });

  it("and an upper-case stored address is rejected, since the message signed lower-case", () => {
    assert.equal(isHolderProof({ address: `0x${"A".repeat(40)}`, at: 1 }), false);
  });
});
