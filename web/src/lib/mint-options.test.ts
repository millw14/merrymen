import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { refusalMessage } from "./session";

/**
 * The bug this file exists to prevent, written down because it shipped.
 *
 * `createAgentWallet` and `restoreAgentWallet` took seven POSITIONAL
 * parameters, four of them optional and three of them the same type. Adding
 * `ponsAdapterAddress` before `hostedAs` shifted every call site by one, so the
 * signed-in wallet address went into the adapter slot and `hostedAs` became
 * undefined. Nothing failed to compile — an optional address is an optional
 * address whatever it is meant to be — and nothing failed a test.
 *
 * The result was two separate faults from one edit. Every newly created hosted
 * wallet was refused by the server, because no `hostedAs` means no binding. And
 * the owner's own wallet address was being sealed into the wall as a Pons
 * adapter: a call target, and a spender named in every approve permission.
 *
 * The structural fix is the options object. These tests pin it, because the
 * next person to add a parameter will not have read the story.
 */

const SESSION_SRC = readFileSync(new URL("./session.ts", import.meta.url), "utf8");
const GRANT_PAGE_SRC = readFileSync(new URL("../terminal/screens/Wallet.tsx", import.meta.url), "utf8");

describe("mint entry points take NAMED options", () => {
  it("createAgentWallet and restoreAgentWallet take an options object", () => {
    assert.match(SESSION_SRC, /export async function createAgentWallet\(o: MintOptions\)/);
    assert.match(SESSION_SRC, /export async function restoreAgentWallet\(\s*ownerPrivateKey: `0x\$\{string\}`,\s*o: MintOptions,/);
  });

  it("no caller passes them positionally", () => {
    // The exact shape that broke: a call whose fifth argument is an adapter and
    // whose sixth is a wallet, distinguishable only by reading the signature.
    //
    // AN OPTIONS OBJECT, INLINE OR HOISTED. The renew site now builds one
    // `options` and hands it to whichever mint entry point the owner needs —
    // that is still one named object, and it is what keeps a Privy re-sign and
    // an owner-key re-sign on ONE set of conditions rather than two. What must
    // never come back is a bare positional argument list.
    const calls = [
      ...GRANT_PAGE_SRC.matchAll(
        /(createAgentWallet|restoreAgentWallet|createPrivyOwnedWallet)\(([\s\S]{0,400}?)\)\s*[;,\n]/g,
      ),
    ];
    assert.ok(calls.length >= 4, `expected every mint call site, found ${calls.length}`);
    for (const [, name, args] of calls) {
      const inline = /onStatus:/.test(args);
      const hoisted = /(^|[\s,])options\s*$/.test(args.trim()) || /,\s*options\s*$/.test(args.trim());
      assert.ok(inline || hoisted, `${name} must take a named options object, not positional args`);
    }
    // And the hoisted one is a real options object, not something reshaped.
    const hoistedLiteral = GRANT_PAGE_SRC.slice(GRANT_PAGE_SRC.indexOf("const options = {"));
    assert.match(hoistedLiteral.slice(0, 900), /onStatus: setStatus/);
    assert.match(hoistedLiteral.slice(0, 900), /hostedAs:/);
  });

  it("every call site that can be hosted passes hostedAs BY NAME", () => {
    // No hostedAs means no binding means the server refuses the wallet. Naming
    // it is what makes that impossible to do by accident.
    const named = (GRANT_PAGE_SRC.match(/hostedAs:/g) ?? []).length;
    assert.equal(named, 3, "all three mint call sites must pass hostedAs by name");
  });

  it("no call site passes an adapter where a wallet belongs", () => {
    // The specific corruption: session.address landing in the adapter slot.
    assert.ok(
      !/v4AdapterAddress:\s*session/.test(GRANT_PAGE_SRC),
      "a session wallet must never be passed as an adapter address",
    );
    assert.ok(
      !/ponsAdapterAddress:\s*session/.test(GRANT_PAGE_SRC),
      "a session wallet must never be passed as an adapter address",
    );
  });
});

describe("refusalMessage", () => {
  it("surfaces the server's OWN reason for a 403", () => {
    // Two different refusals arrive as 403 and need different actions: no
    // binding at all, versus a binding that does not verify. A single
    // hardcoded sentence told the reader their brand-new wallet belonged to
    // someone else, which sent them hunting a wallet mix-up that did not exist
    // and hid the real bug for a whole debugging session.
    const msg = refusalMessage(403, "this grant isn't linked to your login — create it again from a signed-in browser");
    assert.match(msg, /isn't linked to your login/);
    assert.ok(!/isn't owned by the wallet/.test(msg), "must not assert an ownership problem it cannot know about");
  });

  it("still says something useful when the server sent no reason", () => {
    assert.match(refusalMessage(403), /won't arm/);
  });

  it("keeps the actionable text for the other hosted refusals", () => {
    assert.match(refusalMessage(401), /Sign in with your wallet/);
    assert.match(refusalMessage(422), /bug on our side/);
    assert.match(refusalMessage(503), /try again/);
  });

  it("falls through to the server for anything unmapped", () => {
    assert.equal(refusalMessage(500, "boom"), "boom");
    assert.match(refusalMessage(500), /refused the grant \(500\)/);
  });
});

/**
 * The backup gate must be able to SHOW the key it demands you save.
 *
 * A hosted grant deliberately omits the owner key from the object handed to the
 * server — the server is never custodian of one. The page then set its state
 * from that object, so the one screen whose entire purpose is to display the
 * key rendered "(external wallet — no key stored)" while asking the reader to
 * tick "I've saved my owner key somewhere safe."
 *
 * The key was in localStorage the whole time, so reloading the page fixed it —
 * but nobody reloads a page that is telling them to write something down. On a
 * screen about losing funds, that is the worst place for the UI to be wrong.
 */
describe("the backup gate gets the copy with the key", () => {
  it("mint returns a `local` grant distinct from the server one", () => {
    assert.match(SESSION_SRC, /local: Grant;/);
    assert.match(SESSION_SRC, /return \{ grant, local: localGrant, handoff:/);
    // And the server copy still omits the key when hosted — the property that
    // made them different in the first place, and worth keeping. The condition
    // gained a second arm: a PRIVY owner has no key to omit, because merrymen
    // never holds one. Both arms must be present, or a Privy grant would try to
    // attach a `privateKey` field that does not exist on its signer.
    assert.match(SESSION_SRC, /hostedAs \|\| ownerSigner\.binding !== "legacy-wallet-owner-v1"/);
    assert.match(SESSION_SRC, /demoOwnerPrivateKey: ownerSigner\.privateKey/);
  });

  it("every mint call site takes `local`, never the server copy", () => {
    // The renew site branches on which owner can sign — an owner key or a Privy
    // embedded wallet — so the destructure sits above the branch rather than on
    // each arm. Matched on the destructure itself for that reason.
    const sites = [...GRANT_PAGE_SRC.matchAll(/const \{ ([^}]*) \} =\s*\n?\s*(?:await )?(?:resignBy|createAgentWallet|restoreAgentWallet|createPrivyOwnedWallet)/g)];
    assert.ok(sites.length >= 3, `expected the mint call sites, found ${sites.length}`);
    for (const [, destructured] of sites) {
      assert.match(destructured, /local:/, "a mint result must be read as the LOCAL copy — it is the one with the key");
      assert.ok(
        !/(^|\s)grant:/.test(destructured),
        "a mint call site must not put the server-shaped grant into page state",
      );
    }
    // And every mint entry point that can be reached from this page is covered
    // by the loop above rather than sneaking in under a name it does not check.
    for (const fn of ["createAgentWallet", "restoreAgentWallet", "createPrivyOwnedWallet"]) {
      assert.ok(GRANT_PAGE_SRC.includes(`${fn}(`), `${fn} is expected on this page`);
    }
  });

  it("does not claim an external wallet when a key is simply missing", () => {
    // The old fallback explained the absence with something untrue. If the key
    // cannot be read, the honest move is to say so and warn against funding.
    assert.ok(!/external wallet — no key stored/.test(GRANT_PAGE_SRC));
    assert.match(GRANT_PAGE_SRC, /couldn't read your owner key/);
  });
});
