import { AppError } from "../errors";
import type { PromptMessage } from "../types";
import type { ProviderChunk } from "./types";

export function sdkPrompt(messages: PromptMessage[]) {
  const firstConversation = messages.findIndex((message) => message.role !== "system");
  const split = firstConversation < 0 ? messages.length : firstConversation;
  return {
    system: messages.slice(0, split).map(({ content }) => ({ role: "system" as const, content })),
    messages: messages.slice(split).map(({ role, content }) => ({ role: role === "assistant" ? "assistant" as const : "user" as const, content })),
  };
}

interface StreamPart {
  type: string;
  text?: string;
  error?: unknown;
  finishReason?: string;
  totalUsage?: { inputTokens?: number; outputTokens?: number };
}

export async function* consumeStream(
  fullStream: AsyncIterable<StreamPart>,
  signal: AbortSignal | undefined,
  label: string,
): AsyncGenerator<ProviderChunk> {
  signal?.throwIfAborted();
  let finishReason: string | undefined;
  let hasAnswer = false;
  for await (const part of fullStream) {
    if (part.type === "error") throw part.error;
    if (part.type === "abort") throw new DOMException("Response stopped.", "AbortError");
    if (part.type === "text-delta") {
      const text = part.text ?? "";
      hasAnswer ||= Boolean(text.trim());
      yield { type: "text", text };
    }
    if (part.type === "finish") {
      finishReason = part.finishReason;
      const usage = part.totalUsage;
      if (usage?.inputTokens !== undefined && usage?.outputTokens !== undefined) yield { type: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
    }
  }
  signal?.throwIfAborted();
  if (finishReason === "length") throw new AppError(`${label} reached its response limit. Your text is saved.`, 502, "response_limit");
  if (finishReason !== "stop") throw new AppError("The response ended before it finished. Your text is saved. Please retry.", 502, "incomplete_response");
  if (!hasAnswer) throw new AppError(`${label} returned no answer. Please retry.`, 502, "empty_response");
}
