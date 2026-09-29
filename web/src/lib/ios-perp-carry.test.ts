/**
 * THE iOS HOST HANDS THE SERVER'S PROJECTION TO THE ENGINE (docs/perps.md
 * rules 3 and 5).
 *
 * Perps are enabled on the dashboard only, so the phone's own stored grants
 * never carry them: the one place an iOS re-sign can learn that this account
 * holds a Lighter key is GET /api/grants → `grant` (publicGrantView), which
 * GrantScreen already reads for `expectAccount`. The engine
 * (ios-native/Signing/engine.ts) carries a key forward from `previousGrant`;
 * a host that never passes it signs every renewal WITHOUT the perp block —
 * refused 409 while the venue holds anything, and a silent removal when it
 * happens to be flat.
 *
 * Swift cannot run here, so this pins the source, the circle-strategies
 * precedent. The engine half — that `previousGrant` alone carries the key
 * into the posted grant — is exercised end to end by
 * `node ios-native/Signing/verify-engine.mjs`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.resolve(here, rel), "utf8");

/** The body of one Swift `func`, by brace matching from its declaration. */
function swiftFunc(src: string, name: string): string {
  const at = src.indexOf(`func ${name}(`);
  assert.ok(at >= 0, `func ${name} not found`);
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`func ${name} is unbalanced`);
}

it("GrantScreen.prepareReview passes the server's grant projection as previousGrant", () => {
  const body = swiftFunc(read("../../../ios-native/Sources/GrantScreen.swift"), "prepareReview");
  const branch = body.match(/if let grant \{([^\n]*)\}/);
  assert.ok(branch, "the `if let grant` branch that sets expectAccount");
  assert.match(branch[1] ?? "", /input\["expectAccount"\] = grant\["smartAccount"\]/);
  assert.match(branch[1] ?? "", /input\["previousGrant"\] = grant\b/, "the projection the screen holds must reach the engine");
});

it("activate forwards the reviewed input untouched apart from the review-only keys", () => {
  const body = swiftFunc(read("../../../ios-native/Sources/GrantScreen.swift"), "activate");
  const stripped = body.match(/for key in \[([^\]]*)\] \{ input\.removeValue/);
  assert.ok(stripped, "activate strips a fixed list of review-only keys");
  assert.doesNotMatch(stripped[1] ?? "", /previousGrant/, "previousGrant is signing input, not review-only");
});

it("the engine hands previousGrant to both signing entry points", () => {
  const engine = read("../../../ios-native/Signing/engine.ts");
  assert.match(engine, /createPrivyOwnedWallet\([\s\S]*?previousGrant: input\.previousGrant,[\s\S]*?\}\);/);
  assert.match(engine, /prepareAgentGrant\([\s\S]*?previousGrant: projectionFor\(input\.previousGrant, input\.expectAccount\)/);
});
