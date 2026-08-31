/**
 * Hosted house-key precedence inversion.
 *
 * Self-hosted, the settings file is the owner's own and wins: file > env >
 * default. Hosted, the connection/credential/endpoint fields are the SERVER's —
 * a tenant's file value for them is stripped before the merge, so the server env
 * wins and a tenant can neither repoint the bundler at their own key nor point
 * our RPC/LLM at an arbitrary endpoint. Non-house fields (strategy, caps…) still
 * come from the file either way.
 *
 * MERRYMEN_HOSTED is toggled per-case and restored; node's --test isolates the
 * file in its own process regardless.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mergeSettings, stripHouseKeys } from "./settings";

afterEach(() => {
  delete process.env.MERRYMEN_HOSTED;
});

describe("hosted mode strips house keys so server env wins", () => {
  const tenantFile = {
    bundlerApiKey: "tenant-bundler-key",
    bundlerUrl: "https://tenant.example/bundler",
    rpcMainnet: "https://tenant.example/rpc",
    groqApiKey: "tenant-groq-key",
    llmBaseUrl: "https://tenant.example/llm",
    // a NON-house field the tenant legitimately owns
    strategy: "weekend-gap",
  } as const;

  it("self-hosted: the file wins (unchanged)", () => {
    delete process.env.MERRYMEN_HOSTED;
    const c = mergeSettings(tenantFile, { MERRYMEN_BUNDLER_API_KEY: "server-bundler-key" });
    assert.equal(c.bundlerApiKey, "tenant-bundler-key", "file wins self-hosted");
    assert.equal(c.rpcMainnet, "https://tenant.example/rpc");
    assert.equal(c.strategy, "weekend-gap");
  });

  it("hosted: house keys come from the server env, not the tenant file", () => {
    process.env.MERRYMEN_HOSTED = "1";
    const c = mergeSettings(tenantFile, {
      MERRYMEN_BUNDLER_API_KEY: "server-bundler-key",
      MERRYMEN_RPC_MAINNET: "https://server/rpc",
      GROQ_API_KEY: "server-groq-key",
    });
    assert.equal(c.bundlerApiKey, "server-bundler-key", "tenant bundler key ignored");
    assert.equal(c.rpcMainnet, "https://server/rpc", "tenant RPC ignored");
    // A TENANT MAY BRING THEIR OWN LLM KEY, hosted or not. The house key is the
    // default, not the ceiling — see HOUSE_KEY_FIELDS. The SSRF-shaped sibling
    // (`llmBaseUrl`) is asserted below and still cannot survive.
    assert.equal(c.groqApiKey, "tenant-groq-key", "a tenant may bring their own LLM key");
    // No server env for these → they resolve to nothing, NOT the tenant's value.
    assert.equal(c.bundlerUrl, undefined, "tenant bundler URL cannot survive");
    assert.equal(c.llmBaseUrl, undefined, "tenant LLM base URL (SSRF vector) cannot survive");
    // A non-house field is still the tenant's.
    assert.equal(c.strategy, "weekend-gap", "the tenant still owns non-house settings");
  });

  it("stripHouseKeys leaves non-house fields intact", () => {
    const stripped = stripHouseKeys(tenantFile);
    assert.equal("bundlerApiKey" in stripped, false);
    assert.equal("rpcMainnet" in stripped, false);
    assert.equal("llmBaseUrl" in stripped, false);
    assert.equal(stripped.strategy, "weekend-gap");
  });
});
