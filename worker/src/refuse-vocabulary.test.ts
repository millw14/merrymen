/**
 * EVERY REASON AN AGENT IS NOT TRADING NEEDS A PUBLIC SENTENCE.
 *
 * `execModeOf` produces six RefuseRules. `thesis-policy.ts`'s map carried
 * exactly one of them — `no-gas`. The other five are written into
 * `reject_rule` on every tick a blocked agent proposes anything, and
 * `read-wall-tape.ts` buckets anything outside `REJECT_RULES` into the
 * catch-all. So the sentences explaining an agent doing NOTHING — which is the
 * most common thing an owner asks about — were precisely the ones rendering as
 * unnamed amber, on the public page and in the lane breakdown alike.
 *
 * `web/src/lib/live-blocker.test.ts` already forces the funding screen to cover
 * every RefuseRule. Nothing forced this map. That asymmetry is the whole reason
 * it drifted, and this file is the missing half.
 *
 * Read from SOURCE rather than imported, deliberately: the point is to fail
 * when someone adds a seventh rule and forgets this map, and an import of the
 * type would give a compile error nobody sees in a union of string literals.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { REJECT_RULES } from "./thesis-policy";
import { liveBlockerText } from "./exec-mode";

const SOURCE = readFileSync(new URL("./exec-mode.ts", import.meta.url), "utf8");

/** The RefuseRule union, parsed from the file that declares it. */
const RULES = (() => {
  const decl = /export type RefuseRule =([^;]+);/.exec(SOURCE);
  assert.ok(decl, "RefuseRule must still be a string-literal union in exec-mode.ts");
  const rules = [...decl[1]!.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
  assert.ok(rules.length >= 6, `expected the full union, parsed ${rules.length}`);
  return rules;
})();

describe("the public refusal vocabulary covers every live-rail blocker", () => {
  it("every RefuseRule has a sentence in thesis-policy", () => {
    const known = new Set(REJECT_RULES);
    const missing = RULES.filter((r) => !known.has(r));
    assert.deepEqual(
      missing,
      [],
      `these are reasons an agent is not trading, and they render as unnamed amber: ${missing.join(", ")}`,
    );
  });

  it("and a sentence in the owner-facing feed, which is where they meet it first", () => {
    // The two must both exist. A public page that names a blocker the private
    // feed does not — or the reverse — is two answers to one question.
    for (const rule of RULES) {
      const text = liveBlockerText(rule as Parameters<typeof liveBlockerText>[0]);
      assert.ok(text && text.length > 0, `${rule} has no owner-facing sentence`);
    }
  });

  it("no sentence is the rule slug echoed back", () => {
    // The catch-all's failure mode was rendering nothing useful; the other
    // failure mode is rendering the slug, which is not English either.
    const known = new Set(REJECT_RULES);
    for (const rule of RULES) {
      assert.ok(known.has(rule));
      assert.notEqual(rule, liveBlockerText(rule as Parameters<typeof liveBlockerText>[0]));
    }
  });
});
