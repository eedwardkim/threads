import { z } from "zod";
import { apiError, assertLocalRequest, readBody } from "../../../lib/api";
import { attributeContextUsage } from "../../../lib/context";
import { getRepository } from "../../../lib/db/repository";
import { AppError, readableError } from "../../../lib/errors";
import { acquireGeneration, stopGeneration } from "../../../lib/generation-lock";
import { isModelKey, type ModelKey } from "../../../lib/models";
import { assembleMainPrompt, assembleThreadPrompt } from "../../../lib/prompts";
import { getProviderStatus, requireProviderAvailable, streamChat } from "../../../lib/provider";
import type { Message, StreamEvent } from "../../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const id = z.string().min(1).max(100);
const schema = z.object({
  requestId: z.string().uuid(),
  chatId: id,
  threadId: id.nullable(),
  content: z.string().max(100_000).optional(),
  modelKey: z.custom<ModelKey>(isModelKey),
  retryMessageId: id.optional(),
}).refine((input) => Boolean(input.retryMessageId || input.content?.trim()), { path: ["content"], message: "Enter a message." });

export async function POST(request: Request): Promise<Response> {
  let lease: ReturnType<typeof acquireGeneration> | undefined;
  try {
    const input = await readBody(request, schema);
    const status = getProviderStatus();
    if (!status.mock) requireProviderAvailable(input.modelKey, status);
    const repository = getRepository();
    if (!repository.getChat(input.chatId)) throw new AppError("This conversation no longer exists.", 404, "chat_not_found");
    const thread = input.threadId === null ? null : repository.getThread(input.threadId);
    if (input.threadId !== null && (!thread || thread.chatId !== input.chatId)) {
      throw new AppError("Thread not found in this chat.", 404, "thread_not_found");
    }
    const parent = thread ? repository.getMessage(thread.parentMessageId) : null;
    if (thread && (!parent || parent.chatId !== input.chatId || parent.threadId !== null || parent.role !== "assistant" || !parent.complete)) {
      throw new AppError("This thread needs a completed parent message.", 409, "invalid_parent");
    }
    const retry = input.retryMessageId ? repository.getMessage(input.retryMessageId) : null;
    if (input.retryMessageId && (!retry || retry.chatId !== input.chatId || retry.threadId !== input.threadId)) {
      throw new AppError("Message not found in this conversation.", 404, "message_not_found");
    }
    if (retry && (retry.role !== "assistant" || retry.complete)) {
      throw new AppError("Only incomplete assistant messages can be retried.", 409, "message_immutable");
    }
    const generation = acquireGeneration(input.requestId, request.signal);
    lease = generation;
    const signal = generation.controller.signal;
    if (signal.aborted) throw new AppError("Generation stopped.", 499, "aborted");
    let history = repository.listMessages(input.chatId, input.threadId);
    if (retry) {
      const index = history.findIndex((message) => message.id === retry.id);
      if (index < 0) throw new AppError("Message not found in this conversation.", 404, "message_not_found");
      history = history.slice(0, index);
    }
    const messages = thread && parent ? assembleThreadPrompt(thread, parent, history) : assembleMainPrompt(history);
    let userMessage: Message | null = null;
    let message: Message;
    if (retry) {
      message = repository.updatePartialMessage(retry.id, "");
      message = repository.finishMessage(message.id, { content: "", complete: false, inputTokens: null, outputTokens: null });
    } else {
      const scope = { chatId: input.chatId, threadId: input.threadId, modelKey: input.modelKey };
      userMessage = repository.appendMessage({ ...scope, role: "user", content: input.content!, complete: true });
      messages.push({ role: userMessage.role, content: userMessage.content });
      message = repository.appendMessage({ ...scope, role: "assistant", content: "", complete: false });
    }
    const encoder = new TextEncoder();
    let disconnected = false;
    let task: Promise<void> | undefined;

    async function pump(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
      let successful = false;
      let content = message.content;
      let inputTokens: number | null = null;
      let outputTokens: number | null = null;
      const emit = (event: StreamEvent): boolean => {
        if (disconnected) return false;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          return true;
        } catch {
          disconnected = true;
          generation.controller.abort();
          return false;
        }
      };
      const emitError = (error: unknown) => {
        if (signal.aborted) return;
        const readable = readableError(error);
        emit({ type: "error", message: readable.message, code: readable.code, messageId: message.id });
      };
      try {
        if (!emit({ type: "start", message, userMessage })) return;
        for await (const chunk of streamChat({ messages, modelKey: message.modelKey ?? input.modelKey, signal })) {
          if (signal.aborted) break;
          if (chunk.type === "text") {
            content += chunk.text;
            message = repository.updatePartialMessage(message.id, content);
            if (!emit({ type: "delta", messageId: message.id, text: chunk.text })) break;
          } else {
            inputTokens = chunk.inputTokens;
            outputTokens = chunk.outputTokens;
            message = repository.finishMessage(message.id, { content, complete: false, inputTokens, outputTokens });
          }
        }
        successful = !signal.aborted;
      } catch (error) {
        emitError(error);
      } finally {
        try {
          try {
            message = repository.finishMessage(message.id, { content, complete: successful && !signal.aborted, inputTokens, outputTokens });
            if (thread && inputTokens !== null) {
              const current = repository.getThread(thread.id);
              if (current && current.contextFrozenAt === thread.contextFrozenAt) {
                const compressedContext = attributeContextUsage(current.compressedContext, thread.compressedContext, message.id);
                if (compressedContext !== null) repository.updateThread(thread.id, { compressedContext });
              }
            }
          } catch (error) {
            emitError(error);
          }
          emit({ type: "finish", message });
        } finally {
          generation.release();
          if (!disconnected) {
            try {
              controller.close();
            } catch {
              disconnected = true;
            }
          }
        }
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        task = pump(controller).catch(() => generation.release());
      },
      cancel() {
        disconnected = true;
        generation.controller.abort();
        return task;
      },
    });
    return new Response(stream, { headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    } });
  } catch (error) {
    lease?.release();
    return apiError(request.signal.aborted ? new AppError("Generation stopped.", 499, "aborted") : error);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    assertLocalRequest(request);
    stopGeneration(new URL(request.url).searchParams.get("id") ?? undefined);
    return Response.json({ ok: true });
  } catch (error) {
    return apiError(error);
  }
}
