import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SETTINGS_DEFAULTS, SLIPPAGE_BPS_MAX } from "../../packages/core/src/index";
import { minOutWithSlippage } from "./venues/uniswap";

/**
 * THE CEILING IS A PRODUCT POLICY, AND IT HAS TO LIVE IN ONE PLACE.
 *
 * It was 5,000 bps — a minOut of half the trade — written as a literal in a web
 * route's validation table and again in the worker's resolver, where an
 * out-of-range value SILENTLY fell back to the default rather than being
 * refused. Two enforcement points for a rule that was never written down, and a
 * third check (`minOutWithSlippage`) twice as permissive again because its job
 * is only to stop a negative minOut.
 *
 * These tests are about the seams rather than the number: a ceiling that lives
 * in three literals is one careless edit from being three different ceilings.
 */

test("the ceiling is low enough that a fill still resembles the quote", () => {
  assert.equal(SLIPPAGE_BPS_MAX, 1_000);
  // The number that motivates it: at the old ceiling, minOut was half the quote.
  assert.equal(minOutWithSlippage(1_000_000n, 5_000), 500_000n);
  // At this one, a fill can come in 10% light and no further.
  assert.equal(minOutWithSlippage(1_000_000n, SLIPPAGE_BPS_MAX), 900_000n);
});

test("the default sits well inside it, so the ceiling is a bound and not a setting", () => {
  assert.ok(
    SETTINGS_DEFAULTS.slippageBps < SLIPPAGE_BPS_MAX,
    "a default at the ceiling would mean the ordinary case is the worst allowed case",
  );
  assert.equal(SETTINGS_DEFAULTS.slippageBps, 100);
});

test("NO OVERRIDE CHANNEL — not an env var, not a setting, not a flag", () => {
  // The whole point. A ceiling a running agent can raise for itself is not a
  // ceiling, and every mechanism this repo has for widening a bound is one the
  // agent's own configuration can reach. So the constant must be referenced,
  // never read from anywhere.
  const src = [
    "packages/core/src/settings.ts",
    "worker/src/settings.ts",
    "web/src/app/api/settings/route.ts",
  ].map((f) => readFileSync(f, "utf8"));

  for (const [i, text] of src.entries()) {
    const line = text.split(/\r?\n/).find((l) => /SLIPPAGE_BPS_MAX\s*=/.test(l));
    if (i === 0) {
      assert.ok(line, "core declares it");
      assert.match(line, /=\s*1_000;/, "as a literal, with no env fallback");
    } else {
      assert.equal(line, undefined, "and nothing else redeclares it");
    }
  }
  // No MERRYMEN_* escape hatch anywhere near it.
  assert.equal(
    /MERRYMEN_[A-Z_]*SLIPPAGE[A-Z_]*MAX/.test(src.join("\n")),
    false,
    "an env var here would let the deployment out-vote the policy",
  );
});

test("both enforcement points import the constant rather than restating it", () => {
  // The failure this prevents is silent: the web route REJECTS out of range
  // while the worker FALLS BACK to the default, so two different numbers would
  // not disagree loudly — a hand-edited settings.json would simply behave
  // differently from the same value typed into the dashboard.
  const worker = readFileSync("worker/src/settings.ts", "utf8");
  const route = readFileSync("web/src/app/api/settings/route.ts", "utf8");

  assert.match(worker, /slippageBps: num\([^)]*SLIPPAGE_BPS_MAX\)/);
  assert.match(route, /slippageBps: \[1, SLIPPAGE_BPS_MAX\]/);
  for (const [name, text] of [["worker", worker], ["route", route]] as const) {
    assert.equal(/slippageBps[^\n]*5_000/.test(text), false, `${name} must not carry the old literal`);
  }
});

test("minOutWithSlippage is a sanity check, not the bound — and stays that way", () => {
  // Its guard is >= 10_000, i.e. it only prevents a zero or negative floor. That
  // is correct for what it is and must not be mistaken for a policy: a value
  // between the ceiling and 10,000 is unreachable through configuration, so if
  // one ever arrives here it came from code, and throwing is right.
  assert.doesNotThrow(() => minOutWithSlippage(1_000n, 9_999));
  assert.throws(() => minOutWithSlippage(1_000n, 10_000));
  assert.throws(() => minOutWithSlippage(1_000n, -1));
});
