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
/** Comments stripped, so a header naming the field it refuses does not trip a pin. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

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

  it("THE WALLET IS CLAIMED AFTER THE SIGNATURE IS RECOVERED AND BEFORE THE PROOF IS STORED", () => {
    // One wallet powers one agent. Claimed before recovery, anyone could squat
    // a wallet they cannot sign for; stored before the claim, the proof would
    // count in two accounts for as long as the gap lasted.
    const src = read("../app/api/holder/route.ts");
    const post = src.slice(src.indexOf("export async function POST"), src.indexOf("export async function DELETE"));
    const consume = post.indexOf("consumeChallengeNonce(");
    const recover = post.indexOf("recoverMessageAddress(");
    const claim = post.indexOf("store.claimHolder(wallet, tenant)");
    const put = post.indexOf("store.put(");
    assert.ok(consume > 0 && recover > consume && claim > recover && put > claim, "nonce, recover, claim, then store");
    assert.match(post, /status: 409/, "another account's wallet is a conflict, not an error");
    assert.match(post, /status: 503/, "and an unreadable store refuses rather than letting a second account in");
  });

  it("AND UNLINKING RELEASES IT, before the proof is dropped", () => {
    const src = read("../app/api/holder/route.ts");
    const del = src.slice(src.indexOf("export async function DELETE"), src.indexOf("export async function PATCH"));
    const release = del.indexOf("store.releaseHolder(gone.address, tenant)");
    const put = del.indexOf("store.put(tenant, rest)");
    assert.ok(release > 0 && put > release, "released first, so a retry can always find the proof again");
  });
});

describe("the worker trusts the proof and nothing else", () => {
  /** writeSettingsForChild's body, from its signature to the next top-level brace. */
  const writeSettings = () => {
    const orch = read("../../../worker/src/orchestrator.ts");
    const at = orch.indexOf("async function writeSettingsForChild(");
    return orch.slice(at, orch.indexOf("\n}\n", at));
  };

  it("A PROVEN WALLET OUTRANKS THE LOGIN ONE — BY ONE RULE, IN THE WORKER AND ON EVERY SCREEN", () => {
    // One $MERRYMEN wallet powers one agent: the orchestrator and
    // holderWalletFor (/api/tier, /api/circle, /api/alpha) both ask
    // effectiveHolder, with the same claims, so they cannot drift apart.
    assert.match(writeSettings(), /\? \(effectiveHolder\(tenant, settings\?\.holderProof \?\? null, \(w\) => claims\.get\(w\)\)\?\.address \?\? null\)/);
    assert.match(writeSettings(), /const forChild: MerrymenSettings = childSettingsFor\(settings, holder\);/);
    assert.match(writeSettings(), /writeChildSettings\(tenant, childSettingsFor\(null, holder\)\)/);
    const wallet = read("./holder-wallet.ts");
    assert.match(wallet, /effectiveHolder\(tenant, proof \?\? null, \(w\) => claims\.get\(w\)\)/);
  });

  it("AND THE SELF-DECLARED FIELD IS NEVER A FALLBACK", () => {
    // `holderAddress` remains typed-in and remains untrusted. If it is ever
    // read here, the tier goes back to being a claim.
    assert.ok(!/settings\??\.holderAddress/.test(code(writeSettings())), "the orchestrator must not read the stored address");
    const helper = code(read("../../../worker/src/holder-claims.ts"));
    const fn = helper.slice(helper.indexOf("export function childSettingsFor("), helper.indexOf("\n}\n", helper.indexOf("export function childSettingsFor(")));
    assert.match(fn, /const \{ holderAddress: _typedIn, \.\.\.rest \} = settings \?\? \{\};/, "dropped first, whatever it says");
    assert.equal(fn.split("_typedIn").length, 2, "and never used after it is dropped");
    assert.ok(!/settings\??\.holderAddress/.test(code(read("./holder-wallet.ts"))), "nor on the screens");
  });

  it("AND A NULL EFFECTIVE HOLDER DELETES THE KEY — the child is never handed a self-declared wallet", () => {
    // Behaviour, not text: the helper the orchestrator writes through.
    // Imported lazily: it is worker code, reached the way the orchestrator
    // reaches it.
    return import("../../../worker/src/holder-claims").then(({ childSettingsFor }) => {
      const typed = { strategy: "trencher", holderAddress: "0x000000000000000000000000000000000000dead" };
      const none = childSettingsFor(typed, null);
      assert.equal("holderAddress" in none, false, "no wallet counts → no key at all");
      assert.equal(none.strategy, "trencher", "and everything else the tenant saved is kept");
      assert.deepEqual(childSettingsFor(null, null), {}, "a tenant who saved nothing and counts no wallet gets an empty file");
      const own = `0x${"b".repeat(40)}` as const;
      assert.equal(childSettingsFor(typed, own).holderAddress, own, "the counted wallet overrides the typed one");
    });
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
