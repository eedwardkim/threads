import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "../../app/api/generate/route";
import { setAuthResolverForTests } from "../../lib/auth/server";
import { parseFrozenContext } from "../../lib/context";
import { setDatabaseForTests } from "../../lib/db/client";
import { GenerationStore } from "../../lib/db/jobs";
import type { ChatRepository } from "../../lib/db/repository";
import { prepareGeneration, streamGeneration, type GenerationTuning } from "../../lib/generation";
import { assembleFullThreadPrompt, assembleThreadPrompt, MAIN_SYSTEM_PROMPT } from "../../lib/prompts";
import * as provider from "../../lib/provider";
import { seedDatabase } from "../../lib/seed";
import { getThreadData, refreshThreadContext } from "../../lib/thread-service";
import { estimateTokens } from "../../lib/tokens";
import type { Briefing, Message, StreamEvent } from "../../lib/types";
import { newUser, separateInstance, testDatabase } from "./harness";

function untilAborted(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) resolve();
    else signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const briefing: Briefing = {
  goal: "  Keep the frozen goal verbatim\n",
  constraints: ["No changes to main messages"], decisions: ["Preserve the parent"],
  artifacts: ["```ts\nconst raw = '  unchanged  ';\n```"], open_questions: ["What should the retry add?"],
};

let repository: ChatRepository;
let jobs: GenerationStore;
let userId: string;
let chatId: string;

beforeAll(() => setDatabaseForTests(testDatabase()));
afterAll(() => setDatabaseForTests(undefined));

beforeEach(async () => {
  ({ repository, jobs, userId } = newUser());
  setAuthResolverForTests(async () => ({ id: userId, email: null }));
  chatId = (await repository.createChat()).id;
  vi.spyOn(provider, "getProviderStatus").mockReturnValue({ mock: true, deepseek: false, anthropic: false, openai: false });
  vi.spyOn(provider, "compress").mockResolvedValue(briefing);
  vi.spyOn(provider, "streamChat").mockImplementation(async function* () {
    yield { type: "text", text: "Saved text" };
    yield { type: "usage", inputTokens: 12, outputTokens: 3 };
  });
});

afterEach(async () => {
  setAuthResolverForTests(undefined);
  vi.restoreAllMocks();
  expect(await jobs.listRunning()).toEqual([]);
});

function generate(input: Record<string, unknown> = {}, signal?: AbortSignal, headers: Record<string, string> = {}) {
  return POST(new Request("http://localhost/api/generate", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, signal,
    body: JSON.stringify({ requestId: crypto.randomUUID(), chatId, threadId: null, content: "Question", modelKey: "fast", ...input }),
  }));
}

async function events(response: Response): Promise<StreamEvent[]> {
  return (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as StreamEvent);
}

function append(input: Partial<Message> = {}) {
  return repository.appendMessage({ chatId, threadId: null, role: "assistant", content: "A completed parent with an anchor", modelKey: "fast", complete: true, ...input });
}

async function branch(parent?: Message) {
  const row = parent ?? await append();
  return repository.insertThread({ parentMessageId: row.id, anchorStart: 0, anchorEnd: 11, source: "user", compressedContext: null, contextFrozenAt: null });
}

async function retryFixture() {
  const parent = await append();
  const thread = await branch(parent);
  const question = await append({ threadId: thread.id, role: "user", content: "  Original **thread question**\n" });
  const partial = await append({ threadId: thread.id, content: "Old partial", complete: false, modelKey: "thinking" });
  await repository.finishMessage(partial.id, { content: partial.content, complete: false, inputTokens: 99, outputTokens: 8 });
  await append({ role: "user", content: "New main information after the original call" });
  return { parent, thread, question, partial };
}

const last = async (threadId: string | null = null) => (await repository.listMessages(chatId, threadId)).at(-1);
const service = () => ({ repository, jobs });

describe("authenticated generation API on Postgres", () => {
  it("hydrates demo history before a direct follow-up without sending thread transcripts to main", async () => {
    await seedDatabase(repository);
    const demo = (await repository.listChats()).find((chat) => chat.demoKey === "demo-la-span");
    if (!demo) throw new Error("demo chat missing");
    chatId = demo.id;
    expect(await repository.hasMessages(chatId)).toBe(false);
    const response = await generate({ content: "My own follow-up" });
    expect(response.status).toBe(200);
    await events(response);
    const main = await repository.listMessages(chatId);
    expect(main).toHaveLength(8);
    expect(main.at(-2)?.content).toBe("My own follow-up");
    expect(main.at(-1)?.content).toBe("Saved text");
    const prompt = vi.mocked(provider.streamChat).mock.calls[0][0].messages;
    expect(prompt.slice(1)).toEqual(main.slice(0, -1).map(({ role, content }) => ({ role, content })));
    expect(await repository.listThreads(chatId)).toHaveLength(3);
    expect(provider.compress).not.toHaveBeenCalled();
  });

  it("streams deltas promptly, checkpoints in the background, and finishes only after the final row is saved", async () => {
    const gate = deferred<void>();
    vi.mocked(provider.streamChat).mockImplementation(async function* () {
      yield { type: "text", text: "First " };
      await gate.promise;
      yield { type: "text", text: "second" };
      yield { type: "usage", inputTokens: 17, outputTokens: 4 };
    });
    const requestId = crypto.randomUUID();
    const response = await generate({ modelKey: "thinking", requestId });
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("cache-control")).toContain("private");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes('"delta"')) text += decoder.decode((await reader.read()).value, { stream: true });
    // The delta reached the client before any database write was required for it; the checkpoint lands shortly after.
    await vi.waitFor(async () => expect(await last()).toMatchObject({ content: "First ", complete: false }), { timeout: 3_000 });
    gate.resolve();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    const result = text.trim().split("\n").map((line) => JSON.parse(line) as StreamEvent);
    expect(result.map((event) => event.type)).toEqual(["start", "delta", "delta", "finish"]);
    expect(result[0]).toMatchObject({ message: { complete: false, modelKey: "thinking" }, userMessage: { complete: true, modelKey: "thinking", content: "Question" } });
    const saved = await last();
    expect(saved).toMatchObject({ content: "First second", complete: true, inputTokens: 17, outputTokens: 4 });
    expect(result.at(-1)).toEqual({ type: "finish", message: saved });
    expect(provider.streamChat).toHaveBeenCalledWith(expect.objectContaining({ messages: [{ role: "system", content: MAIN_SYSTEM_PROMPT }, { role: "user", content: "Question" }], modelKey: "thinking" }));
    expect(await jobs.get(requestId)).toMatchObject({ status: "completed", messageId: saved!.id });
  });

  it.each([false, true])("normalizes successful math before completing a message (thread: %s)", async (inThread) => {
    const threadId = inThread ? (await branch()).id : null;
    const raw = String.raw`Answer: \(x^2\).`;
    vi.mocked(provider.streamChat).mockImplementation(async function* () {
      yield { type: "text", text: raw.slice(0, 10) };
      yield { type: "text", text: raw.slice(10) };
      yield { type: "usage", inputTokens: 17, outputTokens: 4 };
    });
    const result = await events(await generate({ threadId, content: raw }));
    const saved = await last(threadId);
    expect(saved).toMatchObject({ content: "Answer: $x^2$.", complete: true, inputTokens: 17, outputTokens: 4 });
    expect(result.at(-1)).toEqual({ type: "finish", message: saved });
    expect((await repository.listMessages(chatId, threadId)).find((message) => message.role === "user")?.content).toBe(raw);
  });

  it.each(["error", "stop"])("preserves raw partial math after %s", async (failure) => {
    const raw = String.raw`Answer: \(x^2\), then \[unfinished`;
    const requestId = crypto.randomUUID();
    vi.mocked(provider.streamChat).mockImplementation(async function* ({ signal }) {
      yield { type: "text", text: raw };
      if (failure === "stop") {
        await new GenerationStore(separateInstance(), userId).requestStop(requestId);
        await untilAborted(signal);
      } else throw new Error("Interrupted");
    });
    const result = await events(await generate({ requestId }));
    expect(await last()).toMatchObject({ content: raw, complete: false });
    expect(result.at(-1)).toMatchObject({ type: "finish", message: { content: raw, complete: false } });
    expect((await jobs.get(requestId))?.status).toBe(failure === "stop" ? "stopped" : "failed");
  });

  it("preserves Unicode when provider chunks split a surrogate pair, through a Postgres round trip", async () => {
    vi.mocked(provider.streamChat).mockImplementation(async function* () {
      yield { type: "text", text: "A \ud834" };
      yield { type: "text", text: "\udd1e note" };
      yield { type: "usage", inputTokens: 2, outputTokens: 3 };
    });
    const result = await events(await generate());
    expect(await last()).toMatchObject({ content: "A \ud834\udd1e note", complete: true });
    expect(result.at(-1)).toMatchObject({ type: "finish", message: { content: "A \ud834\udd1e note" } });
  });

  it("keeps branch history out of main and main/sibling history out of a branch", async () => {
    const parent = await append();
    const thread = await branch(parent);
    await append({ threadId: thread.id, role: "user", content: "Thread-only history" });
    await append({ content: "Later main history" });
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
    await append({ role: "user", content: "Original question" });
    const partial = await append({ content: "Old partial", complete: false, modelKey: "thinking" });
    await repository.finishMessage(partial.id, { content: partial.content, complete: false, inputTokens: 99, outputTokens: 88 });
    await append({ role: "user", content: "Future question" });
    await append({ content: "Future answer" });
    const result = await events(await generate({ retryMessageId: partial.id, modelKey: "fast", content: undefined }));
    expect(await repository.listMessages(chatId)).toHaveLength(4);
    expect(result[0]).toMatchObject({ type: "start", message: { id: partial.id, content: "", modelKey: "thinking", inputTokens: null, outputTokens: null }, userMessage: null });
    expect(provider.streamChat).toHaveBeenCalledWith(expect.objectContaining({ modelKey: "thinking", messages: [{ role: "system", content: MAIN_SYSTEM_PROMPT }, { role: "user", content: "Original question" }] }));
    expect(await repository.getMessage(partial.id)).toMatchObject({ complete: true, modelKey: "thinking", inputTokens: 12, outputTokens: 3, content: "Saved text" });
  });

  it.each([["compressed", 0], ["fallback", 23]] as const)("attributes a retry after %s refresh to its actual usage (%s) without changing frozen prompt bytes", async (kind, inputTokens) => {
    const { parent, thread, question, partial } = await retryFixture();
    if (kind === "fallback") vi.mocked(provider.compress).mockResolvedValueOnce("invalid briefing");
    const refreshed = await refreshThreadContext(thread.id, service());
    expect(refreshed.context.actual).toBe(false);
    expect(partial.createdAt).toBeLessThan(refreshed.thread.contextFrozenAt!);
    const prompt = assembleThreadPrompt(refreshed.thread, parent, [question]);
    vi.mocked(provider.streamChat).mockImplementationOnce(async function* () {
      yield { type: "text", text: "Fresh retry response" };
      yield { type: "usage", inputTokens, outputTokens: 4 };
    });
    const result = await events(await generate({ threadId: thread.id, retryMessageId: partial.id, content: undefined }));
    const data = await getThreadData(thread.id, repository);
    expect(data.messages.at(-1)).toMatchObject({ id: partial.id, createdAt: partial.createdAt, complete: true, inputTokens, content: "Fresh retry response", modelKey: "thinking" });
    expect(result.at(-1)).toEqual({ type: "finish", message: data.messages.at(-1) });
    expect(data.context).toMatchObject({ actual: true, tokens: inputTokens, fullTokens: estimateTokens(assembleFullThreadPrompt(data.thread, await repository.listMessages(chatId), [question])) });
    expect(provider.streamChat).toHaveBeenCalledWith(expect.objectContaining({ messages: prompt, modelKey: "thinking" }));
    expect(data.thread).toEqual({ ...refreshed.thread, compressedContext: data.thread.compressedContext });
    expect(JSON.parse(data.thread.compressedContext!)).toMatchObject({ ...JSON.parse(refreshed.thread.compressedContext!), measuredMessageId: partial.id });
    expect(parseFrozenContext(data.thread.compressedContext)).toEqual(refreshed.context.briefing);
    expect(new TextEncoder().encode(JSON.stringify(assembleThreadPrompt(data.thread, parent, [question]))))
      .toEqual(new TextEncoder().encode(JSON.stringify(prompt)));
    expect(provider.compress).toHaveBeenCalledOnce();
    const reset = await refreshThreadContext(thread.id, service());
    expect(reset.context.actual).toBe(false);
    expect(JSON.parse(reset.thread.compressedContext!)).not.toHaveProperty("measuredMessageId");
    expect((await repository.getMessage(partial.id))?.inputTokens).toBe(inputTokens);
    expect(provider.compress).toHaveBeenCalledTimes(2);
  });

  it("attributes measured incomplete retries but never revives their usage on an unmeasured retry", async () => {
    const { thread, partial } = await retryFixture();
    await refreshThreadContext(thread.id, service());
    vi.mocked(provider.streamChat).mockImplementationOnce(async function* () {
      yield { type: "text", text: "Measured partial retry" };
      yield { type: "usage", inputTokens: 17, outputTokens: 3 };
      throw new Error("Interrupted after usage");
    });
    await events(await generate({ threadId: thread.id, retryMessageId: partial.id, content: undefined }));
    expect(await repository.getMessage(partial.id)).toMatchObject({ complete: false, inputTokens: 17 });
    expect((await getThreadData(thread.id, repository)).context.actual).toBe(false);
    vi.mocked(provider.streamChat).mockImplementationOnce(async function* () {
      yield { type: "text", text: "Retry without usage" };
    });
    await events(await generate({ threadId: thread.id, retryMessageId: partial.id, content: undefined }));
    expect((await repository.getMessage(partial.id))?.inputTokens).toBeNull();
    expect((await getThreadData(thread.id, repository)).context.actual).toBe(false);
    expect(provider.compress).toHaveBeenCalledOnce();
  });

  it("does not attribute an old in-flight retry after the cutoff moved, and refuses a refresh while the scope is busy", async () => {
    const { thread, partial } = await retryFixture();
    await refreshThreadContext(thread.id, service());
    const gate = deferred<void>();
    vi.mocked(provider.streamChat).mockImplementationOnce(async function* () {
      yield { type: "usage", inputTokens: 21, outputTokens: 5 };
      yield { type: "text", text: "Late response " };
      await gate.promise;
      yield { type: "text", text: "from the previous snapshot" };
    });
    const completion = events(await generate({ threadId: thread.id, retryMessageId: partial.id, content: undefined }));
    let contextAfterRefresh!: string | null;
    try {
      await vi.waitFor(async () => expect((await repository.getMessage(partial.id))?.content).toBe("Late response "), { timeout: 3_000 });
      // Context refresh and generation share the thread scope: the durable admission rejects the overlap instead of racing it.
      await expect(refreshThreadContext(thread.id, service())).rejects.toMatchObject({ code: "generation_busy" });
      const main = await append({ content: "New cutoff without changing briefing JSON" });
      await repository.updateThread(thread.id, { contextFrozenAt: main.createdAt });
      contextAfterRefresh = (await repository.getThread(thread.id))!.compressedContext;
      expect((await getThreadData(thread.id, repository)).context.actual).toBe(false);
    } finally {
      gate.resolve();
      await completion;
    }
    const data = await getThreadData(thread.id, repository);
    expect(data.messages.at(-1)).toMatchObject({ id: partial.id, complete: true, inputTokens: 21 });
    expect(data.context.actual).toBe(false);
    expect(data.thread.compressedContext).toBe(contextAfterRefresh);
    expect(JSON.parse(data.thread.compressedContext!)).not.toHaveProperty("measuredMessageId");
    expect(provider.compress).toHaveBeenCalledOnce();
  });

  it("preserves the unavailable briefing label when attributing usage to a legacy null context", async () => {
    const parent = await append();
    const thread = await branch(parent);
    const prompt = assembleThreadPrompt(thread, parent, []);
    await events(await generate({ threadId: thread.id }));
    const data = await getThreadData(thread.id, repository);
    expect(data.context).toMatchObject({ actual: true, tokens: 12, briefing: null });
    expect(JSON.parse(data.thread.compressedContext!)).toHaveProperty("measuredMessageId", data.messages.at(-1)!.id);
    expect(assembleThreadPrompt(data.thread, parent, [])).toEqual(prompt);
    expect(provider.compress).not.toHaveBeenCalled();
  });

  it("rejects missing configuration before appending or admitting a job", async () => {
    vi.mocked(provider.getProviderStatus).mockReturnValue({ mock: false, deepseek: false, anthropic: false, openai: false });
    const response = await generate();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "missing_key" });
    expect(await repository.listMessages(chatId)).toEqual([]);
    expect(provider.streamChat).not.toHaveBeenCalled();
  });

  it.each([{ complete: true, role: "assistant" as const }, { complete: false, role: "user" as const }])("never retries immutable rows: %o", async (input) => {
    const original = await append(input);
    const response = await generate({ retryMessageId: original.id });
    expect(response.status).toBe(409);
    expect(await repository.listMessages(chatId)).toEqual([original]);
    expect(provider.streamChat).not.toHaveBeenCalled();
  });

  it("validates chat, thread, and retry scope before writing", async () => {
    const otherChat = await repository.createChat();
    const parent = await append({ chatId: otherChat.id });
    const otherThread = await branch(parent);
    const retry = await append({ complete: false, chatId: otherChat.id });
    for (const input of [{ chatId: crypto.randomUUID() }, { threadId: otherThread.id }, { retryMessageId: retry.id }, { retryMessageId: crypto.randomUUID() }]) {
      const response = await generate(input);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    for (const input of [{ requestId: "not-a-uuid" }, { modelKey: "unknown" }, { content: " \n " }, { threadId: undefined }]) {
      expect((await generate(input)).status).toBe(400);
    }
    expect(await repository.listMessages(chatId)).toEqual([]);
    expect(provider.streamChat).not.toHaveBeenCalled();
  });

  it("refuses a busy scope without appending a user message, while an unrelated scope proceeds", async () => {
    const admitted = await jobs.admit({ requestId: crypto.randomUUID(), kind: "context", chatId, threadId: null, payloadHash: "busy", leaseMs: 30_000 });
    if (!admitted.admitted) throw new Error("expected admission");
    try {
      const response = await generate();
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "generation_busy" });
      expect(await repository.listMessages(chatId)).toEqual([]);
      const other = await repository.createChat();
      const unrelated = await generate({ chatId: other.id });
      expect(unrelated.status).toBe(200);
      await events(unrelated);
    } finally {
      await jobs.finish(admitted.job.id, admitted.job.fence, "stopped");
    }
  });

  it.each([[401, "invalid_key"], [404, "model_unavailable"], [429, "rate_limit"], [503, "busy"]] as const)("streams readable errors for synchronous provider failures (%s)", async (statusCode, code) => {
    vi.mocked(provider.streamChat).mockImplementation(() => { throw Object.assign(new Error("Provider rejected"), { statusCode }); });
    const response = await generate();
    expect(response.status).toBe(200);
    const result = await events(response);
    const saved = (await last())!;
    expect(result.map((event) => event.type)).toEqual(["start", "error", "finish"]);
    expect(result[1]).toMatchObject({ code, messageId: saved.id });
    expect(result.at(-1)).toEqual({ type: "finish", message: saved });
    expect(saved).toMatchObject({ content: "", complete: false });
  });

  it("retains partial text and reported usage when a provider fails after chunks", async () => {
    vi.mocked(provider.streamChat).mockImplementation(async function* () {
      yield { type: "text", text: "Retain this" };
      yield { type: "usage", inputTokens: 8, outputTokens: 3 };
      throw new Error("Connection lost");
    });
    const result = await events(await generate());
    expect(result.at(-2)).toMatchObject({ type: "error", code: "network" });
    expect(await last()).toMatchObject({ content: "Retain this", complete: false, inputTokens: 8, outputTokens: 3 });
  });

  it.each(["delete", "request-abort", "reader-cancel"])("retains incomplete text after %s and frees the scope", async (mode) => {
    vi.mocked(provider.streamChat).mockImplementation(async function* ({ signal }) {
      yield { type: "text", text: "A saved partial" };
      await untilAborted(signal);
    });
    const upstream = new AbortController();
    const requestId = crypto.randomUUID();
    const response = await generate({ requestId }, upstream.signal);
    await vi.waitFor(async () => expect((await last())?.content).toBe("A saved partial"), { timeout: 3_000 });
    if (mode === "delete") {
      const stop = await DELETE(new Request(`http://localhost/api/generate?id=${requestId}`, { method: "DELETE" }));
      expect(stop.status).toBe(200);
      expect(await stop.json()).toMatchObject({ stopped: true });
    } else if (mode === "request-abort") {
      upstream.abort();
    } else {
      await response.body!.cancel();
    }
    if (mode === "delete") {
      const result = await events(response);
      expect(result.some((event) => event.type === "error")).toBe(false);
      expect(result.at(-1)).toMatchObject({ type: "finish", message: { content: "A saved partial", complete: false } });
    } else if (mode === "request-abort") {
      // A disconnected client gets no finish event; the durable state below is what matters.
      expect((await events(response)).some((event) => event.type === "finish")).toBe(false);
    }
    await vi.waitFor(async () => expect((await jobs.get(requestId))?.status).toBe("stopped"), { timeout: 5_000 });
    expect(await last()).toMatchObject({ content: "A saved partial", complete: false });
  });

  it.each(["enqueue", "close"] as const)("handles a disconnected controller throwing from %s without leaking the job", async (method) => {
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
    await vi.waitFor(async () => expect(await jobs.listRunning()).toEqual([]), { timeout: 5_000 });
    expect(await last()).toMatchObject({ content: "Persisted before disconnect", complete: method === "close" });
  });

  it("does not append for an already-aborted request", async () => {
    const upstream = new AbortController();
    upstream.abort();
    const response = await generate({}, upstream.signal);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await repository.listMessages(chatId)).toEqual([]);
  });

  it("rejects cross-origin cancellation without stopping the active generation", async () => {
    const admitted = await jobs.admit({ requestId: crypto.randomUUID(), kind: "generation", chatId, threadId: null, payloadHash: "x", leaseMs: 30_000 });
    if (!admitted.admitted) throw new Error("expected admission");
    const response = await DELETE(new Request(`http://localhost/api/generate?id=${admitted.job.id}`, { method: "DELETE", headers: { origin: "https://elsewhere.invalid" } }));
    expect(response.status).toBe(403);
    expect((await jobs.get(admitted.job.id))?.cancelRequested).toBe(false);
    await jobs.finish(admitted.job.id, admitted.job.fence, "stopped");
  });

  it("returns JSON 401 for every method when unauthenticated", async () => {
    setAuthResolverForTests(async () => null);
    for (const response of [await generate(), await GET(new Request("http://localhost/api/generate")), await DELETE(new Request("http://localhost/api/generate?chatId=x", { method: "DELETE" }))]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    expect(provider.streamChat).not.toHaveBeenCalled();
  });
});

describe("durable coordination across instances and users", () => {
  it("answers a duplicate request id once: no second message and no second provider call", async () => {
    const requestId = crypto.randomUUID();
    const first = await events(await generate({ requestId }));
    expect(first.at(-1)?.type).toBe("finish");
    const second = await generate({ requestId });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "duplicate_request", job: { status: "completed", chatId } });
    expect(await repository.listMessages(chatId)).toHaveLength(2);
    expect(provider.streamChat).toHaveBeenCalledOnce();
  });

  it("rejects a reused request id carrying a different payload", async () => {
    const requestId = crypto.randomUUID();
    await events(await generate({ requestId }));
    const response = await generate({ requestId, content: "Something else" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "request_mismatch" });
    expect(await repository.listMessages(chatId)).toHaveLength(2);
  });

  it("lets a client reconcile a lost response through GET and refuses other owners' request ids", async () => {
    const requestId = crypto.randomUUID();
    await events(await generate({ requestId }));
    const mine = await GET(new Request(`http://localhost/api/generate?id=${requestId}`));
    expect(await mine.json()).toMatchObject({ job: { id: requestId, status: "completed", messageId: expect.any(String) } });
    const stranger = newUser();
    setAuthResolverForTests(async () => ({ id: stranger.userId, email: null }));
    expect((await GET(new Request(`http://localhost/api/generate?id=${requestId}`))).status).toBe(404);
    const stop = await DELETE(new Request(`http://localhost/api/generate?id=${requestId}`, { method: "DELETE" }));
    expect(await stop.json()).toMatchObject({ stopped: false });
  });

  it("runs unrelated scopes and users concurrently and keeps each stream separate", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    vi.mocked(provider.streamChat).mockImplementation(async function* ({ messages }) {
      const key = messages.at(-1)!.content;
      const gate = deferred<void>();
      gates.set(key, gate);
      yield { type: "text", text: `Answer to ${key}` };
      await gate.promise;
      yield { type: "usage", inputTokens: 1, outputTokens: 1 };
    });
    const other = newUser();
    const otherChat = await other.repository.createChat();
    const threadA = await branch();
    const responses = [
      await generate({ content: "main-A" }),
      await generate({ content: "thread-A", threadId: threadA.id }),
    ];
    setAuthResolverForTests(async () => ({ id: other.userId, email: null }));
    responses.push(await generate({ content: "other-user", chatId: otherChat.id }));
    setAuthResolverForTests(async () => ({ id: userId, email: null }));
    await vi.waitFor(() => expect(gates.size).toBe(3), { timeout: 5_000 });
    expect(await jobs.listRunning()).toHaveLength(2);
    expect(await other.jobs.listRunning()).toHaveLength(1);
    gates.forEach((gate) => gate.resolve());
    const results = await Promise.all(responses.map(events));
    expect(results.map((result) => (result.at(-1) as { message: Message }).message.content)).toEqual(["Answer to main-A", "Answer to thread-A", "Answer to other-user"]);
    expect(await repository.listMessages(chatId)).toHaveLength(3); // parent + main-A user + answer
    expect(await repository.listMessages(chatId, threadA.id)).toHaveLength(2);
    expect(await other.repository.listMessages(otherChat.id)).toHaveLength(2);
    expect(await other.jobs.listRunning()).toEqual([]);
  });

  it("stops a generation from a different server instance within the heartbeat, and only for its owner", async () => {
    vi.mocked(provider.streamChat).mockImplementation(async function* ({ signal }) {
      yield { type: "text", text: "Streaming on instance A" };
      await untilAborted(signal);
    });
    const requestId = crypto.randomUUID();
    const response = await generate({ requestId });
    await vi.waitFor(async () => expect((await last())?.content).toBe("Streaming on instance A"), { timeout: 3_000 });
    const stranger = new GenerationStore(separateInstance(), newUser().userId);
    expect(await stranger.requestStop(requestId)).toBe(false);
    expect(await stranger.requestStopScope(chatId)).toBe(0);
    const startedAt = Date.now();
    expect(await new GenerationStore(separateInstance(), userId).requestStop(requestId)).toBe(true);
    const result = await events(response);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(result.at(-1)).toMatchObject({ type: "finish", message: { content: "Streaming on instance A", complete: false } });
    expect((await jobs.get(requestId))).toMatchObject({ status: "stopped", errorCode: "stop" });
  });

  it("recovers an expired lease so the scope is not permanently busy, and fences the dead worker out", async () => {
    const dead = await jobs.admit({ requestId: crypto.randomUUID(), kind: "generation", chatId, threadId: null, payloadHash: "crash", leaseMs: 50 });
    if (!dead.admitted) throw new Error("expected admission");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await jobs.listRunning()).toEqual([]);
    expect((await jobs.get(dead.job.id))).toMatchObject({ status: "expired", errorCode: "lease_expired" });
    expect(await jobs.renew(dead.job.id, dead.job.fence, 30_000)).toBeNull();
    expect(await jobs.finish(dead.job.id, dead.job.fence, "completed")).toBe(false);
    expect(await jobs.attach(dead.job.id, dead.job.fence, { messageId: null, userMessageId: null, attempt: 0 })).toBe(false);
    const response = await generate();
    expect(response.status).toBe(200);
    await events(response);
  });

  it("keeps renewing the lease while the provider is silent, so slow prefill does not expire the job", async () => {
    const tuning: Partial<GenerationTuning> = { leaseMs: 300, heartbeatMs: 60 };
    vi.mocked(provider.streamChat).mockImplementation(async function* () {
      await new Promise((resolve) => setTimeout(resolve, 900));
      yield { type: "text", text: "Finally" };
      yield { type: "usage", inputTokens: 1, outputTokens: 1 };
    });
    const prepared = await prepareGeneration({ requestId: crypto.randomUUID(), chatId, threadId: null, content: "Slow", modelKey: "fast" }, { repository, jobs, tuning });
    const result = await events(new Response(streamGeneration(prepared, { repository, jobs, tuning })));
    expect(result.at(-1)).toMatchObject({ type: "finish", message: { content: "Finally", complete: true } });
    expect((await jobs.get(prepared.job.id))?.status).toBe("completed");
  });

  it("never lets a stale checkpoint or finalizer overwrite a newer attempt of the same message", async () => {
    const partial = await append({ content: "Old partial", complete: false });
    const attempt0 = await repository.getMessageAttempt(partial.id);
    const { attempt } = await repository.beginRetry(partial.id);
    expect(attempt).toBe((attempt0 ?? 0) + 1);
    expect(await repository.checkpointMessage(partial.id, "stale worker text", attempt - 1)).toBeNull();
    await expect(repository.finishMessage(partial.id, { content: "stale final", complete: true, inputTokens: null, outputTokens: null }, { attempt: attempt - 1 })).rejects.toMatchObject({ code: "stale_generation" });
    expect(await repository.getMessage(partial.id)).toMatchObject({ content: "", complete: false });
    await repository.finishMessage(partial.id, { content: "current final", complete: true, inputTokens: 1, outputTokens: 1 }, { attempt });
    expect(await repository.checkpointMessage(partial.id, "late raw text after completion", attempt)).toBeNull();
    expect(await repository.getMessage(partial.id)).toMatchObject({ content: "current final", complete: true });
  });

  it("a retry racing an in-flight generation of the same row fences the old worker's final write", async () => {
    const gate = deferred<void>();
    vi.mocked(provider.streamChat).mockImplementation(async function* () {
      yield { type: "text", text: "Old attempt text" };
      await gate.promise;
      yield { type: "text", text: " that arrived late" };
    });
    const partial = await append({ content: "Old partial", complete: false });
    const first = await generate({ retryMessageId: partial.id, content: undefined });
    await vi.waitFor(async () => expect((await repository.getMessage(partial.id))?.content).toBe("Old attempt text"), { timeout: 3_000 });
    // Simulate another instance whose stop-and-retry landed on the same row (the scope was force-expired by a crash).
    await jobs.requestStopScope(chatId);
    const { attempt } = await repository.beginRetry(partial.id);
    await repository.finishMessage(partial.id, { content: "Newer attempt final", complete: true, inputTokens: 1, outputTokens: 1 }, { attempt });
    gate.resolve();
    const result = await events(first);
    expect(result.some((event) => event.type === "error" && event.code === "stale_generation") || result.at(-1)?.type === "finish").toBe(true);
    expect(await repository.getMessage(partial.id)).toMatchObject({ content: "Newer attempt final", complete: true });
  });

  it("marks persistence failures instead of claiming unsaved text is durable", async () => {
    vi.mocked(provider.streamChat).mockImplementation(async function* () {
      yield { type: "text", text: "Never saved" };
      yield { type: "text", text: " either" };
      yield { type: "usage", inputTokens: 1, outputTokens: 1 };
    });
    vi.spyOn(repository, "checkpointMessage").mockRejectedValue(new Error("db down"));
    vi.spyOn(repository, "finishMessage").mockRejectedValue(new Error("db down"));
    const tuning: Partial<GenerationTuning> = { maxCheckpointFailures: 1, checkpointIntervalMs: 0 };
    const prepared = await prepareGeneration({ requestId: crypto.randomUUID(), chatId, threadId: null, content: "Q", modelKey: "fast" }, { repository, jobs, tuning });
    const result = await events(new Response(streamGeneration(prepared, { repository, jobs, tuning })));
    expect(result.some((event) => event.type === "error" && event.code === "persistence_failed")).toBe(true);
    expect(result.at(-1)).toMatchObject({ type: "finish", message: { content: "", complete: false } });
    expect((await jobs.get(prepared.job.id))).toMatchObject({ status: "failed" });
  });

  it("enforces the per-user concurrency limit without affecting other users", async () => {
    const admitted = [];
    for (let index = 0; index < 2; index += 1) {
      admitted.push(await jobs.admit({ requestId: crypto.randomUUID(), kind: "generation", chatId: (await repository.createChat()).id, threadId: null, payloadHash: "x", leaseMs: 30_000, limits: { maxConcurrentPerUser: 2 } }));
    }
    await expect(jobs.admit({ requestId: crypto.randomUUID(), kind: "generation", chatId, threadId: null, payloadHash: "x", leaseMs: 30_000, limits: { maxConcurrentPerUser: 2 } }))
      .rejects.toMatchObject({ code: "too_many_generations" });
    const other = newUser();
    const otherChat = await other.repository.createChat();
    const theirs = await other.jobs.admit({ requestId: crypto.randomUUID(), kind: "generation", chatId: otherChat.id, threadId: null, payloadHash: "x", leaseMs: 30_000, limits: { maxConcurrentPerUser: 2 } });
    expect(theirs.admitted).toBe(true);
    for (const job of [...admitted, theirs]) if (job.admitted) await (job === theirs ? other.jobs : jobs).finish(job.job.id, job.job.fence, "stopped");
  });
});
