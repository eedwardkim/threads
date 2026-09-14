import { AppError } from "./errors";
import { modelFor, type ModelKey, type ProviderId } from "./models";
import { createAnthropicProvider } from "./providers/anthropic";
import { createDeepSeekProvider } from "./providers/deepseek";
import { mockProvider } from "./providers/mock";
import { createOpenAIProvider } from "./providers/openai";
import type { CompressionInput, StreamInput } from "./providers/types";
import type { ChatProvider } from "./providers/types";
import type { ProviderStatus } from "./types";
import type { AttachmentFile } from "./db/repository";
import { DIGEST_SYSTEM_PROMPT, digestModelKey, mockDigest, type DigestWriter } from "./vision";

const ENV_VAR: Record<ProviderId, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

const PROVIDER_ORDER: ProviderId[] = ["deepseek", "anthropic", "openai"];

/**
 * Mock inference is an explicit opt-in (`USE_MOCK=true`) meant for development and tests.
 * Production deployments never fall back to it: a missing key fails clearly at request time.
 */
export function mockEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.USE_MOCK !== "true") return false;
  if (env.VERCEL_ENV === "production" && env.THREADS_ALLOW_MOCK_IN_PRODUCTION !== "true") {
    throw new AppError("Mock inference is not allowed in production. Unset USE_MOCK and configure a provider key.", 503, "mock_forbidden");
  }
  return true;
}

export function getProviderStatus(): ProviderStatus {
  return {
    mock: mockEnabled(),
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY?.trim()),
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
    openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
  };
}

/**
 * The provider used to compress briefings is a server-side choice: `THREADS_COMPRESSION_PROVIDER`
 * when set (and its key is configured), otherwise the first provider with credentials.
 */
export function compressionProvider(status: ProviderStatus = getProviderStatus()): ProviderId | null {
  const requested = process.env.THREADS_COMPRESSION_PROVIDER?.trim();
  if (requested) {
    if (!PROVIDER_ORDER.includes(requested as ProviderId)) {
      throw new AppError(`THREADS_COMPRESSION_PROVIDER must be one of ${PROVIDER_ORDER.join(", ")}.`, 503, "invalid_config");
    }
    return status[requested as ProviderId] ? (requested as ProviderId) : null;
  }
  return PROVIDER_ORDER.find((provider) => status[provider]) ?? null;
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
  const status = getProviderStatus();
  if (status.mock) return mockProvider;
  const providerId = compressionProvider(status);
  if (!providerId) {
    throw new AppError("No provider key is configured for context compression. Set DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY (or THREADS_COMPRESSION_PROVIDER to a configured provider).", 503, "missing_key");
  }
  let cached = providerCache.get(providerId);
  if (!cached) {
    cached = createProvider(providerId, process.env[ENV_VAR[providerId]]!.trim());
    providerCache.set(providerId, cached);
  }
  return cached;
}

export function streamChat(input: StreamInput) {
  return getProvider(input.modelKey).streamChat(input);
}

export function compress(input: CompressionInput) {
  return getCompressProvider().compress(input);
}

const DIGEST_TIMEOUT_MS = 90_000;

/** Writes the one-time visual record of an image with the configured vision model. */
export const digestWriter: DigestWriter = {
  async describe(file: AttachmentFile, signal?: AbortSignal) {
    const status = getProviderStatus();
    const modelKey = digestModelKey(status);
    if (!modelKey) {
      throw new AppError("No vision-capable provider is configured to read images. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or DEEPSEEK_API_KEY.", 503, "missing_key");
    }
    if (status.mock) return { digest: mockDigest(file), model: "mock" };
    const timeout = AbortSignal.timeout(DIGEST_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let digest = "";
    try {
      for await (const chunk of getProvider(modelKey).streamChat({
        modelKey,
        signal: combined,
        messages: [
          { role: "system", content: DIGEST_SYSTEM_PROMPT },
          { role: "user", content: `Describe this image (${file.name}, ${file.width}×${file.height}).`, attachments: [file], images: [{ data: file.data, mediaType: file.mediaType }] },
        ],
      })) {
        if (chunk.type === "text") digest += chunk.text;
      }
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) throw new AppError("Reading the image took too long. Please retry.", 504, "vision_timeout");
      if (error instanceof AppError) throw new AppError(`The image could not be read: ${error.message}`, error.status, "vision_failed");
      throw error;
    }
    if (!digest.trim()) throw new AppError("The image could not be read. Please retry.", 502, "vision_failed");
    return { digest: digest.trim(), model: modelFor(modelKey).id };
  },
};

export function requireProviderAvailable(modelKey: ModelKey, status: ProviderStatus = getProviderStatus()): void {
  if (status.mock) return;
  const providerId = modelFor(modelKey).provider;
  if (!status[providerId]) {
    throw new AppError(`Set ${ENV_VAR[providerId]} in .env.local and restart, or set USE_MOCK=true to use the local demo.`, 503, "missing_key");
  }
}
