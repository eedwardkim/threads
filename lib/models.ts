export type ProviderId = "deepseek" | "anthropic" | "openai";

export const MODELS = [
  { key: "fast", id: "deepseek-flash", label: "Fast", thinking: false, provider: "deepseek", description: "Get to the point" },
  { key: "thinking", id: "deepseek-flash", label: "Thinking", thinking: true, provider: "deepseek", description: "Take time to reason" },
  { key: "opus", id: "claude-opus-4-1", label: "Opus", thinking: false, provider: "anthropic", description: "Most capable Claude" },
  { key: "sonnet", id: "claude-sonnet-4-5", label: "Sonnet", thinking: false, provider: "anthropic", description: "Balanced Claude" },
  { key: "haiku", id: "claude-haiku-4-5", label: "Haiku", thinking: false, provider: "anthropic", description: "Fastest Claude" },
  { key: "gpt-5", id: "gpt-5", label: "GPT-5", thinking: false, provider: "openai", description: "OpenAI flagship" },
  { key: "gpt-5-mini", id: "gpt-5-mini", label: "GPT-5 mini", thinking: false, provider: "openai", description: "Lighter, cheaper GPT-5" },
] as const;

export const COMPRESSION_MODEL = "deepseek-flash";
export type ModelKey = (typeof MODELS)[number]["key"];
export const DEFAULT_MODEL: ModelKey = "fast";

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  deepseek: "DeepSeek",
  anthropic: "Claude",
  openai: "OpenAI",
};

export function isModelKey(value: unknown): value is ModelKey {
  return MODELS.some((model) => model.key === value);
}

export function modelFor(key: ModelKey) {
  return MODELS.find((model) => model.key === key) ?? MODELS[0];
}
