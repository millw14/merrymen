import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/** Repo root, from packages/core/src. */
const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

import {
  UNDERIVED_ADDRESS,
  accountsMatch,
  assertDerivedAccount,
  derivationOf,
  derivationUnreachable,
} from "./derivation";

const REAL = "0x3E34E58e39DC6614e047dFD3BAD5B7DEA45DCd62";
const OTHER = "0x1102b20c835ff07DCA4eDC15F0B4C7d805bbB22F";

describe("a derived account address is a result, not a string", () => {
  it("a real address derives", () => {
    const d = derivationOf(REAL);
    assert.equal(d.ok, true);
    assert.equal(d.ok && d.address, REAL.toLowerCase());
  });

  it("THE ZERO ADDRESS IS NOT AN ACCOUNT", () => {
    // What createKernelAccount returns when getSenderAddress does not answer.
    // It is a well-formed address, which is exactly why every syntactic check
    // in the codebase used to wave it through.
    const d = derivationOf(UNDERIVED_ADDRESS);
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.failure, "zero");
  });

  it("every spelling of nothing is refused, and each under the right arm", () => {
    // The first version of this test looped over three byte-identical strings,
    // because zero has no letters and so no checksummed variant — it proved
    // none of the three things it named. These genuinely differ.
    const zeroLike: [unknown, "zero" | "malformed"][] = [
      [UNDERIVED_ADDRESS, "zero"],
      ["0x" + "0".repeat(40), "zero"],
      ["0X" + "0".repeat(40), "malformed"], // capital X fails the shape test
      ["0x" + "0".repeat(64), "malformed"], // a 32-byte word, not an address
      ["0x0", "malformed"],
      ["0", "malformed"],
      [" " + UNDERIVED_ADDRESS, "malformed"], // not trimmed on the way in
    ];
    for (const [value, arm] of zeroLike) {
      const d = derivationOf(value);
      assert.equal(d.ok, false, String(value));
      assert.equal(d.ok === false && d.failure, arm, String(value));
    }
  });

  it("anything that is not 20 hex bytes is malformed, not an address", () => {
    for (const bad of [undefined, null, "", "0x", "not-an-address", "0x123", 42, {}, [REAL]]) {
      const d = derivationOf(bad);
      assert.equal(d.ok, false, String(bad));
      assert.equal(d.ok === false && d.failure, "malformed", String(bad));
    }
  });

  it("an unreachable derivation is its own failure, and carries a bounded reason", () => {
    const d = derivationUnreachable("x".repeat(1000));
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.failure, "unreachable");
    assert.ok(d.ok === false && d.why.length <= 300);
  });
});

describe("two failed derivations must never compare equal", () => {
  /**
   * THE BUG THIS FILE EXISTS FOR.
   *
   * The browser derives the account and the server re-derives it, and the
   * hosted custody boundary is the equality between them. Both call the same
   * SDK against the same chain, so when the Kernel factory does not answer they
   * fail IDENTICALLY — and an equality test on the returned strings then says
   * the account is verified. The fault does not make the check fail; it makes
   * the check pass.
   */
  it("browser derives zero, server derives zero, and that is NOT a match", () => {
    const server = derivationOf(UNDERIVED_ADDRESS); // what the route computed
    const browser = UNDERIVED_ADDRESS; // what the grant claimed
    // The raw comparison the code used to make would have been true:
    assert.equal(UNDERIVED_ADDRESS.toLowerCase() === browser.toLowerCase(), true);
    // The one it makes now is not:
    const m = accountsMatch(server, browser);
    assert.equal(m.ok, false);
    assert.match(m.ok === false ? m.why : "", /zero address/);
  });

  it("an unreachable derivation cannot be matched against anything, including itself", () => {
    const m = accountsMatch(derivationUnreachable("rpc timeout"), REAL);
    assert.equal(m.ok, false);
  });

  it("a real derivation still matches its own claim", () => {
    assert.equal(accountsMatch(derivationOf(REAL), REAL).ok, true);
    assert.equal(accountsMatch(derivationOf(REAL), REAL.toLowerCase()).ok, true);
  });

  it("a real derivation refuses a different claim", () => {
    const m = accountsMatch(derivationOf(REAL), OTHER);
    assert.equal(m.ok, false);
    assert.match(m.ok === false ? m.why : "", /does not derive/);
  });

  it("a real derivation refuses a zero CLAIM as well as a zero derivation", () => {
    // The other direction: the server derived fine, the client claimed zero.
    const m = accountsMatch(derivationOf(REAL), UNDERIVED_ADDRESS);
    assert.equal(m.ok, false);
  });
});

describe("the signer refuses to seal a grant around a zero", () => {
  it("assertDerivedAccount throws on zero, and names what failed", () => {
    assert.throws(
      () => assertDerivedAccount(UNDERIVED_ADDRESS, "the smart account could not be derived"),
      /the smart account could not be derived/,
    );
  });

  it("assertDerivedAccount returns the lowercased address on success", () => {
    assert.equal(assertDerivedAccount(REAL, "x"), REAL.toLowerCase());
  });
});

describe("every derivation call site routes through the guard", () => {
  // Source-reading, because the property is "nobody returns account.address
  // raw" and that cannot be asserted from behaviour without a live chain.

  it("the server-side deriver returns a Derivation, never a bare address", () => {
    const src = read("web/src/lib/derive-account.ts");
    assert.match(src, /Promise<Derivation>/, "deriveKernelAccountAddress must return a result type");
    assert.match(src, /return derivationOf\(account\.address\)/);
    assert.doesNotMatch(src, /return account\.address;/, "a bare address would skip the zero check");
  });

  it("the hosted grant intake compares with accountsMatch, not with ===", () => {
    const src = read("web/src/app/api/grants/route.ts");
    assert.match(src, /accountsMatch\(derived, grant\.smartAccount\)/);
    assert.doesNotMatch(
      src,
      /derived\.toLowerCase\(\)\s*!==\s*grant\.smartAccount\.toLowerCase\(\)/,
      "a raw string comparison is what two zeros satisfy",
    );
  });

  it("the recovery ticket refuses to mint on a failed derivation", () => {
    const src = read("web/src/app/api/recover/ticket/route.ts");
    assert.match(src, /if \(!derived\.ok\) return NextResponse\.json\(\{ error: derived\.why \}/);
  });

  it("EVERY createKernelAccount in the tree is followed by an assert", () => {
    // Hand-listing the files is what let the phone signer ship unguarded while
    // this suite stayed green. Enumerate instead.
    const roots = ["web/src", "worker/src", "packages/core/src", "mobile/src"];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(rel);
      }
    };
    for (const r of roots) walk(r);

    const unguarded: string[] = [];
    let examined = 0;
    for (const f of files) {
      const src = read(f);
      if (!src.includes("createKernelAccount(")) continue;
      examined += 1;
      // derive-account.ts returns the result itself rather than asserting.
      if (src.includes("return derivationOf(account.address)")) continue;
      const derivations = [...src.matchAll(/await createKernelAccount\(/g)].length;
      const asserts = [...src.matchAll(/assertDerivedAccount\(/g)].length;
      if (asserts < derivations) unguarded.push(`${f} (${derivations} derivations, ${asserts} asserts)`);
    }
    // Non-vacuity: a walk that finds nothing would pass silently, which is the
    // failure mode of every enumerating test.
    assert.ok(examined >= 4, `expected several derivation sites, examined ${examined}`);
    assert.deepEqual(unguarded, [], `these derive an account without asserting it: ${unguarded.join(", ")}`);
  });

  it("the browser signer asserts the account before the wall is pinned to it", () => {
    const src = read("web/src/lib/session.ts");
    const guard = src.indexOf("assertDerivedAccount(sudoOnlyAccount.address");
    const wall = src.indexOf("buildWallPolicies({");
    assert.ok(guard > 0, "the sudo-only derivation must be asserted");
    assert.ok(wall > 0);
    assert.ok(guard < wall, "the assert must come BEFORE the wall pins value to that address");
  });

  it("all four of session.ts's derivations are asserted, not just the first", () => {
    const src = read("web/src/lib/session.ts");
    assert.match(src, /assertDerivedAccount\(sudoOnlyAccount\.address/);
    assert.match(src, /assertDerivedAccount\(account\.address, "the permissioned account/);
    assert.match(src, /assertDerivedAccount\(account\.address, "that owner key does not derive/);
    // And the preview keeps EIP-55 casing rather than the lowercase the guard
    // normalises to — it is rendered beside addresses that are checksummed.
    assert.match(src, /return \{ smartAccount: account\.address, owner: ownerAccount\.address \};/);
  });

  it("the worker refuses to arm against a zero, on both sides of its own equality", () => {
    const src = read("worker/src/session-account.ts");
    assert.match(src, /assertDerivedAccount\(derived\.address/);
    assert.match(src, /assertDerivedAccount\(params\.accountParams\.accountAddress/);
  });
});
