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
 * The safety contract is unchanged and provider-agnostic: the model can only
 * emit a member of a forced tool schema; deterministic code disposes. Swapping
 * the brain never widens what it can do.
 */

import Anthropic from "@anthropic-ai/sdk";
import { llmProviderById, type LlmProviderInfo } from "../../packages/core/src/index";
import type { ResolvedConfig } from "./settings";

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
 * One forced tool call → the validated arguments object. Throws on transport
 * error (callers wrap and degrade). The model MUST answer via the tool.
 */
export async function llmToolCall(
  creds: LlmCreds,
  opts: { system: string; messages: ChatMsg[]; tool: ToolSpec; maxTokens?: number },
): Promise<Record<string, unknown>> {
  if (creds.transport === "anthropic") {
    const client = new Anthropic({ apiKey: creds.apiKey });
    const res = await client.messages.create({
      model: creds.model,
      max_tokens: opts.maxTokens ?? 1024,
      system: opts.system,
      thinking: { type: "disabled" },
      // strict schema + forced choice — the model can only fill the enum.
      tools: [{ name: opts.tool.name, description: opts.tool.description, input_schema: opts.tool.schema } as never],
      tool_choice: { type: "tool", name: opts.tool.name },
      messages: opts.messages,
    });
    const t = res.content.find((b) => b.type === "tool_use");
    return t && t.type === "tool_use" ? (t.input as Record<string, unknown>) : {};
  }

  // openai-compatible function calling (Groq, OpenAI, Gemini, xAI, DeepSeek, …)
  const body = {
    model: creds.model,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: 0.2,
    messages: [{ role: "system", content: opts.system }, ...opts.messages],
    tools: [{ type: "function", function: { name: opts.tool.name, description: opts.tool.description, parameters: opts.tool.schema } }],
    tool_choice: { type: "function", function: { name: opts.tool.name } },
  };
  // Servers validate tool arguments and the model is nondeterministic — a
  // malformed emission 400s. One retry usually lands; then we throw honestly.
  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(chatUrl(creds), {
      method: "POST",
      headers: openaiHeaders(creds),
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      lastErr = `${creds.provider} ${r.status}: ${(await r.text()).slice(0, 200)}`;
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

/** Plain text completion (narration). Throws on transport error. */
export async function llmText(
  creds: LlmCreds,
  opts: { system: string; prompt: string; maxTokens?: number },
): Promise<string> {
  if (creds.transport === "anthropic") {
    const client = new Anthropic({ apiKey: creds.apiKey });
    const res = await client.messages.create({
      model: creds.model,
      max_tokens: opts.maxTokens ?? 400,
      thinking: { type: "disabled" },
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
    });
    const t = res.content.find((b) => b.type === "text");
    return t && t.type === "text" ? t.text.trim() : "";
  }

  const body = {
    model: creds.model,
    max_tokens: opts.maxTokens ?? 400,
    temperature: 0.6,
    messages: [{ role: "system", content: opts.system }, { role: "user", content: opts.prompt }],
  };
  const r = await fetch(chatUrl(creds), {
    method: "POST",
    headers: openaiHeaders(creds),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${creds.provider} ${r.status}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return (j.choices?.[0]?.message?.content ?? "").trim();
}
