import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, SCHEMA_VERSION, type AppDatabase } from "../lib/db/database";
import { ChatRepository, getRepository } from "../lib/db/repository";
import { chats, messages, threads } from "../lib/db/schema";
import { AppError } from "../lib/errors";
import type { Message } from "../lib/types";

describe("ChatRepository", () => {
  let repository: ChatRepository;

  beforeEach(() => {
    repository = new ChatRepository(":memory:");
  });

  afterEach(() => {
    repository.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function assistant(chatId: string, content = "First anchor. Second anchor. Third anchor.") {
    return repository.appendMessage({ chatId, threadId: null, role: "assistant", content, modelKey: "fast", complete: true });
  }

  function thread(parent: Message, anchorStart = 0, anchorEnd = 5) {
    return repository.insertThread({
      parentMessageId: parent.id,
      anchorStart,
      anchorEnd,
      source: "user",
      compressedContext: null,
      contextFrozenAt: null,
    });
  }

  function rawDatabase() {
    return (repository as unknown as { db: AppDatabase }).db;
  }

  it("creates and retrieves chats and derives the title only from the first main user message", () => {
    const chat = repository.createChat();
    expect(chat.title).toBe("New chat");
    expect(repository.getChat(chat.id)).toEqual(chat);
    expect(repository.getChat("missing")).toBeNull();
    expect(repository.getMessage("missing")).toBeNull();
    const parent = assistant(chat.id);
    const branch = thread(parent);
    repository.appendMessage({ chatId: chat.id, threadId: branch.id, role: "user", content: "Not the chat title", modelKey: null });
    expect(repository.getChat(chat.id)?.title).toBe("New chat");
    const content = "The first main question ".repeat(5);
    const userMessage = repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content, modelKey: null });
    expect(repository.getChat(chat.id)?.title).toBe(content.slice(0, 60));
    expect(userMessage).toMatchObject({ complete: true, modelKey: null, inputTokens: null, outputTokens: null });
    repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content: "Later title", modelKey: null });
    const reply = repository.appendMessage({ chatId: chat.id, threadId: null, role: "assistant", content: "Thoughtful answer", modelKey: "thinking" });
    expect(repository.getMessage(reply.id)?.modelKey).toBe("thinking");
    expect(repository.getChat(chat.id)?.title).toBe(content.slice(0, 60));
  });

  it("isolates main, thread, sibling-thread, and other-chat messages in both directions", () => {
    const chat = repository.createChat();
    const otherChat = repository.createChat();
    const mainUser = repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content: "Main question", modelKey: null });
    const parent = assistant(chat.id);
    const first = thread(parent, 0, 5);
    const second = thread(parent, 6, 12);
    const firstUser = repository.appendMessage({ chatId: chat.id, threadId: first.id, role: "user", content: "First branch", modelKey: null });
    const firstReply = repository.appendMessage({ chatId: chat.id, threadId: first.id, role: "assistant", content: "First branch reply", modelKey: "thinking" });
    const secondUser = repository.appendMessage({ chatId: chat.id, threadId: second.id, role: "user", content: "Second branch", modelKey: null });
    const otherReply = assistant(otherChat.id);
    expect(repository.listMessages(chat.id)).toEqual([mainUser, parent]);
    expect(repository.listMessages(chat.id, null)).toEqual([mainUser, parent]);
    expect(repository.listMessages(chat.id, first.id)).toEqual([firstUser, firstReply]);
    expect(repository.listMessages(chat.id, second.id)).toEqual([secondUser]);
    expect(repository.listMessages(otherChat.id)).toEqual([otherReply]);
    expect(() => repository.listMessages(otherChat.id, first.id)).toThrow(AppError);
    expect(() => repository.listMessages(chat.id, "missing")).toThrow(AppError);
    expect(() => repository.appendMessage({ chatId: otherChat.id, threadId: first.id, role: "user", content: "Wrong chat", modelKey: null })).toThrow(AppError);
    expect(() => repository.appendMessage({ chatId: "missing", threadId: null, role: "user", content: "Missing chat", modelKey: null })).toThrow(AppError);
    expect(repository.listMessages(chat.id, first.id)).toEqual([firstUser, firstReply]);
  });

  it("assigns monotonically increasing timestamps when the clock or requested timestamps tie", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const firstChat = repository.createChat();
    const secondChat = repository.createChat();
    expect(secondChat.createdAt).toBeGreaterThan(firstChat.createdAt);
    expect(repository.listChats()).toEqual([secondChat, firstChat]);
    const first = repository.appendMessage({ chatId: firstChat.id, threadId: null, role: "assistant", content: "First second third", modelKey: "fast", createdAt: 1_000 });
    const second = repository.appendMessage({ chatId: firstChat.id, threadId: null, role: "user", content: "Second", modelKey: null, createdAt: 1_000 });
    const third = repository.appendMessage({ chatId: firstChat.id, threadId: null, role: "user", content: "Third", modelKey: null, createdAt: 999 });
    expect([first.createdAt, second.createdAt, third.createdAt]).toEqual([1_000, 1_001, 1_002]);
    expect(repository.listMessages(firstChat.id)).toEqual([first, second, third]);
    const firstThread = thread(first, 0, 5);
    const secondThread = thread(first, 6, 12);
    expect(secondThread.createdAt).toBeGreaterThan(firstThread.createdAt);
    expect(repository.listThreads(firstChat.id).map((item) => item.id)).toEqual([firstThread.id, secondThread.id]);
  });

  it("stores exact anchors and titles and enriches threads with validation and real message counts", () => {
    const chat = repository.createChat();
    const parent = assistant(chat.id, "Prefix " + "A long selected phrase ".repeat(6));
    const branch = thread(parent, 7, 100);
    expect(branch).toMatchObject({
      chatId: chat.id,
      parentMessageId: parent.id,
      anchorStart: 7,
      anchorEnd: 100,
      anchorExact: parent.content.slice(7, 100),
      title: parent.content.slice(7, 100).slice(0, 60),
      source: "user",
      resolved: false,
      compressedContext: null,
      contextFrozenAt: null,
      anchorValid: true,
      messageCount: 0,
    });
    expect(repository.getThread(branch.id)).toEqual(branch);
    expect(repository.getThread("missing")).toBeNull();
    repository.appendMessage({ chatId: chat.id, threadId: branch.id, role: "user", content: "Question", modelKey: null });
    repository.appendMessage({ chatId: chat.id, threadId: branch.id, role: "assistant", content: "Answer", modelKey: "fast" });
    expect(repository.getThread(branch.id)?.messageCount).toBe(2);
    expect(repository.listThreads(chat.id)[0]).toMatchObject({ anchorValid: true, messageCount: 2 });
    const compressedContext = JSON.stringify({ kind: "fallback", messages: [] });
    const updated = repository.updateThread(branch.id, { resolved: true, compressedContext, contextFrozenAt: 1_234 });
    expect(updated).toMatchObject({ resolved: true, compressedContext, contextFrozenAt: 1_234, messageCount: 2 });
    expect(repository.updateThread(branch.id, {})).toEqual(updated);
    expect(repository.updateThread(branch.id, { resolved: false, compressedContext: null, contextFrozenAt: null })).toMatchObject({ resolved: false, compressedContext: null, contextFrozenAt: null });
  });

  it("keeps corrupted stored anchors visible and logs no parent or selected text", () => {
    const parent = assistant(repository.createChat().id, "A confidential answer that must not appear in logs");
    const branch = thread(parent, 2, 21);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    rawDatabase().update(threads).set({ anchorExact: "Private stale anchor" }).where(eq(threads.id, branch.id)).run();
    expect(repository.getThread(branch.id)).toMatchObject({ id: branch.id, anchorValid: false, messageCount: 0 });
    expect(repository.listThreads(parent.chatId)).toHaveLength(1);
    expect(repository.listThreads(parent.chatId)[0].anchorValid).toBe(false);
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain(parent.content);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("Private stale anchor");
  });

  it("requires a completed main assistant parent and a user source", () => {
    const chat = repository.createChat();
    const user = repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content: "User text", modelKey: null });
    const incomplete = repository.appendMessage({ chatId: chat.id, threadId: null, role: "assistant", content: "Streaming text", modelKey: "fast", complete: false });
    expect(() => thread({ ...user, id: "missing" })).toThrow(AppError);
    expect(() => thread(user)).toThrow(AppError);
    expect(() => thread(incomplete)).toThrow(AppError);
    const parent = assistant(chat.id);
    const first = thread(parent);
    const nestedParent = repository.appendMessage({ chatId: chat.id, threadId: first.id, role: "assistant", content: "Cannot nest", modelKey: "fast" });
    expect(() => thread(nestedParent)).toThrow(AppError);
    expect(() => repository.insertThread({ parentMessageId: parent.id, anchorStart: 6, anchorEnd: 12, source: "assistant" as "user", compressedContext: null, contextFrozenAt: null })).toThrow(AppError);
    expect(repository.listThreads(chat.id)).toHaveLength(1);
  });

  it.each([[-1, 2], [0, 100], [1, 1], [3, 2], [0.5, 2], [0, 2.5], [Number.NaN, 2]])("rejects invalid anchor bounds atomically: %s to %s", (start, end) => {
    const parent = assistant(repository.createChat().id);
    expect(() => thread(parent, start, end)).toThrow(AppError);
    expect(repository.listThreads(parent.chatId)).toEqual([]);
  });

  it("rejects intersecting anchors, including resolved ones, but allows adjacent anchors", () => {
    const parent = assistant(repository.createChat().id);
    const middle = thread(parent, 4, 10);
    repository.updateThread(middle.id, { resolved: true });
    for (const [start, end] of [[4, 10], [5, 8], [0, 12], [0, 6], [9, 12]]) {
      try {
        thread(parent, start, end);
        expect.fail("An overlapping anchor was accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ code: "anchor_overlap", status: 409 });
      }
    }
    expect(repository.listThreads(parent.chatId)).toHaveLength(1);
    const before = thread(parent, 0, 4);
    const after = thread(parent, 10, 14);
    expect(repository.listThreads(parent.chatId).map((item) => item.id)).toEqual([middle.id, before.id, after.id]);
    expect(thread(assistant(parent.chatId), 4, 10).anchorValid).toBe(true);
  });

  it("cascades thread deletion to its messages without deleting the parent or a sibling thread", () => {
    const parent = assistant(repository.createChat().id);
    const first = thread(parent, 0, 5);
    const sibling = thread(parent, 6, 12);
    const child = repository.appendMessage({ chatId: parent.chatId, threadId: first.id, role: "user", content: "Thread content", modelKey: null });
    repository.deleteThread(first.id);
    expect(repository.getThread(first.id)).toBeNull();
    expect(repository.getMessage(child.id)).toBeNull();
    expect(repository.getMessage(parent.id)).toEqual(parent);
    expect(repository.getThread(sibling.id)?.id).toBe(sibling.id);
    expect(() => repository.deleteThread(first.id)).not.toThrow();
  });

  it("cascades parent deletion through its threads and their messages", () => {
    const parent = assistant(repository.createChat().id);
    const branch = thread(parent);
    const child = repository.appendMessage({ chatId: parent.chatId, threadId: branch.id, role: "assistant", content: "Thread reply", modelKey: "fast" });
    const unrelated = assistant(parent.chatId);
    rawDatabase().delete(messages).where(eq(messages.id, parent.id)).run();
    expect(repository.getMessage(parent.id)).toBeNull();
    expect(repository.getThread(branch.id)).toBeNull();
    expect(repository.getMessage(child.id)).toBeNull();
    expect(repository.getMessage(unrelated.id)).toEqual(unrelated);
  });

  it("cascades chat deletion through all scopes while preserving other chats", () => {
    const parent = assistant(repository.createChat().id);
    const branch = thread(parent);
    const child = repository.appendMessage({ chatId: parent.chatId, threadId: branch.id, role: "user", content: "Thread content", modelKey: null });
    const unrelated = assistant(repository.createChat().id);
    repository.deleteChat(parent.chatId);
    expect(repository.getChat(parent.chatId)).toBeNull();
    expect(repository.getMessage(parent.id)).toBeNull();
    expect(repository.getMessage(child.id)).toBeNull();
    expect(repository.getThread(branch.id)).toBeNull();
    expect(repository.listMessages(parent.chatId)).toEqual([]);
    expect(repository.listThreads(parent.chatId)).toEqual([]);
    expect(repository.getMessage(unrelated.id)).toEqual(unrelated);
    expect(() => repository.deleteChat(parent.chatId)).not.toThrow();
  });

  it("updates only incomplete assistants and freezes completed content and completion state", () => {
    const chat = repository.createChat();
    const user = repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content: "Question", modelKey: null });
    const pending = repository.appendMessage({ chatId: chat.id, threadId: null, role: "assistant", content: "", modelKey: "thinking", complete: false });
    expect(repository.updatePartialMessage(pending.id, "Partial")).toMatchObject({ content: "Partial", complete: false });
    expect(repository.finishMessage(pending.id, { content: "Interrupted", complete: false, inputTokens: 10 })).toMatchObject({ content: "Interrupted", complete: false, inputTokens: 10 });
    repository.updatePartialMessage(pending.id, "Final answer");
    const finished = repository.finishMessage(pending.id, { content: "Final answer", complete: true, inputTokens: 10, outputTokens: 20 });
    expect(finished).toMatchObject({ complete: true, content: "Final answer", modelKey: "thinking", inputTokens: 10, outputTokens: 20 });
    expect(() => repository.updatePartialMessage(user.id, "Changed")).toThrow(AppError);
    expect(() => repository.finishMessage(user.id, { content: "Changed", complete: true })).toThrow(AppError);
    expect(() => repository.updatePartialMessage(finished.id, "Changed")).toThrow(AppError);
    expect(() => repository.finishMessage(finished.id, { content: "Changed", complete: true })).toThrow(AppError);
    expect(() => repository.finishMessage(finished.id, { content: finished.content, complete: false })).toThrow(AppError);
    expect(repository.finishMessage(finished.id, { content: finished.content, complete: true })).toEqual(finished);
    expect(repository.getMessage(finished.id)).toEqual(finished);
    expect(thread(finished).anchorValid).toBe(true);
  });

  it("copies complete and stopped thread snapshots to main without changing the source", () => {
    const parent = assistant(repository.createChat().id);
    const branch = thread(parent);
    const source = repository.appendMessage({ chatId: parent.chatId, threadId: branch.id, role: "assistant", content: "Useful branch result", modelKey: "thinking" });
    const copied = repository.copyMessageToMain(source.id);
    expect(copied.id).not.toBe(source.id);
    expect(copied).toMatchObject({ chatId: parent.chatId, threadId: null, role: source.role, content: source.content, modelKey: source.modelKey, complete: true });
    expect(copied.createdAt).toBeGreaterThan(source.createdAt);
    expect(repository.getMessage(source.id)).toEqual(source);
    expect(repository.listMessages(parent.chatId)).toEqual([parent, copied]);
    expect(repository.listMessages(parent.chatId, branch.id)).toEqual([source]);
    expect(() => repository.copyMessageToMain(parent.id)).toThrow(AppError);
    const incomplete = repository.appendMessage({ chatId: parent.chatId, threadId: branch.id, role: "assistant", content: "Still streaming", modelKey: "fast", complete: false });
    const partialCopy = repository.copyMessageToMain(incomplete.id);
    expect(partialCopy).toMatchObject({ content: incomplete.content, role: incomplete.role, threadId: null, complete: true });
    expect(repository.getMessage(incomplete.id)).toEqual(incomplete);
  });

  it("searches main and every thread case-insensitively within only the requested chat", () => {
    const parent = assistant(repository.createChat().id, "A NEEDLE in the main answer");
    const first = thread(parent, 2, 8);
    const second = thread(parent, 12, 16);
    const firstReply = repository.appendMessage({ chatId: parent.chatId, threadId: first.id, role: "assistant", content: "A Needle in a branch", modelKey: "fast" });
    const secondReply = repository.appendMessage({ chatId: parent.chatId, threadId: second.id, role: "user", content: "Another needle", modelKey: null });
    assistant(repository.createChat().id, "An unrelated needle");
    expect(repository.searchMessages(parent.chatId, "nEeDlE")).toEqual([
      { id: parent.id, threadId: null, threadTitle: null, role: "assistant", excerpt: parent.content },
      { id: firstReply.id, threadId: first.id, threadTitle: first.title, role: "assistant", excerpt: firstReply.content },
      { id: secondReply.id, threadId: second.id, threadTitle: second.title, role: "user", excerpt: secondReply.content },
    ]);
    expect(repository.searchMessages(parent.chatId, "")).toEqual([]);
    expect(repository.searchMessages(parent.chatId, "absent")).toEqual([]);
  });

  it.each(["%", "_", "\\", "50%_\\"])("treats LIKE wildcard input %s literally", (query) => {
    const chat = repository.createChat();
    const matching = assistant(chat.id, `Literal ${query} marker`);
    assistant(chat.id, "Literal wildcard marker 500x");
    expect(repository.searchMessages(chat.id, query).map((item) => item.id)).toEqual([matching.id]);
  });

  it("builds a short excerpt around the first match", () => {
    const parent = assistant(repository.createChat().id, "a".repeat(180) + "FIRST Needle MATCH" + "b".repeat(200) + "Needle");
    const [result] = repository.searchMessages(parent.chatId, "needle");
    expect(result.excerpt).toContain("FIRST Needle MATCH");
    expect(result.excerpt.length).toBeLessThanOrEqual(122);
    expect(result.excerpt.startsWith("…")).toBe(true);
    expect(result.excerpt.endsWith("…")).toBe(true);
  });

  it("rejects invalid model keys, token counts, and frozen JSON without changing data", () => {
    const parent = assistant(repository.createChat().id);
    expect(() => repository.appendMessage({ chatId: parent.chatId, threadId: null, role: "assistant", content: "Bad model", modelKey: "unknown" as "fast" })).toThrow(AppError);
    const pending = repository.appendMessage({ chatId: parent.chatId, threadId: null, role: "assistant", content: "", modelKey: "fast", complete: false });
    expect(() => repository.finishMessage(pending.id, { content: "Answer", complete: true, inputTokens: -1 })).toThrow(AppError);
    expect(repository.getMessage(pending.id)).toEqual(pending);
    const branch = thread(parent);
    expect(() => repository.updateThread(branch.id, { compressedContext: "not JSON" })).toThrow(AppError);
    expect(repository.getThread(branch.id)).toEqual(branch);
  });

  it("reuses its global singleton across module reloads and clears it on close", async () => {
    vi.stubGlobal("__threadllmRepository", repository);
    expect(getRepository()).toBe(repository);
    vi.resetModules();
    const reloaded = await import("../lib/db/repository");
    expect(reloaded.getRepository()).toBe(repository);
    repository.close();
    expect((globalThis as { __threadllmRepository?: ChatRepository }).__threadllmRepository).toBeUndefined();
  });

  it("can be closed more than once", () => {
    repository.close();
    expect(() => repository.close()).not.toThrow();
  });
});

describe("database initialization", () => {
  it("initializes the versioned snake_case schema with foreign keys and integer booleans", () => {
    const { db, sqlite } = openDatabase(":memory:");
    try {
      expect(sqlite.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
      expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(sqlite.pragma("journal_mode", { simple: true })).toBe("memory");
      const columns = sqlite.pragma("table_info(messages)") as { name: string }[];
      expect(columns.map((column) => column.name)).toEqual(["id", "chat_id", "thread_id", "role", "content", "model_key", "complete", "input_tokens", "output_tokens", "created_at"]);
      expect(() => db.insert(messages).values({ id: "orphan", chatId: "missing", threadId: null, role: "user", content: "Orphan", modelKey: null, complete: true, createdAt: 1 }).run()).toThrow();
      db.insert(chats).values({ id: "chat", title: "New chat", createdAt: 1 }).run();
      db.insert(messages).values({ id: "message", chatId: "chat", threadId: null, role: "assistant", content: "Answer", modelKey: "fast", complete: true, createdAt: 1 }).run();
      expect(sqlite.prepare("SELECT complete, typeof(complete) AS storage FROM messages WHERE id = ?").get("message")).toEqual({ complete: 1, storage: "integer" });
      db.insert(threads).values({ id: "thread", chatId: "chat", parentMessageId: "message", anchorStart: 0, anchorEnd: 6, anchorExact: "Answer", title: "Answer", createdAt: 1 }).run();
      expect(sqlite.prepare("SELECT resolved, source FROM threads WHERE id = ?").get("thread")).toEqual({ resolved: 0, source: "user" });
      expect(() => db.update(threads).set({ source: "assistant" as "user" }).where(eq(threads.id, "thread")).run()).toThrow();
      const foreignKeys = sqlite.pragma("foreign_key_list(threads)") as { on_delete: string }[];
      expect(foreignKeys).toHaveLength(2);
      expect(foreignKeys.every((key) => key.on_delete === "CASCADE")).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});
