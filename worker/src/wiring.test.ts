/**
 * IS THE GUARD ACTUALLY REACHED?
 *
 * Three defects shipped into a review of this repo in one afternoon, all the
 * same shape: a correct function, a passing unit test, and no call site. The
 * unit tests could not catch any of them, because each one called the guard
 * directly and supplied the argument the production caller was failing to pass.
 *
 *   - `verifyGrantBinding` grew a version dispatch, and the grants route did
 *     not pass `version`. Every claim resolved to the default, so the
 *     unknown-version refusal and the privy-not-implemented refusal were both
 *     unreachable — a grant declaring `privy-did-owner-v1` would have been
 *     verified under LEGACY rules, which is exactly the downgrade the
 *     versioning exists to prevent. `binding-version.test.ts` passed, because
 *     it calls the validator itself.
 *   - `runIdentityAuditIfAsked` was defined and never called. The env var did
 *     nothing.
 *   - The phone signer kept deriving an account with no zero-address guard
 *     while the browser signer gained one.
 *
 * So these are WIRING tests. They assert that the dangerous argument is passed,
 * that a defined entry point is invoked, and that two signers that must refuse
 * the same things actually do. Source-reading, because none of it is observable
 * without a chain and a database.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the binding version reaches the validator", () => {
  it("the grants route passes `version` to verifyGrantBinding", () => {
    const src = read("web/src/app/api/grants/route.ts");
    const call = src.slice(src.indexOf("verifyGrantBinding({"));
    const args = call.slice(0, call.indexOf("});"));
    assert.match(
      args,
      /version:\s*binding\.version/,
      "without this the dispatch is unreachable and every claim resolves to the legacy default",
    );
  });

  it("the route does not decide the version itself", () => {
    // The one place that decides which security model applies is the
    // validator. A route that normalised, defaulted or filtered the version
    // would be making that decision in two places, which is how they drift.
    const src = read("web/src/app/api/grants/route.ts");
    assert.doesNotMatch(src, /binding\.version\s*(\?\?|\|\|)/, "the route must not default the version");
    assert.doesNotMatch(src, /isBindingVersion/, "the route must not validate the version itself");
  });
});

describe("every env-gated report the orchestrator defines is actually run", () => {
  /**
   * A `run…IfAsked` that is never called is an environment variable that does
   * nothing, and it fails silently by construction: the operator sets it, sees
   * no output, and concludes the fleet had nothing to say.
   */
  it("no orchestrator entry point is defined without a call site", () => {
    const src = read("worker/src/orchestrator.ts");
    const defined = [...src.matchAll(/^async function (run\w*IfAsked)\(/gm)].map((m) => m[1]!);
    assert.ok(defined.length >= 3, `expected several env-gated reports, found ${defined.length}`);
    const orphans = defined.filter((name) => {
      // A call site is any occurrence that is not the definition itself.
      const uses = [...src.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length;
      return uses < 2;
    });
    assert.deepEqual(orphans, [], `defined but never called: ${orphans.join(", ")}`);
  });
});

describe("the two signers refuse the same things", () => {
  /**
   * The phone and the dashboard seal the SAME wall — worker/src/wall.test.ts
   * and signer-lockstep.test.ts exist for that reason. A guard added to one and
   * not the other means the two disagree about what a signature may carry, and
   * the disagreement is invisible until a phone seals something the browser
   * would have refused.
   */
  const web = () => read("web/src/lib/session.ts");
  const phone = () => read("mobile/src/crypto/signGrant.ts");

  it("both assert the sudo-only account before the wall is pinned to it", () => {
    for (const [what, src] of [["web", web()], ["phone", phone()]] as const) {
      const guard = src.indexOf('assertDerivedAccount(sudoOnlyAccount.address');
      const wall = src.indexOf("buildWallPolicies({");
      assert.ok(guard > 0, `${what} does not assert the sudo-only derivation`);
      assert.ok(wall > guard, `${what} pins the wall before asserting the address it pins to`);
    }
  });

  it("both assert the permissioned account before the equality that two zeros satisfy", () => {
    for (const [what, src] of [["web", web()], ["phone", phone()]] as const) {
      const guard = src.indexOf("assertDerivedAccount(account.address");
      const equality = src.indexOf("account.address.toLowerCase() !== sudoOnlyAccount.address.toLowerCase()");
      assert.ok(guard > 0, `${what} does not assert the permissioned derivation`);
      assert.ok(equality > guard, `${what} compares two possibly-zero addresses before asserting them`);
    }
  });
});
