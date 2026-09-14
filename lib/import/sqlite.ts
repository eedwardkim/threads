import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseHandle } from "../db/client";
import { chats, folders, messages, threads } from "../db/schema";
import type { Tx } from "../db/session";
import { DEMO_FOLDERS } from "../demo-catalog";
import { TransactionRollbackError } from "drizzle-orm/errors";
import { isModelKey, type ModelKey } from "../models";

/**
 * Explicit, one-shot import of a legacy single-user SQLite database into one Postgres owner.
 *
 * - The source is opened read-only inside a single read transaction, so a WAL-mode database yields a
 *   consistent snapshot and is never modified (no checkpoint, no journal change).
 * - Ids are preserved verbatim. The only exceptions are the legacy globally-shared demo ids
 *   (`demo-folder-*`, `demo-*`), which map onto the destination user's own demo instances by logical
 *   catalog key, and ids already taken by a different owner, which get a deterministic replacement
 *   (sha256 of owner + legacy id). Every remap is listed in the report.
 * - Reruns are idempotent: rows that already exist for the owner with identical content are skipped;
 *   rows that exist with different content are reported as conflicts and nothing is written.
 * - Runs with the privileged migration connection (RLS does not apply) and stamps every row with the
 *   explicitly selected owner, never "whoever signs in first".
 */

export interface ImportOptions {
  sqlitePath: string;
  userId: string;
  handle: DatabaseHandle;
  dryRun: boolean;
  /** Skip demo chats the user already hydrated instead of failing the import. */
  skipHydratedDemos?: boolean;
  /** Require the owner to exist in auth.users (Supabase). Defaults to true when auth.users exists. */
  requireAuthUser?: boolean;
}

export interface ImportCounts { folders: number; chats: number; messages: number; threads: number }

export interface ImportReport {
  dryRun: boolean;
  userId: string;
  source: ImportCounts;
  planned: ImportCounts;
  alreadyPresent: ImportCounts;
  written: ImportCounts;
  remapped: { table: keyof ImportCounts; from: string; to: string; reason: "demo" | "taken" }[];
  skippedDemoChats: string[];
  errors: string[];
  contentHash: string;
  destinationHash: string | null;
}

interface LegacyFolder { id: string; name: string; parent_id: string | null; created_at: number; sort_order: number }
interface LegacyChat { id: string; title: string; folder_id: string | null; created_at: number }
interface LegacyMessage {
  id: string; chat_id: string; thread_id: string | null; role: string; content: string; model_key: string | null;
  complete: number; input_tokens: number | null; output_tokens: number | null; created_at: number;
}
interface LegacyThread {
  id: string; chat_id: string; parent_message_id: string; anchor_start: number; anchor_end: number; anchor_exact: string;
  compressed_context: string | null; context_frozen_at: number | null; source: string; resolved: number; title: string; created_at: number;
}

interface Snapshot { folders: LegacyFolder[]; chats: LegacyChat[]; messages: LegacyMessage[]; threads: LegacyThread[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEMO_FOLDER_KEYS = new Set(DEMO_FOLDERS.map((folder) => folder.id));
const DEMO_CHAT_KEYS = new Set(DEMO_FOLDERS.flatMap((folder) => folder.chats.map((chat) => chat.id)));

function readSnapshot(path: string): Snapshot {
  if (!existsSync(path)) throw new Error(`SQLite database not found: ${path}`);
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma("query_only = 1");
    const columns = (table: string) => new Set((db.pragma(`table_info(${table})`) as { name: string }[]).map((column) => column.name));
    const tables = new Set((db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((row) => row.name));
    for (const required of ["folders", "chats", "messages", "threads"]) {
      if (!tables.has(required)) throw new Error(`Legacy database is missing table "${required}".`);
    }
    const pick = (table: string, wanted: Record<string, string>) => {
      const present = columns(table);
      return Object.entries(wanted).map(([name, fallback]) => present.has(name) ? `"${name}"` : `${fallback} as "${name}"`).join(", ");
    };
    db.exec("begin"); // one read transaction => consistent WAL snapshot
    try {
      return {
        folders: db.prepare(`select ${pick("folders", { id: "null", name: "''", parent_id: "null", created_at: "0", sort_order: "0" })} from folders order by created_at, rowid`).all() as LegacyFolder[],
        chats: db.prepare(`select ${pick("chats", { id: "null", title: "''", folder_id: "null", created_at: "0" })} from chats order by created_at, rowid`).all() as LegacyChat[],
        messages: db.prepare(`select ${pick("messages", { id: "null", chat_id: "null", thread_id: "null", role: "''", content: "''", model_key: "null", complete: "1", input_tokens: "null", output_tokens: "null", created_at: "0" })} from messages order by created_at, rowid`).all() as LegacyMessage[],
        threads: db.prepare(`select ${pick("threads", { id: "null", chat_id: "null", parent_message_id: "null", anchor_start: "0", anchor_end: "0", anchor_exact: "''", compressed_context: "null", context_frozen_at: "null", source: "'user'", resolved: "0", title: "''", created_at: "0" })} from threads order by created_at, rowid`).all() as LegacyThread[],
      };
    } finally {
      db.exec("commit");
    }
  } finally {
    db.close();
  }
}

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

function validateSnapshot(snapshot: Snapshot): string[] {
  const errors: string[] = [];
  const folderIds = new Set<string>();
  for (const folder of snapshot.folders) {
    if (typeof folder.id !== "string" || !folder.id) errors.push("folder with empty id");
    else if (folderIds.has(folder.id)) errors.push(`duplicate folder id ${folder.id}`);
    folderIds.add(folder.id);
    if (typeof folder.name !== "string" || !folder.name.length) errors.push(`folder ${folder.id}: empty name`);
    if (!isInt(folder.created_at) || !isInt(folder.sort_order)) errors.push(`folder ${folder.id}: non-integer created_at/sort_order`);
  }
  for (const folder of snapshot.folders) {
    if (folder.parent_id !== null && !folderIds.has(folder.parent_id)) errors.push(`folder ${folder.id}: missing parent ${folder.parent_id}`);
  }
  // Folder cycles would make the import unrepresentable.
  for (const folder of snapshot.folders) {
    const seen = new Set<string>();
    let cursor: string | null = folder.id;
    while (cursor) {
      if (seen.has(cursor)) { errors.push(`folder cycle through ${folder.id}`); break; }
      seen.add(cursor);
      cursor = snapshot.folders.find((candidate) => candidate.id === cursor)?.parent_id ?? null;
    }
  }
  const chatIds = new Set<string>();
  for (const chat of snapshot.chats) {
    if (typeof chat.id !== "string" || !chat.id) errors.push("chat with empty id");
    else if (chatIds.has(chat.id)) errors.push(`duplicate chat id ${chat.id}`);
    chatIds.add(chat.id);
    if (typeof chat.title !== "string") errors.push(`chat ${chat.id}: invalid title`);
    if (!isInt(chat.created_at)) errors.push(`chat ${chat.id}: non-integer created_at`);
    if (chat.folder_id !== null && !folderIds.has(chat.folder_id)) errors.push(`chat ${chat.id}: missing folder ${chat.folder_id}`);
  }
  const messageById = new Map<string, LegacyMessage>();
  for (const message of snapshot.messages) {
    if (typeof message.id !== "string" || !message.id) errors.push("message with empty id");
    else if (messageById.has(message.id)) errors.push(`duplicate message id ${message.id}`);
    messageById.set(message.id, message);
    if (!chatIds.has(message.chat_id)) errors.push(`message ${message.id}: missing chat ${message.chat_id}`);
    if (message.role !== "user" && message.role !== "assistant") errors.push(`message ${message.id}: invalid role ${message.role}`);
    if (typeof message.content !== "string") errors.push(`message ${message.id}: non-text content`);
    if (message.model_key !== null && !isModelKey(message.model_key)) errors.push(`message ${message.id}: unknown model key ${message.model_key}`);
    if (message.complete !== 0 && message.complete !== 1) errors.push(`message ${message.id}: invalid complete flag`);
    if (!isInt(message.created_at)) errors.push(`message ${message.id}: non-integer created_at`);
    for (const field of ["input_tokens", "output_tokens"] as const) {
      const value = message[field];
      if (value !== null && (!isInt(value) || value < 0)) errors.push(`message ${message.id}: invalid ${field}`);
    }
  }
  const threadById = new Map<string, LegacyThread>();
  for (const thread of snapshot.threads) {
    if (typeof thread.id !== "string" || !thread.id) errors.push("thread with empty id");
    else if (threadById.has(thread.id)) errors.push(`duplicate thread id ${thread.id}`);
    threadById.set(thread.id, thread);
    const parent = messageById.get(thread.parent_message_id);
    if (!parent) errors.push(`thread ${thread.id}: missing parent message ${thread.parent_message_id}`);
    else {
      if (parent.chat_id !== thread.chat_id) errors.push(`thread ${thread.id}: parent belongs to another chat`);
      if (parent.thread_id !== null) errors.push(`thread ${thread.id}: parent is itself a thread message`);
      if (!isInt(thread.anchor_start) || !isInt(thread.anchor_end) || thread.anchor_start < 0 || thread.anchor_end <= thread.anchor_start
        || thread.anchor_end > parent.content.length || parent.content.slice(thread.anchor_start, thread.anchor_end) !== thread.anchor_exact) {
        errors.push(`thread ${thread.id}: anchor does not match parent source`);
      }
    }
    if (thread.source !== "user") errors.push(`thread ${thread.id}: unsupported source ${thread.source}`);
    if (thread.resolved !== 0 && thread.resolved !== 1) errors.push(`thread ${thread.id}: invalid resolved flag`);
    if (typeof thread.title !== "string") errors.push(`thread ${thread.id}: invalid title`);
    if (!isInt(thread.created_at)) errors.push(`thread ${thread.id}: non-integer created_at`);
    if (thread.context_frozen_at !== null && !isInt(thread.context_frozen_at)) errors.push(`thread ${thread.id}: invalid context_frozen_at`);
    if (thread.compressed_context !== null) {
      try { JSON.parse(thread.compressed_context); } catch { errors.push(`thread ${thread.id}: compressed_context is not JSON`); }
    }
  }
  for (const message of snapshot.messages) {
    if (message.thread_id === null) continue;
    const thread = threadById.get(message.thread_id);
    if (!thread) errors.push(`message ${message.id}: missing thread ${message.thread_id}`);
    else if (thread.chat_id !== message.chat_id) errors.push(`message ${message.id}: thread belongs to another chat`);
  }
  return errors;
}

function contentHash(rows: { table: string; id: string; content: string }[]): string {
  const hash = createHash("sha256");
  for (const row of [...rows].sort((a, b) => a.table.localeCompare(b.table) || a.id.localeCompare(b.id))) {
    hash.update(`${row.table}\u0000${row.id}\u0000${row.content}\u0000`);
  }
  return hash.digest("hex");
}

function derivedId(userId: string, legacyId: string): string {
  const hex = createHash("sha256").update(`${userId}\u0000${legacyId}`).digest("hex");
  // Format as a UUID so derived ids look like every other application id.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const chunked = <T>(rows: T[], size = 500): T[][] => Array.from({ length: Math.ceil(rows.length / size) }, (_, index) => rows.slice(index * size, (index + 1) * size));

async function ownerOf(tx: Tx, table: typeof folders | typeof chats | typeof messages | typeof threads, ids: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (const batch of chunked(ids)) {
    for (const row of await tx.select({ id: table.id, ownerId: table.ownerId }).from(table).where(inArray(table.id, batch))) owners.set(row.id, row.ownerId);
  }
  return owners;
}

export async function importSqlite(options: ImportOptions): Promise<ImportReport> {
  const { userId, handle } = options;
  if (!UUID.test(userId)) throw new Error("--user must be the destination user's UUID.");
  const snapshot = readSnapshot(options.sqlitePath);
  const report: ImportReport = {
    dryRun: options.dryRun, userId,
    source: { folders: snapshot.folders.length, chats: snapshot.chats.length, messages: snapshot.messages.length, threads: snapshot.threads.length },
    planned: { folders: 0, chats: 0, messages: 0, threads: 0 },
    alreadyPresent: { folders: 0, chats: 0, messages: 0, threads: 0 },
    written: { folders: 0, chats: 0, messages: 0, threads: 0 },
    remapped: [], skippedDemoChats: [], errors: validateSnapshot(snapshot),
    contentHash: contentHash([
      ...snapshot.messages.map((row) => ({ table: "messages", id: row.id, content: row.content })),
      ...snapshot.threads.map((row) => ({ table: "threads", id: row.id, content: `${row.anchor_start}:${row.anchor_end}:${row.anchor_exact}:${row.compressed_context ?? ""}` })),
    ]),
    destinationHash: null,
  };
  if (report.errors.length) return report;

  await handle.db.transaction(async (tx) => {
    const [authTable] = await tx.execute(sql`select to_regclass('auth.users') as name`) as unknown as { name: string | null }[];
    const requireAuthUser = options.requireAuthUser ?? authTable.name !== null;
    if (requireAuthUser) {
      if (!authTable.name) throw new Error("auth.users does not exist; pass requireAuthUser=false only for non-Supabase test databases.");
      const [exists] = await tx.execute(sql`select 1 as ok from auth.users where id = ${userId}::uuid`) as unknown as { ok: number }[];
      if (!exists) throw new Error(`Destination user ${userId} does not exist in auth.users. Create the account first, then import.`);
    }
    // Serialize against any concurrent import/demo work for this owner.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`import:${userId}`}))`);

    // --- id mapping -------------------------------------------------------------------------------
    const folderMap = new Map<string, string>();
    const chatMap = new Map<string, string>();
    const messageMap = new Map<string, string>();
    const threadMap = new Map<string, string>();
    const remap = (table: keyof ImportCounts, map: Map<string, string>, from: string, to: string, reason: "demo" | "taken") => {
      map.set(from, to);
      if (from !== to) report.remapped.push({ table, from, to, reason });
    };

    const ownDemoFolders = new Map((await tx.select({ id: folders.id, key: folders.demoKey }).from(folders).where(and(eq(folders.ownerId, userId), sql`${folders.demoKey} is not null`))).map((row) => [row.key!, row.id]));
    const ownDemoChats = new Map((await tx.select({ id: chats.id, key: chats.demoKey }).from(chats).where(and(eq(chats.ownerId, userId), sql`${chats.demoKey} is not null`))).map((row) => [row.key!, row.id]));

    const folderOwners = await ownerOf(tx, folders, snapshot.folders.map((row) => row.id));
    for (const folder of snapshot.folders) {
      if (DEMO_FOLDER_KEYS.has(folder.id)) remap("folders", folderMap, folder.id, ownDemoFolders.get(folder.id) ?? derivedId(userId, folder.id), "demo");
      else if (folderOwners.has(folder.id) && folderOwners.get(folder.id) !== userId) remap("folders", folderMap, folder.id, derivedId(userId, folder.id), "taken");
      else folderMap.set(folder.id, folder.id);
    }
    const chatOwners = await ownerOf(tx, chats, snapshot.chats.map((row) => row.id));
    for (const chat of snapshot.chats) {
      if (DEMO_CHAT_KEYS.has(chat.id)) remap("chats", chatMap, chat.id, ownDemoChats.get(chat.id) ?? derivedId(userId, chat.id), "demo");
      else if (chatOwners.has(chat.id) && chatOwners.get(chat.id) !== userId) remap("chats", chatMap, chat.id, derivedId(userId, chat.id), "taken");
      else chatMap.set(chat.id, chat.id);
    }
    const messageOwners = await ownerOf(tx, messages, snapshot.messages.map((row) => row.id));
    for (const message of snapshot.messages) {
      if (messageOwners.has(message.id) && messageOwners.get(message.id) !== userId) remap("messages", messageMap, message.id, derivedId(userId, message.id), "taken");
      else messageMap.set(message.id, message.id);
    }
    const threadOwners = await ownerOf(tx, threads, snapshot.threads.map((row) => row.id));
    for (const thread of snapshot.threads) {
      if (threadOwners.has(thread.id) && threadOwners.get(thread.id) !== userId) remap("threads", threadMap, thread.id, derivedId(userId, thread.id), "taken");
      else threadMap.set(thread.id, thread.id);
    }

    // Demo chats the user already hydrated from the catalog cannot be merged with a legacy copy.
    const skippedChats = new Set<string>();
    const hydratedDemoIds = [...ownDemoChats.values()];
    const hydrated = new Set<string>();
    for (const batch of chunked(hydratedDemoIds)) {
      for (const row of await tx.selectDistinct({ chatId: messages.chatId }).from(messages).where(inArray(messages.chatId, batch))) hydrated.add(row.chatId);
    }
    for (const chat of snapshot.chats) {
      if (!DEMO_CHAT_KEYS.has(chat.id) || !hydrated.has(chatMap.get(chat.id)!)) continue;
      const legacyMessageIds = snapshot.messages.filter((message) => message.chat_id === chat.id).map((message) => messageMap.get(message.id)!);
      const alreadyImported = legacyMessageIds.length > 0 && (await tx.select({ id: messages.id }).from(messages).where(and(eq(messages.chatId, chatMap.get(chat.id)!), inArray(messages.id, legacyMessageIds.slice(0, 50))))).length > 0;
      if (alreadyImported) continue; // a previous run of this importer hydrated it; idempotent path below handles it
      if (!options.skipHydratedDemos) report.errors.push(`demo chat ${chat.id} is already hydrated for this user; rerun with --skip-hydrated-demos to keep the hosted copy`);
      skippedChats.add(chat.id);
      report.skippedDemoChats.push(chat.id);
    }
    if (report.errors.length) return;

    // --- build destination rows -------------------------------------------------------------------
    const depth = (folder: LegacyFolder): number => folder.parent_id ? 1 + depth(snapshot.folders.find((candidate) => candidate.id === folder.parent_id)!) : 0;
    const folderRows = [...snapshot.folders].sort((a, b) => depth(a) - depth(b)).map((folder) => ({
      id: folderMap.get(folder.id)!, ownerId: userId, name: folder.name, parentId: folder.parent_id ? folderMap.get(folder.parent_id)! : null,
      createdAt: folder.created_at, sortOrder: folder.sort_order, demoKey: DEMO_FOLDER_KEYS.has(folder.id) ? folder.id : null,
    }));
    const chatRows = snapshot.chats.filter((chat) => !skippedChats.has(chat.id)).map((chat) => ({
      id: chatMap.get(chat.id)!, ownerId: userId, title: chat.title, folderId: chat.folder_id ? folderMap.get(chat.folder_id)! : null,
      createdAt: chat.created_at, demoKey: DEMO_CHAT_KEYS.has(chat.id) ? chat.id : null,
    }));
    const messageRows = snapshot.messages.filter((message) => !skippedChats.has(message.chat_id)).map((message) => ({
      id: messageMap.get(message.id)!, ownerId: userId, chatId: chatMap.get(message.chat_id)!, threadId: message.thread_id ? threadMap.get(message.thread_id)! : null,
      role: message.role as "user" | "assistant", content: message.content, modelKey: message.model_key as ModelKey | null, complete: message.complete === 1,
      inputTokens: message.input_tokens, outputTokens: message.output_tokens, createdAt: message.created_at, attempt: 0,
    }));
    const threadRows = snapshot.threads.filter((thread) => !skippedChats.has(thread.chat_id)).map((thread) => ({
      id: threadMap.get(thread.id)!, ownerId: userId, chatId: chatMap.get(thread.chat_id)!, parentMessageId: messageMap.get(thread.parent_message_id)!,
      anchorStart: thread.anchor_start, anchorEnd: thread.anchor_end, anchorExact: thread.anchor_exact, compressedContext: thread.compressed_context,
      contextFrozenAt: thread.context_frozen_at, source: "user" as const, resolved: thread.resolved === 1, title: thread.title, createdAt: thread.created_at,
    }));

    // --- idempotence: classify each row as new, identical, or conflicting ---------------------------
    const existingFolders = new Map<string, typeof folders.$inferSelect>();
    for (const batch of chunked(folderRows.map((row) => row.id))) for (const row of await tx.select().from(folders).where(and(eq(folders.ownerId, userId), inArray(folders.id, batch)))) existingFolders.set(row.id, row);
    const existingChats = new Map<string, typeof chats.$inferSelect>();
    for (const batch of chunked(chatRows.map((row) => row.id))) for (const row of await tx.select().from(chats).where(and(eq(chats.ownerId, userId), inArray(chats.id, batch)))) existingChats.set(row.id, row);
    const existingMessages = new Map<string, typeof messages.$inferSelect>();
    for (const batch of chunked(messageRows.map((row) => row.id))) for (const row of await tx.select().from(messages).where(and(eq(messages.ownerId, userId), inArray(messages.id, batch)))) existingMessages.set(row.id, row);
    const existingThreads = new Map<string, typeof threads.$inferSelect>();
    for (const batch of chunked(threadRows.map((row) => row.id))) for (const row of await tx.select().from(threads).where(and(eq(threads.ownerId, userId), inArray(threads.id, batch)))) existingThreads.set(row.id, row);

    const newFolders = folderRows.filter((row) => {
      const existing = existingFolders.get(row.id);
      if (!existing) return true;
      // Demo folders map onto the user's own instance: keep the user's placement, but a renamed legacy folder wins the name.
      if (existing.demoKey) return false;
      if (existing.parentId !== row.parentId || existing.createdAt !== row.createdAt) report.errors.push(`folder ${row.id} already exists with different structure`);
      return false;
    });
    const renamedDemoFolders = folderRows.filter((row) => existingFolders.get(row.id)?.demoKey && existingFolders.get(row.id)!.name !== row.name);
    const newChats = chatRows.filter((row) => {
      const existing = existingChats.get(row.id);
      if (!existing) return true;
      if (existing.demoKey) return false;
      if (existing.createdAt !== row.createdAt) report.errors.push(`chat ${row.id} already exists with a different timestamp`);
      return false;
    });
    const movedOrRenamedDemoChats = chatRows.filter((row) => {
      const existing = existingChats.get(row.id);
      return existing?.demoKey && (existing.title !== row.title || existing.folderId !== row.folderId);
    });
    const newMessages = messageRows.filter((row) => {
      const existing = existingMessages.get(row.id);
      if (!existing) return true;
      if (existing.content !== row.content || existing.chatId !== row.chatId || existing.threadId !== row.threadId || existing.role !== row.role
        || existing.createdAt !== row.createdAt || (existing.complete && !row.complete)) {
        report.errors.push(`message ${row.id} already exists with different content`);
      }
      return false;
    });
    const newThreads = threadRows.filter((row) => {
      const existing = existingThreads.get(row.id);
      if (!existing) return true;
      if (existing.parentMessageId !== row.parentMessageId || existing.anchorStart !== row.anchorStart || existing.anchorEnd !== row.anchorEnd || existing.anchorExact !== row.anchorExact) {
        report.errors.push(`thread ${row.id} already exists with a different anchor`);
      }
      return false;
    });
    report.planned = { folders: newFolders.length, chats: newChats.length, messages: newMessages.length, threads: newThreads.length };
    report.alreadyPresent = {
      folders: folderRows.length - newFolders.length, chats: chatRows.length - newChats.length,
      messages: messageRows.length - newMessages.length, threads: threadRows.length - newThreads.length,
    };
    if (report.errors.length) return;

    // --- write (folders -> chats -> main messages -> threads -> thread messages) ------------------
    const write = async () => {
      for (const batch of chunked(newFolders)) report.written.folders += (await tx.insert(folders).values(batch).returning({ id: folders.id })).length;
      for (const row of renamedDemoFolders) await tx.update(folders).set({ name: row.name }).where(and(eq(folders.id, row.id), eq(folders.ownerId, userId)));
      for (const batch of chunked(newChats)) report.written.chats += (await tx.insert(chats).values(batch).returning({ id: chats.id })).length;
      for (const row of movedOrRenamedDemoChats) await tx.update(chats).set({ title: row.title, folderId: row.folderId }).where(and(eq(chats.id, row.id), eq(chats.ownerId, userId)));
      for (const batch of chunked(newMessages.filter((row) => row.threadId === null))) report.written.messages += (await tx.insert(messages).values(batch).returning({ id: messages.id })).length;
      for (const batch of chunked(newThreads)) report.written.threads += (await tx.insert(threads).values(batch).returning({ id: threads.id })).length;
      for (const batch of chunked(newMessages.filter((row) => row.threadId !== null))) report.written.messages += (await tx.insert(messages).values(batch).returning({ id: messages.id })).length;
    };
    await write();

    // --- verify inside the transaction; any failure rolls everything back --------------------------
    const importedMessageIds = messageRows.map((row) => row.id);
    const importedThreadIds = threadRows.map((row) => row.id);
    const destinationMessages: { id: string; content: string; chatId: string; threadId: string | null }[] = [];
    for (const batch of chunked(importedMessageIds)) destinationMessages.push(...await tx.select({ id: messages.id, content: messages.content, chatId: messages.chatId, threadId: messages.threadId }).from(messages).where(and(eq(messages.ownerId, userId), inArray(messages.id, batch))));
    const destinationThreads: typeof threads.$inferSelect[] = [];
    for (const batch of chunked(importedThreadIds)) destinationThreads.push(...await tx.select().from(threads).where(and(eq(threads.ownerId, userId), inArray(threads.id, batch))));
    if (destinationMessages.length !== importedMessageIds.length) report.errors.push(`message count mismatch: expected ${importedMessageIds.length}, found ${destinationMessages.length}`);
    if (destinationThreads.length !== importedThreadIds.length) report.errors.push(`thread count mismatch: expected ${importedThreadIds.length}, found ${destinationThreads.length}`);
    const destinationById = new Map(destinationMessages.map((row) => [row.id, row]));
    for (const thread of destinationThreads) {
      const parent = destinationById.get(thread.parentMessageId);
      if (!parent || parent.chatId !== thread.chatId || parent.content.slice(thread.anchorStart, thread.anchorEnd) !== thread.anchorExact) report.errors.push(`thread ${thread.id}: anchor invalid after import`);
    }
    // Compare content hashes with the mapping applied so remapped rows are still checked.
    const expected = contentHash([
      ...messageRows.map((row) => ({ table: "messages", id: row.id, content: row.content })),
      ...threadRows.map((row) => ({ table: "threads", id: row.id, content: `${row.anchorStart}:${row.anchorEnd}:${row.anchorExact}:${row.compressedContext ?? ""}` })),
    ]);
    report.destinationHash = contentHash([
      ...destinationMessages.map((row) => ({ table: "messages", id: row.id, content: row.content })),
      ...destinationThreads.map((row) => ({ table: "threads", id: row.id, content: `${row.anchorStart}:${row.anchorEnd}:${row.anchorExact}:${row.compressedContext ?? ""}` })),
    ]);
    if (expected !== report.destinationHash) report.errors.push("content hash mismatch after import");
    if (skippedChats.size === 0 && report.remapped.length === 0 && report.destinationHash !== report.contentHash) report.errors.push("destination hash differs from source hash");
    if (report.errors.length || options.dryRun) await tx.rollback();
  }).catch((error: unknown) => {
    // drizzle's tx.rollback() throws a TransactionRollbackError; that is the expected exit for dry runs and failures.
    if (!(error instanceof TransactionRollbackError)) throw error;
  });

  if (options.dryRun || report.errors.length) report.written = { folders: 0, chats: 0, messages: 0, threads: 0 };
  return report;
}
