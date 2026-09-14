import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, isNull, lt, max, sql } from "drizzle-orm";
import { alias, type PgColumn } from "drizzle-orm/pg-core";
import { validateAnchor } from "../anchors";
import { AppError } from "../errors";
import { isModelKey } from "../models";
import type { Chat, Folder, Message, SearchResult, Thread } from "../types";
import type { DatabaseHandle } from "./client";
import { chats, folders, messages, threads, userState } from "./schema";
import { withUser, type Tx } from "./session";

export type AppendMessageInput = Pick<Message, "chatId" | "threadId" | "role" | "content" | "modelKey">
  & Partial<Pick<Message, "complete" | "createdAt">>;
export type FinishMessageInput = Pick<Message, "content" | "complete">
  & Partial<Pick<Message, "inputTokens" | "outputTokens">>;
export type InsertThreadInput = Pick<Thread, "parentMessageId" | "anchorStart" | "anchorEnd" | "source" | "compressedContext" | "contextFrozenAt">
  & Partial<Pick<Thread, "title" | "createdAt">>;
export type UpdateThreadInput = Partial<Pick<Thread, "resolved" | "title" | "compressedContext" | "contextFrozenAt">>;

export interface DemoCatalogFolder {
  key: string;
  name: string;
  chats: { key: string; title: string; createdAt: number }[];
}

export interface DemoMessagePlan {
  id: string;
  threadId: string | null;
  role: Message["role"];
  content: string;
  createdAt: number;
}

export interface DemoThreadPlan {
  id: string;
  parentMessageId: string;
  anchorStart: number;
  anchorEnd: number;
  anchorExact: string;
  compressedContext: string;
  contextFrozenAt: number;
  title: string;
  resolved: boolean;
  createdAt: number;
}

export interface DemoHydrationPlan {
  messages: DemoMessagePlan[];
  threads: DemoThreadPlan[];
}

type MessageRow = typeof messages.$inferSelect;
type ThreadRow = { thread: typeof threads.$inferSelect; parentContent: string | null; messageCount: number };
type OrderedTable = typeof chats | typeof messages | typeof threads;

const parentMessages = alias(messages, "parent_messages");
const threadMessages = alias(messages, "thread_messages");

function validateInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new AppError(`${field} must be a nonnegative integer.`);
}

function validateContext(input: UpdateThreadInput) {
  if (input.compressedContext !== undefined && input.compressedContext !== null) {
    if (typeof input.compressedContext !== "string") throw new AppError("Compressed context must be a JSON string or null.");
    try {
      JSON.parse(input.compressedContext);
    } catch {
      throw new AppError("Compressed context must contain valid JSON.");
    }
  }
  if (input.contextFrozenAt !== undefined && input.contextFrozenAt !== null) validateInteger(input.contextFrozenAt, "Context freeze time");
}

export function toFolder(row: typeof folders.$inferSelect): Folder {
  return { id: row.id, name: row.name, parentId: row.parentId, createdAt: row.createdAt, sortOrder: row.sortOrder, demoKey: row.demoKey };
}

export function toChat(row: typeof chats.$inferSelect): Chat {
  return { id: row.id, title: row.title, folderId: row.folderId, createdAt: row.createdAt, demoKey: row.demoKey };
}

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id, chatId: row.chatId, threadId: row.threadId, role: row.role, content: row.content, modelKey: row.modelKey,
    complete: row.complete, inputTokens: row.inputTokens, outputTokens: row.outputTokens, createdAt: row.createdAt,
  };
}

function enrichThread(row: ThreadRow): Thread {
  const { ownerId: _ownerId, ...thread } = row.thread;
  void _ownerId;
  return { ...thread, anchorValid: validateAnchor(row.parentContent ?? "", thread), messageCount: row.messageCount };
}

function excerpt(content: string, query: string): string {
  const fold = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const firstMatch = Math.max(0, fold(content).indexOf(fold(query)));
  const width = Math.max(120, query.length);
  let start = Math.max(0, firstMatch - Math.floor((width - query.length) / 2));
  const end = Math.min(content.length, start + width);
  start = Math.max(0, end - width);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

/**
 * Owner-scoped data access. Every method is one short transaction executed as the RLS-enforced
 * runtime role for `userId`; the owner filter is also applied explicitly in each query.
 */
export class ChatRepository {
  constructor(private readonly handle: DatabaseHandle, readonly userId: string, private readonly guest = false) {}

  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withUser(this.handle, this.userId, fn, this.guest);
  }

  private owned(table: { ownerId: PgColumn }) {
    return eq(table.ownerId, this.userId);
  }

  async listFolders(tx?: Tx): Promise<Folder[]> {
    const query = (db: Tx) => db.select().from(folders).where(this.owned(folders))
      .orderBy(asc(folders.parentId), asc(folders.sortOrder), asc(folders.createdAt), asc(folders.id));
    const rows = tx ? await query(tx) : await this.run(query);
    return rows.map(toFolder);
  }

  async createFolder(name: string, parentId: string | null = null): Promise<Folder> {
    if (typeof name !== "string" || name.trim().length === 0) throw new AppError("Folder name must not be empty.");
    return this.run(async (tx) => {
      if (parentId !== null && !(await this.folderExists(tx, parentId))) throw new AppError("Parent folder not found.", 404, "folder_not_found");
      const [row] = await tx.insert(folders).values({
        id: randomUUID(), ownerId: this.userId, name: name.trim(), parentId, createdAt: Date.now(), sortOrder: 0,
      }).returning();
      return toFolder(row);
    });
  }

  async renameFolder(id: string, name: string): Promise<Folder> {
    if (typeof name !== "string" || name.trim().length === 0) throw new AppError("Folder name must not be empty.");
    return this.run(async (tx) => {
      const [row] = await tx.update(folders).set({ name: name.trim() }).where(and(eq(folders.id, id), this.owned(folders))).returning();
      if (!row) throw new AppError("Folder not found.", 404, "folder_not_found");
      return toFolder(row);
    });
  }

  async moveFolder(id: string, parentId: string | null): Promise<Folder> {
    if (parentId === id) throw new AppError("A folder cannot be moved into itself.");
    return this.run(async (tx) => {
      // Serialize structural folder changes per owner so concurrent moves cannot create a cycle.
      await this.lock(tx, "folders");
      if (!(await this.folderExists(tx, id))) throw new AppError("Folder not found.", 404, "folder_not_found");
      if (parentId !== null) {
        let current = await this.folderRow(tx, parentId);
        if (!current) throw new AppError("Parent folder not found.", 404, "folder_not_found");
        while (current) {
          if (current.id === id) throw new AppError("A folder cannot be moved into one of its children.");
          current = current.parentId ? await this.folderRow(tx, current.parentId) : undefined;
        }
      }
      const [row] = await tx.update(folders).set({ parentId }).where(and(eq(folders.id, id), this.owned(folders))).returning();
      return toFolder(row);
    });
  }

  async deleteFolder(id: string): Promise<void> {
    return this.run(async (tx) => {
      await this.lock(tx, "folders");
      await tx.delete(folders).where(and(eq(folders.id, id), this.owned(folders)));
    });
  }

  async renameChat(chatId: string, title: string): Promise<Chat> {
    if (typeof title !== "string" || !title.trim()) throw new AppError("Title must not be empty.");
    return this.run(async (tx) => {
      const [row] = await tx.update(chats).set({ title: title.trim() }).where(and(eq(chats.id, chatId), this.owned(chats))).returning();
      if (!row) throw new AppError("Chat not found.", 404, "chat_not_found");
      return toChat(row);
    });
  }

  async moveChat(chatId: string, folderId: string | null): Promise<Chat> {
    return this.run(async (tx) => {
      if (folderId !== null && !(await this.folderExists(tx, folderId))) throw new AppError("Folder not found.", 404, "folder_not_found");
      const [row] = await tx.update(chats).set({ folderId }).where(and(eq(chats.id, chatId), this.owned(chats))).returning();
      if (!row) throw new AppError("Chat not found.", 404, "chat_not_found");
      return toChat(row);
    });
  }

  async listChats(tx?: Tx): Promise<Chat[]> {
    const query = (db: Tx) => db.select().from(chats).where(this.owned(chats)).orderBy(desc(chats.createdAt), desc(chats.id));
    const rows = tx ? await query(tx) : await this.run(query);
    return rows.map(toChat);
  }

  /** Library and current-chat contents in one round trip. */
  async library(chatId?: string | null): Promise<{ chats: Chat[]; folders: Folder[]; current: { chat: Chat; messages: Message[]; threads: Thread[] } | null }> {
    return this.run(async (tx) => {
      const [chatList, folderList] = await Promise.all([this.listChats(tx), this.listFolders(tx)]);
      const chat = chatId === null ? undefined : chatList.find((item) => item.id === chatId) ?? chatList[0];
      if (!chat) return { chats: chatList, folders: folderList, current: null };
      const [messageList, threadList] = await Promise.all([this.listMessages(chat.id, null, tx), this.listThreads(chat.id, tx)]);
      return { chats: chatList, folders: folderList, current: { chat, messages: messageList, threads: threadList } };
    });
  }

  async getChat(id: string, tx?: Tx): Promise<Chat | null> {
    const query = async (db: Tx) => (await db.select().from(chats).where(and(eq(chats.id, id), this.owned(chats))))[0];
    const row = tx ? await query(tx) : await this.run(query);
    return row ? toChat(row) : null;
  }

  async createChat(folderId: string | null = null): Promise<Chat> {
    return this.run(async (tx) => {
      if (folderId !== null && !(await this.folderExists(tx, folderId))) throw new AppError("Folder not found.", 404, "folder_not_found");
      const [row] = await tx.insert(chats).values({
        id: randomUUID(), ownerId: this.userId, title: "New chat", folderId, createdAt: await this.nextCreatedAt(tx, chats),
      }).returning();
      return toChat(row);
    });
  }

  async deleteChat(id: string): Promise<boolean> {
    return this.run(async (tx) => {
      const deleted = await tx.delete(chats).where(and(eq(chats.id, id), this.owned(chats))).returning({ id: chats.id });
      return deleted.length > 0;
    });
  }

  async getMessage(id: string, tx?: Tx): Promise<Message | null> {
    const row = tx ? await this.messageRow(tx, id) : await this.run((db) => this.messageRow(db, id));
    return row ? toMessage(row) : null;
  }

  async listMessages(chatId: string, threadId: string | null = null, tx?: Tx): Promise<Message[]> {
    const query = async (db: Tx) => {
      if (threadId !== null) await this.requireThreadScope(db, chatId, threadId);
      return db.select().from(messages).where(and(
        this.owned(messages),
        eq(messages.chatId, chatId),
        threadId === null ? isNull(messages.threadId) : eq(messages.threadId, threadId),
      )).orderBy(asc(messages.createdAt), asc(messages.id));
    };
    const rows = tx ? await query(tx) : await this.run(query);
    return rows.map(toMessage);
  }

  async hasMessages(chatId: string, tx?: Tx): Promise<boolean> {
    const query = async (db: Tx) => (await db.select({ id: messages.id }).from(messages)
      .where(and(this.owned(messages), eq(messages.chatId, chatId))).limit(1)).length > 0;
    return tx ? query(tx) : this.run(query);
  }

  async appendMessage(input: AppendMessageInput, options: { preserveTimestamp?: boolean } = {}): Promise<Message> {
    return this.run((tx) => this.insertMessage(tx, input, options.preserveTimestamp));
  }

  /**
   * Fenced partial write: only touches the incomplete assistant message when it is still the same
   * attempt, so a late checkpoint from a superseded worker can never overwrite newer content.
   * Returns null when the message is gone, completed, or was retried by a newer attempt.
   */
  async checkpointMessage(id: string, content: string, attempt: number): Promise<Message | null> {
    if (typeof content !== "string") throw new AppError("Message content must be text.");
    return this.run(async (tx) => {
      const [row] = await tx.update(messages).set({ content }).where(and(
        eq(messages.id, id), this.owned(messages), eq(messages.role, "assistant"), eq(messages.complete, false), eq(messages.attempt, attempt),
      )).returning();
      return row ? toMessage(row) : null;
    });
  }

  async updatePartialMessage(id: string, content: string): Promise<Message> {
    if (typeof content !== "string") throw new AppError("Message content must be text.");
    return this.run(async (tx) => {
      const message = await this.requireMessage(tx, id);
      if (message.role !== "assistant" || message.complete) {
        throw new AppError("Only incomplete assistant messages can be updated.", 409, "message_immutable");
      }
      const [row] = await tx.update(messages).set({ content }).where(and(eq(messages.id, id), this.owned(messages))).returning();
      return toMessage(row);
    });
  }

  /** Resets an incomplete assistant message for a new attempt and returns the new attempt number. */
  async beginRetry(id: string): Promise<{ message: Message; attempt: number }> {
    return this.run(async (tx) => {
      const message = await this.requireMessage(tx, id);
      if (message.role !== "assistant" || message.complete) {
        throw new AppError("Only incomplete assistant messages can be retried.", 409, "message_immutable");
      }
      const [row] = await tx.update(messages).set({ content: "", inputTokens: null, outputTokens: null, attempt: sql`${messages.attempt} + 1` })
        .where(and(eq(messages.id, id), this.owned(messages), eq(messages.complete, false), eq(messages.attempt, message.attempt))).returning();
      if (!row) throw new AppError("This message changed while retrying. Please try again.", 409, "conflict");
      return { message: toMessage(row), attempt: row.attempt };
    });
  }

  async finishMessage(id: string, input: FinishMessageInput, options: { attempt?: number } = {}): Promise<Message> {
    if (typeof input.content !== "string" || typeof input.complete !== "boolean") {
      throw new AppError("Message content and completion state are required.");
    }
    if (input.inputTokens !== undefined && input.inputTokens !== null) validateInteger(input.inputTokens, "Input tokens");
    if (input.outputTokens !== undefined && input.outputTokens !== null) validateInteger(input.outputTokens, "Output tokens");
    return this.run(async (tx) => {
      const message = await this.requireMessage(tx, id);
      if (message.role !== "assistant") throw new AppError("Only assistant messages can be finished.", 409, "message_immutable");
      if (options.attempt !== undefined && message.attempt !== options.attempt) {
        throw new AppError("This message was retried by a newer request.", 409, "stale_generation");
      }
      if (message.complete) {
        if (input.content !== message.content || !input.complete) {
          throw new AppError("Completed message content cannot be changed.", 409, "message_immutable");
        }
        return toMessage(message);
      }
      const [row] = await tx.update(messages).set({
        content: input.content,
        complete: input.complete,
        inputTokens: input.inputTokens === undefined ? message.inputTokens : input.inputTokens,
        outputTokens: input.outputTokens === undefined ? message.outputTokens : input.outputTokens,
      }).where(and(eq(messages.id, id), this.owned(messages), eq(messages.complete, false), eq(messages.attempt, message.attempt))).returning();
      if (!row) throw new AppError("This message was retried by a newer request.", 409, "stale_generation");
      return toMessage(row);
    });
  }

  async getMessageAttempt(id: string): Promise<number | null> {
    return this.run(async (tx) => (await this.messageRow(tx, id))?.attempt ?? null);
  }

  async getThread(id: string, tx?: Tx): Promise<Thread | null> {
    return tx ? this.readThread(tx, id) : this.run((db) => this.readThread(db, id));
  }

  async listThreads(chatId: string, tx?: Tx): Promise<Thread[]> {
    const query = (db: Tx) => this.threadQuery(db).where(and(eq(threads.chatId, chatId), this.owned(threads)))
      .orderBy(asc(threads.createdAt), asc(threads.id));
    const rows = tx ? await query(tx) : await this.run(query);
    return rows.map(enrichThread);
  }

  async insertThread(input: InsertThreadInput): Promise<Thread> {
    return this.run(async (tx) => {
      // Lock the parent row so overlapping-anchor checks and the insert are atomic per parent.
      const parent = await this.requireMessage(tx, input.parentMessageId, true);
      if (parent.role !== "assistant" || !parent.complete || parent.threadId !== null) {
        throw new AppError("Threads require a completed assistant message in the main conversation.", 400, "invalid_parent");
      }
      if (input.source !== "user") throw new AppError("Only user-created threads are supported.", 400, "invalid_source");
      const { anchorStart, anchorEnd } = input;
      if (!Number.isInteger(anchorStart) || !Number.isInteger(anchorEnd)
        || anchorStart < 0 || anchorEnd <= anchorStart || anchorEnd > parent.content.length) {
        throw new AppError("Select a nonempty range within the parent message.", 400, "invalid_anchor");
      }
      validateContext(input);
      const overlapping = await tx.select({ id: threads.id }).from(threads).where(and(
        this.owned(threads), eq(threads.parentMessageId, parent.id), lt(threads.anchorStart, anchorEnd), gt(threads.anchorEnd, anchorStart),
      )).limit(1);
      if (overlapping.length) throw new AppError("This selection overlaps an existing thread anchor.", 409, "anchor_overlap");
      const anchorExact = parent.content.slice(anchorStart, anchorEnd);
      if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim())) throw new AppError("Thread title must not be empty.");
      const [inserted] = await tx.insert(threads).values({
        id: randomUUID(), ownerId: this.userId, chatId: parent.chatId, parentMessageId: parent.id, anchorStart, anchorEnd, anchorExact,
        compressedContext: input.compressedContext, contextFrozenAt: input.contextFrozenAt, source: "user", resolved: false,
        title: input.title?.trim() ?? anchorExact.slice(0, 60), createdAt: await this.nextCreatedAt(tx, threads, input.createdAt, true),
      }).returning();
      const { ownerId: _ownerId, ...thread } = inserted;
      void _ownerId;
      return { ...thread, anchorValid: true, messageCount: 0 };
    });
  }

  async updateThread(id: string, input: UpdateThreadInput, options: { expectContextFrozenAt?: number | null } = {}): Promise<Thread> {
    validateContext(input);
    if (input.resolved !== undefined && typeof input.resolved !== "boolean") throw new AppError("Thread resolution must be a boolean.");
    if (input.title !== undefined && (typeof input.title !== "string" || !input.title.trim())) throw new AppError("Thread title must not be empty.");
    return this.run(async (tx) => {
      const current = await this.readThread(tx, id);
      if (!current) throw new AppError("Thread not found.", 404, "thread_not_found");
      if (options.expectContextFrozenAt !== undefined && current.contextFrozenAt !== options.expectContextFrozenAt) return current;
      const changes: UpdateThreadInput = {};
      if (input.resolved !== undefined) changes.resolved = input.resolved;
      if (input.title !== undefined) changes.title = input.title.trim();
      if (input.compressedContext !== undefined) changes.compressedContext = input.compressedContext;
      if (input.contextFrozenAt !== undefined) changes.contextFrozenAt = input.contextFrozenAt;
      if (Object.keys(changes).length === 0) return current;
      await tx.update(threads).set(changes).where(and(eq(threads.id, id), this.owned(threads)));
      return { ...current, ...changes };
    });
  }

  async deleteThread(id: string): Promise<boolean> {
    return this.run(async (tx) => {
      const deleted = await tx.delete(threads).where(and(eq(threads.id, id), this.owned(threads))).returning({ id: threads.id });
      return deleted.length > 0;
    });
  }

  async searchMessages(chatId: string, query: string): Promise<SearchResult[]> {
    if (typeof query !== "string") throw new AppError("Search text must be a string.");
    if (query.trim().length === 0) return Promise.resolve([]);
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    return this.run(async (tx) => {
      const matches = await tx.select({
        id: messages.id, threadId: messages.threadId, threadTitle: threads.title, role: messages.role, content: messages.content,
      }).from(messages).leftJoin(threads, and(eq(messages.threadId, threads.id), eq(messages.chatId, threads.chatId)))
        .where(and(this.owned(messages), eq(messages.chatId, chatId), sql`${messages.content} ILIKE ${pattern} ESCAPE '\\'`))
        .orderBy(asc(messages.createdAt), asc(messages.id)).limit(200);
      return matches.map(({ content, ...match }) => ({ ...match, excerpt: excerpt(content, query) }));
    });
  }

  async copyMessageToMain(messageId: string): Promise<Message> {
    return this.run(async (tx) => {
      const message = await this.requireMessage(tx, messageId);
      if (message.threadId === null) throw new AppError("Only thread messages can be copied to main.", 400, "invalid_scope");
      await this.requireThreadScope(tx, message.chatId, message.threadId);
      return this.insertMessage(tx, {
        chatId: message.chatId, threadId: null, role: message.role, content: message.content, modelKey: message.modelKey, complete: true,
      });
    });
  }

  /**
   * Creates any folders/chats from the catalog that this user does not have yet, keyed by stable
   * demo keys. Existing items (renamed, moved, deleted threads, follow-ups) are left untouched.
   * Safe to run concurrently from independent instances.
   */
  async restoreDemoCatalog(catalog: readonly DemoCatalogFolder[], seedKey: string): Promise<{ addedFolders: number; addedChats: number }> {
    return this.run(async (tx) => {
      await this.lock(tx, "demo");
      let addedFolders = 0;
      let addedChats = 0;
      const owned = await tx.select({ id: folders.id, demoKey: folders.demoKey }).from(folders).where(and(this.owned(folders), sql`${folders.demoKey} is not null`));
      const folderIds = new Map(owned.map((row) => [row.demoKey!, row.id]));
      const newFolders = catalog.map((folder, sortOrder) => ({ folder, sortOrder })).filter(({ folder }) => !folderIds.has(folder.key))
        .map(({ folder, sortOrder }) => ({ id: randomUUID(), ownerId: this.userId, name: folder.name, parentId: null, sortOrder, createdAt: folder.chats[0].createdAt, demoKey: folder.key }));
      if (newFolders.length) {
        const inserted = await tx.insert(folders).values(newFolders).onConflictDoNothing().returning({ id: folders.id, demoKey: folders.demoKey });
        addedFolders = inserted.length;
        for (const row of inserted) folderIds.set(row.demoKey!, row.id);
      }
      const existingChats = new Set((await tx.select({ demoKey: chats.demoKey }).from(chats).where(and(this.owned(chats), sql`${chats.demoKey} is not null`))).map((row) => row.demoKey!));
      const newChats = catalog.flatMap((folder) => folder.chats.filter((chat) => !existingChats.has(chat.key)).map((chat) => ({
        id: randomUUID(), ownerId: this.userId, title: chat.title, folderId: folderIds.get(folder.key) ?? null, createdAt: chat.createdAt, demoKey: chat.key,
      })));
      if (newChats.length) addedChats = (await tx.insert(chats).values(newChats).onConflictDoNothing().returning({ id: chats.id })).length;
      const restoredFolders = new Set(newFolders.map((folder) => folder.demoKey));
      for (const folder of catalog) {
        if (!restoredFolders.has(folder.key)) continue;
        const keys = folder.chats.map((chat) => chat.key);
        if (keys.length) {
          await tx.update(chats).set({ folderId: folderIds.get(folder.key)! })
            .where(and(this.owned(chats), isNull(chats.folderId), sql`${chats.demoKey} in ${keys}`));
        }
      }
      await tx.insert(userState).values({ ownerId: this.userId, demoSeedKey: seedKey, createdAt: Date.now() })
        .onConflictDoUpdate({ target: userState.ownerId, set: { demoSeedKey: seedKey } });
      return { addedFolders, addedChats };
    });
  }

  async demoSeedKey(): Promise<string | null> {
    return this.run(async (tx) => (await tx.select({ key: userState.demoSeedKey }).from(userState).where(eq(userState.ownerId, this.userId)))[0]?.key ?? null);
  }

  /**
   * Bulk-writes a prepared fixture graph for an empty demo chat in one short transaction.
   * The chat row is locked so concurrent hydration on other instances is idempotent.
   */
  async hydrateDemoChat(chatId: string, plan: () => DemoHydrationPlan): Promise<boolean> {
    return this.run(async (tx) => {
      const [chat] = await tx.select().from(chats).where(and(eq(chats.id, chatId), this.owned(chats))).for("update");
      if (!chat || (await this.hasMessages(chatId, tx))) return false;
      const { messages: planned, threads: plannedThreads } = plan();
      const rows = planned.map((message) => ({
        id: message.id, ownerId: this.userId, chatId, threadId: message.threadId, role: message.role, content: message.content,
        modelKey: null, complete: true, inputTokens: null, outputTokens: null, createdAt: message.createdAt,
      }));
      for (const row of rows) validateInteger(row.createdAt, "Creation time");
      const main = rows.filter((row) => row.threadId === null);
      const branch = rows.filter((row) => row.threadId !== null);
      if (main.length) await tx.insert(messages).values(main);
      if (plannedThreads.length) {
        await tx.insert(threads).values(plannedThreads.map((thread) => ({ ...thread, ownerId: this.userId, chatId, source: "user" as const })));
      }
      if (branch.length) await tx.insert(messages).values(branch);
      return true;
    });
  }

  private lock(tx: Tx, scope: string): Promise<unknown> {
    return tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${scope}:${this.userId}`}))`);
  }

  private async nextCreatedAt(tx: Tx, table: OrderedTable, requested?: number, preserveTimestamp = false): Promise<number> {
    if (requested !== undefined) {
      validateInteger(requested, "Creation time");
      if (preserveTimestamp) return requested;
    }
    // Per-owner advisory lock makes the max+1 allocation safe under concurrent inserts.
    await this.lock(tx, `order:${table === chats ? "chats" : table === messages ? "messages" : "threads"}`);
    const [{ value }] = await tx.select({ value: max(table.createdAt) }).from(table).where(eq(table.ownerId, this.userId));
    const next = Math.max(requested ?? Date.now(), (value ?? -1) + 1);
    validateInteger(next, "Creation time");
    return next;
  }

  private async folderRow(tx: Tx, id: string): Promise<typeof folders.$inferSelect | undefined> {
    return (await tx.select().from(folders).where(and(eq(folders.id, id), this.owned(folders))))[0];
  }

  private async folderExists(tx: Tx, id: string): Promise<boolean> {
    return (await tx.select({ id: folders.id }).from(folders).where(and(eq(folders.id, id), this.owned(folders)))).length > 0;
  }

  private async messageRow(tx: Tx, id: string, forUpdate = false): Promise<MessageRow | undefined> {
    const query = tx.select().from(messages).where(and(eq(messages.id, id), this.owned(messages)));
    return (await (forUpdate ? query.for("update") : query))[0];
  }

  private async requireMessage(tx: Tx, id: string, forUpdate = false): Promise<MessageRow> {
    const message = await this.messageRow(tx, id, forUpdate);
    if (!message) throw new AppError("Message not found.", 404, "message_not_found");
    return message;
  }

  private async requireThreadScope(tx: Tx, chatId: string, threadId: string): Promise<void> {
    if (typeof threadId !== "string") throw new AppError("Thread scope must be an ID or null.");
    const rows = await tx.select({ id: threads.id }).from(threads).where(and(eq(threads.id, threadId), eq(threads.chatId, chatId), this.owned(threads)));
    if (!rows.length) throw new AppError("Thread not found in this chat.", 404, "thread_not_found");
  }

  private async insertMessage(tx: Tx, input: AppendMessageInput, preserveTimestamp = false): Promise<Message> {
    if (input.role !== "user" && input.role !== "assistant") throw new AppError("Message role must be user or assistant.");
    if (typeof input.content !== "string") throw new AppError("Message content must be text.");
    if (input.modelKey !== null && !isModelKey(input.modelKey)) throw new AppError("Unknown model key.");
    if (input.complete !== undefined && typeof input.complete !== "boolean") throw new AppError("Message completion must be a boolean.");
    const [chat] = await tx.select({ id: chats.id, title: chats.title }).from(chats).where(and(eq(chats.id, input.chatId), this.owned(chats)));
    if (!chat) throw new AppError("Chat not found.", 404, "chat_not_found");
    if (input.threadId !== null) await this.requireThreadScope(tx, input.chatId, input.threadId);
    const firstMainUser = input.threadId === null && input.role === "user"
      && (await tx.select({ id: messages.id }).from(messages).where(and(
        this.owned(messages), eq(messages.chatId, input.chatId), isNull(messages.threadId), eq(messages.role, "user"),
      )).limit(1)).length === 0;
    const [row] = await tx.insert(messages).values({
      id: randomUUID(), ownerId: this.userId, chatId: input.chatId, threadId: input.threadId, role: input.role, content: input.content,
      modelKey: input.modelKey, complete: input.complete ?? true, inputTokens: null, outputTokens: null,
      createdAt: await this.nextCreatedAt(tx, messages, input.createdAt, preserveTimestamp),
    }).returning();
    if (firstMainUser && chat.title === "New chat") {
      // Conditional update keeps a concurrent custom rename authoritative.
      await tx.update(chats).set({ title: input.content.slice(0, 60) }).where(and(eq(chats.id, input.chatId), this.owned(chats), eq(chats.title, "New chat")));
    }
    return toMessage(row);
  }

  private threadQuery(tx: Tx) {
    return tx.select({ thread: threads, parentContent: parentMessages.content, messageCount: count(threadMessages.id) })
      .from(threads)
      .leftJoin(parentMessages, and(eq(threads.parentMessageId, parentMessages.id), eq(threads.chatId, parentMessages.chatId)))
      .leftJoin(threadMessages, and(eq(threadMessages.threadId, threads.id), eq(threadMessages.chatId, threads.chatId)))
      .groupBy(threads.id, parentMessages.id);
  }

  private async readThread(tx: Tx, id: string): Promise<Thread | null> {
    const [row] = await this.threadQuery(tx).where(and(eq(threads.id, id), this.owned(threads)));
    return row ? enrichThread(row) : null;
  }
}
