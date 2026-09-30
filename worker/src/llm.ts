/**
 * Provider layer for every LLM call in merrymen — one shape, any backend.
 *
 * Bring any key. The dashboard lists a catalog of providers (LLM_PROVIDERS):
 * Groq (free default), OpenAI, Anthropic, Google Gemini, xAI, DeepSeek, Mistral,
 * OpenRouter, Together, Perplexity, Cerebras, Fireworks, local Ollama, or a
 * fully custom OpenAI-compatible URL. Pick one, paste its key, done.
 *
 * Two transports cover the whole list:
 *   openai    — a bare fetch to <baseUrl>/chat/completions. Every provider above
 *               except Anthropic speaks this. We just vary base URL + key + model.
 *   anthropic — Claude via the official SDK. Best tool-use, and the only backend
 *               that also does screen vision.
 *
 * Resolution: an explicit settings.llmProvider selection wins (with the right key
 * for it). If none is selected — or the selected one has no key yet — we fall back
 * to the legacy auto path: an Anthropic key beats a Groq key. With nothing usable,
 * resolveLlm returns null and callers degrade to deterministic behavior (null
 * driver, slash-only chat).
 *
 * The safety contract is unchanged and provider-agnostic: model decisions use
 * a tool schema (or structured JSON on models without forced tools), then
 * deterministic code validates and disposes. Swapping the brain never widens
 * what it can do.
 */

import Anthropic from "@anthropic-ai/sdk";
import { llmProviderById, type LlmProviderInfo } from "../../packages/core/src/index";
import type { ResolvedConfig } from "./settings";
import { redactSecrets } from "./telegram/agent";

export interface LlmCreds {
  /** Provider id (for logs/telemetry), e.g. "groq" | "openai" | "custom". */
  provider: string;
  /** Which code path talks to it. */
  transport: "anthropic" | "openai";
  /** OpenAI-compatible base (…/v1). Empty for the anthropic transport. */
  baseUrl: string;
  /** May be empty for keyless local runtimes (Ollama). */
  apiKey: string;
  model: string;
  /** Does this brain accept images (screen vision)? */
  vision: boolean;
}

/** Pick the key for a selected provider: groq/anthropic reuse their classic
 * fields (so old setups keep working), everyone else uses the generic llmApiKey. */
function keyFor(p: LlmProviderInfo, cfg: ResolvedConfig): string {
  if (p.id === "groq") return cfg.groqApiKey ?? cfg.llmApiKey ?? "";
  if (p.id === "anthropic") return cfg.anthropicApiKey ?? cfg.llmApiKey ?? "";
  return cfg.llmApiKey ?? "";
}

/** Pick the model: explicit override, else the classic per-provider field, else
 * the provider's catalog default. */
function modelFor(p: LlmProviderInfo, cfg: ResolvedConfig): string {
  const override = cfg.llmProviderModel?.trim();
  if (override) return override;
  if (p.id === "anthropic") return cfg.llmModel || p.defaultModel;
  if (p.id === "groq") return cfg.groqModel || p.defaultModel;
  return p.defaultModel;
}

/** Build creds from an explicit provider selection, or null if it isn't usable
 * yet (missing key / missing custom URL or model). */
function credsFromProvider(p: LlmProviderInfo, cfg: ResolvedConfig): LlmCreds | null {
  const apiKey = keyFor(p, cfg);
  if (p.needsKey !== false && !apiKey) return null;

  const baseUrl = p.id === "custom" ? (cfg.llmBaseUrl ?? "").trim() : p.baseUrl;
  if (p.transport === "openai" && !baseUrl) return null; // custom without a URL

  const model = modelFor(p, cfg);
  if (!model) return null; // custom without a model

  return { provider: p.id, transport: p.transport, baseUrl, apiKey, model, vision: p.vision };
}

/** Which brain (if any) is armed. Explicit selection wins; else legacy auto. */
export function resolveLlm(cfg: ResolvedConfig): LlmCreds | null {
  const selected = llmProviderById(cfg.llmProvider);
  if (selected) {
    const built = credsFromProvider(selected, cfg);
    if (built) return built;
    // Selected but not usable yet — fall through so a classic key still gives a brain.
  }
  if (cfg.anthropicApiKey)
    return { provider: "anthropic", transport: "anthropic", baseUrl: "", apiKey: cfg.anthropicApiKey, model: cfg.llmModel, vision: true };
  if (cfg.groqApiKey)
    return { provider: "groq", transport: "openai", baseUrl: "https://api.groq.com/openai/v1", apiKey: cfg.groqApiKey, model: cfg.groqModel, vision: false };
  return null;
}

/** True when the armed brain accepts images (screen vision). */
export function hasVision(creds: LlmCreds | null): boolean {
  return creds?.vision ?? false;
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema — reused verbatim as Anthropic input_schema and OpenAI parameters. */
  schema: Record<string, unknown>;
}

/** OpenAI-compatible headers — Bearer only when a key is present (Ollama is keyless). */
function openaiHeaders(creds: LlmCreds): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (creds.apiKey) h.Authorization = `Bearer ${creds.apiKey}`;
  return h;
}

/** <baseUrl>/chat/completions, tolerating a trailing slash on the base. */
function chatUrl(creds: LlmCreds): string {
  return `${creds.baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/**
 * ASK A REASONING MODEL NOT TO PUT ITS THINKING IN `content`.
 *
 * Two halves, and only one of them is universal.
 *
 * THE UNIVERSAL HALF is the response side: whatever a provider sends, this code
 * reads `content` and discards `reasoning_content` / `reasoning` entirely.
 * That needs no model list and cannot be wrong.
 *
 * THIS is the other half — a REQUEST hint, and it is a model list, because
 * there is no portable way to ask. It is best-effort by construction: a
 * provider that does not know `reasoning_effort` ignores it.
 *
 * `extra_body` IS NOT A WIRE FIELD. It is a python-SDK convenience that the SDK
 * unwraps before sending; posted as JSON it is just an unknown key, so
 * `include_reasoning: false` inside it was never sent anywhere. Worse, it was
 * being added to the CLASSIFIER's request too, where an unknown key is one
 * strict-schema provider away from a 400 that takes the whole natural-language
 * surface down. Sent at the top level, where the field actually lives.
 */
const REASONING_MODELS = ["gpt-oss", "deepseek-r1", "qwen3-thinking", "nemotron"] as const;

/**
 * PROVIDERS THAT HAVE REFUSED THE HINT, so we ask them once and then stop.
 *
 * Keyed by base URL rather than by model: the refusal is a property of the
 * PROVIDER's schema, not of the weights — Groq rejects `reasoning_effort:
 * "none"` for gpt-oss while other hosts of the same model accept it.
 *
 * In-process and deliberately not persisted. It costs one 400 per process to
 * rediscover, which is the right trade against carrying state that could go
 * stale when a provider fixes its schema.
 */
const REASONING_HINT_REFUSED = new Set<string>();

/**
 * THE COMMENT ABOVE WAS WRONG IN ONE WORD, AND THE WORD COST EVERY CALL.
 *
 * "best-effort by construction: a provider that does not know `reasoning_effort`
 * ignores it" — true, and beside the point. Groq DOES know the field and
 * VALIDATES it: it accepts `low`, `medium` and `high`, and answers `"none"` with
 *
 *     400 — `reasoning_effort` must be one of `low`, `medium`, or `high`
 *
 * So for every tenant on a Groq gpt-oss model — which is what this deployment
 * runs — every worker-side LLM call failed before it was sent. Not degraded: a
 * hard 400, on the strategist, the scout and anything else that reaches a model.
 * It failed the same way each time and looked like a model with nothing to say.
 *
 * `services/brain/brain/llm.py` already hit this exact wall and already solved
 * it: drop the field on a 400 that names it, remember the base URL, retry. This
 * is that solution on the TypeScript side, which never got it. Same behaviour,
 * because two clients that disagree about how to talk to the same provider is
 * the drift this codebase keeps paying for.
 */
export function quietReasoning(creds: LlmCreds): Record<string, unknown> {
  const model = creds.model.toLowerCase();
  if (!REASONING_MODELS.some((m) => model.includes(m))) return {};
  if (REASONING_HINT_REFUSED.has(creds.baseUrl)) return {};
  return { reasoning_effort: "none", include_reasoning: false };
}

/**
 * Did this response refuse the hint rather than the request?
 *
 * NARROW ON PURPOSE. A 400 that does not name the field is a real error and
 * must stay one — retrying every 400 without the hint would turn a malformed
 * prompt into two malformed prompts and hide the cause of both.
 */
export function refusedReasoningHint(status: number, message: string): boolean {
  return status === 400 && /reasoning_effort/i.test(message);
}

/** Remember a provider's refusal so the next call does not repeat it. */
export function noteReasoningRefusal(baseUrl: string): void {
  REASONING_HINT_REFUSED.add(baseUrl);
}

/** Test seam — the set is process-global and would otherwise leak between cases. */
export function resetReasoningRefusalsForTest(): void {
  REASONING_HINT_REFUSED.clear();
}

interface AnthropicCapabilities {
  adaptiveThinking: boolean;
  structuredTool: boolean;
}

// These are model capabilities, not account failures. Learn them only from the
// API's specific validation errors; another model or endpoint starts fresh.
const ANTHROPIC_CAPABILITIES = new Map<string, AnthropicCapabilities>();

export function resetAnthropicCapabilitiesForTest(): void {
  ANTHROPIC_CAPABILITIES.clear();
}

function anthropicThinking(capabilities: AnthropicCapabilities): Pick<Anthropic.MessageCreateParams, "thinking" | "output_config"> {
  return capabilities.adaptiveThinking
    ? { thinking: { type: "adaptive", display: "omitted" }, output_config: { effort: "low" } }
    : { thinking: { type: "disabled" } };
}

/** Retry only rejected request capabilities, before a response/stream exists. */
async function withAnthropicCapabilities<T>(
  client: Anthropic,
  creds: LlmCreds,
  forcedTool: boolean,
  request: (capabilities: AnthropicCapabilities) => PromiseLike<T>,
): Promise<T> {
  const key = JSON.stringify([client.baseURL, creds.model]);
  for (let attempt = 0; attempt < 3; attempt++) {
    const capabilities = ANTHROPIC_CAPABILITIES.get(key) ?? { adaptiveThinking: false, structuredTool: false };
    try {
      return await request(capabilities);
    } catch (error) {
      if (error instanceof Anthropic.APIError && error.status === 400 && attempt < 2) {
        const body = error.error as { error?: { message?: unknown }; message?: unknown } | undefined;
        const message = body?.error?.message ?? body?.message;
        const next = { ...capabilities, ...ANTHROPIC_CAPABILITIES.get(key) };
        if (typeof message === "string") {
          if (!capabilities.adaptiveThinking && /["']?thinking\.type\.disabled["']?\s+is not supported for this model\b/i.test(message)) {
            next.adaptiveThinking = true;
          } else if (forcedTool && !capabilities.structuredTool && /\btool_choice:\s*type\s+["']tool["']\s+and\s+["']any["']\s+are not supported for this model\b/i.test(message)) {
            next.structuredTool = true;
          } else {
            throw normalizedAnthropicError(creds, error);
          }
          ANTHROPIC_CAPABILITIES.set(key, next);
          continue;
        }
      }
      throw normalizedAnthropicError(creds, error);
    }
  }
  throw new Error(`${creds.provider} request capabilities could not be resolved`);
}

/** Structured replies are data only when the provider completed a JSON object. */
function anthropicStructuredReply(creds: LlmCreds, res: Anthropic.Message): Record<string, unknown> {
  if (res.stop_reason !== "end_turn") {
    throw new Error(`${creds.provider} ${creds.model} did not complete its structured reply (${res.stop_reason ?? "unknown"})`);
  }
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error(`${creds.provider} ${creds.model} returned invalid structured JSON`);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${creds.provider} ${creds.model} returned a structured reply that is not an object`);
  }
  return input as Record<string, unknown>;
}

/**
 * One schema-shaped decision: forced tool arguments, or structured JSON when
 * Anthropic explicitly rejects forced tools. Callers validate the decision
 * before acting. Transport and incomplete structured-output failures throw.
 */
export async function llmToolCall(
  creds: LlmCreds,
  opts: { system: string; messages: ChatMsg[]; tool: ToolSpec; maxTokens?: number },
): Promise<Record<string, unknown>> {
  if (creds.transport === "anthropic") {
    const client = new Anthropic({ apiKey: creds.apiKey });
    const { res, structured } = await withAnthropicCapabilities(client, creds, true, async (capabilities) => {
      const thinking = anthropicThinking(capabilities);
      const structured = capabilities.structuredTool;
      const res = await client.messages.create({
        model: creds.model,
        max_tokens: opts.maxTokens ?? 1024,
        system: structured
          ? `${opts.system}\n\nReturn the arguments for ${opts.tool.name} as one JSON object matching the required output schema. ${opts.tool.description}`
          : opts.system,
        ...thinking,
        ...(structured
          ? { output_config: { ...thinking.output_config, format: { type: "json_schema" as const, schema: opts.tool.schema } } }
          : {
              tools: [{ name: opts.tool.name, description: opts.tool.description, input_schema: opts.tool.schema } as never],
              tool_choice: { type: "tool" as const, name: opts.tool.name },
            }),
        messages: opts.messages,
      });
      return { res, structured };
    });
    if (structured) return anthropicStructuredReply(creds, res);
    const t = res.content.find((b) => b.type === "tool_use");
    return t && t.type === "tool_use" ? (t.input as Record<string, unknown>) : {};
  }

  // openai-compatible function calling (Groq, OpenAI, Gemini, xAI, DeepSeek, …)
  // Some reasoning models (gpt-oss-120b, deepseek-r1, qwen3-thinking, nemotron) dump chain-of-thought
  // into `content` or `reasoning_content`. We ignore that side-channel and only use tool_calls.
  // Universal: ask reasoning models not to put CoT into content — separate bank.
  const base: Record<string, unknown> = {
    model: creds.model,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: 0.2,
    messages: [{ role: "system", content: opts.system }, ...opts.messages],
    tools: [{ type: "function", function: { name: opts.tool.name, description: opts.tool.description, parameters: opts.tool.schema } }],
    tool_choice: { type: "function", function: { name: opts.tool.name } },
  };
  // Servers validate tool arguments and the model is nondeterministic — a
  // malformed emission 400s. One retry usually lands; then we throw honestly.
  //
  // THE HINT IS RE-RESOLVED ON EVERY ATTEMPT, and that is the fix. The body
  // used to be built once, above this loop, with `...quietReasoning(creds)`
  // baked in — so when Groq answered 400 for `reasoning_effort: "none"` the
  // one retry re-sent the identical body and 400'd again. `llmText` learned
  // to drop the hint on that answer; this path, which the Telegram
  // interpreter uses, never did, and the owner's chat stayed dead on Groq
  // gpt-oss behind a fix that was only half applied.
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(chatUrl(creds), {
      method: "POST",
      headers: openaiHeaders(creds),
      body: JSON.stringify({ ...base, ...quietReasoning(creds) }),
    });
    if (!r.ok) {
      // providerError, not a raw body slice: it parses the provider's own
      // code and message, redacts secrets, and produces the shape every
      // owner-facing surface classifies on. The old string was the exact
      // `groq 401: {"error":{...}}` a live owner read in their chat.
      lastErr = await providerError(creds, r);
      // A provider that refuses the FIELD has refused the optimisation, not
      // the work: remember it, and the retry below resolves to no hint.
      if (refusedReasoningHint(r.status, lastErr)) noteReasoningRefusal(creds.baseUrl);
      if (r.status === 400 && attempt === 0) continue;
      throw new Error(lastErr);
    }
    const j = (await r.json()) as {
      choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
    };
    const args = j.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    return args ? (JSON.parse(args) as Record<string, unknown>) : {};
  }
  throw new Error(lastErr);
}

// ── agentic turns (multi-tool, model chooses) ────────────────────────────────
// Used by /agent: unlike llmToolCall (ONE forced tool), the model here sees a
// CATALOG of tools and freely interleaves text (progress narration) with tool
// calls until it stops calling tools. The loop lives in telegram/agent.ts; this
// layer only translates one neutral message shape to both transports.

export interface AgentToolUse {
  /** Provider-issued call id — must be echoed back with the result. */
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type AgentMsg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolUses: AgentToolUse[]; anthropicContent?: Anthropic.ContentBlock[] }
  | { role: "tools"; results: { id: string; name: string; output: string }[] };

export interface AgentTurn {
  text: string;
  toolUses: AgentToolUse[];
  /** Opaque provider history for tool round-trips; never owner-facing text. */
  anthropicContent?: Anthropic.ContentBlock[];
}

/** One model turn: text and/or tool calls. Throws on transport error. */
export async function llmAgentTurn(
  creds: LlmCreds,
  opts: { system: string; messages: AgentMsg[]; tools: ToolSpec[]; maxTokens?: number },
): Promise<AgentTurn> {
  if (creds.transport === "anthropic") {
    const client = new Anthropic({ apiKey: creds.apiKey });
    const messages = opts.messages.map((m) => {
      if (m.role === "user") return { role: "user" as const, content: m.text };
      if (m.role === "assistant") {
        if (m.anthropicContent) return { role: "assistant" as const, content: m.anthropicContent as Anthropic.ContentBlockParam[] };
        const blocks: unknown[] = [];
        if (m.text) blocks.push({ type: "text", text: m.text });
        for (const t of m.toolUses) blocks.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
        return { role: "assistant" as const, content: blocks as never };
      }
      // tool results ride a user turn in the Anthropic shape
      return {
        role: "user" as const,
        content: m.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.output })) as never,
      };
    });
    const res = await withAnthropicCapabilities(client, creds, false, (capabilities) => client.messages.create({
      model: creds.model,
      max_tokens: opts.maxTokens ?? 1500,
      system: opts.system,
      ...anthropicThinking(capabilities),
      tools: opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema }) as never),
      messages,
    }));
    const text = res.content.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")).join("\n").trim();
    const toolUses: AgentToolUse[] = res.content
      .filter((b) => b.type === "tool_use")
      .map((b) => (b.type === "tool_use" ? { id: b.id, name: b.name, input: b.input as Record<string, unknown> } : null))
      .filter((t): t is AgentToolUse => t !== null);
    return { text, toolUses, anthropicContent: res.content };
  }

  // openai-compatible: assistant tool_calls + role:"tool" results
  const messages: unknown[] = [{ role: "system", content: opts.system }];
  for (const m of opts.messages) {
    if (m.role === "user") messages.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      messages.push({
        role: "assistant",
        content: m.text || "",
        ...(m.toolUses.length > 0
          ? { tool_calls: m.toolUses.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.input) } })) }
          : {}),
      });
    } else {
      for (const r of m.results) messages.push({ role: "tool", tool_call_id: r.id, content: r.output });
    }
  }
  const body: Record<string, unknown> = {
    model: creds.model,
    max_tokens: opts.maxTokens ?? 1500,
    temperature: 0.2,
    messages,
    tools: opts.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.schema } })),
    ...quietReasoning(creds),
  };
  let r = await fetch(chatUrl(creds), { method: "POST", headers: openaiHeaders(creds), body: JSON.stringify(body) });
  if (!r.ok) {
    // Same rule as llmText and llmToolCall: a 400 that names the reasoning
    // hint is the provider refusing an optimisation, so retry once without it
    // and remember. Any other failure is thrown as providerError's sentence.
    const why = await providerError(creds, r);
    if (!refusedReasoningHint(r.status, why)) throw new Error(why);
    noteReasoningRefusal(creds.baseUrl);
    const bare = { ...body };
    delete bare.reasoning_effort;
    delete bare.include_reasoning;
    r = await fetch(chatUrl(creds), { method: "POST", headers: openaiHeaders(creds), body: JSON.stringify(bare) });
    if (!r.ok) throw new Error(await providerError(creds, r));
  }
  const j = (await r.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]; reasoning_content?: string; reasoning?: string } }[];
  };
  const msg = j.choices?.[0]?.message as { content?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[]; reasoning_content?: string; reasoning?: string } | undefined;
  // reasoning_content/reasoning is a separate bank — never merge into content (universal exclusion)
  const toolUses: AgentToolUse[] = (msg?.tool_calls ?? [])
    .map((tc, i) => {
      if (!tc.function?.name) return null;
      let input: Record<string, unknown> = {};
      try {
        input = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
      } catch {
        /* malformed args — surface an empty input; the tool will complain */
      }
      return { id: tc.id ?? `call_${i}`, name: tc.function.name, input };
    })
    .filter((t): t is AgentToolUse => t !== null);
  return { text: (msg?.content ?? "").trim(), toolUses };
}

/** Plain text completion (narration). Throws on transport error. */
/**
 * The provider's OWN reason for refusing, not just the status code.
 *
 * This threw `"groq 400"` and dropped the body — and the body is the only part
 * that says anything actionable. A dead model, a rejected key, a rate limit and
 * a too-long prompt are four different problems with four different fixes, and
 * they all arrived as the same four characters. Whoever runs the deployment has
 * to be able to tell them apart; on the hosted app they cannot read the logs.
 *
 * Redacted through the shared value-based scrubber before it goes anywhere,
 * because this string reaches a browser: a provider that echoed part of a
 * request back would otherwise put it on screen.
 */
async function providerError(creds: LlmCreds, r: Response): Promise<string> {
  const raw = await r.text().catch(() => "");
  let detail = "";
  try {
    const j = JSON.parse(raw) as { error?: { message?: string; code?: string } };
    detail = [j.error?.code, j.error?.message].filter(Boolean).join(": ");
  } catch {
    detail = raw;
  }
  return providerFailure(creds, r.status, detail);
}

function providerFailure(creds: LlmCreds, status: number, detail: string): string {
  const safe = redactSecrets(detail, [creds.apiKey].filter(Boolean)).replace(/\s+/g, " ").trim();
  return `${creds.provider} ${status}${safe ? ` — ${safe.slice(0, 300)}` : ""}`;
}

/**
 * The SDK throws `404 { ... }`, while fetch errors already name the provider.
 * Without this boundary an unavailable Anthropic model reached the owner as an
 * unrecognised failure, even though its status said exactly what to change.
 * Read SDK fields, redact before logging, and keep local errors/aborts intact.
 */
function normalizedAnthropicError(creds: LlmCreds, error: unknown): unknown {
  if (error instanceof Anthropic.APIUserAbortError) return error;
  if (error instanceof Anthropic.APIConnectionError) {
    return new Error(`${creds.provider} network request failed`);
  }
  if (!(error instanceof Anthropic.APIError)) return error;
  const body = error.error as { error?: { type?: unknown; code?: unknown; message?: unknown }; message?: unknown } | undefined;
  const detail = body?.error;
  const code = detail?.code ?? detail?.type ?? error.type;
  const message = detail?.message ?? body?.message;
  if (typeof error.status === "number") {
    const text = [code, message].filter((part) => typeof part === "string" && part).join(": ");
    return new Error(providerFailure(creds, error.status, text));
  }
  // SSE errors arrive after HTTP 200, without a failure status. Do not invent
  // one or let the partially received reply count as a completed answer.
  return new Error(streamError(creds, { code, message }));
}

/**
 * Reasoning models (nemotron, deepseek-r1, qwen3-thinking, gpt-oss) may return
 * chain-of-thought in `reasoning_content`, `reasoning`, or inline `<think>…</think>`
 * blocks inside `content`. Strip that side-channel before returning to Telegram.
 */
function stripReasoningFromContent(content: string, reasoning?: string): string {
  let out = content ?? "";
  // reasoning_content/reasoning is a separate field — never append it; it's thinking.
  // If content is empty and only reasoning exists, treat as no answer (caller throws).
  if (!out.trim() && reasoning) return "";
  // Remove <think>…</think> and <|think|>…<|/think|> blocks (multiline, case-insensitive)
  out = out.replace(/<\|?think\|?>([\s\S]*?)<\/\|?think\|?>/gi, "");
  out = out.replace(/<think>([\s\S]*?)<\/think>/gi, "");
  return out;
}

export async function llmText(
  creds: LlmCreds,
  opts: { system: string; prompt: string; maxTokens?: number },
): Promise<string> {
  if (creds.transport === "anthropic") {
    const client = new Anthropic({ apiKey: creds.apiKey });
    const res = await withAnthropicCapabilities(client, creds, false, (capabilities) => client.messages.create({
      model: creds.model,
      max_tokens: opts.maxTokens ?? 400,
      ...anthropicThinking(capabilities),
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
    }));
    const t = res.content.find((b) => b.type === "text");
    return t && t.type === "text" ? t.text.trim() : "";
  }

  const base: Record<string, unknown> = {
    model: creds.model,
    max_tokens: opts.maxTokens ?? 400,
    temperature: 0.6,
    messages: [{ role: "system", content: opts.system }, { role: "user", content: opts.prompt }],
  };
  const send = (hint: Record<string, unknown>) =>
    fetch(chatUrl(creds), {
      method: "POST",
      headers: openaiHeaders(creds),
      body: JSON.stringify({ ...base, ...hint }),
    });

  let r = await send(quietReasoning(creds));
  if (!r.ok) {
    const why = await providerError(creds, r);
    // ONE RETRY, AND ONLY FOR THIS. The hint is an optimisation — it asks a
    // reasoning model not to spend the completion budget thinking — so a
    // provider that refuses the FIELD has refused the optimisation, not the
    // work. Anything else is a real error and is thrown as one.
    if (!refusedReasoningHint(r.status, why)) throw new Error(why);
    noteReasoningRefusal(creds.baseUrl);
    r = await send({});
    if (!r.ok) throw new Error(await providerError(creds, r));
  }
  const j = (await r.json()) as {
    choices?: { finish_reason?: string; message?: { content?: string; reasoning_content?: string; reasoning?: string } }[];
    usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
  };
  const choice = j.choices?.[0];
  const rawMsg = choice?.message as { content?: string; reasoning_content?: string; reasoning?: string } | undefined;
  const text = stripReasoningFromContent(rawMsg?.content ?? "", rawMsg?.reasoning_content ?? rawMsg?.reasoning ?? "").trim();
  // AN EMPTY COMPLETION IS A FAILURE, NOT AN ANSWER.
  //
  // A reasoning model spends its completion budget on hidden reasoning before
  // it writes anything, so too small a maxTokens returns HTTP 200 with
  // `content: ""` and `finish_reason: "length"`. Measured: gpt-oss-120b at
  // maxTokens 40 produced 38 reasoning tokens and no text at all. Returning ""
  // here made that indistinguishable from a model with nothing to say — the
  // caller saw no error, showed its generic fallback, and the real cause (a
  // budget too small for this model) was invisible.
  if (!text) {
    const reasoned = j.usage?.completion_tokens_details?.reasoning_tokens;
    const why =
      choice?.finish_reason === "length"
        ? `ran out of tokens before writing a reply${reasoned ? ` (spent ${reasoned} on reasoning)` : ""} — raise maxTokens or pick a model that does not reason`
        : `returned an empty reply (finish_reason: ${choice?.finish_reason ?? "unknown"})`;
    throw new Error(`${creds.provider} ${creds.model} ${why}`);
  }
  return text;
}

// ── streamed narration ──────────────────────────────────────────────────────

/**
 * A provider's refusal that arrived INSIDE a stream, after the 200.
 *
 * Same redaction as providerError: this sentence reaches a browser, and a
 * provider that echoed part of the request back would otherwise put it there.
 */
function streamError(creds: LlmCreds, e: { message?: unknown; code?: unknown }): string {
  const detail = [e.code, e.message].filter((v) => typeof v === "string" && v).join(": ");
  const safe = redactSecrets(detail, [creds.apiKey].filter(Boolean)).replace(/\s+/g, " ").trim();
  return `${creds.provider} stream failed${safe ? ` — ${safe.slice(0, 300)}` : ""}`;
}

/**
 * llmText, A PIECE AT A TIME — for the owner's chat, where waiting for the whole
 * completion left "thinking…" on screen for as long as the slowest provider took.
 *
 * ADDITIVE. llmText is untouched and every other caller keeps it; nothing here
 * changes what any existing path sends or returns.
 *
 * `onText` receives the model's CONTENT as it arrives — raw, and deliberately
 * so: deciding what of it may be shown (reasoning tags, a command marker still
 * being written) is the caller's rule, stated once in web/src/lib/chat-stream.ts
 * for the server and the browser alike. The reasoning SIDE CHANNEL
 * (`reasoning_content`, `reasoning`) is never passed on at all.
 *
 * Returns the whole reply with inline reasoning stripped, exactly as llmText
 * would have, and fails where llmText fails: an empty completion is an error
 * rather than an answer, a provider that refuses the reasoning hint is asked
 * once more without it, and a refusal is thrown in the provider's own words.
 * An error that arrives mid-stream is thrown too — half a reply is not a reply.
 */
export async function llmTextStream(
  creds: LlmCreds,
  opts: { system: string; prompt: string; maxTokens?: number; signal?: AbortSignal },
  onText: (piece: string) => void,
): Promise<string> {
  if (creds.transport === "anthropic") {
    try {
      const client = new Anthropic({ apiKey: creds.apiKey });
      const stream = await withAnthropicCapabilities(client, creds, false, (capabilities) => client.messages.create(
        {
          model: creds.model,
          max_tokens: opts.maxTokens ?? 400,
          ...anthropicThinking(capabilities),
          system: opts.system,
          messages: [{ role: "user", content: opts.prompt }],
          stream: true,
        },
        { signal: opts.signal },
      ));
      let raw = "";
      let stopped = false;
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta" && ev.delta.text) {
          raw += ev.delta.text;
          onText(ev.delta.text);
        }
        if (ev.type === "message_stop" || (ev.type === "message_delta" && ev.delta.stop_reason)) stopped = true;
      }
      // See the OpenAI branch below: a stream that never said it stopped was cut.
      if (!stopped) throw new Error(`${creds.provider} ${creds.model} stream ended before the reply was finished`);
      const text = raw.trim();
      // llmText answers "" here and leaves the caller to notice; a stream the
      // owner watched arrive empty is a failure, and is said as one.
      if (!text) throw new Error(`${creds.provider} ${creds.model} returned an empty reply`);
      return text;
    } catch (error) {
      throw normalizedAnthropicError(creds, error);
    }
  }

  const base: Record<string, unknown> = {
    model: creds.model,
    max_tokens: opts.maxTokens ?? 400,
    temperature: 0.6,
    messages: [{ role: "system", content: opts.system }, { role: "user", content: opts.prompt }],
    stream: true,
  };
  const send = (hint: Record<string, unknown>) =>
    fetch(chatUrl(creds), {
      method: "POST",
      headers: openaiHeaders(creds),
      body: JSON.stringify({ ...base, ...hint }),
      signal: opts.signal,
    });

  let r = await send(quietReasoning(creds));
  if (!r.ok) {
    // The same one retry llmText makes, for the same reason and nothing else.
    const why = await providerError(creds, r);
    if (!refusedReasoningHint(r.status, why)) throw new Error(why);
    noteReasoningRefusal(creds.baseUrl);
    r = await send({});
    if (!r.ok) throw new Error(await providerError(creds, r));
  }

  let raw = "";
  let finish: string | undefined;
  let reasoned: number | undefined;
  // A PROVIDER THAT IGNORES `stream` — some OpenAI-compatible hosts and local
  // runtimes do — answers with one JSON body. Read it as llmText would and
  // hand it on whole, rather than failing a reply that is sitting right there.
  if (/application\/json/i.test(r.headers.get("content-type") ?? "") || !r.body) {
    const j = (await r.json()) as {
      choices?: { finish_reason?: string; message?: { content?: string } }[];
      usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
    };
    raw = j.choices?.[0]?.message?.content ?? "";
    finish = j.choices?.[0]?.finish_reason;
    reasoned = j.usage?.completion_tokens_details?.reasoning_tokens;
    if (raw) onText(raw);
  } else {
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let ended = false;
    const line = (l: string) => {
      const s = l.replace(/\r$/, "");
      if (!s.startsWith("data:")) return; // `event:`, `id:`, keep-alive comments
      const data = s.slice(5).trim();
      if (!data) return;
      if (data === "[DONE]") {
        ended = true;
        return;
      }
      let j: {
        error?: { message?: unknown; code?: unknown };
        choices?: { finish_reason?: string | null; delta?: { content?: string | null } }[];
        usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
      };
      try {
        j = JSON.parse(data);
      } catch {
        return;
      }
      if (j.error) throw new Error(streamError(creds, j.error));
      const choice = j.choices?.[0];
      // `delta.reasoning_content` / `delta.reasoning` are the thinking bank —
      // read past, never merged into content (the universal exclusion above).
      const piece = choice?.delta?.content;
      if (typeof piece === "string" && piece) {
        raw += piece;
        onText(piece);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
      const rt = j.usage?.completion_tokens_details?.reasoning_tokens;
      if (typeof rt === "number") reasoned = rt;
    };
    try {
      while (!ended) {
        const { value, done } = await reader.read();
        if (value) buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const l of lines) {
          line(l);
          if (ended) break;
        }
        if (done) {
          if (buffer) line(buffer);
          break;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    // A STREAM THAT NEVER SAID IT FINISHED WAS CUT. A connection dropped
    // mid-reply ends the body exactly like a finished one, and the half that
    // had arrived was returned as the whole — which the chat then sent as its
    // final reply. A finished completion always says so: a finish_reason on
    // its last chunk, or [DONE].
    if (!ended && !finish) throw new Error(`${creds.provider} ${creds.model} stream ended before the reply was finished`);
  }

  const text = stripReasoningFromContent(raw).trim();
  if (!text) {
    const why =
      finish === "length"
        ? `ran out of tokens before writing a reply${reasoned ? ` (spent ${reasoned} on reasoning)` : ""} — raise maxTokens or pick a model that does not reason`
        : `returned an empty reply (finish_reason: ${finish ?? "unknown"})`;
    throw new Error(`${creds.provider} ${creds.model} ${why}`);
  }
  return text;
}
