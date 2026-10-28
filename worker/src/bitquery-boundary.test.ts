/**
 * BITQUERY IS SPENT BY ONE PROCESS, AND NO CHILD CAN START SPENDING IT.
 *
 * Two boundaries, pinned where a busy file's edits cannot quietly drop them.
 *
 * THE FAN-OUT BOUNDARY. A hosted child resolves its discovery credentials from
 * the environment alone — the settings fields are house keys stripped from the
 * tenant's file — and discovery defaults on. So any Bitquery credential left in
 * the orchestrator's environment becomes one poller per child, each on its own
 * timer, none of them under the fleet's daily points budget. The strip is what
 * makes "the paid plan is spent by one process" a property of the process
 * boundary rather than of nobody setting a variable.
 *
 * THE SIDE DOOR. The house's brain key reaches every child on purpose (house
 * keys are injected), and the discovery fallback used to read it as a gateway
 * token whenever the brain was the gateway. gatewayTokenForDiscovery refuses
 * exactly that case, and only that case.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

process.env.MERRYMEN_HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-bq-boundary-"));
process.env.MERRYMEN_HOSTED = "1";
process.env.MERRYMEN_BITQUERY_API_KEY = "ory_at_fleet_lane_key_never_to_a_child";
process.env.BITQUERY_API_KEY = "BQY_house_key_never_to_a_child";
process.env.MERRYMEN_TOKEN = "mmk_operator_holder_token_never_to_a_child";
process.env.MERRYMEN_LLM_API_KEY = "house-brain-key";

const { childEnv } = await import("./orchestrator");
const { gatewayTokenForDiscovery } = await import("./venues/bitquery");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, "orchestrator.ts"), "utf8");

describe("no Bitquery credential reaches a child", () => {
  it("CHILD_SECRET_STRIP names all three", () => {
    const i = SRC.indexOf("const CHILD_SECRET_STRIP = [");
    assert.ok(i > 0, "the strip list must exist for this to mean anything");
    const block = SRC.slice(i, SRC.indexOf("] as const;", i));
    for (const key of ["MERRYMEN_BITQUERY_API_KEY", "BITQUERY_API_KEY", "MERRYMEN_TOKEN"]) {
      assert.ok(block.includes(`"${key}"`), `${key} is not stripped from a child's environment`);
    }
  });

  it("childEnv removes them, and still passes the house keys a child is meant to have", () => {
    const env = childEnv("0xABCDef0000000000000000000000000000000001");
    assert.equal(env.MERRYMEN_BITQUERY_API_KEY, undefined, "the fleet lane's key stays in the orchestrator");
    assert.equal(env.BITQUERY_API_KEY, undefined, "a child would poll discovery on the house's plan");
    assert.equal(env.MERRYMEN_TOKEN, undefined, "a child would poll the gateway as the operator's wallet");
    assert.equal(env.MERRYMEN_LLM_API_KEY, "house-brain-key", "the strip is of Bitquery credentials only");
  });
});

describe("the flow broker flag — a child asks only when somebody will answer", () => {
  const T = "0xABCDef0000000000000000000000000000000001";

  it("is set only on the orchestrator's word, never inherited from its environment", () => {
    process.env.MERRYMEN_FLOW_BROKER = "1"; // an operator's fleet-wide copy must not reach a child
    try {
      assert.equal(childEnv(T).MERRYMEN_FLOW_BROKER, undefined);
      assert.equal(childEnv(T, { flowBroker: false }).MERRYMEN_FLOW_BROKER, undefined);
      assert.equal(childEnv(T, { flowBroker: true }).MERRYMEN_FLOW_BROKER, "1");
      assert.equal(childEnv(T, { flowBroker: true }).MERRYMEN_BITQUERY_API_KEY, undefined, "the flag is not the key");
    } finally {
      delete process.env.MERRYMEN_FLOW_BROKER;
    }
  });

  it("spawnChild says it exactly when the broker is attached: the lane is on and the child has the channel", () => {
    const spawn = SRC.slice(SRC.indexOf("async function spawnChild("), SRC.indexOf("attachFlowBroker(flowRuntimeNow().service, tenant, proc, smartAccount, log);"));
    // And never for a Perps worker, which asks the flow lane nothing and gets no channel.
    assert.match(spawn, /flowBroker: !perpsSlot && !fomoBootNow\(\)\.off && flowRuntimeNow\(\)\.service !== null,/);
    assert.match(spawn, /stdio: perpsSlot \|\| fomoBootNow\(\)\.off \? \["ignore", "pipe", "pipe"\] : \["ignore", "pipe", "pipe", "ipc"\],/);
  });
});

describe("gatewayTokenForDiscovery — the side door, closed for the house and open for the owner", () => {
  const house = "mmk_house_brain";

  it("a standalone token always wins", () => {
    assert.equal(gatewayTokenForDiscovery({ merrymenToken: "mmk_own", llmProvider: "merrymen", llmApiKey: house, hosted: true, houseLlmKey: house }), "mmk_own");
  });

  it("hosted: the house's brain key is never read as a discovery token", () => {
    assert.equal(gatewayTokenForDiscovery({ llmProvider: "merrymen", llmApiKey: house, hosted: true, houseLlmKey: house }), undefined);
    assert.equal(gatewayTokenForDiscovery({ llmProvider: "merrymen", llmApiKey: ` ${house} `, hosted: true, houseLlmKey: house }), undefined, "whitespace does not disguise it");
  });

  it("hosted: a tenant's OWN gateway brain key still opens discovery on its own quota", () => {
    assert.equal(gatewayTokenForDiscovery({ llmProvider: "merrymen", llmApiKey: "mmk_tenant", hosted: true, houseLlmKey: house }), "mmk_tenant");
    assert.equal(gatewayTokenForDiscovery({ llmProvider: "merrymen", llmApiKey: "mmk_tenant", hosted: true }), "mmk_tenant");
  });

  it("self-hosted: the house and the owner are one, so nothing changes", () => {
    assert.equal(gatewayTokenForDiscovery({ llmProvider: "merrymen", llmApiKey: house, hosted: false, houseLlmKey: house }), house);
  });

  it("a brain that is not the gateway is never a discovery credential", () => {
    assert.equal(gatewayTokenForDiscovery({ llmProvider: "groq", llmApiKey: "gsk_x", hosted: false }), undefined);
    assert.equal(gatewayTokenForDiscovery({ llmProvider: "merrymen", hosted: false }), undefined);
  });

  it("runDiscovery asks this function, with the house key it inherited", () => {
    const index = readFileSync(path.join(HERE, "index.ts"), "utf8");
    const run = index.slice(index.indexOf("async function runDiscovery("), index.indexOf("async function runDiscovery(") + 1500);
    assert.match(run, /merrymenToken: gatewayTokenForDiscovery\(\{[\s\S]*?hosted: isHostedMode\(\),[\s\S]*?houseLlmKey: process\.env\.MERRYMEN_LLM_API_KEY,/);
    assert.doesNotMatch(run, /cfg\.llmProvider === "merrymen" \? cfg\.llmApiKey/, "the unguarded fallback is gone");
  });
});
