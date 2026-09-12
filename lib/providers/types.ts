import type { ModelKey } from "../models";
import type { PromptMessage } from "../types";

export type CompressionDirection = "main-to-thread" | "thread-to-main";

export interface StreamInput {
  messages: PromptMessage[];
  modelKey: ModelKey;
  signal?: AbortSignal;
}

export interface CompressionInput {
  messages: PromptMessage[];
  direction: CompressionDirection;
  signal?: AbortSignal;
}

export type ProviderChunk =
  | { type: "text"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number };

export interface ChatProvider {
  streamChat(input: StreamInput): AsyncGenerator<ProviderChunk>;
  compress(input: CompressionInput): Promise<unknown>;
}
