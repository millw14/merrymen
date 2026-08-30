import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * THE PRE-SUBMIT REASON STRING, tested by RUNNING it rather than by a fixture.
 *
 * index.ts builds the reason for a failure that never reached the chain as
 * `couldn't submit: ${msg.replace(/\s+/g, " ").slice(0, 80)}`. A refactor on
 * this branch dropped one backslash — `/s+/g` — which does not collapse
 * whitespace, it deletes every letter "s". "insufficient funds for gas" became
 * "in ufficient fund  for ga ", in the one row that explains why a first real
 * operation failed, and unsearchable afterwards.
 *
 * Nothing caught it: the only nearby test used a hand-written
 * "couldn't submit: AA21" fixture, which cannot exercise the expression that
 * produced it. So this extracts the expression FROM THE SOURCE and runs it.
 * That is uglier than importing a function, and it is the point — the bug was
 * in a line with no seam, and adding the test without adding the seam is what
 * keeps the assertion honest about what it covers.
 */

/** Pull the live expression out of index.ts and evaluate it on a message. */
function reasonFor(msg: string): string {
  const src = readFileSync("worker/src/index.ts", "utf8");
  const line = src.split(/\r?\n/).find((l) => l.includes("couldn't submit: ${msg"));
  assert.ok(line, "the pre-submit reason line must exist");
  const expr = line.slice(line.indexOf("`"), line.lastIndexOf("`") + 1);
  return new Function("msg", `return ${expr};`)(msg) as string;
}

test("REGRESSION: whitespace is collapsed, and letters are not deleted", () => {
  // Real bundler text. Under /s+/g every one of these loses its s's.
  const cases = [
    "insufficient funds for gas * price + value",
    "UserOperation reverted during simulation with reason: AA21 didn't pay prefund",
    "HTTP request failed.\n\nStatus: 429\nURL: https://api.pimlico.io",
  ];
  for (const raw of cases) {
    const out = reasonFor(raw);
    assert.ok(out.startsWith("couldn't submit: "), out);
    const body = out.slice("couldn't submit: ".length);
    // The words a human or a grep would look for must survive intact.
    for (const word of raw.split(/\s+/).slice(0, 3)) {
      if (word.length > 3 && body.length >= raw.length) {
        assert.ok(body.includes(word), `"${word}" must survive — got: ${body}`);
      }
    }
    assert.equal(/\n/.test(body), false, "newlines must be collapsed, not stored raw");
    assert.equal(/ {2}/.test(body), false, "runs of whitespace must collapse to one space");
  }
});

test("REGRESSION: the letter s specifically survives", () => {
  // The narrowest statement of the bug, so a future reader does not have to
  // infer it from the cases above.
  const out = reasonFor("sssss");
  assert.match(out, /sssss/);
});

test("the reason is bounded, because reject_rule is not a log", () => {
  const out = reasonFor("x".repeat(500));
  assert.ok(out.length <= "couldn't submit: ".length + 80);
});
