import type { AssistantModelMessage, UserModelMessage } from "ai";
import { AppError } from "../errors";
import type { PromptMessage } from "../types";
import { attachmentText } from "../vision";
import type { ProviderChunk } from "./types";

/**
 * Converts prompt messages to AI SDK model messages. A user turn with native `images` becomes
 * text + image parts; any other turn with attachments gets their cached descriptions appended as text,
 * so a model without vision (or an older turn) still knows exactly what the image contained.
 */
export function sdkPrompt(messages: PromptMessage[]) {
  const firstConversation = messages.findIndex((message) => message.role !== "system");
  const split = firstConversation < 0 ? messages.length : firstConversation;
  return {
    system: messages.slice(0, split).map(({ content }) => ({ role: "system" as const, content })),
    messages: messages.slice(split).map((message): UserModelMessage | AssistantModelMessage => {
      if (message.role === "assistant") return { role: "assistant", content: message.content };
      if (message.images?.length) {
        return {
          role: "user",
          content: [
            { type: "text", text: attachmentText(message.content, message.attachments ?? [], "native") },
            ...message.images.map((image) => ({ type: "image" as const, image: image.data, mediaType: image.mediaType })),
          ],
        };
      }
      return { role: "user", content: message.attachments?.length ? attachmentText(message.content, message.attachments, "digest") : message.content };
    }),
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
