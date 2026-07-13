/**
 * Provider layer for every LLM call in merrymen — one shape, two backends.
 *
 *   Groq (default): a free, fast, OpenAI-compatible endpoint. The zero-cost way
 *     to test chat, the strategist, and narration. Bare fetch, no SDK.
 *   Anthropic (upgrade): Claude via the official SDK — the smartest strategist,
 *     and the only backend that also does screen vision.
 *
 * Precedence when both keys are present: Anthropic wins (you paid for the
 * upgrade). With neither, resolveLlm returns null and the caller degrades to
 * deterministic behavior (null driver, slash-only chat).
 *
 * The safety contract is unchanged and provider-agnostic: the model can only
 * emit a member of a forced tool schema; deterministic code disposes. Swapping
 * the brain never widens what it can do.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ResolvedConfig } from "./settings";

export interface LlmCreds {
  provider: "anthropic" | "groq";
  apiKey: string;
  model: string;
}

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

/** Which brain (if any) is armed. Anthropic key upgrades over Groq. */
export function resolveLlm(cfg: ResolvedConfig): LlmCreds | null {
  if (cfg.anthropicApiKey) return { provider: "anthropic", apiKey: cfg.anthropicApiKey, model: cfg.llmModel };
  if (cfg.groqApiKey) return { provider: "groq", apiKey: cfg.groqApiKey, model: cfg.groqModel };
  return null;
}

/** True when the smartest features (screen vision) are available. */
export function hasVision(creds: LlmCreds | null): boolean {
  return creds?.provider === "anthropic";
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

/**
 * One forced tool call → the validated arguments object. Throws on transport
 * error (callers wrap and degrade). The model MUST answer via the tool.
 */
export async function llmToolCall(
  creds: LlmCreds,
  opts: { system: string; messages: ChatMsg[]; tool: ToolSpec; maxTokens?: number },
): Promise<Record<string, unknown>> {
  if (creds.provider === "anthropic") {
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

  // groq — OpenAI-compatible function calling
  const body = {
    model: creds.model,
    max_tokens: opts.maxTokens ?? 1024,
    temperature: 0.2,
    messages: [{ role: "system", content: opts.system }, ...opts.messages],
    tools: [{ type: "function", function: { name: opts.tool.name, description: opts.tool.description, parameters: opts.tool.schema } }],
    tool_choice: { type: "function", function: { name: opts.tool.name } },
  };
  const r = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as {
    choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
  };
  const args = j.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  return args ? (JSON.parse(args) as Record<string, unknown>) : {};
}

/** Plain text completion (narration). Throws on transport error. */
export async function llmText(
  creds: LlmCreds,
  opts: { system: string; prompt: string; maxTokens?: number },
): Promise<string> {
  if (creds.provider === "anthropic") {
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
  const r = await fetch(GROQ_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${creds.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`groq ${r.status}`);
  const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return (j.choices?.[0]?.message?.content ?? "").trim();
}
