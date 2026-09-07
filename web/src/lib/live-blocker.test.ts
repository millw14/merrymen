/**
 * A REFUSE RULE THE FUNDING SCREEN CANNOT TALK ABOUT IS A SILENT ONE.
 *
 * The worker decides what blocks the live rail; this page only translates the
 * name into something the person looking at a deposit address can act on. That
 * split is right, and it has exactly one failure mode: somebody adds a rule to
 * `exec-mode.ts` and the screen renders nothing for it — which is how an owner
 * ends up funding an account that was never short of money.
 *
 * `no-gas` was added to `RefuseRule` earlier today, and a census once the fleet
 * stopped being killed mid-tick found it is now the LARGEST blocker: 12
 * agents, against 9 wrong-chain, 6 dead-policy and 2 no-cash. That is twelve
 * owners who were reading "Send USDG to your agent's account" and doing it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { ADVISED_RULES, blockerAdvice } from "./live-blocker";

/** Every member of the worker's `RefuseRule` union, read from its source. */
function refuseRules(): string[] {
  const src = readFileSync(new URL("../../../worker/src/exec-mode.ts", import.meta.url), "utf8");
  const at = src.indexOf("export type RefuseRule");
  assert.ok(at > 0, "RefuseRule must be declared in exec-mode.ts");
  const decl = src.slice(at, src.indexOf(";", at));
  const names = [...decl.matchAll(/"([a-z-]+)"/g)].map((m) => m[1]!);
  assert.ok(names.length >= 4, `expected the union's members, parsed ${names.length}`);
  return names;
}

describe("the screen can talk about every blocker there is", () => {
  it("EVERY RefuseRule HAS ADVICE", () => {
    const missing = refuseRules().filter((r) => blockerAdvice(r) === null);
    assert.deepEqual(missing, [], `these blockers would render as nothing: ${missing.join(", ")}`);
  });

  it("and nothing here invents a rule the worker does not have", () => {
    const rules = refuseRules();
    const extra = ADVISED_RULES.filter((r) => !rules.includes(r));
    assert.deepEqual(extra, [], `advice for rules that cannot occur: ${extra.join(", ")}`);
  });

  it("NO-GAS IS THE ONE THIS WAS BUILT FOR, and it says to send ETH", () => {
    const a = blockerAdvice("no-gas");
    assert.ok(a);
    assert.equal(a.funding, true, "money is the fix, so the funding panel must say so");
    assert.match(a.say, /ETH/, "and it must name the asset that is missing");
    assert.ok(!/USDG/.test(a.say), "naming USDG here is what sent owners round the loop again");
  });

  it("and the three that money CANNOT fix say so", () => {
    // The failure this codebase keeps refusing: a screen that looks like it is
    // telling you what to do while being wrong about what would happen. An
    // owner who sends ETH to a wrong-chain agent has spent money for nothing.
    for (const rule of ["dead-policy", "wrong-chain", "not-armed", "no-executor"]) {
      const a = blockerAdvice(rule);
      assert.ok(a, `${rule} has no advice`);
      assert.equal(a.funding, false, `${rule} must not be presented as a funding problem`);
    }
  });
});

describe("what null means", () => {
  it("trading for real, and never beaten, are both silence", () => {
    assert.equal(blockerAdvice(null), null);
    assert.equal(blockerAdvice(undefined), null);
    assert.equal(blockerAdvice(""), null);
  });

  it("AN UNKNOWN RULE IS SILENCE, NOT A GUESS", () => {
    // A newer worker talking to an older page. Inventing advice for a name this
    // build has never seen would be worse than saying nothing.
    assert.equal(blockerAdvice("something-added-next-year"), null);
  });
});

describe("the fact travels from the child to the screen", () => {
  const codeOf = (src: string) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .split(/\r?\n/)
      .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
      .join("\n");
  const at = (p: string) => codeOf(readFileSync(new URL(p, import.meta.url), "utf8"));

  it("the worker writes it on the row it already mirrors", () => {
    // Same channel as `sponsor_gas`, for the same stated reason: only the child
    // resolves it and the dashboard has no other way to learn it.
    const store = at("../../../worker/src/store.ts");
    assert.match(store, /ALTER TABLE agents ADD COLUMN live_blocker TEXT/);
    assert.match(store, /UPDATE agents SET mode = \?, beat_at = \?, sponsor_gas = \?, live_blocker = \?/);
    const index = at("../../../worker/src/index.ts");
    assert.match(index, /setAgentMode\(active\.agentId, mode, at, sponsorGas, blocking\)/);
  });

  it("the mirror carries it to the shared database", () => {
    // A column the child writes and the mirror drops is a column the hosted
    // dashboard can never see — every hosted tenant read IDLE for weeks that way.
    const mirror = at("../../../worker/src/ledger-mirror.ts");
    assert.match(mirror, /sponsor_gas, live_blocker, x_handle/);
    assert.match(mirror, /live_blocker = excluded\.live_blocker/);
    assert.match(mirror, /a\.live_blocker \?\? null/);
  });

  it("and the route hands it to the browser", () => {
    const route = at("../app/api/grants/route.ts");
    assert.match(route, /SELECT mode, beat_at, sponsor_gas, live_blocker FROM agents/);
    assert.match(route, /liveBlocker = row\.live_blocker \?\? null;/);
    assert.match(route, /\n    liveBlocker,\n/);
  });
});
