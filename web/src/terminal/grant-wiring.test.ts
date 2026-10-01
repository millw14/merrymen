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
 * These tests pin settings-to-signer wiring. wallet-renewal.test.ts separately
 * renders the screen and checks the failure and renewal behavior.
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
    // A successful fresh read must supply every selected capability. The
    // payload is now validated as a record before individual fields are read;
    // optional chaining on the old payload shape would conceal a failed read.
    const renew = WALLET.slice(WALLET.indexOf("async function renewKey"));
    const body = renew.slice(0, renew.indexOf("\n  }"));
    const optionsAt = body.indexOf("const options = {");
    assert.ok(optionsAt > 0, "renewal builds one set of signing options");
    const settings = body.slice(0, optionsAt);
    assert.match(settings, /await fetch\("\/api\/settings", \{ cache: "no-store" \}\)/);
    assert.match(settings, /if \(!r\.ok\) throw new Error/, "HTTP failure must not reuse mounted settings");
    assert.match(settings, /const body: unknown = await r\.json\(\)/);
    assert.match(settings, /!body\.values \|\| typeof body\.values !== "object" \|\| Array\.isArray\(body\.values\)/);
    assert.match(settings, /const v = body\.values as Record<string, unknown>/, "fields come from the validated fresh payload");
    assert.match(settings, /throw new Error\("Could not refresh your trading settings/, "an unreadable payload must fail closed");

    const freshVariables = {
      v4AdapterAddress: "freshAdapter",
      ponsAdapterAddress: "freshPons",
      ponsClassVaultFactory: "freshClassFactory",
    } as const;
    for (const { field, setter } of SEALED_ADDRESSES) {
      const fresh = freshVariables[field];
      assert.match(settings, new RegExp(`${fresh} = addressSetting\\(v\\.${field}\\)`), `renew must validate and re-read ${field}`);
      assert.match(settings, new RegExp(`${setter}\\(${fresh}\\)`), `renew must display the freshly read ${field}`);
      assert.match(body.slice(optionsAt), new RegExp(`${field}: (?:await verifiedAdapter\\()?${fresh}[,)]`), `renew must seal the freshly read ${field}`);
    }
    assert.match(settings, /v\.customTokens\.every\(isValidCustomToken\)/, "custom tokens use the same validated fresh response");
    assert.match(settings, /freshTokens = \(v\.customTokens \?\? \[\]\) as CustomToken\[\]/);
    assert.match(body.slice(optionsAt), /extraTokens: freshTokens,/, "renewal cannot silently keep the mounted token scope");
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
