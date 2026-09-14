import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRepository } from "../../lib/db/repository";
import { messages, threads } from "../../lib/db/schema";
import { AppError } from "../../lib/errors";
import type { Message } from "../../lib/types";
import { newUser, testDatabase } from "./harness";

describe("ChatRepository (Postgres)", () => {
  // Every test gets a fresh owner; nothing is shared between tests or with other users' data.
  let repository: ChatRepository = newUser().repository;

  beforeEach(() => {
    repository = newUser().repository;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function assistant(chatId: string, content = "First anchor. Second anchor. Third anchor.") {
    return repository.appendMessage({ chatId, threadId: null, role: "assistant", content, modelKey: "fast", complete: true });
  }

  async function thread(parent: Message, anchorStart = 0, anchorEnd = 5) {
    return repository.insertThread({
      parentMessageId: parent.id,
      anchorStart,
      anchorEnd,
      source: "user",
      compressedContext: null,
      contextFrozenAt: null,
    });
  }

  /** Superuser access used only to corrupt fixtures deliberately. */
  function rawDatabase() {
    return testDatabase().db;
  }

  it("creates and retrieves chats and derives the title only from the first main user message", async () => {
    const chat = await repository.createChat();
    expect(chat.title).toBe("New chat");
    expect(await repository.getChat(chat.id)).toEqual(chat);
    expect(await repository.getChat("missing")).toBeNull();
    expect(await repository.getMessage("missing")).toBeNull();
    const parent = await assistant(chat.id);
    const branch = await thread(parent);
    await repository.appendMessage({ chatId: chat.id, threadId: branch.id, role: "user", content: "Not the chat title", modelKey: null });
    expect((await repository.getChat(chat.id))?.title).toBe("New chat");
    const content = "The first main question ".repeat(5);
    const userMessage = await repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content, modelKey: null });
    expect((await repository.getChat(chat.id))?.title).toBe(content.slice(0, 60));
    expect(userMessage).toMatchObject({ complete: true, modelKey: null, inputTokens: null, outputTokens: null });
    await repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content: "Later title", modelKey: null });
    const reply = await repository.appendMessage({ chatId: chat.id, threadId: null, role: "assistant", content: "Thoughtful answer", modelKey: "thinking" });
    expect((await repository.getMessage(reply.id))?.modelKey).toBe("thinking");
    const dotted = await repository.appendMessage({ chatId: chat.id, threadId: null, role: "assistant", content: "Newer model answer", modelKey: "gpt-5.5" });
    expect((await repository.getMessage(dotted.id))?.modelKey).toBe("gpt-5.5");
    expect((await repository.getChat(chat.id))?.title).toBe(content.slice(0, 60));
  });

  it("renames a conversation without changing its location, messages, or thread anchors", async () => {
    const folder = await repository.createFolder("Work");
    const chat = await repository.moveChat((await repository.createChat()).id, folder.id);
    const parent = await assistant(chat.id);
    const branch = await thread(parent);
    expect(await repository.renameChat(chat.id, "  Planning notes  ")).toEqual({ ...chat, title: "Planning notes" });
    expect((await repository.getChat(chat.id))?.title).toBe("Planning notes");
    expect(await repository.getMessage(parent.id)).toEqual(parent);
    expect(await repository.getThread(branch.id)).toEqual(branch);
  });

  it("preserves a custom name when the first main message arrives", async () => {
    const chat = await repository.createChat();
    await repository.renameChat(chat.id, "My project");
    await repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content: "A different first question", modelKey: null });
    expect((await repository.getChat(chat.id))?.title).toBe("My project");
  });

  it.each(["", "   ", null, 42])("rejects invalid conversation names: %s", async (title) => {
    const chat = await repository.createChat();
    await expect(repository.renameChat(chat.id, title as string)).rejects.toThrow(AppError);
    expect(await repository.getChat(chat.id)).toEqual(chat);
  });

  it("reports a missing conversation when renaming", async () => {
    await expect(repository.renameChat("missing", "New name")).rejects.toThrowError(expect.objectContaining({ status: 404, code: "chat_not_found" }));
  });

  it("isolates main, thread, sibling-thread, and other-chat messages in both directions", async () => {
    const chat = await repository.createChat();
    const otherChat = await repository.createChat();
    const mainUser = await repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content: "Main question", modelKey: null });
    const parent = await assistant(chat.id);
    const first = await thread(parent, 0, 5);
    const second = await thread(parent, 6, 12);
    const firstUser = await repository.appendMessage({ chatId: chat.id, threadId: first.id, role: "user", content: "First branch", modelKey: null });
    const firstReply = await repository.appendMessage({ chatId: chat.id, threadId: first.id, role: "assistant", content: "First branch reply", modelKey: "thinking" });
    const secondUser = await repository.appendMessage({ chatId: chat.id, threadId: second.id, role: "user", content: "Second branch", modelKey: null });
    const otherReply = await assistant(otherChat.id);
    expect(await repository.listMessages(chat.id)).toEqual([mainUser, parent]);
    expect(await repository.listMessages(chat.id, null)).toEqual([mainUser, parent]);
    expect(await repository.listMessages(chat.id, first.id)).toEqual([firstUser, firstReply]);
    expect(await repository.listMessages(chat.id, second.id)).toEqual([secondUser]);
    expect(await repository.listMessages(otherChat.id)).toEqual([otherReply]);
    await expect(repository.listMessages(otherChat.id, first.id)).rejects.toThrow(AppError);
    await expect(repository.listMessages(chat.id, "missing")).rejects.toThrow(AppError);
    await expect(repository.appendMessage({ chatId: otherChat.id, threadId: first.id, role: "user", content: "Wrong chat", modelKey: null })).rejects.toThrow(AppError);
    await expect(repository.appendMessage({ chatId: "missing", threadId: null, role: "user", content: "Missing chat", modelKey: null })).rejects.toThrow(AppError);
    expect(await repository.listMessages(chat.id, first.id)).toEqual([firstUser, firstReply]);
  });

  it("assigns monotonically increasing timestamps when the clock or requested timestamps tie", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    const firstChat = await repository.createChat();
    const secondChat = await repository.createChat();
    expect(secondChat.createdAt).toBeGreaterThan(firstChat.createdAt);
    expect(await repository.listChats()).toEqual([secondChat, firstChat]);
    const first = await repository.appendMessage({ chatId: firstChat.id, threadId: null, role: "assistant", content: "First second third", modelKey: "fast", createdAt: 1_000 });
    const second = await repository.appendMessage({ chatId: firstChat.id, threadId: null, role: "user", content: "Second", modelKey: null, createdAt: 1_000 });
    const third = await repository.appendMessage({ chatId: firstChat.id, threadId: null, role: "user", content: "Third", modelKey: null, createdAt: 999 });
    expect([first.createdAt, second.createdAt, third.createdAt]).toEqual([1_000, 1_001, 1_002]);
    expect(await repository.listMessages(firstChat.id)).toEqual([first, second, third]);
    const firstThread = await thread(first, 0, 5);
    const secondThread = await thread(first, 6, 12);
    expect(secondThread.createdAt).toBeGreaterThan(firstThread.createdAt);
    expect((await repository.listThreads(firstChat.id)).map((item) => item.id)).toEqual([firstThread.id, secondThread.id]);
  });

  it("stores exact anchors and titles and enriches threads with validation and real message counts", async () => {
    const chat = await repository.createChat();
    const parent = await assistant(chat.id, "Prefix " + "A long selected phrase ".repeat(6));
    const branch = await thread(parent, 7, 100);
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
    expect(await repository.getThread(branch.id)).toEqual(branch);
    expect(await repository.getThread("missing")).toBeNull();
    await repository.appendMessage({ chatId: chat.id, threadId: branch.id, role: "user", content: "Question", modelKey: null });
    await repository.appendMessage({ chatId: chat.id, threadId: branch.id, role: "assistant", content: "Answer", modelKey: "fast" });
    expect((await repository.getThread(branch.id))?.messageCount).toBe(2);
    expect((await repository.listThreads(chat.id))[0]).toMatchObject({ anchorValid: true, messageCount: 2 });
    const compressedContext = JSON.stringify({ kind: "fallback", messages: [] });
    const updated = await repository.updateThread(branch.id, { resolved: true, compressedContext, contextFrozenAt: 1_234 });
    expect(updated).toMatchObject({ resolved: true, compressedContext, contextFrozenAt: 1_234, messageCount: 2 });
    expect(await repository.updateThread(branch.id, {})).toEqual(updated);
    expect(await repository.updateThread(branch.id, { resolved: false, compressedContext: null, contextFrozenAt: null })).toMatchObject({ resolved: false, compressedContext: null, contextFrozenAt: null });
  });

  it("keeps corrupted stored anchors visible and logs no parent or selected text", async () => {
    const parent = await assistant((await repository.createChat()).id, "A confidential answer that must not appear in logs");
    const branch = await thread(parent, 2, 21);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await rawDatabase().update(threads).set({ anchorExact: "Private stale anchor" }).where(eq(threads.id, branch.id));
    expect(await repository.getThread(branch.id)).toMatchObject({ id: branch.id, anchorValid: false, messageCount: 0 });
    expect(await repository.listThreads(parent.chatId)).toHaveLength(1);
    expect((await repository.listThreads(parent.chatId))[0].anchorValid).toBe(false);
    expect(spy).toHaveBeenCalled();
    expect(JSON.stringify(spy.mock.calls)).not.toContain(parent.content);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("Private stale anchor");
  });

  it("requires a completed main assistant parent and a user source", async () => {
    const chat = await repository.createChat();
    const user = await repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content: "User text", modelKey: null });
    const incomplete = await repository.appendMessage({ chatId: chat.id, threadId: null, role: "assistant", content: "Streaming text", modelKey: "fast", complete: false });
    await expect(thread({ ...user, id: "missing" })).rejects.toThrow(AppError);
    await expect(thread(user)).rejects.toThrow(AppError);
    await expect(thread(incomplete)).rejects.toThrow(AppError);
    const parent = await assistant(chat.id);
    const first = await thread(parent);
    const nestedParent = await repository.appendMessage({ chatId: chat.id, threadId: first.id, role: "assistant", content: "Cannot nest", modelKey: "fast" });
    await expect(thread(nestedParent)).rejects.toThrow(AppError);
    await expect(repository.insertThread({ parentMessageId: parent.id, anchorStart: 6, anchorEnd: 12, source: "assistant" as "user", compressedContext: null, contextFrozenAt: null })).rejects.toThrow(AppError);
    expect(await repository.listThreads(chat.id)).toHaveLength(1);
  });

  it.each([[-1, 2], [0, 100], [1, 1], [3, 2], [0.5, 2], [0, 2.5], [Number.NaN, 2]])("rejects invalid anchor bounds atomically: %s to %s", async (start, end) => {
    const parent = await assistant((await repository.createChat()).id);
    await expect(thread(parent, start, end)).rejects.toThrow(AppError);
    expect(await repository.listThreads(parent.chatId)).toEqual([]);
  });

  it("rejects intersecting anchors, including resolved ones, but allows adjacent anchors", async () => {
    const parent = await assistant((await repository.createChat()).id);
    const middle = await thread(parent, 4, 10);
    await repository.updateThread(middle.id, { resolved: true });
    for (const [start, end] of [[4, 10], [5, 8], [0, 12], [0, 6], [9, 12]]) {
      try {
        await thread(parent, start, end);
        expect.fail("An overlapping anchor was accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ code: "anchor_overlap", status: 409 });
      }
    }
    expect(await repository.listThreads(parent.chatId)).toHaveLength(1);
    const before = await thread(parent, 0, 4);
    const after = await thread(parent, 10, 14);
    expect((await repository.listThreads(parent.chatId)).map((item) => item.id)).toEqual([middle.id, before.id, after.id]);
    expect((await thread(await assistant(parent.chatId), 4, 10)).anchorValid).toBe(true);
  });

  it("cascades thread deletion to its messages without deleting the parent or a sibling thread", async () => {
    const parent = await assistant((await repository.createChat()).id);
    const first = await thread(parent, 0, 5);
    const sibling = await thread(parent, 6, 12);
    const child = await repository.appendMessage({ chatId: parent.chatId, threadId: first.id, role: "user", content: "Thread content", modelKey: null });
    await repository.deleteThread(first.id);
    expect(await repository.getThread(first.id)).toBeNull();
    expect(await repository.getMessage(child.id)).toBeNull();
    expect(await repository.getMessage(parent.id)).toEqual(parent);
    expect((await repository.getThread(sibling.id))?.id).toBe(sibling.id);
    await expect(repository.deleteThread(first.id)).resolves.not.toThrow();
  });

  it("cascades parent deletion through its threads and their messages", async () => {
    const parent = await assistant((await repository.createChat()).id);
    const branch = await thread(parent);
    const child = await repository.appendMessage({ chatId: parent.chatId, threadId: branch.id, role: "assistant", content: "Thread reply", modelKey: "fast" });
    const unrelated = await assistant(parent.chatId);
    await rawDatabase().delete(messages).where(eq(messages.id, parent.id));
    expect(await repository.getMessage(parent.id)).toBeNull();
    expect(await repository.getThread(branch.id)).toBeNull();
    expect(await repository.getMessage(child.id)).toBeNull();
    expect(await repository.getMessage(unrelated.id)).toEqual(unrelated);
  });

  it("cascades chat deletion through all scopes while preserving other chats", async () => {
    const parent = await assistant((await repository.createChat()).id);
    const branch = await thread(parent);
    const child = await repository.appendMessage({ chatId: parent.chatId, threadId: branch.id, role: "user", content: "Thread content", modelKey: null });
    const unrelated = await assistant((await repository.createChat()).id);
    await repository.deleteChat(parent.chatId);
    expect(await repository.getChat(parent.chatId)).toBeNull();
    expect(await repository.getMessage(parent.id)).toBeNull();
    expect(await repository.getMessage(child.id)).toBeNull();
    expect(await repository.getThread(branch.id)).toBeNull();
    expect(await repository.listMessages(parent.chatId)).toEqual([]);
    expect(await repository.listThreads(parent.chatId)).toEqual([]);
    expect(await repository.getMessage(unrelated.id)).toEqual(unrelated);
    await expect(repository.deleteChat(parent.chatId)).resolves.not.toThrow();
  });

  it("updates only incomplete assistants and freezes completed content and completion state", async () => {
    const chat = await repository.createChat();
    const user = await repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content: "Question", modelKey: null });
    const pending = await repository.appendMessage({ chatId: chat.id, threadId: null, role: "assistant", content: "", modelKey: "thinking", complete: false });
    expect(await repository.updatePartialMessage(pending.id, "Partial")).toMatchObject({ content: "Partial", complete: false });
    expect(await repository.finishMessage(pending.id, { content: "Interrupted", complete: false, inputTokens: 10 })).toMatchObject({ content: "Interrupted", complete: false, inputTokens: 10 });
    await repository.updatePartialMessage(pending.id, "Final answer");
    const finished = await repository.finishMessage(pending.id, { content: "Final answer", complete: true, inputTokens: 10, outputTokens: 20 });
    expect(finished).toMatchObject({ complete: true, content: "Final answer", modelKey: "thinking", inputTokens: 10, outputTokens: 20 });
    await expect(repository.updatePartialMessage(user.id, "Changed")).rejects.toThrow(AppError);
    await expect(repository.finishMessage(user.id, { content: "Changed", complete: true })).rejects.toThrow(AppError);
    await expect(repository.updatePartialMessage(finished.id, "Changed")).rejects.toThrow(AppError);
    await expect(repository.finishMessage(finished.id, { content: "Changed", complete: true })).rejects.toThrow(AppError);
    await expect(repository.finishMessage(finished.id, { content: finished.content, complete: false })).rejects.toThrow(AppError);
    expect(await repository.finishMessage(finished.id, { content: finished.content, complete: true })).toEqual(finished);
    expect(await repository.getMessage(finished.id)).toEqual(finished);
    expect((await thread(finished)).anchorValid).toBe(true);
  });

  it("copies complete and stopped thread snapshots to main without changing the source", async () => {
    const parent = await assistant((await repository.createChat()).id);
    const branch = await thread(parent);
    const source = await repository.appendMessage({ chatId: parent.chatId, threadId: branch.id, role: "assistant", content: "Useful branch result", modelKey: "thinking" });
    const copied = await repository.copyMessageToMain(source.id);
    expect(copied.id).not.toBe(source.id);
    expect(copied).toMatchObject({ chatId: parent.chatId, threadId: null, role: source.role, content: source.content, modelKey: source.modelKey, complete: true });
    expect(copied.createdAt).toBeGreaterThan(source.createdAt);
    expect(await repository.getMessage(source.id)).toEqual(source);
    expect(await repository.listMessages(parent.chatId)).toEqual([parent, copied]);
    expect(await repository.listMessages(parent.chatId, branch.id)).toEqual([source]);
    await expect(repository.copyMessageToMain(parent.id)).rejects.toThrow(AppError);
    const incomplete = await repository.appendMessage({ chatId: parent.chatId, threadId: branch.id, role: "assistant", content: "Still streaming", modelKey: "fast", complete: false });
    const partialCopy = await repository.copyMessageToMain(incomplete.id);
    expect(partialCopy).toMatchObject({ content: incomplete.content, role: incomplete.role, threadId: null, complete: true });
    expect(await repository.getMessage(incomplete.id)).toEqual(incomplete);
  });

  it("searches main and every thread case-insensitively within only the requested chat", async () => {
    const parent = await assistant((await repository.createChat()).id, "A NEEDLE in the main answer");
    const first = await thread(parent, 2, 8);
    const second = await thread(parent, 12, 16);
    const firstReply = await repository.appendMessage({ chatId: parent.chatId, threadId: first.id, role: "assistant", content: "A Needle in a branch", modelKey: "fast" });
    const secondReply = await repository.appendMessage({ chatId: parent.chatId, threadId: second.id, role: "user", content: "Another needle", modelKey: null });
    await assistant((await repository.createChat()).id, "An unrelated needle");
    expect(await repository.searchMessages(parent.chatId, "nEeDlE")).toEqual([
      { id: parent.id, threadId: null, threadTitle: null, role: "assistant", excerpt: parent.content },
      { id: firstReply.id, threadId: first.id, threadTitle: first.title, role: "assistant", excerpt: firstReply.content },
      { id: secondReply.id, threadId: second.id, threadTitle: second.title, role: "user", excerpt: secondReply.content },
    ]);
    expect(await repository.searchMessages(parent.chatId, "")).toEqual([]);
    expect(await repository.searchMessages(parent.chatId, "absent")).toEqual([]);
  });

  it.each(["%", "_", "\\", "50%_\\"])("treats LIKE wildcard input %s literally", async (query) => {
    const chat = await repository.createChat();
    const matching = await assistant(chat.id, `Literal ${query} marker`);
    await assistant(chat.id, "Literal wildcard marker 500x");
    expect((await repository.searchMessages(chat.id, query)).map((item) => item.id)).toEqual([matching.id]);
  });

  it("builds a short excerpt around the first match", async () => {
    const parent = await assistant((await repository.createChat()).id, "a".repeat(180) + "FIRST Needle MATCH" + "b".repeat(200) + "Needle");
    const [result] = await repository.searchMessages(parent.chatId, "needle");
    expect(result.excerpt).toContain("FIRST Needle MATCH");
    expect(result.excerpt.length).toBeLessThanOrEqual(122);
    expect(result.excerpt.startsWith("…")).toBe(true);
    expect(result.excerpt.endsWith("…")).toBe(true);
  });

  it("rejects invalid model keys, token counts, and frozen JSON without changing data", async () => {
    const parent = await assistant((await repository.createChat()).id);
    await expect(repository.appendMessage({ chatId: parent.chatId, threadId: null, role: "assistant", content: "Bad model", modelKey: "unknown" as "fast" })).rejects.toThrow(AppError);
    const pending = await repository.appendMessage({ chatId: parent.chatId, threadId: null, role: "assistant", content: "", modelKey: "fast", complete: false });
    await expect(repository.finishMessage(pending.id, { content: "Answer", complete: true, inputTokens: -1 })).rejects.toThrow(AppError);
    expect(await repository.getMessage(pending.id)).toEqual(pending);
    const branch = await thread(parent);
    await expect(repository.updateThread(branch.id, { compressedContext: "not JSON" })).rejects.toThrow(AppError);
    expect(await repository.getThread(branch.id)).toEqual(branch);
  });

  describe("folders", async () => {
    it("creates, lists, renames, and deletes folders", async () => {
      const folder = await repository.createFolder("Work");
      expect(folder).toMatchObject({ name: "Work", parentId: null, sortOrder: 0 });
      expect(folder.id).toBeTruthy();
      expect(await repository.listFolders()).toEqual([folder]);

      const renamed = await repository.renameFolder(folder.id, "Projects");
      expect(renamed.name).toBe("Projects");
      expect(await repository.listFolders()).toEqual([renamed]);

      await repository.deleteFolder(folder.id);
      expect(await repository.listFolders()).toEqual([]);
    });

    it("supports nested folders and cascades deletion to children", async () => {
      const parent = await repository.createFolder("Parent");
      const child = await repository.createFolder("Child", parent.id);
      expect(child.parentId).toBe(parent.id);
      expect(await repository.listFolders()).toHaveLength(2);

      await repository.deleteFolder(parent.id);
      expect(await repository.listFolders()).toEqual([]);
    });

    it("rejects empty folder names", async () => {
      await expect(repository.createFolder("")).rejects.toThrow(AppError);
      await expect(repository.createFolder("   ")).rejects.toThrow(AppError);
      const folder = await repository.createFolder("Valid");
      await expect(repository.renameFolder(folder.id, "")).rejects.toThrow(AppError);
    });

    it("rejects creating a folder under a nonexistent parent", async () => {
      await expect(repository.createFolder("Orphan", "nonexistent")).rejects.toThrow(AppError);
    });

    it("rejects renaming a nonexistent folder", async () => {
      await expect(repository.renameFolder("nonexistent", "Name")).rejects.toThrow(AppError);
    });
  });

  describe("moveChat", async () => {
    it("moves a chat into a folder and back to unsorted", async () => {
      const chat = await repository.createChat();
      const folder = await repository.createFolder("Work");
      expect(chat.folderId).toBeNull();

      const moved = await repository.moveChat(chat.id, folder.id);
      expect(moved.folderId).toBe(folder.id);
      expect((await repository.getChat(chat.id))?.folderId).toBe(folder.id);

      const unsorted = await repository.moveChat(chat.id, null);
      expect(unsorted.folderId).toBeNull();
    });

    it("unfiles chats when their folder is deleted (ON DELETE SET NULL)", async () => {
      const folder = await repository.createFolder("Temp");
      const chat = await repository.createChat();
      await repository.moveChat(chat.id, folder.id);
      expect((await repository.getChat(chat.id))?.folderId).toBe(folder.id);

      await repository.deleteFolder(folder.id);
      expect((await repository.getChat(chat.id))?.folderId).toBeNull();
    });

    it("rejects moving a nonexistent chat", async () => {
      await expect(repository.moveChat("nonexistent", null)).rejects.toThrow(AppError);
    });

    it("rejects moving a chat to a nonexistent folder", async () => {
      const chat = await repository.createChat();
      await expect(repository.moveChat(chat.id, "nonexistent")).rejects.toThrow(AppError);
    });
  });
});

describe("database schema (Postgres)", () => {
  it("enforces owner-aware foreign keys, completed-message immutability, and source checks at the database boundary", async () => {
    const { userId, repository } = newUser();
    const other = newUser();
    const db = testDatabase().db;
    const chat = await repository.createChat();
    const message = await repository.appendMessage({ chatId: chat.id, threadId: null, role: "assistant", content: "Answer", modelKey: "fast", complete: true });
    // A message may not point at a chat owned by someone else, even when the chat id exists.
    await expect(db.insert(messages).values({ id: "orphan-" + userId, ownerId: other.userId, chatId: chat.id, threadId: null, role: "user", content: "Orphan", modelKey: null, complete: true, attempt: 0, createdAt: 1 })).rejects.toThrow();
    await expect(db.insert(messages).values({ id: "orphan-" + userId, ownerId: userId, chatId: "missing", threadId: null, role: "user", content: "Orphan", modelKey: null, complete: true, attempt: 0, createdAt: 1 })).rejects.toThrow();
    // Completed message source is immutable even for a privileged connection.
    await expect(db.update(messages).set({ content: "Rewritten" }).where(eq(messages.id, message.id))).rejects.toThrow();
    await expect(db.update(messages).set({ complete: false }).where(eq(messages.id, message.id))).rejects.toThrow();
    expect(await repository.getMessage(message.id)).toEqual(message);
    const branch = await repository.insertThread({ parentMessageId: message.id, anchorStart: 0, anchorEnd: 6, source: "user", compressedContext: null, contextFrozenAt: null });
    await expect(db.update(threads).set({ source: "assistant" as "user" }).where(eq(threads.id, branch.id))).rejects.toThrow();
    await expect(db.update(threads).set({ anchorStart: 7 }).where(eq(threads.id, branch.id))).rejects.toThrow();
  });
});
