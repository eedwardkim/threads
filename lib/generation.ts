import { createHash } from "node:crypto";
import { attributeContextUsage } from "./context";
import type { GenerationJob, GenerationStore } from "./db/jobs";
import type { ChatRepository } from "./db/repository";
import { AppError, readableError } from "./errors";
import { normalizeMathDelimiters } from "./math";
import type { ModelKey } from "./models";
import { assembleMainPrompt, assembleThreadPrompt } from "./prompts";
import { getProviderStatus, requireProviderAvailable, streamChat } from "./provider";
import { ensureDemoChat } from "./seed";
import type { Message, PromptMessage, StreamEvent, Thread } from "./types";

export interface GenerationRequest {
  requestId: string;
  chatId: string;
  threadId: string | null;
  content?: string;
  modelKey: ModelKey;
  retryMessageId?: string;
}

export interface GenerationTuning {
  /** How long a lease lasts before another instance may treat this worker as dead. */
  leaseMs: number;
  /** Minimum spacing between checkpoint writes. */
  checkpointIntervalMs: number;
  /** Unsaved bytes that force a checkpoint even inside the interval. */
  checkpointBytes: number;
  /** Unsaved bytes tolerated while checkpoint writes keep failing before the stream is stopped. */
  maxUnsavedBytes: number;
  /** Consecutive failed checkpoint writes tolerated before the stream is stopped. */
  maxCheckpointFailures: number;
  /** Wall-clock budget for the whole generation, leaving a margin before the platform deadline. */
  deadlineMs: number;
  /** Lease renewal / durable-stop polling cadence; bounds cross-instance Stop propagation. */
  heartbeatMs: number;
}

export interface GenerationDeps {
  repository: ChatRepository;
  jobs: GenerationStore;
  /** Aborts when the HTTP client disconnects. */
  signal?: AbortSignal;
  tuning?: Partial<GenerationTuning>;
  now?: () => number;
}

export interface PreparedGeneration {
  job: GenerationJob;
  attempt: number;
  message: Message;
  userMessage: Message | null;
  thread: Thread | null;
  prompt: PromptMessage[];
  modelKey: ModelKey;
}

export const DEFAULT_TUNING: GenerationTuning = {
  leaseMs: 30_000,
  checkpointIntervalMs: 400,
  checkpointBytes: 8 * 1024,
  maxUnsavedBytes: 256 * 1024,
  maxCheckpointFailures: 3,
  deadlineMs: 280_000,
  heartbeatMs: 1_000,
};

export function payloadHash(input: GenerationRequest): string {
  return createHash("sha256").update(JSON.stringify({
    chatId: input.chatId, threadId: input.threadId, content: input.content ?? null, modelKey: input.modelKey, retryMessageId: input.retryMessageId ?? null,
  })).digest("hex");
}

export class DuplicateRequest extends AppError {
  constructor(readonly job: GenerationJob) {
    super(job.status === "running" ? "This request is already being answered." : "This request was already answered.", 409, "duplicate_request");
  }
}

/**
 * Validates the request, admits it as a durable job and creates the message rows.
 * Nothing here talks to a model provider; a duplicate request id is rejected before any paid call.
 */
export async function prepareGeneration(input: GenerationRequest, deps: GenerationDeps): Promise<PreparedGeneration> {
  const { repository, jobs } = deps;
  const tuning = { ...DEFAULT_TUNING, ...deps.tuning };
  const status = getProviderStatus();
  if (!status.mock) requireProviderAvailable(input.modelKey, status);
  if (!(await repository.getChat(input.chatId))) throw new AppError("This conversation no longer exists.", 404, "chat_not_found");
  await ensureDemoChat(repository, input.chatId);
  const thread = input.threadId === null ? null : await repository.getThread(input.threadId);
  if (input.threadId !== null && (!thread || thread.chatId !== input.chatId)) {
    throw new AppError("Thread not found in this chat.", 404, "thread_not_found");
  }
  const parent = thread ? await repository.getMessage(thread.parentMessageId) : null;
  if (thread && (!parent || parent.chatId !== input.chatId || parent.threadId !== null || parent.role !== "assistant" || !parent.complete)) {
    throw new AppError("This thread needs a completed parent message.", 409, "invalid_parent");
  }
  const retry = input.retryMessageId ? await repository.getMessage(input.retryMessageId) : null;
  if (input.retryMessageId && (!retry || retry.chatId !== input.chatId || retry.threadId !== input.threadId)) {
    throw new AppError("Message not found in this conversation.", 404, "message_not_found");
  }
  if (retry && (retry.role !== "assistant" || retry.complete)) {
    throw new AppError("Only incomplete assistant messages can be retried.", 409, "message_immutable");
  }
  if (deps.signal?.aborted) throw new AppError("Generation stopped.", 499, "aborted");

  const admission = await jobs.admit({
    requestId: input.requestId, kind: "generation", chatId: input.chatId, threadId: input.threadId,
    payloadHash: payloadHash(input), leaseMs: tuning.leaseMs,
  });
  if (!admission.admitted) throw new DuplicateRequest(admission.job);
  const job = admission.job;
  try {
    if (thread && thread.resolved) await repository.updateThread(thread.id, { resolved: false });
    let history = await repository.listMessages(input.chatId, input.threadId);
    if (retry) {
      const index = history.findIndex((message) => message.id === retry.id);
      if (index < 0) throw new AppError("Message not found in this conversation.", 404, "message_not_found");
      history = history.slice(0, index);
    }
    const prompt = thread && parent ? assembleThreadPrompt(thread, parent, history) : assembleMainPrompt(history);
    let userMessage: Message | null = null;
    let message: Message;
    let attempt: number;
    if (retry) {
      ({ message, attempt } = await repository.beginRetry(retry.id));
    } else {
      const scope = { chatId: input.chatId, threadId: input.threadId, modelKey: input.modelKey };
      userMessage = await repository.appendMessage({ ...scope, role: "user", content: input.content!, complete: true });
      prompt.push({ role: userMessage.role, content: userMessage.content });
      message = await repository.appendMessage({ ...scope, role: "assistant", content: "", complete: false });
      attempt = 0;
    }
    if (!(await jobs.attach(job.id, job.fence, { messageId: message.id, userMessageId: userMessage?.id ?? null, attempt }))) {
      throw new AppError("Generation was stopped before it started.", 409, "aborted");
    }
    return { job, attempt, message, userMessage, thread, prompt, modelKey: message.modelKey ?? input.modelKey };
  } catch (error) {
    await jobs.finish(job.id, job.fence, "failed", error instanceof AppError ? error.code : "prepare_failed").catch(() => undefined);
    throw error;
  }
}

type StopReason = "client" | "stop" | "lease_lost" | "deadline" | "persistence_failed" | "stale_generation" | "guest_expired";

/**
 * Persists streamed text in bounded, coalesced checkpoints: at most one write in flight,
 * newer text replaces queued text, and every write is fenced to the current attempt.
 */
class CheckpointWriter {
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastWriteAt = 0;
  private closed = false;
  private failures = 0;
  saved: Message;
  savedLength = 0;
  latest = "";

  constructor(
    private readonly repository: ChatRepository,
    message: Message,
    private readonly attempt: number,
    private readonly tuning: GenerationTuning,
    private readonly now: () => number,
    private readonly onFatal: (reason: StopReason, error: AppError) => void,
  ) {
    this.saved = message;
    this.latest = message.content;
    this.savedLength = message.content.length;
  }

  get unsavedBytes(): number {
    return this.latest.length - this.savedLength;
  }

  push(content: string): void {
    this.latest = content;
    if (this.closed) return;
    if (this.unsavedBytes >= this.tuning.checkpointBytes || this.now() - this.lastWriteAt >= this.tuning.checkpointIntervalMs) {
      this.flush();
    } else if (!this.timer && !this.inFlight) {
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.tuning.checkpointIntervalMs - (this.now() - this.lastWriteAt));
    }
  }

  private flush(): void {
    if (this.closed || this.inFlight || this.latest.length === this.savedLength) return;
    const content = this.latest;
    this.lastWriteAt = this.now();
    this.inFlight = this.repository.checkpointMessage(this.saved.id, content, this.attempt).then((row) => {
      this.failures = 0;
      if (this.closed) return;
      if (!row) {
        this.close();
        this.onFatal("stale_generation", new AppError("This message was retried by a newer request.", 409, "stale_generation"));
        return;
      }
      this.saved = row;
      this.savedLength = content.length;
    }, () => {
      this.failures += 1;
      if (!this.closed && (this.failures >= this.tuning.maxCheckpointFailures || this.unsavedBytes >= this.tuning.maxUnsavedBytes)) {
        this.close();
        this.onFatal("persistence_failed", new AppError("Your answer could not be saved. The last saved part is kept.", 503, "persistence_failed"));
      }
    }).finally(() => {
      this.inFlight = null;
      if (!this.closed && this.latest.length !== this.savedLength) {
        if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.tuning.checkpointIntervalMs);
      }
    });
  }

  /** Stops future checkpoint writes; the in-flight one (if any) is awaited by `drain`. */
  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async drain(): Promise<void> {
    this.close();
    if (this.inFlight) await this.inFlight.catch(() => undefined);
  }
}

/**
 * Streams the answer as NDJSON. The provider stream never waits on the database; leases are renewed
 * on a timer so long prefill/reasoning pauses do not expire the job; finalization writes the exact
 * final state before `finish` is emitted.
 */
export function streamGeneration(prepared: PreparedGeneration, deps: GenerationDeps): ReadableStream<Uint8Array> {
  const { repository, jobs } = deps;
  const tuning = { ...DEFAULT_TUNING, ...deps.tuning };
  const now = deps.now ?? Date.now;
  const { job, attempt, thread } = prepared;
  const encoder = new TextEncoder();
  const controller = new AbortController();
  const signal = controller.signal;
  let stopReason: StopReason | null = null;
  let disconnected = false;
  let task: Promise<void> | undefined;

  const stop = (reason: StopReason) => {
    if (signal.aborted) return;
    stopReason = reason;
    controller.abort();
  };
  const onClientAbort = () => { disconnected = true; stop("client"); };
  deps.signal?.addEventListener("abort", onClientAbort, { once: true });
  if (deps.signal?.aborted) onClientAbort();

  async function pump(output: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    let message = prepared.message;
    let content = message.content;
    let successful = false;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let fatal: AppError | null = null;
    let providerFailed = false;
    const emit = (event: StreamEvent): boolean => {
      if (disconnected) return false;
      try {
        output.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        return true;
      } catch {
        onClientAbort();
        return false;
      }
    };
    const emitError = (error: unknown) => {
      const readable = readableError(error);
      emit({ type: "error", message: readable.message, code: readable.code, messageId: message.id });
    };
    const writer = new CheckpointWriter(repository, message, attempt, tuning, now, (reason, error) => {
      fatal = error;
      stop(reason);
    });
    const startedAt = now();
    const deadline = setTimeout(() => stop("deadline"), tuning.deadlineMs);
    const heartbeat = setInterval(() => {
      void jobs.renew(job.id, job.fence, tuning.leaseMs).then((lease) => {
        if (!lease) stop("lease_lost");
        else if (lease.cancelRequested) stop("stop");
      }).catch((error: unknown) => {
        if (error instanceof AppError && error.code === "guest_expired") stop("guest_expired");
      });
    }, Math.min(tuning.heartbeatMs, Math.max(50, Math.floor(tuning.leaseMs / 3))));

    try {
      if (!emit({ type: "start", message, userMessage: prepared.userMessage })) return;
      for await (const chunk of streamChat({ messages: prepared.prompt, modelKey: prepared.modelKey, signal })) {
        if (signal.aborted) break;
        if (chunk.type === "text") {
          content += chunk.text;
          writer.push(content);
          if (!emit({ type: "delta", messageId: message.id, text: chunk.text })) break;
        } else {
          inputTokens = chunk.inputTokens;
          outputTokens = chunk.outputTokens;
        }
      }
      successful = !signal.aborted;
    } catch (error) {
      if (!signal.aborted) {
        providerFailed = true;
        emitError(error);
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(deadline);
      let status: "completed" | "stopped" | "failed" = successful ? "completed" : providerFailed ? "failed" : "stopped";
      let errorCode: string | null = providerFailed ? "provider_error" : stopReason;
      try {
        await writer.drain();
        if (fatal) {
          status = "failed";
          emitError(fatal);
          message = writer.saved;
        } else {
          if (successful) content = normalizeMathDelimiters(content);
          try {
            message = await repository.finishMessage(message.id, { content, complete: successful, inputTokens, outputTokens }, { attempt });
            if (successful && thread && inputTokens !== null) {
              const current = await repository.getThread(thread.id);
              if (current && current.contextFrozenAt === thread.contextFrozenAt) {
                const compressedContext = attributeContextUsage(current.compressedContext, thread.compressedContext, message.id);
                if (compressedContext !== null) {
                  await repository.updateThread(thread.id, { compressedContext }, { expectContextFrozenAt: thread.contextFrozenAt }).catch(() => undefined);
                }
              }
            }
            if (inputTokens !== null || outputTokens !== null) await jobs.recordUsage(inputTokens, outputTokens).catch(() => undefined);
          } catch (error) {
            // The final write failed: report it and fall back to the last confirmed checkpoint.
            status = "failed";
            errorCode = error instanceof AppError ? error.code : "finalize_failed";
            emitError(error);
            message = writer.saved;
            successful = false;
          }
        }
        emit({ type: "finish", message: { ...message, complete: message.complete && successful } });
      } finally {
        deps.signal?.removeEventListener("abort", onClientAbort);
        await jobs.finish(job.id, job.fence, status, errorCode).catch(() => undefined);
        if (process.env.THREADS_LOG_TIMING === "true") {
          console.info("[generation] finished", { status, ms: now() - startedAt, chars: content.length });
        }
        try {
          output.close();
        } catch {
          disconnected = true;
        }
      }
    }
  }

  return new ReadableStream<Uint8Array>({
    start(output) {
      task = pump(output).catch(() => undefined);
    },
    cancel() {
      onClientAbort();
      return task;
    },
  });
}

export const STREAM_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "private, no-cache, no-store, no-transform",
  "X-Accel-Buffering": "no",
} as const;
