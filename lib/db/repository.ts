import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, isNull, lt, max, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { validateAnchor } from "../anchors";
import { AppError } from "../errors";
import { isModelKey } from "../models";
import type { Chat, Message, SearchResult, Thread } from "../types";
import { DEFAULT_DATABASE_PATH, openDatabase, type AppDatabase } from "./database";
import { chats, messages, threads } from "./schema";

export type AppendMessageInput = Pick<Message, "chatId" | "threadId" | "role" | "content" | "modelKey">
  & Partial<Pick<Message, "complete" | "createdAt">>;
export type FinishMessageInput = Pick<Message, "content" | "complete">
  & Partial<Pick<Message, "inputTokens" | "outputTokens">>;
export type InsertThreadInput = Pick<Thread, "parentMessageId" | "anchorStart" | "anchorEnd" | "source" | "compressedContext" | "contextFrozenAt">;
export type UpdateThreadInput = Partial<Pick<Thread, "resolved" | "compressedContext" | "contextFrozenAt">>;

type QueryDatabase = Pick<AppDatabase, "select" | "insert" | "update" | "delete">;
type ThreadRow = {
  thread: typeof threads.$inferSelect;
  parentContent: string | null;
  messageCount: number;
};

const parentMessages = alias(messages, "parent_messages");
const threadMessages = alias(messages, "thread_messages");

function validateInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError(`${field} must be a nonnegative integer.`);
  }
}

function validateContext(input: UpdateThreadInput) {
  if (input.compressedContext !== undefined && input.compressedContext !== null) {
    if (typeof input.compressedContext !== "string") {
      throw new AppError("Compressed context must be a JSON string or null.");
    }
    try {
      JSON.parse(input.compressedContext);
    } catch {
      throw new AppError("Compressed context must contain valid JSON.");
    }
  }
  if (input.contextFrozenAt !== undefined && input.contextFrozenAt !== null) {
    validateInteger(input.contextFrozenAt, "Context freeze time");
  }
}

function enrichThread(row: ThreadRow): Thread {
  return {
    ...row.thread,
    anchorValid: validateAnchor(row.parentContent ?? "", row.thread),
    messageCount: row.messageCount,
  };
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

export class ChatRepository {
  private readonly db: AppDatabase;
  private readonly sqlite: ReturnType<typeof openDatabase>["sqlite"];

  constructor(filename: string) {
    const database = openDatabase(filename);
    this.db = database.db;
    this.sqlite = database.sqlite;
  }

  close(): void {
    if (this.sqlite.open) this.sqlite.close();
    if (repositoryGlobal.__marginRepository === this) {
      delete repositoryGlobal.__marginRepository;
    }
  }

  listChats(): Chat[] {
    return this.db.select().from(chats).orderBy(desc(chats.createdAt), desc(chats.id)).all();
  }

  getChat(id: string): Chat | null {
    return this.db.select().from(chats).where(eq(chats.id, id)).get() ?? null;
  }

  createChat(): Chat {
    return this.db.transaction((tx) => tx.insert(chats).values({
      id: randomUUID(),
      title: "New chat",
      createdAt: this.nextCreatedAt(tx, chats),
    }).returning().get()!, { behavior: "immediate" });
  }

  deleteChat(id: string): void {
    this.db.delete(chats).where(eq(chats.id, id)).run();
  }

  getMessage(id: string): Message | null {
    return this.db.select().from(messages).where(eq(messages.id, id)).get() ?? null;
  }

  listMessages(chatId: string, threadId: string | null = null): Message[] {
    if (threadId !== null) this.requireThreadScope(this.db, chatId, threadId);
    return this.db.select().from(messages).where(and(
      eq(messages.chatId, chatId),
      threadId === null ? isNull(messages.threadId) : eq(messages.threadId, threadId),
    )).orderBy(asc(messages.createdAt), asc(messages.id)).all();
  }

  appendMessage(input: AppendMessageInput): Message {
    return this.db.transaction((tx) => this.insertMessage(tx, input), { behavior: "immediate" });
  }

  updatePartialMessage(id: string, content: string): Message {
    return this.db.transaction((tx) => {
      const message = this.requireMessage(tx, id);
      if (message.role !== "assistant" || message.complete) {
        throw new AppError("Only incomplete assistant messages can be updated.", 409, "message_immutable");
      }
      if (typeof content !== "string") throw new AppError("Message content must be text.");
      return tx.update(messages).set({ content }).where(eq(messages.id, id)).returning().get()!;
    }, { behavior: "immediate" });
  }

  finishMessage(id: string, input: FinishMessageInput): Message {
    return this.db.transaction((tx) => {
      const message = this.requireMessage(tx, id);
      if (message.role !== "assistant") {
        throw new AppError("Only assistant messages can be finished.", 409, "message_immutable");
      }
      if (typeof input.content !== "string" || typeof input.complete !== "boolean") {
        throw new AppError("Message content and completion state are required.");
      }
      if (input.inputTokens !== undefined && input.inputTokens !== null) validateInteger(input.inputTokens, "Input tokens");
      if (input.outputTokens !== undefined && input.outputTokens !== null) validateInteger(input.outputTokens, "Output tokens");
      if (message.complete) {
        if (input.content !== message.content || !input.complete) {
          throw new AppError("Completed message content cannot be changed.", 409, "message_immutable");
        }
        return message;
      }
      return tx.update(messages).set({
        content: input.content,
        complete: input.complete,
        inputTokens: input.inputTokens === undefined ? message.inputTokens : input.inputTokens,
        outputTokens: input.outputTokens === undefined ? message.outputTokens : input.outputTokens,
      }).where(eq(messages.id, id)).returning().get()!;
    }, { behavior: "immediate" });
  }

  getThread(id: string): Thread | null {
    return this.readThread(this.db, id);
  }

  listThreads(chatId: string): Thread[] {
    return this.threadQuery(this.db).where(eq(threads.chatId, chatId))
      .orderBy(asc(threads.createdAt), asc(threads.id)).all().map(enrichThread);
  }

  insertThread(input: InsertThreadInput): Thread {
    return this.db.transaction((tx) => {
      const parent = this.requireMessage(tx, input.parentMessageId);
      if (parent.role !== "assistant" || !parent.complete || parent.threadId !== null) {
        throw new AppError("Threads require a completed assistant message in the main conversation.", 400, "invalid_parent");
      }
      if (input.source !== "user") {
        throw new AppError("Only user-created threads are supported.", 400, "invalid_source");
      }
      const { anchorStart, anchorEnd } = input;
      if (!Number.isInteger(anchorStart) || !Number.isInteger(anchorEnd)
        || anchorStart < 0 || anchorEnd <= anchorStart || anchorEnd > parent.content.length) {
        throw new AppError("Select a nonempty range within the parent message.", 400, "invalid_anchor");
      }
      validateContext(input);
      const overlapping = tx.select({ id: threads.id }).from(threads).where(and(
        eq(threads.parentMessageId, parent.id),
        lt(threads.anchorStart, anchorEnd),
        gt(threads.anchorEnd, anchorStart),
      )).limit(1).get();
      if (overlapping) {
        throw new AppError("This selection overlaps an existing thread anchor.", 409, "anchor_overlap");
      }
      const anchorExact = parent.content.slice(anchorStart, anchorEnd);
      const inserted = tx.insert(threads).values({
        id: randomUUID(),
        chatId: parent.chatId,
        parentMessageId: parent.id,
        anchorStart,
        anchorEnd,
        anchorExact,
        compressedContext: input.compressedContext,
        contextFrozenAt: input.contextFrozenAt,
        source: "user",
        resolved: false,
        title: anchorExact.slice(0, 60),
        createdAt: this.nextCreatedAt(tx, threads),
      }).returning().get()!;
      return { ...inserted, anchorValid: true, messageCount: 0 };
    }, { behavior: "immediate" });
  }

  updateThread(id: string, input: UpdateThreadInput): Thread {
    return this.db.transaction((tx) => {
      const current = this.readThread(tx, id);
      if (!current) throw new AppError("Thread not found.", 404, "thread_not_found");
      validateContext(input);
      if (input.resolved !== undefined && typeof input.resolved !== "boolean") {
        throw new AppError("Thread resolution must be a boolean.");
      }
      const changes: UpdateThreadInput = {};
      if (input.resolved !== undefined) changes.resolved = input.resolved;
      if (input.compressedContext !== undefined) changes.compressedContext = input.compressedContext;
      if (input.contextFrozenAt !== undefined) changes.contextFrozenAt = input.contextFrozenAt;
      if (Object.keys(changes).length === 0) return current;
      tx.update(threads).set(changes).where(eq(threads.id, id)).run();
      return { ...current, ...changes };
    }, { behavior: "immediate" });
  }

  deleteThread(id: string): void {
    this.db.delete(threads).where(eq(threads.id, id)).run();
  }

  searchMessages(chatId: string, query: string): SearchResult[] {
    if (typeof query !== "string") throw new AppError("Search text must be a string.");
    if (query.trim().length === 0) return [];
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const matches = this.db.select({
      id: messages.id,
      threadId: messages.threadId,
      threadTitle: threads.title,
      role: messages.role,
      content: messages.content,
    }).from(messages).leftJoin(threads, and(
      eq(messages.threadId, threads.id),
      eq(messages.chatId, threads.chatId),
    )).where(and(
      eq(messages.chatId, chatId),
      sql`${messages.content} LIKE ${pattern} ESCAPE '\\'`,
    )).orderBy(asc(messages.createdAt), asc(messages.id)).all();
    return matches.map(({ content, ...match }) => ({ ...match, excerpt: excerpt(content, query) }));
  }

  copyMessageToMain(messageId: string): Message {
    return this.db.transaction((tx) => {
      const message = this.requireMessage(tx, messageId);
      if (message.threadId === null) {
        throw new AppError("Only thread messages can be copied to main.", 400, "invalid_scope");
      }
      this.requireThreadScope(tx, message.chatId, message.threadId);
      return this.insertMessage(tx, {
        chatId: message.chatId,
        threadId: null,
        role: message.role,
        content: message.content,
        modelKey: message.modelKey,
        complete: true,
      });
    }, { behavior: "immediate" });
  }

  seedOnce(seed: (repository: ChatRepository) => void): void {
    this.sqlite.transaction(() => {
      if (this.sqlite.prepare("SELECT value FROM app_meta WHERE key = 'seeded'").get()) return;
      seed(this);
      this.sqlite.prepare("INSERT INTO app_meta (key, value) VALUES ('seeded', '1')").run();
    }).immediate();
  }

  private nextCreatedAt(db: QueryDatabase, table: typeof chats | typeof messages | typeof threads, requested?: number): number {
    if (requested !== undefined) validateInteger(requested, "Creation time");
    const latest = db.select({ value: max(table.createdAt) }).from(table).get()?.value;
    const next = Math.max(requested ?? Date.now(), (latest ?? -1) + 1);
    validateInteger(next, "Creation time");
    return next;
  }

  private requireMessage(db: QueryDatabase, id: string): Message {
    const message = db.select().from(messages).where(eq(messages.id, id)).get();
    if (!message) throw new AppError("Message not found.", 404, "message_not_found");
    return message;
  }

  private requireThreadScope(db: QueryDatabase, chatId: string, threadId: string): void {
    if (typeof threadId !== "string") throw new AppError("Thread scope must be an ID or null.");
    const thread = db.select({ id: threads.id }).from(threads).where(and(
      eq(threads.id, threadId),
      eq(threads.chatId, chatId),
    )).get();
    if (!thread) throw new AppError("Thread not found in this chat.", 404, "thread_not_found");
  }

  private insertMessage(db: QueryDatabase, input: AppendMessageInput): Message {
    const chat = db.select({ id: chats.id }).from(chats).where(eq(chats.id, input.chatId)).get();
    if (!chat) throw new AppError("Chat not found.", 404, "chat_not_found");
    if (input.threadId !== null) this.requireThreadScope(db, input.chatId, input.threadId);
    if (input.role !== "user" && input.role !== "assistant") throw new AppError("Message role must be user or assistant.");
    if (typeof input.content !== "string") throw new AppError("Message content must be text.");
    if (input.modelKey !== null && !isModelKey(input.modelKey)) throw new AppError("Unknown model key.");
    if (input.complete !== undefined && typeof input.complete !== "boolean") throw new AppError("Message completion must be a boolean.");
    const firstMainUser = input.threadId === null && input.role === "user"
      && !db.select({ id: messages.id }).from(messages).where(and(
        eq(messages.chatId, input.chatId),
        isNull(messages.threadId),
        eq(messages.role, "user"),
      )).limit(1).get();
    const message = db.insert(messages).values({
      id: randomUUID(),
      chatId: input.chatId,
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      modelKey: input.modelKey,
      complete: input.complete ?? true,
      inputTokens: null,
      outputTokens: null,
      createdAt: this.nextCreatedAt(db, messages, input.createdAt),
    }).returning().get()!;
    if (firstMainUser) {
      db.update(chats).set({ title: input.content.slice(0, 60) }).where(eq(chats.id, input.chatId)).run();
    }
    return message;
  }

  private threadQuery(db: QueryDatabase) {
    return db.select({
      thread: threads,
      parentContent: parentMessages.content,
      messageCount: count(threadMessages.id),
    }).from(threads).leftJoin(parentMessages, and(
      eq(threads.parentMessageId, parentMessages.id),
      eq(threads.chatId, parentMessages.chatId),
    )).leftJoin(threadMessages, and(
      eq(threadMessages.threadId, threads.id),
      eq(threadMessages.chatId, threads.chatId),
    )).groupBy(threads.id);
  }

  private readThread(db: QueryDatabase, id: string): Thread | null {
    const row = this.threadQuery(db).where(eq(threads.id, id)).get();
    return row ? enrichThread(row) : null;
  }
}

import { seedDatabase } from "../seed";

const repositoryGlobal = globalThis as typeof globalThis & { __marginRepository?: ChatRepository };

export function getRepository(): ChatRepository {
  if (!repositoryGlobal.__marginRepository) {
    const repository = new ChatRepository(DEFAULT_DATABASE_PATH);
    repository.seedOnce(seedDatabase);
    repositoryGlobal.__marginRepository = repository;
  }
  return repositoryGlobal.__marginRepository;
}
