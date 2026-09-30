import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_NAME_RULE } from "./agent-name-rule";
import { agentNameSave } from "./settings-agent-name";

/**
 * WHAT A SETTINGS SAVE DOES WITH THE NAME IT WAS SENT, given what is stored.
 *
 * The route used to do this inline, so nothing ran the one argument that
 * matters — the STORED name — and passing the wrong one would have stayed
 * green: an owner whose agent is "007" could not have saved any setting.
 */
describe("a settings save's agent name", () => {
  it("re-saving the stored \"007\" keeps it, so every other setting can still be saved", () => {
    assert.deepEqual(agentNameSave("007", { agentName: "007" }), { kind: "set", name: "007" });
    assert.deepEqual(agentNameSave(" 007 ", { agentName: "007" }), { kind: "set", name: "007" }, "in the shape the soul stores");
  });

  it("a letterless name that is not the stored one is refused, in words an owner can comply with", () => {
    for (const stored of [{}, { agentName: "Shogun" }, { agentName: "007" }]) {
      const name = stored.agentName === "007" ? "99.5" : "007";
      assert.deepEqual(agentNameSave(name, stored), { kind: "error", message: `name: ${AGENT_NAME_RULE}` });
    }
  });

  it("the stored name is judged by the rule it was stored under, not waved through", () => {
    assert.deepEqual(agentNameSave("@007", { agentName: "@007" }), { kind: "error", message: `name: ${AGENT_NAME_RULE}` });
    assert.equal(agentNameSave("007", { agentName: 7 }).kind, "error", "a stored value that is not a name grandfathers nothing");
  });

  it("stores a new name in the soul's shape", () => {
    assert.deepEqual(agentNameSave("  Little   John ", {}), { kind: "set", name: "Little John" });
    assert.deepEqual(agentNameSave("José", { agentName: "007" }), { kind: "set", name: "José" });
  });

  it("empty, null or whitespace clears back to the default; anything not a string is refused", () => {
    for (const v of ["", "   ", null, undefined]) assert.deepEqual(agentNameSave(v, { agentName: "Shogun" }), { kind: "clear" });
    for (const v of [7, true, ["Shogun"], { name: "Shogun" }]) assert.equal(agentNameSave(v, { agentName: "Shogun" }).kind, "error");
  });
});
