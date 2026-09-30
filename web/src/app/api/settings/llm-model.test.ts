import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { MerrymenSettings } from "@merrymen/core";
import { resolveLlm } from "../../../../../worker/src/llm";
import { mergeSettings } from "../../../../../worker/src/settings";
import { providerChange, providerModelChange, providerModelValue } from "@/lib/settings-llm-model";

let home: string;
let PUT: (req: Request) => Promise<Response>;
const saved = { home: process.env.MERRYMEN_HOME, hosted: process.env.MERRYMEN_HOSTED };

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-settings-llm-model-"));
  process.env.MERRYMEN_HOME = home;
  delete process.env.MERRYMEN_HOSTED;
  ({ PUT } = await import("./route"));
});
after(() => {
  for (const [key, value] of [["MERRYMEN_HOME", saved.home], ["MERRYMEN_HOSTED", saved.hosted]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const file = () => path.join(home, "settings.json");
const stored = () => JSON.parse(readFileSync(file(), "utf8")) as MerrymenSettings;
const seed = (settings: MerrymenSettings) => writeFileSync(file(), JSON.stringify(settings));
const resolved = () => resolveLlm(mergeSettings(stored(), {}));
const put = async (body: unknown) => {
  const response = await PUT(new Request("http://localhost/api/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  assert.equal(response.status, 200, await response.text());
};

// These fake credentials only resolve a configuration. No inference or trade runs.
const keys = { llmApiKey: "test-generic-key", anthropicApiKey: "test-anthropic-key", groqApiKey: "test-groq-key" };

describe("the settings model is the worker's model", () => {
  it("an existing generic GPT override on Anthropic stays visible until the owner edits it", async () => {
    seed({ ...keys, llmProvider: "anthropic", llmModel: "claude-saved-model", llmProviderModel: "gpt-5.6-luna" });
    assert.equal(providerModelValue(stored(), "anthropic"), "gpt-5.6-luna");
    assert.equal(resolved()?.model, providerModelValue(stored(), "anthropic"));

    await put(providerModelChange("anthropic", "claude-chosen-model"));
    assert.equal(resolved()?.model, "claude-chosen-model");
    assert.equal(resolved()?.apiKey, keys.anthropicApiKey);
    assert.equal(stored().llmProviderModel, undefined);
    assert.equal(providerModelValue(stored(), "anthropic"), resolved()?.model);
  });

  it("switching OpenAI to Anthropic clears the previous provider's override atomically", async () => {
    seed({ ...keys, llmProvider: "openai", llmProviderModel: "gpt-5.6-luna", llmModel: "claude-saved-model" });
    const edit = providerChange("anthropic");
    assert.equal(providerModelValue({ ...stored(), ...edit }, "anthropic"), "claude-saved-model");
    await put(edit);
    assert.equal(resolved()?.provider, "anthropic");
    assert.equal(resolved()?.model, "claude-saved-model");
    for (const key of Object.keys(keys) as (keyof typeof keys)[]) assert.equal(stored()[key], keys[key]);
  });

  it("a non-form provider-only PATCH also cannot carry the old provider's override", async () => {
    seed({ ...keys, llmProvider: "openai", llmProviderModel: "gpt-5.6-luna", groqModel: "qwen/qwen3.8-27b" });
    await put({ llmProvider: "groq" });
    assert.equal(resolved()?.provider, "groq");
    assert.equal(resolved()?.model, "qwen/qwen3.8-27b");
    assert.equal(stored().llmProviderModel, undefined);
  });

  it("an active legacy model edit replaces a stale override for non-form clients too", async () => {
    seed({ ...keys, llmProvider: "anthropic", llmProviderModel: "gpt-5.6-luna" });
    await put({ llmModel: "claude-chosen-model" });
    assert.equal(resolved()?.model, "claude-chosen-model");
  });

  it("an explicit generic model in the same save keeps its documented precedence", async () => {
    seed({ ...keys, llmProvider: "openai", llmProviderModel: "previous-model" });
    await put({ llmProvider: "anthropic", llmModel: "claude-saved-model", llmProviderModel: "claude-explicit-model" });
    assert.equal(resolved()?.model, "claude-explicit-model");
    assert.equal(providerModelValue(stored(), "anthropic"), resolved()?.model);
  });

  it("an unrelated save or an inactive provider's edit preserves a chosen override", async () => {
    seed({ ...keys, llmProvider: "openai", llmProviderModel: "gpt-owner-choice" });
    await put({ llmProvider: "openai", llmModel: "claude-inactive-model", agentName: "Vector" });
    assert.equal(resolved()?.model, "gpt-owner-choice");
  });

  it("echoing an unchanged legacy field in an unrelated save keeps an explicit override", async () => {
    seed({ ...keys, llmProvider: "anthropic", llmProviderModel: "claude-owner-choice", llmModel: "claude-legacy-model" });
    await put({ llmProvider: "anthropic", llmModel: "claude-legacy-model", agentName: "Vector" });
    assert.equal(resolved()?.model, "claude-owner-choice");
  });

  it("editing Groq supports catalog IDs with vendor slashes and uppercase", async () => {
    seed({ ...keys, llmProvider: "groq", llmProviderModel: "old-override" });
    for (const model of ["qwen/qwen3.8-27b", "vendor/Future_Model:1"]) {
      await put(providerModelChange("groq", model));
      assert.equal(resolved()?.model, model);
      assert.equal(providerModelValue(stored(), "groq"), model);
    }
  });

  it("custom and future models remain explicit choices, never a static allowlist", async () => {
    seed({ ...keys, llmProvider: "custom", llmBaseUrl: "https://model.example/v1" });
    const model = "private/Future_Model:2";
    await put(providerModelChange("custom", model));
    assert.equal(resolved()?.model, model);
    assert.equal(resolved()?.baseUrl, "https://model.example/v1");
  });

  it("choosing default deliberately clears both override and legacy field", async () => {
    seed({ ...keys, llmProvider: "anthropic", llmProviderModel: "old-override", llmModel: "old-legacy-model" });
    await put(providerModelChange("anthropic", ""));
    assert.equal(stored().llmProviderModel, undefined);
    assert.equal(stored().llmModel, undefined);
    assert.equal(providerModelValue(stored(), "anthropic"), "");
    assert.equal(resolved()?.model, mergeSettings({}, {}).llmModel);
  });
});
