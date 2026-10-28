import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { llmAgentTurn, llmText, REASONING_ON_MIN_TOKENS, resetReasoningRefusalsForTest, resolveLlm, type AgentMsg, type LlmCreds } from "./llm";
import { MERRYMEN_GATEWAY_ORIGIN } from "../../packages/core/src/index";
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
  assert.equal(creds?.model, "qwen/qwen3.8-27b");
});

test("no keys, no selection → null (deterministic degrade)", () => {
  assert.equal(resolveLlm(cfg({})), null);
});

test("Merrymen AI (holder provider) resolves to the gateway with the pasted token", () => {
  const creds = resolveLlm(cfg({ llmProvider: "merrymen", llmApiKey: "mmk_holdertoken" }));
  assert.equal(creds?.provider, "merrymen");
  assert.equal(creds?.transport, "openai");
  assert.equal(creds?.baseUrl, `${MERRYMEN_GATEWAY_ORIGIN}/v1`);
  assert.equal(creds?.apiKey, "mmk_holdertoken");
  assert.equal(creds?.model, "merrymen-fast"); // gateway overrides server-side
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

// ── llmText's per-call settings (the X writer's; 2026-10-18) ─────────────────
// Every other caller passes neither, and must send exactly what it sent before.

const GROQ = (model: string): LlmCreds => ({ provider: "groq", transport: "openai", baseUrl: "https://api.groq.com/openai/v1", apiKey: "gsk_x", model, vision: false });

/** Answer every request with `answer(body)`, keeping each body sent. */
function serve(bodies: Record<string, unknown>[], answer: (body: Record<string, unknown>) => { status: number; json: unknown }) {
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    bodies.push(body);
    const { status, json } = answer(body);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as never;
}
const OK = { status: 200, json: { choices: [{ finish_reason: "stop", message: { content: "ok" } }] } };
const GROQ_REFUSES_NONE = { status: 400, json: { error: { message: "`reasoning_effort` must be one of `low`, `medium`, or `high`", type: "invalid_request_error" } } };

test("llmText still sends temperature 0.6 when no temperature is given, and a caller's own when one is", async () => {
  const bodies: Record<string, unknown>[] = [];
  serve(bodies, () => OK);
  await llmText(GROQ("llama-3.3-70b-versatile"), { system: "s", prompt: "p" });
  await llmText(GROQ("llama-3.3-70b-versatile"), { system: "s", prompt: "p", temperature: 0.8 });
  await llmText(GROQ("llama-3.3-70b-versatile"), { system: "s", prompt: "p", temperature: 0 });
  // One a provider would refuse is the default, never sent as written.
  await llmText(GROQ("llama-3.3-70b-versatile"), { system: "s", prompt: "p", temperature: 7 });
  await llmText(GROQ("llama-3.3-70b-versatile"), { system: "s", prompt: "p", temperature: Number.NaN });
  assert.deepEqual(bodies.map((b) => b.temperature), [0.6, 0.8, 0, 0.6, 0.6]);
  assert.deepEqual(bodies.map((b) => b.max_tokens), [400, 400, 400, 400, 400], "the default budget is unchanged");
});

test("without reasoning \"off\", the hint is quietReasoning's model list, as before: none sent for trading's qwen, both fields for gpt-oss", async () => {
  resetReasoningRefusalsForTest();
  const bodies: Record<string, unknown>[] = [];
  serve(bodies, () => OK);
  await llmText(GROQ("qwen/qwen3.8-27b"), { system: "s", prompt: "p", maxTokens: 200 });
  await llmText(GROQ("openai/gpt-oss-120b"), { system: "s", prompt: "p" });
  assert.ok(!("reasoning_effort" in bodies[0]!), "trading's qwen gets no hint it did not get before");
  assert.equal(bodies[0]!.max_tokens, 200);
  assert.equal(bodies[1]!.reasoning_effort, "none");
  assert.equal(bodies[1]!.include_reasoning, false);
});

test("reasoning \"off\" sends reasoning_effort none alone, steps down once on a 400 that names it, and raises the budget", async () => {
  resetReasoningRefusalsForTest();
  try {
    const bodies: Record<string, unknown>[] = [];
    serve(bodies, () => OK);
    assert.equal(await llmText(GROQ("qwen/qwen3.8-27b"), { system: "s", prompt: "p", maxTokens: 200, reasoning: "off" }), "ok");
    assert.equal(bodies[0]!.reasoning_effort, "none");
    assert.ok(!("include_reasoning" in bodies[0]!));
    assert.equal(bodies[0]!.max_tokens, 200);

    // Refused: the cheapest effort the refusal names, with room to think; one retry.
    bodies.length = 0;
    serve(bodies, (b) => (b.reasoning_effort === "none" ? GROQ_REFUSES_NONE : OK));
    assert.equal(await llmText(GROQ("qwen/qwen3.8-27b"), { system: "s", prompt: "p", maxTokens: 200, reasoning: "off" }), "ok");
    assert.deepEqual(bodies.map((b) => [b.reasoning_effort, b.max_tokens]), [["none", 200], ["low", REASONING_ON_MIN_TOKENS]]);
    assert.equal(REASONING_ON_MIN_TOKENS, 700);
    // A caller's larger budget is kept, never lowered.
    bodies.length = 0;
    await llmText(GROQ("qwen/qwen3.8-27b"), { system: "s", prompt: "p", maxTokens: 1000, reasoning: "off" });
    assert.deepEqual(bodies.map((b) => [b.reasoning_effort, b.max_tokens]), [["low", 1000]], "remembered: straight to the step");

    // PER MODEL: another model on the same URL still asks for none, and trading's shared hint is untouched.
    bodies.length = 0;
    serve(bodies, () => OK);
    await llmText(GROQ("qwen3-32b"), { system: "s", prompt: "p", maxTokens: 200, reasoning: "off" });
    await llmText(GROQ("openai/gpt-oss-120b"), { system: "s", prompt: "p" });
    assert.equal(bodies[0]!.reasoning_effort, "none");
    assert.equal(bodies[1]!.reasoning_effort, "none", "a writer's refusal never switches off trading's hint");
    assert.equal(bodies[1]!.include_reasoning, false);
  } finally {
    resetReasoningRefusalsForTest();
  }
});

test("reasoning \"off\": a refusal naming no lower effort drops the field; a second refusal is thrown — never a loop", async () => {
  resetReasoningRefusalsForTest();
  try {
    const bodies: Record<string, unknown>[] = [];
    const noEffort = { status: 400, json: { error: { message: "`reasoning_effort` is not supported with this model", type: "invalid_request_error" } } };
    serve(bodies, (b) => ("reasoning_effort" in b ? noEffort : OK));
    assert.equal(await llmText(GROQ("qwen/qwen3.8-27b"), { system: "s", prompt: "p", maxTokens: 200, reasoning: "off" }), "ok");
    assert.deepEqual(bodies.map((b) => ["reasoning_effort" in b, b.max_tokens]), [[true, 200], [false, 700]]);

    resetReasoningRefusalsForTest();
    bodies.length = 0;
    serve(bodies, () => GROQ_REFUSES_NONE);
    await assert.rejects(llmText(GROQ("qwen/qwen3.8-27b"), { system: "s", prompt: "p", maxTokens: 200, reasoning: "off" }), /groq 400/);
    assert.deepEqual(bodies.map((b) => b.reasoning_effort), ["none", "low"], "one step down in a call, never a third request");
    // The step the second refusal named is remembered, not taken: the next call starts with no field.
    // Nothing left to refuse there: a 400 naming the field is thrown as it came, with no retry.
    bodies.length = 0;
    await assert.rejects(llmText(GROQ("qwen/qwen3.8-27b"), { system: "s", prompt: "p", maxTokens: 200, reasoning: "off" }), /groq 400/);
    assert.equal(bodies.length, 1);

    // A stepped-down effort refused later on: dropped for the call after, never retried within one.
    resetReasoningRefusalsForTest();
    bodies.length = 0;
    serve(bodies, (b) => (b.reasoning_effort === "none" ? GROQ_REFUSES_NONE : OK));
    await llmText(GROQ("qwen/qwen3.8-27b"), { system: "s", prompt: "p", maxTokens: 200, reasoning: "off" });
    serve(bodies, (b) => ("reasoning_effort" in b ? noEffort : OK));
    assert.equal(await llmText(GROQ("qwen/qwen3.8-27b"), { system: "s", prompt: "p", maxTokens: 200, reasoning: "off" }), "ok");
    assert.deepEqual(bodies.map((b) => [b.reasoning_effort ?? null, b.max_tokens]), [["none", 200], ["low", 700], ["low", 700], [null, 700]]);

    // A 400 that does not name the field is a real error: no retry.
    resetReasoningRefusalsForTest();
    bodies.length = 0;
    serve(bodies, () => ({ status: 400, json: { error: { message: "messages: invalid role", code: "bad_request" } } }));
    await assert.rejects(llmText(GROQ("qwen/qwen3.8-27b"), { system: "s", prompt: "p", maxTokens: 200, reasoning: "off" }), /groq 400 — bad_request: messages: invalid role/);
    assert.equal(bodies.length, 1);
  } finally {
    resetReasoningRefusalsForTest();
  }
});

test("reasoning \"off\" is not switched off by trading's shared refusal of the hint on the same URL", async () => {
  resetReasoningRefusalsForTest();
  try {
    const bodies: Record<string, unknown>[] = [];
    // Groq refuses gpt-oss's "none": the shared set learns the URL.
    serve(bodies, (b) => (b.reasoning_effort === "none" && String(b.model).includes("gpt-oss") ? GROQ_REFUSES_NONE : OK));
    await llmText(GROQ("openai/gpt-oss-120b"), { system: "s", prompt: "p" });
    bodies.length = 0;
    await llmText(GROQ("qwen/qwen3.8-27b"), { system: "s", prompt: "p", maxTokens: 200, reasoning: "off" });
    assert.equal(bodies[0]!.reasoning_effort, "none", "qwen3 takes none on the same URL");
    assert.equal(bodies.length, 1);
  } finally {
    resetReasoningRefusalsForTest();
  }
});
