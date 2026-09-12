import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { ModelKey } from "../models";

export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("chats_created_at_idx").on(table.createdAt),
]);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  threadId: text("thread_id").references((): AnySQLiteColumn => threads.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  modelKey: text("model_key").$type<ModelKey>(),
  complete: integer("complete", { mode: "boolean" }).notNull().default(true),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("messages_scope_created_at_idx").on(table.chatId, table.threadId, table.createdAt),
  index("messages_thread_id_idx").on(table.threadId),
  index("messages_created_at_idx").on(table.createdAt),
  check("messages_role_check", sql`${table.role} in ('user', 'assistant')`),
  check("messages_model_key_check", sql`${table.modelKey} is null or ${table.modelKey} in ('fast', 'thinking', 'opus', 'sonnet', 'haiku', 'gpt-5', 'gpt-5-mini')`),
  check("messages_complete_check", sql`${table.complete} in (0, 1)`),
  check("messages_input_tokens_check", sql`${table.inputTokens} is null or (typeof(${table.inputTokens}) = 'integer' and ${table.inputTokens} >= 0)`),
  check("messages_output_tokens_check", sql`${table.outputTokens} is null or (typeof(${table.outputTokens}) = 'integer' and ${table.outputTokens} >= 0)`),
]);

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
  parentMessageId: text("parent_message_id").notNull().references((): AnySQLiteColumn => messages.id, { onDelete: "cascade" }),
  anchorStart: integer("anchor_start").notNull(),
  anchorEnd: integer("anchor_end").notNull(),
  anchorExact: text("anchor_exact").notNull(),
  compressedContext: text("compressed_context"),
  contextFrozenAt: integer("context_frozen_at"),
  source: text("source", { enum: ["user"] }).notNull().default("user"),
  resolved: integer("resolved", { mode: "boolean" }).notNull().default(false),
  title: text("title").notNull(),
  createdAt: integer("created_at").notNull(),
}, (table) => [
  index("threads_chat_created_at_idx").on(table.chatId, table.createdAt),
  index("threads_parent_anchor_idx").on(table.parentMessageId, table.anchorStart, table.anchorEnd),
  index("threads_created_at_idx").on(table.createdAt),
  check("threads_anchor_bounds_check", sql`typeof(${table.anchorStart}) = 'integer' and typeof(${table.anchorEnd}) = 'integer' and ${table.anchorStart} >= 0 and ${table.anchorEnd} > ${table.anchorStart}`),
  check("threads_source_check", sql`${table.source} = 'user'`),
  check("threads_resolved_check", sql`${table.resolved} in (0, 1)`),
  check("threads_compressed_context_check", sql`${table.compressedContext} is null or json_valid(${table.compressedContext})`),
]);
