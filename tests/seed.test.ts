import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../lib/db/repository";
import { DEMO_FOLDERS, DEMO_SEED_KEY } from "../lib/demo-catalog";
import { parseFrozenContext } from "../lib/context";
import { ensureDemoChat, seedDatabase } from "../lib/seed";

const repositories: ChatRepository[] = [];
function fresh() {
  const repository = new ChatRepository(":memory:");
  repositories.push(repository);
  return repository;
}

function initialize(repository: ChatRepository) {
  repository.seedOnce(seedDatabase, DEMO_SEED_KEY);
}

const catalog = DEMO_FOLDERS.flatMap((folder) => folder.chats);

afterEach(() => {
  repositories.splice(0).forEach((repository) => repository.close());
  vi.restoreAllMocks();
});

describe("reusable study library", () => {
  it("creates four folders and 27 chat summaries without loading any conversation bodies", () => {
    const repository = fresh();
    initialize(repository);
    expect(repository.listFolders().map((folder) => folder.name)).toEqual(DEMO_FOLDERS.map((folder) => folder.name));
    expect(repository.listChats()).toHaveLength(catalog.length);
    for (const folder of DEMO_FOLDERS) {
      expect(repository.listChats().filter((chat) => chat.folderId === folder.id)).toHaveLength(folder.chats.length);
      expect(folder.chats.length).toBeGreaterThanOrEqual(4);
    }
    for (const chat of repository.listChats()) {
      expect(repository.listMessages(chat.id)).toEqual([]);
      expect(repository.listThreads(chat.id)).toEqual([]);
    }
  });

  it("adds demos to an existing installation without changing real chats or matching folder names", () => {
    const repository = fresh();
    const folder = repository.createFolder("Linear Algebra");
    const chat = repository.createChat(folder.id);
    const message = repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content: "My actual notes", modelKey: null });
    repository.seedOnce(() => {});
    initialize(repository);
    expect(repository.getChat(chat.id)).toMatchObject({ title: "My actual notes", folderId: folder.id });
    expect(repository.listMessages(chat.id)).toEqual([message]);
    expect(repository.listFolders()).toContainEqual(folder);
    expect(repository.listChats()).toHaveLength(catalog.length + 1);
  });

  it("does not resurrect deletions on every startup, but explicit restore adds missing demos", async () => {
    const repository = fresh();
    initialize(repository);
    const chat = catalog[0];
    await ensureDemoChat(repository, chat.id);
    repository.deleteChat(chat.id);
    initialize(repository);
    expect(repository.getChat(chat.id)).toBeNull();
    seedDatabase(repository);
    await ensureDemoChat(repository, chat.id);
    expect(repository.getChat(chat.id)?.title).toBe(chat.title);
    expect(repository.listMessages(chat.id).length).toBeGreaterThanOrEqual(6);
    seedDatabase(repository);
    expect(repository.listChats()).toHaveLength(catalog.length);
  });

  it("restores deleted folders and their unsorted demo chats without moving personal chats", () => {
    const repository = fresh();
    initialize(repository);
    const folder = DEMO_FOLDERS[0];
    const personal = repository.createChat(folder.id);
    repository.deleteFolder(folder.id);
    seedDatabase(repository);
    expect(repository.getChat(folder.chats[0].id)?.folderId).toBe(folder.id);
    expect(repository.getChat(personal.id)?.folderId).toBeNull();
  });

  it("preserves custom names, moves, added messages, resolutions, and deleted threads when restored", async () => {
    const repository = fresh();
    initialize(repository);
    const chat = catalog[0];
    await ensureDemoChat(repository, chat.id);
    const destination = repository.createFolder("My revision");
    repository.renameChat(chat.id, "My edited study plan");
    repository.moveChat(chat.id, destination.id);
    repository.renameFolder(DEMO_FOLDERS[0].id, "My algebra");
    const threads = repository.listThreads(chat.id);
    repository.deleteThread(threads[0].id);
    repository.updateThread(threads[1].id, { resolved: !threads[1].resolved });
    repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content: "My own follow-up", modelKey: null });
    const before = { chat: repository.getChat(chat.id), messages: repository.listMessages(chat.id), threads: repository.listThreads(chat.id) };
    seedDatabase(repository);
    await ensureDemoChat(repository, chat.id);
    expect({ chat: repository.getChat(chat.id), messages: repository.listMessages(chat.id), threads: repository.listThreads(chat.id) }).toEqual(before);
    expect(repository.listFolders().find((folder) => folder.id === DEMO_FOLDERS[0].id)?.name).toBe("My algebra");
  });

  it("hydrates just the requested conversation once, including concurrent opens", async () => {
    const repository = fresh();
    initialize(repository);
    const chat = catalog[0];
    await Promise.all([ensureDemoChat(repository, chat.id), ensureDemoChat(repository, chat.id)]);
    const before = repository.listMessages(chat.id);
    await ensureDemoChat(repository, chat.id);
    expect(repository.listMessages(chat.id)).toEqual(before);
    expect(before).toHaveLength(6);
    expect(repository.listMessages(catalog[1].id)).toEqual([]);
    await ensureDemoChat(repository, "not-a-demo");
    repository.deleteChat(catalog[1].id);
    await ensureDemoChat(repository, catalog[1].id);
    expect(repository.getChat(catalog[1].id)).toBeNull();
  });

  it("keeps demo history backdated even when newer real messages already exist", async () => {
    const repository = fresh();
    const personal = repository.createChat();
    const message = repository.appendMessage({ chatId: personal.id, threadId: null, role: "user", content: "Current work", modelKey: null, createdAt: Date.UTC(2026, 9, 1) });
    initialize(repository);
    await ensureDemoChat(repository, catalog[0].id);
    const main = repository.listMessages(catalog[0].id);
    expect(main[0].createdAt).toBe(catalog[0].createdAt + 60_000);
    expect(main.at(-1)!.createdAt).toBeLessThan(message.createdAt);
    expect(repository.getMessage(message.id)).toEqual(message);
  });

  it("rolls back interrupted catalog setup and allows a clean retry", () => {
    const repository = fresh();
    expect(() => repository.seedOnce((db) => { seedDatabase(db); throw new Error("Interrupted"); }, DEMO_SEED_KEY)).toThrow("Interrupted");
    expect(repository.listChats()).toEqual([]);
    expect(repository.listFolders()).toEqual([]);
    initialize(repository);
    expect(repository.listChats()).toHaveLength(catalog.length);
  });

  it("rolls back partial hydration instead of leaving an incomplete demo", async () => {
    const repository = fresh();
    initialize(repository);
    const original = repository.appendMessage.bind(repository);
    let calls = 0;
    const append = vi.spyOn(repository, "appendMessage").mockImplementation((input, options) => {
      if (++calls === 3) throw new Error("Interrupted");
      return original(input, options);
    });
    await expect(ensureDemoChat(repository, catalog[0].id)).rejects.toThrow("Interrupted");
    expect(repository.listMessages(catalog[0].id)).toEqual([]);
    expect(repository.listThreads(catalog[0].id)).toEqual([]);
    append.mockRestore();
    await ensureDemoChat(repository, catalog[0].id);
    expect(repository.listMessages(catalog[0].id)).toHaveLength(6);
  });

  it.each(catalog)("provides substantial, correctly anchored study history: $title", async (chat) => {
    const repository = fresh();
    initialize(repository);
    await ensureDemoChat(repository, chat.id);
    const main = repository.listMessages(chat.id);
    const threads = repository.listThreads(chat.id);
    expect(main.length).toBeGreaterThanOrEqual(6);
    expect(main.map((message) => message.role)).toEqual(main.map((_, index) => index % 2 ? "assistant" : "user"));
    expect(main.every((message) => message.complete && message.threadId === null)).toBe(true);
    expect(main.filter((message) => message.role === "assistant").every((message) => message.content.length > 450)).toBe(true);
    expect(threads.length).toBeGreaterThanOrEqual(3);
    expect(threads.some((thread) => thread.resolved)).toBe(true);
    expect(threads.some((thread) => !thread.resolved)).toBe(true);
    for (const thread of threads) {
      const parent = main.find((message) => message.id === thread.parentMessageId)!;
      expect(thread.anchorValid).toBe(true);
      expect(parent.content.slice(thread.anchorStart, thread.anchorEnd)).toBe(thread.anchorExact);
      expect(thread.anchorExact).not.toMatch(/[`$\n]/);
      const context = parseFrozenContext(thread.compressedContext);
      expect(context?.kind).toBe("compressed");
      if (context?.kind === "compressed") expect(context.briefing.decisions).toHaveLength(Math.floor(main.indexOf(parent) / 2));
      expect(thread.contextFrozenAt).toBe(parent.createdAt);
      const replies = repository.listMessages(chat.id, thread.id);
      expect(replies.length).toBeGreaterThanOrEqual(4);
      expect(replies.every((message) => message.complete && message.threadId === thread.id && message.chatId === chat.id)).toBe(true);
      expect(replies.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(replies.every((message) => message.inputTokens === null && message.outputTokens === null)).toBe(true);
      expect(main.some((message) => replies.some((reply) => reply.id === message.id))).toBe(false);
      for (const other of threads.filter((other) => other.parentMessageId === parent.id && other.id !== thread.id)) {
        expect(thread.anchorEnd <= other.anchorStart || other.anchorEnd <= thread.anchorStart).toBe(true);
      }
    }
  });
});
