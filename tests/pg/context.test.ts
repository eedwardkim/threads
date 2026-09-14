import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PATCH, POST } from "../../app/api/threads/route";
import { setAuthResolverForTests } from "../../lib/auth/server";
import { parseFrozenContext } from "../../lib/context";
import { setDatabaseForTests } from "../../lib/db/client";
import { GenerationStore } from "../../lib/db/jobs";
import type { ChatRepository } from "../../lib/db/repository";
import * as prompts from "../../lib/prompts";
import { compress } from "../../lib/provider";
import * as service from "../../lib/thread-service";
import { estimateTokens } from "../../lib/tokens";
import type { Briefing, FrozenContext, Message, PromptMessage, Thread } from "../../lib/types";
import { newUser, separateInstance, testDatabase } from "./harness";

vi.mock("../../lib/provider", () => ({ compress: vi.fn() }));

const briefing: Briefing = {
  goal: "Keep the surrounding design available",
  constraints: ["Preserve local reads", "  Keep whitespace\ninside fields  "],
  decisions: ["Commit the edit and outbox together"],
  artifacts: ["```ts\nconst durable = true;\n```"],
  open_questions: ["How should retries be scheduled?"],
};
const updatedBriefing: Briefing = { ...briefing, goal: "Explicitly updated surrounding design" };
let repository: ChatRepository;
let jobs: GenerationStore;
let userId: string;
let chatId: string;
let parent: Message;
let timestamp: number;

function append(input: Partial<Message> = {}): Promise<Message> {
  return repository.appendMessage({
    chatId, threadId: null, role: "user", content: "Main question", modelKey: "fast", createdAt: timestamp++, ...input,
  });
}

function input(overrides: Partial<service.CreateThreadInput> = {}): service.CreateThreadInput {
  const anchorStart = parent.content.indexOf("**durable boundary**");
  return { parentMessageId: parent.id, anchorStart, anchorEnd: anchorStart + "**durable boundary**".length, source: "user", ...overrides };
}

function options(signal?: AbortSignal): service.ThreadServiceOptions {
  return { repository, jobs, signal, heartbeatMs: 50 };
}

function create(overrides: Partial<service.CreateThreadInput> = {}, signal?: AbortSignal): Promise<Thread> {
  return service.createThread(input(overrides), options(signal));
}

async function running(): Promise<number> {
  return (await jobs.listRunning()).length;
}

/** Occupies a scope with a durable job, like a stream running on another instance. */
async function occupy(threadId: string | null = null) {
  const admitted = await jobs.admit({ requestId: crypto.randomUUID(), kind: "generation", chatId, threadId, payloadHash: "busy", leaseMs: 30_000 });
  if (!admitted.admitted) throw new Error("scope already occupied");
  return { release: () => jobs.finish(admitted.job.id, admitted.job.fence, "stopped") };
}

function promptRows(rows: Message[]): PromptMessage[] {
  return rows.map(({ role, content }) => ({ role, content }));
}

function fallback(rows: Message[]): FrozenContext {
  return { kind: "fallback", messages: promptRows(rows.slice(-4)) };
}

async function currentFallback(): Promise<FrozenContext> {
  return fallback(await repository.listMessages(chatId));
}

async function existingThread(context: FrozenContext | null | "current" = "current", overrides: Partial<service.CreateThreadInput> = {}): Promise<Thread> {
  const main = await repository.listMessages(chatId);
  const frozen = context === "current" ? fallback(main) : context;
  return repository.insertThread({
    ...input(overrides), compressedContext: frozen === null ? null : JSON.stringify(frozen),
    contextFrozenAt: main.at(-1)?.createdAt ?? null,
  });
}

async function answer(thread: Thread, inputTokens: number | null, complete = true, content = "Thread response that was not part of its input"): Promise<Message> {
  const row = await append({ threadId: thread.id, role: "assistant", content, complete: false });
  return await repository.finishMessage(row.id, { content, complete, inputTokens, outputTokens: 9 });
}

async function fullPrompt(thread: Thread, history: Message[]): Promise<PromptMessage[]> {
  return [...prompts.assembleMainPrompt(await repository.listMessages(chatId)), { role: "system", content: `Thread subject:\n${thread.anchorExact}` }, ...promptRows(history)];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

beforeAll(() => setDatabaseForTests(testDatabase()));
afterAll(() => setDatabaseForTests(undefined));

beforeEach(async () => {
  const user = newUser();
  ({ repository, jobs, userId } = user);
  setAuthResolverForTests(async () => ({ id: userId, email: null }));
  vi.mocked(compress).mockReset().mockResolvedValue(briefing);
  chatId = (await repository.createChat()).id;
  timestamp = 100;
  await append({ content: "FIRST_MAIN_SENTINEL\n  keep the full relevant history  " });
  await append({ role: "assistant", content: "Earlier answer with exact bytes\n\tand spacing" });
  await append({ content: "Third main question" });
  await append({ role: "assistant", content: "Fourth main answer\n```ts\nconst raw = '  unchanged  ';\n```" });
  await append({ content: "Fifth main question\n\n  unchanged  " });
  parent = await append({ role: "assistant", content: "# Full parent\n\nA **durable boundary** keeps the raw source.\n\n```ts\nconst keep = '  verbatim  ';\n```\n" });
});

afterEach(async () => {
  setAuthResolverForTests(undefined);
  vi.restoreAllMocks();
  expect(await running()).toBe(0);
});

describe("frozen main-to-thread compression", () => {
  it.each(["object", "JSON string"])("accepts a structured %s, calls compression once, and never regenerates on reads", async (format) => {
    vi.mocked(compress).mockResolvedValueOnce(format === "object" ? briefing : JSON.stringify(briefing));
    const before = await repository.listMessages(chatId);
    const thread = await create();
    expect(JSON.parse(thread.compressedContext!)).toEqual({ kind: "compressed", briefing });
    expect(thread.contextFrozenAt).toBe(before.at(-1)!.createdAt);
    expect(thread.anchorExact).toBe(parent.content.slice(thread.anchorStart, thread.anchorEnd));
    expect((await service.getThreadData(thread.id, repository)).context).toMatchObject({ fallback: false, briefing: { kind: "compressed", briefing }, newMessages: 0 });
    expect((await service.getThreadData(thread.id, repository)).messages).toEqual([]);
    expect(compress).toHaveBeenCalledOnce();
    expect(await repository.listMessages(chatId)).toEqual(before);
  });

  it("sends every surrounding main message verbatim but never the parent, thread rows, or other chats", async () => {
    const sibling = await existingThread(null, { anchorStart: 0, anchorEnd: 1 });
    await append({ threadId: sibling.id, content: "PRIVATE_THREAD_SENTINEL" });
    await append({ threadId: sibling.id, role: "assistant", content: "PRIVATE_THREAD_ASSISTANT_SENTINEL" });
    await append({ chatId: (await repository.createChat()).id, content: "OTHER_CHAT_SENTINEL" });
    const main = await repository.listMessages(chatId);
    await create();
    expect(compress).toHaveBeenCalledExactlyOnceWith({
      messages: promptRows(main.filter((message) => message.id !== parent.id)),
      direction: "main-to-thread", signal: expect.any(AbortSignal),
    });
    expect(vi.mocked(compress).mock.calls[0][0].messages).toHaveLength(5);
  });

  it("captures the whole main history even when the selected parent is an older assistant", async () => {
    const main = await repository.listMessages(chatId);
    const olderParent = main[1];
    const thread = await create({ parentMessageId: olderParent.id, anchorStart: 0, anchorEnd: 5 });
    expect(vi.mocked(compress).mock.calls[0][0].messages).toEqual(promptRows(main.filter((message) => message.id !== olderParent.id)));
    expect(thread.contextFrozenAt).toBe(parent.createdAt);
  });

  it("validates a missing parent before calling compression", async () => {
    await expect(create({ parentMessageId: "missing" })).rejects.toMatchObject({ code: "message_not_found" });
    expect(compress).not.toHaveBeenCalled();
    expect(await repository.listThreads(chatId)).toEqual([]);
  });

  it.each(["user", "incomplete", "thread"])("rejects a %s parent before calling compression", async (kind) => {
    const branch = kind === "thread" ? await existingThread(null, { anchorStart: 0, anchorEnd: 1 }) : null;
    const invalidParent = await append({ role: kind === "user" ? "user" : "assistant", complete: kind !== "incomplete", threadId: branch?.id ?? null, content: "Invalid parent" });
    await expect(create({ parentMessageId: invalidParent.id, anchorStart: 0, anchorEnd: 1 })).rejects.toMatchObject({ code: "invalid_parent" });
    expect(compress).not.toHaveBeenCalled();
    expect(await repository.listThreads(chatId)).toHaveLength(branch ? 1 : 0);
  });

  it.each([
    [-1, 1], [0, 0], [2, 1], [0, 100_000], [0.5, 1], [0, 1.5], [Number.NaN, 1], [0, Number.POSITIVE_INFINITY],
  ])("validates bounds (%s, %s) before calling compression", async (anchorStart, anchorEnd) => {
    await expect(create({ anchorStart, anchorEnd })).rejects.toMatchObject({ code: "invalid_anchor" });
    expect(compress).not.toHaveBeenCalled();
    expect(await repository.listThreads(chatId)).toEqual([]);
  });

  it("validates the source and existing resolved anchors before calling compression", async () => {
    await expect(create({ source: "model" as "user" })).rejects.toMatchObject({ code: "invalid_source" });
    const thread = await existingThread();
    await repository.updateThread(thread.id, { resolved: true });
    await expect(create()).rejects.toMatchObject({ code: "anchor_overlap" });
    expect(compress).not.toHaveBeenCalled();
    expect(await repository.listThreads(chatId)).toHaveLength(1);
  });

  it("allows adjacent anchors but retains the repository's final atomic overlap validation", async () => {
    await existingThread(null, { anchorStart: 0, anchorEnd: 1 });
    await create({ anchorStart: 1, anchorEnd: 2 });
    vi.mocked(compress).mockImplementationOnce(async () => {
      await existingThread();
      return briefing;
    });
    await expect(create()).rejects.toMatchObject({ code: "anchor_overlap" });
    expect(compress).toHaveBeenCalledTimes(2);
    expect(await repository.listThreads(chatId)).toHaveLength(3);
  });

  it.each([
    ["unparseable JSON", "not JSON"],
    ["prose JSON", JSON.stringify("A prose summary is not a briefing")],
    ["code-fenced JSON", `\`\`\`json\n${JSON.stringify(briefing)}\n\`\`\``],
    ["null", null],
    ["missing fields", { goal: "Only a goal" }],
    ["non-string goal", { ...briefing, goal: 7 }],
    ["non-array constraints", { ...briefing, constraints: "Not an array" }],
    ["non-string decision", { ...briefing, decisions: [3] }],
    ["non-array artifacts", { ...briefing, artifacts: null }],
    ["missing open questions", { ...briefing, open_questions: undefined }],
    ["provider failure", new Error("PRIVATE_PROVIDER_FAILURE_SENTINEL")],
  ])("stores the exact last four main rows for %s", async (_, result) => {
    const sibling = await existingThread(null, { anchorStart: 0, anchorEnd: 1 });
    await append({ threadId: sibling.id, content: "PRIVATE_THREAD_SENTINEL" });
    const main = await repository.listMessages(chatId);
    if (result instanceof Error) vi.mocked(compress).mockRejectedValueOnce(result);
    else vi.mocked(compress).mockResolvedValueOnce(result);
    const thread = await create();
    expect(JSON.parse(thread.compressedContext!)).toEqual(fallback(main));
    expect(thread.contextFrozenAt).toBe(main.at(-1)!.createdAt);
    expect((await service.getThreadData(thread.id, repository)).context).toMatchObject({ fallback: true, briefing: fallback(main) });
    expect(compress).toHaveBeenCalledOnce();
    expect(await repository.listMessages(chatId)).toEqual(main);
  });

  it("uses all available main rows if fewer than four exist and does not log provider content", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const otherParent = await append({ chatId: (await repository.createChat()).id, role: "assistant", content: "  The only main row\n" });
    vi.mocked(compress).mockImplementationOnce(() => { throw new Error("PRIVATE_PROVIDER_FAILURE_SENTINEL"); });
    const thread = await create({ parentMessageId: otherParent.id, anchorStart: 0, anchorEnd: 3 });
    expect(JSON.parse(thread.compressedContext!)).toEqual({ kind: "fallback", messages: promptRows([otherParent]) });
    expect(vi.mocked(compress).mock.calls[0][0].messages).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it.each(["compressed", "fallback"])("freezes the pre-call snapshot for %s even if main advances during compression", async (kind) => {
    const pending = deferred<unknown>();
    vi.mocked(compress).mockReturnValueOnce(pending.promise);
    const main = await repository.listMessages(chatId);
    const operation = create();
    await vi.waitFor(() => expect(compress).toHaveBeenCalledOnce());
    await append({ content: "MAIN_ADDED_DURING_COMPRESSION" });
    pending.resolve(kind === "compressed" ? briefing : "invalid JSON");
    const thread = await operation;
    expect(thread.contextFrozenAt).toBe(main.at(-1)!.createdAt);
    expect(JSON.parse(thread.compressedContext!)).toEqual(kind === "compressed" ? { kind, briefing } : fallback(main));
    expect(vi.mocked(compress).mock.calls[0][0].messages).toEqual(promptRows(main.filter((message) => message.id !== parent.id)));
    await append({ content: "MAIN_ADDED_AFTER_COMPRESSION" });
    await append({ threadId: thread.id, content: "THREAD_ADDED_AFTER_COMPRESSION" });
    const data = await service.getThreadData(thread.id, repository);
    expect(data.context.newMessages).toBe(2);
    expect(data.thread.compressedContext).toBe(thread.compressedContext);
    expect(data.thread.contextFrozenAt).toBe(thread.contextFrozenAt);
    expect(compress).toHaveBeenCalledOnce();
  });
});

describe("context cancellation and locking", () => {
  it.each([undefined, "cancelled by caller", new Error("arbitrary abort reason")])("normalizes pre-aborted requests to AbortError (%s) without compression or insertion", async (reason) => {
    const controller = new AbortController();
    controller.abort(reason);
    await expect(create({}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(compress).not.toHaveBeenCalled();
    expect(await repository.listThreads(chatId)).toEqual([]);
  });

  it.each(["request", "stop"])("cancels a pending provider through %s without waiting for its cooperation or committing later", async (mode) => {
    const pending = deferred<unknown>();
    const controller = new AbortController();
    vi.mocked(compress).mockReturnValueOnce(pending.promise);
    const operation = create({}, controller.signal);
    await vi.waitFor(() => expect(compress).toHaveBeenCalledOnce());
    expect(await running()).toBe(1);
    if (mode === "request") controller.abort("stopped");
    else expect(await new GenerationStore(separateInstance(), userId).requestStopScope(chatId)).toBe(1);
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(await running()).toBe(0);
    pending.resolve(briefing);
    await pending.promise;
    expect(await repository.listThreads(chatId)).toEqual([]);
    expect(compress).toHaveBeenCalledOnce();
  });

  it("does not mistake a provider AbortError for a fallback-worthy failure", async () => {
    vi.mocked(compress).mockRejectedValueOnce(new DOMException("Stopped", "AbortError"));
    await expect(create()).rejects.toMatchObject({ name: "AbortError" });
    expect(await repository.listThreads(chatId)).toEqual([]);
  });

  it("checks cancellation again when a provider returns a valid briefing after aborting", async () => {
    const controller = new AbortController();
    vi.mocked(compress).mockImplementationOnce(async () => {
      controller.abort(new Error("Stopped"));
      return briefing;
    });
    await expect(create({}, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(await repository.listThreads(chatId)).toEqual([]);
  });
});

describe("explicit context refresh", () => {
  it("leaves legacy fallbacks alone on read, then changes only context fields on explicit refresh", async () => {
    const thread = await existingThread();
    await repository.updateThread(thread.id, { resolved: true });
    await append({ threadId: thread.id, content: "PRIVATE_THREAD_QUESTION" });
    await answer(thread, 73, true, "PRIVATE_THREAD_ANSWER");
    await append({ content: "New main requirement" });
    const before = await service.getThreadData(thread.id, repository);
    const main = await repository.listMessages(chatId);
    expect(before.context.fallback).toBe(true);
    expect(before.context.newMessages).toBe(1);
    expect(compress).not.toHaveBeenCalled();
    const update = vi.spyOn(repository, "updateThread");
    vi.mocked(compress).mockResolvedValueOnce(updatedBriefing);
    const data = await service.refreshThreadContext(thread.id, options());
    expect(compress).toHaveBeenCalledExactlyOnceWith({ messages: promptRows(main.filter((message) => message.id !== parent.id)), direction: "main-to-thread", signal: expect.any(AbortSignal) });
    expect(update).toHaveBeenCalledOnce();
    expect(Object.keys(update.mock.calls[0][1]).sort()).toEqual(["compressedContext", "contextFrozenAt"]);
    expect(data.thread).toEqual({ ...before.thread, compressedContext: data.thread.compressedContext, contextFrozenAt: main.at(-1)!.createdAt });
    expect(data.parentMessage).toEqual(before.parentMessage);
    expect(data.messages).toEqual(before.messages);
    expect(data.context).toMatchObject({ actual: false, newMessages: 0, fallback: false, briefing: { kind: "compressed", briefing: updatedBriefing } });
    expect(await repository.listMessages(chatId)).toEqual(main);
    expect(await service.getThreadData(thread.id, repository)).toEqual(data);
    expect(compress).toHaveBeenCalledOnce();
  });

  it.each(["invalid JSON", { ...briefing, artifacts: false }, new Error("Provider unavailable")])("refresh stores a proper last-four fallback after compression failure: %s", async (result) => {
    const thread = await existingThread({ kind: "compressed", briefing });
    await append({ threadId: thread.id, content: "PRIVATE_THREAD_SENTINEL" });
    await append({ content: "New main message" });
    const expected = await currentFallback();
    if (result instanceof Error) vi.mocked(compress).mockRejectedValueOnce(result);
    else vi.mocked(compress).mockResolvedValueOnce(result);
    const data = await service.refreshThreadContext(thread.id, options());
    expect(data.context.briefing).toEqual(expected);
    expect(JSON.parse(data.thread.compressedContext!)).toMatchObject(expected);
    expect(data.context.fallback).toBe(true);
    expect(data.thread.contextFrozenAt).toBe((await repository.listMessages(chatId)).at(-1)!.createdAt);
    expect(compress).toHaveBeenCalledOnce();
  });

  it.each(["pre-aborted", "pending", "provider-aborted"])("preserves all stored context and messages when refresh is %s", async (mode) => {
    const thread = await existingThread();
    await append({ threadId: thread.id, content: "Thread history stays" });
    const before = await service.getThreadData(thread.id, repository);
    const update = vi.spyOn(repository, "updateThread");
    const controller = new AbortController();
    const pending = deferred<unknown>();
    if (mode === "pre-aborted") controller.abort("cancelled");
    if (mode === "pending") vi.mocked(compress).mockReturnValueOnce(pending.promise);
    if (mode === "provider-aborted") vi.mocked(compress).mockRejectedValueOnce(new DOMException("Stopped", "AbortError"));
    const operation = service.refreshThreadContext(thread.id, options(controller.signal));
    if (mode === "pending") controller.abort("cancelled");
    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    pending.resolve(updatedBriefing);
    await pending.promise;
    expect(update).not.toHaveBeenCalled();
    expect(await service.getThreadData(thread.id, repository)).toEqual(before);
  });

  it("rejects missing threads and busy operations before compression", async () => {
    await expect(service.refreshThreadContext("missing", options())).rejects.toMatchObject({ code: "thread_not_found" });
    const thread = await existingThread();
    const lease = await occupy(thread.id);
    try {
      await expect(service.refreshThreadContext(thread.id, options())).rejects.toMatchObject({ code: "generation_busy" });
    } finally {
      await lease.release();
    }
    expect(compress).not.toHaveBeenCalled();
  });

  it("refreshes to the captured main cutoff rather than messages arriving while compression is pending", async () => {
    const thread = await existingThread();
    await append({ content: "Captured for refresh" });
    const main = await repository.listMessages(chatId);
    const pending = deferred<unknown>();
    vi.mocked(compress).mockReturnValueOnce(pending.promise);
    const operation = service.refreshThreadContext(thread.id, options());
    await vi.waitFor(() => expect(compress).toHaveBeenCalledOnce());
    await append({ content: "Arrived after refresh snapshot" });
    pending.resolve(updatedBriefing);
    const data = await operation;
    expect(data.thread.contextFrozenAt).toBe(main.at(-1)!.createdAt);
    expect(data.context.newMessages).toBe(1);
    expect(vi.mocked(compress).mock.calls[0][0].messages).toEqual(promptRows(main.filter((message) => message.id !== parent.id)));
  });
});

describe("context token accounting and verbatim prompts", () => {
  it("uses the same estimator for the assembled thread and full-main comparison, with unabridged parent, anchor, and history", async () => {
    parent = await append({ role: "assistant", content: `  Full parent\n${"**durable boundary**\n```ts\nconst raw = '  unchanged  ';\n```\n".repeat(1_000)}` });
    const thread = await create({ anchorStart: 2, anchorEnd: parent.content.length - 2 });
    const question = await append({ threadId: thread.id, content: "  Raw thread question\n".repeat(1_000) });
    const response = await answer(thread, null, true, "  Full thread response\n".repeat(1_000));
    const history = [question, response];
    const assembled = prompts.assembleThreadPrompt(thread, parent, [
      ...await repository.listMessages(chatId), ...history,
      { ...question, id: "other-thread", threadId: "other-thread", content: "OTHER_THREAD_SENTINEL" },
      { ...question, id: "other-chat", chatId: "other-chat", content: "OTHER_CHAT_SENTINEL" },
    ]);
    expect(assembled).toEqual([
      { role: "system", content: prompts.MAIN_SYSTEM_PROMPT },
      { role: "system", content: `Frozen main conversation briefing:\n\n${prompts.renderBriefing(briefing)}` },
      { role: "assistant", content: parent.content },
      { role: "system", content: `Thread subject:\n${thread.anchorExact}` },
      ...promptRows(history),
    ]);
    const data = await service.getThreadData(thread.id, repository);
    expect(data.context).toMatchObject({ tokens: estimateTokens(assembled), fullTokens: estimateTokens(await fullPrompt(thread, history)), actual: false });
    await append({ content: "New main text\n".repeat(300) });
    const later = await service.getThreadData(thread.id, repository);
    expect(later.context.tokens).toBe(data.context.tokens);
    expect(later.context.fullTokens).toBe(estimateTokens(await fullPrompt(thread, history)));
    expect(later.context.fullTokens).toBeGreaterThan(data.context.fullTokens);
  });

  it.each([0, 31])("uses the latest actual inputTokens (%s) and excludes its response from the right-hand comparison", async (tokens) => {
    const thread = await create();
    const question = await append({ threadId: thread.id, content: "The input question" });
    await answer(thread, tokens, true, "RESPONSE_NOT_IN_INPUT\n".repeat(500));
    const data = await service.getThreadData(thread.id, repository);
    expect(data.context).toMatchObject({ actual: true, tokens, fullTokens: estimateTokens(await fullPrompt(thread, [question])) });
    await append({ content: "A later main message does not refresh the briefing" });
    expect((await service.getThreadData(thread.id, repository)).context).toMatchObject({ actual: true, tokens, fullTokens: estimateTokens(await fullPrompt(thread, [question])) });
  });

  it.each([false, true])("does not reuse an older measured call when the latest assistant has no usage (complete=%s)", async (complete) => {
    const thread = await create();
    await append({ threadId: thread.id, content: "First question" });
    await answer(thread, 1);
    await append({ threadId: thread.id, content: "Second question" });
    await answer(thread, null, complete, "Latest response without measured usage");
    const data = await service.getThreadData(thread.id, repository);
    expect(data.context).toMatchObject({ actual: false, tokens: estimateTokens(prompts.assembleThreadPrompt(thread, parent, data.messages)), fullTokens: estimateTokens(await fullPrompt(thread, data.messages)) });
  });

  it("can use a latest incomplete call's measured input without borrowing earlier usage", async () => {
    const thread = await create();
    const question = await append({ threadId: thread.id, content: "Question before interrupted answer" });
    await answer(thread, 19, false);
    expect((await service.getThreadData(thread.id, repository)).context).toMatchObject({ actual: true, tokens: 19, fullTokens: estimateTokens(await fullPrompt(thread, [question])) });
  });

  it.each(["compressed", "fallback"])("trusts an attributed older retry without changing %s briefing or prompt bytes, then invalidates it on refresh", async (kind) => {
    const thread = await existingThread(kind === "compressed" ? { kind: "compressed", briefing } : await currentFallback());
    const question = await append({ threadId: thread.id, content: "Original retry question" });
    const partial = await answer(thread, 99, false, "Original partial response");
    await append({ content: "Main advanced beyond the incomplete assistant row" });
    if (kind === "fallback") vi.mocked(compress).mockResolvedValueOnce("invalid briefing");
    const refreshed = await service.refreshThreadContext(thread.id, options());
    expect(partial.createdAt).toBeLessThan(refreshed.thread.contextFrozenAt!);
    expect(refreshed.context.actual).toBe(false);
    const retried = await repository.finishMessage(partial.id, { content: "Retried response", complete: true, inputTokens: 23, outputTokens: 4 });
    const history = [question, retried];
    const promptBefore = prompts.assembleThreadPrompt(refreshed.thread, parent, history);
    const attributed = await repository.updateThread(thread.id, {
      compressedContext: JSON.stringify({ ...JSON.parse(refreshed.thread.compressedContext!), measuredMessageId: partial.id }),
    });
    expect(parseFrozenContext(attributed.compressedContext)).toEqual(refreshed.context.briefing);
    expect(new TextEncoder().encode(JSON.stringify(prompts.assembleThreadPrompt(attributed, parent, history))))
      .toEqual(new TextEncoder().encode(JSON.stringify(promptBefore)));
    const data = await service.getThreadData(thread.id, repository);
    expect(data.context).toMatchObject({ actual: true, tokens: 23, fullTokens: estimateTokens(await fullPrompt(attributed, [question])) });
    expect(data.context.briefing).toEqual(refreshed.context.briefing);
    vi.resetModules();
    const reloaded = await import("../../lib/thread-service");
    expect((await reloaded.getThreadData(thread.id, repository)).context).toEqual(data.context);
    const reset = await service.refreshThreadContext(thread.id, options());
    expect(JSON.parse(reset.thread.compressedContext!)).not.toHaveProperty("measuredMessageId");
    expect(reset.context.actual).toBe(false);
    expect(await repository.getMessage(partial.id)).toEqual(retried);
  });

  it.each(["an-earlier-message", null, 17, { id: "not-a-string" }])("does not trust unrelated or malformed measured-message attribution: %s", async (measuredMessageId) => {
    const thread = await create();
    await append({ threadId: thread.id, content: "Question" });
    await answer(thread, 13, false);
    const refreshed = await service.refreshThreadContext(thread.id, options());
    await repository.updateThread(thread.id, { compressedContext: JSON.stringify({ ...JSON.parse(refreshed.thread.compressedContext!), measuredMessageId }) });
    expect((await service.getThreadData(thread.id, repository)).context.actual).toBe(false);
  });

  it.each(["new main", "unchanged main", "identical briefing"])("invalidates old usage after refresh with %s and restores actual counts only for a new call", async (mode) => {
    const thread = await create();
    await append({ threadId: thread.id, content: "Measured question" });
    const measured = await answer(thread, 7);
    const originalMessages = await repository.listMessages(chatId, thread.id);
    if (mode === "new main") await append({ content: "New main information" });
    vi.mocked(compress).mockResolvedValueOnce(mode === "identical briefing" ? briefing : updatedBriefing);
    const refreshed = await service.refreshThreadContext(thread.id, options());
    expect(refreshed.context).toMatchObject({
      actual: false,
      tokens: estimateTokens(prompts.assembleThreadPrompt(refreshed.thread, parent, originalMessages)),
      fullTokens: estimateTokens(await fullPrompt(refreshed.thread, originalMessages)),
    });
    expect(await repository.getMessage(measured.id)).toEqual(measured);
    expect(await repository.listMessages(chatId, thread.id)).toEqual(originalMessages);
    vi.resetModules();
    const reloaded = await import("../../lib/thread-service");
    expect((await reloaded.getThreadData(thread.id, repository)).context.actual).toBe(false);
    await append({ threadId: thread.id, content: "A new question after refresh" });
    await answer(thread, 43);
    const current = await service.getThreadData(thread.id, repository);
    expect(current.context).toMatchObject({ actual: true, tokens: 43, fullTokens: estimateTokens(await fullPrompt(current.thread, current.messages.slice(0, -1))) });
  });
});

describe("malformed stored frozen contexts", () => {
  it.each([
    "not JSON", "null", "[]", '"prose"', "{}",
    JSON.stringify({ kind: "unknown", messages: [] }),
    JSON.stringify({ kind: "compressed", briefing: null }),
    JSON.stringify({ kind: "compressed", briefing: { ...briefing, constraints: [4] } }),
    JSON.stringify({ kind: "fallback", messages: null }),
    JSON.stringify({ kind: "fallback", messages: [{ role: "unknown", content: "Text" }] }),
    JSON.stringify({ kind: "fallback", messages: [{ role: "user", content: {} }] }),
  ])("handles corrupted storage without throwing, regenerating, or changing the parent: %s", async (compressedContext) => {
    const thread = { ...await existingThread(), compressedContext };
    vi.spyOn(repository, "getThread").mockResolvedValue(thread);
    expect(prompts.assembleThreadPrompt(thread, parent, [])).toEqual([
      { role: "system", content: prompts.MAIN_SYSTEM_PROMPT },
      { role: "system", content: "Frozen main conversation briefing:\nNo briefing is available." },
      { role: "assistant", content: parent.content },
      { role: "system", content: `Thread subject:\n${thread.anchorExact}` },
    ]);
    const data = await service.getThreadData(thread.id, repository);
    expect(data.context).toMatchObject({ fallback: true, briefing: null });
    expect(data.thread.compressedContext).toBe(compressedContext);
    expect(compress).not.toHaveBeenCalled();
  });
});

describe("thread context API", () => {
  function request(body: unknown, id?: string, signal?: AbortSignal): Request {
    return new Request(`http://localhost/api/threads${id ? `?id=${id}` : ""}`, {
      method: id ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
    });
  }

  it("preserves the POST and GET response shapes and keeps GET read-only", async () => {
    const response = await POST(request(input()));
    expect(response.status).toBe(201);
    const body = await response.json() as { thread: Thread };
    expect(Object.keys(body)).toEqual(["thread"]);
    const get = await GET(new Request(`http://localhost/api/threads?id=${body.thread.id}`));
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual(await service.getThreadData(body.thread.id, repository));
    expect(compress).toHaveBeenCalledOnce();
  });

  it("accepts the refresh action and returns ThreadData without changing the existing resolution shape", async () => {
    const thread = await existingThread();
    await append({ content: "New main information" });
    const refreshed = await PATCH(request({ action: "refresh" }, thread.id));
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toEqual(await service.getThreadData(thread.id, repository));
    expect(compress).toHaveBeenCalledOnce();
    const resolved = await PATCH(request({ resolved: true }, thread.id));
    expect(resolved.status).toBe(200);
    expect((await resolved.json()).thread.resolved).toBe(true);
    expect(compress).toHaveBeenCalledOnce();
  });

  it("rejects refresh while the thread scope is busy on another instance and validates refresh actions", async () => {
    const thread = await existingThread();
    const lease = await occupy(thread.id);
    try {
      const response = await PATCH(request({ action: "refresh" }, thread.id));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "generation_busy" });
    } finally {
      await lease.release();
    }
    for (const body of [{}, { action: "unknown" }, { resolved: "true" }]) {
      expect((await PATCH(request(body, thread.id))).status).toBe(400);
    }
    expect((await repository.getThread(thread.id))?.resolved).toBe(false);
    expect(compress).not.toHaveBeenCalled();
  });

  it("forwards refresh request cancellation and responds with readable 499 without committing", async () => {
    const thread = await existingThread();
    const controller = new AbortController();
    const pending = deferred<unknown>();
    vi.mocked(compress).mockReturnValueOnce(pending.promise);
    const operation = PATCH(request({ action: "refresh" }, thread.id, controller.signal));
    await vi.waitFor(() => expect(compress).toHaveBeenCalledOnce());
    controller.abort("cancelled by caller");
    const response = await operation;
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: "Context preparation stopped.", code: "cancelled" });
    pending.resolve(updatedBriefing);
    await pending.promise;
    expect(await repository.getThread(thread.id)).toEqual(thread);
  });

  it("keeps POST cancellation readable and rejects cross-origin refresh before compression", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");
    const post = await POST(request(input(), undefined, controller.signal));
    expect(post.status).toBe(499);
    expect(await post.json()).toEqual({ error: "Context preparation stopped.", code: "cancelled" });
    const thread = await existingThread();
    const patch = new Request(`http://localhost/api/threads?id=${thread.id}`, { method: "PATCH", headers: { origin: "https://elsewhere.invalid" }, body: JSON.stringify({ action: "refresh" }) });
    expect((await PATCH(patch)).status).toBe(403);
    expect(compress).not.toHaveBeenCalled();
  });
});
