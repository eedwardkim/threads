export const TRANSCRIPTION_MODELS = { openai: "gpt-transcribe", elevenlabs: "scribe_v2" } as const;
export type ProviderId = "deepseek" | "anthropic" | "openai";

export interface ModelInfo {
  /** Stable key persisted with messages. Never rename or reuse a key. */
  key: string;
  /** Provider API model ID. Verified against each provider's Models API before it is added here. */
  id: string;
  label: string;
  thinking: boolean;
  provider: ProviderId;
  description: string;
  /** Accepts image input parts natively. */
  vision: boolean;
  /** Kept so saved conversations keep resolving and can be retried, but hidden from the picker. */
  legacy?: boolean;
}

export const MODELS = [
  { key: "fast", id: "deepseek-flash", label: "DeepSeek Flash (Fast)", thinking: false, provider: "deepseek", description: "Get to the point", vision: true },
  { key: "thinking", id: "deepseek-flash", label: "DeepSeek Flash (Thinking)", thinking: true, provider: "deepseek", description: "Take time to reason", vision: true },
  { key: "deepseek-pro", id: "deepseek-v4-pro", label: "DeepSeek V4 Pro", thinking: false, provider: "deepseek", description: "Strongest DeepSeek, text only", vision: false },
  { key: "opus-5", id: "claude-opus-5", label: "Opus 5", thinking: false, provider: "anthropic", description: "Most capable Claude", vision: true },
  { key: "sonnet-5", id: "claude-sonnet-5", label: "Sonnet 5", thinking: false, provider: "anthropic", description: "Balanced Claude", vision: true },
  { key: "haiku", id: "claude-haiku-4-5", label: "Haiku 4.5", thinking: false, provider: "anthropic", description: "Fastest Claude", vision: true },
  { key: "opus", id: "claude-opus-4-8", label: "Opus 4.8", thinking: false, provider: "anthropic", description: "Previous Opus", vision: true, legacy: true },
  { key: "sonnet", id: "claude-sonnet-4-5", label: "Sonnet 4.5", thinking: false, provider: "anthropic", description: "Previous Sonnet", vision: true, legacy: true },
  { key: "gpt-5.5", id: "gpt-5.5", label: "GPT-5.5", thinking: false, provider: "openai", description: "OpenAI flagship", vision: true },
  { key: "gpt-5.4-mini", id: "gpt-5.4-mini", label: "GPT-5.4 mini", thinking: false, provider: "openai", description: "Fast, cheaper GPT", vision: true },
  { key: "gpt-5", id: "gpt-5", label: "GPT-5 (original)", thinking: false, provider: "openai", description: "Previous flagship", vision: true, legacy: true },
  { key: "gpt-5-mini", id: "gpt-5-mini", label: "GPT-5 mini", thinking: false, provider: "openai", description: "Previous mini", vision: true, legacy: true },
] as const satisfies readonly ModelInfo[];

export const COMPRESSION_MODEL = "deepseek-flash";
export type ModelKey = (typeof MODELS)[number]["key"];
export const DEFAULT_MODEL: ModelKey = "fast";
/** Model keys accepted by the database check constraint: lowercase letters, digits, dots and dashes. */
export const MODEL_KEY_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;

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

/** Models offered for new messages: current models plus a legacy model that is already selected. */
export function selectableModels(selected?: ModelKey | null) {
  return MODELS.filter((model) => !("legacy" in model && model.legacy) || model.key === selected);
}
