/**
 * EXECUTION IS DISCONNECTED BY ABSENCE, and this is what checks it.
 *
 * The shadow path's guarantee is not a flag someone can flip — it is that these
 * modules do not import or call the execution machinery at all. Connecting
 * execution later has to ADD an import, which shows up in a diff and needs a
 * reason given.
 *
 * COMMENTS ARE STRIPPED FIRST. The modules describe what they will not do, in
 * prose, using the names of the things they will not do — and the first version
 * of this check failed on its own documentation. What is under review is code.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SHADOW_MODULES = ["brain-shadow", "brain-client", "brain-trigger", "brain-enabled"];

const FORBIDDEN_IMPORTS = ["./proposals", "./policy", "./executor", "./simulate", "./wall", "./intents"];
const FORBIDDEN_CALLS = [
  "proposalsToIntents",
  "checkPolicy",
  "simulateSwap",
  "sendUserOp",
  "buildCalldata",
  "executeIntent",
];

/** Source with comments removed, so prose about execution is not read as execution. */
function codeOnly(mod: string): string {
  const raw = readFileSync(new URL("./" + mod + ".ts", import.meta.url), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

describe("the shadow path cannot reach execution", () => {
  for (const mod of SHADOW_MODULES) {
    it(mod + " imports nothing that can move money", () => {
      const code = codeOnly(mod);
      const modules = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const bad of FORBIDDEN_IMPORTS) {
        const hit = modules.find((m) => m === bad || m.endsWith(bad.slice(1)));
        assert.equal(hit, undefined, mod + " imports " + bad + " — the shadow path must not reach execution");
      }
    });

    it(mod + " calls no execution function", () => {
      const code = codeOnly(mod);
      for (const fn of FORBIDDEN_CALLS) {
        assert.doesNotMatch(code, new RegExp("\\b" + fn + "\\s*\\("), mod + " calls " + fn);
      }
    });
  }

  it("the tick guards the shadow path and defaults to nobody", () => {
    const raw = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    assert.match(
      raw,
      /if \(shadowBrainEnabledFor\(agentId\) && cfg\.brainUrl && cfg\.brainToken/,
      "three guards: the agent is named AND the house configured a Brain",
    );
  });

  it("the tick does nothing with the outcome but log it", () => {
    // The decision is persisted inside runShadow and dropped here. If a future
    // edit routes `outcome` onward, this is the line that notices.
    const raw = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const from = raw.indexOf("const outcome = await runShadow(");
    assert.ok(from > 0, "the tick still calls runShadow");
    const block = raw.slice(from, from + 700).replace(/\/\/[^\n]*/g, " ");
    for (const fn of FORBIDDEN_CALLS) {
      assert.doesNotMatch(block, new RegExp("\\b" + fn + "\\b"), "the outcome reaches " + fn);
    }
  });
});
