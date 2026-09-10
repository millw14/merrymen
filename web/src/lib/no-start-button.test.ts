/**
 * THERE IS NO START BUTTON, AND THERE MUST NOT BE ONE.
 *
 * Once an owner approves and re-signs a grant, the Merryman arms itself: the
 * signed grant is POSTed to /api/grants, the worker's `syncGrant` picks it up on
 * its next pass, and it runs. Nothing waits for a human to press anything.
 *
 * That is a product decision and it is load-bearing, because the alternative
 * fails silently in the worst way: an owner completes the hardest step in the
 * product — generating an owner key, backing it up, funding an account, signing
 * a permission wall — and then their agent sits still because of a control they
 * did not notice. The repo already carries that exact incident from the other
 * direction, in status-line.ts: a user with $318 in the account asking the group
 * chat "Will it now start trading". Adding a button would make that question
 * correct.
 *
 * `canStart` exists and is fine: it drives a READINESS INDICATOR (is this owner
 * finished setting up?), never a gate on execution. This file pins the
 * distinction, because the two are one refactor apart.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
/** Comments stripped — this codebase argues in prose right next to the code. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const CHECKLIST = strip(read("../terminal/SetupChecklist.tsx"));
const WALLET = strip(read("../terminal/screens/Wallet.tsx"));

describe("arming is automatic, and nothing offers to start an agent", () => {
  it("the setup checklist offers only CREATE and FUND", () => {
    // Two steps, both of which the owner genuinely has to do. A third would be
    // a step the software could have taken itself.
    assert.match(CHECKLIST, /Create your agent/);
    assert.match(CHECKLIST, /Add trading funds/);
    for (const forbidden of [/Start trading/i, /Start agent/i, />\s*Start\s*</]) {
      assert.ok(!forbidden.test(CHECKLIST), `the checklist must not offer a start action: ${forbidden}`);
    }
  });

  it("the wallet screen has no start action either", () => {
    for (const forbidden of [/Start trading/i, /Start agent/i, /startAgent/, /\/api\/start/]) {
      assert.ok(!forbidden.test(WALLET), `the wallet must not offer a start action: ${forbidden}`);
    }
  });

  it("there is no start endpoint anywhere for one to call", () => {
    // The cheapest way a button comes back is a route appearing first.
    assert.throws(
      () => read("../app/api/start/route.ts"),
      /ENOENT/,
      "an /api/start route would be the thing a Start button posts to",
    );
  });

  it("canStart is a readiness signal, not an execution gate", () => {
    // Its two callers both use it to decide what to SHOW. If a third ever uses
    // it to decide whether to ARM, an owner who is fully set up but momentarily
    // unreadable stops trading — and `canStart` reads an unreadable balance as
    // false BY DESIGN, which is right for a checklist and catastrophic for a gate.
    const src = read("./can-start.ts");
    assert.match(src, /does not treat an UNREADABLE balance as a funded one/);
    assert.ok(
      !/arm|execute|trade\(/i.test(strip(src).replace(/canStart|can this agent actually begin trading/gi, "")),
      "can-start must not grow an execution concern",
    );
  });
});
