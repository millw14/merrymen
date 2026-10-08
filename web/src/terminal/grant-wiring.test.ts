/**
 * EVERY ADDRESS THE GRANT SCREEN CAN SEAL MUST ACTUALLY BE READ FROM SETTINGS.
 *
 * `ponsClassVaultFactory` was declared as state, typed into the /api/settings
 * response shape at BOTH fetch sites, threaded into all three signing calls,
 * and documented with a comment explaining why it is re-read at click time —
 * and never once assigned. `setClassFactory` appeared exactly once in the whole
 * file: its own declaration.
 *
 * So every grant signed from this screen carried `ponsClassVaultFactory:
 * undefined`. session.ts skips the entire vault block on a falsy factory, no
 * GRANT_PONS_CLASS marker was minted, and the worker's class route returned at
 * `if (!vault)` on every tick, forever, with no log line. A whole feature — the
 * contracts, the wall, the encoder, the dispatch, the operator chain — was
 * unreachable from the only screen that can reach it.
 *
 * Nothing failed. Types were satisfied, because `undefined` is a legal value
 * for an optional field. Only an end-to-end attempt would have caught it, and
 * that attempt costs a signature and real money.
 *
 * These tests read the source, because the alternative is rendering a React
 * screen; what they pin is the wiring, which is exactly what was missing.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const WALLET = readFileSync(new URL("./screens/Wallet.tsx", import.meta.url), "utf8");

/**
 * Every optional address this screen can seal into a wall.
 *
 * Each entry is a field the signer accepts and the worker later depends on. Add
 * a new one to the signing call and it belongs here too — that is the point.
 */
const SEALED_ADDRESSES = [
  { field: "v4AdapterAddress", setter: "setV4Adapter" },
  { field: "ponsAdapterAddress", setter: "setPonsAdapter" },
  { field: "ponsClassVaultFactory", setter: "setClassFactory" },
] as const;

describe("every sealable address is read, not merely declared", () => {
  for (const { field, setter } of SEALED_ADDRESSES) {
    it(`${field} is assigned from the settings response, not left undefined`, () => {
      // A setter that appears ONCE is its own declaration and nothing else,
      // which is precisely the bug this file exists about.
      const uses = (WALLET.match(new RegExp(`${setter}\\(`, "g")) ?? []).length;
      assert.ok(
        uses >= 2,
        `${setter} is declared but never called — ${field} would be sealed as undefined on every grant`,
      );
      // And it must be read from the settings payload, not invented locally.
      assert.match(
        WALLET,
        new RegExp(`values\\?\\.${field}`),
        `${field} must be read out of /api/settings`,
      );
    });

    it(`${field} is validated as an address before it reaches a wall`, () => {
      // A typo must not mint a marker plus a permission pinned at nonsense.
      const near = WALLET.split("\n")
        .filter((l) => l.includes(field) || l.includes(setter))
        .join("\n");
      assert.match(near, /0x\[0-9a-fA-F\]\{40\}/, `${field} must be shape-checked`);
    });
  }

  it("the renew path re-reads all three at CLICK time, not from mount state", () => {
    // The mount fetch predates anything the owner just saved, and re-signing
    // from stale state seals a wall without the thing they added thirty seconds
    // ago. The comment saying so was already in the file for the factory — the
    // code under it was not.
    const renew = WALLET.slice(WALLET.indexOf("async function renewKey"));
    const body = renew.slice(0, renew.indexOf("\n  }"));
    for (const { field } of SEALED_ADDRESSES) {
      assert.match(body, new RegExp(`values\\?\\.${field}`), `renew must re-read ${field}`);
    }
  });

  it("a fresh mint and a restore seal the same set as a renewal", () => {
    // Three call sites, one wall. A field threaded into one and forgotten in
    // another produces agents whose capabilities differ by which button their
    // owner happened to press.
    const calls = (WALLET.match(/ponsClassVaultFactory:/g) ?? []).length;
    assert.ok(calls >= 3, "create, restore and renew must all pass the factory");
    assert.equal(
      (WALLET.match(/ponsAdapterAddress:/g) ?? []).length >= 3,
      true,
      "the same is true of the pons adapter",
    );
  });
});

/**
 * THE PERPETUALS OPT-IN MUST ACTUALLY REACH THE SIGNATURE.
 *
 * The same failure as the factory above, in the one opt-in where it would be
 * worst in BOTH directions. A box declared and never assigned into the mint
 * call means an owner who ticked "perpetuals" signs a wall without them and is
 * told it worked. And the carry-forward that protects a live Lighter account
 * is only as good as the page handing the signer the server's view of the
 * previous grant — a device that never saw the key sealed knows it no other way.
 */
describe("the perpetuals opt-in is wired into the mint, not merely declared", () => {
  const renew = WALLET.slice(WALLET.indexOf("async function renewKey"));
  const body = renew.slice(0, renew.indexOf("\n  }"));

  it("the box is CLOSED by default and set by its control", () => {
    assert.match(WALLET, /const \[perpsOptIn, setPerpsOptIn\] = useState\(false\)/, "the opt-in must start closed");
    for (const setter of ["setPerpsOptIn", "setPerpsDrop"]) {
      const uses = (WALLET.match(new RegExp(`${setter}\\(`, "g")) ?? []).length;
      assert.ok(uses >= 3, `${setter} is declared but never driven by the control`);
    }
    assert.match(WALLET, /onChange=\{\(e\) => void onPerpsToggle\(e\.target\.checked\)\}/, "the checkbox must drive the toggle");
  });

  it("renew mints the key at CLICK time, from the box, and passes it BY NAME into the mint options", () => {
    assert.match(body, /perpSeal = await mintPerpKey\(grant\.smartAccount, purpose\)/, "the key must come from keygen for THIS account");
    assert.match(body, /priorAtClick\.state === "none" && perpsOptIn/, "a key is minted only for a new opt-in the owner ticked");
    const options = body.slice(body.indexOf("const options = {"));
    for (const field of [/perp: perpSeal,/, /previousGrant,/, /perpDrop: perpsDropping,/, /venueFlat: perpsFlat,/]) {
      assert.match(options, field, `the mint options must carry ${field}`);
    }
  });

  it("keygen is asked for the PUBLIC half only, and what comes back is checked before it is sealed", () => {
    assert.match(WALLET, /fetch\(scopedAccountUrl\("\/api\/perps\/keygen", purpose\), \{\s*method: "POST"/);
    assert.match(WALLET, /body: JSON\.stringify\(\{ smartAccount \}\)/);
    assert.match(WALLET, /validatePerpPubKey\(body\.apiPublicKey\)/);
    assert.match(WALLET, /body\.apiKeyIndex !== LIGHTER_ROUTE_V1\.apiKeyIndex/);
    assert.doesNotMatch(WALLET, /apiPrivateKey/, "this page never names, holds or forwards a Lighter private key");
  });

  it("a NEW opt-in is shown only where the server offers it for THIS account; carried perps are always shown", () => {
    // Rollout Phase 1 (and the hosted default MERRYMEN_PERPS=paper): signers do
    // not offer the opt-in. GET /api/grants' `perpsOptIn` is the operator's
    // word; unread or false is not offered, and the answer is bound to the
    // account it was given for.
    assert.match(WALLET, /const \[perpsOfferedFor, setPerpsOfferedFor\] = useState<string \| null>\(null\)/, "not offered until the server says so");
    assert.match(
      WALLET,
      /setPerpsOfferedFor\(s\.exists && s\.perpsOptIn === true && s\.grant\?\.smartAccount \? s\.grant\.smartAccount\.toLowerCase\(\) : null\)/,
      "only an explicit true, for the server's account",
    );
    assert.match(WALLET, /const perpsOffered = !!grant && perpsOfferedFor === grant\.smartAccount\.toLowerCase\(\)/);
    const box = WALLET.indexOf('t("wallet.perps.label")');
    const gate = WALLET.lastIndexOf("{(perpsCarried || perpsOffered) && (", box);
    assert.ok(gate > 0 && box - gate < 200, "the Perpetuals box renders only when carried or offered");
  });

  it("removing carried perps re-reads the venue at click time and proceeds only on flat === true", () => {
    assert.match(WALLET, /\/api\/perps\/flat\?smartAccount=/);
    assert.match(body, /readVenueFlat\(grant\.smartAccount, purpose\)/, "the drop must be re-checked when the owner signs, not only when the box was cleared");
    assert.match(body, /if \(read\.flat !== true\) throw/, "anything but a flat reading refuses the drop");
    assert.match(WALLET, /flat: body\.flat === true \? true : body\.flat === false \? false : null/, "an unreadable venue is never read as flat");
  });

  it("every mint call site hands the signer the server's view of the previous grant", () => {
    // Create (a new account over an armed one), restore and renew: three sites,
    // one rule — a Lighter key the server holds is never lost by a signature
    // made somewhere that did not seal it.
    const calls = (WALLET.match(/previousGrant: await serverGrantNow\(\),|const previousGrant = await serverGrantNow\(\);/g) ?? []).length;
    assert.equal(calls, 3, "create, restore and renew must each read the server's grant at click time");
  });
});
