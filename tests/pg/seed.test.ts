import { afterEach, describe, expect, it, vi } from "vitest";
import { parseFrozenContext } from "../../lib/context";
import { ChatRepository } from "../../lib/db/repository";
import { DEMO_FOLDERS, DEMO_SEED_KEY } from "../../lib/demo-catalog";
import { ensureDemoChat, seedDatabase, seedIfNeeded } from "../../lib/seed";
import { newUser, separateInstance } from "./harness";

const catalog = DEMO_FOLDERS.flatMap((folder) => folder.chats);

afterEach(() => vi.restoreAllMocks());

/** Resolves this user's own instance of a catalog entry by its stable demo key. */
async function demo(repository: ChatRepository, key: string) {
  const chat = (await repository.listChats()).find((item) => item.demoKey === key);
  if (!chat) throw new Error(`Demo ${key} is missing for this user`);
  return chat;
}

async function demoFolder(repository: ChatRepository, key: string) {
  const folder = (await repository.listFolders()).find((item) => item.demoKey === key);
  if (!folder) throw new Error(`Demo folder ${key} is missing for this user`);
  return folder;
}

describe("reusable study library (per-user instances on Postgres)", () => {
  it("creates four folders and 27 chat summaries per user without loading any conversation bodies", async () => {
    const { repository } = newUser();
    await seedIfNeeded(repository);
    expect(await repository.demoSeedKey()).toBe(DEMO_SEED_KEY);
    const folders = await repository.listFolders();
    expect(folders.map((folder) => folder.name)).toEqual(DEMO_FOLDERS.map((folder) => folder.name));
    expect(folders.map((folder) => folder.demoKey)).toEqual(DEMO_FOLDERS.map((folder) => folder.id));
    const chats = await repository.listChats();
    expect(chats).toHaveLength(catalog.length);
    expect(new Set(chats.map((chat) => chat.demoKey))).toEqual(new Set(catalog.map((chat) => chat.id)));
    for (const folder of DEMO_FOLDERS) {
      const own = folders.find((item) => item.demoKey === folder.id)!;
      expect(chats.filter((chat) => chat.folderId === own.id)).toHaveLength(folder.chats.length);
      expect(folder.chats.length).toBeGreaterThanOrEqual(4);
    }
    for (const chat of chats) {
      expect(await repository.hasMessages(chat.id)).toBe(false);
      expect(await repository.listThreads(chat.id)).toEqual([]);
    }
  });

  it("gives each user isolated demo instances with distinct ids and never shares mutable demo state", async () => {
    const a = newUser();
    const b = newUser();
    await Promise.all([seedIfNeeded(a.repository), seedIfNeeded(b.repository)]);
    const first = await demo(a.repository, catalog[0].id);
    const second = await demo(b.repository, catalog[0].id);
    expect(first.id).not.toBe(second.id);
    await a.repository.renameChat(first.id, "Renamed by A");
    await ensureDemoChat(a.repository, first.id);
    expect((await b.repository.getChat(second.id))?.title).toBe(catalog[0].title);
    expect(await b.repository.hasMessages(second.id)).toBe(false);
    expect(await b.repository.getChat(first.id)).toBeNull();
    await expect(ensureDemoChat(b.repository, first.id)).resolves.toBeUndefined();
    expect(await b.repository.listChats()).toHaveLength(catalog.length);
  });

  it("adds demos to an existing account without changing real chats or matching folder names", async () => {
    const { repository } = newUser();
    const folder = await repository.createFolder("Linear Algebra");
    const chat = await repository.createChat(folder.id);
    const message = await repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content: "My actual notes", modelKey: null });
    await seedIfNeeded(repository);
    expect(await repository.getChat(chat.id)).toMatchObject({ title: "My actual notes", folderId: folder.id, demoKey: null });
    expect(await repository.listMessages(chat.id)).toEqual([message]);
    expect(await repository.listFolders()).toContainEqual(folder);
    expect((await repository.listFolders()).filter((item) => item.name === "Linear Algebra")).toHaveLength(2);
    expect(await repository.listChats()).toHaveLength(catalog.length + 1);
  });

  it("does not resurrect deletions on ordinary loads, but explicit restore adds only missing demos", async () => {
    const { repository } = newUser();
    await seedIfNeeded(repository);
    const chat = await demo(repository, catalog[0].id);
    await ensureDemoChat(repository, chat.id);
    await repository.deleteChat(chat.id);
    await seedIfNeeded(repository);
    expect(await repository.getChat(chat.id)).toBeNull();
    expect((await repository.listChats()).some((item) => item.demoKey === catalog[0].id)).toBe(false);
    expect(await seedDatabase(repository)).toEqual({ addedFolders: 0, addedChats: 1 });
    const restored = await demo(repository, catalog[0].id);
    expect(restored.id).not.toBe(chat.id);
    await ensureDemoChat(repository, restored.id);
    expect(restored.title).toBe(catalog[0].title);
    expect((await repository.listMessages(restored.id)).length).toBeGreaterThanOrEqual(6);
    expect(await seedDatabase(repository)).toEqual({ addedFolders: 0, addedChats: 0 });
    expect(await repository.listChats()).toHaveLength(catalog.length);
  });

  it("restores deleted folders and re-files their unsorted demo chats without moving personal chats", async () => {
    const { repository } = newUser();
    await seedIfNeeded(repository);
    const folder = await demoFolder(repository, DEMO_FOLDERS[0].id);
    const personal = await repository.createChat(folder.id);
    await repository.deleteFolder(folder.id);
    expect((await demo(repository, DEMO_FOLDERS[0].chats[0].id)).folderId).toBeNull();
    expect(await seedDatabase(repository)).toEqual({ addedFolders: 1, addedChats: 0 });
    const restored = await demoFolder(repository, DEMO_FOLDERS[0].id);
    expect((await demo(repository, DEMO_FOLDERS[0].chats[0].id)).folderId).toBe(restored.id);
    expect((await repository.getChat(personal.id))?.folderId).toBeNull();
  });

  it("preserves custom names, moves, added messages, resolutions, and deleted threads when restored", async () => {
    const { repository } = newUser();
    await seedIfNeeded(repository);
    const chat = await demo(repository, catalog[0].id);
    await ensureDemoChat(repository, chat.id);
    const destination = await repository.createFolder("My revision");
    await repository.renameChat(chat.id, "My edited study plan");
    await repository.moveChat(chat.id, destination.id);
    const folder = await demoFolder(repository, DEMO_FOLDERS[0].id);
    await repository.renameFolder(folder.id, "My algebra");
    const threads = await repository.listThreads(chat.id);
    await repository.deleteThread(threads[0].id);
    await repository.updateThread(threads[1].id, { resolved: !threads[1].resolved });
    await repository.appendMessage({ chatId: chat.id, threadId: null, role: "user", content: "My own follow-up", modelKey: null });
    const snapshot = async () => ({ chat: await repository.getChat(chat.id), messages: await repository.listMessages(chat.id), threads: await repository.listThreads(chat.id) });
    const before = await snapshot();
    expect(await seedDatabase(repository)).toEqual({ addedFolders: 0, addedChats: 0 });
    await ensureDemoChat(repository, chat.id);
    expect(await snapshot()).toEqual(before);
    expect((await repository.listFolders()).find((item) => item.id === folder.id)?.name).toBe("My algebra");
  });

  it("hydrates just the requested conversation once, including concurrent opens from independent instances", async () => {
    const user = newUser();
    await seedIfNeeded(user.repository);
    const otherRepository = new ChatRepository(separateInstance(), user.userId);
    const chat = await demo(user.repository, catalog[0].id);
    await Promise.all([ensureDemoChat(user.repository, chat.id), ensureDemoChat(otherRepository, chat.id), ensureDemoChat(user.repository, chat.id)]);
    const before = await user.repository.listMessages(chat.id);
    await ensureDemoChat(user.repository, chat.id);
    expect(await user.repository.listMessages(chat.id)).toEqual(before);
    expect(before).toHaveLength(6);
    const second = await demo(user.repository, catalog[1].id);
    expect(await user.repository.listMessages(second.id)).toEqual([]);
    await ensureDemoChat(user.repository, "not-a-demo");
    await user.repository.deleteChat(second.id);
    await ensureDemoChat(user.repository, second.id);
    expect(await user.repository.getChat(second.id)).toBeNull();
  });

  it("keeps demo history backdated even when newer real messages already exist", async () => {
    const { repository } = newUser();
    const personal = await repository.createChat();
    const message = await repository.appendMessage({ chatId: personal.id, threadId: null, role: "user", content: "Current work", modelKey: null, createdAt: Date.UTC(2026, 9, 1) });
    await seedIfNeeded(repository);
    const chat = await demo(repository, catalog[0].id);
    await ensureDemoChat(repository, chat.id);
    const main = await repository.listMessages(chat.id);
    expect(main[0].createdAt).toBe(catalog[0].createdAt + 60_000);
    expect(main.at(-1)!.createdAt).toBeLessThan(message.createdAt);
    expect(await repository.getMessage(message.id)).toEqual(message);
  });

  it("rolls back partial hydration instead of leaving an incomplete demo", async () => {
    const { repository } = newUser();
    await seedIfNeeded(repository);
    const chat = await demo(repository, catalog[0].id);
    const original = repository.hydrateDemoChat.bind(repository);
    const spy = vi.spyOn(repository, "hydrateDemoChat").mockImplementation((chatId, plan) =>
      original(chatId, () => {
        const built = plan();
        // Corrupt the last thread so the bulk insert fails after messages were written in the same transaction.
        built.threads[built.threads.length - 1] = { ...built.threads[built.threads.length - 1], anchorEnd: -1 };
        return built;
      }),
    );
    await expect(ensureDemoChat(repository, chat.id)).rejects.toThrow();
    expect(await repository.listMessages(chat.id)).toEqual([]);
    expect(await repository.listThreads(chat.id)).toEqual([]);
    spy.mockRestore();
    await ensureDemoChat(repository, chat.id);
    expect(await repository.listMessages(chat.id)).toHaveLength(6);
  });

  it.each(catalog)("provides substantial, correctly anchored study history: $title", async (entry) => {
    const { repository } = newUser();
    await seedIfNeeded(repository);
    const chat = await demo(repository, entry.id);
    await ensureDemoChat(repository, chat.id);
    const main = await repository.listMessages(chat.id);
    const threads = await repository.listThreads(chat.id);
    expect(main.length).toBeGreaterThanOrEqual(6);
    expect(main.map((message) => message.role)).toEqual(main.map((_, index) => index % 2 ? "assistant" : "user"));
    expect(main.every((message) => message.complete && message.threadId === null && message.modelKey === null)).toBe(true);
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
      const replies = await repository.listMessages(chat.id, thread.id);
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
