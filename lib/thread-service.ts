import { randomUUID } from "node:crypto";
import { getContextMeasuredMessageId, getContextUsageCutoff, parseBriefing, parseFrozenContext } from "./context";
import type { GenerationStore } from "./db/jobs";
import type { ChatRepository } from "./db/repository";
import { AppError } from "./errors";
import { assembleFullThreadPrompt, assembleThreadPrompt } from "./prompts";
import { compress, digestWriter, getProviderStatus } from "./provider";
import { estimateTokens } from "./tokens";
import type { FrozenContext, Message, PromptMessage, Thread, ThreadData } from "./types";
import { attachmentText, resolvePromptAttachments } from "./vision";

export interface CreateThreadInput {
  parentMessageId: string;
  anchorStart: number;
  anchorEnd: number;
  source: "user";
}

export interface ThreadServiceOptions {
  repository: ChatRepository;
  jobs: GenerationStore;
  signal?: AbortSignal;
  /** Lease-renewal cadence; tests shorten it to observe cross-instance stops quickly. */
  heartbeatMs?: number;
}

const CONTEXT_LEASE_MS = 30_000;

function compressionTimeoutMs(): number {
  const raw = Number(process.env.THREADS_COMPRESSION_TIMEOUT_MS ?? "45000");
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
}

function cancellation(): DOMException {
  return new DOMException("Context preparation stopped.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellation();
}

/** Resolves with `work`, or rejects as soon as `signal` aborts even if the provider ignores it. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancellation());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancellation());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function requireParent(repository: ChatRepository, id: string, chatId?: string): Promise<Message> {
  const parent = await repository.getMessage(id);
  if (!parent) throw new AppError("The selected message no longer exists.", 404, "message_not_found");
  if (parent.role !== "assistant" || !parent.complete || parent.threadId !== null || (chatId !== undefined && parent.chatId !== chatId)) {
    throw new AppError("Threads require a completed assistant message in the main conversation.", 400, "invalid_parent");
  }
  return parent;
}

function mainMessages(repository: ChatRepository, chatId: string): Promise<Message[]> {
  return repository.listMessages(chatId, null);
}

/**
 * Compresses the main conversation into a briefing with a bounded timeout. Timeouts and provider
 * failures fall back to the last few messages; only an explicit stop propagates as cancellation.
 */
async function prepareContext(repository: ChatRepository, main: Message[], parentId: string, signal: AbortSignal): Promise<FrozenContext> {
  throwIfAborted(signal);
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(compressionTimeoutMs())]);
  const turns: PromptMessage[] = main.map(({ role, content, attachments }) => attachments?.length ? { role, content, attachments } : { role, content });
  // Frozen context is text: images are represented by their cached digests (written now if missing).
  try {
    await resolvePromptAttachments({
      prompt: turns, modelKey: "fast", status: getProviderStatus(), signal: bounded, forceDigest: true, writer: digestWriter,
      load: (ids) => repository.loadAttachments(ids),
      save: (id, digest, model) => repository.saveAttachmentDigest(id, digest, model),
    });
  } catch {
    throwIfAborted(signal);
  }
  const withParent = (_turn: PromptMessage, index: number) => main[index].id !== parentId;
  try {
    const result = await raceAbort(Promise.resolve().then(() => compress({
      messages: turns.filter(withParent),
      direction: "main-to-thread",
      signal: bounded,
    })), signal);
    throwIfAborted(signal);
    const briefing = parseBriefing(result);
    if (briefing) return { kind: "compressed", briefing };
  } catch (error) {
    throwIfAborted(signal);
    // A provider-side abort is a stop, not a compression failure worth a fallback briefing.
    if (error instanceof Error && error.name === "AbortError") throw cancellation();
  }
  throwIfAborted(signal);
  return {
    kind: "fallback",
    messages: turns.slice(-4).map(({ role, content, attachments }) => ({ role, content: attachments?.length ? attachmentText(content, attachments, "digest") : content })),
  };
}

/** Runs `work` under a durable context job so a stop from any instance (or a lost lease) cancels it. */
async function withContextJob<T>(options: ThreadServiceOptions, chatId: string, threadId: string | null, scopeSuffix: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  throwIfAborted(options.signal);
  const requestId = randomUUID();
  const admitted = await options.jobs.admit({
    requestId, kind: "context", chatId, threadId: scopeSuffix ? `${threadId ?? "main"}:${scopeSuffix}` : threadId, payloadHash: scopeSuffix || "refresh", leaseMs: CONTEXT_LEASE_MS,
  });
  if (!admitted.admitted) throw new AppError("This context request is already running.", 409, "generation_busy");
  const job = admitted.job;
  const controller = new AbortController();
  const forward = () => controller.abort();
  options.signal?.addEventListener("abort", forward, { once: true });
  const heartbeat = setInterval(() => {
    void options.jobs.renew(job.id, job.fence, CONTEXT_LEASE_MS).then((lease) => {
      if (!lease || lease.cancelRequested) controller.abort();
    }).catch(() => undefined);
  }, options.heartbeatMs ?? CONTEXT_LEASE_MS / 3);
  let status: "completed" | "failed" | "stopped" = "failed";
  try {
    const result = await work(controller.signal);
    status = "completed";
    return result;
  } catch (error) {
    if (controller.signal.aborted) status = "stopped";
    throw error;
  } finally {
    clearInterval(heartbeat);
    options.signal?.removeEventListener("abort", forward);
    await options.jobs.finish(job.id, job.fence, status).catch(() => undefined);
  }
}

export async function createThread(input: CreateThreadInput, options: ThreadServiceOptions): Promise<Thread> {
  const { repository } = options;
  const parent = await requireParent(repository, input.parentMessageId);
  if (input.source !== "user") throw new AppError("Only user-created threads are supported.", 400, "invalid_source");
  const { anchorStart, anchorEnd } = input;
  if (!Number.isInteger(anchorStart) || !Number.isInteger(anchorEnd)
    || anchorStart < 0 || anchorEnd <= anchorStart || anchorEnd > parent.content.length) {
    throw new AppError("Select a nonempty range within the parent message.", 400, "invalid_anchor");
  }
  const existing = await repository.listThreads(parent.chatId);
  if (existing.some((thread) => thread.parentMessageId === parent.id && thread.anchorStart < anchorEnd && thread.anchorEnd > anchorStart)) {
    throw new AppError("This selection overlaps an existing thread anchor.", 409, "anchor_overlap");
  }
  return withContextJob(options, parent.chatId, null, `new:${randomUUID()}`, async (signal) => {
    const main = await mainMessages(repository, parent.chatId);
    const context = await prepareContext(repository, main, parent.id, signal);
    throwIfAborted(signal);
    return repository.insertThread({ ...input, compressedContext: JSON.stringify(context), contextFrozenAt: main.at(-1)?.createdAt ?? null });
  });
}

export async function refreshThreadContext(id: string, options: ThreadServiceOptions): Promise<ThreadData> {
  const { repository } = options;
  const thread = await repository.getThread(id);
  if (!thread) throw new AppError("This thread no longer exists.", 404, "thread_not_found");
  return withContextJob(options, thread.chatId, thread.id, "", async (signal) => {
    const parent = await requireParent(repository, thread.parentMessageId, thread.chatId);
    const [main, threadMessages] = await Promise.all([mainMessages(repository, thread.chatId), repository.listMessages(thread.chatId, thread.id)]);
    const context = await prepareContext(repository, main, parent.id, signal);
    const usageInvalidatedThrough = threadMessages.at(-1)?.createdAt ?? 0;
    throwIfAborted(signal);
    await repository.updateThread(id, {
      compressedContext: JSON.stringify({ ...context, usageInvalidatedThrough, contextRevision: randomUUID() }),
      contextFrozenAt: main.at(-1)?.createdAt ?? null,
    }, { expectContextFrozenAt: thread.contextFrozenAt });
    return getThreadData(id, repository);
  });
}

export async function getThreadData(id: string, repository: ChatRepository): Promise<ThreadData> {
  const thread = await repository.getThread(id);
  if (!thread) throw new AppError("This thread no longer exists.", 404, "thread_not_found");
  const [parentMessage, messages, main] = await Promise.all([
    repository.getMessage(thread.parentMessageId),
    repository.listMessages(thread.chatId, thread.id),
    mainMessages(repository, thread.chatId),
  ]);
  if (!parentMessage) throw new AppError("The parent message could not be found.", 404, "message_not_found");
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
