import { AppError } from "./errors";
import { modelFor, type ModelKey, type ProviderId } from "./models";
import { createAnthropicProvider } from "./providers/anthropic";
import { createDeepSeekProvider } from "./providers/deepseek";
import { mockProvider } from "./providers/mock";
import { createOpenAIProvider } from "./providers/openai";
import type { CompressionInput, StreamInput } from "./providers/types";
import type { ChatProvider } from "./providers/types";
import type { ProviderStatus } from "./types";

const ENV_VAR: Record<ProviderId, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export function getProviderStatus(): ProviderStatus {
  return {
    mock: process.env.USE_MOCK !== "false",
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
  };
}

function thinkingParameters(thinking: boolean) {
  // Update this mapping if DeepSeek changes its thinking request parameter.
  return { thinking: { type: thinking ? "enabled" : "disabled" } };
}

const providerCache = new Map<ProviderId, ChatProvider>();

function getProvider(modelKey: ModelKey): ChatProvider {
  if (getProviderStatus().mock) return mockProvider;
  const providerId = modelFor(modelKey).provider;
  const cached = providerCache.get(providerId);
  if (cached) return cached;
  const apiKey = process.env[ENV_VAR[providerId]]?.trim();
  if (!apiKey) {
    throw new AppError(`Set ${ENV_VAR[providerId]} in .env.local and restart, or set USE_MOCK=true to use the local demo.`, 503, "missing_key");
  }
  const provider = createProvider(providerId, apiKey);
  providerCache.set(providerId, provider);
  return provider;
}

function createProvider(providerId: ProviderId, apiKey: string): ChatProvider {
  switch (providerId) {
    case "deepseek":
      return createDeepSeekProvider({ apiKey, requestOptions: thinkingParameters });
    case "anthropic":
      return createAnthropicProvider({ apiKey });
    case "openai":
      return createOpenAIProvider({ apiKey });
  }
}

function getCompressProvider(): ChatProvider {
  if (getProviderStatus().mock) return mockProvider;
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new AppError("Set DEEPSEEK_API_KEY in .env.local and restart, or set USE_MOCK=true to use the local demo.", 503, "missing_key");
  }
  let cached = providerCache.get("deepseek");
  if (!cached) {
    cached = createDeepSeekProvider({ apiKey, requestOptions: thinkingParameters });
    providerCache.set("deepseek", cached);
  }
  return cached;
}

export function streamChat(input: StreamInput) {
  return getProvider(input.modelKey).streamChat(input);
}

export function compress(input: CompressionInput) {
  return getCompressProvider().compress(input);
}

export function requireProviderAvailable(modelKey: ModelKey, status: ProviderStatus = getProviderStatus()): void {
  if (status.mock) return;
  const providerId = modelFor(modelKey).provider;
  if (!status[providerId]) {
    throw new AppError(`Set ${ENV_VAR[providerId]} in .env.local and restart, or set USE_MOCK=true to use the local demo.`, 503, "missing_key");
  }
}
