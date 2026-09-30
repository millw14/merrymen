import type { MerrymenSettings } from "@merrymen/core";

type ModelSettings = Pick<MerrymenSettings, "llmProvider" | "llmProviderModel" | "llmModel" | "groqModel">;
type ModelField = "llmProviderModel" | "llmModel" | "groqModel";

export function providerModelField(provider: string): ModelField {
  return provider === "groq" ? "groqModel" : provider === "anthropic" ? "llmModel" : "llmProviderModel";
}

/** Match the worker's explicit-provider precedence, including older overrides. */
export function providerModelValue(settings: ModelSettings, provider: string): string {
  return settings.llmProviderModel?.trim() || settings[providerModelField(provider)]?.trim() || "";
}

/** A model belongs to the provider it was selected for; keys stay untouched. */
export function providerChange(provider: string): Record<string, string> {
  return { llmProvider: provider, llmProviderModel: "" };
}

/** Editing the visible model must replace the effective override, not hide it. */
export function providerModelChange(provider: string, model: string): Record<string, string> {
  return { llmProviderModel: "", [providerModelField(provider)]: model };
}

/**
 * PUT clients get the same provider/model pairing as the form. An explicit
 * generic model in this patch is intentional and keeps its usual precedence.
 * Unrelated edits, including edits to an inactive provider's model, keep it.
 */
export function clearsStaleProviderModel(
  stored: ModelSettings,
  next: ModelSettings,
  patch: Record<string, unknown>,
): boolean {
  if ("llmProviderModel" in patch) return false;
  if ("llmProvider" in patch && next.llmProvider !== stored.llmProvider) return true;
  if (next.llmProvider !== "groq" && next.llmProvider !== "anthropic") return false;
  const field = providerModelField(next.llmProvider);
  return field in patch && (next[field] !== stored[field] || patch[field] === "" || patch[field] === null);
}
