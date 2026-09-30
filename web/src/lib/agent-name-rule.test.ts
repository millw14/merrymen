import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { agentNameAccepted } from "./agent-name-rule";

describe("a name already stored keeps the rule it was stored under", () => {
  it("re-saving the form with the agent's existing \"007\" is accepted", () => {
    // The Settings screen sends the whole form on every save. Refusing the
    // name it already holds would block every OTHER setting too.
    assert.equal(agentNameAccepted("007", "007"), true);
    assert.equal(agentNameAccepted("007", "  007 "), true, "compared in the shape the soul stores");
  });

  it("a NEW letterless name still needs a letter", () => {
    assert.equal(agentNameAccepted("007", undefined), false, "nothing stored yet");
    assert.equal(agentNameAccepted("007", "Shogun"), false, "renaming Shogun to 007 is a new choice");
    assert.equal(agentNameAccepted("99.5", "007"), false, "only the stored name itself is grandfathered");
  });

  it("the old rule is still a rule: grandfathering never admits what was never storable", () => {
    assert.equal(agentNameAccepted("@007", "@007"), false);
    assert.equal(agentNameAccepted("0".repeat(25), "0".repeat(25)), false);
  });

  it("an ordinary name passes whatever is stored", () => {
    assert.equal(agentNameAccepted("Shogun", undefined), true);
    assert.equal(agentNameAccepted("Agent 7", "007"), true);
  });
});
