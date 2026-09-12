import { randomUUID } from "node:crypto";
import { getContextMeasuredMessageId, getContextUsageCutoff, parseBriefing, parseFrozenContext } from "./context";
import { getRepository, type ChatRepository } from "./db/repository";
import { AppError } from "./errors";
import { acquireGeneration } from "./generation-lock";
import { assembleFullThreadPrompt, assembleThreadPrompt } from "./prompts";
import { compress } from "./provider";
import { estimateTokens } from "./tokens";
import type { FrozenContext, Message, Thread, ThreadData } from "./types";

export interface CreateThreadInput {
  parentMessageId: string;
  anchorStart: number;
  anchorEnd: number;
  source: "user";
}

function cancellation(): DOMException {
  return new DOMException("Context preparation stopped.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellation();
}

function requireParent(repository: ChatRepository, id: string, chatId?: string): Message {
  const parent = repository.getMessage(id);
  if (!parent) throw new AppError("The selected message no longer exists.", 404, "message_not_found");
  if (parent.role !== "assistant" || !parent.complete || parent.threadId !== null || (chatId !== undefined && parent.chatId !== chatId)) {
    throw new AppError("Threads require a completed assistant message in the main conversation.", 400, "invalid_parent");
  }
  return parent;
}

function mainMessages(repository: ChatRepository, chatId: string): Message[] {
  return repository.listMessages(chatId).filter((message) => message.chatId === chatId && message.threadId === null);
}

async function prepareContext(main: Message[], parentId: string, signal: AbortSignal): Promise<FrozenContext> {
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  try {
    const result = await new Promise<unknown>((resolve, reject) => {
      onAbort = () => reject(cancellation());
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) return onAbort();
      Promise.resolve(compress({
        messages: main.filter((message) => message.id !== parentId).map(({ role, content }) => ({ role, content })),
        direction: "main-to-thread",
        signal,
      })).then(resolve, reject);
    });
    throwIfAborted(signal);
    const briefing = parseBriefing(result);
    if (briefing) return { kind: "compressed", briefing };
  } catch (error) {
    if (signal.aborted || (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")) {
      throw cancellation();
    }
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
  throwIfAborted(signal);
  return { kind: "fallback", messages: main.slice(-4).map(({ role, content }) => ({ role, content })) };
}

export async function createThread(input: CreateThreadInput, options: { repository?: ChatRepository; signal?: AbortSignal } = {}): Promise<Thread> {
  throwIfAborted(options.signal);
  const repository = options.repository ?? getRepository();
  const generation = acquireGeneration(`context:${randomUUID()}`, options.signal);
  const signal = generation.controller.signal;
  try {
    throwIfAborted(signal);
    const parent = requireParent(repository, input.parentMessageId);
    if (input.source !== "user") throw new AppError("Only user-created threads are supported.", 400, "invalid_source");
    const { anchorStart, anchorEnd } = input;
    if (!Number.isInteger(anchorStart) || !Number.isInteger(anchorEnd)
      || anchorStart < 0 || anchorEnd <= anchorStart || anchorEnd > parent.content.length) {
      throw new AppError("Select a nonempty range within the parent message.", 400, "invalid_anchor");
    }
    if (repository.listThreads(parent.chatId).some((thread) => thread.parentMessageId === parent.id && thread.anchorStart < anchorEnd && thread.anchorEnd > anchorStart)) {
      throw new AppError("This selection overlaps an existing thread anchor.", 409, "anchor_overlap");
    }
    const main = mainMessages(repository, parent.chatId);
    const context = await prepareContext(main, parent.id, signal);
    throwIfAborted(signal);
    return repository.insertThread({ ...input, compressedContext: JSON.stringify(context), contextFrozenAt: main.at(-1)?.createdAt ?? null });
  } finally {
    generation.release();
  }
}

export async function refreshThreadContext(id: string, options: { repository?: ChatRepository; signal?: AbortSignal } = {}): Promise<ThreadData> {
  throwIfAborted(options.signal);
  const repository = options.repository ?? getRepository();
  const generation = acquireGeneration(`context:${id}`, options.signal);
  const signal = generation.controller.signal;
  try {
    throwIfAborted(signal);
    const thread = repository.getThread(id);
    if (!thread) throw new AppError("This thread no longer exists.", 404, "thread_not_found");
    const parent = requireParent(repository, thread.parentMessageId, thread.chatId);
    const main = mainMessages(repository, thread.chatId);
    const context = await prepareContext(main, parent.id, signal);
    const usageInvalidatedThrough = repository.listMessages(thread.chatId, thread.id).at(-1)?.createdAt ?? 0;
    throwIfAborted(signal);
    repository.updateThread(id, {
      compressedContext: JSON.stringify({ ...context, usageInvalidatedThrough, contextRevision: randomUUID() }),
      contextFrozenAt: main.at(-1)?.createdAt ?? null,
    });
    return getThreadData(id, repository);
  } finally {
    generation.release();
  }
}

export function getThreadData(id: string, repository: ChatRepository = getRepository()): ThreadData {
  const thread = repository.getThread(id);
  if (!thread) throw new AppError("This thread no longer exists.", 404, "thread_not_found");
  const parentMessage = repository.getMessage(thread.parentMessageId);
  if (!parentMessage) throw new AppError("The parent message could not be found.", 404, "message_not_found");
  const messages = repository.listMessages(thread.chatId, thread.id);
  const main = mainMessages(repository, thread.chatId);
  const briefing = parseFrozenContext(thread.compressedContext);
  const latestAssistantIndex = messages.findLastIndex((message) => message.role === "assistant");
  const latestAssistant = messages[latestAssistantIndex];
  const usageCutoff = Math.max(thread.contextFrozenAt ?? -1, getContextUsageCutoff(thread.compressedContext) ?? -1);
  const attributed = latestAssistant?.id === getContextMeasuredMessageId(thread.compressedContext);
  const usage = latestAssistant && (attributed || latestAssistant.createdAt > usageCutoff) ? latestAssistant.inputTokens : null;
  const actual = usage !== undefined && usage !== null;
  const comparisonHistory = actual ? messages.slice(0, latestAssistantIndex) : messages;
  return {
    thread, parentMessage, messages,
    context: {
      tokens: usage ?? estimateTokens(assembleThreadPrompt(thread, parentMessage, messages)),
      fullTokens: estimateTokens(assembleFullThreadPrompt(thread, main, comparisonHistory)),
      actual,
      newMessages: main.filter((message) => message.createdAt > (thread.contextFrozenAt ?? -1)).length,
      fallback: briefing?.kind !== "compressed",
      briefing,
    },
  };
}
