import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { llmAgentTurn, llmText, resolveLlm, type AgentMsg } from "./llm";
import { mergeSettings } from "./settings";

/** Build a ResolvedConfig from a settings patch, ignoring env. */
const cfg = (file: Record<string, unknown>) => mergeSettings(file as never, {});

test("legacy auto: anthropic key beats groq key", () => {
  const creds = resolveLlm(cfg({ anthropicApiKey: "sk-ant", groqApiKey: "gsk_x" }));
  assert.equal(creds?.provider, "anthropic");
  assert.equal(creds?.transport, "anthropic");
  assert.equal(creds?.vision, true);
});

test("legacy auto: groq key alone → groq (openai transport)", () => {
  const creds = resolveLlm(cfg({ groqApiKey: "gsk_x" }));
  assert.equal(creds?.provider, "groq");
  assert.equal(creds?.transport, "openai");
  assert.equal(creds?.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(creds?.model, "llama-3.3-70b-versatile");
});

test("no keys, no selection → null (deterministic degrade)", () => {
  assert.equal(resolveLlm(cfg({})), null);
});

test("explicit openai selection uses llmApiKey + catalog defaults", () => {
  const creds = resolveLlm(cfg({ llmProvider: "openai", llmApiKey: "sk-openai" }));
  assert.equal(creds?.provider, "openai");
  assert.equal(creds?.transport, "openai");
  assert.equal(creds?.baseUrl, "https://api.openai.com/v1");
  assert.equal(creds?.model, "gpt-4o-mini");
  assert.equal(creds?.apiKey, "sk-openai");
  assert.equal(creds?.vision, true);
});

test("llmProviderModel overrides the provider default (vendor id with slash/case)", () => {
  const creds = resolveLlm(
    cfg({ llmProvider: "together", llmApiKey: "tk", llmProviderModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo" }),
  );
  assert.equal(creds?.model, "meta-llama/Llama-3.3-70B-Instruct-Turbo");
});

test("groq selected still reads the classic groqApiKey/groqModel", () => {
  const creds = resolveLlm(cfg({ llmProvider: "groq", groqApiKey: "gsk_x", groqModel: "llama-3.1-8b-instant" }));
  assert.equal(creds?.provider, "groq");
  assert.equal(creds?.apiKey, "gsk_x");
  assert.equal(creds?.model, "llama-3.1-8b-instant");
});

test("anthropic selected reads the classic anthropicApiKey/llmModel", () => {
  const creds = resolveLlm(cfg({ llmProvider: "anthropic", anthropicApiKey: "sk-ant", llmModel: "claude-haiku-4-5" }));
  assert.equal(creds?.transport, "anthropic");
  assert.equal(creds?.apiKey, "sk-ant");
  assert.equal(creds?.model, "claude-haiku-4-5");
});

test("ollama needs no key", () => {
  const creds = resolveLlm(cfg({ llmProvider: "ollama" }));
  assert.equal(creds?.provider, "ollama");
  assert.equal(creds?.transport, "openai");
  assert.equal(creds?.baseUrl, "http://localhost:11434/v1");
  assert.equal(creds?.apiKey, "");
});

test("custom needs both base URL and model, else falls through", () => {
  // missing URL/model → not usable → falls through to legacy (here: null)
  assert.equal(resolveLlm(cfg({ llmProvider: "custom", llmApiKey: "k" })), null);
  const creds = resolveLlm(
    cfg({ llmProvider: "custom", llmApiKey: "k", llmBaseUrl: "https://my-host/v1", llmProviderModel: "my-model" }),
  );
  assert.equal(creds?.baseUrl, "https://my-host/v1");
  assert.equal(creds?.model, "my-model");
});

test("selected-but-unkeyed provider falls through to a classic key", () => {
  // picked OpenAI but never keyed it; a groq key is present → still get a brain
  const creds = resolveLlm(cfg({ llmProvider: "openai", groqApiKey: "gsk_x" }));
  assert.equal(creds?.provider, "groq");
});

// ── generic OpenAI-compatible transport hits <baseUrl>/chat/completions ──────
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("llmText posts to <baseUrl>/chat/completions with a Bearer header", async () => {
  let seenUrl = "";
  let seenAuth: string | null = null;
  globalThis.fetch = (async (url: string, init: { headers?: Record<string, string> }) => {
    seenUrl = url;
    seenAuth = init.headers?.Authorization ?? null;
    return { ok: true, json: async () => ({ choices: [{ message: { content: "hello" } }] }) };
  }) as never;

  const creds = resolveLlm(cfg({ llmProvider: "deepseek", llmApiKey: "sk-deep" }))!;
  const out = await llmText(creds, { system: "s", prompt: "p" });
  assert.equal(out, "hello");
  assert.equal(seenUrl, "https://api.deepseek.com/chat/completions");
  assert.equal(seenAuth, "Bearer sk-deep");
});

test("llmAgentTurn (openai transport): converts history + parses tool calls", async () => {
  let sentBody: {
    messages: { role: string; content?: string | null; tool_call_id?: string; tool_calls?: unknown[] }[];
    tools: { function: { name: string } }[];
    tool_choice?: unknown;
  } | null = null;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    sentBody = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "on it",
              tool_calls: [{ id: "call_9", function: { name: "run", arguments: '{"command":"git status"}' } }],
            },
          },
        ],
      }),
    };
  }) as never;

  const creds = resolveLlm(cfg({ llmProvider: "openai", llmApiKey: "sk" }))!;
  const messages: AgentMsg[] = [
    { role: "user", text: "check the repo" },
    { role: "assistant", text: "looking", toolUses: [{ id: "call_1", name: "list_dir", input: {} }] },
    { role: "tools", results: [{ id: "call_1", name: "list_dir", output: "src/" }] },
  ];
  const turn = await llmAgentTurn(creds, {
    system: "sys",
    messages,
    tools: [{ name: "run", description: "d", schema: { type: "object" } }],
  });

  assert.equal(turn.text, "on it");
  assert.deepEqual(turn.toolUses, [{ id: "call_9", name: "run", input: { command: "git status" } }]);
  // conversion shape: system first, assistant carries tool_calls, results ride role:"tool"
  const roles = sentBody!.messages.map((m) => m.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "tool"]);
  assert.equal(sentBody!.messages[3]!.tool_call_id, "call_1");
  assert.ok(Array.isArray(sentBody!.messages[2]!.tool_calls));
  // multi-tool catalog, model's choice — no forced tool_choice
  assert.equal(sentBody!.tool_choice, undefined);
});

test("keyless (ollama) sends no Authorization header", async () => {
  let seenAuth: string | null = "unset";
  globalThis.fetch = (async (_url: string, init: { headers?: Record<string, string> }) => {
    seenAuth = init.headers?.Authorization ?? null;
    return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
  }) as never;

  const creds = resolveLlm(cfg({ llmProvider: "ollama" }))!;
  await llmText(creds, { system: "s", prompt: "p" });
  assert.equal(seenAuth, null);
});
