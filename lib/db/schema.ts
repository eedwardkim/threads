import { sql } from "drizzle-orm";
import { bigint, boolean, customType, date, integer, pgSchema, text, uuid } from "drizzle-orm/pg-core";
import type { ModelKey } from "../models";
import type { AttachmentMediaType } from "../types";

// Column constraints, composite owner foreign keys, triggers, and RLS policies are defined in
// db/migrations/*.sql; this file mirrors the tables for typed queries.
export const threadsSchema = pgSchema("threads");

const ms = (name: string) => bigint(name, { mode: "number" });

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => value,
  fromDriver: (value) => new Uint8Array(value),
});

export const userState = threadsSchema.table("user_state", {
  ownerId: uuid("owner_id").primaryKey(),
  demoSeedKey: text("demo_seed_key"),
  createdAt: ms("created_at").notNull(),
});

export const folders = threadsSchema.table("folders", {
  id: text("id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  name: text("name").notNull(),
  parentId: text("parent_id"),
  createdAt: ms("created_at").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  demoKey: text("demo_key"),
});

export const chats = threadsSchema.table("chats", {
  id: text("id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  title: text("title").notNull(),
  folderId: text("folder_id"),
  createdAt: ms("created_at").notNull(),
  demoKey: text("demo_key"),
});

export const messages = threadsSchema.table("messages", {
  id: text("id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  chatId: text("chat_id").notNull(),
  threadId: text("thread_id"),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  modelKey: text("model_key").$type<ModelKey>(),
  complete: boolean("complete").notNull().default(true),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  createdAt: ms("created_at").notNull(),
  attempt: integer("attempt").notNull().default(0),
});

export const threads = threadsSchema.table("threads", {
  id: text("id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  chatId: text("chat_id").notNull(),
  parentMessageId: text("parent_message_id").notNull(),
  anchorStart: integer("anchor_start").notNull(),
  anchorEnd: integer("anchor_end").notNull(),
  anchorExact: text("anchor_exact").notNull(),
  compressedContext: text("compressed_context"),
  contextFrozenAt: ms("context_frozen_at"),
  source: text("source", { enum: ["user"] }).notNull().default("user"),
  resolved: boolean("resolved").notNull().default(false),
  title: text("title").notNull(),
  createdAt: ms("created_at").notNull(),
});

export type JobStatus = "running" | "completed" | "stopped" | "failed" | "expired";
export type JobKind = "generation" | "context";

export const generationJobs = threadsSchema.table("generation_jobs", {
  id: uuid("id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  kind: text("kind").$type<JobKind>().notNull().default("generation"),
  chatId: text("chat_id").notNull(),
  threadId: text("thread_id"),
  scopeKey: text("scope_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  status: text("status").$type<JobStatus>().notNull(),
  messageId: text("message_id"),
  userMessageId: text("user_message_id"),
  attempt: integer("attempt").notNull().default(0),
  fence: ms("fence").notNull().default(sql`nextval('threads.generation_fence_seq')`),
  leaseExpiresAt: ms("lease_expires_at").notNull(),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  createdAt: ms("created_at").notNull(),
  updatedAt: ms("updated_at").notNull(),
  finishedAt: ms("finished_at"),
  errorCode: text("error_code"),
});

export const attachments = threadsSchema.table("attachments", {
  id: text("id").primaryKey(),
  ownerId: uuid("owner_id").notNull(),
  chatId: text("chat_id").notNull(),
  messageId: text("message_id"),
  name: text("name").notNull(),
  mediaType: text("media_type").$type<AttachmentMediaType>().notNull(),
  width: integer("width").notNull(),
  height: integer("height").notNull(),
  byteSize: integer("byte_size").notNull(),
  sha256: text("sha256").notNull(),
  data: bytea("data").notNull(),
  digest: text("digest"),
  digestModel: text("digest_model"),
  createdAt: ms("created_at").notNull(),
});

export const rateWindows = threadsSchema.table("rate_windows", {
  ownerId: uuid("owner_id").notNull(),
  windowStart: ms("window_start").notNull(),
  requests: integer("requests").notNull().default(0),
});

export const usageLedger = threadsSchema.table("usage_ledger", {
  ownerId: uuid("owner_id").notNull(),
  day: date("day").notNull(),
  inputTokens: ms("input_tokens").notNull().default(0),
  outputTokens: ms("output_tokens").notNull().default(0),
  requests: integer("requests").notNull().default(0),
});
