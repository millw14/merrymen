/**
 * THE STRATEGIST'S DETERMINISTIC WORDS WERE SILENCED BY ITS OWN NAME.
 *
 * `makeLlmStrategist` calls itself `llm-strategist(<driver>)` — the driver
 * suffix is genuinely useful in the operator log, where it says which engine
 * answered. But `index.ts` filed every decision under
 * `strategy:${strategy.name}`, so the publication key became
 * `strategy:llm-strategist(anthropic:claude-opus-4)`, which appears in neither
 * PUBLISHABLE_STRATEGIES nor SOURCE_POLICY. An absent key means publish nothing.
 *
 * The model's OWN words were never affected — they are filed under `strategist`
 * and always published. What vanished was the strategist's deterministic
 * renderWhy output: every stop-floor and take-profit exit reason, and
 * `model-held`, the sentence written specifically so the strategist would stop
 * looking like a quiet tick. The line that exists to end its silence was the
 * line being silenced.
 *
 * WHAT THIS FILE FIXES, AND WHAT IT DELIBERATELY DOES NOT.
 *
 * Fixed: the driver suffix. A publication key that changes when somebody swaps
 * the model is broken whatever the trust policy says, so `publicationSourceFor`
 * strips it and both index.ts sites go through it.
 *
 * NOT fixed: the silence itself. Publishing those rows means giving
 * `llm-strategist` a policy key, and `web/src/lib/thesis.test.ts` pins its
 * absence on purpose — its decisions publish as `strategist`, at MODEL trust,
 * capped and address-checked, rather than the uncapped trust the strategy list
 * grants. Closing the gap widens a boundary somebody drew deliberately in a
 * product that moves real money, so it is a decision to be taken, not a tidy-up
 * to be performed in passing. The gap is pinned below so it cannot be lost.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { PUBLISHABLE_SOURCES, PUBLISHABLE_STRATEGIES, publicationSourceFor } from "./thesis-policy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("a strategy's engine is not part of its identity", () => {
  it("STRIPS THE DRIVER SUFFIX — swapping models must not change the publication key", () => {
    assert.equal(
      publicationSourceFor("llm-strategist(anthropic:claude-opus-4)"),
      "strategy:llm-strategist",
    );
    assert.equal(publicationSourceFor("llm-strategist(groq:llama-3.3-70b)"), "strategy:llm-strategist");
  });

  it("and leaves a plain name alone", () => {
    assert.equal(publicationSourceFor("steady-basket"), "strategy:steady-basket");
    assert.equal(publicationSourceFor("dip-hunter"), "strategy:dip-hunter");
  });

  it("and the strategist's deterministic words are STILL unpublished — on purpose, for now", () => {
    /**
     * NOT A PASSING GRADE. This pins a KNOWN GAP so it cannot be forgotten, and
     * so that closing it is a deliberate act rather than a side effect.
     *
     * `thesis.test.ts` pins that `llm-strategist` is absent from
     * PUBLISHABLE_STRATEGIES, because its decisions publish as `strategist` —
     * MODEL trust, capped and address-checked — rather than the uncapped trust
     * that list grants. That is a real boundary and it was drawn on purpose.
     *
     * But two sites in index.ts (the idle post, and the ensureDecision
     * fallback) file renderWhy output — OUR words — under the strategy's own
     * name. For a strategist tenant those sentences therefore reach no policy
     * key and publish nothing, including `model-held`, the line written
     * specifically so the strategist would stop looking like a quiet tick.
     *
     * Closing it means choosing: list the name at strategy trust, file those
     * two rows under `strategist` instead, or mint a separate mechanical key.
     * All three change what a reader is told about provenance, so none of them
     * is a cleanup.
     */
    const source = publicationSourceFor("llm-strategist(anthropic:claude-opus-4)");
    assert.ok(
      !PUBLISHABLE_SOURCES.includes(source),
      "if this now passes, the gap was closed — delete this test and say which way it went",
    );
  });

  it("and index.ts files decisions through the helper, not by template", () => {
    // The bug was a template literal in two places. If either comes back, the
    // suffix returns with it.
    const raw = readFileSync(path.join(__dirname, "index.ts"), "utf8");
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(
      src,
      /source: `strategy:\$\{strategy\.name\}`/,
      "a decision source must go through publicationSourceFor",
    );
    assert.doesNotMatch(src, /ensureDecision\(intent, `strategy:\$\{strategy\.name\}`/);
    assert.match(src, /publicationSourceFor\(strategy\.name\)/);
  });
});

/**
 * THE DRIFT GUARD. Every strategy this repo can build must map to a source the
 * publication policy knows, or its reasons vanish with no error anywhere — which
 * is precisely how the strategist stayed silent without anyone noticing.
 */
describe("no strategy can be published into the void", () => {
  it("every builtin strategy name resolves to a recognised source", () => {
    const dir = path.join(__dirname, "strategies");
    const names = new Set<string>();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = readFileSync(path.join(dir, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of src.matchAll(/^\s*name: "([a-z0-9-]+)",/gm)) names.add(m[1]!);
    }
    assert.ok(names.size >= 3, `expected to find builtin strategy names, found ${[...names].join(", ")}`);

    for (const name of names) {
      assert.ok(
        PUBLISHABLE_SOURCES.includes(publicationSourceFor(name)),
        `strategy "${name}" publishes nothing: strategy:${name} is absent from SOURCE_POLICY. ` +
          `Add it to PUBLISHABLE_STRATEGIES, or state in that list why its reasons must not be shown.`,
      );
    }
  });

  it("and this file agrees with thesis.test.ts about where the strategist publishes", () => {
    // Two tests in two packages assert the same boundary from opposite sides.
    // If one is ever relaxed without the other, they contradict rather than
    // drift — which is the point of stating it twice.
    assert.ok(
      !(PUBLISHABLE_STRATEGIES as readonly string[]).includes("llm-strategist"),
      "web/src/lib/thesis.test.ts pins this absence; change both or neither",
    );
  });
});
