/**
 * The catalog of AI providers a merryman's brain can run on.
 *
 * Almost every modern LLM host exposes an OpenAI-compatible /chat/completions
 * endpoint, so the whole list below shares ONE transport in worker/src/llm.ts —
 * we only vary base URL + key + model. Anthropic is the exception: it keeps its
 * native SDK path (best tool-use + the only backend that also does screen vision).
 *
 * "Bring any key": pick a provider from this list, paste its key, done — or pick
 * `custom` and point at any OpenAI-compatible URL. Nothing here widens what the
 * agent can DO: the model still only fills a forced tool schema; code disposes.
 */

export interface LlmProviderInfo {
  /** Stable id stored in settings.llmProvider. */
  id: string;
  /** Human label for the dropdown. */
  label: string;
  /** How we talk to it: the native Anthropic SDK, or OpenAI-compatible HTTP. */
  transport: "anthropic" | "openai";
  /** OpenAI-compatible base (…/v1). Empty for anthropic (SDK) and custom (user-supplied). */
  baseUrl: string;
  /** Default model when the user doesn't override it. Empty for custom. */
  defaultModel: string;
  /** Where to get a key (or, for local, where to install). Empty for custom. */
  keyUrl: string;
  /** Does the default model accept images? Gates the vision hint. */
  vision: boolean;
  /** Has a usable free tier — surfaced as a badge. */
  free?: boolean;
  /** false = no API key required (local runtimes like Ollama). */
  needsKey?: boolean;
  /** Gated to verified $MERRYMEN holders (the Merrymen AI gateway). Surfaced as a badge. */
  holder?: boolean;
  /** One-line pitch shown under the picker. */
  blurb: string;
}

/**
 * Order matters — this is the dropdown order. Groq first (the free default),
 * then the big names, then the aggregators, then local, then custom last.
 */
export const LLM_PROVIDERS: LlmProviderInfo[] = [
  {
    // The holder perk: a merryman-run gateway (gateway/) proxies to a fast model
    // behind the scenes. Holders claim a token (prove they hold $MERRYMEN by
    // signing) and paste it here — no third-party API key, no signup. The client
    // never sees the upstream key; the gateway checks holdings + rate-limits.
    // baseUrl points at YOUR deployed gateway (see gateway/README.md).
    id: "merrymen",
    label: "Merrymen AI",
    transport: "openai",
    baseUrl: "https://ai.merrymen.dev/v1",
    defaultModel: "merrymen-fast", // cosmetic — the gateway picks the real model
    keyUrl: "https://ai.merrymen.dev/claim",
    vision: false,
    holder: true,
    blurb: "For verified $MERRYMEN holders — no API key or signup. Claim a token by signing with your holder wallet, paste it, done.",
  },
  {
    id: "groq",
    label: "Groq",
    transport: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    keyUrl: "https://console.groq.com/keys",
    vision: false,
    free: true,
    blurb: "Free and very fast. The zero-cost way to test chat and the strategist.",
  },
  {
    id: "openai",
    label: "OpenAI",
    transport: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    keyUrl: "https://platform.openai.com/api-keys",
    vision: true,
    blurb: "GPT-4o family. Strong all-rounder with image understanding.",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    transport: "anthropic",
    baseUrl: "",
    defaultModel: "claude-opus-4-8",
    keyUrl: "https://console.anthropic.com/settings/keys",
    vision: true,
    blurb: "The smartest strategist, and the only brain that also does screen vision.",
  },
  {
    id: "google",
    label: "Google Gemini",
    transport: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.0-flash",
    keyUrl: "https://aistudio.google.com/apikey",
    vision: true,
    free: true,
    blurb: "Generous free tier, fast, multimodal.",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    transport: "openai",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-2-latest",
    keyUrl: "https://console.x.ai",
    vision: true,
    blurb: "Grok, with vision models available.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    transport: "openai",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-chat",
    keyUrl: "https://platform.deepseek.com/api_keys",
    vision: false,
    blurb: "Very cheap, strong reasoning.",
  },
  {
    id: "mistral",
    label: "Mistral",
    transport: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-large-latest",
    keyUrl: "https://console.mistral.ai/api-keys",
    vision: false,
    blurb: "European models, open-weights lineage.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    transport: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "meta-llama/llama-3.3-70b-instruct",
    keyUrl: "https://openrouter.ai/keys",
    vision: false,
    blurb: "One key, hundreds of models — set any model id in the model field.",
  },
  {
    id: "together",
    label: "Together AI",
    transport: "openai",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    keyUrl: "https://api.together.ai/settings/api-keys",
    vision: false,
    blurb: "Open models at scale.",
  },
  {
    id: "perplexity",
    label: "Perplexity",
    transport: "openai",
    baseUrl: "https://api.perplexity.ai",
    defaultModel: "sonar",
    keyUrl: "https://www.perplexity.ai/settings/api",
    vision: false,
    blurb: "Sonar models with live web grounding.",
  },
  {
    id: "cerebras",
    label: "Cerebras",
    transport: "openai",
    baseUrl: "https://api.cerebras.ai/v1",
    defaultModel: "llama-3.3-70b",
    keyUrl: "https://cloud.cerebras.ai",
    vision: false,
    free: true,
    blurb: "Free tier, wafer-scale fast inference.",
  },
  {
    id: "fireworks",
    label: "Fireworks",
    transport: "openai",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    keyUrl: "https://fireworks.ai/account/api-keys",
    vision: false,
    blurb: "Fast open-model hosting.",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    transport: "openai",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    keyUrl: "https://ollama.com/download",
    vision: false,
    needsKey: false,
    blurb: "Runs models on your own machine — no key, nothing leaves your computer.",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    transport: "openai",
    baseUrl: "",
    defaultModel: "",
    keyUrl: "",
    vision: false,
    blurb: "Any OpenAI-compatible endpoint — set your own base URL, key, and model.",
  },
];

/** Valid ids for validation (settings PUT, worker resolution). */
export const LLM_PROVIDER_IDS = LLM_PROVIDERS.map((p) => p.id);

/** Lookup by id; undefined for unknown ids. */
export function llmProviderById(id: string | undefined): LlmProviderInfo | undefined {
  if (!id) return undefined;
  return LLM_PROVIDERS.find((p) => p.id === id);
}
