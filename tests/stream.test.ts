import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, POST } from "../app/api/generate/route";
import { parseFrozenContext } from "../lib/context";
import * as repositories from "../lib/db/repository";
import { AppError } from "../lib/errors";
import { acquireGeneration, assertIdle, stopGeneration } from "../lib/generation-lock";
import { assembleFullThreadPrompt, assembleThreadPrompt, MAIN_SYSTEM_PROMPT } from "../lib/prompts";
import * as provider from "../lib/provider";
import { streamStore, useStreams } from "../lib/stream-store";
import { getThreadData, refreshThreadContext } from "../lib/thread-service";
import { estimateTokens } from "../lib/tokens";
import type { Briefing, Message, StreamEvent } from "../lib/types";

const policy = vi.hoisted(() => ({ single: true }));
vi.mock("../lib/generation-policy", () => ({ get ONE_GENERATION_AT_A_TIME() { return policy.single; } }));

function untilAborted(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

function row(input: Partial<Message> = {}): Message {
  return {
    id: "assistant", chatId: "chat", threadId: null, role: "assistant", content: "", modelKey: "fast",
    complete: false, inputTokens: null, outputTokens: null, createdAt: 1, ...input,
  };
}

const releases: (() => void)[] = [];
function lock(id: string, signal?: AbortSignal) {
  const lease = acquireGeneration(id, signal);
  releases.push(lease.release);
  return lease;
}

afterEach(() => {
  stopGeneration();
  releases.splice(0).forEach((release) => release());
  policy.single = true;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("generation lock", () => {
  it("defaults to one generation and rejects duplicates until idempotent release", async () => {
    const actual = await vi.importActual<typeof import("../lib/generation-policy")>("../lib/generation-policy");
    expect(actual.ONE_GENERATION_AT_A_TIME).toBe(true);
    const lease = lock("first");
    expect(() => lock("first")).toThrowError(AppError);
    expect(() => lock("second")).toThrowError(expect.objectContaining({ status: 409, code: "generation_busy" }));
    expect(() => assertIdle()).toThrowError(AppError);
    lease.release();
    lease.release();
    expect(() => assertIdle()).not.toThrow();
    const next = lock("first");
    lease.release();
    expect(() => lock("other")).toThrowError(AppError);
    next.release();
  });

  it("forwards abort and removes the upstream listener on release", () => {
    const upstream = new AbortController();
    const remove = vi.spyOn(upstream.signal, "removeEventListener");
    const lease = lock("forward", upstream.signal);
    upstream.abort("stopped by caller");
    expect(lease.controller.signal.aborted).toBe(true);
    expect(lease.controller.signal.reason).toBe("stopped by caller");
    expect(() => assertIdle()).toThrowError(AppError);
    lease.release();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(lock("already-aborted", upstream.signal).controller.signal.aborted).toBe(true);
  });

  it("keeps exclusivity across module reloads", async () => {
    const lease = lock("original-module");
    vi.resetModules();
    const reloaded = await import("../lib/generation-lock");
    expect(() => reloaded.acquireGeneration("reloaded-module")).toThrowError(expect.objectContaining({ code: "generation_busy" }));
    reloaded.stopGeneration("original-module");
    expect(lease.controller.signal.aborted).toBe(true);
    lease.release();
    expect(() => reloaded.assertIdle()).not.toThrow();
  });

  it("allows independent IDs with the flag off while still guarding duplicates and stopping all", () => {
    policy.single = false;
    const first = lock("one");
    const second = lock("two");
    expect(() => assertIdle()).not.toThrow();
    expect(() => lock("one")).toThrowError(expect.objectContaining({ code: "generation_busy" }));
    stopGeneration("one");
    expect(first.controller.signal.aborted).toBe(true);
    expect(second.controller.signal.aborted).toBe(false);
    stopGeneration();
    expect(second.controller.signal.aborted).toBe(true);
  });
});

describe("generation API with an in-memory repository", () => {
  let repository: repositories.ChatRepository;
  let chatId: string;
  const briefing: Briefing = {
    goal: "  Keep the frozen goal verbatim\n",
    constraints: ["No changes to main messages"], decisions: ["Preserve the parent"],
    artifacts: ["```ts\nconst raw = '  unchanged  ';\n```"], open_questions: ["What should the retry add?"],
  };

  beforeEach(() => {
    repository = new repositories.ChatRepository(":memory:");
    chatId = repository.createChat().id;
    vi.spyOn(repositories, "getRepository").mockReturnValue(repository);
    vi.spyOn(provider, "getProviderStatus").mockReturnValue({ mock: true, deepseek: false, anthropic: false, openai: false });
    vi.spyOn(provider, "compress").mockResolvedValue(briefing);
    vi.spyOn(provider, "streamChat").mockImplementation(async function* () {
      yield { type: "text", text: "Saved text" };
      yield { type: "usage", inputTokens: 12, outputTokens: 3 };
    });
  });

  afterEach(() => repository.close());

  function generate(input: Record<string, unknown> = {}, signal?: AbortSignal) {
    return POST(new Request("http://localhost/api/generate", {
      method: "POST", headers: { "content-type": "application/json" }, signal,
      body: JSON.stringify({ requestId: crypto.randomUUID(), chatId, threadId: null, content: "Question", modelKey: "fast", ...input }),
    }));
  }

  async function events(response: Response): Promise<StreamEvent[]> {
    return (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as StreamEvent);
  }

  function append(input: Partial<Message> = {}) {
    return repository.appendMessage({ chatId, threadId: null, role: "assistant", content: "A completed parent with an anchor", modelKey: "fast", complete: true, ...input });
  }

  function branch(parent = append()) {
    return repository.insertThread({ parentMessageId: parent.id, anchorStart: 0, anchorEnd: 11, source: "user", compressedContext: null, contextFrozenAt: null });
  }

  function retryFixture() {
    const parent = append();
    const thread = branch(parent);
    const question = append({ threadId: thread.id, role: "user", content: "  Original **thread question**\n" });
    const partial = append({ threadId: thread.id, content: "Old partial", complete: false, modelKey: "thinking" });
    repository.finishMessage(partial.id, { content: partial.content, complete: false, inputTokens: 99, outputTokens: 8 });
    append({ role: "user", content: "New main information after the original call" });
    return { parent, thread, question, partial };
  }

  it("persists each delta before requesting the next chunk, then saves usage and finishes", async () => {
    vi.mocked(provider.streamChat).mockImplementation(async function* () {
      yield { type: "text", text: "First " };
      expect(repository.listMessages(chatId).at(-1)).toMatchObject({ content: "First ", complete: false });
      yield { type: "text", text: "second" };
      yield { type: "usage", inputTokens: 17, outputTokens: 4 };
    });
    const response = await generate({ modelKey: "thinking" });
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const result = await events(response);
    expect(result.map((event) => event.type)).toEqual(["start", "delta", "delta", "finish"]);
    expect(result[0]).toMatchObject({ message: { complete: false, modelKey: "thinking" }, userMessage: { complete: true, modelKey: "thinking", content: "Question" } });
    const saved = repository.listMessages(chatId).at(-1);
    expect(saved).toMatchObject({ content: "First second", complete: true, inputTokens: 17, outputTokens: 4 });
    expect(result.at(-1)).toEqual({ type: "finish", message: saved });
    expect(provider.streamChat).toHaveBeenCalledWith(expect.objectContaining({ messages: [{ role: "system", content: MAIN_SYSTEM_PROMPT }, { role: "user", content: "Question" }], modelKey: "thinking" }));
    expect(() => assertIdle()).not.toThrow();
  });

  it.each([false, true])("normalizes successful math before completing a message (thread: %s)", async (inThread) => {
    const threadId = inThread ? branch().id : null;
    const raw = String.raw`Answer: \(x^2\).`;
    vi.mocked(provider.streamChat).mockImplementation(async function* () {
      yield { type: "text", text: raw.slice(0, 10) };
      yield { type: "text", text: raw.slice(10) };
      expect(repository.listMessages(chatId, threadId).at(-1)).toMatchObject({ content: raw, complete: false });
      yield { type: "usage", inputTokens: 17, outputTokens: 4 };
    });
    const result = await events(await generate({ threadId, content: raw }));
    const saved = repository.listMessages(chatId, threadId).at(-1);
    expect(saved).toMatchObject({ content: "Answer: $x^2$.", complete: true, inputTokens: 17, outputTokens: 4 });
    expect(result.at(-1)).toEqual({ type: "finish", message: saved });
    expect(repository.listMessages(chatId, threadId).find((message) => message.role === "user")?.content).toBe(raw);
  });

  it.each(["error", "abort"])("preserves raw partial math after %s", async (failure) => {
    const raw = String.raw`Answer: \(x^2\), then \[unfinished`;
    vi.mocked(provider.streamChat).mockImplementation(async function* () {
      yield { type: "text", text: raw };
      if (failure === "abort") stopGeneration();
      else throw new Error("Interrupted");
    });
    const result = await events(await generate());
    expect(repository.listMessages(chatId).at(-1)).toMatchObject({ content: raw, complete: false });
    expect(result.at(-1)).toMatchObject({ type: "finish", message: { content: raw, complete: false } });
  });

  it("preserves Unicode when provider chunks split a surrogate pair", async () => {
    vi.mocked(provider.streamChat).mockImplementation(async function* () {
      yield { type: "text", text: "A \ud834" };
      yield { type: "text", text: "\udd1e note" };
      yield { type: "usage", inputTokens: 2, outputTokens: 3 };
    });
    const result = await events(await generate());
    expect(repository.listMessages(chatId).at(-1)).toMatchObject({ content: "A \ud834\udd1e note", complete: true });
    expect(result.at(-1)).toMatchObject({ type: "finish", message: { content: "A \ud834\udd1e note" } });
  });

  it("keeps branch history out of main and main/sibling history out of a branch", async () => {
    const parent = append();
    const thread = branch(parent);
    append({ threadId: thread.id, role: "user", content: "Thread-only history" });
    append({ content: "Later main history" });
    await events(await generate({ content: "Main request" }));
    expect(vi.mocked(provider.streamChat).mock.calls[0][0].messages.some((message) => message.content === "Thread-only history")).toBe(false);
    await events(await generate({ threadId: thread.id, content: "Thread request" }));
    expect(vi.mocked(provider.streamChat).mock.calls[1][0].messages).toEqual([
      { role: "system", content: MAIN_SYSTEM_PROMPT },
      { role: "system", content: "Frozen main conversation briefing:\nNo briefing is available." },
      { role: "assistant", content: parent.content },
      { role: "system", content: `Thread subject:\n${thread.anchorExact}` },
      { role: "user", content: "Thread-only history" },
      { role: "user", content: "Thread request" },
    ]);
  });

  it("retries only the same incomplete row with its original model and strictly earlier history", async () => {
    append({ role: "user", content: "Original question" });
    const partial = append({ content: "Old partial", complete: false, modelKey: "thinking" });
    repository.finishMessage(partial.id, { content: partial.content, complete: false, inputTokens: 99, outputTokens: 88 });
    append({ role: "user", content: "Future question" });
    append({ content: "Future answer" });
    const clear = vi.spyOn(repository, "updatePartialMessage");
    const result = await events(await generate({ retryMessageId: partial.id, modelKey: "fast", content: undefined }));
    expect(repository.listMessages(chatId)).toHaveLength(4);
    expect(clear).toHaveBeenCalledWith(partial.id, "");
    expect(result[0]).toMatchObject({ type: "start", message: { id: partial.id, content: "", modelKey: "thinking", inputTokens: null, outputTokens: null }, userMessage: null });
    expect(provider.streamChat).toHaveBeenCalledWith(expect.objectContaining({ modelKey: "thinking", messages: [{ role: "system", content: MAIN_SYSTEM_PROMPT }, { role: "user", content: "Original question" }] }));
    expect(repository.getMessage(partial.id)).toMatchObject({ complete: true, modelKey: "thinking", inputTokens: 12, outputTokens: 3 });
  });

  it.each([["compressed", 0], ["fallback", 23]] as const)("attributes a retry after %s refresh to its actual usage (%s) without changing frozen prompt bytes", async (kind, inputTokens) => {
    const { parent, thread, question, partial } = retryFixture();
    if (kind === "fallback") vi.mocked(provider.compress).mockResolvedValueOnce("invalid briefing");
    const refreshed = await refreshThreadContext(thread.id, { repository });
    expect(refreshed.context.actual).toBe(false);
    expect(partial.createdAt).toBeLessThan(refreshed.thread.contextFrozenAt!);
    const prompt = assembleThreadPrompt(refreshed.thread, parent, [question]);
    const update = vi.spyOn(repository, "updateThread");
    vi.mocked(provider.streamChat).mockImplementationOnce(async function* () {
      yield { type: "text", text: "Fresh retry response" };
      yield { type: "usage", inputTokens, outputTokens: 4 };
    });
    const result = await events(await generate({ threadId: thread.id, retryMessageId: partial.id, content: undefined }));
    const data = getThreadData(thread.id, repository);
    expect(data.messages.at(-1)).toMatchObject({ id: partial.id, createdAt: partial.createdAt, complete: true, inputTokens, content: "Fresh retry response", modelKey: "thinking" });
    expect(result.at(-1)).toEqual({ type: "finish", message: data.messages.at(-1) });
    expect(data.context).toMatchObject({ actual: true, tokens: inputTokens, fullTokens: estimateTokens(assembleFullThreadPrompt(data.thread, repository.listMessages(chatId), [question])) });
    expect(provider.streamChat).toHaveBeenCalledWith(expect.objectContaining({ messages: prompt, modelKey: "thinking" }));
    expect(update).toHaveBeenCalledOnce();
    expect(Object.keys(update.mock.calls[0][1])).toEqual(["compressedContext"]);
    expect(data.thread).toEqual({ ...refreshed.thread, compressedContext: data.thread.compressedContext });
    expect(JSON.parse(data.thread.compressedContext!)).toMatchObject({ ...JSON.parse(refreshed.thread.compressedContext!), measuredMessageId: partial.id });
    expect(parseFrozenContext(data.thread.compressedContext)).toEqual(refreshed.context.briefing);
    expect(data.context.briefing).toEqual(refreshed.context.briefing);
    expect(new TextEncoder().encode(JSON.stringify(assembleThreadPrompt(data.thread, parent, [question]))))
      .toEqual(new TextEncoder().encode(JSON.stringify(prompt)));
    expect(provider.compress).toHaveBeenCalledOnce();
    vi.resetModules();
    const reloaded = await import("../lib/thread-service");
    expect(reloaded.getThreadData(thread.id, repository).context).toEqual(data.context);
    const reset = await refreshThreadContext(thread.id, { repository });
    expect(reset.context.actual).toBe(false);
    expect(JSON.parse(reset.thread.compressedContext!)).not.toHaveProperty("measuredMessageId");
    expect(repository.getMessage(partial.id)?.inputTokens).toBe(inputTokens);
    expect(provider.compress).toHaveBeenCalledTimes(2);
  });

  it("attributes measured incomplete retries but never revives their usage on an unmeasured retry", async () => {
    const { thread, partial } = retryFixture();
    await refreshThreadContext(thread.id, { repository });
    vi.mocked(provider.streamChat).mockImplementationOnce(async function* () {
      yield { type: "text", text: "Measured partial retry" };
      yield { type: "usage", inputTokens: 17, outputTokens: 3 };
      throw new Error("Interrupted after usage");
    });
    await events(await generate({ threadId: thread.id, retryMessageId: partial.id, content: undefined }));
    expect(repository.getMessage(partial.id)).toMatchObject({ complete: false, inputTokens: 17 });
    expect(getThreadData(thread.id, repository).context).toMatchObject({ actual: true, tokens: 17 });
    vi.mocked(provider.streamChat).mockImplementationOnce(async function* () {
      yield { type: "text", text: "Retry without usage" };
    });
    await events(await generate({ threadId: thread.id, retryMessageId: partial.id, content: undefined }));
    expect(repository.getMessage(partial.id)?.inputTokens).toBeNull();
    expect(getThreadData(thread.id, repository).context.actual).toBe(false);
    expect(provider.compress).toHaveBeenCalledOnce();
  });

  it.each(["identical refresh", "changed briefing", "cutoff only"])("does not attribute an old in-flight retry after %s when concurrent operations are enabled", async (mode) => {
    const { thread, partial } = retryFixture();
    const initial = await refreshThreadContext(thread.id, { repository });
    policy.single = false;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    vi.mocked(provider.streamChat).mockImplementationOnce(async function* () {
      yield { type: "usage", inputTokens: 21, outputTokens: 5 };
      await pending;
      yield { type: "text", text: "Late response from the previous snapshot" };
    });
    const completion = events(await generate({ threadId: thread.id, retryMessageId: partial.id, content: undefined }));
    let contextAfterRefresh!: string | null;
    try {
      await vi.waitFor(() => expect(repository.getMessage(partial.id)?.inputTokens).toBe(21));
      if (mode === "cutoff only") {
        const main = append({ content: "New cutoff without changing briefing JSON" });
        repository.updateThread(thread.id, { contextFrozenAt: main.createdAt });
      } else {
        if (mode === "changed briefing") vi.mocked(provider.compress).mockResolvedValueOnce({ ...briefing, goal: "New surrounding design" });
        await refreshThreadContext(thread.id, { repository });
      }
      contextAfterRefresh = repository.getThread(thread.id)!.compressedContext;
      expect(getThreadData(thread.id, repository).context.actual).toBe(false);
    } finally {
      finish();
      await completion;
    }
    const data = getThreadData(thread.id, repository);
    expect(data.messages.at(-1)).toMatchObject({ id: partial.id, complete: true, inputTokens: 21 });
    expect(data.context.actual).toBe(false);
    expect(data.thread.compressedContext).toBe(contextAfterRefresh);
    expect(JSON.parse(data.thread.compressedContext!)).not.toHaveProperty("measuredMessageId");
    if (mode === "identical refresh") expect(data.context.briefing).toEqual(initial.context.briefing);
    expect(provider.compress).toHaveBeenCalledTimes(mode === "cutoff only" ? 1 : 2);
  });

  it("allows attribution when only measurement metadata changed during a call", async () => {
    const { thread, partial } = retryFixture();
    const refreshed = await refreshThreadContext(thread.id, { repository });
    vi.mocked(provider.streamChat).mockImplementationOnce(async function* () {
      repository.updateThread(thread.id, {
        compressedContext: JSON.stringify({ ...JSON.parse(refreshed.thread.compressedContext!), measuredMessageId: "another-call" }),
      });
      yield { type: "usage", inputTokens: 37, outputTokens: 4 };
      yield { type: "text", text: "Same frozen snapshot" };
    });
    await events(await generate({ threadId: thread.id, retryMessageId: partial.id, content: undefined }));
    const data = getThreadData(thread.id, repository);
    expect(data.context).toMatchObject({ actual: true, tokens: 37 });
    expect(JSON.parse(data.thread.compressedContext!)).toHaveProperty("measuredMessageId", partial.id);
    expect(data.context.briefing).toEqual(refreshed.context.briefing);
    expect(provider.compress).toHaveBeenCalledOnce();
  });

  it("preserves the unavailable briefing label when attributing usage to a legacy null context", async () => {
    const parent = append();
    const thread = branch(parent);
    const prompt = assembleThreadPrompt(thread, parent, []);
    await events(await generate({ threadId: thread.id }));
    const data = getThreadData(thread.id, repository);
    expect(data.context).toMatchObject({ actual: true, tokens: 12, briefing: null });
    expect(JSON.parse(data.thread.compressedContext!)).toHaveProperty("measuredMessageId", data.messages.at(-1)!.id);
    expect(assembleThreadPrompt(data.thread, parent, [])).toEqual(prompt);
    expect(provider.compress).not.toHaveBeenCalled();
  });

  it("rejects missing configuration before appending or acquiring a lock", async () => {
    vi.mocked(provider.getProviderStatus).mockReturnValue({ mock: false, deepseek: false, anthropic: false, openai: false });
    const response = await generate();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "missing_key" });
    expect(repository.listMessages(chatId)).toEqual([]);
    expect(provider.streamChat).not.toHaveBeenCalled();
    expect(() => assertIdle()).not.toThrow();
  });

  it.each([{ complete: true, role: "assistant" as const }, { complete: false, role: "user" as const }])("never retries immutable rows: %o", async (input) => {
    const original = append(input);
    const response = await generate({ retryMessageId: original.id });
    expect(response.status).toBe(409);
    expect(repository.listMessages(chatId)).toEqual([original]);
    expect(provider.streamChat).not.toHaveBeenCalled();
  });

  it("validates chat, thread, and retry scope before writing", async () => {
    const otherChat = repository.createChat();
    const parent = append({ chatId: otherChat.id });
    const otherThread = branch(parent);
    const retry = append({ complete: false, chatId: otherChat.id });
    for (const input of [{ chatId: "missing" }, { threadId: otherThread.id }, { retryMessageId: retry.id }, { retryMessageId: "missing" }]) {
      const response = await generate(input);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    for (const input of [{ requestId: "not-a-uuid" }, { modelKey: "unknown" }, { content: " \n " }, { threadId: undefined }]) {
      expect((await generate(input)).status).toBe(400);
    }
    expect(repository.listMessages(chatId)).toEqual([]);
    expect(provider.streamChat).not.toHaveBeenCalled();
  });

  it("refuses a busy request without appending a user message", async () => {
    const lease = lock("compression-in-progress");
    const response = await generate();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "generation_busy" });
    expect(repository.listMessages(chatId)).toEqual([]);
    lease.release();
  });

  it.each([[401, "invalid_key"], [429, "rate_limit"], [503, "busy"]] as const)("streams readable errors for synchronous provider failures (%s)", async (statusCode, code) => {
    vi.mocked(provider.streamChat).mockImplementation(() => { throw Object.assign(new Error("Provider rejected"), { statusCode }); });
    const response = await generate();
    expect(response.status).toBe(200);
    const result = await events(response);
    const saved = repository.listMessages(chatId).at(-1)!;
    expect(result.map((event) => event.type)).toEqual(["start", "error", "finish"]);
    expect(result[1]).toMatchObject({ code, messageId: saved.id });
    expect(result.at(-1)).toEqual({ type: "finish", message: saved });
    expect(saved).toMatchObject({ content: "", complete: false });
    expect(() => assertIdle()).not.toThrow();
  });

  it("retains partial text and reported usage when a provider fails after chunks", async () => {
    vi.mocked(provider.streamChat).mockImplementation(async function* () {
      yield { type: "text", text: "Retain this" };
      yield { type: "usage", inputTokens: 8, outputTokens: 3 };
      throw new Error("Connection lost");
    });
    const result = await events(await generate());
    expect(result.at(-2)).toMatchObject({ type: "error", code: "network" });
    expect(repository.listMessages(chatId).at(-1)).toMatchObject({ content: "Retain this", complete: false, inputTokens: 8, outputTokens: 3 });
    expect(() => assertIdle()).not.toThrow();
  });

  it.each(["delete", "request-abort", "reader-cancel"])("retains incomplete text after %s and releases the lock", async (mode) => {
    vi.mocked(provider.streamChat).mockImplementation(async function* ({ signal }) {
      yield { type: "text", text: "A saved partial" };
      await untilAborted(signal);
    });
    const upstream = new AbortController();
    const requestId = crypto.randomUUID();
    const response = await generate({ requestId }, upstream.signal);
    await vi.waitFor(() => expect(repository.listMessages(chatId).at(-1)?.content).toBe("A saved partial"));
    if (mode === "delete") {
      expect((await DELETE(new Request(`http://localhost/api/generate?id=${requestId}`, { method: "DELETE" }))).status).toBe(200);
    } else if (mode === "request-abort") {
      upstream.abort();
    } else {
      await response.body!.cancel();
    }
    if (mode !== "reader-cancel") {
      const result = await events(response);
      expect(result.some((event) => event.type === "error")).toBe(false);
      expect(result.at(-1)).toMatchObject({ type: "finish", message: { content: "A saved partial", complete: false } });
    }
    expect(repository.listMessages(chatId).at(-1)).toMatchObject({ content: "A saved partial", complete: false });
    expect(() => assertIdle()).not.toThrow();
  });

  it.each(["enqueue", "close"] as const)("handles a disconnected controller throwing from %s without leaking the lock", async (method) => {
    vi.mocked(provider.streamChat).mockImplementation(async function* () {
      vi.spyOn(ReadableStreamDefaultController.prototype, method).mockImplementationOnce(function (this: ReadableStreamDefaultController<Uint8Array>) {
        this.error(new TypeError("Browser disconnected"));
        throw new TypeError("Browser disconnected");
      });
      yield { type: "text", text: "Persisted before disconnect" };
      yield { type: "usage", inputTokens: 5, outputTokens: 6 };
    });
    const response = await generate();
    await expect(response.text()).rejects.toThrow("Browser disconnected");
    await vi.waitFor(() => expect(() => assertIdle()).not.toThrow());
    expect(repository.listMessages(chatId).at(-1)).toMatchObject({ content: "Persisted before disconnect", complete: method === "close" });
  });

  it("does not append for an already-aborted request", async () => {
    const upstream = new AbortController();
    upstream.abort();
    const response = await generate({}, upstream.signal);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(repository.listMessages(chatId)).toEqual([]);
    expect(() => assertIdle()).not.toThrow();
  });

  it("rejects cross-origin cancellation without stopping the active generation", async () => {
    const lease = lock("local-only");
    const response = await DELETE(new Request("http://localhost/api/generate?id=local-only", { method: "DELETE", headers: { origin: "https://elsewhere.invalid" } }));
    expect(response.status).toBe(403);
    expect(lease.controller.signal.aborted).toBe(false);
  });
});

function wire() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return {
    response: new Response(stream, { headers: { "content-type": "application/x-ndjson" } }),
    push(...events: StreamEvent[]) { controller.enqueue(new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join("\n") + "\n")); },
    controller,
  };
}

describe("component-independent stream store", () => {
  let root: Root;
  let current: ReturnType<typeof useStreams>;
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  function Probe() {
    current = useStreams();
    return null;
  }

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    root = createRoot(document.createElement("div"));
    await act(() => root.render(createElement(Probe)));
  });

  afterEach(async () => {
    await act(async () => streamStore.stop());
    await act(() => root.unmount());
  });

  it("connects synchronously, resolves send before EOF, decodes split NDJSON, and keeps an idle bridge", async () => {
    const response = wire();
    let accept!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { accept = resolve; }));
    let sending!: Promise<boolean>;
    const previous = current;
    act(() => { sending = streamStore.send({ chatId: "chat", threadId: null, content: "Question", modelKey: "fast" }); });
    expect(current).not.toBe(previous);
    expect(previous.sessions.get(null)?.phase ?? "idle").toBe("idle");
    expect(current).toMatchObject({ active: true, locked: true, operation: null });
    expect(current.sessions.get(null)).toMatchObject({ phase: "connecting", chatId: "chat" });
    await act(async () => {
      expect(await streamStore.send({ chatId: "other-chat", threadId: "other-thread", content: "Blocked", modelKey: "fast" })).toBe(false);
      accept(response.response);
      expect(await sending).toBe(true);
    });
    const userMessage = row({ id: "user", role: "user", content: "Question", complete: true });
    const message = row();
    const prefix = new TextEncoder().encode(`${JSON.stringify({ type: "start", message, userMessage })}\n${JSON.stringify({ type: "delta", messageId: message.id, text: "漢字 text" })}\n`);
    const split = prefix.indexOf(0xe6) + 1;
    await act(async () => {
      response.controller.enqueue(prefix.subarray(0, 17));
      response.controller.enqueue(prefix.subarray(17, split));
      response.controller.enqueue(prefix.subarray(split));
    });
    expect(current.sessions.get(null)).toMatchObject({ phase: "streaming", message: { content: "漢字 text", complete: false }, userMessage });
    const refresh = vi.fn();
    window.addEventListener("threads:refresh", refresh, { once: true });
    await act(async () => {
      response.controller.enqueue(new TextEncoder().encode(JSON.stringify({ type: "finish", message: { ...message, content: "漢字 text", complete: true, inputTokens: 4, outputTokens: 2 } })));
      response.controller.close();
    });
    expect(current).toMatchObject({ active: false, locked: false });
    expect(current.sessions.get(null)).toMatchObject({ phase: "idle", message: { content: "漢字 text", complete: true, inputTokens: 4, outputTokens: 2 }, userMessage });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("replaces raw streamed math with the authoritative normalized finish content", async () => {
    const response = wire();
    fetchMock.mockResolvedValueOnce(response.response);
    const message = row();
    const raw = String.raw`Answer: \(x^2\).`;
    await act(async () => {
      await streamStore.send({ chatId: "chat", threadId: null, content: "Question", modelKey: "fast" });
      response.push({ type: "start", message, userMessage: null }, { type: "delta", messageId: message.id, text: raw });
    });
    expect(current.sessions.get(null)?.message?.content).toBe(raw);
    await act(async () => {
      response.push({ type: "finish", message: { ...message, content: "Answer: $x^2$.", complete: true } });
      response.controller.close();
    });
    expect(current.sessions.get(null)).toMatchObject({ phase: "idle", message: { content: "Answer: $x^2$.", complete: true } });
  });

  it("keeps reading when the observing component unmounts", async () => {
    const response = wire();
    fetchMock.mockResolvedValueOnce(response.response);
    const message = row({ id: "independent", threadId: "independent-thread" });
    await act(async () => {
      expect(await streamStore.send({ chatId: "chat", threadId: message.threadId, content: "Question", modelKey: "fast" })).toBe(true);
      response.push({ type: "start", message, userMessage: null });
    });
    await act(() => root.unmount());
    await act(async () => {
      response.push({ type: "delta", messageId: message.id, text: "Still reading" }, { type: "finish", message: { ...message, content: "Still reading", complete: true } });
      response.controller.close();
    });
    root = createRoot(document.createElement("div"));
    await act(() => root.render(createElement(Probe)));
    expect(current.sessions.get(message.threadId)).toMatchObject({ phase: "idle", message: { content: "Still reading", complete: true } });
  });

  it("preserves root HTTP error codes without inventing an affected message", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: "Check the configured key", code: "invalid_key" }, { status: 401 }));
    await act(async () => {
      expect(await streamStore.send({ chatId: "rejected-chat", threadId: null, content: "Question", modelKey: "fast" })).toBe(false);
    });
    expect(current).toMatchObject({ active: false, locked: false, notice: { message: "Check the configured key", code: "invalid_key" } });
    expect(current.notice?.messageId).toBeUndefined();
    expect(current.sessions.get(null)).toMatchObject({ phase: "idle", chatId: "rejected-chat", message: null, userMessage: null, error: null });
  });

  it("cancels an unusable initial response and releases its browser fetch", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/html" } }));
    await act(async () => {
      expect(await streamStore.send({ chatId: "chat", threadId: null, content: "Question", modelKey: "fast" })).toBe(false);
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(current).toMatchObject({ active: false, locked: false, notice: { code: "network" } });
    expect(current.sessions.get(null)).toMatchObject({ phase: "idle", message: null });
  });

  it("marks a reader ending without finish incomplete and retryable", async () => {
    const response = wire();
    fetchMock.mockResolvedValueOnce(response.response);
    const message = row({ id: "interrupted", chatId: "interrupted-chat" });
    await act(async () => {
      await streamStore.send({ chatId: message.chatId, threadId: null, content: "Question", modelKey: "fast" });
      response.push({ type: "start", message, userMessage: null }, { type: "delta", messageId: message.id, text: "Saved partial" });
      response.controller.close();
    });
    expect(current.sessions.get(null)).toMatchObject({ phase: "idle", message: { content: "Saved partial", complete: false }, error: expect.any(String) });
    expect(current.notice).toMatchObject({ messageId: message.id, code: "network" });
    expect(current.active).toBe(false);
  });

  it("retains an affected-message error through its incomplete finish", async () => {
    const response = wire();
    fetchMock.mockResolvedValueOnce(response.response);
    const message = row({ id: "rate-limited" });
    await act(async () => {
      await streamStore.send({ chatId: "chat", threadId: null, retryMessageId: message.id, modelKey: "thinking" });
      response.push({ type: "start", message, userMessage: null }, { type: "error", message: "Wait, then retry", code: "rate_limit", messageId: message.id }, { type: "finish", message });
      response.controller.close();
    });
    expect(current.sessions.get(null)).toMatchObject({ phase: "idle", message: { complete: false }, error: "Wait, then retry" });
    expect(current.notice).toMatchObject({ messageId: message.id, code: "rate_limit" });
  });

  it("preserves a provider error code if the reader then fails before finish", async () => {
    const response = wire();
    fetchMock.mockResolvedValueOnce(response.response);
    const message = row({ id: "rejected-stream" });
    await act(async () => {
      await streamStore.send({ chatId: "chat", threadId: null, content: "Question", modelKey: "fast" });
      response.push({ type: "start", message, userMessage: null }, { type: "error", message: "The key was rejected", code: "invalid_key", messageId: message.id });
    });
    await act(async () => response.controller.error(new Error("Transport closed")));
    expect(current.notice).toMatchObject({ message: "The key was rejected", code: "invalid_key", messageId: message.id });
    expect(current.sessions.get(null)).toMatchObject({ phase: "idle", message: { complete: false }, error: "The key was rejected" });
    expect(current.active).toBe(false);
  });

  it("shows message-free stream errors only as notices", async () => {
    const response = wire();
    fetchMock.mockResolvedValueOnce(response.response);
    await act(async () => {
      await streamStore.send({ chatId: "chat", threadId: null, content: "Question", modelKey: "fast" });
      response.push({ type: "error", message: "Try again shortly", code: "busy" });
      response.controller.close();
    });
    expect(current.notice).toMatchObject({ message: "Try again shortly", code: "busy" });
    expect(current.notice?.messageId).toBeUndefined();
    expect(current.sessions.get(null)).toMatchObject({ phase: "idle", message: null, error: null });
  });

  it("does not merge rows from another chat into the requested session", async () => {
    const response = wire();
    fetchMock.mockResolvedValueOnce(response.response);
    await act(async () => {
      await streamStore.send({ chatId: "requested-chat", threadId: null, content: "Question", modelKey: "fast" });
      response.push({ type: "start", message: row({ chatId: "wrong-chat" }), userMessage: null });
      response.controller.close();
    });
    expect(current.sessions.get(null)).toMatchObject({ chatId: "requested-chat", message: null, phase: "idle" });
    expect(current.notice).toMatchObject({ code: "network" });
  });

  it("locks operations before their first await and releases them even when the task throws", async () => {
    let reject!: (error: Error) => void;
    let result!: Promise<unknown>;
    act(() => {
      result = streamStore.runOperation("Preparing thread", () => new Promise((_, fail) => { reject = fail; })).catch((error: unknown) => error);
    });
    expect(current).toMatchObject({ active: true, locked: true, operation: "Preparing thread" });
    await act(async () => {
      expect(await streamStore.send({ chatId: "chat", threadId: null, content: "Blocked", modelKey: "fast" })).toBe(false);
      reject(new Error("Task failed"));
      expect(await result).toEqual(new Error("Task failed"));
    });
    expect(current).toMatchObject({ active: false, locked: false, operation: null });
  });

  it("supports independent scopes with the flag off, still guards one scope, and stops every stream and operation", async () => {
    policy.single = false;
    const first = wire();
    const second = wire();
    fetchMock.mockResolvedValueOnce(first.response).mockResolvedValueOnce(second.response);
    const a = row({ id: "first-partial", threadId: "first-thread" });
    const b = row({ id: "second-partial", threadId: "second-thread" });
    let operationSignal!: AbortSignal;
    let operation!: Promise<unknown>;
    await act(async () => {
      expect(await streamStore.send({ chatId: "chat", threadId: a.threadId, content: "A", modelKey: "fast" })).toBe(true);
      expect(await streamStore.send({ chatId: "chat", threadId: b.threadId, content: "B", modelKey: "fast" })).toBe(true);
      first.push({ type: "start", message: a, userMessage: null }, { type: "delta", messageId: a.id, text: "A partial" });
      second.push({ type: "start", message: b, userMessage: null }, { type: "delta", messageId: b.id, text: "B partial" });
      operation = streamStore.runOperation("Concurrent operation", async (signal) => { operationSignal = signal; await untilAborted(signal); signal.throwIfAborted(); }).catch((error: unknown) => error);
    });
    expect(current).toMatchObject({ active: true, locked: false, operation: "Concurrent operation" });
    await act(async () => {
      expect(await streamStore.send({ chatId: "chat", threadId: a.threadId, content: "Duplicate", modelKey: "fast" })).toBe(false);
      streamStore.stop();
      await operation;
    });
    expect(operationSignal.aborted).toBe(true);
    const stops = fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(stops).toHaveLength(2);
    expect(stops.every(([url, init]) => String(url).startsWith("/api/generate?id=") && init?.keepalive === true)).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").every(([, init]) => init?.signal?.aborted)).toBe(true);
    expect(current.sessions.get(a.threadId)).toMatchObject({ phase: "idle", message: { content: "A partial", complete: false }, error: null });
    expect(current.sessions.get(b.threadId)).toMatchObject({ phase: "idle", message: { content: "B partial", complete: false }, error: null });
    expect(current).toMatchObject({ active: false, locked: false, operation: null });
  });

  it("stops a connecting request on pagehide without an abort error notice", async () => {
    fetchMock.mockImplementationOnce(async (_, init) => {
      await untilAborted(init?.signal ?? undefined);
      throw new DOMException("Aborted", "AbortError");
    });
    let sending!: Promise<boolean>;
    await act(async () => {
      sending = streamStore.send({ chatId: "reload-chat", threadId: null, content: "Question", modelKey: "fast" });
      window.dispatchEvent(new Event("pagehide"));
      expect(await sending).toBe(false);
    });
    expect(current).toMatchObject({ active: false, locked: false, notice: null });
    expect(current.sessions.get(null)?.phase).toBe("idle");
  });

  it("returns one stable, empty server snapshot without requiring window", () => {
    const snapshots: ReturnType<typeof useStreams>[] = [];
    function ServerProbe() {
      snapshots.push(useStreams());
      return null;
    }
    vi.stubGlobal("window", undefined);
    renderToString(createElement(ServerProbe));
    renderToString(createElement(ServerProbe));
    expect(snapshots[0]).toBe(snapshots[1]);
    expect(snapshots[0]).toMatchObject({ active: false, locked: false, operation: null, notice: null });
    expect(snapshots[0].sessions.size).toBe(0);
    vi.unstubAllGlobals();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetchMock);
  });
});
