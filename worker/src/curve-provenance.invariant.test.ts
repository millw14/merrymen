import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * WHERE `discovered_pools.curve` IS ALLOWED TO COME FROM.
 *
 * `knownCurves()` reads every non-null `curve` in that table and hands the list
 * to the policy mirror, where it is the ONLY thing standing between an agent and
 * an arbitrary contract calling itself a bonding curve. The wall cannot pin the
 * curve — it is a new address per launch, ~475 an hour — so this table IS the
 * provenance check, and its trustworthiness is entirely a property of who writes
 * to it.
 *
 * Today exactly one producer does: the Pons launch scan, which enumerates
 * launches from the FACTORY and therefore vouches for what it records. Nothing
 * about `recordCandidate`'s signature says so. It takes an optional `curve`
 * object like any other field, and a second discoverer — a trending feed, a
 * third-party JSON API, a user-supplied address — could start passing one
 * tomorrow with no test failing and no reviewer necessarily noticing. The list
 * would then still be called "curves seen in a factory-filtered launch" while
 * containing curves nobody filtered.
 *
 * THE CLASS ROUTE RAISES THE STAKES RATHER THAN CREATING THEM. For an ordinary
 * curve trade both legs are enumerated in the signed grant, so a bogus curve
 * still cannot reach an asset the owner never named. A CLASS trade's output leg
 * is deliberately un-enumerated — that is the whole feature — which leaves this
 * table as the last remaining check on what an agent can buy. checkPolicy
 * refuses a class trade outright when the list is unreadable, for the same
 * reason; this test guards the other failure, where the list is readable and
 * wrong.
 *
 * Source-level, because there is no seam: the guarantee is about which code
 * paths exist, not about what any function returns.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string) => readFileSync(`${HERE}${p}`, "utf8");

/** `recordCandidate({ … curve: …})` call sites, with a little context each. */
function curveWrites(src: string): string[] {
  const out: string[] = [];
  const re = /recordCandidate\(\{/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    // Balance braces from the opening `{` so a nested object cannot end the
    // slice early and hide a `curve:` that is really inside this call.
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    const body = src.slice(m.index, i + 1);
    if (/\bcurve:/.test(body)) out.push(body);
  }
  return out;
}

test("only the factory-filtered launch scan may write a curve", () => {
  const index = read("index.ts");
  const writes = curveWrites(index);

  assert.equal(
    writes.length,
    1,
    `exactly one producer may write discovered_pools.curve; found ${writes.length}. ` +
      `A new one is not automatically wrong — but it must enumerate launches from the Pons ` +
      `FACTORY, because knownCurves() is what vouches for a class trade's output token and it ` +
      `cannot tell one writer from another.`,
  );

  // And that one write must be reading the scan's own result, not a token
  // address, a config value, or anything a third party could shape.
  assert.match(
    writes[0]!,
    /curve:\s*d\.curve\.curve/,
    "the recorded curve must come from the launch scan's own discovery record",
  );
});

test("the launch scan filters on the Pons factory before anything is recorded", () => {
  // The claim above is only worth anything if the scan really is
  // factory-filtered. Pinned here so removing the filter fails a test that says
  // why, rather than quietly widening what `knownCurves` vouches for.
  const scan = read("venues/pons.ts");
  assert.match(
    scan,
    /factory/i,
    "the Pons launch scan must filter on the factory — it is the provenance",
  );
});

test("knownCurves stays the only route from this table into the wall", () => {
  // policy.ts must reach curve provenance through AgentLimits and nothing else.
  // A direct query from the policy mirror would make the wall's verdict depend
  // on a database read it cannot see fail — and `limitsFromGrant` deliberately
  // takes the list as an argument so the caller owns that failure.
  const policy = read("policy.ts");
  for (const symbol of ["discovered_pools", "curveFor", "getDb"]) {
    assert.equal(
      policy.includes(symbol),
      false,
      `policy.ts must not reference ${symbol} — provenance arrives as AgentLimits.knownCurves`,
    );
  }
});
